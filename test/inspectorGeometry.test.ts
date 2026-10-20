// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseDeck, type SlideElement } from '../src/shared/deck.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';

/**
 * The Geometry section, laid out as Keynote's Arrange pane: Position (X, Y)
 * and Size (W, H) on rows of their own, then Rotate -- a dial beside the
 * angle -- with Flip Horizontally and Flip Vertically. Every kind of object
 * gets the same rows, and a selection of several shows what they share.
 */

const ELEMENTS = [
  { id: 'text', type: 'text', x: 100, y: 100, w: 600, h: 120, rot: 20, html: 'Title' },
  { id: 'table', type: 'text', x: 100, y: 300, w: 600, h: 120, html: '<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>', table: { columnWidths: [1, 1] } },
  { id: 'image', type: 'image', x: 800, y: 100, w: 400, h: 300, rot: 20, src: 'assets/pic.png' },
  { id: 'video', type: 'video', x: 800, y: 500, w: 400, h: 225, src: 'assets/clip.mp4' },
  { id: 'rect', type: 'shape', shape: 'rect', x: 1300, y: 100, w: 300, h: 200, fill: '#cc5533' },
  { id: 'arrow', type: 'shape', shape: 'arrow', x: 1300, y: 400, w: 400, h: 4, rot: 30, stroke: '#333333', arrowEnd: true },
  { id: 'region', type: 'html', x: 100, y: 600, w: 300, h: 200, html: '<b>raw</b>' },
  { id: 'page', type: 'web', x: 500, y: 600, w: 300, h: 200, src: 'assets/web/page.html' },
  { id: 'gap', type: 'unsupported', x: 900, y: 800, w: 200, h: 100 },
];

function setup(): { store: EditorStore; host: HTMLElement } {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = { escape: (v: string) => v.replace(/["\\]/g, '\\$&') };
  }
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => `deck://${src}`,
    pathForFile: () => '',
    importAssets: async () => [],
    probeAsset: async () => ({ duration: 20 }),
  } as never;
  const deck = parseDeck({ version: 1, slides: [{ id: 's', elements: ELEMENTS }] });
  const store = new EditorStore(deck, '/tmp/geometry-inspector');
  const host = document.createElement('aside');
  document.body.replaceChildren(host);
  new Inspector(host, store);
  return { store, host };
}

const geometry = (host: HTMLElement): HTMLElement => host.querySelector<HTMLElement>('.geometry-section')!;

function row(host: HTMLElement, name: string): HTMLElement {
  const found = geometry(host).querySelector<HTMLElement>(`.geometry-row[data-row="${name}"]`);
  expect(found, `no ${name} row`).toBeTruthy();
  return found!;
}

function input(host: HTMLElement, label: string): HTMLInputElement {
  const field = [...geometry(host).querySelectorAll('label.field-number')]
    .find((node) => node.querySelector('span')?.textContent === label);
  expect(field, `no ${label} field`).toBeTruthy();
  return field!.querySelector('input')!;
}

const dial = (host: HTMLElement): HTMLElement => row(host, 'rotate').querySelector<HTMLElement>('.angle-dial')!;
const flipButton = (host: HTMLElement, axis: 'horizontal' | 'vertical'): HTMLButtonElement =>
  row(host, 'rotate').querySelector<HTMLButtonElement>(`button[data-flip="${axis}"]`)!;
const byId = (store: EditorStore, id: string): SlideElement =>
  store.slide!.elements.find((element) => element.id === id)!;

function change(field: HTMLInputElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event('change'));
}

describe('the Geometry section', () => {
  it('gives every kind of object Position, Size and Rotate rows', () => {
    const { store, host } = setup();
    for (const element of ELEMENTS) {
      store.select([element.id]);
      const names = [...geometry(host).querySelectorAll<HTMLElement>('.geometry-row-label')].map((label) => label.textContent);
      expect(names.slice(0, 3), element.id).toEqual(['Position', 'Size', 'Rotate']);
      const labels = (name: string) => [...row(host, name).querySelectorAll('.field > span:first-child')].map((span) => span.textContent);
      expect(labels('position'), element.id).toEqual(['X', 'Y']);
      expect(labels('size'), element.id).toEqual(['W', 'H']);
      expect(labels('rotate'), element.id).toEqual(['Angle', 'Flip']);
      expect(dial(host), element.id).toBeTruthy();
      expect(flipButton(host, 'horizontal').getAttribute('aria-label')).toBe('Flip horizontally');
      expect(flipButton(host, 'vertical').getAttribute('aria-label')).toBe('Flip vertically');
      expect(input(host, 'X').value, element.id).toBe(String(element.x));
      expect(input(host, 'H').value, element.id).toBe(String(element.h));
    }
  });

  it('shows the rotation on the dial, its hand along the object\'s own right-hand side', () => {
    const { store, host } = setup();
    store.select(['image']);
    expect(input(host, 'Angle').value).toBe('20');
    // 20° clockwise on the slide is 340° counter-clockwise on the dial.
    expect(dial(host).getAttribute('aria-valuenow')).toBe('340');
  });

  it('turns the selection with the dial, as one undo step', () => {
    const { store, host } = setup();
    store.select(['image']);
    // A turn counter-clockwise on the dial is a turn counter-clockwise on the slide.
    dial(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
    expect(byId(store, 'image').rot).toBe(5);
    expect(input(host, 'Angle').value).toBe('5');
    expect(dial(host).getAttribute('aria-valuenow')).toBe('355');
    store.undo();
    expect(byId(store, 'image').rot).toBe(20);
  });

  it('rotates from the angle field', () => {
    const { store, host } = setup();
    store.select(['rect']);
    change(input(host, 'Angle'), '45');
    expect(byId(store, 'rect').rot).toBe(45);
    expect(dial(host).getAttribute('aria-valuenow')).toBe('315');
  });

  it('keeps the dial with a rotation made on the canvas', () => {
    const { store, host } = setup();
    store.select(['rect']);
    const knob = dial(host);
    store.beginTransaction('Rotate');
    store.updateSelected((element) => { element.rot = 90; });
    // Mid-gesture the panel is refreshed in place, not rebuilt.
    expect(dial(host)).toBe(knob);
    expect(knob.getAttribute('aria-valuenow')).toBe('270');
    expect(input(host, 'Angle').value).toBe('90');
    store.endTransaction();
  });

  it('flips a box in place, mirroring it on the slide whatever its rotation', () => {
    const { store, host } = setup();
    store.select(['text']);
    flipButton(host, 'horizontal').click();
    expect(byId(store, 'text')).toMatchObject({ x: 100, y: 100, w: 600, h: 120, rot: 340, flipX: true });
    expect(input(host, 'Angle').value).toBe('340');
    flipButton(host, 'vertical').click();
    expect(byId(store, 'text')).toMatchObject({ rot: 20, flipX: true, flipY: true });
    flipButton(host, 'horizontal').click();
    expect(byId(store, 'text').flipX).toBeUndefined();
    store.undo();
    expect(byId(store, 'text')).toMatchObject({ rot: 20, flipX: true, flipY: true });
  });

  it('flips a picture, a video, a page and a table the same way', () => {
    const { store, host } = setup();
    for (const id of ['image', 'video', 'page', 'table', 'region', 'gap']) {
      store.select([id]);
      flipButton(host, 'vertical').click();
      expect(byId(store, id).flipY, id).toBe(true);
    }
  });

  it('flips an arrow by its ends rather than with a flag', () => {
    const { store, host } = setup();
    store.select(['arrow']);
    flipButton(host, 'horizontal').click();
    const arrow = byId(store, 'arrow');
    expect(arrow.rot).toBe(150);
    expect(arrow.flipX).toBeUndefined();
  });

  it('shows what a selection shares, blanks what it does not, and flips each in place', () => {
    const { store, host } = setup();
    store.select(['image', 'rect']);
    expect(input(host, 'X').value).toBe('');
    expect(input(host, 'Y').value).toBe('100');
    expect(input(host, 'Angle').value).toBe('');
    expect(dial(host).classList.contains('is-mixed')).toBe(true);

    store.select(['text', 'image']);
    expect(input(host, 'Angle').value).toBe('20');
    expect(dial(host).classList.contains('is-mixed')).toBe(false);
    flipButton(host, 'horizontal').click();
    expect(byId(store, 'text')).toMatchObject({ x: 100, rot: 340, flipX: true });
    expect(byId(store, 'image')).toMatchObject({ x: 800, rot: 340, flipX: true });
    // One click, one undo step for the whole selection.
    store.undo();
    expect(byId(store, 'text').flipX).toBeUndefined();
    expect(byId(store, 'image').flipX).toBeUndefined();

    store.select(['text', 'rect']);
    dial(host).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(byId(store, 'text').rot).toBe(byId(store, 'rect').rot);
  });
});
