import type { Slide, TimelineEntry } from '@shared/deck.js';
import {
  TERM_CLASS_PREFIX,
  defaultEmphasisDamping,
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
    const damping = entry.action.damping ?? defaultEmphasisDamping(type);
    const frames = type === 'jiggle' ? jiggleFrames(damping)
      : type === 'pop' ? popFrames(scale, damping) : pulseFrames(scale, damping);
    // A jiggle never grows, and a swell to 1× is no swell at all.
    if (type !== 'jiggle' && scale === 1) return () => () => {};
    const lift = type === 'pulse' && entry.action.value === 'lift';
    const text = slide.elements.find((element) => element.id === target)?.type === 'text';
    return () => emphasize(node, entry.action.term, frames, duration, { lift, text });
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

/** Keyframe numbers are compared in tests; keep them short and stable. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** `a` to `b`, `t` of the way. */
function mix(a: number, b: number, t: number): number {
  return round(a + (b - a) * t);
}

/**
 * The easings of a swell, by damping (0 to 1). Out of rest: at 0 a sharp
 * ease-out that leaps away at once, at 1 a full ease-in-out that starts from
 * stillness and slows into the top. Back to rest: at 0 an ease-in that gathers
 * speed and lands hard, at 1 the same full ease-in-out that settles softly.
 * Between, the curve's handles slide from one to the other, so a damping
 * between is a softer start and a softer landing, never an overshoot.
 */
function swellEasings(damping: number): { out: string; back: string } {
  const d = Math.min(1, Math.max(0, damping));
  return {
    out: `cubic-bezier(${mix(0.1, 0.45, d)},${mix(0.9, 0, d)},${mix(0.3, 0.55, d)},1)`,
    back: `cubic-bezier(${mix(0.7, 0.45, d)},0,${mix(0.9, 0.55, d)},${mix(0.1, 1, d)})`,
  };
}

/**
 * A pulse: out to `scale` in the first third, held there for a beat, and
 * back over the longer rest. The hold and the quicker rise are what make it
 * a pulse, a deliberate "look here", where a pop turns at the top at once.
 */
function pulseFrames(scale: number, damping: number): EmphasisFrames {
  const { out, back } = swellEasings(damping);
  return (around) => [
    { transform: around('scale(1)'), offset: 0, easing: out },
    { transform: around(`scale(${scale})`), offset: 0.35, easing: 'linear' },
    { transform: around(`scale(${scale})`), offset: 0.5, easing: back },
    { transform: around('scale(1)'), offset: 1 },
  ];
}

/**
 * A pop: a bump, symmetric about its middle. At its default damping of 1 it
 * eases into growing, eases to a stop at full size halfway, eases back down
 * and settles softly at its own size, never below it.
 */
function popFrames(scale: number, damping: number): EmphasisFrames {
  const { out, back } = swellEasings(damping);
  return (around) => [
    { transform: around('scale(1)'), offset: 0, easing: out },
    { transform: around(`scale(${scale})`), offset: 0.5, easing: back },
    { transform: around('scale(1)'), offset: 1 },
  ];
}

/** How far a jiggle's first swing turns, in degrees. */
const JIGGLE_TURN = 5;
/** How many swings a jiggle makes before it comes to rest. */
const JIGGLE_SWINGS = 6;

/**
 * A jiggle's turns, in degrees: side to side, each swing smaller, ending
 * square. Damping sets how fast the swings die out: at 0 they hardly do and
 * the wobble stops short, at 1 the first swing or two carry it all.
 */
function jiggleTurns(damping: number): number[] {
  const d = Math.min(1, Math.max(0, damping));
  const power = mix(0.3, 2.5, d);
  const swings = Array.from({ length: JIGGLE_SWINGS }, (_, k) =>
    round(JIGGLE_TURN * (1 - k / JIGGLE_SWINGS) ** power * (k % 2 === 0 ? 1 : -1)));
  return [0, ...swings, 0];
}

/** A jiggle: a wobble about the centre that dies away, ending exactly square. */
function jiggleFrames(damping: number): EmphasisFrames {
  const turns = jiggleTurns(damping);
  return (around) => turns.map((turn, index) => ({
    transform: around(`rotate(${turn}deg)`),
    offset: index / (turns.length - 1),
    easing: 'ease-in-out',
  }));
}

/** The drop shadow a lifting pulse casts at its peak. */
const LIFT_SHADOW = 'drop-shadow(0px 14px 18px rgba(0, 0, 0, 0.35))';
const NO_SHADOW = 'drop-shadow(0px 0px 0px rgba(0, 0, 0, 0))';
/** How far a lifting object rises above the rest of the slide while it is up. */
const LIFT_Z = 100000;

/**
 * Where the eye puts an object's centre, as an offset from its box's centre
 * in its own (unrotated) frame. A text box is often bigger than its text — a
 * left-aligned title in a full-width box, one short line at the top of a tall
 * box — and only the text shows, so it moves about the middle of its text. A
 * text box that paints its box (a fill, a border, a shadow) shows its edges,
 * and a shape or a picture fills its box, so those move about the box.
 */
function visualCentre(node: HTMLElement, text: boolean): { x: number; y: number } {
  const none = { x: 0, y: 0 };
  if (!text || paintsBox(node)) return none;
  const content = node.querySelector<HTMLElement>('.text-content');
  const unit = slideScale(node);
  if (!content || !(unit > 0)) return none;
  const range = node.ownerDocument.createRange();
  range.selectNodeContents(content);
  const [ink] = localRects(node, [range], unit);
  if (!ink || !(ink.w > 0) || !(ink.h > 0)) return none;
  return { x: px(ink.x + ink.w / 2 - node.offsetWidth / 2), y: px(ink.y + ink.h / 2 - node.offsetHeight / 2) };
}

/** Whether an object paints anything at its box's edges. */
function paintsBox(node: HTMLElement): boolean {
  const style = getComputedStyle(node);
  const alpha = /rgba?\([^)]*,\s*([\d.]+)\)/.exec(style.backgroundColor)?.[1];
  const filled = style.backgroundColor !== 'transparent' && style.backgroundColor !== '' && alpha !== '0';
  const bordered = ['Top', 'Right', 'Bottom', 'Left'].some((side) =>
    Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0
    && style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none');
  return filled || bordered || (style.backgroundImage !== '' && style.backgroundImage !== 'none')
    || (style.boxShadow !== '' && style.boxShadow !== 'none');
}

/** Set inline styles for a while; returns what puts the old values back. */
function holdStyle(node: HTMLElement, values: Partial<Record<'transformOrigin' | 'zIndex', string>>): () => void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, node.style[key as 'zIndex']]));
  Object.assign(node.style, values);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    Object.assign(node.style, before);
  };
}

/**
 * Briefly move an object, or one marked term of its equation, about the
 * centre of what shows: swell it, turn it. Transforms only — nothing is laid
 * out differently at any point, so when it ends the slide is exactly as it
 * was. A whole-object pulse with `lift` also casts a drop shadow at its peak
 * and paints over its neighbours while it is up, as if picked up off the
 * slide and put back; objects lifted together keep their own stacking order.
 *
 * The object's own transform (a rotation, about its box's centre) stays
 * first and its origin stays the box's centre, so the motion happens in its
 * frame and the fill-none end is its settled render; the motion itself is
 * moved to the centre that shows by translating there and back around it.
 */
function emphasize(
  node: HTMLElement,
  term: string | undefined,
  keyframes: EmphasisFrames,
  duration: number,
  { lift = false, text = false }: { lift?: boolean; text?: boolean } = {},
): () => void {
  if (duration <= 0) return () => {};
  const base = node.style.transform && node.style.transform !== 'none' ? `${node.style.transform} ` : '';
  const about = (o: { x: number; y: number }) => (local: string): string =>
    `${base}translate(${o.x}px, ${o.y}px) ${local} translate(${-o.x}px, ${-o.y}px)`;

  if (term === undefined) {
    const frames: Keyframe[] = keyframes(about(visualCentre(node, text)));
    const held: Partial<Record<'transformOrigin' | 'zIndex', string>> = { transformOrigin: 'center' };
    if (lift) {
      held.zIndex = String((Number.parseInt(getComputedStyle(node).zIndex, 10) || 0) + LIFT_Z);
      frames.forEach((frame, index) => {
        // Up for every frame but the first and the last, the hold included.
        frame.filter = index === 0 || index === frames.length - 1 ? NO_SHADOW : LIFT_SHADOW;
      });
    }
    // The origin and the raised stacking are held on the node rather than
    // animated: either one in the keyframes keeps the whole animation off the
    // compositor, and on the main thread it stutters whenever the page is busy.
    const restore = holdStyle(node, held);
    const animation = node.animate(frames, { duration, fill: 'none' });
    void animation.finished.then(restore, restore);
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
    // (unrotated) frame.
    const centre = { x: px(rect.x + rect.w / 2 - width / 2), y: px(rect.y + rect.h / 2 - height / 2) };
    const clone = isolatedClone(node, [nodePath(node, span)]);
    // Set, not animated, so the move runs on the compositor (see above).
    clone.style.transformOrigin = 'center';
    // Last in the slide, so the moving term paints over its neighbours.
    node.parentElement?.appendChild(clone);
    const move = clone.animate(keyframes(about(centre)), { duration, fill: 'forwards' });
    // The term itself steps aside while its copy moves over it.
    const hide = span.animate([{ opacity: 0 }, { opacity: 0 }], { duration, fill: 'none' });
    const remove = (): void => clone.remove();
    void move.finished.then(remove, remove);
    finishers.push(() => { move.finish(); hide.finish(); remove(); });
  });
  return () => { for (const finish of finishers) finish(); };
}
