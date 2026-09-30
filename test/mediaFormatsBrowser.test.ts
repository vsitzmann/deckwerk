import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
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
import { fixture, writeMediaFixtures } from './support/mediaFixtures.js';
import { PAINT_READER, READ_MEDIA, type Landed, type Painted } from './support/mediaPaint.js';

/**
 * Drag-and-drop and clipboard paste of every format that matters, through the
 * real events, in a real browser.
 *
 * `test/mediaImportFormats.test.ts` covers the importer for the whole matrix
 * cheaply. What only a browser can prove is the other half: that the drop and
 * paste listeners accept the file at all (both filter by name or MIME type
 * before anything imports), that the element the app builds for it is the
 * right kind, and — the part no unit test reaches — that the asset actually
 * *decodes in the page*. A HEIC that imports to a valid PNG but is still
 * pointed at by an `<img>` the browser cannot paint looks identical to a
 * working import from the outside, and that is exactly the bug class here:
 * every format below renders as an empty rectangle if it is mishandled.
 *
 * `test/collabDragDropBrowser.test.ts` covers the drop mechanics in depth for
 * one image and one video — placeholder lifecycle, cursor centring, cascade,
 * server persistence. This suite is deliberately about format breadth instead.
 */

const DECK_ID = 'media-formats';

/** One per rendering branch and one per import branch, plus a non-media file. */
const DROPPED = [
  'swatch.png',
  'photo.jpg',
  'photo.webp',
  'loop.gif',
  'photo.heic',
  'diagram.svg',
  'paper.pdf',
  'clip.mp4',
  'clip.webm',
  'screen.mov',
  'notes.txt',
] as const;

/** The clipboard only ever carries one image at a time, so these paste singly. */
const PASTED = ['swatch.png', 'photo.jpg', 'photo.heic'] as const;

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;
let encoded = new Map<string, string>();

beforeAll(async () => {
  if (!electronBinary) return;
  workDir = await mkdtemp(join(tmpdir(), 'media-formats-browser-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, DECK_ID);
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await saveDeck(deckDir, emptyDeck('Media formats'));
  await writeFile(
    join(deckDir, 'theme.css'),
    '.slide { background: #ffffff; color: #111827; }\n',
    'utf8',
  );

  const sources = await writeMediaFixtures(join(workDir, 'sources'), [...DROPPED]);
  encoded = new Map(
    await Promise.all(
      [...sources].map(async ([name, path]) =>
        [name, (await readFile(path)).toString('base64')] as const,
      ),
    ),
  );

  server = await startCollabServer({
    rootDir: decksRoot,
    clientDir: await collabClientDir(),
    host: '127.0.0.1',
    port: 0,
  });
  browser = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Formats`,
    profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (t) => t.url.includes(`deck=${DECK_ID}`) && !t.url.includes('present.html'),
    browser.log,
  );
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => editor!.evaluate<boolean>(`(() => (
    document.getElementById('status')?.textContent?.includes('connected as Formats') === true
    && Boolean(document.querySelector('#canvas .slide'))
  ))()`), 'browser editor did not finish connecting');
}, 180_000);

afterAll(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('media formats in the browser', () => {
  it('drops every important format at once and paints all of them', async () => {
    const items = DROPPED.map((name) => {
      const entry = fixture(name);
      return `transfer.items.add(new File([decode(${JSON.stringify(encoded.get(name))})], ${
        JSON.stringify(name)}, { type: ${JSON.stringify(entry.mime)} }));`;
    }).join('\n');

    await editor!.evaluate<number>(`(() => {
      const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      ${items}
      const host = document.getElementById('canvas');
      const box = host.querySelector('.slide').getBoundingClientRect();
      host.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: new DataTransfer()
      }));
      host.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: Math.round(box.left + box.width / 2),
        clientY: Math.round(box.top + box.height / 2),
      }));
      return transfer.files.length;
    })()`);

    // The non-media file is filtered before anything is created, so the count
    // is the media count — a text file must not become an element, and must
    // not abort the drop of the files beside it either.
    const media = DROPPED.filter((name) => fixture(name).kind !== null);
    const resolved = await eventually(
      async () => editor!.evaluate<Landed[]>(READ_MEDIA),
      'dropped formats never resolved to asset paths',
      (els) => els.length === media.length && els.every((el) => !el.src.startsWith('pending:')),
      120_000,
    );

    // Elements come back in drop order, so each one lines up with its fixture.
    for (const [i, name] of media.entries()) {
      const entry = fixture(name);
      const el = resolved[i];
      expect(el.type, `kind of ${name}`).toBe(entry.kind);
      expect(el.src, `src of ${name}`).toMatch(entry.src!);
      expect(el.w, `width of ${name}`).toBeGreaterThan(0);
      expect(el.h, `height of ${name}`).toBeGreaterThan(0);
    }

    const ids = resolved.map((el) => el.id);
    const painted = await eventually(
      async () => editor!.evaluate<Painted[]>(`${PAINT_READER}(${JSON.stringify(ids)})`),
      'dropped media did not decode in the page',
      (values) => values.every((value) => value.ok),
      60_000,
    );
    // Named per format so a failure says which one went blank.
    expect(Object.fromEntries(media.map((name, i) => [name, painted[i].ok]))).toEqual(
      Object.fromEntries(media.map((name) => [name, true])),
    );
    // The right rendering branch, not merely something that painted.
    expect(painted.map((value) => value.tag)).toEqual(
      media.map((name) => {
        if (name.endsWith('.pdf')) return 'embed';
        return fixture(name).kind === 'video' ? 'video' : 'img';
      }),
    );
    // Converted formats are re-encoded, so their decoded size is the source's,
    // proving the conversion carried real pixels rather than a blank canvas.
    expect(painted[media.indexOf('photo.heic')].detail).toBe('64x48');

    // Every asset is fetchable from the server, so a reload or a peer sees it.
    for (const el of resolved) {
      const response = await fetch(
        `http://127.0.0.1:${server!.port}/decks/${DECK_ID}/${el.src}`,
      );
      expect(response.status, `serving ${el.src}`).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
  }, 300_000);

  it('pastes an image from the clipboard whatever format it is in', async () => {
    const before = (await editor!.evaluate<Landed[]>(READ_MEDIA)).length;

    for (const [n, name] of PASTED.entries()) {
      const entry = fixture(name);
      // A real paste event carrying a file, which is what Chromium delivers
      // for a copied photo — the app never sees `navigator.clipboard` here.
      await editor!.evaluate(`(() => {
        const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([decode(${JSON.stringify(encoded.get(name))})], ${
          JSON.stringify(name)}, { type: ${JSON.stringify(entry.mime)} }));
        document.body.focus();
        window.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true, cancelable: true, clipboardData: transfer
        }));
      })()`);

      const landed = await eventually(
        async () => editor!.evaluate<Landed[]>(READ_MEDIA),
        `pasting ${name} created no element`,
        (els) => els.length === before + n + 1
          && els.every((el) => !el.src.startsWith('pending:')),
        60_000,
      );
      const pasted = landed[landed.length - 1];
      expect(pasted.type, `kind of pasted ${name}`).toBe('image');
      expect(pasted.src, `src of pasted ${name}`).toMatch(entry.src!);

      const painted = await eventually(
        async () => editor!.evaluate<Painted[]>(`${PAINT_READER}(["${pasted.id}"])`),
        `pasted ${name} did not decode in the page`,
        ([value]) => value.ok,
        30_000,
      );
      expect(painted[0].detail, `decoded size of pasted ${name}`).toBe('64x48');
    }
  }, 300_000);
});

describe.skipIf(electronBinary)('media formats in the browser (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
