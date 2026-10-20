import type { Slide, SlideElement, TimelineEntry } from './deck.js';

/**
 * Terms of an equation, as builds see them.
 *
 * An author marks a part of the TeX as a term — `\step{2}{\rho \ddot{u}}`, or
 * the standard KaTeX spelling `\htmlClass{step-2}{\rho \ddot{u}}` — and KaTeX
 * renders it as a span carrying the class `step-2`. A `terms` build steps
 * through those labels, revealing or colouring each in turn, and an emphasis
 * (`pulse`, `jiggle` or `pop`) can point at one for a moment. Nothing else
 * about the maths changes: a term is laid out exactly where it would be
 * without the marker, so an unrevealed term holds its place and the equation
 * never reflows as it builds.
 *
 * Pure and DOM-free: the timeline counts steps from the TeX source in Node
 * (the agent CLI, the collab server) as well as in the renderer.
 */

/** The class prefix KaTeX's `\htmlClass` gives a marked term. */
export const TERM_CLASS_PREFIX = 'step-';

/** A term label: digits order the steps, any other word names a term. */
const LABEL = /^[A-Za-z0-9_-]+$/;

/**
 * DeckWerk's shorthands for marking a term. `\step{2}{x}` is the short form,
 * and `\class{step-2}{x}` is MathJax's spelling, which decks written for
 * MathJax already use. Both expand to KaTeX's own `\htmlClass`, so the
 * markup an agent writes renders in any KaTeX that trusts that command.
 */
export const TERM_MACROS: Readonly<Record<string, string>> = {
  '\\step': '\\htmlClass{step-#1}{#2}',
  '\\class': '\\htmlClass{#1}{#2}',
};

/**
 * KaTeX's `trust` hook, limited to term markers. `\htmlClass` is gated by
 * KaTeX because a class can pull in arbitrary theme styling; a term class
 * cannot, so exactly that — `\htmlClass` with nothing but `step-…` classes —
 * is trusted, and every other HTML extension (`\href`, `\htmlStyle`, …)
 * still renders as an error.
 */
export function trustTermMarker(context: { command?: string; class?: string }): boolean {
  if (context.command !== '\\htmlClass') return false;
  const classes = (context.class ?? '').trim().split(/\s+/).filter(Boolean);
  return classes.length > 0
    && classes.every((name) => name.startsWith(TERM_CLASS_PREFIX) && LABEL.test(name.slice(TERM_CLASS_PREFIX.length)));
}

/** The KaTeX options every renderer of slide maths adds for term markers. */
export function katexTermOptions(): { trust: typeof trustTermMarker; macros: Record<string, string> } {
  // A fresh macro table per render: KaTeX writes `\gdef`s into the object it
  // is handed, and one slide's definitions must not leak into the next.
  return { trust: trustTermMarker, macros: { ...TERM_MACROS } };
}

/** The class a rendered term with this label carries. */
export function termClass(label: string): string {
  return `${TERM_CLASS_PREFIX}${label}`;
}

/** Whether a string can be a term label. */
export function isTermLabel(label: string): boolean {
  return LABEL.test(label);
}

/**
 * Every term label marked in a text element's html, in build order: numbered
 * labels by number, then named ones in the order they are written. Repeats
 * are one term — `\step{2}{…}` written twice reveals both places together.
 */
export function termLabels(html: string): string[] {
  const seen = new Set<string>();
  const marker = /\\(step|htmlClass|class)\s*\{([^{}]*)\}/g;
  for (const match of html.matchAll(marker)) {
    const labels = match[1] === 'step'
      ? [match[2].trim()]
      : match[2].trim().split(/\s+/)
        .filter((name) => name.startsWith(TERM_CLASS_PREFIX))
        .map((name) => name.slice(TERM_CLASS_PREFIX.length));
    for (const label of labels) if (isTermLabel(label)) seen.add(label);
  }
  const numbered = [...seen].filter((label) => /^\d+$/.test(label))
    .sort((a, b) => Number(a) - Number(b));
  const named = [...seen].filter((label) => !/^\d+$/.test(label));
  return [...numbered, ...named];
}

/** How long a term takes to fade in, or to change colour, when its entry does not say. */
export const DEFAULT_TERM_DURATION = 400;
/** How long an emphasis pulse takes when its entry does not say. */
export const DEFAULT_PULSE_DURATION = 800;
/** How far an emphasis pulse enlarges its target at the peak. */
export const DEFAULT_PULSE_SCALE = 1.6;
/** How long a jiggle wobbles when its entry does not say. */
export const DEFAULT_JIGGLE_DURATION = 700;
/** How long a pop takes, swelling and settling back, when its entry does not say. */
export const DEFAULT_POP_ACTION_DURATION = 700;
/** How far a pop swells its target at the peak: less than a pulse. */
export const DEFAULT_POP_ACTION_SCALE = 1.3;
/**
 * How softly an emphasis moves when its entry does not say, from 0 (a sharp
 * snap: it leaps away from rest and slams back into it) to 1 (fully smooth:
 * it eases out of rest, into the turn and back to rest, like a critically
 * damped spring). A pulse eases in and out but sets off a touch more briskly
 * than a pop, which is fully smooth; a jiggle's swings die out at a middling
 * rate.
 */
export const DEFAULT_PULSE_DAMPING = 0.8;
export const DEFAULT_POP_ACTION_DAMPING = 1;
export const DEFAULT_JIGGLE_DAMPING = 0.5;
/** The highlight a `color` term build paints when its entry names none. */
export const DEFAULT_TERM_COLOR = '#d9480f';

/** What a `terms` build does to each term: reveal it, or paint it. */
export type TermEffect = 'appear' | 'color';

/** A `terms` entry's effect; `appear` is the default. */
export function termEffect(entry: TimelineEntry): TermEffect {
  return entry.action.value === 'color' ? 'color' : 'appear';
}

/** Whether an entry steps through an equation's terms. */
export function isTermBuild(entry: TimelineEntry): boolean {
  return entry.action.type === 'terms';
}

/**
 * Keynote's Action builds: a moment of motion that points at an object, or at
 * one term of its equation, and leaves it exactly as it was. A `pulse` swells
 * out at once and settles, a `jiggle` wobbles side to side, and a `pop` is a
 * smooth, gentle bump: it eases up to its size and eases back down.
 */
export const EMPHASIS_TYPES = ['pulse', 'jiggle', 'pop'] as const;
export type EmphasisType = (typeof EMPHASIS_TYPES)[number];

/** Whether an action type is an emphasis. */
export function isEmphasisType(type: string): type is EmphasisType {
  return (EMPHASIS_TYPES as readonly string[]).includes(type);
}

/** How long an emphasis takes when its entry does not say. */
export function defaultEmphasisDuration(type: EmphasisType): number {
  return type === 'jiggle' ? DEFAULT_JIGGLE_DURATION : type === 'pop' ? DEFAULT_POP_ACTION_DURATION : DEFAULT_PULSE_DURATION;
}

/** How softly an emphasis moves when its entry does not say (see DEFAULT_PULSE_DAMPING). */
export function defaultEmphasisDamping(type: EmphasisType): number {
  return type === 'jiggle' ? DEFAULT_JIGGLE_DAMPING : type === 'pop' ? DEFAULT_POP_ACTION_DAMPING : DEFAULT_PULSE_DAMPING;
}

/** How far a pulse or a pop swells at the peak when its entry does not say; a jiggle does not. */
export function defaultEmphasisScale(type: EmphasisType): number {
  return type === 'pop' ? DEFAULT_POP_ACTION_SCALE : type === 'pulse' ? DEFAULT_PULSE_SCALE : 1;
}

/** The text element a term build targets, if it is one. */
function textTarget(slide: Slide, id: string): Extract<SlideElement, { type: 'text' }> | undefined {
  const element = slide.elements.find((candidate) => candidate.id === id);
  return element?.type === 'text' ? element : undefined;
}

/**
 * The labels one `terms` entry steps through: the term it names, or every
 * term of its target in build order. Empty when the target has no markers.
 */
export function termBuildLabels(entry: TimelineEntry, slide: Slide): string[] {
  if (entry.action.term) return [entry.action.term];
  const target = textTarget(slide, entry.action.target);
  return target ? termLabels(target.html) : [];
}

/** Per text element: which of its terms are not revealed yet, and the paint on the rest. */
export interface TermState {
  hidden: Set<string>;
  colors: Map<string, string>;
}

/**
 * The terms each element starts with. A term that some `terms` build reveals
 * starts hidden, exactly as an object with an `appear` build does: the
 * equation's unmarked parts are on screen from the start, and each step adds
 * to them.
 */
export function initialTermStates(slide: Slide): Map<string, TermState> {
  const states = new Map<string, TermState>();
  for (const entry of slide.timeline) {
    if (!isTermBuild(entry)) continue;
    const state = termStateOf(states, entry.action.target);
    if (termEffect(entry) === 'appear') {
      for (const label of termBuildLabels(entry, slide)) state.hidden.add(label);
    }
  }
  return states;
}

/** Fold one expanded `terms` unit into the per-element term states. */
export function applyTermAction(states: Map<string, TermState>, entry: TimelineEntry, slide: Slide): void {
  if (!isTermBuild(entry)) return;
  const state = termStateOf(states, entry.action.target);
  // An expanded unit names its term; an entry that names none, on an
  // equation with no markers, acts on every term there is (none).
  const labels = termBuildLabels(entry, slide);
  for (const label of labels) {
    if (termEffect(entry) === 'appear') state.hidden.delete(label);
    else state.colors.set(label, entry.action.color ?? DEFAULT_TERM_COLOR);
  }
}

function termStateOf(states: Map<string, TermState>, target: string): TermState {
  let state = states.get(target);
  if (!state) {
    state = { hidden: new Set(), colors: new Map() };
    states.set(target, state);
  }
  return state;
}

/**
 * The TeX a term wraps, for showing beside its number in the Build panel:
 * the second argument of its first `\step{label}{…}` (or `\htmlClass` /
 * `\class` with its class), braces balanced. Null when it is not written.
 */
export function termSource(html: string, label: string): string | null {
  const marker = /\\(step|htmlClass|class)\s*\{([^{}]*)\}\s*\{/g;
  for (const match of html.matchAll(marker)) {
    const names = match[1] === 'step'
      ? [termClass(match[2].trim())]
      : match[2].trim().split(/\s+/);
    if (!names.includes(termClass(label))) continue;
    let depth = 1;
    const start = match.index! + match[0].length;
    for (let i = start; i < html.length; i++) {
      if (html[i] === '\\') { i++; continue; }
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(start, i).trim();
    }
    return null;
  }
  return null;
}
