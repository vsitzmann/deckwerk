import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Deck, type Slide, type SlideElement } from '../src/shared/deck.js';
import { diffDecks } from '../src/shared/deckDiff.js';
import { applyOpsLenient } from '../src/shared/collabApply.js';
import { applyAgentOperations, applyAgentTransaction, AGENT_PROTOCOL_VERSION } from '../src/shared/agent.js';
import { createHash } from 'node:crypto';

function textElement(id: string, overrides: Partial<SlideElement> = {}): SlideElement {
  return parseDeck({
    ...emptyDeck(),
    slides: [{ id: 'tmp', elements: [{ id, type: 'text', x: 0, y: 0, w: 100, h: 50, html: id, ...overrides }] }],
  }).slides[0].elements[0];
}

function slide(id: string, elementIds: string[] = []): Slide {
  return parseDeck({
    ...emptyDeck(),
    slides: [{
      id,
      name: id,
      elements: elementIds.map((elementId) => ({
        id: elementId, type: 'text', x: 0, y: 0, w: 100, h: 50, html: elementId,
      })),
    }],
  }).slides[0];
}

function deckWith(...slides: Slide[]): Deck {
  return parseDeck({ ...emptyDeck('Diff'), slides: structuredClone(slides) });
}

function expectRoundTrip(prev: Deck, next: Deck): void {
  const ops = diffDecks(prev, next);
  const { deck: rebuilt, skipped } = applyOpsLenient(prev, ops);
  expect(skipped).toEqual([]);
  expect(normalize(rebuilt)).toEqual(normalize(next));
}

/** Compare decks up to element array order (z governs render order). */
function normalize(deck: Deck): unknown {
  const parsed = parseDeck(deck);
  return {
    ...parsed,
    slides: parsed.slides.map((entry) => ({
      ...entry,
      elements: [...entry.elements].sort((a, b) => a.id.localeCompare(b.id)),
    })),
  };
}

describe('diffDecks round-trips', () => {
  it('returns no ops for identical decks', () => {
    const deck = deckWith(slide('s1', ['e1']), slide('s2', ['e2']));
    expect(diffDecks(deck, deck)).toEqual([]);
    expect(diffDecks(deck, structuredClone(deck))).toEqual([]);
  });

  it('diffs deck-level properties', () => {
    const prev = deckWith(slide('s1'));
    const next = structuredClone(prev);
    next.title = 'Renamed';
    next.canvas = { w: 1280, h: 720 };
    const ops = diffDecks(prev, next);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('updateDeck');
    expectRoundTrip(prev, next);
  });

  it('round-trips layout master changes used by persisted and collaborative history', () => {
    const prev = deckWith(slide('s1'));
    const next = structuredClone(prev);
    const blank = { background: { color: null, image: null }, elements: [] };
    next.layoutMasters = {
      freeform: structuredClone(blank),
      standard: structuredClone(blank),
      title: structuredClone(blank),
    };

    expectRoundTrip(prev, parseDeck(next));
  });

  it('diffs element edits, inserts, and deletes', () => {
    const prev = deckWith(slide('s1', ['e1', 'e2']), slide('s2', ['e3']));
    const next = structuredClone(prev);
    next.slides[0].elements[0].x = 400; // edit e1
    next.slides[0].elements.splice(1, 1); // delete e2
    next.slides[1].elements.push(textElement('e4')); // insert e4
    expectRoundTrip(prev, next);
  });

  it('puts re-added elements back in their place in the array, not at the end', () => {
    // Objects of equal z paint in array order, so an undone delete that came
    // back at the end of the array jumped in front of what it used to sit
    // behind — and the redo of the delete left it there.
    const order = (deck: Deck) => deck.slides.map((entry) => entry.elements.map((element) => element.id));
    const full = deckWith(slide('s1', ['a', 'b', 'c', 'd', 'e', 'f']));
    const thinned = structuredClone(full);
    thinned.slides[0].elements = thinned.slides[0].elements.filter((element) => !['a', 'c', 'd', 'f'].includes(element.id));
    // Undo of the delete, as both the collab layer and the local store apply it.
    const back = diffDecks(thinned, full);
    expect(order(applyOpsLenient(thinned, back).deck)).toEqual(order(full));
    expect(order(applyAgentOperations(thinned, back))).toEqual(order(full));
    // Into an empty slide, and after an anchor that has since gone (lenient).
    const empty = deckWith(slide('s1'));
    expect(order(applyOpsLenient(empty, diffDecks(empty, full)).deck)).toEqual(order(full));
    const withoutB = structuredClone(thinned);
    withoutB.slides[0].elements = withoutB.slides[0].elements.filter((element) => element.id !== 'b');
    expect(order(applyOpsLenient(withoutB, back).deck)).toEqual([['a', 'e', 'f', 'c', 'd']]);
  });

  it('diffs slide property changes without touching elements', () => {
    const prev = deckWith(slide('s1', ['e1']));
    const next = structuredClone(prev);
    next.slides[0].name = 'Renamed';
    next.slides[0].background.color = '#123456';
    next.slides[0].morphDuration = 500;
    const ops = diffDecks(prev, next);
    expect(ops.map((op) => op.op)).toEqual(['setSlideProperties']);
    expectRoundTrip(prev, next);
  });

  it('diffs slide inserts at start, middle, and end', () => {
    const prev = deckWith(slide('s1'), slide('s2'));
    const next = deckWith(slide('s0'), slide('s1'), slide('sMid'), slide('s2'), slide('s3a'), slide('s3b'));
    expectRoundTrip(prev, next);
  });

  it('diffs slide deletion', () => {
    const prev = deckWith(slide('s1'), slide('s2'), slide('s3'));
    const next = deckWith(slide('s1'), slide('s3'));
    expectRoundTrip(prev, next);
  });

  it('diffs pure reorders with minimal moves', () => {
    const prev = deckWith(slide('s1'), slide('s2'), slide('s3'), slide('s4'));
    const next = deckWith(slide('s2'), slide('s3'), slide('s4'), slide('s1'));
    const ops = diffDecks(prev, next);
    expect(ops.filter((op) => op.op === 'moveSlide')).toHaveLength(1);
    expectRoundTrip(prev, next);
  });

  it('diffs reorder combined with edit, insert, and delete', () => {
    const prev = deckWith(slide('s1', ['e1']), slide('s2', ['e2']), slide('s3', ['e3']));
    const next = structuredClone(prev);
    const [s1] = next.slides.splice(0, 1);
    next.slides.push(s1); // s2 s3 s1
    next.slides.splice(1, 0, slide('sNew', ['eNew'])); // s2 sNew s3 s1
    next.slides[0].elements[0].x = 777;
    next.slides.splice(2, 1); // drop s3
    expectRoundTrip(prev, next);
  });

  it('round-trips randomized mutation scripts', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T,>(list: T[]): T => list[Math.floor(rand() * list.length)];

    let counter = 0;
    for (let trial = 0; trial < 30; trial++) {
      const prev = deckWith(
        slide('a', ['a1', 'a2']), slide('b', ['b1']), slide('c', []), slide('d', ['d1', 'd2', 'd3']),
      );
      const next = structuredClone(prev);
      const mutations = 1 + Math.floor(rand() * 5);
      for (let m = 0; m < mutations; m++) {
        switch (pick(['edit', 'insertEl', 'deleteEl', 'insertSlide', 'deleteSlide', 'move', 'props'])) {
          case 'edit': {
            const target = pick(next.slides.filter((s) => s.elements.length > 0));
            if (target) pick(target.elements).x = Math.floor(rand() * 1000);
            break;
          }
          case 'insertEl':
            pick(next.slides).elements.push(textElement(`n${counter++}`));
            break;
          case 'deleteEl': {
            const target = pick(next.slides.filter((s) => s.elements.length > 0));
            if (target) target.elements.splice(Math.floor(rand() * target.elements.length), 1);
            break;
          }
          case 'insertSlide':
            next.slides.splice(Math.floor(rand() * (next.slides.length + 1)), 0, slide(`ns${counter++}`));
            break;
          case 'deleteSlide':
            if (next.slides.length > 1) next.slides.splice(Math.floor(rand() * next.slides.length), 1);
            break;
          case 'move': {
            const from = Math.floor(rand() * next.slides.length);
            const [moved] = next.slides.splice(from, 1);
            next.slides.splice(Math.floor(rand() * (next.slides.length + 1)), 0, moved);
            break;
          }
          case 'props':
            pick(next.slides).name = `renamed-${counter++}`;
            break;
        }
      }
      expectRoundTrip(prev, parseDeck(next));
    }
  });

  it('diff output also satisfies the strict transaction path', () => {
    const prev = deckWith(slide('s1', ['e1']), slide('s2', ['e2']));
    const next = structuredClone(prev);
    next.slides[0].elements[0].w = 640;
    next.slides[1].name = 'Strict';
    const ops = diffDecks(prev, next);
    const revision = createHash('sha256').update(JSON.stringify(parseDeck(prev))).digest('hex');
    const applied = applyAgentTransaction(prev, {
      version: AGENT_PROTOCOL_VERSION,
      expectedRevision: revision,
      label: 'strict',
      operations: ops,
    });
    expect(normalize(applied)).toEqual(normalize(next));
  });
});

describe('applyOpsLenient merge rules', () => {
  it('skips edits to deleted elements (delete wins)', () => {
    const base = deckWith(slide('s1', ['e1']));
    const deleted = applyOpsLenient(base, [
      { op: 'deleteElements', slideId: 's1', elementIds: ['e1'] },
    ]).deck;
    const edited = structuredClone(base);
    edited.slides[0].elements[0].x = 999;
    const editOps = diffDecks(base, edited);
    const { deck, skipped } = applyOpsLenient(deleted, editOps);
    expect(deck.slides[0].elements).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/no longer exists/);
  });

  it('drops re-inserted ids (idempotent under replay)', () => {
    const base = deckWith(slide('s1', ['e1']));
    const ops = diffDecks(deckWith(slide('s1')), base); // insertElements e1
    const { deck, skipped } = applyOpsLenient(base, ops);
    expect(deck.slides[0].elements).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it('never deletes the last remaining slide', () => {
    const base = deckWith(slide('only'));
    const { deck, skipped } = applyOpsLenient(base, [{ op: 'deleteSlide', slideId: 'only' }]);
    expect(deck.slides).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/at least one slide/);
  });

  it('appends inserted slides when their anchor was deleted concurrently', () => {
    const base = deckWith(slide('s1'), slide('s3'));
    const { deck, skipped } = applyOpsLenient(base, [
      { op: 'insertSlides', afterSlideId: 's2', slides: [structuredClone(slide('sNew'))] },
    ]);
    expect(skipped).toEqual([]);
    expect(deck.slides.map((s) => s.id)).toEqual(['s1', 's3', 'sNew']);
  });

  it('prunes timeline entries whose target was deleted on another replica', () => {
    const withTimeline = deckWith(slide('s1', ['e1', 'e2']));
    withTimeline.slides[0].timeline = [{
      id: 't1',
      trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'e1', value: null },
    }] as Slide['timeline'];
    const base = parseDeck(withTimeline);
    const { deck } = applyOpsLenient(base, [
      { op: 'deleteElements', slideId: 's1', elementIds: ['e1'] },
    ]);
    expect(deck.slides[0].timeline).toHaveLength(0);
  });

  it('converges two replicas replaying the same server order over different pending sets', () => {
    const base = deckWith(slide('s1', ['e1']), slide('s2', ['e2']));

    const editA = structuredClone(base);
    editA.slides[0].elements[0].x = 111;
    const opsA = diffDecks(base, editA);

    const editB = structuredClone(base);
    editB.slides[1].elements[0].y = 222;
    const opsB = diffDecks(base, editB);

    // Server order: A then B. Replica A had opsA pending; replica B had opsB pending.
    const serverDeck = applyOpsLenient(applyOpsLenient(base, opsA).deck, opsB).deck;

    // Replica A: shadow advances with confirmed A, then foreign B.
    const replicaA = applyOpsLenient(applyOpsLenient(base, opsA).deck, opsB).deck;
    // Replica B: foreign A arrives first, B still pending → UI = shadow+pending; then B confirms.
    const shadowAfterA = applyOpsLenient(base, opsA).deck;
    const replicaBOptimistic = applyOpsLenient(shadowAfterA, opsB).deck;
    const replicaB = applyOpsLenient(shadowAfterA, opsB).deck;

    for (const replica of [replicaA, replicaBOptimistic, replicaB]) {
      expect(normalize(replica)).toEqual(normalize(serverDeck));
    }
  });

  it('resolves concurrent edits to the same element by server order (LWW)', () => {
    const base = deckWith(slide('s1', ['e1']));
    const first = structuredClone(base);
    first.slides[0].elements[0].x = 1;
    const second = structuredClone(base);
    second.slides[0].elements[0].x = 2;
    const result = applyOpsLenient(
      applyOpsLenient(base, diffDecks(base, first)).deck,
      diffDecks(base, second),
    ).deck;
    expect(result.slides[0].elements[0].x).toBe(2);
  });
});

describe('replacing every slide', () => {
  // A deck may not pass through having no slides: deleting the only slide
  // before inserting its replacement was refused, leaving both.
  it('inserts the new slides before deleting the last old one', () => {
    const prev = deckWith(slide('old'));
    const next = deckWith(slide('new-1'), slide('new-2'));
    const ops = diffDecks(prev, next);
    expect(applyOpsLenient(prev, ops).deck).toEqual(next);
    expect(applyAgentOperations(prev, ops)).toEqual(next);
  });

  it('still deletes first when some slide survives', () => {
    const ops = diffDecks(deckWith(slide('a'), slide('b')), deckWith(slide('b'), slide('c')));
    expect(ops.map((op) => op.op)).toEqual(['deleteSlide', 'insertSlides']);
  });
});
