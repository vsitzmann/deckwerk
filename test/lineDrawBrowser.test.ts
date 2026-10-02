import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  wait,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Line draw on an arrow, set up the way an author does it.
 *
 * Select the arrow, Build → Add animation, pick "line draw", present, click:
 * the arrow is visible at once but only partly drawn, and whole when its
 * time is up. The rest of this header describes the rectangle suite it was
 * copied from:
 *
 * Double-click a rectangle and type.
 *
 * The rectangle becomes a text box with the same fill, border and corners,
 * the caret is in it, and what is typed is the label — one object with the
 * shape's id, so it still drags, builds and morphs as the shape did. Props
 * then shows the box's fill and a shadow for its text.
 */
const DECK_ID = 'shape-text';
const BOX_ID = 'label-box';
const BOX = `#canvas [data-element-id="${BOX_ID}"]`;

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

describe.skipIf(!electronBinary)('line draw on an arrow', () => {
  it('is offered in the Build panel and draws the arrow in when presenting', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'line-draw-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const deck = emptyDeck('Line draw');
    deck.slides[0].elements.push({
      id: BOX_ID, type: 'shape', x: 200, y: 500, w: 1400, h: 2, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, shape: 'arrow', fill: null, stroke: '#111111',
      strokeWidth: 10, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: true,
    } as never);
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Draw`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('${BOX}'))`), 'no fixture');
    await editor.evaluate(`document.querySelector('#side-tabs button[data-panel="timeline"]')?.click()`);
    // Select the arrow the way the Build panel lists it, then add its animation.
    await editor.click(`.build-element-row[data-element-id="${BOX_ID}"]`, 'the arrow in the Build list');
    await editor.clickByText('button', 'Add animation', 'Add animation');
    const options = await editor.evaluate<string[]>(
      `[...document.querySelectorAll('.timeline-row select.build-action option')].map((o) => o.textContent)`);
    expect(options).toContain('line draw');
    await editor.choose('.timeline-row select.build-action', 'appear:draw', 'the action menu');
    const saved = async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return (await response.json() as Deck).slides[0].timeline[0]?.action;
    };
    await eventually(saved, 'line draw never reached the saved deck',
      (action) => action?.value === 'draw' && action.duration === 600);

    // Present it: the first click starts the draw.
    await editor.evaluate(`location.href = '/present.html?deck=${DECK_ID}&slide=1'`);
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('[data-element-id="${BOX_ID}"] svg line'))`), 'the presentation never came up');
    await wait(500);
    // Read the line on every frame in the page itself: a sample taken from
    // here at a fixed delay can miss a 600ms animation on a loaded machine.
    await editor.evaluate(`(() => {
      window.__x2 = [];
      const read = () => {
        const line = document.querySelector('[data-element-id="${BOX_ID}"] svg line');
        window.__x2.push(Number(line?.getAttribute('x2')));
        if (window.__x2.length < 600) requestAnimationFrame(read);
      };
      requestAnimationFrame(read);
    })()`);
    await editor.key('ArrowRight', 39);
    await eventually(async () => editor!.evaluate<number>(`Number(document.querySelector('[data-element-id="${BOX_ID}"] svg line').getAttribute('x2'))`),
      'the arrow never finished drawing', (x2) => x2 === 1400);
    const frames = await editor.evaluate<number[]>('window.__x2');
    // It grew through the middle on the way, rather than appearing whole.
    expect(frames.some((x2) => x2 > 0 && x2 < 1400)).toBe(true);
  });

  it('carries a bent arrow\'s head along the tip as the path draws', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'path-draw-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const deck = emptyDeck('Path draw');
    // An L-shaped arrow: right along the top, then down to its head at (400, 400).
    deck.slides[0].elements.push({
      id: BOX_ID, type: 'shape', x: 400, y: 300, w: 400, h: 400, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, shape: 'path', fill: null, stroke: '#111111',
      strokeWidth: 8, radius: 0, path: 'M 0 0 L 400 0 L 400 400', pathSize: { w: 400, h: 400 },
      arrowStart: false, arrowEnd: true,
    } as never);
    deck.slides[0].timeline.push({
      id: 'draw-1', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: BOX_ID, value: 'draw', duration: 1200 },
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}&slide=1`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const svg = `[data-element-id="${BOX_ID}"] svg`;
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('${svg} > path'))`), 'the presentation never came up');
    await wait(500);
    const state = () => editor!.evaluate<{ marker: string | null; heads: number; transform: string | null }>(`(() => {
      const paths = [...document.querySelectorAll('${svg} > path')];
      return {
        marker: paths[0].getAttribute('marker-end'),
        heads: paths.length - 1,
        transform: paths[1]?.getAttribute('transform') ?? null,
      };
    })()`);
    // Recorded on every frame in the page (see the straight arrow above).
    await editor.evaluate(`(() => {
      window.__heads = [];
      const read = () => {
        const paths = [...document.querySelectorAll('${svg} > path')];
        window.__heads.push({
          marker: paths[0].getAttribute('marker-end'),
          heads: paths.length - 1,
          transform: paths[1]?.getAttribute('transform') ?? null,
        });
        if (window.__heads.length < 600) requestAnimationFrame(read);
      };
      requestAnimationFrame(read);
    })()`);
    await editor.key('ArrowRight', 39);
    // Drawn: the ordinary marker is back and the travelling head is gone.
    const done = await eventually(state, 'the path never finished drawing',
      (now) => now.marker !== null && now.heads === 0);
    expect(done.marker).toMatch(/^url\(#arrowhead-/);
    const frames = await editor.evaluate<Array<{ marker: string | null; heads: number; transform: string | null }>>('window.__heads');
    // On the way: no marker at the far end, a head out on the top edge pointing right.
    const early = frames.find((frame) => {
      const match = frame.transform && /translate\(([-\d.]+) ([-\d.]+)\)/.exec(frame.transform);
      return match && Number(match[1]) > 0 && Number(match[1]) < 400;
    });
    expect(early).toBeDefined();
    expect(early!.marker).toBeNull();
    expect(early!.heads).toBe(1);
    const [x, y, angle] = /translate\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\)/.exec(early!.transform!)!.slice(1).map(Number);
    expect(y).toBeCloseTo(0, 0);
    expect(x).toBeGreaterThan(0);
    expect(angle).toBeCloseTo(0, 0);
  });
});
