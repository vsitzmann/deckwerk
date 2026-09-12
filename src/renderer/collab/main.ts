import '../player/player.css';
import '../appChrome.css';
import '../editor/editor.css';
import './collab.css';
import { emptyDeck } from '@shared/deck.js';
import { setIdSuffix } from '@shared/geometry.js';
import { EditorCanvas } from '../editor/canvas.js';
import { SpeakerNotesDrawer } from '../editor/speakerNotesDrawer.js';
import { createDeckWerkButton } from '../editor/aboutDialog.js';
import { installAgentApi, setAgentName } from './agentApi.js';
import { CssEditor } from '../editor/cssEditor.js';
import {
  createToolbarPicker,
  createToolbarSplitButton,
  type ToolbarPickerEntry,
} from '../editor/exportPicker.js';
import { showPdfExportDialog } from '../editor/pdfExportDialog.js';
import { HistoryPanel } from '../editor/historyPanel.js';
import {
  createShapeInsertPicker,
  createTableInsertPicker,
  insertText,
} from '../editor/elementCreation.js';
import { Inspector } from '../editor/inspector.js';
import {
  barButton,
  barIconButton,
  TEXT_ICON,
  bindEditorKeys,
  createClipboardActions,
  makeContextActions,
  wireCanvasInspector,
  type ShellDeps,
} from '../editor/shellWiring.js';
import { SlideRail } from '../editor/slideRail.js';
import { EditorStore } from '../editor/store.js';
import { createThemePanel } from '../editor/themePanel.js';
import { TimelinePanel } from '../editor/timelinePanel.js';
import { CollabBridge } from './collabBridge.js';
import { createConnectionNotice } from './connectionNotice.js';
import { createDeckOnServer, importKeynoteToServer, importPowerPointToServer, showDeckPicker, showShareDialog } from './deckPicker.js';
import { installNetApi } from './netApi.js';
import { PresenceOverlay } from './presenceOverlay.js';
import { installAgentWorkspace } from './agentWorkspace.js';
import { createSharedAgentApi, type SharedAgentBrowserApi } from './sharedAgentApi.js';
import { openEndCollaborationPopover } from './endCollaborationPopover.js';
import { decodeEditorView, restoreEditorView } from '@shared/editorView.js';
import { AgentChatPanel } from '../editor/agentChatPanel.js';
import { startPresenting } from './presentOverlay.js';
import { rangeForSlideSelection } from '@shared/presentationRange.js';
import { setRenderInvariantChecks } from '../editor/renderInvariants.js';
import { setSelectionInvariantChecks } from '../editor/selectionInvariants.js';
import { trackPreviewFrameRecovery } from '../player/previewFrameRecovery.js';
import { trackVideoLoading } from '../player/videoLoadingProgress.js';
import { DelayedOperationProgress } from '../editor/operationProgress.js';
import { DesignWorkspace } from '../editor/designWorkspace.js';
import { installResponsiveToolbar } from '../editor/responsiveToolbar.js';

/**
 * Browser collaboration shell: the same canvas, rail, inspector, theme
 * gallery, timeline and history panels as the desktop app, wired to a collab
 * server over WebSocket instead of an Electron preload. Persistence, asset
 * storage, ffprobe, and presentation import live on the server; edits leave here
 * as element-level transactions and arrive from everyone else the same way.
 */

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

/* --- identity ------------------------------------------------------------ */

function userName(): string {
  const fromQuery = new URLSearchParams(location.search).get('name');
  if (fromQuery) {
    localStorage.setItem('collab-name', fromQuery);
    return fromQuery;
  }
  const stored = localStorage.getItem('collab-name');
  if (stored) return stored;
  try {
    const answer = (prompt('Your name for this session?') ?? '').trim();
    if (answer) localStorage.setItem('collab-name', answer);
    return answer;
  } catch {
    return ''; // Embedded browsers may block prompt(); the server assigns Guest N.
  }
}

/* --- server session config --------------------------------------------------- */

/**
 * A hosted session is the desktop app sharing the one deck it has open: the
 * server pins that deck, so joiners get no New/Open/Import — they land
 * straight in the shared presentation.
 */
interface ServerConfig {
  hosted: boolean;
  deckId: string | null;
  urls: string[];
  sharedAgent: null | {
    enabled: true;
    name: string;
    canManageAccount: boolean;
    personal?: boolean;
    /** Participants connect their own local agents (headless server default). */
    mode?: 'local';
  };
  /** Present when the server runs with --access: who the server says we are. */
  access?: null | { user: string; name: string; admin: boolean };
}

let serverConfig: ServerConfig = { hosted: false, deckId: null, urls: [], sharedAgent: null, access: null };

async function fetchServerConfig(): Promise<ServerConfig> {
  try {
    const response = await fetch('/api/config');
    if (response.ok) return await response.json() as ServerConfig;
  } catch {
    // Older server without /api/config; behave like the multi-deck server.
  }
  return { hosted: false, deckId: null, urls: [], sharedAgent: null, access: null };
}

/* --- deck selection -------------------------------------------------------- */

const deckId = new URLSearchParams(location.search).get('deck');
const initialView = decodeEditorView(new URLSearchParams(location.search).get('view'));
let initialViewPending = initialView !== null;

const PRESENT_NEEDS_SERVER = 'Presenting needs the server — waiting to reconnect.';
let statusMessage = '';
let statusBusy = false;
let participantName = '';
let sharedAgentPanel: AgentChatPanel | null = null;
let sharedAgentBrowserApi: SharedAgentBrowserApi | null = null;
function setStatusMessage(text: string): void {
  statusMessage = text;
  statusBusy = false;
  renderStatus();
}

const operationProgress = new DelayedOperationProgress(({ message, busy }) => {
  statusMessage = message;
  statusBusy = busy;
  renderStatus();
});

async function runOperation<T>(message: string, action: () => Promise<T>): Promise<T> {
  const operation = operationProgress.begin(message);
  try {
    return await action();
  } finally {
    operation.finish();
  }
}

if (!deckId) {
  el('status').textContent = 'Connecting…';
  void fetchServerConfig().then((config) => {
    if (config.hosted && config.deckId) {
      // Hosted session: there is exactly one deck — join it, no picker.
      const params = new URLSearchParams(location.search);
      params.set('deck', config.deckId);
      location.search = params.toString();
      return;
    }
    el('status').textContent = 'Choose a presentation to start.';
    // Module init stops right below this block (`throw`), so the editor store
    // never exists here: status goes straight to the DOM, not renderStatus().
    showDeckPicker({
      dismissable: false,
      onStatus: (text) => { el('status').textContent = text; },
      access: config.access ?? null,
    });
  });
  throw new Error('no deck selected — showing picker');
}

/* --- boot ----------------------------------------------------------------- */

installNetApi({ deckId, saveTheme: (css) => bridge.sendTheme(css) });

const store = new EditorStore(emptyDeck('Connecting…'));
// Development builds verify after every in-place patch that the canvas DOM
// still matches a fresh render of the deck, and report any property the two
// paths disagree about. See renderInvariants.ts.
setRenderInvariantChecks(import.meta.env.DEV);
setSelectionInvariantChecks(import.meta.env.DEV);
const canvas = new EditorCanvas(el('canvas'), store);
// Remote sessions fetch video bytes over the wire; until a frame decodes each
// video is a black box, so overlay loading progress on the editing canvas.
trackVideoLoading(el('canvas'));
// Presenting hides this page, and a hidden page's media buffers are Chromium's
// to reclaim: come back from Present and canvas, rail and Morph previews
// can all be black with nothing in flight. Re-queue them on the way back.
trackPreviewFrameRecovery(el('canvas'), document.body);
// Peers should watch each other type, not just see the result on blur.
canvas.liveTextSync = true;
// Speaker notes edit like any other slide field and reach peers through the
// same store; the file behind them lives on the server, so there is nothing
// local to open here.
new SpeakerNotesDrawer(el('canvas'), store, {
  onInsetChange: (px) => canvas.setBottomInset(px),
  onStatus: setStatusMessage,
});
const inspector = new Inspector(el('inspector'), store);
new TimelinePanel(el('timeline'), store);
new HistoryPanel(el('history'), store);
const rail = new SlideRail(el('rail'), store);
// The CSS buffer backs the Theme panel and live theme sync. Like the desktop
// app it has no sidebar tab of its own — theme.css is edited on disk or
// through theme adoption, not in this UI.
const cssHost = document.createElement('div');
cssHost.hidden = true;
document.body.appendChild(cssHost);
const cssEditor = new CssEditor(cssHost);
// See the desktop shell: the inspector reads theme values off the live
// stylesheet, so it has to be rebuilt whenever that stylesheet changes.
cssEditor.onChange = () => {
  canvas.refitAutoText();
  inspector.noteThemeChanged();
};
// The documented HTML-first surface and visible agent workspace share this
// compiler and the live theme buffer.
installAgentApi(store, deckId, { theme: () => cssEditor.getValue() });
installAgentWorkspace(store);
const presence = new PresenceOverlay(canvas, store);
rail.presenceForSlide = (slideId) => presence.peersOnSlide(slideId);

wireCanvasInspector(canvas, inspector);

const designWorkspace = new DesignWorkspace({
  canvasHost: el('canvas'),
  store,
  save: async () => {},
  setStatusMessage,
});
const themePanel = createThemePanel({
  store,
  cssEditor,
  save: async () => {},
  setStatusMessage,
  saveThemeCss: (css) => bridge.sendTheme(css),
  onThemePreview: (theme) => (theme ? designWorkspace.show(theme) : designWorkspace.hide()),
  onEditLayouts: (layout) => designWorkspace.openLayoutEditor(layout),
  onPreviewSlide: (slide, label) => designWorkspace.previewSlideOnCanvas(slide, label),
  onPreviewThemeDraft: (theme) => designWorkspace.previewThemeDraft(theme),
});
rail.onSlideActivate = () => {
  themePanel.dismiss();
  designWorkspace.hide();
};
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const escaped = designWorkspace.escape();
  if (escaped === 'theme') themePanel.dismiss();
  const dismissedThemeEditor = !escaped && themePanel.dismiss();
  if (dismissedThemeEditor) designWorkspace.hide();
  if (escaped || dismissedThemeEditor) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);
inspector.onEditLayouts = (layout) => designWorkspace.openLayoutEditor(layout);
inspector.onPreviewSlide = (slide, label) => designWorkspace.previewSlideOnCanvas(slide, label);
el('themePanel').appendChild(themePanel.element);
el('themePanel').classList.add('theme-panel');

let connectionState = 'connecting…';
/** Whether a welcome has already been handled, i.e. later ones are reconnects. */
let welcomed = false;
/** Live connection state; gates the actions that need the server (Present, export). */
let connected = false;

// When the server dies mid-session the status-bar text is easy to miss, and
// what the user most needs to know — synced edits are safe, new ones will be
// discarded — is not obvious. The banner says it, and offers a client-side
// backup of the in-memory deck, the only save that works without the server.
const connectionNotice = createConnectionNotice({
  mode: 'editor',
  backup: () => ({
    fileName: `${deckId}-backup.json`,
    text: JSON.stringify(
      { deck: store.get().deck, themeCss: cssEditor.getValue() },
      null,
      2,
    ),
  }),
});

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?deck=${encodeURIComponent(deckId)}`;
// The hello name is set just before connect(): an access-controlled server
// assigns names from the tailnet identity, so prompting for one would be
// asking a question whose answer the server ignores.
const bridge = new CollabBridge(wsUrl, undefined, {
  onWelcome: (welcome) => {
    // Presence messages are intentionally not queued while disconnected. A
    // reconnect therefore establishes a fresh deduplication epoch: the same
    // still-selected objects must be published to the server again.
    lastPresenceKey = '';
    lastCursorKey = '';
    participantName = welcome.self.name;
    setIdSuffix(welcome.clientId.slice(0, 4));
    setAgentName(welcome.self.name);
    connectionState = `connected as ${welcome.self.name}`;
    // The first welcome opens the document; every later one is a reconnect of
    // the same session, where the revision log and the selection must survive.
    if (welcomed) store.resyncRemote(welcome.deck, `(collab) ${deckId}`);
    else store.load(welcome.deck, `(collab) ${deckId}`, { keepView: true });
    welcomed = true;
    if (initialViewPending) {
      restoreEditorView(store, initialView);
      initialViewPending = false;
    }
    cssEditor.setValue(welcome.themeCss);
    themePanel.noteDeckOpened(welcome.deck);
    presence.replaceAll(welcome.peers);
    rail.refreshPresence();
    renderStatus();
    document.documentElement.dataset.collabReady = 'true';
  },
  onDeckReplaced: (deck, label, options) => {
    store.applyRemote(deck, label, options);
  },
  onPeerPresence: (state) => {
    presence.upsert(state);
    rail.refreshPresence();
  },
  onPeerCursor: (clientId, cursor) => presence.moveCursor(clientId, cursor),
  onPeerLeft: (clientId) => {
    presence.remove(clientId);
    rail.refreshPresence();
  },
  onThemeCss: (css) => {
    // Never yank the CodeMirror buffer out from under someone typing in it.
    if (!cssEditor.hasFocus() && css !== cssEditor.getValue()) cssEditor.setValue(css);
  },
  onStatus: (text) => {
    connectionState = text;
    renderStatus();
  },
  onCleanChange: (clean) => {
    if (clean) store.markClean();
  },
  onConnectionChange: (isConnected) => {
    connected = isConnected;
    if (isConnected) {
      connectionNotice.hide();
      // The refusal is moot once the server is back; don't leave it lingering.
      if (statusMessage === PRESENT_NEEDS_SERVER) setStatusMessage('');
    } else {
      delete document.documentElement.dataset.collabReady;
      connectionNotice.showDisconnected();
    }
  },
  onEditsDiscarded: (count) => {
    setStatusMessage(count === 1
      ? 'Reconnected — 1 change made while disconnected could not be saved and was discarded.'
      : `Reconnected — ${count} changes made while disconnected could not be saved and were discarded.`);
  },
  onEnded: () => {
    connected = false;
    connectionState = 'session ended by the host';
    setStatusMessage('The host ended this collaboration.');
    connectionNotice.showEnded('The host ended this collaboration. All synced edits are saved on the host.');
  },
});

store.onLocalEdit = bridge.localEdit;

/* --- shared shell wiring --------------------------------------------------- */

const shellDeps: ShellDeps = {
  store,
  canvas,
  rail,
  // Persistence is the server's job; Cmd+S just confirms that.
  save: async () => setStatusMessage('Saved automatically — every edit syncs live.'),
  setStatusMessage,
  runOperation,
  undo: () => bridge.undo(store.get().deck),
  redo: () => bridge.redo(store.get().deck),
};
const clipboard = createClipboardActions(shellDeps);
bindEditorKeys(shellDeps, clipboard);
canvas.contextActions = makeContextActions(shellDeps, clipboard);

/* --- presence sending ------------------------------------------------------ */

// Cursor: rAF-throttled with a 30Hz floor, skipping unmoved samples.
let pendingCursor: { x: number; y: number } | null | undefined;
let lastCursorSent = 0;
let lastCursorKey = '';
let cursorFrame = 0;
let cursorTimer = 0;
const flushCursor = () => {
  cursorFrame = 0;
  const now = performance.now();
  const remaining = 33 - (now - lastCursorSent);
  if (remaining > 0) {
    // Do not drop a lone Safari compatibility-mouse sample merely because it
    // followed another event inside the rate-limit window. Deliver the newest
    // point once the window expires.
    cursorTimer = window.setTimeout(() => {
      cursorTimer = 0;
      cursorFrame = requestAnimationFrame(flushCursor);
    }, remaining);
    return;
  }
  const slide = store.slide;
  const cursor = pendingCursor && slide
    ? { slideId: slide.id, x: Math.round(pendingCursor.x), y: Math.round(pendingCursor.y) }
    : null;
  const key = JSON.stringify(cursor);
  if (key === lastCursorKey) return;
  lastCursorKey = key;
  lastCursorSent = now;
  bridge.sendCursor(cursor);
};
canvas.onPointerSample = (point) => {
  pendingCursor = point;
  if (cursorFrame || cursorTimer) return;
  cursorFrame = requestAnimationFrame(flushCursor);
};
const clearRemoteCursor = () => {
  pendingCursor = null;
  if (cursorFrame) cancelAnimationFrame(cursorFrame);
  if (cursorTimer) clearTimeout(cursorTimer);
  cursorFrame = 0;
  cursorTimer = 0;
  lastCursorKey = 'null';
  bridge.sendCursor(null);
};
el('canvas').addEventListener('pointerleave', clearRemoteCursor);
// WebKit may pair its compatibility mousemove stream with mouseleave rather
// than pointerleave. Sending null twice is safe and prevents a cursor from
// sticking at the canvas edge.
el('canvas').addEventListener('mouseleave', clearRemoteCursor);

// Selection, active slide, editing element: edge-triggered from store changes.
let lastPresenceKey = '';
function publishPresence(): void {
  const { deck, slideIndex, slideSelection, selection } = store.get();
  const state = {
    activeSlideId: deck.slides[slideIndex]?.id ?? null,
    selectedSlideIds: [...slideSelection],
    selectedElementIds: [...selection],
    editingElementId: canvas.editingElementId(),
  };
  const key = JSON.stringify(state);
  if (key === lastPresenceKey) return;
  lastPresenceKey = key;
  bridge.sendPresence(state);
}
store.subscribe(() => {
  publishPresence();
  syncSlideSelectionContext();
  const title = document.querySelector<HTMLElement>('.toolbar-deck-title');
  if (title) title.textContent = store.get().deck.title;
  renderStatus();
});
const inspectorRefresh = canvas.onTextEditModeChange;
canvas.onTextEditModeChange = (elementId) => {
  inspectorRefresh?.(elementId);
  publishPresence();
};

/* --- toolbar, tabs, status -------------------------------------------------- */

/**
 * navigator.clipboard only exists in secure contexts; joiners load this page
 * over plain http on the LAN, so fall back to the legacy execCommand path.
 */
/**
 * The one line a person runs to bring their own agent into this deck: fetch
 * the server's own bridge and run it with Node. The page's origin is the
 * address that reaches the server from their machine — the tailnet name they
 * opened, not a loopback the server prints.
 */
function localAgentConnectCommand(deck: string, participantId: string): string {
  return `curl -fsSL ${location.origin}/deckwerk-connect.mjs -o deckwerk-connect.mjs `
    + `&& node deckwerk-connect.mjs '${localAgentSessionUrl(deck, participantId)}'`;
}

function localAgentSessionUrl(deck: string, participantId: string): string {
  const session = new URL(location.origin);
  session.searchParams.set('deck', deck);
  session.searchParams.set('agent', participantId);
  return session.href;
}

/** A prompt for an agent that will work the HTTP API directly, no bridge. */
function localAgentBrief(deck: string, participantId: string): string {
  const origin = location.origin;
  const query = `deck=${encodeURIComponent(deck)}&agentSession=${encodeURIComponent(participantId)}`;
  return `# Live presentation editing session

Session URL: ${localAgentSessionUrl(deck, participantId)}
API origin: ${origin}
Deck ID: ${deck}

You are editing a DeckWerk presentation that people are working on live. Everything
happens over its HTTP API; start by reading the complete guide:

    curl -s '${origin}/api/brief?${query}'

Append \`${query}\` to every /api request: that is how your work is attributed
to me and how your previews open in my browser. Read /api/comments before authoring —
comments are the task list — and check the playerUrl a successful apply returns.`;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  document.body.append(scratch);
  scratch.select();
  const ok = document.execCommand('copy');
  scratch.remove();
  if (!ok) throw new Error('copy rejected');
}

/**
 * Open the print tab for the live deck.
 *
 * The pages are built from `/api/deck`, so the export is whatever every
 * collaborator currently sees — there is nothing local to flush first.
 */
async function exportPdf(): Promise<void> {
  const choice = await showPdfExportDialog();
  if (!choice) return;
  const query = new URLSearchParams({
    deck: deckId!,
    mode: choice.includeEachBuildStage ? 'every' : 'final',
  });
  const tab = window.open(`./print.html?${query.toString()}`, '_blank');
  if (!tab) {
    setStatusMessage('PDF export needs a new tab — allow pop-ups for this site and try again.');
    return;
  }
  setStatusMessage('Preparing the PDF in a new tab…');
}

/**
 * Present the deck, honouring a multi-slide rail selection as a bounded run
 * exactly as the desktop app does: a selection of two or more slides starts at
 * the first and ends the show after the last.
 */
function startPresentation(speakerView = false): void {
  // present.html and its bundle are served by the collab server; with the
  // server gone the iframe would load nothing — a white overlay with no
  // explanation. Refuse with the reason instead.
  if (!connected) {
    setStatusMessage(PRESENT_NEEDS_SERVER);
    connectionNotice.showDisconnected();
    return;
  }
  const { deck, slideIndex, slideSelection } = store.get();
  const range = rangeForSlideSelection(deck.slides, slideSelection);
  startPresenting(
    deckId!,
    range?.start ?? slideIndex,
    () => ({ deck: store.get().deck, themeCss: cssEditor.getValue() }),
    { endSlideIndex: range?.end, speakerView, onStatus: setStatusMessage },
  );
}

/**
 * The desktop app's self-contained web bundle, built by the server from the
 * live session and delivered as a zip.
 *
 * The bundle is streamed rather than buffered — a deck's video is most of its
 * bytes — so the browser cannot report a failure once the download starts.
 * Hence the probe: the one thing that can go wrong (a server without the built
 * export player) is settled before any bytes move.
 */
async function exportWeb(): Promise<void> {
  const query = `deck=${encodeURIComponent(deckId!)}`;
  const refusal = await runOperation('Checking the web export…', async () => {
    const probe = await fetch(`/api/export/web?${query}&probe=1`);
    if (probe.ok) return null;
    const body = await probe.json().catch(() => null) as { error?: string } | null;
    return body?.error ?? `HTTP ${probe.status}`;
  });
  if (refusal !== null) {
    setStatusMessage(`Web export unavailable: ${refusal}`);
    return;
  }
  const link = document.createElement('a');
  link.href = `/api/export/web?${query}`;
  link.download = `${deckId}-web.zip`;
  link.click();
  // A browser download reports its own progress and completion, and nothing
  // here is told when it finishes — so say what is happening and stop there
  // rather than leaving a spinner that could never be cleared.
  setStatusMessage('Building the web export — the download starts when the server is done.');
}

function buildToolbar(): void {
  const bar = el('toolbar');
  bar.replaceChildren();

  const left = document.createElement('div');
  left.className = 'bar-group';
  const divider = (): HTMLElement => {
    const line = document.createElement('span');
    line.className = 'bar-divider';
    line.setAttribute('aria-hidden', 'true');
    return line;
  };
  const deckName = document.createElement('span');
  deckName.className = 'bar-deck-name';
  deckName.textContent = deckId;
  left.append(createDeckWerkButton(), deckName, divider());
  const fileActions = document.createElement('span');
  fileActions.className = 'toolbar-expanded-file-actions';
  const compactFileEntries: ToolbarPickerEntry[] = [];
  // In a hosted session the server pins one deck; switching, creating or
  // importing presentations is the host's business, not a joiner's.
  if (!serverConfig.hosted) {
    const createDeck = (): void => {
      void createDeckOnServer().catch((error) =>
        setStatusMessage(`Create failed: ${error instanceof Error ? error.message : error}`));
    };
    const openDeck = (): void => showDeckPicker({
      dismissable: true,
      onStatus: setStatusMessage,
      access: serverConfig.access ?? null,
    });
    const importEntries = [
      { label: 'Keynote…', action: () => importKeynoteToServer(setStatusMessage) },
      { label: 'PowerPoint…', action: () => importPowerPointToServer(setStatusMessage) },
    ];
    fileActions.append(
      barButton('New', () => {
        createDeck();
      }),
      barButton('Open', openDeck),
      createToolbarPicker('Import…', importEntries),
    );
    compactFileEntries.push(
      {
        label: 'Presentation',
        options: [
          { label: 'New', action: createDeck },
          { label: 'Open…', action: openDeck },
        ],
      },
      { label: 'Import', options: importEntries },
    );
  }
  // In collaboration the deck archive comes straight off the server (which
  // flushes the live session before streaming it), while PDF is produced in a
  // print tab: the headless server has no Chromium of its own, so the
  // browser's own "Save as PDF" stands in for the desktop app's printToPDF.
  const downloadDeck = (): void => {
    const link = document.createElement('a');
    link.href = `/api/download?deck=${encodeURIComponent(deckId!)}`;
    link.download = `${deckId}.zip`;
    link.click();
  };
  const saveEntries: ToolbarPickerEntry[] = [
    {
      label: 'Deck archive (.zip)…',
      action: downloadDeck,
    },
    {
      label: 'Lossy export',
      options: [
        { label: 'PDF…', action: () => void exportPdf() },
        { label: 'Web…', action: () => void exportWeb() },
      ],
    },
  ];
  fileActions.append(createToolbarPicker('Save As…', saveEntries, { deckOnly: true }));
  compactFileEntries.push({
    label: 'Save and export',
    options: [
      {
        label: 'Deck archive (.zip)…',
        action: downloadDeck,
      },
      { label: 'Export PDF…', action: () => void exportPdf() },
      { label: 'Export Web…', action: () => void exportWeb() },
    ],
  });
  const compactFile = createToolbarPicker('File', compactFileEntries, { deckOnly: true });
  compactFile.classList.add('toolbar-compact-file-action');
  left.append(fileActions, compactFile);

  const mid = document.createElement('div');
  mid.className = 'bar-group bar-center';
  mid.append(
    barIconButton('Text', TEXT_ICON, () => insertText(store)),
    createShapeInsertPicker(store),
    createTableInsertPicker(store),
  );

  const right = document.createElement('div');
  right.className = 'bar-group bar-right';
  const secondaryActions = document.createElement('span');
  secondaryActions.className = 'toolbar-expanded-secondary-actions';
  const compactSecondaryEntries: ToolbarPickerEntry[] = [];
  // Access-controlled server: the sharing dialog handles both cases — owners
  // and the admin get controls, everyone else a read-only summary.
  if (serverConfig.access) {
    const share = (): void => showShareDialog(deckId!, setStatusMessage);
    secondaryActions.append(barButton('Share…', share));
    compactSecondaryEntries.push({ label: 'Share…', action: share });
  }
  if (serverConfig.sharedAgent?.enabled) {
    const toggleSharedAgent = (): void => sharedAgentPanel?.toggle();
    const agentLabel = serverConfig.sharedAgent.personal || serverConfig.sharedAgent.mode === 'local'
      ? 'Agent…'
      : 'Shared Agent';
    const agent = barButton(
      agentLabel,
      toggleSharedAgent,
    );
    agent.id = 'agent-chat-trigger';
    secondaryActions.append(agent);
    compactSecondaryEntries.push({ label: agentLabel, action: toggleSharedAgent });
  }
  if (serverConfig.hosted) {
    const copyInviteLink = (): void => {
      const base = serverConfig.urls.find((u) => !u.includes('127.0.0.1')) ?? serverConfig.urls[0];
      if (!base) {
        setStatusMessage('No invite link available');
        return;
      }
      const link = `${base}?deck=${encodeURIComponent(deckId!)}`;
      void copyText(link).then(
        () => setStatusMessage('Invite link copied'),
        () => setStatusMessage(`Could not copy — invite: ${link}`),
      );
    };
    secondaryActions.append(barButton('Copy Invite Link', copyInviteLink));
    compactSecondaryEntries.push({ label: 'Copy Invite Link', action: copyInviteLink });
  }
  // In a hosted session the desktop app's own window is the only loopback
  // client, so hosted + loopback identifies the host. The server enforces the
  // same rule on /api/end; this only decides whether to show the button.
  const isHost = serverConfig.hosted
    && (location.hostname === '127.0.0.1' || location.hostname === 'localhost');
  let compactSecondary: HTMLElement | null = null;
  if (isHost) {
    const requestEndCollaboration = (anchor: HTMLButtonElement): void => {
      openEndCollaborationPopover(anchor, () => {
        void fetch('/api/end', { method: 'POST' }).catch((error) =>
          setStatusMessage(`Could not end the session: ${error instanceof Error ? error.message : error}`));
      });
    };
    const endCollaboration = barButton(
      'End collaboration',
      () => requestEndCollaboration(endCollaboration),
      'danger',
    );
    endCollaboration.id = 'end-collaboration-trigger';
    secondaryActions.append(endCollaboration);
    compactSecondaryEntries.push({
      label: 'End collaboration',
      action: () => requestEndCollaboration(
        compactSecondary?.querySelector<HTMLButtonElement>('.shape-menu-trigger') ?? endCollaboration,
      ),
    });
  }
  if (compactSecondaryEntries.length > 0) {
    compactSecondary = createToolbarPicker('More', compactSecondaryEntries);
    compactSecondary.classList.add('toolbar-compact-secondary-action');
  }
  right.append(
    secondaryActions,
    ...(compactSecondary ? [compactSecondary] : []),
    createToolbarSplitButton(
      'Present',
      () => startPresentation(),
      [{ label: 'Present in Speaker View', action: () => startPresentation(true) }],
      { variant: 'primary', menuLabel: 'Presentation options' },
    ),
  );

  bar.append(left, mid, right);
  installResponsiveToolbar(bar);
}

const PANELS = [
  { id: 'inspector', label: 'Props' },
  { id: 'themePanel', label: 'Design' },
  { id: 'timeline', label: 'Build' },
  { id: 'history', label: 'History' },
] as const;

let activePanelId = 'inspector';

function buildTabs(): void {
  const tabs = el('side-tabs');
  tabs.replaceChildren();
  for (const panel of PANELS) {
    const b = document.createElement('button');
    b.textContent = panel.label;
    b.dataset.panel = panel.id;
    b.addEventListener('click', () => showPanel(panel.id));
    tabs.appendChild(b);
  }
  showPanel('inspector');
}

function showPanel(id: string): void {
  if (store.get().slideSelection.size > 1 && id !== 'themePanel' && id !== 'inspector') return;
  activePanelId = id;
  for (const panel of PANELS) el(panel.id).hidden = panel.id !== id;
  for (const b of el('side-tabs').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.panel === id);
  }
  if (id === 'inspector') inspector.render();
  if (id === 'themePanel') el('themePanel').scrollTop = 0;
  if (id !== 'themePanel') designWorkspace.hide();
  rail.setDesignLabels(id === 'themePanel');
  canvas.setBuildBadgesVisible(id === 'timeline');
}

/** Multi-slide selection is a deck-level editing context: Theme and Props apply. */
function syncSlideSelectionContext(): void {
  const count = store.get().slideSelection.size;
  const multiple = count > 1;
  for (const button of el('side-tabs').querySelectorAll<HTMLButtonElement>('button')) {
    button.disabled = multiple
      && button.dataset.panel !== 'themePanel'
      && button.dataset.panel !== 'inspector';
  }
  if (multiple && activePanelId !== 'themePanel' && activePanelId !== 'inspector') {
    showPanel('themePanel');
  }
  themePanel.syncScope(count);
}

function renderStatus(): void {
  const { deck, slideIndex, slideSelection, selection, dirty } = store.get();
  const bits = [
    connectionState,
    deck.title,
    `slide ${slideIndex + 1}/${deck.slides.length}`,
  ];
  if (slideSelection.size > 1) bits.push(`${slideSelection.size} slides selected`);
  if (selection.size > 0) bits.push(`${selection.size} selected`);
  if (dirty) bits.push('syncing…');
  if (statusMessage) bits.push(statusMessage);
  // In a hosted session, keep the invite address visible so anyone at the
  // machine can read it out — the LAN/tailscale URL, not loopback.
  if (serverConfig.hosted) {
    const invite = serverConfig.urls.find((u) => !u.includes('127.0.0.1')) ?? serverConfig.urls[0];
    if (invite) bits.push(`invite: ${invite}`);
  }
  if (serverConfig.sharedAgent?.enabled && serverConfig.sharedAgent.mode !== 'local') {
    bits.push(serverConfig.sharedAgent.personal
      ? `${serverConfig.sharedAgent.name}: host agent`
      : `${serverConfig.sharedAgent.name}: shared test mode`);
  }
  // Visible in any screenshot or accessibility read of the page, so an agent
  // that lands here cold finds its onboarding without guessing endpoints.
  bits.push('agents: GET /api/brief · await window.agent.seeComments()');
  el('status').textContent = bits.join('  ·  ');
  el('status').dataset.busy = statusBusy ? 'true' : 'false';
  el('status').setAttribute('aria-busy', String(statusBusy));
}

// The toolbar depends on whether this is a hosted session; one round-trip
// before first paint of the buttons keeps New/Open/Import from flashing in.
void fetchServerConfig().then((config) => {
  serverConfig = config;
  if (config.sharedAgent?.enabled && !sharedAgentPanel) {
    sharedAgentBrowserApi = createSharedAgentApi(deckId!, () => participantName || 'Guest');
    const local = config.sharedAgent.mode === 'local';
    sharedAgentPanel = new AgentChatPanel({
      api: sharedAgentBrowserApi.api,
      currentDeckPath: () => deckId,
      title: config.sharedAgent.personal || local
        ? config.sharedAgent.name
        : `${config.sharedAgent.name} · test mode`,
      userRoleLabel: config.sharedAgent.personal || local ? 'You' : 'Participant',
      canManageAccount: config.sharedAgent.canManageAccount,
      ...(local ? {
        localAgent: {
          connectCommand: localAgentConnectCommand(deckId!, sharedAgentBrowserApi.participantId),
          brief: localAgentBrief(deckId!, sharedAgentBrowserApi.participantId),
        },
      } : {}),
    });
    // The bridge a person starts from that panel pairs with this browser's
    // selection through the participant id announced in the hello.
    if (local) bridge.setParticipant(sharedAgentBrowserApi.participantId);
  }
  buildToolbar();
  renderStatus();
  // Connect only after the config answers whether the server assigns names
  // (access control) or the client supplies one (possibly via a prompt).
  if (!config.access) bridge.setName(userName() || undefined);
  bridge.connect();
});
buildTabs();
syncSlideSelectionContext();
renderStatus();

// Console access for debugging and driving a session from devtools.
Object.assign(window, { store, canvas, rail, bridge });
window.addEventListener('beforeunload', () => sharedAgentBrowserApi?.close());
