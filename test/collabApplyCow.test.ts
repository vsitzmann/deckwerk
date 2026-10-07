import { describe, expect, it } from 'vitest';
import { DeckSchema, emptyDeck, parseDeck, type Deck, type Slide, type SlideElement } from '../src/shared/deck.js';
import type { AgentOperation } from '../src/shared/agent.js';
import { applyOpsLenient, type LenientApplyResult } from '../src/shared/collabApply.js';

/**
 * applyOpsLenient is copy-on-write: it must produce exactly what the
 * whole-deck implementation produced (parse, clone, apply, prune, parse) —
 * byte for byte, key order included, since replicas and the store compare
 * decks as JSON — while never mutating its input and handing back every
 * slide no op touched as the very same object.
 */

// ---------------------------------------------------------------------------
// The previous implementation, kept verbatim as the reference oracle.

function oracleApply(deck: Deck, ops: AgentOperation[]): LenientApplyResult {
  const next = structuredClone(parseDeck(deck));
  const skipped: LenientApplyResult['skipped'] = [];
  const skip = (op: AgentOperation, reason: string) => skipped.push({ op, reason });
  for (const op of ops) oracleApplyOne(next, op, skip);
  for (const slide of next.slides) {
    const local = new Set(slide.elements.map((element) => element.id));
    slide.timeline = slide.timeline.filter((entry) =>
      local.has(entry.action.target) && (!entry.trigger.ref || local.has(entry.trigger.ref)));
  }
  return { deck: DeckSchema.parse(next), skipped };
}

function oracleApplyOne(
  deck: Deck,
  op: AgentOperation,
  skip: (op: AgentOperation, reason: string) => void,
): void {
  const indexOfSlide = (id: string) => deck.slides.findIndex((slide) => slide.id === id);
  switch (op.op) {
    case 'insertSlides': {
      const existing = new Set(deck.slides.map((slide) => slide.id));
      const fresh = op.slides.filter((slide) => !existing.has(slide.id));
      if (fresh.length === 0) return skip(op, 'all slide ids already present');
      const at = op.afterSlideId === null
        ? 0
        : indexOfSlide(op.afterSlideId) === -1
          ? deck.slides.length
          : indexOfSlide(op.afterSlideId) + 1;
      deck.slides.splice(at, 0, ...structuredClone(fresh));
      return;
    }
    case 'replaceSlide': {
      const at = indexOfSlide(op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      if (op.slide.id !== op.slideId) return skip(op, 'replacement changes slide id');
      deck.slides[at] = structuredClone(op.slide);
      return;
    }
    case 'deleteSlide': {
      const at = indexOfSlide(op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} already deleted`);
      if (deck.slides.length === 1) return skip(op, 'a deck must retain at least one slide');
      deck.slides.splice(at, 1);
      return;
    }
    case 'moveSlide': {
      if (op.afterSlideId === op.slideId) return skip(op, 'slide cannot follow itself');
      const from = indexOfSlide(op.slideId);
      if (from === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      if (op.afterSlideId !== null && indexOfSlide(op.afterSlideId) === -1) {
        return skip(op, `anchor ${op.afterSlideId} no longer exists`);
      }
      const [slide] = deck.slides.splice(from, 1);
      const at = op.afterSlideId === null ? 0 : indexOfSlide(op.afterSlideId) + 1;
      deck.slides.splice(at, 0, slide);
      return;
    }
    case 'insertElements': {
      const slide = deck.slides.find((candidate) => candidate.id === op.slideId);
      if (!slide) return skip(op, `slide ${op.slideId} no longer exists`);
      const existing = new Set<string>();
      for (const s of deck.slides) for (const element of s.elements) existing.add(element.id);
      const fresh = op.elements.filter((element) => !existing.has(element.id));
      if (fresh.length === 0) return skip(op, 'all element ids already present');
      slide.elements.push(...structuredClone(fresh));
      return;
    }
    case 'replaceElement': {
      const slide = deck.slides.find((candidate) => candidate.id === op.slideId);
      if (!slide) return skip(op, `slide ${op.slideId} no longer exists`);
      const at = slide.elements.findIndex((element) => element.id === op.elementId);
      if (at === -1) return skip(op, `element ${op.elementId} no longer exists`);
      if (op.element.id !== op.elementId) return skip(op, 'replacement changes element id');
      slide.elements[at] = structuredClone(op.element);
      return;
    }
    case 'deleteElements': {
      const slide = deck.slides.find((candidate) => candidate.id === op.slideId);
      if (!slide) return skip(op, `slide ${op.slideId} no longer exists`);
      const ids = new Set(op.elementIds);
      const before = slide.elements.length;
      slide.elements = slide.elements.filter((element) => !ids.has(element.id));
      if (slide.elements.length === before) return skip(op, 'no listed element still exists');
      slide.timeline = slide.timeline.filter((entry) =>
        !ids.has(entry.action.target) && !(entry.trigger.ref && ids.has(entry.trigger.ref)));
      return;
    }
    case 'updateDeck':
      if (op.title !== undefined) deck.title = op.title;
      if (op.canvas !== undefined) deck.canvas = structuredClone(op.canvas);
      if (op.theme !== undefined) deck.theme = op.theme;
      if (op.themePreset !== undefined) deck.themePreset = op.themePreset;
      if (op.themeStyle !== undefined) deck.themeStyle = structuredClone(op.themeStyle);
      if (op.themeSelection !== undefined) deck.themeSelection = structuredClone(op.themeSelection);
      if (op.themeHistory !== undefined) deck.themeHistory = [...op.themeHistory];
      if (op.customThemes !== undefined) deck.customThemes = structuredClone(op.customThemes);
      if (op.layoutMasters !== undefined) deck.layoutMasters = structuredClone(op.layoutMasters);
      if (op.morphEasing !== undefined) deck.morphEasing = op.morphEasing;
      return;
    case 'setSlideProperties': {
      const at = indexOfSlide(op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      if (op.slide.id !== op.slideId) return skip(op, 'properties change slide id');
      deck.slides[at] = {
        ...deck.slides[at],
        ...structuredClone(op.slide),
        elements: deck.slides[at].elements,
      };
      for (const key of op.clear ?? []) {
        if (key === 'id' || key === 'elements') continue;
        delete (deck.slides[at] as Record<string, unknown>)[key];
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures and a seeded op generator.

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Raw (unparsed) element: the op payload path must normalise it. */
function rawElement(id: string, html = id): SlideElement {
  return { id, type: 'text', x: 1, y: 2, w: 100, h: 50, html } as unknown as SlideElement;
}

function rawSlide(id: string, elementIds: string[]): Slide {
  return {
    id,
    name: id,
    elements: elementIds.map((elementId) => rawElement(elementId)),
    timeline: elementIds.slice(0, 2).map((elementId, i) => ({
      id: `${id}-t${i}`,
      trigger: i === 0 ? { on: 'click' } : { on: 'withPrev', ref: elementIds[0] },
      action: { type: 'appear', target: elementId },
    })),
  } as unknown as Slide;
}

function baseDeck(): Deck {
  return parseDeck({
    ...emptyDeck('COW'),
    slides: Array.from({ length: 6 }, (_, s) =>
      rawSlide(`s${s}`, Array.from({ length: 3 }, (_, e) => `s${s}e${e}`))),
  });
}

function randomOps(deck: Deck, rand: () => number, serial: { n: number }): AgentOperation[] {
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const slideIds = [...deck.slides.map((slide) => slide.id), 'gone-slide'];
  const elementIds = [...deck.slides.flatMap((slide) => slide.elements.map((e) => e.id)), 'gone-el'];
  const ops: AgentOperation[] = [];
  const count = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < count; i++) {
    const fresh = `n${serial.n++}`;
    const slideId = pick(slideIds);
    const live = deck.slides.find((slide) => slide.id === slideId);
    const localIds = live ? live.elements.map((e) => e.id) : ['gone-el'];
    switch (Math.floor(rand() * 11)) {
      case 0:
        ops.push({
          op: 'insertSlides',
          afterSlideId: rand() < 0.2 ? null : pick(slideIds), // includes a vanished anchor
          slides: [rawSlide(fresh, [`${fresh}e0`, `${fresh}e1`]), ...(rand() < 0.3 ? [rawSlide(pick(slideIds), [])] : [])],
        });
        break;
      case 1:
        ops.push({ op: 'deleteSlide', slideId });
        break;
      case 2:
        ops.push({ op: 'moveSlide', slideId, afterSlideId: rand() < 0.2 ? null : pick(slideIds) });
        break;
      case 3:
        ops.push({
          op: 'insertElements',
          slideId,
          elements: [rawElement(`${fresh}x`), ...(rand() < 0.3 ? [rawElement(pick(elementIds))] : [])],
        });
        break;
      case 4: {
        const elementId = pick(localIds);
        ops.push({
          op: 'replaceElement',
          slideId,
          elementId,
          element: rawElement(rand() < 0.1 ? 'other-id' : elementId, `edited ${fresh}`),
        });
        break;
      }
      case 5:
        ops.push({ op: 'deleteElements', slideId, elementIds: [pick(localIds), ...(rand() < 0.3 ? [pick(elementIds)] : [])] });
        break;
      case 6: {
        const patches = [
          { id: slideId, name: `renamed ${fresh}` },
          { id: slideId, notes: `notes ${fresh}` },
          { id: slideId, skipped: true, layout: 'title' },
          { id: slideId, timeline: [] },
          { id: slideId, morphFromPrevious: true, morphDuration: 700 },
        ];
        const clears = [undefined, ['skipped'], ['notes'], ['layout', 'name'], ['timeline'], ['elements', 'id']];
        const clear = pick(clears);
        ops.push({
          op: 'setSlideProperties',
          slideId,
          slide: pick(patches) as never,
          ...(clear ? { clear } : {}),
        });
        break;
      }
      case 7:
        ops.push({
          op: 'replaceSlide',
          slideId,
          slide: rawSlide(rand() < 0.1 ? 'renamed-id' : slideId, [`${fresh}r0`]),
        });
        break;
      case 8:
        ops.push({ op: 'updateDeck', title: `Title ${fresh}`, themeHistory: [fresh] });
        break;
      case 9:
        ops.push({ op: 'updateDeck', canvas: { w: 1280, h: 720 }, morphEasing: 'linear' });
        break;
      default:
        ops.push({ op: 'updateDeck', title: deck.title });
        break;
    }
  }
  return ops;
}

/** Slide ids an op list could have changed. */
function mentionedSlides(ops: AgentOperation[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) {
    if ('slideId' in op) ids.add(op.slideId);
    if (op.op === 'insertSlides') for (const slide of op.slides) ids.add(slide.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------

describe('applyOpsLenient copy-on-write', () => {
  it('matches the whole-deck implementation, never mutates, and shares untouched slides', () => {
    let compared = 0;
    let oracleThrew = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rand = mulberry32(seed);
      const serial = { n: 0 };
      let deck = deepFreeze(baseDeck());
      for (let step = 0; step < 12; step++) {
        const ops = randomOps(deck, rand, serial);
        const before = JSON.stringify(deck);
        const actual = applyOpsLenient(deck, ops);
        const where = `seed ${seed} step ${step}: ${JSON.stringify(ops)}`;
        // Input untouched (it is frozen too, so a write would have thrown).
        expect(JSON.stringify(deck), where).toBe(before);
        let expected: LenientApplyResult | null = null;
        try {
          expected = oracleApply(deck, ops);
        } catch {
          // The old implementation was not total: clearing `timeline` left
          // it undefined for the prune to trip over. The new one restores
          // the default first; its result must still be a fully parsed deck.
          oracleThrew += 1;
        }
        if (expected) {
          expect(JSON.stringify(actual.deck), where).toBe(JSON.stringify(expected.deck));
          expect(actual.skipped, where).toEqual(expected.skipped);
        }
        expect(JSON.stringify(actual.deck), where).toBe(JSON.stringify(DeckSchema.parse(actual.deck)));
        compared += expected ? 1 : 0;
        expect(actual.deck, where).not.toBe(deck);
        const touched = mentionedSlides(ops);
        const inputById = new Map(deck.slides.map((slide) => [slide.id, slide]));
        for (const slide of actual.deck.slides) {
          if (touched.has(slide.id)) continue;
          expect(slide, `${where} slide ${slide.id}`).toBe(inputById.get(slide.id));
        }
        deck = deepFreeze(actual.deck);
      }
    }
    expect(compared).toBeGreaterThan(600);
    expect(oracleThrew).toBeLessThan(120);
  });

  it('keeps untouched elements of a touched slide and unchanged deck properties', () => {
    const deck = deepFreeze(baseDeck());
    const { deck: next } = applyOpsLenient(deck, [
      { op: 'replaceElement', slideId: 's2', elementId: 's2e1', element: rawElement('s2e1', 'changed') },
      { op: 'updateDeck', title: 'Renamed' },
    ]);
    expect(next.slides[2]).not.toBe(deck.slides[2]);
    expect(next.slides[2].elements[0]).toBe(deck.slides[2].elements[0]);
    expect(next.slides[2].elements[2]).toBe(deck.slides[2].elements[2]);
    expect(next.slides[2].elements[1]).not.toBe(deck.slides[2].elements[1]);
    expect(next.title).toBe('Renamed');
    expect(next.canvas).toBe(deck.canvas);
    expect(next.themeHistory).toBe(deck.themeHistory);
    for (const i of [0, 1, 3, 4, 5]) expect(next.slides[i]).toBe(deck.slides[i]);
  });

  it('prunes a timeline only on the slide whose element went away', () => {
    const deck = deepFreeze(baseDeck());
    const { deck: next } = applyOpsLenient(deck, [
      { op: 'deleteElements', slideId: 's1', elementIds: ['s1e0'] },
    ]);
    // s1e0 was both a target and a trigger ref: both entries go.
    expect(next.slides[1].timeline).toEqual([]);
    expect(next.slides[0]).toBe(deck.slides[0]);
    expect(next.slides[0].timeline).toHaveLength(2);
  });

  it('a fully skipped transaction shares every slide', () => {
    const deck = deepFreeze(baseDeck());
    const { deck: next, skipped } = applyOpsLenient(deck, [
      { op: 'deleteSlide', slideId: 'gone' },
      { op: 'replaceElement', slideId: 's0', elementId: 'gone', element: rawElement('gone') },
      { op: 'deleteElements', slideId: 's0', elementIds: ['gone'] },
      { op: 'moveSlide', slideId: 's0', afterSlideId: 'gone' },
    ]);
    expect(skipped).toHaveLength(4);
    next.slides.forEach((slide, i) => expect(slide).toBe(deck.slides[i]));
  });

  it('a setSlideProperties clear restores the field default, as a whole-deck parse did', () => {
    const deck = deepFreeze(baseDeck());
    const ops: AgentOperation[] = [
      { op: 'setSlideProperties', slideId: 's3', slide: { id: 's3', notes: 'hello', skipped: true }, clear: ['notes', 'timeline'] },
    ];
    const { deck: next } = applyOpsLenient(deck, ops);
    expect(next.slides[3].notes).toBe('');
    expect(next.slides[3].timeline).toEqual([]);
    expect(next.slides[3].skipped).toBe(true);
    // The old implementation threw here (see above); a whole-deck parse of
    // the result is the guarantee it was meant to give.
    expect(() => oracleApply(deck, ops)).toThrow();
    expect(JSON.stringify(next)).toBe(JSON.stringify(DeckSchema.parse(next)));
  });
});
