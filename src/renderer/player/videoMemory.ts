/**
 * Where an editing surface's `<video>` elements get their bytes, in a browser
 * whose media stack keeps none of them from one element to the next.
 *
 * Chromium shares what one `<video>` downloaded with the next element that
 * opens the same URL, so the editor canvas can rebuild, pool and re-point
 * elements freely (docs/media-loading.md). Safari does not: AVFoundation
 * probes `bytes=0-1` and then reads the clip again from byte zero for every
 * element it opens, often twice in parallel. Measured on the media transfer
 * budget suite (Oct 2026), every slide change, edit, collaborator's edit and
 * return from presenting downloaded the slide's clips again, and a clip still
 * waiting for its streaming version pulled up to the whole 30 MB original
 * to show one paused frame.
 *
 * So in such a browser the collab editor installs a `VideoMemory`
 * (collab/editorVideoMemory.ts), and `renderVideo` asks it what an element
 * should read:
 *
 * - `memory`: the whole file, fetched once, as a `blob:` URL. Until it lands
 *   the element shows the server-cut still as its poster and has no source;
 *   `fillVideosFromMemory` gives it the blob.
 * - `still`: the clip's streaming version is still being prepared. The
 *   original would be read only to show a paused frame, so the element shows
 *   the still and reads nothing until the version exists (the canvas
 *   rebuilds it then) or somebody plays it (`startVideoSource`).
 * - `network`: stream as every other browser does (a file too large to hold).
 *
 * Kept apart from render.ts like previewPosterProvider.ts, so render.ts can
 * consult it without importing the collab client.
 */

export type VideoMemoryMode = 'memory' | 'still' | 'network';

export interface VideoMemory {
  /** How an element showing `assetSrc` through the network URL `url` should load. */
  mode(url: string, assetSrc: string): VideoMemoryMode;
  /** The `blob:` URL standing in for `url`, once its file is in memory. */
  objectUrl(url: string): string | undefined;
  /** Somebody is about to show `url`: fetch it into memory next. */
  request(url: string): void;
  /** A server-cut frame of `assetSrc` at `time`, or null when there is none. */
  still(assetSrc: string, time: number): string | null;
}

let memory: VideoMemory | null = null;

export function setVideoMemory(next: VideoMemory | null): void {
  memory = next;
}

export function videoMemory(): VideoMemory | null {
  return memory;
}

/**
 * Whether this browser's media stack reuses bytes one `<video>` downloaded
 * for the next element that opens the same URL. WebKit's (every browser on
 * iOS, Safari on the Mac) does not.
 */
export function mediaStackReusesBytes(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return !/AppleWebKit\//.test(userAgent) || /(Chrome|Chromium|Edg|Electron)\//.test(userAgent);
}

/**
 * Point every waiting element of `url` in `root` at `objectUrl`, or at the
 * network when the memory gave the file up (`objectUrl` null).
 */
export function fillVideosFromMemory(url: string, objectUrl: string | null, root: ParentNode = document): void {
  for (const video of root.querySelectorAll<HTMLVideoElement>('video[data-memory-pending]')) {
    if (video.dataset.networkSrc !== url || video.hasAttribute('src')) continue;
    delete video.dataset.memoryPending;
    if (objectUrl) {
      // Local bytes: no reason to ration the read.
      video.preload = 'auto';
      video.src = objectUrl;
    } else {
      video.preload = 'metadata';
      video.src = url;
    }
  }
}
