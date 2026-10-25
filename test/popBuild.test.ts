// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck, type Slide, type SlideElement, type TimelineEntry } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { TimelinePanel } from '../src/renderer/editor/timelinePanel.js';
import { buildFromNode, slideToHtml } from '../src/shared/htmlSlides.js';
import {
  DEFAULT_POP_DURATION, DEFAULT_POP_FROM, DEFAULT_POP_PEAK, buildEffect, effectDuration, popScales,
} from '../src/shared/timeline.js';
import { installCanvasDomShims } from './support/canvasHarness.js';

const slide = { id: 's', elements: [], timeline: [] } as unknown as Slide;
const entry = (
  type: 'appear' | 'disappear',
  value: string | null,
  over: Partial<TimelineEntry['action']> = {},
): TimelineEntry => ({
  id: 'b', trigger: { on: 'click', ref: null, delay: 0 },
  action: { type, target: 'e', value, ...over },
}) as TimelineEntry;

function text(id: string): SlideElement {
  return {
    id, type: 'text', x: 0, y: 0, w: 400, h: 100, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, html: id, align: 'left', valign: 'top',
  } as SlideElement;
}

function deckWith(action: Partial<TimelineEntry['action']>): Deck {
  const deck = emptyDeck('Pop');
  deck.slides[0].elements.push(text('title'));
  deck.slides[0].timeline.push({
    id: 't-pop', trigger: { on: 'click', ref: null, delay: 0 },
    action: { type: 'appear', target: 'title', value: 'pop', ...action },
  });
  return deck;
}

describe('pop builds', () => {
  it('is an animated appear with its own default time', () => {
    expect(buildEffect(entry('appear', 'pop'), slide)).toBe('pop');
    expect(effectDuration(entry('appear', 'pop'), 'pop')).toBe(DEFAULT_POP_DURATION);
    expect(effectDuration(entry('appear', 'pop', { duration: 300 }), 'pop')).toBe(300);
  });

  it('has no disappear form', () => {
    expect(buildEffect(entry('disappear', 'pop'), slide)).toBeNull();
  });

  it('starts at 60% and overshoots to 106% unless the build says otherwise', () => {
    expect(popScales(entry('appear', 'pop'))).toEqual({ from: DEFAULT_POP_FROM, peak: DEFAULT_POP_PEAK });
    expect(popScales(entry('appear', 'pop', { popFrom: 0, popPeak: 1.3 }))).toEqual({ from: 0, peak: 1.3 });
  });
});

describe('popping in while presenting', () => {
  let animations: Array<{ keyframes: Keyframe[]; options: KeyframeAnimationOptions }> = [];
  beforeEach(() => {
    animations = [];
    // jsdom has no Web Animations; record what the player asks for instead.
    (Element.prototype as unknown as { animate: unknown }).animate = function animate(
      keyframes: Keyframe[], options: KeyframeAnimationOptions,
    ) {
      animations.push({ keyframes, options });
      return { finish() {}, cancel() {}, finished: new Promise(() => {}) };
    };
  });
  afterEach(() => {
    delete (Element.prototype as unknown as { animate?: unknown }).animate;
  });

  function present(deck: Deck): Player {
    installCanvasDomShims();
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    return new Player({ deck, container: host, resolveSrc: (src) => src });
  }

  it('grows through the sizes and time the build states', () => {
    const player = present(deckWith({ duration: 900, popFrom: 0.2, popPeak: 1.25 }));
    player.next();
    expect(animations).toHaveLength(1);
    expect(animations[0].keyframes.map((frame) => frame.scale)).toEqual(['0.2', '1.25', '1']);
    expect(animations[0].options.duration).toBe(900);
  });

  it('uses the defaults when the build states none', () => {
    present(deckWith({})).next();
    expect(animations[0].keyframes.map((frame) => frame.scale)).toEqual(['0.6', '1.06', '1']);
  });
});

describe('pop sizes in authoring HTML', () => {
  const canvas = { w: 1920, h: 1080 };
  it('reads them from the page', () => {
    const node = { dataset: { build: 'click', buildEffect: 'pop', buildPopFrom: '0.3', buildPopPeak: '1.2' } };
    expect(buildFromNode(node as never, 'title', 0)!.action)
      .toMatchObject({ value: 'pop', popFrom: 0.3, popPeak: 1.2 });
  });

  it('ignores sizes out of range, and sizes on another effect', () => {
    const odd = { dataset: { build: 'click', buildEffect: 'pop', buildPopFrom: '2', buildPopPeak: '0.5' } };
    expect(buildFromNode(odd as never, 'title', 0)!.action).not.toHaveProperty('popFrom');
    expect(buildFromNode(odd as never, 'title', 0)!.action).not.toHaveProperty('popPeak');
    const fade = { dataset: { build: 'click', buildEffect: 'dissolve', buildPopFrom: '0.3' } };
    expect(buildFromNode(fade as never, 'title', 0)!.action).not.toHaveProperty('popFrom');
  });

  it('writes them out, so a page round trip keeps them', () => {
    const html = slideToHtml(deckWith({ popFrom: 0.3, popPeak: 1.2 }).slides[0], canvas);
    expect(html).toContain('data-build-pop-from="0.3"');
    expect(html).toContain('data-build-pop-peak="1.2"');
    expect(slideToHtml(deckWith({}).slides[0], canvas)).not.toContain('data-build-pop');
  });
});

describe('pop sizes in the Build panel', () => {
  beforeEach(() => document.body.replaceChildren());

  it('edits them in percent and drops them when the build stops popping', () => {
    const store = new EditorStore(deckWith({ duration: 500 }), '/tmp/pop');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);
    const field = (cls: string) => host.querySelector<HTMLInputElement>(`input.${cls}`)!;
    expect(field('build-pop-from').value).toBe('60');
    expect(field('build-pop-peak').value).toBe('106');

    field('build-pop-from').value = '25';
    field('build-pop-from').dispatchEvent(new Event('change', { bubbles: true }));
    field('build-pop-peak').value = '300';
    field('build-pop-peak').dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.slide!.timeline[0].action).toMatchObject({ popFrom: 0.25, popPeak: 2 });

    const select = host.querySelector<HTMLSelectElement>('.timeline-row select.build-action')!;
    select.value = 'appear:dissolve';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.slide!.timeline[0].action).not.toHaveProperty('popFrom');
    expect(store.slide!.timeline[0].action).not.toHaveProperty('popPeak');
    expect(host.querySelector('input.build-pop-from')).toBeNull();
  });
});
