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
  wait,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * The Build panel's Preview, in both editors.
 *
 * A box dissolves in on the first click with a label alongside it. Select the
 * box, press Preview: the presentation's player plays that click over the
 * slide, at the slide's own place and size, the box fading up through the
 * values between nothing and full; then the editing view is back exactly as
 * it was -- same selection, same place, no undo entry. A click on the canvas
 * and Escape each end a preview early, without selecting anything.
 */
const BOX = 'box';
const LABEL = 'label';
const DISSOLVE_MS = 1500;

function fixture() {
  const deck = emptyDeck('Build preview');
  deck.slides[0].elements.push(
    { id: BOX, type: 'shape', shape: 'rect', x: 560, y: 340, w: 800, h: 400, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, fill: '#2255cc', stroke: null, strokeWidth: 0,
      radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false },
    { id: LABEL, type: 'text', x: 160, y: 120, w: 1600, h: 140, rot: 0, z: 2,
      opacity: 1, class: [], style: {}, html: 'Revealed', align: 'left', valign: 'top' },
  );
  deck.slides[0].timeline.push(
    { id: 't-box', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: BOX, value: 'dissolve', duration: DISSOLVE_MS } },
    { id: 't-label', trigger: { on: 'withPrev', ref: null, delay: 0 },
      action: { type: 'appear', target: LABEL, value: null } },
  );
  return deck;
}

async function writeFixture(deckDir: string): Promise<void> {
  await mkdir(deckDir, { recursive: true });
  await saveDeck(deckDir, fixture() as never);
  await writeFile(join(deckDir, 'theme.css'),
    '.slide { background: #fff; color: #111; font: 64px Arial, sans-serif; }\n', 'utf8');
}

/** What the editing view looks like: compared before and after a preview. */
const editingView = `(() => {
  const stage = document.querySelector('#canvas > .stage').getBoundingClientRect();
  return {
    stage: [stage.left, stage.top, stage.width, stage.height].map(Math.round),
    selected: [...document.querySelectorAll('.build-element-row.selected')].map((row) => row.dataset.elementId),
    handles: document.querySelectorAll('#canvas .overlay-layer .handle').length,
    layers: [...document.querySelectorAll('#canvas > .stage > *')].map((layer) => getComputedStyle(layer).opacity),
    previewing: document.querySelector('#canvas').classList.contains('build-previewing'),
    shield: Boolean(document.querySelector('.build-preview-shield')),
  };
})()`;

async function exercise(cdp: Cdp): Promise<void> {
  await eventually(async () => cdp.evaluate<boolean>(
    `Boolean(document.querySelector('#canvas [data-element-id="${BOX}"]'))`), 'no fixture');
  await cdp.evaluate(`document.querySelector('#side-tabs button[data-panel="timeline"]')?.click()`);
  await cdp.click(`.build-element-row[data-element-id="${BOX}"]`, 'the box in the Build list');
  await eventually(async () => cdp.evaluate<number>(
    `document.querySelectorAll('#canvas .overlay-layer .handle').length`), 'the box never selected', (n) => n > 0);
  const before = await cdp.evaluate<Record<string, unknown>>(editingView);
  expect(before.previewing).toBe(false);

  // Sample the previewed box's opacity off the page's own clock: a sample
  // taken from here at a fixed delay can miss the middle of the fade.
  await cdp.evaluate(`(() => {
    window.__preview = { opacities: [], frames: [] };
    const sample = () => {
      const frame = document.querySelector('.build-preview-frame');
      const box = frame?.querySelector('[data-element-id="${BOX}"]');
      const label = frame?.querySelector('[data-element-id="${LABEL}"]');
      if (box) {
        window.__preview.opacities.push(Number(getComputedStyle(box).opacity)
          * (getComputedStyle(box).visibility === 'visible' ? 1 : 0));
        window.__preview.label = getComputedStyle(label).visibility;
        const r = frame.getBoundingClientRect();
        window.__preview.frames.push([r.left, r.top, r.width, r.height].map(Math.round));
      }
      if (window.__preview.opacities.length < 2000) setTimeout(sample, 10);
    };
    sample();
  })()`);
  await cdp.click('.build-preview', 'Preview');
  expect(await cdp.evaluate<string>(`document.querySelector('.build-preview .build-preview-label').textContent`)).toBe('Stop');
  expect(await cdp.evaluate<boolean>(`document.querySelector('#canvas').classList.contains('build-previewing')`))
    .toBe(true);
  // It ends by itself once the dissolve and a short pause are over.
  await eventually(async () => cdp.evaluate<string>(`document.querySelector('.build-preview .build-preview-label').textContent`),
    'the preview never ended', (label) => label === 'Preview');
  const sampled = await cdp.evaluate<{ opacities: number[]; frames: number[][]; label: string }>(
    'window.__preview');
  // The box faded up through the middle rather than appearing at once, and
  // the label that comes with it was there too.
  expect(sampled.opacities.some((o) => o > 0.1 && o < 0.9)).toBe(true);
  expect(sampled.opacities.at(-1)).toBe(1);
  expect(sampled.label).toBe('visible');
  // Laid exactly over the edited slide.
  expect(sampled.frames[0]).toEqual(before.stage);
  // And the editing view is back as it was, with nothing to undo.
  expect(await cdp.evaluate(editingView)).toEqual(before);

  // A click on the canvas ends a preview early and selects nothing.
  await cdp.click('.build-preview', 'Preview');
  await wait(200);
  const [x, y] = before.stage as number[];
  await cdp.clickAt(x + 20, y + 20);
  await eventually(async () => cdp.evaluate<boolean>(`!document.querySelector('.build-preview-shield')`),
    'a click did not end the preview');
  await wait(200);
  expect(await cdp.evaluate(editingView)).toEqual(before);

  // So does Escape, which the editor would otherwise take as "deselect".
  await cdp.click('.build-preview-slide', 'Play slide');
  await wait(200);
  await cdp.key('Escape', 27);
  await eventually(async () => cdp.evaluate<boolean>(`!document.querySelector('.build-preview-shield')`),
    'Escape did not end the preview');
  expect(await cdp.evaluate(editingView)).toEqual(before);

  await cdp.evaluate(`document.querySelector('#side-tabs button[data-panel="history"]')?.click()`);
  expect(await cdp.evaluate<boolean>(`Boolean(document.querySelector('#history .history-empty'))`)).toBe(true);
}

let workDir = '';
let server: RunningCollabServer | null = null;
let child: RunningBrowser['process'] | null = null;
let cdp: Cdp | null = null;

afterEach(async () => {
  cdp?.close();
  cdp = null;
  await stopBrowser(child);
  child = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('Build panel preview', () => {
  it('plays a build in place and restores the canvas in the browser editor', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'build-preview-web-'));
    const decksRoot = join(workDir, 'decks');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await writeFixture(join(decksRoot, 'preview'));
    server = await startCollabServer({
      rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0,
    });
    const browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=preview&name=Preview`, profileDir);
    child = browser.process;
    const target = await findTarget(browser.debugPort, (c) => c.url.includes('deck=preview'), browser.log);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    await exercise(cdp);
  });

  it('plays a build in place and restores the canvas in the desktop app', { timeout: 180_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'build-preview-desktop-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await materializeDesktopApp(appDir, 'deckwerk-build-preview-test');
    await writeFixture(deckDir);
    const app = await launchDesktopApp(appDir, [deckDir], { profileDir });
    child = app.process;
    const target = await findTarget(app.debugPort, isEditorTarget, app.log, 20_000);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    await cdp.call('Page.bringToFront');
    await exercise(cdp);
  });
});
