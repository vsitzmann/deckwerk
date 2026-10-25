// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { BuildPreview, PREVIEW_PAUSE_MS } from '../src/renderer/editor/buildPreview.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { TimelinePanel } from '../src/renderer/editor/timelinePanel.js';

/** A preview button's label, beside its icon. */
const label = (button: HTMLButtonElement) => button.querySelector('.build-preview-label')?.textContent;

function text(id: string, y: number) {
  return { id, type: 'text' as const, x: 0, y, w: 100, h: 50, rot: 0, z: 1,
    opacity: 1, class: [], style: {}, html: id, align: 'left' as const, valign: 'top' as const };
}

/** a on the first click (a dissolve) with b alongside it, then c on the second. */
function builtDeck(): Deck {
  const deck = emptyDeck('Preview');
  deck.slides[0].elements.push(text('a', 0), text('b', 60), text('c', 120));
  deck.slides[0].timeline.push(
    { id: 't-a', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'a', value: 'dissolve', duration: 1000 } },
    { id: 't-b', trigger: { on: 'withPrev', ref: null, delay: 0 },
      action: { type: 'appear', target: 'b', value: null } },
    { id: 't-c', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'c', value: null } },
  );
  return deck;
}

describe('Build panel Preview', () => {
  let surface: HTMLElement;
  let presses: (() => void) | null;
  let ended: number;
  const canvas = {
    beginPlayback(onPress: () => void) {
      surface = document.createElement('div');
      document.body.appendChild(surface);
      presses = onPress;
      return { surface, end: () => { ended += 1; surface.remove(); } };
    },
  };

  beforeEach(() => {
    document.body.replaceChildren();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
    if (!CSS.escape) CSS.escape = (value) => value;
    presses = null;
    ended = 0;
  });
  // A preview left playing would keep its Escape listener on the window.
  const previews: BuildPreview[] = [];
  afterEach(() => {
    for (const preview of previews.splice(0)) preview.stop();
    vi.useRealTimers();
  });

  function setup() {
    const store = new EditorStore(builtDeck(), '/tmp/build-preview');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const preview = new BuildPreview(canvas, store);
    previews.push(preview);
    new TimelinePanel(host, store, preview);
    const button = () => host.querySelector<HTMLButtonElement>('.build-preview')!;
    const slideButton = () => host.querySelector<HTMLButtonElement>('.build-preview-slide')!;
    const visible = (id: string) =>
      surface.querySelector<HTMLElement>(`[data-element-id="${id}"]`)?.style.visibility === 'visible';
    return { store, host, preview, button, slideButton, visible };
  }

  it('plays the selected build with its companions, then ends by itself', async () => {
    const { store, preview, button, slideButton, visible } = setup();
    store.select(['a']);
    const deckBefore = store.get().deck;
    expect(label(button())).toBe('Preview');
    expect(button().title).toMatch(/selected build/);

    button().click();
    expect(preview.playing).toBe('builds');
    expect(label(button())).toBe('Stop');
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().querySelector('.build-preview-icon')?.textContent).toBe('■');
    expect(button().classList.contains('primary')).toBe(true);
    expect(slideButton().classList.contains('primary')).toBe(false);
    expect(label(slideButton())).toBe('Play slide');
    // The first click's builds ran -- a and the b that comes with it -- and
    // nothing of the second click.
    expect([visible('a'), visible('b'), visible('c')]).toEqual([true, true, false]);

    // Held through the dissolve and a pause, then the editing view is back.
    await vi.advanceTimersByTimeAsync(1000);
    expect(preview.playing).toBe('builds');
    await vi.advanceTimersByTimeAsync(PREVIEW_PAUSE_MS);
    expect(preview.playing).toBeNull();
    expect(ended).toBe(1);
    expect(label(button())).toBe('Preview');
    expect(button().getAttribute('aria-pressed')).toBe('false');
    expect(button().classList.contains('primary')).toBe(false);
    // Nothing about the document moved.
    expect(store.get().deck).toBe(deckBefore);
    expect(store.canUndo()).toBe(false);
    expect([...store.get().selection]).toEqual(['a']);
  });

  it('starts a later build from the state just before it', () => {
    const { store, button, visible } = setup();
    store.select(['c']);
    button().click();
    expect([visible('a'), visible('b'), visible('c')]).toEqual([true, true, true]);
  });

  it('stops on Stop, on Escape and on a click on the canvas', () => {
    const { store, preview, button } = setup();
    store.select(['a']);
    button().click();
    button().click();
    expect(preview.playing).toBeNull();
    expect(ended).toBe(1);
    expect(label(button())).toBe('Preview');

    // Escape ends the preview and goes no further: the editor's own Escape
    // (deselect, leave a mode) never hears it.
    const heard = vi.fn();
    document.addEventListener('keydown', heard);
    button().click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(preview.playing).toBeNull();
    expect(heard).not.toHaveBeenCalled();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(heard).toHaveBeenCalledTimes(1);

    button().click();
    presses!();
    expect(preview.playing).toBeNull();
    expect(ended).toBe(3);
    expect([...store.get().selection]).toEqual(['a']);
    expect(store.canUndo()).toBe(false);
  });

  it('plays the whole slide click by click from Play slide or a Shift-click', async () => {
    const { store, preview, button, slideButton, visible } = setup();
    store.select(['c']);
    slideButton().click();
    expect(preview.playing).toBe('slide');
    expect(label(slideButton())).toBe('Stop');
    expect(label(button())).toBe('Preview');
    // The slide arrives with nothing built yet.
    expect([visible('a'), visible('b'), visible('c')]).toEqual([false, false, false]);
    await vi.advanceTimersByTimeAsync(PREVIEW_PAUSE_MS);
    expect([visible('a'), visible('b'), visible('c')]).toEqual([true, true, false]);
    await vi.advanceTimersByTimeAsync(1000 + PREVIEW_PAUSE_MS);
    expect(visible('c')).toBe(true);
    await vi.advanceTimersByTimeAsync(PREVIEW_PAUSE_MS);
    expect(preview.playing).toBeNull();
    expect(label(slideButton())).toBe('Play slide');

    // Shift on Preview is the same whole-slide run, and Preview is its Stop.
    button().dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(preview.playing).toBe('slide');
    expect(label(button())).toBe('Stop');
    expect(label(slideButton())).toBe('Play slide');
    button().click();
    expect(preview.playing).toBeNull();
  });

  it('previews a pop-in as a pop-in, held until it has finished growing', async () => {
    // jsdom has no Web Animations; record what the player asks for instead.
    const animations: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
    (Element.prototype as unknown as { animate: unknown }).animate = function animate(
      keyframes: Keyframe[], options: KeyframeAnimationOptions,
    ) {
      animations.push({ keyframes, options });
      return { finish() {}, cancel() {}, finished: new Promise(() => {}) };
    };
    try {
      const { store, preview, button, visible } = setup();
      store.commit((deck) => {
        deck.slides[0].timeline = [{
          id: 't-pop', trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'appear', target: 'a', value: 'pop', duration: 900, popFrom: 0.2, popPeak: 1.25 },
        }];
      });
      store.select(['a']);
      button().click();
      expect(preview.playing).toBe('builds');
      expect(visible('a')).toBe(true);
      expect(animations).toHaveLength(1);
      expect(animations[0].keyframes.map((frame) => frame.scale)).toEqual(['0.2', '1.25', '1']);
      expect(animations[0].options.duration).toBe(900);

      // The pause before the slide comes back starts once the pop has ended.
      await vi.advanceTimersByTimeAsync(900);
      expect(preview.playing).toBe('builds');
      await vi.advanceTimersByTimeAsync(PREVIEW_PAUSE_MS);
      expect(preview.playing).toBeNull();
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('previews an emphasis by playing it, held until it has settled', async () => {
    const animations: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
    (Element.prototype as unknown as { animate: unknown }).animate = function animate(
      keyframes: Keyframe[], options: KeyframeAnimationOptions,
    ) {
      animations.push({ keyframes, options });
      return { finish() {}, cancel() {}, finished: new Promise(() => {}) };
    };
    try {
      const { store, preview, button, visible } = setup();
      // a is on the slide from the start; its one build is a jiggle.
      store.commit((deck) => {
        deck.slides[0].timeline = [{
          id: 't-jiggle', trigger: { on: 'click', ref: null, delay: 0 },
          action: { type: 'jiggle', target: 'a', value: null, duration: 800 },
        }];
      });
      store.select(['a']);
      button().click();
      expect(preview.playing).toBe('builds');
      expect(visible('a')).toBe(true);
      expect(animations).toHaveLength(1);
      expect(animations[0].options.duration).toBe(800);
      expect(animations[0].keyframes.some((frame) => /rotate\(/.test(String(frame.transform)))).toBe(true);

      await vi.advanceTimersByTimeAsync(800);
      expect(preview.playing).toBe('builds');
      await vi.advanceTimersByTimeAsync(PREVIEW_PAUSE_MS);
      expect(preview.playing).toBeNull();
    } finally {
      delete (Element.prototype as unknown as { animate?: unknown }).animate;
    }
  });

  it('ends when the slide changes under it', () => {
    const { store, preview, button } = setup();
    store.commit((deck) => { deck.slides.push(structuredClone(deck.slides[0])); deck.slides[1].id = 's2'; });
    store.select(['a']);
    button().click();
    expect(preview.playing).toBe('builds');
    store.selectSlide(1);
    expect(preview.playing).toBeNull();
  });

  it('heads the panel with an icon on each, disabled on a slide without builds', () => {
    const { host, button, slideButton } = setup();
    expect(host.firstElementChild?.nextElementSibling?.classList.contains('build-preview-controls')).toBe(true);
    expect(button().querySelector('.build-preview-icon')?.textContent).toBe('▶');
    expect(slideButton().querySelector('.build-preview-icon')?.textContent).toBe('▶▶');
    expect(button().disabled).toBe(false);

    const store = new EditorStore(emptyDeck('Empty'), '/tmp/build-preview');
    const empty = document.createElement('div');
    new TimelinePanel(empty, store, new BuildPreview(canvas, store));
    expect(empty.querySelector<HTMLButtonElement>('.build-preview')!.disabled).toBe(true);
    expect(empty.querySelector<HTMLButtonElement>('.build-preview-slide')!.disabled).toBe(true);
  });
});
