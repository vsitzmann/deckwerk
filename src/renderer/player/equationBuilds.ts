import type { Slide, TimelineEntry } from '@shared/deck.js';
import {
  TERM_CLASS_PREFIX,
  defaultEmphasisScale,
  isEmphasisType,
  termBuildLabels,
  termClass,
  termEffect,
} from '@shared/equationTerms.js';
import type { SlideState } from '@shared/timeline.js';
import { isolatedClone, localRects, nodePath, px, slideScale } from './glyphClone.js';

/**
 * Equation builds on a rendered slide: the motion-free endpoint of term
 * reveals and term colours, and the live animations that get there — a term
 * fading in, a term changing colour, a term or an object pulsing, jiggling or
 * popping.
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
  if (type !== 'terms' && !isEmphasisType(type)) return null;
  const node = [...stage.querySelectorAll<HTMLElement>('[data-element-id]')]
    .find((candidate) => candidate.dataset.elementId === target);
  if (!node || typeof node.animate !== 'function') return null;

  if (isEmphasisType(type)) {
    const scale = entry.action.scale ?? defaultEmphasisScale(type);
    const frames = type === 'jiggle' ? jiggleFrames : type === 'pop' ? popFrames(scale) : pulseFrames(scale);
    // A jiggle never grows, and a swell to 1× is no swell at all.
    if (type !== 'jiggle' && scale === 1) return () => () => {};
    const lift = type === 'pulse' && entry.action.value === 'lift';
    return () => emphasize(node, entry.action.term, frames, duration, lift);
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
 * An emphasis's keyframes, given how to place one local transform (a scale,
 * a turn) about the centre of what moves. Each ends where it began, so with
 * `fill: none` the slide is exactly as it was once it is over.
 */
type EmphasisFrames = (around: (local: string) => string) => Keyframe[];

/**
 * A pulse: out to `scale` with an ease-out, and back with an ease-in-out, so
 * the term lingers big for a beat and settles rather than bouncing.
 */
function pulseFrames(scale: number): EmphasisFrames {
  return (around) => [
    { transform: around('scale(1)'), offset: 0, easing: 'cubic-bezier(.2,.7,.3,1)' },
    { transform: around(`scale(${scale})`), offset: 0.4, easing: 'cubic-bezier(.45,0,.25,1)' },
    { transform: around('scale(1)'), offset: 1 },
  ];
}

/**
 * A pop: a sharp swell to `scale` in the first quarter, a quick snap back
 * that overshoots a little below the original size, and one small rebound
 * before it settles — more abrupt than a pulse, and springy where a pulse is
 * smooth.
 */
function popFrames(scale: number): EmphasisFrames {
  const swell = scale - 1;
  return (around) => [
    { transform: around('scale(1)'), offset: 0, easing: 'cubic-bezier(.2,.9,.3,1)' },
    { transform: around(`scale(${scale})`), offset: 0.25, easing: 'cubic-bezier(.6,0,.8,.4)' },
    { transform: around(`scale(${1 - swell * 0.3})`), offset: 0.55, easing: 'ease-in-out' },
    { transform: around(`scale(${1 + swell * 0.08})`), offset: 0.8, easing: 'ease-in-out' },
    { transform: around('scale(1)'), offset: 1 },
  ];
}

/** A jiggle's turns, in degrees: side to side, each swing smaller, ending square. */
const JIGGLE_TURNS = [0, 5, -4.5, 3.5, -2.5, 1.5, -0.5, 0];

/** A jiggle: a wobble about the centre that dies away, ending exactly square. */
const jiggleFrames: EmphasisFrames = (around) => JIGGLE_TURNS.map((turn, index) => ({
  transform: around(`rotate(${turn}deg)`),
  offset: index / (JIGGLE_TURNS.length - 1),
  easing: 'ease-in-out',
}));

/** The drop shadow a lifting pulse casts at its peak. */
const LIFT_SHADOW = 'drop-shadow(0px 14px 18px rgba(0, 0, 0, 0.35))';
const NO_SHADOW = 'drop-shadow(0px 0px 0px rgba(0, 0, 0, 0))';
/** How far a lifting object rises above the rest of the slide while it is up. */
const LIFT_Z = 100000;

/**
 * Briefly move an object, or one marked term of its equation, about its own
 * centre: swell it, turn it. Transforms only — nothing is laid out
 * differently at any point, so when it ends the slide is exactly as it was. A
 * whole-object pulse with `lift` also casts a drop shadow at its peak and
 * paints over its neighbours while it is up, as if picked up off the slide
 * and put back; objects lifted together keep their own stacking order.
 */
function emphasize(
  node: HTMLElement,
  term: string | undefined,
  keyframes: EmphasisFrames,
  duration: number,
  lift = false,
): () => void {
  if (duration <= 0) return () => {};
  const base = node.style.transform && node.style.transform !== 'none' ? `${node.style.transform} ` : '';

  if (term === undefined) {
    // The object's own transform (a rotation) stays first, so the motion
    // happens in its frame and the fill-none end is its settled render.
    const frames: Keyframe[] = keyframes((local) => `${base}${local}`).map((frame) => ({ ...frame, transformOrigin: 'center' }));
    if (lift) {
      const z = (Number.parseInt(getComputedStyle(node).zIndex, 10) || 0) + LIFT_Z;
      frames.forEach((frame, index) => {
        frame.filter = index === 1 ? LIFT_SHADOW : NO_SHADOW;
        frame.zIndex = String(z);
      });
    }
    const animation = node.animate(frames, { duration, fill: 'none' });
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
    // (unrotated) frame: translate there, scale or turn, translate back, all
    // after the object's own transform.
    const ox = px(rect.x + rect.w / 2 - width / 2);
    const oy = px(rect.y + rect.h / 2 - height / 2);
    const clone = isolatedClone(node, [nodePath(node, span)]);
    // Last in the slide, so the moving term paints over its neighbours.
    node.parentElement?.appendChild(clone);
    const move = clone.animate(
      keyframes((local) => `${base}translate(${ox}px, ${oy}px) ${local} translate(${-ox}px, ${-oy}px)`)
        .map((frame) => ({ ...frame, transformOrigin: 'center' })),
      { duration, fill: 'forwards' },
    );
    // The term itself steps aside while its copy moves over it.
    const hide = span.animate([{ opacity: 0 }, { opacity: 0 }], { duration, fill: 'none' });
    const remove = (): void => clone.remove();
    void move.finished.then(remove, remove);
    finishers.push(() => { move.finish(); hide.finish(); remove(); });
  });
  return () => { for (const finish of finishers) finish(); };
}
