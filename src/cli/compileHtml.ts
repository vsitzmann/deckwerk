import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Deck, Slide } from '@shared/deck.js';
import {
  authoringPageHtml,
  measureSlidesSource,
  measureTextOverflowsSource,
  withBase,
  type TextOverflow,
} from '@shared/htmlMeasure.js';
import { PLAYER_TYPE_CSS } from '@shared/playerTypeCss.js';
import { slidesFromMeasured, slidesToHtml, type MeasuredSlide } from '@shared/htmlSlides.js';
import { loadTheme } from '../main/deckStore.js';
import { electronFailure, headlessElectronArgs } from './electronDisplay.js';

/**
 * Compile authored HTML into deck slides with the editor closed.
 *
 * This is the offline half: a headless Electron window lays the page out and
 * reports what it measured. When the editor *is* open its own renderer does the
 * same work in an iframe — same page, same walk, no extra process — so this
 * path exists for `slide-agent apply --html` and for tests, not for the
 * everyday save-and-watch loop.
 */

const COMPILE_TIMEOUT_MS = 60_000;

export interface CompileRequest {
  deckDir: string;
  deck: Deck;
  htmlPath: string;
}

export interface CompiledHtml {
  slides: Slide[];
  /** Inline style the browser silently dropped; see `MeasuredSlide.warnings`. */
  warnings: string[];
  /**
   * What the browser measured, before any of it met the deck. The layout
   * depends only on the page, the theme and the canvas; ids and layout
   * masters come from the deck. So a deck that moved on while the page
   * compiled needs `slidesFromMeasured` again, not another browser.
   */
  measured: MeasuredSlide[];
  /** The stylesheet the page was measured against. */
  theme: string;
}

export async function compileHtmlToSlides(request: CompileRequest): Promise<CompiledHtml> {
  const authored = await readFile(request.htmlPath, 'utf8');
  const theme = await loadTheme(request.deckDir, request.deck.theme);
  // Every temporary page is removed again: left behind, each compile kept a
  // copy of the page — and each measurement a copy of everything measured,
  // tens of megabytes for a large deck — in the temp folder for good.
  return withWorkDir('slide-agent-compile-', async (work) => {
    const pagePath = join(work, 'page.html');
    await writeFile(
      pagePath,
      authoringPageHtml({
        authored,
        typeCss: PLAYER_TYPE_CSS,
        theme,
        themeHref: request.deck.theme,
        canvas: request.deck.canvas,
        base: pathToFileURL(`${request.deckDir}/`).href,
      }),
      'utf8',
    );
    const [measured] = await runPages([pagePath], request.deck.canvas) as MeasuredSlide[][];
    return {
      slides: slidesFromMeasured(request.deck, measured),
      warnings: measured.flatMap((slide) => slide.warnings ?? []),
      measured,
      theme,
    };
  });
}

/** Run `work` in a fresh temporary folder that is gone again afterwards, however it ends. */
async function withWorkDir<T>(prefix: string, work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Whether each compiled slide's text still fits once it is *built*.
 *
 * The compile above measures the author's markup; this renders what the deck
 * will actually show — the same export `inspect --html` produces, boxes fixed
 * and the auto-fit script aboard — and reports every text element whose
 * content spills past its box. That is the difference an agent cannot see in
 * the transaction itself: a fitted box that a theme or font change has pushed
 * into clipping.
 */
export async function measureBuiltTextOverflows(
  deckDir: string,
  deck: Deck,
  slides: Slide[],
): Promise<TextOverflow[]> {
  if (slides.length === 0) return [];
  return withWorkDir('slide-agent-overflow-', async (work) => {
    const pagePath = join(work, 'built.html');
    await writeFile(
      pagePath,
      slidesToHtml(slides, deck.canvas, {
        typeCss: PLAYER_TYPE_CSS,
        // The page sits in a temp folder, so assets and theme.css resolve
        // against the deck itself.
        base: pathToFileURL(`${deckDir}/`).href,
        theme: deck.theme,
      }),
      'utf8',
    );
    const [overflows] = await runPages([pagePath], deck.canvas, measureTextOverflowsSource());
    return overflows as TextOverflow[];
  });
}

/**
 * Measure a page exactly as it sits on disk: its own URL, its own `<base>`,
 * nothing assembled and nothing rewritten.
 *
 * This is what the author's browser does when they double-click the file, and
 * it is the only way to check that the two agree. Everything else here goes
 * through `authoringPageHtml`, which retargets the base — useful in production,
 * and precisely what would hide an export that only works because the compiler
 * repaired it on the way in.
 */
export async function measureSavedPage(
  pagePath: string,
  canvas: { w: number; h: number },
  script?: string,
): Promise<unknown> {
  const [result] = await runPages([pagePath], canvas, script);
  return result;
}

/**
 * The same, for many pages at once. One browser, one launch: measuring a deck
 * a page at a time otherwise spends most of its time starting Electron.
 */
export async function measureSavedPages(
  pagePaths: string[],
  canvas: { w: number; h: number },
  script?: string,
): Promise<unknown[]> {
  return runPages(pagePaths, canvas, script);
}

/**
 * Whether the headless browser behind compiling and rendering starts here:
 * null when it does, otherwise why not, in words an admin can act on.
 *
 * A server whose browser cannot start serves its pages and its WebSocket
 * perfectly well, so nothing looked wrong until the first agent save failed.
 * This is the same launch every compile makes, on a page with nothing in it.
 */
export async function headlessBrowserProblem(): Promise<string | null> {
  const work = await mkdtemp(join(tmpdir(), 'slide-agent-probe-'));
  try {
    const page = join(work, 'probe.html');
    await writeFile(page, '<!doctype html><title>probe</title><p>ok</p>', 'utf8');
    const [result] = await runPages([page], { w: 64, h: 36 }, 'document.querySelector("p")?.textContent ?? null');
    return result === 'ok' ? null : 'the headless browser started but could not lay out a page';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export interface HtmlDraftRenderAssets {
  /** File URL for the deck root while the temporary render page is open. */
  base?: string;
  /** HTTP-only stylesheets that need inlining before the page is opened from disk. */
  stylesheets?: Array<{ href: string; css: string }>;
}

/**
 * Retarget an HTTP scratchpad page for the temporary file used by Electron.
 *
 * Draft pages are normally served by the collaboration server, so their base
 * is `/decks/<id>/` and their theme points at `/api/theme`. The PNG renderer
 * writes that same page into a temp directory and opens it as `file://`; without
 * this retargeting every image resolves under `file:///decks/` and silently
 * disappears, while the theme resolves under `file:///api/` and disappears too.
 */
export function prepareHtmlDraftRenderPage(
  html: string,
  assets: HtmlDraftRenderAssets = {},
): string {
  let prepared = assets.base ? withBase(html, assets.base) : html;
  for (const stylesheet of assets.stylesheets ?? []) {
    const href = stylesheet.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const link = new RegExp(`<link\\b(?=[^>]*\\bhref=["']${href}["'])[^>]*>`, 'i');
    if (link.test(prepared)) {
      prepared = prepared.replace(link, () => `<style>${stylesheet.css}</style>`);
    }
  }
  return prepared;
}

/**
 * Render one authored/imported HTML slide, or a contact sheet of every slide,
 * inside the Electron process that is already hosting the collaboration API.
 * This gives HTTP agents visual evidence without installing their own browser.
 */
export async function renderHtmlDraftPng(
  html: string,
  canvas: { w: number; h: number },
  slideIndex: number | null,
  assets: HtmlDraftRenderAssets = {},
): Promise<Buffer> {
  const electronModule = createRequire(import.meta.url)('electron') as
    | string
    | typeof import('electron');
  const work = await mkdtemp(join(tmpdir(), 'slide-agent-draft-render-'));
  const pagePath = join(work, 'draft.html');
  const outPath = join(work, 'render.png');
  try {
    await writeFile(pagePath, prepareHtmlDraftRenderPage(html, assets), 'utf8');
    if (typeof electronModule === 'string') {
      const jobPath = join(work, 'job.json');
      await writeFile(jobPath, JSON.stringify({ pagePath, outPath, canvas, slideIndex }), 'utf8');
      await runElectron(draftRendererScript(), jobPath);
      return await readFile(outPath);
    }
    return await renderHtmlDraftPngInCurrentElectron(
      pagePath,
      work,
      canvas,
      slideIndex,
      electronModule.BrowserWindow,
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function renderHtmlDraftPngInCurrentElectron(
  pagePath: string,
  work: string,
  canvas: { w: number; h: number },
  slideIndex: number | null,
  BrowserWindow: typeof import('electron').BrowserWindow,
): Promise<Buffer> {
  const win = new BrowserWindow({
    width: canvas.w,
    height: canvas.h,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await win.loadURL(pathToFileURL(pagePath).href);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    await win.webContents.executeJavaScript(
      `Promise.all([...document.images].map((image) => image.decode().catch(() => null))).then(() => {
        const failed = [...document.images].filter((image) => !image.complete || image.naturalWidth === 0);
        if (failed.length) throw new Error('Raster assets failed to load: ' + failed.map((image) => image.currentSrc || image.src).join(', '));
        return true;
      })`,
    );
    const count = await win.webContents.executeJavaScript(
      'document.querySelectorAll("section.slide, .slide").length',
    ) as number;
    if (count === 0) throw new Error('No slides found in HTML draft');

    const capture = async (index: number) => {
      await win.webContents.executeJavaScript(`(() => {
        const slides = [...document.querySelectorAll('section.slide, .slide')];
        slides.forEach((slide, i) => { slide.style.display = i === ${index} ? '' : 'none'; });
        document.documentElement.style.margin = '0';
        document.documentElement.style.width = '${canvas.w}px';
        document.documentElement.style.height = '${canvas.h}px';
        document.documentElement.style.overflow = 'hidden';
        document.body.style.margin = '0';
        document.body.style.width = '${canvas.w}px';
        document.body.style.height = '${canvas.h}px';
        document.body.style.overflow = 'hidden';
        return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      })()`);
      return win.webContents.capturePage({ x: 0, y: 0, width: canvas.w, height: canvas.h });
    };

    if (slideIndex !== null) {
      if (slideIndex < 0 || slideIndex >= count) throw new Error(`No draft slide ${slideIndex + 1}`);
      return (await capture(slideIndex)).toPNG();
    }

    const columns = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count))));
    const thumbWidth = 420;
    const thumbHeight = Math.round((thumbWidth * canvas.h) / canvas.w);
    const gap = 12;
    const labelHeight = 28;
    const rows = Math.ceil(count / columns);
    const sheetWidth = columns * thumbWidth + (columns + 1) * gap;
    const sheetHeight = rows * (thumbHeight + labelHeight) + (rows + 1) * gap;
    const cells: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const image = (await capture(index)).resize({ width: thumbWidth, height: thumbHeight });
      cells.push(`<figure><img src="${image.toDataURL()}" width="${thumbWidth}" height="${thumbHeight}"><figcaption>${index + 1}</figcaption></figure>`);
    }
    const sheetPath = join(work, 'contact-sheet.html');
    await writeFile(sheetPath, `<!doctype html><style>
      *{box-sizing:border-box}html,body{margin:0;background:#17181c;color:#fff}
      body{display:grid;grid-template-columns:repeat(${columns},${thumbWidth}px);gap:${gap}px;padding:${gap}px}
      figure{margin:0}img{display:block;outline:1px solid #555}figcaption{height:${labelHeight}px;font:600 16px/${labelHeight}px -apple-system,sans-serif}
    </style>${cells.join('')}`, 'utf8');
    win.setContentSize(sheetWidth, sheetHeight);
    await win.loadURL(pathToFileURL(sheetPath).href);
    await win.webContents.executeJavaScript(
      'Promise.all([...document.images].map((image) => image.decode().catch(() => null))).then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))',
    );
    return (await win.webContents.capturePage({
      x: 0, y: 0, width: sheetWidth, height: sheetHeight,
    })).toPNG();
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** Hand a list of pages to the offscreen browser and collect what it measured. */
async function runPages(
  pages: string[],
  canvas: { w: number; h: number },
  script: string = measureSlidesSource(),
): Promise<unknown[]> {
  // The collaboration server is hosted by Electron when the native editor is
  // open. In that case `require('electron')` is the API object, not the path
  // returned by the npm launcher package, so spawning it as a binary fails as
  // `[object Object]`. Reuse the app's browser process directly; this is both
  // correct in packaged builds and avoids paying for a second Electron launch.
  const electronModule = createRequire(import.meta.url)('electron') as
    | string
    | typeof import('electron');
  if (typeof electronModule !== 'string') {
    return runPagesInCurrentElectron(
      pages,
      canvas,
      script,
      electronModule.BrowserWindow,
    );
  }
  return withWorkDir('slide-agent-measure-', async (work) => {
    const outPath = join(work, 'measured.json');
    const jobPath = join(work, 'job.json');
    // The walk travels with the job: the runner is a bundler-less Electron
    // script, so handing it the source is what keeps one implementation shared
    // with the live renderer.
    await writeFile(jobPath, JSON.stringify({ pages, outPath, canvas, script }), 'utf8');
    await runElectron(compilerScript(), jobPath);
    return (JSON.parse(await readFile(outPath, 'utf8')) as { results: unknown[] }).results;
  });
}

async function runPagesInCurrentElectron(
  pages: string[],
  canvas: { w: number; h: number },
  script: string,
  BrowserWindow: typeof import('electron').BrowserWindow,
): Promise<unknown[]> {
  const win = new BrowserWindow({
    width: canvas.w,
    height: canvas.h,
    show: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    const results: unknown[] = [];
    for (const page of pages) {
      await win.loadURL(pathToFileURL(page).href);
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
      results.push(await win.webContents.executeJavaScript(script));
    }
    return results;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function compilerScript(): string {
  return fileURLToPath(new URL('../../scripts/compile-slides.cjs', import.meta.url));
}

function draftRendererScript(): string {
  return fileURLToPath(new URL('../../scripts/render-html-draft.cjs', import.meta.url));
}

function runElectron(script: string, jobPath: string): Promise<string> {
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  if (!existsSync(electron)) throw new Error(`Electron is not installed at ${electron}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electron, [script, jobPath, ...headlessElectronArgs()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => {
      err += chunk;
      if (process.env.SLIDE_AGENT_DEBUG === '1') process.stderr.write(String(chunk));
    });
    // A child that fails before installing its own handlers — a syntax error
    // in the compiler, a window that never loads — keeps Electron alive with
    // nothing to do, and the CLI would wait on it forever.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`HTML compile timed out after ${COMPILE_TIMEOUT_MS / 1000}s.\n${err.trim()}`));
    }, COMPILE_TIMEOUT_MS);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(electronFailure(err, `HTML compile failed with exit code ${code}`));
    });
  });
}
