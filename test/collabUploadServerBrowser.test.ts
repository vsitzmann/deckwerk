import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import { startCollabServerProcess, type CollabServerProcess } from './support/collabServerProcess.js';
import { fixture, MEDIA_FIXTURES, writeMediaFixtures } from './support/mediaFixtures.js';
import { PAINT_READER, READ_MEDIA, type Landed, type Painted } from './support/mediaPaint.js';

/**
 * Uploads from a real browser editor to the collab server as production runs
 * it: its own process, under the deckwerk-collab unit's syscall sandbox.
 *
 * `mediaFormatsBrowser.test.ts` proves every format drops and paints against
 * an in-process server. Every upload failure of Sept 2026 was invisible
 * there, because each lived in how the server survives, not in the format:
 *
 * - fs.copyFile calls fchown(2), which the sandbox answers with SIGSYS, so
 *   the server died mid-upload ("upload failed", the media never played);
 * - each such death left a truncated file under the asset's hashed name, and
 *   the importer reused any existing hashed file, so re-uploading the same
 *   picture "succeeded" as a blank rectangle, forever;
 * - screen recordings run to hundreds of megabytes.
 *
 * Each test drives the editor's own drop path and asserts what a person sees:
 * the element resolves to a real asset, the media decodes in the page, and
 * the server is still up afterwards.
 */

const DECK_ID = 'uploads';

/** Every format the importer accepts. */
const MEDIA = MEDIA_FIXTURES.filter((entry) => entry.kind !== null).map((entry) => entry.name);

let workDir = '';
let server: CollabServerProcess | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

function deckDir(): string {
  return join(workDir, 'decks', DECK_ID);
}

/** A fresh deck, the sandboxed server, and a connected editor. `prepare` runs before the server starts. */
async function openEditor(prepare?: () => Promise<void>): Promise<Cdp> {
  workDir = await mkdtemp(join(tmpdir(), 'collab-upload-server-'));
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir(), { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await saveDeck(deckDir(), emptyDeck('Uploads'));
  await writeFile(join(deckDir(), 'theme.css'), '.slide { background: #ffffff; color: #111827; }\n', 'utf8');
  await prepare?.();

  server = await startCollabServerProcess({ rootDir: join(workDir, 'decks'), clientDir: await collabClientDir() });
  browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Uploader`, profileDir);
  const target = await findTarget(
    browser.debugPort,
    (t) => t.url.includes(`deck=${DECK_ID}`) && !t.url.includes('present.html'),
    browser.log,
  );
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  // Dropping before the socket is up queues the insert as an offline change,
  // which is a different path; wait for the connected status.
  await eventually(async () => editor!.evaluate<boolean>(`(() => (
    document.getElementById('status')?.textContent?.includes('connected as Uploader') === true
    && Boolean(document.querySelector('#canvas .slide'))
  ))()`), 'browser editor did not finish connecting');
  return editor;
}

/** Drop files onto the slide through the canvas's real dragover/drop listeners. `files` is page-side JS building `transfer`. */
async function drop(files: string): Promise<void> {
  // Record every upload the server refuses, so a failure ends the test at
  // once with the server's reason instead of as a placeholder that never
  // resolves.
  await editor!.evaluate(`(() => {
    if (window.__uploadFailures) return;
    window.__uploadFailures = [];
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (String(url).startsWith('/api/upload')) this.addEventListener('loadend', () => {
        if (this.status < 200 || this.status >= 300) {
          window.__uploadFailures.push(url + ' -> ' + this.status + ' ' + JSON.stringify(this.response));
        }
      });
      return open.call(this, method, url, ...rest);
    };
  })()`);
  await editor!.evaluate(`(async () => {
    const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    ${files}
    const host = document.getElementById('canvas');
    const box = host.querySelector('.slide').getBoundingClientRect();
    host.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    host.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: transfer,
      clientX: Math.round(box.left + box.width / 2), clientY: Math.round(box.top + box.height / 2),
    }));
  })()`);
}

async function dropFixtures(names: readonly string[]): Promise<Map<string, Buffer>> {
  const sources = await writeMediaFixtures(join(workDir, 'sources'), names);
  const bytes = new Map<string, Buffer>();
  for (const name of names) bytes.set(name, await readFile(sources.get(name)!));
  await drop(names.map((name) => `transfer.items.add(new File([decode(${
    JSON.stringify(bytes.get(name)!.toString('base64'))})], ${JSON.stringify(name)}, { type: ${
    JSON.stringify(fixture(name).mime)} }));`).join('\n'));
  return bytes;
}

/**
 * Wait until `count` media elements hold real asset paths. A refused upload
 * or a dead server ends the wait at once: `eventually` retries through
 * errors, so those are returned as values and thrown afterwards.
 */
async function resolvedMedia(count: number, timeoutMs: number): Promise<Landed[]> {
  const state = await eventually(
    async () => ({
      alive: server!.alive(),
      failures: await editor!.evaluate<string[]>('window.__uploadFailures ?? []'),
      els: await editor!.evaluate<Landed[]>(READ_MEDIA),
    }),
    'dropped media never resolved to asset paths',
    ({ alive, failures, els }) => !alive || failures.length > 0
      || (els.length === count && els.every((el) => !el.src.startsWith('pending:'))),
    timeoutMs,
  );
  if (!state.alive) throw new Error(`collab server died during the upload:\n${server!.stderr().slice(-2000)}`);
  if (state.failures.length) throw new Error(`the server refused uploads:\n${state.failures.join('\n')}`);
  return state.els;
}

async function paintedMedia(els: Landed[], timeoutMs = 60_000): Promise<Painted[]> {
  return eventually(
    async () => editor!.evaluate<Painted[]>(`${PAINT_READER}(${JSON.stringify(els.map((el) => el.id))})`),
    'dropped media did not decode in the page',
    (values) => values.every((value) => value.ok),
    timeoutMs,
  );
}

/** The hash the importer names an asset by. */
function assetHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

describe.skipIf(!electronBinary)('uploads to the sandboxed collab server', () => {
  it('drops every supported format, paints each one, and the server survives', async () => {
    await openEditor();
    await dropFixtures(MEDIA);
    const resolved = await resolvedMedia(MEDIA.length, 180_000);
    for (const [i, name] of MEDIA.entries()) expect(resolved[i].src, `src of ${name}`).toMatch(fixture(name).src!);

    const painted = await paintedMedia(resolved);
    expect(Object.fromEntries(MEDIA.map((name, i) => [name, painted[i].ok]))).toEqual(
      Object.fromEntries(MEDIA.map((name) => [name, true])),
    );
    expect(server!.alive(), `server exited:\n${server!.stderr()}`).toBe(true);

    // The deck on disk holds the uploads, so a reload or a peer sees them.
    const saved = await eventually(
      async () => JSON.parse(await readFile(join(deckDir(), 'deck.json'), 'utf8')) as { slides: { elements: { src?: string }[] }[] },
      'uploads never reached deck.json',
      (deck) => resolved.every((el) => deck.slides[0].elements.some((candidate) => candidate.src === el.src)),
    );
    expect(saved.slides[0].elements.length).toBeGreaterThanOrEqual(MEDIA.length);
  }, 420_000);

  it('repairs truncated leftovers from a crashed upload instead of reusing them', async () => {
    // A crash mid-import leaves the hashed original, or a converted copy,
    // empty under its final name. Plant exactly that, then upload the same
    // files again the way a person retrying would.
    const names = ['swatch.png', 'photo.heic', 'screen.mov'] as const;
    let sources = new Map<string, Buffer>();
    await openEditor(async () => {
      const paths = await writeMediaFixtures(join(workDir, 'planted'), names);
      sources = new Map(await Promise.all(names.map(async (name) => [name, await readFile(paths.get(name)!)] as const)));
      const assets = join(deckDir(), 'assets');
      await mkdir(assets, { recursive: true });
      const hash = (name: string) => assetHash(sources.get(name)!);
      await writeFile(join(assets, `swatch.${hash('swatch.png')}.png`), '');
      await writeFile(join(assets, `photo.${hash('photo.heic')}.heic`), sources.get('photo.heic')!.subarray(0, 100));
      await writeFile(join(assets, `photo.${hash('photo.heic')}.png`), '');
      await writeFile(join(assets, `screen.${hash('screen.mov')}.h264.mp4`), '');
    });

    await dropFixtures(names);
    const resolved = await resolvedMedia(names.length, 120_000);
    const painted = await paintedMedia(resolved);
    expect(Object.fromEntries(names.map((name, i) => [name, painted[i].ok]))).toEqual(
      Object.fromEntries(names.map((name) => [name, true])),
    );
    // The original is whole again, byte for byte.
    const png = await readFile(join(deckDir(), resolved[0].src));
    expect(png.equals(sources.get('swatch.png')!)).toBe(true);
    for (const el of resolved) expect((await stat(join(deckDir(), el.src))).size, el.src).toBeGreaterThan(0);
  }, 300_000);

  it('uploads a 650 MB screen recording and plays it', async () => {
    await openEditor();
    const clip = (await readFile((await writeMediaFixtures(join(workDir, 'sources'), ['clip.mp4'])).get('clip.mp4')!));
    // A real clip padded past 650 MB by a trailing 64-bit `free` atom, built
    // in the page so the bytes never cross the DevTools protocol.
    const pad = 650 * 1024 * 1024;
    await drop(`
      const header = new DataView(new ArrayBuffer(16));
      header.setUint32(0, 1); header.setUint32(4, 0x66726565); header.setBigUint64(8, BigInt(${pad} + 16));
      const parts = [decode(${JSON.stringify(clip.toString('base64'))}), header.buffer];
      const chunk = new Uint8Array(64 * 1024 * 1024);
      for (let sent = 0; sent < ${pad}; sent += chunk.length) parts.push(chunk.subarray(0, Math.min(chunk.length, ${pad} - sent)));
      transfer.items.add(new File(parts, 'recording.mp4', { type: 'video/mp4' }));
    `);
    const [video] = await resolvedMedia(1, 300_000);
    expect(video.type).toBe('video');
    const [painted] = await paintedMedia([video]);
    expect(painted.tag).toBe('video');
    expect(painted.ok).toBe(true);
    expect((await stat(join(deckDir(), video.src))).size).toBe(clip.length + 16 + pad);
    expect(server!.alive(), `server exited:\n${server!.stderr()}`).toBe(true);
  }, 420_000);
});

describe.skipIf(electronBinary)('uploads to the sandboxed collab server (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBeFalsy();
  });
});
