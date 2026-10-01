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

export function setMediaVariants(next: Record<string, string> | undefined, replace = false): void {
  if (replace) variants.clear();
  for (const [src, variant] of Object.entries(next ?? {})) variants.set(src, variant);
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
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(variant)}`;
}
