import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { FSWatcher } from 'node:fs';
import type { BrowserWindow, WebContents } from 'electron';
import type { DeckSession, PresentationState } from '@shared/ipc.js';
import { AgentRuntime } from './agentRuntime.js';

/**
 * One open document per editor window.
 *
 * Everything a deck owns while it is open — the session itself, the theme the
 * renderer holds, its filesystem watchers, and the satellite windows it opened
 * (Present, Speaker View, Trim, Raster Paint, the hidden PDF page) — hangs off
 * the editor window that opened it. The main process reaches that state from
 * whichever window sent an IPC message, so a second presentation cannot answer
 * with the first one's slides, write into its folder, or reach its projector.
 */
export interface DeckWindowState {
  readonly editor: BrowserWindow;
  session: DeckSession | null;
  /**
   * Host used in this document's `deck://` asset URLs. Keyed by deck folder, so
   * two windows on the same deck share one cache entry per asset while a window
   * showing a different deck cannot resolve this one's media.
   */
  deckKey: string;
  /** Renderer-owned theme while a collaboration session owns disk writes. */
  themeCss: string | null;
  watchers: FSWatcher[];
  /** Exactly what we last wrote, so the watcher can tell an echo from an edit. */
  lastSavedDeckJson: string | null;
  /** HTML this editor just exported; its watcher event is an echo, not an edit. */
  lastWrittenHtml: Map<string, string>;
  present: BrowserWindow | null;
  presenter: BrowserWindow | null;
  presentationState: PresentationState | null;
  presentationDisplays: { audienceDisplayId: number; presenterDisplayId: number } | null;
  trim: BrowserWindow | null;
  raster: BrowserWindow | null;
  /** Every live window of this document, editor included. */
  readonly windows: Set<BrowserWindow>;
  /** File-only bridge between a local agent and this window. */
  readonly agentRuntime: AgentRuntime;
}

/** The host in `deck://<host>/<path>` for a window with nothing open. */
export const NO_DECK_KEY = 'no-deck';

const states: DeckWindowState[] = [];
/** Every window that belongs to a document, satellites included. */
const owners = new Map<number, DeckWindowState>();
const keysByDir = new Map<string, string>();
const dirsByKey = new Map<string, string>();

/** A stable, opaque asset host for a deck folder. */
export function deckKeyFor(dir: string): string {
  const canonical = resolve(dir);
  const existing = keysByDir.get(canonical);
  if (existing) return existing;
  // Opaque rather than derived from the path: a URL host is not the place to
  // publish where the author keeps their files.
  const key = randomUUID().replace(/-/g, '');
  keysByDir.set(canonical, key);
  dirsByKey.set(key, canonical);
  return key;
}

/** The deck folder an asset URL's host refers to, if any. */
export function deckDirForKey(key: string): string | null {
  return dirsByKey.get(key) ?? null;
}

export function registerEditorWindow(editor: BrowserWindow): DeckWindowState {
  const state: DeckWindowState = {
    editor,
    session: null,
    deckKey: NO_DECK_KEY,
    themeCss: null,
    watchers: [],
    lastSavedDeckJson: null,
    lastWrittenHtml: new Map(),
    present: null,
    presenter: null,
    presentationState: null,
    presentationDisplays: null,
    trim: null,
    raster: null,
    windows: new Set([editor]),
    agentRuntime: new AgentRuntime(() => (editor.isDestroyed() ? null : editor)),
  };
  states.push(state);
  owners.set(editor.webContents.id, state);
  return state;
}

/** Route a satellite window's messages, and deck broadcasts, to its document. */
export function attachWindow(state: DeckWindowState, win: BrowserWindow): void {
  const id = win.webContents.id;
  owners.set(id, state);
  state.windows.add(win);
  win.on('closed', () => {
    if (owners.get(id) === state) owners.delete(id);
    state.windows.delete(win);
  });
}

export function forgetEditorWindow(state: DeckWindowState): void {
  const index = states.indexOf(state);
  if (index >= 0) states.splice(index, 1);
  for (const [id, owner] of owners) {
    if (owner === state) owners.delete(id);
  }
  state.windows.clear();
}

/** The document a message belongs to, from the window that sent it. */
export function ownerOf(contents: WebContents | null | undefined): DeckWindowState | null {
  if (!contents) return null;
  return owners.get(contents.id) ?? null;
}

export function editorStates(): readonly DeckWindowState[] {
  return states;
}

/** The window showing a deck folder, for state that is addressed by deck. */
export function stateForDeckDir(dir: string): DeckWindowState | null {
  const canonical = resolve(dir);
  return states.find((state) => state.session && resolve(state.session.dir) === canonical) ?? null;
}

/** An editor window with nothing open: it adopts a deck rather than spawning one. */
export function isEmptyEditor(state: DeckWindowState): boolean {
  return state.session === null;
}

/** Live windows of a document, for a broadcast that must not leave it. */
export function windowsOf(state: DeckWindowState): BrowserWindow[] {
  return [...state.windows].filter((win) => !win.isDestroyed());
}
