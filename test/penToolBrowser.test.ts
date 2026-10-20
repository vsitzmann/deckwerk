import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck, type ShapeEl } from '../src/shared/deck.js';
import { pathOnCanvas } from '../src/shared/pathNodes.js';
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
 * Shape → Draw with Pen, driven with real mouse and keyboard input in the
 * browser editor: corners by clicking, a smooth point by dragging, the shape
 * closed on its first point; then a second, open line finished with Return.
 * Both land in the saved deck as path shapes.
 */
const DECK_ID = 'pen-tool';

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

describe.skipIf(!electronBinary)('drawing with the pen', () => {
  it('draws a closed curved shape and an open line', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'pen-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Pen'));
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Pen`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('.shape-menu-trigger'))`), 'no toolbar');

    const openPen = async () => {
      // The toolbar keeps a compact copy of its controls; open the visible one.
      await editor!.evaluate(`[...document.querySelectorAll('.shape-menu-trigger')]
        .find((node) => node.getBoundingClientRect().width > 0 && node.textContent?.trim() === 'Shape')?.click()`);
      await editor!.clickByText('.shape-menu-item', 'Draw with Pen', 'Draw with Pen');
      await eventually(async () => editor!.evaluate<boolean>(
        `document.querySelector('.canvas-host')?.classList.contains('pen-tool') ?? false`,
      ), 'the pen never started');
    };
    const shapes = async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return (await response.json() as Deck).slides[0].elements.filter((e): e is ShapeEl => e.type === 'shape');
    };
    // Slide coordinates to the screen.
    const stage = await editor.evaluate<{ left: number; top: number; scale: number }>(`(() => {
      const slide = document.querySelector('#canvas .slide').getBoundingClientRect();
      return { left: slide.left, top: slide.top, scale: slide.width / 1920 };
    })()`);
    const at = (x: number, y: number) => ({ x: stage.left + x * stage.scale, y: stage.top + y * stage.scale });
    const mouse = (type: string, p: { x: number; y: number }, buttons = type === 'mousePressed' ? 1 : 0) =>
      editor!.call('Input.dispatchMouseEvent', {
        type, x: p.x, y: p.y, button: type === 'mouseMoved' && buttons === 0 ? 'none' : 'left', buttons, clickCount: 1,
      });
    const click = async (x: number, y: number) => {
      await mouse('mouseMoved', at(x, y));
      await mouse('mousePressed', at(x, y));
      await mouse('mouseReleased', at(x, y));
    };

    await openPen();
    // A smooth point: press at 400,700 and drag the handle up to 400,500.
    await mouse('mouseMoved', at(400, 700));
    await mouse('mousePressed', at(400, 700));
    await mouse('mouseMoved', at(400, 650), 1);
    await mouse('mouseMoved', at(400, 500), 1);
    await mouse('mouseReleased', at(400, 500));
    await click(900, 700);
    await click(900, 900);
    await mouse('mouseMoved', at(402, 702));
    expect(await editor.evaluate<boolean>(`Boolean(document.querySelector('.path-anchor.closing'))`)).toBe(true);
    await click(402, 702);

    const [closed] = await eventually(shapes, 'the closed shape never reached the saved deck', (list) => list.length === 1);
    expect(closed).toMatchObject({ shape: 'path', stroke: null });
    expect(closed.fill).toBeTruthy();
    const [run] = pathOnCanvas(closed)!;
    expect(run.closed).toBe(true);
    expect(run.nodes.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })))
      .toEqual([{ x: 400, y: 700 }, { x: 900, y: 700 }, { x: 900, y: 900 }]);
    expect(Math.round(run.nodes[0].out!.y)).toBe(500);
    expect(Math.round(run.nodes[0].in!.y)).toBe(900);

    await openPen();
    await click(1100, 200);
    await click(1500, 260);
    await editor.key('Enter', 13);
    const list = await eventually(shapes, 'the open line never reached the saved deck', (found) => found.length === 2);
    const line = list.find((shape) => shape.id !== closed.id)!;
    expect(line).toMatchObject({ shape: 'path', fill: null, x: 1100, y: 200, w: 400, h: 60, path: 'M 0 0 L 400 60' });
    expect(line.stroke).toBeTruthy();
    expect(await editor.evaluate<boolean>(
      `document.querySelector('.canvas-host')?.classList.contains('pen-tool') ?? true`,
    )).toBe(false);

    if (process.env.DECKWERK_TEST_SHOTS) {
      const { data } = await editor.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile(join(process.env.DECKWERK_TEST_SHOTS, 'pen.png'), Buffer.from(data, 'base64'));
    }
  });
});
