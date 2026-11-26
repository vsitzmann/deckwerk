import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDeck } from '../src/shared/deck.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { copyElementStyle, pasteElementStyle } from '../src/renderer/editor/styleClipboard.js';

const report = vi.fn();
const element = (id: string, type: string, extra = {}) => ({
  id, type, x: 10, y: 20, w: 300, h: 150, rot: 5, z: 2, opacity: 1,
  class: [], style: {}, html: id, src: `${id}.mp4`, ...extra,
});
const storeOf = (elements: unknown[]) => new EditorStore(parseDeck({ version: 1, slides: [{ id: 'slide', elements }] }));

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window) });
  report.mockClear();
});

describe('object style clipboard', () => {
  it('copies image style to videos without changing content, geometry, crop or playback; undoes together', () => {
    const store = storeOf([
      element('source', 'image', { opacity: 0.6, style: { 'box-shadow': '0 4px 6px black', width: '900px' }, borderColor: '#123456', borderWidth: 3, borderRadius: 12, effects: [{ type: 'grayscale', amount: 0.5 }] }),
      element('target', 'video', { x: 400, y: 500, w: 200, h: 120, start: 5, end: 9, loop: false, autoplay: false, sourceBox: { x: -20, y: -30, w: 240, h: 180 }, style: { width: '200px', 'box-shadow': 'none' } }),
      element('other', 'image'),
    ]);
    store.select(['source']);
    copyElementStyle(store, report);
    const before = structuredClone(store.get().deck);
    store.select(['target', 'other']);
    pasteElementStyle(store, report);
    const target = store.slide!.elements[1];
    expect(target).toMatchObject({ type: 'video', src: 'target.mp4', x: 400, y: 500, w: 200, h: 120, rot: 5, z: 2, start: 5, end: 9, loop: false, autoplay: false, opacity: 0.6, borderColor: '#123456', borderWidth: 3, borderRadius: 12, sourceBox: { x: -20, y: -30, w: 240, h: 180 }, style: { width: '200px', 'box-shadow': '0 4px 6px black' } });
    expect(store.slide!.elements[2]).toMatchObject({ borderWidth: 3, opacity: 0.6 });
    store.undo();
    expect(store.get().deck).toEqual(before);
  });

  it('resolves theme/run typography while preserving destination text and list structure', () => {
    const store = storeOf([
      element('source', 'text', { class: ['role-title'], html: '<strong>Source</strong>', align: 'center', valign: 'middle' }),
      element('target', 'text', { html: '<ul><li><em>Keep this text</em></li></ul>', style: { 'font-size': '14px', color: 'blue' } }),
    ]);
    document.body.innerHTML = '<div class="slide-layer"><div data-element-id="source"><div class="text-content" style="font-family:serif;font-size:40px;line-height:52px;color:rgb(255,0,0)"><strong style="font-weight:700">Source</strong></div></div></div>';
    store.select(['source']);
    copyElementStyle(store, report);
    store.select(['target']);
    pasteElementStyle(store, report);
    const target = store.slide!.elements[1];
    expect(target.type).toBe('text');
    if (target.type !== 'text') throw new Error('wrong target');
    expect(target).toMatchObject({ class: ['role-title'], align: 'center', valign: 'middle', x: 10, y: 20, w: 300, h: 150, style: { 'font-size': '40px', 'font-weight': '700', 'font-style': 'normal', 'line-height': '1.3', color: 'rgb(255, 0, 0)' } });
    const content = document.createElement('div'); content.innerHTML = target.html;
    expect(content.textContent).toBe('Keep this text');
    expect(content.querySelector('ul > li')).not.toBeNull();
  });

  it('uses a separate clipboard across slides and rejects incompatible or malformed styles', () => {
    const store = storeOf([element('source', 'image', { borderWidth: 8 }), element('text', 'text')]);
    store.select(['source']); copyElementStyle(store, report);
    expect(window.localStorage.getItem('deckwerk.styleClipboard')).not.toContain('source.mp4');
    store.select(['text']);
    const before = structuredClone(store.get().deck);
    pasteElementStyle(store, report);
    expect(store.get().deck).toEqual(before);
    expect(report).toHaveBeenLastCalledWith('Select images or videos to paste this style.');
    window.localStorage.setItem('deckwerk.styleClipboard', '{"kind":"media","style":{"width":"999px"}}');
    pasteElementStyle(store, report);
    expect(store.get().deck).toEqual(before);
    expect(report).toHaveBeenLastCalledWith('Copy a style first (⌘⌥C).');
  });
});
