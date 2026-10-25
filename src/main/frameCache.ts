import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Frames cut out of video files by ffmpeg, cached on disk.
 *
 * Shared by the desktop's preview posters (posterCache.ts) and the collab
 * server's print stills. No Electron here, so the server can use it too.
 * Entries are keyed by the file's identity and the requested time, so an
 * edited clip gets a fresh frame.
 */

export interface FrameCacheOptions {
  /** Where frames live; read on every call so tests can redirect it. */
  dir: () => string;
  /** Cut the frame of `input` at `seconds` into `output`. */
  extract: (input: string, seconds: number, output: string) => Promise<void>;
  /** Folded into the key, so caches sharing a folder never collide. */
  variant?: string;
  /** How many extractions run at once. */
  concurrency?: number;
}

export type FrameCache = (absolutePath: string, time: number) => Promise<string | null>;

/**
 * A function answering the cached file name (inside `dir()`) for a clip at a
 * time, cutting it first if needed. Null when the frame cannot be produced.
 */
export function createFrameCache(options: FrameCacheOptions): FrameCache {
  const { dir, extract, variant = '', concurrency = 3 } = options;
  let running = 0;
  const queue: Array<() => void> = [];
  /** One extraction per key, however many elements want it. */
  const inFlight = new Map<string, Promise<string | null>>();

  const acquire = (): Promise<void> => {
    if (running < concurrency) {
      running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(() => {
      running += 1;
      resolve();
    }));
  };
  const release = (): void => {
    running -= 1;
    queue.shift()?.();
  };

  return async (absolutePath, time) => {
    let info;
    try {
      info = await stat(absolutePath);
    } catch {
      return null;
    }
    const seconds = Number.isFinite(time) && time >= 0 ? time : 0;
    const key = createHash('sha256')
      .update(`${variant}${absolutePath}|${info.size}|${Math.round(info.mtimeMs)}|${seconds.toFixed(3)}`)
      .digest('hex')
      .slice(0, 32);
    const name = `${key}.jpg`;
    const output = join(dir(), name);
    if (existsSync(output)) return name;

    const pending = inFlight.get(name);
    if (pending) return pending;
    const job = (async () => {
      await acquire();
      try {
        if (existsSync(output)) return name;
        await mkdir(dir(), { recursive: true });
        // Cut beside the final name and move it in whole: the existence
        // check above must never hand out a file ffmpeg is still writing.
        const partial = join(dir(), `${key}.partial-${process.pid}.jpg`);
        try {
          await extract(absolutePath, seconds, partial);
          await rename(partial, output);
        } finally {
          await rm(partial, { force: true });
        }
        return name;
      } catch (error) {
        console.error(`Could not extract a frame from ${absolutePath}:`, error);
        return null;
      } finally {
        release();
        inFlight.delete(name);
      }
    })();
    inFlight.set(name, job);
    return job;
  };
}
