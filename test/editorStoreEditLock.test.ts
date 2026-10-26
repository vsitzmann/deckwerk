// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * The browser editor shows the copy of a deck kept in the browser when it
 * opens without the server, and that copy is read-only: anything edited in
 * it would be discarded when the server answers (collab/main.ts). The lock
 * lives in the store, where every local edit passes on its way to the
 * server, so no control can get round it.
 */

function text(id: string): SlideElement {
  return {
    id, type: 'text', x: 0, y: 0, w: 400, h: 100, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, html: 'Hello', align: 'left', valign: 'top',
  } as SlideElement;
}

function lockedStore() {
  const deck = emptyDeck('Talk');
  deck.slides[0].elements = [text('t1')];
  const store = new EditorStore(deck);
  const sent: string[] = [];
  const refused: string[] = [];
  store.onLocalEdit = (_prev, _next, label) => sent.push(label);
  store.onEditRefused = (reason) => refused.push(reason);
  store.setEditLock('Read-only: the copy kept in this browser');
  return { store, sent, refused };
}

describe('a store locked against edits', () => {
  it('refuses a commit, sends nothing, and says why', () => {
    const { store, sent, refused } = lockedStore();
    const before = store.get().deck;
    store.commit((deck) => { (deck.slides[0].elements[0] as { html: string }).html = 'Edited'; }, { label: 'Type' });
    expect(store.get().deck).toBe(before);
    expect(sent).toEqual([]);
    expect(refused).toEqual(['Read-only: the copy kept in this browser']);
    expect(store.get().dirty).toBe(false);
  });

  it('refuses a drag, a history replace and a restore', () => {
    const { store, sent, refused } = lockedStore();
    const before = store.get().deck;
    store.beginTransaction('Move');
    store.commit((deck) => { deck.slides[0].elements[0].x += 40; });
    store.endTransaction();
    const replaced = structuredClone(before);
    replaced.title = 'Renamed';
    store.replaceWithHistory(replaced, 'Rename');
    expect(store.restoreHistory(1)).toBe(false);
    expect(store.get().deck).toBe(before);
    expect(sent).toEqual([]);
    expect(refused.length).toBeGreaterThanOrEqual(3);
  });

  it('still takes what the renderer measured, and decks from the server', () => {
    const { store, refused } = lockedStore();
    store.commit((deck) => { deck.slides[0].elements[0].h = 120; }, { measurement: true });
    expect(store.get().deck.slides[0].elements[0].h).toBe(120);
    const remote = structuredClone(store.get().deck);
    remote.title = 'From the server';
    store.applyRemote(remote, 'Remote edit');
    expect(store.get().deck.title).toBe('From the server');
    expect(refused).toEqual([]);
  });

  it('edits again once unlocked', () => {
    const { store, sent } = lockedStore();
    store.setEditLock(null);
    store.commit((deck) => { (deck.slides[0].elements[0] as { html: string }).html = 'Edited'; }, { label: 'Type' });
    expect((store.get().deck.slides[0].elements[0] as { html: string }).html).toBe('Edited');
    expect(sent).toEqual(['Type']);
  });
});
