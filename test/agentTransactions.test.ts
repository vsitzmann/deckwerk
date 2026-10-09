import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyAgentTransaction,
  validateDeckIntegrity,
  type AgentOperation,
  type AgentRequest,
  type AgentTransaction,
} from '../src/shared/agent.js';
import { type Deck, type Slide, type SlideElement, emptyDeck, parseDeck } from '../src/shared/deck.js';
import { RevisionConflict, applyTransactionOffline, validateDeckFolder } from '../src/main/agentDeck.js';
import {
  AgentRuntime,
  agentRuntimePaths,
  deckRevision,
  readAgentContextFile,
  readLiveAgentContext,
  waitForAgentResponse,
  writeAgentRequest,
} from '../src/main/agentRuntime.js';

/**
 * Transactions are the only way an agent changes a deck, so the properties
 * that matter are the boring ones: they either apply completely or not at all,
 * they refuse to run against a deck that moved underneath them, and they never
 * leave `deck.json` in a state the app would reject on load.
 */

const text = (
  id: string,
  html = 'Body',
  over: Partial<Extract<SlideElement, { type: 'text' }>> = {},
) => ({
  id, type: 'text' as const, x: 0, y: 0, w: 400, h: 100, rot: 0, z: 1, opacity: 1,
  class: [], style: {}, html, align: 'left' as const, valign: 'top' as const, ...over,
});

function slide(id: string, elements: Slide['elements'] = []): Slide {
  return parseDeck({
    version: 1,
    slides: [{ id, name: id, elements }],
  }).slides[0];
}

function fixture(): Deck {
  const deck = emptyDeck('Fixture');
  deck.slides = [
    slide('slide-1', [text('title-1', 'One')]),
    slide('slide-2', [text('title-2', 'Two')]),
    slide('slide-3', [text('title-3', 'Three')]),
  ];
  return parseDeck(deck);
}

function transaction(operations: AgentOperation[], deck: Deck, label = 'Agent edit'): AgentTransaction {
  return {
    version: 1,
    expectedRevision: deckRevision(deck),
    label,
    operations,
  };
}

describe('agent transaction operations', () => {
  it('inserts, moves and deletes slides by id', () => {
    const deck = fixture();
    const inserted = applyAgentTransaction(deck, transaction([
      { op: 'insertSlides', afterSlideId: 'slide-1', slides: [slide('slide-new', [text('new-1')])] },
    ], deck));
    expect(inserted.slides.map((s) => s.id)).toEqual(['slide-1', 'slide-new', 'slide-2', 'slide-3']);

    const moved = applyAgentTransaction(inserted, transaction([
      { op: 'moveSlide', slideId: 'slide-new', afterSlideId: null },
    ], inserted));
    expect(moved.slides.map((s) => s.id)).toEqual(['slide-new', 'slide-1', 'slide-2', 'slide-3']);

    const deleted = applyAgentTransaction(moved, transaction([
      { op: 'deleteSlide', slideId: 'slide-2' },
    ], moved));
    expect(deleted.slides.map((s) => s.id)).toEqual(['slide-new', 'slide-1', 'slide-3']);
  });

  it('replaces a slide together with its timeline in one operation', () => {
    const deck = fixture();
    const replacement: Slide = {
      ...deck.slides[1],
      elements: [text('title-2', 'Rewritten'), text('bullet-2', 'Added')],
      timeline: [{
        id: 'build-1',
        trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target: 'bullet-2', value: null },
      }],
    };
    const next = applyAgentTransaction(deck, transaction([
      { op: 'replaceSlide', slideId: 'slide-2', slide: replacement },
    ], deck));
    expect(next.slides[1].timeline).toHaveLength(1);
    expect(next.slides[1].timeline[0].action.target).toBe('bullet-2');
  });

  it('drops timeline entries that referenced a deleted element', () => {
    const deck = fixture();
    deck.slides[0].elements.push(text('bullet-1', 'Second'));
    deck.slides[0].timeline = [{
      id: 'build-1',
      trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'bullet-1', value: null },
    }];
    const next = applyAgentTransaction(deck, transaction([
      { op: 'deleteElements', slideId: 'slide-1', elementIds: ['bullet-1'] },
    ], deck));
    expect(next.slides[0].timeline).toEqual([]);
  });

  it('updates whitelisted deck fields and nothing else', () => {
    const deck = fixture();
    const next = applyAgentTransaction(deck, transaction([
      { op: 'updateDeck', title: 'MilliVid' },
    ], deck));
    expect(next.title).toBe('MilliVid');
    expect(next.slides).toHaveLength(3);
  });

  it('pairs Morph objects across a slide range in a single transaction', () => {
    // The plan's worked example: several slides are selected in the rail and
    // their matching objects get one shared identity per pair.
    const deck = emptyDeck('Range');
    deck.slides = [18, 19, 20, 21].map((n) =>
      slide(`slide-${n}`, [text(`equation-${n}`, 'E = mc^2'), text(`caption-${n}`, `Step ${n - 17}`)]));
    const parsed = parseDeck(deck);

    // Operations apply in array order, so the slide-level flag goes first and
    // the identity fields are written on top of the replaced slides.
    const operations: AgentOperation[] = parsed.slides.slice(1).map((current) => ({
      op: 'replaceSlide' as const,
      slideId: current.id,
      slide: { ...current, morphFromPrevious: true },
    }));
    operations.push(...parsed.slides.map((current) => ({
      op: 'replaceElement' as const,
      slideId: current.id,
      elementId: current.elements[0].id,
      element: { ...current.elements[0], morphId: 'mm-equation' },
    })));

    const next = applyAgentTransaction(parsed, transaction(operations, parsed, 'Pair equations'));
    expect(next.slides.map((s) => s.elements[0].morphId)).toEqual(
      ['mm-equation', 'mm-equation', 'mm-equation', 'mm-equation'],
    );
    expect(next.slides.slice(1).every((s) => s.morphFromPrevious)).toBe(true);
  });

  it('refuses unknown ids, id changes and duplicate ids, leaving the deck untouched', () => {
    const deck = fixture();
    const before = JSON.stringify(deck);

    expect(() => applyAgentTransaction(deck, transaction([
      { op: 'deleteElements', slideId: 'slide-1', elementIds: ['nope'] },
    ], deck))).toThrow(/Unknown element id/);

    expect(() => applyAgentTransaction(deck, transaction([
      { op: 'replaceSlide', slideId: 'slide-1', slide: slide('renamed') },
    ], deck))).toThrow(/must remain slide-1/);

    expect(() => applyAgentTransaction(deck, transaction([
      { op: 'insertElements', slideId: 'slide-2', elements: [text('title-1', 'Clash')] },
    ], deck))).toThrow(/Duplicate element id/);

    expect(JSON.stringify(deck)).toBe(before);
  });

  it('is all-or-nothing when a later operation fails', () => {
    const deck = fixture();
    const before = JSON.stringify(deck);
    expect(() => applyAgentTransaction(deck, transaction([
      { op: 'insertElements', slideId: 'slide-1', elements: [text('fresh', 'Kept?')] },
      { op: 'deleteSlide', slideId: 'missing-slide' },
    ], deck))).toThrow(/Unknown slide id/);
    expect(JSON.stringify(deck)).toBe(before);
  });

  it('rejects a timeline that points at an element the transaction removed', () => {
    const deck = fixture();
    const broken: Slide = {
      ...deck.slides[0],
      timeline: [{
        id: 'build-1',
        trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target: 'ghost', value: null },
      }],
    };
    expect(() => applyAgentTransaction(deck, transaction([
      { op: 'replaceSlide', slideId: 'slide-1', slide: broken },
    ], deck))).toThrow(/targets missing element ghost/);
  });

  it('reports missing assets when an asset checker is supplied', () => {
    const deck = fixture();
    deck.slides[0].elements.push({
      id: 'figure', type: 'image', x: 0, y: 0, w: 100, h: 100, rot: 0, z: 2, opacity: 1,
      class: [], style: {}, src: 'assets/absent.png', fit: 'contain', alt: '', sourceBox: null,
    });
    expect(validateDeckIntegrity(deck, () => false)).toContain(
      'Missing asset for figure: assets/absent.png',
    );
    expect(validateDeckIntegrity(deck, () => true)).toEqual([]);
  });
});

describe('the file-backed request bridge', () => {
  let dir: string;
  let stateDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-bridge-'));
    stateDir = await mkdtemp(join(tmpdir(), 'agent-bridge-state-'));
    process.env.DECKWERK_STATE_DIR = stateDir;
    await writeFile(join(dir, 'deck.json'), `${JSON.stringify(fixture(), null, 2)}\n`, 'utf8');
  });

  afterEach(async () => {
    delete process.env.DECKWERK_STATE_DIR;
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Stand in for the editor window on the far side of the IPC. */
  function fakeEditor() {
    const sent: Array<{ channel: string; payload: AgentRequest }> = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: AgentRequest) => sent.push({ channel, payload }),
      },
    };
    return { sent, win: win as unknown as BrowserWindow };
  }

  it('carries a request to the editor and its response back to the caller', async () => {
    const editor = fakeEditor();
    const runtime = new AgentRuntime(() => editor.win);
    await runtime.open(dir);

    const deck = fixture();
    const request: AgentRequest = {
      version: 1,
      id: 'req-round-trip',
      kind: 'transaction',
      transaction: transaction([{ op: 'updateDeck', title: 'Bridged' }], deck),
    };
    const responsePath = await writeAgentRequest(dir, request);

    // The runtime drains the inbox and hands the request to the renderer.
    await vi.waitFor(() => expect(editor.sent).toHaveLength(1), { timeout: 2_000 });
    expect(editor.sent[0].payload.id).toBe('req-round-trip');

    await runtime.respond({ version: 1, id: 'req-round-trip', status: 'applied', revision: 'a'.repeat(64) });
    const response = await waitForAgentResponse(responsePath, 2_000);
    expect(response).toMatchObject({ status: 'applied', id: 'req-round-trip' });

    await runtime.close();
  });

  it('publishes a live context and marks it dead on close', async () => {
    const editor = fakeEditor();
    const runtime = new AgentRuntime(() => editor.win);
    await runtime.open(dir);

    const deck = fixture();
    await runtime.publish({
      version: 1,
      deckRevision: deckRevision(deck),
      activeSlideId: 'slide-2',
      activeSlideIndex: 1,
      selectedSlideIds: ['slide-2'],
      selectedElementIds: ['title-2'],
      scenes: [],
    });

    const live = await readLiveAgentContext(dir);
    expect(live).toMatchObject({ live: true, activeSlideId: 'slide-2', pid: process.pid });

    // Closing the deck must not leave a sidecar claiming an editor is up.
    await runtime.close();
    expect(await readLiveAgentContext(dir)).toBeNull();
    expect(await readAgentContextFile(dir)).toMatchObject({ live: false, activeSlideId: 'slide-2' });
  });

  it('answers with an error when no editor is there to take the request', async () => {
    const runtime = new AgentRuntime(() => null);
    await runtime.open(dir);
    const responsePath = await writeAgentRequest(dir, {
      version: 1,
      id: 'req-no-editor',
      kind: 'dom',
      expectedRevision: deckRevision(fixture()),
    });
    const response = await waitForAgentResponse(responsePath, 2_000);
    expect(response).toMatchObject({ status: 'error' });
    expect(response.message).toMatch(/not available/);
    await runtime.close();
  });

  it('leaves a request another drain already took to that drain', async () => {
    // One atomic write fires several watch events, so drains overlap, and one
    // can list a request that another answers and removes before it reads it.
    // A dangling link is that request: listed, but gone when read.
    const runtime = new AgentRuntime(() => null);
    await runtime.open(dir);
    const paths = agentRuntimePaths(dir);
    await symlink(join(paths.inbox, 'gone.json'), join(paths.inbox, 'req-taken.json'));
    const internals = runtime as unknown as { drain(): Promise<void>; processing: Set<string> };
    await internals.drain();
    // The watcher's own drain may hold it still; wait until it has let go.
    await vi.waitFor(() => expect(internals.processing.size).toBe(0));
    // An ENOENT error here would overwrite the real answer — and could tell an
    // agent its change failed while the editor applies it.
    expect(existsSync(join(paths.responses, 'req-taken.json'))).toBe(false);
    await runtime.close();
  });

  it('sweeps temp files a killed session left behind', async () => {
    const paths = agentRuntimePaths(dir);
    await mkdir(paths.root, { recursive: true });
    await writeFile(join(paths.root, 'context.json.999.abcd.tmp'), '{"half":', 'utf8');

    const runtime = new AgentRuntime(() => null);
    await runtime.open(dir);
    expect((await readdir(paths.root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await runtime.close();
  });

  it('refuses a request id that could escape the inbox directory', async () => {
    await expect(writeAgentRequest(dir, {
      version: 1,
      id: '../../etc/passwd',
      kind: 'dom',
      expectedRevision: deckRevision(fixture()),
    })).rejects.toThrow(/Invalid request id/);
  });
});

describe('offline transactions', () => {
  let dir: string;
  let stateDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-deck-'));
    stateDir = await mkdtemp(join(tmpdir(), 'agent-state-'));
    process.env.DECKWERK_STATE_DIR = stateDir;
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'deck.json'), `${JSON.stringify(fixture(), null, 2)}\n`, 'utf8');
  });

  afterEach(async () => {
    delete process.env.DECKWERK_STATE_DIR;
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const onDisk = async (): Promise<Deck> =>
    parseDeck(JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')));

  it('applies a transaction to deck.json and reports the new revision', async () => {
    const deck = await onDisk();
    const result = await applyTransactionOffline(dir, transaction([
      { op: 'insertElements', slideId: 'slide-1', elements: [text('added', 'Offline')] },
    ], deck, 'Add a line'));

    const written = await onDisk();
    expect(written.slides[0].elements.map((e) => e.id)).toEqual(['title-1', 'added']);
    expect(result.revision).toBe(deckRevision(written));
    expect(result.revision).not.toBe(deckRevision(deck));
  });

  it('refuses a stale transaction and reports the revision to retry against', async () => {
    const deck = await onDisk();
    const stale = transaction([{ op: 'updateDeck', title: 'Stale' }], deck);
    await applyTransactionOffline(dir, transaction([{ op: 'updateDeck', title: 'First' }], deck));

    await expect(applyTransactionOffline(dir, stale)).rejects.toBeInstanceOf(RevisionConflict);
    const current = await onDisk();
    expect(current.title).toBe('First');
    await expect(applyTransactionOffline(dir, stale)).rejects.toMatchObject({
      revision: deckRevision(current),
    });
  });

  it('leaves deck.json byte-identical when the transaction is invalid', async () => {
    const before = await readFile(join(dir, 'deck.json'), 'utf8');
    const deck = await onDisk();
    await expect(applyTransactionOffline(dir, transaction([
      { op: 'insertElements', slideId: 'slide-1', elements: [text('ok')] },
      { op: 'deleteElements', slideId: 'slide-1', elementIds: ['ghost'] },
    ], deck))).rejects.toThrow(/Unknown element id/);
    expect(await readFile(join(dir, 'deck.json'), 'utf8')).toBe(before);
  });

  it('refuses to write a deck that references a missing asset', async () => {
    const deck = await onDisk();
    await expect(applyTransactionOffline(dir, transaction([
      {
        op: 'insertElements',
        slideId: 'slide-1',
        elements: [{
          id: 'figure', type: 'image', x: 0, y: 0, w: 100, h: 100, rot: 0, z: 2, opacity: 1,
          class: [], style: {}, src: 'assets/absent.png', fit: 'contain', alt: '', sourceBox: null,
        }],
      },
    ], deck))).rejects.toThrow(/Missing asset/);
    expect((await onDisk()).slides[0].elements).toHaveLength(1);
  });

  it('serialises concurrent writers so neither edit is silently lost', async () => {
    const deck = await onDisk();
    // Both transactions are prepared against the same revision. The lock makes
    // them run one after the other, so the second sees a moved deck and
    // conflicts rather than overwriting the first.
    const results = await Promise.allSettled([
      applyTransactionOffline(dir, transaction([{ op: 'updateDeck', title: 'A' }], deck)),
      applyTransactionOffline(dir, transaction([{ op: 'updateDeck', title: 'B' }], deck)),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflict);
    expect(['A', 'B']).toContain((await onDisk()).title);
  });

  it('validates a deck folder including its asset references', async () => {
    expect(await validateDeckFolder(dir)).toEqual([]);

    const deck = await onDisk();
    deck.slides[1].elements.push({
      id: 'figure', type: 'image', x: 0, y: 0, w: 100, h: 100, rot: 0, z: 2, opacity: 1,
      class: [], style: {}, src: 'assets/absent.png', fit: 'contain', alt: '', sourceBox: null,
    });
    await writeFile(join(dir, 'deck.json'), `${JSON.stringify(deck, null, 2)}\n`, 'utf8');
    expect(await validateDeckFolder(dir)).toEqual(['Missing asset for figure: assets/absent.png']);

    await writeFile(join(dir, 'deck.json'), '{ "version": 1, "slides": [ { } ] }', 'utf8');
    expect((await validateDeckFolder(dir))[0]).toMatch(/deck.json is not valid/);
  });
});
