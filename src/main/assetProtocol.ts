import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { resolveAsset } from './deckStore.js';
import { deckDirForKey } from './deckWindows.js';
import { POSTER_HOST, posterCacheDir } from './posterCache.js';

/**
 * A custom `deck://` scheme for serving a deck's own assets to the renderer.
 *
 * Loading media over `file://` from a page that isn't itself a file URL is
 * blocked, and relaxing web security to work around that would be a poor trade.
 * More importantly, this route goes through `net.fetch`, which honours HTTP
 * range requests — without those, seeking in a long video forces a full
 * download and scrubbing in the trim window is unusable.
 *
 * The URL's host names the deck: `deck://<deck key>/<path inside the folder>`.
 * A request carries no window identity, so with several presentations open at
 * once the URL is the only thing that can say which folder to serve from.
 */

/** Must be called before `app.ready`. */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: false,
      },
      scheme: 'deck',
    },
  ]);
}

/**
 * Parse an HTTP Range header against a file size. Returns null for absent or
 * unsatisfiable ranges. Only the single-range form is supported — it is the
 * only one Chromium's media stack sends.
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    // Suffix form: last N bytes.
    const n = Number(rawEnd);
    if (n <= 0) return null;
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start >= size || start > end) return null;
  return { start, end };
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.avif': 'image/avif', '.css': 'text/css',
  // Web elements: a deck-relative page in a sandboxed frame, plus what it may pull in.
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
};

/** Must be called after `app.ready`. */
export function installAssetProtocol(): void {
  protocol.handle('deck', async (request) => {
    try {
      // deck://<deck key>/<relative path>
      const url = new URL(request.url);
      // `deck://posters/<name>.jpg` is the poster-frame cache, shared by every
      // deck; anything else names a deck folder.
      const deckDir = url.hostname === POSTER_HOST ? posterCacheDir() : deckDirForKey(url.hostname);
      if (!deckDir) return new Response('No deck open', { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (!relative) return new Response('Not found', { status: 404 });
      const absolute = resolveAsset(deckDir, relative);
      const info = statSync(absolute);
      const size = info.size;
      const ext = absolute.slice(absolute.lastIndexOf('.')).toLowerCase();
      const type = MIME[ext] ?? 'application/octet-stream';

      // Same caching contract as the collab server: imported assets carry a
      // content hash in the name and are immutable; everything else
      // revalidates with the ETag. Without this, every element mounting the
      // same clip streamed its own full copy — a deck reusing one clip across
      // N elements did N large reads at every open, and previews sat black
      // until their turn came.
      const etag = `"${size}-${Math.round(info.mtimeMs)}"`;
      const cacheControl = /\.[0-9a-f]{8}\.(?:[a-z0-9]+\.)?[a-z0-9]+$/i.test(absolute)
        ? 'public, max-age=31536000, immutable'
        : 'public, no-cache';
      if (request.headers.get('If-None-Match') === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': cacheControl,
            // Also on the revalidation path: a CORS media load that 304s must
            // still see the header, or the cached bytes taint the canvas.
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // Range support is not an optimisation here — it is what makes seeking
      // work at all. Without 206 responses, setting `currentTime` on a video
      // never completes, which presented as "trim scrubbing shows nothing".
      const range = parseRange(request.headers.get('Range'), size);
      const headers: Record<string, string> = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        ETag: etag,
        'Cache-Control': cacheControl,
        // The editor renderer is http(s) in development and file: when
        // packaged, while assets live at deck:. Opting this private scheme
        // into CORS lets canvas tools read pixels without tainting the bitmap.
        'Access-Control-Allow-Origin': '*',
      };

      if (range) {
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
        headers['Content-Length'] = String(range.end - range.start + 1);
        const stream = Readable.toWeb(
          createReadStream(absolute, { start: range.start, end: range.end }),
        ) as ReadableStream;
        return new Response(stream, { status: 206, headers });
      }

      headers['Content-Length'] = String(size);
      const stream = Readable.toWeb(createReadStream(absolute)) as ReadableStream;
      return new Response(stream, { status: 200, headers });
    } catch (err) {
      return new Response(String(err), { status: 403 });
    }
  });
}
