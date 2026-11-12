import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
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
 * Text that runs past the slide edge must read on the pasteboard.
 *
 * The editor paints off-slide content so it can be found again, but the
 * pasteboard is near-black in the dark UI and light grey in the light one:
 * black body text dragged past the edge vanished into the first, white titles
 * into the second. The part outside the slide now takes the editor's text
 * colour, while the part on the slide keeps the deck's colour, because that
 * is what will be presented.
 *
 * Measured on screen pixels, through the real editor: a glyph's colour is only
 * what the compositor actually painted.
 */

const DECK_ID = 'offslide-text';
const noWindowManager = process.env.CI_NO_WINDOW_MANAGER === '1';

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

/** A row of solid blocks, so every sample lands on a glyph. */
const BLOCKS = '█'.repeat(30);

const text = (id: string, y: number, colour: string) => ({
  id, type: 'text' as const, x: 1500, y, w: 1000, h: 140, z: 1,
  valign: 'top' as const, align: 'left' as const, autoFit: false,
  html: `<span style="color: ${colour}">${BLOCKS}</span>`,
});

describe.skipIf(!electronBinary || noWindowManager)('off-slide text on the pasteboard', () => {
  it('recolours only the part past the edge, only when it would not read', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'offslide-text-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    // Each box starts 420px inside the 1920-wide slide and runs ~600px past it.
    const deck: Deck = parseDeck({
      ...emptyDeck('Off-slide text'),
      slides: [{
        id: 's1',
        name: 'One',
        elements: [
          text('dark', 200, '#111111'),
          text('light', 500, '#fafafa'),
          // Reads on both grounds: left as authored.
          text('red', 800, '#e00000'),
        ],
      }],
    });
    await saveDeck(deckDir, deck);
    await writeFile(
      join(deckDir, 'theme.css'),
      '.slide { background: #808080; }\n.element-text { font-size: 100px; line-height: 1.2; }\n',
      'utf8',
    );

    const clientDir = await collabClientDir();
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Pixel%20Browser`,
      profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (t) => t.url.includes(`deck=${DECK_ID}`) && !t.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const cdp = editor;

    await eventually(async () => cdp.evaluate<boolean>(`(() => Boolean(
      document.querySelector('#canvas .slide-layer [data-element-id="red"]')
    ))()`), 'the browser editor never finished painting the slide');

    const view = await cdp.evaluate<{ left: number; top: number; right: number; scale: number }>(`(() => {
      const stage = document.querySelector('#canvas .stage');
      const r = stage.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, scale: r.width / window.store.get().deck.canvas.w };
    })()`);
    const canvasRight = await cdp.evaluate<number>(
      "document.getElementById('canvas').getBoundingClientRect().right",
    );

    /** Mean luminance (0..255) of a small patch of screen, decoded by the page. */
    const luminanceAt = async (x: number, y: number): Promise<number> => {
      const shot = await cdp.call('Page.captureScreenshot', {
        format: 'png',
        clip: { x: x - 2, y: y - 2, width: 5, height: 5, scale: 1 },
        captureBeyondViewport: false,
      });
      return cdp.evaluate<number>(`(async () => {
        const image = new Image();
        image.src = 'data:image/png;base64,${shot.data}';
        await image.decode();
        const surface = document.createElement('canvas');
        surface.width = image.width;
        surface.height = image.height;
        const ctx = surface.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const { data } = ctx.getImageData(0, 0, image.width, image.height);
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        return sum / (data.length / 4);
      })()`);
    };
    /** The middle of a box's first line: inside the slide, and just past its right edge. */
    const samples = (y: number) => {
      const row = view.top + (y + 60) * view.scale;
      const outside = view.right + 10;
      expect(outside).toBeLessThan(canvasRight - 4);
      return { inside: { x: view.left + 1700 * view.scale, y: row }, outside: { x: outside, y: row } };
    };
    const setUiTheme = async (theme: 'dark' | 'light') => {
      await cdp.evaluate(`document.documentElement.dataset.uiTheme = ${JSON.stringify(theme)}`);
    };
    const paletteSettles = () => new Promise((resolve) => setTimeout(resolve, 300));

    // --- dark UI: near-black ground ----------------------------------------
    await setUiTheme('dark');
    await paletteSettles();
    const dark = samples(200);
    await eventually(async () => (await luminanceAt(dark.outside.x, dark.outside.y)) > 150,
      'black text past the slide edge stayed black on the dark pasteboard');
    // On the slide it is still the deck's black.
    expect(await luminanceAt(dark.inside.x, dark.inside.y)).toBeLessThan(40);
    // White text already reads on the dark ground and is left white.
    const light = samples(500);
    expect(await luminanceAt(light.outside.x, light.outside.y)).toBeGreaterThan(200);
    // Red reads on both grounds, so nothing is copied for it at all.
    const copied = await cdp.evaluate<number>(
      "document.querySelectorAll('#canvas .offslide-text-layer .element').length",
    );
    expect(copied).toBe(1);

    // --- light UI: light grey ground ---------------------------------------
    await setUiTheme('light');
    await eventually(async () => (await luminanceAt(light.outside.x, light.outside.y)) < 100,
      'white text past the slide edge stayed white on the light pasteboard');
    expect(await luminanceAt(light.inside.x, light.inside.y)).toBeGreaterThan(220);
    // The black text reads on the light ground again, as authored.
    expect(await luminanceAt(dark.outside.x, dark.outside.y)).toBeLessThan(40);

    // --- the copy is inert -------------------------------------------------
    // Clicking the recoloured glyphs selects the real element underneath.
    await cdp.clickAt(light.outside.x, light.outside.y);
    expect(await cdp.evaluate<string[]>('[...window.store.get().selection]')).toEqual(['light']);
    expect(await cdp.evaluate<number>(
      "document.querySelectorAll('#canvas .offslide-text-layer [data-element-id], #canvas .offslide-text-layer [contenteditable]').length",
    )).toBe(0);
  }, 180_000);
});

describe.skipIf(Boolean(electronBinary) && !noWindowManager)('off-slide text on the pasteboard (skipped)', () => {
  it('needs Electron and compositor frames for Page.captureScreenshot (absent under bare Xvfb)', () => {
    expect(true).toBe(true);
  });
});
