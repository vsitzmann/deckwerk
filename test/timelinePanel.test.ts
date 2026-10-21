// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { TimelinePanel } from '../src/renderer/editor/timelinePanel.js';

describe('Build panel interactions', () => {
  beforeEach(() => document.body.replaceChildren());

  it('adds selected reveals and reorders them through the visible drag grip', () => {
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

    const rows = host.querySelectorAll<HTMLElement>('.timeline-row');
    const first = rows[0];
    const secondGrip = rows[1].querySelector<HTMLElement>('.build-drag-handle')!;
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

    const rows = [...host.querySelectorAll<HTMLElement>('.timeline-row')];
    expect(rows).toHaveLength(2);
    // No element dropdown: the card names its element instead.
    expect(host.querySelector('select.build-target')).toBeNull();
    expect(rows.map((r) => r.querySelector('.build-num')?.textContent)).toEqual(['1', '2']);
    expect(rows[0].querySelector('.build-target-name')?.textContent).toContain('Alpha');
    expect(rows[1].querySelector('.build-target-name')?.textContent).toContain('Beta');
    // The element is the card's headline; the trigger sits on the line below.
    expect(rows[0].querySelector('.build-card-head .build-target-name')).toBeTruthy();
    expect(rows[0].querySelector('.build-card-when select.build-trigger')).toBeTruthy();
    // Elements are named by their content or shape, not their raw type.
    const listNames = [...host.querySelectorAll('.build-element-row')]
      .map((r) => r.textContent);
    expect(listNames).toEqual(['Alpha', 'Beta', 'rectangle']);
    // Clicking a list row selects that element in the store.
    (host.querySelector('.build-element-row[data-element-id="b"]') as HTMLButtonElement).click();
    expect([...store.get().selection]).toEqual(['b']);
    // The redundant "Click N" step labels are gone.
    const labels = [...host.querySelectorAll('.step-label')].map((l) => l.textContent);
    expect(labels.some((t) => /^Click \d/.test(t ?? ''))).toBe(false);
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
