import { describe, expect, it } from 'vitest';
import { shapeSvg } from '../src/shared/shapeSvg.js';
import type { SlideElement } from '../src/shared/deck.js';

const rect = (over: Partial<SlideElement>): Extract<SlideElement, { type: 'shape' }> => ({
  id: 'r', type: 'shape', shape: 'rect', x: 0, y: 0, w: 860, h: 2, rot: 0, z: 1, opacity: 1, class: [], style: {},
  fill: '#000000', stroke: null, strokeWidth: 2, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
  ...over,
} as Extract<SlideElement, { type: 'shape' }>);

describe('the stroke inset of a shape', () => {
  it('leaves a thin filled bar with no stroke at its full height', () => {
    expect(shapeSvg(rect({}))).toContain('height="2"');
  });

  it('still insets a stroked shape so its stroke is not clipped', () => {
    expect(shapeSvg(rect({ stroke: '#000000', h: 40 }))).toContain('height="38"');
  });
});
