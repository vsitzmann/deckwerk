import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Deck } from '../shared/deck.js';
import type { DeckAssetListing, DeckAssetTrashResult } from '../shared/mediaIndex.js';
import { formatBytes } from '../shared/mediaIndex.js';
import { checkTrashable, moveAssetsInto, restoreAssets, scanDeckAssets } from '../main/deckAssets.js';

/**
 * The Media panel on the collab server. Unused asset files go into the same
 * trash a deleted deck does (`<root>/.trash/<entry>/item`, see the trash in
 * collabServer.ts): one entry per "Move unused to Trash", whose `item/` keeps
 * the files under their deck-relative paths and whose `trash.json` says which
 * deck they came from. The Trash… dialog lists it and Restore puts them back.
 */

export interface AssetTrashMeta {
  /** The deck the files came from. */
  originalPath: string;
  kind: 'assets';
  name: string;
  files: string[];
  deletedAt: string;
  deletedBy: string;
}

export async function deckAssetListing(
  deckDir: string,
  deck: Deck,
  themeCss: string,
  trashAvailable: boolean,
): Promise<DeckAssetListing> {
  const scan = await scanDeckAssets(deckDir, deck.theme, themeCss);
  return {
    ...scan,
    trash: trashAvailable
      ? { available: true, where: "the server's Trash", note: 'Presentations → Trash… puts them back.' }
      : { available: false, where: '', note: 'This shared session has no Trash, so unused files are only listed.' },
  };
}

/**
 * Recheck `files` against the live deck and theme, then move the ones that
 * really are unused into a new trash entry. Nothing is unlinked.
 */
export async function trashDeckAssets(options: {
  trashDir: string;
  entryId: string;
  deckId: string;
  deckDir: string;
  deck: Deck;
  themeCss: string;
  files: string[];
  deletedBy: string;
}): Promise<DeckAssetTrashResult> {
  const { allowed, refused } = await checkTrashable(options.deckDir, [options.deck], options.files, options.themeCss);
  if (allowed.length === 0) return { moved: [], bytes: 0, refused };
  const entryDir = join(options.trashDir, options.entryId);
  const meta = (files: string[]): AssetTrashMeta => {
    const bytes = allowed.filter((file) => files.includes(file.path)).reduce((sum, file) => sum + file.bytes, 0);
    return {
      originalPath: options.deckId,
      kind: 'assets',
      name: `${files.length} unused ${files.length === 1 ? 'file' : 'files'} (${formatBytes(bytes)}) from “${options.deck.title}”`,
      files,
      deletedAt: new Date().toISOString(),
      deletedBy: options.deletedBy,
    };
  };
  const writeMeta = (files: string[]) =>
    writeFile(join(entryDir, 'trash.json'), `${JSON.stringify(meta(files), null, 2)}\n`, 'utf8');
  await mkdir(entryDir, { recursive: true });
  // Written first, so a server that dies mid-move still leaves a restorable entry.
  await writeMeta(allowed.map((file) => file.path));
  const moved: string[] = [];
  try {
    moved.push(...await moveAssetsInto(options.deckDir, allowed.map((file) => file.path), join(entryDir, 'item')));
  } catch (error) {
    for (const file of allowed) {
      if (!moved.includes(file.path)) refused.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (moved.length === 0) {
    await rm(entryDir, { recursive: true, force: true });
  } else if (moved.length < allowed.length) {
    await writeMeta(moved);
  }
  const bytes = allowed.filter((file) => moved.includes(file.path)).reduce((sum, file) => sum + file.bytes, 0);
  return { moved, bytes, refused };
}

/** Put a trashed set of asset files back into its deck and drop the entry. */
export async function restoreTrashedAssets(entryDir: string, deckDir: string, files: string[]): Promise<void> {
  await restoreAssets(join(entryDir, 'item'), deckDir, files);
  await rm(join(entryDir, 'item'), { recursive: true, force: true });
  await rm(join(entryDir, 'trash.json'), { force: true });
  await rmdir(entryDir).catch(() => undefined);
}
