import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
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
 * Slide rail thumbnails keep a visible edge whatever the slide's colour: a
 * black slide on the dark rail and a white slide on the light one both get a
 * hairline that differs from the slide and from the rail around it.
 *
 * The stroke used to be an inset shadow on the thumbnail box, which the
 * rendered slide paints straight over, so it never showed. Only real pixels
 * catch that, so like canvasVisibilityBrowser this needs compositor frames
 * and skips under CI's bare Xvfb.
 */
const DECK_ID = 'rail-edge';
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

describe.skipIf(!electronBinary || noWindowManager)('slide rail thumbnail edges', () => {
  it('outlines a slide that matches the rail in both UI themes', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'rail-edge-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    // The first slide is current and outlined in the accent; probe the others.
    await saveDeck(deckDir, parseDeck({
      ...emptyDeck('Rail edges'),
      slides: ['#808080', '#000000', '#ffffff'].map((color, i) => ({
        id: `s${i}`, name: `S${i}`, background: { color, image: null }, elements: [],
      })),
    }));
    server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Rail`, profileDir);
    const target = await findTarget(browser.debugPort, (t) => t.url.includes(`deck=${DECK_ID}`) && !t.url.includes('present.html'), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<number>(`document.querySelectorAll('#rail .rail-thumb .slide').length`),
      'the rail never drew its thumbnails', (count) => count === 3);

    /** Luminance of each pixel along one screen row, decoded by the page itself. */
    const rowLuminance = async (x: number, y: number, width: number): Promise<number[]> => {
      const shot = await editor!.call('Page.captureScreenshot', {
        format: 'png',
        clip: { x, y, width, height: 1, scale: 1 },
      });
      return editor!.evaluate<number[]>(`(async () => {
        const image = new Image();
        image.src = 'data:image/png;base64,${shot.data}';
        await image.decode();
        const surface = document.createElement('canvas');
        surface.width = image.width;
        surface.height = image.height;
        const ctx = surface.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const px = ctx.getImageData(0, 0, image.width, 1).data;
        const out = [];
        for (let i = 0; i < px.length; i += 4) out.push(Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]));
        return out;
      })()`);
    };
    /** Rail, then the thumbnail's left edge, then the slide, along one row. */
    const expectEdge = async (theme: string, index: number): Promise<void> => {
      await editor!.evaluate(`document.documentElement.dataset.uiTheme = '${theme}'`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const { left, y } = await editor!.evaluate<{ left: number; y: number }>(`(() => {
        const r = document.querySelectorAll('#rail .rail-thumb')[${index}].getBoundingClientRect();
        return { left: Math.round(r.left), y: Math.floor(r.top + r.height * 0.75) };
      })()`);
      const row = await rowLuminance(left - 5, y, 12);
      const [rail, edge, fill] = [row[0], row[5], row[11]];
      expect(Math.abs(edge - fill), `${theme} rail: edge against the slide (${row})`).toBeGreaterThan(20);
      expect(Math.abs(edge - rail), `${theme} rail: edge against the rail (${row})`).toBeGreaterThan(20);
    };
    await expectEdge('dark', 1);
    await expectEdge('light', 2);
  });
});

describe.skipIf(Boolean(electronBinary) && !noWindowManager)('slide rail thumbnail edges (skipped)', () => {
  it('needs Electron and compositor frames for Page.captureScreenshot (absent under bare Xvfb)', () => {
    expect(!electronBinary || noWindowManager).toBe(true);
  });
});
