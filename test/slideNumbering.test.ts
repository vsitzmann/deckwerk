import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { insertionAnchor } from '../src/shared/htmlSlides.js';
import { slideProgress, slideProgressLabel } from '../src/shared/slideNumbering.js';

describe('visible slide progress', () => {
  it('numbers only visible slides, including around consecutive hidden slides', () => {
    const slides = [{ skipped: true }, {}, { skipped: true }, { skipped: true }, {}, { skipped: true }];
    expect(slides.map((_, index) => slideProgress(slides, index).number)).toEqual([null, 1, null, null, 2, null]);
    expect(slideProgressLabel(slides, 4)).toBe('2/2');
    expect(slideProgressLabel(slides, 2)).toBe('—/2');
  });

  it('inserts after the visible slide number while keeping hidden anchors accessible by id', () => {
    const deck = emptyDeck();
    const visibleId = deck.slides[0].id;
    deck.slides.unshift({ ...structuredClone(deck.slides[0]), id: 'hidden', skipped: true });
    expect(insertionAnchor(deck, '1')).toBe(visibleId);
    expect(insertionAnchor(deck, 'hidden')).toBe('hidden');
    expect(insertionAnchor(deck, '0')).toBeNull();
    expect(insertionAnchor(deck, '2')).toBeUndefined();
  });

  it('handles empty and entirely hidden decks', () => {
    expect(slideProgressLabel([], 0)).toBe('—/0');
    expect(slideProgressLabel([{ skipped: true }], 0)).toBe('—/0');
  });
});
