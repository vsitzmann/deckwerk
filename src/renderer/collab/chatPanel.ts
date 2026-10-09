import {
  AGENT_MENTION,
  CHAT_TEXT_MAX,
  chatSince,
  mentionHandle,
  splitMentions,
  type ChatMessage,
  type ChatRef,
} from '@shared/chat.js';
import { makeId } from '@shared/geometry.js';

/**
 * The deck chat, as a side panel of the collab shell.
 *
 * Nothing here waits on the network: a message is drawn the moment it is
 * sent, marked pending, and confirmed when the server's `chat` echo carries
 * its id. One that could not be sent (socket down) stays pending and is sent
 * again after the next welcome; the server ignores an id it already holds,
 * and the welcome's history confirms it either way.
 *
 * Read state is per deck, per browser: the id of the last message seen while
 * the panel was on screen, in localStorage. Everything after it from someone
 * else is unread — the tab's badge — and the subset that mentions this person
 * prefixes the page title "(N) ", and raises a desktop notification while the
 * page is hidden, if the person turned the bell on (permission is requested
 * only from that click, never on load).
 */

export interface ChatParticipant {
  name: string;
  color: string;
  agent?: boolean;
}

export interface ChatPanelOptions {
  deckId: string;
  /** Send to the server; false when the socket is not open. */
  send: (post: { id: string; text: string; ref?: ChatRef }) => boolean;
  /** This person, once the server has named them. */
  self: () => ChatParticipant | null;
  /** Everyone else in the deck right now. */
  peers: () => ChatParticipant[];
  /** The slide on screen, for attaching a reference to it. */
  currentSlide: () => { id: string; number: number } | null;
  /** 1-based number of a slide, or null if the deck no longer has it. */
  slideNumber: (slideId: string) => number | null;
  /** The slide holding a comment, when a message points at one. */
  slideOfComment: (commentId: string) => string | null;
  /** Go to a comment and open its thread. */
  openComment?: (commentId: string) => void;
  jumpTo: (slideId: string, elementId?: string) => void;
  /** Unread messages and, of those, how many mention this person. */
  onUnreadChange?: (unread: number, mentions: number) => void;
}

interface Row {
  message: ChatMessage;
  pending: boolean;
}

const READ_KEY = (deckId: string): string => `deckwerk-chat-read:${deckId}`;
const NOTIFY_KEY = 'deckwerk-chat-notify';
const MAX_ROWS = 2000;
/** A read marker no log holds: "read up to before the first message". */
const READ_START = 'start-of-chat';

const BELL_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
  + '<path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3zM6.5 13.5a1.5 1.5 0 0 0 3 0" fill="none" '
  + 'stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

export class ChatPanel {
  private rows: Row[] = [];
  /** Ids this browser sent, so its own messages never count as unread. */
  private readonly own = new Set<string>();
  private lastRead: string | null;
  private readonly list: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly refButton: HTMLButtonElement;
  private readonly bell: HTMLButtonElement;
  private readonly empty: HTMLElement;
  private readonly completions: HTMLElement;
  private completionItems: string[] = [];
  private completionIndex = 0;
  private attachSlide = false;
  private notified = new Set<string>();
  private baseTitle: string | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: HTMLElement, private readonly options: ChatPanelOptions) {
    this.lastRead = localStorage.getItem(READ_KEY(options.deckId));
    host.classList.add('chat-panel');

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h3');
    title.className = 'insp-title';
    title.textContent = 'Chat';
    this.bell = document.createElement('button');
    this.bell.type = 'button';
    this.bell.className = 'chat-bell';
    this.bell.innerHTML = BELL_ICON;
    this.bell.addEventListener('click', () => void this.toggleNotifications());
    header.append(title, this.bell);

    const help = document.createElement('p');
    help.className = 'insp-hint';
    help.textContent = 'Talk about this deck. Messages are not part of it and never show up in History. Type @ to mention someone, or @agent for the agent.';

    this.list = document.createElement('div');
    this.list.className = 'chat-list';
    this.list.setAttribute('role', 'log');
    this.list.setAttribute('aria-live', 'polite');
    this.empty = document.createElement('p');
    this.empty.className = 'insp-hint chat-empty';
    this.empty.textContent = 'No messages yet.';

    const compose = document.createElement('div');
    compose.className = 'comment-compose chat-compose';
    this.input = document.createElement('textarea');
    this.input.rows = 2;
    this.input.maxLength = CHAT_TEXT_MAX;
    this.input.placeholder = 'Message…';
    this.input.setAttribute('aria-label', 'Chat message');
    this.input.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.input.addEventListener('input', () => this.updateCompletions());
    this.input.addEventListener('blur', () => setTimeout(() => this.hideCompletions(), 120));
    this.completions = document.createElement('div');
    this.completions.className = 'shape-menu chat-completions';
    this.completions.setAttribute('role', 'listbox');
    this.completions.hidden = true;
    const actions = document.createElement('div');
    actions.className = 'chat-compose-actions';
    this.refButton = document.createElement('button');
    this.refButton.type = 'button';
    this.refButton.className = 'chat-ref-toggle';
    this.refButton.addEventListener('click', () => {
      this.attachSlide = !this.attachSlide;
      this.renderRefButton();
      this.input.focus();
    });
    this.sendButton = document.createElement('button');
    this.sendButton.type = 'button';
    this.sendButton.textContent = 'Send';
    this.sendButton.addEventListener('click', () => this.submit());
    actions.append(this.refButton, this.sendButton);
    compose.append(this.completions, this.input, actions);

    host.append(header, help, this.list, compose);
    this.renderBell();
    this.renderRefButton();
    this.render();

    // Tabs toggle `hidden` directly; reading happens when the panel shows.
    new MutationObserver(() => this.onVisibilityChange())
      .observe(host, { attributes: true, attributeFilter: ['hidden'] });
    document.addEventListener('visibilitychange', () => this.onVisibilityChange());
    this.onVisibilityChange();
  }

  /** The welcome's history: replaces what the server knows, keeps what it has not seen yet. */
  setHistory(messages: ChatMessage[]): void {
    const confirmed = new Set(messages.map((message) => message.id));
    const unsent = this.rows.filter((row) => row.pending && !confirmed.has(row.message.id));
    const firstVisit = this.lastRead === null;
    this.rows = [...messages.map((message) => ({ message, pending: false })), ...unsent];
    // A first visit starts caught up: a whole backlog is history, not news.
    if (firstVisit) this.markRead(messages.at(-1)?.id ?? READ_START, true);
    for (const message of messages) this.notified.add(message.id);
    for (const row of unsent) this.options.send({ id: row.message.id, text: row.message.text, ref: row.message.ref });
    this.render();
  }

  /** One message from the server — possibly the echo of one of ours. */
  receive(message: ChatMessage): void {
    const at = this.rows.findIndex((row) => row.message.id === message.id);
    if (at !== -1) this.rows[at] = { message, pending: false };
    else this.rows.push({ message, pending: false });
    if (this.rows.length > MAX_ROWS) this.rows.splice(0, this.rows.length - MAX_ROWS);
    if (at === -1 && !this.isOwn(message) && this.mentionsMe(message)) this.notify(message);
    this.render();
  }

  /** Slide numbers in the reference chips follow the deck. */
  refresh(): void {
    this.renderRefButton();
    this.render();
  }

  focusInput(): void {
    this.input.focus();
  }

  private submit(): void {
    const text = this.input.value.trim();
    const self = this.options.self();
    if (!text || !self) return;
    const slide = this.attachSlide ? this.options.currentSlide() : null;
    const message: ChatMessage = {
      id: makeId('chat'),
      author: self.name,
      agent: false,
      ts: new Date().toISOString(),
      text,
      mentions: splitMentions(text).flatMap((part) => (part.mention ? [part.mention] : [])),
      ...(slide ? { ref: { slideId: slide.id } } : {}),
    };
    this.own.add(message.id);
    this.rows.push({ message, pending: true });
    this.input.value = '';
    this.attachSlide = false;
    this.renderRefButton();
    this.hideCompletions();
    this.options.send({ id: message.id, text, ref: message.ref });
    this.render();
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Every key belongs to the text box: Delete must not delete a slide.
    event.stopPropagation();
    if (!this.completions.hidden && this.completionItems.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.completionIndex = (this.completionIndex + step + this.completionItems.length) % this.completionItems.length;
        this.renderCompletions();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.complete(this.completionItems[this.completionIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.hideCompletions();
        return;
      }
    }
    // Enter sends; Shift+Enter makes a newline, matching the comment box.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      this.submit();
    }
  }

  /** The `@partial` the caret is in, if any. */
  private mentionQuery(): { start: number; query: string } | null {
    const caret = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, caret);
    const match = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.-]*)$/u.exec(before);
    if (!match) return null;
    return { start: caret - match[2].length - 1, query: match[2].toLowerCase() };
  }

  private updateCompletions(): void {
    const query = this.mentionQuery();
    if (!query) {
      this.hideCompletions();
      return;
    }
    const selfHandle = this.selfHandle();
    const handles = [AGENT_MENTION];
    for (const peer of this.options.peers()) {
      if (peer.agent) continue; // Agents answer to @agent.
      const handle = mentionHandle(peer.name);
      if (handle && handle.toLowerCase() !== selfHandle && !handles.some((h) => h.toLowerCase() === handle.toLowerCase())) {
        handles.push(handle);
      }
    }
    this.completionItems = handles.filter((handle) => handle.toLowerCase().startsWith(query.query));
    this.completionIndex = 0;
    // A handle typed out in full needs no list: Enter should send, not complete.
    const exact = this.completionItems.length === 1 && this.completionItems[0].toLowerCase() === query.query;
    if (this.completionItems.length === 0 || exact) {
      this.hideCompletions();
      return;
    }
    this.completions.hidden = false;
    this.renderCompletions();
  }

  private renderCompletions(): void {
    this.completions.replaceChildren(...this.completionItems.map((handle, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `shape-menu-item${index === this.completionIndex ? ' is-active' : ''}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === this.completionIndex));
      item.textContent = `@${handle}`;
      // pointerdown, before the textarea's blur hides the list.
      item.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.complete(handle);
      });
      return item;
    }));
  }

  private complete(handle: string): void {
    const query = this.mentionQuery();
    if (!query) return;
    const caret = this.input.selectionStart ?? this.input.value.length;
    const value = this.input.value;
    const insert = `@${handle} `;
    this.input.value = value.slice(0, query.start) + insert + value.slice(caret);
    const at = query.start + insert.length;
    this.input.setSelectionRange(at, at);
    this.hideCompletions();
    this.input.focus();
  }

  private hideCompletions(): void {
    this.completions.hidden = true;
    this.completionItems = [];
  }

  private async toggleNotifications(): Promise<void> {
    if (!('Notification' in window)) return;
    if (this.notificationsOn()) {
      localStorage.setItem(NOTIFY_KEY, 'off');
      this.renderBell();
      return;
    }
    // Only ever from this click: a permission prompt nobody asked for is noise.
    if (Notification.permission === 'default') await Notification.requestPermission();
    localStorage.setItem(NOTIFY_KEY, Notification.permission === 'granted' ? 'on' : 'off');
    this.renderBell();
  }

  private notificationsOn(): boolean {
    return 'Notification' in window
      && Notification.permission === 'granted'
      && localStorage.getItem(NOTIFY_KEY) === 'on';
  }

  private renderBell(): void {
    const supported = 'Notification' in window;
    const on = this.notificationsOn();
    this.bell.disabled = !supported;
    this.bell.setAttribute('aria-pressed', String(on));
    const label = !supported
      ? 'This browser cannot show notifications'
      : supported && Notification.permission === 'denied'
        ? 'Notifications are blocked for this site in the browser settings'
        : on ? 'Notify me when someone mentions me (on)' : 'Notify me when someone mentions me';
    this.bell.title = label;
    this.bell.setAttribute('aria-label', label);
  }

  private notify(message: ChatMessage): void {
    if (this.notified.has(message.id)) return;
    this.notified.add(message.id);
    if (!document.hidden || !this.notificationsOn()) return;
    try {
      const notification = new Notification(`${message.author} mentioned you`, {
        body: message.text.slice(0, 200),
        tag: `deckwerk-chat-${this.options.deckId}`,
      });
      notification.addEventListener('click', () => {
        window.focus();
        notification.close();
      });
    } catch {
      // Some browsers only notify from a service worker; the badge still counts.
    }
  }

  private selfHandle(): string {
    const self = this.options.self();
    return self ? mentionHandle(self.name).toLowerCase() : '';
  }

  private isOwn(message: ChatMessage): boolean {
    if (this.own.has(message.id)) return true;
    const self = this.options.self();
    return Boolean(self && !message.agent && message.author === self.name);
  }

  private mentionsMe(message: ChatMessage): boolean {
    const handle = this.selfHandle();
    return Boolean(handle) && message.mentions.includes(handle);
  }

  private visible(): boolean {
    return !this.host.hidden && document.visibilityState === 'visible';
  }

  private onVisibilityChange(): void {
    if (this.visible()) {
      this.markRead(this.lastConfirmedId());
      if (!this.clock) this.clock = setInterval(() => this.renderTimes(), 30_000);
    } else if (this.clock) {
      clearInterval(this.clock);
      this.clock = null;
    }
    this.renderTimes();
  }

  private lastConfirmedId(): string | null {
    for (let i = this.rows.length - 1; i >= 0; i--) if (!this.rows[i].pending) return this.rows[i].message.id;
    return null;
  }

  private markRead(id: string | null, quiet = false): void {
    if (!id || id === this.lastRead) {
      if (!quiet) this.updateUnread();
      return;
    }
    this.lastRead = id;
    localStorage.setItem(READ_KEY(this.options.deckId), id);
    this.updateUnread();
  }

  private updateUnread(): void {
    const confirmed = this.rows.filter((row) => !row.pending).map((row) => row.message);
    // Before the first welcome nothing is known to be unread. A marker the
    // list does not hold (READ_START, or one older than the history sent)
    // counts everything — erring towards showing a message, not hiding it.
    const fresh = this.lastRead ? chatSince(confirmed, this.lastRead) : [];
    const unread = fresh.filter((message) => !this.isOwn(message));
    const mentions = unread.filter((message) => this.mentionsMe(message)).length;
    this.options.onUnreadChange?.(unread.length, mentions);
    this.baseTitle ??= document.title.replace(/^\(\d+\) /, '');
    const base = document.title.replace(/^\(\d+\) /, '') || this.baseTitle;
    document.title = mentions > 0 ? `(${mentions}) ${base}` : base;
  }

  private render(): void {
    const stick = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    const rows = this.rows.map((row) => this.messageRow(row));
    this.list.replaceChildren(...(rows.length > 0 ? rows : [this.empty]));
    if (stick || this.rows.at(-1)?.pending) this.list.scrollTop = this.list.scrollHeight;
    if (this.visible()) this.markRead(this.lastConfirmedId());
    else this.updateUnread();
  }

  private messageRow(row: Row): HTMLElement {
    const { message } = row;
    const element = document.createElement('div');
    element.className = 'chat-message';
    element.dataset.chatId = message.id;
    element.classList.toggle('pending', row.pending);
    element.classList.toggle('agent', message.agent);
    element.classList.toggle('mentions-me', !this.isOwn(message) && this.mentionsMe(message));

    const meta = document.createElement('div');
    meta.className = 'comment-meta chat-meta';
    const dot = document.createElement('span');
    dot.className = 'chat-dot';
    const color = this.colorOf(message);
    if (color) dot.style.background = color;
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = message.author;
    if (color) author.style.color = color;
    const when = document.createElement('time');
    when.className = 'comment-when';
    when.dateTime = message.ts;
    when.dataset.ts = message.ts;
    when.dataset.pending = String(row.pending);
    when.textContent = row.pending ? 'sending…' : relativeTime(message.ts);
    when.title = new Date(message.ts).toLocaleString();
    meta.append(dot, author, when);

    const body = document.createElement('div');
    body.className = 'comment-text chat-text';
    for (const part of splitMentions(message.text)) {
      if (!part.mention) {
        body.append(part.text);
        continue;
      }
      const mention = document.createElement('span');
      mention.className = 'chat-mention';
      mention.classList.toggle('is-me', part.mention === this.selfHandle());
      mention.textContent = part.text;
      body.append(mention);
    }
    element.append(meta, body);

    const ref = message.ref ? this.refChip(message.ref) : null;
    if (ref) element.append(ref);
    return element;
  }

  private refChip(ref: ChatRef): HTMLElement | null {
    const slideId = 'commentId' in ref ? this.options.slideOfComment(ref.commentId) : ref.slideId;
    const elementId = 'elementId' in ref ? ref.elementId : undefined;
    const number = slideId ? this.options.slideNumber(slideId) : null;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat-ref';
    if (!slideId || number === null) {
      chip.disabled = true;
      chip.textContent = 'commentId' in ref ? 'Comment (removed)' : 'Slide (removed)';
      return chip;
    }
    chip.textContent = `${'commentId' in ref ? 'Comment on slide' : elementId ? 'Object on slide' : 'Slide'} ${number}`;
    chip.title = 'Go there';
    chip.addEventListener('click', () => {
      if ('commentId' in ref && this.options.openComment) this.options.openComment(ref.commentId);
      else this.options.jumpTo(slideId, elementId);
    });
    return chip;
  }

  private colorOf(message: ChatMessage): string | null {
    const self = this.options.self();
    if (self && message.author === self.name) return self.color;
    return this.options.peers().find((peer) => peer.name === message.author)?.color ?? null;
  }

  private renderRefButton(): void {
    const slide = this.options.currentSlide();
    this.refButton.disabled = !slide;
    this.refButton.setAttribute('aria-pressed', String(this.attachSlide && Boolean(slide)));
    this.refButton.textContent = slide ? `Slide ${slide.number}` : 'Slide';
    this.refButton.title = this.attachSlide
      ? 'This message will point at the current slide. Click to detach.'
      : 'Point this message at the current slide';
  }

  private renderTimes(): void {
    for (const time of this.list.querySelectorAll<HTMLTimeElement>('time[data-ts]')) {
      if (time.dataset.pending === 'true') continue;
      time.textContent = relativeTime(time.dataset.ts ?? '');
    }
  }
}

/** "just now", "5 min ago", "3 h ago", then the date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' });
}
