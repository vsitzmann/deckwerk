import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findHostingServer } from '../src/cli/hostedDeck.js';
import { AGENT_HOST_FILE } from '../src/main/agentHost.js';
import { loadDeck, saveDeck } from '../src/main/deckStore.js';
import { CollabSession } from '../src/server/collabSession.js';
import { mergeDiskChange } from '../src/server/diskMerge.js';
import type { AgentOperation } from '../src/shared/agent.js';
import { emptyDeck, parseDeck, type Deck, type Slide, type SlideElement } from '../src/shared/deck.js';

/**
 * A deck.json written beside a server that holds the deck.
 *
 * The server used to adopt such a file wholesale, which dropped every edit
 * it had accepted but the writer had not seen, and to ignore it outright
 * while a save was pending, which dropped the file's change and let the next
 * autosave write over it — the agent that wrote it had been told it landed.
 * Now the file is merged into the live deck (server/diskMerge.ts), and the
 * CLI does not write there at all while a server is up (cli/hostedDeck.ts).
 */

function text(id: string, html: string): SlideElement {
  return {
    id, type: 'text', x: 160, y: 200, w: 1600, h: 200, rot: 0, z: 1, opacity: 1, class: ['role-body'],
    style: {}, html, align: 'left', valign: 'top',
  } as SlideElement;
}

function slide(id: string, html: string): Slide {
  return { ...emptyDeck('x').slides[0], id, elements: [text(`${id}-body`, html)], timeline: [] };
}

function deckOf(...slides: Slide[]): Deck {
  const deck = emptyDeck('Disk merge');
  deck.slides = slides;
  return parseDeck(deck);
}

const withSlide = (deck: Deck, id: string, html: string): Deck => ({
  ...deck,
  slides: deck.slides.map((s) => (s.id === id ? slide(id, html) : s)),
});

const bodies = (deck: Deck) => deck.slides.map((s) => `${s.id}:${(s.elements[0] as { html: string }).html}`);

describe('merging a deck.json written beside the live deck', () => {
  const a = deckOf(slide('one', 'One'), slide('two', 'Two'));

  it('keeps the live edits the file has not seen and takes the file\'s own', () => {
    const live = withSlide(a, 'one', 'One, typed');
    const disk = { ...a, slides: [...a.slides, slide('three', 'Agent')] };
    const { deck, keptLive } = mergeDiskChange([a], live, disk);
    expect(bodies(deck)).toEqual(['one:One, typed', 'two:Two', 'three:Agent']);
    expect(keptLive).toEqual([]);
  });

  it('does not take back an autosaved edit when the file was written from a copy read before it', () => {
    // The writer read `a`; the server then saved `saved`; then the writer
    // wrote `a` plus its slide. Against the newest save alone the file looks
    // as if it deliberately reverted slide one.
    const saved = withSlide(a, 'one', 'One, typed');
    const disk = { ...a, slides: [...a.slides, slide('three', 'Agent')] };
    const { deck } = mergeDiskChange([a, saved], saved, disk);
    expect(bodies(deck)).toEqual(['one:One, typed', 'two:Two', 'three:Agent']);
  });

  it('puts back an older state written on purpose (a restore, a git checkout)', () => {
    const saved = withSlide(a, 'one', 'One, typed');
    const { deck } = mergeDiskChange([a, saved], saved, a);
    expect(bodies(deck)).toEqual(['one:One', 'two:Two']);
  });

  it('keeps the live edit where both changed the same object, and says so', () => {
    const live = withSlide(a, 'two', 'Two, typed');
    const disk = withSlide(a, 'two', 'Two, by the script');
    const { deck, keptLive } = mergeDiskChange([a], live, disk);
    expect(bodies(deck)).toEqual(['one:One', 'two:Two, typed']);
    expect(keptLive).toEqual(['two']);
  });
});

describe('a session with deck.json changed under it', () => {
  let dir = '';
  let session: CollabSession | null = null;
  const seen: Array<{ ops: AgentOperation[]; label: string }> = [];

  afterEach(async () => {
    await session?.close();
    session = null;
    seen.length = 0;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = '';
  });

  async function open(deck: Deck): Promise<CollabSession> {
    dir = await mkdtemp(join(tmpdir(), 'disk-merge-'));
    await saveDeck(dir, deck);
    await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; }\n');
    session = await CollabSession.open(dir);
    session.watch({
      onExternalOps: (ops, _seq, _txnId, label) => { seen.push({ ops, label }); },
      onExternalTheme: () => undefined,
    });
    return session;
  }

  /** What a careful outside writer does: a temporary file renamed over deck.json. */
  async function writeBeside(deck: Deck): Promise<void> {
    const temporary = join(dir, '.deck.json.writing');
    await writeFile(temporary, `${JSON.stringify(deck, null, 2)}\n`);
    await rename(temporary, join(dir, 'deck.json'));
  }

  const typing = (s: CollabSession, html: string): void => {
    const element = s.deck.slides[0].elements[0];
    s.applyOps([{ op: 'replaceElement', slideId: 'one', elementId: element.id, element: { ...element, html } as SlideElement }], {
      label: 'Edit text', author: { name: 'Typist', agent: false, via: 'socket' },
    });
  };

  async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }

  it('merges a file written while a save is pending, instead of saving over it', async () => {
    const s = await open(deckOf(slide('one', 'One'), slide('two', 'Two')));
    const read = await loadDeck(dir);
    typing(s, 'One, typed'); // a save is now pending
    await writeBeside({ ...read, slides: [...read.slides, slide('agent', 'Agent')] });
    await until(() => seen.length > 0, 'the change on disk was never merged');
    expect(bodies(s.deck)).toEqual(['one:One, typed', 'two:Two', 'agent:Agent']);
    expect(seen[0].label).toBe('deck.json changed on disk');
    await s.flush();
    expect(bodies(await loadDeck(dir))).toEqual(['one:One, typed', 'two:Two', 'agent:Agent']);
  });

  it('keeps an autosaved edit when the file was written from a copy read before that save', async () => {
    const s = await open(deckOf(slide('one', 'One'), slide('two', 'Two')));
    const read = await loadDeck(dir);
    typing(s, 'One, typed');
    await s.flush();
    expect(bodies(await loadDeck(dir))[0]).toBe('one:One, typed');
    await writeBeside({ ...read, slides: [...read.slides, slide('agent', 'Agent')] });
    await until(() => seen.length > 0, 'the change on disk was never merged');
    expect(bodies(s.deck)).toEqual(['one:One, typed', 'two:Two', 'agent:Agent']);
    await s.flush();
    expect(bodies(await loadDeck(dir))).toEqual(['one:One, typed', 'two:Two', 'agent:Agent']);
  });

  it('merges a file the watcher has not reported yet before its own save writes', async () => {
    const s = await open(deckOf(slide('one', 'One'), slide('two', 'Two')));
    const read = await loadDeck(dir);
    typing(s, 'One, typed');
    await writeBeside({ ...read, slides: [...read.slides, slide('agent', 'Agent')] });
    // Straight away: the save must notice the file is not the one it left.
    await s.flush();
    expect(bodies(await loadDeck(dir))).toEqual(['one:One, typed', 'two:Two', 'agent:Agent']);
    expect(bodies(s.deck)).toEqual(['one:One, typed', 'two:Two', 'agent:Agent']);
  });

  it('merges a file written in the instant the session closes into its last save', async () => {
    const s = await open(deckOf(slide('one', 'One'), slide('two', 'Two')));
    const read = await loadDeck(dir);
    typing(s, 'One, typed');
    await writeBeside({ ...read, slides: [...read.slides, slide('agent', 'Agent')] });
    await s.close();
    session = null;
    expect(bodies(await loadDeck(dir))).toEqual(['one:One, typed', 'two:Two', 'agent:Agent']);
  });

  it('takes no notice of its own saves', async () => {
    const s = await open(deckOf(slide('one', 'One')));
    typing(s, 'One, typed');
    await s.flush();
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    expect(seen).toEqual([]);
  });
});

describe('finding the server that hosts a deck folder', () => {
  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  it('names the deck by its path under the served folder, and ignores a marker whose server is gone', async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-host-'));
    const deckDir = join(root, 'Talks', 'Rank symposium');
    await mkdir(deckDir, { recursive: true });
    expect(await findHostingServer(deckDir)).toBeNull();

    const marker = { version: 1, url: 'http://127.0.0.1:5800', token: 't', pid: process.pid, startedAt: new Date().toISOString() };
    await writeFile(join(root, AGENT_HOST_FILE), JSON.stringify(marker));
    expect(await findHostingServer(deckDir)).toEqual({
      url: 'http://127.0.0.1:5800', token: 't', pid: process.pid, deckId: 'Talks/Rank symposium',
    });

    // Killed without removing it: no process behind the pid any more.
    await writeFile(join(root, AGENT_HOST_FILE), JSON.stringify({ ...marker, pid: 2 ** 22 - 7 }));
    expect(await findHostingServer(deckDir)).toBeNull();
    expect(JSON.parse(await readFile(join(root, AGENT_HOST_FILE), 'utf8')).token).toBe('t');
  });
});
