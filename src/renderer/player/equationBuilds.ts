import type { Slide, TimelineEntry } from '@shared/deck.js';
import {
  DEFAULT_PULSE_SCALE,
  TERM_CLASS_PREFIX,
  termBuildLabels,
  termClass,
  termEffect,
} from '@shared/equationTerms.js';
import type { SlideState } from '@shared/timeline.js';
import { isolatedClone, localRects, nodePath, px, slideScale } from './glyphClone.js';

/**
 * Equation builds on a rendered slide: the motion-free endpoint of term
 * reveals and term colours, and the live animations that get there — a term
 * fading in, a term changing colour, a term or an object pulsing.
 */

/** The labels a rendered term span carries (`step-2` → `2`). */
function labelsOf(span: Element): string[] {
  return [...span.classList]
    .filter((name) => name.startsWith(TERM_CLASS_PREFIX))
    .map((name) => name.slice(TERM_CLASS_PREFIX.length));
}

/** Every rendered term span of an object; MathML's parallel tree is not painted. */
function termSpans(node: ParentNode, label?: string): HTMLElement[] {
  const selector = label === undefined ? `[class*="${TERM_CLASS_PREFIX}"]` : `.${cssEscape(termClass(label))}`;
  return [...node.querySelectorAll<HTMLElement>(`.katex-html ${selector}`)]
    .filter((span) => labelsOf(span).length > 0);
}

/** `CSS.escape` where there is one (jsdom has none); labels are word characters anyway. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^\w-]/g, '\\$&');
}

/**
 * Show each equation's terms as the state says: an unrevealed term is
 * `visibility: hidden`, so it keeps its place and the equation never reflows
 * as it builds; a coloured term carries its colour inline. Shared by the
 * player, the presenter preview and the PDF renderer through
 * `applyStaticSlideState`.
 */
export function applyTermStates(stage: ParentNode, slide: Slide, state: SlideState): void {
  if (!state.terms || state.terms.size === 0) return;
  const nodes = new Map(
    [...stage.querySelectorAll<HTMLElement>('[data-element-id]')]
      .map((node) => [node.dataset.elementId ?? '', node] as const),
  );
  for (const element of slide.elements) {
    const terms = state.terms.get(element.id);
    const node = nodes.get(element.id);
    if (!terms || !node) continue;
    for (const span of termSpans(node)) {
      const labels = labelsOf(span);
      span.style.visibility = labels.some((label) => terms.hidden.has(label)) ? 'hidden' : '';
      const painted = labels.map((label) => terms.colors.get(label)).filter(Boolean);
      span.style.color = painted.length > 0 ? painted[painted.length - 1]! : '';
    }
  }
}

/**
 * Snapshot what an equation build animates from, before its state lands.
 *
 * Returns null for anything that is not an equation build. Otherwise call the
 * result once the new state has been applied: it starts the animation and
 * returns a function that jumps it to its end (the player's `effects`).
 */
export function prepareEquationEffect(
  stage: ParentNode,
  slide: Slide,
  entry: TimelineEntry,
  duration: number,
): (() => () => void) | null {
  const { type, target } = entry.action;
  if (type !== 'terms' && type !== 'pulse') return null;
  const node = [...stage.querySelectorAll<HTMLElement>('[data-element-id]')]
    .find((candidate) => candidate.dataset.elementId === target);
  if (!node || typeof node.animate !== 'function') return null;

  if (type === 'pulse') {
    return () => pulse(node, entry.action.term, entry.action.scale ?? DEFAULT_PULSE_SCALE, duration);
  }

  const labels = termBuildLabels(entry, slide);
  const spans = labels.flatMap((label) => termSpans(node, label));
  if (spans.length === 0 || duration <= 0) return null;
  const effect = termEffect(entry);
  const before = spans.map((span) => getComputedStyle(span).color);
  return () => {
    const animations = spans.flatMap((span, index): Animation[] => {
      if (getComputedStyle(span).visibility === 'hidden') return [];
      if (effect === 'appear') {
        return [span.animate([{ opacity: 0 }, { opacity: 1 }], { duration, easing: 'ease-in-out', fill: 'none' })];
      }
      const after = getComputedStyle(span).color;
      if (after === before[index]) return [];
      return [span.animate([{ color: before[index] }, { color: after }], { duration, easing: 'ease-in-out', fill: 'none' })];
    });
    return () => { for (const animation of animations) animation.finish(); };
  };
}

/**
 * The keyframes of an emphasis pulse around `transform`: out to `scale` with
 * an ease-out, and back with an ease-in-out, so the term lingers big for a
 * beat and settles rather than bouncing.
 */
function pulseFrames(around: (scale: number) => string, scale: number): Keyframe[] {
  return [
    { transform: around(1), offset: 0, easing: 'cubic-bezier(.2,.7,.3,1)' },
    { transform: around(scale), offset: 0.4, easing: 'cubic-bezier(.45,0,.25,1)' },
    { transform: around(1), offset: 1 },
  ];
}

/**
 * Briefly enlarge an object, or one marked term of its equation, about its
 * own centre. Transforms only — nothing is laid out differently at any point,
 * so when it ends the slide is exactly as it was.
 */
function pulse(node: HTMLElement, term: string | undefined, scale: number, duration: number): () => void {
  if (duration <= 0 || scale === 1) return () => {};
  const base = node.style.transform && node.style.transform !== 'none' ? `${node.style.transform} ` : '';

  if (term === undefined) {
    // The object's own transform (a rotation) stays first, so the swell
    // happens in its frame and the fill-none end is its settled render.
    const animation = node.animate(
      pulseFrames((s) => `${base}scale(${s})`, scale).map((frame) => ({ ...frame, transformOrigin: 'center' })),
      { duration, fill: 'none' },
    );
    return () => animation.finish();
  }

  const spans = termSpans(node, term).filter((span) => getComputedStyle(span).visibility !== 'hidden');
  const unit = slideScale(node);
  if (spans.length === 0 || !(unit > 0)) return () => {};
  const rects = localRects(node, spans, unit);
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const finishers: Array<() => void> = [];
  spans.forEach((span, index) => {
    const rect = rects[index];
    // The term's centre relative to the object's centre, in the object's own
    // (unrotated) frame: translate there, scale, translate back, all after
    // the object's own transform.
    const ox = px(rect.x + rect.w / 2 - width / 2);
    const oy = px(rect.y + rect.h / 2 - height / 2);
    const clone = isolatedClone(node, [nodePath(node, span)]);
    // Last in the slide, so the enlarged term paints over its neighbours.
    node.parentElement?.appendChild(clone);
    const grow = clone.animate(
      pulseFrames((s) => `${base}translate(${ox}px, ${oy}px) scale(${s}) translate(${-ox}px, ${-oy}px)`, scale)
        .map((frame) => ({ ...frame, transformOrigin: 'center' })),
      { duration, fill: 'forwards' },
    );
    // The term itself steps aside while its copy swells over it.
    const hide = span.animate([{ opacity: 0 }, { opacity: 0 }], { duration, fill: 'none' });
    const remove = (): void => clone.remove();
    void grow.finished.then(remove, remove);
    finishers.push(() => { grow.finish(); hide.finish(); remove(); });
  });
  return () => { for (const finish of finishers) finish(); };
}
