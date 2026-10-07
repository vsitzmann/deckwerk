import type { AgentOperation } from './agent.js';
import type { Deck, Slide, SlideElement } from './deck.js';
import { diffDecks } from './deckDiff.js';
import { slideTitle } from './deckDigest.js';

/**
 * The edit log: who changed a hosted deck, when, and what went — beside
 * deck.json as `history.jsonl`, one JSON object per accepted change,
 * append-only.
 *
 * It exists so a slide that vanishes can be traced and put back. Every
 * transaction the collaboration server accepts is a line: its time, its seq,
 * its author (the name everyone saw, and on an access-controlled server the
 * login it was admitted under), whether an agent sent it, its label, and what
 * it did — counts per operation, the ids of slides inserted, moved and
 * changed, and for every slide or object it deleted the complete JSON it had
 * just before, so a deletion can always be undone from the log alone.
 * Replacements carry ids only: they are the most frequent operation and can
 * be large. A deck replaced wholesale (deck.json written on disk behind the
 * server) is a line too, summarised as the difference it made.
 *
 * It is not the History panel (which lives in each client and is undoable),
 * not part of the deck, and never mirrored to agents or served to viewers.
 * The server rotates it to `history.1.jsonl` past HISTORY_ROTATE_BYTES, so
 * the two files hold the most recent 20–40 MB of edits.
 */

export const HISTORY_FILE = 'history.jsonl';
export const HISTORY_ROTATED_FILE = 'history.1.jsonl';
/** Every file the log may occupy in a deck folder. */
export const HISTORY_FILES: readonly string[] = [HISTORY_FILE, HISTORY_ROTATED_FILE];
export const HISTORY_ROTATE_BYTES = 20 * 1024 * 1024;

export interface EditAuthor {
  /** The display name the room saw ("Vincent", "Vincent · agent", "Agent"). */
  name: string;
  /** The identity access control admitted the request under, when it is on. */
  login?: string;
  /** The WebSocket peer's id for this connection. */
  clientId?: string;
  /** Sent by an agent: a `slide-agent connect` bridge or the HTTP agent API. */
  agent: boolean;
  /**
   * The door it came through: `socket` (a peer on the session), `http` (an
   * HTTP route — the agent mirror's verbs, comments, the agent API), `disk`
   * (deck.json written behind the server), `server` (the server's own doing).
   */
  via: 'socket' | 'http' | 'disk' | 'server';
  /** For a bridge: the browser participant whose agent it is. */
  agentFor?: string;
}

export interface DeletedSlideRecord {
  id: string;
  /** Its 1-based number in the deck just before the change. */
  number: number;
  title: string;
  slide: Slide;
}

export interface DeletedElementRecord {
  slideId: string;
  id: string;
  type: string;
  element: SlideElement;
}

export interface EditHistoryEntry {
  ts: string;
  /** The session's seq after this change (restarts at 0 when the server opens the deck). */
  seq: number;
  /** `txn`: a transaction. `replace`: the whole deck replaced from disk. */
  kind: 'txn' | 'replace';
  label: string;
  author: EditAuthor;
  txnId?: string;
  /** How many operations of each type the change carried. */
  ops: Record<string, number>;
  /** Operations the server skipped (their target was gone). */
  skipped?: number;
  /** Every operation was skipped: the deck did not change. */
  noop?: true;
  slides?: {
    inserted?: string[];
    deleted?: DeletedSlideRecord[];
    moved?: string[];
    /** Slides whose properties or objects changed. */
    changed?: string[];
  };
  elements?: {
    inserted?: string[];
    replaced?: string[];
    deleted?: DeletedElementRecord[];
  };
  /** Slides in the deck after the change. */
  slideCount: number;
}

type SlideOp = Extract<AgentOperation, { slideId: string }>;

/**
 * What a change did, from the deck before and after it and the operations
 * that made it. Deleted slides and objects are read from `before` — whatever
 * an operation said, what was lost is what `before` had and `after` lacks.
 */
export function summarizeChange(
  before: Deck,
  after: Deck,
  ops: AgentOperation[],
  skipped: ReadonlyArray<{ op: AgentOperation }> = [],
): Pick<EditHistoryEntry, 'ops' | 'skipped' | 'noop' | 'slides' | 'elements' | 'slideCount'> {
  const counts: Record<string, number> = {};
  for (const op of ops) counts[op.op] = (counts[op.op] ?? 0) + 1;
  const skippedOps = new Set(skipped.map((entry) => entry.op));
  const afterSlides = new Map(after.slides.map((slide) => [slide.id, slide]));
  const beforeIds = new Set(before.slides.map((slide) => slide.id));

  const deletedSlides: DeletedSlideRecord[] = [];
  before.slides.forEach((slide, index) => {
    if (!afterSlides.has(slide.id)) deletedSlides.push({ id: slide.id, number: index + 1, title: slideTitle(slide), slide });
  });
  const insertedSlides = after.slides.filter((slide) => !beforeIds.has(slide.id)).map((slide) => slide.id);
  const moved = unique(ops.flatMap((op) => (op.op === 'moveSlide' && !skippedOps.has(op) && afterSlides.has(op.slideId)
    ? [op.slideId] : [])));

  // Objects can go by deleteElements or by a replaceSlide that leaves them
  // out: compare every surviving slide an operation touched.
  const touched = unique(ops.flatMap((op) => ('slideId' in op && op.op !== 'deleteSlide' && op.op !== 'moveSlide'
    && !skippedOps.has(op) ? [(op as SlideOp).slideId] : [])));
  const beforeSlides = new Map(before.slides.map((slide) => [slide.id, slide]));
  const deletedElements: DeletedElementRecord[] = [];
  const insertedElements: string[] = [];
  const changed: string[] = [];
  for (const id of touched) {
    const was = beforeSlides.get(id);
    const is = afterSlides.get(id);
    if (!was || !is) continue;
    changed.push(id);
    const now = new Set(is.elements.map((element) => element.id));
    const then = new Set(was.elements.map((element) => element.id));
    for (const element of was.elements) {
      if (!now.has(element.id)) deletedElements.push({ slideId: id, id: element.id, type: element.type, element });
    }
    for (const element of is.elements) if (!then.has(element.id)) insertedElements.push(element.id);
  }
  const replaced = unique(ops.flatMap((op) => (op.op === 'replaceElement' && !skippedOps.has(op) ? [op.elementId] : [])));

  const slides = compact({
    inserted: insertedSlides,
    deleted: deletedSlides,
    moved,
    changed,
  });
  const elements = compact({ inserted: insertedElements, replaced, deleted: deletedElements });
  return {
    ops: counts,
    ...(skipped.length > 0 ? { skipped: skipped.length } : {}),
    ...(ops.length > 0 && skipped.length >= ops.length ? { noop: true as const } : {}),
    ...(slides ? { slides } : {}),
    ...(elements ? { elements } : {}),
    slideCount: after.slides.length,
  };
}

/** A whole deck replaced by another: summarised as the difference between them. */
export function summarizeReplacement(before: Deck, after: Deck): ReturnType<typeof summarizeChange> {
  return summarizeChange(before, after, diffDecks(before, after));
}

/** Parse the log's lines, oldest first; a torn or hand-mangled line is skipped. */
export function parseEditHistory(text: string): EditHistoryEntry[] {
  const entries: EditHistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as EditHistoryEntry;
      if (entry && typeof entry.ts === 'string' && typeof entry.seq === 'number') entries.push(entry);
    } catch {
      // A torn last line (a crash mid-append); keep the rest.
    }
  }
  return entries;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compact<T extends Record<string, unknown[]>>(lists: T): Partial<T> | null {
  const kept = Object.fromEntries(Object.entries(lists).filter(([, list]) => list.length > 0)) as Partial<T>;
  return Object.keys(kept).length > 0 ? kept : null;
}
