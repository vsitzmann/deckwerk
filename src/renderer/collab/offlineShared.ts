/**
 * What the browser editor's service worker (sw.ts) and the page that fills
 * its caches (offlineCopy.ts) agree on: cache names, what counts as media,
 * the key a file is kept under, and how a byte range of a kept file is
 * answered. Pure, and free of imports, because the worker is bundled on its
 * own (vite.collab.config.ts).
 */

/** The app shell of one build: HTML pages, hashed bundles, fonts, /api/config. */
export const SHELL_CACHE_PREFIX = 'deckwerk-shell-';
/**
 * The decks' media, kept by URL. Content-keyed `/media/` URLs make one entry
 * serve every deck holding the same bytes, so this is one cache for all of
 * them; which deck holds which file is the index's business (offlineCopy.ts).
 */
export const MEDIA_CACHE = 'deckwerk-media';
/** Snapshots of decks and the index of what each one holds. */
export const DECKS_CACHE = 'deckwerk-decks';
/**
 * A download on its way into MEDIA_CACHE. It is written here first, then
 * read back through the worker (STAGING_HEADER): a response the page
 * fetched carries its URL, which a response it built does not, and
 * Chromium's media stack refuses a URL-less response for a `<video>`.
 */
export const STAGING_CACHE = 'deckwerk-staging';
/** On a page's request for a file in STAGING_CACHE: the worker answers from there. */
export const STAGING_HEADER = 'x-deckwerk-staging';

/** Where a deck's snapshot is kept in DECKS_CACHE: never a URL the server answers. */
export function snapshotKey(deckId: string): string {
  return `/__offline__/deck?deck=${encodeURIComponent(deckId)}`;
}

/** On an answer the worker gave from its cache because the server did not answer. */
export const KEPT_HEADER = 'x-deckwerk-kept';

/** Where the index of offline decks is kept in DECKS_CACHE. */
export const INDEX_KEY = '/__offline__/index';

/**
 * Whether a same-origin path is one of the decks' files: content-keyed media,
 * a deck asset, or a frame the server cut from a clip.
 */
export function isMediaPath(path: string): boolean {
  return path.startsWith('/media/') || /^\/decks\/.+\/assets\//.test(path) || path === '/api/video-still';
}

/**
 * Whether the URL names exact bytes for good, so a kept copy may be served
 * without asking the server: `/media/<o|r><key>`. Anything else is asked
 * first and the kept copy is what answers when the server cannot.
 */
export function isImmutableMedia(path: string): boolean {
  return /^\/media\/[or][0-9a-f]{24}(?:\.[a-z0-9]+)?$/.test(path);
}

/** The key a file is kept under: its path and query, the origin being implied. */
export function mediaKey(url: string | URL): string {
  const parsed = typeof url === 'string' ? new URL(url, 'http://offline.invalid') : url;
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * The bytes a `Range` header asks for, inclusive, or null when it asks for
 * nothing this file has. Only single ranges: that is all a media stack, or
 * MediaBlobCache resuming a download, ever sends.
 */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    // A suffix: the last n bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || end < start) return null;
  return { start, end };
}

/**
 * Answer a request from a kept copy, honouring its `Range` the way the
 * server would: a `<video>` reads its source in ranges and cannot seek
 * without them, Safari's media stack least of all.
 */
export async function answerFromKept(request: Request, kept: Response, options: { whole?: boolean } = {}): Promise<Response> {
  const range = request.headers.get('range');
  if (!range || options.whole) return kept;
  const blob = await kept.blob();
  const type = kept.headers.get('content-type') ?? blob.type;
  const wanted = parseRange(range, blob.size);
  if (!wanted) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${blob.size}` } });
  }
  const body = blob.slice(wanted.start, wanted.end + 1);
  const headers = new Headers({
    'content-type': type,
    'content-length': String(body.size),
    'content-range': `bytes ${wanted.start}-${wanted.end}/${blob.size}`,
    'accept-ranges': 'bytes',
  });
  const etag = kept.headers.get('etag');
  if (etag) headers.set('etag', etag);
  return new Response(body, { status: 206, headers });
}

/** Messages the page sends the worker. */
export type OfflineWorkerMessage =
  /** Files put into, or deleted from, MEDIA_CACHE. */
  | { type: 'offline-media'; added?: string[]; removed?: string[] }
  /** What the worker could not answer since it started (tests and diagnostics). */
  | { type: 'offline-failures' };
