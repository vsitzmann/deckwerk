import {
  answerFromKept,
  DECKS_CACHE,
  KEPT_HEADER,
  STAGING_CACHE,
  STAGING_HEADER,
  isImmutableMedia,
  isMediaPath,
  MEDIA_CACHE,
  mediaKey,
  SHELL_CACHE_PREFIX,
  type OfflineWorkerMessage,
} from './offlineShared.js';

/**
 * The browser editor's service worker: the app keeps working when the server
 * goes away, for a talk the editor has already downloaded (offlineCopy.ts).
 *
 * - **The shell** (pages, hashed bundles, fonts) is precached when the worker
 *   installs, from the list the build writes into it (vite.collab.config.ts).
 *   Pages are asked of the network first and answered from the cache when it
 *   cannot answer, so a server that is up always serves its current build;
 *   hashed files never change, so the cache answers them first.
 * - **Media** the page has put into MEDIA_CACHE is answered from there:
 *   content-keyed `/media/` URLs always (they name exact bytes), other deck
 *   files only once the server cannot answer. A file not in the cache is not
 *   touched at all: the request goes to the network exactly as it would
 *   with no worker, so nothing here changes how a media stack streams.
 *
 * Bundled on its own by the build, so it imports nothing but pure helpers.
 */

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  readonly clientId: string;
  readonly resultingClientId: string;
  respondWith(response: Response | Promise<Response>): void;
}
interface ExtendableMessageEvent extends ExtendableEvent {
  readonly data: unknown;
  readonly source: { postMessage(message: unknown): void } | null;
}
interface WorkerScope {
  readonly registration: { readonly scope: string };
  readonly location: Location;
  skipWaiting(): Promise<void>;
  readonly clients: {
    claim(): Promise<void>;
    matchAll(options?: { includeUncontrolled?: boolean }): Promise<Array<{ id: string }>>;
  };
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'message', listener: (event: ExtendableMessageEvent) => void): void;
}

declare const DECKWERK_SHELL: { version: string; files: string[] };

const worker = self as unknown as WorkerScope;
const SHELL_CACHE = `${SHELL_CACHE_PREFIX}${DECKWERK_SHELL.version}`;
/** The app's root, where the pages and `app/` live: the worker's own scope. */
const BASE = new URL(worker.registration.scope).pathname;
/** Pages kept under one key each, whatever query they were opened with. */
const PAGES = new Set(['index.html', 'present.html', 'mobile.html', 'print.html']);
/**
 * How long a page waits for a server that does not answer before the kept
 * copy is shown. A stopped server refuses at once; one behind a dropped
 * tailnet link can leave the connection hanging for a minute.
 */
const PAGE_TIMEOUT_MS = 3_000;
/** Older shells kept beside the current one, for a page still running an older build. */
const SHELL_GENERATIONS = 2;

/** Keys of MEDIA_CACHE, or null until read (the worker can be restarted at any moment). */
let kept: Set<string> | null = null;
let keptLoading: Promise<Set<string>> | null = null;
let keptReadAt = 0;
/**
 * The page says what it adds (`offline-media`), but a message can miss a
 * worker that was starting; a request for a file not known to be kept reads
 * the keys again, at most this often, so the next one is answered.
 */
const KEPT_REREAD_MS = 5_000;
/** Requests this worker could not answer, for the page to ask about (tests, diagnostics). */
const failures: Array<{ url: string; at: number; reason: string }> = [];

function loadKept(): Promise<Set<string>> {
  keptReadAt = Date.now();
  keptLoading ??= caches.open(MEDIA_CACHE)
    .then((cache) => cache.keys())
    .then((requests) => {
      const keys = new Set(requests.map((request) => mediaKey(request.url)));
      // Messages that arrived while the keys were read.
      for (const key of kept ?? []) keys.add(key);
      kept = keys;
      return keys;
    })
    .catch(() => {
      kept ??= new Set();
      return kept;
    });
  return keptLoading;
}

worker.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => worker.skipWaiting()));
});

worker.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const shells = (await caches.keys()).filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE);
    // caches.keys() lists in creation order: keep the newest few.
    for (const name of shells.slice(0, Math.max(0, shells.length - SHELL_GENERATIONS))) await caches.delete(name);
    await Promise.all([loadKept(), loadClientsBorn()]);
    await worker.clients.claim();
  })());
});

worker.addEventListener('message', (event) => {
  const message = event.data as OfflineWorkerMessage | null;
  if (message?.type === 'offline-media') {
    const keys = kept ?? new Set<string>();
    for (const url of message.added ?? []) keys.add(mediaKey(url));
    for (const url of message.removed ?? []) keys.delete(mediaKey(url));
    if (!kept) {
      kept = keys;
      void loadKept();
    }
  } else if (message?.type === 'offline-failures') {
    event.source?.postMessage({ type: 'offline-failures', failures });
  }
});

/**
 * One file at a time: this runs while the editor loads its first slide, and
 * the shell is a few megabytes. Every file must arrive, or the install fails
 * and the editor tries again once it reconnects (offlineShell.ts): a worker
 * that took charge without the presentation's page would let Present start
 * without a server and then show nothing. A second pass gives a file that
 * failed once (a blip) another chance first.
 */
async function precache(): Promise<void> {
  const cache = await caches.open(SHELL_CACHE);
  for (let pass = 0; pass < 2; pass++) {
    const missing: string[] = [];
    for (const file of DECKWERK_SHELL.files) {
      const url = `${BASE}${file}`;
      if (await cache.match(url)) continue;
      try {
        const response = await fetch(url, { cache: PAGES.has(file) ? 'no-cache' : 'default' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        await cache.put(url, response);
      } catch {
        missing.push(file);
      }
    }
    if (missing.length === 0) return;
    if (pass === 1) throw new Error(`the shell did not arrive: ${missing.join(', ')}`);
  }
}

worker.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || !url.pathname.startsWith(BASE)) return;
  const path = url.pathname;
  const relative = path.slice(BASE.length);
  if (relative === 'sw.js') return;
  // The app's pages only: a download or an export opened in a tab is the
  // server's business, and passes straight through.
  if (relative === '' || PAGES.has(relative)) {
    bornHere(event.resultingClientId);
    event.respondWith(page(request, relative === '' ? 'index.html' : relative));
    return;
  }
  if (relative.startsWith('app/')) {
    event.respondWith(appFile(request));
    return;
  }
  if (relative === 'api/config') {
    event.respondWith(networkFirst(request, SHELL_CACHE, mediaKey(url)));
    return;
  }
  if (relative === 'api/video-still') {
    // Small, and what a slide's thumbnail shows: kept as they are fetched.
    event.respondWith(networkFirst(request, MEDIA_CACHE, mediaKey(url)));
    return;
  }
  if (!isMediaPath(path)) return;
  const key = mediaKey(url);
  if (request.headers.has(STAGING_HEADER)) {
    // The offline copy reading back a download (offlineCopy.ts): the answer
    // carries this URL, so it can be kept and later given to a <video>.
    event.respondWith(caches.open(STAGING_CACHE).then((cache) => cache.match(key)).then((found) => found ?? Response.error()));
    return;
  }
  const client = event.clientId;
  if (kept === null || clientsBorn === null) {
    // Restarted: the decision needs what was kept, and which pages were born here.
    event.respondWith(Promise.all([loadKept(), loadClientsBorn()])
      .then(() => (fromCopy(request, key, client) ? media(request, path, key) : network(request))));
    return;
  }
  if (!kept.has(key) && Date.now() - keptReadAt > KEPT_REREAD_MS) {
    keptLoading = null;
    void loadKept();
  }
  if (!fromCopy(request, key, client)) {
    // A picture (or any whole file) under a content key, not kept yet:
    // fetched here rather than passed through. WebKit sends a request a
    // worker passes through past the HTTP cache, so Safari downloaded every
    // picture the editor had shown a second time when the copy asked for it
    // (dev/offline/safari-cache-probe3.mts). Fetched here, the page's
    // pictures are kept as they arrive, and the copy finds them kept.
    if (!isVideo(request) && isImmutableMedia(path)) event.respondWith(fetchAndKeep(request, key));
    // A clip, or a file without a content key: the network, untouched.
    return;
  }
  event.respondWith(media(request, path, key));
});

/** The network's answer; a whole picture a page shows is kept as it passes. */
async function fetchAndKeep(request: Request, key: string): Promise<Response> {
  const response = await network(request);
  if (request.destination === 'image' && response.status === 200 && response.type === 'basic') {
    const copy = response.clone();
    void caches.open(MEDIA_CACHE).then((cache) => cache.put(key, copy)).then(() => kept?.add(key)).catch(() => undefined);
  }
  return response;
}

/*
 * Never switch a page's video from the network to the copy in mid-life.
 * Chromium's media stack keeps one data source per URL in a page, shared by
 * every <video> on it; once some of a clip's ranges came from the network
 * and later ones from the worker, every element on that URL in that page
 * fails ("data source error"). That broke the editor canvas the moment the
 * copy finished a clip it had been streaming. So a clip a page first had
 * from the network stays on the network for that page, and so does every
 * clip of a page this worker did not control from its start (it cannot know
 * what that page loaded before). Pages born here (the presentation, an
 * editor opened or reloaded since) read clips from the copy from the start.
 * With the server gone the copy answers anyway: there is nothing to keep
 * consistent with.
 */
const streamedFromNetwork = new Map<string, Set<string>>();
/** Pages whose navigation this worker answered, so every request they made came here; null until read. */
let clientsBorn: Set<string> | null = null;
let clientsBornLoading: Promise<void> | null = null;
const CLIENTS_KEY = '/__offline__/clients';

function fromCopy(request: Request, key: string, client: string): boolean {
  if (!kept?.has(key)) {
    if (isVideo(request) && client) {
      const seen = streamedFromNetwork.get(client) ?? new Set<string>();
      seen.add(key);
      streamedFromNetwork.set(client, seen);
    }
    return false;
  }
  if (!isVideo(request) || serverSeemsDown()) return true;
  return Boolean(client) && Boolean(clientsBorn?.has(client)) && !streamedFromNetwork.get(client)?.has(key);
}

function isVideo(request: Request): boolean {
  return request.destination === 'video' || request.destination === 'audio';
}

function loadClientsBorn(): Promise<void> {
  clientsBornLoading ??= (async () => {
    try {
      const found = await (await caches.open(DECKS_CACHE)).match(CLIENTS_KEY);
      const ids = found ? await found.json() as string[] : [];
      // Only pages still open.
      const open = new Set((await worker.clients.matchAll({ includeUncontrolled: true })).map((each) => each.id));
      clientsBorn = new Set([...ids.filter((id) => open.has(id)), ...clientsBorn ?? []]);
    } catch {
      clientsBorn ??= new Set();
    }
  })();
  return clientsBornLoading;
}

/** A page this worker answered the navigation of: its every request comes here. */
function bornHere(id: string): void {
  if (!id) return;
  clientsBorn ??= new Set();
  clientsBorn.add(id);
  void (async () => {
    const open = new Set((await worker.clients.matchAll({ includeUncontrolled: true })).map((each) => each.id));
    const ids = [...clientsBorn ?? []].filter((each) => each === id || open.has(each));
    await (await caches.open(DECKS_CACHE)).put(CLIENTS_KEY, new Response(JSON.stringify(ids)));
  })().catch(() => undefined);
}

/** A kept file: from the cache if its URL names its bytes, else from the server while it answers. */
async function media(request: Request, path: string, key: string): Promise<Response> {
  const cache = await caches.open(MEDIA_CACHE);
  const found = await cache.match(key);
  if (!found) {
    kept?.delete(key);
    return network(request);
  }
  // A URL that names its bytes needs no server; anything else is the
  // server's to answer while it can.
  if (isImmutableMedia(path)) return answerFromKept(request, found, { whole: wholeForMedia(request) });
  const answer = await freshOrKept(request, PAGE_TIMEOUT_MS, (response) => response.ok || response.status === 304);
  return answer ?? answerFromKept(request, found, { whole: wholeForMedia(request) });
}

/**
 * Chromium's media stack (as of Chrome 155) aborts a load answered with a
 * byte range a service worker made up itself: the 206 arrives, the element
 * reports a format error. It plays the whole file answered with a 200, and
 * reads on through it to seek. Safari's media stack is the opposite: it
 * needs real ranges and refuses a 200 for video.
 */
const CHROMIUM = /\bChrom(?:e|ium)\//.test(navigator.userAgent);

function wholeForMedia(request: Request): boolean {
  return CHROMIUM && (request.destination === 'video' || request.destination === 'audio');
}

async function network(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch (error) {
    failures.push({ url: mediaKey(request.url), at: Date.now(), reason: String(error) });
    throw error;
  }
}

/*
 * Whether the server answers. A server behind a dropped route never refuses:
 * each request waits out its timeout. Once one has, the next ones (the page,
 * then its config, then its files) are answered from what is kept at once,
 * while the request still goes out and, the moment one comes back, the
 * server is believed again.
 */
let unansweredAt = 0;
let answeredAt = 0;
const SERVER_DOWN_MEMORY_MS = 15_000;

function serverSeemsDown(): boolean {
  return unansweredAt > answeredAt && Date.now() - unansweredAt < SERVER_DOWN_MEMORY_MS;
}

/**
 * The server's answer to `request`, or null if it fails, does not answer
 * within `timeoutMs`, gives an answer `acceptable` rejects, or seems down
 * (then without waiting). `onFresh` sees every answer that does come, late
 * ones included, to keep it.
 */
async function freshOrKept(
  request: Request,
  timeoutMs: number,
  acceptable: (response: Response) => boolean,
  onFresh?: (response: Response) => Promise<void>,
): Promise<Response | null> {
  let settled = false;
  const fresh = fetch(request).then(async (response) => {
    answeredAt = Date.now();
    await onFresh?.(response.clone()).catch(() => undefined);
    return response;
  }, () => {
    unansweredAt = Date.now();
    return null;
  });
  if (serverSeemsDown()) return null;
  let timer = 0;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      if (!settled) unansweredAt = Date.now();
      resolve(null);
    }, timeoutMs) as unknown as number;
  });
  try {
    const answer = await Promise.race([fresh, timedOut]);
    settled = true;
    return answer && acceptable(answer) ? answer : null;
  } finally {
    clearTimeout(timer);
  }
}

/** A kept answer, marked so the page can tell it did not come from the server. */
function markedKept(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(KEPT_HEADER, '1');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** A page: the server's current one while it answers, the kept one when it cannot. */
async function page(request: Request, file: string): Promise<Response> {
  const cache = await caches.open(SHELL_CACHE);
  const key = `${BASE}${file}`;
  const keep = async (response: Response) => {
    // A redirect (a view-only participant sent to the viewer) or an error
    // page is this request's answer, never the page to keep.
    if (response.ok && !response.redirected && response.type === 'basic'
      && (response.headers.get('content-type') ?? '').includes('text/html')) {
      await cache.put(key, response);
    }
  };
  const keptPage = await cache.match(key) ?? await caches.match(key);
  if (!keptPage) {
    try {
      const response = await fetch(request);
      await keep(response.clone());
      return response;
    } catch (error) {
      return fail(request, error);
    }
  }
  // The presentation is opened by an editor already running this build, and
  // the shell kept is that build's: no reason to wait on the server for it,
  // which over a route that dropped silently is a black screen for as long
  // as the timeout. The fetch still refreshes the kept copy.
  if (file === 'present.html') {
    void fetch(request).then(keep).catch(() => undefined);
    return keptPage;
  }
  // Any answer the server gives is this request's: a redirect, an error page.
  return (await freshOrKept(request, PAGE_TIMEOUT_MS, () => true, keep)) ?? keptPage;
}

/** A hashed bundle file: kept for good once fetched. */
async function appFile(request: Request): Promise<Response> {
  const found = await caches.match(request);
  if (found) return found;
  try {
    const response = await fetch(request);
    if (response.ok) await (await caches.open(SHELL_CACHE)).put(request, response.clone());
    return response;
  } catch (error) {
    return fail(request, error);
  }
}

/**
 * The server's answer while it gives one, the kept answer (marked) when it
 * does not: when it fails, does not answer within the timeout, or seems down.
 */
async function networkFirst(request: Request, cacheName: string, key: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const keep = async (response: Response) => {
    if (response.ok) await cache.put(key, response);
  };
  const keptAnswer = await cache.match(key);
  if (!keptAnswer) {
    try {
      const response = await fetch(request);
      await keep(response.clone());
      return response;
    } catch (error) {
      return fail(request, error);
    }
  }
  return (await freshOrKept(request, PAGE_TIMEOUT_MS, () => true, keep)) ?? markedKept(keptAnswer);
}

function fail(request: Request, error: unknown): Response {
  failures.push({ url: mediaKey(request.url), at: Date.now(), reason: String(error) });
  return Response.error();
}
