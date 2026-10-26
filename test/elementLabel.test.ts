import { describe, expect, it } from 'vitest';
import { colorName, describeElement, elementSwatches } from '../src/renderer/editor/elementLabel.js';
import type { SlideElement } from '../src/shared/deck.js';

function shape(over: Partial<Extract<SlideElement, { type: 'shape' }>>): SlideElement {
  return {
    id: 's', type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, rot: 0, z: 1,
    opacity: 1, class: [], style: {}, fill: null, stroke: null, strokeWidth: 2,
    radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    ...over,
  } as SlideElement;
}

describe('element labels', () => {
  it('names a shape by geometry and dominant colour', () => {
    expect(describeElement(shape({ fill: '#000000' }))).toBe('rectangle, black');
    expect(describeElement(shape({ shape: 'arrow', stroke: '#1a1a1a' }))).toBe('arrow, black');
    // A fill wins over the outline when both are set.
    expect(describeElement(shape({ fill: '#2255dd', stroke: '#ffffff' }))).toBe('rectangle, blue');
    // No colour at all still reads better than the raw type.
    expect(describeElement(shape({}))).toBe('rectangle');
  });

  it('names lines as one family: an arrowhead makes an arrow, an open path is a line', () => {
    expect(describeElement(shape({ shape: 'line', arrowEnd: true, stroke: '#000' }))).toBe('arrow, black');
    expect(describeElement(shape({ shape: 'arrow', endCap: 'dot', arrowStart: true }))).toBe('arrow');
    const pen = { shape: 'path' as const, path: 'M 0 0 L 10 10', pathSize: { w: 10, h: 10 }, stroke: '#000' };
    expect(describeElement(shape(pen))).toBe('line, black');
    expect(describeElement(shape({ ...pen, arrowEnd: true }))).toBe('arrow, black');
    expect(describeElement(shape({ ...pen, path: 'M 0 0 L 10 10 L 0 10 Z', fill: '#f00' }))).toBe('shape, red');
  });

  it('parses hex, shorthand, rgb and keyword colours', () => {
    expect(colorName('#f00')).toBe('red');
    expect(colorName('rgb(20, 160, 60)')).toBe('green');
    expect(colorName('rgba(255, 255, 255, 0.5)')).toBe('white');
    expect(colorName('teal')).toBe('teal');
    expect(colorName('transparent')).toBeNull();
    expect(colorName('var(--accent)')).toBeNull();
  });

  it('offers fill and stroke swatches, skipping unset ones', () => {
    expect(elementSwatches(shape({ fill: '#fff', stroke: '#000' }))).toEqual([
      { color: '#fff', kind: 'fill' },
      { color: '#000', kind: 'stroke' },
    ]);
    expect(elementSwatches(shape({ stroke: 'none' }))).toEqual([]);
  });
});
