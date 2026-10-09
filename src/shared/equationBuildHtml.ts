import type { Slide, TimelineEntry } from './deck.js';
import { isTermLabel } from './equationTerms.js';

/**
 * Equation builds in the HTML authoring format.
 *
 * Like `data-build`, they ride on data attributes of the object they animate,
 * so an agent states them where it writes the equation:
 *
 *   data-term-build="click"         step through the equation's marked terms,
 *                                   one per click (`afterPrev+300` cascades)
 *   data-term-effect="color"        paint the terms instead of revealing them
 *   data-term-color="#d9480f"       …in this colour
 *   data-term-duration="400"        fade / colour change, in ms (0 is instant)
 *   data-term="2"                   only this term, rather than all in order
 *
 *   data-pulse="click"              enlarge the object, or one term, and settle
 *   data-pulse-term="2"             the term to pulse (absent: the whole object)
 *   data-pulse-scale="1.6"          how big at the peak
 *   data-pulse-duration="800"       in ms
 *
 * A page states an object's first build of each kind; further ones (a second
 * pulse of another term, say) are made in the Build panel and survive a save
 * of the page the same way a second appearance does (`mergedTimeline`).
 */

type Trigger = TimelineEntry['trigger'];

const TRIGGERS = ['click', 'afterPrev', 'withPrev', 'mediaEnd'] as const;

function triggerFrom(spec: string | undefined, ref: string | undefined): Trigger | null {
  if (!spec) return null;
  const [name, delay] = spec.split('+');
  const on = TRIGGERS.find((candidate) => candidate.toLowerCase() === name.trim().toLowerCase());
  if (!on) return null;
  return { on, ref: ref ?? null, delay: Number(delay ?? 0) || 0 };
}

function triggerSpec(trigger: Trigger): string {
  return `${trigger.on}${trigger.delay ? `+${trigger.delay}` : ''}`;
}

function finite(value: string | undefined, min: number, max = Infinity): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : undefined;
}

/** The timeline entries an object's equation-build attributes state, in order: terms, then pulse. */
export function equationBuildsFromNode(
  node: { dataset: Record<string, string | undefined> },
  elementId: string,
  index: number,
): TimelineEntry[] {
  const { dataset } = node;
  const entries: TimelineEntry[] = [];
  const terms = triggerFrom(dataset.termBuild, dataset.termBuildRef);
  if (terms) {
    const duration = finite(dataset.termDuration, 0);
    const term = dataset.term?.trim();
    entries.push({
      id: `${elementId}-terms-${index + 1}`,
      trigger: terms,
      action: {
        type: 'terms',
        target: elementId,
        value: dataset.termEffect === 'color' ? 'color' : 'appear',
        ...(term && isTermLabel(term) ? { term } : {}),
        ...(dataset.termEffect === 'color' && dataset.termColor ? { color: dataset.termColor } : {}),
        ...(duration !== undefined ? { duration } : {}),
      },
    });
  }
  const pulse = triggerFrom(dataset.pulse, dataset.pulseRef);
  if (pulse) {
    const duration = finite(dataset.pulseDuration, 0);
    const scale = finite(dataset.pulseScale, 1, 4);
    const term = dataset.pulseTerm?.trim();
    entries.push({
      id: `${elementId}-pulse-${index + entries.length + 1}`,
      trigger: pulse,
      action: {
        type: 'pulse',
        target: elementId,
        value: null,
        ...(term && isTermLabel(term) ? { term } : {}),
        ...(scale !== undefined ? { scale } : {}),
        ...(duration !== undefined ? { duration } : {}),
      },
    });
  }
  return entries;
}

/** Which page-stated build an entry is, per object: a page owns the first of each. */
export function pageBuildKind(entry: TimelineEntry): string | null {
  const { type, target } = entry.action;
  return type === 'appear' || type === 'terms' || type === 'pulse' ? `${type}\0${target}` : null;
}

function firstOf(slide: Slide, elementId: string, type: 'terms' | 'pulse'): TimelineEntry | undefined {
  return slide.timeline.find((entry) => entry.action.type === type && entry.action.target === elementId);
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The attributes an export writes for an object's first term build and first pulse. */
export function equationBuildAttributes(slide: Slide, elementId: string): string[] {
  const attrs: string[] = [];
  const attr = (name: string, value: string | number | undefined): void => {
    if (value !== undefined) attrs.push(`${name}="${escapeAttribute(String(value))}"`);
  };
  const terms = firstOf(slide, elementId, 'terms');
  if (terms) {
    attr('data-term-build', triggerSpec(terms.trigger));
    attr('data-term-build-ref', terms.trigger.ref ?? undefined);
    if (terms.action.value === 'color') attr('data-term-effect', 'color');
    attr('data-term-color', terms.action.value === 'color' ? terms.action.color : undefined);
    attr('data-term-duration', terms.action.duration);
    attr('data-term', terms.action.term);
  }
  const pulse = firstOf(slide, elementId, 'pulse');
  if (pulse) {
    attr('data-pulse', triggerSpec(pulse.trigger));
    attr('data-pulse-ref', pulse.trigger.ref ?? undefined);
    attr('data-pulse-term', pulse.action.term);
    attr('data-pulse-scale', pulse.action.scale);
    attr('data-pulse-duration', pulse.action.duration);
  }
  return attrs;
}

/**
 * What the page states about an object's equation builds, for the export's
 * fingerprint. Empty for an object without any, so every fingerprint an
 * older export recorded still matches.
 */
export function equationBuildSpec(slide: Slide, elementId: string): string {
  const attrs = equationBuildAttributes(slide, elementId);
  return attrs.length > 0 ? `|${attrs.join(' ')}` : '';
}
