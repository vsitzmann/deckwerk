import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deck } from '@shared/deck.js';
import { exportDeck } from '../main/exportDeck.js';
import { writeFileNamed } from '../main/writeFailure.js';
import { removeTempDir, tempDir, trackHelper } from './scratch.js';
import { electronChildEnv, electronFailure, headlessElectronArgs } from './electronDisplay.js';

/**
 * Optional PNGs of slides, captured from the shared presentation renderer.
 *
 * The deck is exported to a scratch bundle and then screenshotted by Electron
 * running `scripts/capture-slides.cjs`. That indirection is the point: the
 * capture loads the same Player the app and the projector use, so a screenshot
 * cannot disagree with what a human would see.
 */

export interface RenderRequest {
  deckDir: string;
  deck: Deck;
  outDir: string;
  slides: Array<{ id: string; number: number }>;
  annotate: boolean;
  /** Fire every build, so the capture shows the finished slide. */
  built: boolean;
  /** Also compose one tiled, numbered overview of every captured slide. */
  contactSheet?: boolean;
  selectedElementIds: string[];
  /**
   * An already exported bundle of this deck to capture from, instead of
   * exporting a scratch copy. A web export that wants a thumbnail of itself
   * has just written one; copying a gigabyte of media again for a screenshot
   * would be absurd.
   */
  bundleDir?: string;
  /**
   * A fixed pause after each slide loads, before the capture waits for its
   * media. Defaults to 400 ms; tests set 0 to prove the media wait alone is
   * what puts pictures and clips in the PNG.
   */
  settleMs?: number;
  /** How long one slide's pictures and clips may take to be paintable. */
  mediaTimeoutMs?: number;
}

export interface RenderedImage {
  slideId: string;
  number: number;
  path: string;
  /**
   * Media on the slide that failed to load, or was still not paintable when
   * the wait ran out, so the PNG may be missing it. Absent when every picture
   * and clip was on screen.
   */
  problems?: string[];
}

export interface RenderResult {
  images: RenderedImage[];
  /** Path of the (first) tiled overview, when one was requested. */
  contactSheet: string | null;
  /** Every tiled overview, in slide order: one per CONTACT_SHEET_SLIDES slides. */
  contactSheets: string[];
}

export async function renderSlidesToPng(request: RenderRequest): Promise<RenderResult> {
  // A bundle made here is this render's scratch: the export of the requested
  // slides, their media included. It goes once the captures are written or
  // the render fails (and, through `cleanUpOnSignals`, when the CLI is
  // stopped). It lives in os.tmpdir(), so TMPDIR moves it.
  const ownBundle = request.bundleDir ? null : await tempDir('slide-agent-bundle-');
  try {
    // Only what the captured slides show: a deck can carry a gigabyte of
    // media, and one unreadable file on a slide nobody asked for must not
    // fail the render of every other slide.
    if (ownBundle) {
      await exportDeck(request.deckDir, request.deck, ownBundle, undefined, {
        onlySlides: new Set(request.slides.map((slide) => slide.id)),
      });
    }
    return await captureSlides(request, request.bundleDir ?? ownBundle!);
  } finally {
    if (ownBundle) await removeTempDir(ownBundle);
  }
}

async function captureSlides(request: RenderRequest, bundleDir: string): Promise<RenderResult> {
  // The job file lives with the captures, never in a caller's bundle: a web
  // export handed in here is the folder the author is about to publish.
  await mkdir(request.outDir, { recursive: true });
  const jobPath = join(request.outDir, 'capture-job.json');
  await writeFileNamed(jobPath, JSON.stringify({
    bundleDir,
    outDir: request.outDir,
    slides: request.slides,
    canvas: request.deck.canvas,
    annotate: request.annotate,
    built: request.built,
    contactSheet: request.contactSheet ?? false,
    selectedElementIds: request.selectedElementIds,
    ...(request.settleMs !== undefined ? { settleMs: request.settleMs } : {}),
    mediaTimeoutMs: request.mediaTimeoutMs ?? MEDIA_TIMEOUT_MS,
    // SLIDE_AGENT_DEBUG=1 keeps the capture's own diagnostics on stderr, which
    // is the only way to see inside a headless render that came out wrong.
    debug: process.env.SLIDE_AGENT_DEBUG === '1',
  }), 'utf8');

  let stdout: string;
  try {
    stdout = await runElectron(captureScript(), jobPath, {
      timeoutMs: captureTimeoutMs(request.slides.length),
      describe: (seconds) => `Capturing ${request.slides.length} slide(s) exceeded ${seconds} seconds; `
        + 'render fewer slides at a time with --slide, or set SLIDE_AGENT_DEBUG=1 to see where it stalls.',
    });
  } finally {
    // The capture's instructions, not one of its results.
    await rm(jobPath, { force: true });
  }
  const parsed = JSON.parse(stdout) as { images: RenderedImage[]; contactSheets?: string[] };
  const contactSheets = parsed.contactSheets ?? [];
  return { images: parsed.images, contactSheet: contactSheets[0] ?? null, contactSheets };
}

/**
 * How long one slide's media may take to become paintable before the
 * capture goes ahead and names what is missing. Well inside the per-slide
 * share of `captureTimeoutMs`, so a deck of slow clips is reported, not killed.
 */
const MEDIA_TIMEOUT_MS = 8_000;

function captureScript(): string {
  // Resolved from this module, not from the cwd: the CLI is normally run from
  // the deck folder, which is not this repository.
  return fileURLToPath(new URL('../../scripts/capture-slides.cjs', import.meta.url));
}

function electronBinary(): string {
  // Inside Electron (the editor spawning a capture for a workflow) the
  // `electron` module is the API object, not a path — but the running binary
  // itself is the Electron we want.
  if (process.versions.electron) return process.execPath;
  // Resolved lazily and through `require`: the `electron` package exports the
  // path to its executable, which is only meaningful outside Electron itself.
  return createRequire(import.meta.url)('electron') as unknown as string;
}

/**
 * Load a web page headlessly the way a web element shows it and report what a
 * PNG cannot: console errors, overflow, network dependence, bridge use.
 */
export async function checkWebPage(request: {
  pagePath: string;
  width: number;
  height: number;
  screenshot?: string | null;
}): Promise<WebPageCheck> {
  const started = Date.now();
  // `web check` immediately followed by `web add` is the documented safe
  // workflow. Both commands receive the same bridge-injected document, so
  // keep the expensive Chromium result briefly and let add reuse it. The
  // short TTL protects pages that load sibling files whose contents are not
  // represented in the HTML digest.
  const source = await readFile(request.pagePath);
  const digest = createHash('sha256')
    .update('deckwerk-web-check-v1\0')
    .update(source)
    .update(`\0${request.width}x${request.height}`)
    .digest('hex');
  const cacheDir = join(tmpdir(), 'deckwerk-web-check-cache');
  const cachedJson = join(cacheDir, `${digest}.json`);
  const cachedPng = join(cacheDir, `${digest}.png`);
  const ttlMs = 5 * 60_000;
  try {
    const info = await stat(cachedJson);
    if (Date.now() - info.mtimeMs <= ttlMs) {
      const cached = JSON.parse(await readFile(cachedJson, 'utf8')) as WebPageCheck;
      if (request.screenshot) await copyFile(cachedPng, request.screenshot);
      return {
        ...cached,
        screenshot: request.screenshot ?? null,
        cacheHit: true,
        durationMs: Date.now() - started,
      };
    }
  } catch {
    // A miss is the normal first command in the check -> add workflow.
  }

  await mkdir(cacheDir, { recursive: true });
  await pruneWebCheckCache(cacheDir, ttlMs);
  const dir = await tempDir('slide-agent-web-check-');
  const jobPath = join(dir, 'check-job.json');
  const script = fileURLToPath(new URL('../../scripts/check-web-page.cjs', import.meta.url));
  let checked: WebPageCheck;
  try {
    await writeFileNamed(jobPath, JSON.stringify({
      ...request,
      screenshot: cachedPng,
      settleMs: 800,
    }), 'utf8');
    checked = JSON.parse(await runElectron(script, jobPath, WEB_CHECK_BUDGET)) as WebPageCheck;
  } finally {
    await removeTempDir(dir);
  }
  await writeFileNamed(cachedJson, JSON.stringify({ ...checked, screenshot: null }), 'utf8');
  if (request.screenshot) await copyFile(cachedPng, request.screenshot);
  return {
    ...checked,
    screenshot: request.screenshot ?? null,
    cacheHit: false,
    durationMs: Date.now() - started,
  };
}

/**
 * Drop cached checks past their TTL. They are never read again, and the cache
 * sits in the OS temp folder, which on a quota'd tmpfs every page check used
 * to grow by a screenshot for good.
 */
async function pruneWebCheckCache(cacheDir: string, ttlMs: number): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(cacheDir).catch(() => [] as string[])) {
    const path = join(cacheDir, name);
    try {
      if (now - (await stat(path)).mtimeMs > ttlMs) await rm(path, { force: true });
    } catch {
      // Gone already (another check pruned it): nothing to do.
    }
  }
}

export interface WebPageCheck {
  ok: boolean;
  problems: string[];
  page: Record<string, unknown>;
  console: Array<{ level: string; message: string; line: number; source: string }>;
  remoteRequests: string[];
  screenshot: string | null;
  /** True when this identical page and viewport were checked in the last five minutes. */
  cacheHit: boolean;
  /** Wall-clock time spent serving this check, including cache lookup or Chromium. */
  durationMs: number;
}

/** How long one Electron child may run before it is killed, and what to say when it is. */
interface ElectronBudget {
  timeoutMs: number;
  describe: (seconds: number) => string;
}

// A malformed or unlucky page must not strand an agent behind an unbounded
// Chromium await. Healthy checks finish in ~1–2 seconds; keep a generous
// ceiling and fail with an actionable message instead of making the whole
// authoring turn appear hung. Browser startup can be heavily contended in the
// full CI tiers, so CI gets more room without turning runner load into a false
// failure in browser and bridge integration tests.
const WEB_CHECK_BUDGET: ElectronBudget = {
  timeoutMs: process.env.CI ? 60_000 : 20_000,
  describe: (seconds) => `Interactive page check exceeded ${seconds} seconds; simplify the page and retry.`,
};

/**
 * The ceiling for capturing `slideCount` slides in one Electron run.
 *
 * Capture cost grows with the deck: every slide is laid out, its fonts and
 * media awaited and its PNG encoded, and a video-heavy slide takes seconds on
 * its own. A whole-deck render once ran under the web check's 20-second
 * ceiling and was killed partway through any long talk (about 40 slides in),
 * reported as an "interactive page check" the deck did not have.
 */
export function captureTimeoutMs(slideCount: number, ci = Boolean(process.env.CI)): number {
  const perSlideMs = ci ? 30_000 : 10_000;
  return 60_000 + Math.max(1, slideCount) * perSlideMs;
}

function runElectron(script: string, jobPath: string, budget: ElectronBudget): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electronBinary(), [script, jobPath, ...headlessElectronArgs()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: electronChildEnv(),
    });
    trackHelper(child);
    let out = '';
    let err = '';
    let settled = false;
    const { timeoutMs } = budget;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(budget.describe(Math.round(timeoutMs / 1000))));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => {
      err += chunk;
      if (process.env.SLIDE_AGENT_DEBUG === '1') process.stderr.write(String(chunk));
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolvePromise(out);
      else reject(electronFailure(err, `Slide capture failed with exit code ${code}`));
    });
  });
}
