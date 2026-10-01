import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { type Deck, emptyDeck, parseDeck } from '@shared/deck.js';
import type { ImportedAsset } from '@shared/ipc.js';
import { classifyMediaName, CONVERTED_IMAGE_EXTS } from '@shared/media.js';
import { serializeSpeakerNotes, SPEAKER_NOTES_FILE } from '@shared/speakerNotes.js';
import { convertImageToPng, isWebSafeCodec, probeMedia, transcodeToH264, videoCodec } from './ffmpeg.js';
import { needsFastStart, writeFastStart } from './mp4FastStart.js';
import { copyFileStreamed } from './copyFileStreamed.js';
import { convertHeicToPng } from './heic.js';

/**
 * Reading and writing deck folders.
 *
 * A deck is a directory, not a file: `deck.json` (content and geometry),
 * `theme.css` (typography and colour, hand-edited), `assets/` (media), and an
 * optional `agent-chats.json` and `deck-history-v2.json.gz` sidecars.
 * Keeping media as real files on disk rather than embedded data is what makes
 * video practical — a 200 MB clip is referenced, never copied into the document.
 */

export const DECK_FILE = 'deck.json';
export const ASSETS_DIR = 'assets';

/**
 * Extensions a save dialog can plausibly hand us for a *new deck folder*.
 *
 * A deck is a directory with no extension, but the panel returns whatever text
 * is in its name field — and clicking an existing document in the panel's
 * browser copies that document's name, extension and all. Left alone, the
 * result is a folder called `talk.key`, which Launch Services then reports as
 * `com.apple.iwork.keynote.sffkey`: Finder draws it with a Keynote icon and
 * double-clicking it opens Keynote, which cannot read it.
 *
 * Deliberately a fixed list rather than "strip any dotted suffix", so a deck
 * legitimately named `Q3 2026 v1.2` keeps its `.2`.
 */
const PRESENTATION_EXTENSIONS = new Set(['.key', '.keynote', '.pptx', '.ppt', '.pdf', '.deck']);

/**
 * Normalise a path chosen in a save dialog into a deck folder path, dropping a
 * presentation extension the user did not mean to type.
 */
export function deckFolderPath(chosen: string): string {
  const ext = extname(chosen).toLowerCase();
  if (!PRESENTATION_EXTENSIONS.has(ext)) return chosen;
  return chosen.slice(0, -ext.length);
}


const DEFAULT_THEME = `/* Fonts, sizes and colours live here. The editor never rewrites this file. */

.slide {
  background: #ffffff;
  color: #111111;
  font-family: "Helvetica Neue", Inter, system-ui, sans-serif;
}

.element-text {
  font-size: 48px;
  line-height: 1.28;
}

.role-title, .title {
  font-size: 92px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.role-body {
  font-size: 48px;
  line-height: 1.3;
}

.role-caption, .caption {
  font-size: 30px;
  color: #666666;
}
`;

/**
 * Read a deck folder, naming the folder in every failure.
 *
 * Open surfaces this message verbatim in the status bar, so "no deck.json in
 * /Users/.../Downloads" has to be distinguishable from a deck that is present
 * but damaged: the first is the wrong folder, the second is a real problem
 * with the right one.
 */
export async function loadDeck(dir: string): Promise<Deck> {
  const path = join(dir, DECK_FILE);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`No ${DECK_FILE} in ${dir}`);
    if (code === 'EISDIR') throw new Error(`${path} is a folder, not a deck file`);
    throw new Error(`Could not read ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  try {
    return parseDeck(parsed);
  } catch (error) {
    // parseDeck reports the offending fields but knows nothing of the folder.
    throw new Error(`${path} is not a valid deck.\n${(error as Error).message}`);
  }
}

/**
 * The exact bytes `saveDeck` writes for a deck: stable 2-space JSON with a
 * trailing newline, so a deck diffs cleanly in git and a load/save round-trip
 * of an untouched deck is a no-op. Watchers compare against this to tell a
 * write of identical content from a real change.
 */
export function serializeDeck(deck: Deck): string {
  return `${JSON.stringify(parseDeck(deck), null, 2)}\n`;
}

/** Write `deck.json`, atomically. */
export async function saveDeck(dir: string, deck: Deck): Promise<string> {
  await mkdir(dir, { recursive: true });
  const json = serializeDeck(deck);
  const target = join(dir, DECK_FILE);
  // Write beside the deck, then rename over it. A truncated deck.json is the
  // one unrecoverable failure this app has — the presentation is the only
  // copy — and a plain write leaves exactly that behind if the disk fills or
  // the process dies mid-save. Rename within the folder is atomic, so a reader
  // sees either the previous deck or the new one, never half of either.
  const temporary = join(dir, `.${DECK_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, json, 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await saveSpeakerNotes(dir, deck);
  // Returned so the caller can recognise the watcher echo of this very write.
  return json;
}

/**
 * Mirror the slides' notes into `notes.md` beside the deck. Skipped when the
 * file already says exactly that, so an autosave that changed no note does not
 * touch the file an author may have open in another editor. Returns what the
 * file now holds, so a watcher can recognise the echo of this write.
 */
export async function saveSpeakerNotes(dir: string, deck: Deck): Promise<string> {
  const markdown = serializeSpeakerNotes(deck);
  const target = join(dir, SPEAKER_NOTES_FILE);
  const existing = await readFile(target, 'utf8').catch(() => null);
  if (existing === markdown) return markdown;
  const temporary = join(dir, `.${SPEAKER_NOTES_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, markdown, 'utf8');
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return markdown;
}

/**
 * Create a new deck folder.
 *
 * Refuses a folder that already holds a deck. The New save panel hands back
 * whatever name is in its field, including that of an existing presentation,
 * and its own "replace?" prompt is about replacing a *file* — agreeing to it
 * must not silently blank a real deck's slides. `copyDeck` guards Save As the
 * same way. An existing `theme.css` is likewise never overwritten: that file
 * is hand-authored and the editor's standing promise is that it never rewrites
 * it.
 */
export async function createDeck(dir: string, title?: string): Promise<Deck> {
  if (existsSync(join(dir, DECK_FILE))) {
    throw new Error(`${dir} already contains a presentation`);
  }
  await Promise.all([
    mkdir(join(dir, ASSETS_DIR), { recursive: true }),
    mkdir(join(dir, 'edit'), { recursive: true }),
  ]);
  const deck = emptyDeck(title ?? basename(dir));
  await saveDeck(dir, deck);
  const themePath = join(dir, deck.theme);
  if (!existsSync(themePath)) await writeFile(themePath, DEFAULT_THEME, 'utf8');
  return deck;
}

/** Copy a complete deck folder without overwriting an existing destination. */
export async function copyDeck(sourceDir: string, targetDir: string): Promise<Deck> {
  const source = resolve(sourceDir);
  const target = resolve(targetDir);
  if (target === source) throw new Error('Choose a different folder for Save As');
  if (target.startsWith(source + sep)) {
    throw new Error('A saved copy cannot be placed inside the open deck');
  }
  if (existsSync(target)) throw new Error(`A file or folder already exists at ${target}`);

  await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  return loadDeck(target);
}

export async function loadTheme(dir: string, theme: string): Promise<string> {
  const path = join(dir, theme);
  if (!existsSync(path)) return DEFAULT_THEME;
  return readFile(path, 'utf8');
}

export async function saveTheme(
  dir: string,
  theme: string,
  css: string,
): Promise<void> {
  await writeFile(join(dir, theme), css, 'utf8');
}

export function classifyMedia(path: string): 'image' | 'video' | null {
  return classifyMediaName(path);
}

/**
 * Copy a dropped file into `assets/`, then probe it.
 *
 * The destination name is the original stem plus a short content hash. That
 * dedupes re-drops of the same file (common when iterating on a render) while
 * keeping names human-readable in the folder, and it means two different files
 * that happen to share a name never collide.
 */
export async function importAsset(
  deckDir: string,
  sourcePath: string,
  onProgress?: (ratio: number | null) => void,
): Promise<ImportedAsset> {
  const kind = classifyMedia(sourcePath);
  if (!kind) throw new Error(`Unsupported media type: ${basename(sourcePath)}`);

  const assetsDir = join(deckDir, ASSETS_DIR);
  await mkdir(assetsDir, { recursive: true });

  const hash = await hashFile(sourcePath);
  const ext = extname(sourcePath).toLowerCase();
  const stem = sanitize(basename(sourcePath, extname(sourcePath)));
  const name = `${stem}.${hash}${ext}`;
  const dest = join(assetsDir, name);

  // The hashed name is only a cache hit when the bytes behind it are really
  // that file. A server killed mid-copy once left zero-byte files under
  // hashed names, and reusing those made every later upload of the same media
  // "succeed" as a blank image or an unplayable video.
  if (!existsSync(dest) || (await hashFile(dest)) !== hash) await copyFileStreamed(sourcePath, dest);

  // Formats Chromium cannot decode import fine and then render as nothing.
  // Both branches below re-encode on the way in, exactly as the Keynote
  // importer does, and leave the original in place as the hashed source.
  let finalName = name;

  // iPhone photos: HEIC out to PNG. Decoding is not free, and there is no
  // duration to measure it against, so the placeholder just spins.
  if (kind === 'image' && CONVERTED_IMAGE_EXTS.has(ext)) {
    const converted = `${stem}.${hash}.png`;
    const convertedPath = join(assetsDir, converted);
    onProgress?.(null);
    const convert = ext === '.heic' || ext === '.heif' ? convertHeicToPng : convertImageToPng;
    if (!(await hasContent(convertedPath))) await produceAtomically(convertedPath, (tmp) => convert(dest, tmp));
    finalName = converted;
  }

  // Screen recordings are routinely HEVC.
  if (kind === 'video') {
    const codec = await videoCodec(dest);
    if (!isWebSafeCodec(codec)) {
      const converted = `${stem}.${hash}.h264.mp4`;
      const convertedPath = join(assetsDir, converted);
      if (!(await hasContent(convertedPath))) {
        await produceAtomically(convertedPath, (tmp) => transcodeToH264(dest, tmp, onProgress));
      }
      finalName = converted;
    } else if (await needsFastStart(dest)) {
      // Playable as-is, but indexed at the tail: Chromium would seek to the
      // end of the file before painting any frame, through the asset
      // protocol, for every thumbnail that shows the clip. Move the index up
      // front with a byte-exact rewrite (no ffmpeg, nothing re-timed) and
      // serve that copy under the same stem and extension.
      const relocated = `${stem}.${hash}.fs${ext}`;
      const relocatedPath = join(assetsDir, relocated);
      onProgress?.(null);
      if (!(await hasContent(relocatedPath))) await writeFastStart(dest, relocatedPath);
      finalName = relocated;
    }
  }
  const finalPath = join(assetsDir, finalName);

  const info = await probeMedia(finalPath);
  const fallback = ext === '.pdf' ? { width: 1400, height: 1000 } : { width: null, height: null };
  return {
    src: `${ASSETS_DIR}/${finalName}`,
    kind,
    width: info.width ?? fallback.width,
    height: info.height ?? fallback.height,
    duration: info.duration,
  };
}

/** Import image bytes that have no filesystem source, such as a screenshot on
 * the OS clipboard. Content-addressing gives repeated pastes the same asset. */
export async function importImageBuffer(
  deckDir: string,
  data: Uint8Array,
  sourceName: string,
  dimensions: { width: number; height: number },
): Promise<ImportedAsset> {
  const ext = extname(sourceName).toLowerCase();
  if (classifyMediaName(sourceName) !== 'image') {
    throw new Error(`Unsupported image type: ${basename(sourceName)}`);
  }
  const assetsDir = join(deckDir, ASSETS_DIR);
  await mkdir(assetsDir, { recursive: true });
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 8);
  const stem = sanitize(basename(sourceName, extname(sourceName)));
  const name = `${stem}.${hash}${ext}`;
  const dest = join(assetsDir, name);
  if (!existsSync(dest)) await writeFile(dest, data);
  return {
    src: `${ASSETS_DIR}/${name}`,
    kind: 'image',
    width: dimensions.width,
    height: dimensions.height,
    duration: null,
  };
}

/** Name for a derived (trimmed/cropped) file that won't clash with the original. */
export async function derivedAssetPath(
  deckDir: string,
  src: string,
  suffix: string,
  extension = '.mp4',
): Promise<{ absolute: string; relative: string }> {
  const assetsDir = join(deckDir, ASSETS_DIR);
  await mkdir(assetsDir, { recursive: true });
  const stem = sanitize(basename(src, extname(src)));
  const existing = new Set(await readdir(assetsDir).catch(() => []));
  // Trim callers keep the .mp4 default; raster edits opt into .png.
  for (let n = 1; ; n++) {
    const ext = extension.startsWith('.') ? extension : `.${extension}`;
    const name = `${stem}.${suffix}${n}${ext}`;
    if (!existing.has(name)) {
      return { absolute: join(assetsDir, name), relative: `${ASSETS_DIR}/${name}` };
    }
  }
}

/**
 * Resolve a deck-relative asset path, refusing anything that escapes the deck.
 *
 * Lexical containment is not enough. A symlink planted inside `assets/`
 * resolves to a path that *looks* inside the deck while pointing anywhere on
 * disk, and the collab server streams whatever the link targets to every
 * viewer on the network (see `serveFileWithRanges`). So the real paths are
 * compared too — of the deepest existing ancestor, so a derived asset that has
 * not been written yet (`derivedAssetPath`) still resolves.
 *
 * The returned path is the lexical one, not the real one: callers layer their
 * own `deckDir`-relative prefix checks on top of it, and those would break for
 * a deck folder that itself lives under a symlink.
 */
export function resolveAsset(deckDir: string, src: string): string {
  const abs = resolve(deckDir, src);
  const root = resolve(deckDir);
  if (!contains(root, abs)) throw new Error(`Asset path escapes the deck folder: ${src}`);
  if (!contains(realPath(root), realPath(abs))) {
    throw new Error(`Asset path escapes the deck folder through a symlink: ${src}`);
  }
  return abs;
}

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * `realpathSync`, but tolerant of a path that does not exist yet: the deepest
 * existing ancestor is resolved and the missing tail appended. `resolve()` has
 * already collapsed any `..`, so the tail cannot walk back out.
 */
function realPath(target: string): string {
  const missing: string[] = [];
  for (let current = target; ; ) {
    try {
      return join(realpathSync(current), ...missing);
    } catch {
      const parent = dirname(current);
      // No existing ancestor at all (or an unreadable one): the lexical path is
      // the best answer available, and the caller's own check already saw it.
      if (parent === current) return target;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Copy a complete HTML document into `assets/web/` for a `web` element.
 *
 * Content-hashed like media, so re-importing the same page is a no-op and an
 * edited page gets a new name (and so a fresh cache entry everywhere). The
 * deck's bridge runtime is written into the page unless it already carries
 * it: that is what gives the page `window.deckwerk` and keeps the presenter's
 * arrow keys working while the page has focus.
 */
export async function importWebPage(
  deckDir: string,
  sourcePath: string,
  prepare: (html: string) => string,
): Promise<{ src: string; bytes: number }> {
  const ext = extname(sourcePath).toLowerCase();
  if (!/^\.x?html?$/.test(ext)) {
    throw new Error(`Not an HTML document: ${basename(sourcePath)}`);
  }
  const html = prepare(await readFile(sourcePath, 'utf8'));
  const hash = createHash('sha256').update(html).digest('hex').slice(0, 8);
  const stem = sanitize(basename(sourcePath, extname(sourcePath)));
  const dir = join(deckDir, ASSETS_DIR, 'web');
  await mkdir(dir, { recursive: true });
  const name = `${stem}.${hash}.html`;
  const dest = join(dir, name);
  if (!existsSync(dest)) await writeFile(dest, html, 'utf8');
  return { src: `${ASSETS_DIR}/web/${name}`, bytes: Buffer.byteLength(html, 'utf8') };
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset';
}

async function hashFile(path: string): Promise<string> {
  // Whole-file hash: partial hashing would collide across re-encodes that
  // share a header. Streamed, so a long recording is never held in memory.
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex').slice(0, 8);
}

/** A derived asset is reusable only when it exists and is not an empty leftover. */
async function hasContent(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Build a derived asset beside its final name and rename it into place, so a
 * conversion that dies partway (a crash, a killed ffmpeg) never leaves a
 * truncated file that later imports would mistake for the finished one. The
 * temporary keeps the target's extension: ffmpeg picks its muxer from it.
 */
async function produceAtomically(target: string, make: (temporary: string) => Promise<void>): Promise<void> {
  const temporary = `${target}.${randomUUID()}.partial${extname(target)}`;
  try {
    await make(temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
