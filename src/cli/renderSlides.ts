import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deck } from '@shared/deck.js';
import { exportDeck } from '../main/exportDeck.js';
import { tempDir } from './agentCli.js';
import { electronFailure, headlessElectronArgs } from './electronDisplay.js';

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
}

export interface RenderedImage {
  slideId: string;
  number: number;
  path: string;
}

export interface RenderResult {
  images: RenderedImage[];
  /** Path of the tiled overview, when one was requested. */
  contactSheet: string | null;
}

export async function renderSlidesToPng(request: RenderRequest): Promise<RenderResult> {
  // A bundle made here is the deck's whole web export, media and all; it is
  // this render's scratch and goes once the captures are written.
  const ownBundle = request.bundleDir ? null : await tempDir('slide-agent-bundle-');
  try {
    if (ownBundle) await exportDeck(request.deckDir, request.deck, ownBundle);
    return await captureSlides(request, request.bundleDir ?? ownBundle!);
  } finally {
    if (ownBundle) await rm(ownBundle, { recursive: true, force: true });
  }
}

async function captureSlides(request: RenderRequest, bundleDir: string): Promise<RenderResult> {
  // The job file lives with the captures, never in a caller's bundle: a web
  // export handed in here is the folder the author is about to publish.
  await mkdir(request.outDir, { recursive: true });
  const jobPath = join(request.outDir, 'capture-job.json');
  await writeFile(jobPath, JSON.stringify({
    bundleDir,
    outDir: request.outDir,
    slides: request.slides,
    canvas: request.deck.canvas,
    annotate: request.annotate,
    built: request.built,
    contactSheet: request.contactSheet ?? false,
    selectedElementIds: request.selectedElementIds,
    // SLIDE_AGENT_DEBUG=1 keeps the capture's own diagnostics on stderr, which
    // is the only way to see inside a headless render that came out wrong.
    debug: process.env.SLIDE_AGENT_DEBUG === '1',
  }), 'utf8');

  const stdout = await runElectron(captureScript(), jobPath);
  const parsed = JSON.parse(stdout) as { images: RenderedImage[]; contactSheet?: string | null };
  return { images: parsed.images, contactSheet: parsed.contactSheet ?? null };
}

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
  const dir = await tempDir('slide-agent-web-check-');
  const jobPath = join(dir, 'check-job.json');
  await writeFile(jobPath, JSON.stringify({
    ...request,
    screenshot: cachedPng,
    settleMs: 800,
  }), 'utf8');
  const script = fileURLToPath(new URL('../../scripts/check-web-page.cjs', import.meta.url));
  let checked: WebPageCheck;
  try {
    checked = JSON.parse(await runElectron(script, jobPath)) as WebPageCheck;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await writeFile(cachedJson, JSON.stringify({ ...checked, screenshot: null }), 'utf8');
  if (request.screenshot) await copyFile(cachedPng, request.screenshot);
  return {
    ...checked,
    screenshot: request.screenshot ?? null,
    cacheHit: false,
    durationMs: Date.now() - started,
  };
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

function runElectron(script: string, jobPath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electronBinary(), [script, jobPath, ...headlessElectronArgs()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let out = '';
    let err = '';
    let settled = false;
    // A malformed or unlucky page must not strand an agent behind an
    // unbounded Chromium await. Healthy checks finish in ~1–2 seconds; keep a
    // generous ceiling and fail with an actionable message instead of making
    // the whole authoring turn appear hung.
    // Browser startup can be heavily contended in the full CI tiers even
    // though an isolated agent check normally finishes in ~1–2 seconds.
    // Preserve the fast local failure bound without turning runner load into
    // a false failure in browser and bridge integration tests.
    const timeoutMs = process.env.CI ? 60_000 : 20_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Interactive page check exceeded ${timeoutMs / 1000} seconds; simplify the page and retry.`));
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
