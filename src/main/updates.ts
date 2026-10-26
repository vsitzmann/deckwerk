import { randomUUID } from 'node:crypto';
import { BrowserWindow, Menu, MenuItem, app, ipcMain, shell } from 'electron';
import type { IpcMainEvent, WebContents } from 'electron';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import {
  UPDATE_IPC,
  isNewerVersion,
  releaseNotesText,
  releasePageUrl,
  restartBlocker,
  updateMode,
  type UpdateCheckResult,
  type UpdateDownloadResult,
  type UpdateFlushReply,
  type UpdateInstallResult,
  type UpdateMode,
  type UpdateRelease,
  type UpdateState,
} from '@shared/updates.js';

/**
 * Updating the installed app from GitHub Releases through electron-updater.
 *
 * Nothing happens unasked. The app never checks by itself; the person
 * chooses Check for Updates…, confirms a newer release before it downloads,
 * and chooses when to restart into it (updateDialog.ts drives every step, so
 * the dialog that shows the release notes owns the buttons). A download that
 * is never restarted into is never installed. This module holds the one
 * updater for the app, answers those requests, and before restarting asks
 * every editor window to save, refusing while anything is unsaved,
 * presenting or shared.
 *
 * electron-updater is imported only once a check is asked for on an install
 * that updates itself, so a development run, an unpackaged checkout and the
 * test suites never load it. `DECKWERK_UPDATE_FEED` points the updater at a
 * generic feed (a folder of latest*.yml and installers served over HTTP)
 * instead of GitHub, and lets an unpackaged run check against it: the
 * integration test uses it, and docs/RELEASING.md uses it to try an update
 * end to end from a dry-run release.
 */

export interface UpdateDeps {
  /** Editor windows that must confirm their deck is saved before a restart. */
  editorWindows: () => BrowserWindow[];
  /** A presentation is on screen. */
  presenting: () => boolean;
  /** People are connected to a deck this app hosts; a restart would cut them off. */
  sharing: () => boolean;
}

const FLUSH_TIMEOUT_MS = 20_000;

const feedOverride = process.env['DECKWERK_UPDATE_FEED'] || undefined;

let mode: UpdateMode = { kind: 'none', reason: 'development' };
let updater: Promise<AppUpdater> | null = null;
let available: UpdateRelease | null = null;
let availableInfo: UpdateInfo | null = null;
let downloading: Promise<UpdateDownloadResult> | null = null;
let downloaded = false;
const pendingFlushes = new Map<string, (reply: UpdateFlushReply) => void>();

function currentState(): UpdateState {
  return {
    currentVersion: app.getVersion(),
    mode,
    available,
    downloading: downloading !== null,
    downloaded,
  };
}

async function loadUpdater(): Promise<AppUpdater> {
  updater ??= (async () => {
    // A CommonJS package whose `autoUpdater` is a lazy getter: reach it
    // through the module object rather than a named ESM import.
    const module = await import('electron-updater');
    const instance = (module.default ?? module).autoUpdater;
    // The dialog asks before downloading, and installing waits for Restart:
    // quitting the app does not install a downloaded update. (On macOS this
    // also keeps Squirrel from fetching it until Restart is chosen.)
    instance.autoDownload = false;
    instance.autoInstallOnAppQuit = false;
    instance.allowDowngrade = false;
    // The promise each call returns carries the failure to the dialog; the
    // event would otherwise reach EventEmitter's unhandled-error throw.
    instance.on('error', () => {});
    if (feedOverride) {
      instance.forceDevUpdateConfig = true;
      instance.setFeedURL({ provider: 'generic', url: feedOverride });
    }
    return instance;
  })();
  return updater;
}

function releaseFrom(info: UpdateInfo): UpdateRelease {
  return {
    version: info.version,
    notes: releaseNotesText(info.releaseNotes),
    releaseDate: info.releaseDate ?? null,
    pageUrl: releasePageUrl(info.version),
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // electron-updater's network errors carry the whole response; the first
  // line says what happened.
  return message.split('\n')[0].slice(0, 300) || 'Unknown error';
}

async function check(): Promise<UpdateCheckResult> {
  if (mode.kind === 'none') return { kind: 'disabled' };
  if (mode.kind === 'release-page') return { kind: 'release-page', url: releasePageUrl(null) };
  // Asking again while a found release downloads or waits for a restart
  // must not lose it: the dialog shows it again with its current state.
  if (available && (downloading || downloaded)) return { kind: 'available', release: available };
  try {
    const instance = await loadUpdater();
    const result = await instance.checkForUpdates();
    const current = app.getVersion();
    if (!result || !isNewerVersion(result.updateInfo.version, current)) {
      available = null;
      availableInfo = null;
      return { kind: 'latest', currentVersion: current };
    }
    availableInfo = result.updateInfo;
    available = releaseFrom(result.updateInfo);
    return { kind: 'available', release: available };
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) };
  }
}

function download(sender: WebContents): Promise<UpdateDownloadResult> {
  if (downloaded) return Promise.resolve({ ok: true });
  if (downloading) return downloading;
  if (mode.kind !== 'auto' || !available || !availableInfo) {
    return Promise.resolve({ ok: false, message: 'There is no update to download. Check for updates first.' });
  }
  const run = (async (): Promise<UpdateDownloadResult> => {
    const instance = await loadUpdater();
    const onProgress = (progress: { percent: number }): void => {
      if (!sender.isDestroyed()) sender.send(UPDATE_IPC.progress, progress.percent / 100);
    };
    instance.on('download-progress', onProgress);
    try {
      await instance.downloadUpdate();
      downloaded = true;
      return { ok: true };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    } finally {
      instance.off('download-progress', onProgress);
      downloading = null;
    }
  })();
  downloading = run;
  return run;
}

/** Ask one editor window to save everything now; null if it never answers. */
function flushWindow(win: BrowserWindow): Promise<UpdateFlushReply | null> {
  if (win.isDestroyed()) return Promise.resolve({ token: '', clean: true });
  const token = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingFlushes.delete(token);
      resolve(null);
    }, FLUSH_TIMEOUT_MS);
    pendingFlushes.set(token, (reply) => {
      clearTimeout(timer);
      pendingFlushes.delete(token);
      resolve(reply);
    });
    win.webContents.send(UPDATE_IPC.flush, token);
  });
}

async function install(deps: UpdateDeps): Promise<UpdateInstallResult> {
  if (!downloaded) return { ok: false, message: 'The update has not finished downloading.' };
  if (deps.sharing()) {
    return { ok: false, message: 'Stop sharing before restarting to update: people editing this deck would be disconnected.' };
  }
  const replies = await Promise.all(deps.editorWindows().map(flushWindow));
  const blocker = restartBlocker(replies, deps.presenting());
  if (blocker) return { ok: false, message: blocker };
  const instance = await loadUpdater();
  // Silent: the NSIS installer is assisted, and without this it would walk
  // the person through the install pages again. Run after: reopen DeckWerk.
  setImmediate(() => instance.quitAndInstall(true, true));
  return { ok: true };
}

/** The window that answers the native menu: the focused editor, else any. */
function menuTarget(deps: UpdateDeps): BrowserWindow | null {
  const windows = deps.editorWindows().filter((win) => !win.isDestroyed());
  const focused = BrowserWindow.getFocusedWindow();
  return windows.find((win) => win === focused) ?? windows[0] ?? null;
}

/**
 * macOS: "Check for Updates…" under About in the app menu. The app keeps
 * Electron's default menu (Edit's roles are what make copy and paste work in
 * every text field), so the item is slipped into it rather than replacing it.
 * Windows and Linux hide the menu bar; there the DeckWerk menu in the toolbar
 * is the app menu, and it carries the same item.
 */
function installMenuItem(deps: UpdateDeps): void {
  if (process.platform !== 'darwin') return;
  const menu = Menu.getApplicationMenu();
  const appMenu = menu?.items[0]?.submenu;
  if (!menu || !appMenu) return;
  const aboutIndex = appMenu.items.findIndex((item) => item.role?.toLowerCase() === 'about');
  appMenu.insert(aboutIndex + 1, new MenuItem({
    id: 'deckwerk-check-for-updates',
    label: 'Check for Updates…',
    click: () => {
      const target = menuTarget(deps);
      if (!target) return;
      if (target.isMinimized()) target.restore();
      target.focus();
      target.webContents.send(UPDATE_IPC.menuCheck);
    },
  }));
  // A menu edited after it was set is only redrawn once it is set again.
  Menu.setApplicationMenu(menu);
}

/** Wire updating up; call once from `whenReady`, after the app menu exists. */
export function registerUpdates(deps: UpdateDeps): void {
  mode = updateMode({
    platform: process.platform,
    isPackaged: app.isPackaged,
    appImage: process.env['APPIMAGE'],
    flatpakId: process.env['FLATPAK_ID'],
    feedOverride,
  });

  ipcMain.handle(UPDATE_IPC.state, (): UpdateState => currentState());
  ipcMain.handle(UPDATE_IPC.check, (): Promise<UpdateCheckResult> => check());
  ipcMain.handle(UPDATE_IPC.download, (event): Promise<UpdateDownloadResult> => download(event.sender));
  ipcMain.handle(UPDATE_IPC.install, (): Promise<UpdateInstallResult> => install(deps));
  ipcMain.handle(UPDATE_IPC.openReleasePage, async (_event, version?: string): Promise<void> => {
    await shell.openExternal(releasePageUrl(typeof version === 'string' ? version : null));
  });
  ipcMain.on(UPDATE_IPC.flushed, (_event: IpcMainEvent, reply: UpdateFlushReply) => {
    if (reply && typeof reply.token === 'string') pendingFlushes.get(reply.token)?.(reply);
  });

  installMenuItem(deps);
}
