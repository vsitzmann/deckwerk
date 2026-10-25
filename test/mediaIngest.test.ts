import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type CollabServerOptions, type RunningCollabServer } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import type { RenditionEvent } from '../src/server/streamingRenditions.js';
import { COLLAB_PROTOCOL_VERSION } from '../src/shared/collab.js';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { buildZip } from '../src/shared/zip.js';

/**
 * Every video that reaches the server gets its streaming version once, as it
 * arrives, and keeps it.
 *
 * A browser that opens a deck should find a small streaming version of every
 * big clip already made, not start one: until it exists, everyone who opens
 * the deck streams the original. And in Oct 2026 the hosted server encoded
 * the same 125 MB recording once per copy of a talk, five times. So:
 *
 * - each of the ways a video arrives (a drop or paste into the editor, a
 *   paste from another deck, a Keynote, PowerPoint or deck-archive import, an
 *   agent's mirror upload) starts its encode at once, with nobody opening
 *   the deck or asking for the clip;
 * - videos already on the server are swept once at startup;
 * - one encode serves every copy of the same bytes, and a restart redoes
 *   nothing, whether the encode's result was kept or discarded;
 * - a streaming version is never deleted while some deck still uses it;
 * - a clip somebody asks for while it waits for its encode jumps the queue.
 *
 * Videos embedded in an agent's HTML arrive through the compile, which needs
 * Electron; that case lives in mediaTransferBudgetBrowser.test.ts.
 *
 * Tests marked `it.fails` describe behaviour not built yet, each under a
 * PENDING note naming the change that makes it pass. CI stays green until
 * that change lands; then the test passes, `it.fails` reports it, and the
 * marker comes off.
 */

const execFileAsync = promisify(execFile);
/** How long an encode may take to start after the arrival that should start it. */
const START_MS = 8_000;
/** After the first encode, how long to watch for a redundant second one. */
const SETTLE_MS = 3_000;

const ffmpeg = (() => {
  try {
    return createRequire(import.meta.url)('ffmpeg-static') as string;
  } catch {
    return '';
  }
})();

/* Every process the server starts, so encodes can be counted. */
const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[]; at: number }>);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((command: string, args?: readonly string[], ...rest: unknown[]) => {
      spawned.push({ command, args: [...(args ?? [])], at: Date.now() });
      return (actual.spawn as (...all: unknown[]) => unknown)(command, args, ...rest);
    }) as typeof actual.spawn,
  };
});

/** ffmpeg runs that encoded `source`: video re-encoded, not stream-copied, not a still. */
function encodesOf(source: string): number {
  return spawned.filter(({ command, args }) => {
    if (!/ffmpeg(\.exe)?$/.test(command) || !args.includes(source) || args.includes('-frames:v')) return false;
    const codec = args.indexOf('-c:v');
    return codec >= 0 && args[codec + 1] !== 'copy';
  }).length;
}

/** When `source`'s first encode started, or Infinity. */
function firstEncodeAt(source: string): number {
  const run = spawned.find(({ command, args }) => /ffmpeg(\.exe)?$/.test(command) && args.includes(source) && args.includes('-c:v'));
  return run?.at ?? Infinity;
}

/**
 * Encodes of the clips at `paths`, all together: waits up to START_MS for the
 * first, then SETTLE_MS more for any redundant ones.
 */
async function encodesAfterArrival(...paths: string[]): Promise<number> {
  const total = () => paths.reduce((sum, path) => sum + encodesOf(path), 0);
  const deadline = Date.now() + START_MS;
  while (total() === 0 && Date.now() < deadline) await sleep(100);
  if (total() > 0) await sleep(SETTLE_MS);
  return total();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

let fixtures = '';
/** A screen recording: 12 Mbit/s of a picture that compresses well, over every threshold. */
let recording = '';
/** The same, but no encode can shrink it: its streaming version is discarded. */
let incompressible = '';
/** Small and modest: already its own streaming version. */
let light = '';

beforeAll(async () => {
  if (!ffmpeg) return;
  fixtures = await mkdtemp(join(tmpdir(), 'media-ingest-fixtures-'));
  recording = join(fixtures, 'recording.mp4');
  incompressible = join(fixtures, 'incompressible.mp4');
  light = join(fixtures, 'light.mp4');
  await Promise.all([
    execFileAsync(ffmpeg, [
      '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-t', '8', '-an',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-b:v', '12M', '-minrate', '12M', '-maxrate', '12M', '-bufsize', '12M',
      '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-movflags', '+faststart', recording,
    ]),
    execFileAsync(ffmpeg, [
      '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
      '-vf', 'noise=alls=30:allf=t', '-t', '8', '-an',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-b:v', '10M', '-maxrate', '10M', '-bufsize', '20M',
      '-movflags', '+faststart', incompressible,
    ]),
    execFileAsync(ffmpeg, [
      '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '2', '-an',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-movflags', '+faststart', light,
    ]),
  ]);
}, 120_000);

afterAll(async () => {
  if (fixtures) await rm(fixtures, { recursive: true, force: true });
});

/**
 * A copy of `source` with bytes of its own (a stream copy under a different
 * tag), so a test's encode is not satisfied by another test's: one encode per
 * content is the point of the content-keyed cache.
 */
async function uniqueCopy(source: string, out: string, tag: string): Promise<string> {
  await mkdir(join(out, '..'), { recursive: true });
  await execFileAsync(ffmpeg, [
    '-loglevel', 'error', '-y', '-i', source, '-c', 'copy', '-metadata', `comment=${tag}`,
    '-movflags', '+faststart', out,
  ]);
  return out;
}

function videoElement(id: string, src: string): SlideElement {
  return {
    id, type: 'video', x: 100, y: 100, w: 960, h: 540, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src, fit: 'contain', start: 0, end: null,
    autoplay: false, loop: true, muted: true, controls: false, poster: null, sourceBox: null,
  } as SlideElement;
}

/** A deck with one slide per clip. */
function deckOf(title: string, srcs: string[]): Deck {
  const deck = emptyDeck(title);
  const base = deck.slides[0];
  deck.slides = srcs.map((src, i) => ({ ...base, id: `s${i + 1}`, elements: [videoElement(`v${i + 1}`, src)] }));
  return deck;
}

/* ------------------------------------------------------------------------ */
/* Server                                                                    */
/* ------------------------------------------------------------------------ */

let workDir = '';
let server: RunningCollabServer | null = null;
let base = '';
const sockets: WebSocket[] = [];
const renditions: RenditionEvent[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
  spawned.length = 0;
  renditions.length = 0;
});

async function freshRoot(name: string): Promise<string> {
  workDir = await mkdtemp(join(tmpdir(), `media-ingest-${name}-`));
  const decksRoot = join(workDir, 'decks');
  await mkdir(decksRoot, { recursive: true });
  return decksRoot;
}

async function start(decksRoot: string, extra: Partial<CollabServerOptions> = {}): Promise<void> {
  server = await startCollabServer({
    rootDir: decksRoot,
    host: '127.0.0.1',
    port: 0,
    mediaRenditions: { cacheDir: join(workDir, 'renditions'), onProgress: (event) => renditions.push(event) },
    printStillCacheDir: join(workDir, 'print-stills'),
    ...extra,
  });
  base = `http://127.0.0.1:${server.port}`;
}

async function stop(): Promise<void> {
  for (const socket of sockets.splice(0)) socket.close();
  await server?.close();
  server = null;
}

/** Open a deck the way a browser does, which today is what starts its encodes. */
async function openDeck(deckId: string): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/ws?deck=${encodeURIComponent(deckId)}`);
  sockets.push(socket);
  const welcomed = new Promise<void>((resolve, reject) => {
    socket.on('message', (raw) => {
      if ((JSON.parse(String(raw)) as { kind: string }).kind === 'welcome') resolve();
    });
    socket.once('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name: 'Test' }));
  await welcomed;
}

async function finished(source: string, timeoutMs = 60_000): Promise<RenditionEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ended = renditions.find((e) => e.source === source && e.status !== 'started');
    if (ended) return ended;
    if (Date.now() > deadline) throw new Error(`no encode of ${source} finished`);
    await sleep(100);
  }
}

/** The streaming versions the rendition cache holds, other than encodes in progress. */
async function cachedVersions(): Promise<string[]> {
  try {
    return (await readdir(join(workDir, 'renditions'))).filter((name) => name.endsWith('.mp4') && !name.includes('.tmp')).sort();
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------ */
/* Arrival                                                                   */
/* ------------------------------------------------------------------------ */

describe.skipIf(!ffmpeg)('a video gets its streaming version as it arrives', () => {
  it('dropped, pasted or uploaded into the editor', async () => {
    const decksRoot = await freshRoot('upload');
    await saveDeck(join(decksRoot, 'talk'), emptyDeck('talk'));
    const clip = await uniqueCopy(recording, join(workDir, 'in', 'screen recording.mp4'), 'upload');
    await start(decksRoot);

    const response = await fetch(`${base}/api/upload?deck=talk&name=${encodeURIComponent('screen recording.mp4')}`, {
      method: 'POST', body: await readFile(clip),
    });
    expect(response.status).toBe(200);
    const { src } = await response.json() as { src: string };
    expect(await encodesAfterArrival(join(decksRoot, 'talk', src)), 'encodes of the uploaded clip').toBe(1);
  }, 60_000);

  // The pasted copy is the source's bytes: one encode serves both.
  it('pasted from another deck', async () => {
    const decksRoot = await freshRoot('paste');
    const sourceClip = await uniqueCopy(recording, join(decksRoot, 'source', 'assets', 'clip-77.mp4'), 'paste');
    await saveDeck(join(decksRoot, 'source'), deckOf('source', ['assets/clip-77.mp4']));
    await saveDeck(join(decksRoot, 'talk'), emptyDeck('talk'));
    await start(decksRoot);

    const response = await fetch(`${base}/api/import-url?deck=talk`, {
      method: 'POST',
      body: JSON.stringify({ url: `${base}/decks/source/assets/clip-77.mp4`, deckAsset: true }),
    });
    expect(response.status).toBe(200);
    const { src } = await response.json() as { src: string };
    expect(await encodesAfterArrival(sourceClip, join(decksRoot, 'talk', src)), 'encodes of the clip, both copies').toBe(1);
  }, 60_000);

  for (const format of ['Keynote', 'PowerPoint'] as const) {
    it(`imported from ${format}`, async () => {
      const decksRoot = await freshRoot(format.toLowerCase());
      const clip = await uniqueCopy(recording, join(workDir, 'in', 'movie.mp4'), format);
      const importer = async (_source: string, outDir: string) => {
        await mkdir(join(outDir, 'assets'), { recursive: true });
        await copyFile(clip, join(outDir, 'assets', 'movie-12.mp4'));
        await saveDeck(outDir, deckOf('imported', ['assets/movie-12.mp4']));
        return { slides: 1 };
      };
      await start(decksRoot, format === 'Keynote' ? { keynoteImporter: importer } : { pptxImporter: importer });

      const route = format === 'Keynote' ? 'import-keynote' : 'import-pptx';
      const response = await fetch(`${base}/api/${route}?name=imported`, { method: 'POST', body: 'not a real archive' });
      expect(response.status).toBe(200);
      expect(await encodesAfterArrival(join(decksRoot, 'imported', 'assets', 'movie-12.mp4')), 'encodes of the imported clip').toBe(1);
    }, 60_000);
  }

  it('unpacked from a deck archive', async () => {
    const decksRoot = await freshRoot('archive');
    const clip = await uniqueCopy(recording, join(workDir, 'in', 'movie.mp4'), 'archive');
    await start(decksRoot);

    const archive = buildZip([
      { name: 'deck.json', data: new TextEncoder().encode(JSON.stringify(deckOf('archived', ['assets/movie-12.mp4']))) },
      { name: 'assets/movie-12.mp4', data: new Uint8Array(await readFile(clip)) },
    ]);
    const response = await fetch(`${base}/api/import-deck?name=archived`, { method: 'POST', body: archive });
    expect(response.status).toBe(200);
    expect(await encodesAfterArrival(join(decksRoot, 'archived', 'assets', 'movie-12.mp4')), 'encodes of the archived clip').toBe(1);
  }, 60_000);

  it("uploaded by an agent's mirror", async () => {
    const decksRoot = await freshRoot('mirror');
    await saveDeck(join(decksRoot, 'talk'), emptyDeck('talk'));
    const clip = await uniqueCopy(recording, join(workDir, 'in', 'movie.mp4'), 'mirror');
    await start(decksRoot, { localAgents: new LocalAgentRegistry({ name: 'Agent' }) });

    const response = await fetch(`${base}/api/agent-mirror/file?deck=talk&path=assets/agent-movie.mp4`, {
      method: 'PUT', headers: { 'x-deckwerk-bridge': '1' }, body: await readFile(clip),
    });
    expect(response.status).toBe(200);
    expect(await encodesAfterArrival(join(decksRoot, 'talk', 'assets', 'agent-movie.mp4')), 'encodes of the mirrored clip').toBe(1);
  }, 60_000);

  it('leaves a light clip alone: it is its own streaming version', async () => {
    const decksRoot = await freshRoot('light');
    await saveDeck(join(decksRoot, 'talk'), emptyDeck('talk'));
    await start(decksRoot);

    const response = await fetch(`${base}/api/upload?deck=talk&name=small.mp4`, { method: 'POST', body: await readFile(light) });
    expect(response.status).toBe(200);
    const { src } = await response.json() as { src: string };
    await sleep(SETTLE_MS);
    expect(encodesOf(join(decksRoot, 'talk', src)), 'encodes of a light clip').toBe(0);
  }, 60_000);
});

/* ------------------------------------------------------------------------ */
/* Videos already on the server                                              */
/* ------------------------------------------------------------------------ */

describe.skipIf(!ffmpeg)('videos already on the server', () => {
  it('are prepared at startup, before anyone opens their deck', async () => {
    const decksRoot = await freshRoot('sweep');
    const clip = await uniqueCopy(recording, join(decksRoot, 'old-talk', 'assets', 'recording-5.mp4'), 'sweep');
    await saveDeck(join(decksRoot, 'old-talk'), deckOf('old-talk', ['assets/recording-5.mp4']));
    await start(decksRoot);

    expect(await encodesAfterArrival(clip), 'encodes of a clip on disk at startup').toBe(1);
  }, 60_000);

  it('are encoded once, however many decks hold a copy', async () => {
    const decksRoot = await freshRoot('copies');
    const first = await uniqueCopy(recording, join(decksRoot, 'talk-2025', 'assets', 'recording-9.mp4'), 'copies');
    const second = join(decksRoot, 'talk-2026', 'assets', 'recording-9.mp4');
    await mkdir(join(second, '..'), { recursive: true });
    await copyFile(first, second);
    // Copied later, as copying a deck does.
    const later = new Date(Date.now() + 60_000);
    await utimes(second, later, later);
    for (const id of ['talk-2025', 'talk-2026']) await saveDeck(join(decksRoot, id), deckOf(id, ['assets/recording-9.mp4']));
    await start(decksRoot);
    await openDeck('talk-2025');
    await openDeck('talk-2026');

    expect(await encodesAfterArrival(first, second), 'encodes of one clip in two decks').toBe(1);
  }, 60_000);

  it('are not encoded again after a restart once their streaming version was kept', async () => {
    const decksRoot = await freshRoot('restart-kept');
    const clip = await uniqueCopy(recording, join(decksRoot, 'talk', 'assets', 'recording-3.mp4'), 'kept');
    await saveDeck(join(decksRoot, 'talk'), deckOf('talk', ['assets/recording-3.mp4']));
    await start(decksRoot);
    await openDeck('talk');
    expect((await finished(clip)).status, 'fixture: the recording encodes smaller').toBe('done');
    await stop();

    spawned.length = 0;
    await start(decksRoot);
    await openDeck('talk');
    await sleep(SETTLE_MS);
    expect(encodesOf(clip), 'encodes after a restart').toBe(0);
  }, 90_000);

  it('are not encoded again after a restart once their streaming version was discarded', async () => {
    const decksRoot = await freshRoot('restart-discarded');
    const clip = await uniqueCopy(incompressible, join(decksRoot, 'talk', 'assets', 'noise-4.mp4'), 'discarded');
    await saveDeck(join(decksRoot, 'talk'), deckOf('talk', ['assets/noise-4.mp4']));
    await start(decksRoot);
    await openDeck('talk');
    expect((await finished(clip)).status, 'fixture: the noise clip encodes no smaller').toBe('skipped');
    await stop();

    spawned.length = 0;
    await start(decksRoot);
    await openDeck('talk');
    await sleep(SETTLE_MS);
    expect(encodesOf(clip), 'encodes after a restart').toBe(0);
  }, 90_000);

  it('keep their streaming version however long it goes unused', async () => {
    const decksRoot = await freshRoot('keep');
    const clip = await uniqueCopy(recording, join(decksRoot, 'talk', 'assets', 'recording-6.mp4'), 'keep');
    await saveDeck(join(decksRoot, 'talk'), deckOf('talk', ['assets/recording-6.mp4']));
    await start(decksRoot);
    await openDeck('talk');
    expect((await finished(clip)).status).toBe('done');
    await stop();
    const versions = await cachedVersions();
    expect(versions.length, 'fixture: one streaming version on disk').toBe(1);
    // A year unused.
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    for (const name of versions) await utimes(join(workDir, 'renditions', name), old, old);

    spawned.length = 0;
    await start(decksRoot);
    await sleep(SETTLE_MS);
    expect(await cachedVersions(), 'the streaming version of a clip a deck still shows').toEqual(versions);
    expect(encodesOf(clip), 'encodes after the restart').toBe(0);
  }, 90_000);

  it('drop a streaming version once no deck uses its clip', async () => {
    const decksRoot = await freshRoot('orphan');
    const clip = await uniqueCopy(recording, join(decksRoot, 'talk', 'assets', 'recording-7.mp4'), 'orphan');
    await saveDeck(join(decksRoot, 'talk'), deckOf('talk', ['assets/recording-7.mp4']));
    await start(decksRoot);
    await openDeck('talk');
    expect((await finished(clip)).status).toBe('done');
    await stop();
    const versions = await cachedVersions();
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    for (const name of versions) await utimes(join(workDir, 'renditions', name), old, old);
    // The deck is gone, and its clip with it.
    await rm(join(decksRoot, 'talk'), { recursive: true, force: true });

    await start(decksRoot);
    const deadline = Date.now() + START_MS;
    while ((await cachedVersions()).length > 0 && Date.now() < deadline) await sleep(100);
    expect(await cachedVersions(), 'versions of clips no deck holds').toEqual([]);
  }, 90_000);
});

/* ------------------------------------------------------------------------ */
/* The queue                                                                 */
/* ------------------------------------------------------------------------ */

describe.skipIf(!ffmpeg)('the encode queue', () => {
  it('moves a clip somebody asks for ahead of the clips still waiting', async () => {
    const decksRoot = await freshRoot('queue');
    const names = [1, 2, 3, 4].map((n) => `assets/recording-q${n}.mp4`);
    const clips = await Promise.all(names.map((name, i) => uniqueCopy(recording, join(decksRoot, 'talk', name), `queue-${i}`)));
    await saveDeck(join(decksRoot, 'talk'), deckOf('talk', names));
    await start(decksRoot);
    await openDeck('talk');
    // A browser playing the last slide's clip while the first is encoding.
    const response = await fetch(`${base}/decks/talk/${names[3]}`, { headers: { range: 'bytes=0-' } });
    await response.body?.cancel();
    for (const clip of clips) await finished(clip, 120_000);

    expect(firstEncodeAt(clips[3]), 'the requested clip started encoding before the one queued ahead of it')
      .toBeLessThan(firstEncodeAt(clips[2]));
  }, 180_000);
});

// Keep the fixture helpers honest: a unique copy really is different bytes.
describe.skipIf(!ffmpeg)('fixtures', () => {
  it('make a copy with bytes of its own', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'media-ingest-fixture-'));
    const a = await uniqueCopy(recording, join(workDir, 'a.mp4'), 'a');
    const b = await uniqueCopy(recording, join(workDir, 'b.mp4'), 'b');
    expect((await readFile(a)).equals(await readFile(b))).toBe(false);
    expect((await stat(a)).size).toBeGreaterThan(8 * 1024 * 1024);
    expect(existsSync(light) && (await stat(light)).size < 8 * 1024 * 1024).toBe(true);
  }, 60_000);
});
