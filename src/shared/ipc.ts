import type { Deck } from './deck.js';
import type { DeckHistoryDocument } from './deckHistory.js';
import type { AgentContextDraft, AgentRequest, AgentResponse } from './agent.js';
import type { EditorViewSnapshot } from './editorView.js';

/**
 * The contract between the renderer and the main process. Both sides import
 * these types, so a channel can't drift out of sync with its payload.
 */

export const IPC = {
  deckOpen: 'deck:open',
  deckOpenPath: 'deck:openPath',
  deckGet: 'deck:get',
  deckNew: 'deck:new',
  deckSave: 'deck:save',
  deckSyncSnapshot: 'deck:syncSnapshot',
  deckSaveAs: 'deck:saveAs',
  deckHistoryLoad: 'deckHistory:load',
  deckHistorySave: 'deckHistory:save',
  deckLoadTheme: 'deck:loadTheme',
  deckSaveTheme: 'deck:saveTheme',
  deckState: 'deck:state',
  /** Synchronous, at preload time: which deck this window's assets come from. */
  deckKeyGet: 'deck:keyGet',
  deckKey: 'deck:key',
  themeCss: 'deck:themeCss',
  assetImport: 'asset:import',
  assetImportUrl: 'asset:importUrl',
  assetImportProgress: 'asset:importProgress',
  meshImport: 'mesh:import',
  clipboardWrite: 'clipboard:write',
  clipboardRead: 'clipboard:read',
  assetProbe: 'asset:probe',
  presentOpen: 'present:open',
  displayList: 'display:list',
  presentCursor: 'present:cursor',
  presentCommand: 'present:command',
  presentState: 'present:state',
  trimOpen: 'trim:open',
  trimRun: 'trim:run',
  /** A poster frame for a preview surface, cut by ffmpeg in the main process. */
  videoPoster: 'video:poster',
  trimProgress: 'trim:progress',
  trimDone: 'trim:done',
  rasterOpen: 'raster:open',
  rasterSave: 'raster:save',
  rasterDone: 'raster:done',
  keynoteImport: 'keynote:import',
  pptxImport: 'pptx:import',
  exportBundle: 'export:bundle',
  exportPdf: 'export:pdf',
  exportPdfReady: 'export:pdfReady',
  operationProgress: 'operation:progress',
  htmlExport: 'html:export',
  htmlEdit: 'html:edit',
  htmlAdopt: 'html:adopt',
  /** `notes.md` changed on disk; payload is the file's contents. */
  speakerNotesEdit: 'speakerNotes:edit',
  speakerNotesOpen: 'speakerNotes:open',
  agentContextPublish: 'agent:contextPublish',
  agentRequest: 'agent:request',
  agentResponse: 'agent:response',
  /** Read-only status/activity/scratchpad for the user's filesystem agent. */
  agentPanelGetState: 'agentPanel:getState',
  agentPanelState: 'agentPanel:state',
  collabStart: 'collab:start',
  agentSessionStart: 'agentSession:start',
  agentSessionEnd: 'agentSession:end',
  agentSessionState: 'agentSession:state',
} as const;

export interface AgentPanelMessage {
  id: string;
  role: 'assistant' | 'system';
  text: string;
  error?: boolean;
}

export interface AgentScratchpad {
  draftId: string;
  slideCount: number;
  sourceUrl: string;
  importedUrl: string;
  comparisonUrl?: string;
  sourceContactSheetUrl: string;
  importedContactSheetUrl: string;
  sourceLabel?: string;
  importedLabel?: string;
}

/** Read-only status for a user-owned filesystem agent bridge. */
export interface AgentPanelState {
  deckPath: string;
  connection: 'ready' | 'unavailable';
  agentName: string | null;
  scratchpad: AgentScratchpad | null;
  busy: boolean;
  activity: string | null;
  messages: AgentPanelMessage[];
  error: string | null;
}

export interface CollabStartRequest extends EditorViewSnapshot {
  agent?: boolean;
}

/** Native editor connection to the authoritative deck-scoped agent session. */
export interface AgentSessionConnection {
  active: true;
  deckId: string;
  wsUrl: string;
  name: string;
  /** Which desktop feature owns the background collaboration connection. */
  mode?: 'agent' | 'collaboration';
  /** Filesystem bridge handoff, present for an Agent session. */
  agentUrl?: string;
  /** Ready-to-paste command that mirrors the session onto the user's machine. */
  agentCommand?: string;
}

export type AgentSessionState = AgentSessionConnection | { active: false };

export type { AgentContextDraft, AgentRequest, AgentResponse };

export type PresentationCommand =
  | { type: 'next' | 'prev' | 'toggleBlank' | 'swapDisplays' | 'exit' }
  | { type: 'goTo'; slide: number };

export interface PresentationState {
  cursor: { slide: number; step: number };
  steps: number;
  startedAt: number;
  /** Reset whenever the presentation moves to a different slide, not for builds. */
  slideStartedAt: number;
  /** Inclusive bounds when presenting a multi-slide rail selection. */
  range?: { start: number; end: number };
}

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  width: number;
  height: number;
}

export interface PresentOptions {
  audienceDisplayId?: number;
  presenterDisplayId?: number;
  /** Open Speaker View even when audience and presenter resolve to one display. */
  speakerView?: boolean;
  /** Inclusive last slide when presenting a multi-slide rail selection. */
  endSlideIndex?: number;
}

export type PdfBuildMode = 'initial' | 'final' | 'every';
/**
 * How hard a web export squeezes the deck's media.
 *
 * `original` copies every referenced file byte for byte. `balanced` re-encodes
 * video as H.264 and stills as WebP at sizes a projector cannot tell apart from
 * the originals. `compact` trades visible sharpness for a folder small enough
 * to sit on a static web host.
 */
export type WebExportQuality = 'original' | 'balanced' | 'compact';

export interface WebExportRequest {
  quality?: WebExportQuality;
}

export interface PdfExportRequest {
  mode?: PdfBuildMode;
  includeHidden?: boolean;
}

/**
 * A saved file from the deck's `edit/` folder, on its way to being compiled.
 *
 * The main process watches; the editor's renderer is what lays the markup out,
 * so the contents travel rather than the reader.
 */
export interface AuthoredHtmlFile {
  /** Absolute path, used to name the resulting change. */
  path: string;
  contents: string;
}

/** An open deck: its folder on disk plus the parsed document. */
export interface DeckSession {
  /** Absolute path to the deck folder containing deck.json. */
  dir: string;
  deck: Deck;
}

/**
 * Authoritative renderer state while the collaboration server owns disk writes.
 * Main-process consumers (Present/PDF/web export) read this without becoming a
 * competing deck.json writer.
 *
 * Carried with its owner, so a mirror overtaken by a deck switch is refused
 * rather than applied to whichever deck happens to be open when it lands.
 */
export interface DeckSessionSnapshot {
  /** Absolute path to the deck folder this state belongs to. */
  dir: string;
  deck: Deck;
  themeCss: string;
}

/** History is returned with its owner so an overlapping deck switch is safe. */
export interface DeckHistorySession {
  dir: string;
  history: DeckHistoryDocument;
}

/** Result of copying a media file into the deck's assets/ folder. */
/** A dropped 3D model (or several), staged as one interactive web page. */
export interface ImportedMeshPage {
  /** Deck-relative page, e.g. "assets/web/crab.1a2b3c4d.html". */
  src: string;
  /** Its first frame, or null when it could not be captured. */
  poster: string | null;
  /** The models' names, for the element's title. */
  title: string;
  /** The box the page was laid out and captured for. */
  w: number;
  h: number;
}

export interface ImportedAsset {
  /** Deck-relative path, e.g. "assets/demo.mp4". */
  src: string;
  kind: 'image' | 'video';
  /** Natural dimensions in px; null when they could not be determined. */
  width: number | null;
  height: number | null;
  /** Seconds, for video only. */
  duration: number | null;
}

/**
 * Progress of one in-flight asset import, keyed by the caller's token (which
 * is also the element's `pending:<token>` src, so the canvas can find the
 * placeholder to update).
 */
export interface AssetImportProgress {
  token: string;
  /** 'upload' is browser-only; the desktop app skips straight to processing. */
  phase: 'upload' | 'processing';
  /** 0..1, or null when the phase has no measurable progress. */
  ratio: number | null;
}

/** A phase update for a renderer-initiated operation that may take a while. */
export interface OperationProgress {
  /** Opaque renderer-generated id, so overlapping operations cannot cross-talk. */
  id: string;
  /** Human-readable current work, ideally naming the file being handled. */
  message: string;
  /** 0..1 when the operation can measure progress; null for an indeterminate phase. */
  ratio: number | null;
}

/** Probe results for a media file already inside the deck. */
export interface MediaInfo {
  width: number | null;
  height: number | null;
  duration: number | null;
}

/** A trim/crop job handed to ffmpeg. Crop is in source pixels. */
/** One frame of a deck video, for a thumbnail that must never play it. */
export interface VideoPosterRequest {
  /** Deck-relative path of the clip. */
  src: string;
  /** Seconds into the clip. */
  time: number;
}

export interface VideoPosterResult {
  /** A URL this window can put on an `<img>`, or null when no frame could be cut. */
  url: string | null;
}

export interface TrimRequest {
  deckDir: string;
  /** Deck-relative source, e.g. "assets/demo.mp4". */
  src: string;
  start: number;
  end: number;
  crop: { x: number; y: number; w: number; h: number } | null;
  /** Stream-copy when no crop is requested. Fast and lossless, keyframe-aligned. */
  copyWhenPossible: boolean;
}

export interface TrimResult {
  /** Deck-relative path of the new file. The source is never modified. */
  src: string;
  width: number | null;
  height: number | null;
  duration: number | null;
}

export interface TrimProgress {
  /** 0..1, derived from ffmpeg's reported output time. */
  fraction: number;
  message: string;
}

/** The image element handed to the standalone raster paint window. */
export interface RasterTarget {
  src: string;
  elementId: string;
}

/** A PNG rendered by the raster editor, ready to become a derived deck asset. */
export interface RasterSaveRequest extends RasterTarget {
  width: number;
  height: number;
  png: Uint8Array;
}

export interface RasterResult extends RasterTarget {
  /** Deck-relative path of the new PNG. The source is never modified. */
  src: string;
  width: number;
  height: number;
}

/** Per-deck summary of what a presentation importer could and could not map. */
export interface ImportReport {
  slides: number;
  elements: number;
  /** Archive type name -> how many instances were left as placeholders. */
  unsupported: Record<string, number>;
  warnings: string[];
}

/** Outcome of importing a Keynote or PowerPoint presentation. */
export interface PresentationImportResult {
  dir: string;
  deck: Deck;
  report: ImportReport;
  /**
   * The import went to a window of its own because the asking window already
   * held a presentation, so that window must not adopt this deck. It still
   * reports the outcome: it is the window the author started the import from.
   */
  openedInNewWindow?: boolean;
}

/** @deprecated Kept for callers that predate the PowerPoint importer. */
export type KeynoteImportResult = PresentationImportResult;
