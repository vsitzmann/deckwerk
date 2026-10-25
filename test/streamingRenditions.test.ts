import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  RenditionStore,
  contentKeyOfFile,
  isVideoAsset,
  pruneRenditions,
  renditionPath,
} from '../src/server/streamingRenditions.js';
import { probeMedia } from '../src/main/ffmpeg.js';

/**
 * The wire copy of an oversized clip.
 *
 * The bug this closes (docs/media-loading.md): a real talk's assets are
 * 10–26 Mbit/s screen recordings, tens or hundreds of megabytes each. Over a
 * remote link those cannot arrive in time no matter how early the player asks
 * — measured cold on a 8 Mbit/s link, a 48 MB clip never showed a frame at
 * all, and a 51 MB one took 15 seconds. The server therefore serves a
 * 1080p/CRF-23 rendition instead, and the originals stay on disk for editing
 * and export.
 */

const execFileAsync = promisify(execFile);
const ffmpeg = (() => {
  try {
    return createRequire(import.meta.url)('ffmpeg-static') as string;
  } catch {
    return '';
  }
})();

let work = '';
let cacheDir = '';

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'renditions-'));
  cacheDir = join(work, 'cache');
});

afterEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
  work = '';
});

/** A clip big enough per second to be worth re-encoding, or small enough not to be. */
async function clip(
  name: string,
  args: string[],
  { size = '2560x1440', seconds = 2 } = {},
): Promise<string> {
  const path = join(work, name);
  await execFileAsync(ffmpeg, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`,
    '-t', String(seconds), '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
    ...args, '-movflags', '+faststart', path,
  ]);
  return path;
}

describe.skipIf(!ffmpeg)('streaming renditions', () => {
  it('re-encodes a clip too big to stream, and reports what it saved', async () => {
    const source = await clip('huge.mp4', ['-b:v', '40M']);
    const events: string[] = [];
    const store = new RenditionStore({ cacheDir, onProgress: (e) => events.push(e.status) });

    const rendition = await store.ensure(source);
    expect(rendition, 'an oversized clip must get a rendition').not.toBeNull();
    expect(events).toContain('done');

    const before = await stat(source);
    const after = await stat(rendition!);
    expect(after.size).toBeLessThan(before.size);
    // Capped at 1080p: a presentation that ships 1440p is sending pixels no
    // projector shows.
    const media = await probeMedia(rendition!);
    expect(Math.max(media.width ?? 0, media.height ?? 0)).toBeLessThanOrEqual(1920);
  }, 120_000);

  it('leaves an already streamable clip alone', async () => {
    // Past the size floor (so it is actually considered) but modest in
    // bitrate and already within 1080p.
    const source = await clip('modest.mp4', ['-b:v', '5M'], { size: '1280x720', seconds: 16 });
    const events: string[] = [];
    const store = new RenditionStore({ cacheDir, onProgress: (e) => events.push(e.status) });

    // Re-encoding this would cost quality and save nothing, so the original
    // is what goes over the wire.
    expect(await store.ensure(source)).toBeNull();
    expect(events).toEqual(['skipped']);
  }, 120_000);

  it('shares one transcode between callers that race for it', async () => {
    const source = await clip('raced.mp4', ['-b:v', '40M']);
    const starts: string[] = [];
    const store = new RenditionStore({
      cacheDir,
      onProgress: (e) => { if (e.status === 'started') starts.push(e.source); },
    });

    const [a, b] = await Promise.all([store.ensure(source), store.ensure(source)]);
    expect(a).toBe(b);
    // Two requests for one slide's video must not run ffmpeg twice.
    expect(starts).toHaveLength(1);
  }, 120_000);

  it('keys the cache by content: a copy, however named, shares the encode', async () => {
    const source = await clip('keyed.mp4', ['-b:v', '40M']);
    const starts: string[] = [];
    const store = new RenditionStore({ cacheDir, onProgress: (e) => { if (e.status === 'started') starts.push(e.source); } });
    const rendition = await store.ensure(source);
    expect(rendition).not.toBeNull();

    // A talk starts as a copy of the last one: same bytes, another deck,
    // another name, a later mtime. One encode serves both.
    await mkdir(join(work, 'next-talk'), { recursive: true });
    const copy = join(work, 'next-talk', 'renamed.mp4');
    await copyFile(source, copy);
    const later = new Date(Date.now() + 60_000);
    await utimes(copy, later, later);
    expect(await store.ensure(copy)).toBe(rendition);
    expect(starts).toEqual([source]);
    expect(await contentKeyOfFile(copy)).toBe(await contentKeyOfFile(source));

    // A changed file is a different clip, whatever it is called.
    await appendFile(copy, Buffer.alloc(16));
    expect(await contentKeyOfFile(copy)).not.toBe(await contentKeyOfFile(source));
  }, 120_000);

  it('remembers what an encode concluded across a restart', async () => {
    const big = await clip('kept.mp4', ['-b:v', '40M']);
    const modest = await clip('modest-again.mp4', ['-b:v', '5M'], { size: '1280x720', seconds: 16 });
    const first = new RenditionStore({ cacheDir });
    expect(await first.ensure(big)).not.toBeNull();
    expect(await first.ensure(modest)).toBeNull();

    // A new process: neither clip is probed or encoded again.
    const events: string[] = [];
    const second = new RenditionStore({ cacheDir, onProgress: (e) => events.push(`${e.status} ${e.source}`) });
    expect(await second.ensure(big)).toBe(renditionPath(await contentKeyOfFile(big), cacheDir));
    expect(await second.ensure(modest)).toBeNull();
    expect(events).toEqual([]);
  }, 180_000);

  it('reports a ready rendition synchronously, and a pending one as pending', async () => {
    const source = await clip('ready.mp4', ['-b:v', '40M']);
    const store = new RenditionStore({ cacheDir });
    const before = await stat(source);

    // Serving is a hot path: it never waits, and never starts work itself.
    expect(store.ready(source, before.size, before.mtimeMs)).toBeNull();
    expect(store.pending(source, before.size, before.mtimeMs)).toBe(true);

    await store.ensure(source);
    expect(store.ready(source, before.size, before.mtimeMs)).not.toBeNull();
    expect(store.pending(source, before.size, before.mtimeMs)).toBe(false);

    // Touch the source: the old rendition is no longer this file's.
    const later = new Date(Date.now() + 5_000);
    await utimes(source, later, later);
    const after = await stat(source);
    expect(store.ready(source, after.size, after.mtimeMs)).toBeNull();
  }, 120_000);

  it('ignores a clip too small to be worth re-encoding', async () => {
    // Small assets must cost nothing to decide about: the serving path asks
    // this question on every request, and a deck owns hundreds of them.
    const source = await clip('small.mp4', ['-b:v', '200k', '-vf', 'scale=640:360']);
    const info = await stat(source);
    const store = new RenditionStore({ cacheDir });
    expect(info.size).toBeLessThan(8 * 1024 * 1024);
    expect(store.pending(source, info.size, info.mtimeMs)).toBe(false);
    expect(await store.ensure(source)).toBeNull();
  }, 60_000);

  it('pins a small clip to its exact bytes, so browsers can cache it', async () => {
    // A small clip once had no variant, so its URL pinned a bare `o` and was
    // served `no-cache`; Safari refetched it on every load of a looping slide.
    const source = await clip('small-pin.mp4', ['-b:v', '200k', '-vf', 'scale=640:360']);
    const info = await stat(source);
    const store = new RenditionStore({ cacheDir });
    const variant = store.variant(source, info.size, info.mtimeMs);
    expect(variant).toMatch(/^o[0-9a-f]{24}$/);
    expect(store.pinned(source, info.size, info.mtimeMs, variant!)).toBe(source);
    // An edit changes the key, so a stale pin is served as if unpinned.
    expect(store.pinned(source, info.size + 1, info.mtimeMs, variant!)).toBeNull();
    expect(store.variant('/x/still.png', 10, 0)).toBeNull();
  }, 60_000);

  it('forgets renditions nothing has needed for a season', async () => {
    const source = await clip('aged.mp4', ['-b:v', '40M']);
    const store = new RenditionStore({ cacheDir });
    const rendition = (await store.ensure(source))!;
    expect(rendition).toBeTruthy();

    // Fresh: kept. Every edited or deleted asset would otherwise leave its
    // rendition behind forever.
    expect(await pruneRenditions(cacheDir)).toBe(0);
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await utimes(rendition, old, old);
    expect(await pruneRenditions(cacheDir)).toBe(1);
    expect(existsSync(rendition)).toBe(false);
  }, 120_000);

  it('only claims video files', () => {
    expect(isVideoAsset('/x/a.mov')).toBe(true);
    expect(isVideoAsset('/x/a.MP4')).toBe(true);
    expect(isVideoAsset('/x/a.png')).toBe(false);
  });
});
