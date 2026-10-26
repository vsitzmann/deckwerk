import type { Deck } from '@shared/deck.js';
import { deckReferencedAssets } from '@shared/mediaIndex.js';
import { talkMediaOrder } from '../player/talkMediaOrder.js';
import {
  DECKS_CACHE,
  INDEX_KEY,
  isImmutableMedia,
  MEDIA_CACHE,
  mediaKey,
  snapshotKey,
  STAGING_CACHE,
  STAGING_HEADER,
  type OfflineWorkerMessage,
} from './offlineShared.js';

/**
 * The editor's offline copy of the deck it has open: the deck itself and
 * every file its slides show, kept in Cache Storage, where the service
 * worker (sw.ts) answers from them once the server has gone. With it a
 * talk can be given, and the editor reloaded, after the connection drops.
 *
 * - **The deck** is kept as a snapshot (deck, theme, media variants) that
 *   the editor loads when it opens without a server (main.ts).
 * - **The files** are downloaded in the background, one at a time, in the
 *   order the presentation would want them (talkMediaOrder.ts: pictures of
 *   the slide on screen and the next few, the clips about to play, the
 *   other pictures, the other clips), counted outward from the slide the
 *   editor is on. Then the files a talk shows only in passing: skipped
 *   slides, web pages, layout masters.
 * - **Never in the way.** Nothing starts while the editor is fetching what
 *   it shows or a presentation is running (`busy`), and a clip already
 *   downloading stops reading until it is quiet again. Whatever is waiting
 *   for a file this is downloading (`settled`) makes it go at once instead
 *   of fetching it a second time. In a browser whose HTTP cache keeps what
 *   a `<video>` read (Chromium), a clip is asked for as `bytes=0-`, which
 *   that cache assembles from the parts it holds; elsewhere the editor's
 *   own in-memory copy is used when it has one (`borrow`).
 * - **Bounded.** A file goes in only while the origin's storage has room
 *   for it (`navigator.storage.estimate`), and the browser is asked to keep
 *   the storage (`persist`). Every deck opened is recorded in an index with
 *   the files it holds; the decks opened longest ago are dropped past
 *   MAX_DECKS or MAX_AGE_MS, a deck the server says this person may no
 *   longer open is dropped at once (`forget`), and a file no recorded deck
 *   holds any more is deleted.
 *
 * A clip whose streaming version the server is still preparing is not
 * downloaded (its original can be many times the size): it counts as a file
 * left until the version exists.
 */

/** What another fetcher of the deck's files needs of the offline copy. */
export interface OfflineLender {
  settled(url: string): Promise<void>;
}

declare global {
  interface Window {
    /** The editor tab's offline copy (main.ts), for the presentation it embeds and its video memory. */
    deckwerkOffline?: OfflineLender;
  }
}

/**
 * `fetch`, but first waiting out a download of the same URL that the offline
 * copy in `host` (this page, or the editor that embeds it) is running, so
 * the file is read from that copy rather than downloaded a second time.
 */
export function fetchAfterOfflineCopy(host: () => Window | null): typeof fetch {
  return async (input, init) => {
    try {
      await host()?.deckwerkOffline?.settled(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    } catch {
      // The lender's page went away.
    }
    return fetch(input, init);
  };
}

/** Decks kept offline, most recently opened first. */
const MAX_DECKS = 8;
/** A deck not opened for this long is no longer kept. */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Share of the origin's quota the offline copy may fill. */
const QUOTA_SHARE = 0.8;
/** The editor must have been quiet this long before a download starts or resumes. */
const IDLE_MS = 1_000;
const POLL_MS = 250;
/** A file that fails this often is left to the network for the rest of the session. */
const FAILURE_LIMIT = 2;
/** Snapshot writes are coalesced: a deck can be a megabyte of JSON. */
const SNAPSHOT_DELAY_MS = 2_000;
/** Without a server, downloading tries again this often (and at once when the editor reconnects). */
const RETRY_MS = 15_000;
/** Re-planning follows slide changes and edits, coalesced. */
const PLAN_DELAY_MS = 300;

/** What the editor keeps of a deck to open it without a server. */
export interface OfflineSnapshot {
  version: 1;
  deckId: string;
  deck: Deck;
  themeCss: string;
  mediaVariants: Record<string, string>;
  pendingMedia: string[];
  savedAt: number;
}

interface IndexEntry {
  openedAt: number;
  /** Keys in MEDIA_CACHE this deck holds. */
  files: string[];
}

interface OfflineIndex {
  decks: Record<string, IndexEntry>;
}

export type OfflineState = 'unavailable' | 'downloading' | 'ready' | 'incomplete';

export interface OfflineStatus {
  state: OfflineState;
  /** Files still to download, waiting clips included. */
  remaining: number;
  /** Files the deck shows. */
  total: number;
  /** Files left to the network: no room for them, or they kept failing. */
  noRoom: number;
  failed: number;
}

export interface OfflineCopyOptions {
  deckId: string;
  /** The deck as the editor holds it, and the slide it is on. */
  deck: () => Deck;
  slideIndex: () => number;
  themeCss: () => string;
  mediaVariants: () => Record<string, string>;
  pendingMedia: () => string[];
  /** A deck src's network URL, exactly as the editor and the presentation build it. */
  resolveSrc: (src: string) => string;
  isPending: (src: string) => boolean;
  /** The editor is fetching what it shows, or presenting: downloading waits. */
  busy: () => boolean;
  /** A `blob:` URL the page already holds this file under (the editor's video memory). */
  borrow?: (url: string) => string | undefined;
  /** Ask for clips as `bytes=0-`, so Chromium's HTTP cache serves what its media stack already read. */
  rangeReuse: boolean;
  /** Something a status line shows changed. */
  onChange: () => void;
  caches?: CacheStorage;
  fetch?: typeof fetch;
  storage?: Pick<StorageManager, 'estimate'> & Partial<Pick<StorageManager, 'persist' | 'persisted'>>;
  locks?: Pick<LockManager, 'request'> | null;
  /** The active service worker, to hear what was added and removed. */
  worker?: () => { postMessage(message: OfflineWorkerMessage): void } | null;
  /**
   * Whether the worker controls this page: a download is read back through
   * it (STAGING_CACHE), so nothing is downloaded before it does.
   */
  controlled?: () => boolean;
  now?: () => number;
}

interface Flight {
  url: string;
  urgent: boolean;
  done: Promise<void>;
}

export class OfflineCopy {
  private readonly caches: CacheStorage;
  private readonly fetchFile: typeof fetch;
  private readonly now: () => number;
  /** The deck's files, most urgent first, and which are pictures. */
  private plan: string[] = [];
  /** The planned files that are clips: they download one chunk at a time, yielding to the editor. */
  private clips = new Set<string>();
  private waiting = 0;
  private planned = false;
  /** Keys in MEDIA_CACHE, or null until read. */
  private kept: Set<string> | null = null;
  private failures = new Map<string, number>();
  private noRoom = new Set<string>();
  private flight: Flight | null = null;
  private running = false;
  private started = false;
  private disposed = false;
  /** The service worker that answers from these files: being installed, in charge, or impossible here. */
  private shell: 'pending' | 'ready' | 'unavailable' = 'pending';
  private planTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotDue = 0;
  /** The last download found no server: downloading waits for `resume` (or a retry). */
  private unreachable = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  /** When the editor was last seen busy: the copy waits IDLE_MS past it. */
  private busyAt = Number.NEGATIVE_INFINITY;
  persisted: boolean | null = null;

  constructor(private readonly options: OfflineCopyOptions) {
    this.caches = options.caches ?? globalThis.caches;
    this.fetchFile = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    // Read what is kept now: whether the copy is complete must be known the
    // moment the deck is on screen, which is when somebody presses Present.
    void this.loadKept().catch(() => undefined);
  }

  /** The server is back: download what is left. */
  resume(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.unreachable = false;
    void this.pump();
  }

  private retrySoon(): void {
    if (this.retryTimer || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.resume();
    }, RETRY_MS);
  }

  /** Whether this browser can keep anything offline here (Cache Storage needs a secure context). */
  static supported(): boolean {
    return typeof caches !== 'undefined' && globalThis.isSecureContext !== false;
  }

  /** The kept snapshot of a deck, or null. */
  static async loadSnapshot(deckId: string, storage: CacheStorage = caches): Promise<OfflineSnapshot | null> {
    try {
      const found = await (await storage.open(DECKS_CACHE)).match(snapshotKey(deckId));
      if (!found) return null;
      const snapshot = await found.json() as OfflineSnapshot;
      return snapshot.version === 1 && snapshot.deckId === deckId ? snapshot : null;
    } catch {
      return null;
    }
  }

  /** Begin: the deck is open and the editor has shown its first slide. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.options.storage?.persist?.().then((granted) => {
      this.persisted = granted;
    }).catch(() => undefined);
    this.replan();
    this.saveSnapshotSoon(0);
  }

  /** Whether the service worker that answers from these files is in charge (false: it never will be). */
  setShellReady(ready: boolean): void {
    this.shell = ready ? 'ready' : 'unavailable';
    this.options.onChange();
    if (ready && this.started) void this.pump();
  }

  private isControlled(): boolean {
    return this.options.controlled ? this.options.controlled() : Boolean(globalThis.navigator?.serviceWorker?.controller);
  }

  /** The deck, its theme, its media variants or the slide shown changed. */
  deckChanged(): void {
    if (!this.started || this.disposed) return;
    if (this.planTimer) clearTimeout(this.planTimer);
    this.planTimer = setTimeout(() => {
      this.planTimer = null;
      this.replan();
    }, PLAN_DELAY_MS);
    this.saveSnapshotSoon(SNAPSHOT_DELAY_MS);
  }

  /** Only the slide shown changed: the order may, nothing to save. */
  slideChanged(): void {
    if (!this.started || this.disposed || this.planTimer) return;
    this.planTimer = setTimeout(() => {
      this.planTimer = null;
      this.replan();
    }, PLAN_DELAY_MS);
  }

  /**
   * Resolves once a download of `url` this copy is running has ended (at
   * once when there is none). Whatever would otherwise fetch the same file
   * waits here, so its bytes cross the wire once: the download is made to
   * go ahead of everything, and afterwards the worker answers from the copy.
   */
  async settled(url: string): Promise<void> {
    const flight = this.flight;
    if (!flight || mediaKey(flight.url) !== mediaKey(url)) return;
    flight.urgent = true;
    this.wake?.();
    await flight.done.catch(() => undefined);
  }

  status(): OfflineStatus {
    // An edit just made counts now, not once the coalescing timer fires:
    // somebody may press Present in between.
    if (this.planTimer) {
      clearTimeout(this.planTimer);
      this.planTimer = null;
      this.replan();
    }
    const kept = this.kept ?? new Set<string>();
    const left = this.plan.filter((url) => !kept.has(mediaKey(url)));
    const noRoom = left.filter((url) => this.noRoom.has(url)).length;
    const failed = left.filter((url) => (this.failures.get(url) ?? 0) >= FAILURE_LIMIT).length;
    const remaining = left.length + this.waiting;
    let state: OfflineState;
    if (!this.started || !this.planned || this.shell === 'unavailable') state = 'unavailable';
    else if (remaining === 0 && this.shell === 'ready') state = 'ready';
    else if (remaining > 0 && remaining === noRoom + failed) state = 'incomplete';
    else state = 'downloading';
    return { state, remaining, total: this.plan.length + this.waiting, noRoom, failed };
  }

  /** Everything a presentation needs is here: the shell, the deck and every file. */
  ready(): boolean {
    return this.status().state === 'ready';
  }

  /** The words for the editor's status line, or '' when there is nothing to say. */
  statusText(): string {
    const status = this.status();
    if (status.state === 'ready') return 'Available offline';
    if (status.state === 'downloading') {
      if (status.remaining === 0) return 'Preparing for offline…';
      const left = `${status.remaining} ${status.remaining === 1 ? 'file' : 'files'} left`;
      if (this.unreachable) return `Offline copy waits for the server: ${left}`;
      return `Downloading for offline: ${left}`;
    }
    if (status.state === 'incomplete') {
      if (status.noRoom > 0) return `Not enough storage to keep ${status.noRoom} ${status.noRoom === 1 ? 'file' : 'files'} offline`;
      return `Offline copy incomplete: ${status.failed} ${status.failed === 1 ? 'file' : 'files'} could not be downloaded`;
    }
    return '';
  }

  /** This person may no longer open the deck: keep nothing of it. */
  async forget(): Promise<void> {
    this.dispose();
    try {
      await (await this.caches.open(DECKS_CACHE)).delete(snapshotKey(this.options.deckId));
      const index = await this.readIndex();
      delete index.decks[this.options.deckId];
      await this.writeIndex(index);
      await this.evict(index);
    } catch {
      // Storage refused: nothing more to do here.
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.planTimer) clearTimeout(this.planTimer);
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.wake?.();
  }

  /* --- planning ----------------------------------------------------------- */

  private replan(): void {
    if (this.disposed) return;
    const deck = this.options.deck();
    const { urls } = talkMediaOrder(deck.slides, this.options.slideIndex(), this.options.resolveSrc);
    const plan = new Set(urls);
    const all = deckReferencedAssets(deck);
    // Everything else a slide shows: skipped slides, web pages, PDFs, layout
    // masters, pictures inside HTML regions. Not the theme file: it arrives
    // with the snapshot.
    for (const src of all) if (src !== deck.theme && src.startsWith('assets/')) plan.add(this.options.resolveSrc(src));
    const waiting = new Set([...all].filter((src) => this.options.isPending(src)).map((src) => this.options.resolveSrc(src)));
    this.waiting = waiting.size;
    this.plan = [...plan].filter((url) => !waiting.has(url));
    this.clips = new Set(deck.slides.flatMap((slide) => slide.elements)
      .flatMap((el) => (el.type === 'video' ? [this.options.resolveSrc(el.src)] : [])));
    this.planned = true;
    void this.recordDeck();
    this.options.onChange();
    void this.pump();
  }

  /* --- downloading -------------------------------------------------------- */

  private keptLoading: Promise<Set<string>> | null = null;

  private loadKept(): Promise<Set<string>> {
    this.keptLoading ??= (async () => {
      const requests = await (await this.caches.open(MEDIA_CACHE)).keys();
      this.kept ??= new Set(requests.map((request) => mediaKey(request.url)));
      this.options.onChange();
      return this.kept;
    })();
    return this.keptLoading;
  }

  private next(kept: Set<string>): string | undefined {
    return this.plan.find((url) => !kept.has(mediaKey(url))
      && !this.noRoom.has(url) && (this.failures.get(url) ?? 0) < FAILURE_LIMIT);
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      const kept = await this.loadKept();
      for (;;) {
        if (this.disposed) return;
        if (this.unreachable) {
          this.retrySoon();
          break;
        }
        // Resumed by setShellReady once the worker is in charge.
        if (!this.isControlled()) break;
        if (!this.next(kept)) break;
        await this.quiet();
        // The plan may have moved on while the editor was busy.
        const url = this.next(kept);
        if (!url || this.disposed) break;
        await this.exclusively(() => this.download(url, kept));
        this.options.onChange();
      }
    } catch {
      // Cache Storage refused (private browsing, storage cleared): stay quiet.
    } finally {
      this.running = false;
      this.options.onChange();
    }
  }

  /** One download in the whole browser at a time, however many editor tabs are open. */
  private async exclusively(work: () => Promise<void>): Promise<void> {
    const locks = this.options.locks === undefined ? globalThis.navigator?.locks : this.options.locks;
    if (!locks) return work();
    await locks.request('deckwerk-offline-download', work);
  }

  /**
   * Resolves once the editor has not been busy for IDLE_MS. Quiet since the
   * last look, it goes on at once: waiting a second before each of a talk's
   * hundred-odd files was most of the time a copy took.
   */
  private async quiet(urgent?: () => boolean): Promise<void> {
    while (!this.disposed && !urgent?.()) {
      if (this.options.busy()) this.busyAt = this.now();
      else if (this.now() - this.busyAt >= IDLE_MS) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.wake = null;
          resolve();
        }, POLL_MS);
        this.wake = () => {
          clearTimeout(timer);
          this.wake = null;
          resolve();
        };
      });
    }
  }

  private async download(url: string, kept: Set<string>): Promise<void> {
    const key = mediaKey(url);
    const cache = await this.caches.open(MEDIA_CACHE);
    // Another tab may have kept it while this one waited for the lock.
    if (await cache.match(key)) {
      kept.add(key);
      return;
    }
    let finish!: () => void;
    const flight: Flight = { url, urgent: false, done: new Promise<void>((resolve) => { finish = resolve; }) };
    this.flight = flight;
    const abort = new AbortController();
    try {
      const borrowed = this.options.borrow?.(url);
      const clip = this.clips.has(url);
      const response = await this.fetchFile(borrowed ?? url, {
        signal: abort.signal,
        // A content-keyed URL names exact bytes: whatever the browser holds
        // for it is right. Safari otherwise sent the editor's own pictures
        // again once the worker was in charge of the page.
        ...(!borrowed && isImmutableMedia(mediaKey(url).split('?')[0]) ? { cache: 'force-cache' as const } : {}),
        ...(!borrowed && clip && this.options.rangeReuse ? { headers: { range: 'bytes=0-' } } : {}),
      });
      const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (!(response.status === 200 || (response.status === 206 && range?.[1] === '0')) || !response.body) {
        throw new ServerRefused(response.status);
      }
      const declared = Number(range?.[2] ?? response.headers.get('content-length'));
      const size = declared > 0 ? declared : null;
      if (size !== null && !(await this.fits(size))) {
        abort.abort();
        this.noRoom.add(url);
        return;
      }
      const headers = new Headers();
      const type = response.headers.get('content-type');
      if (type) headers.set('content-type', type);
      if (size !== null) headers.set('content-length', String(size));
      const etag = response.headers.get('etag');
      if (etag) headers.set('etag', etag);
      headers.set('accept-ranges', 'bytes');
      // A clip yields to the editor between chunks: its download is the one
      // that holds the link for seconds.
      const body = clip
        ? pausable(response.body, () => !flight.urgent && !this.disposed && this.options.busy(), () => this.quiet(() => flight.urgent))
        : response.body;
      // Written aside, then read back through the worker, so what is kept
      // carries its URL: Chromium plays no `<video>` from a response without one.
      const staging = await this.caches.open(STAGING_CACHE);
      await staging.put(key, new Response(body, { status: 200, headers }));
      try {
        const settled = await this.fetchFile(url, { headers: { [STAGING_HEADER]: '1' } });
        if (!settled.ok) throw new Error(`the worker could not read back ${url}`);
        await cache.put(key, settled);
      } finally {
        await staging.delete(key);
      }
      kept.add(key);
      this.failures.delete(url);
      this.options.worker?.()?.postMessage({ type: 'offline-media', added: [url] });
    } catch (error) {
      if ((error as { name?: string }).name === 'QuotaExceededError') this.noRoom.add(url);
      else if (error instanceof ServerRefused) {
        // The server answered, and not with the file: that is the file's failure.
        if (!this.disposed) this.failures.set(url, (this.failures.get(url) ?? 0) + 1);
      } else if (!this.disposed && !abort.signal.aborted) {
        // No answer at all: the connection, not the file. Wait for the server.
        this.unreachable = true;
      }
    } finally {
      if (this.flight === flight) this.flight = null;
      finish();
    }
  }

  /** Whether `bytes` more fit the share of the origin's storage the copy may fill. */
  private async fits(bytes: number): Promise<boolean> {
    try {
      const estimate = await this.options.storage?.estimate();
      if (!estimate?.quota) return true;
      return (estimate.usage ?? 0) + bytes <= estimate.quota * QUOTA_SHARE;
    } catch {
      return true;
    }
  }

  /* --- the deck, the index, eviction --------------------------------------- */

  /**
   * Save within `delay`. A save already due sooner stands: it reads the deck
   * as it is when it runs, and pushing it back on every edit meant a deck
   * edited steadily, or left within a couple of seconds of opening, never
   * had a snapshot at all.
   */
  private saveSnapshotSoon(delay: number): void {
    const due = this.now() + delay;
    if (this.snapshotTimer && this.snapshotDue <= due) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotDue = due;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.saveSnapshot();
    }, delay);
  }

  /** The page is going away or out of sight: save a pending snapshot now. */
  flushSnapshot(): void {
    if (!this.snapshotTimer) return;
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    void this.saveSnapshot();
  }

  private async saveSnapshot(): Promise<void> {
    if (this.disposed) return;
    const snapshot: OfflineSnapshot = {
      version: 1,
      deckId: this.options.deckId,
      deck: this.options.deck(),
      themeCss: this.options.themeCss(),
      mediaVariants: this.options.mediaVariants(),
      pendingMedia: this.options.pendingMedia(),
      savedAt: this.now(),
    };
    try {
      await (await this.caches.open(DECKS_CACHE)).put(snapshotKey(this.options.deckId), new Response(JSON.stringify(snapshot), {
        headers: { 'content-type': 'application/json' },
      }));
    } catch {
      // No room for the snapshot: the editor simply will not open offline.
    }
  }

  private async readIndex(): Promise<OfflineIndex> {
    try {
      const found = await (await this.caches.open(DECKS_CACHE)).match(INDEX_KEY);
      const index = found ? await found.json() as OfflineIndex : null;
      return index && typeof index.decks === 'object' ? index : { decks: {} };
    } catch {
      return { decks: {} };
    }
  }

  private async writeIndex(index: OfflineIndex): Promise<void> {
    await (await this.caches.open(DECKS_CACHE)).put(INDEX_KEY, new Response(JSON.stringify(index), {
      headers: { 'content-type': 'application/json' },
    }));
  }

  /** Index writes, one after another: two at once each read the index the other was replacing. */
  private recording: Promise<void> = Promise.resolve();

  private recordDeck(): Promise<void> {
    this.recording = this.recording.then(() => this.recordDeckNow());
    return this.recording;
  }

  /** Record what this deck holds, drop the decks past keeping, delete what nothing holds. */
  private async recordDeckNow(): Promise<void> {
    try {
      const index = await this.readIndex();
      index.decks[this.options.deckId] = { openedAt: this.now(), files: this.plan.map((url) => mediaKey(url)) };
      const decks = Object.entries(index.decks).sort(([, a], [, b]) => b.openedAt - a.openedAt);
      for (const [id] of decks.slice(MAX_DECKS)) delete index.decks[id];
      for (const [id, entry] of decks) {
        if (this.now() - entry.openedAt > MAX_AGE_MS) delete index.decks[id];
      }
      const dropped = decks.map(([id]) => id).filter((id) => !(id in index.decks));
      for (const id of dropped) await (await this.caches.open(DECKS_CACHE)).delete(snapshotKey(id));
      await this.writeIndex(index);
      await this.evict(index);
    } catch {
      // Storage refused: keep going without the bookkeeping.
    }
  }

  /** Delete every kept file no deck in the index holds (a frame cut for a deck goes with that deck). */
  private async evict(index: OfflineIndex): Promise<void> {
    const held = new Set(Object.values(index.decks).flatMap((entry) => entry.files));
    const decks = new Set(Object.keys(index.decks));
    const cache = await this.caches.open(MEDIA_CACHE);
    const removed: string[] = [];
    for (const request of await cache.keys()) {
      const key = mediaKey(request.url);
      if (key.startsWith('/api/video-still')) {
        const deck = new URL(request.url).searchParams.get('deck');
        if (deck === null || decks.has(deck)) continue;
      } else if (held.has(key)) {
        continue;
      }
      await cache.delete(request);
      this.kept?.delete(key);
      removed.push(key);
    }
    if (removed.length > 0) this.options.worker?.()?.postMessage({ type: 'offline-media', removed });
  }
}

/** The server answered a download with something other than the file. */
class ServerRefused extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * `body`, read only while `paused` says go: between chunks, a paused reader
 * waits on `resume`, and TCP's own flow control stops the server sending.
 */
function pausable(
  body: ReadableStream<Uint8Array>,
  paused: () => boolean,
  resume: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (paused()) await resume();
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
