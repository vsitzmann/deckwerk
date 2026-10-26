/**
 * Whole video files held in memory for a browser presentation, handed to
 * `<video>` elements as `blob:` URLs.
 *
 * Everything else in docs/media-loading.md assumes the browser's media stack
 * reuses bytes it already has: content-hashed assets are served immutable,
 * the lookahead warms the HTTP cache, decoded elements are pooled across
 * slides. Chromium does reuse them. Safari does not: its media loader reads a
 * clip in range requests of its own and keeps nothing for the next element,
 * so every visit to a slide downloaded that slide's clips again from byte
 * zero. The server's asset log of the Oct 2026 TRI site visit shows it: a
 * slide with four clips (31 MB) was fetched again on every pass, over a link
 * that delivered about 7 MB/s, and its clips spun, then showed without
 * playing, until the presenter stepped back and forward again.
 *
 * A clip read from a blob never goes back to the network: no range requests,
 * no stalls, and loops and revisits cost nothing, whatever the browser. The
 * cache downloads one file at a time, whole, in the order the Player asks for
 * (the slides about to be shown first), and stays under a byte budget by
 * dropping the files the talk is furthest from. A file it cannot hold (too
 * large, or failing to download) is left to stream the old way.
 */

/** Room for a long talk's worth of renditions; the TRI deck needs about a third. */
const DEFAULT_BUDGET_BYTES = 1024 * 1024 * 1024;
/** A file that fails this often streams instead; a single blip should not decide that. */
const FAILURE_LIMIT = 2;

export interface VideoBlobCacheOptions {
  budgetBytes?: number;
  /**
   * Files declared larger than this are never held, however much room there
   * is: they stream. The editor sets it, because there a clip only has to show
   * a paused frame until somebody plays it.
   */
  maxFileBytes?: number;
  /**
   * Another cache's `blob:` URLs this one may hand out as its own (the
   * editor's, to the presentation it embeds). A file found there is never
   * downloaded here.
   */
  borrow?: (url: string) => string | undefined;
  fetch?: typeof fetch;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

interface Entry {
  objectUrl: string;
  bytes: number;
}

interface Flight {
  url: string;
  abort: AbortController;
  /** Callers waiting for this transfer to end (`settled`). */
  waiters: Array<(objectUrl: string | undefined) => void>;
}

export class VideoBlobCache {
  private readonly budget: number;
  private readonly maxFileBytes: number;
  private readonly borrow: (url: string) => string | undefined;
  private readonly fetchFile: typeof fetch;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;

  /** Network URL → the blob holding that file. */
  private entries = new Map<string, Entry>();
  private bytes = 0;
  /** Network URLs in the order they are wanted, most urgent first. */
  private order: string[] = [];
  private held = false;
  private inFlight: Flight | null = null;
  private failures = new Map<string, number>();
  /** Files that did not fit the budget for the current order; retried when it changes. */
  private noRoom = new Set<string>();
  /** Files over `maxFileBytes`: they stream for good. */
  private tooLarge = new Set<string>();
  private readyListeners = new Set<(url: string) => void>();
  private givenUpListeners = new Set<(url: string) => void>();
  private inUse: (objectUrl: string) => boolean = () => false;
  private disposed = false;

  constructor(options: VideoBlobCacheOptions = {}) {
    this.budget = options.budgetBytes ?? DEFAULT_BUDGET_BYTES;
    this.maxFileBytes = options.maxFileBytes ?? Number.POSITIVE_INFINITY;
    this.borrow = options.borrow ?? (() => undefined);
    this.fetchFile = options.fetch ?? ((input, init) => fetch(input, init));
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  /** The `blob:` URL standing in for this network URL, once its file is in memory. */
  objectUrl(url: string): string | undefined {
    return this.entries.get(url)?.objectUrl ?? this.borrowed(url);
  }

  /**
   * Whether this file is, or is on its way to being, served from memory. A
   * file the cache has given up on is the caller's to fetch.
   */
  covers(url: string): boolean {
    return this.entries.has(url) || this.borrowed(url) !== undefined
      || ((this.failures.get(url) ?? 0) < FAILURE_LIMIT && !this.noRoom.has(url) && !this.tooLarge.has(url));
  }

  /** Whether this file is being downloaded right now. */
  fetching(url: string): boolean {
    return this.inFlight?.url === url;
  }

  /**
   * Resolves once the download of `url` now running has ended: with its
   * `blob:` URL if the file landed in memory, `undefined` if it did not
   * (failed, abandoned, or too large to hold). With no download of `url`
   * running it resolves at once, the same way.
   *
   * A `<video>` that wants a file this cache is downloading waits here rather
   * than opening the URL itself. Two transfers of one file at once is the
   * case the HTTP cache handles worst: Chromium lets a range request (the
   * media stack's `bytes=0-`) wait only 25 ms for the transfer already
   * writing the entry, then sends it to the network past the cache, and the
   * whole file crosses the wire a second time.
   */
  settled(url: string): Promise<string | undefined> {
    const flight = this.inFlight;
    if (flight?.url !== url) return Promise.resolve(this.objectUrl(url));
    return new Promise((resolve) => flight.waiters.push(resolve));
  }

  /**
   * Set what to hold, most urgent first, and resume downloading. A transfer
   * for a file no longer wanted at all is abandoned.
   */
  want(urls: string[]): void {
    if (this.disposed) return;
    this.order = [...new Set(urls)];
    this.held = false;
    this.noRoom.clear();
    const flight = this.inFlight;
    if (flight && !this.order.includes(flight.url)) {
      this.inFlight = null;
      flight.abort.abort();
    }
    this.pump();
  }

  /**
   * Start no new transfer until the next `want`. The Player holds while a
   * slide's own videos are still loading, so the cache never competes with
   * what the audience is waiting for; the transfer already running finishes.
   */
  hold(): void {
    this.held = true;
  }

  /** Called with the network URL of each file as it lands in memory. */
  onReady(listener: (url: string) => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  /**
   * Called with the network URL of a file the cache stopped trying to hold
   * (too large, or failing), so whoever waited for it can stream it instead.
   */
  onGiveUp(listener: (url: string) => void): () => void {
    this.givenUpListeners.add(listener);
    return () => this.givenUpListeners.delete(listener);
  }

  /**
   * Tell the cache which `blob:` URLs an element still reads. Those are never
   * evicted: revoking a URL under a pooled or playing element would break it.
   */
  setInUse(inUse: ((objectUrl: string) => boolean) | null): void {
    this.inUse = inUse ?? (() => false);
  }

  dispose(): void {
    this.disposed = true;
    this.inFlight?.abort.abort();
    this.inFlight = null;
    for (const entry of this.entries.values()) this.revokeObjectUrl(entry.objectUrl);
    this.entries.clear();
    this.bytes = 0;
    this.readyListeners.clear();
    this.givenUpListeners.clear();
  }

  /** Bytes currently held (exposed for tests). */
  get heldBytes(): number {
    return this.bytes;
  }

  private pump(): void {
    if (this.disposed || this.held || this.inFlight) return;
    const next = this.order.find((url) => !this.entries.has(url) && this.borrowed(url) === undefined && this.covers(url));
    if (next !== undefined) void this.download(next);
  }

  private async download(url: string): Promise<void> {
    const flight: Flight = { url, abort: new AbortController(), waiters: [] };
    this.inFlight = flight;
    try {
      const response = await this.fetchFile(url, { signal: flight.abort.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      // Decide on the declared size before spending the bandwidth.
      const declared = Number(response.headers.get('content-length'));
      if (declared > this.maxFileBytes) {
        flight.abort.abort();
        this.tooLarge.add(url);
        this.gaveUp(url);
        return;
      }
      if (declared > 0 && !this.makeRoom(url, declared)) {
        flight.abort.abort();
        this.noRoom.add(url);
        return;
      }
      const blob = await response.blob();
      if (this.inFlight !== flight) return;
      if (!this.makeRoom(url, blob.size)) {
        this.noRoom.add(url);
        return;
      }
      this.entries.set(url, { objectUrl: this.createObjectUrl(blob), bytes: blob.size });
      this.bytes += blob.size;
      this.failures.delete(url);
      for (const listener of [...this.readyListeners]) listener(url);
    } catch {
      // An abort is a change of plan, not a failure of the file.
      if (this.inFlight === flight && !flight.abort.signal.aborted) {
        const failures = (this.failures.get(url) ?? 0) + 1;
        this.failures.set(url, failures);
        if (failures >= FAILURE_LIMIT) this.gaveUp(url);
      }
    } finally {
      for (const resolve of flight.waiters) resolve(this.objectUrl(url));
      if (this.inFlight === flight) {
        this.inFlight = null;
        this.pump();
      }
    }
  }

  private borrowed(url: string): string | undefined {
    try {
      return this.borrow(url);
    } catch {
      // The lender's page went away.
      return undefined;
    }
  }

  private gaveUp(url: string): void {
    for (const listener of [...this.givenUpListeners]) listener(url);
  }

  /**
   * Evict files ranked below `url` until `bytes` more fit. Never evicts a
   * file wanted sooner, nor one an element still reads.
   */
  private makeRoom(url: string, bytes: number): boolean {
    if (bytes > this.budget) return false;
    if (this.bytes + bytes <= this.budget) return true;
    const rank = (candidate: string): number => {
      const index = this.order.indexOf(candidate);
      return index < 0 ? Number.POSITIVE_INFINITY : index;
    };
    const own = rank(url);
    const victims = [...this.entries.entries()]
      .filter(([candidate, entry]) => rank(candidate) > own && !this.inUse(entry.objectUrl))
      .sort(([a], [b]) => rank(b) - rank(a));
    for (const [candidate, entry] of victims) {
      if (this.bytes + bytes <= this.budget) break;
      this.entries.delete(candidate);
      this.bytes -= entry.bytes;
      this.revokeObjectUrl(entry.objectUrl);
    }
    return this.bytes + bytes <= this.budget;
  }
}
