import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { injectWebBridgeRuntime } from '../src/shared/webBridge.js';
import {
  Cdp, electronBinary, eventually, findTarget, launchBrowser, stopBrowser, wait, type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * A web element in the real browser editor and presentation.
 *
 * The editor must treat the page as one opaque, selectable object: its frame
 * is inert on the canvas (or the editor's own pointer handling would stop at
 * it), a click over it selects the element, and the inspector edits its
 * fields. The presentation must do the opposite: load the page live, give it
 * pointer input, and tell it when its slide is shown.
 */
const DECK_ID = 'web-element-editor';
const WEB_ID = 'web-1';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Probe</title></head>
<body style="margin:0;background:#224;color:#fff;font:48px sans-serif">
<div id="status">loaded</div><button id="hits" style="font:inherit">0</button>
<script>
var n = 0;
document.getElementById('hits').addEventListener('click', function () { n += 1; this.textContent = String(n); });
deckwerk.onActive(function (e) { document.getElementById('status').textContent = 'active ' + e.step + '/' + e.steps; });
</script></body></html>`;

/** Under the test's budget, so a command that never answers fails by name. */
const COMMAND_TIMEOUT_MS = 30_000;

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;
let present: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  present?.close();
  editor = null;
  present = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('web element in the browser editor and presentation', () => {
  it('is inert and selectable on the canvas, editable in Props, and live when presenting', {
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'web-element-editor-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets', 'web'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(deckDir, 'assets', 'web', 'probe.html'), injectWebBridgeRuntime(PAGE), 'utf8');

    const deck = emptyDeck('Web element');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: WEB_ID, type: 'web', x: 160, y: 160, w: 1600, h: 760, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, src: 'assets/web/probe.html', poster: null, interactive: true, title: 'Probe page',
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Web%20Tester`, profileDir,
    );
    const target = await findTarget(
      browser.debugPort, (candidate) => candidate.url.includes(`deck=${DECK_ID}`) && !candidate.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!, { commandTimeoutMs: COMMAND_TIMEOUT_MS });
    const FRAME = `#canvas [data-element-id="${WEB_ID}"] iframe.web-frame`;
    await eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('${FRAME}'))`), 'the web element never rendered on the canvas');

    /* Canvas: the frame is inert (previews must not swallow the editor's
       pointer), sandboxed, and points at the deck's own asset. */
    const frame = await editor.evaluate<{ pe: string; sandbox: string | null; src: string }>(`(() => {
      const f = document.querySelector('${FRAME}');
      return { pe: getComputedStyle(f).pointerEvents, sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src') };
    })()`);
    expect(frame.pe).toBe('none');
    expect(frame.sandbox).toBe('allow-scripts');
    expect(frame.src).toMatch(/assets\/web\/probe\.html$/);

    // Clicking over the page selects the element, shown by its resize handles.
    await editor.click(`#canvas [data-element-id="${WEB_ID}"]`, 'the web element');
    await eventually(async () => editor!.evaluate<number>(
      `document.querySelectorAll('.handle[data-element-id="${WEB_ID}"]').length`),
      'the web element was not selected by clicking it', (count) => count > 0);

    /* Live on the canvas: double-click runs the page in place, Escape ends it.

       First a click on the empty slide, away from the element. The canvas
       pairs presses into a double-click by time and distance, so a selection
       click followed at once by a double-click on the same spot is a triple
       click to it: the page went live on the double-click's *first* press, and
       its second landed in the new live frame whenever that frame was ready in
       time. The page then held focus, Escape reached the page's bridge, and
       ending live mode on its keydown tore down the frame the keyup was
       addressed to -- a key event DevTools never acknowledges, so the test
       hung until its budget ran out. A press elsewhere starts a fresh pair:
       this double-click selects on its first press and runs the page on its
       second, with nothing after it to land in the page. */
    const spots = await editor.evaluate<{ empty: { x: number; y: number }; web: { x: number; y: number } }>(`(() => {
      const slide = document.querySelector('#canvas .slide').getBoundingClientRect();
      const r = document.querySelector('#canvas [data-element-id="${WEB_ID}"]').getBoundingClientRect();
      return {
        empty: { x: slide.left + (r.left - slide.left) / 2, y: slide.top + (r.top - slide.top) / 2 },
        web: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      };
    })()`);
    await editor.clickAt(spots.empty.x, spots.empty.y);
    await eventually(async () => editor!.evaluate<number>(
      `document.querySelectorAll('.handle[data-element-id="${WEB_ID}"]').length`),
      'a click on the empty slide did not clear the selection', (count) => count === 0);
    await editor.doubleClickAt(spots.web.x, spots.web.y);
    const liveState = () => editor!.evaluate<{ live: boolean; badge: string | null; pe: string | null }>(`(() => {
      const n = document.querySelector('#canvas [data-element-id="${WEB_ID}"]');
      const f = n?.querySelector('iframe.web-frame');
      return { live: Boolean(n?.classList.contains('web-live')), badge: n?.querySelector('.web-live-badge')?.textContent ?? null,
        pe: f ? getComputedStyle(f).pointerEvents : null };
    })()`);
    await eventually(liveState, 'double-click did not make the page live', (s) => s.live && s.pe === 'auto');
    expect((await liveState()).badge).toMatch(/Esc/);
    // Both presses were the canvas's: neither reached the page, which would have taken the keyboard.
    expect(await editor.evaluate<string>('document.activeElement?.tagName ?? ""')).not.toBe('IFRAME');
    await editor.key('Escape', 27);
    await eventually(liveState, 'Escape did not return the page to editing', (s) => !s.live && s.pe === 'none');

    /* Props: the web section is there and its Title field writes through. */
    await editor.click(`#canvas [data-element-id="${WEB_ID}"]`, 'the web element');
    await editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
    const field = await editor.evaluate<boolean>(`(() => {
      const wrap = [...document.querySelectorAll('#inspector .field')]
        .find((node) => node.querySelector('span')?.textContent === 'Title');
      const input = wrap?.querySelector('textarea');
      if (!input) return false;
      input.id = 'test-web-title';
      return true;
    })()`);
    expect(field, 'the web page Title field is in Props').toBe(true);
    await editor.click('#test-web-title', 'Title field');
    await editor.evaluate('document.getElementById("test-web-title").select()');
    await editor.typeKeys('Papers per year');
    await editor.key('Tab', 9);
    await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      const live = await response.json() as Deck;
      const element = live.slides[0].elements.find((candidate) => candidate.id === WEB_ID);
      return element && element.type === 'web' ? element.title : '';
    }, 'the title edit never reached the server', (title) => title === 'Papers per year');

    /* Presentation: the page runs, receives input, and hears it is active. */
    const presentTarget = await (async () => {
      // A Window is not serializable over the wire; return nothing.
      await editor!.evaluate(`(window.open(${JSON.stringify(
        `http://127.0.0.1:${server!.port}/present.html?deck=${DECK_ID}`)}, '_blank'), null)`);
      return findTarget(browser!.debugPort,
        (candidate) => candidate.url.includes('present.html') && candidate.url.includes(`deck=${DECK_ID}`),
        browser!.log);
    })();
    present = await Cdp.connect(presentTarget.webSocketDebuggerUrl!, { commandTimeoutMs: COMMAND_TIMEOUT_MS });
    await eventually(async () => present!.evaluate<string>(
      `getComputedStyle(document.querySelector('iframe.web-frame') ?? document.body).pointerEvents`),
      'the presentation never showed the live frame', (pe) => pe === 'auto');

    /* The frame is a separate target (opaque origin): read it through its own
       session. The editor's canvas previews load the same page, so the frame
       is picked by the presentation that embeds it, not by its URL alone. */
    const pageTarget = await findTarget(browser.debugPort,
      (candidate) => candidate.url.includes('assets/web/probe.html') && candidate.parentId === presentTarget.id,
      browser.log);
    const page = await Cdp.connect(pageTarget.webSocketDebuggerUrl!, { commandTimeoutMs: COMMAND_TIMEOUT_MS });
    try {
      await eventually(async () => page.evaluate<string>(
        `document.getElementById('status').textContent`),
        'the page never heard it was active', (text) => text === 'active 0/1');

      // A real click on the page's button counts in the page and does not advance the deck.
      const box = await present.evaluate<{ x: number; y: number }>(`(() => {
        const r = document.querySelector('iframe.web-frame').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      })()`);
      const button = await page.evaluate<{ x: number; y: number }>(`(() => {
        const r = document.getElementById('hits').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      const scale = await present.evaluate<number>(
        `document.querySelector('iframe.web-frame').getBoundingClientRect().width / 1600`);
      // The presentation opened behind the editor; a hidden tab has no
      // compositor frame to hit-test the out-of-process page against.
      await present.call('Page.bringToFront', {});
      // The test runner holds OS focus; make the presentation believe it has it.
      await present.call('Emulation.setFocusEmulationEnabled', { enabled: true });
      await eventually(async () => present!.evaluate<string>('document.visibilityState'),
        'the presentation tab never came to the front', (state) => state === 'visible');
      await present.evaluate(`(window.__hits = [], ['pointerdown','mousedown','click'].forEach(t => window.addEventListener(t, e => window.__hits.push(t + ':' + e.target.tagName + '.' + e.target.className), true)), null)`);
      const cx = box.x + button.x * scale;
      const cy = box.y + button.y * scale;
      // The child frame is composited separately; until its first frame has
      // been embedded, browser-side hit-testing falls through to the parent.
      // Moving the pointer over the page and waiting for the page to see it
      // is the observable form of "ready".
      await page.evaluate(`(window.__moves = 0, addEventListener('mousemove', () => { window.__moves += 1; }), null)`);
      await eventually(async () => {
        await present!.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + 1, y: cy + 1, button: 'none' });
        await present!.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' });
        return page.evaluate<number>('window.__moves');
      }, 'pointer movement never reached the page', (moves) => moves > 0);
      // The click itself, delivered through the page's own session: the
      // routing of a press from the host into a child frame is the browser's
      // business and is covered by the standalone-export probe; what matters
      // here is that the sandboxed page runs its own handlers.
      await page.clickAt(button.x, button.y);
      await eventually(async () => page.evaluate<string>(
        `document.getElementById('hits').textContent`), 'the click never reached the page', (n) => n === '1');

      // A press over the page from the host must not advance the deck.
      await present.clickAt(cx, cy);
      await wait(400);
      const slide = await present.evaluate<string>(
        `document.querySelector('.stage [data-slide-id]')?.getAttribute('data-slide-id') ?? ''`);
      expect(slide).toBe(deck.slides[0].id);
    } finally {
      page.close();
    }
  });
});
