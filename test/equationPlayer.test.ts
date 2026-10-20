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

  it('wobbles side to side, then swells and snaps back past its size, ending where each began', () => {
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
    // The snap back overshoots: for a moment it is smaller than it was.
    expect(Math.min(...scales)).toBeLessThan(1);
    expect(scales.indexOf(1.3)).toBeLessThan(scales.indexOf(Math.min(...scales)));
    expect(pop.options).toMatchObject({ duration: 450, fill: 'none' });

    // Neither left anything behind, and jumping back over them plays nothing.
    expect(box.getAttribute('style')).not.toContain('rotate');
    animate.mockClear();
    player.goTo({ slide: 0, step: 2 });
    expect(animate).not.toHaveBeenCalled();
    player.destroy();
  });
});
