import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { slideKey, ORDER_KEY, THEME_KEY } from '../src/shared/deckMerge.js';
import { startCuttableLink, type CuttableLink } from './support/cuttableLink.js';
import { OfflineReplica } from './support/offlineReplica.js';

/**
 * The desktop's copy of a server deck, against a real collaboration server,
 * through a link the test cuts and restores: edits keep landing while the link
 * is down, and the reconnect merges them with what everybody else did.
 */

const DECK_ID = 'talk';

function talk(): Deck {
  return parseDeck({
    version: 1,
    title: 'Talk',
    slides: [1, 2, 3, 4].map((n) => ({
      id: `s${n}`,
      name: `Slide ${n}`,
      elements: [
        { id: `t${n}`, type: 'text', x: 0, y: 0, w: 800, h: 100, html: `Title ${n}`, class: ['role-title'] },
        { id: `b${n}`, type: 'text', x: 0, y: 200, w: 800, h: 100, html: `Body ${n}` },
      ],
    })),
  });
}

const html = (deck: Deck | null, slideId: string, elementId: string) =>
  (deck!.slides.find((s) => s.id === slideId)?.elements.find((e) => e.id === elementId) as { html?: string } | undefined)?.html;
const setHtml = (slideId: string, elementId: string, value: string) => (deck: Deck) => {
  (deck.slides.find((s) => s.id === slideId)!.elements.find((e) => e.id === elementId) as { html: string }).html = value;
};
const ids = (deck: Deck | null) => deck!.slides.map((s) => s.id);

let rootDir: string;
let server: RunningCollabServer;
let link: CuttableLink;
const replicas: OfflineReplica[] = [];

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'remote-sync-'));
  await mkdir(join(rootDir, DECK_ID), { recursive: true });
  await saveDeck(join(rootDir, DECK_ID), talk());
  server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1' });
  link = await startCuttableLink(server.port);
});

afterEach(async () => {
  for (const replica of replicas.splice(0)) replica.close();
  await link.close();
  await server.close();
  await rm(rootDir, { recursive: true, force: true });
});

const viaLink = () => `ws://127.0.0.1:${link.port}/ws?deck=${DECK_ID}`;
const direct = () => `ws://127.0.0.1:${server.port}/ws?deck=${DECK_ID}`;

function replica(url: string, options: ConstructorParameters<typeof OfflineReplica>[1]): OfflineReplica {
  const r = new OfflineReplica(url, options);
  replicas.push(r);
  return r.connect();
}

/** Cut the link and wait until the desktop replica has noticed. */
async function goOffline(desktop: OfflineReplica): Promise<void> {
  link.cut();
  await desktop.until(() => !desktop.connected, 'the disconnect');
}

/** Restore the link and wait for the replica's next welcome to have been settled. */
async function comeBack(desktop: OfflineReplica): Promise<void> {
  const before = desktop.welcomes;
  link.restore();
  desktop.bridge.reconnectNow();
  await desktop.until(() => desktop.welcomes > before, 'the reconnect');
}

/** Both replicas show the same deck, and so does a fresh look at the server. */
async function converged(...rs: OfflineReplica[]): Promise<Deck> {
  for (const r of rs) await r.until(() => r.bridge.unconfirmed === 0 && !r.bridge.isReconciling, 'confirmation');
  const probe = replica(direct(), { name: 'probe', plain: true });
  await probe.until(() => probe.welcomes > 0, 'probe welcome');
  for (const r of rs) {
    await r.until(() => JSON.stringify(r.deck) === JSON.stringify(probe.deck), `${r.bridge.clientId} to converge`);
  }
  return probe.deck!;
}

describe('a server deck kept on the desktop', () => {
  it('syncs both ways while connected', async () => {
    const desktop = replica(viaLink(), { name: 'Desktop' });
    const peer = replica(direct(), { name: 'Peer', plain: true });
    await desktop.until(() => desktop.welcomes > 0, 'welcome');
    await peer.until(() => peer.welcomes > 0, 'welcome');
    desktop.edit('Retitle', setHtml('s1', 't1', 'From desktop'));
    await peer.until(() => html(peer.deck, 's1', 't1') === 'From desktop', 'the desktop edit');
    peer.edit('Body', setHtml('s2', 'b2', 'From peer'));
    await desktop.until(() => html(desktop.deck, 's2', 'b2') === 'From peer', 'the peer edit');
    expect(desktop.merges).toEqual([]);
  });

  it('keeps editing offline and merges with the server on reconnect, without asking', async () => {
    const desktop = replica(viaLink(), { name: 'Desktop' });
    const peer = replica(direct(), { name: 'Peer', plain: true });
    await desktop.until(() => desktop.welcomes > 0, 'welcome');
    await peer.until(() => peer.welcomes > 0, 'welcome');

    await goOffline(desktop);
    desktop.edit('Offline title', setHtml('s1', 't1', 'Written offline'));
    desktop.edit('Offline slide', (deck) => {
      deck.slides.splice(2, 0, { id: 'offline-new', name: 'New', elements: [], timeline: [] } as never);
    });
    desktop.edit('Offline delete', (deck) => { deck.slides = deck.slides.filter((s) => s.id !== 's4'); });
    peer.edit('Peer body', setHtml('s2', 'b2', 'Peer meanwhile'));
    peer.edit('Peer same slide, other object', setHtml('s1', 'b1', 'Peer on slide 1'));
    await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');
    // Offline edits are on screen and nothing reached the server.
    expect(html(desktop.deck, 's1', 't1')).toBe('Written offline');
    expect(html(peer.deck, 's1', 't1')).toBe('Title 1');

    await comeBack(desktop);
    const deck = await converged(desktop, peer);
    expect(desktop.merges).toHaveLength(1);
    expect(desktop.merges[0].dialog).toBe(false);
    expect(ids(deck)).toEqual(['s1', 's2', 'offline-new', 's3']);
    expect(html(deck, 's1', 't1')).toBe('Written offline');
    expect(html(deck, 's1', 'b1')).toBe('Peer on slide 1');
    expect(html(deck, 's2', 'b2')).toBe('Peer meanwhile');
  });

  it('asks about a slide both sides changed, and lands the side chosen', async () => {
    let asked: string[] = [];
    const desktop = replica(viaLink(), {
      name: 'Desktop',
      choose: (plan) => {
        asked = plan.items.filter((i) => i.conflict).map((i) => i.key);
        return { [slideKey('s1')]: 'local', [slideKey('s3')]: 'remote' };
      },
    });
    const peer = replica(direct(), { name: 'Peer', plain: true });
    await desktop.until(() => desktop.welcomes > 0, 'welcome');
    await peer.until(() => peer.welcomes > 0, 'welcome');

    await goOffline(desktop);
    desktop.edit('Mine 1', setHtml('s1', 't1', 'Desktop 1'));
    desktop.edit('Mine 3', setHtml('s3', 't3', 'Desktop 3'));
    peer.edit('Theirs 1', setHtml('s1', 't1', 'Peer 1'));
    peer.edit('Theirs 3', setHtml('s3', 't3', 'Peer 3'));
    await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');

    await comeBack(desktop);
    const deck = await converged(desktop, peer);
    expect(asked.sort()).toEqual([slideKey('s1'), slideKey('s3')]);
    expect(html(deck, 's1', 't1')).toBe('Desktop 1');
    expect(html(deck, 's3', 't3')).toBe('Peer 3');
  });

  it('a slide deleted on one side and edited on the other can be kept', async () => {
    const desktop = replica(viaLink(), { name: 'Desktop', choose: () => ({ [slideKey('s2')]: 'remote' }) });
    const peer = replica(direct(), { name: 'Peer', plain: true });
    await desktop.until(() => desktop.welcomes > 0, 'welcome');
    await peer.until(() => peer.welcomes > 0, 'welcome');
    await goOffline(desktop);
    desktop.edit('Delete 2', (deck) => { deck.slides = deck.slides.filter((s) => s.id !== 's2'); });
    peer.edit('Edit 2', setHtml('s2', 'b2', 'Keep me'));
    await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');
    await comeBack(desktop);
    const deck = await converged(desktop, peer);
    expect(ids(deck)).toEqual(['s1', 's2', 's3', 's4']);
    expect(html(deck, 's2', 'b2')).toBe('Keep me');
  });

  it('asks about the order when both sides rearranged slides', async () => {
    const desktop = replica(viaLink(), { name: 'Desktop', choose: () => ({ [ORDER_KEY]: 'local' }) });
    const peer = replica(direct(), { name: 'Peer', plain: true });
    await desktop.until(() => desktop.welcomes > 0, 'welcome');
    await peer.until(() => peer.welcomes > 0, 'welcome');
    await goOffline(desktop);
    desktop.edit('Reverse', (deck) => { deck.slides.reverse(); });
    peer.edit('Rotate', (deck) => { deck.slides.push(deck.slides.shift()!); });
    await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');
    await comeBack(desktop);
    expect(ids(await converged(desktop, peer))).toEqual(['s4', 's3', 's2', 's1']);
  });

  it('keeps edits made after the app was closed offline and reopened (seeded from disk)', async () => {
    const first = replica(viaLink(), { name: 'Desktop' });
    await first.until(() => first.welcomes > 0, 'welcome');
    await goOffline(first);
    first.edit('Offline', setHtml('s4', 't4', 'Before quitting'));
    // What the desktop would have persisted: the deck on screen, and the
    // server state it last knew.
    const persisted = { baseline: first.bridge.baseline()!, local: first.deck!, themeCss: first.themeCss };
    first.close();

    const peer = replica(direct(), { name: 'Peer', plain: true });
    await peer.until(() => peer.welcomes > 0, 'welcome');
    peer.edit('Peer', setHtml('s1', 'b1', 'While the laptop was shut'));
    await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');

    link.restore();
    const reopened = replica(viaLink(), { name: 'Desktop', seed: persisted });
    // Editable before the server answers.
    expect(html(reopened.deck, 's4', 't4')).toBe('Before quitting');
    await reopened.until(() => reopened.welcomes > 0, 'welcome');
    const deck = await converged(reopened, peer);
    expect(html(deck, 's4', 't4')).toBe('Before quitting');
    expect(html(deck, 's1', 'b1')).toBe('While the laptop was shut');
  });

  it('a merge that takes a while lands on top of what the server did meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const desktop = replica(viaLink(), {
      name: 'Desktop',
      choose: async () => {
        await gate;
        return { [slideKey('s1')]: 'local' };
      },
    });
    const peer = replica(direct(), { name: 'Peer', plain: true });
    await desktop.until(() => desktop.welcomes > 0, 'welcome');
    await peer.until(() => peer.welcomes > 0, 'welcome');
    await goOffline(desktop);
    desktop.edit('Mine', setHtml('s1', 't1', 'Desktop'));
    peer.edit('Theirs', setHtml('s1', 't1', 'Peer'));
    await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');
    link.restore();
    desktop.bridge.reconnectNow();
    await desktop.until(() => desktop.bridge.isReconciling, 'the dialog');
    // While the person is choosing, the server moves on…
    peer.edit('Later', setHtml('s3', 'b3', 'While choosing'));
    await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');
    // …and the screen keeps showing the unmerged local deck.
    expect(html(desktop.deck, 's3', 'b3')).toBe('Body 3');
    release();
    const deck = await converged(desktop, peer);
    expect(html(deck, 's1', 't1')).toBe('Desktop');
    expect(html(deck, 's3', 'b3')).toBe('While choosing');
  });

  it('survives the link dropping again while the dialog is open', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const desktop = replica(viaLink(), {
      name: 'Desktop',
      choose: async () => {
        await gate;
        return { [slideKey('s2')]: 'local' };
      },
    });
    const peer = replica(direct(), { name: 'Peer', plain: true });
    await desktop.until(() => desktop.welcomes > 0, 'welcome');
    await peer.until(() => peer.welcomes > 0, 'welcome');
    await goOffline(desktop);
    desktop.edit('Mine', setHtml('s2', 't2', 'Desktop'));
    peer.edit('Theirs', setHtml('s2', 't2', 'Peer'));
    await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');
    link.restore();
    desktop.bridge.reconnectNow();
    await desktop.until(() => desktop.bridge.isReconciling, 'the dialog');
    // The baseline to persist is still the one the merge started from.
    expect(html(desktop.bridge.baseline()!.deck, 's2', 't2')).toBe('Title 2');
    await goOffline(desktop);
    release();
    await desktop.until(() => !desktop.bridge.isReconciling, 'the dialog to close');
    // Offline again: the choice is on screen and waiting to be sent.
    expect(html(desktop.deck, 's2', 't2')).toBe('Desktop');
    expect(desktop.bridge.unconfirmed).toBe(1);
    await comeBack(desktop);
    const deck = await converged(desktop, peer);
    expect(html(deck, 's2', 't2')).toBe('Desktop');
    // The second reconnect merged from the server state the first one saw:
    // the person's choice was not asked again.
    expect(desktop.merges.filter((m) => m.dialog)).toHaveLength(1);
  });

  it('merges theme.css edits, and asks when both sides edited it', async () => {
    const desktop = replica(viaLink(), { name: 'Desktop', choose: () => ({ [THEME_KEY]: 'local' }) });
    const peer = replica(direct(), { name: 'Peer', plain: true });
    await desktop.until(() => desktop.welcomes > 0, 'welcome');
    await peer.until(() => peer.welcomes > 0, 'welcome');

    await goOffline(desktop);
    desktop.setTheme('.role-title { color: red; }');
    await comeBack(desktop);
    await peer.until(() => peer.themeCss === '.role-title { color: red; }', 'theme to reach the peer');
    expect(desktop.merges.at(-1)!.dialog).toBe(false);

    await goOffline(desktop);
    desktop.setTheme('.role-title { color: green; }');
    peer.setTheme('.role-title { color: blue; }');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await comeBack(desktop);
    expect(desktop.merges.at(-1)!.dialog).toBe(true);
    await peer.until(() => peer.themeCss === '.role-title { color: green; }', 'the chosen theme');
  });

  it('an edit sent just before the link died is neither lost nor doubled', async () => {
    const desktop = replica(viaLink(), { name: 'Desktop' });
    const peer = replica(direct(), { name: 'Peer', plain: true });
    await desktop.until(() => desktop.welcomes > 0, 'welcome');
    await peer.until(() => peer.welcomes > 0, 'welcome');
    desktop.edit('Add a slide', (deck) => {
      deck.slides.push({ id: 'racing', name: 'Racing', elements: [], timeline: [] } as never);
    });
    // Cut before the echo can come back; the server may or may not have it.
    link.cut();
    await desktop.until(() => !desktop.connected, 'the disconnect');
    await comeBack(desktop);
    const deck = await converged(desktop, peer);
    expect(ids(deck).filter((id) => id === 'racing')).toHaveLength(1);
    expect(desktop.merges.every((m) => !m.dialog)).toBe(true);
  });
});

/**
 * A seeded walk: the desktop and a collaborator edit at random while the link
 * goes down and comes back, conflicts are answered at random, and at the end
 * every replica and the server hold the same valid deck. Edits that only one
 * side made to a slide survive whatever was answered elsewhere.
 * `REMOTE_FUZZ_SEEDS` / `REMOTE_FUZZ_STEPS` walk it longer.
 */
describe('offline editing, fuzzed', () => {
  const seeds = Number(process.env.REMOTE_FUZZ_SEEDS ?? 6);
  const steps = Number(process.env.REMOTE_FUZZ_STEPS ?? 30);

  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (let seed = 1; seed <= seeds; seed++) {
    it(`converges on seed ${seed}`, async () => {
      const rand = rng(seed);
      let fresh = 0;
      const desktop = replica(viaLink(), {
        name: 'Desktop',
        choose: (plan) => Object.fromEntries(plan.items.filter((i) => i.conflict)
          .map((i) => [i.key, rand() < 0.5 ? 'local' : 'remote'])),
      });
      const peer = replica(direct(), { name: 'Peer', plain: true });
      await desktop.until(() => desktop.welcomes > 0, 'welcome');
      await peer.until(() => peer.welcomes > 0, 'welcome');
      /** The last text each side typed into a box during the current offline spell. */
      const solo = new Map<string, { slideId: string; text: string; side: 'desktop' | 'peer' }>();
      let offlineTouched = { desktop: new Set<string>(), peer: new Set<string>() };

      const randomEdit = (who: OfflineReplica, tag: 'D' | 'P') => {
        const deck = who.deck!;
        const roll = rand();
        const slides = deck.slides;
        if (roll < 0.15) {
          who.edit('add', (d) => {
            d.slides.splice(Math.floor(rand() * (d.slides.length + 1)), 0, {
              id: `${tag}s${fresh}`, name: '', timeline: [],
              elements: [{ id: `${tag}e${fresh++}`, type: 'text', x: 0, y: 0, w: 100, h: 50, html: 'new' }],
            } as never);
          });
        } else if (roll < 0.25 && slides.length > 2) {
          const victim = slides[Math.floor(rand() * slides.length)].id;
          who.edit('delete', (d) => { d.slides = d.slides.filter((s) => s.id !== victim); });
          (tag === 'D' ? offlineTouched.desktop : offlineTouched.peer).add(victim);
        } else if (roll < 0.35) {
          who.edit('move', (d) => {
            const [moved] = d.slides.splice(Math.floor(rand() * d.slides.length), 1);
            d.slides.splice(Math.floor(rand() * (d.slides.length + 1)), 0, moved);
          });
        } else {
          const slide = slides[Math.floor(rand() * slides.length)];
          const element = slide.elements[Math.floor(rand() * slide.elements.length)];
          if (!element) return;
          const text = `${tag}${fresh++}`;
          who.edit('type', setHtml(slide.id, element.id, text));
          (tag === 'D' ? offlineTouched.desktop : offlineTouched.peer).add(slide.id);
          if (link.isCut) solo.set(`${tag}:${element.id}`, { slideId: slide.id, text, side: tag === 'D' ? 'desktop' : 'peer' });
        }
      };

      for (let step = 0; step < steps; step++) {
        const roll = rand();
        if (roll < 0.12 && !link.isCut) {
          // Settle first: an edit still in flight at the cut belongs to the
          // spell (the racing-cut test above covers that on its own).
          await converged(desktop, peer);
          await goOffline(desktop);
          offlineTouched = { desktop: new Set(), peer: new Set() };
          solo.clear();
        } else if (roll < 0.24 && link.isCut) {
          await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');
          await comeBack(desktop);
          await converged(desktop, peer);
          // Text typed on a slide the other side never touched while apart
          // lands as typed, whatever was answered about other slides.
          for (const [key, { slideId, text, side }] of solo) {
            const other = side === 'desktop' ? offlineTouched.peer : offlineTouched.desktop;
            if (other.has(slideId)) continue;
            const elementId = key.slice(2);
            const now = desktop.deck!.slides.flatMap((s) => s.elements).find((e) => e.id === elementId) as { html?: string } | undefined;
            // Gone only if its own side deleted the slide afterwards.
            if (!now) {
              expect((side === 'desktop' ? offlineTouched.desktop : offlineTouched.peer).has(slideId), `seed ${seed}: ${elementId}`).toBe(true);
              continue;
            }
            expect(now.html, `seed ${seed}: ${side}'s ${text} in ${elementId}`).toBe(text);
          }
          solo.clear();
        } else if (roll < 0.62) {
          randomEdit(desktop, 'D');
        } else {
          randomEdit(peer, 'P');
        }
      }
      if (link.isCut) {
        await peer.until(() => peer.bridge.unconfirmed === 0, 'peer confirmation');
        await comeBack(desktop);
      }
      const deck = await converged(desktop, peer);
      expect(deck.slides.length).toBeGreaterThan(0);
      expect(JSON.stringify(desktop.deck)).toBe(JSON.stringify(deck));
    }, 60_000);
  }
});
