import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { emptyDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { getFfmpegPath } from '../src/main/ffmpeg.js';
import { startCollabServerProcess, type CollabServerProcess } from './support/collabServerProcess.js';

/**
 * Regression: large video uploads to the headless server failed ("upload
 * failed") and never played. The deckwerk-collab systemd unit filters
 * `@privileged` syscalls; importAsset copied the upload with fs.copyFile,
 * whose libuv implementation calls fchown(2), and the filter killed the
 * server with SIGSYS mid-request. The server here runs under that same
 * filter (via `systemd-run --user`) so any such syscall fails the test.
 */
const DECK_ID = 'big-video';
const PAD_BYTES = 700 * 1024 * 1024;

/** A small valid MP4 followed by a 64-bit `free` atom that pads it past PAD_BYTES, generated lazily. */
function largeMp4Body(clip: Buffer): { body: Readable; size: number } {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write('free', 4, 'latin1');
  header.writeBigUInt64BE(BigInt(PAD_BYTES + 16), 8);
  const zeros = Buffer.alloc(4 * 1024 * 1024);
  async function* chunks() {
    yield clip;
    yield header;
    for (let sent = 0; sent < PAD_BYTES; sent += zeros.length) {
      yield zeros.subarray(0, Math.min(zeros.length, PAD_BYTES - sent));
    }
  }
  return { body: Readable.from(chunks()), size: clip.length + 16 + PAD_BYTES };
}

describe('large video upload on the headless server', () => {
  let rootDir: string;
  let server: CollabServerProcess;
  let clip: Buffer;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-large-upload-'));
    await mkdir(join(rootDir, DECK_ID), { recursive: true });
    await saveDeck(join(rootDir, DECK_ID), emptyDeck('Big video'));
    const clipPath = join(rootDir, 'clip.mp4');
    execFileSync(getFfmpegPath(), [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', clipPath,
    ]);
    clip = await readFile(clipPath);

    server = await startCollabServerProcess({ rootDir });
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('imports a 700 MB video under the production seccomp filter and serves it for playback', async () => {
    const { body, size } = largeMp4Body(clip);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/api/upload?deck=${DECK_ID}&name=recording.mp4`,
      { method: 'POST', body: Readable.toWeb(body) as ReadableStream, duplex: 'half' } as RequestInit,
    ).catch((error: unknown) => {
      throw new Error(`upload failed (${String(error)}); server stderr:\n${server.stderr().slice(-2000)}`);
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const imported = await response.json() as { src: string; kind: string };
    expect(imported.kind).toBe('video');
    expect((await stat(join(rootDir, DECK_ID, imported.src))).size).toBe(size);

    // Playback: the browser fetches a video by ranges.
    const ranged = await fetch(`http://127.0.0.1:${server.port}/decks/${DECK_ID}/${imported.src}`, {
      headers: { range: `bytes=0-${clip.length - 1}` },
    });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(clip);
    expect(server.alive(), server.stderr()).toBe(true);
  }, 300_000);
});
