/**
 * Bring frameless preview videos back after the page stops being hidden.
 *
 * A `<video>` paints nothing until a frame is decoded, and Chromium is free to
 * reclaim a hidden or occluded page's media buffers — which is exactly what a
 * presentation does to the editor behind it. Come back from Present and some
 * previews are black, with no request in flight to fix them: the poster-frame
 * seek in `renderVideo` was a `once` listener that already fired, so nothing
 * re-decodes the frame until some unrelated event happens to touch the
 * element. The symptom is thumbnails that are black for a while, then fill in
 * one at a time for no visible reason.
 *
 * This module closes that hole: when the page becomes visible again, every
 * preview video without a paintable frame is re-queued through the load gate
 * with its poster seek re-armed. Recovery therefore obeys the same
 * three-at-a-time connection budget as a fresh mount (docs/media-loading.md),
 * and videos the gate is already carrying are left alone.
 */

import { gateVideoLoad, isGated } from './mediaLoadGate.js';
import { armPosterFrameSeek } from './render.js';

/** A video that cannot paint and has nothing in flight to change that. */
function needsRecovery(video: HTMLVideoElement): boolean {
  // No poster time stamped → not a gated preview element (live player, or a
  // capture path pinning its own frames). Not ours to touch.
  if (video.dataset.posterTime === undefined) return false;
  if (video.dataset.holdFrame === 'true') return false;
  // Built without a source on purpose: its still is on its way from the
  // poster provider, or freezePreviewVideos will restore the source itself.
  if (video.dataset.posterPending === 'true') return false;
  // An element the gate aborted while it was detached has no src; if it is
  // back on screen (a cached rail thumbnail, re-appended) the stashed source
  // is what makes it recoverable at all.
  if (!video.getAttribute('src') && !video.dataset.gateAbortedSrc) return false;
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return false;
  if (video.seeking) return false;
  if (isGated(video)) return false;
  // A fetch is genuinely in progress; restarting it would only lose bytes.
  return video.networkState !== HTMLMediaElement.NETWORK_LOADING;
}

/**
 * Re-queue every frameless preview video under `root`. Returns how many were
 * restarted, which is what the tests assert on.
 */
export function recoverPreviewFrames(root: ParentNode): number {
  let recovered = 0;
  for (const video of root.querySelectorAll('video')) {
    if (!needsRecovery(video)) continue;
    // Bytes held in memory (videoMemory.ts) cost the network nothing to read
    // again: no slot to wait for, so no gate.
    if (video.dataset.networkSrc && video.getAttribute('src')?.startsWith('blob:')) {
      video.preload = 'auto';
      try {
        video.load();
      } catch {
        // jsdom stub
      }
      armPosterFrameSeek(video);
      recovered += 1;
      continue;
    }
    // Back to 'none' before src/load(): the fetch decision is made when src is
    // assigned and load() reads the hint of that moment; the gate is what
    // promotes the element to 'metadata' when a slot frees.
    video.preload = 'none';
    const aborted = video.dataset.gateAbortedSrc;
    if (aborted && !video.getAttribute('src')) {
      video.src = aborted;
      delete video.dataset.gateAbortedSrc;
    }
    try {
      video.load();
    } catch {
      // jsdom stub
    }
    armPosterFrameSeek(video);
    gateVideoLoad(video);
    recovered += 1;
  }
  return recovered;
}

export interface PreviewFrameRecovery {
  dispose(): void;
}

/**
 * Recover frames whenever the page becomes visible again, over each root in
 * the order given (most visible first).
 *
 * `pageshow` covers a back/forward-cache restore, which never fires
 * `visibilitychange`; `focus` covers an Electron window that was merely
 * occluded by the presentation window.
 */
export function trackPreviewFrameRecovery(...roots: ParentNode[]): PreviewFrameRecovery {
  const onVisible = () => {
    if (document.visibilityState === 'hidden') return;
    // Roots are recovered in order and the gate is FIFO, so passing the
    // editing canvas before the whole document puts the surface the author is
    // looking at at the front of the queue, ahead of rail thumbnails. A video
    // the first pass queued is skipped by the second.
    for (const root of roots) recoverPreviewFrames(root);
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', onVisible);
  window.addEventListener('focus', onVisible);
  return {
    dispose(): void {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
      window.removeEventListener('focus', onVisible);
    },
  };
}
