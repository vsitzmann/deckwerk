import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
 * The colour picker's eyedropper in a browser without `EyeDropper` (Safari,
 * Firefox): the person shares a screen or window, one frame of it is shown
 * letterboxed with the loupe, and a click takes the pixel under the pointer.
 * The share is stubbed with a wide two-colour frame, so a click on either
 * half proves the pointer is mapped through the letterbox to the right pixel.
 */
const DECK_ID = 'eyedropper-share';
const LEFT = '#cc3322';
const RIGHT = '#2255aa';

const NO_EYEDROPPER = `(() => {
  Object.defineProperty(window, 'EyeDropper', { value: undefined, configurable: true });
  window.__shares = 0;
  window.__stopped = 0;
  navigator.mediaDevices.getDisplayMedia = async () => {
    window.__shares++;
    const frame = document.createElement('canvas');
    frame.width = 400;
    frame.height = 100;
    const paint = frame.getContext('2d');
    paint.fillStyle = '${LEFT}';
    paint.fillRect(0, 0, 200, 100);
    paint.fillStyle = '${RIGHT}';
    paint.fillRect(200, 0, 200, 100);
    const stream = frame.captureStream(30);
    for (const track of stream.getTracks()) {
      const stop = track.stop.bind(track);
      track.stop = () => { window.__stopped++; stop(); };
    }
    // Keep frames coming, as a real share does.
    const tick = () => { if (stream.active) { paint.fillRect(399, 99, 1, 1); requestAnimationFrame(tick); } };
    tick();
    return stream;
  };
})()`;

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

describe.skipIf(!electronBinary)('the eyedropper in a browser without EyeDropper', () => {
  it('picks from a shared frame into a shape fill, through the letterbox', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'eyedropper-share-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Eyedropper deck'));
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #ffffff; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });

    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Picker`, profileDir);
    const target = await findTarget(browser.debugPort, (t) => t.url.includes(`deck=${DECK_ID}`), browser.log);
    const cdp = editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await cdp.call('Page.enable');
    await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: NO_EYEDROPPER });
    await cdp.call('Page.reload');
    await eventually(async () => cdp.evaluate<boolean>('Boolean(window.store?.get().deck.slides.length)'),
      'the browser editor did not finish connecting');
    expect(await cdp.evaluate<boolean>('window.EyeDropper === undefined')).toBe(true);

    await eventually(async () => cdp.evaluate<boolean>(`(() => {
      const trigger = [...document.querySelectorAll('.shape-menu-trigger')]
        .find((node) => node.getBoundingClientRect().width > 0 && node.textContent?.trim() === 'Shape');
      trigger?.click();
      return Boolean(trigger);
    })()`), 'the toolbar never offered the Shape menu');
    await cdp.clickByText('.shape-menu-item', 'Rectangle', 'Rectangle');
    const shapeFill = () => cdp.evaluate<string | null>(`(() => {
      const node = [...document.querySelectorAll('#canvas [data-element-id^="shape"] svg rect')].at(-1);
      return node ? node.getAttribute('fill') : null;
    })()`);
    await eventually(shapeFill, 'no rectangle was inserted');

    const viewport = await cdp.evaluate<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
    const mouse = (type: string, x: number, y: number) => cdp.call('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
    const pickAt = async (x: number, y: number) => {
      // The inspector draws the selected shape's fields a moment after it is inserted.
      await eventually(async () => cdp.evaluate<boolean>(`(() => {
        const trigger = [...document.querySelectorAll('.field-color')]
          .find((field) => field.getBoundingClientRect().width > 0 && field.querySelector('span')?.textContent === 'Fill')
          ?.querySelector('.color-picker-trigger');
        trigger?.click();
        return Boolean(trigger);
      })()`), 'the inspector never showed a Fill colour field');
      await eventually(async () => cdp.evaluate<boolean>(
        `Boolean(document.querySelector('.color-picker-popover .color-picker-eyedropper'))`),
      'the colour picker offers no eyedropper without EyeDropper');
      await cdp.click('.color-picker-popover .color-picker-eyedropper', 'eyedropper');
      await eventually(async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('.eyedropper-overlay'))`),
        'the eyedropper never showed the shared frame');
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y);
      await mouse('mouseReleased', x, y);
      await eventually(async () => cdp.evaluate<boolean>(`!document.querySelector('.eyedropper-overlay')`),
        'the eyedropper never closed');
    };

    // The 4:1 frame fills the window's width and sits centred in its height.
    await pickAt(viewport.w * 0.25, viewport.h / 2);
    await eventually(async () => (await shapeFill())?.toLowerCase() === LEFT, 'the left half never became the fill');
    expect(await cdp.evaluate<string>(`document.querySelector('.color-picker-popover input[aria-label="Hex color"]').value`))
      .toBe(LEFT);

    await pickAt(viewport.w * 0.75, viewport.h / 2);
    await eventually(async () => (await shapeFill())?.toLowerCase() === RIGHT, 'the right half never became the fill');

    // One share per pick, each stopped as soon as its frame was taken.
    expect(await cdp.evaluate<{ shares: number; stopped: number }>('({ shares: __shares, stopped: __stopped })'))
      .toEqual({ shares: 2, stopped: 2 });
  });
});
