import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deck } from '../src/shared/deck.js';
import { loadDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { eventually } from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import { ThrottledLink } from './support/throttledLink.js';
import {
  browsersFromEnv,
  editorState,
  exitPresentation,
  haveFfmpeg,
  imageElement,
  openPage,
  pressPresent,
  presentJump,
  presentKey,
  stageComplete,
  stageState,
  takeFirstFrames,
  watchPresentation,
  writeFixtureDeck,
  type DrivenPage,
  DWELL_MS,
  type EditorState,
  type FirstFrame,
  type OfflineBrowserKind,
} from './support/offlinePresenting.js';

/**
 * A seeded walk of a person using the browser editor while its server comes
 * and goes, checked after every move against a model of what must be on
 * screen.
 *
 * Moves: open a deck, wait a while, wait for the offline copy, lose the link
 * (refused, a black hole, the WebSocket alone), get it back, press Present,
 * step forward and back and jump, end the show, reload, add an image to a
 * slide (online, and offline, where the edit is discarded on reconnect), and
 * switch to the other deck.
 *
 * The model knows, per deck, whether this browser has a complete offline
 * copy (the editor said so, and nothing was added since), whether it has a
 * snapshot to open without a server, and what the server holds. It demands:
 *
 * - a deck opened or reloaded with the link up shows the server's deck, its
 *   slide painted; with the link down, the snapshot if there is one, painted
 *   if the copy is complete;
 * - Present without the server presents exactly when the copy is complete,
 *   and otherwise says why, never mounting an overlay that cannot load;
 * - every slide of a presentation that the copy covers (or that the link
 *   serves) shows every picture in its first frame and plays every clip,
 *   and no media element fails;
 * - once the link is back the editor reconnects and shows the server's
 *   deck, an edit made offline gone.
 *
 * Knobs, after the repo's other fuzzers: OFFLINE_FUZZ_SEEDS (comma-
 * separated; FUZZ_SEED, the nightly's rotated seed, is added), OFFLINE_FUZZ_STEPS,
 * OFFLINE_FUZZ_BROWSERS (chromium, chrome, safari; safari is added by
 * RUN_SAFARI_MEDIA_BUDGET=1). A failure prints the trail and the line to
 * replay it.
 */

const STEPS = Number.parseInt(process.env.OFFLINE_FUZZ_STEPS ?? '', 10) || 16;
const SEEDS = [
  ...(process.env.OFFLINE_FUZZ_SEEDS?.split(',').map((value) => Number.parseInt(value, 10)).filter(Number.isFinite) ?? [1]),
  ...(process.env.FUZZ_SEED ? [Number.parseInt(process.env.FUZZ_SEED, 10)].filter(Number.isFinite) : []),
];
const BROWSERS = browsersFromEnv('OFFLINE_FUZZ_BROWSERS', [
  'chromium',
  ...(process.env.RUN_SAFARI_MEDIA_BUDGET === '1' ? ['safari' as const] : []),
]);
const LINK = { bytesPerSecond: 12_000_000, latencyMs: 20 };
const DECKS = ['talk-a', 'talk-b'] as const;
type DeckId = typeof DECKS[number];

/** mulberry32: small, seedable, good enough to choose moves. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let workDir = '';
let decksRoot = '';
let server: RunningCollabServer | null = null;
let link: ThrottledLink | null = null;
let origin = '';
let page: DrivenPage | null = null;
const spares: Record<DeckId, string[]> = { 'talk-a': [], 'talk-b': [] };

beforeAll(async () => {
  if (!haveFfmpeg || BROWSERS.length === 0) return;
  workDir = await mkdtemp(join(tmpdir(), 'offline-fuzz-'));
  decksRoot = join(workDir, 'decks');
  await mkdir(decksRoot, { recursive: true });
  spares['talk-a'] = (await writeFixtureDeck(join(decksRoot, 'talk-a'), 'Talk A', {
    slides: 6, photosPerSlide: [3, 0, 5, 1], clipEvery: 2, photoFiles: 10, clipFiles: 2, clipSeconds: 10, sparePhotos: 24,
  })).spares;
  spares['talk-b'] = (await writeFixtureDeck(join(decksRoot, 'talk-b'), 'Talk B', {
    slides: 4, photosPerSlide: [2, 4], clipEvery: 3, photoFiles: 6, clipFiles: 1, clipSeconds: 8, sparePhotos: 24,
  })).spares;
}, 600_000);

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

afterEach(async () => {
  await page?.close();
  page = null;
  await link?.close();
  link = null;
  await server?.close();
  server = null;
});

/** What the walk believes; checked against the browser after every move. */
interface Model {
  link: 'up' | 'refused' | 'blackhole';
  /** The deck the editor tab is on, or null before the first open. */
  open: DeckId | null;
  presenting: boolean;
  /** The presentation may be checked slide by slide: the copy or the link covers it. */
  presentationCovered: boolean;
  /**
   * The show began from a complete copy: every picture is local, so each
   * slide shows its pictures in its first frame. A show begun cold over the
   * network may paint a slide it reaches before the pictures arrive.
   */
  presentationLocal: boolean;
  /** The link went down at some point during this show. */
  showLostLink: boolean;
  /** Per deck: the editor said the copy was complete, and nothing was added since. */
  complete: Record<DeckId, boolean>;
  /** Per deck: a snapshot was kept (the deck was open online for a moment). */
  snapshot: Record<DeckId, boolean>;
  /** The worker is installed in this browser. */
  shell: boolean;
  /** Images added offline, which the reconnect must discard. */
  offlineEdits: number;
  /** The tab shows a deck from the server (welcomed) right now. */
  connected: boolean;
}

class Walk {
  readonly trail: string[] = [];
  readonly problems: string[] = [];
  readonly model: Model = {
    link: 'up', open: null, presenting: false, presentationCovered: false, presentationLocal: false, showLostLink: false,
    complete: { 'talk-a': false, 'talk-b': false }, snapshot: { 'talk-a': false, 'talk-b': false },
    shell: false, offlineEdits: 0, connected: false,
  };
  private spareUsed = 0;
  /** Slides this show has had on stage (their pictures may be kept decoded). */
  private seen = new Set<string>();
  /** Slides in the order they appeared, and the one on stage. */
  private recent: string[] = [];
  private last = '';

  constructor(private readonly page: DrivenPage, private readonly rand: () => number) {}

  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)];
  }

  private fail(problem: string): void {
    this.problems.push(`step ${this.trail.length}: ${problem}`);
  }

  private async state(): Promise<EditorState | null> {
    return editorState(this.page).catch(() => null);
  }

  /** The server's deck, as it has saved it. */
  private async serverDeck(id: DeckId): Promise<Deck> {
    await server!.flush();
    return loadDeck(join(decksRoot, id));
  }

  /** The moves that make sense now, weighted by repetition. */
  private moves(): Array<() => Promise<string>> {
    const m = this.model;
    // Nothing answers a page in a black hole before the worker is installed:
    // the browser spins until it is stopped. A WebDriver navigation cannot
    // be stopped, so Safari leaves that dead end alone.
    const deadEnd = m.link === 'blackhole' && !m.shell && !this.page.stop;
    const moves: Array<() => Promise<string>> = deadEnd ? [] : [() => this.open(this.pick(DECKS))];
    if (m.open === null) return moves.length > 0 ? moves : [() => this.restore()];
    moves.push(() => this.wait());
    if (!deadEnd) moves.push(() => this.reload());
    if (m.presenting) {
      moves.push(() => this.step(), () => this.step(), () => this.step(), () => this.step(), () => this.endShow());
    } else {
      moves.push(() => this.present(), () => this.present(), () => this.addImage());
      moves.push(() => this.open(m.open === 'talk-a' ? 'talk-b' : 'talk-a'));
    }
    if (m.link === 'up') {
      moves.push(() => this.awaitCopy(), () => this.awaitCopy(), () => this.lose(), () => this.lose(), () => this.dropSocket());
    } else {
      moves.push(() => this.restore(), () => this.restore());
    }
    return moves;
  }

  async move(): Promise<void> {
    const started = Date.now();
    const label = await this.pick(this.moves())();
    this.trail.push(label);
    // As it happens: a walk that hangs says where.
    if (process.env.OFFLINE_FUZZ_VERBOSE !== '0') console.log(`offline fuzz step ${this.trail.length}: ${label} (${Date.now() - started} ms)`);
    await this.noteShell();
  }

  private async noteShell(): Promise<void> {
    if (this.model.shell || this.model.link !== 'up') return;
    this.model.shell = (await this.state())?.shell === 'ready';
  }

  /* --- moves ---------------------------------------------------------------- */

  private async open(id: DeckId): Promise<string> {
    const m = this.model;
    if (m.presenting) await this.endShow();
    await this.page.goto(`${origin}/?deck=${id}&name=Fuzz`).catch(() => undefined);
    m.open = id;
    m.presenting = false;
    await this.giveUpOnDeadEnd();
    await this.expectDeck(`open ${id}`);
    return `open ${id} (link ${m.link})`;
  }

  private async reload(): Promise<string> {
    const m = this.model;
    await this.page.reload().catch(() => undefined);
    m.presenting = false;
    await this.giveUpOnDeadEnd();
    await this.expectDeck('reload');
    return `reload (link ${m.link})`;
  }

  /** A page that nothing can answer (a black hole, no worker yet) spins: stop it, as a person would. */
  private async giveUpOnDeadEnd(): Promise<void> {
    if (this.model.link !== 'blackhole' || this.model.shell) return;
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await this.page.stop?.();
    // The tab stays on the page it had: that is the deck on screen.
    const href = await this.page.evaluate<string>('location.href').catch(() => '');
    const shown = href ? new URL(href).searchParams.get('deck') : null;
    if (shown === 'talk-a' || shown === 'talk-b') this.model.open = shown;
  }

  /** After an open or a reload: what the editor must show. */
  private async expectDeck(what: string): Promise<void> {
    const m = this.model;
    const id = m.open!;
    m.connected = false;
    if (m.link === 'up') {
      const server = await this.serverDeck(id);
      const state = await eventually(() => editorState(this.page), `${what}: the editor`,
        (s) => s.collabReady && s.slides === server.slides.length && s.unpainted.length === 0, 90_000)
        .catch(() => this.state());
      if (!state?.collabReady || state.slides !== server.slides.length) {
        this.fail(`${what} online: showed ${state?.slides} slides (server ${server.slides.length}), ${state?.status}`);
      } else if (state.unpainted.length > 0) {
        this.fail(`${what} online: unpainted ${state.unpainted.join(', ')}`);
      }
      m.connected = true;
      // The snapshot is written as the deck opens.
      await new Promise((resolve) => setTimeout(resolve, 500));
      m.snapshot[id] = true;
      return;
    }
    if (!m.shell || !m.snapshot[id]) {
      // Nothing to open it from: the page may be the browser's error page or an editor waiting for its server.
      return;
    }
    const expected = (await this.serverDeck(id)).slides.length;
    const state = await eventually(() => editorState(this.page), `${what}: the offline copy`,
      (s) => s.offlineDeck && s.slides === expected && (!m.complete[id] || s.unpainted.length === 0), 60_000)
      .catch(() => this.state());
    if (!state?.offlineDeck || state.slides !== expected) {
      this.fail(`${what} without the server: showed ${state?.slides} slides of ${expected}, offlineDeck ${state?.offlineDeck}, ${state?.status}`);
    } else if (m.complete[id] && state.unpainted.length > 0) {
      this.fail(`${what} without the server, copy complete: unpainted ${state.unpainted.join(', ')}`);
    }
  }

  private async wait(): Promise<string> {
    const ms = Math.round(500 + this.rand() * 7_500);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return `wait ${ms} ms`;
  }

  private async awaitCopy(): Promise<string> {
    const m = this.model;
    // The browser's error page, from a load the link refused: a person reloads it.
    if (!(await this.state())?.deckShown) await this.reload();
    if (m.presenting) {
      // The copy downloads only while nothing is presented.
      await this.endShow();
    }
    const state = await eventually(() => editorState(this.page), 'the copy', (s) => s.offline === 'ready', 180_000)
      .catch(() => this.state());
    if (state?.offline !== 'ready') this.fail(`the copy of ${m.open} never completed: ${state?.offline}, ${state?.status}`);
    else m.complete[m.open!] = true;
    return `await the copy of ${m.open}`;
  }

  private async lose(): Promise<string> {
    const how = this.pick(['refused', 'blackhole'] as const);
    await link!.down(how);
    this.model.link = how;
    if (this.model.presenting) this.model.showLostLink = true;
    this.model.connected = false;
    return `link ${how}`;
  }

  private async dropSocket(): Promise<string> {
    const before = await this.state();
    link!.dropWebSockets();
    // The session comes straight back: a new welcome, not a flag a browser
    // has not cleared yet. An edit made in between is discarded on
    // reconnect (collabBridge.ts), which is not this walk's subject.
    if (before?.collabReady) {
      await eventually(() => editorState(this.page), 'reconnect after the WebSocket dropped',
        (s) => s.collabReady && s.welcomes > before.welcomes, 30_000)
        .catch(() => this.fail('never reconnected after the WebSocket dropped'));
    }
    return 'drop the WebSocket';
  }

  private async restore(): Promise<string> {
    const m = this.model;
    await link!.up();
    m.link = 'up';
    const id = m.open;
    if (!id) return 'link up';
    const state = await this.state();
    // A tab that never had its page cannot reconnect by itself.
    if (!state?.deckShown) return 'link up (no editor to reconnect)';
    const server = await this.serverDeck(id);
    // A fresh welcome: a browser that never noticed the link went still says connected.
    const after = await eventually(() => editorState(this.page), 'reconnect',
      (s) => s.collabReady && s.welcomes > state.welcomes && s.slides === server.slides.length, 60_000).catch(() => this.state());
    if (!after?.collabReady || after.welcomes <= state.welcomes) this.fail(`never reconnected once the link was back: ${after?.status}`);
    m.connected = Boolean(after?.collabReady);
    if (m.connected) {
      m.snapshot[id] = true;
      // Edits made while the link was down are gone; the server's deck is what shows.
      const expected = server.slides.flatMap((s) => s.elements).filter((e) => e.type === 'image').length;
      const images = await eventually(
        () => this.page.evaluate<number>(`window.store.get().deck.slides.flatMap((s) => s.elements).filter((e) => e.type === 'image').length`),
        'the editor showing the server\'s deck', (count) => count === expected, 15_000,
      ).catch(() => -1);
      if (images !== expected) this.fail(`after reconnecting the editor holds a different number of images from the server's ${expected}`);
      m.offlineEdits = 0;
    }
    return 'link up';
  }

  private async present(): Promise<string> {
    const m = this.model;
    const id = m.open!;
    const before = await this.state();
    if (!before?.deckShown) return 'present (no deck on screen)';
    const pressed = await pressPresent(this.page);
    const online = pressed.connectedAtClick;
    if (!online) {
      const ready = pressed.offlineAtClick === 'ready';
      if (pressed.mounted && !ready) this.fail('Present mounted a presentation without the server or a complete copy');
      if (!pressed.mounted && ready) this.fail(`Present was refused with a complete copy: ${pressed.status}`);
      if (!pressed.mounted && !pressed.status.includes('Presenting needs the server')) this.fail(`Present refused without the reason: ${pressed.status}`);
      if (!pressed.mounted && m.complete[id]) {
        // The editor said the copy was complete and nothing was added since.
        this.fail(`the copy of ${id} was complete, yet Present was refused (${before.offline}): ${pressed.status}`);
      }
    }
    if (!pressed.mounted) return `present refused (${pressed.status.slice(-60)})`;
    if (m.link !== 'up' && online) {
      // The editor did not know the link was gone yet. With a worker the show
      // comes from the shell; without one nothing can answer for it, and the
      // overlay must come down with the reason rather than stay up black.
      const outcome = await eventually(() => this.page.evaluate<{ stage: boolean; overlay: boolean; status: string }>(`({
        stage: Boolean(document.querySelector('iframe[src*="present.html"]')?.contentDocument?.querySelector('#stage .stage > .slide')),
        overlay: Boolean(document.querySelector('iframe[src*="present.html"]')),
        status: document.getElementById('status')?.textContent ?? '',
      })`), 'the show began or said why not', (o) => o.stage || !o.overlay, 30_000).catch(() => null);
      if (!outcome) this.fail('Present without a server it did not know was gone: neither a show nor a reason');
      else if (!outcome.stage) {
        if (!outcome.status.includes('did not load')) this.fail(`a show that never loaded was taken down without the reason: ${outcome.status}`);
        return 'present (did not load: the link was gone)';
      }
    }
    m.presenting = true;
    this.seen.clear();
    m.presentationCovered = online || pressed.offlineAtClick === 'ready';
    m.presentationLocal = pressed.offlineAtClick === 'ready';
    m.showLostLink = !online;
    await watchPresentation(this.page).catch((error) => this.fail(`the presentation never built its stage: ${error}`));
    this.last = (await stageState(this.page).catch(() => ({ slideId: '' }))).slideId;
    this.seen.add(this.last);
    this.recent = [this.last];
    await this.checkStage('present');
    return `present (${online ? 'online' : 'offline'})`;
  }

  private async step(): Promise<string> {
    const m = this.model;
    const slides = (await this.serverDeck(m.open!)).slides.length;
    const roll = this.rand();
    let label: string;
    let jumpedToUnseen = false;
    if (roll < 0.45) {
      await presentKey(this.page, 'ArrowRight');
      label = 'next';
    } else if (roll < 0.8) {
      await presentKey(this.page, 'ArrowLeft');
      label = 'previous';
    } else {
      const target = Math.floor(this.rand() * slides);
      const deck = await this.serverDeck(m.open!);
      const from = deck.slides.findIndex((slide) => slide.id === this.last);
      // Only a jump next door, or back to a slide just shown, can count on decoded pictures.
      jumpedToUnseen = Math.abs(target - from) > 1 && !this.recent.slice(-3).includes(deck.slides[target]?.id ?? '');
      await presentJump(this.page, m.open!, target);
      label = `jump to ${target + 1}`;
    }
    await this.checkStage(label);
    await this.judgeFirstFrames(jumpedToUnseen);
    // A presenter says something about each slide (DWELL_MS, as the scenario walks).
    await new Promise((resolve) => setTimeout(resolve, DWELL_MS));
    return label;
  }

  /**
   * The first frame of every slide the last move put on stage. A jump to a
   * slide this show has not been near is excused: the Player decodes the
   * pictures of the slides around the one shown, and of slides shown
   * before, and nothing else (player.ts, `imageWarmSlides`, `shownImages`).
   */
  private async judgeFirstFrames(excused: boolean): Promise<void> {
    const m = this.model;
    const { frames, errors } = await takeFirstFrames(this.page).catch(() => ({ frames: [] as FirstFrame[], errors: [] as string[], ticks: 0 }));
    for (const frame of frames) {
      if (m.presentationLocal && !excused && frame.missing.length > 0) {
        this.fail(`${frame.slide} appeared without ${frame.missing.join(', ')}`);
      }
      this.seen.add(frame.slide);
      this.recent.push(frame.slide);
      this.last = frame.slide;
    }
    if (m.presentationLocal || (m.presentationCovered && !m.showLostLink)) {
      for (const error of errors) this.fail(`media element failed: ${error}`);
    }
  }

  private async checkStage(label: string): Promise<void> {
    const m = this.model;
    // Judged when the show began from a complete copy, or online without
    // losing the link since: a show that lost it may miss what it had not reached.
    if (!m.presentationLocal && !(m.presentationCovered && m.link === 'up' && !m.showLostLink)) return;
    const { state, problems } = await stageComplete(this.page, 20_000);
    for (const problem of problems) this.fail(`${label} (${state.slideId}, link ${m.link}): ${problem}`);
  }

  private async endShow(): Promise<string> {
    const m = this.model;
    if (!m.presenting) return 'end show (none)';
    await this.judgeFirstFrames(false);
    await exitPresentation(this.page).catch((error) => this.fail(`the show would not end: ${error}`));
    m.presenting = false;
    return 'end show';
  }

  /** Add one of the deck's unused photos to the slide shown, as a person dropping it there would. */
  private async addImage(): Promise<string> {
    const m = this.model;
    const id = m.open!;
    const state = await this.state();
    if (!state?.deckShown) return 'add an image (no deck)';
    // Online, a picture nobody has (an upload). Offline nothing can be
    // uploaded: a person duplicates a picture the deck already shows.
    const shown = (await this.serverDeck(id)).slides.flatMap((slide) => slide.elements)
      .filter((el) => el.type === 'image').map((el) => (el as { src: string }).src);
    // Online is the link being up: an editor that has not yet noticed the
    // link went (Safari takes a moment) is offline whatever it says, and
    // what it sends is discarded on reconnect, as any edit during an outage.
    const online = m.link === 'up' && state.collabReady;
    const src = online ? spares[id][this.spareUsed++ % spares[id].length] : this.pick(shown);
    const element = imageElement(`added-${this.spareUsed}-${Math.floor(this.rand() * 1e6)}`, src, 80 + Math.floor(this.rand() * 1200), 640, 320, 200);
    await this.page.evaluate(`(() => {
      const element = ${JSON.stringify(element)};
      window.store.commit((deck) => { deck.slides[window.store.get().slideIndex].elements.push(element); }, { label: 'Fuzz: add an image' });
      return true;
    })()`);
    if (online) {
      m.complete[id] = false;
      // The edit reaches the server; the picture is the editor's to paint.
      await eventually(() => this.serverDeck(id), 'the edit reached the server',
        (deck) => deck.slides.some((slide) => slide.elements.some((el) => el.id === element.id)), 30_000)
        .catch(() => this.fail(`an image added online never reached the server`));
      const painted = await eventually(() => editorState(this.page), 'the added image painted', (s) => s.unpainted.length === 0, 30_000)
        .catch(() => this.state());
      if (painted && painted.unpainted.length > 0) this.fail(`an image added online stayed unpainted: ${painted.unpainted.join(', ')}`);
      return `add ${src} to ${id} (online)`;
    }
    m.offlineEdits++;
    return `add ${src} to ${id} (offline, to be discarded)`;
  }
}

for (const kind of haveFfmpeg ? BROWSERS : []) {
  describe(`the editor losing its server, a seeded walk (${kind})`, () => {
    for (const seed of SEEDS) {
      it(`survives a ${STEPS}-step walk, seed ${seed}`, async () => {
        server = await startCollabServer({
          rootDir: decksRoot,
          clientDir: await collabClientDir(),
          host: '127.0.0.1',
          port: 0,
          mediaRenditions: { cacheDir: join(workDir, `renditions-${kind}-${seed}`) },
          printStillCacheDir: join(workDir, 'print-stills'),
        });
        link = new ThrottledLink(server.port, LINK);
        origin = `http://127.0.0.1:${await link.listen()}`;
        page = await openPage(kind as OfflineBrowserKind, join(workDir, `profile-${kind}-${seed}`));
        const walk = new Walk(page, random(seed));
        for (let step = 1; step <= STEPS; step++) {
          try {
            await walk.move();
          } catch (error) {
            walk.problems.push(`step ${step} threw: ${(error as Error).stack ?? error}`);
          }
          if (walk.problems.length > 0) {
            const storage = await page.evaluate<string>(`(async () => {
              try {
                const decks = await caches.open('deckwerk-decks');
                const keys = (await decks.keys()).map((r) => new URL(r.url).pathname + new URL(r.url).search);
                const index = await (await decks.match('/__offline__/index'))?.text();
                const media = (await (await caches.open('deckwerk-media')).keys()).length;
                return JSON.stringify({ keys, index, media, caches: await caches.keys(), controlled: Boolean(navigator.serviceWorker?.controller), url: location.href });
              } catch (error) { return String(error); }
            })()`).catch((error) => String(error));
            walk.problems.push(`browser storage: ${storage}`);
            throw new Error(`${walk.problems.join('\n')}\n\ntrail:\n${walk.trail.map((move, i) => `  ${i + 1}. ${move}`).join('\n')}`
              + `\n\nreplay: OFFLINE_FUZZ_SEEDS=${seed} OFFLINE_FUZZ_BROWSERS=${kind} OFFLINE_FUZZ_STEPS=${step}`);
          }
        }
        console.log(`offline fuzz (${kind}, seed ${seed}):\n${walk.trail.map((move, i) => `  ${i + 1}. ${move}`).join('\n')}`);
        expect(walk.trail.length).toBe(STEPS);
      }, 120_000 + STEPS * 90_000);
    }
  });
}

describe.skipIf(haveFfmpeg && BROWSERS.length > 0)('the editor losing its server, a seeded walk (skipped)', () => {
  it('needs ffmpeg and a browser (OFFLINE_FUZZ_BROWSERS)', () => {
    expect(haveFfmpeg && BROWSERS.length > 0).toBe(false);
  });
});
