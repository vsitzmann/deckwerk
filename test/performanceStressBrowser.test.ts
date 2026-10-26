import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDeckHistory, saveDeckHistory } from '../src/main/deckHistoryStore.js';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck, parseDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
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
 * Opt-in, real-runtime performance gates.
 *
 * These are deliberately absent from the ordinary correctness suite: they
 * generate 6K stills and 4K video, launch Electron, bind localhost, force GC,
 * and exercise the 200-entry history ceiling against hundreds of slides.
 * Run with `npm run test:performance`; budget environment variables are
 * documented in docs/performance-testing.md.
 */

const RUN_PERFORMANCE = process.env.RUN_PERFORMANCE_STRESS === '1';
const execFileAsync = promisify(execFile);
const DECK_ID = 'performance-stress';
const IMAGE_A = 'assets/large-a.11111111.jpeg';
const IMAGE_B = 'assets/large-b.22222222.jpeg';
const VIDEO = 'assets/large-video.33333333.mp4';

const ffmpeg = (() => {
  try {
    return createRequire(import.meta.url)('ffmpeg-static') as string;
  } catch {
    return '';
  }
})();

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;
let speaker: Cdp | null = null;

afterEach(async () => {
  speaker?.close();
  speaker = null;
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

const budget = (name: string, fallback: number): number => {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured > 0 ? configured : fallback;
};

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function textElement(index: number): SlideElement {
  return {
    id: `title-${index}`, type: 'text',
    x: 80, y: 40, w: 1760, h: 130, rot: 0, z: 3, opacity: 1,
    class: ['role-title'], style: {}, html: `Synthetic media slide ${index + 1}`,
    align: 'center', valign: 'middle',
  } as SlideElement;
}

function imageElement(index: number): SlideElement {
  return {
    id: `image-${index}`, type: 'image',
    x: 70, y: 210, w: 820, h: 700, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: index % 2 === 0 ? IMAGE_A : IMAGE_B,
    fit: 'cover', alt: `Synthetic 6000 by 4000 raster ${index % 2 + 1}`,
    sourceBox: null,
  } as SlideElement;
}

function videoElement(index: number): SlideElement {
  return {
    id: `video-${index}`, type: 'video',
    x: 960, y: 210, w: 890, h: 700, rot: 0, z: 2, opacity: 1,
    class: [], style: {}, src: VIDEO, fit: 'cover',
    autoplay: false, loop: true, muted: true, controls: false,
    start: index % 2 === 0 ? 0 : 2, end: null, poster: null, sourceBox: null,
  } as SlideElement;
}

function syntheticMediaDeck(slideCount: number): Deck {
  const deck = emptyDeck('Synthetic performance stress');
  const base = deck.slides[0];
  deck.slides = Array.from({ length: slideCount }, (_, index) => ({
    ...structuredClone(base),
    id: `perf-slide-${index}`,
    name: `Performance ${index + 1}`,
    background: { color: index % 2 === 0 ? '#f8fafc' : '#eef2ff', image: null },
    elements: [textElement(index), imageElement(index), videoElement(index)],
  }));
  return parseDeck(deck);
}

interface NavigationSample {
  duration: number;
  slideIndex: number;
  imageReady: boolean;
  videoReady: boolean;
}

interface RuntimeMemory {
  usedSize: number;
  totalSize: number;
}

interface DomCounters {
  documents: number;
  nodes: number;
  jsEventListeners: number;
}

describe.skipIf(!RUN_PERFORMANCE)('large-deck performance stress', () => {
  it.skipIf(!electronBinary || !ffmpeg)(
    'keeps 1,000 media-heavy slides responsive and resource-bounded in Electron',
    async () => {
      workDir = await mkdtemp(join(tmpdir(), 'deckwerk-performance-'));
      const decksRoot = join(workDir, 'decks');
      const deckDir = join(decksRoot, DECK_ID);
      const assetsDir = join(deckDir, 'assets');
      const profileDir = join(workDir, 'electron-profile');
      await mkdir(assetsDir, { recursive: true });
      await mkdir(profileDir, { recursive: true });

      // Two distinct 24 MP JPEGs force real decode/adoption work on every
      // forward step. The 4K clip alternates between two in-points so the
      // canvas also has to retain two compatible decoded video presentations.
      await execFileAsync(ffmpeg, [
        '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=6000x4000:rate=1',
        '-frames:v', '1', '-q:v', '2', join(assetsDir, 'large-a.11111111.jpeg'),
      ]);
      await execFileAsync(ffmpeg, [
        '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'smptebars=size=6000x4000:rate=1',
        '-frames:v', '1', '-q:v', '2', join(assetsDir, 'large-b.22222222.jpeg'),
      ]);
      await execFileAsync(ffmpeg, [
        '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30',
        '-t', '6', '-an', '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8M',
        join(assetsDir, 'large-video.33333333.mp4'),
      ]);
      for (let index = 0; index < 6; index += 1) {
        await copyFile(
          join(assetsDir, index % 2 === 0 ? 'large-a.11111111.jpeg' : 'large-b.22222222.jpeg'),
          join(assetsDir, `wall-${index}.4444444${index}.jpeg`),
        );
      }

      const [imageAStat, imageBStat, videoStat] = await Promise.all([
        stat(join(assetsDir, 'large-a.11111111.jpeg')),
        stat(join(assetsDir, 'large-b.22222222.jpeg')),
        stat(join(assetsDir, 'large-video.33333333.mp4')),
      ]);
      expect(imageAStat.size).toBeGreaterThan(500_000);
      expect(imageBStat.size).toBeGreaterThan(100_000);
      expect(videoStat.size).toBeGreaterThan(2_000_000);

      const deck = syntheticMediaDeck(1_000);
      // Every slide uses a distinct presentation key even though the bytes are
      // shared. This catches globally-unbounded decoded-video pools, which a
      // repeated two-key fixture cannot expose.
      deck.slides.forEach((slide, index) => {
        const video = slide.elements.find((element) => element.type === 'video');
        if (video?.type === 'video') video.start = (index % 180) * 0.03;
      });
      // The first measured target is a six-image 144 MP wall. Lookahead must
      // decode sequentially and stop at the 48 MP retention budget.
      deck.slides[451].elements = [
        textElement(451),
        ...Array.from({ length: 6 }, (_, index) => ({
          ...imageElement(451),
          id: `wall-image-${index}`,
          src: `assets/wall-${index}.4444444${index}.jpeg`,
          x: 40 + (index % 3) * 620,
          y: 190 + Math.floor(index / 3) * 410,
          w: 590,
          h: 380,
        } as SlideElement)),
        videoElement(451),
      ];
      await saveDeck(deckDir, deck);
      await writeFile(join(deckDir, 'theme.css'), [
        '.slide { color: #111827; }',
        '.role-title { font: 700 58px/1.1 sans-serif; }',
        '',
      ].join('\n'), 'utf8');

      const clientDir = await collabClientDir();
      server = await startCollabServer({
        rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
      });
      const loadStarted = performance.now();
      browser = await launchBrowser(
        `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Performance%20Stress`,
        profileDir,
      );
      const target = await findTarget(
        browser.debugPort,
        (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
        browser.log,
        30_000,
      );
      editor = await Cdp.connect(target.webSocketDebuggerUrl!);

      await eventually(async () => editor!.evaluate<number>(
        `window.store?.get()?.deck?.slides?.length ?? 0`,
      ), 'the 1,000-slide fixture did not open', (count) => count === 1_000, 90_000);
      const loadMs = performance.now() - loadStarted;
      expect(loadMs).toBeLessThan(budget('PERF_DECK_LOAD_BUDGET_MS', 60_000));

      await editor.evaluate(`(() => {
        window.store.selectSlide(450);
        document.getElementById('rail')?.focus({ preventScroll: true });
        return true;
      })()`);
      await eventually(async () => editor!.evaluate<{
        index: number;
        imageReady: boolean;
        imageWidth: number;
        videoReady: boolean;
        videoWidth: number;
      }>(`(() => {
        const image = document.querySelector('#canvas img');
        const video = document.querySelector('#canvas video');
        return {
          index: window.store.get().slideIndex,
          imageReady: Boolean(image?.complete && image.naturalWidth > 0),
          imageWidth: image?.naturalWidth ?? 0,
          videoReady: Boolean(video && video.readyState >= 2 && !video.seeking),
          videoWidth: video?.videoWidth ?? 0,
        };
      })()`), 'the middle media slide did not settle', (state) =>
        state.index === 450
          && state.imageReady && state.imageWidth === 6_000
          && state.videoReady && state.videoWidth === 3_840, 90_000);

      // Give the editor's one-slide image lookahead an idle period before the
      // first measured ArrowDown, matching a user reading the current slide.
      await editor.evaluate(`new Promise((resolve) => {
        const done = () => setTimeout(resolve, 500);
        if (typeof requestIdleCallback === 'function') requestIdleCallback(done, { timeout: 1500 });
        else setTimeout(done, 750);
      })`);
      const warmedImageCount = await editor.evaluate<number>(
        `window.canvas?.warmedImages?.size ?? -1`,
      );
      expect(warmedImageCount).toBeGreaterThan(0);
      expect(warmedImageCount).toBeLessThanOrEqual(2);
      await editor.evaluate(`(() => {
        window.__navigationPerformance = { samples: [], longTasks: [] };
        try {
          const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              window.__navigationPerformance.longTasks.push(entry.duration);
            }
          });
          observer.observe({ entryTypes: ['longtask'] });
          window.__navigationPerformance.observer = observer;
        } catch {}
        document.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowDown' || document.activeElement?.id !== 'rail') return;
          const started = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const image = document.querySelector('#canvas img');
            const video = document.querySelector('#canvas video');
            window.__navigationPerformance.samples.push({
              duration: performance.now() - started,
              slideIndex: window.store.get().slideIndex,
              imageReady: Boolean(image?.complete && image.naturalWidth > 0),
              videoReady: Boolean(video && video.readyState >= 2 && !video.seeking),
            });
          }));
        }, true);
        return true;
      })()`);

      await editor.call('HeapProfiler.enable');
      await editor.call('HeapProfiler.collectGarbage');
      const heapBefore = await editor.call('Runtime.getHeapUsage') as RuntimeMemory;
      const domBefore = await editor.call('Memory.getDOMCounters') as DomCounters;
      const resourcesBefore = await editor.evaluate<{
        connectedVideos: number;
        railCachedThumbs: number;
        railCachedVideos: number;
      }>(`(() => ({
        connectedVideos: document.querySelectorAll('video').length,
        railCachedThumbs: window.rail?.thumbCache?.size ?? -1,
        railCachedVideos: window.rail?.thumbCache
          ? [...window.rail.thumbCache.values()].reduce((sum, thumb) => sum + thumb.querySelectorAll('video').length, 0)
          : -1,
      }))()`);

      const navigationCount = 60;
      for (let step = 0; step < navigationCount; step += 1) {
        await editor.key('ArrowDown', 40);
        await eventually(async () => editor!.evaluate<number>(
          `window.__navigationPerformance.samples.length`,
        ), `navigation sample ${step + 1} did not paint`, (count) => count === step + 1, 10_000);
      }

      // `removeAttribute('src'); load()` releases media resources through
      // Chromium's asynchronous pipeline. Measure the retained steady state,
      // not internal nodes already queued for destruction on the media thread.
      await editor.evaluate(`new Promise((resolve) => setTimeout(resolve, 1500))`);
      await editor.call('HeapProfiler.collectGarbage');
      const heapAfter = await editor.call('Runtime.getHeapUsage') as RuntimeMemory;
      const domAfter = await editor.call('Memory.getDOMCounters') as DomCounters;
      const navigation = await editor.evaluate<{
        samples: NavigationSample[];
        longTasks: number[];
        railItems: number;
        mountedThumbs: number;
        pooledVideos: number;
        connectedVideos: number;
        railCachedThumbs: number;
        railCachedVideos: number;
      }>(`(() => ({
        samples: window.__navigationPerformance.samples,
        longTasks: window.__navigationPerformance.longTasks,
        railItems: document.querySelectorAll('.rail-item').length,
        mountedThumbs: document.querySelectorAll('.rail-thumb-inner').length,
        pooledVideos: window.canvas?.videoPool?.size ?? -1,
        connectedVideos: document.querySelectorAll('video').length,
        railCachedThumbs: window.rail?.thumbCache?.size ?? -1,
        railCachedVideos: window.rail?.thumbCache
          ? [...window.rail.thumbCache.values()].reduce((sum, thumb) => sum + thumb.querySelectorAll('video').length, 0)
          : -1,
      }))()`);

      expect(navigation.samples).toHaveLength(navigationCount);
      expect(navigation.samples[0].slideIndex).toBe(451);
      expect(navigation.samples.at(-1)?.slideIndex).toBe(450 + navigationCount);
      expect(navigation.samples[0].imageReady, 'the first warmed 24 MP image missed first paint')
        .toBe(true);
      expect(navigation.samples.slice(5).every((sample) => sample.imageReady)).toBe(true);
      expect(navigation.railItems).toBe(1_000);
      expect(navigation.mountedThumbs).toBeLessThan(60);
      expect(navigation.pooledVideos).toBeGreaterThanOrEqual(0);
      expect(navigation.pooledVideos).toBeLessThanOrEqual(16);
      expect(navigation.connectedVideos).toBeLessThanOrEqual(24);
      expect(navigation.railCachedThumbs).toBeLessThanOrEqual(40);
      expect(navigation.railCachedVideos).toBeLessThanOrEqual(24);

      const steady = navigation.samples.slice(5).map((sample) => sample.duration);
      const firstNavigationMs = navigation.samples[0].duration;
      const navigationP95Ms = percentile(steady, 0.95);
      const navigationMaxMs = Math.max(...steady);
      const longTaskMaxMs = Math.max(0, ...navigation.longTasks);
      const heapGrowthBytes = Math.max(0, heapAfter.usedSize - heapBefore.usedSize);
      const domNodeGrowth = Math.max(0, domAfter.nodes - domBefore.nodes);

      expect(firstNavigationMs).toBeLessThan(budget('PERF_FIRST_NAV_BUDGET_MS', 350));
      expect(navigationP95Ms).toBeLessThan(budget('PERF_NAV_P95_BUDGET_MS', 250));
      expect(navigationMaxMs).toBeLessThan(budget('PERF_NAV_MAX_BUDGET_MS', 750));
      expect(longTaskMaxMs).toBeLessThan(budget('PERF_LONG_TASK_MAX_BUDGET_MS', 750));
      expect(heapGrowthBytes).toBeLessThan(budget('PERF_HEAP_GROWTH_BUDGET_MB', 128) * 1024 * 1024);
      expect(domNodeGrowth).toBeLessThan(budget('PERF_DOM_GROWTH_BUDGET', 20_000));

      // Hydrate the maximum supported history directly, then measure the real
      // hidden-panel catch-up path. Persistence and complex delta replay are
      // covered separately below; this isolates the browser UI cost.
      const hydrateMs = await editor.evaluate<number>(`(() => {
        const deck = window.store.get().deck;
        const entries = Array.from({ length: 200 }, (_, index) => ({
          label: 'Synthetic history ' + (index + 1),
          at: Date.now() - (200 - index) * 1000,
          slideIndex: 450,
          operations: [],
        }));
        const hydrateStarted = performance.now();
        window.store.load(deck, '/synthetic-performance', {
          keepView: true,
          history: { version: 2, base: deck, entries },
        });
        return performance.now() - hydrateStarted;
      })()`);
      // The panel is opened by a real click on the History button beside the
      // deck name, into a popover. The stopwatch starts inside the page on
      // that click's own pointerdown and stops two frames after the click
      // opened it, so the measurement covers the app's work and not the
      // test's round trip.
      await editor.evaluate(`(() => {
        const button = document.querySelector('.bar-history-button');
        window.__historyOpen = new Promise((resolve) => {
          let started = 0;
          button.addEventListener('pointerdown', () => { started = performance.now(); }, { once: true });
          button.addEventListener('click', () => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve({
              openMs: performance.now() - started,
              rows: document.querySelectorAll('#history .history-item').length,
            })));
          }, { once: true });
        });
        return true;
      })()`);
      await editor.click('.bar-history-button', 'History button');
      const opened = await editor.evaluate<{ openMs: number; rows: number }>(
        `window.__historyOpen`);
      const historyUi = { hydrateMs, openMs: opened.openMs, rows: opened.rows };
      expect(historyUi.rows).toBe(200);
      expect(historyUi.hydrateMs).toBeLessThan(budget('PERF_HISTORY_UI_HYDRATE_BUDGET_MS', 5_000));
      expect(historyUi.openMs).toBeLessThan(budget('PERF_HISTORY_UI_OPEN_BUDGET_MS', 750));

      console.info('[performance:large-deck]', JSON.stringify({
        slides: 1_000,
        imagePixels: 6_000 * 4_000,
        videoPixels: 3_840 * 2_160,
        loadMs: Math.round(loadMs),
        firstNavigationMs: Math.round(firstNavigationMs),
        navigationP95Ms: Math.round(navigationP95Ms),
        navigationMaxMs: Math.round(navigationMaxMs),
        longTaskMaxMs: Math.round(longTaskMaxMs),
        heapGrowthMb: Math.round(heapGrowthBytes / 1024 / 1024),
        domNodeGrowth,
        mountedThumbs: navigation.mountedThumbs,
        warmedImageCount,
        pooledVideos: navigation.pooledVideos,
        connectedVideos: navigation.connectedVideos,
        railCachedThumbs: navigation.railCachedThumbs,
        railCachedVideos: navigation.railCachedVideos,
        resourcesBefore,
        domNodesBefore: domBefore.nodes,
        domNodesAfter: domAfter.nodes,
        historyUi: {
          hydrateMs: Math.round(historyUi.hydrateMs),
          openMs: Math.round(historyUi.openMs),
        },
      }));
    },
    360_000,
  );

  it('bounds, persists, reloads, and restores 205 complex revisions of a 500-slide deck', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-history-performance-'));
    const store = new EditorStore(syntheticMediaDeck(500), workDir);
    const commitTimes: number[] = [];
    const historyStarted = performance.now();

    for (let revision = 1; revision <= 205; revision += 1) {
      const started = performance.now();
      store.commit((deck) => {
        deck.title = `Revision ${revision}`;
        for (let offset = 0; offset < 8; offset += 1) {
          const slide = deck.slides[(revision * 13 + offset * 37) % deck.slides.length];
          slide.name = `Revision ${revision}, branch ${offset}`;
          const title = slide.elements.find((element) => element.type === 'text');
          if (title?.type === 'text') title.html = `Revision ${revision} / ${offset}`;
          const image = slide.elements.find((element) => element.type === 'image');
          if (image?.type === 'image') image.opacity = 0.7 + (revision % 4) * 0.1;
          const video = slide.elements.find((element) => element.type === 'video');
          if (video?.type === 'video') video.start = (revision + offset) % 3;
        }
      }, { label: `Edit ${revision}` });
      commitTimes.push(performance.now() - started);
    }
    const historyBuildMs = performance.now() - historyStarted;
    const persisted = store.persistedHistory();
    expect(store.history()).toHaveLength(200);
    expect(persisted.entries).toHaveLength(200);
    expect(store.history().at(-1)?.label).toBe('Edit 6');

    const saveStarted = performance.now();
    await saveDeckHistory(workDir, persisted);
    const saveMs = performance.now() - saveStarted;
    const sidecar = await stat(join(workDir, 'deck-history-v2.json.gz'));

    const loadStarted = performance.now();
    const loaded = await loadDeckHistory(workDir);
    const loadMs = performance.now() - loadStarted;
    expect(loaded.entries).toHaveLength(200);

    const hydrateStarted = performance.now();
    const reopened = new EditorStore(emptyDeck());
    reopened.load(store.get().deck, workDir, { history: loaded });
    const hydrateMs = performance.now() - hydrateStarted;
    expect(reopened.history()).toHaveLength(200);

    const middle = reopened.history().find((entry) => entry.label === 'Edit 105');
    expect(middle).toBeDefined();
    const restoreStarted = performance.now();
    expect(reopened.restoreHistory(middle!.id)).toBe(true);
    const restoreMs = performance.now() - restoreStarted;
    expect(reopened.get().deck.title).toBe('Revision 105');
    expect(() => parseDeck(reopened.get().deck)).not.toThrow();

    const oneDeckBytes = Buffer.byteLength(JSON.stringify(persisted.base));
    expect(sidecar.size).toBeLessThan(Math.max(10_000_000, oneDeckBytes * 3));
    expect(historyBuildMs).toBeLessThan(budget('PERF_HISTORY_BUILD_BUDGET_MS', 120_000));
    expect(percentile(commitTimes, 0.95))
      .toBeLessThan(budget('PERF_HISTORY_COMMIT_P95_BUDGET_MS', 1_000));
    expect(saveMs).toBeLessThan(budget('PERF_HISTORY_SAVE_BUDGET_MS', 30_000));
    expect(loadMs).toBeLessThan(budget('PERF_HISTORY_LOAD_BUDGET_MS', 30_000));
    expect(hydrateMs).toBeLessThan(budget('PERF_HISTORY_HYDRATE_BUDGET_MS', 30_000));
    expect(restoreMs).toBeLessThan(budget('PERF_HISTORY_RESTORE_BUDGET_MS', 30_000));

    console.info('[performance:history]', JSON.stringify({
      slides: 500,
      attemptedRevisions: 205,
      retainedRevisions: persisted.entries.length,
      historyBuildMs: Math.round(historyBuildMs),
      commitP95Ms: Math.round(percentile(commitTimes, 0.95)),
      sidecarMb: Number((sidecar.size / 1024 / 1024).toFixed(2)),
      saveMs: Math.round(saveMs),
      loadMs: Math.round(loadMs),
      hydrateMs: Math.round(hydrateMs),
      restoreMs: Math.round(restoreMs),
    }));
  }, 360_000);
});

/**
 * Presenting costs twice what it looks like: every advance renders the
 * audience slide *and* two more full stages in Speaker View, on a second
 * window fed over the presentation bus. A regression there is invisible until
 * someone is on stage, so it gets its own gate — how long the Speaker View
 * takes to follow the audience, and whether rebuilding those previews on every
 * step leaks DOM or heap.
 */
describe.skipIf(!RUN_PERFORMANCE)('presentation pair performance stress', () => {
  it.skipIf(!electronBinary || !ffmpeg)(
    'keeps Speaker View following a media-heavy audience window',
    async () => {
      workDir = await mkdtemp(join(tmpdir(), 'deckwerk-present-performance-'));
      const decksRoot = join(workDir, 'decks');
      const deckDir = join(decksRoot, DECK_ID);
      const assetsDir = join(deckDir, 'assets');
      const profileDir = join(workDir, 'electron-profile');
      await mkdir(assetsDir, { recursive: true });
      await mkdir(profileDir, { recursive: true });

      await execFileAsync(ffmpeg, [
        '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=6000x4000:rate=1',
        '-frames:v', '1', '-q:v', '2', join(assetsDir, 'large-a.11111111.jpeg'),
      ]);
      await execFileAsync(ffmpeg, [
        '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'smptebars=size=6000x4000:rate=1',
        '-frames:v', '1', '-q:v', '2', join(assetsDir, 'large-b.22222222.jpeg'),
      ]);
      await execFileAsync(ffmpeg, [
        '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30',
        '-t', '6', '-an', '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '8M',
        join(assetsDir, 'large-video.33333333.mp4'),
      ]);

      const ADVANCES = 40;
      await saveDeck(deckDir, syntheticMediaDeck(ADVANCES + 20));
      await writeFile(join(deckDir, 'theme.css'), [
        '.slide { color: #111827; }',
        '.role-title { font: 700 58px/1.1 sans-serif; }',
        '',
      ].join('\n'), 'utf8');

      const clientDir = await collabClientDir();
      server = await startCollabServer({
        rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
      });

      const present = `http://127.0.0.1:${server.port}/present.html?deck=${DECK_ID}`;
      browser = await launchBrowser(`${present}&slide=1`, profileDir);
      const audienceTarget = await findTarget(
        browser.debugPort,
        (candidate) => candidate.url.includes('present.html') && !candidate.url.includes('role='),
        browser.log,
        30_000,
      );
      editor = await Cdp.connect(audienceTarget.webSocketDebuggerUrl!);
      await eventually(
        async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('#stage .slide'))`),
        'the audience window never painted a slide',
        Boolean,
        60_000,
      );

      await editor.evaluate(
        `Boolean(window.open(${JSON.stringify(`${present}&slide=1&role=speaker`)}, 'speaker'))`,
      );
      const speakerTarget = await findTarget(
        browser.debugPort, (candidate) => candidate.url.includes('role=speaker'), browser.log, 30_000,
      );
      speaker = await Cdp.connect(speakerTarget.webSocketDebuggerUrl!);
      await eventually(
        async () => speaker!.evaluate<boolean>(
          `Boolean(document.querySelector('.speaker-current .slide'))`,
        ),
        'Speaker View never painted its first preview',
        Boolean,
        60_000,
      );

      await speaker.call('HeapProfiler.collectGarbage');
      const beforeMemory = (await speaker.call('Runtime.getHeapUsage')) as RuntimeMemory;
      const beforeDom = (await speaker.call('Memory.getDOMCounters')) as DomCounters;

      /**
       * One advance, timed inside the Speaker View: from the click that sends
       * the command to the render that answers it. The audience does the work
       * in between — command over the bus, player advance, state back — so
       * this is the whole loop the presenter actually feels.
       */
      const follow: number[] = [];
      const domCheckpoints: number[] = [];
      for (let step = 0; step < ADVANCES; step += 1) {
        if (step % 10 === 0) {
          await speaker.call('HeapProfiler.collectGarbage');
          domCheckpoints.push(((await speaker.call('Memory.getDOMCounters')) as DomCounters).nodes);
        }
        // Arm the stopwatch in the page, advance with a real click on the
        // speaker control, then collect what that click cost.
        await speaker.evaluate(`(() => {
          const position = document.querySelector('.speaker-position');
          const before = position.textContent;
          window.__advance = new Promise((resolve) => {
            let started = null;
            document.querySelector('.speaker-next-button').addEventListener(
              'pointerdown', () => { started = performance.now(); }, { once: true });
            const observer = new MutationObserver(() => {
              if (position.textContent === before) return;
              observer.disconnect();
              resolve(performance.now() - (started ?? performance.now()));
            });
            observer.observe(position, { childList: true, characterData: true, subtree: true });
            setTimeout(() => { observer.disconnect(); resolve(10000); }, 10000);
          });
          return true;
        })()`);
        await speaker.click('.speaker-next-button', 'speaker next');
        follow.push(await speaker.evaluate<number>(`window.__advance`));
      }

      const followed = await speaker.evaluate<string | null>(
        `document.querySelector('.speaker-position')?.textContent ?? null`,
      );
      expect(followed).toBe(`Slide ${ADVANCES + 1} / ${ADVANCES + 20} · Build 1 / 1`);
      // The audience is where the show actually is; the two must not drift.
      const audienceSlide = await editor.evaluate<string | null>(
        `document.querySelector('#stage .role-title')?.textContent ?? null`,
      );
      expect(audienceSlide).toBe(`Synthetic media slide ${ADVANCES + 1}`);

      await speaker.call('HeapProfiler.collectGarbage');
      const afterMemory = (await speaker.call('Runtime.getHeapUsage')) as RuntimeMemory;
      const afterDom = (await speaker.call('Memory.getDOMCounters')) as DomCounters;

      const followP95Ms = percentile(follow, 0.95);
      const followMaxMs = Math.max(...follow);
      const heapGrowthBytes = afterMemory.usedSize - beforeMemory.usedSize;
      const domNodeGrowth = afterDom.nodes - beforeDom.nodes;

      console.info('[performance:presentation]', JSON.stringify({
        slides: ADVANCES + 20,
        advances: ADVANCES,
        followP95Ms: Math.round(followP95Ms),
        followMaxMs: Math.round(followMaxMs),
        speakerHeapGrowthMb: Number((heapGrowthBytes / 1024 / 1024).toFixed(1)),
        speakerDomNodeGrowth: domNodeGrowth,
        speakerDomCheckpoints: domCheckpoints,
      }));

      expect(followP95Ms).toBeLessThan(budget('PERF_SPEAKER_FOLLOW_P95_BUDGET_MS', 600));
      expect(followMaxMs).toBeLessThan(budget('PERF_SPEAKER_FOLLOW_MAX_BUDGET_MS', 2_000));
      // Speaker View throws away and rebuilds two stages per advance. Neither
      // the discarded DOM nor the frozen video stills may accumulate: forty
      // advances must cost about two live stages, not forty of them. The
      // checkpoints above are diagnostics for when this trips — a leak shows as
      // steady climb, a bounded cache as the sawtooth GC leaves behind.
      //
      // The budget sits between the two states this has actually been observed
      // in: ~1300–2300 nodes healthy, ~5300 while every discarded preview was
      // still pinned by the poster-capture map. It is a narrower margin than
      // the other gates here because the failure it guards is a slow leak
      // rather than an order-of-magnitude blow-up.
      expect(domNodeGrowth).toBeLessThan(budget('PERF_SPEAKER_DOM_GROWTH_BUDGET', 3_500));
      expect(heapGrowthBytes)
        .toBeLessThan(budget('PERF_SPEAKER_HEAP_GROWTH_BUDGET_MB', 128) * 1024 * 1024);
    },
    360_000,
  );
});
