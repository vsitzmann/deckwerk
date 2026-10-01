import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
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

/**
 * Drag-and-drop of real image and video files into the browser collab client.
 *
 * `test/collabBrowserSmoke.test.ts` calls `window.api.importAssetFiles`
 * directly, which proves the upload bridge but skips everything the user
 * actually does: the canvas `drop` listener, media classification by name,
 * local probing for natural size, the `pending:` placeholder, and the commit
 * that swaps the placeholder for the hashed asset path. This test dispatches a
 * genuine `DragEvent` carrying a `DataTransfer` with two files onto the canvas
 * of a browser connected to a headless collab server, and follows both files
 * from drop to rendered media to persisted deck on the server.
 */

const DECK_ID = 'drag-drop';
const PNG = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png');
const MP4 = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'testclip.mp4');

interface DroppedElement {
  id: string;
  type: string;
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

let workDir = '';
let server: RunningCollabServer | null = null;
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

/** Bring up a headless collab server with an empty deck and a connected
 *  browser editor, ready to be dropped on. */
async function openEditor(): Promise<Cdp> {
  workDir = await mkdtemp(join(tmpdir(), 'collab-drag-drop-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, DECK_ID);
  const clientDir = await collabClientDir();
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  await saveDeck(deckDir, emptyDeck('Drag and drop'));
  await writeFile(
    join(deckDir, 'theme.css'),
    '.slide { background: #ffffff; color: #111827; }\n',
    'utf8',
  );

  server = await startCollabServer({
    rootDir: decksRoot,
    clientDir,
    host: '127.0.0.1',
    port: 0,
  });

  browser = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Drop%20Browser`,
    profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (t) => t.url.includes(`deck=${DECK_ID}`) && !t.url.includes('present.html'),
    browser.log,
  );
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);

  await eventually(async () => editor!.evaluate<boolean>(`(() => (
    document.getElementById('status')?.textContent?.includes('connected as Drop Browser') === true
    && Boolean(document.querySelector('#canvas .slide'))
  ))()`), 'browser editor did not finish connecting');
  return editor;
}

describe.skipIf(!electronBinary)('collab drag-and-drop', () => {
  it('drops an image and a video onto the canvas, uploads both, and syncs them', async () => {
    editor = await openEditor();

    const png = (await readFile(PNG)).toString('base64');
    const mp4 = (await readFile(MP4)).toString('base64');

    // A dragover over the canvas must arm the drop affordance; without it the
    // browser's own default handler wins and the drop never reaches the app.
    const armed = await editor.evaluate<boolean>(`(() => {
      const host = document.getElementById('canvas');
      host.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: new DataTransfer()
      }));
      return host.classList.contains('drop-active');
    })()`);
    expect(armed).toBe(true);

    // A real drop: two Files in a DataTransfer, dropped at the centre of the
    // slide stage. Everything downstream — classification, probing, upload,
    // placeholder resolution — is the app's own code path.
    const dropped = await editor.evaluate<{ x: number; y: number; count: number }>(`(() => {
      const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([decode(${JSON.stringify(png)})], 'swatch.png', { type: 'image/png' }));
      transfer.items.add(new File([decode(${JSON.stringify(mp4)})], 'testclip.mp4', { type: 'video/mp4' }));

      const host = document.getElementById('canvas');
      const slide = host.querySelector('.slide');
      const box = slide.getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const y = Math.round(box.top + box.height / 2);
      host.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y
      }));
      return { x, y, count: transfer.files.length };
    })()`);
    expect(dropped.count).toBe(2);

    const read = `(() => window.store.get().deck.slides[0].elements
      .filter((el) => el.type === 'image' || el.type === 'video')
      .map((el) => ({ id: el.id, type: el.type, src: el.src, x: el.x, y: el.y, w: el.w, h: el.h })))()`;

    // The placeholder pass is what keeps the slide usable during an upload:
    // both elements exist, sized from the local bytes, before the hashed asset
    // path arrives. How long the `pending:` src stays observable depends on
    // upload speed, though — against a loopback server the swap can beat this
    // 100ms poll (it did on CI) — so the durable contract asserted here is:
    // both elements appear with real local-probed sizes, and at every
    // observation each src is either a `pending:` placeholder or already a
    // hashed asset path, never anything else. Resolution is asserted next.
    const firstSeen = await eventually(
      async () => editor!.evaluate<DroppedElement[]>(read),
      'dropped files did not create elements',
      (els) => els.length === 2,
    );
    expect(firstSeen.map((el) => el.type)).toEqual(['image', 'video']);
    for (const el of firstSeen) {
      expect(el.w).toBeGreaterThan(0);
      expect(el.h).toBeGreaterThan(0);
      expect(el.src).toMatch(/^(pending:|assets\/)/);
    }

    const resolved = await eventually(
      async () => editor!.evaluate<DroppedElement[]>(read),
      'dropped uploads never resolved to real asset paths',
      (els) => els.length === 2 && els.every((el) => !el.src.startsWith('pending:')),
      30_000,
    );
    const [image, video] = resolved;
    expect(image.type).toBe('image');
    expect(image.src).toMatch(/^assets\/swatch\.[0-9a-f]+\.png$/);
    expect(video.type).toBe('video');
    expect(video.src).toMatch(/^assets\/testclip\.[0-9a-f]+\.mp4$/);

    // Dropped media lands centred on the cursor, the second file cascading so
    // multi-file drops don't stack exactly on top of each other.
    const canvasW = await editor.evaluate<number>('window.store.get().deck.canvas.w');
    expect(image.x + image.w / 2).toBeCloseTo(canvasW / 2, 0);
    expect(video.x + video.w / 2).toBeCloseTo(image.x + image.w / 2 + 40, 0);

    // Both assets must be fetchable from the server and actually decode in the
    // page: an upload that stores unusable bytes still passes a src assertion.
    for (const src of [image.src, video.src]) {
      const response = await fetch(`http://127.0.0.1:${server!.port}/decks/${DECK_ID}/${src}`);
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }

    const painted = await eventually(async () => editor!.evaluate<{
      image: boolean;
      video: boolean;
    }>(`(() => {
      const img = document.querySelector('[data-element-id="${image.id}"] img');
      const vid = document.querySelector('[data-element-id="${video.id}"] video');
      return {
        image: img?.complete === true && img.naturalWidth > 0,
        video: Boolean(vid) && vid.readyState >= 1 && vid.videoWidth > 0
      };
    })()`), 'dropped media did not render in the editor',
      (value) => value.image && value.video, 20_000);
    expect(painted).toEqual({ image: true, video: true });

    // Finally, the drop is a normal transaction: the headless server holds it.
    const live = await eventually(
      async () => fetchDeck(server!.port),
      'dropped media never reached the server deck',
      (deck) => [image, video].every((el) => deck.slides[0].elements.some(
        (candidate) => candidate.id === el.id && 'src' in candidate && candidate.src === el.src,
      )),
    );
    expect(live.slides[0].elements.filter((el) => el.type === 'video')).toHaveLength(1);
  }, 120_000);

  /**
   * A drag out of a web page, which carries no file at all.
   *
   * Chromium hands over the page's `<img>` markup and the image's URL, and
   * nothing else -- the reason this drop used to be discarded in silence. The
   * drag here quotes an inline `data:` image rather than a remote one so the
   * test needs no network: everything the fix touches (finding the image on
   * the drag, probing it for its natural size, the placeholder, and the
   * import that resolves it) is the same code either way.
   */
  it('drops an image dragged out of a web page, which carries no file', async () => {
    editor = await openEditor();
    const png = (await readFile(PNG)).toString('base64');

    const dropped = await editor.evaluate<{ files: number; x: number }>(`(() => {
      const transfer = new DataTransfer();
      // Exactly what a browser writes for an image drag: markup, plus the
      // image's own URL in text/uri-list and the page's in text/plain.
      transfer.setData('text/html', "<meta charset='utf-8'><img src=\\"data:image/png;base64,${png}\\" alt=\\"Swatch\\">");
      transfer.setData('text/uri-list', 'data:image/png;base64,${png}');
      transfer.setData('text/plain', 'https://example.test/gallery');

      const host = document.getElementById('canvas');
      const box = host.querySelector('.slide').getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const y = Math.round(box.top + box.height / 2);
      host.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer, clientX: x, clientY: y
      }));
      return { files: transfer.files.length, x };
    })()`);
    // The premise of the bug: there is no file to import.
    expect(dropped.files).toBe(0);

    const read = `(() => window.store.get().deck.slides[0].elements
      .filter((el) => el.type === 'image')
      .map((el) => ({ id: el.id, type: el.type, src: el.src, x: el.x, y: el.y, w: el.w, h: el.h })))()`;

    const resolved = await eventually(
      async () => editor!.evaluate<DroppedElement[]>(read),
      'a web image drag never became a resolved image element',
      (els) => els.length === 1 && !els[0].src.startsWith('pending:'),
      30_000,
    );
    const [image] = resolved;
    expect(image.src).toMatch(/^assets\/.+\.png$/);
    // Sized from the image the browser decoded off the drag, and centred on
    // the cursor like any other drop.
    expect(image.w).toBeGreaterThan(0);
    expect(image.h).toBeGreaterThan(0);
    const canvasW = await editor.evaluate<number>('window.store.get().deck.canvas.w');
    expect(image.x + image.w / 2).toBeCloseTo(canvasW / 2, 0);

    // The bytes really landed in the deck, and really paint.
    const port = server!.port;
    const response = await fetch(`http://127.0.0.1:${port}/decks/${DECK_ID}/${image.src}`);
    expect(response.status).toBe(200);
    const painted = await eventually(async () => editor!.evaluate<boolean>(`(() => {
      const img = document.querySelector('[data-element-id="${image.id}"] img');
      return img?.complete === true && img.naturalWidth > 0;
    })()`), 'the dropped web image did not render', (ok) => ok, 20_000);
    expect(painted).toBe(true);

    const live = await eventually(
      async () => fetchDeck(server!.port),
      'the dropped web image never reached the server deck',
      (deck) => deck.slides[0].elements.some(
        (el) => el.id === image.id && 'src' in el && el.src === image.src,
      ),
    );
    expect(live.slides[0].elements).toHaveLength(1);
  }, 120_000);

  it('drops a file whose name carries no extension, by its MIME type', async () => {
    // A drag out of Photos or a browser's image cache hands over a file named
    // just `image`. BUG (fixed): the drop was ignored without a word.
    editor = await openEditor();
    const png = (await readFile(PNG)).toString('base64');
    await editor.evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(${JSON.stringify(png)}), (c) => c.charCodeAt(0))], 'image', { type: 'image/png' }));
      const host = document.getElementById('canvas');
      const box = host.querySelector('.slide').getBoundingClientRect();
      host.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2,
      }));
    })()`);
    const [image] = await eventually(
      async () => editor!.evaluate<DroppedElement[]>(`(() => window.store.get().deck.slides[0].elements
        .filter((el) => el.type === 'image').map((el) => ({ id: el.id, type: el.type, src: el.src, x: el.x, y: el.y, w: el.w, h: el.h })))()`),
      'an extension-less image drop never became a resolved image',
      (els) => els.length === 1 && !els[0].src.startsWith('pending:'),
      30_000,
    );
    expect(image.src).toMatch(/^assets\/image\.[0-9a-f]{8}\.png$/);
    expect(await eventually(async () => editor!.evaluate<boolean>(`(() => {
      const img = document.querySelector('[data-element-id="${image.id}"] img');
      return img?.complete === true && img.naturalWidth > 0;
    })()`), 'the extension-less image did not render', (ok) => ok, 20_000)).toBe(true);
  }, 120_000);

  it('drops an image dragged out of another deck on the same server', async () => {
    // Dragging between two DeckWerk tabs carries the other deck's asset URL —
    // this server's own, private address. BUG (fixed): the server refused to
    // fetch it and the drop became an "Upload failed" frame.
    editor = await openEditor();
    const otherDir = join(workDir, 'decks', 'other');
    await mkdir(join(otherDir, 'assets'), { recursive: true });
    await saveDeck(otherDir, emptyDeck('Other'));
    await writeFile(join(otherDir, 'assets', 'swatch.png'), await readFile(PNG));
    const url = `http://127.0.0.1:${server!.port}/decks/other/assets/swatch.png`;

    await editor.evaluate(`(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/html', '<img src="${url}">');
      transfer.setData('text/uri-list', '${url}');
      const host = document.getElementById('canvas');
      const box = host.querySelector('.slide').getBoundingClientRect();
      host.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: transfer,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2,
      }));
    })()`);
    const [image] = await eventually(
      async () => editor!.evaluate<DroppedElement[]>(`(() => window.store.get().deck.slides[0].elements
        .filter((el) => el.type === 'image').map((el) => ({ id: el.id, type: el.type, src: el.src, x: el.x, y: el.y, w: el.w, h: el.h })))()`),
      'a cross-deck image drag never resolved',
      (els) => els.length === 1 && !els[0].src.startsWith('pending:'),
      30_000,
    );
    expect(image.src).toMatch(/^assets\/swatch\.[0-9a-f]{8}\.png$/);
    expect((await readFile(join(workDir, 'decks', DECK_ID, image.src))).equals(await readFile(PNG))).toBe(true);
  }, 120_000);
});

describe.skipIf(electronBinary)('collab drag-and-drop (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});

async function fetchDeck(port: number): Promise<Deck> {
  const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${DECK_ID}`);
  if (!response.ok) throw new Error(`deck request failed (${response.status})`);
  return response.json() as Promise<Deck>;
}
