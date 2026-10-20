import type { Deck, Slide, SlideElement } from './deck.js';
import { isPendingSrc } from './media.js';

/**
 * The deck's media as a first-class list: every image, video and web page
 * (a dropped 3D model is one) a slide shows, which slides show it, and which files in `assets/`
 * nothing uses any more. Pure, so the Media panel (both shells), the desktop
 * main process and the collab server all agree on one answer.
 *
 * "Referenced" follows `referencedAssets`/`themeReferencedAssets` in
 * src/main/exportDeck.ts (what a web export copies), widened to the layout
 * masters and the theme file itself. Finding *unused* files errs the other way
 * on purpose: a file is only unused when its name appears nowhere — not in the
 * deck's elements, not in theme.css, not in any page a slide shows, and not
 * anywhere in deck.json's text — because the cost of a wrong answer is a
 * picture missing from somebody's talk.
 */

export type MediaKind = 'image' | 'video' | 'web';

export const MEDIA_KIND_LABELS: Record<MediaKind, string> = {
  image: 'Image',
  video: 'Video',
  web: 'Web page',
};

/** One place a piece of media is shown. `elementId` is null for a slide background. */
export interface MediaUsage {
  slideIndex: number;
  slideId: string;
  elementId: string | null;
}

/** One source file and everywhere it appears. */
export interface MediaItem {
  /** Deck-relative path, the identity of the item. */
  src: string;
  kind: MediaKind;
  /** The file name, for display and search. */
  name: string;
  /** In slide order, then element order. */
  usages: MediaUsage[];
  /** Zero-based indices of the slides it appears on, ascending, unique. */
  slides: number[];
  /** The first element showing it, the template for reuse; null if only a background. */
  sample: SlideElement | null;
  /** A still to show for it: the video's or page's poster, when one is set. */
  poster: string | null;
  /** A web page's title, when it has one. */
  title: string;
}

/** The last path segment of a deck-relative path. */
export function assetFileName(src: string): string {
  const clean = src.replace(/[?#].*$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1) || clean;
}

function kindOf(el: SlideElement): MediaKind | null {
  if (el.type === 'image') return 'image';
  if (el.type === 'video') return 'video';
  if (el.type === 'web') return 'web';
  return null;
}

/** Every piece of media the slides show, in order of first appearance. */
export function buildMediaIndex(deck: Deck): MediaItem[] {
  const items = new Map<string, MediaItem>();
  const add = (src: string, kind: MediaKind, usage: MediaUsage, el: SlideElement | null): void => {
    if (!src || isPendingSrc(src)) return;
    let item = items.get(src);
    if (!item) {
      item = {
        src,
        kind,
        name: assetFileName(src),
        usages: [],
        slides: [],
        sample: null,
        poster: null,
        title: '',
      };
      items.set(src, item);
    }
    // A file first met as a background and later as an element takes the
    // element's kind: that is what reusing it would make.
    if (el && !item.sample) {
      item.sample = el;
      item.kind = kind;
    }
    if (el && !item.poster && (el.type === 'video' || el.type === 'web') && el.poster) item.poster = el.poster;
    if (el && !item.title && el.type === 'web' && el.title) item.title = el.title;
    item.usages.push(usage);
    if (item.slides[item.slides.length - 1] !== usage.slideIndex) item.slides.push(usage.slideIndex);
  };
  deck.slides.forEach((slide, slideIndex) => {
    if (slide.background.image) {
      add(slide.background.image, 'image', { slideIndex, slideId: slide.id, elementId: null }, null);
    }
    for (const el of slide.elements) {
      const kind = kindOf(el);
      if (!kind || !('src' in el)) continue;
      add(el.src, kind, { slideIndex, slideId: slide.id, elementId: el.id }, el);
    }
  });
  return [...items.values()];
}

export interface MediaFilter {
  /** Null shows every kind. */
  kind: MediaKind | null;
  /** Zero-based slide index, or null for the whole deck. */
  onSlide: number | null;
  /** Case-insensitive substring of the file name (or a page's title). */
  query: string;
}

export function filterMediaItems(items: MediaItem[], filter: MediaFilter): MediaItem[] {
  const query = filter.query.trim().toLowerCase();
  return items.filter((item) => {
    if (filter.kind && item.kind !== filter.kind) return false;
    if (filter.onSlide !== null && !item.slides.includes(filter.onSlide)) return false;
    if (query && !item.name.toLowerCase().includes(query) && !item.title.toLowerCase().includes(query)) return false;
    return true;
  });
}

/* --- references -------------------------------------------------------- */

const CSS_ASSET_URL = /url\(\s*["']?(?:\.\/)?(assets\/[^"')#?]+)(?:[?#][^"')]*)?["']?\s*\)/gi;
const HTML_ASSET_PATTERNS = [
  /\b(?:src|poster)\s*=\s*["'](assets\/[^"'#?]+)(?:[?#][^"']*)?["']/gi,
  CSS_ASSET_URL,
];

function collectSourceAssets(source: string, into: Set<string>): void {
  for (const pattern of HTML_ASSET_PATTERNS) {
    for (const match of source.matchAll(pattern)) into.add(match[1]);
  }
}

function collectSlideAssets(slide: Pick<Slide, 'background' | 'elements'>, into: Set<string>): void {
  if (slide.background.image) into.add(slide.background.image);
  for (const el of slide.elements) {
    if (el.type === 'image' || el.type === 'video' || el.type === 'web') into.add(el.src);
    if ((el.type === 'video' || el.type === 'web') && el.poster) into.add(el.poster);
    if (el.type === 'html') {
      collectSourceAssets(el.html, into);
      collectSourceAssets(el.css ?? '', into);
    }
    if (el.type === 'text') collectSourceAssets(el.html, into);
    for (const value of Object.values(el.style)) collectSourceAssets(value, into);
  }
}

/**
 * Every deck-relative path deck.json points at: what the web export copies
 * (`referencedAssets`), plus the layout masters — a master no slide uses
 * still owns its pictures — and the theme file.
 */
export function deckReferencedAssets(deck: Deck): Set<string> {
  const wanted = new Set<string>();
  for (const slide of deck.slides) collectSlideAssets(slide, wanted);
  if (deck.layoutMasters) {
    for (const master of Object.values(deck.layoutMasters)) collectSlideAssets(master, wanted);
  }
  if (deck.theme) wanted.add(deck.theme);
  for (const path of [...wanted]) if (isPendingSrc(path)) wanted.delete(path);
  return wanted;
}

/**
 * Every name a text mentions, as the last path segment of each token. Used
 * to decide what a web page, theme.css or deck.json could be pointing at
 * without having to understand it: `assets/fig.png`, `../fig.png?v=2` and
 * `fetch("fig.png")` all yield `fig.png`. `data:` payloads are dropped first
 * — a 3D model page carries megabytes of base64 that names nothing.
 */
export function mentionedFileNames(text: string): Set<string> {
  const names = new Set<string>();
  const stripped = text.replace(/data:[^"'\s)]+/g, ' ');
  for (const token of stripped.split(/[\s"'()<>`=,;:*?|{}[\]\\#&]+/)) {
    if (!token.includes('.')) continue;
    const name = token.slice(token.lastIndexOf('/') + 1);
    if (name) names.add(name);
  }
  return names;
}

/** The listed files a text mentions by name. */
export function filesMentioned(text: string, files: Iterable<string>): string[] {
  const names = mentionedFileNames(text);
  return [...files].filter((file) => names.has(assetFileName(file)));
}

/* --- unused files -------------------------------------------------------- */

/** A file in the deck's `assets/` folder, as the main process or server lists it. */
export interface DeckAssetFile {
  /** Deck-relative, always under `assets/`. */
  path: string;
  bytes: number;
  mtimeMs: number;
}

/** What the backend knows about a deck's asset folder. */
export interface DeckAssetListing {
  files: DeckAssetFile[];
  /** Files theme.css mentions. */
  themeRefs: string[];
  /** For each web page in `assets/`, the files it mentions. */
  pageRefs: Record<string, string[]>;
  /** Whether "Move to Trash" is available here, and where things go. */
  trash: { available: boolean; where: string; note?: string };
}

export interface DeckAssetTrashResult {
  moved: string[];
  bytes: number;
  /** Requested files that were not moved, with why. */
  refused: Array<{ path: string; reason: string }>;
}

/** IPC channels for the desktop app (src/main/deckAssets.ts). */
export const DECK_ASSET_IPC = {
  list: 'deckAssets:list',
  trash: 'deckAssets:trash',
} as const;

export type UnusedKeepReason = 'recent' | 'history';

export interface UnusedAsset extends DeckAssetFile {
  /** Listed but left out of "Move to Trash", and why. */
  keep?: UnusedKeepReason;
  /** The used file an importer derived from this one (an HEVC original kept beside its H.264 copy). */
  originalOf?: string;
}

/** A file modified this recently may be an import still being written. */
export const RECENT_ASSET_MS = 2 * 60 * 1000;

export interface UnusedAssetOptions {
  /**
   * deck.json as text; any mention of a file's name keeps it. A function is
   * only called when some file is otherwise unused, so the common case never
   * serialises the deck.
   */
  deckText?: string | (() => string);
  /** Files an undoable earlier state of the deck still uses (lazy, like `deckText`). */
  historyRefs?: Iterable<string> | (() => Iterable<string>);
  now?: number;
}

/**
 * The files in `assets/` nothing points at: no element, background, layout
 * master, theme rule, page a slide shows, or mention in deck.json. Pages are
 * followed transitively, but only from pages that are themselves in use — an
 * unused page does not keep its own pictures alive.
 */
export function findUnusedAssets(
  deck: Deck,
  listing: Pick<DeckAssetListing, 'files' | 'themeRefs' | 'pageRefs'>,
  options: UnusedAssetOptions = {},
): UnusedAsset[] {
  const used = deckReferencedAssets(deck);
  for (const ref of listing.themeRefs) used.add(ref);
  const queue = [...used];
  while (queue.length > 0) {
    const page = queue.pop() as string;
    for (const ref of listing.pageRefs[page] ?? []) {
      if (used.has(ref)) continue;
      used.add(ref);
      queue.push(ref);
    }
  }
  let candidates = listing.files.filter((file) => !used.has(file.path));
  if (candidates.length > 0 && options.deckText !== undefined) {
    const named = mentionedFileNames(typeof options.deckText === 'function' ? options.deckText() : options.deckText);
    candidates = candidates.filter((file) => !named.has(assetFileName(file.path)));
  }
  if (candidates.length === 0) return [];
  const history = new Set(
    typeof options.historyRefs === 'function' ? options.historyRefs() : options.historyRefs ?? [],
  );
  const now = options.now ?? Date.now();
  const usedNames = [...used].map(assetFileName);
  return candidates
    .map((file): UnusedAsset => {
      const out: UnusedAsset = { ...file };
      if (history.has(file.path)) out.keep = 'history';
      else if (now - file.mtimeMs < RECENT_ASSET_MS) out.keep = 'recent';
      const derived = derivedFrom(assetFileName(file.path), usedNames);
      if (derived) out.originalOf = derived;
      return out;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The importer names files `stem.hash.ext` and keeps that original beside
 * what it derives from it (`stem.hash.h264.mp4`, `stem.hash.fs.mov`,
 * `stem.hash.png` for a HEIC). Name the derived file in use, if any.
 */
function derivedFrom(name: string, usedNames: string[]): string | undefined {
  const match = /^(.+\.[0-9a-f]{8})\.[^.]+$/i.exec(name);
  if (!match) return undefined;
  const prefix = `${match[1]}.`;
  return usedNames.find((used) => used !== name && used.startsWith(prefix));
}

/** The files `findUnusedAssets` would let "Move to Trash" take. */
export function trashableAssets(unused: UnusedAsset[]): UnusedAsset[] {
  return unused.filter((file) => !file.keep);
}

/** Deck-relative asset paths an arbitrary JSON-able value mentions. */
export function assetPathsIn(value: unknown): Set<string> {
  const found = new Set<string>();
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  } catch {
    return found;
  }
  for (const match of text.matchAll(/assets\/[^"'\s)<>\\]+/g)) found.add(match[0].replace(/[?#].*$/, ''));
  return found;
}

/**
 * Whether a requested path names a plain file inside `assets/`: no parent
 * steps, no absolute paths, no dotfiles. Both backends check this before
 * touching anything.
 */
export function isSafeAssetPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('assets/')) return false;
  const parts = path.split('/');
  return parts.length >= 2 && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.'));
}

/* --- reuse ---------------------------------------------------------------- */

export interface ReuseOptions {
  id: string;
  /** Canvas point the new element is centred on. */
  center: { x: number; y: number };
  /** The file's own pixel size, when known. */
  natural?: { w: number; h: number } | null;
  /** Largest share of the canvas the new element may take. */
  maxShare?: number;
}

/**
 * A new element showing `item`'s source, ready to push onto a slide.
 *
 * What carries over is what describes the *file*, not one placement of it:
 * - Images and videos come in at the file's natural aspect ratio, never
 *   enlarged past its pixels, fitted inside 60% of the canvas. Crop
 *   (`sourceBox`), mask, effects, border, rotation, opacity and sync group
 *   belong to one framing and are left behind — a crop would contradict
 *   "the natural aspect ratio".
 * - A video's trim (in/out points), poster and playback flags carry over only
 *   when every existing use agrees on them: then they are evidently how this
 *   deck plays the clip. Otherwise the whole file, with the defaults.
 * - An image keeps the first alt text it was given.
 * - Web pages (3D models included) keep their box size (a page is authored
 *   for its box), title, poster and interactivity.
 */
export function reuseElement(item: MediaItem, deck: Deck, options: ReuseOptions): SlideElement {
  const elements = sameSourceElements(deck, item.src);
  const sample = item.sample;
  const { canvas } = deck;
  const share = options.maxShare ?? 0.6;
  let w: number;
  let h: number;
  if (item.kind === 'web') {
    const box = sample ? { w: sample.w, h: sample.h } : { w: canvas.w * 0.8, h: canvas.h * 0.8 };
    const scale = Math.min(1, canvas.w / box.w, canvas.h / box.h);
    w = box.w * scale;
    h = box.h * scale;
  } else {
    const natural = options.natural && options.natural.w > 0 && options.natural.h > 0
      ? options.natural
      : naturalGuess(sample) ?? { w: 1600, h: 900 };
    const scale = Math.min(1, (canvas.w * share) / natural.w, (canvas.h * share) / natural.h);
    w = natural.w * scale;
    h = natural.h * scale;
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const x = Math.round(Math.min(Math.max(0, options.center.x - w / 2), Math.max(0, canvas.w - w)));
  const y = Math.round(Math.min(Math.max(0, options.center.y - h / 2), Math.max(0, canvas.h - h)));
  const base = {
    id: options.id, x, y, w, h, rot: 0, z: 0, opacity: 1, class: [] as string[], style: {} as Record<string, string>,
  };

  if (item.kind === 'video') {
    const videos = elements.filter((el): el is Extract<SlideElement, { type: 'video' }> => el.type === 'video');
    const agreed = <K extends 'start' | 'end' | 'poster' | 'autoplay' | 'loop' | 'muted' | 'controls'>(
      key: K,
      fallback: Extract<SlideElement, { type: 'video' }>[K],
    ) => (videos.length > 0 && videos.every((el) => el[key] === videos[0][key]) ? videos[0][key] : fallback);
    return {
      ...base,
      type: 'video',
      src: item.src,
      fit: 'contain',
      autoplay: agreed('autoplay', true),
      loop: agreed('loop', true),
      muted: agreed('muted', true),
      controls: agreed('controls', false),
      start: agreed('start', 0),
      end: agreed('end', null),
      poster: agreed('poster', null),
      sourceBox: null,
    };
  }
  if (item.kind === 'web') {
    const web = sample?.type === 'web' ? sample : null;
    return {
      ...base,
      type: 'web',
      src: item.src,
      poster: web?.poster ?? item.poster ?? null,
      interactive: web?.interactive ?? true,
      title: web?.title ?? item.title,
    };
  }
  const described = elements.find(
    (el): el is Extract<SlideElement, { type: 'image' }> => el.type === 'image' && el.alt !== '',
  );
  return {
    ...base,
    type: 'image',
    src: item.src,
    fit: 'contain',
    alt: described?.alt || item.name,
    sourceBox: null,
  };
}

/** Every element in the deck whose source is `src`. */
function sameSourceElements(deck: Deck, src: string): SlideElement[] {
  return deck.slides.flatMap((slide) => slide.elements.filter((el) => 'src' in el && el.src === src));
}

/**
 * The aspect a placed element implies when the file's own size is unknown:
 * an uncropped element's box, or a crop's full-picture box.
 */
function naturalGuess(sample: SlideElement | null): { w: number; h: number } | null {
  if (!sample || (sample.type !== 'image' && sample.type !== 'video')) return null;
  if (sample.sourceBox) return { w: sample.sourceBox.w, h: sample.sourceBox.h };
  return { w: sample.w, h: sample.h };
}

/** Where "Add to slide" puts a new copy: the centre, stepped off any copy already there. */
export function reuseCenter(slide: Slide, deck: Deck, src: string): { x: number; y: number } {
  const center = { x: deck.canvas.w / 2, y: deck.canvas.h / 2 };
  const occupied = (point: { x: number; y: number }) => slide.elements.some((el) =>
    'src' in el && el.src === src && Math.abs(el.x + el.w / 2 - point.x) < 2 && Math.abs(el.y + el.h / 2 - point.y) < 2);
  for (let step = 0; step < 12 && occupied(center); step++) {
    center.x += 40;
    center.y += 40;
  }
  return center;
}

/* --- formatting ------------------------------------------------------------ */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "1, 3–5, 9" for one-based slide numbers. */
export function formatSlideRanges(indices: number[]): string {
  const numbers = [...new Set(indices)].sort((a, b) => a - b).map((i) => i + 1);
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    parts.push(j - i >= 2 ? `${numbers[i]}–${numbers[j]}` : numbers.slice(i, j + 1).join(', '));
    i = j;
  }
  return parts.join(', ');
}
