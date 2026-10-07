import type { Deck, Slide } from './deck.js';
import type { AgentOperation } from './agent.js';

/**
 * Structural diff of two decks into the agent op vocabulary, keyed entirely by
 * stable slide/element ids. Applying the result to `prev` with lenient (or
 * strict) semantics reproduces `next`, up to element array order — which is
 * not load-bearing: render order is governed by `z`, and replaceElement
 * preserves array position.
 *
 * The inverse of diffDecks(prev, next) is simply diffDecks(next, prev); the
 * collab undo layer relies on that.
 *
 * Fast path: EditorStore.commit preserves object identity for untouched
 * slides and elements (reshareDeck), as applyOpsLenient does for whatever no
 * op touched, so identical references are skipped without a stringify.
 */
export function diffDecks(prev: Deck, next: Deck): AgentOperation[] {
  const ops: AgentOperation[] = [];

  const deckProps = diffDeckProps(prev, next);
  if (deckProps) ops.push(deckProps);

  const prevIds = new Set(prev.slides.map((slide) => slide.id));
  const nextIds = new Set(next.slides.map((slide) => slide.id));

  for (const slide of prev.slides) {
    if (!nextIds.has(slide.id)) ops.push({ op: 'deleteSlide', slideId: slide.id });
  }

  ops.push(...reorderOps(prev, next, prevIds));
  ops.push(...insertSlideOps(next, prevIds));

  const prevById = new Map(prev.slides.map((slide) => [slide.id, slide]));
  for (const nextSlide of next.slides) {
    const prevSlide = prevById.get(nextSlide.id);
    if (!prevSlide || prevSlide === nextSlide) continue;
    ops.push(...diffSlide(prevSlide, nextSlide));
  }

  return ops;
}

function diffDeckProps(prev: Deck, next: Deck): AgentOperation | null {
  const op: Record<string, unknown> = { op: 'updateDeck' };
  let changed = false;
  const scalarKeys = ['title', 'theme', 'themePreset', 'morphEasing'] as const;
  for (const key of scalarKeys) {
    if (prev[key] !== next[key]) {
      op[key] = next[key];
      changed = true;
    }
  }
  for (const key of ['canvas', 'themeStyle', 'themeSelection', 'themeHistory', 'customThemes', 'layoutMasters'] as const) {
    if (prev[key] !== next[key] && JSON.stringify(prev[key]) !== JSON.stringify(next[key])) {
      op[key] = structuredClone(next[key]);
      changed = true;
    }
  }
  return changed ? (op as AgentOperation) : null;
}

/**
 * Minimal moveSlide set for surviving slides: keep the longest increasing
 * subsequence of prev-positions (in next order) fixed, and move everything
 * else after its final predecessor, processing in next order so each
 * anchor is already in place.
 */
function reorderOps(prev: Deck, next: Deck, prevIds: Set<string>): AgentOperation[] {
  const survivorsNext = next.slides.filter((slide) => prevIds.has(slide.id));
  const prevPosition = new Map(prev.slides.map((slide, index) => [slide.id, index]));
  const sequence = survivorsNext.map((slide) => prevPosition.get(slide.id)!);
  const keep = new Set(longestIncreasingSubsequence(sequence).map((i) => survivorsNext[i].id));

  const ops: AgentOperation[] = [];
  for (let i = 0; i < survivorsNext.length; i++) {
    const slide = survivorsNext[i];
    if (keep.has(slide.id)) continue;
    const afterSlideId = i === 0 ? null : survivorsNext[i - 1].id;
    ops.push({ op: 'moveSlide', slideId: slide.id, afterSlideId });
  }
  return ops;
}

function insertSlideOps(next: Deck, prevIds: Set<string>): AgentOperation[] {
  const ops: AgentOperation[] = [];
  let run: Slide[] = [];
  let runAnchor: string | null = null;

  const flush = () => {
    if (run.length === 0) return;
    ops.push({ op: 'insertSlides', afterSlideId: runAnchor, slides: structuredClone(run) });
    run = [];
  };

  for (let i = 0; i < next.slides.length; i++) {
    const slide = next.slides[i];
    if (prevIds.has(slide.id)) {
      flush();
      continue;
    }
    if (run.length === 0) {
      // Anchor on the immediate predecessor in next order: a surviving slide
      // (already positioned by reorderOps) or a slide from an earlier run
      // (already inserted, since runs are emitted left to right).
      runAnchor = i === 0 ? null : next.slides[i - 1].id;
    }
    run.push(slide);
  }
  flush();
  return ops;
}

function diffSlide(prev: Slide, next: Slide): AgentOperation[] {
  const ops: AgentOperation[] = [];

  const { elements: prevElements, ...prevProps } = prev;
  const { elements: nextElements, ...nextProps } = next;
  if (JSON.stringify(prevProps) !== JSON.stringify(nextProps)) {
    // Only the fields that actually changed. Sending the whole blob made a
    // notes edit overwrite a peer's concurrent timeline edit on the same slide.
    const before = prevProps as Record<string, unknown>;
    const after = nextProps as Record<string, unknown>;
    const changed: Record<string, unknown> = { id: next.id };
    const clear: string[] = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (key === 'id') continue;
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      // An optional field that went away must be stated as a removal: a patch
      // that simply omits it would read as "leave it alone".
      if (after[key] === undefined) clear.push(key);
      else changed[key] = structuredClone(after[key]);
    }
    ops.push({
      op: 'setSlideProperties',
      slideId: next.id,
      slide: changed as typeof nextProps,
      ...(clear.length ? { clear } : {}),
    });
  }

  const nextById = new Map(nextElements.map((element) => [element.id, element]));
  const prevById = new Map(prevElements.map((element) => [element.id, element]));

  const removed = prevElements.filter((element) => !nextById.has(element.id));
  if (removed.length > 0) {
    ops.push({
      op: 'deleteElements',
      slideId: next.id,
      elementIds: removed.map((element) => element.id),
    });
  }

  const added = nextElements.filter((element) => !prevById.has(element.id));
  if (added.length > 0) {
    ops.push({ op: 'insertElements', slideId: next.id, elements: structuredClone(added) });
  }

  for (const element of nextElements) {
    const before = prevById.get(element.id);
    if (!before || before === element) continue;
    if (JSON.stringify(before) !== JSON.stringify(element)) {
      ops.push({
        op: 'replaceElement',
        slideId: next.id,
        elementId: element.id,
        element: structuredClone(element),
      });
    }
  }

  return ops;
}

/** Indices (into the input) of one longest strictly increasing subsequence. */
function longestIncreasingSubsequence(values: number[]): number[] {
  const tailIndices: number[] = [];
  const predecessors = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tailIndices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tailIndices[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) predecessors[i] = tailIndices[lo - 1];
    tailIndices[lo] = i;
  }
  const result: number[] = [];
  let k = tailIndices.length > 0 ? tailIndices[tailIndices.length - 1] : -1;
  while (k !== -1) {
    result.unshift(k);
    k = predecessors[k];
  }
  return result;
}
