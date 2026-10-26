import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseDeck, type Deck } from '@shared/deck.js';
import {
  filesMentioned,
  findUnusedAssets,
  isSafeAssetPath,
  type DeckAssetFile,
  type DeckAssetListing,
  type DeckAssetTrashResult,
} from '@shared/mediaIndex.js';
import { ASSETS_DIR, resolveAsset } from './deckStore.js';

/**
 * The filesystem half of the Media panel, shared by the desktop main process
 * and the collab server: list a deck's `assets/` folder with what theme.css
 * and each web page in it mention, and move files the deck no longer uses
 * somewhere they can be got back from. Nothing here ever unlinks a file.
 */

/** Larger pages are not read for references; every file they could name is kept. */
const MAX_SCANNED_PAGE_BYTES = 64 * 1024 * 1024;

/** Every plain file under `assets/`: no dotfiles, no symlinks, no half-written imports. */
async function walkAssets(deckDir: string): Promise<DeckAssetFile[]> {
  const files: DeckAssetFile[] = [];
  const walk = async (relativeDir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    let entries;
    try {
      entries = await readdir(join(deckDir, relativeDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      // An import in flight writes `<name>.<uuid>.partial.<ext>` and renames
      // it into place when done (deckStore.produceAtomically).
      if (!entry.isFile() || /\.partial(\.[^.]+)?$/i.test(entry.name)) continue;
      try {
        const info = await lstat(join(deckDir, path));
        if (info.isFile()) files.push({ path, bytes: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // Gone between readdir and lstat.
      }
    }
  };
  await walk(ASSETS_DIR, 0);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The deck's asset folder and what refers to what inside it; `trash` is the caller's to fill. */
export async function scanDeckAssets(
  deckDir: string,
  themeFile: string,
  themeCss?: string,
): Promise<Omit<DeckAssetListing, 'trash'>> {
  const files = await walkAssets(deckDir);
  const paths = files.map((file) => file.path);
  let css = themeCss;
  if (css === undefined) {
    try {
      css = await readFile(resolveAsset(deckDir, themeFile || 'theme.css'), 'utf8');
    } catch {
      css = '';
    }
  }
  const pageRefs: Record<string, string[]> = {};
  for (const file of files) {
    if (!/\.x?html?$/i.test(file.path)) continue;
    if (file.bytes > MAX_SCANNED_PAGE_BYTES) {
      pageRefs[file.path] = paths.filter((path) => path !== file.path);
      continue;
    }
    try {
      const text = await readFile(join(deckDir, file.path), 'utf8');
      pageRefs[file.path] = filesMentioned(text, paths).filter((path) => path !== file.path);
    } catch {
      pageRefs[file.path] = [];
    }
  }
  return { files, themeRefs: filesMentioned(css, paths), pageRefs };
}

/**
 * Which of `requested` may go: each must be a plain file under `assets/` that
 * every deck in `decks` (the saved one, the editor's live one) leaves unused,
 * and that was not written in the last couple of minutes. The check is made
 * here, against the disk, whatever the renderer believed.
 */
export async function checkTrashable(
  deckDir: string,
  decks: Deck[],
  requested: string[],
  themeCss?: string,
): Promise<{ allowed: DeckAssetFile[]; refused: DeckAssetTrashResult['refused'] }> {
  const theme = decks[0]?.theme ?? 'theme.css';
  const listing = await scanDeckAssets(deckDir, theme, themeCss);
  const byPath = new Map(listing.files.map((file) => [file.path, file]));
  const unusedEverywhere = decks.map((deck) => new Map(
    findUnusedAssets(deck, listing, { deckText: JSON.stringify(deck) }).map((file) => [file.path, file]),
  ));
  const allowed: DeckAssetFile[] = [];
  const refused: DeckAssetTrashResult['refused'] = [];
  for (const path of [...new Set(requested)]) {
    if (!isSafeAssetPath(path)) {
      refused.push({ path: String(path), reason: 'not a file in assets/' });
      continue;
    }
    const file = byPath.get(path);
    if (!file) {
      refused.push({ path, reason: 'no such file' });
      continue;
    }
    const verdicts = unusedEverywhere.map((unused) => unused.get(path));
    if (verdicts.some((verdict) => !verdict)) {
      refused.push({ path, reason: 'the deck uses it' });
      continue;
    }
    if (verdicts.some((verdict) => verdict?.keep === 'recent')) {
      refused.push({ path, reason: 'added in the last few minutes' });
      continue;
    }
    try {
      resolveAsset(deckDir, path);
    } catch {
      refused.push({ path, reason: 'outside the deck folder' });
      continue;
    }
    allowed.push(file);
  }
  return { allowed, refused };
}

/** A deck the renderer sent, normalised; null when it is not a deck at all. */
export function parseClientDeck(raw: unknown): Deck | null {
  try {
    return parseDeck(raw);
  } catch {
    return null;
  }
}

/** `rename`, or copy-and-remove when the destination is on another volume. */
async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(from, to);
    await rm(from);
  }
}

/** Remove now-empty folders under `assets/` left behind by a move, never `assets/` itself. */
async function pruneEmptyParents(deckDir: string, path: string): Promise<void> {
  for (let dir = dirname(path); dir !== ASSETS_DIR && dir.startsWith(`${ASSETS_DIR}/`); dir = dirname(dir)) {
    try {
      await rmdir(join(deckDir, dir));
    } catch {
      return;
    }
  }
}

/**
 * Move deck files into `itemDir`, keeping their deck-relative paths, so the
 * same layout can be put back by `restoreAssets`. Used by the collab server's
 * trash (`<root>/.trash/<entry>/item`).
 */
export async function moveAssetsInto(deckDir: string, files: string[], itemDir: string): Promise<string[]> {
  const moved: string[] = [];
  for (const path of files) {
    await moveFile(join(deckDir, path), join(itemDir, path));
    moved.push(path);
    await pruneEmptyParents(deckDir, path);
  }
  return moved;
}

/**
 * Put trashed files back where they were. Refuses as a whole if any of them
 * exists again, naming it, rather than overwriting a newer file.
 */
export async function restoreAssets(itemDir: string, deckDir: string, files: string[]): Promise<void> {
  const safe = files.filter(isSafeAssetPath);
  const clash = safe.find((path) => existsSync(join(deckDir, path)));
  if (clash) throw new Error(`"${clash}" exists again in the deck — rename or remove it first`);
  for (const path of safe) {
    if (!existsSync(join(itemDir, path))) continue;
    await moveFile(join(itemDir, path), join(deckDir, path));
  }
}
