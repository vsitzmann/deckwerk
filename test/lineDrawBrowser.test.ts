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
 * time is up, its head riding the tip of the line all the way. A bent path
 * arrow traces its outline the same way, carrying a copy of its head. A
 * filled shape drawn with the pen is outlined first, one run after another,
 * and coloured in only once its outline is complete.
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
      `[...document.querySelectorAll('.timeline-row select.build-action option')].map((o) => o.value)`);
    expect(options).toContain('appear:draw');
    // Named in the menu for what it does, under Appear.
    expect(await editor.evaluate<string>(
      `document.querySelector('.timeline-row select.build-action option[value="appear:draw"]').textContent`))
      .toBe('Line draw — traced from its start');
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
    // Read the head's tip on every frame in the page itself: a sample taken
    // from here at a fixed delay can miss a 600ms animation on a loaded
    // machine. A head's path starts at its tip.
    const tipX = `(() => {
      const head = document.querySelector('[data-element-id="${BOX_ID}"] svg path.arrowhead');
      const match = head && /^M (-?[\\d.]+)/.exec(head.getAttribute('d'));
      return match ? Number(match[1]) : -1;
    })()`;
    const lineX2 = `Number(document.querySelector('[data-element-id="${BOX_ID}"] svg line')?.getAttribute('x2'))`;
    await editor.evaluate(`(() => {
      window.__tips = [];
      const read = () => {
        window.__tips.push(${tipX});
        if (window.__tips.length < 600) requestAnimationFrame(read);
      };
      requestAnimationFrame(read);
    })()`);
    await editor.key('ArrowRight', 39);
    await eventually(async () => editor!.evaluate<number>(tipX),
      'the arrow never finished drawing', (x) => x === 1400);
    const frames = await editor.evaluate<number[]>('window.__tips');
    // It grew through the middle on the way, head first, rather than
    // appearing whole or with its head waiting at the far end.
    expect(frames.some((x) => x > 0 && x < 1400)).toBe(true);
    // And ends as the static arrow does: the line stops inside the head.
    const x2 = await editor.evaluate<number>(lineX2);
    expect(x2).toBeGreaterThan(1300);
    expect(x2).toBeLessThan(1400);
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
    // The head is drawn as a line's is: a path whose data starts at its tip,
    // then runs to one corner of its base.
    type Head = { heads: number; tip: number[] | null; corner: number[] | null };
    const read = `(() => {
      const heads = [...document.querySelectorAll('${svg} > path.arrowhead')];
      const numbers = heads[0]?.getAttribute('d')?.match(/-?[\\d.]+/g)?.map(Number) ?? null;
      return { heads: heads.length, tip: numbers ? numbers.slice(0, 2) : null, corner: numbers ? numbers.slice(2, 4) : null };
    })()`;
    const state = () => editor!.evaluate<Head>(read);
    // Recorded on every frame in the page (see the straight arrow above).
    await editor.evaluate(`(() => {
      window.__heads = [];
      const sample = () => {
        window.__heads.push(${read});
        if (window.__heads.length < 600) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    })()`);
    await editor.key('ArrowRight', 39);
    // Drawn: one head, its tip on the path's end.
    const done = await eventually(state, 'the path never finished drawing',
      (now) => now.heads === 1 && now.tip![0] === 400 && now.tip![1] === 400);
    expect(done.heads).toBe(1);
    const frames = await editor.evaluate<Head[]>('window.__heads');
    // On the way: a single head out on the top edge, pointing right.
    const early = frames.find((frame) => frame.tip && frame.tip[0] > 0 && frame.tip[0] < 380);
    expect(early).toBeDefined();
    expect(early!.heads).toBe(1);
    expect(early!.tip![1]).toBeCloseTo(0, 0);
    expect(early!.corner![0]).toBeLessThan(early!.tip![0]);
    // Never two heads, never one left behind at the far end while it draws.
    expect(frames.every((frame) => frame.heads <= 1)).toBe(true);
    expect(frames.filter((frame) => frame.tip && frame.tip[0] === 400 && frame.tip[1] === 400).length)
      .toBeLessThan(frames.length);
  });
  it('outlines a filled pen shape first, one run after another, and only then colours it in', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'fill-draw-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const deck = emptyDeck('Fill draw');
    // A frame with a hole, filled and with no stroke: the pen's closed shape.
    deck.slides[0].elements.push({
      id: BOX_ID, type: 'shape', x: 400, y: 300, w: 400, h: 400, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, shape: 'path', fill: '#c96442', stroke: null,
      strokeWidth: 2, radius: 0, pathSize: { w: 400, h: 400 }, arrowStart: false, arrowEnd: false,
      path: 'M 0 400 C 0 0 400 0 400 400 Z M 100 300 L 300 300 L 200 150 Z',
    } as never);
    deck.slides[0].timeline.push({
      id: 'draw-1', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: BOX_ID, value: 'draw', duration: 1500 },
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
    type Frame = { drawn: number[]; fill: string; traces: number };
    // How much of each run is drawn, and how far the fill is in, on every frame.
    const sample = `(() => {
      const shape = document.querySelector('${svg} > path:not(.draw-trace)');
      const traces = [...document.querySelectorAll('${svg} > .draw-trace')];
      return {
        traces: traces.length,
        fill: shape.style.fillOpacity,
        drawn: traces.map((trace) => trace.style.visibility === 'hidden' ? 0
          : 1 - Number(trace.style.strokeDashoffset) / trace.getTotalLength()),
      };
    })()`;
    await editor.evaluate(`(() => {
      window.__frames = [];
      const read = () => {
        window.__frames.push(${sample});
        if (window.__frames.length < 600) requestAnimationFrame(read);
      };
      requestAnimationFrame(read);
    })()`);
    await editor.key('ArrowRight', 39);
    await eventually(async () => editor!.evaluate<Frame>(sample), 'the shape never finished drawing',
      (frame) => frame.traces === 0 && frame.fill === '');
    const frames = (await editor.evaluate<Frame[]>('window.__frames')).filter((frame) => frame.traces === 2);
    // It was traced through the middle of each run, unfilled, the outer run first.
    expect(frames.some((frame) => frame.drawn[0] > 0.2 && frame.drawn[0] < 0.8 && frame.drawn[1] === 0
      && Number(frame.fill) === 0)).toBe(true);
    expect(frames.some((frame) => frame.drawn[0] > 0.99 && frame.drawn[1] > 0.2 && frame.drawn[1] < 0.8)).toBe(true);
    for (const frame of frames) {
      if (frame.drawn[1] > 0) expect(frame.drawn[0]).toBeGreaterThan(0.99);
      // No colour before the whole outline is there.
      if (Number(frame.fill) > 0) expect(Math.min(...frame.drawn)).toBeGreaterThan(0.99);
    }
    expect(frames.some((frame) => Number(frame.fill) > 0.2 && Number(frame.fill) < 0.9)).toBe(true);
  });
});
