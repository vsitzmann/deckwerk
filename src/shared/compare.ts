import type { SlideElement } from './deck.js';

/**
 * Comparing two pictures of the same thing: a real clip beside its
 * simulation, a frame before and after a method.
 *
 * Side by side is a sync group (`syncGroup`, played from one clock by
 * renderer/player/videoSync.ts). Stacked is a wipe: the upper of two pictures
 * in one box carries `compare: 'wipe'` and is shown only left of a vertical
 * divider at `wipe` (a fraction of the box's width), so whatever lies beneath
 * it shows on the right. Only the top layer carries the setting, so there is
 * one divider position and nothing for two copies of it to disagree about.
 *
 * Everything here is pure: the renderer, the player, the inspector and the
 * HTML round trip all read the model through these helpers.
 */

export type CompareMedia = Extract<SlideElement, { type: 'image' | 'video' }>;

/** Where a new wipe puts its divider: the middle, so both sides read equally. */
export const DEFAULT_WIPE = 0.5;

export interface Box { x: number; y: number; w: number; h: number }

export function isCompareMedia(element: SlideElement): element is CompareMedia {
  return element.type === 'image' || element.type === 'video';
}

/** A divider position kept inside the box; anything unreadable is the middle. */
export function clampWipe(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_WIPE;
}

/** Where this element's divider sits, or null when it is not a wipe. */
export function wipeOf(element: SlideElement): number | null {
  if (!isCompareMedia(element) || element.compare !== 'wipe') return null;
  return clampWipe(element.wipe ?? DEFAULT_WIPE);
}

/**
 * The clip that shows the upper layer only left of the divider. An `inset`
 * rather than a polygon so it follows the box through a resize or a Morph
 * without being recomputed.
 */
export function wipeClipPath(fraction: number): string {
  const hidden = Math.round((1 - clampWipe(fraction)) * 10000) / 100;
  return `inset(0 ${hidden}% 0 0)`;
}

/** `data-compare` / `data-wipe` for the HTML an agent edits. */
export function compareDataAttrs(element: CompareMedia): string {
  if (element.compare !== 'wipe') return '';
  return ` data-compare="wipe" data-wipe="${clampWipe(element.wipe ?? DEFAULT_WIPE)}"`;
}

/**
 * Read `data-compare` / `data-wipe` back. The position may be written as a
 * fraction (`0.4`) or as a percentage (`40%`), since an author thinks of a
 * divider "40% of the way across" as readily as of 0.4. A position without
 * `data-compare="wipe"` means nothing and is dropped.
 */
export function compareFromDataset(
  dataset: Record<string, string | undefined>,
): { compare?: 'wipe'; wipe?: number } {
  if (dataset.compare !== 'wipe') return {};
  const raw = (dataset.wipe ?? '').trim();
  const percent = /^([+-]?[\d.]+)\s*%$/.exec(raw);
  const value = percent ? Number(percent[1]) / 100 : raw === '' ? DEFAULT_WIPE : Number(raw);
  return { compare: 'wipe', wipe: clampWipe(value) };
}

/** Elements in the order they paint: `z`, ties broken by array position, as the renderer draws them. */
function paintOrder(elements: readonly SlideElement[]): SlideElement[] {
  return elements
    .map((element, index) => ({ element, index }))
    .sort((a, b) => a.element.z - b.element.z || a.index - b.index)
    .map(({ element }) => element);
}

function sameBox(a: Box, b: Box): boolean {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
    && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;
}

/**
 * The two layers of the wipe `element` belongs to, from either side: the top
 * (which carries the setting) and the picture beneath it. A video's partner
 * is its sync partner; a still's is whatever media fills the same box just
 * below it. `under` is null when the top layer has nothing to reveal yet.
 */
export function wipeLayers(
  elements: readonly SlideElement[],
  element: SlideElement,
): { top: CompareMedia; under: CompareMedia | null } | null {
  if (!isCompareMedia(element)) return null;
  const order = paintOrder(elements);
  const partnerOf = (top: CompareMedia, candidate: SlideElement): boolean => {
    if (candidate.id === top.id || !isCompareMedia(candidate)) return false;
    if (top.type === 'video' && top.syncGroup && candidate.type === 'video'
      && candidate.syncGroup === top.syncGroup) return true;
    return sameBox(top, candidate);
  };
  if (element.compare === 'wipe') {
    const below = order.slice(0, order.indexOf(element)).reverse();
    const under = below.find((candidate) => partnerOf(element, candidate)) ?? null;
    return { top: element, under: under as CompareMedia | null };
  }
  const above = order.slice(order.indexOf(element) + 1);
  const top = above.find((candidate) =>
    isCompareMedia(candidate) && candidate.compare === 'wipe' && partnerOf(candidate, element));
  return top ? { top: top as CompareMedia, under: element } : null;
}

/**
 * Stack two pictures into one before/after wipe, in place.
 *
 * The left-hand one (as they stood) becomes the upper layer, so it keeps
 * showing on the left of the divider and the reading order of the slide does
 * not flip. The shared box is the larger of the two, centred where the pair
 * stood. Two videos end up in one sync group, or the wipe would compare two
 * different moments. Returns false when the pair cannot be a wipe.
 */
export function arrangeAsWipe(elements: SlideElement[], ids: readonly [string, string]): boolean {
  const pair = ids.map((id) => elements.find((element) => element.id === id));
  if (pair.some((element) => !element || !isCompareMedia(element))) return false;
  const [a, b] = pair as [CompareMedia, CompareMedia];
  if (a.id === b.id) return false;
  const centreX = (box: Box) => box.x + box.w / 2;
  const centreY = (box: Box) => box.y + box.h / 2;
  const leftFirst = centreX(a) < centreX(b)
    || (centreX(a) === centreX(b) && centreY(a) <= centreY(b));
  const [before, after] = leftFirst ? [a, b] : [b, a];

  const larger = before.w * before.h >= after.w * after.h ? before : after;
  const union = unionBox([before, after])!;
  const box = {
    x: Math.round(union.x + (union.w - larger.w) / 2),
    y: Math.round(union.y + (union.h - larger.h) / 2),
    w: larger.w,
    h: larger.h,
  };
  for (const element of [before, after]) Object.assign(element, box, { rot: before.rot });

  if (before.type === 'video' && after.type === 'video') {
    const group = before.syncGroup ?? after.syncGroup ?? `sync-${before.id}`;
    before.syncGroup = group;
    after.syncGroup = group;
  }

  // The upper layer must paint just above its partner. Anything else keeps
  // its relative order; z is renumbered 1…n the way Arrange does, so no tie
  // is left for array order to decide.
  const order = paintOrder(elements).filter((element) => element !== before);
  order.splice(order.indexOf(after) + 1, 0, before);
  order.forEach((element, index) => { element.z = index + 1; });

  before.compare = 'wipe';
  before.wipe = clampWipe(before.wipe ?? DEFAULT_WIPE);
  delete after.compare;
  delete after.wipe;
  return true;
}

/** The axis-aligned box that holds every one of `boxes`, or null for none. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * A clip's playable window: its in-point to its out-point, or to the end of
 * the file once the file's duration is known. Null until it is.
 */
export function trimWindow(
  clip: { start: number; end: number | null },
  duration: number,
): { start: number; end: number } | null {
  const end = clip.end ?? (Number.isFinite(duration) && duration > 0 ? duration : null);
  if (end === null || end <= clip.start) return null;
  return { start: clip.start, end };
}

/** How far through its trim window a clip is, 0…1. */
export function scrubFraction(time: number, window: { start: number; end: number }): number {
  const span = window.end - window.start;
  return span > 0 ? Math.min(1, Math.max(0, (time - window.start) / span)) : 0;
}

/**
 * The time a scrub to `fraction` lands on. The very end is held a frame short
 * of the out-point: landing on it exactly would trip the player's loop and
 * throw the clip back to its start under the presenter's finger.
 */
export function scrubTime(fraction: number, window: { start: number; end: number }): number {
  const time = window.start + Math.min(1, Math.max(0, fraction)) * (window.end - window.start);
  return Math.min(time, Math.max(window.start, window.end - 0.05));
}

/** `m:ss` for the scrubber's readout. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
