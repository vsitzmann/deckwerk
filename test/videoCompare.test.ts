// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type SlideElement } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import {
  DEFAULT_WIPE,
  arrangeAsWipe,
  compareFromDataset,
  formatClock,
  scrubFraction,
  scrubTime,
  trimWindow,
  unionBox,
  wipeClipPath,
  wipeLayers,
  wipeOf,
} from '../src/shared/compare.js';
import { renderElement, syncMediaFrame } from '../src/renderer/player/render.js';
import { capabilities } from '../src/shared/capabilities.js';

/**
 * Comparing pictures: the before/after wipe's model, its HTML round trip and
 * its drawing, and the arithmetic behind a sync group's scrubber.
 */

type Video = Extract<SlideElement, { type: 'video' }>;
type Image = Extract<SlideElement, { type: 'image' }>;

function video(over: Partial<Video> = {}): Video {
  return {
    id: 'v', type: 'video', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: 'assets/a.mp4', fit: 'cover', autoplay: true, loop: true,
    muted: true, controls: false, start: 0, end: null, poster: null, sourceBox: null,
    ...over,
  } as Video;
}

function image(over: Partial<Image> = {}): Image {
  return {
    id: 'i', type: 'image', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: 'assets/a.png', fit: 'cover', alt: '', sourceBox: null,
    ...over,
  } as Image;
}

describe('the wipe in the model', () => {
  it('is only a wipe with compare set, and defaults the divider to the middle', () => {
    expect(wipeOf(video())).toBeNull();
    expect(wipeOf(video({ compare: 'wipe' }))).toBe(DEFAULT_WIPE);
    expect(wipeOf(video({ compare: 'wipe', wipe: 0.3 }))).toBe(0.3);
    expect(wipeOf(image({ compare: 'wipe', wipe: 0.8 }))).toBe(0.8);
  });

  it('survives the deck schema, and refuses a divider off the box', () => {
    const deck = emptyDeck('Wipe');
    deck.slides[0].elements.push(video({ compare: 'wipe', wipe: 0.25 }));
    const parsed = parseDeck(JSON.parse(JSON.stringify(deck)));
    expect(parsed.slides[0].elements[0]).toMatchObject({ compare: 'wipe', wipe: 0.25 });
    (deck.slides[0].elements[0] as Video).wipe = 1.5;
    expect(() => parseDeck(JSON.parse(JSON.stringify(deck)))).toThrow();
  });

  it('clips the upper layer to the left of the divider', () => {
    expect(wipeClipPath(0.5)).toBe('inset(0 50% 0 0)');
    expect(wipeClipPath(0.25)).toBe('inset(0 75% 0 0)');
    expect(wipeClipPath(2)).toBe('inset(0 0% 0 0)');
  });

  it('finds both layers from either one', () => {
    const under = video({ id: 'sim', syncGroup: 'g', z: 1 });
    const top = video({ id: 'real', syncGroup: 'g', z: 2, compare: 'wipe' });
    const other = video({ id: 'other', x: 900, z: 3 });
    const elements = [top, under, other];
    expect(wipeLayers(elements, top)).toEqual({ top, under });
    expect(wipeLayers(elements, under)).toEqual({ top, under });
    expect(wipeLayers(elements, other)).toBeNull();
    // A still pairs by sharing the box, not by a sync group.
    const before = image({ id: 'before', z: 1 });
    const after = image({ id: 'after', z: 2, compare: 'wipe' });
    expect(wipeLayers([before, after], before)).toEqual({ top: after, under: before });
  });
});

describe('arranging two pictures as a wipe', () => {
  it('stacks them in one box, left one on top, synced, with the divider in the middle', () => {
    const right = video({ id: 'sim', x: 1000, y: 300, w: 640, h: 360, z: 1 });
    const left = video({ id: 'real', x: 200, y: 300, w: 640, h: 360, z: 2 });
    const caption = image({ id: 'cap', z: 3 });
    const elements: SlideElement[] = [right, left, caption];
    expect(arrangeAsWipe(elements, ['sim', 'real'])).toBe(true);
    // Centred where the pair stood: the union is 200…1640, so 600…1240.
    expect(left).toMatchObject({ x: 600, y: 300, w: 640, h: 360, compare: 'wipe', wipe: 0.5 });
    expect(right).toMatchObject({ x: 600, y: 300, w: 640, h: 360 });
    expect(right.compare).toBeUndefined();
    expect(left.syncGroup).toBeDefined();
    expect(left.syncGroup).toBe(right.syncGroup);
    expect(left.z).toBeGreaterThan(right.z);
    // Everything else keeps its place in paint order.
    expect(caption.z).toBeGreaterThan(left.z);
    expect(wipeLayers(elements, right)?.top.id).toBe('real');
  });

  it('puts the left one above even when it was below, without ties', () => {
    const left = video({ id: 'a', x: 0, z: 5 });
    const right = video({ id: 'b', x: 800, z: 5, syncGroup: 'keep' });
    const elements: SlideElement[] = [right, left];
    arrangeAsWipe(elements, ['a', 'b']);
    expect(left.z).toBeGreaterThan(right.z);
    expect(left.syncGroup).toBe('keep');
  });

  it('works for two stills and refuses anything else', () => {
    const elements: SlideElement[] = [image({ id: 'x', x: 0 }), image({ id: 'y', x: 500 })];
    expect(arrangeAsWipe(elements, ['x', 'y'])).toBe(true);
    expect((elements[0] as Image).compare).toBe('wipe');
    expect(arrangeAsWipe(elements, ['x', 'missing'])).toBe(false);
    expect(arrangeAsWipe(elements, ['x', 'x'])).toBe(false);
  });
});

describe('the wipe in the HTML an agent edits', () => {
  function measured(over: Partial<MeasuredNode>): MeasuredNode {
    return {
      tag: 'video', elementId: null, classes: [], dataset: {}, rect: { x: 0, y: 0, w: 400, h: 300 },
      rotation: 0, opacity: 1, style: {}, html: '', attrs: { src: 'assets/a.mp4' }, ...over,
    };
  }

  it('is written as data-compare / data-wipe on the top layer only', () => {
    const deck = emptyDeck('Wipe');
    deck.slides[0].elements.push(
      video({ id: 'sim', syncGroup: 'g', z: 1 }),
      video({ id: 'real', syncGroup: 'g', z: 2, compare: 'wipe', wipe: 0.4 }),
      image({ id: 'crop', z: 3, compare: 'wipe', sourceBox: { x: -10, y: 0, w: 420, h: 300 } }),
    );
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html.match(/data-compare="wipe"/g)).toHaveLength(2);
    expect(html).toContain('data-wipe="0.4"');
    expect(html).toContain('data-wipe="0.5"');
  });

  it('is read back on plain and cropped videos and images', () => {
    const plain = elementFromNode(measured({ dataset: { compare: 'wipe', wipe: '0.4' } }), 'v', 1) as Video;
    expect(plain).toMatchObject({ compare: 'wipe', wipe: 0.4 });
    const cropped = elementFromNode(measured({
      tag: 'div', dataset: { element: 'video', src: 'assets/a.mp4', compare: 'wipe', wipe: '30%' }, attrs: {},
    }), 'c', 1) as Video;
    expect(cropped).toMatchObject({ compare: 'wipe', wipe: 0.3 });
    const still = elementFromNode(measured({
      tag: 'img', dataset: { compare: 'wipe' }, attrs: { src: 'assets/a.png' },
    }), 'i', 1) as Image;
    expect(still).toMatchObject({ type: 'image', compare: 'wipe', wipe: 0.5 });
    const none = elementFromNode(measured({ dataset: { wipe: '0.4' } }), 'n', 1) as Video;
    expect(none.compare).toBeUndefined();
    expect(none.wipe).toBeUndefined();
  });

  it('clamps and defaults what an author writes', () => {
    expect(compareFromDataset({ compare: 'wipe', wipe: '1.7' })).toEqual({ compare: 'wipe', wipe: 1 });
    expect(compareFromDataset({ compare: 'wipe', wipe: 'left' })).toEqual({ compare: 'wipe', wipe: 0.5 });
    expect(compareFromDataset({ compare: 'side-by-side' })).toEqual({});
  });
});

describe('drawing the wipe', () => {
  const resolveSrc = (src: string) => src;

  it('clips the media body and draws the divider where the deck says', () => {
    const node = renderElement(video({ compare: 'wipe', wipe: 0.3 }), { resolveSrc });
    const body = node.querySelector('video')!;
    expect(body.style.clipPath).toBe('inset(0 70% 0 0)');
    const divider = node.querySelector<HTMLElement>(':scope > .wipe-divider')!;
    expect(divider.style.left).toBe('30%');
    expect(divider.querySelector('.wipe-handle')).not.toBeNull();
    // Last child, after the frame overlay, so patch and fresh render agree.
    expect(node.lastElementChild).toBe(divider);
  });

  it('moves and removes it through the editor’s in-place patch', () => {
    const el = image({ compare: 'wipe', wipe: 0.5 });
    const node = renderElement(el, { resolveSrc });
    syncMediaFrame(node, { ...el, wipe: 0.8 });
    expect(node.querySelector<HTMLElement>('.wipe-divider')!.style.left).toBe('80%');
    expect(node.querySelector('img')!.style.clipPath).toBe('inset(0 20% 0 0)');
    syncMediaFrame(node, { ...el, compare: undefined, wipe: undefined });
    expect(node.querySelector('.wipe-divider')).toBeNull();
    expect(node.querySelector('img')!.style.clipPath).toBe('');
  });

  it('leaves a plain picture alone', () => {
    const node = renderElement(video(), { resolveSrc });
    expect(node.querySelector('.wipe-divider')).toBeNull();
    expect(node.querySelector('video')!.style.clipPath).toBe('');
  });
});

describe('the group scrubber’s arithmetic', () => {
  it('spans the members’ combined box', () => {
    expect(unionBox([{ x: 100, y: 200, w: 300, h: 100 }, { x: 500, y: 150, w: 200, h: 100 }]))
      .toEqual({ x: 100, y: 150, w: 600, h: 150 });
    expect(unionBox([])).toBeNull();
  });

  it('works inside the leader’s trim window, once its length is known', () => {
    expect(trimWindow({ start: 2, end: 6 }, NaN)).toEqual({ start: 2, end: 6 });
    expect(trimWindow({ start: 2, end: null }, 10)).toEqual({ start: 2, end: 10 });
    expect(trimWindow({ start: 2, end: null }, NaN)).toBeNull();
    const span = { start: 2, end: 6 };
    expect(scrubFraction(4, span)).toBe(0.5);
    expect(scrubFraction(9, span)).toBe(1);
    expect(scrubTime(0.25, span)).toBe(3);
    // Never exactly on the out-point, which would loop the clip back.
    expect(scrubTime(1, span)).toBeCloseTo(5.95, 5);
  });

  it('reads time as m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65.4)).toBe('1:05');
    expect(formatClock(NaN)).toBe('0:00');
  });
});

describe('the capability an agent reads', () => {
  it('is a valid slide with a synced wipe pair', () => {
    const cap = capabilities().find((capability) => capability.id === 'video-compare')!;
    const deck = emptyDeck('Cap');
    deck.slides[0].elements = cap.elements;
    const parsed = parseDeck(JSON.parse(JSON.stringify(deck)));
    const top = parsed.slides[0].elements.find((el) => wipeOf(el) !== null)!;
    expect(wipeLayers(parsed.slides[0].elements, top)?.under).not.toBeNull();
  });
});
