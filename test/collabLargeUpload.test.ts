import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { emptyDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { getFfmpegPath } from '../src/main/ffmpeg.js';

/**
 * Regression: large video uploads to the headless server failed ("upload
 * failed") and never played. The deckwerk-collab systemd unit filters
 * `@privileged` syscalls; importAsset copied the upload with fs.copyFile,
 * whose libuv implementation calls fchown(2), and the filter killed the
 * server with SIGSYS mid-request. The server here runs under that same
 * filter (via `systemd-run --user`) so any such syscall fails the test.
 */
const REPO = resolve(import.meta.dirname, '..');
const DECK_ID = 'big-video';
const PAD_BYTES = 700 * 1024 * 1024;
// Mirrors /etc/systemd/system/deckwerk-collab.service.
const PRODUCTION_SANDBOX = [
  '-p', 'NoNewPrivileges=yes',
  '-p', 'SystemCallArchitectures=native',
  '-p', 'SystemCallFilter=@system-service',
  '-p', 'SystemCallFilter=~@privileged @resources @mount @reboot @swap @debug @module @obsolete @raw-io @cpu-emulation',
];

/**
 * Whether this machine can run a sandboxed transient unit. CI runners have no
 * user systemd session; there the server runs unsandboxed, which still covers
 * the upload and playback path but not the syscall filter itself.
 */
function canSandbox(): boolean {
  try {
    execFileSync('systemd-run', ['--user', '--wait', '--quiet', '--collect', ...PRODUCTION_SANDBOX, 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolvePort(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

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
  let server: ChildProcess;
  let port: number;
  let clip: Buffer;
  let stderr = '';

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

    port = await freePort();
    const command = [
      join(REPO, 'node_modules/.bin/vite-node'),
      '--config', 'vitest.config.ts', 'scripts/collab-server.mts', '--', rootDir,
      '--host', '127.0.0.1', '--port', String(port), '--no-local-agents',
    ];
    server = canSandbox()
      ? spawn('systemd-run', [
        '--user', '--pipe', '--wait', '--quiet', '--collect',
        `--working-directory=${REPO}`, `--setenv=PATH=${process.env.PATH}`,
        ...PRODUCTION_SANDBOX, ...command,
      ])
      : spawn(command[0], command.slice(1), { cwd: REPO });
    server.stderr?.on('data', (chunk) => { stderr += chunk; });
    await new Promise<void>((resolveReady, reject) => {
      server.stdout?.on('data', (chunk) => { if (String(chunk).includes('"serving"')) resolveReady(); });
      server.once('exit', (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
    });
  }, 120_000);

  afterAll(async () => {
    server?.kill();
    await rm(rootDir, { recursive: true, force: true });
  });

  it('imports a 700 MB video under the production seccomp filter and serves it for playback', async () => {
    const { body, size } = largeMp4Body(clip);
    const response = await fetch(
      `http://127.0.0.1:${port}/api/upload?deck=${DECK_ID}&name=recording.mp4`,
      { method: 'POST', body: Readable.toWeb(body) as ReadableStream, duplex: 'half' } as RequestInit,
    ).catch((error: unknown) => {
      throw new Error(`upload failed (${String(error)}); server stderr:\n${stderr.slice(-2000)}`);
    });
    expect(response.status).toBe(200);
    const imported = await response.json() as { src: string; kind: string };
    expect(imported.kind).toBe('video');
    expect((await stat(join(rootDir, DECK_ID, imported.src))).size).toBe(size);

    // Playback: the browser fetches a video by ranges.
    const ranged = await fetch(`http://127.0.0.1:${port}/decks/${DECK_ID}/${imported.src}`, {
      headers: { range: `bytes=0-${clip.length - 1}` },
    });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(clip);
    expect(server.exitCode).toBeNull();
  }, 300_000);
});
