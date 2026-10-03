// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { suggestMorphPairs } from '../src/shared/morph.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { SlideRail } from '../src/renderer/editor/slideRail.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { STOCK_STYLESHEET_STYLE, THEMES, adoptThemeStyles, fullThemeSelection } from '../src/shared/themes.js';
import { defaultLayoutMasters, syncDeckWithLayoutMasters } from '../src/shared/layoutMasters.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { PLAYER_TYPE_CSS } from '../src/shared/playerTypeCss.js';

/**
 * Rows select on pointerdown (a click never arrives when the browser turns a
 * slightly-wobbly press on the draggable row into a native drag).
 */
function pickRow(row: HTMLElement, shiftKey = false): void {
  row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, shiftKey }));
}

function togglePickRow(row: HTMLElement): void {
  row.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, metaKey: true }));
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function setup() {
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => src,
  } as never;
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
  const deck = emptyDeck('Rail');
  deck.slides.push({
    id: 'slide-2', name: 'Second', background: { color: null, image: null },
    notes: '', elements: [], timeline: [],
  });
  const store = new EditorStore(deck, '/tmp/deck');
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const rail = new SlideRail(host, store);
  return { store, host, rail };
}

describe('collaborator presence in the slide rail', () => {
  beforeEach(() => document.body.replaceChildren());

  it('highlights a remote element selection on another slide without rebuilding its thumbnail', () => {
    const { store, host, rail } = setup();
    store.commit((deck) => {
      deck.slides[1].elements.push({
        id: 'title-2', type: 'text', x: 100, y: 80, w: 800, h: 160,
        rot: 5, z: 1, opacity: 1, class: ['role-title'], style: {},
        html: 'Selected elsewhere', align: 'left', valign: 'top',
      });
    }, { history: false });

    const secondThumb = host.querySelectorAll<HTMLElement>('.rail-thumb')[1];
    rail.presenceForSlide = (slideId) => slideId === 'slide-2' ? [{
      name: 'Ada', color: '#ff3366', selectedElementIds: ['title-2'],
    }] : [];
    rail.refreshPresence();

    const secondRow = host.querySelectorAll<HTMLElement>('.rail-item')[1];
    const selection = secondRow.querySelector<HTMLElement>('.rail-presence-selection')!;
    expect(selection.title).toBe('Ada');
    expect(selection.style.left).toBe('8.75px');
    expect(selection.style.top).toBe('7px');
    expect(selection.style.width).toBe('70px');
    expect(selection.style.height).toBe('14px');
    expect(selection.style.transform).toBe('rotate(5deg)');
    expect(selection.style.outline).toBe('2px solid #ff3366');
    expect(secondRow.querySelector('.rail-presence-dot')).not.toBeNull();
    expect(host.querySelectorAll<HTMLElement>('.rail-thumb')[1]).toBe(secondThumb);

    rail.presenceForSlide = () => [];
    rail.refreshPresence();
    expect(secondRow.querySelector('.rail-presence-selection')).toBeNull();
    expect(secondRow.querySelector('.rail-presence-dot')).toBeNull();
    expect(host.querySelectorAll<HTMLElement>('.rail-thumb')[1]).toBe(secondThumb);
  });
});

describe('slide activation', () => {
  it('announces an explicit pick even when the active slide is picked again', () => {
    const { host, rail } = setup();
    const onSlideActivate = vi.fn();
    rail.onSlideActivate = onSlideActivate;

    pickRow(host.querySelector<HTMLElement>('.rail-item')!);

    expect(onSlideActivate).toHaveBeenCalledWith(0);
  });
});

describe('editing objects with the slide rail visible', () => {
  it('keeps every thumbnail mounted throughout a drag and refreshes after drop', () => {
    const { store, host } = setup();
    store.commit((deck) => {
      deck.slides[0].elements.push({
        id: 'drag-me', type: 'text', x: 100, y: 80, w: 800, h: 160,
        rot: 0, z: 1, opacity: 1, class: ['role-title'], style: {},
        html: 'Drag me', align: 'left', valign: 'top',
      });
    }, { history: false });
    store.select(['drag-me']);

    const before = [...host.querySelectorAll<HTMLElement>('.rail-thumb')];
    store.beginTransaction();
    store.updateSelected((element) => { element.x = 140; });
    expect([...host.querySelectorAll('.rail-thumb')]).toEqual(before);
    store.updateSelected((element) => { element.x = 180; });
    expect([...host.querySelectorAll('.rail-thumb')]).toEqual(before);

    store.endTransaction();
    const after = [...host.querySelectorAll<HTMLElement>('.rail-thumb')];
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(store.slide?.elements[0].x).toBe(180);
  });
});

describe('resizing the slide rail', () => {
  beforeEach(() => document.body.replaceChildren());

  it('scales the preview surface and collaboration boxes to the thumbnail width', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() { return (this as HTMLElement).classList.contains('rail-thumb') ? 240 : 0; },
    });

    try {
      const { store, host, rail } = setup();
      store.commit((deck) => {
        deck.slides[0].elements.push({
          id: 'title-1', type: 'text', x: 160, y: 80, w: 800, h: 160,
          rot: 0, z: 1, opacity: 1, class: ['role-title'], style: {},
          html: 'Responsive preview', align: 'left', valign: 'top',
        });
      }, { history: false });
      rail.presenceForSlide = (slideId) => slideId === 'slide-1' ? [{
        name: 'Ada', color: '#ff3366', selectedElementIds: ['title-1'],
      }] : [];
      rail.refreshPresence();

      const thumb = host.querySelector<HTMLElement>('.rail-thumb')!;
      expect(thumb.style.getPropertyValue('--rail-thumb-aspect')).toBe('1920 / 1080');
      expect(thumb.querySelector<HTMLElement>('.rail-thumb-inner')!.style.transform)
        .toBe('scale(0.125)');
      const selection = thumb.querySelector<HTMLElement>('.rail-presence-selection')!;
      expect(selection.style.left).toBe('20px');
      expect(selection.style.width).toBe('100px');
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
      else delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
    }
  });
});

describe('large-deck thumbnail virtualization', () => {
  it('updates only the changed rows during ordinary keyboard navigation', () => {
    const deck = emptyDeck('Large highlight');
    deck.slides = Array.from({ length: 1_000 }, (_, index) => ({
      id: `slide-${index + 1}`, name: `Slide ${index + 1}`,
      background: { color: null, image: null }, notes: '', elements: [], timeline: [],
    }));
    const store = new EditorStore(deck, '/tmp/large-highlight');
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    new SlideRail(host, store);
    const allRows = vi.spyOn(host, 'querySelectorAll');

    store.selectSlide(1);

    expect(host.querySelector<HTMLElement>('[data-index="0"]')?.classList.contains('active')).toBe(false);
    expect(host.querySelector<HTMLElement>('[data-index="1"]')?.classList.contains('active')).toBe(true);
    expect(allRows.mock.calls.some(([selector]) => selector === '.rail-item')).toBe(false);
  });

  it('mounts only the active and near-viewport slide surfaces', () => {
    const original = globalThis.IntersectionObserver;
    let callback: IntersectionObserverCallback = () => {
      throw new Error('IntersectionObserver was not constructed');
    };
    class FakeIntersectionObserver {
      observed: Element[] = [];
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe = (target: Element) => { this.observed.push(target); };
      unobserve = (target: Element) => {
        this.observed = this.observed.filter((candidate) => candidate !== target);
      };
      disconnect = () => { this.observed = []; };
      takeRecords = () => [];
      root = null;
      rootMargin = '';
      thresholds = [];
    }
    globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    try {
      const deck = emptyDeck('Large rail');
      deck.slides = Array.from({ length: 80 }, (_, index) => ({
        id: `slide-${index + 1}`, name: `Slide ${index + 1}`,
        background: { color: null, image: null }, notes: '', elements: [], timeline: [],
      }));
      const store = new EditorStore(deck, '/tmp/large-rail');
      const host = document.createElement('div');
      document.body.replaceChildren(host);
      new SlideRail(host, store);

      expect(host.querySelectorAll('.rail-item')).toHaveLength(80);
      expect(host.querySelectorAll('.rail-thumb-inner')).toHaveLength(1);
      const placeholders = [...host.querySelectorAll<HTMLElement>('.rail-thumb-placeholder')];
      expect(placeholders).toHaveLength(79);

      callback(placeholders.slice(0, 3).map((target) => ({
        target, isIntersecting: true,
      } as unknown as IntersectionObserverEntry)), {} as IntersectionObserver);
      expect(host.querySelectorAll('.rail-thumb-inner')).toHaveLength(4);

      const promoted = host.querySelectorAll<HTMLElement>('.rail-thumb:not(.rail-thumb-placeholder)')[1];
      callback([{
        target: promoted, isIntersecting: false,
      } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
      expect(host.querySelectorAll('.rail-thumb-inner')).toHaveLength(3);
      expect(host.querySelectorAll('.rail-thumb-placeholder')).toHaveLength(77);
    } finally {
      if (original) globalThis.IntersectionObserver = original;
      else delete (globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    }
  });
});

describe('deleting slides from the rail', () => {
  beforeEach(() => document.body.replaceChildren());

  const push = (store: ReturnType<typeof setup>['store'], ...ids: string[]) =>
    store.commit((deck) => {
      for (const id of ids) {
        deck.slides.push({
          id, name: id, background: { color: null, image: null }, notes: '',
          elements: [], timeline: [],
        });
      }
    }, { history: false });

  it('deletes every slide in a Shift-click range as one undo entry', () => {
    const { store, host } = setup();
    push(store, 'slide-3', 'slide-4', 'slide-5');

    const items = () => host.querySelectorAll<HTMLElement>('.rail-item');
    pickRow(items()[1]);
    pickRow(items()[3], true);
    expect([...store.get().slideSelection]).toEqual(['slide-2', 'slide-3', 'slide-4']);

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

    expect(store.get().deck.slides.map((slide) => slide.id)).toEqual(['slide-1', 'slide-5']);
    expect(store.history()[0].label).toBe('Delete 3 slides');
    // The cursor lands just before the range that was removed.
    expect(store.get().slideIndex).toBe(0);

    store.undo();
    expect(store.get().deck.slides).toHaveLength(5);
  });

  it('takes focus when a slide is clicked, so Backspace is a slide command', () => {
    const { store, host } = setup();
    pickRow(host.querySelectorAll<HTMLElement>('.rail-item')[1]);
    expect(document.activeElement).toBe(host);
    expect(store.get().slideIndex).toBe(1);
  });

  it('deletes only the current slide when just one is selected', () => {
    const { store, host } = setup();
    push(store, 'slide-3');
    pickRow(host.querySelectorAll<HTMLElement>('.rail-item')[1]);
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

    expect(store.get().deck.slides.map((slide) => slide.id)).toEqual(['slide-1', 'slide-3']);
    expect(store.history()[0].label).toBe('Delete slide');
  });

  it('deletes a scattered Cmd-click selection in one keystroke', () => {
    const { store, host } = setup();
    push(store, 'slide-3', 'slide-4', 'slide-5');

    const items = () => host.querySelectorAll<HTMLElement>('.rail-item');
    pickRow(items()[0]);
    togglePickRow(items()[2]);
    togglePickRow(items()[4]);
    expect([...store.get().slideSelection]).toEqual(['slide-1', 'slide-3', 'slide-5']);

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

    expect(store.get().deck.slides.map((slide) => slide.id)).toEqual(['slide-2', 'slide-4']);
    expect(store.history()[0].label).toBe('Delete 3 slides');

    store.undo();
    expect(store.get().deck.slides).toHaveLength(5);
  });

  it('drops a Cmd-clicked slide back out of the selection', () => {
    const { store, host } = setup();
    push(store, 'slide-3');

    const items = () => host.querySelectorAll<HTMLElement>('.rail-item');
    pickRow(items()[0]);
    togglePickRow(items()[1]);
    togglePickRow(items()[2]);
    togglePickRow(items()[1]);
    expect([...store.get().slideSelection]).toEqual(['slide-1', 'slide-3']);

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(store.get().deck.slides.map((slide) => slide.id)).toEqual(['slide-2']);
  });

  it('never unpicks the last remaining slide of the selection', () => {
    const { store, host } = setup();
    const items = () => host.querySelectorAll<HTMLElement>('.rail-item');
    pickRow(items()[1]);
    togglePickRow(items()[1]);

    expect([...store.get().slideSelection]).toEqual(['slide-2']);
    expect(store.get().slideIndex).toBe(1);
  });

  it('leaves one fresh slide behind when the selection covers the deck', () => {
    const { store, host } = setup();
    const items = () => host.querySelectorAll<HTMLElement>('.rail-item');
    pickRow(items()[0]);
    pickRow(items()[1], true);

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

    const slides = store.get().deck.slides;
    expect(slides).toHaveLength(1);
    // The surviving row keeps its id but none of its content: the deck is
    // never momentarily empty, which the operation log cannot replay.
    expect(slides[0].id).toBe('slide-1');
    expect(slides[0].name).toBe('');
    expect(store.get().slideIndex).toBe(0);
    expect([...store.get().slideSelection]).toEqual([slides[0].id]);
    expect(store.history()[0].label).toBe('Delete 2 slides');

    store.undo();
    expect(store.get().deck.slides.map((slide) => slide.id)).toEqual(['slide-1', 'slide-2']);
  });

  it('does not swap the deck\'s only slide for another empty one', () => {
    const { store, host } = setup();
    store.commit((deck) => { deck.slides.length = 1; }, { history: false });
    pickRow(host.querySelectorAll<HTMLElement>('.rail-item')[0]);

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(store.get().deck.slides.map((slide) => slide.id)).toEqual(['slide-1']);
  });

  it('selects and deletes a large collapsed hidden suffix without expanding it', () => {
    const deck = emptyDeck('Imported deck with hidden appendix');
    deck.slides = Array.from({ length: 215 }, (_, index) => ({
      id: `slide-${index + 1}`,
      name: `Slide ${index + 1}`,
      background: { color: null, image: null },
      notes: '',
      elements: [],
      timeline: [],
      ...(index >= 181 ? { skipped: true } : {}),
    }));
    const store = new EditorStore(deck, '/tmp/large-hidden-suffix');
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    new SlideRail(host, store);

    store.selectSlide(180);
    const collapsed = host.querySelector<HTMLElement>('.rail-collapsed')!;
    expect(collapsed.title).toBe('Show hidden slides 182–215');
    expect(host.querySelector('.rail-run')).toBeNull();

    pickRow(collapsed, true);

    expect(store.get().slideIndex).toBe(214);
    expect([...store.get().slideSelection]).toEqual(
      Array.from({ length: 34 }, (_, index) => `slide-${index + 182}`),
    );
    expect(host.querySelector('.rail-run')).toBeNull();
    expect(host.querySelector('.rail-collapsed.selected')).not.toBeNull();

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));

    expect(store.get().deck.slides).toHaveLength(181);
    expect(store.get().deck.slides.at(-1)?.id).toBe('slide-181');
    expect(store.history()[0].label).toBe('Delete 34 slides');
  });

  it('fuzzes collapsed hidden suffix selection, deletion, and undo', () => {
    const random = mulberry32(2608182);
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const slideCount = 3 + Math.floor(random() * 68);
      const hiddenCount = 2 + Math.floor(random() * (slideCount - 2));
      const hiddenStart = slideCount - hiddenCount;
      const ids = Array.from({ length: slideCount }, (_, index) => `fuzz-${attempt}-${index}`);
      const deck = emptyDeck(`Hidden suffix fuzz ${attempt}`);
      deck.slides = ids.map((id, index) => ({
        id,
        name: id,
        background: { color: null, image: null },
        notes: '',
        elements: [],
        timeline: [],
        ...(index >= hiddenStart ? { skipped: true } : {}),
      }));
      const store = new EditorStore(deck, `/tmp/hidden-suffix-fuzz-${attempt}`);
      const host = document.createElement('div');
      document.body.replaceChildren(host);
      new SlideRail(host, store);
      store.selectSlide(hiddenStart - 1);

      const collapsed = host.querySelector<HTMLElement>('.rail-collapsed')!;
      pickRow(collapsed, true);
      expect([...store.get().slideSelection], `attempt ${attempt}: selected ids`)
        .toEqual(ids.slice(hiddenStart));
      expect(host.querySelector('.rail-run'), `attempt ${attempt}: stayed collapsed`).toBeNull();

      host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
      expect(
        store.get().deck.slides.map((slide) => slide.id),
        `attempt ${attempt}: surviving prefix`,
      ).toEqual(ids.slice(0, hiddenStart));
      store.undo();
      expect(
        store.get().deck.slides.map((slide) => slide.id),
        `attempt ${attempt}: undo`,
      ).toEqual(ids);
    }
  });
});

describe('hiding slides from the rail', () => {
  beforeEach(() => document.body.replaceChildren());

  it('toggles skipped for the whole selection, driven by the current slide', () => {
    const { store, host } = setup();
    const items = () => host.querySelectorAll<HTMLElement>('.rail-item');
    pickRow(items()[0]);
    pickRow(items()[1], true);

    const hide = [...host.querySelectorAll<HTMLElement>('.rail-actions button')]
      .find((b) => b.textContent === 'Hide');
    hide!.click();
    expect(store.get().deck.slides.map((s) => s.skipped ?? false)).toEqual([true, true]);
    expect(host.querySelectorAll('.rail-item.skipped')).toHaveLength(2);
    expect(host.querySelectorAll('.rail-skipped-badge')).toHaveLength(2);

    const show = [...host.querySelectorAll<HTMLElement>('.rail-actions button')]
      .find((b) => b.textContent === 'Show');
    show!.click();
    expect(store.get().deck.slides.some((s) => s.skipped)).toBe(false);

    store.undo();
    expect(store.get().deck.slides.map((s) => s.skipped ?? false)).toEqual([true, true]);
  });

  it('collapses an expanded hidden run without changing the active slide', () => {
    const { store, host } = setup();
    store.commit((deck) => {
      deck.slides[0].skipped = true;
      deck.slides[1].skipped = true;
      deck.slides.push({
        id: 'slide-3', name: 'Third', background: { color: null, image: null },
        notes: '', elements: [], timeline: [],
      });
    }, { history: false });

    expect(host.querySelector('.rail-run')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('.rail-run-bracket')!.click();

    expect(store.get().slideIndex).toBe(0);
    expect(store.slide?.id).toBe('slide-1');
    expect(host.querySelector('.rail-run')).toBeNull();
    expect(host.querySelector('.rail-collapsed')).not.toBeNull();

    // A regular edit should not make the explicitly collapsed run spring
    // open again while this hidden slide remains active in the editor.
    store.commit((deck) => {
      deck.slides[0].name = 'Still editing';
    }, { history: false });
    expect(store.slide?.name).toBe('Still editing');
    expect(host.querySelector('.rail-collapsed')).not.toBeNull();
  });

  it('restores auto-reveal after selecting a different slide', () => {
    const { store, host } = setup();
    store.commit((deck) => {
      deck.slides[0].skipped = true;
      deck.slides[1].skipped = true;
      deck.slides.push({
        id: 'slide-3', name: 'Third', background: { color: null, image: null },
        notes: '', elements: [], timeline: [],
      });
    }, { history: false });

    host.querySelector<HTMLButtonElement>('.rail-run-bracket')!.click();
    pickRow(host.querySelector<HTMLElement>('.rail-item[data-index="2"]')!);
    expect(store.slide?.id).toBe('slide-3');
    expect(host.querySelector('.rail-collapsed')).not.toBeNull();

    store.selectSlide(0);
    expect(store.slide?.id).toBe('slide-1');
    expect(host.querySelector('.rail-run')).not.toBeNull();
    expect(host.querySelector('.rail-item[data-index="0"]')).not.toBeNull();
  });
});

describe('slide rail keyboard insertion', () => {
  beforeEach(() => document.body.replaceChildren());

  it('Shift-click selects an inclusive slide range and a plain click collapses it', () => {
    const { store, host } = setup();
    store.commit((deck) => {
      deck.slides.push(
        { id: 'slide-3', name: 'Third', background: { color: null, image: null }, notes: '', elements: [], timeline: [] },
        { id: 'slide-4', name: 'Fourth', background: { color: null, image: null }, notes: '', elements: [], timeline: [] },
      );
    }, { history: false });

    pickRow(host.querySelectorAll<HTMLElement>('.rail-item')[1]);
    pickRow(host.querySelectorAll<HTMLElement>('.rail-item')[3], true);

    expect(store.get().slideIndex).toBe(3);
    expect([...store.get().slideSelection]).toEqual(['slide-2', 'slide-3', 'slide-4']);
    expect(host.querySelectorAll('.rail-item.selected')).toHaveLength(3);
    expect(host.querySelectorAll('.rail-item.active')).toHaveLength(1);

    pickRow(host.querySelectorAll<HTMLElement>('.rail-item')[2]);
    expect([...store.get().slideSelection]).toEqual(['slide-3']);
    expect(host.querySelectorAll('.rail-item.selected')).toHaveLength(1);
  });

  it('inserts one title-and-body slide after the selected slide on Return', () => {
    const { store, host } = setup();
    store.selectSlide(0);
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.get().deck.slides).toHaveLength(3);
    expect(store.get().slideIndex).toBe(1);
    expect(store.slide).toMatchObject({ name: '', layout: 'standard', timeline: [] });
    expect(store.slide?.elements.map((element) => element.class[0])).toEqual([
      'role-title', 'role-body',
    ]);
    expect(store.get().deck.slides[2].id).toBe('slide-2');
  });

  it('also works when the active thumbnail owns focus', () => {
    const { store, host } = setup();
    const active = host.querySelector<HTMLButtonElement>('.rail-item.active')!;
    active.focus();
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.get().deck.slides).toHaveLength(3);
    expect(store.get().slideIndex).toBe(1);
  });

  it('deletes the selected slide on Backspace', () => {
    const { store, host } = setup();
    store.selectSlide(1);
    const active = host.querySelector<HTMLButtonElement>('.rail-item.active')!;
    active.focus();
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

    expect(store.get().deck.slides).toHaveLength(1);
    expect(store.get().deck.slides[0].id).toBe('slide-1');
    expect(store.get().slideIndex).toBe(0);
  });

  it('does not delete the deck\'s only slide', () => {
    const { store, host } = setup();
    store.selectSlide(1);
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(store.get().deck.slides).toHaveLength(1);

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(store.get().deck.slides).toHaveLength(1);
    expect(store.get().slideIndex).toBe(0);
  });

  it('does not implicitly Morph every object on a duplicated slide', () => {
    const { store, host } = setup();
    store.get().deck.slides[0].elements.push({
      id: 'source', type: 'text', x: 20, y: 20, w: 300, h: 80, rot: 0, z: 1,
      opacity: 1, class: ['role-title'], style: {}, html: 'Keep me', align: 'left',
      valign: 'top', morphId: 'existing-chain',
    });
    const rail = new SlideRail(host, store);

    rail.duplicateSlide();

    expect(store.get().deck.slides[0].elements[0].morphId).toBe('existing-chain');
    expect(store.get().deck.slides[1].elements[0].morphId).toBeNull();
    expect(store.get().deck.slides[1].elements[0].lineageId).toBe('source');
    const copy = store.get().deck.slides[1].elements[0];
    if (copy.type !== 'text') throw new Error('expected duplicated text');
    copy.html = 'Edited after duplication';
    expect(suggestMorphPairs(
      store.get().deck.slides[0].elements,
      store.get().deck.slides[1].elements,
    ).map(([source, target]) => [source.id, target.id])).toEqual([['source', copy.id]]);
  });

  it('edits a large imported-style deck without rebuilding unchanged media', () => {
    let assetResolutions = 0;
    const resolutionsByAsset = new Map<string, number>();
    (globalThis as unknown as { window: Window }).window.api = {
      assetUrl: (src: string) => {
        assetResolutions += 1;
        resolutionsByAsset.set(src, (resolutionsByAsset.get(src) ?? 0) + 1);
        return src;
      },
    } as never;
    if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};

    const deck = emptyDeck('Large import');
    deck.slides = Array.from({ length: 140 }, (_, index) => ({
      id: `imported-${index}`,
      name: `Imported ${index + 1}`,
      background: { color: '#ffffff', image: null },
      notes: '',
      elements: [{
        id: `image-${index}`, type: 'image' as const, src: `assets/frame-${index}.png`,
        x: 0, y: 0, w: 1920, h: 1080, rot: 0, z: 0, opacity: 1,
        class: [], style: {}, fit: 'contain' as const, alt: '', sourceBox: null,
      }],
      timeline: [],
    }));
    const store = new EditorStore(deck, '/tmp/large-import');
    const railHost = document.createElement('div');
    const inspectorHost = document.createElement('div');
    document.body.replaceChildren(railHost, inspectorHost);
    new SlideRail(railHost, store);
    new Inspector(inspectorHost, store);
    const firstThumb = railHost.querySelector('.rail-thumb');
    // Props renders the selected and following slide once for its two compact
    // read-only Morph previews.
    expect(assetResolutions).toBe(142);

    store.selectSlide(69);
    railHost.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const layout = [...inspectorHost.querySelectorAll<HTMLSelectElement>('select')].find((select) =>
      [...select.options].some((option) => option.value === 'standard'))!;
    layout.value = 'standard';
    layout.dispatchEvent(new Event('change', { bubbles: true }));

    expect(store.slide?.layout).toBe('standard');
    expect(store.slide?.elements.map((element) => element.class[0])).toEqual([
      'role-title', 'role-body',
    ]);
    expect(railHost.querySelector('.rail-thumb')).toBe(firstThumb);
    // An untouched rail thumbnail far away from the edit is not resolved again.
    expect(resolutionsByAsset.get('assets/frame-139.png')).toBe(1);
    expect(() => parseDeck(store.get().deck)).not.toThrow();
  });
});

describe('adding a slide', () => {
  beforeEach(() => document.body.replaceChildren());

  it('themes the new slide like the slides the author already themed', () => {
    const { store, rail } = setup();
    const theme = THEMES[1];
    store.commit((deck) => adoptThemeStyles(deck, theme, {
      scope: 'slides', roles: ['title', 'body', 'caption'], fontFamily: true,
      fontWeight: false, typeScale: false, textColor: false, background: false,
      objectColors: false, replaceOverrides: true, detectRoles: false,
    }, 0, new Set(), new Set(['slide-1'])));

    rail.addSlide();

    // The apply installed the family into the deck's defaults, so the new
    // slide sits on theme.css: nothing is copied onto it, and it wears the
    // family through the stylesheet alone.
    const { deck, slideIndex } = store.get();
    const added = deck.slides[slideIndex];
    const title = added.elements.find((el) => el.class.includes('role-title'))!;
    expect(title.style['font-family']).toBeUndefined();
    expect(deck.themeStyle?.fonts.title.family).toBe(theme.fonts.title.family);
    expect(deck.themePreset).toBe(theme.id);
    expect(added.background).toEqual({ color: null, image: null });
  });

  it('leaves a new slide to the stylesheet when no theme has been applied', () => {
    const { store, rail } = setup();
    rail.addSlide();
    const { deck, slideIndex } = store.get();
    const added = deck.slides[slideIndex];
    expect(added.elements.every((el) => Object.keys(el.style).length === 0)).toBe(true);
    expect(added.background.color).toBeNull();
  });

  it('themes a slide inserted with Return in the rail from a merely chosen theme', () => {
    const { store, host } = setup();
    const theme = THEMES[2];
    // An older deck's shape: a choice recorded, never installed. An existing
    // title sits on the stock stylesheet so the test can show it stays put.
    store.commit((deck) => {
      deck.themeSelection = fullThemeSelection(theme.id);
      deck.slides[0].elements.push({
        id: 'existing', type: 'text', x: 0, y: 0, w: 800, h: 160, rot: 0, z: 1, opacity: 1,
        class: ['role-title'], style: {}, html: 'Already here', align: 'left', valign: 'top',
      });
    });

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // The new slide installs the chosen theme and follows it: no copies on
    // its boxes, the theme in the deck's defaults.
    const { deck, slideIndex } = store.get();
    expect(deck.slides).toHaveLength(3);
    const added = deck.slides[slideIndex];
    const title = added.elements.find((el) => el.class.includes('role-title'))!;
    expect(title.style).toEqual({});
    expect(added.background).toEqual({ color: null, image: null });
    expect(deck.themePreset).toBe(theme.id);
    expect(deck.themeStyle?.fonts.title.family).toBe(theme.fonts.title.family);
    // The slide that was already there keeps rendering as it did: what it drew
    // from the stock stylesheet is now written on it, where the theme differs.
    const existing = deck.slides[0].elements.find((el) => el.id === 'existing')!;
    expect(existing.style['font-family']).toBe(STOCK_STYLESHEET_STYLE.fonts.title.family);
    expect(existing.style['font-size']).toBe(`${STOCK_STYLESHEET_STYLE.fonts.title.size}px`);
    expect(existing.style.color).toBe(STOCK_STYLESHEET_STYLE.colors.text);
    expect(deck.slides[0].background.color).toBe(STOCK_STYLESHEET_STYLE.colors.background);
  });
});

/**
 * The slide picker draws real slides through the player's own renderer, so it
 * inherits the player's stylesheet — including the rule that hides prompt copy
 * the author has not replaced (`type.css`). Editing a layout used to re-mark
 * every authored title and body as prompt copy, and the whole picker went
 * blank; the same class list also blanks the projector and every export, which
 * is why this asserts on rendered visibility rather than on class names.
 */
describe('the slide picker after a layout change', () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    const style = document.createElement('style');
    style.textContent = PLAYER_TYPE_CSS;
    document.head.appendChild(style);
  });

  function authoredRail() {
    const { store, host, rail } = setup();
    store.commit((deck) => {
      deck.layoutMasters = defaultLayoutMasters();
      for (const [index, slide] of deck.slides.entries()) {
        applySlideLayout(slide, 'standard', deck.layoutMasters);
        for (const element of slide.elements) {
          if (element.type !== 'text') continue;
          element.html = `Authored ${element.layoutPlaceholder} ${index + 1}`;
          // What the canvas does on the first real content commit.
          element.class = element.class.filter((name) => name !== 'placeholder');
        }
      }
    }, { history: false });
    return { store, host, rail };
  }

  /** Every line of text the picker actually shows, thumbnail by thumbnail. */
  function visibleThumbText(host: HTMLElement): string[][] {
    return [...host.querySelectorAll<HTMLElement>('.rail-thumb')].map((thumb) => (
      [...thumb.querySelectorAll<HTMLElement>('.text-body')]
        .filter((body) => getComputedStyle(body).visibility === 'visible')
        .map((body) => body.textContent ?? '')
    ));
  }

  it('still shows every authored title and body after a layout master is edited', () => {
    const { store, host } = authoredRail();
    expect(visibleThumbText(host)).toEqual([
      ['Authored title 1', 'Authored body 1'],
      ['Authored title 2', 'Authored body 2'],
    ]);

    // What the layout editor commits when the author presses Done.
    store.commit((deck) => {
      deck.layoutMasters!.standard.elements[0].x = 300;
      syncDeckWithLayoutMasters(deck);
    }, { label: 'Edit layout masters' });

    expect(visibleThumbText(host)).toEqual([
      ['Authored title 1', 'Authored body 1'],
      ['Authored title 2', 'Authored body 2'],
    ]);
    // The new geometry reached the thumbnails, so this is not a stale render.
    const title = host.querySelector<HTMLElement>('.rail-thumb .element-text')!;
    expect(title.style.left).toBe('300px');
  });

  it('still shows authored copy after the slide switches layout', () => {
    const { store, host } = authoredRail();
    store.commit((deck) => {
      applySlideLayout(deck.slides[0], 'title', deck.layoutMasters);
    }, { label: 'Apply Title slide layout' });

    expect(visibleThumbText(host)[0]).toContain('Authored title 1');
  });

  it('leaves an untouched prompt hidden, exactly as the projector shows it', () => {
    const { store, host } = setup();
    store.commit((deck) => {
      deck.layoutMasters = defaultLayoutMasters();
      syncDeckWithLayoutMasters(deck);
      applySlideLayout(deck.slides[0], 'standard', deck.layoutMasters);
    }, { history: false });

    expect(visibleThumbText(host)[0]).toEqual([]);
  });
});

describe('rebuilding the rail without detaching untouched rows', () => {
  beforeEach(() => document.body.replaceChildren());

  it('keeps unchanged rows and thumbnails attached across an edit to another slide', () => {
    const { store, host } = setup();
    const rowsBefore = [...host.querySelectorAll<HTMLElement>('.rail-item')];
    const thumbsBefore = [...host.querySelectorAll<HTMLElement>('.rail-thumb')];
    expect(rowsBefore.length).toBeGreaterThan(1);
    const detached: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) detached.push(...record.removedNodes);
    });
    observer.observe(host, { childList: true });

    store.commit((deck) => { deck.slides[0].name = 'Renamed'; }, { label: 'Rename' });
    observer.disconnect();

    const rowsAfter = [...host.querySelectorAll<HTMLElement>('.rail-item')];
    expect(rowsAfter[0]).not.toBe(rowsBefore[0]);
    expect(rowsAfter[1]).toBe(rowsBefore[1]);
    expect(host.querySelectorAll('.rail-thumb')[1]).toBe(thumbsBefore[1]);
    // The untouched row never left the document, even for a moment.
    expect(detached).not.toContain(rowsBefore[1]);
  });

  it('keeps a slide’s row and thumbnail when only its speaker note changed', () => {
    const { store, host } = setup();
    const row = host.querySelector<HTMLElement>('.rail-item');
    const thumb = host.querySelector<HTMLElement>('.rail-thumb');
    const detached: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) detached.push(...record.removedNodes);
    });
    observer.observe(host, { childList: true, subtree: true });

    // Typing in the notes drawer, one commit per keystroke, outside a transaction.
    store.commit((deck) => { deck.slides[0].notes = 'r'; }, { label: 'Edit speaker notes' });
    store.commit((deck) => { deck.slides[0].notes = 're'; }, { label: 'Edit speaker notes' });
    observer.disconnect();

    expect(host.querySelector('.rail-item')).toBe(row);
    expect(host.querySelector('.rail-thumb')).toBe(thumb);
    expect(detached.filter((node) => node === row || node === thumb)).toEqual([]);
  });

  it('still moves the highlight onto the kept rows', () => {
    const { store, host } = setup();
    store.commit((deck) => { deck.slides[0].name = 'Renamed'; }, { label: 'Rename' });
    store.selectSlide(1);
    const rows = [...host.querySelectorAll<HTMLElement>('.rail-item')];
    expect(rows[0].classList.contains('active')).toBe(false);
    expect(rows[1].classList.contains('active')).toBe(true);
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
  });
});

describe('a drag that reorders nothing', () => {
  beforeEach(() => document.body.replaceChildren());

  /** The native drag events a row sees, with a DataTransfer stub. */
  function drag(row: HTMLElement, type: 'dragstart' | 'dragend'): void {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: {
        effectAllowed: '',
        dropEffect: '',
        setData: () => {},
        getData: () => '',
        setDragImage: () => {},
      },
    });
    row.dispatchEvent(event);
  }

  // Reported: start dragging a slide, abandon the drag, and the row stays
  // dimmed. Nothing moved, so every slide object is identical and the rail's
  // row cache hands the very same node back -- the re-render that was meant
  // to clear the mark never rebuilt the row carrying it.
  it('leaves no row dimmed after the drag is abandoned', () => {
    const { host } = setup();
    const row = host.querySelector<HTMLElement>('.rail-item')!;

    drag(row, 'dragstart');
    expect(row.classList.contains('dragging')).toBe(true);
    drag(row, 'dragend');

    expect(row.classList.contains('dragging')).toBe(false);
    expect(host.querySelectorAll('.rail-item.dragging')).toHaveLength(0);
    // The same node really is still the one on screen: without the explicit
    // strip this test would pass on a rebuild that never happened.
    expect(host.querySelector('.rail-item')).toBe(row);
  });

  it('clears the insertion marks a cancelled drag left on another row', () => {
    const { host } = setup();
    const [first, second] = [...host.querySelectorAll<HTMLElement>('.rail-item')];

    drag(first, 'dragstart');
    second.classList.add('drop-after');
    drag(first, 'dragend');

    expect(host.querySelectorAll('.drop-before, .drop-after')).toHaveLength(0);
  });
});

describe('changing layout from the slide context menu', () => {
  beforeEach(() => document.body.replaceChildren());

  const openMenu = (row: HTMLElement) => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return document.getElementById('ctx-menu')!;
  };
  const layoutRow = (menu: HTMLElement, label: string) =>
    [...menu.querySelectorAll<HTMLButtonElement>('button.ctx-check')]
      .find((row) => row.textContent === label)!;

  it('lists every layout, ticks the current one, and applies a pick as one undo step', () => {
    const { store, host } = setup();
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(store.slide?.layout).toBe('standard');
    const menu = openMenu(host.querySelectorAll<HTMLElement>('.rail-item')[1]);

    expect(menu.querySelector('.ctx-heading')?.textContent).toBe('Layout');
    expect([...menu.querySelectorAll('button.ctx-check')].map((row) => row.textContent))
      .toEqual(['Freeform', 'Title + body', 'Title slide']);
    expect(layoutRow(menu, 'Title + body').getAttribute('aria-checked')).toBe('true');
    expect(layoutRow(menu, 'Title slide').getAttribute('aria-checked')).toBe('false');

    layoutRow(menu, 'Title slide').click();
    expect(document.getElementById('ctx-menu')).toBeNull();
    expect(store.slide?.layout).toBe('title');
    expect(store.get().deck.slides[0].layout ?? 'freeform').toBe('freeform');

    store.undo();
    expect(store.slide?.layout).toBe('standard');
  });

  it('applies the layout to every selected slide and ticks nothing for a mixed set', () => {
    const { store, host } = setup();
    store.commit((deck) => applySlideLayout(deck.slides[1], 'standard'));
    const rows = () => host.querySelectorAll<HTMLElement>('.rail-item');
    pickRow(rows()[0]);
    pickRow(rows()[1], true);
    const menu = openMenu(rows()[1]);
    expect(menu.querySelectorAll('button.ctx-check[aria-checked="true"]')).toHaveLength(0);

    layoutRow(menu, 'Title slide').click();
    expect(store.get().deck.slides.map((slide) => slide.layout)).toEqual(['title', 'title']);
  });
});
