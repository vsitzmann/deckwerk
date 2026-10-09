import type { Comment, Slide } from '@shared/deck.js';
import {
  commentThreads,
  setComments,
  threadEdits,
  type CommentTarget,
  type CommentThread,
} from '@shared/comments.js';
import { makeId } from '@shared/geometry.js';
import { describeElement } from './elementLabel.js';
import type { EditorStore } from './store.js';

/**
 * Comment threads in the editor, after TeXWerk's: a thread is a conversation
 * on a slide or an object (replies, edits, resolve and reopen, a link that
 * opens it). Nothing here is on screen until someone asks for it from a
 * right-click menu or follows a comment link; what stays visible is the
 * highlight on whatever carries an open thread (canvas.ts, slideRail.ts).
 *
 * Threads live in deck.json and every change is an ordinary store commit
 * outside undo, which the diff states as a merging `updateComments`
 * operation (shared/comments.ts), so collaborators see a reply as soon as it
 * is posted and two replies posted at once both land.
 */

/** Who is writing. The collab shell sets the session's identity. */
let identity = { name: 'You', login: '' };

export function setCommentAuthor(name: string, login = ''): void {
  if (name.trim()) identity = { name: name.trim(), login };
}

/** Builds the shareable address of a comment; null where there is none (the desktop app). */
let linkBuilder: ((commentId: string) => string) | null = null;

export function setCommentLinks(build: ((commentId: string) => string) | null): void {
  linkBuilder = build;
}

export function newComment(text: string): Comment {
  return {
    id: makeId('comment'),
    author: identity.name,
    ...(identity.login ? { login: identity.login } : {}),
    text,
    ts: new Date().toISOString(),
    resolved: false,
  };
}

function isMine(comment: Comment): boolean {
  if (comment.login && identity.login) return comment.login === identity.login;
  return !comment.login && comment.author === identity.name;
}

/* --- highlight visibility and focus --------------------------------------- */

const SHOW_KEY = 'deckwerk-show-comments';
let showHighlights = readShowHighlights();
let focus: CommentTarget | null = null;
const listeners = new Set<() => void>();

function readShowHighlights(): boolean {
  try {
    return localStorage.getItem(SHOW_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Called whenever the highlights should be redrawn: visibility or focus changed. */
export function onCommentHighlightsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function commentHighlightsShown(): boolean {
  return showHighlights;
}

export function setCommentHighlightsShown(show: boolean): void {
  showHighlights = show;
  try {
    localStorage.setItem(SHOW_KEY, show ? '1' : '0');
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  notify();
}

/**
 * What the open comment popover is about, drawn stronger than the other
 * highlights: its target, or the thread under the pointer. Shown even when
 * highlights are hidden and even before the first comment is written, so it
 * is always clear what a comment will attach to.
 */
export function commentFocus(): CommentTarget | null {
  return focus;
}

function setFocus(next: CommentTarget | null): void {
  if (focus?.slideId === next?.slideId && focus?.elementId === next?.elementId) return;
  focus = next;
  notify();
}

/* --- the popover ----------------------------------------------------------- */

export interface OpenCommentsOptions {
  store: EditorStore;
  slideId: string;
  /** One object's threads; omitted, the slide's own threads and every object's. */
  elementId?: string;
  /** Viewport point or rectangle the popover opens beside. */
  anchor: DOMRect | { x: number; y: number };
  /** Put the caret in the new-comment box. */
  compose?: boolean;
  /** Show this thread (by any of its messages' ids) and put the caret in its reply box. */
  threadId?: string;
  /** Select an object when its label in a thread is clicked. */
  reveal?: (target: CommentTarget) => void;
}

interface ThreadEntry {
  thread: CommentThread;
  target: CommentTarget;
  where: string;
}

let active: CommentsPopover | null = null;

export function openComments(options: OpenCommentsOptions): void {
  active?.close();
  active = new CommentsPopover(options);
}

export function closeCommentsPopover(): void {
  active?.close();
}

class CommentsPopover {
  private readonly pop = document.createElement('div');
  private readonly unsubscribe: () => void;
  private showResolved = false;
  private renderedComments: unknown = null;
  private readonly onOutside = (event: Event) => {
    if (!(event.target instanceof Node) || !this.pop.contains(event.target)) this.close();
  };
  private readonly onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') this.close();
  };
  private readonly onFullscreen = () => {
    if (document.fullscreenElement) this.close();
  };
  private closed = false;

  constructor(private readonly options: OpenCommentsOptions) {
    this.pop.id = 'comments-popover';
    this.pop.addEventListener('pointerdown', (event) => event.stopPropagation());
    this.pop.addEventListener('contextmenu', (event) => event.stopPropagation());
    const threadId = options.threadId;
    if (threadId) {
      const entry = this.entries().find((candidate) => holds(candidate.thread, threadId));
      if (entry?.thread.root.resolved) this.showResolved = true;
    }
    this.render();
    document.body.appendChild(this.pop);
    this.place();
    setFocus(this.target());

    // Re-render when the threads change (a reply arriving from a
    // collaborator), close when what they hang on goes away.
    this.unsubscribe = options.store.subscribe(() => {
      const slide = this.slide();
      if (!slide || (options.elementId && !slide.elements.some((element) => element.id === options.elementId))) {
        this.close();
        return;
      }
      this.render();
    });
    setTimeout(() => {
      if (this.closed) return;
      document.addEventListener('pointerdown', this.onOutside);
      document.addEventListener('keydown', this.onKey);
      document.addEventListener('fullscreenchange', this.onFullscreen);
    }, 0);

    if (threadId) {
      const card = this.pop.querySelector<HTMLElement>(`.cthread[data-thread-id="${CSS.escape(this.threadRootId(threadId) ?? '')}"]`);
      card?.classList.add('flash');
      card?.scrollIntoView({ block: 'nearest' });
      card?.querySelector<HTMLTextAreaElement>('.creply textarea')?.focus();
    } else if (options.compose || this.entries().every((entry) => entry.thread.root.resolved)) {
      this.pop.querySelector<HTMLTextAreaElement>('.cnew textarea')?.focus();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.pop.remove();
    document.removeEventListener('pointerdown', this.onOutside);
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    if (active === this) active = null;
    setFocus(null);
  }

  private slide(): Slide | undefined {
    return this.options.store.get().deck.slides.find((slide) => slide.id === this.options.slideId);
  }

  private target(): CommentTarget {
    return {
      slideId: this.options.slideId,
      ...(this.options.elementId ? { elementId: this.options.elementId } : {}),
    };
  }

  private threadRootId(id: string): string | null {
    return this.entries().find((entry) => holds(entry.thread, id))?.thread.root.id ?? null;
  }

  /** The threads this popover shows, each with what it hangs on. */
  private entries(): ThreadEntry[] {
    const slide = this.slide();
    if (!slide) return [];
    const out: ThreadEntry[] = [];
    if (!this.options.elementId) {
      for (const thread of commentThreads(slide.comments)) {
        out.push({ thread, target: { slideId: slide.id }, where: 'Slide' });
      }
    }
    for (const element of slide.elements) {
      if (this.options.elementId && element.id !== this.options.elementId) continue;
      for (const thread of commentThreads(element.comments)) {
        out.push({ thread, target: { slideId: slide.id, elementId: element.id }, where: describeElement(element) });
      }
    }
    return out;
  }

  private slideNumber(): number {
    return this.options.store.get().deck.slides.findIndex((slide) => slide.id === this.options.slideId) + 1;
  }

  private mutate(target: CommentTarget, label: string, change: (comments: Comment[]) => Comment[]): void {
    this.options.store.commit((deck) => {
      const slide = deck.slides.find((candidate) => candidate.id === target.slideId);
      const owner = target.elementId
        ? slide?.elements.find((element) => element.id === target.elementId)
        : slide;
      if (owner) setComments(owner, change(owner.comments ?? []));
    }, { label, history: false });
  }

  /**
   * Rebuild from the deck. Text typed into any box survives, as does the
   * caret: a collaborator's reply arriving mid-sentence must not eat it.
   */
  private render(): void {
    const slide = this.slide();
    if (!slide) return;
    const signature = this.options.elementId
      ? slide.elements.find((element) => element.id === this.options.elementId)?.comments
      : [slide.comments, ...slide.elements.map((element) => element.comments)];
    const key = JSON.stringify(signature ?? null) + String(this.showResolved);
    if (key === this.renderedComments) return;
    this.renderedComments = key;

    const drafts = new Map<string, string>();
    for (const box of this.pop.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')) {
      if (box.value) drafts.set(box.dataset.draft!, box.value);
    }
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.draft ?? null;
    const caret = focused ? (document.activeElement as HTMLTextAreaElement).selectionStart : null;
    const scroll = this.pop.querySelector('.comments-list')?.scrollTop ?? 0;

    const entries = this.entries();
    const open = entries.filter((entry) => !entry.thread.root.resolved);
    const resolved = entries.filter((entry) => entry.thread.root.resolved);

    const title = document.createElement('div');
    title.className = 'comments-title';
    const element = this.options.elementId
      ? slide.elements.find((candidate) => candidate.id === this.options.elementId)
      : undefined;
    title.textContent = element
      ? `${describeElement(element)} · slide ${this.slideNumber()}`
      : `Slide ${this.slideNumber()}`;

    const list = document.createElement('div');
    list.className = 'comments-list';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'comments-empty';
      empty.textContent = 'No comments yet.';
      list.appendChild(empty);
    }
    for (const entry of open) list.appendChild(this.threadCard(entry));
    if (resolved.length) {
      const toggle = document.createElement('button');
      toggle.className = 'comments-resolved-toggle';
      toggle.textContent = `${this.showResolved ? 'Hide' : 'Show'} ${resolved.length} resolved`;
      toggle.addEventListener('click', () => {
        this.showResolved = !this.showResolved;
        this.render();
      });
      list.appendChild(toggle);
      if (this.showResolved) for (const entry of resolved) list.appendChild(this.threadCard(entry));
    }

    const compose = this.composer(
      'new',
      element ? 'Comment on this object…' : 'Comment on this slide…',
      'Comment',
      (text) => this.mutate(this.target(), 'Add comment', (comments) => threadEdits.start(comments, newComment(text))),
    );
    compose.classList.add('cnew');

    this.pop.replaceChildren(title, list, compose);
    list.scrollTop = scroll;
    for (const box of this.pop.querySelectorAll<HTMLTextAreaElement>('textarea[data-draft]')) {
      const draft = drafts.get(box.dataset.draft!);
      if (draft !== undefined) {
        box.value = draft;
        box.dispatchEvent(new Event('input'));
      }
      if (box.dataset.draft === focused) {
        box.focus();
        if (caret !== null) box.setSelectionRange(caret, caret);
      }
    }
  }

  private threadCard(entry: ThreadEntry): HTMLElement {
    const { thread, target } = entry;
    const card = document.createElement('div');
    card.className = `cthread${thread.root.resolved ? ' resolved' : ''}`;
    card.dataset.threadId = thread.root.id;
    card.addEventListener('pointerenter', () => setFocus(target));
    card.addEventListener('pointerleave', () => setFocus(this.target()));

    const head = document.createElement('div');
    head.className = 'cthread-head';
    if (!this.options.elementId) {
      const where = document.createElement('button');
      where.className = 'cthread-where';
      where.textContent = entry.where;
      where.title = target.elementId ? 'Select this object' : 'This slide';
      where.disabled = !target.elementId || !this.options.reveal;
      where.addEventListener('click', () => this.options.reveal?.(target));
      head.appendChild(where);
    } else if (thread.root.resolved && thread.root.resolvedBy) {
      const by = document.createElement('span');
      by.className = 'cthread-where';
      by.textContent = `Resolved by ${thread.root.resolvedBy}`;
      head.appendChild(by);
    }
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    head.appendChild(spacer);
    if (linkBuilder) {
      const link = linkBuilder(thread.root.id);
      const copy = document.createElement('button');
      copy.textContent = 'Link';
      copy.title = 'Copy a link that opens this comment, for anyone who has access to the presentation';
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(link).then(
          () => flashLabel(copy, 'Copied'),
          () => flashLabel(copy, 'Copy failed'),
        );
      });
      head.appendChild(copy);
    }
    const resolve = document.createElement('button');
    resolve.className = 'cthread-resolve';
    resolve.textContent = thread.root.resolved ? 'Reopen' : '✓ Resolve';
    resolve.title = thread.root.resolved
      ? 'Reopen this thread'
      : 'Mark as resolved: the highlight goes away, the thread is kept';
    resolve.addEventListener('click', () => this.mutate(
      target,
      thread.root.resolved ? 'Reopen comment' : 'Resolve comment',
      (comments) => threadEdits.resolve(comments, thread.root.id, !thread.root.resolved, identity.name),
    ));
    head.appendChild(resolve);
    card.appendChild(head);

    for (const message of [thread.root, ...thread.replies]) card.appendChild(this.message(entry, message));

    card.appendChild(this.composer(
      `reply:${thread.root.id}`,
      thread.root.resolved ? 'Reply (reopens the thread)…' : 'Reply…',
      'Reply',
      (text) => this.mutate(target, 'Reply to comment', (comments) =>
        threadEdits.reply(comments, thread.root.id, newComment(text))),
      true,
    ));
    return card;
  }

  private message(entry: ThreadEntry, message: Comment): HTMLElement {
    const row = document.createElement('div');
    row.className = 'cmsg';
    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const dot = document.createElement('span');
    dot.className = `cmsg-dot${/(^|:)agent$|^agent$/i.test(message.login ?? message.author) ? ' agent' : ''}`;
    dot.style.background = colorFor(message.login || message.author);
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = message.author || 'Unknown';
    const when = document.createElement('span');
    when.className = 'comment-when';
    when.textContent = `${formatWhen(message.ts)}${message.edited ? ' · edited' : ''}`;
    when.title = new Date(message.ts).toLocaleString();
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    meta.append(dot, author, when, spacer);

    const text = document.createElement('div');
    text.className = 'comment-text';
    text.textContent = message.text;

    if (isMine(message)) {
      const tools = document.createElement('span');
      tools.className = 'cmsg-tools';
      const edit = document.createElement('button');
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => {
        const editor = this.composer(`edit:${message.id}`, '', 'Save', (value) => {
          this.mutate(entry.target, 'Edit comment', (comments) => threadEdits.edit(comments, message.id, value));
        });
        const box = editor.querySelector('textarea')!;
        box.value = message.text;
        box.dispatchEvent(new Event('input'));
        text.replaceWith(editor);
        box.focus();
      });
      const isRoot = message.id === entry.thread.root.id;
      const remove = document.createElement('button');
      remove.textContent = 'Delete';
      remove.title = isRoot ? 'Delete this comment and all its replies' : 'Delete this reply';
      remove.addEventListener('click', () => {
        // A thread with replies holds other people's words: ask once, inline.
        if (isRoot && entry.thread.replies.length && remove.dataset.armed !== 'true') {
          remove.dataset.armed = 'true';
          remove.textContent = 'Delete thread?';
          remove.classList.add('danger');
          return;
        }
        this.mutate(entry.target, isRoot ? 'Delete comment thread' : 'Delete reply', (comments) =>
          threadEdits.remove(comments, message.id));
      });
      tools.append(edit, remove);
      meta.appendChild(tools);
    }
    row.append(meta, text);
    return row;
  }

  /** A text box and its button; Enter posts, Shift+Enter is a new line. */
  private composer(
    draftKey: string,
    placeholder: string,
    label: string,
    submit: (text: string) => void,
    compact = false,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = `comment-compose${compact ? ' creply' : ''}`;
    const box = document.createElement('textarea');
    box.dataset.draft = draftKey;
    box.placeholder = placeholder;
    box.rows = compact ? 1 : 2;
    const send = document.createElement('button');
    send.textContent = label;
    if (compact) send.hidden = true;
    const post = () => {
      const text = box.value.trim();
      if (!text) {
        box.focus();
        return;
      }
      box.value = '';
      submit(text);
    };
    box.addEventListener('input', () => {
      if (compact) send.hidden = !box.value.trim();
      box.style.height = 'auto';
      box.style.height = `${Math.min(160, box.scrollHeight)}px`;
    });
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        post();
      } else if (event.key === 'Escape') {
        this.close();
      }
      // Typing here must never reach the editor's shortcuts (Delete, arrows).
      event.stopPropagation();
    });
    send.addEventListener('click', post);
    row.append(box, send);
    return row;
  }

  /** Beside the anchor, clamped to the viewport. */
  private place(): void {
    const { anchor } = this.options;
    const rect = this.pop.getBoundingClientRect();
    const box = 'width' in anchor
      ? anchor
      : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
    let left = box.right + 8;
    if (left + rect.width > window.innerWidth - 8) left = box.left - rect.width - 8;
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(box.top, window.innerHeight - rect.height - 8));
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${top}px`;
  }
}

function holds(thread: CommentThread, id: string): boolean {
  return thread.root.id === id || thread.replies.some((reply) => reply.id === id);
}

function flashLabel(button: HTMLButtonElement, text: string): void {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1400);
}

/** A stable colour per person, so a thread's voices are easy to tell apart. */
function colorFor(key: string): string {
  let hash = 0;
  for (const char of key.replace(/:agent$/, '')) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 62% 58%)`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
