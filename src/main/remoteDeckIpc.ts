import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { app, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { parseDeck, type Deck } from '@shared/deck.js';
import {
  IPC,
  type DeckSession,
  type RemoteDeckBinding,
  type RemoteDeckListing,
  type RemoteLocalCopy,
  type RemoteServerEntry,
  type RemoteServerInfo,
} from '@shared/ipc.js';
import type { DeckWindowState } from './deckWindows.js';
import {
  MirrorAssetUploader,
  RemoteClient,
  RemoteRelay,
  SavedServers,
  bindingFor,
  fetchMissingAssets,
  listMirrors,
  prepareMirror,
  readRemoteState,
  writeRemoteBaseline,
} from './remoteDecks.js';

/**
 * IPC for server decks (remoteDecks.ts): the servers this desktop knows, the
 * decks on them, opening one as a mirror, and keeping an open mirror's
 * baseline and files in step while the editor's own bridge syncs the deck.
 */

interface RemoteIpcDeps {
  requireOwner: (event: { sender: WebContents }) => DeckWindowState;
  requireSession: (event: { sender: WebContents }) => DeckSession;
  reportOperation: (event: IpcMainInvokeEvent, id: unknown, message: string, ratio?: number | null) => void;
  openDeckForRequester: (state: DeckWindowState, dir: string, deck: Deck, event: IpcMainInvokeEvent) => DeckSession | null;
}

/** Where mirrors live: ~/.deckwerk/remote, or DECKWERK_REMOTE_ROOT (tests). */
export function remoteMirrorRoot(): string {
  return process.env.DECKWERK_REMOTE_ROOT || join(homedir(), '.deckwerk', 'remote');
}

let servers: SavedServers | null = null;
const savedServers = (): SavedServers =>
  servers ??= new SavedServers(join(app.getPath('userData'), 'remote-servers.json'));

const relay = new RemoteRelay(async (origin) => (await savedServers().list()).some((s) => s.url === origin));
let relayStarted: Promise<void> | null = null;
const startRelay = (): Promise<void> => (relayStarted ??= relay.start());

/** Per window: the uploader for the mirror it has open. */
const uploaders = new Map<DeckWindowState, { dir: string; uploader: MirrorAssetUploader }>();

/** A window closed or opened another deck: stop syncing the mirror's files for it. */
export function releaseRemoteMirror(state: DeckWindowState, keepDir?: string): void {
  const current = uploaders.get(state);
  if (!current || (keepDir && resolve(keepDir) === resolve(current.dir))) return;
  current.uploader.close();
  uploaders.delete(state);
}

export async function closeRemoteDecks(): Promise<void> {
  for (const { uploader } of uploaders.values()) uploader.close();
  uploaders.clear();
  await relay.close();
}

export function registerRemoteDeckIpc(deps: RemoteIpcDeps): void {
  const { requireOwner, requireSession, reportOperation, openDeckForRequester } = deps;

  const clientFor = async (serverId: string): Promise<RemoteClient> =>
    new RemoteClient((await savedServers().get(serverId)).url);

  /** The open mirror this request is about, refusing one the window no longer has. */
  const requireMirror = (event: IpcMainInvokeEvent, dir: string): { state: DeckWindowState; dir: string } => {
    const state = requireOwner(event);
    const session = requireSession(event);
    if (resolve(dir) !== resolve(session.dir)) throw new Error('That server deck is no longer open in this window');
    return { state, dir: session.dir };
  };

  ipcMain.handle(IPC.remoteServers, async (): Promise<RemoteServerEntry[]> => savedServers().list());

  ipcMain.handle(IPC.remoteServerAdd, async (_event, url: string, name?: string): Promise<RemoteServerEntry & { info: RemoteServerInfo }> => {
    const probe = await savedServers().add(url, name).then(async (saved) => {
      try {
        return { saved, info: await new RemoteClient(saved.url).info() };
      } catch (error) {
        // Only keep servers that answered like a deck server.
        await savedServers().remove(saved.id);
        throw error;
      }
    });
    return { ...probe.saved, info: probe.info };
  });

  ipcMain.handle(IPC.remoteServerRemove, async (_event, id: string): Promise<void> => {
    await savedServers().remove(id);
  });

  ipcMain.handle(IPC.remoteListing, async (_event, serverId: string): Promise<RemoteDeckListing> =>
    (await clientFor(serverId)).listing());

  ipcMain.handle(
    IPC.remoteOpen,
    async (
      event,
      serverId: string,
      deckId: string,
      operationId?: string,
      options?: { offline?: boolean },
    ): Promise<DeckSession | null> => {
      const client = await clientFor(serverId);
      if (!options?.offline) reportOperation(event, operationId, `Connecting to ${new URL(client.origin).host}`, 0);
      const { dir, deck } = await prepareMirror(client, remoteMirrorRoot(), deckId, (message, fraction) => {
        reportOperation(event, operationId, message, fraction ?? null);
      }, { offline: Boolean(options?.offline) });
      reportOperation(event, operationId, 'Opening the presentation', 0.95);
      return openDeckForRequester(requireOwner(event), dir, deck, event);
    },
  );

  ipcMain.handle(IPC.remoteLocalCopies, async (_event, serverId: string): Promise<RemoteLocalCopy[]> => {
    const copies = await listMirrors(remoteMirrorRoot(), (await savedServers().get(serverId)).url);
    return copies.map(({ deckId, title, savedAt }) => ({ deckId, title, savedAt }));
  });

  ipcMain.handle(IPC.remoteBinding, async (event, dir: string): Promise<RemoteDeckBinding | null> => {
    const { state, dir: mirror } = requireMirror(event, dir);
    const remote = await readRemoteState(mirror).catch(() => null);
    if (!remote) {
      releaseRemoteMirror(state);
      return null;
    }
    const saved = (await savedServers().list()).find((s) => s.url === remote.state.server) ?? null;
    let wsUrl: string | null = null;
    if (saved) {
      await startRelay();
      wsUrl = relay.urlFor(saved.url, remote.state.deckId);
      if (!uploaders.has(state)) {
        const uploader = new MirrorAssetUploader(new RemoteClient(saved.url), mirror, remote.state.deckId, (error) => {
          console.error(`Could not sync files of ${remote.state.deckId}:`, error);
        });
        uploader.start();
        uploaders.set(state, { dir: mirror, uploader });
      }
    }
    return bindingFor(mirror, saved, remote, wsUrl, userInfo().username || 'Desktop');
  });

  ipcMain.handle(
    IPC.remoteBaselineSave,
    async (event, dir: string, baseline: { deck: Deck; themeCss: string; seq: number }): Promise<void> => {
      const { dir: mirror } = requireMirror(event, dir);
      const remote = await readRemoteState(mirror);
      if (!remote) throw new Error('This folder is not a server deck');
      const deck = parseDeck(baseline.deck);
      await writeRemoteBaseline(mirror, {
        server: remote.state.server, deckId: remote.state.deckId, title: deck.title,
      }, { deck, themeCss: String(baseline.themeCss ?? ''), seq: Number(baseline.seq) || 0 });
    },
  );

  ipcMain.handle(IPC.remoteFilesSync, async (event, dir: string): Promise<void> => {
    const { state } = requireMirror(event, dir);
    await uploaders.get(state)?.uploader.flush();
  });

  ipcMain.handle(IPC.remoteAssetsFetch, async (event, dir: string, deck: Deck): Promise<string[]> => {
    const { dir: mirror } = requireMirror(event, dir);
    const remote = await readRemoteState(mirror);
    const saved = remote && (await savedServers().list()).find((s) => s.url === remote.state.server);
    if (!remote || !saved) return [];
    return fetchMissingAssets(new RemoteClient(saved.url), mirror, remote.state.deckId, parseDeck(deck));
  });
}
