import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import type { AgentOperation } from '../src/shared/agent.js';
import { applyOpsLenient } from '../src/shared/collabApply.js';
import { diffDecks } from '../src/shared/deckDiff.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * Per-transaction collaboration cost must follow what a transaction touched,
 * not the size of the deck.
 *
 * A hosted deck whose deck.json was 13.5 MB (one text box held a 10 MB
 * base64 blob) saturated every browser editing it: each incoming txn
 * parsed, cloned and stringified the whole deck several times over, on every
 * client, and every live-typing push did the same on the typist's machine.
 * The bounds below are deliberately generous — the old path took hundreds of
 * milliseconds per step on this deck — so they catch a whole-deck pass, not
 * scheduler noise.
 */

const SLIDES = 60;
const ELEMENTS_PER_SLIDE = 8;
const BLOB_BYTES = 10 * 1024 * 1024;

function largeDeck(): Deck {
  const blob = `<img src="data:image/png;base64,${'A'.repeat(BLOB_BYTES)}">`;
  return parseDeck({
    ...emptyDeck('Large'),
    slides: Array.from({ length: SLIDES }, (_, s) => ({
      id: `s${s}`,
      name: `Slide ${s}`,
      elements: Array.from({ length: ELEMENTS_PER_SLIDE }, (_, e) => ({
        id: `s${s}e${e}`,
        type: 'text',
        x: 10 * e,
        y: 10 * e,
        w: 400,
        h: 80,
        html: s === 7 && e === 3 ? blob : `<p>Slide ${s} box ${e} — some ordinary prose.</p>`,
      })),
      timeline: [{
        id: `s${s}t0`,
        trigger: { on: 'click' },
        action: { type: 'appear', target: `s${s}e1` },
      }],
    })),
  });
}

function editOp(deck: Deck, slide: number, element: number, html: string): AgentOperation {
  const target = deck.slides[slide].elements[element];
  return {
    op: 'replaceElement',
    slideId: deck.slides[slide].id,
    elementId: target.id,
    element: { ...structuredClone(target), html } as SlideElement,
  };
}

function htmlOf(element: SlideElement): string {
  return element.type === 'text' ? element.html : '';
}

/**
 * Store states, the bridge's shadow and every deck applyOpsLenient returns
 * now share slide objects, so none of them may be written in place. Frozen
 * (ES modules run strict), any such write throws.
 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function time(fn: () => void, runs = 5): number {
  fn(); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

describe('collaborative edit cost on a 13 MB deck', () => {
  const base = deepFreeze(largeDeck());

  it('applies a one-element transaction without a whole-deck pass', () => {
    let shadow = base;
    let n = 0;
    const ms = time(() => {
      shadow = applyOpsLenient(shadow, [editOp(shadow, 20, 2, `<p>typed ${n++}</p>`)]).deck;
    });
    console.info(`applyOpsLenient, one element: ${ms.toFixed(2)} ms`);
    expect(htmlOf(shadow.slides[7].elements[3]).length).toBeGreaterThan(BLOB_BYTES);
    expect(shadow.slides[7]).toBe(base.slides[7]);
    expect(ms).toBeLessThan(5);
  });

  it('absorbs a remote one-element transaction quickly and keeps untouched slides', () => {
    const store = new EditorStore(base, null);
    let shadow = base;
    let n = 0;
    const ms = time(() => {
      shadow = deepFreeze(applyOpsLenient(shadow, [editOp(shadow, 20, 2, `<p>remote ${n++}</p>`)]).deck);
      const before = deepFreeze(store.get().deck);
      store.applyRemote(shadow, 'Edit text (remote)');
      const after = store.get().deck;
      expect(htmlOf(after.slides[20].elements[2])).toBe(`<p>remote ${n - 1}</p>`);
      expect(after.slides[7]).toBe(before.slides[7]);
      expect(after.slides[19]).toBe(before.slides[19]);
    });
    console.info(`applyOpsLenient + applyRemote, one element: ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(20);
  });

  it('streams a live-typing commit without cloning the whole deck', () => {
    const store = new EditorStore(base, null);
    const sent: number[] = [];
    store.onLocalEdit = (_prev, _next, _label) => { sent.push(1); };
    let n = 0;
    const ms = time(() => {
      const html = `<p>typing ${n++}</p>`;
      store.commit((deck) => {
        const target = deck.slides[20].elements[2];
        if (target.type === 'text') target.html = html;
      }, { label: 'Edit text', transient: true, coalesceKey: 'text:s20e2' });
    });
    console.info(`transient commit, one element: ${ms.toFixed(2)} ms`);
    expect(sent.length).toBeGreaterThan(0);
    expect(store.get().deck.slides[7]).toBe(base.slides[7]);
    expect(ms).toBeLessThan(20);
  });

  it('stays cheap once the History log is full, and its base still materialises right', () => {
    const store = new EditorStore(base, null);
    let shadow = base;
    const decks: Deck[] = [];
    const samples: number[] = [];
    for (let i = 0; i < 320; i++) {
      // Alternating labels and targets: every transaction is its own row.
      shadow = applyOpsLenient(shadow, [editOp(shadow, i % 50, i % ELEMENTS_PER_SLIDE, `<p>v${i}</p>`)]).deck;
      const start = performance.now();
      store.applyRemote(shadow, i % 2 ? 'Edit text (remote)' : 'Move objects (remote)');
      samples.push(performance.now() - start);
      decks.push(store.get().deck);
    }
    const full = samples.slice(220);
    const mean = full.reduce((sum, ms) => sum + ms, 0) / full.length;
    console.info(`applyRemote with a full History log, mean: ${mean.toFixed(2)} ms`);
    expect(mean).toBeLessThan(20);
    const rows = store.history();
    expect(rows).toHaveLength(200);
    // Rows hold the states after transactions 120..319; restore the second
    // oldest, which needs the trimmed rows' operations folded in.
    const second = rows[rows.length - 2];
    expect(store.restoreHistory(second.id)).toBe(true);
    expect(JSON.stringify(store.get().deck)).toBe(JSON.stringify(decks[decks.length - 199]));
    // Restoring recorded one more row, trimming the oldest: the base moved on.
    expect(JSON.stringify(store.persistedHistory().base)).toBe(JSON.stringify(decks[decks.length - 199]));
  });

  it('never writes into a deck it shares with the collab bridge', () => {
    const store = new EditorStore(base, null);
    // The bridge in miniature: UI = shadow + unconfirmed local ops.
    let shadow = base;
    const pending: AgentOperation[][] = [];
    store.onLocalEdit = (prev, next) => { pending.push(diffDecks(prev, next)); };
    const remote = (slide: number, element: number, html: string) => {
      shadow = deepFreeze(applyOpsLenient(shadow, [editOp(shadow, slide, element, html)]).deck);
      let ui = shadow;
      for (const ops of pending) ui = deepFreeze(applyOpsLenient(ui, ops).deck);
      store.applyRemote(ui, 'Edit text (remote)');
      deepFreeze(store.get().deck);
    };
    remote(1, 0, '<p>a</p>');
    store.commit((deck) => { deck.slides[1].elements[1].x += 1; }, { label: 'Nudge' });
    deepFreeze(store.get().deck);
    // A drag with a peer's transaction landing mid-gesture (rebased).
    store.selectSlide(2);
    store.select(['s2e1']);
    store.beginTransaction();
    store.updateSelected((element) => { element.x += 5; });
    deepFreeze(store.get().deck);
    remote(3, 2, '<p>b</p>');
    store.updateSelected((element) => { element.x += 5; });
    store.endTransaction();
    const deck = store.get().deck;
    expect(htmlOf(deck.slides[1].elements[0])).toBe('<p>a</p>');
    expect(deck.slides[1].elements[1].x).toBe(base.slides[1].elements[1].x + 1);
    expect(deck.slides[2].elements[1].x).toBe(base.slides[2].elements[1].x + 10);
    expect(htmlOf(deck.slides[3].elements[2])).toBe('<p>b</p>');
    expect(deck.slides[7]).toBe(base.slides[7]);
  });
});
