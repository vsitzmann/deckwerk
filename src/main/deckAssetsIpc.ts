import { join } from 'node:path';
import { ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { DeckSession } from '@shared/ipc.js';
import {
  DECK_ASSET_IPC,
  type DeckAssetListing,
  type DeckAssetTrashResult,
} from '@shared/mediaIndex.js';
import { checkTrashable, parseClientDeck, scanDeckAssets } from './deckAssets.js';

/** What the operating system calls the place `shell.trashItem` puts things. */
function trashName(): string {
  if (process.platform === 'win32') return 'the Recycle Bin';
  return 'the Trash';
}

/**
 * The Media panel's two desktop channels. Unused files go to the operating
 * system's own Trash through `shell.trashItem`, where Finder (or Explorer)
 * puts them back; the app never unlinks one.
 */
export function registerDeckAssetIpc(requireSession: (event: IpcMainInvokeEvent) => DeckSession): void {
  ipcMain.handle(DECK_ASSET_IPC.list, async (event): Promise<DeckAssetListing> => {
    const session = requireSession(event);
    const scan = await scanDeckAssets(session.dir, session.deck.theme);
    return { ...scan, trash: { available: true, where: trashName() } };
  });

  ipcMain.handle(
    DECK_ASSET_IPC.trash,
    async (event, files: unknown, liveDeck: unknown): Promise<DeckAssetTrashResult> => {
      const session = requireSession(event);
      const live = parseClientDeck(liveDeck);
      if (!live) throw new Error('The editor sent no deck to check the files against.');
      const requested = Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [];
      // Both the saved deck and the one on screen must leave a file unused.
      const { allowed, refused } = await checkTrashable(session.dir, [session.deck, live], requested);
      const moved: string[] = [];
      let bytes = 0;
      for (const file of allowed) {
        try {
          await shell.trashItem(join(session.dir, file.path));
          moved.push(file.path);
          bytes += file.bytes;
        } catch (error) {
          refused.push({ path: file.path, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return { moved, bytes, refused };
    },
  );
}
