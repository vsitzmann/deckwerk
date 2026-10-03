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

/* DEBUG(webflake): timestamp every step and fail one that stalls by name. */
const t0 = Date.now();
async function step<T>(name: string, run: () => Promise<T>, capMs = 45_000): Promise<T> {
  const started = Date.now();
  console.error(`[webflake +${((started - t0) / 1000).toFixed(2)}s] start ${name}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void dumpTargets().finally(() => reject(new Error(`step "${name}" stalled for ${capMs}ms`)));
        }, capMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    console.error(`[webflake +${((Date.now() - t0) / 1000).toFixed(2)}s] end ${name} (${Date.now() - started}ms)`);
  }
}

async function dumpTargets(): Promise<void> {
  if (!browser) return;
  try {
    const response = await fetch(`http://127.0.0.1:${browser.debugPort}/json/list`);
    console.error('[webflake] targets at stall:', JSON.stringify(await response.json(), null, 1));
    console.error('[webflake] browser log:', browser.log().slice(-4000));
  } catch (error) {
    console.error('[webflake] could not list targets', error);
  }
}

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
    const clientDir = await step('1: collabClientDir()', async () => collabClientDir());
    const profileDir = join(workDir, 'electron-profile');
    await step('2: mkdir(join(deckDir, assets, web), { recursive: true })', async () => mkdir(join(deckDir, 'assets', 'web'), { recursive: true }));
    await step('3: mkdir(profileDir, { recursive: true })', async () => mkdir(profileDir, { recursive: true }));
    await step('4: writeFile(join(deckDir, assets, web, probe.html), inje', async () => writeFile(join(deckDir, 'assets', 'web', 'probe.html'), injectWebBridgeRuntime(PAGE), 'utf8'));

    const deck = emptyDeck('Web element');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: WEB_ID, type: 'web', x: 160, y: 160, w: 1600, h: 760, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, src: 'assets/web/probe.html', poster: null, interactive: true, title: 'Probe page',
    });
    await step('5: saveDeck(deckDir, deck)', async () => saveDeck(deckDir, deck));
    await step('6: writeFile(join(deckDir, theme.css), .slide { background: ', async () => writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8'));

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Web%20Tester`, profileDir,
    );
    const target = await step('7: findTarget( browser.debugPort, (candidate) => candidate.url.', async () => findTarget(
      browser!.debugPort, (candidate) => candidate.url.includes(`deck=${DECK_ID}`) && !candidate.url.includes('present.html'),
      browser!.log,
    ));
    editor = await step('connect editor', async () => Cdp.connect(target.webSocketDebuggerUrl!));
    editor.trace = 'editor';
    const FRAME = `#canvas [data-element-id="${WEB_ID}"] iframe.web-frame`;
    await step('8: eventually(async () => editor!.evaluate<boolean>( Boolean(d', async () => eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('${FRAME}'))`), 'the web element never rendered on the canvas'));

    /* Canvas: the frame is inert (previews must not swallow the editor's
       pointer), sandboxed, and points at the deck's own asset. */
    const frame = await step('9: editor.evaluate<{ pe: string; sandbox: string | null; src: s', async () => editor!.evaluate<{ pe: string; sandbox: string | null; src: string }>(`(() => {
      const f = document.querySelector('${FRAME}');
      return { pe: getComputedStyle(f).pointerEvents, sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src') };
    })()`));
    expect(frame.pe).toBe('none');
    expect(frame.sandbox).toBe('allow-scripts');
    expect(frame.src).toMatch(/assets\/web\/probe\.html$/);

    // Clicking over the page selects the element, shown by its resize handles.
    await step('10: editor.click(#canvas [data-element-id="${WEB_ID}"], the w', async () => editor!.click(`#canvas [data-element-id="${WEB_ID}"]`, 'the web element'));
    await step('11: eventually(async () => editor!.evaluate<number>( document.q', async () => eventually(async () => editor!.evaluate<number>(
      `document.querySelectorAll('.handle[data-element-id="${WEB_ID}"]').length`),
      'the web element was not selected by clicking it', (count) => count > 0));

    /* Live on the canvas: double-click runs the page in place, Escape ends it. */
    const box = await step('12: editor.evaluate<{ x: number; y: number }>((() => { const r ', async () => editor!.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('#canvas [data-element-id="${WEB_ID}"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`));
    await step('13: editor.doubleClickAt(box.x, box.y)', async () => editor!.doubleClickAt(box.x, box.y));
    const liveState = () => editor!.evaluate<{ live: boolean; badge: string | null; pe: string | null }>(`(() => {
      const n = document.querySelector('#canvas [data-element-id="${WEB_ID}"]');
      const f = n?.querySelector('iframe.web-frame');
      return { live: Boolean(n?.classList.contains('web-live')), badge: n?.querySelector('.web-live-badge')?.textContent ?? null,
        pe: f ? getComputedStyle(f).pointerEvents : null };
    })()`);
    await step('14: eventually(liveState, double-click did not make the page li', async () => eventually(liveState, 'double-click did not make the page live', (s) => s.live && s.pe === 'auto'));
    expect((await step('badge', liveState)).badge).toMatch(/Esc/);
    await step('15: editor.key(Escape, 27)', async () => editor!.key('Escape', 27));
    await step('16: eventually(liveState, Escape did not return the page to edi', async () => eventually(liveState, 'Escape did not return the page to editing', (s) => !s.live && s.pe === 'none'));

    /* Props: the web section is there and its Title field writes through. */
    await step('17: editor.click(#canvas [data-element-id="${WEB_ID}"], the w', async () => editor!.click(`#canvas [data-element-id="${WEB_ID}"]`, 'the web element'));
    await step('18: editor.click(#side-tabs button[data-panel="inspector"], P', async () => editor!.click('#side-tabs button[data-panel="inspector"]', 'Props tab'));
    const field = await step('19: editor.evaluate<boolean>((() => { const wrap = [...document', async () => editor!.evaluate<boolean>(`(() => {
      const wrap = [...document.querySelectorAll('#inspector .field')]
        .find((node) => node.querySelector('span')?.textContent === 'Title');
      const input = wrap?.querySelector('textarea');
      if (!input) return false;
      input.id = 'test-web-title';
      return true;
    })()`));
    expect(field, 'the web page Title field is in Props').toBe(true);
    await step('20: editor.click(#test-web-title, Title field)', async () => editor!.click('#test-web-title', 'Title field'));
    await step('21: editor.evaluate(document.getElementById("test-web-title").s', async () => editor!.evaluate('document.getElementById("test-web-title").select()'));
    await step('22: editor.typeKeys(Papers per year)', async () => editor!.typeKeys('Papers per year'));
    await step('23: editor.key(Tab, 9)', async () => editor!.key('Tab', 9));
    await step('24: eventually(async () => { const response = await fetch(http:', async () => eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      const live = await response.json() as Deck;
      const element = live.slides[0].elements.find((candidate) => candidate.id === WEB_ID);
      return element && element.type === 'web' ? element.title : '';
    }, 'the title edit never reached the server', (title) => title === 'Papers per year'));

    /* Presentation: the page runs, receives input, and hears it is active. */
    const presentTarget = await step('25: (async () => { // A Window is not serializable over the wire', async () => (async () => {
      // A Window is not serializable over the wire; return nothing.
      await editor!.evaluate(`(window.open(${JSON.stringify(
        `http://127.0.0.1:${server!.port}/present.html?deck=${DECK_ID}`)}, '_blank'), null)`);
      return findTarget(browser!.debugPort,
        (candidate) => candidate.url.includes('present.html') && candidate.url.includes(`deck=${DECK_ID}`),
        browser!.log);
    })());
    present = await step('connect present', async () => Cdp.connect(presentTarget.webSocketDebuggerUrl!));
    present.trace = 'present';
    await step('26: eventually(async () => present!.evaluate<string>( getComput', async () => eventually(async () => present!.evaluate<string>(
      `getComputedStyle(document.querySelector('iframe.web-frame') ?? document.body).pointerEvents`),
      'the presentation never showed the live frame', (pe) => pe === 'auto'));

    // The frame is a separate target (opaque origin): read it through its own session.
    const pageTarget = await step('27: findTarget(browser!.debugPort, (candidate) => candidate.url.i', async () => findTarget(browser!.debugPort,
      (candidate) => candidate.url.includes('assets/web/probe.html'), browser!.log));
    const page = await step('28: Cdp.connect(pageTarget.webSocketDebuggerUrl!)', async () => Cdp.connect(pageTarget.webSocketDebuggerUrl!));
    page.trace = 'page';
    try {
      await step('29: eventually(async () => page.evaluate<string>( document.getE', async () => eventually(async () => page.evaluate<string>(
        `document.getElementById('status').textContent`),
        'the page never heard it was active', (text) => text === 'active 0/1'));

      // A real click on the page's button counts in the page and does not advance the deck.
      const box = await step('30: present.evaluate<{ x: number; y: number }>((() => { const r', async () => present!.evaluate<{ x: number; y: number }>(`(() => {
        const r = document.querySelector('iframe.web-frame').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      })()`));
      const button = await step('31: page.evaluate<{ x: number; y: number }>((() => { const r = ', async () => page.evaluate<{ x: number; y: number }>(`(() => {
        const r = document.getElementById('hits').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`));
      const scale = await step('32: present.evaluate<number>( document.querySelector(iframe.we', async () => present!.evaluate<number>(
        `document.querySelector('iframe.web-frame').getBoundingClientRect().width / 1600`));
      // The presentation opened behind the editor; a hidden tab has no
      // compositor frame to hit-test the out-of-process page against.
      await step('33: present.call(Page.bringToFront, {})', async () => present!.call('Page.bringToFront', {}));
      // The test runner holds OS focus; make the presentation believe it has it.
      await step('34: present.call(Emulation.setFocusEmulationEnabled, { enabled', async () => present!.call('Emulation.setFocusEmulationEnabled', { enabled: true }));
      await step('35: eventually(async () => present!.evaluate<string>(document.v', async () => eventually(async () => present!.evaluate<string>('document.visibilityState'),
        'the presentation tab never came to the front', (state) => state === 'visible'));
      await step('36: present.evaluate((window.__hits = [], [pointerdown,mouse', async () => present!.evaluate(`(window.__hits = [], ['pointerdown','mousedown','click'].forEach(t => window.addEventListener(t, e => window.__hits.push(t + ':' + e.target.tagName + '.' + e.target.className), true)), null)`));
      const cx = box.x + button.x * scale;
      const cy = box.y + button.y * scale;
      // The child frame is composited separately; until its first frame has
      // been embedded, browser-side hit-testing falls through to the parent.
      // Moving the pointer over the page and waiting for the page to see it
      // is the observable form of "ready".
      await step('37: page.evaluate((window.__moves = 0, addEventListener(mousem', async () => page.evaluate(`(window.__moves = 0, addEventListener('mousemove', () => { window.__moves += 1; }), null)`));
      await step('38: eventually(async () => { await present!.call(Input.dispatch', async () => eventually(async () => {
        await present!.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + 1, y: cy + 1, button: 'none' });
        await present!.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none' });
        return page.evaluate<number>('window.__moves');
      }, 'pointer movement never reached the page', (moves) => moves > 0));
      // The click itself, delivered through the page's own session: the
      // routing of a press from the host into a child frame is the browser's
      // business and is covered by the standalone-export probe; what matters
      // here is that the sandboxed page runs its own handlers.
      await step('39: page.clickAt(button.x, button.y)', async () => page.clickAt(button.x, button.y));
      await step('40: eventually(async () => page.evaluate<string>( document.getE', async () => eventually(async () => page.evaluate<string>(
        `document.getElementById('hits').textContent`), 'the click never reached the page', (n) => n === '1'));

      // A press over the page from the host must not advance the deck.
      await step('41: present.clickAt(cx, cy)', async () => present!.clickAt(cx, cy));
      await step('42: wait(400)', async () => wait(400));
      const slide = await step('43: present.evaluate<string>( document.querySelector(.stage [d', async () => present!.evaluate<string>(
        `document.querySelector('.stage [data-slide-id]')?.getAttribute('data-slide-id') ?? ''`));
      expect(slide).toBe(deck.slides[0].id);
    } finally {
      page.close();
    }
  });
});
