import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
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
 * The cache is keyed by the source's identity, so every edited, replaced or
 * deleted asset leaves its rendition behind — on a server that hosts a
 * person's whole talk history, that is unbounded growth for files nobody will
 * ask for again. Losing one that is still wanted costs a background re-encode
 * and nothing else, which is the right side of this trade.
 */
export async function pruneRenditions(
  cacheDir = defaultRenditionCacheDir(),
  maxAgeMs = 90 * 24 * 60 * 60 * 1000,
): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    const path = join(cacheDir, entry);
    try {
      const info = await stat(path);
      if (!info.isFile() || info.mtimeMs >= cutoff) continue;
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

/**
 * The cache path for a source file, keyed by name, size and modification
 * time — deliberately not by the file's full path.
 *
 * Renaming a deck or a folder rewrites every asset path under it, and a deck
 * about to be presented is exactly the one someone just filed somewhere
 * tidier. Keying on the path would throw away an hour of encoding for a
 * rename. Keying on content instead would mean hashing gigabytes on a hot
 * path. Name plus size plus millisecond mtime survives moves and copies,
 * changes whenever the file does, and two distinct clips agreeing on all
 * three is not a thing that happens.
 */
export function renditionPath(absolute: string, size: number, mtimeMs: number, cacheDir: string): string {
  const stem = basename(absolute, extname(absolute)).slice(0, 40).replace(/[^\w.-]+/g, '_');
  return join(cacheDir, `${stem}.${sourceKey(absolute, size, mtimeMs)}.mp4`);
}

function sourceKey(absolute: string, size: number, mtimeMs: number): string {
  return createHash('sha256')
    .update(`${basename(absolute)}\0${size}\0${Math.round(mtimeMs)}`)
    .digest('hex')
    .slice(0, 24);
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
  /** Sources being transcoded right now, and those queued behind them. */
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly queue: Array<() => void> = [];
  private running = 0;
  /** Sources found not to need a rendition, so they are probed once. */
  private readonly passed = new Set<string>();

  constructor(options: RenditionOptions = {}) {
    this.cacheDir = options.cacheDir ?? defaultRenditionCacheDir();
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.onProgress = options.onProgress ?? (() => {});
  }

  /** A ready rendition for this file, or null. Synchronous by design. */
  ready(absolute: string, size: number, mtimeMs: number): string | null {
    if (!isVideoAsset(absolute) || size < MIN_SOURCE_BYTES) return null;
    const path = renditionPath(absolute, size, mtimeMs, this.cacheDir);
    return existsSync(path) ? path : null;
  }

  /**
   * Whether this file is one the store intends to replace. A request for such
   * a file must not be cached immutably by the browser: the rendition may
   * appear at any moment, and a client holding a year-long copy of the
   * original would never ask for it.
   */
  pending(absolute: string, size: number, mtimeMs: number): boolean {
    if (!isVideoAsset(absolute) || size < MIN_SOURCE_BYTES) return false;
    if (this.passed.has(absolute)) return false;
    return !existsSync(renditionPath(absolute, size, mtimeMs, this.cacheDir));
  }

  /**
   * Which bytes this file's URL answers with right now: `o<key>` for the
   * original, `r<key>` for its rendition, null for a file the store never
   * replaces (whose URL is stable anyway).
   *
   * A <video> reads its source in many range requests and never revalidates
   * between them, so the bytes behind one URL must not change under it. When
   * a rendition landed mid-show, a looping clip asked for bytes=0- again, got
   * the rendition's bytes laid out against the original's index, and Chromium
   * failed it with PIPELINE_ERROR_DECODE. Clients pin a variant into the URL
   * (`?v=`) and the server answers that URL with exactly that variant.
   */
  variant(absolute: string, size: number, mtimeMs: number): string | null {
    if (!isVideoAsset(absolute) || size < MIN_SOURCE_BYTES) return null;
    const key = sourceKey(absolute, size, mtimeMs);
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
    if (!isVideoAsset(absolute) || size < MIN_SOURCE_BYTES) return null;
    if (variant.slice(1) !== sourceKey(absolute, size, mtimeMs)) return null;
    if (variant[0] === 'o') return absolute;
    if (variant[0] === 'r') return this.ready(absolute, size, mtimeMs);
    return null;
  }

  /**
   * Produce the rendition if this clip needs one. Safe to call repeatedly and
   * from several requests at once: the work is shared and metered.
   */
  async ensure(absolute: string): Promise<string | null> {
    if (!isVideoAsset(absolute)) return null;
    let info;
    try {
      info = await stat(absolute);
      if (!info.isFile() || info.size < MIN_SOURCE_BYTES) return null;
    } catch {
      return null;
    }
    const target = renditionPath(absolute, info.size, info.mtimeMs, this.cacheDir);
    if (existsSync(target)) return target;
    const existing = this.inFlight.get(target);
    if (existing) return existing;
    const work = this.transcode(absolute, target).finally(() => this.inFlight.delete(target));
    this.inFlight.set(target, work);
    return work;
  }

  /** Queue a deck's clips, in the order a presenter reaches them. */
  warm(sources: string[]): void {
    for (const source of sources) void this.ensure(source).catch(() => null);
  }

  private async transcode(absolute: string, target: string): Promise<string | null> {
    const media = await probeMedia(absolute).catch(() => null);
    if (!media || !media.width || !media.height) {
      this.passed.add(absolute);
      return null;
    }
    const info = await stat(absolute);
    const bitrate = media.duration && media.duration > 0
      ? (info.size * 8) / media.duration
      : 0;
    const longEdge = Math.max(media.width, media.height);
    if (bitrate <= BITRATE_CEILING && longEdge <= LONG_EDGE_CEILING) {
      // Already deliverable. Re-encoding would cost quality and gain nothing.
      this.passed.add(absolute);
      this.onProgress({ source: absolute, status: 'skipped', detail: 'already streamable' });
      return null;
    }

    const scale = longEdge > LONG_EDGE_CEILING ? LONG_EDGE_CEILING / longEdge : 1;
    const width = Math.round(media.width * scale);
    const height = Math.round(media.height * scale);
    await this.slot();
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
        this.passed.add(absolute);
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
      // Serving the original is always a correct fallback.
      this.passed.add(absolute);
      return null;
    } finally {
      this.release();
    }
  }

  /** One transcode at a time by default: a presenter's machine is also a server. */
  private slot(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.running -= 1;
    this.queue.shift()?.();
  }
}
