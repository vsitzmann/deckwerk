import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { DeckSchema, SlideSchema, parseDeck } from '@shared/deck.js';
import { renameRetiredFields } from '@shared/fieldAliases.js';
import { cloneJson, jsonEqual } from '@shared/jsonData.js';
import { applyAgentOperations, type AgentOperation } from '@shared/agent.js';
import { diffDecks } from '@shared/deckDiff.js';
import { carryComments, withoutCommentOps } from '@shared/comments.js';
import { applyOpsLenient } from '@shared/collabApply.js';
import {
  type ClipboardReadResult,
  type ClipboardWriteRequest,
  pinSlidesToTheme,
  remapElementIds,
  remapSlideIds,
  slideThemeStylesDiffer,
} from '@shared/clipboard.js';
import { effectiveThemeStyle } from '@shared/themes.js';
import { makeId } from '@shared/geometry.js';
import { pastedTableData } from '@shared/paragraphs.js';
import { classifyMediaName } from '@shared/media.js';
import type {
  DeckHistoryDocument,
} from '@shared/deckHistory.js';

/**
 * Editor state: the deck, the selection, and an undo history.
 *
 * Mutations become semantic forward/inverse operations for undo and persisted
 * history. Generic deck edits retain a fully isolated clone, while the hot
 * selected-element path uses copy-on-write for only the current slide branch.
 */

export interface EditorState {
  dir: string | null;
  deck: Deck;
  slideIndex: number;
  /** Slide ids selected in the rail. The current slide is always included. */
  slideSelection: Set<string>;
  selection: Set<string>;
  dirty: boolean;
}

type Listener = (state: EditorState) => void;

export interface HistoryItem {
  id: number;
  label: string;
  /** Longer explanation shown beneath the compact history title. */
  description?: string;
  /** Filesystem Agent session that produced this state (legacy persisted key). */
  agentChatId?: string;
  /**
   * What this entry edited, e.g. `text:<elementId>`. Purely a display hint:
   * consecutive entries sharing a group and a label are shown as one
   * collapsible row, while each remains separately restorable and each is
   * still its own undo step.
   */
  group?: string;
  at: number;
  slideIndex: number;
}

export interface RemoteHistoryOptions {
  coalesce?: boolean;
  /** Display grouping hint; see `HistoryItem.group`. */
  group?: string;
  /** False for synchronization events such as filesystem reloads/resyncs. */
  history?: boolean;
  description?: string;
  agentChatId?: string;
}

interface DeckHistoryItem extends HistoryItem {
  /** Operations from the preceding entry; empty for the base entry. */
  operations: AgentOperation[];
}

interface UndoItem {
  label: string;
  forward: AgentOperation[];
  inverse: AgentOperation[];
}

const HISTORY_LIMIT = 200;
/** Rows trimmed off a full history log per fold into its base (see historyBaseLag). */
const HISTORY_FOLD_BATCH = 50;

export class EditorStore {
  /**
   * Fired whenever a local undo unit is born (commit, drag transaction end,
   * history replace) with the deck before and after. Unset in the Electron
   * shell; the collab shell diffs the pair into ops and sends them to the
   * server. Never fired for remote or external deck replacements.
   */
  onLocalEdit:
    | ((prev: Deck, next: Deck, label: string, coalesceKey?: string) => void)
    | null = null;

  /** Signals that the independently persisted history needs a later flush. */
  onHistoryChange: (() => void) | null = null;

  private state: EditorState;
  private listeners = new Set<Listener>();
  private historyListeners = new Set<() => void>();
  private undoStack: UndoItem[] = [];
  private redoStack: UndoItem[] = [];
  private historyLog: DeckHistoryItem[] = [];
  /** Materialized state of historyLog[0], once `historyBaseLag` is applied. */
  private historyBase: Deck | null = null;
  /**
   * Operations of rows trimmed off the front of a full log, not yet folded
   * into `historyBase`. A fold is a whole-deck apply (parse, clone,
   * validate); paying it for every new row once the log is full made every
   * collaborator's transaction O(deck) again, so trims are folded in batches
   * and whenever the base is read out.
   */
  private historyBaseLag: AgentOperation[] = [];
  private historyBaseLagRows = 0;
  /** One materialized cache for diffing the next history entry. */
  private historyTipDeck: Deck | null = null;
  /** The history row represented by `state.deck`, or null for an unrecorded state. */
  private currentHistoryId: number | null = null;
  private nextHistoryId = 1;
  /** Fixed end of a Shift-click range; ordinary slide selection resets it. */
  private slideSelectionAnchor = 0;
  /** Coalesces a drag into one undo entry instead of one per mousemove. */
  private txnBase: Deck | null = null;
  private txnLabel = 'Move or resize objects';
  /**
   * Incoming remote slide object → the store's equal, normalised slide.
   *
   * The collab bridge advances its shadow copy-on-write, so a slide nobody
   * touched arrives as the same object transaction after transaction. Once
   * one has been parsed and found equal to (or adopted as) a store slide, it
   * never needs looking at again. Keyed by identity, never by content: both
   * sides are immutable (applyOpsLenient never mutates its input, and store
   * states are never mutated in place — undo and history already hold them).
   */
  private remoteSlides = new WeakMap<Slide, Slide>();
  /** The same memo for deck properties: the last incoming set and its parse. */
  private remoteProps: { from: Omit<Deck, 'slides'>; to: Omit<Deck, 'slides'> } | null = null;
  private remoteDepth = 0;

  constructor(deck: Deck, dir: string | null = null) {
    this.state = {
      dir,
      deck,
      slideIndex: 0,
      slideSelection: new Set(deck.slides[0] ? [deck.slides[0].id] : []),
      selection: new Set(),
      dirty: false,
    };
  }

  get(): EditorState {
    return this.state;
  }

  /** Whether pointer-driven edits are currently being grouped into one change. */
  isTransactionActive(): boolean {
    return this.txnBase !== null;
  }

  /**
   * True while listeners are being told about a deck decided elsewhere
   * (applyRemote), as opposed to an edit made here. A text box being edited
   * merges the former into its live DOM; the latter is its own commit coming
   * back (EditorCanvas.adoptRemoteEditedHtml).
   */
  isApplyingRemote(): boolean {
    return this.remoteDepth > 0;
  }

  get slide(): Slide | undefined {
    return this.state.deck.slides[this.state.slideIndex];
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe only to history metadata/current-row changes, not canvas selection churn. */
  subscribeHistory(fn: () => void): () => void {
    this.historyListeners.add(fn);
    return () => this.historyListeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  private emitHistory(): void {
    for (const fn of this.historyListeners) fn();
  }

  /** Replace the deck wholesale and hydrate its independently persisted history. */
  load(
    deck: Deck,
    dir: string,
    opts: { keepView?: boolean; history?: DeckHistoryDocument } = {},
  ): void {
    this.undoStack = [];
    this.redoStack = [];
    const persisted = opts.history;
    this.historyBaseLag = [];
    this.historyBaseLagRows = 0;
    try {
      this.historyBase = persisted?.base ? parseDeck(persisted.base) : null;
      this.historyLog = (persisted?.entries ?? []).slice(-HISTORY_LIMIT).map((item) => ({
        ...item,
        id: this.nextHistoryId++,
        operations: structuredClone(item.operations),
        slideIndex: Math.max(0, item.slideIndex),
      }));
      this.historyTipDeck = this.materializeHistoryIndex(this.historyLog.length - 1);
    } catch (error) {
      // A semantically broken sidecar is expendable. It must never prevent the
      // presentation itself from opening.
      console.error('Could not hydrate edit history:', error);
      this.historyBase = null;
      this.historyLog = [];
      this.historyTipDeck = null;
    }
    const persistedTip = this.historyLog[this.historyLog.length - 1];
    this.currentHistoryId = persistedTip && this.historyTipDeck
      && sameDeck(this.historyTipDeck, deck)
      ? persistedTip.id
      : null;
    // An external reload (agent edit, git) must not teleport the editor away
    // from the slide being worked on.
    const slideIndex = opts.keepView
      ? Math.min(this.state.slideIndex, Math.max(0, deck.slides.length - 1))
      : 0;
    this.slideSelectionAnchor = slideIndex;
    this.state = {
      dir,
      deck,
      slideIndex,
      slideSelection: new Set(deck.slides[slideIndex] ? [deck.slides[slideIndex].id] : []),
      selection: new Set(),
      dirty: false,
    };
    this.emitHistory();
    this.emit();
  }

  /**
   * Incorporate a deck written outside the editor without throwing away the
   * user's undo history or stable-id selection. Agent transactions and hand
   * edits therefore behave like ordinary, reversible editor actions.
   */
  replaceExternal(deck: Deck, dir: string): void {
    const anchor = this.cursorAnchor();
    // A disk reload is a new synchronization baseline, not an authored edit.
    // Keeping pre-reload undo entries would make Command-Z silently restore
    // stale file contents, so both stacks stop at this boundary.
    this.undoStack = [];
    this.redoStack = [];
    this.txnBase = null;
    this.state = { ...this.state, dir, deck: parseDeck(deck), dirty: false };
    this.currentHistoryId = null;
    this.restoreCursor(anchor);
    this.emitHistory();
    this.emit();
  }

  /** Replace the document as one local, dirty, undoable transaction. */
  replaceWithHistory(deck: Deck, label: string): void {
    const anchor = this.cursorAnchor();
    const previous = this.state.deck;
    this.state = { ...this.state, deck: parseDeck(deck), dirty: true };
    this.pushUndo(previous, this.state.deck, label);
    this.restoreCursor(anchor);
    this.recordHistory(label);
    this.onLocalEdit?.(previous, this.state.deck, label);
    this.emit();
  }

  /**
   * Absorb a deck decided elsewhere (the collab server) without an undo entry
   * and without dirtying the document — persistence is the server's job. Slide
   * object identity is re-shared so untouched slides keep their DOM and
   * playing videos; the cursor stays on the same slide by id.
   */
  applyRemote(
    deck: Deck,
    label = 'Remote edit',
    opts: RemoteHistoryOptions = {},
  ): void {
    const anchor = this.cursorAnchor();
    let next = this.adoptRemoteDeck(deck);
    // Server acknowledgements normally contain the optimistic state already
    // on screen. Recording them again creates duplicate/misattributed rows and
    // makes the apparent current revision depend on network timing.
    if (sameDeck(this.state.deck, next)) return;
    // A remote transaction landing mid-drag used to overwrite the dragged
    // element (a visible snap-back on every incoming txn), and the drag's
    // endTransaction then diffed across the absorbed remote edit — so the
    // peer's work entered this client's undo entry, and undoing the drag
    // undid the peer too. Rebase instead: replay the in-flight local ops on
    // top of the remote deck, and move the transaction's base to the remote
    // deck so the eventual diff contains only the drag.
    if (this.txnBase) {
      const inFlight = diffDecks(this.txnBase, this.state.deck);
      this.txnBase = next;
      if (inFlight.length > 0) {
        next = reshareDeck(this.state.deck, applyOpsLenient(next, inFlight).deck);
      }
    }
    this.state = { ...this.state, deck: next };
    this.restoreCursor(anchor);
    // Live typing arrives as a stream of same-label transactions; folding them
    // into one history entry keeps the History panel legible.
    if (opts.history !== false) {
      this.recordHistory(label, {
        coalesce: opts.coalesce ?? true,
        description: opts.description,
        agentChatId: opts.agentChatId,
      });
    } else {
      this.currentHistoryId = null;
      this.emitHistory();
    }
    this.remoteDepth += 1;
    try {
      this.emit();
    } finally {
      this.remoteDepth -= 1;
    }
  }

  /**
   * Re-baseline on the server's deck after a reconnect.
   *
   * A dropped WebSocket is not a new document. Reloading through `load` reset
   * the restorable revision log, both undo stacks and the element selection, so
   * a momentary network blip destroyed every revision the History panel held
   * even though the document had not changed. The log and the selection survive
   * here; the undo stacks deliberately do not, because a reconnect abandons the
   * unconfirmed transactions those inverses were computed against, and replaying
   * them would apply edits to a base the server never saw.
   */
  resyncRemote(deck: Deck, dir: string): void {
    const anchor = this.cursorAnchor();
    const next = this.adoptRemoteDeck(deck);
    this.undoStack = [];
    this.redoStack = [];
    this.state = { ...this.state, dir, deck: next, dirty: false };
    this.currentHistoryId = null;
    this.restoreCursor(anchor);
    // Selection is by stable id, so drop only ids the new deck no longer has.
    const live = new Set(this.state.deck.slides.flatMap((slide) => slide.elements.map((e) => e.id)));
    this.state = {
      ...this.state,
      selection: new Set([...this.state.selection].filter((id) => live.has(id))),
    };
    this.emitHistory();
    this.emit();
  }

  /**
   * A deck decided elsewhere, normalised as `parseDeck` would and reconciled
   * with the current state (see `reshareDeck`), in time proportional to what
   * differs from the current state rather than to the deck.
   *
   * Slides already in the current state, and remote slide objects met before,
   * are taken as they are; only slides new to this store are parsed. The
   * result never mutates `incoming`.
   */
  private adoptRemoteDeck(incoming: Deck): Deck {
    const current = this.state.deck;
    if (incoming === current) return current;
    const raw = incoming as unknown as Record<string, unknown> | null;
    // Not a parsed deck (a legacy file shape, or something malformed): the
    // whole-deck parse is the only correct normalisation, and its error the
    // right message.
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.slides)
      || Object.prototype.hasOwnProperty.call(raw, 'morphDuration')) {
      return reshareDeck(current, parseDeck(incoming));
    }
    const inState = new Set(current.slides);
    const currentById = new Map(current.slides.map((slide) => [slide.id, slide]));
    const slides = incoming.slides.map((slide) => {
      if (inState.has(slide)) return slide;
      const known = this.remoteSlides.get(slide);
      if (known) return known;
      const parsed = SlideSchema.parse(renameRetiredFields(slide));
      const before = currentById.get(parsed.id);
      const adopted = before ? reshareSlide(before, parsed) : parsed;
      this.remoteSlides.set(slide, adopted);
      return adopted;
    });
    // Deck properties, likewise: as they are when they are the current
    // state's, as adopted last time when they are the same objects as last
    // time, parsed otherwise.
    const { slides: _incomingSlides, ...props } = incoming;
    const { slides: _currentSlides, ...currentProps } = current;
    let adoptedProps: Omit<Deck, 'slides'>;
    if (sameValues(props, currentProps)) {
      adoptedProps = props;
    } else if (this.remoteProps && sameValues(props, this.remoteProps.from)) {
      adoptedProps = this.remoteProps.to;
    } else {
      const { slides: _none, ...parsed } = DeckSchema.parse(renameRetiredFields({ ...props, slides: [] }));
      adoptedProps = parsed;
      this.remoteProps = { from: props, to: parsed };
    }
    return reshareDeck(current, { ...adoptedProps, slides });
  }

  /** The slide the user is looking at, named by id rather than by position. */
  private cursorAnchor(): string | null {
    return this.state.deck.slides[this.state.slideIndex]?.id ?? null;
  }

  /**
   * Put the cursor back on the slide it was on.
   *
   * A rewrite from outside — an agent transaction, a hand edit, a git checkout
   * — routinely inserts or removes slides ahead of the one being worked on.
   * Restoring by index would silently teleport the user; restoring by id is
   * what makes those edits feel like edits.
   */
  private restoreCursor(anchorSlideId: string | null): void {
    const at = anchorSlideId === null
      ? -1
      : this.state.deck.slides.findIndex((slide) => slide.id === anchorSlideId);
    if (at !== -1) this.state = { ...this.state, slideIndex: at };
    this.clampCursor();
  }

  /**
   * Apply an arbitrary mutation to a structurally-cloned deck.
   *
   * Narrow high-frequency operations use copy-on-write helpers instead; this
   * fallback keeps unconstrained callers isolated from the current state.
   */
  commit(
    fn: (deck: Deck) => void,
    opts: {
      history?: boolean; label?: string; transient?: boolean;
      coalesceKey?: string; historyGroup?: string; measurement?: boolean;
    } = {},
  ): void {
    const previous = this.state.deck;
    // A deep copy that shares strings (immutable, so safe), then identity
    // restored for everything the mutation left alone: O(deck structure), not
    // O(deck bytes) — a deck holding a 10 MB inline image used to clone and
    // stringify all of it on every live-typing push.
    const draft = cloneJson(previous);
    fn(draft);
    this.finishCommit(previous, reshareDeck(previous, draft), opts);
  }

  private finishCommit(
    previous: Deck,
    next: Deck,
    opts: {
      history?: boolean; label?: string; transient?: boolean;
      coalesceKey?: string; historyGroup?: string; measurement?: boolean;
    },
  ): void {
    const forward = diffDecks(previous, next);
    if (forward.length === 0) return;

    // Measurement commits record what the renderer observed (an auto-height
    // table's fitted height), not something the author did. They must not
    // consume an undo slot, mark the document dirty, clear the History
    // panel's current row, or broadcast as an edit — merely opening a deck
    // used to rewrite it and offer an undo step within seconds, and every
    // cell edit grew a phantom "Fit table rows" entry in the collab undo
    // stack. The measured value still lands in the deck, so the next real
    // edit persists it.
    if (opts.measurement) {
      this.state = { ...this.state, deck: next };
      this.emit();
      return;
    }

    // Transient commits stream work in progress (live typing) to collaborators
    // without consuming undo slots or history entries; the coalesce key lets
    // the collab undo layer fold the stream into one undoable edit.
    if (opts.history !== false && !this.txnBase && !opts.transient) {
      this.pushUndo(previous, next, opts.label ?? 'Edit slide', forward);
    }
    // Selection is by stable id, and a commit is free to remove objects — the
    // layout switch that retires a prompt nobody wrote into does exactly
    // that. An id left behind points at nothing: the inspector, the align
    // tools and every `selectedElements()` caller would then be working from
    // an object that is no longer on the slide.
    this.state = {
      ...this.state,
      deck: next,
      dirty: true,
      selection: this.selectionWithin(next),
    };
    if (!this.txnBase) {
      if (!opts.transient && opts.history !== false) {
        this.recordHistory(opts.label ?? 'Edit slide', { group: opts.historyGroup });
      } else {
        this.currentHistoryId = null;
        this.emitHistory();
      }
      this.onLocalEdit?.(previous, next, opts.label ?? 'Edit slide', opts.coalesceKey);
    }
    this.emit();
  }

  /**
   * Group everything until `endTransaction` into a single undo entry. Used for
   * drags and resizes, which fire continuously but mean one edit.
   */
  beginTransaction(label = 'Move or resize objects'): void {
    if (!this.txnBase) {
      this.txnBase = this.state.deck;
      this.txnLabel = label;
      this.currentHistoryId = null;
      this.emitHistory();
    }
  }

  endTransaction(): void {
    if (!this.txnBase) return;
    const base = this.txnBase;
    this.txnBase = null;
    // A drag that ended where it started shouldn't consume an undo slot.
    if (base !== this.state.deck) {
      const forward = diffDecks(base, this.state.deck);
      if (forward.length > 0) {
        this.pushUndo(base, this.state.deck, this.txnLabel, forward);
        this.recordHistory(this.txnLabel);
        this.onLocalEdit?.(base, this.state.deck, this.txnLabel);
        // Transaction updates emit while the gesture is in progress. Emit once
        // more after clearing txnBase so views that deliberately defer costly
        // work during a drag can catch up to the committed deck.
        this.emit();
      }
    }
  }

  private pushUndo(
    previous: Deck,
    next: Deck,
    label: string,
    forward = diffDecks(previous, next),
  ): void {
    // Comment changes are not undoable edits (shared/comments.ts).
    const contentForward = withoutCommentOps(forward);
    if (contentForward.length === 0) return;
    this.undoStack.push({
      label,
      forward: contentForward,
      inverse: withoutCommentOps(diffDecks(next, previous)),
    });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(prev);
    this.state = {
      ...this.state,
      deck: applyAgentOperations(this.state.deck, prev.inverse),
      dirty: true,
    };
    this.clampCursor();
    this.recordHistory(`Undo: ${prev.label}`);
    this.emit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(next);
    this.state = {
      ...this.state,
      deck: applyAgentOperations(this.state.deck, next.forward),
      dirty: true,
    };
    this.clampCursor();
    this.recordHistory(`Redo: ${next.label}`);
    this.emit();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  history(): HistoryItem[] {
    return this.historyLog.map(({ operations: _operations, ...item }) => ({ ...item })).reverse();
  }

  isHistoryCurrent(id: number): boolean {
    return id === this.currentHistoryId;
  }

  persistedHistory(): DeckHistoryDocument {
    this.foldHistoryBase();
    return {
      version: 2,
      base: this.historyBase,
      entries: this.historyLog.map(({ id: _id, ...item }) => ({ ...item })),
    };
  }

  restoreHistory(id: number): boolean {
    const historyIndex = this.historyLog.findIndex((item) => item.id === id);
    const snapshot = this.historyLog[historyIndex];
    const materialized = this.materializeHistoryIndex(historyIndex);
    // A version brings back content, never the comment threads it had then.
    const snapshotDeck = materialized && carryComments(this.state.deck, materialized);
    if (!snapshot || !snapshotDeck || sameDeck(snapshotDeck, this.state.deck)) return false;
    const previous = this.state.deck;
    const slideIndex = Math.min(
      snapshot.slideIndex,
      Math.max(0, snapshotDeck.slides.length - 1),
    );
    const label = `Reverted to ${snapshot.label}`;
    this.pushUndo(this.state.deck, snapshotDeck, label);
    this.redoStack = [];
    this.state = {
      ...this.state,
      deck: snapshotDeck,
      slideIndex,
      slideSelection: new Set(snapshotDeck.slides[slideIndex]
        ? [snapshotDeck.slides[slideIndex].id]
        : []),
      selection: new Set(),
      dirty: true,
    };
    this.currentHistoryId = null;
    this.slideSelectionAnchor = this.state.slideIndex;
    this.recordHistory(label);
    this.onLocalEdit?.(previous, this.state.deck, label);
    this.emit();
    return true;
  }

  markClean(): void {
    this.state = { ...this.state, dirty: false };
    this.emit();
  }

  selectSlide(index: number, extendRange = false): void {
    const clamped = Math.min(Math.max(index, 0), this.state.deck.slides.length - 1);
    const slide = this.state.deck.slides[clamped];
    if (!slide) return;
    const slideSelection = extendRange
      ? new Set(this.state.deck.slides
        .slice(
          Math.min(this.slideSelectionAnchor, clamped),
          Math.max(this.slideSelectionAnchor, clamped) + 1,
        )
        .map((candidate) => candidate.id))
      : new Set([slide.id]);
    if (!extendRange) this.slideSelectionAnchor = clamped;
    const unchanged = clamped === this.state.slideIndex
      && this.state.selection.size === 0
      && slideSelection.size === this.state.slideSelection.size
      && [...slideSelection].every((id) => this.state.slideSelection.has(id));
    if (unchanged) return;
    this.state = {
      ...this.state,
      slideIndex: clamped,
      slideSelection,
      selection: new Set(),
    };
    this.emit();
  }

  /**
   * Cmd/Ctrl-click in the rail: add or drop one slide without disturbing the
   * rest of the selection. Shift-click covers contiguous ranges; this is how
   * a scattered set of slides gets picked, and the rail's own commands
   * (delete, hide, duplicate) then act on all of them.
   */
  toggleSlideSelection(index: number): void {
    const clamped = Math.min(Math.max(index, 0), this.state.deck.slides.length - 1);
    const slide = this.state.deck.slides[clamped];
    if (!slide) return;
    const picked = !this.state.slideSelection.has(slide.id);
    // The selection never empties: unpicking the last slide would leave every
    // rail command with nothing to act on and no row looking current.
    if (!picked && this.state.slideSelection.size === 1) return;
    const slideSelection = new Set(this.state.slideSelection);
    if (picked) slideSelection.add(slide.id);
    else slideSelection.delete(slide.id);
    // Dropping the current slide hands "current" to the first row still
    // selected, so the canvas keeps showing something that is selected.
    const slideIndex = picked || clamped !== this.state.slideIndex
      ? clamped
      : this.state.deck.slides.findIndex((candidate) => slideSelection.has(candidate.id));
    this.slideSelectionAnchor = clamped;
    this.state = {
      ...this.state,
      slideIndex,
      slideSelection,
      selection: new Set(),
    };
    this.emit();
  }

  /** Select one contiguous rail range without first exposing either endpoint. */
  selectSlideRange(startIndex: number, endIndex: number): void {
    if (this.state.deck.slides.length === 0) return;
    const last = this.state.deck.slides.length - 1;
    const start = Math.min(Math.max(startIndex, 0), last);
    const end = Math.min(Math.max(endIndex, 0), last);
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    const slideSelection = new Set(
      this.state.deck.slides.slice(lo, hi + 1).map((slide) => slide.id),
    );
    this.slideSelectionAnchor = start;
    this.state = {
      ...this.state,
      slideIndex: end,
      slideSelection,
      selection: new Set(),
    };
    this.emit();
  }

  /**
   * Ctrl/Cmd+A in the slide rail. Selecting every slide is only meaningful
   * alongside an empty element selection -- the two selections are exclusive
   * everywhere else in the editor, and the rail's own commands read whichever
   * one is populated.
   */
  selectAllSlides(): void {
    const slides = this.state.deck.slides;
    if (slides.length === 0) return;
    this.slideSelectionAnchor = this.state.slideIndex;
    this.state = {
      ...this.state,
      slideSelection: new Set(slides.map((slide) => slide.id)),
      selection: new Set(),
    };
    this.emit();
  }

  /**
   * Ctrl/Cmd+A on the canvas: every element of the slide being edited.
   *
   * Layout-master copies are excluded. They are locked, derived state: they
   * draw no selection handles and take no pointer events, so including them
   * only let the next drag, delete or formatting click act on objects the
   * author cannot see selected -- and the next master sync then threw that
   * work away.
   */
  selectAllElements(): void {
    const slide = this.slide;
    if (!slide) return;
    this.select(slide.elements.filter((el) => !el.layoutMasterId).map((el) => el.id));
  }

  select(ids: string[], additive = false): void {
    const selection = additive ? new Set(this.state.selection) : new Set<string>();
    for (const id of ids) {
      if (additive && selection.has(id)) selection.delete(id);
      else selection.add(id);
    }
    const currentSlide = this.slide;
    this.slideSelectionAnchor = this.state.slideIndex;
    this.state = {
      ...this.state,
      slideSelection: new Set(currentSlide ? [currentSlide.id] : []),
      selection,
    };
    this.emit();
  }

  clearSelection(): void {
    const currentSlide = this.slide;
    const collapseRail = this.state.slideSelection.size > 1 && currentSlide;
    if (this.state.selection.size === 0 && !collapseRail) return;
    if (collapseRail) this.slideSelectionAnchor = this.state.slideIndex;
    this.state = {
      ...this.state,
      selection: new Set(),
      ...(collapseRail ? { slideSelection: new Set([currentSlide.id]) } : {}),
    };
    this.emit();
  }

  selectedElements(): SlideElement[] {
    const slide = this.slide;
    if (!slide) return [];
    return slide.elements.filter((e) => this.state.selection.has(e.id));
  }

  /**
   * Clone the selected objects and select the copies.
   *
   * The optional offset keeps Command-D's familiar nudge while allowing an
   * Option-drag to start its copies exactly on top of their sources.
   */
  duplicateSelection(offset = { x: 24, y: 24 }): string[] {
    const ids = this.state.selection;
    if (ids.size === 0) return [];
    const created: string[] = [];
    const index = this.state.slideIndex;
    this.commit((deck) => {
      const slide = deck.slides[index];
      for (const el of slide.elements.filter((candidate) => ids.has(candidate.id))) {
        const copy = structuredClone(el);
        copy.lineageId = el.lineageId ?? el.id;
        copy.morphId = null;
        copy.id = makeId(el.type);
        copy.x += offset.x;
        copy.y += offset.y;
        if (copy.type === 'shape' && copy.control) {
          copy.control.x += offset.x;
          copy.control.y += offset.y;
        }
        created.push(copy.id);
        slide.elements.push(copy);
      }
    }, { label: ids.size === 1 ? 'Duplicate object' : 'Duplicate objects' });
    this.select(created);
    return created;
  }

  /** Slides selected in the rail, returned in deck order. */
  selectedSlides(): Slide[] {
    return this.state.deck.slides.filter((slide) => this.state.slideSelection.has(slide.id));
  }

  /** Mutate every selected element on the current slide in one commit. */
  updateSelected(
    fn: (el: SlideElement) => void,
    opts: { history?: boolean; label?: string } = {},
  ): void {
    const ids = this.state.selection;
    if (ids.size === 0) return;
    const index = this.state.slideIndex;
    const previous = this.state.deck;
    const previousSlide = previous.slides[index];
    if (!previousSlide) return;

    // Pointer moves can call this dozens of times per second. The generic
    // commit path must isolate an arbitrary deck mutator, but this method's
    // contract is narrower: only selected elements may change. Copy just that
    // branch so a drag on one object never clones every slide in a large deck.
    const elements = previousSlide.elements.map((element) => {
      if (!ids.has(element.id)) return element;
      const next = structuredClone(element);
      fn(next);
      return next;
    });
    const slides = previous.slides.slice();
    slides[index] = { ...previousSlide, elements };
    this.finishCommit(previous, { ...previous, slides }, opts);
  }

  /** Remove the selected elements and any timeline entries that target them. */
  deleteSelection(): void {
    const ids = this.state.selection;
    if (ids.size === 0) return;
    const index = this.state.slideIndex;
    this.commit((deck) => {
      const slide = deck.slides[index];
      slide.elements = slide.elements.filter((e) => !ids.has(e.id));
      slide.timeline = slide.timeline.filter(
        (t) => !ids.has(t.action.target) && !(t.trigger.ref && ids.has(t.trigger.ref)),
      );
    }, { label: ids.size === 1 ? 'Delete object' : 'Delete objects' });
    this.clearSelection();
  }

  /** The current selection, minus ids `deck` no longer has anywhere. */
  private selectionWithin(deck: Deck): Set<string> {
    const selection = this.state.selection;
    if (selection.size === 0) return selection;
    const live = new Set(deck.slides.flatMap((slide) => slide.elements.map((e) => e.id)));
    const kept = [...selection].filter((id) => live.has(id));
    return kept.length === selection.size ? selection : new Set(kept);
  }

  /** Keep the slide index and selection valid after history moves. */
  private clampCursor(): void {
    const count = this.state.deck.slides.length;
    const slideIndex = Math.min(this.state.slideIndex, Math.max(0, count - 1));
    const live = new Set(
      (this.state.deck.slides[slideIndex]?.elements ?? []).map((e) => e.id),
    );
    const liveSlideIds = new Set(this.state.deck.slides.map((slide) => slide.id));
    const slideSelection = new Set(
      [...this.state.slideSelection].filter((id) => liveSlideIds.has(id)),
    );
    const currentSlide = this.state.deck.slides[slideIndex];
    if (slideSelection.size === 0 && currentSlide) slideSelection.add(currentSlide.id);
    this.slideSelectionAnchor = slideIndex;
    this.state = {
      ...this.state,
      slideIndex,
      slideSelection,
      selection: new Set([...this.state.selection].filter((id) => live.has(id))),
    };
  }

  private recordHistory(label: string, opts: RemoteHistoryOptions = {}): void {
    const last = this.historyLog[this.historyLog.length - 1];
    // Coalescing on the label alone folded two peers' edits to *different*
    // elements into one "Edit text (remote)" row — the panel then offered no
    // revision between them. A row only absorbs a change aimed at the same
    // targets it already holds.
    const incoming = this.historyTipDeck
      ? diffDecks(this.historyTipDeck, this.state.deck)
      : [];
    const sameTargets = last
      && (this.historyLog.length === 1
        || last.operations.length === 0
        || operationTargets(incoming) === operationTargets(last.operations));
    if (opts.coalesce && last && last.label === label && sameTargets) {
      const previousTip = this.historyTipDeck;
      last.at = Date.now();
      last.slideIndex = this.state.slideIndex;
      if (this.historyLog.length === 1) {
        // Coalescing the base row replaces its materialized state; it can never
        // carry operations because there is no preceding revision.
        this.historyBase = this.state.deck;
        this.historyBaseLag = [];
        this.historyBaseLagRows = 0;
        last.operations = [];
      } else if (previousTip) {
        last.operations.push(...incoming);
      }
      if (opts.description) last.description = opts.description;
      if (opts.agentChatId) last.agentChatId = opts.agentChatId;
      this.historyTipDeck = this.state.deck;
      this.currentHistoryId = last.id;
      this.emitHistory();
      this.onHistoryChange?.();
      return;
    }
    const operations = incoming;
    if (this.historyLog.length === 0) {
      this.historyBase = this.state.deck;
      this.historyBaseLag = [];
      this.historyBaseLagRows = 0;
    }
    this.historyLog.push({
      id: this.nextHistoryId++,
      label,
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.agentChatId ? { agentChatId: opts.agentChatId } : {}),
      ...(opts.group ? { group: opts.group } : {}),
      at: Date.now(),
      slideIndex: this.state.slideIndex,
      operations,
    });
    this.historyTipDeck = this.state.deck;
    if (this.historyLog.length > HISTORY_LIMIT) {
      const nextBase = this.historyLog[1];
      if (this.historyBase && nextBase) {
        this.historyBaseLag.push(...nextBase.operations);
        this.historyBaseLagRows += 1;
        nextBase.operations = [];
      }
      this.historyLog.shift();
      if (this.historyBaseLagRows >= HISTORY_FOLD_BATCH) this.foldHistoryBase();
    }
    this.currentHistoryId = this.historyLog[this.historyLog.length - 1]?.id ?? null;
    this.emitHistory();
    this.onHistoryChange?.();
  }

  /** Apply trimmed rows' operations to the history base (see historyBaseLag). */
  private foldHistoryBase(): void {
    if (this.historyBase && this.historyBaseLag.length > 0) {
      this.historyBase = applyAgentOperations(this.historyBase, this.historyBaseLag);
    }
    this.historyBaseLag = [];
    this.historyBaseLagRows = 0;
  }

  /** Materialize one persisted revision with a single clone/apply boundary. */
  private materializeHistoryIndex(index: number): Deck | null {
    if (!this.historyBase || index < 0 || index >= this.historyLog.length) return null;
    const operations = [
      ...this.historyBaseLag,
      ...this.historyLog.slice(1, index + 1).flatMap((entry) => entry.operations),
    ];
    return operations.length > 0
      ? applyAgentOperations(this.historyBase, operations)
      : this.historyBase;
  }
}

function sameDeck(left: Deck, right: Deck): boolean {
  return left === right || jsonEqual(left, right);
}

/** Whether two objects hold the same keys with identical (===) values. */
function sameValues(left: object, right: object): boolean {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

/**
 * Whether two slides draw the same picture: everything but the speaker notes
 * and the comment threads (on the slide and on its objects) agrees. Typing in
 * the notes drawer commits a fresh slide object per keystroke, a reply to a
 * comment one per post, and views that only paint the slide must not treat
 * either as a change worth rebuilding for: rebuilding the box a collaborator
 * is typing in, because someone commented on it, would take their caret.
 */
export function sameSlideDrawing(left: Slide, right: Slide): boolean {
  if (left === right) return true;
  if (!jsonEqual(left, right, ['notes', 'comments', 'elements'])) return false;
  if (left.elements.length !== right.elements.length) return false;
  return left.elements.every((element, i) =>
    element === right.elements[i] || jsonEqual(element, right.elements[i], ['comments']));
}

/** Whether two decks differ in nothing but their slides' speaker notes and comments. */
export function sameDeckDrawing(left: Deck, right: Deck): boolean {
  if (left === right) return true;
  if (left.slides.length !== right.slides.length) return false;
  for (let i = 0; i < left.slides.length; i++) {
    if (!sameSlideDrawing(left.slides[i], right.slides[i])) return false;
  }
  return jsonEqual(left, right, ['slides']);
}

/** A stable signature of what a run of operations touches, for coalescing. */
function operationTargets(operations: AgentOperation[]): string {
  const ids = new Set<string>();
  for (const operation of operations) {
    if (operation.op === 'updateComments') ids.add(`comments:${operation.elementId ?? operation.slideId}`);
    else if ('elementId' in operation) ids.add(operation.elementId);
    else if ('elementIds' in operation) for (const id of operation.elementIds) ids.add(id);
    else if ('slideId' in operation) ids.add(`slide:${operation.slideId}`);
    else ids.add(`deck:${operation.op}`);
  }
  return [...ids].sort().join(',');
}

/**
 * Restore object identity for whatever an edit did not touch.
 *
 * `commit` deliberately gives mutation callbacks a fully independent copy,
 * and a remote deck arrives as objects the store has not seen, but the
 * canvas and slide rail use slide identity to retain expensive DOM and
 * decoded media. Without this reconciliation, changing one layout in a large
 * imported deck rebuilds every thumbnail and can exhaust the renderer.
 *
 * Returns `next` with identity restored from `previous` wherever content
 * agrees: a slide equal to the previous slide of the same id becomes that
 * object; in a slide that did change, each unchanged element (by id) becomes
 * the previous element; deck properties likewise. `next` itself is never
 * mutated — a copy is made only where something is re-shared — so it may be
 * a deck another owner holds (the collab bridge's shadow).
 *
 * Comparisons short-circuit on identity at every level, so reconciling two
 * decks that already share most slides costs only what differs.
 */
export function reshareDeck(previous: Deck, next: Deck): Deck {
  if (previous === next) return next;
  const byId = new Map(previous.slides.map((slide) => [slide.id, slide]));
  let slides: Slide[] | null = null;
  for (let i = 0; i < next.slides.length; i++) {
    const slide = next.slides[i];
    const before = byId.get(slide.id);
    if (!before || before === slide) continue;
    const shared = reshareSlide(before, slide);
    if (shared === slide) continue;
    slides ??= next.slides.slice();
    slides[i] = shared;
  }
  let props: Record<string, unknown> | null = null;
  const after = next as unknown as Record<string, unknown>;
  const prior = previous as unknown as Record<string, unknown>;
  for (const key of Object.keys(after)) {
    if (key === 'slides') continue;
    const value = after[key];
    if (value === prior[key] || typeof value !== 'object' || value === null) continue;
    if (!jsonEqual(value, prior[key])) continue;
    props ??= {};
    props[key] = prior[key];
  }
  if (!slides && !props) return next;
  return { ...next, ...props, slides: slides ?? next.slides } as Deck;
}

function reshareSlide(before: Slide, slide: Slide): Slide {
  if (before === slide || jsonEqual(before, slide)) return before;
  const byId = new Map(before.elements.map((element) => [element.id, element]));
  let elements: SlideElement[] | null = null;
  for (let i = 0; i < slide.elements.length; i++) {
    const element = slide.elements[i];
    const prior = byId.get(element.id);
    if (!prior || prior === element || !jsonEqual(prior, element)) continue;
    elements ??= slide.elements.slice();
    elements[i] = prior;
  }
  return elements ? { ...slide, elements } : slide;
}

/**
 * Copy and paste, backed by the OS pasteboard.
 *
 * The payload crosses the system clipboard (via the main process) so that a
 * second running instance of the app can paste it into another deck; assets
 * are re-imported and ids re-minted on the way in. The module-level fallback
 * keeps copy/paste working when no system clipboard is reachable — a deck
 * that isn't open as a session yet, or tests without a preload bridge.
 */
let fallbackClipboard: ClipboardWriteRequest | null = null;

/**
 * Without a pasteboard bridge (the browser client), the in-app payload never
 * reaches the OS clipboard — so on paste there was no telling whether the
 * image sitting there was copied after the slide or long before it, and the
 * image always won. Each in-app copy therefore leaves a token as the OS
 * clipboard's plain text: while that text is still there, nothing newer was
 * copied and the in-app payload is what the author means to paste. Anything
 * copied later replaces the text, and the OS content wins again.
 */
export const IN_APP_CLIPBOARD_TOKEN_PREFIX = 'deckwerk-clipboard:';
let fallbackClipboardToken: string | null = null;

/** The token the last in-app copy wrote, or null if nothing was copied. */
export function inAppClipboardToken(): string | null {
  return fallbackClipboardToken;
}

/** Does this clipboard text say the in-app payload is the newest copy? */
export function isInAppClipboardToken(text: string | null | undefined): boolean {
  return Boolean(fallbackClipboardToken && fallbackClipboard && text?.trim() === fallbackClipboardToken);
}

async function writeSystemClipboard(request: ClipboardWriteRequest): Promise<void> {
  fallbackClipboard = request;
  fallbackClipboardToken = `${IN_APP_CLIPBOARD_TOKEN_PREFIX}${Math.random().toString(36).slice(2)}`;
  try {
    if (typeof window !== 'undefined' && window.api?.writeClipboard) {
      await window.api.writeClipboard(request);
    } else if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      // Secure origins only; on plain HTTP the `copy` event in shellWiring
      // writes the same token.
      await navigator.clipboard.writeText(fallbackClipboardToken);
    }
  } catch (err) {
    console.error('Could not write the system clipboard:', err);
  }
}

async function readSystemClipboard(): Promise<ClipboardReadResult | ClipboardWriteRequest | null> {
  if (typeof window !== 'undefined' && window.api?.readClipboard) {
    try {
      const payload = await window.api.readClipboard();
      if (payload) return payload;
    } catch (err) {
      console.error('Could not read the system clipboard:', err);
    }
  } else if (typeof navigator !== 'undefined' && navigator.clipboard?.read) {
    try {
      let html = '';
      let text = '';
      let image: Blob | null = null;
      for (const item of await navigator.clipboard.read()) {
        if (!html && item.types.includes('text/html')) {
          html = await (await item.getType('text/html')).text();
        }
        if (!text && item.types.includes('text/plain')) {
          text = await (await item.getType('text/plain')).text();
        }
        if (!image && item.types.includes('image/png')) {
          image = await item.getType('image/png');
        }
      }
      if (isInAppClipboardToken(text)) return fallbackClipboard;
      if (/<table\b/i.test(html) || text.includes('\t')) {
        return { kind: 'external-html', html, text };
      }
      if (image && window.api.importAssetFiles) {
        const [asset] = await window.api.importAssetFiles([
          new File([image], 'Screenshot.png', { type: 'image/png' }),
        ]);
        if (asset) return { kind: 'external-image', asset };
      }
    } catch (err) {
      console.error('Could not read the browser clipboard:', err);
    }
  }
  return fallbackClipboard;
}

/**
 * How far a paste is nudged when the copy would otherwise land exactly on top
 * of something the author is already looking at.
 */
const PASTE_OFFSET = 24;

export async function copySelectionToClipboard(store: EditorStore): Promise<number> {
  const els = store.selectedElements();
  if (els.length === 0) return 0;
  const ids = new Set(els.map((e) => e.id));
  // Builds ride along: an element that appears on click should still appear
  // on click after the paste. Entries triggered by elements staying behind
  // keep their action; the dangling ref is nulled during id remapping.
  const timeline = (store.slide?.timeline ?? []).filter((t) => ids.has(t.action.target));
  await writeSystemClipboard({
    kind: 'elements',
    elements: structuredClone(els),
    timeline: structuredClone(timeline),
    sourceSlideId: store.slide?.id ?? null,
  });
  return els.length;
}

export async function cutSelectionToClipboard(store: EditorStore): Promise<number> {
  const n = await copySelectionToClipboard(store);
  if (n > 0) store.deleteSelection();
  return n;
}

/** Copy whole slides (the rail selection, in deck order). */
export async function copySlidesToClipboard(store: EditorStore, currentThemeCss?: string): Promise<number> {
  const slides = store.selectedSlides();
  if (slides.length === 0) return 0;
  const { deck, dir } = store.get();
  await writeSystemClipboard({
    kind: 'slides',
    slides: structuredClone(slides),
    sourceDeckId: dir,
    sourceThemeStyle: structuredClone(effectiveThemeStyle(deck, currentThemeCss)),
  });
  return slides.length;
}

export type SlidePasteThemeChoice = 'source' | 'destination';

export interface PasteOptions {
  destinationThemeCss?: string;
  chooseSlideTheme?: (details: {
    count: number;
    source: ReturnType<typeof effectiveThemeStyle>;
    destination: ReturnType<typeof effectiveThemeStyle>;
  }) => Promise<SlidePasteThemeChoice | null>;
}

/**
 * Paste whatever fragment is on the clipboard: elements land on the current
 * slide, slides land after it. Returns a summary for the status bar, or null
 * when the clipboard holds nothing of ours.
 */
export async function pasteFromClipboard(
  store: EditorStore,
  providedPayload?: ClipboardReadResult | ClipboardWriteRequest | null,
  options: PasteOptions = {},
): Promise<{ kind: 'elements' | 'slides'; count: number } | null> {
  const payload = providedPayload ?? await readSystemClipboard();
  if (!payload) return null;

  if (payload.kind === 'external-image') {
    return insertClipboardMedia(store, payload.asset);
  }

  if (payload.kind === 'external-html') {
    const table = pastedTableData(payload.html, payload.text);
    if (!table) return null;
    const id = makeId('table');
    store.commit((deck) => {
      const slide = deck.slides[store.get().slideIndex];
      if (!slide) return;
      const w = Math.min(Math.max(360, table.columnWidths.length * 260), deck.canvas.w - 160);
      const naturalH = Math.max(72, table.rows * 72);
      const h = Math.min(naturalH, deck.canvas.h - 160);
      slide.elements.push({
        id,
        type: 'text',
        x: (deck.canvas.w - w) / 2,
        y: (deck.canvas.h - h) / 2,
        w,
        h,
        rot: 0,
        z: slide.elements.reduce((max, element) => Math.max(max, element.z), 0) + 1,
        opacity: 1,
        class: ['role-body'],
        style: {},
        html: table.html,
        align: 'left',
        valign: 'top',
        // Ordinary tables grow their rows instead of shrinking the type. Very
        // tall pasted ranges use the existing uniform font fit as a fallback.
        autoFit: naturalH > h,
        table: {
          columnWidths: table.columnWidths,
          autoHeight: true,
        },
      });
    }, { label: 'Paste table' });
    store.select([id]);
    return { kind: 'elements', count: 1 };
  }

  if (payload.kind === 'slides') {
    const slides = structuredClone(payload.slides);
    const destination = effectiveThemeStyle(store.get().deck, options.destinationThemeCss);
    const source = payload.sourceThemeStyle;
    const crossDeck = payload.sourceDeckId != null
      && store.get().dir !== null
      && payload.sourceDeckId !== store.get().dir;
    if (crossDeck && source && slideThemeStylesDiffer(source, destination)) {
      const choice = options.chooseSlideTheme
        ? await options.chooseSlideTheme({ count: slides.length, source, destination })
        : 'destination';
      if (choice === null) return null;
      if (choice === 'source') pinSlidesToTheme(slides, source);
    }
    for (const slide of slides) remapSlideIds(slide);
    const at = store.get().slideIndex + 1;
    store.commit((deck) => {
      deck.slides.splice(at, 0, ...slides);
    }, { label: slides.length === 1 ? 'Paste slide' : `Paste ${slides.length} slides` });
    store.selectSlide(at + slides.length - 1);
    return { kind: 'slides', count: slides.length };
  }

  const elements = structuredClone(payload.elements);
  const timeline = structuredClone(payload.timeline);

  /*
   * Position, as in Figma: a paste lands exactly where the elements were
   * copied from unless that spot is taken. Onto another slide, or after the
   * original was deleted or cut, it keeps the layout the author composed;
   * over the original (or an earlier paste) it steps down and right until it
   * reaches a free spot, so repeated pastes cascade instead of stacking.
   */
  const occupied = (store.slide?.elements ?? []).map((el) => `${el.type}:${el.x},${el.y},${el.w},${el.h}`);
  const taken = new Set(occupied);
  const collides = (offset: number) => elements.some((el) =>
    taken.has(`${el.type}:${el.x + offset},${el.y + offset},${el.w},${el.h}`));
  let nudge = 0;
  for (let step = 0; step < 100 && collides(nudge); step++) nudge += PASTE_OFFSET;

  remapElementIds(elements, timeline);
  const created = elements.map((el) => el.id);
  store.commit((deck) => {
    const slide = deck.slides[store.get().slideIndex];
    if (!slide) return;
    const maxZ = slide.elements.reduce((m, e) => Math.max(m, e.z), 0);
    elements.forEach((el, i) => {
      el.x += nudge;
      el.y += nudge;
      if (el.type === 'shape' && el.control) {
        el.control.x += nudge;
        el.control.y += nudge;
      }
      el.z = maxZ + 1 + i;
      slide.elements.push(el);
    });
    slide.timeline.push(...timeline);
  }, { label: elements.length === 1 ? 'Paste object' : `Paste ${elements.length} objects` });
  store.select(created);
  return { kind: 'elements', count: elements.length };
}

/**
 * Paste what was last copied inside this window, bypassing the system
 * clipboard. The Web UI has no pasteboard bridge: Cmd+C parks the selection
 * in the module-level fallback, and Cmd+V arrives as a native paste event
 * whose clipboardData holds nothing of ours. When that event carries neither
 * a table nor an image, this is what "paste" means.
 */
export async function pasteInAppClipboard(
  store: EditorStore,
  options: PasteOptions = {},
): Promise<{ kind: 'elements' | 'slides'; count: number } | null> {
  if (!fallbackClipboard) return null;
  return pasteFromClipboard(store, fallbackClipboard, options);
}

/** Native browser paste events expose image bytes even on plain HTTP origins,
 * where `navigator.clipboard.read()` is unavailable. Upload those bytes using
 * the same collaboration asset bridge as drag-and-drop.
 *
 * A file copied in the file manager arrives the same way, as a File carrying
 * its own name -- and that may be a video as well as an image. */
export async function pasteMediaFilesFromClipboard(
  store: EditorStore,
  files: File[],
): Promise<{ kind: 'elements'; count: number } | null> {
  // A screenshot arrives as PNG, but copying a photo out of a page or a file
  // manager can hand over any format the importer accepts — including the
  // ones it has to re-encode. Matching PNG alone dropped those pastes with no
  // element and no error.
  const media = files.find((file) => clipboardMediaName(file) !== null);
  if (!media || !window.api.importAssetFiles) return null;
  const name = clipboardMediaName(media) as string;
  const [asset] = await window.api.importAssetFiles([
    // The name is what tells the importer which format this is, so it has to
    // survive the hand-off; the bytes are re-wrapped only to rename them.
    new File([media], name, { type: media.type }),
  ]);
  return asset ? insertClipboardMedia(store, asset) : null;
}

/** The name to import a pasted file under: a video keeps its own name. */
function clipboardMediaName(file: { name: string; type: string }): string | null {
  if (classifyMediaName(file.name) === 'video') return file.name;
  return clipboardImageName(file);
}

/**
 * The name to import a pasted file under, or null if it isn't an image.
 *
 * Chromium names a screenshot `image.png`, so the extension is the only
 * reliable signal; a clipboard file with no usable name but an image MIME
 * type still imports, under a name derived from the type.
 */
export function clipboardImageName(file: { name: string; type: string }): string | null {
  // Chromium's placeholder name for clipboard bytes: the same screenshot is
  // `Screenshot.png` through the OS clipboard, and the asset should not be
  // called something different depending on which paste path caught it.
  const generic = /^image(\.[a-z0-9]+)$/i.exec(file.name);
  if (generic && classifyMediaName(file.name) === 'image') return `Screenshot${generic[1].toLowerCase()}`;
  if (classifyMediaName(file.name) === 'image') return file.name;
  if (!file.type.startsWith('image/')) return null;
  const ext = file.type.slice('image/'.length).split('+')[0].toLowerCase();
  const name = `Screenshot.${ext === 'jpeg' ? 'jpg' : ext}`;
  return classifyMediaName(name) === 'image' ? name : null;
}

function insertClipboardMedia(
  store: EditorStore,
  asset: Extract<ClipboardReadResult, { kind: 'external-image' }>['asset'],
): { kind: 'elements'; count: number } {
  const id = makeId(asset.kind);
  store.commit((deck) => {
    const slide = deck.slides[store.get().slideIndex];
    if (!slide) return;
    const naturalW = asset.width ?? 1600;
    const naturalH = asset.height ?? 900;
    const scale = Math.min(
      1,
      (deck.canvas.w * 0.8) / naturalW,
      (deck.canvas.h * 0.8) / naturalH,
    );
    const w = Math.round(naturalW * scale);
    const h = Math.round(naturalH * scale);
    const base = {
      id,
      x: Math.round((deck.canvas.w - w) / 2),
      y: Math.round((deck.canvas.h - h) / 2),
      w,
      h,
      rot: 0,
      z: slide.elements.reduce((max, element) => Math.max(max, element.z), 0) + 1,
      opacity: 1,
      class: [],
      style: {},
      src: asset.src,
      fit: 'contain' as const,
      sourceBox: null,
    };
    // Same defaults as a video dropped onto the slide.
    slide.elements.push(asset.kind === 'video'
      ? {
          ...base,
          type: 'video',
          autoplay: true,
          loop: true,
          muted: true,
          controls: false,
          start: 0,
          end: null,
          poster: null,
        }
      : { ...base, type: 'image', alt: 'Pasted screenshot' });
  }, { label: asset.kind === 'video' ? 'Paste video' : 'Paste screenshot' });
  store.select([id]);
  return { kind: 'elements', count: 1 };
}

export function deckFrom(raw: unknown): Deck {
  return parseDeck(raw);
}
