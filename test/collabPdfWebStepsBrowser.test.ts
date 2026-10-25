import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Slide } from '../src/shared/deck.js';
import { injectWebBridgeRuntime } from '../src/shared/webBridge.js';
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
 * A web element's own builds, printed.
 *
 * A web element draws its build steps itself, told the step over the bridge.
 * Oct 2026: a chart that filled in bar by bar printed as empty axes on every
 * page, in both PDF modes. The print tab never told the page its step, and
 * even told, the page draws in requestAnimationFrame, which Chromium stops in
 * a sandboxed frame scrolled out of view — as nearly every print page is. The
 * fixture here is that kind of page, on print pages far below the fold, and
 * reports which step it actually drew.
 */

const DECK_ID = 'pdf-web-steps';
const FIXTURE = injectWebBridgeRuntime(`<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;font:700 96px sans-serif">
<div id="label">STEP ?</div>
<script>
  let wanted = null;
  let drawn = null;
  deckwerk.onActive(({ step }) => { wanted = step; });
  deckwerk.onStep(({ step }) => { wanted = step; });
  // Drawn only in animation frames, like the deck pages this guards.
  function frame() {
    if (wanted !== null && wanted !== drawn) {
      drawn = wanted;
      document.getElementById('label').textContent = 'STEP ' + drawn;
      parent.postMessage({ source: 'pdf-web-fixture', drawn }, '*');
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
</script>
</body></html>`);

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let page: Cdp | null = null;

afterEach(async () => {
  page?.close();
  page = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

function textSlide(id: string, text: string): Slide {
  return {
    ...emptyDeck(id).slides[0],
    id,
    elements: [{
      id: `${id}-text`, type: 'text', x: 160, y: 100, w: 1600, h: 140,
      rot: 0, z: 1, opacity: 1, class: ['role-title'], style: {},
      html: text, align: 'center', valign: 'middle',
    }],
  };
}

describe.skipIf(!electronBinary)('collaboration PDF export of web elements', () => {
  it('prints each build stage with the web page drawn at that step', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-pdf-web-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets', 'web'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(deckDir, 'assets', 'web', 'steps.html'), FIXTURE, 'utf8');

    // Three plain slides first, so the web element's pages are below the fold.
    const deck = emptyDeck('PDF web steps');
    const builds = ['one', 'two'];
    deck.slides = [
      textSlide('a', 'First'),
      textSlide('b', 'Second'),
      textSlide('c', 'Third'),
      {
        ...emptyDeck('web').slides[0],
        id: 'web-slide',
        elements: [
          {
            id: 'chart', type: 'web', x: 160, y: 100, w: 1600, h: 800,
            rot: 0, z: 1, opacity: 1, class: [], style: {},
            src: 'assets/web/steps.html', poster: null, interactive: false, title: 'Steps',
          },
          ...builds.map((name, index) => ({
            id: `label-${name}`, type: 'text' as const, x: 160, y: 920 + index * 60, w: 800, h: 50,
            rot: 0, z: 2, opacity: 1, class: ['role-body'], style: {},
            html: name, align: 'left' as const, valign: 'middle' as const,
          })),
        ],
        timeline: builds.map((name) => ({
          id: `build-${name}`,
          trigger: { on: 'click' as const, ref: null, delay: 0 },
          action: { type: 'appear' as const, target: `label-${name}`, value: null },
        })),
      },
    ];
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');

    server = await startCollabServer({
      rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0,
    });
    const origin = `http://127.0.0.1:${server.port}`;
    browser = await launchBrowser(`${origin}/?deck=${DECK_ID}&name=PDF%20Tester`, profileDir);
    const target = await findTarget(browser.debugPort, (t) => t.url.includes(`deck=${DECK_ID}`), browser.log);
    page = await Cdp.connect(target.webSocketDebuggerUrl!);
    await page.call('Page.enable');
    // No native print dialog, and a record of what each frame drew, keyed by
    // its place among the print tab's frames.
    await page.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.print = () => {};
        window.__drawn = {};
        addEventListener('message', (event) => {
          if (event.data?.source !== 'pdf-web-fixture') return;
          const frames = [...document.querySelectorAll('iframe.web-frame')].map((frame) => frame.contentWindow);
          window.__drawn[frames.indexOf(event.source)] = event.data.drawn;
        });`,
    });

    for (const [mode, expected] of [['every', [0, 1, 2]], ['final', [2]]] as const) {
      await page.call('Page.navigate', { url: `${origin}/print.html?deck=${DECK_ID}&mode=${mode}` });
      const printed = await eventually(async () => page!.evaluate<{
        ready: string;
        pages: number;
        drawn: Record<string, number>;
        frames: number;
        settling: number;
        spacers: number;
      }>(`({
        ready: document.documentElement.dataset.ready ?? '',
        pages: document.querySelectorAll('.pdf-page').length,
        drawn: window.__drawn,
        frames: document.querySelectorAll('iframe.web-frame').length,
        settling: document.querySelectorAll('.web-settling').length,
        spacers: document.querySelectorAll('.pdf-page-spacer').length,
      })`), `the ${mode} print tab never finished rendering`, (value) => value.ready !== '', 30_000);

      expect(printed.ready).toBe('true');
      expect(printed.pages).toBe(3 + expected.length);
      expect(printed.frames).toBe(expected.length);
      // BUG (fixed): every frame stayed at step 0, or drew nothing at all.
      expect(expected.map((_, index) => printed.drawn[index])).toEqual(expected);
      // Every page is back in its place in the document before printing.
      expect(printed.settling).toBe(0);
      expect(printed.spacers).toBe(0);
    }
  }, 120_000);
});

describe.skipIf(electronBinary)('collaboration PDF export of web elements (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
