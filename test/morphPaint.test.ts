// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { restyledMorphPairs } from '../src/shared/morph.js';
import { Player } from '../src/renderer/player/player.js';

/**
 * Morph between two slides where an object is the same but recoloured.
 *
 * A slide duplicated and edited carries each copy's lineage back to its
 * source. When the copy only changed paint, the transition should blend the
 * paint — not fade the old object out and a recoloured copy in.
 */

const box = (id: string, fill: string, over: Partial<SlideElement> = {}): SlideElement => ({
  id, type: 'shape', shape: 'rect', x: 100, y: 100, w: 400, h: 240, rot: 0, z: 1, opacity: 1,
  class: [], style: {}, fill, stroke: '#111111', strokeWidth: 2, radius: 8,
  path: null, pathSize: null, arrowStart: false, arrowEnd: false, ...over,
} as SlideElement);
const title = (id: string, html: string, over: Partial<SlideElement> = {}): SlideElement => ({
  id, type: 'text', x: 120, y: 60, w: 1680, h: 140, rot: 0, z: 2, opacity: 1,
  class: [], style: {}, html, align: 'left', valign: 'top', ...over,
} as SlideElement);

describe('which objects count as the same one, restyled', () => {
  it('pairs a duplicate that kept its words and place but changed colour', () => {
    const previous = [title('t', 'sdlieee'), box('b', '#c96442')];
    const next = [
      title('t2', '<span style="color: rgb(255, 255, 0);">sdlieee</span>', { lineageId: 't' }),
      box('b2', '#3f55b5', { lineageId: 'b' }),
    ];
    expect(restyledMorphPairs(previous, next).map((pair) => pair.map((el) => el.id)))
      .toEqual([['t', 't2'], ['b', 'b2']]);
  });

  it('leaves alone a descendant that moved, changed its words, or has no lineage', () => {
    const previous = [title('t', 'Old words'), box('b', '#c96442')];
    expect(restyledMorphPairs(previous, [title('t2', 'New words', { lineageId: 't' })])).toEqual([]);
    expect(restyledMorphPairs(previous, [box('b2', '#fff', { lineageId: 'b', x: 900 })])).toEqual([]);
    expect(restyledMorphPairs(previous, [box('b2', '#fff')])).toEqual([]);
    expect(restyledMorphPairs(previous, [box('b2', '#fff', { lineageId: 'b', shape: 'ellipse' })])).toEqual([]);
  });
});

describe('blending paint across the transition', () => {
  type Call = { target: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions };
  let calls: Call[] = [];
  beforeEach(() => {
    calls = [];
    document.body.replaceChildren();
    if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
    if (!CSS.escape) CSS.escape = (value) => value;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    (Element.prototype as unknown as { animate: unknown }).animate = function animate(
      this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions,
    ) {
      calls.push({ target: this, keyframes, options });
      return { finished: new Promise(() => {}), cancel() {}, finish() {} };
    };
  });
  afterEach(() => { delete (Element.prototype as unknown as { animate?: unknown }).animate; });

  function morphDeck(previous: SlideElement[], next: SlideElement[]): Deck {
    const deck = emptyDeck('Paint');
    deck.slides[0].elements = previous;
    deck.slides.push({
      ...structuredClone(deck.slides[0]), id: 'slide-2', elements: next, morphFromPrevious: true,
      morphDuration: 1200,
    });
    return deck;
  }
  function present(deck: Deck): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });
    calls = [];
    player.next();
    return host;
  }

  it('turns a recoloured box from one fill to the other, on the box itself', () => {
    const host = present(morphDeck([box('b', '#c96442')], [box('b2', '#3f55b5', { lineageId: 'b' })]));
    const paint = calls.find((call) => call.target.tagName.toLowerCase() === 'rect');
    expect(paint?.keyframes[0]).toMatchObject({ fill: '#c96442' });
    expect(paint?.keyframes[1]).toMatchObject({ fill: '#3f55b5' });
    expect(paint?.options.duration).toBe(1200);
    // The box never fades: it is one object throughout.
    expect(host.querySelector('.morph-ghost')).toBeNull();
    const fades = calls.filter((call) => call.keyframes.some((frame) => frame.opacity === '0'));
    expect(fades).toEqual([]);
  });

  it('blends recoloured text through a copy that fades over the opaque target', () => {
    const host = present(morphDeck(
      [title('t', 'sdlieee')],
      [title('t2', '<span style="color: rgb(255, 255, 0);">sdlieee</span>', { lineageId: 't' })],
    ));
    const target = host.querySelector<HTMLElement>('[data-element-id="t2"]')!;
    const ghost = target.nextElementSibling as HTMLElement;
    expect(ghost.classList.contains('morph-ghost')).toBe(true);
    expect(ghost.textContent).toContain('sdlieee');
    const onTarget = calls.find((call) => call.target === target)!;
    expect([onTarget.keyframes[0].opacity, onTarget.keyframes.at(-1)!.opacity]).toEqual(['1', '1']);
    const onGhost = calls.find((call) => call.target === ghost)!;
    expect([onGhost.keyframes[0].opacity, onGhost.keyframes.at(-1)!.opacity]).toEqual(['1', '0']);
    expect(onGhost.options.duration).toBe(1200);
  });

  it('swaps a title whose words changed at the midpoint instead of dissolving one through the other', () => {
    const host = present(morphDeck(
      [title('t', 'Dynamic IoU', { morphId: 'title' })],
      [title('t2', 'Trajectory DTW', { morphId: 'title' })],
    ));
    const target = host.querySelector<HTMLElement>('[data-element-id="t2"]')!;
    const ghost = target.nextElementSibling as HTMLElement;
    expect(ghost.classList.contains('morph-ghost')).toBe(true);
    const stepAt = (frames: Keyframe[]) => frames.filter((frame) => frame.offset === 0.5).map((frame) => frame.opacity);
    const swapOn = (el: Element) => calls.filter((call) => call.target === el).find((call) => stepAt(call.keyframes).length === 2)!;
    expect(stepAt(swapOn(ghost).keyframes)).toEqual(['1', '0']);
    expect(stepAt(swapOn(target).keyframes)).toEqual(['0', '1']);
  });
});
