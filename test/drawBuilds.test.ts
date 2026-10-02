// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck, type SlideElement, type TimelineEntry } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { TimelinePanel } from '../src/renderer/editor/timelinePanel.js';
import { buildFromNode, slideToHtml } from '../src/shared/htmlSlides.js';
import { partialStroke } from '../src/shared/shapeSvg.js';
import { DEFAULT_DRAW_DURATION, drawDuration, isDrawBuild } from '../src/shared/timeline.js';
import { installCanvasDomShims } from './support/canvasHarness.js';

/**
 * A line or arrow that draws itself in.
 *
 * The build is an `appear` with `value: "draw"` and a duration. What an
 * author sees: the arrow starts at nothing, grows from its tail with the head
 * leading, and is whole when the time is up — and is never left half drawn,
 * whether the talk moves on mid-stroke or jumps straight to the step.
 */

type Shape = Extract<SlideElement, { type: 'shape' }>;

function arrow(over: Partial<Shape> = {}): Shape {
  return {
    id: 'arrow', type: 'shape', shape: 'arrow', x: 100, y: 200, w: 400, h: 20, rot: 0, z: 1,
    opacity: 1, class: [], style: {}, fill: null, stroke: '#111111', strokeWidth: 6,
    radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: true,
    ...over,
  } as Shape;
}

function draw(over: Partial<TimelineEntry['action']> = {}): TimelineEntry {
  return {
    id: 't-draw',
    trigger: { on: 'click', ref: null, delay: 0 },
    action: { type: 'appear', target: 'arrow', value: 'draw', duration: 800, ...over },
  };
}

function deckWith(element: SlideElement, entry: TimelineEntry): Deck {
  const deck = emptyDeck('Draw');
  deck.slides[0].elements.push(element);
  deck.slides[0].timeline.push(entry);
  return deck;
}

describe('the geometry of a partly drawn stroke', () => {
  it('shortens a straight line from its start', () => {
    expect(partialStroke(arrow(), 0)).toEqual({ x2: 0 });
    expect(partialStroke(arrow(), 0.25)).toEqual({ x2: 100 });
    expect(partialStroke(arrow(), 1)).toEqual({ x2: 400 });
    expect(partialStroke(arrow(), 7)).toEqual({ x2: 400 });
  });

  it('cuts a curve so its tip lies on the full curve', () => {
    // Control point straight above the middle of a horizontal 400 px arrow.
    const curved = arrow({ control: { x: 300, y: 110 } });
    const half = partialStroke(curved, 0.5) as { d: string };
    const numbers = half.d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    // M 0 10 Q <first control> <tip>: the tip is the curve's own midpoint,
    // B(0.5) = (P0 + 2·C + P2) / 4, in the element's local coordinates.
    expect(numbers.slice(0, 2)).toEqual([0, 10]);
    expect(numbers.slice(4)).toEqual([200, -40]);
    expect(numbers.slice(2, 4)).toEqual([100, -40]);
    expect((partialStroke(curved, 1) as { d: string }).d).toBe('M 0 10 Q 200 -90 400 10');
  });

  it('shortens only lines and arrows; outlines are traced another way', () => {
    expect(partialStroke(arrow({ shape: 'rect' }), 0.5)).toBeNull();
  });
});

describe('which builds draw', () => {
  it('is an appear marked draw on a line or arrow, with a default time', () => {
    const slide = deckWith(arrow(), draw()).slides[0];
    expect(isDrawBuild(slide.timeline[0], slide)).toBe(true);
    expect(drawDuration(slide.timeline[0])).toBe(800);
    expect(drawDuration(draw({ duration: undefined }))).toBe(DEFAULT_DRAW_DURATION);

    // Any shape can be drawn in; text cannot.
    const box = deckWith(arrow({ shape: 'rect' }), draw()).slides[0];
    expect(isDrawBuild(box.timeline[0], box)).toBe(true);
    const words = deckWith({
      id: 'arrow', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, html: 'A', align: 'left', valign: 'top',
    } as SlideElement, draw()).slides[0];
    expect(isDrawBuild(words.timeline[0], words)).toBe(false);
    const plain = deckWith(arrow(), draw({ value: null })).slides[0];
    expect(isDrawBuild(plain.timeline[0], plain)).toBe(false);
  });

  it('survives the HTML round trip an agent edits through', () => {
    const deck = deckWith(arrow(), draw());
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html).toContain('data-build="click"');
    expect(html).toContain('data-build-effect="draw"');
    expect(html).toContain('data-build-duration="800"');
    const back = buildFromNode(
      { dataset: { build: 'afterPrev+200', buildEffect: 'draw', buildDuration: '800' } } as never,
      'arrow', 0,
    );
    expect(back?.trigger).toMatchObject({ on: 'afterPrev', delay: 200 });
    expect(back?.action).toEqual({ type: 'appear', target: 'arrow', value: 'draw', duration: 800 });
    // An ordinary build is untouched by any of this.
    expect(buildFromNode({ dataset: { build: 'click' } } as never, 'arrow', 0)?.action)
      .toEqual({ type: 'appear', target: 'arrow', value: null });
  });
});

describe('drawing an arrow in while presenting', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
    });
  });
  afterEach(() => vi.useRealTimers());

  function present(deck: Deck): { player: Player; line: () => SVGElement; hidden: () => boolean } {
    installCanvasDomShims();
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });
    const node = () => host.querySelector<HTMLElement>('[data-element-id="arrow"]')!;
    return {
      player,
      line: () => node().querySelector<SVGElement>('svg > line, svg > path')!,
      hidden: () => node().style.visibility === 'hidden',
    };
  }
  const x2 = (line: SVGElement) => Number(line.getAttribute('x2'));

  it('grows from nothing to the whole line over its duration', () => {
    const { player, line, hidden } = present(deckWith(arrow(), draw()));
    expect(hidden()).toBe(true);

    player.next();
    // Visible, but not yet drawn: the full line is never painted first.
    expect(hidden()).toBe(false);
    expect(x2(line())).toBe(0);

    vi.advanceTimersByTime(400);
    const halfway = x2(line());
    expect(halfway).toBeGreaterThan(100);
    expect(halfway).toBeLessThan(300);

    vi.advanceTimersByTime(600);
    expect(x2(line())).toBe(400);
  });

  it('finishes the stroke at once when the talk moves on mid-draw', () => {
    const deck = deckWith(arrow(), draw({ duration: 2000 }));
    deck.slides[0].elements.push(arrow({ id: 'second', y: 400 }));
    deck.slides[0].timeline.push({
      id: 't-next', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'second', value: null },
    });
    const { player, line } = present(deck);
    player.next();
    vi.advanceTimersByTime(300);
    expect(x2(line())).toBeLessThan(400);
    player.next();
    expect(x2(line())).toBe(400);
    // And nothing keeps animating it afterwards.
    vi.advanceTimersByTime(3000);
    expect(x2(line())).toBe(400);
  });

  it('shows the finished line when a step is jumped to rather than played', () => {
    const { player, line, hidden } = present(deckWith(arrow(), draw()));
    player.goTo({ slide: 0, step: 1 });
    expect(hidden()).toBe(false);
    expect(x2(line())).toBe(400);
  });

  it('draws a curve with its tip on the curve', () => {
    const { player, line } = present(deckWith(arrow({ control: { x: 300, y: 110 } }), draw()));
    const full = line().getAttribute('d');
    player.next();
    // A sliver, not a point, so the arrowhead already faces along the curve.
    const tip = line().getAttribute('d')!.match(/-?\d+(\.\d+)?/g)!.map(Number).slice(4);
    expect(tip[0]).toBeGreaterThan(0);
    expect(tip[0]).toBeLessThan(2);
    expect(tip[1]).toBeLessThan(10);
    vi.advanceTimersByTime(1100);
    expect(line().getAttribute('d')).toBe(full);
  });
});

describe('choosing draw in from the Build panel', () => {
  beforeEach(() => document.body.replaceChildren());

  it('offers it for an arrow, with a time, and takes both away again', () => {
    const deck = deckWith(arrow(), draw({ value: null, duration: undefined }));
    deck.slides[0].elements.push({
      id: 'label', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 2,
      opacity: 1, class: [], style: {}, html: 'A', align: 'left', valign: 'top',
    });
    deck.slides[0].timeline.push({
      id: 't-label', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'label', value: null },
    });
    const store = new EditorStore(deck, '/tmp/draw');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);
    const card = (id: string) => host.querySelector<HTMLElement>(`.timeline-row[data-entry-id="${id}"]`)!;
    const options = (id: string) => [...card(id).querySelectorAll<HTMLOptionElement>('select.build-action option')]
      .map((option) => option.value);
    const entry = () => store.slide!.timeline.find((candidate) => candidate.id === 't-draw')!;

    // Only a shape can be line-drawn; text keeps its own choices.
    expect(options('t-draw')).toContain('appear:draw');
    expect(options('t-label')).not.toContain('appear:draw');
    expect(card('t-draw').querySelector('.build-duration')).toBeNull();

    const choose = (value: string) => {
      const select = card('t-draw').querySelector<HTMLSelectElement>('select.build-action')!;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    choose('appear:draw');
    expect(entry().action).toMatchObject({ type: 'appear', value: 'draw', duration: DEFAULT_DRAW_DURATION });
    expect(card('t-draw').querySelector<HTMLSelectElement>('select.build-action')!.value).toBe('appear:draw');

    const time = card('t-draw').querySelector<HTMLInputElement>('.build-duration')!;
    expect(time.value).toBe(String(DEFAULT_DRAW_DURATION));
    time.value = '1500';
    time.dispatchEvent(new Event('change', { bubbles: true }));
    expect(entry().action.duration).toBe(1500);

    choose('appear');
    expect(entry().action).toEqual({ type: 'appear', target: 'arrow', value: null });
    expect(card('t-draw').querySelector('.build-duration')).toBeNull();
  });
});

describe('dissolve in and out', () => {
  type Fake = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; finished: boolean; cancelled: boolean };
  let animations: Fake[] = [];
  beforeEach(() => {
    animations = [];
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
    });
    // jsdom has no Web Animations; record what the player asks for instead.
    (Element.prototype as unknown as { animate: unknown }).animate = function animate(
      keyframes: Keyframe[], options: KeyframeAnimationOptions,
    ) {
      const fake: Fake = { keyframes, options, finished: false, cancelled: false };
      animations.push(fake);
      return {
        finish() { fake.finished = true; },
        cancel() { fake.cancelled = true; },
        finished: new Promise(() => {}),
      };
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (Element.prototype as unknown as { animate?: unknown }).animate;
  });

  function text(id: string): SlideElement {
    return {
      id, type: 'text', x: 0, y: 0, w: 400, h: 100, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, html: id, align: 'left', valign: 'top',
    } as SlideElement;
  }
  function entry(id: string, target: string, over: Partial<TimelineEntry> = {}): TimelineEntry {
    return {
      id, trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target, value: null }, ...over,
    };
  }
  function mount(deck: Deck) {
    installCanvasDomShims();
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });
    const node = (id: string) => host.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!;
    return { host, player, hidden: (id: string) => node(id).style.visibility === 'hidden', node };
  }

  it('fades an element in over its duration', () => {
    const deck = emptyDeck('Dissolve');
    deck.slides[0].elements.push(text('title'));
    deck.slides[0].timeline.push(entry('t-1', 'title', {
      action: { type: 'appear', target: 'title', value: 'dissolve', duration: 1200 },
    }));
    const { player, hidden } = mount(deck);
    expect(hidden('title')).toBe(true);
    player.next();
    expect(hidden('title')).toBe(false);
    expect(animations).toHaveLength(1);
    expect(animations[0].keyframes).toEqual([{ opacity: '0' }, { opacity: '1' }]);
    expect(animations[0].options.duration).toBe(1200);
  });

  it('fades a copy out while the element itself is already gone', () => {
    const deck = emptyDeck('Dissolve');
    deck.slides[0].elements.push(text('title'), text('next'));
    deck.slides[0].timeline.push(
      entry('t-1', 'title', { action: { type: 'disappear', target: 'title', value: 'dissolve' } }),
      entry('t-2', 'next'),
    );
    const { host, player, hidden } = mount(deck);
    expect(hidden('title')).toBe(false);
    player.next();
    expect(hidden('title')).toBe(true);
    const ghost = host.querySelector<HTMLElement>('[data-element-id="title"] + [aria-hidden="true"]');
    expect(ghost?.textContent).toContain('title');
    expect(animations[0].keyframes).toEqual([{ opacity: '1' }, { opacity: '0' }]);
    expect(animations[0].options.duration).toBe(1000);
    // Moving on mid-fade clears the copy away.
    player.next();
    expect(ghost!.isConnected).toBe(false);
  });

  it('starts an after-previous build once the dissolve before it has finished', () => {
    const deck = emptyDeck('Dissolve');
    deck.slides[0].elements.push(text('title'), text('caption'));
    deck.slides[0].timeline.push(
      entry('t-1', 'title', { action: { type: 'appear', target: 'title', value: 'dissolve', duration: 800 } }),
      entry('t-2', 'caption', { trigger: { on: 'afterPrev', ref: null, delay: 100 } }),
    );
    const { player, hidden } = mount(deck);
    player.next();
    vi.advanceTimersByTime(850);
    expect(hidden('caption')).toBe(true);
    vi.advanceTimersByTime(100);
    expect(hidden('caption')).toBe(false);
  });

  it('round-trips through authoring HTML', () => {
    const deck = emptyDeck('Dissolve');
    deck.slides[0].elements.push(text('title'));
    deck.slides[0].timeline.push(entry('t-1', 'title', {
      action: { type: 'appear', target: 'title', value: 'dissolve', duration: 700 },
    }));
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html).toContain('data-build-effect="dissolve"');
    expect(html).toContain('data-build-duration="700"');
    expect(buildFromNode(
      { dataset: { build: 'click', buildEffect: 'dissolve', buildDuration: '700' } } as never, 'title', 0,
    )?.action).toEqual({ type: 'appear', target: 'title', value: 'dissolve', duration: 700 });
  });
});

describe('builds that run on arriving at a slide', () => {
  beforeEach(() => vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
  }));
  afterEach(() => vi.useRealTimers());

  function twoSlides(): Deck {
    const deck = emptyDeck('Entry');
    const second = structuredClone(deck.slides[0]);
    second.id = 'slide-2';
    const text = (id: string) => ({
      id, type: 'text', x: 0, y: 0, w: 400, h: 100, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, html: id, align: 'left', valign: 'top',
    }) as SlideElement;
    second.elements = [text('now'), text('later')];
    second.timeline = [
      { id: 't-now', trigger: { on: 'afterPrev', ref: null, delay: 0 },
        action: { type: 'appear', target: 'now', value: null } },
      { id: 't-later', trigger: { on: 'afterPrev', ref: null, delay: 1600 },
        action: { type: 'appear', target: 'later', value: null } },
    ];
    deck.slides.push(second);
    return deck;
  }
  function mount(deck: Deck) {
    installCanvasDomShims();
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });
    const hidden = (id: string) =>
      host.querySelector<HTMLElement>(`[data-element-id="${id}"]`)!.style.visibility === 'hidden';
    return { player, hidden };
  }

  it('plays their delays when the talk advances onto the slide', () => {
    const { player, hidden } = mount(twoSlides());
    player.next();
    // No delay: part of the first paint, as before.
    expect(hidden('now')).toBe(false);
    // A delay is honoured instead of collapsed.
    expect(hidden('later')).toBe(true);
    vi.advanceTimersByTime(1600);
    expect(hidden('later')).toBe(false);
  });

  it('still resolves at once when the slide is jumped to', () => {
    const { player, hidden } = mount(twoSlides());
    player.goToSlide(1);
    expect(hidden('now')).toBe(false);
    expect(hidden('later')).toBe(false);
  });
});

describe('choosing dissolve from the Build panel', () => {
  beforeEach(() => document.body.replaceChildren());

  it('offers dissolve in and out for any element, with a time', () => {
    const deck = emptyDeck('Dissolve');
    deck.slides[0].elements.push({
      id: 'label', type: 'text', x: 0, y: 0, w: 100, h: 50, rot: 0, z: 2,
      opacity: 1, class: [], style: {}, html: 'A', align: 'left', valign: 'top',
    });
    deck.slides[0].timeline.push({
      id: 't-label', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'label', value: null },
    });
    const store = new EditorStore(deck, '/tmp/dissolve');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);
    const select = () => host.querySelector<HTMLSelectElement>('.timeline-row select.build-action')!;
    expect([...select().options].map((option) => option.value))
      .toEqual([
        'appear', 'appear:dissolve', 'appear:blur', 'appear:paragraph',
        'disappear', 'disappear:dissolve', 'disappear:blur', 'play', 'pause',
      ]);
    const choose = (value: string) => {
      select().value = value;
      select().dispatchEvent(new Event('change', { bubbles: true }));
    };
    choose('disappear:dissolve');
    expect(store.slide!.timeline[0].action)
      .toEqual({ type: 'disappear', target: 'label', value: 'dissolve', duration: 1000 });
    expect(select().value).toBe('disappear:dissolve');
    expect(host.querySelector<HTMLInputElement>('.build-duration')!.value).toBe('1000');
    choose('appear:paragraph');
    expect(store.slide!.timeline[0].action).toEqual({ type: 'appear', target: 'label', value: 'byParagraph' });
  });
});

describe('blur in and out', () => {
  let frames: Keyframe[][] = [];
  beforeEach(() => {
    frames = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    (Element.prototype as unknown as { animate: unknown }).animate = function animate(keyframes: Keyframe[]) {
      frames.push(keyframes);
      return { finish() {}, cancel() {}, finished: new Promise(() => {}) };
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (Element.prototype as unknown as { animate?: unknown }).animate;
  });

  it('brings an element into focus as it fades in, keeping its own shadow', () => {
    const deck = emptyDeck('Blur');
    deck.slides[0].elements.push(arrow({ id: 'card', shape: 'rect', style: { filter: 'drop-shadow(0px 8px 24px red)' } }));
    deck.slides[0].timeline.push({
      id: 't-1', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'card', value: 'blur' },
    });
    installCanvasDomShims();
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });
    player.next();
    expect(frames).toHaveLength(1);
    const [from, to] = frames[0];
    expect(from.opacity).toBe('0');
    expect(String(from.filter)).toMatch(/^blur\(24px\) drop-shadow/);
    expect(String(to.filter)).toMatch(/^blur\(0px\) drop-shadow/);
    expect(drawDuration({ ...deck.slides[0].timeline[0], action: { ...deck.slides[0].timeline[0].action, value: 'draw' } }))
      .toBe(DEFAULT_DRAW_DURATION);
  });
});

describe('the duration slider on a build card', () => {
  beforeEach(() => document.body.replaceChildren());

  it('drags to a time and commits once, and the number follows', () => {
    const deck = deckWith(arrow(), draw({ value: 'blur', duration: 1000 }));
    const store = new EditorStore(deck, '/tmp/slider');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new TimelinePanel(host, store);
    const slider = host.querySelector<HTMLInputElement>('.timeline-row .duration-slider')!;
    const number = () => host.querySelector<HTMLInputElement>('.timeline-row .build-duration')!;
    expect(host.querySelector<HTMLSelectElement>('select.build-action')!.value).toBe('appear:blur');
    expect(slider.value).toBe('1000');
    slider.value = '2500';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(number().value).toBe('2500');
    expect(store.slide!.timeline[0].action.duration).toBe(1000);
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.slide!.timeline[0].action.duration).toBe(2500);
  });
});

describe('line draw on an outline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    // jsdom does not measure SVG; a 1000-unit outline stands in.
    (SVGElement.prototype as unknown as { getTotalLength: () => number }).getTotalLength = () => 1000;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (SVGElement.prototype as unknown as { getTotalLength?: unknown }).getTotalLength;
  });

  it('traces a box along its outline, then colours it in, then leaves it untouched', () => {
    installCanvasDomShims();
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const deck = deckWith(arrow({ shape: 'rect', fill: '#dbe4ff', h: 200 }), draw({ duration: 1000 }));
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });
    const rect = () => host.querySelector<SVGElement>('[data-element-id="arrow"] svg > rect')!;
    player.next();
    expect(rect().style.strokeDasharray).toBe('1000 1000');
    expect(rect().style.strokeDashoffset).toBe('1000');
    expect(rect().style.fillOpacity).toBe('0');
    vi.advanceTimersByTime(500);
    expect(Number(rect().style.strokeDashoffset)).toBeLessThan(1000);
    expect(rect().style.fillOpacity).toBe('0');
    vi.advanceTimersByTime(700);
    expect(rect().style.strokeDasharray).toBe('');
    expect(rect().style.fillOpacity).toBe('');
  });
});
