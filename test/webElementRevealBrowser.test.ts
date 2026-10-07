import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck } from '../src/shared/deck.js';
import { injectWebBridgeRuntime } from '../src/shared/webBridge.js';
import {
  Cdp, electronBinary, eventually, findTarget, launchBrowser, stopBrowser, type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Presenting a slide must not flash a web page's uninitialised state.
 *
 * A real deck's slide showed a pile of boxes in its top-left corner for a
 * moment every time it came up: its page positions everything from script
 * once `document.fonts.ready` resolves, and the presentation showed the live
 * frame the instant it was inserted. Here the presentation runs for real and
 * a recorder in the presenting page samples, from the moment each web frame
 * is inserted and on every animation frame after, what a viewer would see at
 * the frame's centre: the page itself, or something else (its poster, or the
 * slide behind a hidden frame).
 *
 * - `slow` holds its readiness with `deckwerk.ready(promise)` and lays itself
 *   out 1.2 s after it loads; it has a poster. It must not be seen before it
 *   says it is laid out, and the poster must stand in meanwhile.
 * - `plain` has neither poster nor readiness call. It must not be seen before
 *   its `load` event.
 */
const DECK_ID = 'web-element-reveal';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SLOW_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#fff">
<div id="box" style="position:absolute;left:0;top:0;width:120px;height:120px;background:#c00">uninitialised</div>
<script>
var laidOut;
var ready = new Promise(function (resolve) { laidOut = resolve; });
deckwerk.ready(ready);
addEventListener('load', function () {
  setTimeout(function () {
    document.getElementById('box').style.transform = 'translate(500px, 200px)';
    parent.postMessage({ revealTest: 'slow-laid-out' }, '*');
    laidOut();
  }, 1200);
});
</script></body></html>`;

const PLAIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#224;color:#fff;font:40px sans-serif">plain page</body></html>`;

/**
 * Installed before the presentation's own scripts. Per web frame: when it was
 * inserted, when it loaded, when the page said it was laid out, and every
 * sample at which the frame was the topmost thing at its centre.
 */
const RECORDER = `(() => {
  const log = window.__reveal = { frames: {}, laidOut: null };
  const now = () => performance.now();
  addEventListener('message', (event) => {
    if (event.data && event.data.revealTest === 'slow-laid-out') log.laidOut = now();
  });
  const watch = (frame) => {
    const name = /slow/.test(frame.getAttribute('src') || '') ? 'slow' : 'plain';
    if (log.frames[name]) return;
    const entry = log.frames[name] = {
      inserted: now(), loaded: null, firstShown: null, posterSeen: false, samples: 0,
    };
    frame.addEventListener('load', () => { if (entry.loaded === null) entry.loaded = now(); });
    const sample = () => {
      if (!frame.isConnected) return;
      entry.samples += 1;
      const r = frame.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // The poster lets pointer input through, so hit-testing skips it; look for it directly.
      const poster = frame.parentElement && frame.parentElement.querySelector('img.web-poster');
      if (poster && getComputedStyle(poster).visibility !== 'hidden' && poster.getBoundingClientRect().width > 0) {
        entry.posterSeen = true;
      }
      if (top === frame && entry.firstShown === null) entry.firstShown = now();
      if (entry.firstShown === null) requestAnimationFrame(sample);
    };
    sample();
  };
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const frames = node.matches('iframe.web-frame') ? [node] : node.querySelectorAll('iframe.web-frame');
        frames.forEach(watch);
      }
    }
  }).observe(document, { childList: true, subtree: true });
})();`;

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let present: Cdp | null = null;

afterEach(async () => {
  present?.close();
  present = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

interface FrameLog {
  inserted: number;
  loaded: number | null;
  firstShown: number | null;
  posterSeen: boolean;
  samples: number;
}

describe.skipIf(!electronBinary)('a web element while presenting', () => {
  it('is not shown before its page has loaded, or before a page that holds readiness is laid out', {
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'web-element-reveal-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets', 'web'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(deckDir, 'assets', 'web', 'slow.html'), injectWebBridgeRuntime(SLOW_PAGE), 'utf8');
    await writeFile(join(deckDir, 'assets', 'web', 'slow.png'), Buffer.from(PNG, 'base64'));
    await writeFile(join(deckDir, 'assets', 'web', 'plain.html'), injectWebBridgeRuntime(PLAIN_PAGE), 'utf8');

    const deck = emptyDeck('Web reveal');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: 'web-slow', type: 'web', x: 80, y: 80, w: 840, h: 600, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, src: 'assets/web/slow.html', poster: 'assets/web/slow.png',
      interactive: true, title: 'Slow page',
    }, {
      id: 'web-plain', type: 'web', x: 1000, y: 80, w: 840, h: 600, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, src: 'assets/web/plain.html', poster: null,
      interactive: true, title: 'Plain page',
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}`;
    // A neutral page first, so the recorder is in place before the
    // presentation's own script runs.
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/api/decks`, profileDir);
    const target = await findTarget(browser.debugPort, (candidate) => candidate.url.includes('/api/decks'), browser.log);
    present = await Cdp.connect(target.webSocketDebuggerUrl!, { commandTimeoutMs: 30_000 });
    await present.call('Page.enable');
    await present.call('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });
    // A hidden page gets no animation frames; the recorder samples on them.
    await present.call('Page.bringToFront', {});
    await present.evaluate(`(location.href = ${JSON.stringify(url)}, null)`);

    const log = await eventually(async () => present!.evaluate<{
      frames: Record<string, FrameLog>; laidOut: number | null;
    } | null>('window.__reveal ?? null'),
    'both web pages were never shown',
    (value) => value?.frames.slow?.firstShown != null && value?.frames.plain?.firstShown != null);

    const slow = log!.frames.slow;
    const plain = log!.frames.plain;
    expect(plain.loaded, 'the plain page never loaded').not.toBeNull();
    expect(plain.firstShown!, 'the plain page was visible before it loaded')
      .toBeGreaterThanOrEqual(plain.loaded!);
    expect(slow.loaded, 'the slow page never loaded').not.toBeNull();
    expect(log!.laidOut, 'the slow page never finished laying itself out').not.toBeNull();
    expect(slow.firstShown!, 'the slow page was visible before it was laid out (it flashed its raw state)')
      .toBeGreaterThanOrEqual(log!.laidOut!);
    expect(slow.posterSeen, 'the poster did not stand in while the page initialised').toBe(true);
  });
});

describe.skipIf(electronBinary)('web element reveal (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
