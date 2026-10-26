// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { paintOrder } from '../src/renderer/editor/arrange.js';
import { ObjectList } from '../src/renderer/editor/objectList.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * The object list: the slide's objects front to back, each with a miniature,
 * picked and restacked by row.
 */

const text = (id: string, z: number, html: string, extra: Partial<SlideElement> = {}) => ({
  id, type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z, opacity: 1,
  class: [], style: {}, html, align: 'left', valign: 'top', ...extra,
}) as SlideElement;

const rect = (id: string, z: number, fill: string) => ({
  id, type: 'shape', shape: 'rect', x: 0, y: 0, w: 80, h: 40, rot: 0, z, opacity: 1,
  class: [], style: {}, fill, stroke: null, strokeWidth: 2, radius: 0, path: null,
  pathSize: null, arrowStart: false, arrowEnd: false,
}) as SlideElement;

function fixture(): Deck {
  const deck = emptyDeck('Objects');
  deck.slides[0].elements.push(
    text('title', 1, '<p>Results</p>'),
    rect('box', 2, '#2050e0'),
    // Off the slide and hidden until a click: still an object on it.
    text('note', 3, '<p>Later</p>', { x: 2400 }),
    text('master', 4, '<p>Footer</p>', { layoutMasterId: 'footer' } as Partial<SlideElement>),
  );
  deck.slides[0].timeline.push({
    id: 't-1', trigger: { on: 'click', ref: null, delay: 0 },
    action: { type: 'appear', target: 'note', value: null },
  });
  return deck;
}

function mount(deck = fixture()) {
  (globalThis as unknown as { window: Window }).window.api = { assetUrl: (src: string) => src } as never;
  const store = new EditorStore(deck, '/tmp/objects');
  const host = document.createElement('aside');
  document.body.appendChild(host);
  const list = new ObjectList(host, store);
  const ids = () => [...host.querySelectorAll<HTMLElement>('.object-list-row')].map((row) => row.dataset.elementId);
  const row = (id: string) => host.querySelector<HTMLElement>(`.object-list-row[data-element-id="${id}"]`)!;
  const selected = () => [...host.querySelectorAll<HTMLElement>('.object-list-row.selected')].map((r) => r.dataset.elementId);
  return { store, host, list, ids, row, selected };
}

const press = (node: HTMLElement, init: PointerEventInit = {}) => {
  node.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, ...init }));
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, ...init }));
};

/** Lay the rows out 20px apart so a drop's clientY lands in a known gap. */
function layOut(host: HTMLElement): void {
  host.querySelectorAll<HTMLElement>('.object-list-row').forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: index * 20, height: 20 } as DOMRect);
  });
}

function drag(from: HTMLElement, list: HTMLElement, clientY: number): void {
  const transfer = { setData() {}, setDragImage() {}, effectAllowed: '', dropEffect: '' };
  const event = (type: string) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
    Object.defineProperty(e, 'dataTransfer', { value: transfer });
    return e;
  };
  from.dispatchEvent(event('dragstart'));
  list.dispatchEvent(event('dragover'));
  list.dispatchEvent(event('drop'));
  from.dispatchEvent(event('dragend'));
}

describe('object list', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('lists every object front-most first, named and marked by kind', () => {
    const { host, list, ids, row } = mount();
    list.setVisible(true);
    expect(ids()).toEqual(['master', 'note', 'box', 'title']);
    expect(row('box').dataset.kind).toBe('shape-rect');
    const name = (id: string) => row(id).querySelector('.element-label-text')!.textContent;
    expect(name('box')).toBe('rectangle, blue');
    expect(name('title')).toBe('Results');
    expect(row('box').querySelector('.object-list-thumb')!.getAttribute('aria-hidden')).toBe('true');
    expect(row('master').classList.contains('locked')).toBe(true);
    expect(row('master').draggable).toBe(false);
    expect(host.querySelector('.object-list-count')!.textContent).toBe('4');
  });

  it('draws each row a miniature of its own object with the slide renderer', () => {
    const { list, row } = mount();
    list.setVisible(true);
    const thumb = row('box').querySelector<HTMLElement>('.object-list-thumb')!;
    // A slide surface holding this one object and nothing else.
    const drawn = [...thumb.querySelectorAll<HTMLElement>('[data-element-id]')].map((node) => node.dataset.elementId);
    expect(drawn).toEqual(['box']);
    expect(thumb.querySelector('.slide')).not.toBeNull();
    expect(row('title').querySelector('.object-list-thumb')!.textContent).toBe('Results');
    // Hidden until its build on the slide; drawn in its row all the same.
    expect(row('note').querySelector('.object-list-thumb [data-element-id="note"]')).not.toBeNull();
  });

  it('redraws only the rows whose object changed', () => {
    const { store, list, row } = mount();
    list.setVisible(true);
    const box = row('box');
    const title = row('title');
    store.select(['title']);
    store.updateSelected((element) => { element.x += 40; });
    expect(row('box')).toBe(box);
    expect(row('title')).not.toBe(title);
    expect(row('title').classList.contains('selected')).toBe(true);
  });

  it('selects like the canvas: a click picks one, Shift and Cmd add and drop', () => {
    const { store, list, row, selected } = mount();
    list.setVisible(true);
    press(row('box'));
    expect([...store.get().selection]).toEqual(['box']);
    press(row('note'), { shiftKey: true });
    expect([...store.get().selection].sort()).toEqual(['box', 'note']);
    press(row('box'), { metaKey: true });
    expect([...store.get().selection]).toEqual(['note']);
    press(row('title'), { ctrlKey: true });
    expect(selected()).toEqual(['note', 'title']);
    // A plain click on one of several selected rows narrows to it.
    press(row('title'));
    expect([...store.get().selection]).toEqual(['title']);
    // The layout's own objects are not picked from the list.
    press(row('master'));
    expect([...store.get().selection]).toEqual(['title']);
  });

  it('highlights what the canvas selects and follows the current slide', () => {
    const deck = fixture();
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'slide-2', elements: [rect('other', 1, '#000')], timeline: [] });
    const { store, list, ids, selected } = mount(deck);
    list.setVisible(true);
    store.select(['title', 'box']);
    expect(selected()).toEqual(['box', 'title']);
    store.selectSlide(1);
    expect(ids()).toEqual(['other']);
    expect(selected()).toEqual([]);
  });

  it('restacks the dragged selection as one undoable edit', () => {
    const { store, list, host, ids } = mount();
    list.setVisible(true);
    store.select(['title']);
    layOut(host);
    // Between "note" and "box": in front of the box, behind the note.
    drag(host.querySelector('.object-list-row[data-element-id="title"]')!, host.querySelector('.object-list-rows')!, 38);
    expect(ids()).toEqual(['master', 'note', 'title', 'box']);
    expect(paintOrder(store.slide!.elements).map((e) => e.id)).toEqual(['box', 'title', 'note', 'master']);
    expect(store.history()[0].label).toBe('Reorder objects');
    store.undo();
    expect(ids()).toEqual(['master', 'note', 'box', 'title']);
  });

  it('drags a group, and drops below the last row at the very back', () => {
    const { store, list, host, ids, row } = mount();
    list.setVisible(true);
    layOut(host);
    press(row('note'));
    press(row('master'), { shiftKey: true });
    press(row('box'), { shiftKey: true });
    // Dragging an unselected row restacks that row alone.
    drag(row('title'), host.querySelector('.object-list-rows')!, 0);
    expect(ids()).toEqual(['title', 'master', 'note', 'box']);
    expect([...store.get().selection]).toEqual(['title']);
    store.select(['note', 'title']);
    layOut(host);
    drag(row('note'), host.querySelector('.object-list-rows')!, 500);
    expect(ids()).toEqual(['master', 'box', 'title', 'note']);
    const before = store.history().length;
    layOut(host);
    // Dropped where it already is: no edit, no history.
    drag(row('note'), host.querySelector('.object-list-rows')!, 500);
    expect(store.history()).toHaveLength(before);
  });

  it('updates live for remote edits, and only catches up once shown', () => {
    const { store, list, ids } = mount();
    list.setVisible(true);
    const remote = structuredClone(store.get().deck);
    remote.slides[0].elements.push(rect('added', 9, '#e02020'));
    store.applyRemote(remote, 'Peer edit');
    expect(ids()[0]).toBe('added');
    list.setVisible(false);
    const removed = structuredClone(store.get().deck);
    removed.slides[0].elements = removed.slides[0].elements.filter((e) => e.id !== 'box');
    store.applyRemote(removed, 'Peer edit');
    list.setVisible(true);
    expect(ids()).toEqual(['added', 'master', 'note', 'title']);
  });

  it('starts closed, opens from its toggle, and remembers being open', () => {
    // A drawer over the canvas: closed until asked for, and drawing nothing
    // while closed. The editors put the toggle in the canvas's corner.
    const first = mount();
    expect(first.list.visible).toBe(false);
    expect(first.host.classList.contains('collapsed')).toBe(true);
    expect(first.ids()).toEqual([]);
    expect(first.list.toggle.getAttribute('aria-label')).toBe('Object list');
    expect(first.list.toggle.getAttribute('aria-pressed')).toBe('false');
    first.list.toggle.click();
    expect(first.host.classList.contains('collapsed')).toBe(false);
    expect(first.list.toggle.getAttribute('aria-pressed')).toBe('true');
    expect(first.ids()).toEqual(['master', 'note', 'box', 'title']);
    const next = mount();
    expect(next.list.visible).toBe(true);
    next.list.toggle.click();
    expect(mount().list.visible).toBe(false);
  });

  it('says so when the slide is empty', () => {
    const deck = emptyDeck('Empty');
    const { list, host } = mount(deck);
    list.setVisible(true);
    expect(host.querySelector('.object-list-empty')!.textContent).toBe('No objects on this slide.');
  });
});
