import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { probeMedia, transcodeVideoForWeb } from '../main/ffmpeg.js';

/**
 * Streaming renditions: the copy of a video that actually goes over the wire.
 *
 * A deck's assets are whatever the author had — a 2600x1522 screen recording
 * at 26 Mbit/s, a 118 MB export. That is the right thing to keep on disk and
 * the wrong thing to hand a browser on the other end of a network. No amount
 * of preloading fixes it: at those bitrates the file cannot even arrive in
 * real time over a normal link, so a slide opens on a black box and then
 * stalls mid-clip. This is the same conclusion every hosted deck reached —
 * Google Slides will not play an arbitrary uploaded file at all; a Drive video
 * plays a transcoded rendition and makes you wait for it to exist first.
 *
 * So: one H.264 rendition per source, capped at 1080p, CRF 23, faststart,
 * written once into a cache outside the deck folder (nothing here ever
 * appears in the author's assets/, an export, or a deck archive). The asset
 * route serves it in place of the original; the original stays authoritative
 * for editing and export, where quality — not latency — is the point.
 *
 * Only clips that need it are touched: a file already small and modest in
 * bitrate is served as-is rather than re-encoded into something slightly
 * worse for nothing.
 *
 * Everything is keyed by content (see `ContentKeys`): a talk starts as a copy
 * of the last one, and in Oct 2026 one 125 MB recording sat in five decks and
 * was encoded once per copy. One encode, one rendition and one URL now serve
 * every copy of the same bytes, and what an encode concluded (a rendition, or
 * that none is worth having) survives a restart.
 */

/** Above this, a clip cannot be delivered comfortably over a remote link. */
const BITRATE_CEILING = 6_000_000;
/** Above this long edge, a presentation is carrying pixels no projector shows. */
const LONG_EDGE_CEILING = 1920;
/** Renditions below this are suspicious — a transcode that produced nothing. */
const MIN_PLAUSIBLE_BYTES = 1024;
/**
 * Below this, a clip is not worth a rendition whatever its bitrate: the whole
 * file is a couple of seconds of transfer, which the player's lookahead
 * already covers. The floor is also what keeps the store from probing every
 * small asset a deck owns — a decision that has to be free, because serving
 * makes it on every request.
 */
const MIN_SOURCE_BYTES = 8 * 1024 * 1024;

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.qt', '.avi']);

export interface RenditionOptions {
  /** Where renditions are cached. Defaults to the per-user cache directory. */
  cacheDir?: string;
  /** How many transcodes may run at once. One keeps a talk's CPU free. */
  concurrency?: number;
  /** Called as work starts and finishes, for the server's console. */
  onProgress?: (event: RenditionEvent) => void;
}

export interface RenditionEvent {
  source: string;
  status: 'started' | 'done' | 'skipped' | 'failed';
  /** Bytes saved, on 'done'. */
  savedBytes?: number;
  detail?: string;
}

/**
 * Forget renditions nothing has needed for a season.
 *
 * The cache is keyed by content, so every edited, replaced or deleted asset
 * leaves its rendition behind — on a server that hosts a person's whole talk
 * history, that is unbounded growth for files nobody will ask for again.
 *
 * Given `inUse` (the content keys some deck still holds), a rendition or
 * `.passed` marker of content in use is kept however long it went unasked
 * for: a talk not opened for a year is still a talk, and its clips must not
 * stream as originals the day it is given again. What no deck holds goes
 * after `maxAgeMs` (a deck in the trash may come back), and files from the
 * cache's old naming go at once: nothing reads them any more.
 */
export async function pruneRenditions(
  cacheDir = defaultRenditionCacheDir(),
  maxAgeMs = 90 * 24 * 60 * 60 * 1000,
  options: { inUse?: Set<string> } = {},
): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (entry === KEY_INDEX) continue;
    const path = join(cacheDir, entry);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      if (options.inUse) {
        const keyed = /^([0-9a-f]{24})\.(?:mp4|passed)$/.exec(entry);
        // An encode still writing is left alone; one a crash abandoned is not.
        if (entry.includes('.tmp')) {
          if (info.mtimeMs >= dayAgo) continue;
        } else if (keyed) {
          if (options.inUse.has(keyed[1]) || info.mtimeMs >= cutoff) continue;
        }
      } else if (info.mtimeMs >= cutoff) {
        continue;
      }
      await rm(path, { force: true });
      removed += 1;
    } catch {
      // A rendition that vanished under us needs no help vanishing.
    }
  }
  return removed;
}

export function defaultRenditionCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'deckwerk', 'renditions');
}

/** The rendition of the content `key` names. */
export function renditionPath(key: string, cacheDir: string): string {
  return join(cacheDir, `${key}.mp4`);
}

/** Left beside the renditions when an encode concluded none is worth having. */
function passedPath(key: string, cacheDir: string): string {
  return join(cacheDir, `${key}.passed`);
}

/** The content keys the store has learned, kept with its renditions. */
const KEY_INDEX = 'content-keys.json';
const KEY_PATTERN = /^[0-9a-f]{24}$/;

/** A file's content key: the start of the SHA-256 of its bytes. */
export async function contentKeyOfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex').slice(0, 24);
}

function contentKeyOfFileSync(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 24);
}

/**
 * Which content each file holds, learned once and remembered.
 *
 * The serving path asks on every request and must not wait, so hashing never
 * happens there: a file is hashed when it is learned (it arrives, its deck
 * opens, the startup sweep reaches it) and the answer is kept under the
 * file's name, size and millisecond mtime. That identity survives a renamed
 * deck or folder, so a move costs nothing; a copy has a new mtime and is
 * hashed once, which is exactly how it is found to be the same clip. The
 * index lives beside the renditions, so a restart re-reads it rather than
 * re-hashing a server's worth of video.
 *
 * Small clips are the exception: under MIN_SOURCE_BYTES a hash costs a few
 * milliseconds, so an unknown one is hashed on the spot.
 */
class ContentKeys {
  private readonly byIdentity = new Map<string, string>();
  private readonly byPath = new Map<string, string>();
  private readonly hashing = new Map<string, Promise<string>>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly cacheDir: string) {
    try {
      const stored = JSON.parse(readFileSync(join(cacheDir, KEY_INDEX), 'utf8')) as Record<string, string>;
      for (const [identity, key] of Object.entries(stored)) {
        if (KEY_PATTERN.test(key)) this.byIdentity.set(identity, key);
      }
    } catch {
      // No index yet, or an unreadable one: files are hashed as they are learned.
    }
  }

  private static identity(absolute: string, size: number, mtimeMs: number): string {
    return `${basename(absolute)}\0${size}\0${Math.round(mtimeMs)}`;
  }

  /** The key of a file as it is now, if known. Never reads the file, except a small one. */
  known(absolute: string, size: number, mtimeMs: number): string | null {
    const identity = ContentKeys.identity(absolute, size, mtimeMs);
    let key = this.byIdentity.get(identity);
    if (!key && size < MIN_SOURCE_BYTES) {
      try {
        // Only for the file as the caller describes it: a stale size or mtime
        // is a file that has changed since, with a key nobody knows yet.
        const info = statSync(absolute);
        if (info.size !== size || Math.round(info.mtimeMs) !== Math.round(mtimeMs)) return null;
        key = contentKeyOfFileSync(absolute);
      } catch {
        return null;
      }
      this.remember(identity, key);
    }
    if (key) this.byPath.set(absolute, key);
    return key ?? null;
  }

  /** The key of a file, hashing it if it is new. */
  async learn(absolute: string): Promise<string | null> {
    let info;
    try {
      info = await stat(absolute);
      if (!info.isFile()) return null;
    } catch {
      return null;
    }
    const identity = ContentKeys.identity(absolute, info.size, info.mtimeMs);
    let key = this.byIdentity.get(identity);
    if (!key) {
      let work = this.hashing.get(identity);
      if (!work) {
        work = contentKeyOfFile(absolute).finally(() => this.hashing.delete(identity));
        this.hashing.set(identity, work);
      }
      try {
        key = await work;
      } catch {
        return null;
      }
      this.remember(identity, key);
    }
    this.byPath.set(absolute, key);
    return key;
  }

  /** The key a file was last known by, whatever its state now. */
  ofPath(absolute: string): string | null {
    return this.byPath.get(absolute) ?? null;
  }

  /** Files known to hold `key` as they are now. */
  pathsFor(key: string): string[] {
    const paths: string[] = [];
    for (const [path, known] of this.byPath) {
      if (known !== key) continue;
      try {
        const info = statSync(path);
        if (this.byIdentity.get(ContentKeys.identity(path, info.size, info.mtimeMs)) === key) paths.push(path);
      } catch {
        // Gone or moved: no longer a home for this content.
      }
    }
    return paths;
  }

  private remember(identity: string, key: string): void {
    if (this.byIdentity.get(identity) === key) return;
    this.byIdentity.set(identity, key);
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save().catch(() => null);
    }, 1_000);
    this.saveTimer.unref?.();
  }

  private async save(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const temporary = join(this.cacheDir, `${KEY_INDEX}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.byIdentity)));
    await rename(temporary, join(this.cacheDir, KEY_INDEX));
  }
}

export function isVideoAsset(absolute: string): boolean {
  return VIDEO_EXTENSIONS.has(extname(absolute).toLowerCase());
}

/**
 * The rendition a request should be served, or null to serve the original.
 *
 * Never waits and never starts work: serving is a hot path, and a slide that
 * has to wait for a transcode is worse than one that streams the original.
 */
export class RenditionStore {
  private readonly cacheDir: string;
  private readonly concurrency: number;
  private readonly onProgress: (event: RenditionEvent) => void;
  private readonly keys: ContentKeys;
  /** Content being transcoded right now, and content queued behind it, by key. */
  private readonly inFlight = new Map<string, Promise<string | null>>();
  /** Work waiting for a slot, in the order it was admitted. */
  private readonly waiting: Array<{ key: string; urgency: number; start: () => void }> = [];
  private running = 0;
  /** Stamps urgent requests, so the latest one goes first. */
  private urgency = 0;
  private stopped = false;
  /** Content found not to need a rendition, so it is probed once. */
  private readonly passed = new Set<string>();

  constructor(options: RenditionOptions = {}) {
    this.cacheDir = options.cacheDir ?? defaultRenditionCacheDir();
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.onProgress = options.onProgress ?? (() => {});
    this.keys = new ContentKeys(this.cacheDir);
  }

  /**
   * Learn the content of these files (hashing the new ones), so the
   * synchronous answers below know them. Call it before handing out
   * variants: a big clip whose content is unknown has none to hand out.
   */
  async learn(paths: string[]): Promise<void> {
    for (const path of paths) if (isVideoAsset(path)) await this.keys.learn(path);
  }

  /** The content key a file was last learned with, or null. */
  keyOf(absolute: string): string | null {
    return this.keys.ofPath(absolute);
  }

  /** A ready rendition for this file, or null. Synchronous by design. */
  ready(absolute: string, size: number, mtimeMs: number): string | null {
    if (!isVideoAsset(absolute) || size < MIN_SOURCE_BYTES) return null;
    const key = this.keys.known(absolute, size, mtimeMs);
    if (!key) return null;
    const path = renditionPath(key, this.cacheDir);
    return existsSync(path) ? path : null;
  }

  /** Whether an encode of this content concluded no rendition is worth having. */
  private hasPassed(key: string): boolean {
    if (this.passed.has(key)) return true;
    if (!existsSync(passedPath(key, this.cacheDir))) return false;
    this.passed.add(key);
    return true;
  }

  private async markPassed(key: string): Promise<void> {
    this.passed.add(key);
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(passedPath(key, this.cacheDir), '');
    } catch {
      // Remembered for this run at least.
    }
  }

  /**
   * Whether this file is one the store intends to replace. A request for such
   * a file must not be cached immutably by the browser: the rendition may
   * appear at any moment, and a client holding a year-long copy of the
   * original would never ask for it.
   */
  pending(absolute: string, size: number, mtimeMs: number): boolean {
    if (!isVideoAsset(absolute) || size < MIN_SOURCE_BYTES) return false;
    const key = this.keys.known(absolute, size, mtimeMs);
    // Not even hashed yet: as far as anyone knows, a rendition is coming.
    if (!key) return true;
    if (this.hasPassed(key)) return false;
    return !existsSync(renditionPath(key, this.cacheDir));
  }

  /**
   * Which bytes this file's URL answers with right now: `o<key>` for the
   * original, `r<key>` for its rendition, null for a file that is not a video.
   *
   * A <video> reads its source in many range requests and never revalidates
   * between them, so the bytes behind one URL must not change under it. When
   * a rendition landed mid-show, a looping clip asked for bytes=0- again, got
   * the rendition's bytes laid out against the original's index, and Chromium
   * failed it with PIPELINE_ERROR_DECODE. Clients pin a variant into the URL
   * (`?v=`) and the server answers that URL with exactly that variant.
   *
   * A clip too small for a rendition still gets a keyed `o`. Without one its
   * client pinned a bare `o`, which is served `no-cache`, and Safari answers
   * `no-cache` on media by downloading the file again on every load: in Oct
   * 2026 one open deck of looping 1–8 MB clips held the server's uplink at
   * ~10 MB/s. A keyed pin names exact bytes, so it is cached for good.
   */
  variant(absolute: string, size: number, mtimeMs: number): string | null {
    if (!isVideoAsset(absolute)) return null;
    const key = this.keys.known(absolute, size, mtimeMs);
    if (!key) return null;
    return `${this.ready(absolute, size, mtimeMs) ? 'r' : 'o'}${key}`;
  }

  /**
   * The file a pinned `?v=` URL names, or null when the pin no longer
   * describes this source (it was edited) and the request should be served
   * as if unpinned. A bare `o` is a client that has not been told this clip's
   * variant yet (it was just uploaded): it gets the original, never a
   * rendition that might land between two of its range requests.
   */
  pinned(absolute: string, size: number, mtimeMs: number, variant: string): string | null {
    if (variant === 'o') return absolute;
    if (!isVideoAsset(absolute)) return null;
    if (variant.slice(1) !== this.keys.known(absolute, size, mtimeMs)) return null;
    if (variant[0] === 'o') return absolute;
    if (variant[0] === 'r') return this.ready(absolute, size, mtimeMs);
    return null;
  }

  /**
   * The file a content-addressed variant (`o<key>` or `r<key>`) names, for
   * the route that serves one URL to every deck holding the same bytes, and
   * the deck files it was found in (for access checks). Null when this
   * server holds no such content any more.
   */
  contentFile(variant: string): { file: string; sources: string[] } | null {
    const key = variant.slice(1);
    if (!KEY_PATTERN.test(key)) return null;
    const sources = this.keys.pathsFor(key);
    if (variant[0] === 'r') {
      const file = renditionPath(key, this.cacheDir);
      return existsSync(file) && sources.length > 0 ? { file, sources } : null;
    }
    if (variant[0] === 'o') return sources.length > 0 ? { file: sources[0], sources } : null;
    return null;
  }

  /**
   * Produce the rendition if this clip needs one. Safe to call repeatedly and
   * from several requests at once: the work is shared and metered.
   *
   * `urgent` is a clip somebody is asking for right now (it is on screen, or
   * someone pressed play): it goes ahead of everything still waiting, so
   * nobody waits behind the other 29 clips of a fresh import.
   */
  async ensure(absolute: string, options: { urgent?: boolean } = {}): Promise<string | null> {
    return (await this.admit(absolute, options.urgent ?? false)).work;
  }

  /**
   * Queue a deck's clips in the order a presenter reaches them. Each is
   * admitted in turn, so the queue keeps slide order whichever file hashes
   * or stats first.
   */
  warm(sources: string[]): Promise<void> {
    return (async () => {
      for (const source of sources) await this.admit(source, false).catch(() => null);
    })();
  }

  /** Start nothing new: the server is closing. What is running finishes. */
  stop(): void {
    this.stopped = true;
    this.waiting.length = 0;
  }

  /**
   * Find this clip's place: done already, nothing to do, or work in the queue.
   * Resolves once the clip is admitted, with the work's promise wrapped so
   * that awaiting the admission does not await the encode.
   */
  private async admit(absolute: string, urgent: boolean): Promise<{ work: Promise<string | null> | string | null }> {
    if (!isVideoAsset(absolute)) return { work: null };
    let info;
    try {
      info = await stat(absolute);
      if (!info.isFile() || info.size < MIN_SOURCE_BYTES) return { work: null };
    } catch {
      return { work: null };
    }
    const key = await this.keys.learn(absolute);
    if (!key) return { work: null };
    const target = renditionPath(key, this.cacheDir);
    if (existsSync(target)) return { work: target };
    if (this.hasPassed(key)) return { work: null };
    // One encode per content, however many decks hold a copy.
    const existing = this.inFlight.get(key);
    if (existing) {
      if (urgent) this.hurry(key);
      return { work: existing };
    }
    const work = this.queued(key, urgent, () => this.transcode(absolute, key, target))
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return { work };
  }

  /**
   * Run `job` when a slot is free: one at a time by default, since a
   * presenter's machine is also a server. The probe that decides whether a
   * clip needs encoding runs inside the slot too; outside it, probes racing
   * each other decided the queue's order.
   */
  private queued<T>(key: string, urgent: boolean, job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        key,
        urgency: urgent ? ++this.urgency : 0,
        start: () => {
          this.running += 1;
          job().then(resolve, reject).finally(() => {
            this.running -= 1;
            this.next();
          });
        },
      });
      this.next();
    });
  }

  private next(): void {
    while (!this.stopped && this.running < this.concurrency && this.waiting.length > 0) {
      let index = 0;
      this.waiting.forEach((entry, i) => {
        if (entry.urgency > this.waiting[index].urgency) index = i;
      });
      const [entry] = this.waiting.splice(index, 1);
      entry.start();
    }
  }

  /** A clip somebody asks for while it waits: it goes next. */
  private hurry(key: string): void {
    const entry = this.waiting.find((candidate) => candidate.key === key);
    if (entry) entry.urgency = ++this.urgency;
  }

  private async transcode(absolute: string, key: string, target: string): Promise<string | null> {
    const media = await probeMedia(absolute).catch(() => null);
    if (!media || !media.width || !media.height) {
      // Not something ffprobe can read now; worth another look after a restart.
      this.passed.add(key);
      return null;
    }
    const info = await stat(absolute);
    const bitrate = media.duration && media.duration > 0
      ? (info.size * 8) / media.duration
      : 0;
    const longEdge = Math.max(media.width, media.height);
    if (bitrate <= BITRATE_CEILING && longEdge <= LONG_EDGE_CEILING) {
      // Already deliverable. Re-encoding would cost quality and gain nothing.
      await this.markPassed(key);
      this.onProgress({ source: absolute, status: 'skipped', detail: 'already streamable' });
      return null;
    }

    const scale = longEdge > LONG_EDGE_CEILING ? LONG_EDGE_CEILING / longEdge : 1;
    const width = Math.round(media.width * scale);
    const height = Math.round(media.height * scale);
    this.onProgress({ source: absolute, status: 'started' });
    // A partially written file must never be discoverable as a rendition:
    // write beside the target and rename, which is atomic on every platform
    // this runs on.
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp.mp4`;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await transcodeVideoForWeb(absolute, temporary, {
        codec: 'h264',
        crf: 23,
        speed: 'veryfast',
        audioBitrate: '128k',
        width,
        height,
      });
      const produced = await stat(temporary);
      if (produced.size < MIN_PLAUSIBLE_BYTES || produced.size >= info.size) {
        // Bigger than the source (a already-efficient clip we misjudged):
        // keeping it would make the talk slower, not faster.
        await rm(temporary, { force: true });
        await this.markPassed(key);
        this.onProgress({ source: absolute, status: 'skipped', detail: 'no smaller than the source' });
        return null;
      }
      await rename(temporary, target);
      this.onProgress({
        source: absolute,
        status: 'done',
        savedBytes: info.size - produced.size,
      });
      return target;
    } catch (error) {
      await rm(temporary, { force: true });
      this.onProgress({
        source: absolute,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      });
      // Serving the original is always a correct fallback. A failure may be
      // the server shutting down mid-encode, so it is not remembered past
      // this run.
      this.passed.add(key);
      return null;
    }
  }
}
