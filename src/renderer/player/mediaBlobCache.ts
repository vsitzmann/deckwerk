/**
 * Whole media files held in memory for a browser presentation, handed to
 * `<video>` and `<img>` elements as `blob:` URLs.
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
 * A file read from a blob never goes back to the network: no range requests,
 * no revalidation, no stalls, and loops and revisits cost nothing, whatever
 * the browser. Pictures are held the same way, for the same reason: a talk's
 * photos are downloaded once, and from then on presenting, moving about and
 * coming back asks the server nothing (Oct 2026: a photo the editor already
 * had took 4 s to show, because its `no-cache` revalidation waited behind a
 * clip's download on the same connection).
 *
 * The cache downloads in the order the Player asks for (the slide on screen
 * and the slides about to be shown first), and the two kinds share the link
 * unequally on purpose:
 *
 * - **pictures** are small next to clips and are what a slide is missing
 *   when it appears, so up to four download at once, held or not;
 * - **clips** download one at a time, and only once every picture ranked
 *   above them is in memory. A clip already downloading when a picture
 *   ranked above it goes missing (the talk moved on) steps aside: the
 *   transfer is stopped, what arrived is kept, and it resumes from there
 *   with a range request once the pictures have landed.
 *
 * Files the Player marks `urgent` (what the slide on screen waits for) go
 * first, ignore `hold`, and are never set aside. The cache stays under a byte
 * budget by dropping the files the talk is furthest from. A file it cannot
 * hold (too large, or failing to download) is left to the network.
 */

/** Room for a long talk's worth of renditions and photos; the TRI deck needs about a third. */
const DEFAULT_BUDGET_BYTES = 1024 * 1024 * 1024;
/** A file that fails this often streams instead; a single blip should not decide that. */
const FAILURE_LIMIT = 2;
/** Pictures downloading at once: a slide of thirty should not cost thirty round trips in a row. */
const IMAGE_CONCURRENCY = 4;

export interface MediaBlobCacheOptions {
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

export interface WantOptions {
  /** Which of the wanted URLs are pictures (see the class comment); the rest are clips. */
  images?: Iterable<string>;
  /** Start no new clip until the next `want` (see `hold`). */
  hold?: boolean;
}

interface Entry {
  objectUrl: string;
  bytes: number;
}

/** What a clip that stepped aside had downloaded, to resume from. */
interface Received {
  chunks: BlobPart[];
  bytes: number;
  type: string;
  /** The strong ETag the bytes came with: the resumed range must match it (`If-Range`). */
  validator: string;
}

interface Flight {
  url: string;
  image: boolean;
  abort: AbortController;
  /** Callers waiting for this transfer to end (`settled`). */
  waiters: Array<(objectUrl: string | undefined) => void>;
  /** Stopped to let pictures through: keep what arrived. */
  yielded: boolean;
  chunks: BlobPart[];
  received: number;
  type: string;
  validator: string | null;
}

export class MediaBlobCache {
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
  /** The wanted URLs that are pictures. */
  private images = new Set<string>();
  /** What the slide on screen is waiting for: fetched first, never held or set aside. */
  private urgent: string[] = [];
  private held = false;
  private flights = new Map<string, Flight>();
  /** Clips that stepped aside for pictures, by URL. */
  private partial = new Map<string, Received>();
  /** Callers of `whenHeld`, by URL. */
  private landing = new Map<string, Array<(objectUrl: string | undefined) => void>>();
  private failures = new Map<string, number>();
  /** Files that did not fit the budget for the current order; retried when it changes. */
  private noRoom = new Set<string>();
  /** Files over `maxFileBytes`: they stream for good. */
  private tooLarge = new Set<string>();
  private readyListeners = new Set<(url: string) => void>();
  private givenUpListeners = new Set<(url: string) => void>();
  private inUse: (objectUrl: string) => boolean = () => false;
  private disposed = false;

  constructor(options: MediaBlobCacheOptions = {}) {
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

  /**
   * Whether every file wanted is in memory: from here on the talk needs
   * nothing from the network, and survives losing it.
   */
  holdsAll(): boolean {
    return this.order.every((url) => this.entries.has(url) || this.borrowed(url) !== undefined);
  }

  /** Whether this wanted file is a picture (see `want`). */
  isImage(url: string): boolean {
    return this.images.has(url);
  }

  /** Whether this file is being downloaded right now. */
  fetching(url: string): boolean {
    return this.flights.has(url);
  }

  /**
   * Whether this file is being downloaded, or was partly downloaded and set
   * aside for pictures: either way, opening it from the network now would
   * send its bytes a second time.
   */
  onItsWay(url: string): boolean {
    return this.flights.has(url) || this.partial.has(url);
  }

  /**
   * Resolves once the download of `url` now running has ended: with its
   * `blob:` URL if the file landed in memory, `undefined` if it did not
   * (failed, abandoned, or too large to hold). With no download of `url`
   * running it resolves at once, the same way.
   *
   * Two transfers of one file at once is the case the HTTP cache handles
   * worst: Chromium lets a range request (the media stack's `bytes=0-`) wait
   * only 25 ms for the transfer already writing the entry, then sends it to
   * the network past the cache, and the whole file crosses the wire a second
   * time.
   */
  settled(url: string): Promise<string | undefined> {
    const flight = this.flights.get(url);
    if (!flight) return Promise.resolve(this.objectUrl(url));
    return new Promise((resolve) => flight.waiters.push(resolve));
  }

  /**
   * Resolves with the file's `blob:` URL once it is in memory, or `undefined`
   * once a download of it failed or the cache will not hold it: given up,
   * no room, no longer wanted.
   * Unlike `settled`, it waits through the downloads ahead of it and through
   * a clip setting itself aside. An element whose file is coming waits here
   * rather than opening the URL itself.
   */
  whenHeld(url: string): Promise<string | undefined> {
    const held = this.objectUrl(url);
    if (held !== undefined || this.disposed || !this.covers(url) || !this.wanted(url)) return Promise.resolve(held);
    return new Promise((resolve) => this.landing.set(url, [...this.landing.get(url) ?? [], resolve]));
  }

  /**
   * Set what to hold, most urgent first, and resume downloading. A transfer
   * for a file no longer wanted at all is abandoned.
   */
  want(urls: string[], options: WantOptions = {}): void {
    if (this.disposed) return;
    this.order = [...new Set(urls)];
    const wanted = new Set(this.order);
    this.images = new Set([...options.images ?? []].filter((url) => wanted.has(url)));
    this.urgent = this.urgent.filter((url) => wanted.has(url));
    this.held = options.hold ?? false;
    this.noRoom.clear();
    for (const flight of [...this.flights.values()]) {
      if (wanted.has(flight.url)) continue;
      this.flights.delete(flight.url);
      flight.abort.abort();
    }
    for (const url of [...this.partial.keys()]) if (!wanted.has(url)) this.partial.delete(url);
    for (const url of [...this.landing.keys()]) if (!wanted.has(url)) this.resolveLanding(url, undefined);
    this.rebalance();
    this.pump();
  }

  /**
   * Mark what the slide on screen is waiting for, replacing the last such
   * list: fetched before everything else, whatever `hold` says, and never set
   * aside for anything. URLs not wanted are ignored.
   */
  prioritize(urls: string[]): void {
    if (this.disposed) return;
    this.urgent = [...new Set(urls)].filter((url) => this.wanted(url));
    this.rebalance();
    this.pump();
  }

  /**
   * Start no new clip until the next `want`. The Player holds while a slide's
   * own videos are still loading, so the cache never competes with what the
   * audience is waiting for; the transfer already running finishes. Pictures
   * and urgent files are not held: they are what a slide shows.
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
    for (const flight of this.flights.values()) flight.abort.abort();
    this.flights.clear();
    this.partial.clear();
    for (const url of [...this.landing.keys()]) this.resolveLanding(url, undefined);
    for (const entry of this.entries.values()) this.revokeObjectUrl(entry.objectUrl);
    this.entries.clear();
    this.bytes = 0;
    this.readyListeners.clear();
    this.givenUpListeners.clear();
  }

  /** Whether any download is running. */
  get transferring(): boolean {
    return this.flights.size > 0;
  }

  /** Bytes currently held (exposed for tests). */
  get heldBytes(): number {
    return this.bytes;
  }

  private wanted(url: string): boolean {
    return this.order.includes(url);
  }

  /** Wanted files, most urgent first. */
  private ranked(): string[] {
    return [...new Set([...this.urgent, ...this.order])];
  }

  /** Not in memory, and the cache still means to hold it. */
  private missing(url: string): boolean {
    return !this.entries.has(url) && this.borrowed(url) === undefined && this.covers(url);
  }

  private pump(): void {
    if (this.disposed) return;
    let images = [...this.flights.values()].filter((flight) => flight.image).length;
    let clip = [...this.flights.values()].some((flight) => !flight.image);
    // A picture ranked above a clip, not in memory yet: the clip waits for it.
    let pictureAhead = false;
    for (const url of this.ranked()) {
      if (!this.missing(url)) continue;
      const image = this.images.has(url);
      if (this.flights.has(url)) {
        if (image) pictureAhead = true;
        continue;
      }
      if (image) {
        pictureAhead = true;
        if (images < IMAGE_CONCURRENCY) {
          images += 1;
          void this.download(url, true);
        }
        continue;
      }
      if (clip) continue;
      if (!this.urgent.includes(url) && (this.held || pictureAhead)) continue;
      clip = true;
      void this.download(url, false);
    }
  }

  /**
   * Stop the clip downloading if something ranked above it is missing: a
   * picture, or a clip the slide on screen waits for. What it received is
   * kept, and it resumes from there in its turn.
   */
  private rebalance(): void {
    const clip = [...this.flights.values()].find((flight) => !flight.image);
    if (!clip || this.urgent.includes(clip.url) || clip.waiters.length > 0) return;
    const ranked = this.ranked();
    const rank = ranked.indexOf(clip.url);
    const blocked = ranked.slice(0, rank < 0 ? ranked.length : rank).some((url) => this.missing(url)
      && (this.images.has(url) || this.urgent.includes(url)));
    if (!blocked) return;
    clip.yielded = true;
    this.flights.delete(clip.url);
    clip.abort.abort();
  }

  private async download(url: string, image: boolean): Promise<void> {
    const flight: Flight = {
      url, image, abort: new AbortController(), waiters: [], yielded: false, chunks: [], received: 0, type: '', validator: null,
    };
    this.flights.set(url, flight);
    const resume = this.partial.get(url);
    this.partial.delete(url);
    const current = () => this.flights.get(url) === flight;
    try {
      const response = await this.fetchFile(url, {
        signal: flight.abort.signal,
        ...(resume ? { headers: { range: `bytes=${resume.bytes}-`, 'if-range': resume.validator } } : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let total: number | null = null;
      const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (resume && response.status === 206) {
        if (!range || Number(range[1]) !== resume.bytes) throw new Error('the server resumed somewhere else');
        flight.chunks = resume.chunks;
        flight.received = resume.bytes;
        flight.type = resume.type;
        flight.validator = resume.validator;
        total = Number(range[2]);
      } else {
        // A full answer: the file changed since, or the server would not resume.
        flight.type = response.headers.get('content-type') ?? '';
        flight.validator = strongValidator(response.headers.get('etag'));
        const declared = Number(response.headers.get('content-length'));
        total = declared > 0 ? declared : null;
      }
      // Decide on the declared size before spending the bandwidth.
      if (total !== null && total > this.maxFileBytes) {
        flight.abort.abort();
        this.tooLarge.add(url);
        this.gaveUp(url);
        return;
      }
      if (total !== null && !this.makeRoom(url, total)) {
        flight.abort.abort();
        this.noRoom.add(url);
        return;
      }
      await readBody(response, flight);
      if (!current()) return;
      const blob = new Blob(flight.chunks, flight.type ? { type: flight.type } : {});
      flight.chunks = [];
      if (!this.makeRoom(url, blob.size)) {
        this.noRoom.add(url);
        return;
      }
      const objectUrl = this.createObjectUrl(blob);
      this.flights.delete(url);
      this.entries.set(url, { objectUrl, bytes: blob.size });
      this.bytes += blob.size;
      this.failures.delete(url);
      this.resolveLanding(url, objectUrl);
      for (const listener of [...this.readyListeners]) listener(url);
    } catch {
      if (flight.yielded) {
        // Set aside for pictures: resume from what arrived, if the server can
        // promise the rest belongs to the same bytes.
        if (flight.validator && flight.received > 0 && !this.disposed && this.wanted(url)) {
          this.partial.set(url, { chunks: flight.chunks, bytes: flight.received, type: flight.type, validator: flight.validator });
        }
      } else if (current() && !flight.abort.signal.aborted) {
        // An abort is a change of plan, not a failure of the file.
        const failures = (this.failures.get(url) ?? 0) + 1;
        this.failures.set(url, failures);
        if (failures >= FAILURE_LIMIT) this.gaveUp(url);
        // Whoever waits for it goes to the network now rather than through
        // another attempt: a slide on screen must not wait out a bad link twice.
        this.resolveLanding(url, undefined);
      }
    } finally {
      for (const resolve of flight.waiters) resolve(this.objectUrl(url));
      if (current()) this.flights.delete(url);
      if (!this.entries.has(url) && !this.covers(url)) this.resolveLanding(url, undefined);
      if (!this.disposed) {
        this.rebalance();
        this.pump();
      }
    }
  }

  private resolveLanding(url: string, objectUrl: string | undefined): void {
    const waiting = this.landing.get(url);
    if (!waiting) return;
    this.landing.delete(url);
    for (const resolve of waiting) resolve(objectUrl);
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

/** An ETag a byte range can be matched against: a weak one promises nothing about bytes. */
function strongValidator(etag: string | null): string | null {
  return etag && !etag.startsWith('W/') ? etag : null;
}

/** Read a response into the flight chunk by chunk, so a transfer stopped part-way keeps what arrived. */
async function readBody(response: Response, flight: Flight): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    flight.chunks.push(blob);
    flight.received += blob.size;
    return;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    flight.chunks.push(value);
    flight.received += value.byteLength;
  }
}
