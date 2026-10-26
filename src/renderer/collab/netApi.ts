import type { AssetImportProgress, ImportedAsset, MediaInfo } from '@shared/ipc.js';
import type { ClipboardWriteRequest } from '@shared/clipboard.js';
import { clipboardImageName, type ClipboardImageSource } from '@shared/clipboardImages.js';
import { pinMediaVariant, setMediaVariants } from './mediaVariants.js';
import type { DeckAssetListing, DeckAssetTrashResult } from '@shared/mediaIndex.js';

/**
 * The browser collab client's stand-in for the Electron preload bridge.
 *
 * Only the surface the reused editor components actually touch is real:
 * assets resolve to the collab server's deck-scoped HTTP routes, drops upload
 * bytes, and theme saves go to the WebSocket (injected by the shell).
 * Everything else on the full Api type is desktop-only and intentionally
 * absent — the collab shell never calls it, and shared code paths feature-test
 * with optional chaining.
 */
export interface NetApiOptions {
  deckId: string;
  saveTheme: (css: string) => void;
}

const progressListeners = new Set<(p: AssetImportProgress) => void>();

function emitProgress(p: AssetImportProgress): void {
  for (const fn of progressListeners) fn(p);
}

/**
 * XHR rather than fetch: only XHR exposes upload progress. Once the bytes are
 * up, the server hashes/copies/transcodes before responding — that stretch is
 * reported as an indeterminate 'processing' phase.
 */
function uploadFile(deck: string, file: File, token?: string): Promise<ImportedAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?deck=${deck}&name=${encodeURIComponent(file.name)}`);
    xhr.responseType = 'json';
    if (token) {
      xhr.upload.addEventListener('progress', (e) => {
        emitProgress({
          token,
          phase: 'upload',
          ratio: e.lengthComputable ? e.loaded / e.total : null,
        });
      });
      xhr.upload.addEventListener('load', () =>
        emitProgress({ token, phase: 'processing', ratio: null }),
      );
    }
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const imported = xhr.response as ImportedAsset & { variant?: string };
        // The server names the clip's variant, so the element built for it
        // asks for the URL it will keep.
        if (imported.variant) setMediaVariants({ [imported.src]: imported.variant });
        resolve(imported);
      } else {
        const body = xhr.response as { error?: string } | null;
        reject(new Error(body?.error ?? `upload failed (${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('upload failed (network)')));
    xhr.send(file);
  });
}

/** True for a URL naming one of this server's own deck assets. */
function isOwnDeckAsset(raw: string): boolean {
  try {
    const url = new URL(raw, location.href);
    return url.origin === location.origin && /^\/decks\/.+\/assets\//.test(url.pathname);
  } catch {
    return false;
  }
}

/** The server's route for one of a deck's assets, unpinned. */
function deckAssetPath(deckId: string, src: string): string {
  return `/decks/${encodeURIComponent(deckId)}/${src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Download the file the author dropped behind an image or video src: the
 * server finds it beside the copy the slide shows, never a rendition, and
 * names it (`Content-Disposition`), so the anchor leaves the name blank.
 */
export function downloadOriginalAsset(deckId: string, src: string): void {
  const link = document.createElement('a');
  link.href = `${deckAssetPath(deckId, src)}?download=original`;
  link.download = '';
  link.click();
}

/** A deck id is a path; each segment is encoded on its own. */
function deckPath(deckId: string): string {
  return deckId.split('/').map(encodeURIComponent).join('/');
}

export function installNetApi(options: NetApiOptions): void {
  const deck = encodeURIComponent(options.deckId);
  const api = {
    /**
     * The browser's half of cross-tab copy and paste (see the server's
     * clipboardStash.ts): a copy is parked on the server under the id its
     * clipboard token carries, and a paste anywhere on this server fetches it
     * back and brings the assets it names into this deck.
     */
    stashClipboard: async (id: string, request: ClipboardWriteRequest): Promise<void> => {
      const response = await fetch(`/api/clipboard/${encodeURIComponent(id)}?deck=${deck}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error(`could not share the copy with other tabs (${response.status})`);
    },

    fetchClipboard: async (id: string): Promise<{ sourceDeck: string; request: unknown } | null> => {
      try {
        const response = await fetch(`/api/clipboard/${encodeURIComponent(id)}`, { cache: 'no-store' });
        const sourceDeck = response.headers.get('x-deckwerk-source-deck');
        if (!response.ok || sourceDeck === null) return null;
        return { sourceDeck: decodeURIComponent(sourceDeck), request: await response.json() as unknown };
      } catch (err) {
        console.error('Could not fetch the copied objects:', err);
        return null;
      }
    },

    /**
     * This deck's copy of an asset another deck on this server references:
     * the server copies the file across (as for a drag between tabs) and
     * answers with the new deck-relative src. Null when the file is gone or
     * this person may not see the other deck.
     */
    importDeckAsset: async (sourceDeck: string, src: string): Promise<string | null> => {
      if (sourceDeck === options.deckId) return src;
      try {
        const url = new URL(`/decks/${deckPath(sourceDeck)}/${deckPath(src.replace(/^\/+/, ''))}`, location.href);
        const response = await fetch(`/api/import-url?deck=${deck}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: url.href, deckAsset: true }),
        });
        if (!response.ok) return null;
        const imported = await response.json() as { src?: string; variant?: string };
        if (imported.src && imported.variant) setMediaVariants({ [imported.src]: imported.variant });
        return imported.src ?? null;
      } catch (err) {
        console.error(`Could not bring ${src} over from ${sourceDeck}:`, err);
        return null;
      }
    },

    assetUrl: (src: string): string => pinMediaVariant(src, deckAssetPath(options.deckId, src)),

    /**
     * One frame of a deck video, cut by the server (`/api/video-still`), for
     * preview surfaces (previewPosterProvider.ts). Without it a thumbnail
     * loads the clip itself to capture its frame: the original, as far in as
     * the in-point, which for a recording shown from 10 s in is 12 MB read to
     * paint one picture. Null when the server cannot cut one (an alpha clip),
     * so the surface falls back to capturing in the page. The still is
     * fetched once here and the `<img>` showing it reads it from the cache.
     */
    videoPoster: async (req: { src: string; time: number }): Promise<{ url: string | null }> => {
      const url = `/api/video-still?deck=${deck}&src=${encodeURIComponent(req.src)}&t=${req.time}`;
      try {
        const response = await fetch(url);
        if (!response.ok) return { url: null };
        await response.arrayBuffer();
        return { url };
      } catch {
        return { url: null };
      }
    },

    importAssetFiles: async (files: File[], progressToken?: string): Promise<ImportedAsset[]> => {
      const imported: ImportedAsset[] = [];
      for (const file of files) {
        imported.push(await uploadFile(deck, file, progressToken));
      }
      return imported;
    },

    /**
     * Import an image a drag only pointed at. A `data:` payload is already
     * bytes and uploads like any drop; a remote URL is fetched by the server,
     * which is both the only party that can reach it without CORS and the one
     * that guards against a client aiming the fetcher at its own network.
     */
    importImageUrl: async (source: ClipboardImageSource): Promise<ImportedAsset | null> => {
      try {
        if (source.kind === 'data') {
          const binary = atob(source.base64);
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          const name = clipboardImageName(source.mime) ?? 'Pasted image.png';
          return await uploadFile(deck, new File([bytes], name, { type: source.mime }));
        }
        const response = await fetch(`/api/import-url?deck=${deck}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // A drag out of another DeckWerk tab points back at this server; it
          // copies that file from disk rather than fetch its own private URL.
          body: JSON.stringify({ url: source.url, deckAsset: isOwnDeckAsset(source.url) }),
        });
        if (!response.ok) return null;
        return await response.json() as ImportedAsset;
      } catch (err) {
        console.error('Could not import the dropped image:', err);
        return null;
      }
    },

    onAssetImportProgress: (fn: (p: AssetImportProgress) => void): (() => void) => {
      progressListeners.add(fn);
      return () => progressListeners.delete(fn);
    },

    // The drop handler prefers importAssetFiles; these exist so shared code
    // that feature-tests them degrades quietly.
    importAssets: async (): Promise<ImportedAsset[]> => [],
    pathForFile: (): string => '',

    probeAsset: async (src: string): Promise<MediaInfo> => {
      const response = await fetch(`/api/probe?deck=${deck}&src=${encodeURIComponent(src)}`);
      if (!response.ok) return { width: null, height: null, duration: null };
      return response.json() as Promise<MediaInfo>;
    },

    /** The Media panel: the deck's assets/ folder, as the server sees it. */
    listDeckAssets: async (): Promise<DeckAssetListing> => {
      const response = await fetch(`/api/deck-assets?deck=${deck}`, { cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`);
      return await response.json() as DeckAssetListing;
    },
    /** Move unused files into the server's Trash; the server rechecks against the live deck. */
    trashDeckAssets: async (files: string[]): Promise<DeckAssetTrashResult> => {
      const response = await fetch(`/api/deck-assets/trash?deck=${deck}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`);
      return await response.json() as DeckAssetTrashResult;
    },

    loadTheme: async (): Promise<string> => {
      const response = await fetch(`/api/theme?deck=${deck}`);
      return response.ok ? response.text() : '';
    },
    saveTheme: async (css: string): Promise<void> => {
      options.saveTheme(css);
    },

    // Persistence belongs to the server; edits reach it as transactions.
    saveDeck: async (): Promise<void> => {},
  };

  (window as unknown as { api: typeof api }).api = api;
}
