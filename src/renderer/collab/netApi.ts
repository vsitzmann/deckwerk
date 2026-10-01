import type { AssetImportProgress, ImportedAsset, MediaInfo } from '@shared/ipc.js';
import { clipboardImageName, type ClipboardImageSource } from '@shared/clipboardImages.js';
import { pinMediaVariant } from './mediaVariants.js';

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
        resolve(xhr.response as ImportedAsset);
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

export function installNetApi(options: NetApiOptions): void {
  const deck = encodeURIComponent(options.deckId);
  const api = {
    assetUrl: (src: string): string => pinMediaVariant(
      src,
      `/decks/${deck}/${src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`,
    ),

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
