// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck, type Slide, type SlideElement, type TimelineEntry } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { TimelinePanel } from '../src/renderer/editor/timelinePanel.js';
import { buildFromNode, slideToHtml } from '../src/shared/htmlSlides.js';
import { DEFAULT_KEYBOARD_DURATION, buildEffect, effectDuration } from '../src/shared/timeline.js';
import { installCanvasDomShims } from './support/canvasHarness.js';

/**
 * Keyboard: text types in a character at a time behind a caret, a thin bar
 * that steps along the text and wraps with it, as Keynote's Keyboard does.
 * Each character simply appears where the caret stood; once the last one is
 * in, the caret goes. The characters are split into spans only while the
 * typing lasts: the resting slide is the markup the renderer made. On
 * anything that is not text, keyboard is an ordinary appear.
 */

function text(id: string, html = id): SlideElement {
  return {
    id, type: 'text', x: 0, y: 0, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, html, align: 'left', valign: 'top',
  } as SlideElement;
}

function box(id: string): SlideElement {
  return {
    id, type: 'shape', shape: 'rect', x: 0, y: 300, w: 200, h: 100, rot: 0, z: 2, opacity: 1,
    class: [], style: {}, fill: '#336699', stroke: null, strokeWidth: 0,
    radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
  } as SlideElement;
}

function deckWith(element: SlideElement, action: Partial<TimelineEntry['action']> = {}): Deck {
  const deck = emptyDeck('Keyboard');
  deck.slides[0].elements.push(element, text('next'));
  deck.slides[0].timeline.push(
    {
      id: 't-keys', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: element.id, value: 'keyboard', ...action },
    },
    {
      id: 't-next', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'next', value: null },
    },
  );
  return deck;
}

const keys = (target: string, type: 'appear' | 'disappear' = 'appear'): TimelineEntry => ({
  id: 'b', trigger: { on: 'click', ref: null, delay: 0 },
  action: { type, target, value: 'keyboard' },
}) as TimelineEntry;

describe('keyboard builds', () => {
  const slide = { id: 's', elements: [text('t'), box('b')], timeline: [] } as unknown as Slide;

  it('is an animated appear on text, with its own default time', () => {
    expect(buildEffect(keys('t'), slide)).toBe('keyboard');
    expect(effectDuration(keys('t'), 'keyboard')).toBe(DEFAULT_KEYBOARD_DURATION);
    expect(effectDuration({ ...keys('t'), action: { ...keys('t').action, duration: 900 } }, 'keyboard')).toBe(900);
  });

  it('is an ordinary appear on anything else, and has no disappear form', () => {
    expect(buildEffect(keys('b'), slide)).toBeNull();
    expect(buildEffect(keys('t', 'disappear'), slide)).toBeNull();
  });
});

describe('typing in while presenting', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  });
  afterEach(() => vi.useRealTimers());

  function present(deck: Deck): { player: Player; host: HTMLElement } {
    installCanvasDomShims();
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    return { player: new Player({ deck, container: host, resolveSrc: (src) => src }), host };
  }
  const content = (host: HTMLElement, id = 'title') =>
    host.querySelector<HTMLElement>(`[data-element-id="${id}"] .text-content`)!;
  /** The characters showing so far, and the text the caret stands after. */
  const typed = (host: HTMLElement, id = 'title') => {
    const spans = [...content(host, id).querySelectorAll<HTMLElement>('span[data-typed]')];
    const caret = content(host, id).querySelector('.build-caret');
    return {
      shown: spans.filter((span) => span.style.visibility !== 'hidden').map((span) => span.textContent).join(''),
      caretAfter: caret ? spans.filter((span) => span.compareDocumentPosition(caret) & Node.DOCUMENT_POSITION_FOLLOWING)
        .map((span) => span.textContent).join('') : null,
    };
  };

  it('types one character after another, each appearing where the caret stood', () => {
    // "Hi yo": five keys, and a sixth step for the caret after the last.
    const { player, host } = present(deckWith(text('title', '<p>Hi <b>yo</b></p>'), { duration: 600 }));
    const before = content(host).innerHTML;
    player.next();
    // Nothing yet but the caret, at the start of the text.
    expect(typed(host)).toEqual({ shown: '', caretAfter: '' });
    // Everything keeps its room: the words read as they will, hidden or not.
    expect(content(host).textContent).toBe('⁠Hi yo');

    vi.advanceTimersByTime(100);
    expect(typed(host)).toEqual({ shown: 'H', caretAfter: 'H' });
    vi.advanceTimersByTime(200);
    expect(typed(host)).toEqual({ shown: 'Hi ', caretAfter: 'Hi ' });
    // The caret goes into the bold run with the letters it follows.
    vi.advanceTimersByTime(100);
    expect(typed(host)).toEqual({ shown: 'Hi y', caretAfter: 'Hi y' });
    expect(content(host).querySelector('.build-caret')!.parentElement!.tagName).toBe('B');
    vi.advanceTimersByTime(100);
    expect(typed(host)).toEqual({ shown: 'Hi yo', caretAfter: 'Hi yo' });

    // When the time is up the caret is gone and the text is the renderer's own markup again.
    vi.advanceTimersByTime(100);
    expect(content(host).querySelector('.build-caret')).toBeNull();
    expect(content(host).innerHTML).toBe(before);
  });

  it('never moves a character: no bounce, lift or scale', () => {
    const { player, host } = present(deckWith(text('title', 'Typing'), { duration: 700 }));
    player.next();
    vi.advanceTimersByTime(350);
    for (const span of content(host).querySelectorAll<HTMLElement>('span[data-typed]')) {
      expect([span.style.top, span.style.transform, span.style.scale, span.style.translate]).toEqual(['', '', '', '']);
    }
  });

  it('brings a list marker in with its item', () => {
    const { player, host } = present(deckWith(text('title', '<ul><li>ab</li><li>cd</li></ul>'), { duration: 500 }));
    const before = content(host).innerHTML;
    player.next();
    const items = [...content(host).querySelectorAll('li')];
    expect(items.map((item) => item.classList.contains('build-unmarked'))).toEqual([true, true]);
    vi.advanceTimersByTime(100);
    expect(items.map((item) => item.classList.contains('build-unmarked'))).toEqual([false, true]);
    vi.advanceTimersByTime(200);
    expect(items.map((item) => item.classList.contains('build-unmarked'))).toEqual([false, false]);
    vi.advanceTimersByTime(200);
    expect(content(host).innerHTML).toBe(before);
  });

  it('puts the text back at once when the talk moves on mid-typing', () => {
    const { player, host } = present(deckWith(text('title', 'Typing'), { duration: 3000 }));
    const before = content(host).innerHTML;
    player.next();
    vi.advanceTimersByTime(1000);
    expect(content(host).innerHTML).not.toBe(before);
    player.next();
    expect(content(host).innerHTML).toBe(before);
    vi.advanceTimersByTime(5000);
    expect(content(host).innerHTML).toBe(before);
  });

  it('shows the whole text, untouched, when the step is jumped to', () => {
    const { player, host } = present(deckWith(text('title', 'Typing')));
    const before = content(host).innerHTML;
    player.goTo({ slide: 0, step: 1 });
    expect(content(host).innerHTML).toBe(before);
    expect(host.querySelector('.build-caret')).toBeNull();
  });

  it('just shows anything that is not text', () => {
    const { player, host } = present(deckWith(box('card')));
    player.next();
    const card = host.querySelector<HTMLElement>('[data-element-id="card"]')!;
    expect(card.style.visibility).toBe('visible');
    expect(host.querySelector('.build-caret')).toBeNull();
  });
});

describe('keyboard in authoring HTML and the Build panel', () => {
  const canvas = { w: 1920, h: 1080 };
  beforeEach(() => document.body.replaceChildren());

  it('round-trips through a page', () => {
    const node = { dataset: { build: 'click', buildEffect: 'keyboard', buildDuration: '2000' } };
    expect(buildFromNode(node as never, 'title', 0)!.action).toMatchObject({ value: 'keyboard', duration: 2000 });
    const html = slideToHtml(deckWith(text('title'), { duration: 2000 }).slides[0], canvas);
    expect(html).toContain('data-build-effect="keyboard"');
    expect(html).toContain('data-build-duration="2000"');
  });

  function panelFor(element: SlideElement): { store: EditorStore; select: HTMLSelectElement } {
    const deck = deckWith(element);
    deck.slides[0].timeline[0].action.value = null;
    const store = new EditorStore(deck, '/tmp/keyboard');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);
    return { store, select: host.querySelector<HTMLSelectElement>('.timeline-row select.build-action')! };
  }

  it('is a choice on a text card, with a time', () => {
    const { store, select } = panelFor(text('title'));
    select.value = 'appear:keyboard';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.slide!.timeline[0].action).toMatchObject({ value: 'keyboard', duration: DEFAULT_KEYBOARD_DURATION });
  });

  it('is not offered for anything else', () => {
    const { select } = panelFor(box('card'));
    expect([...select.options].map((option) => option.value)).not.toContain('appear:keyboard');
    expect([...select.options].map((option) => option.value)).toContain('appear:pop');
  });
});
