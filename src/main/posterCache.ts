import { join } from 'node:path';
import { app } from 'electron';
import { extractPosterFrame, extractStillFrame } from './ffmpeg.js';
import { createFrameCache } from './frameCache.js';

/**
 * Poster frames for preview surfaces, extracted out of process.
 *
 * The slide rail, the Morph panel and Speaker View each need one picture per
 * video element, never playback. Until Sept 2026 they got it by mounting a
 * real `<video>`, letting Chromium fetch the container header, seeking one
 * frame, drawing it to a canvas and tearing the element down — a full media
 * pipeline built and destroyed for every thumbnail, dozens of times per deck
 * open and again on every eviction from the thumbnail cache. On the X-Reason
 * deck (81 videos, screen recordings indexed at the tail) that churn hit a
 * lock inversion between Chromium's main and media threads and froze the
 * editor for good. The deadlock is Chromium's; the churn was ours.
 *
 * So the frame is now cut by ffmpeg in the main process and served back as a
 * JPEG. The renderer never creates a video pipeline for a preview, and the
 * only `<video>` elements left are the ones that play: the editor canvas and
 * the Player. Frames are cached in the app's user data folder — not the deck,
 * which stays exactly the files the author put there — keyed by the file's
 * identity and the requested time, so an edited clip gets a fresh frame.
 */

/** The `deck://` host that serves cached posters (see assetProtocol.ts). */
export const POSTER_HOST = 'posters';

let cacheDirOverride: string | null = null;

/** Where posters live. Tests point this at a scratch folder. */
export function posterCacheDir(): string {
  return cacheDirOverride ?? join(app.getPath('userData'), 'posters');
}

export function setPosterCacheDirForTests(dir: string | null): void {
  cacheDirOverride = dir;
}

/**
 * The cached poster file name for `absolutePath` at `time` seconds, cutting
 * it first if it is not there yet. Null when the frame cannot be produced —
 * the renderer then falls back to its in-browser capture. Bounded to three
 * ffmpeg runs at once: a deck open asks for many frames together.
 */
export const posterFor = createFrameCache({ dir: posterCacheDir, extract: extractPosterFrame });

/**
 * A full-resolution still for a printed PDF page, from the same cache folder
 * (and so the same `deck://posters/` route). The print window takes these
 * instead of mounting every video in the deck at once.
 */
export const printStillFor = createFrameCache({ dir: posterCacheDir, extract: extractStillFrame, variant: 'print|' });
