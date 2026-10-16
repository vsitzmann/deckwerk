// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { SlideRail } from '../src/renderer/editor/slideRail.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { shellUrl, wantsMobileShell } from '../src/renderer/collab/mobileShell.js';
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
