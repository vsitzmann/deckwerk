// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { SlideRail } from '../src/renderer/editor/slideRail.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { fitViewportToDevice, shellUrl, wantsMobileShell } from '../src/renderer/collab/mobileShell.js';
import { showDeckPicker } from '../src/renderer/collab/deckPicker.js';
import { peerLabel, remoteCandidates } from '../src/renderer/collab/remoteControl.js';
import type { PresenceState } from '../src/shared/collab.js';

function deck() {
  return parseDeck({ ...emptyDeck('Talk'), slides: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
}

describe('the phone client’s read-only slide list', () => {
  beforeEach(() => { Element.prototype.scrollIntoView ??= () => {}; });
  afterEach(() => document.body.replaceChildren());

  it('selects on a tap and offers nothing that edits the deck', () => {
    const host = document.createElement('aside');
    document.body.append(host);
    const store = new EditorStore(deck());
    new SlideRail(host, store, { readOnly: true });
    const rows = [...host.querySelectorAll<HTMLElement>('.rail-item')];
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => !row.draggable)).toBe(true);
    expect(host.querySelector('.rail-actions')).toBeNull();

    // A finger landing on a row to scroll the list is not a pick.
    rows[2].dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(store.get().slideIndex).toBe(0);
    rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(store.get().slideIndex).toBe(2);

    rows[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(document.getElementById('ctx-menu')).toBeNull();
    for (const key of ['Enter', 'Backspace', 'Delete']) {
      host.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    expect(store.get().deck.slides.map((slide) => slide.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('choosing the shell', () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
      removeItem: (key: string) => { items.delete(key); },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('remembers an explicit choice either way', () => {
    expect(wantsMobileShell('?deck=talk&mobile=1')).toBe(true);
    expect(wantsMobileShell('?deck=talk')).toBe(true);
    expect(wantsMobileShell('?deck=talk&desktop=1')).toBe(false);
    expect(wantsMobileShell('?deck=talk')).toBe(false);
  });

  it('keeps the deck, comment and view across the switch', () => {
    expect(shellUrl('mobile', '?deck=Talks%2Fkeynote&comment=c1&desktop=1')).toBe('./mobile.html?deck=Talks%2Fkeynote&comment=c1');
    expect(shellUrl('desktop', '?deck=talk&mobile=1')).toBe('./?deck=talk');
  });
});

describe('whom the remote can go to', () => {
  const peer = (overrides: Partial<PresenceState>): PresenceState => ({
    clientId: 'x', name: 'Someone', color: '#fff', activeSlideId: null, selectedSlideIds: [],
    selectedElementIds: [], editingElementId: null, cursor: null, ...overrides,
  });

  it('is people’s own pages: no agents, no presentations, not the presenter’s own tab', () => {
    const peers = [
      peer({ clientId: 'tab', name: 'Vincent' }),
      peer({ clientId: 'phone', name: 'Vincent', device: 'phone' }),
      peer({ clientId: 'ana', name: 'Ana' }),
      peer({ clientId: 'agent', name: 'Vincent · agent', agent: true }),
      peer({ clientId: 'audience', name: 'Vincent (presenting)', presenting: true }),
    ];
    expect(remoteCandidates(peers, new Set(['tab'])).map(peerLabel)).toEqual(['Ana', 'Vincent’s phone']);
  });
});

describe('the deck list on a phone', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.head.querySelector('meta[name="viewport"]')?.remove();
    vi.unstubAllGlobals();
  });

  it('lays the page out at the phone\'s width, once', () => {
    fitViewportToDevice();
    fitViewportToDevice();
    const metas = document.head.querySelectorAll<HTMLMetaElement>('meta[name="viewport"]');
    expect(metas).toHaveLength(1);
    expect(metas[0].content).toContain('width=device-width');
  });

  it('folds each row\'s buttons behind a ⋯', async () => {
    const decks = [
      { id: 'Talk', title: 'Talk', slides: 3, editedAt: null, editors: 0, folder: '', owner: 'me', canManage: true },
      { id: 'Theirs', title: 'Theirs', slides: 2, editedAt: null, editors: 0, folder: '', owner: 'them', role: 'view' },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith('/api/decks') ? decks : []))));
    showDeckPicker({ dismissable: false, onStatus: () => undefined, access: { user: 'me', name: 'Me', admin: false } });
    await vi.waitFor(() => expect(document.querySelectorAll('.deck-picker-list .deck-picker-row-group')).toHaveLength(2));
    const groups = [...document.querySelectorAll<HTMLElement>('.deck-picker-list .deck-picker-row-group')];
    const toggles = groups.map((group) => group.querySelector<HTMLButtonElement>('.deck-picker-more'));
    // Only rows with something to do get one.
    expect(toggles.map((toggle) => toggle !== null)).toEqual([true, groups[1].querySelector('.deck-picker-share') !== null]);
    toggles[0]!.click();
    expect(groups[0].classList.contains('open')).toBe(true);
    expect(toggles[0]!.getAttribute('aria-expanded')).toBe('true');
    toggles[0]!.click();
    expect(groups[0].classList.contains('open')).toBe(false);
    // The column labels never get one.
    expect(document.querySelector('.deck-picker-columns .deck-picker-more')).toBeNull();
  });
});
