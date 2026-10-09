import type { AgentOperation } from './agent.js';
import type { Comment, Deck, Slide, SlideElement } from './deck.js';

/**
 * Comment threads on slides and objects.
 *
 * Comments are stored where they point (`comments` on a slide or an element)
 * but they are review state, not content, and three rules keep them apart
 * from the edits around them:
 *
 * - They change only through `updateComments`, which carries the list it was
 *   made from and merges by comment id (`mergeComments`). Two people replying
 *   to one thread at once both land, and nobody's drag, retype or slide edit
 *   can carry a stale copy of a thread over a newer one: `replaceElement`,
 *   `replaceSlide` and `setSlideProperties` leave the target's comments as
 *   they are (`keepComments`).
 * - `diffDecks` states a comment change as `updateComments` and never inside
 *   a content op, so the rules above hold for every edit made in the editor.
 * - Undo, redo and History never move them (`withoutCommentOps`,
 *   `carryComments`): undoing a text edit must not take back the reply that
 *   came after it.
 */

/** A root comment and its replies, oldest first. */
export interface CommentThread {
  root: Comment;
  replies: Comment[];
}

/** What a thread hangs on: a slide, or one object on it. */
export interface CommentTarget {
  slideId: string;
  elementId?: string;
}

/**
 * Group a flat comment list into threads, in the order their roots appear. A
 * reply whose root is gone (deleted by someone else, or a hand-edited file)
 * becomes a thread of its own rather than disappearing.
 */
export function commentThreads(comments: readonly Comment[] | undefined): CommentThread[] {
  const list = comments ?? [];
  const ids = new Set(list.map((comment) => comment.id));
  const threads = new Map<string, CommentThread>();
  for (const comment of list) {
    if (comment.parentId && ids.has(comment.parentId)) continue;
    threads.set(comment.id, { root: comment, replies: [] });
  }
  for (const comment of list) {
    if (!comment.parentId) continue;
    threads.get(comment.parentId)?.replies.push(comment);
  }
  for (const thread of threads.values()) {
    thread.replies.sort((a, b) => a.ts.localeCompare(b.ts));
  }
  return [...threads.values()];
}

/** Open (unresolved) threads in a comment list. */
export function openThreadCount(comments: readonly Comment[] | undefined): number {
  return commentThreads(comments).filter((thread) => !thread.root.resolved).length;
}

/** Whether a slide, or anything on it, carries an open thread. */
export function slideHasOpenComments(slide: Slide): boolean {
  return openThreadCount(slide.comments) > 0
    || slide.elements.some((element) => openThreadCount(element.comments) > 0);
}

/** Where a comment lives, by its id or the id of any message in its thread. */
export function findComment(deck: Deck, commentId: string): {
  target: CommentTarget;
  slideIndex: number;
  thread: CommentThread;
} | null {
  for (let slideIndex = 0; slideIndex < deck.slides.length; slideIndex++) {
    const slide = deck.slides[slideIndex];
    const hit = (comments: Comment[] | undefined) =>
      commentThreads(comments).find((thread) =>
        thread.root.id === commentId || thread.replies.some((reply) => reply.id === commentId));
    const onSlide = hit(slide.comments);
    if (onSlide) return { target: { slideId: slide.id }, slideIndex, thread: onSlide };
    for (const element of slide.elements) {
      const onElement = hit(element.comments);
      if (onElement) return { target: { slideId: slide.id, elementId: element.id }, slideIndex, thread: onElement };
    }
  }
  return null;
}

/** The comment list a target carries now; empty when the target is gone. */
export function commentsAt(deck: Deck, target: CommentTarget): Comment[] {
  const slide = deck.slides.find((candidate) => candidate.id === target.slideId);
  if (!slide) return [];
  if (!target.elementId) return slide.comments ?? [];
  return slide.elements.find((element) => element.id === target.elementId)?.comments ?? [];
}

/**
 * Three-way merge of a comment list by id. `base` is what the writer saw and
 * `next` what it wants; `current` is what the target holds now, which may
 * carry comments somebody else added or changed in between. A comment the
 * writer added is added (once), one it removed is removed, one it changed
 * takes its version, and everything else stays as `current` has it.
 */
export function mergeComments(
  current: readonly Comment[],
  base: readonly Comment[],
  next: readonly Comment[],
): Comment[] {
  const baseById = new Map(base.map((comment) => [comment.id, comment]));
  const nextById = new Map(next.map((comment) => [comment.id, comment]));
  const out: Comment[] = [];
  const seen = new Set<string>();
  for (const comment of current) {
    seen.add(comment.id);
    const before = baseById.get(comment.id);
    const after = nextById.get(comment.id);
    if (before && !after) continue; // removed by the writer
    if (before && after && JSON.stringify(before) !== JSON.stringify(after)) {
      out.push(structuredClone(after));
      continue;
    }
    out.push(comment);
  }
  for (const comment of next) {
    if (seen.has(comment.id) || baseById.has(comment.id)) continue;
    out.push(structuredClone(comment));
  }
  return out;
}

/** `comments` set, or the key removed when the list is empty. */
export function setComments<T extends { comments?: Comment[] }>(target: T, comments: Comment[]): void {
  if (comments.length) target.comments = comments;
  else delete target.comments;
}

/**
 * A replacement of a slide or an element as it should land: everything from
 * the replacement except its comments, which stay as the target has them.
 */
export function keepComments<T extends { comments?: Comment[] }>(replacement: T, current: { comments?: Comment[] } | undefined): T {
  const next = { ...replacement };
  setComments(next, current?.comments ?? []);
  return next;
}

/** A slide replacement that keeps the slide's comments and those of every object that survives it. */
export function keepSlideComments(replacement: Slide, current: Slide): Slide {
  const before = new Map(current.elements.map((element) => [element.id, element]));
  return {
    ...keepComments(replacement, current),
    elements: replacement.elements.map((element) => keepComments(element, before.get(element.id))),
  };
}

/** An element without its comments, for comparing content alone. */
export function contentOf<T extends { comments?: Comment[] }>(value: T): Omit<T, 'comments'> {
  const { comments: _comments, ...rest } = value;
  return rest;
}

/** Undo and redo replay content only; comment changes are not undoable edits. */
export function withoutCommentOps<T extends { op: string }>(ops: T[]): T[] {
  return ops.filter((op) => op.op !== 'updateComments');
}

/**
 * `into` with every surviving slide and object carrying the comments it has in
 * `from`. Restoring an older version of the deck brings back its content,
 * never the review state it had then.
 */
export function carryComments(from: Deck, into: Deck): Deck {
  const slides = new Map(from.slides.map((slide) => [slide.id, slide]));
  const elements = new Map<string, SlideElement>();
  for (const slide of from.slides) for (const element of slide.elements) elements.set(element.id, element);
  return {
    ...into,
    slides: into.slides.map((slide) => {
      const now = slides.get(slide.id);
      const carried = now ? keepComments(slide, now) : slide;
      return {
        ...carried,
        elements: slide.elements.map((element) => {
          const live = elements.get(element.id);
          return live ? keepComments(element, live) : element;
        }),
      };
    }),
  };
}

/**
 * The `updateComments` operation that applies `change` to the comments a
 * target holds now, or null when it changes nothing.
 */
export function commentsOperation(
  deck: Deck,
  target: CommentTarget,
  change: (comments: Comment[]) => Comment[],
): AgentOperation | null {
  const base = commentsAt(deck, target);
  const comments = change(structuredClone(base));
  if (JSON.stringify(base) === JSON.stringify(comments)) return null;
  return {
    op: 'updateComments',
    slideId: target.slideId,
    ...(target.elementId ? { elementId: target.elementId } : {}),
    base: structuredClone(base),
    comments,
  };
}

/** The id of the thread a comment belongs to (its root's id). */
export function threadIdOf(comments: readonly Comment[], commentId: string): string | null {
  const comment = comments.find((candidate) => candidate.id === commentId);
  if (!comment) return null;
  if (comment.parentId && comments.some((candidate) => candidate.id === comment.parentId)) return comment.parentId;
  return comment.id;
}

/**
 * The edits a thread supports, as pure functions of a target's comment list.
 * The editor, the server's HTTP API and the CLI all go through these, so a
 * reply means the same thing wherever it is made.
 */
export const threadEdits = {
  /** A new thread. */
  start(comments: Comment[], comment: Comment): Comment[] {
    const { parentId: _parentId, ...root } = comment;
    return [...comments, { ...root, resolved: false }];
  },
  /** A reply to the thread holding `commentId`; replying reopens a resolved thread. */
  reply(comments: Comment[], commentId: string, comment: Comment): Comment[] {
    const rootId = threadIdOf(comments, commentId);
    if (!rootId) return comments;
    return [
      ...comments.map((candidate) => (candidate.id === rootId && candidate.resolved
        ? withoutResolution(candidate)
        : candidate)),
      { ...comment, parentId: rootId, resolved: false },
    ];
  },
  /** Resolve or reopen the thread holding `commentId`. */
  resolve(comments: Comment[], commentId: string, resolved: boolean, by?: string): Comment[] {
    const rootId = threadIdOf(comments, commentId);
    return comments.map((candidate) => {
      if (candidate.id !== rootId) return candidate;
      if (!resolved) return withoutResolution(candidate);
      return { ...candidate, resolved: true, ...(by ? { resolvedBy: by } : {}) };
    });
  },
  /** New text for one message. */
  edit(comments: Comment[], commentId: string, text: string, at = new Date().toISOString()): Comment[] {
    return comments.map((candidate) => (candidate.id === commentId && candidate.text !== text
      ? { ...candidate, text, edited: at }
      : candidate));
  },
  /** Remove one reply, or a whole thread when `commentId` is its root. */
  remove(comments: Comment[], commentId: string): Comment[] {
    const rootId = threadIdOf(comments, commentId);
    if (rootId === commentId) {
      return comments.filter((candidate) => candidate.id !== commentId && candidate.parentId !== commentId);
    }
    return comments.filter((candidate) => candidate.id !== commentId);
  },
};

function withoutResolution(comment: Comment): Comment {
  const { resolvedBy: _resolvedBy, ...rest } = comment;
  return { ...rest, resolved: false };
}
