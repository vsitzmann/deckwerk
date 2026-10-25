import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

/**
 * PDF export from the browser collaboration client.
 *
 * The headless collab server has no Chromium, so there is no server-side
 * `printToPDF`: the client lays out the same `.pdf-page` document the desktop
 * exporter renders and hands it to the browser's own print pipeline. What can
 * break silently is the layout — a print tab that renders nothing, or pages at
 * the wrong size, still "works" until someone saves an empty PDF. So this test
 * drives the real toolbar into the real print tab and measures the pages.
 */

const DECK_ID = 'pdf-export';
const TITLE_MARKER = 'PDF EXPORT TITLE';
const BUILD_MARKER = 'PDF EXPORT BUILD STEP';

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

describe.skipIf(!electronBinary)('collaboration PDF export', () => {
  it('renders one print page per build stage at the deck canvas size', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-pdf-export-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    // Two slides: one plain, one with a build — so 'final' is two pages and
    // 'every' is three, which is what the dialog's checkbox chooses between.
    // Slide 1 also has a video: the print tab must show a still the server
    // cut for it, never mount the video (Oct 2026: a 90-page talk's 61 videos
    // all loading at once crashed Chromium).
    const deck = emptyDeck('PDF export deck');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await copyFile(
      join(__dirname, '..', 'decks', 'demo-deck', 'assets', 'testclip.mp4'),
      join(deckDir, 'assets', 'clip.mp4'),
    );
    deck.slides[0].elements.push({
      id: 'clip', type: 'video', x: 160, y: 400, w: 640, h: 360,
      rot: 0, z: 2, opacity: 1, class: [], style: {},
      src: 'assets/clip.mp4', fit: 'contain', autoplay: true, loop: true, muted: true,
      controls: false, start: 0.5, end: null, poster: null, sourceBox: null,
    });
    deck.slides[0].elements.push({
      id: 'title', type: 'text', x: 160, y: 100, w: 1600, h: 140,
      rot: 0, z: 1, opacity: 1, class: ['role-title'], style: {},
      html: TITLE_MARKER, align: 'center', valign: 'middle',
    });
    deck.slides.push({
      ...emptyDeck('second').slides[0],
      id: 'slide-2',
      elements: [{
        id: 'build-text', type: 'text', x: 160, y: 300, w: 1600, h: 140,
        rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
        html: BUILD_MARKER, align: 'center', valign: 'middle',
      }],
      timeline: [{
        id: 'build-1',
        trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target: 'build-text', value: null },
      }],
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #ffffff; color: #111827; }',
      '.role-title { font: 700 72px/1.1 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    server = await startCollabServer({
      rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
    });

    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=PDF%20Tester`,
      profileDir,
    );
    const editorTarget = await findTarget(
      browser.debugPort,
      (target) => target.url.includes(`deck=${DECK_ID}`) && !target.url.includes('print.html'),
      browser.log,
    );
    editor = await Cdp.connect(editorTarget.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(
      'Boolean(window.store?.get().deck.slides.length)'),
      'the browser editor did not finish connecting');

    // Real clicks, all the way from the toolbar: File → Export PDF… → the
    // export dialog's build checkbox → Export. File is the one file control
    // at every width now, so this is the route an author actually takes.
    // The toolbar's dropdowns are not distinguishable by CSS alone, so mark the
    // one under test and then click it for real.
    // The toolbar is drawn after the store has its deck; wait for it rather
    // than reading it in the same tick.
    await eventually(async () => editor!.evaluate<boolean>(`(() => {
      const trigger = [...document.querySelectorAll('#toolbar .shape-menu-trigger')]
        .find((candidate) => candidate.textContent?.trim() === 'File');
      trigger?.setAttribute('data-test', 'file-menu');
      return Boolean(trigger);
    })()`), 'the toolbar never offered the File menu');
    await editor.click('#toolbar [data-test="file-menu"]', 'File menu');
    const menu = await editor.evaluate<string[]>(
      `[...document.querySelectorAll('#toolbar .shape-menu-item')].map((item) => item.textContent)`);
    expect(menu).toContain('Export PDF…');
    // Save and export sits in a labelled group, so the item is not a positional
    // child of the menu. Tag it the same way the trigger was tagged.
    const taggedPdf = await editor.evaluate<boolean>(`(() => {
      const item = [...document.querySelectorAll('#toolbar .shape-menu-item')]
        .find((candidate) => candidate.textContent?.trim() === 'Export PDF…');
      item?.setAttribute('data-test', 'export-pdf');
      return Boolean(item);
    })()`);
    expect(taggedPdf).toBe(true);
    await editor.click('#toolbar [data-test="export-pdf"]', 'Export PDF… menu item');
    await editor.click('.pdf-export-dialog input[type="checkbox"]', 'include-builds checkbox');

    // Capture the URL the real export action asks the browser to open. Letting
    // that tab open here races its immediate native `window.print()` call: a
    // modal print dialog can block CDP before the test has a chance to stub it.
    // Navigating this already-controlled target to the captured URL exercises
    // the same production print page without the native-dialog race.
    const capturesPrintUrl = await editor.evaluate<boolean>(`(() => {
      window.__openedPrintUrl = '';
      window.open = (url) => {
        window.__openedPrintUrl = String(url);
        return {};
      };
      return true;
    })()`);
    expect(capturesPrintUrl).toBe(true);
    await editor.click('.pdf-export-dialog button.primary', 'Export');
    const printPath = await editor.evaluate<string>('window.__openedPrintUrl');
    expect(printPath).toContain('print.html');
    expect(printPath).toContain(`deck=${DECK_ID}`);
    expect(printPath).toContain('mode=every');

    await editor.call('Page.enable');
    await editor.call('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__printed = 0; window.print = () => { window.__printed++; };',
    });
    await editor.call('Page.navigate', {
      url: new URL(printPath, `http://127.0.0.1:${server.port}/`).href,
    });

    const rendered = await eventually(async () => editor!.evaluate<{
      ready: string;
      error: string;
      pages: number;
      sizes: string[];
      pageRule: boolean;
      printed: number;
      status: string;
      buttonDisabled: boolean;
      text: string;
      background: string;
      videos: number;
      stills: string[];
    }>(`(() => {
      const pages = [...document.querySelectorAll('.pdf-page')];
      return {
        ready: document.documentElement.dataset.ready ?? '',
        error: document.documentElement.dataset.error ?? '',
        pages: pages.length,
        sizes: pages.map((page) => page.offsetWidth + 'x' + page.offsetHeight),
        pageRule: [...document.head.querySelectorAll('style')]
          .some((tag) => tag.textContent.includes('@page')),
        printed: window.__printed ?? -1,
        status: document.getElementById('status').textContent,
        buttonDisabled: document.getElementById('print').disabled,
        text: document.body.textContent,
        background: getComputedStyle(pages[0].querySelector('.slide')).backgroundColor,
        videos: document.querySelectorAll('video').length,
        stills: [...document.querySelectorAll('img')]
          .filter((image) => image.naturalWidth > 0)
          .map((image) => image.getAttribute('src')),
      };
    })()`), 'the print tab never finished rendering', (value) => (
      value.ready !== '' || value.error !== ''
    ), 30_000);

    expect(rendered.error).toBe('');
    expect(rendered.ready).toBe('true');
    // Slide 1 plus both stages of slide 2's build.
    expect(rendered.pages).toBe(3);
    expect(rendered.sizes).toEqual([
      `${deck.canvas.w}x${deck.canvas.h}`,
      `${deck.canvas.w}x${deck.canvas.h}`,
      `${deck.canvas.w}x${deck.canvas.h}`,
    ]);
    expect(rendered.pageRule).toBe(true);
    expect(rendered.text).toContain(TITLE_MARKER);
    expect(rendered.text).toContain(BUILD_MARKER);
    // The deck's own theme has to reach the printed pages, not just the editor.
    expect(rendered.background).toBe('rgb(255, 255, 255)');
    expect(rendered.buttonDisabled).toBe(false);
    expect(rendered.status).toContain('3 pages ready');
    expect(rendered.printed).toBe(1);
    expect(rendered.videos).toBe(0);
    expect(rendered.stills).toEqual([
      `/api/video-still?deck=${DECK_ID}&src=assets%2Fclip.mp4&t=0.5`,
    ]);
  }, 90_000);
});

describe.skipIf(electronBinary)('collaboration PDF export (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
