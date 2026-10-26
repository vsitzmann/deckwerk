import { classifyMediaName } from '@shared/media.js';

/**
 * The variant of each oversized clip a URL built now should pin.
 *
 * The collab server swaps an oversized clip for a streaming rendition once
 * one exists. A <video> reads its source in many range requests and never
 * revalidates between them, so a swap mid-playback handed it the rendition's
 * bytes laid out against the original's index, and Chromium died with
 * PIPELINE_ERROR_DECODE. Every video URL therefore names its variant
 * (`?v=`): a <video> keeps the bytes it started with, and the next one built
 * for that clip asks for whatever is current then.
 *
 * Filled from the welcome and from `media` messages (CollabBridge), and from
 * the seed a present window is handed.
 */
const variants = new Map<string, string>();

/** Take the server's variants; returns the srcs whose variant changed, for surfaces to re-point. */
export function setMediaVariants(next: Record<string, string> | undefined, replace = false): string[] {
  const before = new Map(variants);
  if (replace) variants.clear();
  for (const [src, variant] of Object.entries(next ?? {})) variants.set(src, variant);
  return [...new Set([...before.keys(), ...variants.keys()])].filter((src) => before.get(src) !== variants.get(src));
}

/**
 * Deck srcs whose streaming version the server is still preparing: the
 * original is all there is, and it may be many times the version's size.
 */
const pending = new Set<string>();

/** Replace the pending clips (the server always sends all of them); returns the srcs that changed. */
export function setPendingMedia(next: string[] | undefined): string[] {
  if (next === undefined) return [];
  const after = new Set(next);
  const changed = [...new Set([...pending, ...after])].filter((src) => pending.has(src) !== after.has(src));
  pending.clear();
  for (const src of after) pending.add(src);
  return changed;
}

export function isMediaPending(src: string): boolean {
  return pending.has(src);
}

export function mediaVariantsSnapshot(): Record<string, string> {
  return Object.fromEntries(variants);
}

/**
 * `url` with this src's variant pinned. A video the server has not described
 * yet (it was just uploaded) pins the original: it must never be answered
 * with a rendition that lands between two of its range requests.
 */
export function pinMediaVariant(src: string, url: string): string {
  const variant = variants.get(src) ?? (classifyMediaName(src) === 'video' ? 'o' : null);
  if (!variant) return url;
  // A keyed variant names content, and content has one URL on the server
  // whichever deck holds a copy: a copy of a talk is then bytes the browser
  // already has. (The deck URL with `?v=` would redirect there too, but the
  // detour made Chromium's media stack fetch again what it was holding.)
  if (CONTENT_VARIANT.test(variant)) return `/media/${variant}${variant[0] === 'r' ? '.mp4' : extensionOf(src)}`;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(variant)}`;
}

const CONTENT_VARIANT = /^[or][0-9a-f]{24}$/;

function extensionOf(src: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(src.split('?')[0]);
  return match ? match[0].toLowerCase() : '';
}
