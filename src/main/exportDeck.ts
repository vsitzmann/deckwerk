import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import type { Deck, Slide } from '@shared/deck.js';
import type { WebExportQuality } from '@shared/ipc.js';
import { loadTheme, resolveAsset } from './deckStore.js';
import { encodeImageWebp, probeImage, probeMedia, transcodeVideoForWeb } from './ffmpeg.js';
import { copyFileStreamed } from './copyFileStreamed.js';

/**
 * Export a deck as a self-contained folder that opens in any browser.
 *
 * The exported page runs the same `Player` as the app, so a deck presents
 * identically whether or not the editor is installed. That matters for the
 * usual conference situation: someone else's laptop, no install rights, five
 * minutes before the talk.
 *
 * Only media the slides actually show is copied, and a quality below
 * `original` re-encodes it on the way out: a talk's worth of screen
 * recordings is routinely a gigabyte in the deck folder and a tenth of that on
 * a web host without anyone in the audience noticing.
 */

/** Where the export player bundle lives, in dev and when packaged. */
function playerBundleDir(): string {
  const candidates = [
    join(import.meta.dirname, '../export'),
    join(import.meta.dirname, '../../out/export'),
    join(process.cwd(), 'out/export'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'player.js'))) ?? candidates[0];
}

/**
 * Why a web export cannot run right now, or null when it can.
 *
 * The export player is a build artefact rather than source, so a checkout that
 * has not run `npm run build:export` — or a server deployed without it — can
 * only find out by trying. Callers that hand the result straight to a browser
 * download need to know before they start writing bytes.
 */
export function webExportUnavailableReason(): string | null {
  const playerJs = join(playerBundleDir(), 'player.js');
  return existsSync(playerJs)
    ? null
    : `Export player bundle not found at ${playerJs}. Run: npm run build:export`;
}

export interface WebExportOptions {
  quality?: WebExportQuality;
  /**
   * Leave skipped slides out of the export altogether, media included. The
   * player already walks past them; a web export has no reason to ship them.
   * Off by default because the agent's slide captures address slides by their
   * rail number, which counts skipped ones.
   */
  dropSkipped?: boolean;
  /** Re-encodes running at once. Two keeps libx264 busy without thrashing. */
  concurrency?: number;
}

/** What the export wrote, for callers that describe the result or index it. */
export interface WebExportResult {
  /** Deck-relative asset paths that were copied or re-encoded. */
  assets: number;
  /** Bytes the referenced originals occupy in the deck folder. */
  sourceBytes: number;
  /** Bytes the exported media occupies. */
  exportedBytes: number;
  quality: WebExportQuality;
}

interface VideoProfile {
  codec: 'h264' | 'vp9';
  crf: number;
  speed: string;
  audioBitrate: string;
  /** Hard ceiling on the long edge, whatever the slide shows. */
  maxLongEdge: number;
  /** Multiple of the on-slide size (at 1920×1080) that is kept for sharpness. */
  renderedScale: number;
}

interface ImageProfile {
  quality: number;
  maxLongEdge: number;
  renderedScale: number;
  /** Files smaller than this are copied as they are; re-encoding buys nothing. */
  minBytes: number;
}

interface QualityProfile {
  video: VideoProfile | null;
  image: ImageProfile | null;
}

const PROFILES: Record<WebExportQuality, QualityProfile> = {
  original: { video: null, image: null },
  balanced: {
    video: { codec: 'vp9', crf: 36, speed: '2', audioBitrate: '96k', maxLongEdge: 1920, renderedScale: 1.5 },
    image: { quality: 88, maxLongEdge: 2560, renderedScale: 2, minBytes: 120_000 },
  },
  compact: {
    video: { codec: 'vp9', crf: 42, speed: '2', audioBitrate: '64k', maxLongEdge: 1280, renderedScale: 1 },
    image: { quality: 75, maxLongEdge: 1600, renderedScale: 1.25, minBytes: 40_000 },
  },
};

const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mpg', '.mpeg', '.wmv', '.ogv']);
/** Stills worth re-encoding. GIF and SVG stay as they are: one animates, one has no pixels. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.avif']);

export async function exportDeck(
  deckDir: string,
  deck: Deck,
  outDir: string,
  onProgress?: (message: string, ratio: number | null) => void,
  options: WebExportOptions = {},
): Promise<WebExportResult> {
  const unavailable = webExportUnavailableReason();
  if (unavailable) throw new Error(unavailable);
  const bundleDir = playerBundleDir();
  const playerJs = join(bundleDir, 'player.js');
  const quality = options.quality ?? 'original';
  const profile = PROFILES[quality];

  const exported: Deck = options.dropSkipped
    ? { ...deck, slides: deck.slides.filter((slide) => !slide.skipped) }
    : deck;
  const wanted = referencedAssets(exported);
  // theme.css names files no slide does: a webfont's `@font-face`, a paper
  // texture. It ships as written, so those go across under their own names.
  const theme = await loadTheme(deckDir, deck.theme);
  const themeAssets = themeReferencedAssets(theme);

  // Progress is weighted by bytes: a 120 MB screen recording is most of the
  // wait, and a bar that ticked once per file would sit still for minutes on
  // it and then race through fifty small figures.
  const sources = await measureSources(deckDir, new Set([...wanted, ...themeAssets]));
  const mediaBytes = [...sources.values()].reduce((sum, s) => sum + s.bytes, 0);
  // Five fixed steps share a nominal weight so an asset-free deck still moves.
  const fixedWeight = Math.max(1, mediaBytes / 20);
  const totalWeight = mediaBytes + fixedWeight * 5;
  let doneWeight = 0;
  const report = (message: string, extra = 0): void => {
    onProgress?.(message, Math.min(1, (doneWeight + extra) / totalWeight));
  };

  report(`Creating ${outDir}`);
  await mkdir(outDir, { recursive: true });
  doneWeight += fixedWeight;

  report('Copying player.js');
  await copyFileStreamed(playerJs, join(outDir, 'player.js'));
  doneWeight += fixedWeight;

  // The player's structural CSS, then the deck's theme, in that order — the
  // theme must win, exactly as it does in the app.
  const playerCss = join(bundleDir, 'player.css');
  report('Writing player.css');
  const structural = existsSync(playerCss) ? await readFile(playerCss, 'utf8') : '';
  await writeFile(join(outDir, 'player.css'), structural, 'utf8');
  doneWeight += fixedWeight;

  report(`Writing ${deck.theme}`);
  await writeFile(join(outDir, 'theme.css'), theme, 'utf8');
  doneWeight += fixedWeight;

  // The folder exists even when every reference turned out to be unusable, so
  // a reader of the export sees "no assets" rather than "no assets folder".
  if (wanted.size > 0 || themeAssets.size > 0) await mkdir(join(outDir, 'assets'), { recursive: true });
  const renamed = new Map<string, string>();
  const trimmed = new Map<string, number>();
  // What the slides' copies wrote in this run, so the theme's pass below can
  // tell "a slide already shipped this" from "an earlier export left it here".
  const written = new Set<string>();
  let exportedBytes = 0;
  const jobs = [...wanted].map((rel, index) => async () => {
    const source = sources.get(rel);
    const name = rel.split('/').pop() ?? rel;
    if (!source) {
      // Outside the deck folder, or simply not there: the deck's problem to
      // show, not a reason to abandon the export.
      return;
    }
    const label = `${index + 1} of ${wanted.size}`;
    const range = playedRange(exported, rel);
    const outcome = await exportAsset(
      source,
      rel,
      outDir,
      profile,
      renderedLongEdge(exported, rel),
      range,
      (verb, fraction) => report(`${verb} assets/${name} (${label})`, source.bytes * fraction),
    );
    doneWeight += source.bytes;
    exportedBytes += outcome.bytes;
    written.add(outcome.to);
    if (outcome.rel !== rel) renamed.set(rel, outcome.rel);
    if (outcome.trimmedFrom !== undefined) trimmed.set(rel, outcome.trimmedFrom);
  });
  await runPool(jobs, Math.max(1, options.concurrency ?? 2));

  // Byte for byte, and only what a slide's copy did not already put there
  // unchanged: a re-encoded picture leaves its original name free, and the
  // theme still points at that name. A file an earlier export left in the
  // folder is overwritten, or a re-export would keep shipping the old font.
  for (const rel of themeAssets) {
    const source = sources.get(rel);
    const to = source ? join(outDir, source.within) : null;
    if (!source || !to || written.has(to)) continue;
    report(`Copying ${rel}`);
    await mkdir(dirname(to), { recursive: true });
    await copyFileStreamed(source.path, to);
    doneWeight += source.bytes;
    exportedBytes += source.bytes;
  }

  report('Writing index.html');
  const rewritten = renamed.size > 0 || trimmed.size > 0
    ? rewriteAssetReferences(exported, renamed, trimmed)
    : exported;
  await writeFile(join(outDir, 'index.html'), indexHtml(rewritten), 'utf8');
  await writeFile(
    join(outDir, 'export.json'),
    JSON.stringify({
      title: deck.title,
      slides: rewritten.slides.length,
      canvas: deck.canvas,
      quality,
      exportedAt: new Date().toISOString(),
    }, null, 2) + '\n',
    'utf8',
  );
  doneWeight += fixedWeight;
  onProgress?.('Web export complete', 1);
  return { assets: sources.size, sourceBytes: mediaBytes, exportedBytes, quality };
}

interface SourceAsset {
  /** Absolute path inside the deck folder. */
  path: string;
  /** Path relative to the deck folder, as the deck refers to it. */
  within: string;
  bytes: number;
}

/**
 * Resolve every wanted reference to a file inside the deck folder. Never
 * follow a reference out of the deck — lexically or through a symlink planted
 * in `assets/`, which `resolveAsset` also refuses.
 */
async function measureSources(deckDir: string, wanted: Set<string>): Promise<Map<string, SourceAsset>> {
  const sources = new Map<string, SourceAsset>();
  for (const rel of wanted) {
    let path: string;
    try {
      path = resolveAsset(deckDir, rel);
    } catch {
      continue;
    }
    const within = relative(resolve(deckDir), path);
    if (within === '') continue;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      sources.set(rel, { path, within, bytes: info.size });
    } catch {
      // Missing file: skipped, the player shows the gap.
    }
  }
  return sources;
}

async function runPool(jobs: Array<() => Promise<void>>, width: number): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await job();
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, worker));
}

/**
 * Copy or re-encode one asset into the export. Returns the deck-relative path
 * it landed under, which differs from the source only when the container
 * changed (a `.mov` becomes `.mp4`, a `.png` becomes `.webp`).
 */
async function exportAsset(
  source: SourceAsset,
  rel: string,
  outDir: string,
  profile: QualityProfile,
  renderedEdge: number,
  range: PlayedRange | null,
  progress: (verb: string, fraction: number) => void,
): Promise<{ rel: string; bytes: number; to: string; trimmedFrom?: number }> {
  const ext = extname(source.within).toLowerCase();
  const copy = async (): Promise<{ rel: string; bytes: number; to: string }> => {
    progress('Copying', 0);
    const to = join(outDir, source.within);
    await mkdir(dirname(to), { recursive: true });
    await copyFileStreamed(source.path, to);
    return { rel, bytes: source.bytes, to };
  };

  if (profile.video && VIDEO_EXTENSIONS.has(ext)) {
    const container = profile.video.codec === 'vp9' ? '.webm' : '.mp4';
    const target = withExtension(source.within, container);
    const encoded = await encodeVideo(source, join(outDir, target), profile.video, renderedEdge, range, progress);
    if (encoded !== null) {
      return { rel: withExtension(rel, container), bytes: encoded, to: join(outDir, target), trimmedFrom: range?.start };
    }
    return copy();
  }
  if (profile.image && IMAGE_EXTENSIONS.has(ext) && source.bytes >= profile.image.minBytes) {
    const target = withExtension(source.within, '.webp');
    const encoded = await encodeImage(source, join(outDir, target), profile.image, renderedEdge, progress);
    if (encoded !== null) return { rel: withExtension(rel, '.webp'), bytes: encoded, to: join(outDir, target) };
    return copy();
  }
  return copy();
}

/** Re-encode, then keep the result only if it is actually smaller. */
async function encodeVideo(
  source: SourceAsset,
  output: string,
  profile: VideoProfile,
  renderedEdge: number,
  range: PlayedRange | null,
  progress: (verb: string, fraction: number) => void,
): Promise<number | null> {
  progress('Compressing', 0);
  const info = await probeMedia(source.path);
  const size = fitLongEdge(info.width, info.height, targetLongEdge(profile, renderedEdge));
  await mkdir(dirname(output), { recursive: true });
  // A clip cut to what the slides play is smaller for free, so a trim is
  // worth keeping even when the re-encode itself is not.
  const trim = range && (range.start > 0 || info.duration === null || range.end < info.duration - 0.05)
    ? { start: range.start, duration: Math.max(0.1, range.end - range.start + TRIM_TAIL_SECONDS) }
    : undefined;
  try {
    await transcodeVideoForWeb(
      source.path,
      output,
      {
        codec: profile.codec, crf: profile.crf, speed: profile.speed, audioBitrate: profile.audioBitrate,
        ...size, trim,
      },
      (ratio) => progress('Compressing', ratio ?? 0),
    );
  } catch {
    await rm(output, { force: true });
    return null;
  }
  if (trim) return (await stat(output)).size;
  return keepIfSmaller(output, source.bytes);
}

/**
 * A breath of footage past the last frame a slide plays, so the player's own
 * end-of-range stop lands inside the file rather than on its final frame.
 */
const TRIM_TAIL_SECONDS = 0.1;

export interface PlayedRange {
  start: number;
  end: number;
}

/**
 * The stretch of a clip the slides play, when every showing of it is a video
 * element with an explicit end. A clip that some slide plays to its natural
 * end, or that an HTML region embeds, is kept whole: nothing says where it
 * could safely be cut.
 */
export function playedRange(deck: Deck, rel: string): PlayedRange | null {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  let shown = false;
  for (const slide of deck.slides) {
    for (const el of slide.elements) {
      if (el.type === 'html' && (el.html.includes(rel) || (el.css ?? '').includes(rel))) return null;
      if (el.type !== 'video' || el.src !== rel) continue;
      if (el.end === null || el.end === undefined || el.end <= (el.start ?? 0)) return null;
      shown = true;
      start = Math.min(start, Math.max(0, el.start ?? 0));
      end = Math.max(end, el.end);
    }
  }
  return shown ? { start, end } : null;
}

async function encodeImage(
  source: SourceAsset,
  output: string,
  profile: ImageProfile,
  renderedEdge: number,
  progress: (verb: string, fraction: number) => void,
): Promise<number | null> {
  progress('Compressing', 0);
  const info = await probeImage(source.path);
  // An animated WebP or APNG is a clip in a still's clothing; a single frame
  // of it would freeze the slide. Leave it alone.
  if (info.frames !== null && info.frames > 1) return null;
  const size = fitLongEdge(info.width, info.height, targetLongEdge(profile, renderedEdge));
  await mkdir(dirname(output), { recursive: true });
  try {
    await encodeImageWebp(source.path, output, { quality: profile.quality, ...size });
  } catch {
    await rm(output, { force: true });
    return null;
  }
  return keepIfSmaller(output, source.bytes);
}

async function keepIfSmaller(output: string, originalBytes: number): Promise<number | null> {
  const bytes = (await stat(output)).size;
  if (bytes > 0 && bytes < originalBytes) return bytes;
  // Already well compressed: the original is the better file. Remove the
  // attempt so the export folder holds exactly one copy under one name.
  await rm(output, { force: true });
  return null;
}

function targetLongEdge(profile: { maxLongEdge: number; renderedScale: number }, renderedEdge: number): number {
  return Math.round(Math.min(profile.maxLongEdge, Math.max(64, renderedEdge * profile.renderedScale)));
}

/** Output size when the long edge exceeds `longEdge`; empty to keep the source size. */
function fitLongEdge(
  width: number | null,
  height: number | null,
  longEdge: number,
): { width?: number; height?: number } {
  if (!width || !height) return {};
  const current = Math.max(width, height);
  if (current <= longEdge) return {};
  const scale = longEdge / current;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function withExtension(path: string, ext: string): string {
  const current = extname(path);
  return current ? path.slice(0, -current.length) + ext : path + ext;
}

/**
 * The largest edge, in canvas pixels, at which any slide shows this asset. A
 * figure in a 400×300 box needs nowhere near its 4000-pixel original; a
 * full-bleed background needs the whole canvas.
 */
export function renderedLongEdge(deck: Deck, rel: string): number {
  const canvasEdge = Math.max(deck.canvas.w, deck.canvas.h);
  let edge = 0;
  for (const slide of deck.slides) {
    if (slide.background.image === rel) edge = Math.max(edge, canvasEdge);
    for (const el of slide.elements) {
      if (el.type === 'image' || el.type === 'video') {
        if (el.src !== rel && !(el.type === 'video' && el.poster === rel)) continue;
        // A crop shows a window onto the whole picture: the picture itself is
        // laid out at the source box's size, which can exceed the element.
        const box = el.sourceBox ?? el;
        edge = Math.max(edge, box.w, box.h);
      } else if (el.type === 'html' && (el.html.includes(rel) || (el.css ?? '').includes(rel))) {
        // Nothing measures inside an HTML region; assume it could be anything
        // up to the region's own box.
        edge = Math.max(edge, el.w, el.h);
      }
    }
  }
  return edge > 0 ? edge : canvasEdge;
}

/** Every deck-relative asset path the slides show, deduplicated. */
export function referencedAssets(deck: Deck): Set<string> {
  const wanted = new Set<string>();
  for (const slide of deck.slides) {
    if (slide.background.image) wanted.add(slide.background.image);
    for (const el of slide.elements) {
      if (el.type === 'image' || el.type === 'video') wanted.add(el.src);
      if (el.type === 'video' && el.poster) wanted.add(el.poster);
      if (el.type === 'web') {
        wanted.add(el.src);
        if (el.poster) wanted.add(el.poster);
      }
      if (el.type === 'html') {
        collectFallbackAssets(el.html, wanted);
        collectFallbackAssets(el.css ?? '', wanted);
      }
      // A picture can also live in the element's own CSS (a background image,
      // text filled with a picture) or in a styled run of its text.
      for (const value of Object.values(el.style)) collectFallbackAssets(value, wanted);
      if (el.type === 'text') collectFallbackAssets(el.html, wanted);
    }
  }
  return wanted;
}

/** The deck files theme.css refers to with `url(assets/…)` or `url(./assets/…)`. */
export function themeReferencedAssets(css: string): Set<string> {
  const wanted = new Set<string>();
  for (const match of css.matchAll(CSS_ASSET_URL)) wanted.add(match[1]);
  return wanted;
}

/** Assets referenced only by an isolated HTML region still belong in exports. */
function collectFallbackAssets(source: string, wanted: Set<string>): void {
  for (const pattern of HTML_ASSET_PATTERNS) {
    for (const match of source.matchAll(pattern)) wanted.add(match[1]);
  }
}

const CSS_ASSET_URL = /url\(\s*["']?(?:\.\/)?(assets\/[^"')#?]+)(?:[?#][^"')]*)?["']?\s*\)/gi;

const HTML_ASSET_PATTERNS = [
  /\b(?:src|poster)\s*=\s*["'](assets\/[^"'#?]+)(?:[?#][^"']*)?["']/gi,
  CSS_ASSET_URL,
];

/**
 * The deck as the export refers to it: every reference to a re-encoded asset
 * points at the new file. The deck on disk is never touched.
 */
export function rewriteAssetReferences(
  deck: Deck,
  renamed: Map<string, string>,
  trimmed: Map<string, number> = new Map(),
): Deck {
  const swap = (path: string | null): string | null =>
    path !== null && renamed.has(path) ? (renamed.get(path) as string) : path;
  // A cut clip starts where the slides used to seek to, so their in and out
  // points shift back by the same amount.
  const shift = (src: string, seconds: number | null | undefined): number | null | undefined => {
    const offset = trimmed.get(src);
    if (offset === undefined || seconds === null || seconds === undefined) return seconds;
    return Math.max(0, seconds - offset);
  };
  const swapInSource = (source: string): string => {
    let out = source;
    for (const pattern of HTML_ASSET_PATTERNS) {
      out = out.replace(pattern, (whole, path: string) =>
        renamed.has(path) ? whole.replace(path, renamed.get(path) as string) : whole,
      );
    }
    return out;
  };
  const rewriteSlide = <T extends Pick<Slide, 'background' | 'elements'>>(slide: T): T => ({
    ...slide,
    background: { ...slide.background, image: swap(slide.background.image) },
    elements: slide.elements.map((original) => {
      const el = Object.values(original.style).some((value) => value.includes('url('))
        ? { ...original, style: Object.fromEntries(Object.entries(original.style).map(([k, v]) => [k, swapInSource(v)])) }
        : original;
      if (el.type === 'image') return { ...el, src: swap(el.src) as string };
      if (el.type === 'video') {
        return {
          ...el,
          src: swap(el.src) as string,
          poster: swap(el.poster),
          start: shift(el.src, el.start) ?? el.start,
          end: shift(el.src, el.end) ?? el.end,
        };
      }
      if (el.type === 'html') {
        return { ...el, html: swapInSource(el.html), css: el.css === undefined ? el.css : swapInSource(el.css) };
      }
      if (el.type === 'text') return { ...el, html: swapInSource(el.html) };
      return el;
    }),
  });
  return {
    ...deck,
    slides: deck.slides.map(rewriteSlide),
    layoutMasters: deck.layoutMasters === null
      ? deck.layoutMasters
      : Object.fromEntries(
        Object.entries(deck.layoutMasters).map(([name, master]) => [name, rewriteSlide(master)]),
      ) as Deck['layoutMasters'],
  };
}

/**
 * The generated page. The deck is inlined as JSON so the export works off
 * `file://`, where fetching a sibling .json is blocked by CORS.
 */
function indexHtml(deck: Deck): string {
  // `</script>` inside the JSON would close the tag early; escaping the slash is
  // the standard defence and stays valid JSON.
  const json = JSON.stringify(deck).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(deck.title)}</title>
    <link rel="stylesheet" href="./player.css" />
    <link rel="stylesheet" href="./theme.css" />
    <style>
      html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
      #root { width: 100vw; height: 100vh; }
      body:fullscreen #root { cursor: none; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>window.__DECK__ = ${json};</script>
    <script src="./player.js"></script>
  </body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
