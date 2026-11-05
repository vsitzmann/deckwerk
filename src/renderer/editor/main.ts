import '../player/player.css';
import '../appChrome.css';
import './editor.css';
import '../collab/collab.css';
import '../lightTheme.css';
import { applyUiTheme } from '../uiTheme.js';
import { applyUiScale } from '../uiScale.js';
import { applyAgentOperations, applyAgentTransaction, type AgentOperation } from '@shared/agent.js';
import type { Deck, SlideElement } from '@shared/deck.js';
import { emptyDeck } from '@shared/deck.js';
import type { AgentSessionConnection, AuthoredHtmlFile, PresentationImportResult } from '@shared/ipc.js';
import { captureEditorView, decodeEditorView, restoreEditorView } from '@shared/editorView.js';
import { setIdSuffix } from '@shared/geometry.js';
import { adoptAuthoredIds, describeHtmlSync, htmlSyncSummary, pageStampOf, stampPage } from '@shared/htmlSlides.js';
import { rangeForSlideSelection } from '@shared/presentationRange.js';
import {
  themeById,
  themeCss,
  deckThemes,
  themeStyleCss,
  themeStyleLabel,
  withThemeBlock,
} from '@shared/themes.js';
import { AgentBridge, type HtmlSyncOutcome } from './agentBridge.js';
import { AgentPanel } from './agentPanel.js';
import { createDeckWerkButton } from './aboutDialog.js';
import { installUpdates } from './updateDialog.js';
import { trackPreviewFrameRecovery } from '../player/previewFrameRecovery.js';
import { CANVAS_NOTICE_EVENT, EditorCanvas } from './canvas.js';
import { CssEditor } from './cssEditor.js';
import { Inspector } from './inspector.js';
import { HistoryPanel } from './historyPanel.js';
import { ObjectList } from './objectList.js';
import { MediaPanel, installMediaDrop } from './mediaPanel.js';
import { authoredHtmlSync, fileName } from './htmlCompile.js';
import { createPenButton, createShapeInsertPicker, createTableInsertPicker, insertText } from './elementCreation.js';
import { insertCode } from './codeInspector.js';
import { createToolbarPicker, createToolbarSplitButton } from './exportPicker.js';
import { showPdfExportDialog } from './pdfExportDialog.js';
import { showWebExportDialog } from './webExportDialog.js';
import { makePanelResizable } from './panelResize.js';
import { DelayedOperationProgress, type OperationHandle } from './operationProgress.js';
import { DesignWorkspace } from './designWorkspace.js';
import { persistSessionDeck } from './sessionPersistence.js';
import { createThemePanel } from './themePanel.js';
import {
  barButton,
  createTextInsertPicker,
  bindEditorKeys,
  createClipboardActions,
  makeContextActions,
  wireCanvasInspector,
  type ShellDeps,
} from './shellWiring.js';
import { SlideRail } from './slideRail.js';
import { createHistoryButton, createMediaButton, popoverPanelHost } from './toolbarPanels.js';
import { installWindowApiPosterProvider } from '../player/previewPosterProvider.js';
import { EditorStore } from './store.js';
import { statusBarText } from './statusBar.js';
import { BuildPreview } from './buildPreview.js';
import { TimelinePanel } from './timelinePanel.js';
import { WelcomeScreen } from './welcomeScreen.js';
import { showConfirmDialog } from './confirmDialog.js';
import { CollabBridge } from '../collab/collabBridge.js';
import { PresenceOverlay } from '../collab/presenceOverlay.js';
import { openEndCollaborationPopover } from '../collab/endCollaborationPopover.js';
import { setRenderInvariantChecks } from './renderInvariants.js';
import { setSelectionInvariantChecks } from './selectionInvariants.js';
import { SpeakerNotesDrawer } from './speakerNotesDrawer.js';
import { CanvasRulers, isRulersShortcut, toggleRulers } from './rulers.js';
import { LightTable } from './lightTable.js';
import { applySpeakerNotes } from '@shared/speakerNotes.js';
import { installResponsiveToolbar } from './responsiveToolbar.js';
import { setSlideColorSource } from './colorPicker.js';
import { slideColors } from '@shared/slideColors.js';
import type { RemoteDeckBinding } from '@shared/ipc.js';
import { showOpenDialog, type OpenChoice } from './openDialog.js';
import { reconcileOffline } from './remoteSync.js';

applyUiTheme();
applyUiScale();

/**
 * Editor shell: wires the panels to one store, owns the toolbar, the keyboard
 * map and autosave.
 */

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

// macOS hides the title bar into the toolbar (titleBarStyle: hiddenInset), so
// the toolbar's left end has to clear the traffic lights. No other window does.
if (navigator.userAgent.includes('Macintosh')) document.body.classList.add('mac-titlebar');

const store = new EditorStore(emptyDeck());
// The colour picker offers the colours already on the slide being edited.
setSlideColorSource(() => slideColors(store.slide));
// Rail and Morph thumbnails take their poster frames from the main process, so
// this window never opens a video pipeline for a preview (see posterCache.ts).
installWindowApiPosterProvider();
let historySaveTimer: ReturnType<typeof setTimeout> | null = null;
let historyDirty = false;

async function flushHistory(dir = store.get().dir): Promise<void> {
  if (historySaveTimer) {
    clearTimeout(historySaveTimer);
    historySaveTimer = null;
  }
  if (!dir || !historyDirty) return;
  const history = store.persistedHistory();
  historyDirty = false;
  try {
    await window.api.saveDeckHistory(dir, history);
  } catch (error) {
    historyDirty = true;
    throw error;
  }
}

function scheduleHistorySave(dir = store.get().dir): void {
  if (!dir || !historyDirty) return;
  if (historySaveTimer) clearTimeout(historySaveTimer);
  // History is a crash-recovery sidecar, not part of the visual feedback for
  // a formatting click. Flush once after a burst instead of cloning and
  // sending every accumulated deck snapshot synchronously on every edit.
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    void flushHistory(dir).catch((error) => {
      console.error('Could not save edit history:', error);
    });
  }, 1_200);
}

store.onHistoryChange = () => {
  historyDirty = true;
  scheduleHistorySave();
};
const initialView = decodeEditorView(new URLSearchParams(location.search).get('view'));
let initialViewPending = initialView !== null;
// Development builds verify after every in-place patch that the canvas DOM
// still matches a fresh render of the deck, and report any property the two
// paths disagree about. See renderInvariants.ts. The test builds turn it on
// too (VITE_RENDER_INVARIANTS), so the fuzz walks fail on what it reports.
setRenderInvariantChecks(import.meta.env.DEV || import.meta.env.VITE_RENDER_INVARIANTS === '1');
setSelectionInvariantChecks(import.meta.env.DEV);
const canvas = new EditorCanvas(el('canvas'), store);
el('canvas').addEventListener(CANVAS_NOTICE_EVENT, (event) => {
  setStatusMessage((event as CustomEvent<string>).detail);
});
// A presentation window occludes this one, and a hidden page's media buffers
// are Chromium's to reclaim -- closing Present used to leave canvas, rail and
// Morph previews black until something happened to touch them.
trackPreviewFrameRecovery(el('canvas'), document.body);
new SpeakerNotesDrawer(el('canvas'), store, {
  // Flush the note being typed so the file that opens already has it.
  openFile: async () => {
    await save();
    return window.api.openSpeakerNotes();
  },
  onInsetChange: (px) => canvas.setBottomInset(px),
  onStatus: setStatusMessage,
});
new CanvasRulers(el('canvas'), canvas, store, { shortcutHint: 'Cmd/Ctrl+R' });
new LightTable(el('canvas'), canvas, store);
// Cmd/Ctrl+R shows and hides the rulers, as in Keynote, wherever focus is --
// in the capture phase, because a text box being edited keeps its keys to
// itself. Taking it also keeps Electron's default menu from reloading the
// window on it; Cmd/Ctrl+Shift+R still force-reloads.
window.addEventListener('keydown', (event) => {
  if (!isRulersShortcut(event)) return;
  event.preventDefault();
  if (!event.repeat) toggleRulers();
}, true);
const inspector = new Inspector(el('inspector'), store);
new TimelinePanel(el('timeline'), store, new BuildPreview(canvas, store));
// History is the deck's past, not the selection's: it opens from the deck
// name in the toolbar rather than from a sidebar tab.
const historyHost = popoverPanelHost('history');
new HistoryPanel(historyHost, store);
// The deck's media library opens from Media on the Insert bar: reusing a file
// is inserting it, so it sits with Text, Shape and Table rather than in a tab.
const mediaHost = popoverPanelHost('media');
const mediaPanel = new MediaPanel(mediaHost, store, {
  setStatusMessage,
  beginOperation: (message) => operationProgress.begin(message),
});
installMediaDrop(el('canvas'), store, mediaPanel);
const rail = new SlideRail(el('rail'), store);
rail.onStatus = setStatusMessage;
// The slide's objects, from a floating icon in the canvas's top-left corner,
// as the speaker notes open from the bottom-left one: a drawer over the canvas
// rather than a column of its own.
const objectsDrawer = document.createElement('div');
objectsDrawer.id = 'objects';
objectsDrawer.className = 'objects-drawer';
const objectList = new ObjectList(objectsDrawer, store);
objectList.toggle.classList.add('objects-toggle');
el('canvas').append(objectList.toggle, objectsDrawer);
const editorBody = el('body');
const railDivider = document.createElement('div');
railDivider.className = 'panel-resize-divider panel-resize-rail';
const sideDivider = document.createElement('div');
sideDivider.className = 'panel-resize-divider panel-resize-side';
editorBody.append(railDivider, sideDivider);
makePanelResizable(railDivider, {
  storageKey: 'deckwerk.editor.rail-size',
  sizeTarget: editorBody,
  width: {
    property: '--rail-width',
    initial: 220,
    min: 150,
    max: () => Math.min(420, window.innerWidth - 560),
    edge: 'right',
  },
});
makePanelResizable(sideDivider, {
  storageKey: 'deckwerk.editor.sidebar-size',
  sizeTarget: editorBody,
  width: {
    property: '--sidebar-width',
    initial: 320,
    min: 240,
    max: () => Math.min(560, window.innerWidth - 500),
    edge: 'left',
  },
});
let agentSessionBridge: CollabBridge | null = null;
let agentSessionReady = false;
let agentSessionWsUrl: string | null = null;
let agentPresence: PresenceOverlay | null = null;
let activeSessionMode: 'agent' | 'collaboration' | 'remote' | null = null;
/** The server deck this window's folder mirrors, while one is open (remoteDecks.ts). */
let remoteBinding: RemoteDeckBinding | null = null;
let remoteChip: HTMLButtonElement | null = null;
let remoteConnected = false;
let remoteProblem: string | null = null;
let collaborateButton: HTMLButtonElement | null = null;
const persistThemeCss = (css: string): Promise<void> | void => {
  if (agentSessionReady && agentSessionBridge) {
    agentSessionBridge.sendTheme(css);
    // A server deck's mirror keeps its own theme.css too: it is what opens
    // offline, and the base of the next merge.
    if (!remoteBinding) return;
  }
  return window.api.saveTheme(css);
};
const cssEditor = new CssEditor(el('theme'), persistThemeCss);
// A theme.css change moves what the inspector reports as the theme value for
// font family, size, weight and paragraph spacing — those readouts are computed
// styles, so they go stale the moment the stylesheet does.
cssEditor.onChange = () => {
  canvas.refitAutoText();
  inspector.noteThemeChanged();
};
let mainSessionPersistence: Promise<void> = Promise.resolve();
function queueMainSessionPersistence(
  dir: string,
  deck: Deck,
  themeCss: string,
  collaborationOwnsDisk: boolean,
): Promise<void> {
  const next = mainSessionPersistence
    .catch(() => {})
    .then(() => persistSessionDeck(
      window.api,
      dir,
      deck,
      themeCss,
      collaborationOwnsDisk,
    ));
  mainSessionPersistence = next;
  return next;
}

function syncMainSessionSnapshot(): Promise<void> {
  const { dir, deck } = store.get();
  // Nothing is open on the welcome screen, so there is nothing to mirror.
  if (!dir) return Promise.resolve();
  return queueMainSessionPersistence(dir, deck, cssEditor.getValue(), true);
}

function queueAgentSessionSnapshot(): void {
  void syncMainSessionSnapshot().catch((error) => {
    console.error('Could not synchronize Agent deck for presentation:', error);
  });
}
const welcome = new WelcomeScreen(el('canvas'), {
  newPresentation,
  openPresentation: () => openPresentation(),
  openFromServer: async () => {
    const servers = await window.api.remoteServers().catch(() => []);
    await openPresentation(servers.length > 0 ? {} : { start: 'connect' });
  },
  importKeynote: importKeynotePresentation,
  importPowerPoint: importPowerPointPresentation,
  openTutorial: () => openTutorial(),
});
const agentPanel = new AgentPanel({
  currentDeckPath: () => store.get().dir,
  connectCommand: 'Open a presentation first',
  mode: 'local',
});

/**
 * Remember which element asked for a trim: the trim window reports back only
 * the new file, and this is what relinks it to the right element.
 */
let pendingTrimElementId: string | null = null;

const openRaster = (element: Extract<SlideElement, { type: 'image' }>) => {
  void window.api.openRaster({ src: element.src, elementId: element.id });
};
// The ffmpeg trim window (src/renderer/trim) is retired: nothing opens it, so
// neither the inspector nor the right-click menu offers "Edit w/ ffmpeg…".
wireCanvasInspector(canvas, inspector, undefined, openRaster);

/**
 * The agent's window into this editor: it publishes the computed selection to
 * the runtime sidecar and applies inbound transactions here, in the live
 * document, so each one becomes a single named undo entry rather than a file
 * that lands underneath the user.
 */
const agent = new AgentBridge(store, {
  publish: (context) => window.api.publishAgentContext(context),
  respond: (response) => window.api.respondAgentRequest(response),
  save,
  resolveSrc: (src) => window.api.assetUrl(src),
  syncHtml: (edit) => applyHtmlEdit({ path: edit.path, contents: edit.contents }, { after: edit.after, label: edit.label }),
});
window.api.onAgentRequest?.((request) => void agent.handle(request));

/**
 * Saving a file in the deck's `edit/` folder is the agent's everyday edit.
 *
 * It is compiled here rather than in a spawned browser: this window already is
 * one, it holds the live deck, and applying the result in place is what makes
 * the change a single labelled undo entry instead of a file landing underneath
 * the user. The theme comes from the editor rather than from disk, so slides
 * are measured against the typography currently on screen.
 */
window.api.onHtmlEdit?.((file) => void applyHtmlEdit(file, { watched: true }).catch(() => undefined));
// notes.md saved outside the editor: the file is the whole set of notes, so
// apply it to every slide as one undoable edit. The autosave that follows
// rewrites deck.json and the file itself in normalised form.
window.api.onSpeakerNotesEdit?.((contents) => {
  const { deck, changed, dropped } = applySpeakerNotes(store.get().deck, contents);
  const ignored = dropped > 0
    ? ` — ${dropped} section${dropped === 1 ? '' : 's'} beyond the last slide ignored`
    : '';
  if (!changed) {
    if (dropped > 0) setStatusMessage(`notes.md changes nothing${ignored}`);
    return;
  }
  store.replaceWithHistory(deck, 'Edit speaker notes in notes.md');
  setStatusMessage(`Applied notes.md${ignored}`);
});

let htmlEditQueue: Promise<unknown> = Promise.resolve();

/**
 * The last document compiled for each authoring file, and what it did. A
 * watched save and an explicit `apply` of the same file arrive as two
 * requests for one document; compiling it twice inserted its new sections
 * twice. The second request for identical contents gets the first's answer.
 */
const lastHtmlSync = new Map<string, { contents: string; outcome: HtmlSyncOutcome }>();

/**
 * New slides a watched save added at the end, per file, with the page as it
 * was saved and as it was stamped: no `apply --after` has said where they go
 * yet. An agent writes the page with one tool and runs apply with the next,
 * so the watcher has nearly always synced the save by the time apply asks.
 */
const unplacedHtml = new Map<string, { contents: Set<string>; ids: string[]; outcome: HtmlSyncOutcome }>();

function applyHtmlEdit(
  file: AuthoredHtmlFile,
  options: { after?: string | null; label?: string; watched?: boolean } = {},
): Promise<HtmlSyncOutcome> {
  // Serialised: two saves in flight would compile against the same deck and
  // the second would apply operations built from a deck that no longer exists.
  const run = htmlEditQueue.then(async (): Promise<HtmlSyncOutcome> => {
    const name = fileName(file.path);
    const unplaced = unplacedHtml.get(file.path);
    if (unplaced && options.after !== undefined && unplaced.contents.has(file.contents)) {
      const outcome = await placeSyncedSlides(name, unplaced, options.after);
      unplacedHtml.delete(file.path);
      return outcome;
    }
    const previous = lastHtmlSync.get(file.path);
    if (previous && previous.contents === file.contents) return previous.outcome;
    /** The page as stamped with the ids this sync assigned, if it was. */
    let stampedContents: string | null = null;
    try {
      const outcome = await runOperation(`Compiling ${name}…`, async (operation): Promise<HtmlSyncOutcome> => {
        // Compiling takes a moment, and the user may edit during it. The
        // operations address slides by id in a deck that has since been replaced,
        // so compile again rather than apply them to a document that moved.
        for (let attempt = 0; attempt < 3; attempt++) {
          operation.update(`Laying out slides from ${name}`);
          const deck = store.get().deck;
          const { transaction, slides, warnings } = await authoredHtmlSync(
            deck,
            file,
            cssEditor.getValue(),
            options,
          );
          if (store.get().deck !== deck) continue;
          // Inline style the browser's parser dropped, or maths a `<` cut
          // short, would otherwise vanish silently: the page measured without
          // it, yet the apply reads as clean.
          const warned = warnings.length === 0 ? ''
            : ` — ${warnings.length} warning${warnings.length === 1 ? '' : 's'}: ${warnings[0]}`;
          const summarise = (message: string, operations: typeof transaction extends null ? never : NonNullable<typeof transaction>['operations'] | []): HtmlSyncOutcome => ({
            stamp: pageStampOf(slides),
            changes: htmlSyncSummary(operations),
            slides: slides.map((slide) => ({
              id: slide.id,
              elements: slide.elements.map((element) => ({
                id: element.id, type: element.type,
                box: { x: element.x, y: element.y, w: element.w, h: element.h },
              })),
            })),
            warnings,
            message,
          });
          if (!transaction) return summarise(`${name} asks for no change${warned}`, []);
          operation.update(`Applying slides from ${name}`);
          store.replaceWithHistory(applyAgentTransaction(deck, transaction), transaction.label);
          await save();
          // Stamp the ids this compile assigned back into the file, so saving it
          // again replaces these slides rather than inserting them a second time
          // — and what the page now says, which its next save is compared with.
          const stampedPage = stampPage(adoptAuthoredIds(file.contents, slides) ?? file.contents, pageStampOf(slides));
          const adopted = stampedPage === file.contents ? null : stampedPage;
          if (adopted) {
            stampedContents = adopted;
            operation.update(`Writing assigned slide ids to ${name}`);
            // Main only writes inside edit/; a file elsewhere (an agent's
            // drafts/ page applied through the CLI) is stamped by the CLI from
            // the ids in this outcome. Failing here would report an error for
            // a change that already landed, and the retry would insert again.
            await window.api.htmlAdopt?.(file.path, adopted, file.contents).catch(() => undefined);
            // The stamped document is what the file now holds; a save of it
            // (the watcher echo, or the agent re-saving unchanged) is the same
            // request again.
            const stamped = summarise('', transaction.operations);
            lastHtmlSync.set(file.path, { contents: adopted, outcome: stamped });
          }
          // What the save did, not merely that it did something: a file that
          // was meant to add a slide and instead replaced or deleted one reads
          // exactly like a success otherwise.
          const did = describeHtmlSync(htmlSyncSummary(transaction.operations));
          return summarise(`Applied ${name} — ${did}${warned}`, transaction.operations);
        }
        throw new Error(`${name}: the deck kept changing while it compiled — save it again`);
      });
      lastHtmlSync.set(file.path, { contents: file.contents, outcome });
      const { inserted, replaced, deleted, moved } = outcome.changes;
      if (options.watched && inserted.length > 0 && replaced.length === 0 && deleted.length === 0) {
        unplacedHtml.set(file.path, { contents: new Set([file.contents, stampedContents ?? file.contents]), ids: inserted, outcome });
      } else if (inserted.length + replaced.length + deleted.length + moved > 0) {
        // The page was saved again with changes: those slides are its own now.
        unplacedHtml.delete(file.path);
      }
      setStatusMessage(outcome.message);
      return outcome;
    } catch (err) {
      setStatusMessage(`${name}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  });
  // The queue itself never rejects, or one bad file would wedge every later save.
  htmlEditQueue = run.catch(() => undefined);
  return run;
}

/**
 * Move the slides a watched save added at the end to where an apply that came
 * after it says they go — where the apply would have put them had it come
 * first. `after` is a slide id, or null for "first".
 */
async function placeSyncedSlides(
  name: string,
  unplaced: { ids: string[]; outcome: HtmlSyncOutcome },
  after: string | null,
): Promise<HtmlSyncOutcome> {
  const deck = store.get().deck;
  const ids = unplaced.ids.filter((id) => deck.slides.some((slide) => slide.id === id));
  if (after !== null && (ids.includes(after) || !deck.slides.some((slide) => slide.id === after))) {
    throw new Error(`${name} was already saved and its slides added at the end; there is no slide ${after} to put them after`);
  }
  const order = deck.slides.map((slide) => slide.id).filter((id) => !ids.includes(id));
  const at = after === null ? 0 : order.indexOf(after) + 1;
  order.splice(at, 0, ...ids);
  if (ids.length > 0 && order.join() !== deck.slides.map((slide) => slide.id).join()) {
    const operations: AgentOperation[] = ids.map((id, index) => ({
      op: 'moveSlide', slideId: id, afterSlideId: index === 0 ? after : ids[index - 1],
    }));
    const label = `Place ${ids.length === 1 ? 'the new slide' : 'the new slides'} from ${name}`;
    store.replaceWithHistory(applyAgentOperations(deck, operations), label);
    await save();
    setStatusMessage(`${label} after ${after ?? 'the start'}`);
  }
  return unplaced.outcome;
}

/* --- toolbar --- */


let deckNameLabel: HTMLElement | null = null;
let resetTutorialButton: HTMLButtonElement | null = null;
/** The person's tutorial folder; null until known, or when none ships. */
let tutorialDir: string | null = null;
void window.api.tutorialInfo().then((info) => {
  tutorialDir = info.available ? info.dir.replace(/[\\/]+$/, '') : null;
  syncDeckNameLabel();
}, (error: unknown) => console.error('Could not locate the tutorial:', error));

function isTutorialOpen(): boolean {
  const { dir } = store.get();
  return tutorialDir !== null && dir !== null && dir.replace(/[\\/]+$/, '') === tutorialDir;
}

function barDivider(): HTMLElement {
  const divider = document.createElement('span');
  divider.className = 'bar-divider';
  divider.setAttribute('aria-hidden', 'true');
  return divider;
}

/** The open deck's name beside the logo: its folder name, or its title. */
function syncDeckNameLabel(): void {
  if (!deckNameLabel) return;
  const { deck, dir } = store.get();
  const folder = dir ? dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '' : '';
  const name = folder || deck.title || '';
  deckNameLabel.textContent = name;
  deckNameLabel.hidden = name === '';
  deckNameLabel.title = dir ?? '';
  if (resetTutorialButton) resetTutorialButton.hidden = !isTutorialOpen();
}

function buildToolbar(): void {
  const bar = el('toolbar');
  bar.replaceChildren();

  const left = document.createElement('div');
  left.className = 'bar-group';
  deckNameLabel = document.createElement('span');
  deckNameLabel.className = 'bar-deck-name';
  const fileActions = document.createElement('span');
  fileActions.className = 'toolbar-expanded-file-actions';
  const importEntries = [
    { label: 'Keynote…', action: () => void importKeynotePresentation() },
    { label: 'PowerPoint…', action: () => void importPowerPointPresentation() },
  ];
  const saveEntries = [
    { label: 'Deck…', action: () => void saveAsPresentation() },
    {
      label: 'Lossy export',
      options: [
        { label: 'PDF…', action: () => void exportPdf() },
        { label: 'Web…', action: () => void exportWeb() },
      ],
    },
  ];
  fileActions.append(
    barButton('New', newPresentation),
    createToolbarSplitButton('Open', () => void openPresentation(), [
      { label: 'Open Folder…', action: () => void openLocalPresentation() },
      { label: 'Connect to Server…', action: () => void openPresentation({ start: 'connect' }) },
      { label: 'Tutorial', action: () => void openTutorial() },
    ], { menuLabel: 'Open options' }),
    createToolbarPicker('Import…', importEntries),
    createToolbarPicker('Save As…', saveEntries, { deckOnly: true }),
  );
  const compactFile = createToolbarPicker('File', [
    {
      label: 'Presentation',
      options: [
        { label: 'New', action: newPresentation },
        { label: 'Open…', action: () => void openPresentation() },
        { label: 'Connect to Server…', action: () => void openPresentation({ start: 'connect' }) },
        { label: 'Tutorial', action: () => void openTutorial() },
      ],
    },
    { label: 'Import', options: importEntries },
    {
      label: 'Save and export',
      options: [
        { label: 'Save As…', action: () => void saveAsPresentation() },
        { label: 'Export PDF…', action: () => void exportPdf() },
        { label: 'Export Web…', action: () => void exportWeb() },
      ],
    },
  ], { deckOnly: true });
  compactFile.classList.add('toolbar-compact-file-action');
  remoteChip = document.createElement('button');
  remoteChip.type = 'button';
  remoteChip.className = 'remote-status';
  remoteChip.hidden = true;
  remoteChip.addEventListener('click', () => {
    if (!remoteConnected) agentSessionBridge?.reconnectNow();
  });
  resetTutorialButton = barButton('Reset tutorial', () => void resetTutorial());
  resetTutorialButton.title = 'Put back the tutorial as DeckWerk ships it (undoable)';
  resetTutorialButton.hidden = true;
  left.append(
    createDeckWerkButton({
      askAgentPrompt: () => window.api.tutorialPrompt(),
      onStatus: setStatusMessage,
    }),
    deckNameLabel,
    resetTutorialButton,
    remoteChip,
    createHistoryButton(historyHost),
    barDivider(),
    fileActions,
    compactFile,
  );

  const mid = document.createElement('div');
  mid.className = 'bar-group deck-only bar-center';
  mid.append(
    createTextInsertPicker({
      textBox: () => addText(),
      // A starter listing, selected, so typing replaces it.
      codeBlock: () => { canvas.beginCodeEdit(insertCode(store).id, 'all'); },
    }),
    createShapeInsertPicker(store),
    createPenButton(canvas),
    createTableInsertPicker(store),
    createMediaButton(mediaHost),
  );

  const right = document.createElement('div');
  right.className = 'bar-group bar-right deck-only';
  collaborateButton = barButton('Collaborate', () => void startSharing());
  collaborateButton.id = 'collaborate-trigger';
  const secondaryActions = document.createElement('span');
  secondaryActions.className = 'toolbar-expanded-secondary-actions';
  secondaryActions.append(
    barButton('Agent…', () => void toggleAgentPanel()),
    collaborateButton,
  );
  const compactSecondary = createToolbarPicker('More', [
    { label: 'Agent…', action: () => void toggleAgentPanel() },
    { label: 'Collaboration…', action: () => void startSharing() },
  ]);
  compactSecondary.classList.add('toolbar-compact-secondary-action');
  right.append(
    secondaryActions,
    compactSecondary,
    createToolbarSplitButton(
      'Present',
      () => void startPresentation(),
      [{ label: 'Present in Speaker View', action: () => void startPresentation(true) }],
      { variant: 'primary', menuLabel: 'Presentation options' },
    ),
  );

  bar.append(left, mid, right);
  syncDeckNameLabel();
  installResponsiveToolbar(bar);
}

async function startPresentation(speakerView = false): Promise<void> {
  await runOperation('Preparing presentation…', async (operation) => {
    // Presentation reads the main process's in-memory session. When the deck
    // is dirty, mirror that state directly rather than making window creation
    // wait for deck.json plus a potentially very large compressed edit-history
    // sidecar. Ordinary autosave resumes after the windows have been opened.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const historyWasPending = historySaveTimer !== null;
    if (historySaveTimer) {
      clearTimeout(historySaveTimer);
      historySaveTimer = null;
    }
    try {
      operation.update('Synchronizing presentation');
      await cssEditor.flush();
      if (agentSessionReady || store.get().dirty) await syncMainSessionSnapshot();
      const { deck, slideIndex, slideSelection } = store.get();
      const range = rangeForSlideSelection(deck.slides, slideSelection);
      operation.update('Opening presentation windows');
      await window.api.present(range?.start ?? slideIndex, {
        speakerView,
        endSlideIndex: range?.end,
      });
    } finally {
      if (store.get().dirty) scheduleSave();
      else if (historyWasPending) scheduleHistorySave();
    }
  });
}

async function exportWeb(): Promise<void> {
  const choice = await showWebExportDialog();
  if (!choice) return;
  try {
    const dir = await runOperation('Preparing web export…', async (operation) => {
      operation.update('Saving deck.json and theme.css');
      await cssEditor.flush();
      await save();
      operation.update('Waiting for an export folder');
      return window.api.exportBundle({ quality: choice.quality }, operation.id);
    });
    if (dir) setStatusMessage(`Exported to ${dir}`);
  } catch (err) {
    setStatusMessage(`Export failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function exportPdf(): Promise<void> {
  const choice = await showPdfExportDialog();
  if (!choice) return;
  try {
    const result = await runOperation('Preparing PDF export…', async (operation) => {
      operation.update('Saving deck.json and theme.css');
      await cssEditor.flush();
      await save();
      operation.update('Waiting for a PDF destination');
      return window.api.exportPdf({
        mode: choice.includeEachBuildStage ? 'every' : 'final',
      }, operation.id);
    });
    if (result) setStatusMessage(`PDF saved to ${result}`);
  } catch (err) {
    setStatusMessage(`PDF export failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** "Download original…": the dropped file, copied wherever the author picks. */
async function saveOriginalAsset(src: string): Promise<void> {
  try {
    const saved = await runOperation('Preparing download…', async (operation) => {
      operation.update('Waiting for a destination');
      return window.api.saveOriginalAsset(src, operation.id);
    });
    if (saved) setStatusMessage(`Saved the original to ${saved}`);
  } catch (err) {
    setStatusMessage(`Download failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function toggleAgentPanel(): Promise<void> {
  if (!agentPanel.element.hidden) {
    agentPanel.hide();
    return;
  }
  setStatusMessage('Preparing the deck folder for an agent…');
  try {
    await cssEditor.flush();
    await save();
    const dir = store.get().dir;
    if (!dir) throw new Error('Open a presentation first');
    agentPanel.setConnectCommand(dir);
    agentPanel.show();
    setStatusMessage('Deck folder ready for a filesystem agent.');
  } catch (err) {
    setStatusMessage(`Could not prepare the agent handoff: ${err instanceof Error ? err.message : err}`);
  }
}

async function startSharing(): Promise<void> {
  try {
    if (activeSessionMode === 'collaboration') {
      openEndCollaborationPopover(collaborateButton!, () => {
        void runOperation('Ending collaboration…', async (operation) => {
          operation.update('Saving final collaborative changes');
          await window.api.endAgentSession();
        }).then(() => {
          setStatusMessage('Collaboration ended; presentation saved.');
        }).catch((err) => {
          setStatusMessage(`Could not end collaboration: ${err instanceof Error ? err.message : err}`);
        });
      });
      return;
    }
    await runOperation('Starting collaboration…', async (operation) => {
      operation.update('Saving presentation');
      await cssEditor.flush();
      await save();
      operation.update('Starting collaboration server');
      const connection = await window.api.startCollab({
        agent: false,
        ...captureEditorView(store),
      });
      connectAgentSession(connection);
    });
    setStatusMessage('Collaboration link copied to clipboard.');
  } catch (err) {
    setStatusMessage(`Collaboration failed: ${err instanceof Error ? err.message : err}`);
  }
}

let lastAgentPresenceKey = '';
let pendingCollaborationCursor: { x: number; y: number } | null | undefined;
let lastCollaborationCursorSent = 0;
let lastCollaborationCursorKey = '';
let collaborationCursorFrame = 0;
let collaborationCursorTimer = 0;

const flushCollaborationCursor = () => {
  collaborationCursorFrame = 0;
  if (!agentSessionReady || !agentSessionBridge) return;
  const now = performance.now();
  const remaining = 33 - (now - lastCollaborationCursorSent);
  if (remaining > 0) {
    collaborationCursorTimer = window.setTimeout(() => {
      collaborationCursorTimer = 0;
      collaborationCursorFrame = requestAnimationFrame(flushCollaborationCursor);
    }, remaining);
    return;
  }
  const slide = store.slide;
  const cursor = pendingCollaborationCursor && slide
    ? {
      slideId: slide.id,
      x: Math.round(pendingCollaborationCursor.x),
      y: Math.round(pendingCollaborationCursor.y),
    }
    : null;
  const key = JSON.stringify(cursor);
  if (key === lastCollaborationCursorKey) return;
  lastCollaborationCursorKey = key;
  lastCollaborationCursorSent = now;
  agentSessionBridge.sendCursor(cursor);
};

canvas.onPointerSample = (point) => {
  if (!agentSessionReady || !agentSessionBridge) return;
  pendingCollaborationCursor = point;
  if (collaborationCursorFrame || collaborationCursorTimer) return;
  collaborationCursorFrame = requestAnimationFrame(flushCollaborationCursor);
};

const clearCollaborationCursor = () => {
  pendingCollaborationCursor = null;
  if (collaborationCursorFrame) cancelAnimationFrame(collaborationCursorFrame);
  if (collaborationCursorTimer) clearTimeout(collaborationCursorTimer);
  collaborationCursorFrame = 0;
  collaborationCursorTimer = 0;
  lastCollaborationCursorKey = 'null';
  agentSessionBridge?.sendCursor(null);
};
el('canvas').addEventListener('pointerleave', clearCollaborationCursor);
el('canvas').addEventListener('mouseleave', clearCollaborationCursor);

function refreshCollaborationControl(): void {
  if (!collaborateButton) return;
  // A server deck is already shared: everyone on the server edits it.
  collaborateButton.hidden = activeSessionMode === 'remote';
  const sharing = activeSessionMode === 'collaboration';
  collaborateButton.textContent = sharing ? 'End collaboration' : 'Collaborate';
  collaborateButton.classList.toggle('danger', sharing);
}

function publishAgentPresence(): void {
  if (!agentSessionReady || !agentSessionBridge) return;
  const { deck, slideIndex, slideSelection, selection } = store.get();
  const state = {
    activeSlideId: deck.slides[slideIndex]?.id ?? null,
    selectedSlideIds: [...slideSelection],
    selectedElementIds: [...selection],
    editingElementId: canvas.editingElementId(),
  };
  const key = JSON.stringify(state);
  if (key === lastAgentPresenceKey) return;
  lastAgentPresenceKey = key;
  agentSessionBridge.sendPresence(state);
}

/** Join the background HTTP session as an ordinary collaboration peer. */
function connectAgentSession(connection: AgentSessionConnection): void {
  if (agentSessionWsUrl === connection.wsUrl && agentSessionBridge) return;
  disconnectAgentSession();
  activeSessionMode = connection.mode ?? 'agent';
  refreshCollaborationControl();
  agentSessionWsUrl = connection.wsUrl;
  agentPresence = new PresenceOverlay(canvas, store);
  rail.presenceForSlide = (slideId) => agentPresence?.peersOnSlide(slideId) ?? [];

  const bridge = new CollabBridge(connection.wsUrl, connection.name, {
    onWelcome: (welcome) => {
      if (agentSessionBridge !== bridge) return;
      setIdSuffix(welcome.clientId.slice(0, 4));
      agentSessionReady = true;
      if (JSON.stringify(store.get().deck) !== JSON.stringify(welcome.deck)) {
        store.applyRemote(welcome.deck, 'Agent session synchronized', { coalesce: false });
      }
      store.markClean();
      store.onLocalEdit = bridge.localEdit;
      cssEditor.setValue(welcome.themeCss);
      themePanel.noteDeckOpened(welcome.deck);
      for (const peer of welcome.peers) agentPresence?.upsert(peer);
      rail.refreshPresence();
      lastAgentPresenceKey = '';
      lastCollaborationCursorKey = '';
      publishAgentPresence();
      queueAgentSessionSnapshot();
      setStatusMessage(activeSessionMode === 'collaboration'
        ? 'Collaboration connected — edits and cursors sync live.'
        : 'Filesystem agent connected — edits sync live.');
    },
    onDeckReplaced: (deck, label, options) => {
      store.applyRemote(deck, label, options);
      queueAgentSessionSnapshot();
    },
    onPeerPresence: (state) => {
      agentPresence?.upsert(state);
      rail.refreshPresence();
    },
    onPeerCursor: (clientId, cursor) => agentPresence?.moveCursor(clientId, cursor),
    onPeerLeft: (clientId) => {
      agentPresence?.remove(clientId);
      rail.refreshPresence();
    },
    onThemeCss: (css) => {
      if (!cssEditor.hasFocus() && css !== cssEditor.getValue()) cssEditor.setValue(css);
      queueAgentSessionSnapshot();
    },
    onStatus: (text) => setStatusMessage(
      `${activeSessionMode === 'collaboration' ? 'Collaboration' : 'Agent session'}: ${text}`,
    ),
    onCleanChange: (clean) => {
      if (clean) store.markClean();
    },
    onEnded: () => {
      if (agentSessionBridge === bridge) {
        const endedMode = activeSessionMode;
        disconnectAgentSession();
        setStatusMessage(endedMode === 'collaboration'
          ? 'Collaboration ended.'
          : 'Agent session ended.');
      }
    },
  });
  agentSessionBridge = bridge;
  bridge.connect();
}

function disconnectAgentSession(): void {
  const bridge = agentSessionBridge;
  agentSessionBridge = null;
  agentSessionReady = false;
  agentSessionWsUrl = null;
  activeSessionMode = null;
  refreshCollaborationControl();
  pendingCollaborationCursor = undefined;
  if (collaborationCursorFrame) cancelAnimationFrame(collaborationCursorFrame);
  if (collaborationCursorTimer) clearTimeout(collaborationCursorTimer);
  collaborationCursorFrame = 0;
  collaborationCursorTimer = 0;
  lastCollaborationCursorKey = '';
  lastAgentPresenceKey = '';
  if (store.onLocalEdit === bridge?.localEdit) store.onLocalEdit = null;
  bridge?.close();
  agentPresence?.destroy();
  agentPresence = null;
  rail.presenceForSlide = undefined;
  rail.refreshPresence();
  if (remoteBinding) canvas.liveTextSync = false;
  remoteBinding = null;
  remoteConnected = false;
  remoteProblem = null;
  if (remoteSaveTimer) clearTimeout(remoteSaveTimer);
  remoteSaveTimer = null;
  renderRemoteChip();
}

/* --- server decks: a mirror folder kept in sync, editable offline --- */

let remoteSaveTimer: ReturnType<typeof setTimeout> | null = null;
let lastRemoteBaseline: { deck: Deck; themeCss: string; seq: number } | null = null;

/** Written after the deck.json it belongs with, in the same queue. */
function queueRemoteBaseline(dir: string, baseline: { deck: Deck; themeCss: string; seq: number }): Promise<void> {
  if (lastRemoteBaseline && lastRemoteBaseline.deck === baseline.deck
    && lastRemoteBaseline.themeCss === baseline.themeCss && lastRemoteBaseline.seq === baseline.seq) {
    return Promise.resolve();
  }
  const next = mainSessionPersistence
    .catch(() => {})
    .then(() => window.api.saveRemoteBaseline(dir, baseline))
    .then(() => { lastRemoteBaseline = baseline; });
  mainSessionPersistence = next;
  return next;
}

/**
 * A server deck changed under the mirror (a collaborator's edit, a merge):
 * write the mirror and its baseline soon, as an edit here would be. Without
 * it a quit right after would reopen a deck.json older than its baseline,
 * and the next merge would read the difference as edits made here.
 */
function scheduleRemotePersist(): void {
  if (!remoteBinding) return;
  if (remoteSaveTimer) clearTimeout(remoteSaveTimer);
  remoteSaveTimer = setTimeout(() => {
    remoteSaveTimer = null;
    void save({ flushHistory: false }).catch((error) => {
      console.error('Could not save the server deck copy:', error);
    });
  }, 800);
}

function renderRemoteChip(): void {
  if (!remoteChip) return;
  if (!remoteBinding) {
    if (!remoteChip.hidden) remoteChip.hidden = true;
    return;
  }
  const unsent = agentSessionBridge?.unconfirmed ?? 0;
  const server = remoteBinding.serverName;
  let state: 'online' | 'offline' | 'error' | 'syncing';
  let text: string;
  if (remoteProblem) {
    state = 'error';
    text = `${server}: ${remoteProblem}`;
  } else if (agentSessionBridge?.isReconciling) {
    state = 'syncing';
    text = `${server} · merging`;
  } else if (remoteConnected) {
    state = unsent > 0 ? 'syncing' : 'online';
    text = unsent > 0 ? `${server} · syncing` : `${server} · synced`;
  } else {
    state = 'offline';
    // Unsent transactions are not a count anyone thinks in (live typing sends
    // several per word), so say what matters: there is work waiting here.
    text = unsent > 0 ? 'Offline · edits kept on this computer' : 'Offline';
  }
  // Runs on every store emit (renderStatus): touch the DOM only for a change.
  if (remoteChip.hidden) remoteChip.hidden = false;
  if (remoteChip.dataset.state !== state) remoteChip.dataset.state = state;
  if (remoteChip.textContent !== text) remoteChip.textContent = text;
  const title = remoteConnected
    ? `Editing ${remoteBinding.deckId} on ${remoteBinding.server}. Changes sync live.`
    : `${remoteBinding.deckId} on ${remoteBinding.server}. Edits are kept on this computer and sync when the server is reachable — click to retry now.`;
  if (remoteChip.title !== title) remoteChip.title = title;
}

/** Fetch what the server deck refers to that the mirror lacks, and redraw what was missing it. */
async function fetchRemoteAssets(deck: Deck): Promise<void> {
  const binding = remoteBinding;
  if (!binding) return;
  const fetched = await window.api.fetchRemoteAssets(binding.dir, deck).catch(() => [] as string[]);
  if (fetched.length === 0 || remoteBinding !== binding) return;
  canvas.forceRedraw();
  rail.redrawThumbnails();
}

let lastAssetCheck: Deck | null = null;
function noteRemoteDeck(deck: Deck): void {
  scheduleRemotePersist();
  // Cheap to ask; main checks the files. One question per new deck object.
  if (deck === lastAssetCheck) return;
  lastAssetCheck = deck;
  void fetchRemoteAssets(deck);
}

/** After any deck is adopted: if its folder mirrors a server deck, go live. */
async function attachRemoteDeck(dir: string): Promise<void> {
  let binding: RemoteDeckBinding | null = null;
  try {
    binding = await window.api.remoteBinding(dir);
  } catch (error) {
    console.error('Could not read the server deck binding:', error);
  }
  if (store.get().dir !== dir) return;
  if (!binding) {
    if (remoteBinding) disconnectAgentSession();
    return;
  }
  connectRemoteDeck(binding);
}

function connectRemoteDeck(binding: RemoteDeckBinding): void {
  disconnectAgentSession();
  activeSessionMode = 'remote';
  refreshCollaborationControl();
  remoteBinding = binding;
  lastRemoteBaseline = null;
  // Typing streams to collaborators as it happens, and theirs merges into a
  // box being edited here — the browser client's text path.
  canvas.liveTextSync = true;
  agentPresence = new PresenceOverlay(canvas, store);
  rail.presenceForSlide = (slideId) => agentPresence?.peersOnSlide(slideId) ?? [];
  const live = () => agentSessionBridge === bridge;

  const bridge = new CollabBridge(binding.wsUrl ?? 'ws://127.0.0.1:9/unavailable', binding.name, {
    onWelcome: (welcome) => {
      if (!live()) return;
      setIdSuffix(welcome.clientId.slice(0, 4));
      remoteProblem = null;
      if (JSON.stringify(store.get().deck) !== JSON.stringify(welcome.deck)) {
        store.applyRemote(welcome.deck, `Synchronized with ${binding.serverName}`, { coalesce: false });
      }
      if (welcome.themeCss !== cssEditor.getValue()) {
        cssEditor.setValue(welcome.themeCss);
        void window.api.saveTheme(welcome.themeCss);
      }
      themePanel.noteDeckOpened(store.get().deck);
      for (const peer of welcome.peers) agentPresence?.upsert(peer);
      rail.refreshPresence();
      lastAgentPresenceKey = '';
      lastCollaborationCursorKey = '';
      publishAgentPresence();
      queueAgentSessionSnapshot();
      noteRemoteDeck(store.get().deck);
      // Files made here while offline go up; files peers added come down.
      void window.api.syncRemoteFiles(binding.dir)
        .then(() => fetchRemoteAssets(store.get().deck))
        .catch((error) => console.error('Could not sync server deck files:', error));
      renderRemoteChip();
    },
    onDeckReplaced: (deck, label, options) => {
      store.applyRemote(deck, label, options);
      queueAgentSessionSnapshot();
      noteRemoteDeck(deck);
    },
    onPeerPresence: (state) => {
      agentPresence?.upsert(state);
      rail.refreshPresence();
    },
    onPeerCursor: (clientId, cursor) => agentPresence?.moveCursor(clientId, cursor),
    onPeerLeft: (clientId) => {
      agentPresence?.remove(clientId);
      rail.refreshPresence();
    },
    onThemeCss: (css) => {
      if (!cssEditor.hasFocus() && css !== cssEditor.getValue()) cssEditor.setValue(css);
      void window.api.saveTheme(css);
      queueAgentSessionSnapshot();
      scheduleRemotePersist();
    },
    onStatus: () => renderRemoteChip(),
    // The mirror is saved like any deck; the server confirming an edit does
    // not make it clean on disk here.
    onCleanChange: () => renderRemoteChip(),
    onConnectionChange: (connected) => {
      remoteConnected = connected;
      if (!connected) {
        agentPresence?.replaceAll([]);
        rail.refreshPresence();
      }
      renderRemoteChip();
    },
    onAccessRevoked: () => {
      remoteProblem = 'no access';
      renderRemoteChip();
    },
    onUnavailable: (reason) => {
      remoteProblem = reason;
      renderRemoteChip();
    },
    onMoved: (moved) => {
      remoteProblem = `moved to ${moved.deckId}`;
      renderRemoteChip();
    },
  }, {
    local: () => ({ deck: store.get().deck, themeCss: cssEditor.getValue() }),
    reconcile: async (input) => {
      renderRemoteChip();
      store.setEditLock(`Merging your offline changes with ${binding.serverName}…`);
      try {
        const result = await reconcileOffline(input, {
          serverName: binding.serverName,
          prefetch: async (deck) => {
            await window.api.syncRemoteFiles(binding.dir).catch(() => undefined);
            await window.api.fetchRemoteAssets(binding.dir, deck);
          },
        });
        if (result.asked) setStatusMessage(`Merged your offline changes with ${binding.serverName}.`);
        return result;
      } finally {
        store.setEditLock(null);
      }
    },
    onReconciled: ({ sent, themeSent }) => {
      if (!live()) return;
      if (sent > 0 || themeSent) {
        setStatusMessage(`Synced offline changes with ${binding.serverName}.`);
      }
      renderRemoteChip();
    },
  });
  bridge.seed(binding.baseline);
  agentSessionBridge = bridge;
  agentSessionReady = true;
  agentSessionWsUrl = binding.wsUrl;
  store.onLocalEdit = bridge.localEdit;
  if (binding.wsUrl) bridge.connect();
  else remoteProblem = 'server not in your list';
  renderRemoteChip();
}

async function newPresentation(): Promise<void> {
  try {
    await runOperation('Creating presentation…', async (operation) => {
      const session = await window.api.newDeck(operation.id);
      if (session) await adopt(session.dir, session.deck, operation);
    });
  } catch (err) {
    setStatusMessage(`Could not create presentation: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Open: with a deck server known, one dialog covers this computer and the
 * servers; without one, straight to the system folder picker as always.
 */
async function openPresentation(options: { start?: 'connect' } = {}): Promise<void> {
  let choice: OpenChoice | null;
  try {
    const servers = await window.api.remoteServers();
    choice = servers.length === 0 && !options.start ? { kind: 'local' } : await showOpenDialog(window.api, options);
  } catch (err) {
    setStatusMessage(`Open failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (!choice) return;
  if (choice.kind === 'local') return openLocalPresentation();
  const { serverId, deckId, title, offline } = choice;
  try {
    await runOperation(`Opening “${title}”…`, async (operation) => {
      const session = await window.api.openRemoteDeck(serverId, deckId, operation.id, offline ? { offline } : undefined);
      if (session) await adopt(session.dir, session.deck, operation);
    });
  } catch (err) {
    setStatusMessage(`Open failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Open the person's copy of the tutorial, installing or updating it first. */
async function openTutorial(slideId?: string): Promise<void> {
  try {
    await runOperation('Opening the tutorial…', async (operation) => {
      const session = await window.api.openTutorial(operation.id, slideId);
      if (session) await adopt(session.dir, session.deck, operation);
    });
  } catch (err) {
    setStatusMessage(`Could not open the tutorial: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Put back the tutorial as it ships, as one entry in the deck's history: Cmd+Z
 * or History brings back whatever the person or their agent had done to it.
 */
async function resetTutorial(): Promise<void> {
  if (!isTutorialOpen()) return;
  const confirmed = await showConfirmDialog({
    title: 'Reset tutorial',
    description: 'Put back every tutorial slide as DeckWerk ships it? Slides you or your agent added are removed too. Undo, or History, brings everything back.',
    confirmLabel: 'Reset',
  });
  if (!confirmed || !isTutorialOpen()) return;
  try {
    const shipped = await window.api.tutorialShippedDeck();
    if (!isTutorialOpen()) return;
    store.replaceWithHistory(shipped, 'Reset tutorial');
    store.selectSlide(0);
    setStatusMessage('Tutorial reset. Undo brings back what was there.');
  } catch (err) {
    setStatusMessage(`Could not reset the tutorial: ${err instanceof Error ? err.message : err}`);
  }
}

/** Show a slide by id, if the open deck has it. */
function showSlideById(slideId: string): boolean {
  const index = store.get().deck.slides.findIndex((slide) => slide.id === slideId);
  if (index < 0) return false;
  store.selectSlide(index);
  return true;
}

async function openLocalPresentation(): Promise<void> {
  try {
    await runOperation('Opening presentation…', async (operation) => {
      const session = await window.api.openDeck(operation.id);
      if (session) await adopt(session.dir, session.deck, operation);
    });
  } catch (err) {
    setStatusMessage(`Open failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function saveAsPresentation(): Promise<void> {
  try {
    const session = await runOperation('Saving a copy…', async (operation) => {
      operation.update('Saving deck.json and theme.css');
      await cssEditor.flush();
      await save();
      operation.update('Waiting for a destination folder');
      const saved = await window.api.saveDeckAs(operation.id);
      if (saved) await adopt(saved.dir, saved.deck, operation);
      return saved;
    });
    if (!session) return;
    setStatusMessage(`Saved as ${session.dir}`);
  } catch (err) {
    setStatusMessage(`Save As failed: ${err instanceof Error ? err.message : err}`);
  }
}

function importKeynotePresentation(): Promise<void> {
  return importPresentation('Keynote', (operationId) => window.api.importKeynote(operationId));
}

function importPowerPointPresentation(): Promise<void> {
  return importPresentation('PowerPoint', (operationId) => window.api.importPowerPoint(operationId));
}

async function importPresentation(
  kind: string,
  run: (operationId: string) => Promise<PresentationImportResult | null>,
): Promise<void> {
  try {
    const result = await runOperation(`Importing ${kind} presentation…`, async (operation) => {
      const imported = await run(operation.id);
      // A window that already held a presentation keeps it: the imported deck
      // opened in a window of its own. The report still belongs here, in the
      // status bar of the window the author started the import from.
      if (imported && !imported.openedInNewWindow) {
        await adopt(imported.dir, imported.deck, operation);
      }
      return imported;
    });
    if (!result) {
      return;
    }
    const skipped = Object.values(result.report.unsupported).reduce(
      (a, b) => a + b,
      0,
    );
    setStatusMessage(
      `Imported ${result.report.slides} slides, ${result.report.elements} elements` +
        (skipped > 0 ? ` — ${skipped} objects became placeholders` : ''),
    );
  } catch (err) {
    setStatusMessage(`Import failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** The Theme sidebar tab, shared with the browser collab shell. */
const designWorkspace = new DesignWorkspace({
  canvasHost: el('canvas'),
  store,
  save,
  setStatusMessage,
});
const themePanel = createThemePanel({
  store,
  cssEditor,
  save,
  setStatusMessage,
  saveThemeCss: (css) => void persistThemeCss(css),
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
/* --- side panel tabs --- */

const PANELS = [
  { id: 'inspector', label: 'Props' },
  { id: 'themePanel', label: 'Design' },
  { id: 'timeline', label: 'Build' },
] as const;

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

let activePanelId = 'inspector';

function showPanel(id: string): void {
  if (store.get().slideSelection.size > 1 && id !== 'themePanel' && id !== 'inspector') return;
  activePanelId = id;
  for (const panel of PANELS) {
    el(panel.id).hidden = panel.id !== id;
  }
  for (const b of el('side-tabs').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.panel === id);
  }
  if (id === 'inspector') inspector.render();
  if (id === 'themePanel') el('themePanel').scrollTop = 0;
  if (id !== 'themePanel') designWorkspace.hide();
  rail.setDesignLabels(id === 'themePanel');
  canvas.setBuildBadgesVisible(id === 'timeline');
}

/** Multi-slide selection is a deck-level editing context: Theme and Props (Morph) apply. */
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

/* --- element creation --- */

function addText(): void {
  // Straight into the new box, its placeholder selected: typing replaces it.
  canvas.beginTextEdit(insertText(store).id);
}

/* --- persistence --- */

let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function save(opts: { flushHistory?: boolean } = {}): Promise<void> {
  const dir = store.get().dir;
  if (!dir) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const deck = store.get().deck;
  // Taken in the same tick as the deck: the baseline is a server state the
  // deck on screen already contains, so the next merge starts from it.
  const baseline = remoteBinding?.dir === dir ? agentSessionBridge?.baseline() ?? null : null;
  try {
    await queueMainSessionPersistence(dir, deck, cssEditor.getValue(), agentSessionReady && !remoteBinding);
    if (baseline) await queueRemoteBaseline(dir, baseline);
  } catch (error) {
    // Another deck was opened while this write was in flight, and the main
    // process refused it rather than writing these slides into that deck's
    // folder. The document this save belonged to is gone; there is nothing
    // left to report or retry.
    if (store.get().dir === dir) throw error;
    return;
  }
  try {
    // Await the latest snapshot after the deck write. Save As and window close
    // can now rely on history having reached disk rather than racing a fire-
    // and-forget IPC call from the original edit.
    if (opts.flushHistory !== false) await flushHistory(dir);
  } catch (error) {
    console.error('Could not flush edit history:', error);
  }
  // An edit made while this write was in flight belongs to a newer deck
  // object and still needs its own autosave. Never let an older completion
  // mark that newer state clean.
  if (store.get().deck === deck) store.markClean();
}

function scheduleSave(): void {
  if (!store.get().dir || !store.get().dirty) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void save({ flushHistory: false });
  }, 800);
}

let adoptGeneration = 0;

async function adopt(
  dir: string,
  deck: Parameters<typeof store.load>[0],
  operation?: OperationHandle,
): Promise<void> {
  const generation = ++adoptGeneration;
  let history: NonNullable<Parameters<typeof store.load>[2]>['history'];
  try {
    operation?.update(`Reading ${dir.split('/').pop() ?? dir}/deck-history-v2.json.gz`, 0.55);
    const loaded = await window.api.loadDeckHistory(dir);
    if (loaded.dir === dir) history = loaded.history;
  } catch (error) {
    console.error('Could not load edit history:', error);
  }
  // Opening two decks in quick succession must not let the slower first read
  // install snapshots belonging to a document that is no longer current.
  if (generation !== adoptGeneration) return;
  operation?.update('Building slide canvas and thumbnails', 0.7);
  // A large rail rebuild is synchronous. Give an already-visible progress
  // indicator a paint opportunity before Chromium starts constructing it.
  await operation?.waitForPaint();
  themeStylesheetArmed = false;
  store.load(deck, dir, { history });
  historyDirty = false;
  if (initialViewPending) {
    restoreEditorView(store, initialView);
    initialViewPending = false;
  }
  welcome.setVisible(false);
  operation?.update(`Reading ${deck.theme}`, 0.85);
  const loadedCss = await window.api.loadTheme();
  const installedTheme = themeById(deck.themePreset, deckThemes(deck));
  // The marked block belongs to the app. Refresh it when preset definitions
  // evolve, while preserving every hand-written rule outside that block.
  const refreshedCss = deck.themeStyle
    ? withThemeBlock(loadedCss, themeStyleCss(deck.themeStyle))
    : installedTheme
      ? withThemeBlock(loadedCss, themeCss(installedTheme))
    : loadedCss;
  cssEditor.setValue(refreshedCss);
  if (refreshedCss !== loadedCss) void persistThemeCss(refreshedCss);
  // From here on the stylesheet mirrors the deck's composed defaults; until
  // now the editor held the previous deck's CSS and nothing may be derived
  // from it.
  mirroredThemeStyle = JSON.stringify(deck.themeStyle);
  themeStylesheetArmed = true;
  operation?.update('Loading fonts and fitting slide content', 0.95);
  themePanel.noteDeckOpened(deck);
  // Applying the deck stylesheet can start web-font loads, and auto-fit runs
  // again once those metrics are available. Keep opening/importing active
  // through that initial hydration instead of announcing completion while the
  // canvas and rail are still settling.
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts) await fonts.ready;
  operation?.update('Finishing initial display', 0.99);
  await operation?.waitForPaint();
  if (generation === adoptGeneration) await attachRemoteDeck(dir);
  // A tutorial link (deckwerk://tutorial/<slide>) that opened this deck.
  const linkedSlide = await window.api.takeShowSlide(dir).catch(() => null);
  if (linkedSlide && generation === adoptGeneration && !showSlideById(linkedSlide)) {
    setStatusMessage(`The tutorial has no slide ${linkedSlide}.`);
  }
}

/* --- keyboard, clipboard, context menu: shared shell wiring --- */

const shellDeps: ShellDeps = {
  store,
  canvas,
  rail,
  save,
  setStatusMessage,
  runOperation: (message, action) => runOperation(message, async () => action()),
  currentThemeCss: () => cssEditor.getValue(),
  openRaster,
  downloadOriginal: { label: 'Download original…', run: (element) => void saveOriginalAsset(element.src) },
  undo: () => {
    if (agentSessionReady && agentSessionBridge) agentSessionBridge.undo(store.get().deck);
    else store.undo();
  },
  redo: () => {
    if (agentSessionReady && agentSessionBridge) agentSessionBridge.redo(store.get().deck);
    else store.redo();
  },
};
const clipboard = createClipboardActions(shellDeps);

/* --- status bar --- */

/** A transient message (import result, export path, error) shown until the next edit. */
let statusMessage = '';
let statusBusy = false;

const operationProgress = new DelayedOperationProgress(({ message, busy }) => {
  statusMessage = message;
  statusBusy = busy;
  renderStatus();
});

window.api.onOperationProgress?.((progress) => operationProgress.update(progress));

async function runOperation<T>(
  initialMessage: string,
  action: (operation: OperationHandle) => Promise<T>,
): Promise<T> {
  const operation = operationProgress.begin(initialMessage);
  try {
    return await action(operation);
  } finally {
    operation.finish();
  }
}

/**
 * Before restarting into an update: write the deck, its theme and its edit
 * history now, and report whether anything is still unsaved, so the main
 * process can refuse to quit over it (src/main/updates.ts).
 */
async function flushForRestart(): Promise<{ clean: boolean; deckName?: string }> {
  await cssEditor.flush();
  const { dir } = store.get();
  // A window with no deck has nothing to lose.
  if (!dir) return { clean: true };
  await save();
  return { clean: !store.get().dirty, deckName: dir.split(/[\\/]/).pop() || dir };
}

installUpdates({
  beginOperation: (message) => operationProgress.begin(message),
  setStatus: (message) => setStatusMessage(message),
  flush: flushForRestart,
});

function setStatusMessage(text: string): void {
  statusMessage = text;
  statusBusy = false;
  renderStatus();
}

function renderStatus(): void {
  const status = el('status');
  // Runs on every store emit; rewriting unchanged text and attributes still
  // costs a style and paint invalidation of the full-width footer.
  const text = statusBarText(store.get(), statusMessage);
  if (status.textContent !== text) status.textContent = text;
  renderRemoteChip();
  const busy = statusBusy ? 'true' : 'false';
  if (status.dataset.busy !== busy) status.dataset.busy = busy;
  if (status.getAttribute('aria-busy') !== busy) status.setAttribute('aria-busy', busy);
  if (status.getAttribute('aria-live') !== 'polite') status.setAttribute('aria-live', 'polite');
}

/* --- boot --- */

buildToolbar();
buildTabs();
el('themePanel').appendChild(themePanel.element);
el('themePanel').classList.add('theme-panel');
bindEditorKeys(shellDeps, clipboard);
const refreshInspectorForTextMode = canvas.onTextEditModeChange;
canvas.onTextEditModeChange = (elementId) => {
  refreshInspectorForTextMode?.(elementId);
  publishAgentPresence();
};
store.subscribe(() => {
  syncSlideSelectionContext();
  syncDeckNameLabel();
  renderStatus();
  scheduleSave();
  publishAgentPresence();
  syncThemeStylesheet();
});

/**
 * theme.css is the deck's composed defaults, rendered. Any path that changes
 * them -- the panel, the inspector, a new slide installing the chosen theme,
 * an undo -- has to reach the stylesheet, so the mirror lives here once rather
 * than at every call site.
 */
let mirroredThemeStyle = JSON.stringify(store.get().deck.themeStyle);
let themeStylesheetArmed = false;
function syncThemeStylesheet(): void {
  if (!themeStylesheetArmed) return;
  const deck = store.get().deck;
  const serialized = JSON.stringify(deck.themeStyle);
  if (serialized === mirroredThemeStyle) return;
  mirroredThemeStyle = serialized;
  if (!deck.themeStyle) return;
  const css = withThemeBlock(cssEditor.getValue(), themeStyleCss(deck.themeStyle, themeStyleLabel(deck)));
  if (css === cssEditor.getValue()) return;
  cssEditor.setValue(css);
  void persistThemeCss(css);
}
syncSlideSelectionContext();
renderStatus();

// A trimmed file comes back from the trim window; relink the element that
// requested it so the new clip lands in the deck with no manual step.
window.api.onTrimDone((result) => {
  if (!pendingTrimElementId) return;
  const targetId = pendingTrimElementId;
  pendingTrimElementId = null;

  store.commit((deck) => {
    for (const slide of deck.slides) {
      const element = slide.elements.find((e) => e.id === targetId);
      if (!element || element.type !== 'video') continue;
      element.src = result.src;
      // The trim is baked into the file, so the non-destructive in/out points
      // must reset or they'd clip the already-clipped result.
      element.start = 0;
      element.end = null;
      if (result.width && result.height) {
        // Keep the on-slide width and adopt the crop's new aspect ratio.
        element.h = Math.round((element.w * result.height) / result.width);
      }
    }
  });
  void save();
});

// Raster paint writes a new PNG and reports the exact element that launched
// it, so a later selection change cannot relink the wrong image.
window.api.onRasterDone((result) => {
  const targetExists = store.get().deck.slides.some((slide) =>
    slide.elements.some((element) => element.id === result.elementId && element.type === 'image'));
  if (!targetExists) {
    setStatusMessage(`Painted PNG saved as ${result.src}, but its image element no longer exists.`);
    return;
  }
  store.commit((deck) => {
    for (const slide of deck.slides) {
      const element = slide.elements.find((candidate) => candidate.id === result.elementId);
      if (element?.type === 'image') element.src = result.src;
    }
  }, { label: 'Apply raster paint' });
  void save();
  setStatusMessage(`Painted image saved as ${result.src}`);
});

// Ending a presentation returns to the slide it was showing, not the one it
// started from.
window.api.onPresentEnded?.((slideIndex) => store.selectSlide(slideIndex));

canvas.contextActions = makeContextActions(shellDeps, clipboard);

// Watch mode: the main process reloads the deck when deck.json changes on
// disk (an agent, a git checkout, hand editing) and broadcasts it here. Our
// own saves echo back identical content and are ignored by comparison.
window.api.onPresentNotesEdit(({ slideId, notes }) => {
  const slide = store.get().deck.slides.find((item) => item.id === slideId);
  if (!slide || slide.notes === notes) return;
  store.commit((deck) => {
    const target = deck.slides.find((item) => item.id === slideId);
    if (target) target.notes = notes;
  }, { label: 'Edit speaker notes' });
});
window.api.onShowSlide((request) => {
  if (request.dir !== store.get().dir) return;
  if (!showSlideById(request.slideId)) setStatusMessage(`The tutorial has no slide ${request.slideId}.`);
});
window.api.onDeckState((session) => {
  const state = store.get();
  if (
    session.dir === state.dir &&
    JSON.stringify(session.deck) === JSON.stringify(state.deck)
  ) return;
  // A different deck is a genuine open; the same deck rewritten underneath us
  // is an edit, and an edit should be undoable rather than a history wipe.
  if (session.dir !== state.dir) {
    void runOperation('Opening presentation…', (operation) =>
      adopt(session.dir, session.deck, operation)).then(() => {
      themePanel.refreshSwatches();
      setStatusMessage('Deck opened.');
    }).catch((error) => {
      setStatusMessage(`Open failed: ${error instanceof Error ? error.message : error}`);
    });
    return;
  }
  const before = state.deck;
  store.replaceExternal(session.deck, session.dir);
  // In a server deck's mirror, a deck.json rewritten on disk (a local agent's
  // transaction with the editor's watcher in between) is this side's edit.
  if (remoteBinding?.dir === session.dir && agentSessionBridge) {
    agentSessionBridge.localEdit(before, store.get().deck, 'Edited on disk');
  }
  welcome.setVisible(false);
  themePanel.refreshSwatches();
  setStatusMessage('Deck reloaded from disk.');
});
window.api.onThemeCss?.((css) => {
  if (css !== cssEditor.getValue()) cssEditor.setValue(css);
});
window.api.onAgentSessionState?.((state) => {
  if (state.active) connectAgentSession(state);
  else {
    const endedMode = activeSessionMode;
    agentPanel.hide();
    disconnectAgentSession();
    setStatusMessage(endedMode === 'collaboration'
      ? 'Collaboration ended; presentation saved.'
      : 'Agent session closed; presentation saved.');
  }
});

// Reopen the deck the main process already has, if any.
void (async () => {
  await runOperation('Opening presentation…', async (operation) => {
    const session = await window.api.getDeck();
    if (session) await adopt(session.dir, session.deck, operation);
  });
  themePanel.refreshSwatches();
})();
