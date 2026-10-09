import { describe, expect, it } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { slideColors } from '../src/shared/slideColors.js';

/**
 * The colour picker's "On this slide" row: the colours a slide already uses,
 * most used first, so matching one is a click rather than a copied hex code.
 */

function slideWith(...elements: SlideElement[]) {
  const deck = emptyDeck('Colors');
  deck.slides[0].elements.push(...elements);
  return deck.slides[0];
}

const base = { x: 0, y: 0, w: 100, h: 50, rot: 0, z: 1, opacity: 1, class: [] };

describe('colours already on a slide', () => {
  it('collects text, inline, fill, stroke and gradient colours, most used first', () => {
    const slide = slideWith(
      { ...base, id: 't1', type: 'text', style: { color: '#EC6B14' }, align: 'left', valign: 'top',
        html: 'Real <span style="color: rgb(63, 85, 181)">synthetic</span>' } as SlideElement,
      { ...base, id: 't2', type: 'text', style: { color: '#ec6b14' }, align: 'left', valign: 'top', html: 'x' } as SlideElement,
      { ...base, id: 's1', type: 'shape', style: {}, shape: 'rect', fill: '#e8f5e9', stroke: '#5aa469', strokeWidth: 3,
        radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false, fillGradient: { kind: 'linear', to: '#7b90e1', angle: 270 } } as SlideElement,
    );
    const colors = slideColors(slide);
    expect(colors[0]).toBe('#ec6b14');
    expect(colors).toEqual(expect.arrayContaining(['#3f55b5', '#e8f5e9', '#5aa469', '#7b90e1']));
  });

  it('leaves out white, black, transparent and anything in asset paths', () => {
    const slide = slideWith(
      { ...base, id: 't', type: 'text', style: { color: '#000000', 'background-color': 'rgba(0,0,0,0)' },
        align: 'left', valign: 'top', html: '<span style="color:#fff">w</span>' } as SlideElement,
      { ...base, id: 'i', type: 'image', style: {}, src: 'assets/fig.abcdef12.png', fit: 'cover', alt: '', sourceBox: null } as SlideElement,
    );
    expect(slideColors(slide)).toEqual([]);
  });

  it('keeps a translucent colour with its alpha', () => {
    const slide = slideWith(
      { ...base, id: 's', type: 'shape', style: {}, shape: 'rect', fill: 'rgba(123, 144, 225, 0.25)', stroke: null,
        strokeWidth: 0, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false } as SlideElement,
    );
    expect(slideColors(slide)).toEqual(['#7b90e140']);
  });

  it('has nothing to offer before a slide exists', () => {
    expect(slideColors(undefined)).toEqual([]);
  });
});
