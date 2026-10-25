/**
 * Turn preview `<video>` elements into still pictures.
 *
 * A rail thumbnail or a Morph preview never plays: all it needs is one
 * frame. Keeping a live `<video>` for each of them is what makes previews go
 * black, and the failure has three independent triggers, all of them outside
 * our control:
 *
 * 1. A `<video>` paints nothing until a frame is decoded, and Chromium may
 *    reclaim the decoded frames of a page that is hidden, occluded, or simply
 *    holding more media players than it wants to keep resident. Presenting
 *    (a fullscreen overlay with its own playing videos) and scrolling the rail
 *    both do exactly that to the previews behind them.
 * 2. Each element fetches independently, so a deck reusing one clip across
 *    sixteen elements has sixteen loads to get through before the last
 *    thumbnail has a picture — three at a time through the load gate.
 * 3. Anything that recreates the element starts it over at "no frame".
 *
 * A still `<img>` has none of those properties. So: exactly one element per
 * distinct frame (source plus in-point) actually loads, its frame is captured
 * to a data URL, and every element showing that frame — now and for the rest
 * of the session — is replaced by an `<img>` carrying the same CSS box, fit
 * and crop. The video elements are released, which aborts their fetches and
 * frees their decoders.
 *
 * Live surfaces are untouched: the editor canvas keeps real videos (it plays
 * them on demand) and so does the Player. See docs/media-loading.md.
 */

import { gateVideoLoad, ungateVideoLoad } from './mediaLoadGate.js';
import { previewPosterProvider } from './previewPosterProvider.js';
import { armPosterFrameSeek } from './render.js';

/** Longest edge of a captured still. Thumbnails are small; frames need not be. */
const MAX_CAPTURE_EDGE = 960;
/** Data-URL stills are convenient but live on the JS heap; keep an LRU only. */
const MAX_SNAPSHOTS = 64;

/** Captured frames, keyed by source file plus in-point: image URLs (a provider's) or data URLs (captured here). */
const snapshots = new Map<string, string>();
/** Elements waiting for a frame that is being captured, per key. */
const waiting = new Map<string, Set<HTMLVideoElement>>();

/** The frame an element wants: same file, same in-point — crop and fit are CSS. */
function frameKey(video: HTMLVideoElement): string | null {
  const src = video.getAttribute('src') ?? video.dataset.gateAbortedSrc;
  const posterTime = video.dataset.posterTime;
  if (!src || posterTime === undefined) return null;
  return `${src}|${posterTime}`;
}

/** Draw the element's current frame to a data URL, or null if it can't be read. */
function capture(video: HTMLVideoElement): string | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(width, height));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    // A cross-origin frame taints the canvas and this throws; callers then
    // simply keep the live element, which is the old behaviour.
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  }
}

/**
 * Replace one video with a still carrying its box, fit and crop.
 *
 * The `<img>` keeps the video's class, inline styles and media data
 * attributes, so a cropped element stays cropped and later code can still
 * recognise what the node is showing.
 */
function swapInStill(video: HTMLVideoElement, dataUrl: string): void {
  const still = document.createElement('img');
  still.src = dataUrl;
  still.alt = '';
  still.className = video.className;
  still.style.cssText = video.style.cssText;
  still.dataset.previewStill = 'true';
  if (video.dataset.mediaKey) still.dataset.mediaKey = video.dataset.mediaKey;
  if (video.dataset.posterTime) still.dataset.posterTime = video.dataset.posterTime;
  const src = video.getAttribute('src') ?? video.dataset.gateAbortedSrc;
  if (src) still.dataset.previewSrc = src;
  video.replaceWith(still);
  // Release the element: aborts an in-flight fetch and frees the decoder,
  // which is the whole point of showing a still.
  ungateVideoLoad(video);
  video.removeAttribute('src');
  try {
    video.load();
  } catch {
    // jsdom stub
  }
}

function settle(key: string, dataUrl: string): void {
  snapshots.delete(key);
  snapshots.set(key, dataUrl);
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
  const pending = waiting.get(key);
  waiting.delete(key);
  if (!pending) return;
  for (const video of pending) {
    if (!video.isConnected) continue;
    swapInStill(video, dataUrl);
  }
}

/**
 * Give a video built without a source (`deferVideoSrc`) its source back, so
 * it can load and be captured in the page. The fallback when no provider is
 * installed or the provider could not cut the frame.
 */
function restoreDeferredSource(video: HTMLVideoElement): void {
  delete video.dataset.posterPending;
  const src = video.dataset.gateAbortedSrc;
  if (!src || video.getAttribute('src')) return;
  video.preload = 'none';
  // An element that has been in the document without a source sits in
  // NETWORK_NO_SOURCE, and assigning one then queues an 'emptied' event
  // (load algorithm, step 5). The gate reads 'emptied' as "slot free", so
  // registering before it fires would let the queue run past its limit.
  const willEmpty = video.networkState !== HTMLMediaElement.NETWORK_EMPTY;
  video.src = src;
  delete video.dataset.gateAbortedSrc;
  armPosterFrameSeek(video);
  if (willEmpty) video.addEventListener('emptied', () => gateVideoLoad(video), { once: true });
  else gateVideoLoad(video);
}

/**
 * Ask the provider for the frame of every deferred video under `root`. One
 * request per distinct frame; the answer settles every element waiting on it.
 * Returns the videos the provider could not serve, for the in-page path.
 */
function requestProvidedStills(root: ParentNode): HTMLVideoElement[] {
  const provider = previewPosterProvider();
  const fallback: HTMLVideoElement[] = [];
  for (const video of [...root.querySelectorAll('video')]) {
    if (video.dataset.posterPending !== 'true') continue;
    if (!provider) {
      restoreDeferredSource(video);
      fallback.push(video);
      continue;
    }
    const key = frameKey(video);
    const posterTime = Number(video.dataset.posterTime);
    if (!key || !Number.isFinite(posterTime)) {
      restoreDeferredSource(video);
      fallback.push(video);
      continue;
    }
    const cached = snapshots.get(key);
    if (cached !== undefined) {
      swapInStill(video, cached);
      continue;
    }
    const pending = waiting.get(key);
    if (pending) {
      pending.add(video);
      continue;
    }
    const group = new Set([video]);
    waiting.set(key, group);
    void provider(video.dataset.assetSrc ?? video.dataset.gateAbortedSrc ?? '', posterTime).then((url) => {
      if (url) {
        settle(key, url);
        return;
      }
      // Nothing to show from the provider: let each waiter load in the page.
      // `waiting` is dropped first so the capture path can claim the key.
      const waiters = waiting.get(key) === group ? group : new Set<HTMLVideoElement>();
      waiting.delete(key);
      for (const waiter of waiters) {
        if (!waiter.isConnected) continue;
        restoreDeferredSource(waiter);
        freezePreviewVideos(waiter.parentNode ?? waiter);
      }
    });
  }
  return fallback;
}

/**
 * Release preview videos whose owning thumbnail/surface has left its bounded
 * cache. The global `waiting` map would otherwise keep evicted DOM subtrees
 * alive indefinitely when a distinct poster frame never finished decoding.
 */
export function releasePreviewVideos(root: ParentNode): void {
  for (const video of root.querySelectorAll('video')) {
    for (const [key, pending] of waiting) {
      const owner = pending.values().next().value as HTMLVideoElement | undefined;
      if (!pending.delete(video)) continue;
      // Secondary waiters depended on the owner's capture. If the owner goes
      // away, forget the group; a still-mounted waiter can retry on recovery.
      if (owner === video || pending.size === 0) waiting.delete(key);
    }
    ungateVideoLoad(video);
    const src = video.getAttribute('src');
    if (src) video.dataset.gateAbortedSrc = src;
    video.removeAttribute('src');
    try {
      video.load();
    } catch {
      // jsdom stub
    }
  }
}

/** True once the element holds a frame that can be drawn. */
function hasFrame(video: HTMLVideoElement): boolean {
  return video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0;
}

const CAPTURE_EVENTS = ['seeked', 'loadeddata', 'canplay'] as const;

/**
 * Freeze every preview video under `root` into a still.
 *
 * Cheap and idempotent: call it after rendering a preview surface, and again
 * whenever that surface is re-shown. Elements whose frame is already cached
 * become stills synchronously — no fetch, no decode, no black frame at all.
 */
export function freezePreviewVideos(root: ParentNode): void {
  // Videos built without a source get their still from the provider; the ones
  // it cannot serve have just had their source restored and fall through to
  // the in-page capture below like any other preview video.
  requestProvidedStills(root);
  for (const video of [...root.querySelectorAll('video')]) {
    // No poster stamp → a live surface (player, editor canvas). Not ours.
    if (video.dataset.posterTime === undefined) continue;
    if (video.dataset.holdFrame === 'true') continue;
    // Still on its way from the provider.
    if (video.dataset.posterPending === 'true') continue;
    const key = frameKey(video);
    if (!key) continue;

    const cached = snapshots.get(key);
    if (cached !== undefined) {
      swapInStill(video, cached);
      continue;
    }

    const pending = waiting.get(key);
    if (pending) {
      // Another element is already fetching this exact frame. This one must
      // not: sixteen elements of one clip are sixteen loads for one picture.
      pending.add(video);
      ungateVideoLoad(video);
      continue;
    }

    waiting.set(key, new Set([video]));
    if (hasFrame(video)) {
      const dataUrl = capture(video);
      if (dataUrl) settle(key, dataUrl);
      else waiting.delete(key);
      continue;
    }
    const onFrame = () => {
      if (!hasFrame(video)) return;
      for (const name of CAPTURE_EVENTS) video.removeEventListener(name, onFrame);
      const dataUrl = capture(video);
      if (dataUrl) settle(key, dataUrl);
      // Capture refused (a tainted frame): let every waiter load for itself,
      // which is the behaviour this module replaces.
      else waiting.delete(key);
    };
    for (const name of CAPTURE_EVENTS) video.addEventListener(name, onFrame);
  }
}

/** Drop cached stills. Test isolation only. */
export function resetPreviewPostersForTests(): void {
  snapshots.clear();
  waiting.clear();
}
