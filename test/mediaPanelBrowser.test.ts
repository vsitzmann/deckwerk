import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
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
import { writeMediaFixtures } from './support/mediaFixtures.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * The Media tab, end to end in the browser client against a real collab
 * server: open it, filter it, reveal a use, reuse a file by "+" and by a drag
 * onto the canvas, and move an unused file to the server's Trash (and back)
 * through the confirm dialog.
 */
const DECK_ID = 'media';

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;
let app: { process: import('node:child_process').ChildProcess } | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await stopBrowser(app?.process ?? null);
  app = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

const base = { rot: 0, z: 1, opacity: 1, class: [], style: {} };

async function buildDeck(deckDir: string): Promise<void> {
  const fixtures = await writeMediaFixtures(join(workDir, 'fixtures'), ['swatch.png', 'clip.mp4']);
  await mkdir(join(deckDir, 'assets', 'web'), { recursive: true });
  await copyFile(fixtures.get('swatch.png')!, join(deckDir, 'assets', 'swatch.png'));
  await copyFile(fixtures.get('clip.mp4')!, join(deckDir, 'assets', 'clip.mp4'));
  await copyFile(fixtures.get('swatch.png')!, join(deckDir, 'assets', 'web', 'chart.poster.png'));
  await writeFile(join(deckDir, 'assets', 'web', 'chart.html'), '<!doctype html><p>chart</p>');
  await writeFile(join(deckDir, 'assets', 'web', 'bunny.html'), '<!doctype html><p>model</p>');
  await writeFile(join(deckDir, 'assets', 'leftover.png'), 'nobody shows this');
  // Old enough not to count as an import still being written.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (const path of ['swatch.png', 'clip.mp4', 'leftover.png', 'web/chart.html', 'web/bunny.html', 'web/chart.poster.png']) {
    await utimes(join(deckDir, 'assets', path), old, old);
  }

  const deck = emptyDeck('Media');
  const slide = deck.slides[0];
  const image = (id: string, x: number): SlideElement => ({
    id, type: 'image', x, y: 100, w: 320, h: 240, ...base, src: 'assets/swatch.png', fit: 'contain', alt: '', sourceBox: null,
  } as SlideElement);
  const clip: SlideElement = {
    id: 'clip-1', type: 'video', x: 900, y: 500, w: 640, h: 480, ...base, src: 'assets/clip.mp4', fit: 'contain',
    autoplay: true, loop: true, muted: true, controls: false, start: 1, end: 3, poster: null, sourceBox: null,
  } as SlideElement;
  const chart: SlideElement = {
    id: 'chart-1', type: 'web', x: 100, y: 100, w: 1200, h: 600, ...base, src: 'assets/web/chart.html',
    poster: 'assets/web/chart.poster.png', interactive: true, title: 'Chart',
  } as SlideElement;
  const bunny: SlideElement = {
    id: 'bunny-1', type: 'web', x: 1300, y: 100, w: 500, h: 500, ...base, src: 'assets/web/bunny.html',
    poster: null, interactive: true, title: 'Bunny',
  } as SlideElement;
  deck.slides = [
    { ...slide, id: 's1', elements: [image('swatch-1', 100), clip] },
    { ...slide, id: 's2', elements: [chart] },
    { ...slide, id: 's3', elements: [image('swatch-3', 600), bunny] },
  ];
  await saveDeck(deckDir, deck);
}

describe.skipIf(!electronBinary)('the Media tab', () => {
  it('lists, filters, reveals, reuses and clears out the deck\'s media', { timeout: 180_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'media-panel-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(profileDir, { recursive: true });
    await buildDeck(deckDir);
    const clientDir = await collabClientDir();
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Media`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const cdp = editor;
    await eventually(async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('.canvas-host .stage'))`), 'no canvas');
    await eventually(async () => cdp.evaluate<number>(`document.querySelectorAll('#canvas [data-element-id]').length`),
      'deck never rendered', (count) => count >= 2);

    const saved = async (): Promise<Deck> => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return await response.json() as Deck;
    };
    const rows = () => cdp.evaluate<string[]>(`[...document.querySelectorAll('#media .media-item')].map((row) => row.dataset.mediaSrc)`);

    // --- open it like any other tab -------------------------------------------
    await cdp.clickByText('#side-tabs button', 'Media');
    await eventually(rows, 'the panel listed nothing', (srcs) => srcs.length === 4);
    expect(await rows()).toEqual(['assets/swatch.png', 'assets/clip.mp4', 'assets/web/chart.html', 'assets/web/bunny.html']);
    const swatch = await cdp.evaluate<{ meta: string; slides: string[] }>(`(() => {
      const row = document.querySelector('#media .media-item[data-media-src="assets/swatch.png"]');
      return { meta: row.querySelector('.media-meta').textContent, slides: [...row.querySelectorAll('.media-slide-link')].map((b) => b.textContent) };
    })()`);
    expect(swatch.slides).toEqual(['1', '3']);
    // Pixel size from the probe, file size from the listing.
    await eventually(() => cdp.evaluate<string>(`document.querySelector('#media .media-item[data-media-src="assets/swatch.png"] .media-meta').textContent`),
      'no size for the picture', (meta) => /64×48/.test(meta) && /B/.test(meta));
    await eventually(() => cdp.evaluate<string>(`document.querySelector('#media .media-item[data-media-src="assets/clip.mp4"] .media-meta').textContent`),
      'no duration for the clip', (meta) => /^Video · 64×48 · 0:0\d/.test(meta));
    // Posters for pages, a frozen frame for the video.
    expect(await cdp.evaluate<boolean>(`Boolean(document.querySelector('#media .media-item[data-media-src="assets/web/chart.html"] .media-thumb img'))`)).toBe(true);
    expect(await cdp.evaluate<string>(`document.querySelector('#media .media-item[data-media-src="assets/web/bunny.html"] .media-thumb').textContent`)).toBe('WEB');
    await eventually(() => cdp.evaluate<boolean>(`Boolean(document.querySelector('#media .media-item[data-media-src="assets/clip.mp4"] .media-thumb img'))`),
      'the video thumbnail never became a still');

    // --- filters ---------------------------------------------------------------
    await cdp.click('#media .segment-button[data-media-kind="video"]', 'Video filter');
    expect(await rows()).toEqual(['assets/clip.mp4']);
    await cdp.click('#media .segment-button[data-media-kind="web"]', 'Web filter');
    expect(await rows()).toEqual(['assets/web/chart.html', 'assets/web/bunny.html']);
    await cdp.click('#media .segment-button[data-media-kind="all"]', 'All filter');
    await cdp.click('#media .media-on-slide input', 'On this slide');
    expect(await rows()).toEqual(['assets/swatch.png', 'assets/clip.mp4']);
    await cdp.click('#media .media-on-slide input', 'On this slide');
    await cdp.typeInto('#media .media-search input', 'CHART', 'search');
    expect(await rows()).toEqual(['assets/web/chart.html']);
    await cdp.evaluate(`(() => { const input = document.querySelector('#media .media-search input'); input.value = ''; input.dispatchEvent(new Event('input')); })()`);
    expect(await rows()).toHaveLength(4);

    // --- reveal: slide 3, with its swatch selected ---------------------------------
    await cdp.click('#media .media-item[data-media-src="assets/swatch.png"] .media-slide-link[data-slide-index="2"]', 'slide 3 link');
    // One selection box, over swatch-3 (x 600, y 100).
    await eventually(() => cdp.evaluate<string[]>(`[...document.querySelectorAll('#canvas .sel-box')].map((box) => box.style.left + ',' + box.style.top)`),
      'reveal did not select the picture', (boxes) => boxes.join() === '600px,100px');
    expect(await cdp.evaluate<string>(`document.querySelector('#status').textContent`)).toMatch(/slide 3\/3.*1 selected/);

    // --- reuse with "+": natural aspect, centred on slide 3 -------------------------
    await cdp.click('#media .media-item[data-media-src="assets/swatch.png"] .media-add', 'add swatch');
    const afterAdd = await eventually(saved, 'the copy never reached the server',
      (deck) => deck.slides[2].elements.filter((el) => el.type === 'image').length === 2);
    const copy = afterAdd.slides[2].elements.find((el) => el.type === 'image' && el.id !== 'swatch-3')!;
    // 64×48 is smaller than 60% of the canvas: placed at its own pixel size.
    expect(copy).toMatchObject({ src: 'assets/swatch.png', w: 64, h: 48, x: 928, y: 516 });

    // --- reuse by dragging the clip onto the canvas ----------------------------------
    await cdp.evaluate(`(() => {
      const row = document.querySelector('#media .media-item[data-media-src="assets/clip.mp4"]');
      const transfer = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      const stage = document.querySelector('.canvas-host .stage').getBoundingClientRect();
      const host = document.querySelector('.canvas-host');
      const at = { clientX: stage.left + stage.width * 0.25, clientY: stage.top + stage.height * 0.5 };
      host.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, ...at }));
      host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, ...at }));
      row.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
    })()`);
    const afterDrop = await eventually(saved, 'the dropped clip never reached the server',
      (deck) => deck.slides[2].elements.some((el) => el.type === 'video'));
    const dropped = afterDrop.slides[2].elements.find((el) => el.type === 'video')!;
    if (dropped.type !== 'video') throw new Error('not a video');
    // Its one use is trimmed 1–3 s, so the copy plays the same cut; no crop.
    expect(dropped).toMatchObject({ src: 'assets/clip.mp4', start: 1, end: 3, sourceBox: null, w: 64, h: 48 });
    expect(dropped.x + dropped.w / 2).toBeCloseTo(480, -1);
    expect(dropped.y + dropped.h / 2).toBeCloseTo(540, -1);
    // The canvas's own file drop did not also run.
    expect(afterDrop.slides[2].elements.filter((el) => el.type === 'video')).toHaveLength(1);
    // The rows now count the new uses.
    await eventually(() => cdp.evaluate<string[]>(`[...document.querySelectorAll('#media .media-item[data-media-src="assets/clip.mp4"] .media-slide-link')].map((b) => b.textContent)`),
      'the clip row did not pick up slide 3', (slides) => slides.join() === '1,3');

    // --- unused files: listed with size, moved to the Trash after a confirm ---------
    await eventually(() => cdp.evaluate<string[]>(`[...document.querySelectorAll('#media .media-unused-item')].map((row) => row.dataset.assetPath)`),
      'the unused file was not listed', (paths) => paths.join() === 'assets/leftover.png');
    expect(await cdp.evaluate<string>(`document.querySelector('#media .media-unused .insp-subtitle-caption').textContent`)).toBe('1 file · 17 B');
    if (process.env.DECKWERK_TEST_SHOTS) {
      await cdp.evaluate(`document.documentElement.dataset.uiTheme = 'dark'`);
      await shoot(cdp, 'media-panel-dark');
    }

    await cdp.click('#media .media-trash', 'Move unused to Trash');
    const dialog = await eventually(() => cdp.evaluate<{ title: string; items: string[] } | null>(`(() => {
      const box = document.querySelector('.confirm-dialog');
      return box ? { title: box.querySelector('h2').textContent, items: [...box.querySelectorAll('.confirm-dialog-items li')].map((li) => li.textContent) } : null;
    })()`), 'no confirm dialog', (found) => found !== null);
    expect(dialog!.title).toBe("Move 1 unused file to the server's Trash?");
    expect(dialog!.items).toEqual(['assets/leftover.png  ·  17 B']);
    // Cancel first: nothing moves.
    await cdp.clickByText('.confirm-dialog button', 'Cancel');
    expect(existsSync(join(deckDir, 'assets', 'leftover.png'))).toBe(true);
    await cdp.click('#media .media-trash', 'Move unused to Trash');
    await eventually(() => cdp.evaluate<boolean>(`Boolean(document.querySelector('.confirm-dialog'))`), 'no confirm dialog');
    await cdp.clickByText('.confirm-dialog button', 'Move to Trash');
    await eventually(async () => !existsSync(join(deckDir, 'assets', 'leftover.png')), 'the file never moved');
    await eventually(() => cdp.evaluate<string>(`document.querySelector('#media .media-unused').textContent`),
      'the panel did not rescan', (text) => text.includes('Every file in assets/ is used'));
    expect(await cdp.evaluate<string>(`document.querySelector('#status').textContent`)).toMatch(/Moved 1 unused file \(17 B\) to the server's Trash/);
    // Everything in use is still there.
    for (const path of ['swatch.png', 'clip.mp4', 'web/chart.html', 'web/bunny.html', 'web/chart.poster.png']) {
      expect(existsSync(join(deckDir, 'assets', path))).toBe(true);
    }

    // The Trash lists it, and Restore puts it back.
    const trash = await (await fetch(`http://127.0.0.1:${server.port}/api/trash`)).json() as Array<{ id: string; kind: string; files: string[] }>;
    expect(trash).toEqual([expect.objectContaining({ kind: 'assets', files: ['assets/leftover.png'] })]);
    const restored = await fetch(`http://127.0.0.1:${server.port}/api/trash/restore?id=${trash[0].id}`, { method: 'POST' });
    expect(restored.ok).toBe(true);
    expect(await readFile(join(deckDir, 'assets', 'leftover.png'), 'utf8')).toBe('nobody shows this');

    // The server refuses a file the deck uses, whatever a client asks.
    const refused = await fetch(`http://127.0.0.1:${server.port}/api/deck-assets/trash?deck=${DECK_ID}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: ['assets/swatch.png', '../deck.json'] }),
    });
    expect(await refused.json()).toMatchObject({ moved: [], refused: [{ path: 'assets/swatch.png' }, { path: '../deck.json' }] });
    expect(existsSync(join(deckDir, 'assets', 'swatch.png'))).toBe(true);

    if (process.env.DECKWERK_TEST_SHOTS) {
      await cdp.click('#media .media-rescan', 'Rescan');
      await eventually(() => cdp.evaluate<number>(`document.querySelectorAll('#media .media-unused-item').length`), 'no rescan', (n) => n === 1);
      await cdp.evaluate(`document.documentElement.dataset.uiTheme = 'light'`);
      await shoot(cdp, 'media-panel-light');
    }
  });
});

describe.skipIf(!electronBinary)('the Media tab in the desktop app', () => {
  it('lists the deck folder over IPC and reuses a file by + and by drag', { timeout: 180_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'media-panel-desktop-'));
    const deckDir = join(workDir, 'deck');
    const appDir = join(workDir, 'app');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await buildDeck(deckDir);
    await materializeDesktopApp(appDir, 'deckwerk-media-panel-test');
    const running = await launchDesktopApp(appDir, [deckDir], { profileDir });
    app = running;
    const target = await findTarget(running.debugPort, isEditorTarget, running.log, 20_000);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const cdp = editor;
    await eventually(async () => cdp.evaluate<boolean>(`window.api.getDeck().then((session) => session?.dir === ${JSON.stringify(deckDir)}
      && document.querySelectorAll('#canvas [data-element-id]').length >= 2)`), 'the desktop editor did not open the deck');

    await cdp.clickByText('#side-tabs button', 'Media');
    await eventually(() => cdp.evaluate<number>(`document.querySelectorAll('#media .media-item').length`), 'nothing listed', (n) => n === 4);
    // Sizes come from the main process's listing, the picture's pixels from its probe.
    await eventually(() => cdp.evaluate<string>(`document.querySelector('#media .media-item[data-media-src="assets/swatch.png"] .media-meta').textContent`),
      'no size for the picture', (meta) => /64×48 · \d+ B/.test(meta));
    await eventually(() => cdp.evaluate<string[]>(`[...document.querySelectorAll('#media .media-unused-item')].map((row) => row.dataset.assetPath)`),
      'the unused file was not listed', (paths) => paths.join() === 'assets/leftover.png');
    expect(await cdp.evaluate<string>(`document.querySelector('#media .media-trash').textContent`)).toBe('Move unused to Trash…');
    // The confirm names the file; cancelled here, so the test never touches the real Trash.
    await cdp.click('#media .media-trash', 'Move unused to Trash');
    const items = await eventually(() => cdp.evaluate<string[]>(`[...document.querySelectorAll('.confirm-dialog-items li')].map((li) => li.textContent)`),
      'no confirm dialog', (found) => found.length > 0);
    expect(items).toEqual(['assets/leftover.png  ·  17 B']);
    await cdp.clickByText('.confirm-dialog button', 'Cancel');
    expect(existsSync(join(deckDir, 'assets', 'leftover.png'))).toBe(true);

    await cdp.click('#media .segment-button[data-media-kind="web"]', 'Web filter');
    expect(await cdp.evaluate<string[]>(`[...document.querySelectorAll('#media .media-item')].map((row) => row.dataset.mediaSrc)`))
      .toEqual(['assets/web/chart.html', 'assets/web/bunny.html']);
    // Slide 1 is current: "+" puts the page there at its own box size.
    await cdp.click('#media .media-item[data-media-src="assets/web/chart.html"] .media-add', 'add chart');
    await cdp.click('#media .segment-button[data-media-kind="all"]', 'All filter');
    await cdp.evaluate(`(() => {
      const row = document.querySelector('#media .media-item[data-media-src="assets/swatch.png"]');
      const transfer = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      const stage = document.querySelector('.canvas-host .stage').getBoundingClientRect();
      const at = { clientX: stage.left + stage.width * 0.75, clientY: stage.top + stage.height * 0.25 };
      document.querySelector('.canvas-host').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, ...at }));
    })()`);
    // Autosave carries both to disk.
    const onDisk = await eventually(async () => JSON.parse(await readFile(join(deckDir, 'deck.json'), 'utf8')) as Deck,
      'the new elements were never saved', (deck) => deck.slides[0].elements.length === 4, 30_000);
    const page = onDisk.slides[0].elements.find((el) => el.type === 'web')!;
    expect(page).toMatchObject({ src: 'assets/web/chart.html', w: 1200, h: 600, x: 360, y: 240, title: 'Chart', poster: 'assets/web/chart.poster.png' });
    const picture = onDisk.slides[0].elements.find((el) => el.type === 'image' && el.id !== 'swatch-1')!;
    expect(picture).toMatchObject({ src: 'assets/swatch.png', w: 64, h: 48 });
    expect(picture.x + picture.w / 2).toBeCloseTo(1440, -1);
    expect(picture.y + picture.h / 2).toBeCloseTo(270, -1);
  });
});

async function shoot(cdp: Cdp, name: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 600));
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
  await writeFile(join(process.env.DECKWERK_TEST_SHOTS!, `${name}.png`), Buffer.from(data, 'base64'));
}
