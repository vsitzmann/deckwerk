import type { Slide, TimelineEntry } from './deck.js';
import { EMPHASIS_TYPES, isEmphasisType, isTermLabel, type EmphasisType } from './equationTerms.js';

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
 *   data-pulse-damping="0.8"        how softly, 0 (a sharp snap) to 1 (fully
 *                                   smooth); on a jiggle, how fast it dies out
 *   data-pulse-lift="true"          also cast a drop shadow and rise over the
 *                                   neighbours while it is up (whole objects;
 *                                   a term pulse keeps it but does not lift)
 *
 *   data-jiggle="click"             wobble the object, or one term, side to side
 *   data-jiggle-term, data-jiggle-duration, data-jiggle-damping
 *   data-pop="click"                swell smoothly and ease back down
 *   data-pop-term, data-pop-scale, data-pop-duration, data-pop-damping
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

/** The timeline entries an object's equation-build attributes state, in order: terms, then pulse, jiggle, pop. */
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
  for (const type of EMPHASIS_TYPES) {
    // `data-pop-term` and the like, as the dataset spells them (`popTerm`).
    const trigger = triggerFrom(dataset[type], dataset[`${type}Ref`]);
    if (!trigger) continue;
    const duration = finite(dataset[`${type}Duration`], 0);
    // A jiggle turns rather than grows, so it has no size to read.
    const scale = type === 'jiggle' ? undefined : finite(dataset[`${type}Scale`], 1, 4);
    const damping = finite(dataset[`${type}Damping`], 0, 1);
    const term = dataset[`${type}Term`]?.trim();
    const lift = type === 'pulse' && dataset.pulseLift !== undefined
      && dataset.pulseLift.trim().toLowerCase() !== 'false';
    entries.push({
      id: `${elementId}-${type}-${index + entries.length + 1}`,
      trigger,
      action: {
        type,
        target: elementId,
        value: lift ? 'lift' : null,
        ...(term && isTermLabel(term) ? { term } : {}),
        ...(scale !== undefined ? { scale } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(damping !== undefined ? { damping } : {}),
      },
    });
  }
  return entries;
}

/** Which page-stated build an entry is, per object: a page owns the first of each. */
export function pageBuildKind(entry: TimelineEntry): string | null {
  const { type, target } = entry.action;
  return type === 'appear' || type === 'terms' || isEmphasisType(type) ? `${type}\0${target}` : null;
}

function firstOf(slide: Slide, elementId: string, type: 'terms' | EmphasisType): TimelineEntry | undefined {
  return slide.timeline.find((entry) => entry.action.type === type && entry.action.target === elementId);
}

function escapeAttribute(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The attributes an export writes for an object's first term build and first emphasis of each kind. */
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
  for (const type of EMPHASIS_TYPES) {
    const entry = firstOf(slide, elementId, type);
    if (!entry) continue;
    attr(`data-${type}`, triggerSpec(entry.trigger));
    attr(`data-${type}-ref`, entry.trigger.ref ?? undefined);
    attr(`data-${type}-term`, entry.action.term);
    if (type !== 'jiggle') attr(`data-${type}-scale`, entry.action.scale);
    attr(`data-${type}-duration`, entry.action.duration);
    attr(`data-${type}-damping`, entry.action.damping);
    if (type === 'pulse' && entry.action.value === 'lift') attr('data-pulse-lift', 'true');
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
