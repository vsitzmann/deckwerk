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
 * Pen ▾ → Pen, driven with real mouse and keyboard input in the
 * browser editor: corners by clicking, a smooth point by dragging, the shape
 * closed on its first point; then a second, open line finished with Return.
 * Both land in the saved deck as path shapes. Then the points of a path:
 * double-click it, drag a point, add one on the outline, delete one.
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

/** The browser editor on a fresh deck, and real input in slide coordinates. */
async function openEditor(deck: Deck) {
  workDir = await mkdtemp(join(tmpdir(), 'pen-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, DECK_ID);
  const clientDir = await collabClientDir();
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
  server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
  browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Pen`, profileDir);
  const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  const cdp = editor;
  await eventually(async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('#canvas .slide'))`), 'no slide');

  const shapes = async () => {
    const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
    return (await response.json() as Deck).slides[0].elements.filter((e): e is ShapeEl => e.type === 'shape');
  };
  // Slide coordinates to the screen.
  const stage = await cdp.evaluate<{ left: number; top: number; scale: number }>(`(() => {
    const slide = document.querySelector('#canvas .slide').getBoundingClientRect();
    return { left: slide.left, top: slide.top, scale: slide.width / 1920 };
  })()`);
  const at = (x: number, y: number) => ({ x: stage.left + x * stage.scale, y: stage.top + y * stage.scale });
  const mouse = (type: string, x: number, y: number, held = type === 'mousePressed', modifiers = 0) =>
    cdp.call('Input.dispatchMouseEvent', {
      type, ...at(x, y), button: type === 'mouseMoved' && !held ? 'none' : 'left',
      buttons: held ? 1 : 0, clickCount: 1, modifiers,
    });
  const click = async (x: number, y: number) => {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y);
  };
  const drag = async (from: [number, number], to: [number, number], modifiers = 0) => {
    await mouse('mouseMoved', ...from);
    await mouse('mousePressed', ...from, true, modifiers);
    await mouse('mouseMoved', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, true, modifiers);
    await mouse('mouseMoved', ...to, true, modifiers);
    await mouse('mouseReleased', ...to, false, modifiers);
  };
  const shot = async (name: string) => {
    if (!process.env.DECKWERK_TEST_SHOTS) return;
    const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
    await writeFile(join(process.env.DECKWERK_TEST_SHOTS, name), Buffer.from(data, 'base64'));
  };
  return { cdp, shapes, at, mouse, click, drag, shot };
}

describe.skipIf(!electronBinary)('drawing with the pen', () => {
  it('draws a closed curved shape and an open line', { timeout: 120_000 }, async () => {
    const { cdp, shapes, mouse, click, drag, shot } = await openEditor(emptyDeck('Pen'));
    const openPen = async () => {
      // Pen ▾ → Pen; the toolbar keeps a compact copy of its controls, so
      // open the visible one.
      await cdp.evaluate(`[...document.querySelectorAll('.pen-tool-menu')]
        .find((node) => node.getBoundingClientRect().width > 0)?.click()`);
      await cdp.click('.pen-tool-popover [data-drawing-tool="pen"]', 'Pen ▾ → Pen');
      await eventually(async () => cdp.evaluate<boolean>(
        `document.querySelector('.canvas-host')?.classList.contains('pen-tool') ?? false`,
      ), 'the pen never started');
    };

    await openPen();
    // A smooth point: press at 400,700 and drag the handle up to 400,500.
    await drag([400, 700], [400, 500]);
    await click(900, 700);
    await click(900, 900);
    await mouse('mouseMoved', 402, 702);
    expect(await cdp.evaluate<boolean>(`Boolean(document.querySelector('.path-anchor.closing'))`)).toBe(true);
    await shot('pen-drawing.png');
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
    await cdp.key('Enter', 13);
    const list = await eventually(shapes, 'the open line never reached the saved deck', (found) => found.length === 2);
    const line = list.find((shape) => shape.id !== closed.id)!;
    expect(line).toMatchObject({ shape: 'path', fill: null, x: 1100, y: 200, w: 400, h: 60, path: 'M 0 0 L 400 60' });
    expect(line.stroke).toBeTruthy();
    expect(await cdp.evaluate<boolean>(
      `document.querySelector('.canvas-host')?.classList.contains('pen-tool') ?? true`,
    )).toBe(false);
    await shot('pen-done.png');
  });

  it('edits the points of a path', { timeout: 120_000 }, async () => {
    const deck = emptyDeck('Points');
    deck.slides[0].elements = [{
      id: 'arch', type: 'shape', shape: 'path', x: 600, y: 300, w: 600, h: 400, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, fill: '#c96442', stroke: '#111111', strokeWidth: 4, radius: 0,
      path: 'M 0 400 C 0 0 600 0 600 400 Z', pathSize: { w: 600, h: 400 },
      arrowStart: false, arrowEnd: false,
    }];
    const { cdp, shapes, at, drag, click, shot } = await openEditor(deck);
    const arch = async () => (await shapes())[0];

    const centre = at(900, 600);
    await cdp.doubleClickAt(centre.x, centre.y);
    await eventually(async () => cdp.evaluate<number>(`document.querySelectorAll('.path-anchor').length`),
      'point editing never opened', (count) => count === 2);

    // Drag the right foot out and down.
    await drag([1200, 700], [1300, 800]);
    const moved = await eventually(arch, 'the point never moved', (el) => el.path !== 'M 0 400 C 0 0 600 0 600 400 Z');
    expect(pathOnCanvas(moved)![0].nodes[1]).toMatchObject({ x: 1300, y: 800, in: { x: 1300, y: 400 } });

    // Click the straight base, now running from 600,700 to 1300,800: a third point.
    await click(900, 743);
    const added = await eventually(arch, 'no point was added', (el) => pathOnCanvas(el)![0].nodes.length === 3);
    expect(added.fill).toBe('#c96442');
    await shot('points-editing.png');

    // Delete it again, then leave.
    await cdp.key('Delete', 46);
    await eventually(arch, 'the point was never deleted', (el) => pathOnCanvas(el)![0].nodes.length === 2);
    await cdp.key('Escape', 27);
    await eventually(async () => cdp.evaluate<number>(`document.querySelectorAll('.path-anchor').length`),
      'point editing never closed', (count) => count === 0);
    expect(await cdp.evaluate<number>(`document.querySelectorAll('.sel-box .handle-se').length`)).toBe(1);
  });
});
