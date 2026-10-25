import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { ANGLE_SNAP_DEGREES } from '../src/shared/geometry.js';
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
 * Props → Geometry → Rotate: Shift snaps the dial as it snaps the canvas.
 *
 * The canvas's own rotate gesture (Command/Control-drag a handle) snaps to
 * whole steps while Shift is held. The dial in the inspector turns the same
 * property, so the same hand on the same key has to give the same angle
 * there: a Shift-drag lands on a step, the step the canvas lands on for the
 * same direction, and a plain drag still turns freely. All of it through
 * real pointer input, Shift held as a modifier on the events, and read back
 * from the saved deck rather than the DOM.
 */
const DECK_ID = 'rotation-dial';
const PANEL = '#inspector';
const DIAL = `${PANEL} .geometry-row[data-row="rotate"] .angle-dial`;
/** The direction both gestures point at: 37° clockwise from the right. */
const AIM = 37;
const SNAPPED = Math.round(AIM / ANGLE_SNAP_DEGREES) * ANGLE_SNAP_DEGREES;
const SHIFT = 8;
const META = 4;

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

function box(id: string, x: number): Record<string, unknown> {
  return {
    id, type: 'shape', x, y: 340, w: 480, h: 300, rot: 0, z: 1,
    opacity: 1, class: [], style: {}, shape: 'rect', fill: '#dbe4ff', stroke: null,
    strokeWidth: 0, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
  };
}

describe.skipIf(!electronBinary)('snapping the rotation dial with Shift', () => {
  it('lands a Shift-drag on the canvas rotate gesture\'s step, and leaves a plain drag free', {
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'rotation-dial-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Rotation dial');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push(box('dialled', 200) as never, box('handled', 1200) as never);
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111827; }\n', 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Dial`, profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('#canvas [data-element-id="dialled"]'))`), 'the fixture never loaded');
    await editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');

    const savedRotation = async (id: string): Promise<number | undefined> => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      const live = await response.json() as Deck;
      return live.slides[0].elements.find((candidate) => candidate.id === id)?.rot;
    };
    const mouse = (type: string, x: number, y: number, modifiers = 0) => editor!.call('Input.dispatchMouseEvent', {
      type, x, y, modifiers, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });
    /** A point `radius` from `center`, `degrees` clockwise from the right, on screen. */
    const toward = (center: { x: number; y: number }, radius: number, degrees: number) => ({
      x: center.x + radius * Math.cos((degrees * Math.PI) / 180),
      y: center.y + radius * Math.sin((degrees * Math.PI) / 180),
    });

    // The dial says what Shift does, as the dial for a shadow does.
    await editor.click('#canvas [data-element-id="dialled"]', 'the dialled box');
    const dial = await eventually(async () => editor!.evaluate<{ x: number; y: number; r: number; title: string } | null>(`(() => {
      const node = document.querySelector('${DIAL}');
      if (!node) return null;
      node.scrollIntoView({ block: 'center' });
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, r: box.width / 2 - 3, title: node.title };
    })()`), 'Props → Geometry has no rotation dial', (found) => found !== null);
    expect(dial!.title).toContain('Shift');
    expect(dial!.title).toContain(`${ANGLE_SNAP_DEGREES}°`);

    // Grab the dial unshifted, then hold Shift on the way to the aim: the
    // snap follows the key mid-drag, as it does on the canvas.
    const start = toward(dial!, dial!.r, 0);
    const aim = toward(dial!, dial!.r, AIM);
    await mouse('mouseMoved', start.x, start.y);
    await mouse('mousePressed', start.x, start.y);
    await mouse('mouseMoved', (start.x + aim.x) / 2, (start.y + aim.y) / 2, SHIFT);
    await mouse('mouseMoved', aim.x, aim.y, SHIFT);
    await mouse('mouseReleased', aim.x, aim.y, SHIFT);
    await eventually(() => savedRotation('dialled'), 'a Shift-drag on the dial never landed on a step',
      (rot) => rot === SNAPPED);
    expect(await editor.evaluate<string>(`document.querySelector('${DIAL}').getAttribute('aria-valuenow')`))
      .toBe(String((360 - SNAPPED) % 360));

    // Soundness: without Shift the same drag turns freely, off the step.
    await mouse('mouseMoved', start.x, start.y);
    await mouse('mousePressed', start.x, start.y);
    await mouse('mouseMoved', aim.x, aim.y);
    await mouse('mouseReleased', aim.x, aim.y);
    const free = await eventually(() => savedRotation('dialled'), 'a plain drag on the dial never landed',
      (rot) => rot !== SNAPPED);
    expect(Math.abs(free! - AIM)).toBeLessThanOrEqual(3);
    expect(free! % ANGLE_SNAP_DEGREES).not.toBe(0);

    // The canvas gesture, Shift held, aimed the same way, lands on the same step.
    await editor.click('#canvas [data-element-id="handled"]', 'the handled box');
    const handle = await eventually(async () => editor!.evaluate<{ hx: number; hy: number; cx: number; cy: number; r: number } | null>(`(() => {
      const node = document.querySelector('#canvas .handle-e[data-element-id="handled"]')
        ?? document.querySelector('.handle-e[data-element-id="handled"]');
      const element = document.querySelector('#canvas [data-element-id="handled"]');
      if (!node || !element) return null;
      const h = node.getBoundingClientRect();
      const e = element.getBoundingClientRect();
      return { hx: h.left + h.width / 2, hy: h.top + h.height / 2,
        cx: e.left + e.width / 2, cy: e.top + e.height / 2, r: e.width / 2 };
    })()`), 'the handled box shows no east handle', (found) => found !== null);
    const centre = { x: handle!.cx, y: handle!.cy };
    const onCanvas = toward(centre, handle!.r, AIM);
    await mouse('mouseMoved', handle!.hx, handle!.hy, META);
    await mouse('mousePressed', handle!.hx, handle!.hy, META);
    await mouse('mouseMoved', (handle!.hx + onCanvas.x) / 2, (handle!.hy + onCanvas.y) / 2, META | SHIFT);
    await mouse('mouseMoved', onCanvas.x, onCanvas.y, META | SHIFT);
    await mouse('mouseReleased', onCanvas.x, onCanvas.y, META | SHIFT);
    await eventually(() => savedRotation('handled'), 'the canvas Shift-rotate landed somewhere else',
      (rot) => rot === SNAPPED);
  });
});
