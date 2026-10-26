import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { emptyDeck, type Deck, type SlideElement } from '../../src/shared/deck.js';
import {
  Cdp,
  collectProcessOutput,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  reportedPorts,
  stopBrowser,
} from './browserSession.js';
import { launchSafari } from './safariDriver.js';

/**
 * Driving the browser editor through losing its server: the pieces the
 * offline suites share (mediaTransferBudgetBrowser's "presenting after the
 * server has gone", offlinePresentScenariosBrowser, offlinePresentFuzzBrowser).
 *
 * A page is driven the same way whichever browser holds it: Electron (the
 * Chromium every CI tier runs), Google Chrome (headless, where installed) and
 * Safari (safaridriver, on a Mac that allows remote automation). Everything
 * is read and done through `evaluate`, so a check means the same in each.
 */

const execFileAsync = promisify(execFile);

export type OfflineBrowserKind = 'chromium' | 'chrome' | 'safari';

export interface DrivenPage {
  readonly kind: OfflineBrowserKind;
  evaluate<T>(expression: string): Promise<T>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  /** Give up on a navigation that hangs (a dead route, nothing to answer from): what the browser's stop button does. */
  stop?(): Promise<void>;
  /** Pretend the origin may store only this much (Chromium's DevTools can). */
  overrideQuota?(origin: string, bytes: number): Promise<void>;
  close(): Promise<void>;
}

export const CHROME_BINARY = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** The browsers asked for in `variable` (comma-separated), of those this machine has. */
export function browsersFromEnv(variable: string, fallback: OfflineBrowserKind[]): OfflineBrowserKind[] {
  const asked = (process.env[variable]?.split(',').map((name) => name.trim()).filter(Boolean) ?? fallback) as OfflineBrowserKind[];
  return asked.filter((kind) => (kind === 'chromium' ? Boolean(electronBinary)
    : kind === 'chrome' ? existsSync(CHROME_BINARY)
      : process.platform === 'darwin'));
}

export async function openPage(kind: OfflineBrowserKind, profileDir: string): Promise<DrivenPage> {
  await mkdir(profileDir, { recursive: true });
  if (kind === 'safari') {
    const safari = await launchSafari();
    return { kind, ...safari };
  }
  let child: ChildProcess;
  let debugPort: number;
  let log: () => string;
  if (kind === 'chromium') {
    const running = await launchBrowser('about:blank', profileDir);
    child = running.process;
    debugPort = running.debugPort;
    log = running.log;
  } else {
    child = spawn(CHROME_BINARY, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`,
      '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--window-size=1600,1000', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    log = collectProcessOutput(child);
    ({ debugPort } = await reportedPorts(child, [], log));
  }
  const target = await findTarget(debugPort, (candidate) => candidate.url.startsWith('about:blank'), log);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  return {
    kind,
    evaluate: (expression) => cdp.evaluate(expression),
    goto: async (url) => { await cdp.evaluate(`(location.href = ${JSON.stringify(url)}, true)`); },
    reload: async () => { await cdp.evaluate('(location.reload(), true)'); },
    stop: async () => { await cdp.call('Page.stopLoading'); },
    overrideQuota: async (origin, bytes) => { await cdp.call('Storage.overrideQuotaForOrigin', { origin, quotaSize: bytes }); },
    close: async () => {
      cdp.close();
      await stopBrowser(child);
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Fixture decks                                                             */
/* ------------------------------------------------------------------------ */

const ffmpeg = (() => {
  try {
    return createRequire(import.meta.url)('ffmpeg-static') as string;
  } catch {
    return null;
  }
})();

export const haveFfmpeg = Boolean(ffmpeg);

export async function makePhoto(out: string, size: string, seed: number): Promise<void> {
  // Noise, so a photo weighs what a photo weighs (a test pattern compresses to nothing).
  await execFileAsync(ffmpeg!, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}`, '-vf', `noise=alls=10:allf=t:all_seed=${seed}`,
    '-frames:v', '1', '-q:v', '5', out,
  ]);
}

export async function makeClip(out: string, seconds: number, pattern = 'testsrc2', size = '640x360'): Promise<void> {
  await execFileAsync(ffmpeg!, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `${pattern}=size=${size}:rate=30`, '-t', String(seconds),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-g', '30', '-movflags', '+faststart', out,
  ]);
}

export function titleElement(id: string, html: string): SlideElement {
  return {
    id, type: 'text', x: 160, y: 40, w: 1600, h: 140, rot: 0, z: 1, opacity: 1,
    class: ['role-title'], style: {}, html, align: 'center', valign: 'middle',
  } as SlideElement;
}

export function imageElement(id: string, src: string, x: number, y: number, w = 440, h = 280): SlideElement {
  return {
    id, type: 'image', x, y, w, h, rot: 0, z: 2, opacity: 1,
    class: [], style: {}, src, fit: 'contain', alt: '', sourceBox: null,
  } as SlideElement;
}

export function videoElement(id: string, src: string, x: number, y: number): SlideElement {
  return {
    id, type: 'video', x, y, w: 640, h: 360, rot: 0, z: 2, opacity: 1,
    class: [], style: {}, src, fit: 'contain', start: 0, end: null,
    autoplay: true, loop: true, muted: true, controls: false, poster: null, sourceBox: null,
  } as SlideElement;
}

export interface FixtureSpec {
  slides: number;
  /** Photos per slide, cycling through this list. */
  photosPerSlide: number[];
  /** Every n-th slide carries a clip (0: none). */
  clipEvery: number;
  /** Distinct photo files and clip files: slides reuse them. */
  photoFiles: number;
  clipFiles: number;
  photoSize?: string;
  clipSeconds?: number;
  /** Photos written into assets/ that no slide shows yet: what an edit adds. */
  sparePhotos?: number;
}

/** Write a deck of photos and clips into `deckDir`; returns the deck and the spare photos' srcs. */
export async function writeFixtureDeck(deckDir: string, title: string, spec: FixtureSpec): Promise<{ deck: Deck; spares: string[] }> {
  const { saveDeck } = await import('../../src/main/deckStore.js');
  const { writeFile } = await import('node:fs/promises');
  await mkdir(join(deckDir, 'assets'), { recursive: true });
  const photos = Array.from({ length: spec.photoFiles }, (_, i) => `assets/photo-${i + 1}.jpg`);
  const spares = Array.from({ length: spec.sparePhotos ?? 0 }, (_, i) => `assets/spare-${i + 1}.jpg`);
  const clips = Array.from({ length: spec.clipFiles }, (_, i) => `assets/clip-${i + 1}.mp4`);
  const patterns = ['testsrc2', 'mandelbrot', 'smptehdbars', 'rgbtestsrc'];
  const jobs: Array<() => Promise<void>> = [
    ...photos.map((photo, i) => () => makePhoto(join(deckDir, photo), spec.photoSize ?? '1600x1000', i + 1)),
    ...spares.map((photo, i) => () => makePhoto(join(deckDir, photo), spec.photoSize ?? '1600x1000', 500 + i)),
    ...clips.map((clip, i) => () => makeClip(join(deckDir, clip), spec.clipSeconds ?? 6, patterns[i % patterns.length])),
  ];
  // A few ffmpegs at a time: a large deck is hundreds of files.
  for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map((job) => job()));
  const deck = emptyDeck(title);
  const base = deck.slides[0];
  let photo = 0;
  let clip = 0;
  deck.slides = Array.from({ length: spec.slides }, (_, index) => {
    const n = index + 1;
    const elements: SlideElement[] = [titleElement(`t${n}`, `SLIDE ${n}`)];
    const count = spec.photosPerSlide[index % spec.photosPerSlide.length];
    for (let i = 0; i < count; i++) {
      elements.push(imageElement(`p${n}-${i}`, photos[photo++ % photos.length], 60 + (i % 4) * 460, 220 + Math.floor(i / 4) * 300));
    }
    if (spec.clipEvery > 0 && n % spec.clipEvery === 0 && clips.length > 0) {
      elements.push(videoElement(`c${n}`, clips[clip++ % clips.length], 640, 560));
    }
    return { ...base, id: `s${n}`, elements };
  });
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111; }\n', 'utf8');
  return { deck, spares };
}

/* ------------------------------------------------------------------------ */
/* Reading and driving the editor                                            */
/* ------------------------------------------------------------------------ */

/** The presentation's window (the editor may hold other frames: the Agent panel's). */
/**
 * A page-side predicate: the media element is on screen, not held back by a
 * build. The Player hides an element waiting for its build by setting
 * `visibility: hidden` on its wrapper; a picture or clip in there is not
 * missing and not expected to play.
 */
const ON_STAGE = `((el) => { for (let node = el.closest('[data-element-id]'); node; node = node.parentElement?.closest('[data-element-id]')) {
  if (node.style.visibility === 'hidden') return false; } return true; })`;

export const PRESENT_FRAME = `document.querySelector('iframe[src*="present.html"]').contentWindow`;

export interface EditorState {
  offline: string;
  shell: string;
  status: string;
  collabReady: boolean;
  /** Welcomes this page has had: grows on every (re)connection. */
  welcomes: number;
  offlineDeck: boolean;
  /** A deck is on screen: welcomed by the server, opened from the copy, or kept from before the link went. */
  deckShown: boolean;
  slides: number;
  slide: number;
  presenting: boolean;
  /** Canvas media not painted (a picture not loaded, a clip with no frame). */
  unpainted: string[];
}

export function editorState(page: DrivenPage): Promise<EditorState> {
  return page.evaluate<EditorState>(`(() => {
    const root = document.documentElement;
    const store = window.store;
    const painted = (v) => v.readyState >= 2 || (v.dataset.streamPending === 'true' && Boolean(v.getAttribute('poster')));
    return {
      offline: root.dataset.offline ?? '',
      shell: root.dataset.offlineShell ?? '',
      status: document.getElementById('status')?.textContent ?? '',
      collabReady: root.dataset.collabReady === 'true',
      welcomes: Number(root.dataset.collabWelcomes ?? 0),
      offlineDeck: root.dataset.offlineDeck === 'true',
      deckShown: Boolean(store) && store.get().deck.title !== 'Connecting…',
      slides: store ? store.get().deck.slides.length : 0,
      slide: store ? store.get().slideIndex : -1,
      presenting: Boolean(document.querySelector('iframe[src*="present.html"]')),
      unpainted: [
        ...[...document.querySelectorAll('#canvas img')].filter((i) => !(i.complete && i.naturalWidth > 0))
          .map((i) => 'img ' + (i.getAttribute('src') || '').slice(0, 60)),
        ...[...document.querySelectorAll('#canvas video')].filter((v) => !painted(v))
          .map((v) => 'video ' + (v.dataset.networkSrc || v.getAttribute('src') || '').slice(0, 60) + ' rs' + v.readyState + ' ns' + v.networkState),
      ],
    };
  })()`);
}

/** Wait until the editor lists `slides` slides and the slide shown has painted its media. */
export async function waitForEditorPainted(page: DrivenPage, slides: number, timeoutMs = 60_000): Promise<EditorState> {
  return eventually(() => editorState(page), `the editor never showed ${slides} slides with their media painted`,
    (state) => state.slides === slides && state.unpainted.length === 0, timeoutMs);
}

export async function waitForOfflineReady(page: DrivenPage, timeoutMs = 240_000): Promise<EditorState> {
  return eventually(() => editorState(page), 'the editor never said the talk was available offline',
    (state) => state.offline === 'ready', timeoutMs);
}

/**
 * Click Present; resolves with whether a presentation mounted, the status
 * line, and what the editor said of its offline copy the instant before
 * the click (read in the same task, so nothing changed in between).
 */
export async function pressPresent(page: DrivenPage): Promise<{ mounted: boolean; status: string; offlineAtClick: string; connectedAtClick: boolean }> {
  // The toolbar is built once the server's config (or the one remembered) is in.
  await eventually(() => page.evaluate<boolean>(`[...document.querySelectorAll('#toolbar button')]
    .some((button) => button.textContent?.trim() === 'Present' && button.getClientRects().length > 0)`),
  'the toolbar never offered Present', Boolean, 30_000);
  const atClick = await page.evaluate<{ offline: string; connected: boolean }>(`(() => {
    const present = [...document.querySelectorAll('#toolbar button')]
      .filter((button) => button.textContent?.trim() === 'Present')
      .find((button) => button.getClientRects().length > 0);
    const root = document.documentElement;
    const at = { offline: window.deckwerkOffline?.status().state ?? root.dataset.offline ?? '', connected: root.dataset.collabReady === 'true' };
    present.click();
    return at;
  })()`);
  return {
    ...await page.evaluate<{ mounted: boolean; status: string }>(`({
      mounted: Boolean(document.querySelector('iframe[src*="present.html"]')),
      status: document.getElementById('status')?.textContent ?? '',
    })`),
    offlineAtClick: atClick.offline,
    connectedAtClick: atClick.connected,
  };
}

export async function exitPresentation(page: DrivenPage): Promise<void> {
  await page.evaluate(`(window.postMessage({ type: 'present-exit' }, location.origin), true)`);
  await eventually(() => page.evaluate<boolean>(`!document.querySelector('iframe[src*="present.html"]')`),
    'the presentation overlay never closed', Boolean, 30_000);
}

export async function presentKey(page: DrivenPage, key: string): Promise<void> {
  await page.evaluate(`(() => {
    const win = ${PRESENT_FRAME};
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
    return true;
  })()`);
}

/** A Speaker View's jump: the presentation bus is the origin's BroadcastChannel. */
export async function presentJump(page: DrivenPage, deckId: string, slide: number): Promise<void> {
  await page.evaluate(`(() => {
    const bus = new BroadcastChannel(${JSON.stringify(`deckwerk-present:${deckId}`)});
    bus.postMessage({ kind: 'command', command: { type: 'goTo', slide: ${slide} } });
    bus.close();
    return true;
  })()`);
}

/** Every slide the presentation puts on stage, with what was missing in its first frame. */
export interface FirstFrame {
  slide: string;
  images: number;
  missing: string[];
  /** For a slide that appeared incomplete: its pictures over the next frames. */
  frames?: string[];
}

/**
 * Record, for every slide the Player puts on its stage, which images were not
 * on screen in the first frame painted with it, and every media element that
 * fails. Sampled in requestAnimationFrame, which runs right before the
 * browser paints: a MutationObserver runs before the Player's own follow-up
 * work in the same task (revealing a decoded picture) and reports pictures
 * missing that no frame ever showed missing. `ticks` counts the frames seen,
 * so a page that paints nothing cannot pass for one that paints everything.
 */
export async function watchPresentation(page: DrivenPage): Promise<void> {
  // The opening slide paints over a black overlay as its pictures decode; a
  // frame of that is not a slide appearing without them, so the watch starts
  // once it is there (as mediaTransferBudgetBrowser's does).
  await eventually(() => page.evaluate<boolean>(`Boolean(${PRESENT_FRAME}?.document?.querySelector('#stage .stage > .slide'))`),
    'the presentation never put a slide on its stage', Boolean, 30_000);
  await page.evaluate(`(() => {
    const win = ${PRESENT_FRAME};
    const doc = win.document;
    win.__firstFrames = [];
    win.__mediaErrors = [];
    win.__frameTicks = 0;
    const stage = doc.getElementById('stage');
    // The slide already on stage is not a first frame any more.
    let last = stage.querySelector('.stage > .slide');
    const generation = (win.__watchGeneration = (win.__watchGeneration ?? 0) + 1);
    const tick = () => {
      if (win.__watchGeneration !== generation) return;
      win.__frameTicks += 1;
      const root = stage.querySelector('.stage > .slide');
      const describe = (i) => [
        (i.dataset.networkSrc || i.getAttribute('src') || 'no src').split('/').pop().slice(0, 12),
        i.complete ? 'complete' : 'loading', i.naturalWidth, win.getComputedStyle(i).visibility,
      ].join(' ');
      if (root && root !== last) {
        last = root;
        const images = [...root.querySelectorAll('img')].filter(${ON_STAGE});
        const missing = images.filter((i) => !(i.complete && i.naturalWidth > 0 && win.getComputedStyle(i).visibility !== 'hidden'))
          .map((i) => (i.dataset.networkSrc || i.getAttribute('src') || 'no src').split('/').pop());
        // A slide that appears incomplete: how it went over the next frames, to say why.
        const frames = missing.length > 0 ? [images.map(describe).join(' | ')] : undefined;
        win.__firstFrames.push({ slide: root.dataset.slideId, images: images.length, missing, ...(frames ? { frames } : {}) });
      } else if (root) {
        const entry = win.__firstFrames[win.__firstFrames.length - 1];
        if (entry?.frames && entry.frames.length < 8) entry.frames.push([...root.querySelectorAll('img')].filter(${ON_STAGE}).map(describe).join(' | '));
      }
      win.requestAnimationFrame(tick);
    };
    win.requestAnimationFrame(tick);
    doc.addEventListener('error', (event) => {
      const target = event.target;
      if (target && (target.tagName === 'IMG' || target.tagName === 'VIDEO')) {
        win.__mediaErrors.push(target.tagName + ' ' + (target.dataset.networkSrc || target.getAttribute('src') || '').slice(0, 80));
      }
    }, true);
    return true;
  })()`);
}

export async function takeFirstFrames(page: DrivenPage): Promise<{ frames: FirstFrame[]; errors: string[]; ticks: number }> {
  return page.evaluate(`(() => {
    const win = ${PRESENT_FRAME};
    const taken = { frames: win.__firstFrames ?? [], errors: win.__mediaErrors ?? [], ticks: win.__frameTicks ?? 0 };
    win.__firstFrames = [];
    win.__mediaErrors = [];
    return taken;
  })()`);
}

export interface StageState {
  slideId: string;
  images: Array<{ src: string; ok: boolean }>;
  /** `shouldPlay`: the deck autoplays the clip and it has not played to its end. */
  clips: Array<{ src: string; readyState: number; paused: boolean; time: number; error: number | null; shouldPlay: boolean }>;
}

export function stageState(page: DrivenPage): Promise<StageState> {
  return page.evaluate<StageState>(`(() => {
    const win = ${PRESENT_FRAME};
    const root = win?.document?.querySelector('#stage .stage > .slide');
    if (!root) return { slideId: '', images: [], clips: [] };
    const name = (el) => (el.dataset.networkSrc || el.getAttribute('src') || 'no src').split('/').pop().slice(0, 40);
    return {
      slideId: root.dataset.slideId,
      images: [...root.querySelectorAll('img')].filter(${ON_STAGE}).map((i) => ({ src: name(i), ok: i.complete && i.naturalWidth > 0 })),
      clips: [...root.querySelectorAll('video')].filter(${ON_STAGE}).map((v) => {
        // What the deck asks of the clip: an editor tab presenting knows the deck.
        const id = v.closest('[data-element-id]')?.dataset.elementId;
        const slide = window.store?.get().deck.slides.find((s) => s.id === root.dataset.slideId);
        const el = slide?.elements.find((e) => e.id === id);
        const atEnd = v.ended || (Number.isFinite(v.duration) && v.currentTime >= v.duration - 0.25)
          || (el && el.end !== null && v.currentTime >= el.end - 0.25);
        return {
          src: name(v), readyState: v.readyState, paused: v.paused, time: v.currentTime, error: v.error ? v.error.code : null,
          shouldPlay: !el || (el.autoplay !== false && (el.loop !== false || !atEnd)),
        };
      }),
    };
  })()`);
}

/** A clip is fine when it shows a frame without error, and plays if the deck says it should. */
export const clipPlaying = (clip: StageState['clips'][number]) => clip.readyState >= 2 && clip.error === null
  && (!clip.shouldPlay || (!clip.paused && clip.time > 0));

/**
 * Wait for the slide on stage to show everything: every picture decoded and
 * every clip playing. Resolves with what is wrong, empty when nothing is.
 */
export async function stageComplete(page: DrivenPage, timeoutMs = 15_000): Promise<{ state: StageState; problems: string[] }> {
  const problemsOf = (state: StageState) => [
    ...(state.slideId ? [] : ['no slide on the stage']),
    ...state.images.filter((image) => !image.ok).map((image) => `picture ${image.src} not shown`),
    ...state.clips.filter((clip) => !clipPlaying(clip)).map((clip) => `clip ${clip.src} not playing (${JSON.stringify(clip)})`),
  ];
  const state = await eventually(() => stageState(page), 'stage', (s) => problemsOf(s).length === 0, timeoutMs)
    .catch(() => stageState(page));
  return { state, problems: problemsOf(state) };
}

/** What the service worker could not answer since it started. */
export async function workerFailures(page: DrivenPage): Promise<string[]> {
  const failures = await page.evaluate<Array<{ url: string; reason: string }> | null>(`new Promise((resolve) => {
    const worker = navigator.serviceWorker?.controller;
    if (!worker) return resolve(null);
    const timer = setTimeout(() => resolve(null), 5000);
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type !== 'offline-failures') return;
      clearTimeout(timer);
      resolve(event.data.failures);
    });
    worker.postMessage({ type: 'offline-failures' });
  })`);
  if (failures === null) return ['(no service worker controls the editor)'];
  return failures.map((failure) => `worker could not answer ${failure.url}: ${failure.reason}`);
}

/** Storage the origin uses, and its quota, as the browser estimates them. */
export function storageEstimate(page: DrivenPage): Promise<{ usage: number; quota: number; persisted: boolean | null }> {
  return page.evaluate(`(async () => {
    const estimate = await navigator.storage?.estimate?.() ?? {};
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
    return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persisted };
  })()`);
}

/** The JS heap, where the browser reports one (Chromium). */
export function heapBytes(page: DrivenPage): Promise<number | null> {
  return page.evaluate(`performance.memory ? performance.memory.usedJSHeapSize : null`);
}

/* ------------------------------------------------------------------------ */
/* A whole talk                                                              */
/* ------------------------------------------------------------------------ */

/** A deck as the walks know it: its id and how many slides it has. */
export interface TalkDeck {
  id: string;
  slides: number;
}

/** How long the walk stays on each slide once it is complete: a brisk presenter. */
export const DWELL_MS = 1_000;

/**
 * Present from the editor and walk the whole talk: forward to the end, back
 * to the start, a handful of jumps. Resolves with every problem seen.
 */
export async function giveTalk(driven: DrivenPage, deck: TalkDeck, label: string, during?: () => Promise<void>): Promise<string[]> {
  const problems: string[] = [];
  const pressed = await pressPresent(driven);
  if (!pressed.mounted) return [`${label}: Present was refused: ${pressed.status}`];
  await watchPresentation(driven);
  const ids = await driven.evaluate<string[]>(`window.store.get().deck.slides.map((slide) => slide.id)`);
  /** Slides this show has had on stage: the Player may keep their pictures decoded. */
  const seen = new Set<string>([(await stageState(driven)).slideId]);
  /** Slides in the order they appeared. */
  const recent: string[] = [...seen];
  let ticks = 0;
  const look = async (step: string, excused = false) => {
    const { state, problems: wrong } = await stageComplete(driven);
    for (const problem of wrong) problems.push(`${label}, ${step} (${state.slideId}): ${problem}`);
    // The first frame of what this step put on stage. A jump to a slide the
    // show has not been near is excused: the Player decodes the pictures
    // around the slide shown and of slides shown before (player.ts), and a
    // slide it could not know was next paints them a frame late.
    const taken = await takeFirstFrames(driven);
    ticks += taken.ticks;
    for (const frame of taken.frames) {
      if (frame.missing.length > 0 && !excused) {
        problems.push(`${label}, ${step}: ${frame.slide} appeared without ${frame.missing.join(', ')}; frames: ${(frame.frames ?? []).join(' / ')}`);
      }
      seen.add(frame.slide);
      recent.push(frame.slide);
    }
    for (const error of taken.errors) problems.push(`${label}, ${step}: media element failed: ${error}`);
    // A presenter talks over each slide: a second is a brisk one.
    await new Promise((resolve) => setTimeout(resolve, DWELL_MS));
  };
  await look('open');
  const forward = Math.min(deck.slides - 1, 60);
  for (let i = 1; i <= forward; i++) {
    await presentKey(driven, 'ArrowRight');
    if (i === Math.ceil(forward / 2)) await during?.();
    await look(`forward ${i}`);
  }
  for (let i = 1; i <= forward; i++) {
    await presentKey(driven, 'ArrowLeft');
    await look(`back ${i}`);
  }
  for (const fraction of [0.75, 0, 0.5, 1, 0.25]) {
    const target = Math.round(fraction * (deck.slides - 1));
    // Only a jump next door can count on decoded pictures: the Player keeps
    // the slides around the one shown, and the few shown last
    // (`imageWarmSlides`, `shownImages`), not every slide of a long talk.
    const from = ids.indexOf(await editorStateOfStage(driven));
    const far = Math.abs(target - from) > 1 && !recent.slice(-3).includes(ids[target]);
    await presentJump(driven, deck.id, target);
    await eventually(() => editorStateOfStage(driven), `${label}: jump to ${target + 1}`, (id) => id !== '', 10_000);
    await look(`jump to ${target + 1}${far ? ' (far)' : ''}`, far);
  }
  // Safari driven by WebDriver behind other windows paints nothing at all;
  // there the first frame is mediaTransferBudgetBrowser's to judge, and this
  // walk holds it to every slide being complete.
  if (ticks < 10 && driven.kind !== 'safari') problems.push(`${label}: the presentation painted ${ticks} frames: nothing to judge first frames by`);
  if (ticks < 10 && driven.kind === 'safari') console.log(`${label}: Safari painted no frames (window not visible); first frames not judged`);
  await exitPresentation(driven);
  return problems;
}

export const editorStateOfStage = (driven: DrivenPage) => driven.evaluate<string>(
  `document.querySelector('iframe[src*="present.html"]')?.contentWindow?.document?.querySelector('#stage .stage > .slide')?.dataset.slideId ?? ''`,
);

export async function reloadOffline(driven: DrivenPage, deck: TalkDeck): Promise<string[]> {
  await driven.reload();
  const state = await waitForEditorPainted(driven, deck.slides, 60_000).catch(() => editorState(driven));
  const problems: string[] = [];
  if (state.slides !== deck.slides) problems.push(`reload without the server showed ${state.slides} of ${deck.slides} slides (${state.status})`);
  if (state.unpainted.length > 0) problems.push(`reload without the server left unpainted: ${state.unpainted.join(', ')}`);
  if (!state.offlineDeck) problems.push('reload without the server did not say it showed the offline copy');
  problems.push(...await readOnlyCopy(driven));
  return problems;
}

/**
 * The copy kept in the browser is read-only: it says so, the canvas and side
 * panels take no input, and an edit (as a script or a control would make it)
 * changes nothing.
 */
export async function readOnlyCopy(driven: DrivenPage): Promise<string[]> {
  const found = await driven.evaluate<{ flag: boolean; canvas: boolean; side: boolean; status: string; changed: boolean; railActions: boolean }>(`(() => {
    const before = window.store.get().deck;
    window.store.commit((deck) => { deck.title = 'Edited offline'; }, { label: 'Offline edit' });
    const actions = document.querySelector('#rail .rail-actions');
    return {
      flag: document.documentElement.dataset.readOnlyCopy === 'true',
      canvas: document.getElementById('canvas').inert === true,
      side: document.getElementById('side').inert === true,
      status: document.getElementById('status')?.textContent ?? '',
      changed: window.store.get().deck !== before,
      railActions: Boolean(actions && actions.getClientRects().length > 0),
    };
  })()`);
  return [
    ...(found.flag && found.canvas && found.side ? [] : [`the offline copy is not read-only (flag ${found.flag}, canvas inert ${found.canvas}, side inert ${found.side})`]),
    ...(found.changed ? ['an edit changed the offline copy'] : []),
    ...(found.railActions ? ['the rail offers edit buttons on the offline copy'] : []),
    ...(found.status.includes('Read-only') ? [] : [`the status line does not say the copy is read-only: ${found.status}`]),
  ];
}

/** Once the server is back, the deck edits again: an edit reaches the store and is not refused. */
export async function editsAgain(driven: DrivenPage): Promise<string[]> {
  const found = await driven.evaluate<{ flag: boolean; canvas: boolean; edited: boolean }>(`(() => {
    const title = window.store.get().deck.title;
    window.store.commit((deck) => { deck.title = title + ' '; }, { label: 'Edit after reconnect' });
    const edited = window.store.get().deck.title === title + ' ';
    if (edited) window.store.commit((deck) => { deck.title = title; }, { label: 'Undo the probe' });
    return {
      flag: document.documentElement.dataset.readOnlyCopy === 'true',
      canvas: document.getElementById('canvas').inert === true,
      edited,
    };
  })()`);
  return found.edited && !found.flag && !found.canvas ? [] : [`still read-only after reconnecting (${JSON.stringify(found)})`];
}

export async function reconnects(driven: DrivenPage, deck: TalkDeck): Promise<string[]> {
  const state = await eventually(() => editorState(driven), 'reconnect', (s) => s.collabReady, 60_000)
    .catch(() => editorState(driven));
  if (!state.collabReady) return [`never reconnected once the server was back (${state.status})`];
  if (state.slides !== deck.slides) return [`after reconnecting the editor shows ${state.slides} of ${deck.slides} slides`];
  return editsAgain(driven);
}

