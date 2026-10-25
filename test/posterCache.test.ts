import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));

import { extractPosterFrame, extractStillFrame, probeMedia, run, getFfprobePath } from '../src/main/ffmpeg.js';
import { posterFor, printStillFor, setPosterCacheDirForTests } from '../src/main/posterCache.js';

/**
 * Poster frames cut in the main process, against real ffmpeg: a JPEG comes
 * out, the same frame is not cut twice, and a changed clip gets a new one.
 */

const FIXTURE = join(__dirname, '..', 'decks', 'demo-deck', 'assets', 'testclip.mp4');
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'posters-'));
  setPosterCacheDirForTests(join(root, 'cache'));
});

afterAll(async () => {
  setPosterCacheDirForTests(null);
  if (root) await rm(root, { recursive: true, force: true });
});

describe('poster cache', () => {
  it('cuts one JPEG frame', async () => {
    const out = join(root, 'frame.jpg');
    await extractPosterFrame(FIXTURE, 0.5, out);
    const bytes = await readFile(out);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('serves a cached name, and reuses it for the same clip and time', async () => {
    const first = await posterFor(FIXTURE, 0.03);
    expect(first).toMatch(/^[0-9a-f]{32}\.jpg$/);
    const again = await posterFor(FIXTURE, 0.03);
    expect(again).toBe(first);
    const other = await posterFor(FIXTURE, 1);
    expect(other).not.toBe(first);
    expect((await readdir(join(root, 'cache'))).sort()).toEqual([first, other].sort());
  });

  it('keys on the file identity, so an edited clip gets a fresh frame', async () => {
    const copy = join(root, 'clip.mp4');
    await rm(copy, { force: true });
    await (await import('node:fs/promises')).copyFile(FIXTURE, copy);
    const before = await posterFor(copy, 0.03);
    await utimes(copy, new Date(), new Date(Date.now() + 60_000));
    const after = await posterFor(copy, 0.03);
    expect(after).not.toBe(before);
  });

  it('answers null for a clip that is not there', async () => {
    expect(await posterFor(join(root, 'missing.mp4'), 0)).toBeNull();
  });
});

async function imageSize(path: string): Promise<string> {
  const out = await run(getFfprobePath(), [
    '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', path,
  ]);
  return out.stdout.trim();
}

describe('print stills', () => {
  it('cuts the frame at full resolution, unlike a thumbnail', async () => {
    const info = await probeMedia(FIXTURE);
    const out = join(root, 'still.jpg');
    await extractStillFrame(FIXTURE, 0.5, out);
    expect((await readFile(out)).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(await imageSize(out)).toBe(`${info.width}x${info.height}`);
  });

  it('falls back to the last frame for a time past the end of the clip', async () => {
    // ffmpeg cuts nothing at all for such a seek and still exits 0.
    const out = join(root, 'past-end.jpg');
    await extractStillFrame(FIXTURE, 10_000, out);
    expect((await readFile(out)).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('caches apart from the posters of the same clip and time', async () => {
    const still = await printStillFor(FIXTURE, 0.03);
    expect(still).toMatch(/^[0-9a-f]{32}\.jpg$/);
    expect(still).not.toBe(await posterFor(FIXTURE, 0.03));
    expect(await printStillFor(FIXTURE, 0.03)).toBe(still);
    // Nothing half-written is left behind for the next request to serve.
    expect((await readdir(join(root, 'cache'))).filter((name) => name.includes('partial'))).toEqual([]);
  });
});
