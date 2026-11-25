// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { edgeScroll, moveBuildGroup, TimelinePanel } from '../src/renderer/editor/timelinePanel.js';
import type { TimelineEntry } from '../src/shared/deck.js';

describe('Build panel interactions', () => {
  beforeEach(() => document.body.replaceChildren());

  it('adds selected reveals and reorders them by dragging their rows in the build order', () => {
    const deck = emptyDeck('Build');
    deck.slides[0].elements.push(
      { id: 'a', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: 'A', align: 'left', valign: 'top' },
      { id: 'b', type: 'text', x: 0, y: 60, w: 100, h: 50, rot: 0, z: 2,
        opacity: 1, class: [], style: {}, html: 'B', align: 'left', valign: 'top' },
    );
    const store = new EditorStore(deck, '/tmp/build');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);

    const addAnimation = () => [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Add animation')!.click();
    store.select(['a']);
    // The list row for the selected element lights up.
    expect(host.querySelector('.build-element-row[data-element-id="a"]')!.classList
      .contains('selected')).toBe(true);
    expect(host.querySelector('.build-element-row[data-element-id="b"]')!.classList
      .contains('selected')).toBe(false);
    addAnimation();
    store.select(['b']);
    addAnimation();
    expect(store.slide?.timeline.map((entry) => entry.action.target)).toEqual(['a', 'b']);

    // The build order lists one compact row per build; the row itself is the
    // drag handle.
    const rows = host.querySelectorAll<HTMLElement>('.build-overview-row');
    expect(rows).toHaveLength(2);
    const first = rows[0];
    const secondGrip = rows[1];
    expect(secondGrip.draggable).toBe(true);
    first.getBoundingClientRect = () => ({ top: 0, height: 90 } as DOMRect);
    const transfer = { setData() {}, effectAllowed: '', dropEffect: '' };
    const start = new Event('dragstart', { bubbles: true });
    Object.defineProperty(start, 'dataTransfer', { value: transfer });
    secondGrip.dispatchEvent(start);
    const over = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 5 });
    Object.defineProperty(over, 'dataTransfer', { value: transfer });
    first.dispatchEvent(over);
    expect(first.dataset.dropMode).toBe('before');
    const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientY: 5 });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    first.dispatchEvent(drop);

    expect(store.slide?.timeline.map((entry) => entry.action.target)).toEqual(['b', 'a']);
    expect(store.history()[0].label).toBe('Reorder build animations');
  });

  it('binds each card to one element with a number matching the canvas badge', () => {
    const deck = emptyDeck('Build');
    deck.slides[0].elements.push(
      { id: 'a', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: 'Alpha', align: 'left', valign: 'top' },
      { id: 'b', type: 'text', x: 0, y: 60, w: 100, h: 50, rot: 0, z: 2,
        opacity: 1, class: [], style: {}, html: 'Beta', align: 'left', valign: 'top' },
      { id: 'c', type: 'shape', shape: 'rect', x: 0, y: 120, w: 80, h: 40, rot: 0, z: 3,
        opacity: 1, class: [], style: {}, fill: null, stroke: null, strokeWidth: 2,
        radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false },
    );
    deck.slides[0].timeline.push(
      { id: 't-1', trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target: 'a', value: null } },
      { id: 't-2', trigger: { on: 'afterPrev', ref: null, delay: 0 },
        action: { type: 'appear', target: 'b', value: null } },
    );
    const store = new EditorStore(deck, '/tmp/build');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);

    // The build order: one row per build, beside one pill per click,
    // numbered as the canvas badges are: the second build follows the first,
    // so both run on click 1.
    const rows = [...host.querySelectorAll<HTMLElement>('.build-overview-row')];
    expect(rows).toHaveLength(2);
    // No element dropdown: the row names its element instead.
    expect(host.querySelector('select.build-target')).toBeNull();
    expect(rows.map((r) => r.querySelector('.build-num'))).toEqual([null, null]);
    expect([...host.querySelectorAll('.build-click-pill')].map((pill) => pill.textContent)).toEqual(['1']);
    expect(rows[0].querySelector('.build-target-name')?.textContent).toContain('Alpha');
    expect(rows[1].querySelector('.build-target-name')?.textContent).toContain('Beta');
    // Nothing picked yet: the settings card waits for a build.
    expect(host.querySelectorAll('.timeline-row')).toHaveLength(0);
    // Picking a row selects its element and shows that build's card, bound to
    // one element: the element is the card's headline, the trigger below it.
    rows[1].click();
    expect([...store.get().selection]).toEqual(['b']);
    const cards = [...host.querySelectorAll<HTMLElement>('.timeline-row')];
    expect(cards).toHaveLength(1);
    expect(cards[0].dataset.entryId).toBe('t-2');
    expect(cards[0].querySelector('.build-card-head .build-num')?.textContent).toBe('1');
    expect(cards[0].querySelector('.build-card-head .build-target-name')?.textContent).toContain('Beta');
    expect(cards[0].querySelector('.build-field select.build-trigger')).toBeTruthy();
    expect(host.querySelector('.build-overview-row[data-entry-id="t-2"]')!.classList.contains('selected')).toBe(true);
    // Elements are named by their content or shape, not their raw type.
    const listNames = [...host.querySelectorAll('.build-element-row')]
      .map((r) => r.textContent);
    expect(listNames).toEqual(['Alpha', 'Beta', 'rectangle']);
    // Clicking a list row selects that element in the store, and its build.
    (host.querySelector('.build-element-row[data-element-id="a"]') as HTMLButtonElement).click();
    expect([...store.get().selection]).toEqual(['a']);
    expect(host.querySelector<HTMLElement>('.timeline-row')!.dataset.entryId).toBe('t-1');
    // The pill spans both builds of its click.
    expect(host.querySelector<HTMLElement>('.build-click-pill')!.style.gridRow).toBe('span 2');
  });

  it('numbers clicks, links rows to their objects both ways, and takes a drop on a click pill', () => {
    const deck = emptyDeck('Build');
    for (const id of ['a', 'b', 'c']) {
      deck.slides[0].elements.push({ id, type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: id.toUpperCase(), align: 'left', valign: 'top' });
    }
    const step = (id: string, target: string, on: 'click' | 'withPrev') =>
      ({ id, trigger: { on, ref: null, delay: 0 }, action: { type: 'appear' as const, target, value: null } });
    deck.slides[0].timeline.push(step('t-1', 'a', 'click'), step('t-2', 'b', 'click'), step('t-3', 'c', 'withPrev'));
    const store = new EditorStore(deck, '/tmp/build');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const lit: Array<string[] | null> = [];
    const panel = new TimelinePanel(host, store, null, (ids) => lit.push(ids));

    const pills = () => [...host.querySelectorAll<HTMLElement>('.build-click-pill')];
    expect(pills().map((pill) => pill.textContent)).toEqual(['1', '2']);
    // The element list carries the same click numbers.
    expect(host.querySelector<HTMLElement>('.build-element-row[data-element-id="c"]')!.dataset.steps).toBe('2');

    const row = (id: string) => host.querySelector<HTMLElement>(`.build-overview-row[data-entry-id="${id}"]`)!;
    row('t-3').dispatchEvent(new Event('pointerenter'));
    row('t-3').dispatchEvent(new Event('pointerleave'));
    pills()[1].dispatchEvent(new Event('pointerenter'));
    expect(lit).toEqual([['c'], null, ['b', 'c']]);
    // A redraw under the pointer lets the slide go.
    store.select(['a']);
    expect(lit.at(-1)).toBeNull();

    panel.highlightBuildsOf('b');
    expect([...host.querySelectorAll<HTMLElement>('.build-overview-row.linked')].map((r) => r.dataset.entryId))
      .toEqual(['t-2']);
    panel.highlightBuildsOf(null);
    expect(host.querySelector('.build-overview-row.linked')).toBeNull();

    // Dropping the last build on click 1's pill makes it the first.
    const transfer = { setData() {}, effectAllowed: '', dropEffect: '' };
    const fire = (target: Element, type: string) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      target.dispatchEvent(event);
    };
    fire(row('t-3'), 'dragstart');
    fire(pills()[0], 'dragover');
    expect(pills()[0].dataset.dropMode).toBe('before');
    fire(pills()[0], 'drop');
    expect(store.slide?.timeline.map((entry) => entry.id)).toEqual(['t-3', 't-1', 't-2']);
    expect(pills().map((pill) => pill.textContent)).toEqual(['1', '2', '3']);
  });

  it('drags a click pill to move all of its builds at once', () => {
    const deck = emptyDeck('Build');
    for (const id of ['a', 'b', 'c', 'd']) {
      deck.slides[0].elements.push({ id, type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: id.toUpperCase(), align: 'left', valign: 'top' });
    }
    const step = (id: string, target: string, on: 'click' | 'withPrev') =>
      ({ id, trigger: { on, ref: null, delay: 0 }, action: { type: 'appear' as const, target, value: null } });
    deck.slides[0].timeline.push(
      step('t-1', 'a', 'click'), step('t-2', 'b', 'click'), step('t-3', 'c', 'withPrev'), step('t-4', 'd', 'click'));
    const store = new EditorStore(deck, '/tmp/build');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);

    const pills = () => [...host.querySelectorAll<HTMLElement>('.build-click-pill')];
    const row = (id: string) => host.querySelector<HTMLElement>(`.build-overview-row[data-entry-id="${id}"]`)!;
    const transfer = { setData() {}, effectAllowed: '', dropEffect: '' };
    const fire = (target: Element, type: string) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      target.dispatchEvent(event);
    };
    expect(pills()[1].draggable).toBe(true);

    // Click 2 (b and c) onto click 1's pill: both builds move above a.
    fire(pills()[1], 'dragstart');
    expect(row('t-2').classList.contains('dragging')).toBe(true);
    expect(row('t-3').classList.contains('dragging')).toBe(true);
    fire(pills()[0], 'dragover');
    expect(row('t-1').dataset.groupDrop).toBe('before');
    fire(pills()[0], 'drop');
    fire(pills()[1], 'dragend');
    expect(store.slide?.timeline.map((entry) => entry.id)).toEqual(['t-2', 't-3', 't-1', 't-4']);
    expect(pills().map((pill) => pill.textContent)).toEqual(['1', '2', '3']);
    expect(store.history()[0].label).toBe('Reorder build animations');

    // Click 1 (b and c) into the middle of d's row: they join click 3.
    fire(pills()[0], 'dragstart');
    const d = row('t-4');
    d.getBoundingClientRect = () => ({ top: 0, height: 30, bottom: 30, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON() {} });
    const over = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 15 });
    Object.defineProperty(over, 'dataTransfer', { value: transfer });
    d.dispatchEvent(over);
    expect(row('t-4').dataset.groupDrop).toBe('fuse');
    fire(d, 'drop');
    expect(store.slide?.timeline.map((entry) => [entry.id, entry.trigger.on])).toEqual(
      [['t-1', 'click'], ['t-4', 'click'], ['t-2', 'withPrev'], ['t-3', 'withPrev']]);
    expect(pills().map((pill) => pill.textContent)).toEqual(['1', '2']);
  });

  it('moves a click as a block, keeping what builds as the slide appears in its place', () => {
    const entry = (id: string, on: TimelineEntry['trigger']['on'], delay = 0): TimelineEntry =>
      ({ id, trigger: { on, ref: null, delay }, action: { type: 'appear', target: id, value: null } });
    const shape = (timeline: TimelineEntry[]) => timeline.map((e) => `${e.id}:${e.trigger.on}:${e.trigger.delay}`);

    // Below the next click.
    let timeline = [entry('a', 'click'), entry('b', 'withPrev'), entry('c', 'click'), entry('d', 'click')];
    moveBuildGroup(timeline, ['a', 'b'], ['c'], 'after');
    expect(shape(timeline)).toEqual(['c:click:0', 'a:click:0', 'b:withPrev:0', 'd:click:0']);

    // Above what builds on entry: the moved click builds on entry instead.
    timeline = [entry('e', 'afterPrev', 500), entry('a', 'click'), entry('b', 'withPrev')];
    moveBuildGroup(timeline, ['a', 'b'], ['e'], 'before');
    expect(shape(timeline)).toEqual(['a:afterPrev:500', 'b:withPrev:0', 'e:click:0']);

    // What built on entry, moved down, takes a click of its own.
    timeline = [entry('e', 'afterPrev', 500), entry('f', 'withPrev'), entry('a', 'click')];
    moveBuildGroup(timeline, ['e', 'f'], ['a'], 'after');
    expect(shape(timeline)).toEqual(['a:click:0', 'e:click:0', 'f:withPrev:0']);

    // Onto itself: nothing changes.
    timeline = [entry('a', 'click'), entry('b', 'click')];
    moveBuildGroup(timeline, ['a'], ['a'], 'before');
    expect(shape(timeline)).toEqual(['a:click:0', 'b:click:0']);
  });

  it('keeps the build order scrolled where it was when a drop redraws it', () => {
    const deck = emptyDeck('Build');
    for (const id of ['a', 'b', 'c']) {
      deck.slides[0].elements.push({ id, type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: id.toUpperCase(), align: 'left', valign: 'top' });
    }
    deck.slides[0].timeline.push(...['a', 'b', 'c'].map((target, i) => (
      { id: `t-${i + 1}`, trigger: { on: 'click' as const, ref: null, delay: 0 },
        action: { type: 'appear' as const, target, value: null } })));
    const store = new EditorStore(deck, '/tmp/build');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);
    host.querySelector<HTMLElement>('.build-overview')!.scrollTop = 40;

    const transfer = { setData() {}, effectAllowed: '', dropEffect: '' };
    const fire = (target: Element, type: string) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      target.dispatchEvent(event);
    };
    fire(host.querySelector('.build-overview-row[data-entry-id="t-3"]')!, 'dragstart');
    const first = host.querySelector<HTMLElement>('.build-overview-row[data-entry-id="t-1"]')!;
    first.dataset.dropMode = 'before';
    fire(first, 'drop');

    expect(store.slide?.timeline.map((entry) => entry.id)).toEqual(['t-3', 't-1', 't-2']);
    expect(store.history()[0].label).toBe('Reorder build animations');
    // The redrawn list stays where it was scrolled.
    expect(host.querySelector<HTMLElement>('.build-overview')!.scrollTop).toBe(40);
  });

  it('scrolls a list under a dragged build only near its top or bottom edge', () => {
    const list = document.createElement('div');
    list.getBoundingClientRect = () => ({ top: 100, bottom: 400, left: 0, right: 200, height: 300 } as DOMRect);
    let top = 50;
    Object.defineProperty(list, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, 500)); } });

    expect(edgeScroll(list, 100, 250)).toBe(false);
    expect(top).toBe(50);
    // Over the slide beside the list, at the list's bottom: no scroll.
    expect(edgeScroll(list, 300, 398)).toBe(false);
    expect(edgeScroll(list, 100, 398)).toBe(true);
    expect(top).toBeGreaterThan(50);
    // Just above the list, over its heading, scrolls it up at full speed.
    const before = top;
    expect(edgeScroll(list, 100, 95)).toBe(true);
    expect(top).toBe(before - 16);
    top = 0;
    expect(edgeScroll(list, 100, 101)).toBe(false);
  });

  it('picks several builds with Shift and Cmd/Ctrl and deletes them together', () => {
    const deck = emptyDeck('Build');
    for (const id of ['a', 'b', 'c', 'd']) {
      deck.slides[0].elements.push({ id, type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: id.toUpperCase(), align: 'left', valign: 'top' });
    }
    deck.slides[0].timeline.push(...['a', 'b', 'c', 'd'].map((target, i) => (
      { id: `t-${i + 1}`, trigger: { on: 'click' as const, ref: null, delay: 0 },
        action: { type: 'appear' as const, target, value: null } })));
    const store = new EditorStore(deck, '/tmp/build');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);
    const row = (id: string) => host.querySelector<HTMLElement>(`.build-overview-row[data-entry-id="${id}"]`)!;
    const click = (id: string, keys: MouseEventInit = {}) =>
      row(id).dispatchEvent(new MouseEvent('click', { bubbles: true, ...keys }));
    const picked = () => [...host.querySelectorAll<HTMLElement>('.build-overview-row.selected')]
      .map((r) => r.dataset.entryId);

    // Shift picks the range from the last build clicked, and selects every
    // object those builds animate.
    click('t-1');
    click('t-3', { shiftKey: true });
    expect(picked()).toEqual(['t-1', 't-2', 't-3']);
    expect([...store.get().selection].sort()).toEqual(['a', 'b', 'c']);
    expect(host.querySelector('.timeline-row')).toBeNull();
    expect(host.querySelector('.build-delete-picked')?.textContent).toBe('Delete 3 builds');

    // Cmd/Ctrl drops one from the pick, and adds one.
    click('t-2', { metaKey: true });
    expect(picked()).toEqual(['t-1', 't-3']);
    click('t-4', { ctrlKey: true });
    expect(picked()).toEqual(['t-1', 't-3', 't-4']);

    // Delete on a picked row removes those builds -- never the objects -- in
    // one undo step, and focus moves on to the next build.
    row('t-3').focus();
    const del = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true });
    let reachedWindow = false;
    const onWindow = () => { reachedWindow = true; };
    window.addEventListener('keydown', onWindow);
    row('t-3').dispatchEvent(del);
    window.removeEventListener('keydown', onWindow);
    expect(reachedWindow).toBe(false);
    expect(store.slide?.timeline.map((entry) => entry.id)).toEqual(['t-2']);
    expect(store.slide?.elements.map((element) => element.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(store.get().selection.size).toBe(0);
    expect(store.history()[0].label).toBe('Delete 3 builds');
    expect((document.activeElement as HTMLElement).dataset.entryId).toBe('t-2');
    store.undo();
    expect(store.slide?.timeline.map((entry) => entry.id)).toEqual(['t-1', 't-2', 't-3', 't-4']);

    // Cmd/Ctrl+A picks them all; the button deletes the pick.
    click('t-2');
    row('t-2').focus();
    row('t-2').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
    expect(picked()).toEqual(['t-1', 't-2', 't-3', 't-4']);
    host.querySelector<HTMLButtonElement>('.build-delete-picked')!.click();
    expect(store.slide?.timeline).toEqual([]);

    // A plain click ends a pick, and so does picking an object on the slide.
    store.undo();
    click('t-1');
    click('t-2', { shiftKey: true });
    expect(picked()).toEqual(['t-1', 't-2']);
    click('t-4');
    expect(picked()).toEqual(['t-4']);
    click('t-3', { shiftKey: true });
    expect(picked()).toEqual(['t-3', 't-4']);
    store.select(['a']);
    expect(picked()).toEqual(['t-1']);
    expect(host.querySelector<HTMLElement>('.timeline-row')!.dataset.entryId).toBe('t-1');
  });

  it('writes an element\'s steps in the list as the canvas badge does', () => {
    const deck = emptyDeck('Build');
    deck.slides[0].elements.push(
      { id: 'a', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1,
        opacity: 1, class: [], style: {}, html: 'Alpha', align: 'left', valign: 'top' },
      { id: 'b', type: 'text', x: 0, y: 60, w: 100, h: 50, rot: 0, z: 2,
        opacity: 1, class: [], style: {}, html: 'Beta', align: 'left', valign: 'top' },
    );
    const step = (id: string, type: 'appear' | 'disappear', target: string) => (
      { id, trigger: { on: 'click' as const, ref: null, delay: 0 }, action: { type, target, value: null } });
    deck.slides[0].timeline.push(step('t-1', 'appear', 'a'), step('t-2', 'appear', 'b'), step('t-3', 'disappear', 'a'));
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, new EditorStore(deck, '/tmp/build'));

    const steps = (id: string) =>
      host.querySelector<HTMLElement>(`.build-element-row[data-element-id="${id}"]`)!.dataset.steps;
    expect(steps('a')).toBe('1,3');
    expect(steps('b')).toBe('2');
  });
});
