import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { renumber } from '../scripts/renumber-pages.mts';

const page = (id: string, n: number) => ({ id, type: 'text', x: 1356, y: 1001, w: 432, h: 57.5, html: `<ul><li>${n}</li></ul>` });

describe('renumber-pages', () => {
  it('counts shown slides and leaves skipped ones alone', () => {
    const deck = parseDeck({
      ...emptyDeck('Talk'),
      slides: [
        { id: 'a', elements: [page('pa', 1)] },
        { id: 'b', skipped: true, elements: [page('pb', 2)] },
        { id: 'c', elements: [page('pc', 3), { id: 'cap', type: 'text', x: 1356, y: 1001, w: 10, h: 10, html: 'Figure 3' }] },
        { id: 'd', elements: [page('pd', 7)] },
      ],
    });
    const ops = renumber(deck);
    expect(ops.map((o) => [o.slideId, (o.element as { html: string }).html])).toEqual([
      ['c', '<ul><li>2</li></ul>'],
      ['d', '<ul><li>3</li></ul>'],
    ]);
  });
});
