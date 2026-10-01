import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import WebSocket from 'ws';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, withMediaExtension, type RunningCollabServer } from '../src/server/collabServer.js';
import { renditionPath } from '../src/server/streamingRenditions.js';
import { COLLAB_PROTOCOL_VERSION, ServerMessageSchema, type ServerMessage } from '../src/shared/collab.js';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { mediaFileName } from '../src/shared/media.js';
import { pinMediaVariant, setMediaVariants } from '../src/renderer/collab/mediaVariants.js';

/**
 * How the collab server gets media and decks to a browser on the far end of
 * a tailnet link: quickly, and without swapping bytes under a playing video.
 *
 * Each case here was a failure seen presenting and editing through the
 * headless server from a laptop (Chromium and Safari):
 * - a <video> playing an oversized clip died with PIPELINE_ERROR_DECODE when
 *   the clip's streaming rendition landed mid-show;
 * - the first slide waited on an uncompressed megabyte-plus welcome and an
 *   uncompressed client bundle;
 * - an image dragged from another DeckWerk tab, or from a CDN whose URLs
 *   have no extension, left an "Upload failed" frame;
 * - the server had never built the web-export player, so export said
 *   "Export player bundle not found".
 */

const execFileAsync = promisify(execFile);
const ffmpeg = (() => {
  try {
    return createRequire(import.meta.url)('ffmpeg-static') as string;
  } catch {
    return '';
  }
})();

const DECK_ID = 'talk';

function video(id: string, src: string) {
  return { id, type: 'video', x: 0, y: 0, w: 960, h: 540, src, autoplay: true, loop: true, muted: true };
}

function welcomeOf(port: number, deckId = DECK_ID, options: WebSocket.ClientOptions = {}) {
  return new Promise<{ socket: WebSocket; welcome: Extract<ServerMessage, { kind: 'welcome' }>; next: (kind: string) => Promise<ServerMessage> }>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${encodeURIComponent(deckId)}`, options);
    const queue: ServerMessage[] = [];
    const waiters: Array<{ kind: string; resolve: (m: ServerMessage) => void }> = [];
    socket.on('open', () => socket.send(JSON.stringify({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name: 'Test' })));
    socket.on('message', (raw) => {
      const message = ServerMessageSchema.parse(JSON.parse(String(raw)));
      if (message.kind === 'welcome') {
        resolve({
          socket,
          welcome: message,
          next: (kind) => new Promise((done) => {
            const queued = queue.findIndex((m) => m.kind === kind);
            if (queued !== -1) done(queue.splice(queued, 1)[0]);
            else waiters.push({ kind, resolve: done });
          }),
        });
        return;
      }
      const waiter = waiters.findIndex((w) => w.kind === message.kind);
      if (waiter !== -1) waiters.splice(waiter, 1)[0].resolve(message);
      else queue.push(message);
    });
    socket.on('error', reject);
    setTimeout(() => reject(new Error('no welcome')), 5000);
  });
}

describe('media delivery from the collab server', () => {
  let rootDir: string;
  let deckDir: string;
  let cacheDir: string;
  let server: RunningCollabServer;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'collab-media-'));
    deckDir = join(rootDir, DECK_ID);
    cacheDir = join(rootDir, 'rendition-cache');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(cacheDir, { recursive: true });
    await writeFile(join(deckDir, 'theme.css'), '/* theme */\n', 'utf8');
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await server?.close();
    await rm(rootDir, { recursive: true, force: true });
  });

  async function start(slides: unknown[]) {
    await saveDeck(deckDir, parseDeck({ ...emptyDeck('Talk'), slides }));
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', mediaRenditions: { cacheDir } });
    return `http://127.0.0.1:${server.port}/decks/${DECK_ID}/assets`;
  }

  it('keeps a pinned video URL on the bytes it started with when the rendition lands', async () => {
    const source = join(deckDir, 'assets', 'recording.mov');
    await writeFile(source, Buffer.alloc(9 * 1024 * 1024, 7));
    const info = await stat(source);
    const base = await start([{ id: 's1', elements: [video('v1', 'assets/recording.mov')] }]);

    // The welcome names the variant a client should pin: the original, for now.
    const { socket, welcome } = await welcomeOf(server.port);
    sockets.push(socket);
    const pin = welcome.mediaVariants?.['assets/recording.mov'];
    expect(pin).toMatch(/^o[0-9a-f]{24}$/);

    const before = await fetch(`${base}/recording.mov?v=${pin}`, { headers: { range: 'bytes=0-' } });
    expect(before.headers.get('content-range')).toBe(`bytes 0-${info.size - 1}/${info.size}`);
    await before.arrayBuffer();

    // The rendition lands while that <video> is still playing.
    await writeFile(renditionPath(source, info.size, info.mtimeMs, cacheDir), 'RENDITION');

    // BUG (fixed): a looping clip re-asked for bytes=0- and got the
    // rendition's bytes under the same URL — PIPELINE_ERROR_DECODE in Chromium.
    const again = await fetch(`${base}/recording.mov?v=${pin}`, { headers: { range: 'bytes=0-' } });
    expect(again.headers.get('content-range')).toBe(`bytes 0-${info.size - 1}/${info.size}`);
    // Its bytes can never change, so a browser may keep them.
    expect(again.headers.get('cache-control')).toContain('immutable');
    await again.arrayBuffer();

    // The next client is told to pin the rendition, and gets it.
    const { socket: later, welcome: laterWelcome } = await welcomeOf(server.port);
    sockets.push(later);
    const rendition = laterWelcome.mediaVariants?.['assets/recording.mov'];
    expect(rendition).toBe(`r${pin!.slice(1)}`);
    expect(await (await fetch(`${base}/recording.mov?v=${rendition}`)).text()).toBe('RENDITION');

    // A clip a client has not been told about yet (just uploaded) pins `o`:
    // the original, revalidated, never the rendition.
    const bare = await fetch(`${base}/recording.mov?v=o`, { headers: { range: 'bytes=0-1' } });
    expect(bare.headers.get('content-range')).toBe(`bytes 0-1/${info.size}`);
    expect(bare.headers.get('cache-control')).toBe('public, no-cache');
  });

  it.skipIf(!ffmpeg)('tells connected clients when a rendition finishes', async () => {
    // 2 s at ~45 Mbit/s and 2560 wide: oversized on both counts.
    const source = join(deckDir, 'assets', 'screen.mp4');
    await execFileAsync(ffmpeg, [
      '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=30,noise=alls=40:allf=t',
      '-t', '2', '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '45M',
      '-maxrate', '45M', '-bufsize', '90M', '-movflags', '+faststart', source,
    ]);
    expect((await stat(source)).size).toBeGreaterThan(8 * 1024 * 1024);
    const base = await start([{ id: 's1', elements: [video('v1', 'assets/screen.mp4')] }]);

    const { socket, welcome, next } = await welcomeOf(server.port);
    sockets.push(socket);
    expect(welcome.mediaVariants?.['assets/screen.mp4']).toMatch(/^o/);
    // Opening the deck queued the transcode; its completion is announced.
    const media = await Promise.race([
      next('media'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no media message')), 60_000)),
    ]) as Extract<ServerMessage, { kind: 'media' }>;
    expect(media.variants['assets/screen.mp4']).toMatch(/^r/);
    const served = await fetch(`${base}/screen.mp4?v=${media.variants['assets/screen.mp4']}`);
    expect(Number(served.headers.get('content-length'))).toBeLessThan((await stat(source)).size);
  }, 90_000);

  it('compresses the welcome and the client bundle for slow links', async () => {
    // A deck the size of a real talk's.
    const slides = Array.from({ length: 150 }, (_, i) => ({
      id: `s${i}`,
      elements: [{ id: `t${i}`, type: 'text', x: 0, y: 0, w: 800, h: 200, html: `<p>${'Video models for embodied intelligence. '.repeat(40)}</p>` }],
    }));
    await start(slides);

    const { socket } = await welcomeOf(server.port, DECK_ID, { perMessageDeflate: true });
    sockets.push(socket);
    // BUG (fixed): no permessage-deflate, so the whole deck crossed the link raw.
    expect(socket.extensions).toContain('permessage-deflate');

    // Static text (the client bundle, HTML shells, SVG and JSON) goes out
    // gzipped through the same file server deck assets use, and unpacks to
    // the same bytes. A diagram's SVG stands in for the bundle here.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="10" height="10" fill="#123456"/>'.repeat(4000)}</svg>`;
    await writeFile(join(deckDir, 'assets', 'diagram.svg'), svg);
    const url = `http://127.0.0.1:${server.port}/decks/${DECK_ID}/assets/diagram.svg`;
    const zipped = await new Promise<{ encoding: string | undefined; body: Buffer }>((resolve, reject) => {
      // fetch() would transparently gunzip; read what actually crossed the wire.
      get(url, { headers: { 'accept-encoding': 'gzip, deflate, br' } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ encoding: res.headers['content-encoding'], body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    // BUG (fixed): nothing the server sent was compressed.
    expect(zipped.encoding).toBe('gzip');
    expect(zipped.body.length).toBeLessThan(svg.length / 10);
    expect(gunzipSync(zipped.body).toString()).toBe(svg);
    // A range request (a <video> or PDF reader) still gets plain bytes.
    const ranged = await fetch(url, { headers: { range: 'bytes=0-3', 'accept-encoding': 'gzip' } });
    expect(await ranged.text()).toBe('<svg');
  });

  it('imports an image dragged out of another deck on this server from disk', async () => {
    await start([{ id: 's1' }]);
    const otherDir = join(rootDir, 'other');
    await mkdir(join(otherDir, 'assets'), { recursive: true });
    await saveDeck(otherDir, parseDeck({ ...emptyDeck('Other'), slides: [{ id: 's1' }] }));
    const png = readFileSync(join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png'));
    await writeFile(join(otherDir, 'assets', 'swatch.png'), png);

    // What a drag out of the other deck's tab carries: this server's own URL.
    // BUG (fixed): the server refused to fetch its own (private) address and
    // the drop became an "Upload failed" frame.
    const url = `http://127.0.0.1:${server.port}/decks/other/assets/swatch.png`;
    const response = await fetch(`http://127.0.0.1:${server.port}/api/import-url?deck=${DECK_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, deckAsset: true }),
    });
    expect(response.status).toBe(200);
    const imported = await response.json() as { src: string; kind: string };
    expect(imported.kind).toBe('image');
    expect((await readFile(join(deckDir, imported.src))).equals(png)).toBe(true);

    // Only files under a deck's assets/ are reachable this way.
    const escape = await fetch(`http://127.0.0.1:${server.port}/api/import-url?deck=${DECK_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${server.port}/decks/other/assets/../deck.json`, deckAsset: true }),
    });
    expect(escape.ok).toBe(false);
  });

  it('does not copy an image out of a deck the user may not see', async () => {
    const ALICE = 'alice@tailnet.example';
    const BOB = 'bob@tailnet.example';
    for (const [id, owner] of [['alices', ALICE], ['bobs', BOB]] as const) {
      const dir = join(rootDir, id);
      await mkdir(join(dir, 'assets'), { recursive: true });
      await saveDeck(dir, parseDeck({ ...emptyDeck(id), slides: [{ id: 's1' }] }));
      await writeFile(join(dir, 'access.json'), JSON.stringify({ owner, visibility: 'private', sharedWith: [] }));
    }
    await writeFile(join(rootDir, 'alices', 'assets', 'secret.png'),
      readFileSync(join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png')));
    server = await startCollabServer({ rootDir, port: 0, host: '127.0.0.1', accessControl: { admin: 'admin@tailnet.example' } });

    const response = await fetch(`http://127.0.0.1:${server.port}/api/import-url?deck=bobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'tailscale-user-login': BOB },
      body: JSON.stringify({ url: `http://127.0.0.1:${server.port}/decks/alices/assets/secret.png`, deckAsset: true }),
    });
    expect(response.status).toBe(403);
  });
});

describe('naming media that arrives without an extension', () => {
  it('names a CDN image by its Content-Type, or by its bytes when that is generic', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    // BUG (fixed): images.unsplash.com/photo-123?w=800 imported as
    // "photo-123" and failed with "Unsupported media type".
    expect(withMediaExtension('photo-1506744038136', 'image/jpeg', jpeg)).toBe('photo-1506744038136.jpg');
    expect(withMediaExtension('images', 'application/octet-stream', jpeg)).toBe('images.jpg');
    expect(withMediaExtension('x', '', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe('x.png');
    expect(withMediaExtension('x', '', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('x.webp');
    expect(withMediaExtension('x', 'image/svg+xml; charset=utf-8', Buffer.from('<svg/>'))).toBe('x.svg');
    expect(withMediaExtension('clip', '', Buffer.from('\0\0\0\x18ftypqt  '))).toBe('clip.mov');
    // A name that already says what it is stays put; non-media stays unnamed.
    expect(withMediaExtension('cat.png', 'image/jpeg', jpeg)).toBe('cat.png');
    expect(withMediaExtension('page', 'text/html', Buffer.from('<html>'))).toBe('page');
  });

  it('names a dropped file by its MIME type when its name does not say', () => {
    // BUG (fixed): these drops were ignored without a word.
    expect(mediaFileName('image', 'image/jpeg')).toBe('image.jpg');
    expect(mediaFileName('photo.jfif', 'image/jpeg')).toBe('photo.jfif');
    expect(mediaFileName('scan.tiff', 'image/tiff')).toBe('scan.tiff');
    expect(mediaFileName('Screen Recording', 'video/quicktime')).toBe('Screen Recording.mov');
    expect(mediaFileName('notes.txt', 'text/plain')).toBeNull();
  });
});

describe('pinning video variants in client URLs', () => {
  it('pins the announced variant, the original for an unannounced video, and nothing for an image', () => {
    setMediaVariants({ 'assets/talk.mov': 'r0123' }, true);
    expect(pinMediaVariant('assets/talk.mov', '/decks/d/assets/talk.mov')).toBe('/decks/d/assets/talk.mov?v=r0123');
    expect(pinMediaVariant('assets/new.mp4', '/decks/d/assets/new.mp4')).toBe('/decks/d/assets/new.mp4?v=o');
    expect(pinMediaVariant('assets/photo.jpg', '/decks/d/assets/photo.jpg')).toBe('/decks/d/assets/photo.jpg');
    setMediaVariants({}, true);
  });
});

describe('the deployed server can export to the web', () => {
  it("builds the export player as part of the collab server's own build", () => {
    // BUG (fixed): the headless server ran build:collab before starting, which
    // never built out/export, so web export answered "Export player bundle not
    // found" on every deploy.
    const scripts = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    const expand = (name: string, seen = new Set<string>()): string[] => {
      if (seen.has(name) || !scripts[name]) return [];
      seen.add(name);
      return [name, ...[...scripts[name].matchAll(/npm run ([\w:-]+)/g)].flatMap((m) => expand(m[1], seen))];
    };
    expect(expand('precollab')).toContain('build:export');
  });
});
