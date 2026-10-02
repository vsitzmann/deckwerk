import { existsSync, mkdirSync, watch } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { BrowserWindow, app, clipboard, ipcMain, screen, shell } from 'electron';
import type { Display, IpcMainInvokeEvent, WebContents } from 'electron';
import { parseDeck, type Deck } from '@shared/deck.js';
import type { DeckHistoryDocument } from '@shared/deckHistory.js';
import {
  CLIPBOARD_FORMAT,
  type ClipboardReadResult,
  type ClipboardPayload,
  type ClipboardWriteRequest,
  collectAssetSrcs,
  parseClipboardPayload,
  rewriteAssetSrcs,
} from '@shared/clipboard.js';
import { importClipboardImageUrl, importImageSource } from './clipboardImageFetch.js';
import type { ClipboardImageSource } from '@shared/clipboardImages.js';
import { importMeshPage } from './meshPage.js';
import { IPC } from '@shared/ipc.js';
import type {
  AgentContextDraft,
  AgentPanelState,
  AgentSessionConnection,
  AgentSessionState,
  AgentResponse,
  CollabStartRequest,
  DeckSession,
  DeckSessionSnapshot,
  DeckHistorySession,
  ImportedAsset,
  ImportedMeshPage,
  PresentationImportResult,
  OperationProgress,
  PresentationCommand,
  PresentationState,
  PdfExportRequest,
  WebExportRequest,
  PresentOptions,
  RasterSaveRequest,
  RasterResult,
  RasterTarget,
  TrimRequest,
  TrimResult,
  VideoPosterRequest,
  VideoPosterResult,
} from '@shared/ipc.js';
import { installAssetProtocol, registerAssetScheme } from './assetProtocol.js';
import {
  createDeck,
  deckFolderPath,
  copyDeck,
  derivedAssetPath,
  importAsset,
  importImageBuffer,
  loadDeck,
  loadTheme,
  resolveAsset,
  saveDeck,
  saveSpeakerNotes,
  serializeDeck,
  saveTheme,
} from './deckStore.js';
import { exportDeck } from './exportDeck.js';
import { writeExportThumbnail } from './exportThumbnail.js';
import { probeMedia, runTrim } from './ffmpeg.js';
import { attachRendererHealth } from './windowHealth.js';
import { POSTER_HOST, posterFor } from './posterCache.js';
import { showOpenDialog, showSaveDialog } from './dialogs.js';
import { importKeynote } from './keynoteImport.js';
import { importPowerPoint } from './pptxImport.js';
import { loadDeckHistory, saveDeckHistory } from './deckHistoryStore.js';
import { serializeSpeakerNotes, SPEAKER_NOTES_FILE } from '@shared/speakerNotes.js';
import { HTML_EDIT_DIR, isAuthoringFileName, readSettledFile, writeHtmlScope } from './htmlAuthoring.js';
import { AGENT_GUIDE_FILE, defaultLauncherPath, writeAgentGuide } from './agentGuide.js';
import {
  attachWindow,
  deckKeyFor,
  editorStates,
  forgetEditorWindow,
  isEmptyEditor,
  NO_DECK_KEY,
  ownerOf,
  registerEditorWindow,
  stateForDeckDir,
  windowsOf,
  type DeckWindowState,
} from './deckWindows.js';
import {
  cascadedEditorBounds,
  createEditorWindow,
  createPdfWindow,
  createPresentWindow,
  createPresenterWindow,
  createRasterWindow,
  createTrimWindow,
  showSpeakerWindowAboveFullscreen,
  type WindowContinuityState,
} from './windows.js';
import {
  defaultClientDir, startCollabServer, type RunningCollabServer,
} from '../server/collabServer.js';
import { LocalAgentRegistry } from '../server/localAgents.js';
import {
  chooseAudienceDisplay,
  chooseDisplayById,
  shouldOpenSpeakerView,
  shouldShowAudienceWindow,
  swappedPresentationDisplays,
} from './presentationDisplays.js';

/** Pick a loopback URL for the local bridge and a reachable URL for people. */
function collaborationInviteUrl(urls: string[], deckId: string, agent = false): string | null {
  const base = agent
    ? (urls.find((url) => url.includes('127.0.0.1')) ?? urls[0])
    : (urls.find((url) => !url.includes('127.0.0.1')) ?? urls[0]);
  if (!base) return null;
  return `${base}?deck=${encodeURIComponent(deckId)}${agent ? '&agent=1' : ''}`;
}

/**
 * Main process: owns the filesystem, ffmpeg and the windows. The renderer never
 * touches Node directly — everything crosses through the typed IPC in
 * `@shared/ipc`.
 */

// Must happen before `ready`.
app.setName('DeckWerk');
registerAssetScheme();

/**
 * Each open presentation lives in its own editor window, with its own session,
 * watchers and satellite windows; see `deckWindows.ts`. Collaboration and a
 * filesystem-agent session each host one authoritative server pinned to a
 * single deck, so they stay one-at-a-time for the whole app. `collabOwner` is
 * the document that holds the session, so a second presentation asking to
 * share is told one is already running instead of quietly taking it over.
 */
let collabServer: RunningCollabServer | null = null;
let collabMode: 'window' | 'agent-background' | 'collaboration-background' | null = null;
let collabOwner: DeckWindowState | null = null;
let agentSessionReturn: Promise<void> | null = null;
let quitting = false;
const localAgents = new LocalAgentRegistry();
let desktopAgentParticipantId: string | null = null;

localAgents.subscribe((state, participantId) => {
  if (participantId !== desktopAgentParticipantId) return;
  const editor = collabOwner?.editor;
  if (editor && !editor.isDestroyed()) editor.webContents.send(IPC.agentPanelState, state);
});

function moveFullscreenWindowToDisplay(
  win: BrowserWindow | null,
  display: Display,
): Promise<void> {
  if (!win || win.isDestroyed()) return Promise.resolve();
  const enterFullscreen = (): void => {
    if (win.isDestroyed()) return;
    win.setBounds(display.bounds);
    win.setFullScreen(true);
  };
  if (!win.isFullScreen()) {
    enterFullscreen();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    win.once('leave-full-screen', () => {
      enterFullscreen();
      resolve();
    });
    win.setFullScreen(false);
  });
}

function moveSpeakerWindowToDisplay(state: DeckWindowState, display: Display): Promise<void> {
  return moveFullscreenWindowToDisplay(state.presenter, display);
}

function moveAudienceWindowToDisplay(state: DeckWindowState, display: Display): Promise<void> {
  return moveFullscreenWindowToDisplay(state.present, display);
}

function openSpeakerWindow(
  state: DeckWindowState,
  displayId: number,
  visibleAboveFullscreen: boolean,
): BrowserWindow {
  const win = createPresenterWindow(displayId, visibleAboveFullscreen);
  state.presenter = win;
  attachWindow(state, win);
  win.webContents.once('did-finish-load', () => {
    if (state.presentationState && !win.isDestroyed()) {
      win.webContents.send(IPC.presentState, state.presentationState);
    }
  });
  win.on('closed', () => {
    if (state.presenter === win) state.presenter = null;
    state.presentationDisplays = null;
    if (state.present && !state.present.isDestroyed()) state.present.close();
  });
  return win;
}

async function swapPresentationDisplayRoles(state: DeckWindowState): Promise<void> {
  if (state.swappingPresentationDisplays || !state.presentationDisplays || !state.presenter) return;
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const swapped = swappedPresentationDisplays(displays, state.presentationDisplays, primary);
  if (!swapped) return;
  const { audience: audienceTarget, presenter: presenterTarget } = swapped;

  state.swappingPresentationDisplays = true;
  state.presentationDisplays = {
    audienceDisplayId: audienceTarget.id,
    presenterDisplayId: presenterTarget.id,
  };
  try {
    await Promise.all([
      moveSpeakerWindowToDisplay(state, presenterTarget),
      moveAudienceWindowToDisplay(state, audienceTarget),
    ]);
    if (state.presenter && !state.presenter.isDestroyed()) state.presenter.focus();
  } finally {
    state.swappingPresentationDisplays = false;
  }
}

/**
 * Which open presentation a message belongs to.
 *
 * Every handler resolves its document from the window that sent the message
 * rather than from anything app-wide. That is what keeps a second presentation
 * from answering with the first one's slides, and an autosave, export or
 * projector from reaching a deck its window never had open.
 */
function requireOwner(event: { sender: WebContents }): DeckWindowState {
  const owner = ownerOf(event.sender);
  if (!owner) throw new Error('This window does not belong to an open presentation');
  return owner;
}

function requireSession(event: { sender: WebContents }): DeckSession {
  const { session } = requireOwner(event);
  if (!session) throw new Error('No deck is open');
  return session;
}

/** Push a detailed phase back only to the renderer that started the work. */
function reportOperation(
  event: IpcMainInvokeEvent,
  id: unknown,
  message: string,
  ratio: number | null = null,
): void {
  if (typeof id !== 'string' || id.length === 0 || event.sender.isDestroyed()) return;
  const progress: OperationProgress = { id, message, ratio };
  event.sender.send(IPC.operationProgress, progress);
}

/** Collaboration is app-wide, so its state goes to the window that started it. */
function sendAgentSessionState(state: AgentSessionState): void {
  const editor = collabOwner?.editor;
  if (editor && !editor.isDestroyed()) editor.webContents.send(IPC.agentSessionState, state);
}

/**
 * End the hidden authoritative session while leaving the native editor in
 * place. The server flushes first; disk watching resumes only after its final
 * deck is reloaded, so there is never a second writer racing it.
 */
function endBackgroundAgentSession(): Promise<void> {
  if (agentSessionReturn) return agentSessionReturn;
  if (collabMode !== 'agent-background' && collabMode !== 'collaboration-background') {
    return Promise.resolve();
  }
  const owner = collabOwner;
  const endingAgentSession = collabMode === 'agent-background';

  agentSessionReturn = (async () => {
    const closing = collabServer;
    collabServer = null;
    collabMode = null;
    collabOwner = null;
    try {
      closing?.notifyEnded();
      // Let WebSocket queue the terminal frame before close() terminates peers.
      if (closing) await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      await closing?.close();
    } catch (error) {
      console.error('Could not close background collaboration session cleanly:', error);
    }
    if (quitting || !owner || !owner.session || owner.editor.isDestroyed()) return;
    try {
      owner.session.deck = await loadDeck(owner.session.dir);
    } catch (error) {
      console.error('Could not reload the deck after collaboration:', error);
    }
    watchDeck(owner);
    broadcastDeck(owner);
    // The owner is no longer the collaboration's, so address it directly.
    owner.editor.webContents.send(IPC.agentSessionState, { active: false });
  })().finally(() => {
    if (endingAgentSession) desktopAgentParticipantId = null;
    agentSessionReturn = null;
  });
  return agentSessionReturn;
}

/** Give a window a document, and tell it which deck its assets now come from. */
function setSession(state: DeckWindowState, dir: string, deck: Deck): DeckSession {
  const session: DeckSession = { dir, deck };
  state.session = session;
  state.themeCss = null;
  state.lastSavedDeckJson = null;
  state.deckKey = deckKeyFor(dir);
  for (const win of windowsOf(state)) win.webContents.send(IPC.deckKey, state.deckKey);
  watchDeck(state);
  // A deck saved before speaker notes existed has no notes.md. Write it now
  // so an author can open the file straight away; a file that already says
  // what the deck says is left untouched.
  void saveSpeakerNotes(dir, deck).catch((error) => {
    console.error(`Could not write ${SPEAKER_NOTES_FILE} in ${dir}:`, error);
  });
  // An agent pointed at this folder reads AGENTS.md first. Keep the deck's
  // copy current with the editor that is open on it; a copy the author has
  // taken over (marker line removed) is left alone.
  void writeAgentGuide(dir, { launcher: defaultLauncherPath() }).catch((error) => {
    console.error(`Could not write ${AGENT_GUIDE_FILE} in ${dir}:`, error);
  });
  void state.agentRuntime.open(dir);
  return session;
}

/**
 * Open a deck in one window, and tell that window's other windows about it.
 *
 * The window that asked already has the deck in the reply. The ones that did
 * not ask — an audience or Speaker View window still up from the last run, a
 * trim window — would otherwise keep showing the document that was replaced.
 */
function openSession(
  state: DeckWindowState,
  dir: string,
  deck: Deck,
  event: IpcMainInvokeEvent,
): DeckSession {
  const opened = setSession(state, dir, deck);
  broadcastDeck(state, BrowserWindow.fromWebContents(event.sender));
  return opened;
}

/**
 * Where a newly opened, created or imported deck goes.
 *
 * A window with nothing open adopts it — that is what the welcome screen is
 * for. A window that already holds a presentation keeps it, and the new deck
 * gets a window of its own, so opening a second talk never closes the first.
 * `null` tells the asking renderer that the deck went elsewhere and it should
 * leave its own document alone.
 */
function openDeckForRequester(
  state: DeckWindowState,
  dir: string,
  deck: Deck,
  event: IpcMainInvokeEvent,
): DeckSession | null {
  // One document, one window. Two windows on one folder would be two debounced
  // whole-file writers racing each other over the same deck.json, so a deck
  // that is already open is brought forward instead of opened twice.
  const already = stateForDeckDir(dir);
  if (already) {
    if (already === state) return state.session;
    if (!already.editor.isDestroyed()) already.editor.focus();
    return null;
  }
  if (isEmptyEditor(state)) return openSession(state, dir, deck, event);
  const source = state.editor;
  const opened = createEditorState(
    '',
    source.isDestroyed() ? undefined : cascadedEditorBounds(source),
  );
  setSession(opened, dir, deck);
  return null;
}

/** A new editor window, registered as a document before its renderer loads. */
function createEditorState(query = '', bounds?: WindowContinuityState): DeckWindowState {
  const win = createEditorWindow(query, bounds);
  const state = registerEditorWindow(win);
  attachRendererHealth(win);
  win.on('closed', () => closeDocument(state));
  return state;
}

/**
 * The window holding a document has gone. Stop watching its folder, take its
 * satellite windows down with it, and hand back the app-wide collaboration
 * session if this was the document that held it.
 */
function closeDocument(state: DeckWindowState): void {
  for (const watcher of state.watchers) watcher.close();
  state.watchers = [];
  void state.agentRuntime.close();
  for (const win of [state.present, state.presenter, state.trim, state.raster]) {
    if (win && !win.isDestroyed()) win.close();
  }
  if (collabOwner === state) void endBackgroundAgentSession();
  forgetEditorWindow(state);
}

/**
 * Watch mode: reload when deck.json or theme.css change on disk, so an agent
 * (or a git checkout, or hand editing) shows up in the running app. Our own
 * saves also fire these events; the renderer compares content and ignores
 * echoes, which is simpler and more robust than timestamp bookkeeping.
 */
function watchDeck(state: DeckWindowState): void {
  for (const w of state.watchers) w.close();
  state.watchers = [];
  if (!state.session) return;
  const { dir } = state.session;
  const themeFile = state.session.deck.theme;
  let deckTimer: NodeJS.Timeout | null = null;
  let themeTimer: NodeJS.Timeout | null = null;
  const htmlTimers = new Map<string, NodeJS.Timeout>();
  try {
    const editDir = join(dir, HTML_EDIT_DIR);
    mkdirSync(editDir, { recursive: true });
    // Watch the folder, not the two files inside it. Every careful writer of
    // deck.json — our own saveDeck, the collaboration server, git, and any
    // editor a human points at theme.css — replaces the file by rename, and a
    // watch bound to a path stops receiving events the moment that path gets a
    // new inode. Watching the directory survives replacement.
    const onDeckChanged = (): void => {
      // Debounced: editors and agents often write in bursts.
      if (deckTimer) clearTimeout(deckTimer);
      deckTimer = setTimeout(async () => {
        try {
          const { readFile } = await import('node:fs/promises');
          const raw = await readFile(join(dir, 'deck.json'), 'utf8');
          // Our own autosave fires this watcher too. Byte-comparing against
          // what we wrote is the only reliable echo test: comparing decks
          // fails on key order, and that false mismatch caused a full reload
          // that yanked the editor back to slide 1 a second after any edit.
          if (raw === state.lastSavedDeckJson) return;
          // Closing a watcher does not cancel the debounce it already
          // scheduled. A reload belonging to the deck this window had before an
          // Open or Save As must not land in the session that replaced it.
          if (!state.session || state.session.dir !== dir) return;
          // Watching the folder also catches writes nobody here made that
          // change nothing — a script or checkout laying down identical
          // content. Reloading those would broadcast a deck the windows
          // already have, for no reason.
          if (raw === serializeDeck(state.session.deck)) return;
          const deck = await loadDeck(dir);
          state.session.deck = deck;
          broadcastDeck(state);
        } catch {
          // Half-written JSON mid-save; the next event will retry.
        }
      }, 200);
    };
    const onThemeChanged = (): void => {
      if (themeTimer) clearTimeout(themeTimer);
      themeTimer = setTimeout(async () => {
        if (!state.session || state.session.dir !== dir) return;
        const css = await loadTheme(state.session.dir, state.session.deck.theme);
        state.themeCss = css;
        for (const win of windowsOf(state)) win.webContents.send(IPC.themeCss, css);
      }, 200);
    };
    // notes.md is the hand-editable mirror of the slides' notes. A change goes
    // to the editor renderer, which applies it to the slides as an undoable
    // edit and autosaves; that save rewrites deck.json and, normalised,
    // notes.md itself. Our own write of the file is recognised by content:
    // what is on disk already says exactly what the deck says.
    let notesTimer: NodeJS.Timeout | null = null;
    const onNotesChanged = (): void => {
      if (notesTimer) clearTimeout(notesTimer);
      notesTimer = setTimeout(async () => {
        try {
          if (!state.session || state.session.dir !== dir) return;
          const { readFile } = await import('node:fs/promises');
          const contents = await readFile(join(dir, SPEAKER_NOTES_FILE), 'utf8');
          if (contents === serializeSpeakerNotes(state.session.deck)) return;
          if (state.editor.isDestroyed()) return;
          state.editor.webContents.send(IPC.speakerNotesEdit, contents);
        } catch {
          // Deleted or mid-write; the next event will retry.
        }
      }, 200);
    };
    // A theme kept in a subfolder is not visible to a non-recursive directory
    // watch, so that case keeps its own path watcher.
    const themeInDeckRoot = !themeFile.includes('/') && !themeFile.includes(sep);
    state.watchers.push(
      watch(dir, (_event, filename) => {
        const name = filename ? String(filename) : '';
        if (name === 'deck.json') onDeckChanged();
        else if (name === SPEAKER_NOTES_FILE) onNotesChanged();
        else if (themeInDeckRoot && name === themeFile) onThemeChanged();
      }),
      ...(themeInDeckRoot ? [] : [watch(join(dir, themeFile), onThemeChanged)]),
      // Saving an authoring file is the everyday way slides change, so it must
      // be cheap: the contents go straight to the editor's renderer, which is
      // already a browser and lays them out in an offscreen iframe. Nothing is
      // spawned, and the compile is measured by the engine that will draw it.
      watch(editDir, (_event, filename) => {
        if (!filename || !isAuthoringFileName(String(filename))) return;
        const path = resolve(editDir, String(filename));
        // `.scratchpad/` holds persistent Agent preview evidence. Only direct
        // children of edit/ are authored documents whose saves update slides.
        if (dirname(path) !== editDir) return;
        const previous = htmlTimers.get(path);
        if (previous) clearTimeout(previous);
        htmlTimers.set(path, setTimeout(async () => {
          htmlTimers.delete(path);
          try {
            // A save is not necessarily atomic; see readSettledFile for why
            // the read waits for the write to finish rather than giving up.
            const contents = await readSettledFile(path);
            if (/<html[\s>]/i.test(contents) && !/<\/html>/i.test(contents)) return;
            // The editor's own export lands here too; that event is an echo.
            if (state.lastWrittenHtml.get(path) === contents) {
              state.lastWrittenHtml.delete(path);
              return;
            }
            if (!state.session || state.session.dir !== dir) return;
            if (state.editor.isDestroyed()) return;
            state.editor.webContents.send(IPC.htmlEdit, { path, contents });
          } catch (error) {
            console.error(`Could not read HTML edit ${path}:`, error);
          }
        }, 200));
      }),
    );
  } catch {
    // A brand-new deck may not have both files yet; watching resumes on the
    // next setSession.
  }
}

/** Push deck changes to one document's windows so they never show stale content. */
function broadcastDeck(state: DeckWindowState, except?: BrowserWindow | null): void {
  if (!state.session) return;
  for (const win of windowsOf(state)) {
    if (win === except) continue;
    win.webContents.send(IPC.deckState, state.session);
  }
}
/**
 * A deck folder named on the command line, if any. Used by `npm run dev -- <dir>`
 * and by opening a deck from the shell.
 */
function deckDirFromArgv(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    if (existsSync(join(arg, 'deck.json'))) return resolve(arg);
  }
  return null;
}

/**
 * The browser integration tests drive this process with every window hidden
 * (see windows.ts). Chromium treats a window it cannot see as background —
 * timers quantised to one-second ticks, requestAnimationFrame stopped, muted
 * video suspended — which would make every timing a test measures a property
 * of the throttle rather than of the code under test. Switch the throttles
 * off for that mode only; a user's hidden windows keep saving power.
 */
if (process.env['DECKWERK_HEADLESS_TEST'] === '1') {
  for (const flag of [
    'disable-background-timer-throttling',
    'disable-renderer-backgrounding',
    'disable-backgrounding-occluded-windows',
    'disable-background-media-suspend',
  ]) app.commandLine.appendSwitch(flag);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
}

app.whenReady().then(async () => {
  // Packaged macOS builds get this from the bundle's .icns. During local
  // development Electron would otherwise keep its own icon in the Dock and
  // app switcher, so set the matching high-resolution artwork explicitly.
  if (process.platform === 'darwin' && !app.isPackaged) {
    const developmentIcon = join(process.cwd(), 'resources', 'deckwerk-icon.png');
    if (existsSync(developmentIcon)) app.dock.setIcon(developmentIcon);
  }

  installAssetProtocol();
  registerHandlers();

  const initial = deckDirFromArgv();
  const deck = initial
    ? await loadDeck(initial).catch((err: unknown) => {
      console.error(`Could not open ${initial}:`, err);
      return null;
    })
    : null;

  // The window exists before the deck is attached, so the document belongs to
  // it from the start rather than being adopted from anything app-wide.
  const first = createEditorState();
  if (initial && deck) setSession(first, initial, deck);

  screen.on('display-removed', () => {
    const primary = screen.getPrimaryDisplay();
    for (const state of editorStates()) {
      if (!state.present || state.present.isDestroyed()) continue;
      state.presentationDisplays = {
        audienceDisplayId: primary.id,
        presenterDisplayId: primary.id,
      };
      void Promise.all([
        moveSpeakerWindowToDisplay(state, primary),
        moveAudienceWindowToDisplay(state, primary),
      ]).then(() => {
        if (state.presenter && !state.presenter.isDestroyed()) {
          showSpeakerWindowAboveFullscreen(state.presenter);
        }
      });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createEditorState();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  for (const state of editorStates()) void state.agentRuntime.close();
  localAgents.close();
  void collabServer?.close();
});

function registerHandlers(): void {
  ipcMain.handle(IPC.deckNew, async (event, operationId?: string): Promise<DeckSession | null> => {
    const res = await showSaveDialog({
      title: 'New deck',
      buttonLabel: 'Create',
      // A deck is a folder, so the dialog names a directory to create.
      properties: ['createDirectory'],
      defaultPath: 'Untitled deck',
    });
    if (res.canceled || !res.filePath) return null;
    // The panel hands back whatever is in its name field, so a stray `.key`
    // from the surrounding folder must not become the folder name or title.
    const dir = deckFolderPath(res.filePath);
    reportOperation(event, operationId, `Creating ${basename(dir)}/deck.json`);
    const deck = await createDeck(dir, basename(dir));
    reportOperation(event, operationId, 'Preparing the new presentation', 1);
    return openDeckForRequester(requireOwner(event), dir, deck, event);
  });

  ipcMain.handle(IPC.deckOpen, async (event, operationId?: string): Promise<DeckSession | null> => {
    const res = await showOpenDialog({
      title: 'Open deck',
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const dir = res.filePaths[0];
    reportOperation(event, operationId, `Reading ${basename(dir)}/deck.json`);
    const deck = await loadDeck(dir);
    reportOperation(event, operationId, 'Preparing deck files', 0.4);
    return openDeckForRequester(requireOwner(event), dir, deck, event);
  });

  // Pull rather than push: a window that opens mid-session asks for its own
  // deck itself, so it can't miss a broadcast that fired before it loaded.
  ipcMain.handle(
    IPC.deckGet,
    (event): DeckSession | null => ownerOf(event.sender)?.session ?? null,
  );
  // Answered synchronously during preload: `assetUrl` is called on first paint.
  ipcMain.on(IPC.deckKeyGet, (event) => {
    event.returnValue = ownerOf(event.sender)?.deckKey ?? NO_DECK_KEY;
  });
  ipcMain.handle(IPC.deckHistoryLoad, async (event, dir: string): Promise<DeckHistorySession> => {
    const s = requireSession(event);
    if (dir !== s.dir) throw new Error('The requested deck is no longer open');
    return { dir: s.dir, history: await loadDeckHistory(s.dir) };
  });
  ipcMain.handle(
    IPC.deckHistorySave,
    async (event, dir: string, history: DeckHistoryDocument): Promise<void> => {
      const s = requireSession(event);
      if (dir !== s.dir) throw new Error('Refusing to save history to a deck that is no longer open');
      await saveDeckHistory(s.dir, history);
    },
  );

  ipcMain.handle(IPC.agentContextPublish, async (event, context: AgentContextDraft) => {
    await requireOwner(event).agentRuntime.publish(context);
  });
  ipcMain.on(IPC.agentResponse, (event, response: AgentResponse) => {
    void requireOwner(event).agentRuntime.respond(response);
  });
  ipcMain.handle(IPC.agentPanelGetState, async (event): Promise<AgentPanelState> => {
    const s = requireSession(event);
    const participantId = desktopAgentParticipantId ??= randomUUID();
    return localAgents.getState(s.dir, participantId);
  });

  ipcMain.handle(
    IPC.deckOpenPath,
    async (event, dir: string): Promise<DeckSession | null> =>
      openDeckForRequester(requireOwner(event), dir, await loadDeck(dir), event),
  );

  ipcMain.handle(IPC.deckSave, async (event, dir: string, deck: Deck): Promise<void> => {
    const state = requireOwner(event);
    const s = requireSession(event);
    // A save belongs to the deck the renderer had open when the edit was made.
    // One still in flight when this window takes on another deck would
    // otherwise write those slides into the new deck's folder — and put them
    // on the projector, because Present reads this window's session.
    if (dir !== s.dir) throw new Error('Refusing to save a deck that is no longer open');
    state.lastSavedDeckJson = await saveDeck(s.dir, deck);
    s.deck = deck;
    broadcastDeck(state, BrowserWindow.fromWebContents(event.sender));
  });

  ipcMain.handle(
    IPC.deckSyncSnapshot,
    (event, snapshot: DeckSessionSnapshot): void => {
      const state = requireOwner(event);
      const s = requireSession(event);
      // During a filesystem Agent session the collaboration server is the only
      // deck.json writer. Present/PDF/web export still live in the main process,
      // so mirror the authoritative renderer state in memory without racing the
      // server's debounced persistence. Like an ordinary save, a mirror that
      // names a deck this session no longer holds is stale, not authoritative.
      if (snapshot.dir !== s.dir) {
        throw new Error('Refusing to mirror a deck that is no longer open');
      }
      s.deck = parseDeck(snapshot.deck);
      state.themeCss = snapshot.themeCss;
      broadcastDeck(state, BrowserWindow.fromWebContents(event.sender));
    },
  );

  ipcMain.handle(IPC.deckSaveAs, async (event, operationId?: string): Promise<DeckSession | null> => {
    const s = requireSession(event);
    const target = await showSaveDialog({
      title: 'Save deck as',
      buttonLabel: 'Save As',
      defaultPath: basename(s.dir),
      properties: ['createDirectory'],
    });
    if (target.canceled || !target.filePath) return null;
    const dir = deckFolderPath(target.filePath);

    reportOperation(event, operationId, `Copying deck to ${basename(dir)}`);
    const deck = await copyDeck(s.dir, dir);
    reportOperation(event, operationId, 'Opening the saved copy', 0.8);
    // Save As continues one document in one window, so it never spawns another.
    return openSession(requireOwner(event), dir, deck, event);
  });

  ipcMain.handle(IPC.deckLoadTheme, async (event): Promise<string> => {
    const state = requireOwner(event);
    const s = requireSession(event);
    return state.themeCss ?? loadTheme(s.dir, s.deck.theme);
  });

  ipcMain.handle(IPC.deckSaveTheme, async (event, css: string): Promise<void> => {
    const state = requireOwner(event);
    const s = requireSession(event);
    state.themeCss = css;
    await saveTheme(s.dir, s.deck.theme, css);
  });

  ipcMain.handle(IPC.speakerNotesOpen, async (event): Promise<string> => {
    const s = requireSession(event);
    // A deck saved before notes existed has no notes.md yet; write it from the
    // slides so the editor that opens has the sections to fill in.
    await saveSpeakerNotes(s.dir, s.deck);
    const path = join(s.dir, SPEAKER_NOTES_FILE);
    const openError = await shell.openPath(path);
    if (openError) throw new Error(`Could not open ${path}: ${openError}`);
    return path;
  });

  ipcMain.handle(IPC.htmlExport, async (event, slideIds: string[]): Promise<string> => {
    const s = requireSession(event);
    const written = await writeHtmlScope(s.dir, s.deck, slideIds);
    requireOwner(event).lastWrittenHtml.set(written.path, written.contents);
    const openError = await shell.openPath(written.path);
    if (openError) {
      throw new Error(`HTML was written to ${written.path}, but could not be opened: ${openError}`);
    }
    return written.path;
  });

  ipcMain.handle(IPC.htmlAdopt, async (
    event, path: string, contents: string, expected: string,
  ): Promise<void> => {
    const s = requireSession(event);
    const editDir = join(s.dir, HTML_EDIT_DIR);
    const target = resolve(String(path));
    // Only files inside this deck's edit/ folder; the renderer holds no other
    // write access to the filesystem and must not gain one through this.
    if (target !== editDir && !target.startsWith(editDir + sep)) {
      throw new Error(`Refusing to write outside ${editDir}: ${target}`);
    }
    const { readFile, writeFile } = await import('node:fs/promises');
    // The author may have saved again while the compile ran; stamping ids onto
    // *those* contents is the next compile's job, not a reason to lose them.
    const current = await readFile(target, 'utf8').catch(() => null);
    if (current !== expected) return;
    // Our own write; the watcher event it fires is an echo, not an edit.
    requireOwner(event).lastWrittenHtml.set(target, contents);
    await writeFile(target, contents, 'utf8');
  });

  ipcMain.handle(
    IPC.assetImport,
    async (event, paths: string[], token?: string): Promise<ImportedAsset[]> => {
      const s = requireSession(event);
      const out: ImportedAsset[] = [];
      for (const p of paths) {
        // One bad file in a multi-file drop shouldn't lose the rest.
        try {
          out.push(
            await importAsset(s.dir, p, (ratio) => {
              if (token && !event.sender.isDestroyed()) {
                event.sender.send(IPC.assetImportProgress, {
                  token,
                  phase: 'processing',
                  ratio,
                });
              }
            }),
          );
        } catch (err) {
          console.error(`Skipped ${p}:`, err);
        }
      }
      return out;
    },
  );

  // Dropped 3D models become one interactive page in the deck (meshPage.ts).
  ipcMain.handle(IPC.meshImport, async (event, paths: string[]): Promise<ImportedMeshPage> => {
    const s = requireSession(event);
    const sources = await Promise.all(paths.map(async (path) => ({ name: basename(path), bytes: await readFile(path) })));
    return importMeshPage(s.dir, sources);
  });

  // Copy: serialise the fragment onto the OS pasteboard under a private
  // format, with absolute asset paths attached, so any instance of this app —
  // including a different process with a different deck open — can paste it.
  ipcMain.handle(IPC.clipboardWrite, (event, request: ClipboardWriteRequest): void => {
    const assets: ClipboardPayload['assets'] = [];
    const source = ownerOf(event.sender)?.session;
    if (source) {
      for (const src of collectAssetSrcs(request)) {
        try {
          const absPath = resolveAsset(source.dir, src);
          if (existsSync(absPath)) assets.push({ src, absPath });
        } catch {
          // A src that escapes the deck folder simply doesn't travel.
        }
      }
    }
    const payload = { format: CLIPBOARD_FORMAT, version: 1, ...request, assets };
    clipboard.writeBuffer(CLIPBOARD_FORMAT, Buffer.from(JSON.stringify(payload), 'utf8'));
  });

  // Paste: validate whatever is on the pasteboard, then re-import each
  // referenced asset into *this* deck. Import names files by content hash, so
  // pasting back into the source deck (or pasting twice) copies nothing.
  ipcMain.handle(IPC.clipboardRead, async (event): Promise<ClipboardReadResult | null> => {
    const buf = clipboard.readBuffer(CLIPBOARD_FORMAT);
    if (!buf || buf.length === 0) {
      const html = clipboard.readHTML();
      const text = clipboard.readText();
      // A real HTML table wins over everything else: a spreadsheet copy puts
      // a bitmap of the range on the pasteboard *as well*, and an author who
      // copied cells wants cells.
      if (/<table\b/i.test(html)) {
        return { kind: 'external-html', html, text };
      }
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        // Preserve the sharpest representation on Retina displays. NativeImage
        // otherwise defaults PNG encoding to the 1x representation.
        const scaleFactor = Math.max(1, ...image.getScaleFactors());
        const asset = await importImageBuffer(
          requireSession(event).dir,
          image.toPNG({ scaleFactor }),
          'Screenshot.png',
          image.getSize(scaleFactor),
        );
        return { kind: 'external-image', asset };
      }
      // Tab-separated text is a spreadsheet range only when no bitmap was
      // offered. Checking it before the bitmap used to discard a perfectly
      // good pasted image whose caption happened to contain a tab.
      if (text.includes('\t')) {
        return { kind: 'external-html', html, text };
      }
      // Nothing but a reference: chat and web apps overwhelmingly write just
      // an `<img src="https://…">`, with no pixels on the pasteboard at all.
      // Go and get the bytes.
      const linked = await importClipboardImageUrl(requireSession(event).dir, html, text);
      if (linked) return { kind: 'external-image', asset: linked };
      return null;
    }
    let payload: ClipboardPayload | null = null;
    try {
      payload = parseClipboardPayload(JSON.parse(buf.toString('utf8')));
    } catch {
      return null;
    }
    if (!payload) return null;

    const s = requireSession(event);
    const map = new Map<string, string>();
    for (const asset of payload.assets) {
      try {
        // Fast path: the src already resolves in this deck (same-deck paste).
        if (existsSync(resolveAsset(s.dir, asset.src))) {
          map.set(asset.src, asset.src);
          continue;
        }
      } catch {
        // Foreign-shaped src; fall through to import.
      }
      try {
        const imported = await importAsset(s.dir, asset.absPath);
        map.set(asset.src, imported.src);
      } catch (err) {
        // Source deck gone since the copy. The element still pastes; its
        // media renders broken rather than vanishing.
        console.error(`Could not import pasted asset ${asset.absPath}:`, err);
      }
    }
    rewriteAssetSrcs(payload, map);
    return payload;
  });

  // An image dragged out of a web page arrives as a reference, not a file:
  // the renderer hands over the URL (or `data:` payload) it found on the
  // drag, and the bytes are fetched here, next to the deck folder.
  ipcMain.handle(
    IPC.assetImportUrl,
    async (event, source: ClipboardImageSource): Promise<ImportedAsset | null> =>
      importImageSource(requireSession(event).dir, source),
  );

  ipcMain.handle(IPC.assetProbe, async (event, src: string) => {
    const s = requireSession(event);
    return probeMedia(resolveAsset(s.dir, src));
  });

  ipcMain.handle(IPC.displayList, () => {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((display, index) => ({
      id: display.id,
      label: display.label || `Display ${index + 1}`,
      primary: display.id === primaryId,
      width: display.bounds.width,
      height: display.bounds.height,
    }));
  });
  ipcMain.handle(IPC.presentOpen, async (event, slideIndex: number, options: PresentOptions = {}) => {
    // Presenting belongs to one document: the window that asked. Another
    // presentation's projector, if there is one, is left exactly as it is.
    const state = requireOwner(event);
    const displays = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    if (state.present && !state.present.isDestroyed()) {
      if (options.speakerView && (!state.presenter || state.presenter.isDestroyed())) {
        const audienceDisplay = chooseDisplayById(
          displays,
          state.presentationDisplays?.audienceDisplayId,
          chooseAudienceDisplay(displays, primary),
        );
        const presenterDisplay = chooseDisplayById(
          displays,
          options.presenterDisplayId,
          primary,
        );
        state.presentationDisplays = {
          audienceDisplayId: audienceDisplay.id,
          presenterDisplayId: presenterDisplay.id,
        };
        openSpeakerWindow(
          state,
          presenterDisplay.id,
          audienceDisplay.id === presenterDisplay.id,
        );
      }
      (state.presenter ?? state.present).focus();
      return;
    }
    const audienceDisplay = chooseDisplayById(
      displays,
      options.audienceDisplayId,
      chooseAudienceDisplay(displays, primary),
    );
    const presenterDisplay = chooseDisplayById(
      displays,
      options.presenterDisplayId,
      primary,
    );
    const openSpeakerView = shouldOpenSpeakerView(
      audienceDisplay,
      presenterDisplay,
      options.speakerView,
    );
    const showAudienceWindow = shouldShowAudienceWindow(
      audienceDisplay,
      presenterDisplay,
      openSpeakerView,
    );

    state.presentationState = null;
    state.presentationDisplays = {
      audienceDisplayId: audienceDisplay.id,
      presenterDisplayId: presenterDisplay.id,
    };
    const audience = createPresentWindow(
      slideIndex,
      audienceDisplay.id,
      options.endSlideIndex,
      showAudienceWindow,
    );
    state.present = audience;
    attachWindow(state, audience);
    state.presenter = openSpeakerView
      ? openSpeakerWindow(state, presenterDisplay.id, false)
      : null;
    audience.on('closed', () => {
      if (state.present === audience) state.present = null;
      state.presentationDisplays = null;
      if (state.presenter && !state.presenter.isDestroyed()) state.presenter.close();
    });
  });
  ipcMain.on(IPC.presentCommand, (event, command: PresentationCommand) => {
    const state = ownerOf(event.sender);
    if (!state) return;
    if (command.type === 'exit') {
      state.present?.close();
      state.presenter?.close();
      return;
    }
    if (command.type === 'swapDisplays') {
      void swapPresentationDisplayRoles(state);
      return;
    }
    state.present?.webContents.send(IPC.presentCommand, command);
  });
  ipcMain.on(IPC.presentState, (event, presentation: PresentationState) => {
    const state = ownerOf(event.sender);
    if (!state) return;
    state.presentationState = presentation;
    state.presenter?.webContents.send(IPC.presentState, presentation);
  });

  ipcMain.handle(IPC.trimOpen, (event, payload: { src: string; elementId: string }) => {
    const state = requireOwner(event);
    if (state.trim && !state.trim.isDestroyed()) state.trim.close();
    const win = createTrimWindow();
    state.trim = win;
    attachWindow(state, win);
    win.on('closed', () => {
      if (state.trim === win) state.trim = null;
    });
    // Wait for the renderer before sending, or the payload lands nowhere.
    win.webContents.once('did-finish-load', () => {
      win.webContents.send(IPC.trimOpen, payload);
    });
  });

  ipcMain.handle(IPC.rasterOpen, (event, payload: RasterTarget) => {
    const state = requireOwner(event);
    if (state.raster && !state.raster.isDestroyed()) state.raster.close();
    const win = createRasterWindow();
    state.raster = win;
    attachWindow(state, win);
    win.on('closed', () => {
      if (state.raster === win) state.raster = null;
    });
    // Wait for the paint renderer to subscribe before delivering its target.
    win.webContents.once('did-finish-load', () => {
      win.webContents.send(IPC.rasterOpen, payload);
    });
  });

  /**
   * Pick a presentation file, pick where the converted deck goes, run the
   * matching importer sidecar, then open the result. Keynote and PowerPoint
   * differ only in the file filter, the dialog wording and the sidecar.
   */
  async function importPresentation(
    event: IpcMainInvokeEvent,
    operationId: string | undefined,
    source: {
      name: string;
      extensions: string[];
      run: typeof importKeynote;
    },
  ): Promise<PresentationImportResult | null> {
    const picked = await showOpenDialog({
      title: `Import a ${source.name} presentation`,
      properties: ['openFile'],
      filters: [{ extensions: source.extensions, name: source.name }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    const sourcePath = picked.filePaths[0];

    const target = await showSaveDialog({
      title: 'Save the imported deck as',
      buttonLabel: 'Import',
      defaultPath: basename(sourcePath, extname(sourcePath)),
      properties: ['createDirectory'],
    });
    if (target.canceled || !target.filePath) return null;

    // The sidecar reports 0..1 across its own work, and the renderer's
    // `adopt` then reports the rest of the way. Compress the conversion into
    // the first half so the operation's completion only ever moves forward.
    const conversionShare = 0.5;
    const result = await source.run(sourcePath, deckFolderPath(target.filePath), (message, ratio) => {
      reportOperation(event, operationId, message, ratio === null ? null : ratio * conversionShare);
    });
    reportOperation(event, operationId, 'Opening the imported presentation', conversionShare);
    const adopted = openDeckForRequester(requireOwner(event), result.dir, result.deck, event);
    // A window that already held a presentation keeps it; the import went to
    // a window of its own, so the asking renderer must not adopt the deck.
    return { ...result, openedInNewWindow: adopted === null };
  }

  ipcMain.handle(
    IPC.keynoteImport,
    (event, operationId?: string) =>
      importPresentation(event, operationId, { name: 'Keynote', extensions: ['key'], run: importKeynote }),
  );

  ipcMain.handle(
    IPC.pptxImport,
    (event, operationId?: string) =>
      importPresentation(event, operationId, {
        name: 'PowerPoint',
        extensions: ['pptx', 'ppsx', 'potx'],
        run: importPowerPoint,
      }),
  );

  ipcMain.handle(IPC.exportBundle, async (
    event,
    request: WebExportRequest = {},
    operationId?: string,
  ): Promise<string | null> => {
    const s = requireSession(event);
    const target = await showSaveDialog({
      title: 'Export as a standalone web page',
      buttonLabel: 'Export',
      defaultPath: `${basename(s.dir)}-web`,
      properties: ['createDirectory'],
    });
    if (target.canceled || !target.filePath) return null;
    const dir = deckFolderPath(target.filePath);
    await exportDeck(s.dir, s.deck, dir, (message, ratio) => {
      reportOperation(event, operationId, message, ratio);
    }, { quality: request.quality ?? 'original', dropSkipped: true });
    await writeExportThumbnail(s.dir, s.deck, dir, (message) => {
      reportOperation(event, operationId, message, null);
    });
    return dir;
  });

  ipcMain.handle(IPC.exportPdf, async (
    event,
    request: PdfExportRequest = {},
    operationId?: string,
  ): Promise<string | null> => {
    const s = requireSession(event);
    const mode = request.mode ?? 'final';
    const includeHidden = request.includeHidden ?? false;
    const target = await showSaveDialog({
      title: 'Export PDF',
      buttonLabel: 'Export',
      defaultPath: `${basename(s.dir)}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (target.canceled || !target.filePath) return null;

    reportOperation(event, operationId, 'Rendering slide pages', null);
    const jobId = randomUUID();
    const ready = new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => {
        ipcMain.off(IPC.exportPdfReady, listener);
        reject(new Error('PDF renderer timed out'));
      }, 30_000);
      const listener = (_readyEvent: Electron.IpcMainEvent, readyJobId: string) => {
        if (readyJobId !== jobId) return;
        clearTimeout(timer);
        ipcMain.off(IPC.exportPdfReady, listener);
        resolveReady();
      };
      ipcMain.on(IPC.exportPdfReady, listener);
    });
    const query = `?job=${encodeURIComponent(jobId)}&mode=${mode}&includeHidden=${includeHidden ? '1' : '0'}`;
    const printWindow = createPdfWindow(query);
    // The print page asks for "the" deck the same way any window does, so it
    // has to belong to the document being exported.
    attachWindow(requireOwner(event), printWindow);
    try {
      await ready;
      reportOperation(event, operationId, 'Checking rendered pages', 0.6);
      const renderError = await printWindow.webContents.executeJavaScript(
        'document.documentElement.dataset.error || ""',
      ) as string;
      if (renderError) throw new Error(renderError);
      reportOperation(event, operationId, 'Generating PDF data', 0.75);
      const pdf = await printWindow.webContents.printToPDF({
        printBackground: true,
        preferCSSPageSize: true,
      });
      reportOperation(event, operationId, `Writing ${basename(target.filePath)}`, 0.95);
      await writeFile(target.filePath, pdf);
      reportOperation(event, operationId, 'PDF export complete', 1);
      return target.filePath;
    } finally {
      if (!printWindow.isDestroyed()) printWindow.destroy();
    }
  });

  /**
   * "Collaborate": share the open deck for live co-editing.
   *
   * The collab server becomes the deck's only writer — the desktop watcher
   * closes and the editor window hands off to the same browser client the
   * joiners load (over localhost), so the host is simply another peer. The
   * server is pinned to this one deck: joiners can't list, create, or import
   * anything else. Closing the window ends the session and brings the
   * ordinary editor back.
   */
  // Joiners need a URL reachable from their machine, so prefer a LAN
  // address. A desktop agent runs on this machine and should prefer loopback:
  // browser sandboxes commonly block private-LAN navigation while allowing
  // localhost, which is exactly the surface the editor has launched for it.
  const shellArgument = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const localAgentHandoff = (
    urls: string[],
    deckId: string,
    participantId: string,
  ): { url: string; command: string } | null => {
    const joinUrl = collaborationInviteUrl(urls, deckId, true);
    if (!joinUrl) return null;
    const url = new URL(joinUrl);
    url.searchParams.set('agent', participantId);
    const launcher = defaultLauncherPath() ?? 'slide-agent';
    return {
      url: url.href,
      command: `${shellArgument(launcher)} connect ${shellArgument(url.href)}`,
    };
  };
  const copyJoinLink = (
    urls: string[],
    deckId: string,
    agentParticipantId?: string,
  ): { url: string; command: string } | null => {
    const handoff = agentParticipantId
      ? localAgentHandoff(urls, deckId, agentParticipantId)
      : null;
    const joinUrl = handoff?.url ?? collaborationInviteUrl(urls, deckId, false);
    if (!joinUrl) return null;
    // The OS clipboard is the developer's, not the test's: an integration run
    // must not overwrite what they were about to paste, nor what a clipboard
    // test running beside this one just put there.
    if (process.env['DECKWERK_HEADLESS_TEST'] !== '1') {
      clipboard.writeText(handoff?.command ?? joinUrl);
    }
    return handoff;
  };

  const stopDeckWatchers = (state: DeckWindowState): void => {
    for (const watcher of state.watchers) watcher.close();
    state.watchers = [];
  };

  const startHostedServer = async (
    s: DeckSession,
    agentMode: boolean,
    onSessionEnd: () => void,
  ): Promise<RunningCollabServer> => {
    const clientDir = defaultClientDir(app.getAppPath());
    if (!clientDir) {
      throw new Error('The browser client is not built — run: npm run build:collab');
    }
    const base = {
      rootDir: dirname(s.dir),
      hostedDeckId: basename(s.dir),
      agentMode,
      clientDir,
      onSessionEnd,
      localAgents,
    };
    try {
      return await startCollabServer(base);
    } catch (error) {
      // 5800 taken (another session or app); any free port still shares fine.
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      return startCollabServer({ ...base, port: 0 });
    }
  };

  /**
   * Start an authoritative HTTP session while keeping the native editor in
   * place as an ordinary WebSocket peer. Both filesystem Agent mode and normal
   * user collaboration use this path; only the invite and shared-Agent policy
   * differ.
   */
  const startBackgroundSession = async (
    event: IpcMainInvokeEvent,
    mode: 'agent' | 'collaboration',
  ): Promise<AgentSessionConnection> => {
    const state = requireOwner(event);
    const s = requireSession(event);
    if (collabMode === 'window') throw new Error('End the current collaboration first');
    // One hosted session per app: it pins a server to a single deck and shares
    // one agent sign-in. Another window's presentation must not be taken over.
    if (collabServer && collabOwner && collabOwner !== state) {
      throw new Error(
        'Another window is already sharing a presentation — end that session first',
      );
    }
    const deckId = basename(s.dir);
    const name = userInfo().username || 'Host';
    const wantedMode = mode === 'agent' ? 'agent-background' : 'collaboration-background';
    if (mode === 'agent' && !desktopAgentParticipantId) {
      desktopAgentParticipantId = randomUUID();
    }

    if (collabServer && collabMode !== wantedMode) {
      await endBackgroundAgentSession();
    }
    if (!collabServer) {
      collabServer = await startHostedServer(
        s,
        mode === 'agent',
        () => setImmediate(() => void endBackgroundAgentSession()),
      );
      collabMode = wantedMode;
      collabOwner = state;
      // The server is now the deck's sole writer. Native edits will reach it
      // through the WebSocket bridge returned below.
      stopDeckWatchers(state);
    }
    if (collabMode !== wantedMode) {
      throw new Error('A different collaboration session is already running');
    }

    const handoff = copyJoinLink(
      collabServer.urls,
      deckId,
      mode === 'agent' ? desktopAgentParticipantId ?? undefined : undefined,
    );
    const connection: AgentSessionConnection = {
      active: true,
      deckId,
      name,
      mode,
      wsUrl: `ws://127.0.0.1:${collabServer.port}/ws?deck=${encodeURIComponent(deckId)}`,
      ...(handoff ? { agentUrl: handoff.url, agentCommand: handoff.command } : {}),
    };
    sendAgentSessionState(connection);
    return connection;
  };

  ipcMain.handle(
    IPC.agentSessionStart,
    async (event): Promise<AgentSessionConnection> => startBackgroundSession(event, 'agent'),
  );
  ipcMain.handle(IPC.agentSessionEnd, async (): Promise<void> => {
    await endBackgroundAgentSession();
  });

  // Keep the native editor in place. Replacing it with a second BrowserWindow
  // made Collaborate slow and visually disruptive, and—more importantly—meant
  // tests never exercised native cursor publishing.
  ipcMain.handle(IPC.collabStart, async (
    event,
    opts?: CollabStartRequest,
  ): Promise<AgentSessionConnection> => {
    if (opts?.agent) {
      return startBackgroundSession(event, 'agent');
    }
    return startBackgroundSession(event, 'collaboration');
  });

  ipcMain.handle(IPC.videoPoster, async (event, req: VideoPosterRequest): Promise<VideoPosterResult> => {
    const s = requireSession(event);
    const input = resolveAsset(s.dir, req.src);
    const name = await posterFor(input, req.time);
    return { url: name ? `deck://${POSTER_HOST}/${encodeURIComponent(name)}` : null };
  });

  ipcMain.handle(IPC.trimRun, async (event, req: TrimRequest): Promise<TrimResult> => {
    const s = requireSession(event);
    const input = resolveAsset(s.dir, req.src);
    const { absolute, relative } = await derivedAssetPath(s.dir, req.src, 'trim');

    await runTrim(req, input, absolute, (fraction, message) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.trimProgress, { fraction, message });
      }
    });

    const info = await probeMedia(absolute);
    const result: TrimResult = { src: relative, ...info };
    // The editor is what relinks the element; the trim window only reports.
    requireOwner(event).editor.webContents.send(IPC.trimDone, result);
    return result;
  });

  ipcMain.handle(
    IPC.rasterSave,
    async (event, req: RasterSaveRequest): Promise<RasterResult> => {
      const s = requireSession(event);
      // Resolving the input is a cheap containment/existence check. Raster
      // output always becomes a sibling derived asset; the original stays put.
      const input = resolveAsset(s.dir, req.src);
      if (!existsSync(input)) throw new Error(`Image asset does not exist: ${req.src}`);
      const bytes = Buffer.from(req.png);
      const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
        throw new Error('Raster editor produced an invalid PNG');
      }
      if (!Number.isInteger(req.width) || !Number.isInteger(req.height)
        || req.width < 1 || req.height < 1) {
        throw new Error('Raster editor produced invalid image dimensions');
      }
      const { absolute, relative } = await derivedAssetPath(s.dir, req.src, 'paint', '.png');
      await writeFile(absolute, bytes);
      const result: RasterResult = {
        src: relative,
        elementId: req.elementId,
        width: req.width,
        height: req.height,
      };
      requireOwner(event).editor.webContents.send(IPC.rasterDone, result);
      return result;
    },
  );
}
