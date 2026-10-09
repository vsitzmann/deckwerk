// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';

/** The Player stepping through equation builds, and jumping without a Morph. */

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

function mount(): { player: Player; host: HTMLElement; animate: ReturnType<typeof vi.fn> } {
  const animate = vi.fn(() => ({ finished: Promise.resolve(), finish() {}, cancel() {} }));
  HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
  const host = document.createElement('div');
  document.body.appendChild(host);
  return { player: new Player({ deck: deck(), container: host, resolveSrc: (src) => src }), host, animate };
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
