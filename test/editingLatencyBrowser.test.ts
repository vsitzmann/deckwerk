import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { SlideElement } from '../src/shared/deck.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { COLLAB_PROTOCOL_VERSION, type ClientMessage } from '../src/shared/collab.js';
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
import { productionCollabClientDir } from './support/collabClient.js';
import { launchSafari, type SafariKey, type SafariPage } from './support/safariDriver.js';
import { CAPTION, COLLAGE, NEXT_SLIDE, NEXT_SLIDE_CAPTION, latencyDeck, writeLatencyDeck } from './support/latencyDeck.js';

/**
 * The hosted editor stays quick to work in, in Chromium and in real Safari.
 *
 * Typing into a caption on a slide of pictures took 150-300 ms a keystroke in
 * Safari (Oct 2026): each live sync redrew the box in the slide's rail
 * miniature, and Safari repainted the pictures and clips of the rail rows
 * below it to do so. Chromium never showed it, and no budget held either
 * browser to a number, so nothing caught it. This suite drives both browsers
 * with real input (CDP's input pipeline in Chromium, WebDriver actions in
 * Safari) through what a person does all day — type into a box, step through
 * the slides, keep working while a collaborator types elsewhere — on the
 * first forty slides of that talk, rebuilt from their shape with neutral
 * content (support/latencyDeck.ts says why it has to be that deck).
 *
 * Each interaction is timed in the page, from the input event's own
 * timestamp to the end of the first frame that shows its result, and the
 * page's frames are watched for stalls. The budgets are what a person feels
 * as instant, with room for a slow CI machine; the measured numbers are in
 * every failure message.
 *
 * The client is the production build (productionCollabClientDir): the render
 * invariant checker other suites build in re-renders a slide after every
 * patch, which would time the checker. Chromium runs in the required
 * browser tier. Real Safari runs on a Mac when asked, RUN_SAFARI_LATENCY=1
 * (as the CI `safari` job does); once asked, a Safari that will not be
 * automated is a failure, never a skip.
 */

const DECK_ID = 'latency';

const ffmpeg = (() => {
  try {
    return createRequire(import.meta.url)('ffmpeg-static') as string;
  } catch {
    return '';
  }
})();

const SAFARI = process.platform === 'darwin' && process.env.RUN_SAFARI_LATENCY === '1';
type BrowserKind = 'Chromium' | 'Safari';
const BROWSERS: BrowserKind[] = [
  ...(electronBinary ? ['Chromium' as const] : []),
  ...(SAFARI ? ['Safari' as const] : []),
];

/**
 * What instant means here, in milliseconds from input to the frame that
 * shows it. A keystroke that waits 100 ms is felt; one that waits a frame or
 * two is not. A stall is any frame longer than LONG_FRAME_MS.
 */
const BUDGET = {
  keystrokeMedianMs: 50,
  keystrokeP90Ms: 100,
  slideStepMedianMs: 150,
  slideStepWorstMs: 400,
  longFrameMs: 150,
  /** Stalls allowed while typing 24 characters. */
  typingStalls: 1,
  /** The longest frame from the first double-click into a box until the editor has settled. */
  openingFrameMs: 250,
};

/* ------------------------------------------------------------------------ */
/* Driving a browser                                                         */
/* ------------------------------------------------------------------------ */

/** What the suite needs from a browser, whichever drives it: evaluation and real input. */
interface Page {
  evaluate<T>(expression: string): Promise<T>;
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  doubleClick(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: SafariKey): Promise<void>;
  close(): Promise<void>;
}

const KEY_CODES: Record<SafariKey, number> = { ArrowDown: 40, ArrowUp: 38, End: 35, Escape: 27, Enter: 13 };

async function openPage(kind: BrowserKind, profileDir: string): Promise<Page> {
  if (kind === 'Safari') {
    const safari: SafariPage = await launchSafari();
    // The size of the Chromium window, so both lay the editor out alike.
    await safari.setWindowSize(1600, 1000);
    return {
      evaluate: (expression) => safari.evaluate(expression),
      goto: (url) => safari.goto(url),
      click: (selector) => safari.click(selector),
      doubleClick: (selector) => safari.click(selector, 2),
      type: (value) => safari.type(value),
      press: (key) => safari.press(key),
      close: () => safari.close(),
    };
  }
  const browser: RunningBrowser = await launchBrowser('about:blank', profileDir);
  const target = await findTarget(browser.debugPort, (c) => c.url.startsWith('about:blank'), browser.log);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  return {
    evaluate: (expression) => cdp.evaluate(expression),
    goto: async (url) => { await cdp.evaluate(`(location.href = ${JSON.stringify(url)}, true)`); },
    click: (selector) => cdp.click(selector),
    doubleClick: (selector) => cdp.doubleClick(selector),
    type: (value) => cdp.typeKeys(value),
    press: (key) => cdp.key(key, KEY_CODES[key]),
    close: async () => {
      cdp.close();
      await stopBrowser(browser.process);
    },
  };
}

/** A second participant on a plain socket, typing into a box on another slide. */
class Collaborator {
  private socket: WebSocket;
  private messages: Array<{ kind: string; txnId?: string }> = [];

  constructor(port: number) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${DECK_ID}`);
    this.socket.on('message', (raw) => this.messages.push(JSON.parse(String(raw))));
  }

  async hello(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.send({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name: 'Collaborator' });
    await eventually(async () => this.messages.some((m) => m.kind === 'welcome'), 'the collaborator was never welcomed');
  }

  /** One live-sync push of a box being typed into, as the editor sends four a second. */
  push(slideId: string, element: SlideElement): void {
    this.send({
      kind: 'txn', txnId: `txn-${Math.random().toString(36).slice(2)}`, baseSeq: 0, label: 'Typing',
      ops: [{ op: 'replaceElement', slideId, elementId: element.id, element } as never],
    });
  }

  private send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * In-page instruments. Every frame's length while armed; for each keystroke,
 * the time from its keydown's own timestamp to the end of the frame after
 * the `input` it caused; for each slide step, from the keydown to the end of
 * the first frame whose canvas shows the next slide.
 */
const INSTRUMENTS = `(() => {
  const m = window.__latency = { frames: [], keys: [], steps: [], stepTo: [], stepJs: [], armed: false };
  // How long the page's own code takes to switch slides, apart from what the
  // browser then spends laying out, decoding and painting the result.
  const selectSlide = window.store.selectSlide;
  window.store.selectSlide = function (...args) {
    const t0 = performance.now();
    try { return selectSlide.apply(this, args); } finally { if (m.armed) m.stepJs.push(performance.now() - t0); }
  };
  const now = () => performance.now();
  // An event's timeStamp is when it was created, before any queueing behind a
  // busy main thread; fall back to now() where a driver's event lacks one.
  const stamp = (event) => (event.timeStamp > 0 && event.timeStamp <= now() ? event.timeStamp : now());
  const afterFrame = (fn) => requestAnimationFrame(() => setTimeout(fn, 0));
  let last = now();
  const tick = (t) => { if (m.armed) m.frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const typed = [];
  document.addEventListener('keydown', (event) => {
    if (!m.armed) return;
    if (event.key.length === 1) typed.push(stamp(event));
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const t0 = stamp(event);
      const before = window.store.get().slideIndex;
      const shown = () => {
        const state = window.store.get();
        const root = document.querySelector('.slide-layer > [data-slide-id]');
        return state.slideIndex !== before && root?.dataset.slideId === state.deck.slides[state.slideIndex].id;
      };
      const watch = () => (shown()
        ? afterFrame(() => { m.steps.push(now() - t0); m.stepTo.push(window.store.get().deck.slides[window.store.get().slideIndex].id); })
        : requestAnimationFrame(watch));
      requestAnimationFrame(watch);
    }
  }, true);
  document.addEventListener('input', () => {
    if (!m.armed) return;
    const t0 = typed.shift();
    if (t0 !== undefined) afterFrame(() => m.keys.push(now() - t0));
  }, true);
  return true;
})()`;

/** `stepTo` names the slide each of `steps` arrived at; `stepJs` is the editor's own script time for it. */
interface Measured { frames: number[]; keys: number[]; steps: number[]; stepTo: string[]; stepJs: number[] }

async function arm(page: Page): Promise<void> {
  await page.evaluate(`(() => { const m = window.__latency; m.frames = []; m.keys = []; m.steps = []; m.stepTo = []; m.stepJs = []; m.armed = true; return true; })()`);
}

async function disarm(page: Page): Promise<Measured> {
  return page.evaluate<Measured>(`(() => { const m = window.__latency; m.armed = false; return { frames: m.frames, keys: m.keys, steps: m.steps, stepTo: m.stepTo, stepJs: m.stepJs }; })()`);
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
}

const round = (values: number[]) => values.map((value) => Math.round(value)).join(' ');

/** Show a slide the way a click on its rail row does, and wait until its pictures have painted. */
async function showSlide(page: Page, slideId: string): Promise<void> {
  const shownId = () => page.evaluate<string | null>(`document.querySelector('.slide-layer > [data-slide-id]')?.dataset.slideId ?? null`);
  for (let attempt = 1; ; attempt++) {
    await page.evaluate(`(document.querySelector('.rail-item[data-slide-id="${slideId}"]').scrollIntoView({ block: 'center' }), true)`);
    await page.click(`.rail-item[data-slide-id="${slideId}"]`);
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && await shownId() !== slideId) await wait(100);
    if (await shownId() === slideId) break;
    // Leaving a text box rebuilds the rail row a moment later, and a click
    // that WebDriver aimed at the row it found first can land on the one
    // being replaced. Say so, so a harness retry never hides a real miss.
    if (attempt === 3) throw new Error(`three clicks on the rail row of ${slideId} never showed it`);
    process.stdout.write(`[latency] the rail click on ${slideId} did not show it; clicking again\n`);
  }
  await eventually(
    () => page.evaluate<{ id: string | null; pending: number }>(`(() => {
      const root = document.querySelector('.slide-layer > [data-slide-id]');
      const images = [...document.querySelectorAll('.slide-layer img')];
      return { id: root?.dataset.slideId ?? null, pending: images.filter((i) => !(i.complete && i.naturalWidth > 0)).length };
    })()`),
    `slide ${slideId} never finished painting`,
    (state) => state.id === slideId && state.pending === 0,
    60_000,
  );
}

/* ------------------------------------------------------------------------ */
/* The session                                                               */
/* ------------------------------------------------------------------------ */

let workDir = '';
let server: RunningCollabServer | null = null;

beforeAll(async () => {
  if (!ffmpeg || BROWSERS.length === 0) return;
  workDir = await mkdtemp(join(tmpdir(), 'editing-latency-'));
  await writeLatencyDeck(join(workDir, 'decks', DECK_ID), ffmpeg);
  server = await startCollabServer({
    rootDir: join(workDir, 'decks'),
    clientDir: await productionCollabClientDir(),
    host: '127.0.0.1',
    port: 0,
    mediaRenditions: { cacheDir: join(workDir, 'renditions') },
    printStillCacheDir: join(workDir, 'print-stills'),
  });
}, 240_000);

afterAll(async () => {
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

for (const kind of BROWSERS) {
  describe.skipIf(!ffmpeg)(`editing stays instant in ${kind}`, () => {
    let page: Page;
    const results: Partial<Record<'opening' | 'typing' | 'stepping' | 'collaborator', Measured>> = {};

    beforeAll(async () => {
      const profileDir = join(workDir, `profile-${kind}`);
      await mkdir(profileDir, { recursive: true });
      page = await openPage(kind, profileDir);
      await page.goto(`http://127.0.0.1:${server!.port}/?deck=${DECK_ID}&name=Latency`);
      await eventually(
        () => page.evaluate<number>(`document.querySelectorAll('.rail-item').length`),
        'the rail never listed the deck',
        (count) => count > 30,
        60_000,
      );
      await page.evaluate(INSTRUMENTS);

      // Typing into the caption on the slide of 29 pictures.
      await showSlide(page, COLLAGE);
      await wait(1000);
      // The first box opened in a page also starts the spellchecker: watch
      // the frames from the double-click until it has settled.
      await arm(page);
      await page.doubleClick(`.slide-layer [data-element-id="${CAPTION}"]`);
      await eventually(
        () => page.evaluate<string | null>(`document.querySelector('.slide-layer .element.editing')?.dataset.elementId ?? null`),
        'double-clicking the caption never opened it for typing',
        (id) => id === CAPTION,
      );
      await wait(3000);
      results.opening = await disarm(page);
      await page.press('End');
      await wait(300);
      await arm(page);
      // A brisk typist: about twelve characters a second.
      for (const character of 'sharper tokens than text') {
        await page.type(character);
        await wait(80);
      }
      await wait(1500);
      results.typing = await disarm(page);
      await page.press('Escape');
      await wait(500);

      // Stepping down the rail across the collages and the clips.
      await showSlide(page, 's5');
      await wait(1000);
      await arm(page);
      for (let step = 0; step < 14; step++) {
        await page.press('ArrowDown');
        await wait(600);
      }
      await wait(1000);
      results.stepping = await disarm(page);

      // Working on the next slide while a collaborator types on the collage,
      // whose miniature sits right above it in the rail.
      await showSlide(page, NEXT_SLIDE);
      await wait(1000);
      const collaborator = new Collaborator(server!.port);
      await collaborator.hello();
      const deck = await latencyDeck();
      const caption = deck.slides.find((slide) => slide.id === COLLAGE)!.elements.find((element) => element.id === CAPTION)!;
      await page.doubleClick(`.slide-layer [data-element-id="${NEXT_SLIDE_CAPTION}"]`);
      await eventually(
        () => page.evaluate<string | null>(`document.querySelector('.slide-layer .element.editing')?.dataset.elementId ?? null`),
        'double-clicking the next slide\'s caption never opened it for typing',
        (id) => id === NEXT_SLIDE_CAPTION,
      );
      await page.press('End');
      await wait(300);
      await arm(page);
      const words = 'and a collaborator typing elsewhere';
      for (let i = 0; i < words.length; i++) {
        await page.type(words[i]);
        if (i % 3 === 0) collaborator.push(COLLAGE, { ...caption, html: `${(caption as { html: string }).html} ${words.slice(0, i + 1)}` } as SlideElement);
        await wait(80);
      }
      await wait(1500);
      results.collaborator = await disarm(page);
      collaborator.close();
      await page.press('Escape');
    }, 300_000);

    afterAll(async () => {
      await page?.close();
      // The numbers, pass or fail, so a CI log shows how much room is left.
      for (const [scenario, measured] of Object.entries(results)) {
        const times = measured.keys.length ? measured.keys : measured.steps.length ? measured.steps : [NaN];
        process.stdout.write(`[latency] ${kind} ${scenario}: median ${Math.round(quantile(times, 0.5))} ms, `
          + `p90 ${Math.round(quantile(times, 0.9))} ms, worst ${Math.round(Math.max(...times))} ms, `
          + `longest frame ${Math.round(Math.max(0, ...measured.frames))} ms\n`);
      }
    });

    const stalls = (frames: number[]) => frames.filter((frame) => frame > BUDGET.longFrameMs);

    it('opens the first text box of a session without freezing the page', () => {
      const { frames } = results.opening!;
      const longest = Math.max(0, ...frames);
      expect(longest, `longest frame from the double-click on (frames over 50 ms: ${round(frames.filter((f) => f > 50))} ms)`)
        .toBeLessThanOrEqual(BUDGET.openingFrameMs);
    });

    it('answers each keystroke in a caption on a slide of 29 pictures within a frame or two', () => {
      const { keys, frames } = results.typing!;
      const detail = `keystrokes ${round(keys)} ms; stalls ${round(stalls(frames))} ms`;
      expect(keys.length, `every keystroke was measured (${detail})`).toBeGreaterThanOrEqual(20);
      expect(quantile(keys, 0.5), `median keystroke (${detail})`).toBeLessThanOrEqual(BUDGET.keystrokeMedianMs);
      expect(quantile(keys, 0.9), `90th percentile keystroke (${detail})`).toBeLessThanOrEqual(BUDGET.keystrokeP90Ms);
      expect(stalls(frames).length, `frames over ${BUDGET.longFrameMs} ms while typing (${detail})`).toBeLessThanOrEqual(BUDGET.typingStalls);
    });

    it('shows the next slide promptly when stepping through collages and clips', () => {
      const { steps, stepTo, stepJs, frames } = results.stepping!;
      const detail = `steps ${steps.map((ms, i) => `${stepTo[i]} ${Math.round(ms)} (script ${Math.round(stepJs[i] ?? NaN)})`).join(', ')} ms; `
        + `stalls ${round(stalls(frames))} ms`;
      expect(steps.length, `every step was measured (${detail})`).toBeGreaterThanOrEqual(10);
      expect(quantile(steps, 0.5), `median step (${detail})`).toBeLessThanOrEqual(BUDGET.slideStepMedianMs);
      expect(Math.max(...steps), `slowest step (${detail})`).toBeLessThanOrEqual(BUDGET.slideStepWorstMs);
    });

    it('stays instant while a collaborator types on a slide of pictures elsewhere', () => {
      const { keys, frames } = results.collaborator!;
      const detail = `keystrokes ${round(keys)} ms; stalls ${round(stalls(frames))} ms`;
      expect(keys.length, `every keystroke was measured (${detail})`).toBeGreaterThanOrEqual(25);
      expect(quantile(keys, 0.5), `median keystroke (${detail})`).toBeLessThanOrEqual(BUDGET.keystrokeMedianMs);
      expect(quantile(keys, 0.9), `90th percentile keystroke (${detail})`).toBeLessThanOrEqual(BUDGET.keystrokeP90Ms);
      expect(stalls(frames).length, `frames over ${BUDGET.longFrameMs} ms while typing (${detail})`).toBeLessThanOrEqual(BUDGET.typingStalls);
    });
  });
}

describe.skipIf(Boolean(ffmpeg) && BROWSERS.length > 0)('editing latency (skipped)', () => {
  it('needs ffmpeg and Electron (or Safari, on a Mac, with RUN_SAFARI_LATENCY=1)', () => {
    expect(true).toBe(true);
  });
});
