import { describe, expect, it } from 'vitest';
import type { SlideElement } from '../src/shared/deck.js';
import { arrangeElements, arrangeElementsAt } from '../src/renderer/editor/arrange.js';

/** Stacking order: [ ] step the selection, Shift+[ ] send it to the back or front. */

const el = (id: string, z: number) => ({ id, z } as SlideElement);
/** Ids in paint order, bottom first, as the renderer draws them. */
const painted = (elements: SlideElement[]) => elements
  .map((element, index) => ({ element, index }))
  .sort((a, b) => a.element.z - b.element.z || a.index - b.index)
  .map(({ element }) => element.id);

describe('arranging the selection', () => {
  const slide = () => [el('a', 1), el('b', 2), el('c', 3), el('d', 4)];

  it('steps one object forward and backward past its neighbour', () => {
    const elements = slide();
    expect(arrangeElements(elements, new Set(['b']), 'forward')).toBe(true);
    expect(painted(elements)).toEqual(['a', 'c', 'b', 'd']);
    expect(arrangeElements(elements, new Set(['b']), 'backward')).toBe(true);
    expect(painted(elements)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sends to the front and back as a block, keeping the selection in order', () => {
    const elements = slide();
    arrangeElements(elements, new Set(['a', 'c']), 'front');
    expect(painted(elements)).toEqual(['b', 'd', 'a', 'c']);
    arrangeElements(elements, new Set(['d', 'c']), 'back');
    expect(painted(elements)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('moves a selected run one step together', () => {
    const elements = slide();
    arrangeElements(elements, new Set(['a', 'b']), 'forward');
    expect(painted(elements)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('does nothing at the end it is already at', () => {
    const elements = slide();
    expect(arrangeElements(elements, new Set(['d']), 'forward')).toBe(false);
    expect(arrangeElements(elements, new Set(['c', 'd']), 'front')).toBe(false);
    expect(arrangeElements(elements, new Set(['a']), 'back')).toBe(false);
    expect(elements.map((e) => e.z)).toEqual([1, 2, 3, 4]);
  });

  it('steps past a tie instead of joining it', () => {
    // Adding one to z used to land on a neighbour's value and change nothing visible.
    const elements = [el('a', 5), el('b', 5), el('c', 9)];
    arrangeElements(elements, new Set(['a']), 'forward');
    expect(painted(elements)).toEqual(['b', 'a', 'c']);
    expect(new Set(elements.map((e) => e.z)).size).toBe(3);
  });

  it('places the selection with a given number of objects underneath', () => {
    // An object-list drop: rows between the drop and the bottom stay underneath.
    const elements = slide();
    expect(arrangeElementsAt(elements, new Set(['d']), 1)).toBe(true);
    expect(painted(elements)).toEqual(['a', 'd', 'b', 'c']);
    arrangeElementsAt(elements, new Set(['a', 'c']), 2);
    expect(painted(elements)).toEqual(['d', 'b', 'a', 'c']);
    expect(elements.map((e) => e.z).sort()).toEqual([1, 2, 3, 4]);
  });

  it('clamps the place and reports a drop that moves nothing', () => {
    const elements = slide();
    expect(arrangeElementsAt(elements, new Set(['b']), 1)).toBe(false);
    expect(arrangeElementsAt(elements, new Set(['b']), 99)).toBe(true);
    expect(painted(elements)).toEqual(['a', 'c', 'd', 'b']);
    expect(arrangeElementsAt(elements, new Set(['a']), -3)).toBe(false);
    expect(arrangeElementsAt(elements, new Set(), 0)).toBe(false);
  });
});
