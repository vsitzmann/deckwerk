/**
 * The collab shell's Chat panel: optimistic sending, read state, mention
 * highlighting and the title prefix, @-completion, and slide refs.
 */
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatPanel, relativeTime, type ChatPanelOptions } from '../src/renderer/collab/chatPanel.js';
import { parseMentions, type ChatMessage } from '../src/shared/chat.js';

const message = (id: string, author: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, author, agent: false, ts: new Date().toISOString(), text, mentions: parseMentions(text), ...extra,
});

describe('ChatPanel', () => {
  let host: HTMLElement;
  let sent: Array<{ id: string; text: string; ref?: unknown }>;
  let online: boolean;
  let unread: { count: number; mentions: number };
  let jumps: string[];

  const panel = (overrides: Partial<ChatPanelOptions> = {}) => new ChatPanel(host, {
    deckId: 'talk',
    send: (post) => {
      if (online) sent.push(post);
      return online;
    },
    self: () => ({ name: 'Ada Lovelace', color: '#e0533d' }),
    peers: () => [{ name: 'Bob', color: '#3d7de0' }, { name: 'Ada Lovelace · agent', color: '#000', agent: true }],
    currentSlide: () => ({ id: 's2', number: 2 }),
    slideNumber: (id) => (id === 's1' ? 1 : id === 's2' ? 2 : null),
    slideOfComment: () => null,
    jumpTo: (slideId) => jumps.push(slideId),
    onUnreadChange: (count, mentions) => { unread = { count, mentions }; },
    ...overrides,
  });

  const input = () => host.querySelector('textarea')!;
  const type = (text: string) => {
    input().value = text;
    input().setSelectionRange(text.length, text.length);
    input().dispatchEvent(new Event('input'));
  };
  const key = (name: string, init: KeyboardEventInit = {}) =>
    input().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init }));

  beforeEach(() => {
    const dom = new JSDOM(
      '<!doctype html><title>DeckWerk — Collaboration</title><body><div id="chat" class="side-panel" hidden></div></body>',
      { pretendToBeVisual: true, url: 'https://deckwerk.test/?deck=talk' },
    );
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      KeyboardEvent: dom.window.KeyboardEvent,
      Event: dom.window.Event,
      MutationObserver: dom.window.MutationObserver,
      localStorage: dom.window.localStorage,
    });
    host = document.getElementById('chat')!;
    sent = [];
    online = true;
    unread = { count: 0, mentions: 0 };
    jumps = [];
  });

  it('shows a sent message at once as pending and confirms it on the echo', () => {
    const chat = panel();
    chat.setHistory([]);
    type('hello @Bob');
    key('Enter');
    expect(sent).toHaveLength(1);
    expect(input().value).toBe('');
    const row = host.querySelector<HTMLElement>(`[data-chat-id="${sent[0].id}"]`)!;
    expect(row.classList.contains('pending')).toBe(true);
    expect(row.textContent).toContain('sending…');
    chat.receive(message(sent[0].id, 'Ada Lovelace', 'hello @Bob'));
    const confirmed = host.querySelector<HTMLElement>(`[data-chat-id="${sent[0].id}"]`)!;
    expect(confirmed.classList.contains('pending')).toBe(false);
    expect(host.querySelectorAll('.chat-message')).toHaveLength(1);
    // Our own message is never unread.
    expect(unread.count).toBe(0);
  });

  it('Shift+Enter is a newline, not a send', () => {
    panel().setHistory([]);
    type('line one');
    key('Enter', { shiftKey: true });
    expect(sent).toHaveLength(0);
  });

  it('keeps an unsent message pending and sends it again after the next welcome', () => {
    const chat = panel();
    chat.setHistory([]);
    online = false;
    type('offline note');
    key('Enter');
    expect(sent).toHaveLength(0);
    expect(host.querySelector('.chat-message.pending')).not.toBeNull();
    online = true;
    chat.setHistory([]);
    expect(sent.map((post) => post.text)).toEqual(['offline note']);
    expect(host.querySelector('.chat-message.pending')).not.toBeNull();
  });

  it('counts unread messages while hidden, flags mentions in the title, and clears on show', async () => {
    const chat = panel();
    chat.setHistory([message('m0', 'Bob', 'old news')]);
    // A first visit starts caught up.
    expect(unread).toEqual({ count: 0, mentions: 0 });
    chat.receive(message('m1', 'Bob', 'anyone?'));
    chat.receive(message('m2', 'Bob', '@AdaLovelace look at slide 2'));
    expect(unread).toEqual({ count: 2, mentions: 1 });
    expect(document.title).toBe('(1) DeckWerk — Collaboration');
    expect(host.querySelector('[data-chat-id="m2"]')!.classList.contains('mentions-me')).toBe(true);
    expect(host.querySelector('[data-chat-id="m2"] .chat-mention.is-me')).not.toBeNull();
    host.hidden = false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0)); // MutationObserver
    expect(unread).toEqual({ count: 0, mentions: 0 });
    expect(document.title).toBe('DeckWerk — Collaboration');
    expect(localStorage.getItem('deckwerk-chat-read:talk')).toBe('m2');
  });

  it('remembers what was read across a reload', () => {
    localStorage.setItem('deckwerk-chat-read:talk', 'm1');
    const chat = panel();
    chat.setHistory([message('m1', 'Bob', 'seen'), message('m2', 'Bob', 'not seen')]);
    expect(unread.count).toBe(1);
  });

  it('completes @mentions from the people present plus the agent', () => {
    panel().setHistory([]);
    type('hey @');
    const options = () => [...host.querySelectorAll('.chat-completions [role="option"]')].map((node) => node.textContent);
    // Not yourself, and agent peers answer to @agent rather than by name.
    expect(options()).toEqual(['@agent', '@Bob']);
    type('hey @b');
    expect(options()).toEqual(['@Bob']);
    key('Enter');
    expect(input().value).toBe('hey @Bob ');
    expect(sent).toHaveLength(0);
  });

  it('attaches the current slide on request and jumps from a ref chip', () => {
    const chat = panel();
    chat.setHistory([message('m1', 'Bob', 'this one', { ref: { slideId: 's1' } })]);
    const chip = host.querySelector<HTMLButtonElement>('[data-chat-id="m1"] .chat-ref')!;
    expect(chip.textContent).toBe('Slide 1');
    chip.click();
    expect(jumps).toEqual(['s1']);
    host.querySelector<HTMLButtonElement>('.chat-ref-toggle')!.click();
    type('see here');
    key('Enter');
    expect(sent[0].ref).toEqual({ slideId: 's2' });
  });

  it('formats times relative to now', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    expect(relativeTime('2026-10-02T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-10-02T11:55:00Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-10-02T09:00:00Z', now)).toBe('3 h ago');
  });
});
