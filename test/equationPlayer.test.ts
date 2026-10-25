// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';

/** The Player stepping through equation builds and emphases, and jumping without a Morph. */

const originalAnimate = HTMLElement.prototype.animate;
beforeEach(() => {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
  if (!CSS.escape) CSS.escape = (value) => value;
});
afterEach(() => {
  HTMLElement.prototype.animate = originalAnimate;
  document.body.replaceChildren();
});

function text(id: string, html: string, morphId?: string): SlideElement {
  return {
    id, type: 'text', x: 100, y: 300, w: 1600, h: 300, rot: 0, z: 1, opacity: 1, class: [], style: {},
    html, align: 'center', valign: 'middle', ...(morphId ? { morphId } : {}),
  } as SlideElement;
}

function deck(): Deck {
  const base = emptyDeck('Player');
  base.slides = [
    { ...base.slides[0], id: 'a', elements: [text('eq-1', String.raw`$$\nabla \cdot \sigma = 0$$`, 'eq')], timeline: [] },
    {
      ...base.slides[0], id: 'b', morphFromPrevious: true,
      elements: [text('eq-2', String.raw`$$\nabla \cdot \sigma \step{1}{+ f} = \step{2}{\rho \ddot{u}}$$`, 'eq')],
      timeline: [
        { id: 't', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'terms', target: 'eq-2', value: 'appear' } },
        { id: 'p', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'pulse', target: 'eq-2', value: null, term: '2' } },
      ],
    },
  ];
  return parseDeck(base);
}

function mount(playing = deck()): { player: Player; host: HTMLElement; animate: ReturnType<typeof vi.fn> } {
  const animate = vi.fn(() => ({ finished: Promise.resolve(), finish() {}, cancel() {} }));
  HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
  const host = document.createElement('div');
  document.body.appendChild(host);
  return { player: new Player({ deck: playing, container: host, resolveSrc: (src) => src }), host, animate };
}

describe('the Player with equation builds', () => {
  it('reveals each term on its own step and keeps them revealed to the end', () => {
    const { player, host } = mount();
    player.goTo({ slide: 1, step: 0 }, { morph: false });
    const shown = () => [1, 2].map((n) =>
      host.querySelector<HTMLElement>(`.katex-html .step-${n}`)!.style.visibility !== 'hidden');
    expect(shown()).toEqual([false, false]);
    player.next();
    expect(shown()).toEqual([true, false]);
    player.next();
    expect(shown()).toEqual([true, true]);
    player.next(); // the pulse
    expect(player.getCursor()).toEqual({ slide: 1, step: 3 });
    expect(shown()).toEqual([true, true]);
    // Jumping straight to the end resolves the same state.
    player.goTo({ slide: 1, step: Number.MAX_SAFE_INTEGER }, { morph: false });
    expect(shown()).toEqual([true, true]);
    player.destroy();
  });

  it('never runs a Morph on a jump that says so, even onto the next slide', () => {
    const { player, host, animate } = mount();
    player.goTo({ slide: 1, step: 0 }, { morph: false });
    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelectorAll('.morph-ghost')).toHaveLength(0);
    // Advancing still morphs.
    player.goTo({ slide: 0, step: 0 });
    player.next();
    expect(animate).toHaveBeenCalled();
    player.destroy();
  });
});

describe('the Player with a jiggle and a pop', () => {
  function emphases(): Deck {
    const base = emptyDeck('Emphasis');
    base.slides[0].elements = [text('box', 'Look here')];
    base.slides[0].timeline = [
      { id: 'j', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'jiggle', target: 'box', value: null } },
      { id: 'p', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'pop', target: 'box', value: null } },
    ];
    return parseDeck(base);
  }

  /** The keyframe transforms and options of the last animation `node` was given. */
  function lastAnimation(animate: ReturnType<typeof vi.fn>, node: Element): { transforms: string[]; options: KeyframeAnimationOptions } {
    const [frames, options] = animate.mock.calls[animate.mock.contexts.lastIndexOf(node)] as unknown as [Keyframe[], KeyframeAnimationOptions];
    return { transforms: frames.map((frame) => String(frame.transform)), options };
  }

  it('wobbles side to side, then swells smoothly and eases back, ending where each began', () => {
    const { player, host, animate } = mount(emphases());
    player.goTo({ slide: 0, step: 0 });
    const box = host.querySelector('[data-element-id="box"]')!;
    animate.mockClear();

    player.next();
    const jiggle = lastAnimation(animate, box);
    const turns = jiggle.transforms.map((transform) => Number(/rotate\((-?[\d.]+)deg\)/.exec(transform)![1]));
    expect(turns[0]).toBe(0);
    expect(turns.at(-1)).toBe(0);
    // Each swing goes the other way, and is smaller than the one before.
    for (let i = 2; i < turns.length - 1; i++) {
      expect(Math.sign(turns[i])).toBe(-Math.sign(turns[i - 1]));
      expect(Math.abs(turns[i])).toBeLessThan(Math.abs(turns[i - 1]));
    }
    expect(jiggle.options).toMatchObject({ duration: 700, fill: 'none' });

    player.next();
    const pop = lastAnimation(animate, box);
    const scales = pop.transforms.map((transform) => Number(/scale\(([\d.]+)\)/.exec(transform)![1]));
    expect(scales[0]).toBe(1);
    expect(scales.at(-1)).toBe(1);
    expect(Math.max(...scales)).toBe(1.3);
    // One bump, never below its own size, at the top halfway, eased the same
    // way out of rest, into the top and back to rest.
    expect(Math.min(...scales)).toBe(1);
    expect(scales).toEqual([1, 1.3, 1]);
    const frames = animate.mock.calls[animate.mock.contexts.lastIndexOf(box)][0] as Keyframe[];
    expect(frames.map((frame) => frame.offset)).toEqual([0, 0.5, 1]);
    expect(frames[0].easing).toBe(frames[1].easing);
    expect(pop.options).toMatchObject({ duration: 700, fill: 'none' });

    // Neither left anything behind, and jumping back over them plays nothing.
    expect(box.getAttribute('style')).not.toContain('rotate');
    animate.mockClear();
    player.goTo({ slide: 0, step: 2 });
    expect(animate).not.toHaveBeenCalled();
    player.destroy();
  });

  it('animates only what the compositor runs, so an emphasis never stutters on a busy page', async () => {
    // BUG (fixed here): every emphasis keyframe carried transform-origin, and a
    // lifting pulse z-index; either keeps the whole animation on the main
    // thread, where a pulse stuttered and played differently each time.
    const base = emptyDeck('Compositor');
    base.slides[0].elements = [text('box', 'Look here')];
    const step = (id: string, type: 'pulse' | 'jiggle' | 'pop', value: string | null = null) => ({
      id, trigger: { on: 'click' as const, ref: null, delay: 0 }, action: { type, target: 'box', value },
    });
    base.slides[0].timeline = [step('a', 'pulse'), step('b', 'pulse', 'lift'), step('c', 'jiggle'), step('d', 'pop')];
    const { player, host, animate } = mount(parseDeck(base));
    player.goTo({ slide: 0, step: 0 });
    const box = host.querySelector<HTMLElement>('[data-element-id="box"]')!;
    const zBefore = box.style.zIndex;
    const composited = new Set(['transform', 'filter', 'opacity', 'offset', 'easing', 'composite']);
    for (let i = 0; i < 4; i++) {
      animate.mockClear();
      player.next();
      const frames = animate.mock.calls[animate.mock.contexts.lastIndexOf(box)][0] as Keyframe[];
      for (const frame of frames) expect(Object.keys(frame).filter((key) => !composited.has(key))).toEqual([]);
      // The lift still raises the object while it is up, held on the node instead.
      if (i === 1) expect(Number(box.style.zIndex)).toBeGreaterThan(Number(zBefore) || 0);
      await Promise.resolve();
      await Promise.resolve();
      expect(box.style.zIndex).toBe(zBefore);
    }
    player.destroy();
  });

  it('eases a pulse in and out by default, holds it at the top, and lets damping sharpen or soften it', () => {
    const base = emptyDeck('Damping');
    base.slides[0].elements = [text('box', 'Look here')];
    const step = (id: string, type: 'pulse' | 'jiggle', damping?: number) => ({
      id, trigger: { on: 'click' as const, ref: null, delay: 0 },
      action: { type, target: 'box', value: null, ...(damping !== undefined ? { damping } : {}) },
    });
    base.slides[0].timeline = [step('a', 'pulse'), step('b', 'pulse', 0), step('c', 'pulse', 1), step('d', 'jiggle', 0), step('e', 'jiggle', 1)];
    const { player, host, animate } = mount(parseDeck(base));
    player.goTo({ slide: 0, step: 0 });
    const box = host.querySelector('[data-element-id="box"]')!;
    const frames = () => animate.mock.calls[animate.mock.contexts.lastIndexOf(box)][0] as Keyframe[];
    /** The handles of a cubic-bezier easing: [x1, y1, x2, y2]. */
    const handles = (easing: unknown) => /cubic-bezier\(([^)]*)\)/.exec(String(easing))![1].split(',').map(Number);

    player.next();
    const pulse = frames();
    expect(pulse.map((frame) => frame.offset)).toEqual([0, 0.35, 0.5, 1]);
    expect(pulse.map((frame) => Number(/scale\(([\d.]+)\)/.exec(String(frame.transform))![1]))).toEqual([1, 1.6, 1.6, 1]);
    // By default it leaves rest gently and lands gently: little speed at
    // either end, rather than leaping out of the first frame.
    const [, outY1] = handles(pulse[0].easing);
    const [backX1, , , backY2] = handles(pulse[2].easing);
    expect(outY1).toBeLessThan(0.3);
    expect(backY2).toBeGreaterThan(0.75);
    expect(backX1).toBeLessThan(0.6);

    // Damping 0 is a sharp snap: it leaps out and lands hard.
    player.next();
    expect(handles(frames()[0].easing)[1]).toBe(0.9);
    expect(handles(frames()[2].easing)[3]).toBe(0.1);
    // Damping 1 is fully smooth, the same ease out of rest and back into it.
    player.next();
    expect(handles(frames()[0].easing)).toEqual([0.45, 0, 0.55, 1]);
    expect(frames()[2].easing).toBe(frames()[0].easing);

    // A jiggle's damping is how fast its swings die out.
    const turns = () => frames().map((frame) => Math.abs(Number(/rotate\((-?[\d.]+)deg\)/.exec(String(frame.transform))![1])));
    player.next();
    const loose = turns();
    player.next();
    const damped = turns();
    expect(loose[1]).toBe(5);
    expect(damped[1]).toBe(5);
    for (let i = 2; i < loose.length - 1; i++) expect(damped[i]).toBeLessThan(loose[i]);
    expect(loose.at(-2)).toBeGreaterThan(2);
    expect(damped.at(-2)).toBeLessThan(0.1);
    player.destroy();
  });
});
