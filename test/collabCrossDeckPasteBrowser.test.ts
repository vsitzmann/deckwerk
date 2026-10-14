import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * Copy in one deck, paste in another, in the browser editor — reported as
 * "you can't copy-paste images between slideshows". Opening the other deck
 * reloads the page, which emptied the in-page copy, and its `assets/…` srcs
 * named the first deck's files anyway.
 *
 * The real client and server, two decks on one server, one tab that copies in
 * deck A and then opens deck B. The OS clipboard is left out on purpose (this
 * suite must not touch the machine's clipboard, so it can run in parallel):
 * the copy and paste are the ClipboardEvents Chromium would fire, carrying a
 * DataTransfer of their own, and the page's async clipboard API is removed so
 * the copy cannot reach the real one. What crosses from A to B is therefore
 * exactly what the OS clipboard would carry: the copy event's plain text.
 * test/collabEditorShellBrowser.test.ts does the same with real chords.
 */

const DECK_A = 'talk-a';
const DECK_B = 'talk-b';
const USER = 'Paste Browser';
const PNG = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png');
const MP4 = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'testclip.mp4');

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

function deckA(): Deck {
  const deck = emptyDeck('Talk A');
  deck.slides[0].background.image = 'assets/swatch.png';
  deck.slides[0].elements.push(
    {
      id: 'image-a', type: 'image', x: 200, y: 150, w: 400, h: 300, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, src: 'assets/swatch.png', fit: 'contain', alt: 'Swatch', sourceBox: null,
    },
    {
      id: 'video-a', type: 'video', x: 900, y: 150, w: 640, h: 360, rot: 0, z: 2, opacity: 1,
      class: [], style: {}, src: 'assets/testclip.mp4', fit: 'contain', autoplay: false,
      loop: true, muted: true, controls: false, start: 0, end: null, poster: null, sourceBox: null,
    },
  );
  return deck;
}

function cdp(): Cdp {
  if (!editor) throw new Error('editor is not connected');
  return editor;
}

/** Open `deck` in the tab, as the deck picker does: a page load. */
async function openDeck(deck: string, ready: string): Promise<void> {
  // Navigate after the evaluation returns: a page torn down mid-reply is a
  // DevTools "Internal error", not a navigation.
  await cdp().evaluate(`(() => {
    window.testPageLeaving = true;
    setTimeout(() => {
      location.href = ${JSON.stringify(`/?deck=${deck}&name=${encodeURIComponent(USER)}`)};
    }, 0);
  })()`);
  await eventually(async () => cdp().evaluate<boolean>('window.testPageLeaving !== true').catch(() => false),
    `the tab never left for ${deck}`, (left) => left);
  await eventually(async () => cdp().evaluate<boolean>(`(() => (
    new URLSearchParams(location.search).get('deck') === ${JSON.stringify(deck)}
    && document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${USER}`)}) === true
    && Boolean(document.querySelector(${JSON.stringify(ready)}))
  ))()`).catch(() => false), `deck ${deck} did not open`, (ok) => ok);
  // Keep the copy off the machine's real clipboard (see above).
  await cdp().evaluate(`void Object.defineProperty(Navigator.prototype, 'clipboard', {
    configurable: true, get: () => undefined,
  })`);
}

/** Cmd/Ctrl+C as the Web UI sees it: the keydown, then Chromium's copy event. */
async function copyInApp(): Promise<string> {
  return cdp().evaluate<string>(`(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    const data = new DataTransfer();
    window.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/plain');
  })()`);
}

/** Cmd/Ctrl+V as the Web UI sees it: Chromium's paste event, with `text` on the clipboard. */
async function pasteInApp(text: string): Promise<void> {
  await cdp().evaluate(`(() => {
    const data = new DataTransfer();
    data.setData('text/plain', ${JSON.stringify(text)});
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  })()`);
}

/**
 * The copy is done once the status bar says so: that is after it has also
 * been handed to the server, where the other deck's page will look for it.
 */
async function copied(fragment: string): Promise<void> {
  await eventually(
    async () => cdp().evaluate<string>(`document.getElementById('status')?.textContent ?? ''`),
    `the status never said ${JSON.stringify(fragment)}`,
    (status) => status.includes(fragment),
  );
}

async function serverDeck(deck: string): Promise<Deck> {
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${deck}`);
  if (!response.ok) throw new Error(`deck request failed (${response.status})`);
  return response.json() as Promise<Deck>;
}

async function rendered(id: string): Promise<boolean> {
  return eventually(async () => cdp().evaluate<boolean>(`(() => {
    const img = document.querySelector('#canvas [data-element-id="${id}"] img');
    const video = document.querySelector('#canvas [data-element-id="${id}"] video');
    if (img) return img.complete && img.naturalWidth > 0;
    return Boolean(video) && video.readyState >= 1;
  })()`), `${id} did not render`, (ok) => ok, 20_000);
}

describe.skipIf(!electronBinary)('copy and paste between decks in the browser editor', () => {
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-cross-deck-paste-'));
    const decksRoot = join(workDir, 'decks');
    const theme = '.slide { background: #ffffff; color: #111827; }\n';
    for (const [id, deck] of [[DECK_A, deckA()], [DECK_B, emptyDeck('Talk B')]] as const) {
      await mkdir(join(decksRoot, id, 'assets'), { recursive: true });
      await saveDeck(join(decksRoot, id), deck);
      await writeFile(join(decksRoot, id, 'theme.css'), theme, 'utf8');
    }
    await copyFile(PNG, join(decksRoot, DECK_A, 'assets', 'swatch.png'));
    await copyFile(MP4, join(decksRoot, DECK_A, 'assets', 'testclip.mp4'));
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });

    server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_A}&name=${encodeURIComponent(USER)}`,
      profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (t) => t.url.includes(`deck=${DECK_A}`) && !t.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => cdp().evaluate<boolean>(`(() => (
      document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${USER}`)}) === true
    ))()`), 'browser editor did not finish connecting', (ok) => ok);
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
  }, 60_000);

  it('pastes an image and a video copied in deck A into deck B, files and all', async () => {
    await openDeck(DECK_A, '#canvas [data-element-id="image-a"] img');
    await cdp().evaluate(`void window.store.select(['image-a', 'video-a'])`);
    const token = await copyInApp();
    expect(token.startsWith('deckwerk-clipboard:')).toBe(true);
    await copied('Copied 2 elements.');

    await openDeck(DECK_B, '#canvas .slide');
    await pasteInApp(token);
    const pasted = await eventually(
      async () => cdp().evaluate<Array<{ id: string; type: string; src: string; x: number }>>(`(() => window.store.get()
        .deck.slides[0].elements.map((el) => ({ id: el.id, type: el.type, src: el.src, x: el.x })))()`),
      'nothing pasted into deck B',
      (els) => els.length === 2,
      30_000,
    );
    const image = pasted.find((el) => el.type === 'image')!;
    const video = pasted.find((el) => el.type === 'video')!;
    expect(image.src).toMatch(/^assets\/swatch\.[0-9a-f]{8}\.png$/);
    expect(video.src).toMatch(/^assets\/testclip\.[0-9a-f]{8}(\.fs)?\.mp4$/);
    expect(image.x).toBe(200);
    // The files are deck B's own now, byte for byte the picture deck A shows.
    const deckDir = join(workDir, 'decks', DECK_B);
    expect((await readFile(join(deckDir, image.src))).equals(await readFile(PNG))).toBe(true);
    expect((await readFile(join(deckDir, video.src))).length).toBeGreaterThan(0);
    expect(await rendered(image.id)).toBe(true);
    expect(await rendered(video.id)).toBe(true);
    expect(await cdp().evaluate<string>(`document.getElementById('status')?.textContent ?? ''`))
      .toContain('Pasted 2 elements.');

    const persisted = await eventually(
      async () => serverDeck(DECK_B),
      'deck B on the server never got the paste',
      (deck) => deck.slides[0].elements.length === 2,
    );
    expect(persisted.slides[0].elements.map((el) => ('src' in el ? el.src : null)).sort())
      .toEqual([image.src, video.src].sort());
  }, 120_000);

  it('pastes a whole slide copied in deck A into deck B, with its background', async () => {
    await openDeck(DECK_A, '#canvas [data-element-id="image-a"] img');
    await cdp().evaluate(`(() => { window.store.select([]); window.store.selectSlide(0); })()`);
    const token = await copyInApp();
    await copied('Copied 1 slide.');

    await openDeck(DECK_B, '#canvas .slide');
    await pasteInApp(token);
    const slide = await eventually(
      async () => cdp().evaluate<{ count: number; background: string | null; srcs: string[] }>(`(() => {
        const slides = window.store.get().deck.slides;
        const last = slides[slides.length - 1];
        return {
          count: slides.length,
          background: last.background.image,
          srcs: last.elements.map((el) => el.src),
        };
      })()`),
      'no slide pasted into deck B',
      (state) => state.count === 2,
      30_000,
    );
    expect(slide.background).toMatch(/^assets\/swatch\.[0-9a-f]{8}\.png$/);
    expect(slide.srcs).toHaveLength(2);
    for (const src of [slide.background!, ...slide.srcs]) {
      expect(src.startsWith('assets/') && !['assets/swatch.png', 'assets/testclip.mp4'].includes(src)).toBe(true);
    }
  }, 120_000);
});

describe.skipIf(electronBinary)('copy and paste between decks in the browser editor (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
