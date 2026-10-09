// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore, sameDeckDrawing } from '../src/renderer/editor/store.js';

/**
 * Typing in the speaker notes drawer commits a fresh deck per keystroke. The
 * Props panel never shows a note, yet it rebuilt itself for every one of those
 * commits — and with nothing selected that panel is the slide layout preview
 * plus the Morph previews, so every slide picture in the sidebar flickered on
 * each key. A notes-only change must leave the panel alone, and the Morph
 * preview surfaces must survive it even when the panel later rebuilds for a
 * genuine reason.
 */
function setup(): { store: EditorStore; host: HTMLElement } {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (v: string) => v.replace(/["\\]/g, '\\$&'),
    };
  }
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
    pathForFile: () => '',
    importAssets: async () => [],
  } as never;
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: () => {} });

  const deck = emptyDeck('Notes');
  deck.slides[0].elements = [{
    id: 'text-1', type: 'text', x: 100, y: 100, w: 600, h: 120, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, html: 'Title', align: 'left', valign: 'middle',
  }];
  // Two slides, so the panel shows the Morph pair previews.
  deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'slide-2', elements: [] });
  const store = new EditorStore(deck, '/tmp/notes');
  const host = document.createElement('aside');
  document.body.replaceChildren(host);
  new Inspector(host, store);
  return { store, host };
}

function typeNote(store: EditorStore, text: string): void {
  store.commit((deck) => {
    deck.slides[0].notes = text;
  }, { label: 'Edit speaker notes' });
}

describe('inspector while speaker notes are typed', () => {
  it('leaves the panel untouched for a notes-only change', () => {
    const { store, host } = setup();
    const morph = host.querySelector('.morph-section');
    const layout = host.querySelector('.slide-layout-options');
    const preview = host.querySelector('.morph-compact-preview');
    expect(morph && layout && preview).toBeTruthy();

    store.beginTransaction('Edit speaker notes');
    typeNote(store, 'h');
    typeNote(store, 'he');
    store.endTransaction();
    typeNote(store, 'hello');

    expect(host.querySelector('.morph-section')).toBe(morph);
    expect(host.querySelector('.slide-layout-options')).toBe(layout);
    expect(host.querySelector('.morph-compact-preview')).toBe(preview);
  });

  it('keeps the Morph preview surface when the panel later rebuilds', () => {
    const { store, host } = setup();
    const preview = host.querySelector('.morph-compact-preview');
    expect(preview).toBeTruthy();

    typeNote(store, 'remember to pause');
    // A selection change is a genuine reason to rebuild the panel; the slide
    // still draws the same picture, so its preview is reused rather than
    // re-rendered.
    store.select(['text-1']);
    store.select([]);

    expect(host.querySelector('.morph-compact-preview')).toBe(preview);
  });

  it('still rebuilds when the slide itself changes', () => {
    const { store, host } = setup();
    const preview = host.querySelector('.morph-compact-preview');

    store.commit((deck) => {
      const text = deck.slides[0].elements[0];
      if (text.type === 'text') text.html = 'New title';
    }, { label: 'Edit text' });

    expect(host.querySelector('.morph-compact-preview')).not.toBe(preview);
  });
});

describe('sameDeckDrawing', () => {
  it('sees through a note edit but not through anything else', () => {
    const deck = emptyDeck('Compare');
    const noted = structuredClone(deck);
    noted.slides[0].notes = 'a note';
    expect(sameDeckDrawing(deck, noted)).toBe(true);

    const renamed = structuredClone(deck);
    renamed.slides[0].name = 'Other';
    expect(sameDeckDrawing(deck, renamed)).toBe(false);

    const retitled = structuredClone(deck);
    retitled.title = 'Other';
    expect(sameDeckDrawing(deck, retitled)).toBe(false);

    const longer = structuredClone(deck);
    longer.slides.push(structuredClone(deck.slides[0]));
    expect(sameDeckDrawing(deck, longer)).toBe(false);
  });
});
