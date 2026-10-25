/**
 * Who cuts poster frames for preview surfaces.
 *
 * In the desktop app the main process does it with ffmpeg (posterCache.ts)
 * and the renderer never opens a video pipeline for a thumbnail — the reason
 * this seam exists, see that file. In the browser collab client the server
 * does (`/api/video-still`, through netApi's `videoPoster`).
 *
 * Kept apart from previewPoster.ts so render.ts can ask whether a provider
 * exists without importing the capture code that imports render.ts.
 */

/** `src` is the clip's deck-relative path where known, else its URL. */
export type PreviewPosterProvider = (src: string, time: number) => Promise<string | null>;

let provider: PreviewPosterProvider | null = null;

export function setPreviewPosterProvider(next: PreviewPosterProvider | null): void {
  provider = next;
}

export function previewPosterProvider(): PreviewPosterProvider | null {
  return provider;
}

/** Deck-relative path from a deck-relative path or an asset URL, for either asset server. */
function deckRelativePath(resolvedSrc: string): string | null {
  try {
    const url = new URL(resolvedSrc, document.baseURI);
    const path = decodeURIComponent(url.pathname);
    // deck://<key>/assets/x.mov  or  /decks/<id>/assets/x.mov
    const index = path.indexOf('/assets/');
    return index === -1 ? null : path.slice(index + 1);
  } catch {
    return null;
  }
}

/**
 * Use `window.api.videoPoster` when this window has it. Safe to call from any
 * renderer entry point: a window without the bridge method changes nothing.
 */
export function installWindowApiPosterProvider(): boolean {
  const api = (window as unknown as { api?: { videoPoster?: (req: { src: string; time: number }) => Promise<{ url: string | null }> } }).api;
  if (typeof api?.videoPoster !== 'function') return false;
  const videoPoster = api.videoPoster;
  setPreviewPosterProvider(async (resolvedSrc, time) => {
    const src = deckRelativePath(resolvedSrc);
    if (!src) return null;
    try {
      return (await videoPoster({ src, time })).url;
    } catch {
      return null;
    }
  });
  return true;
}
