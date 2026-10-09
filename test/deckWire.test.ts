import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Deck } from '../src/shared/deck.js';
import { applyOpsLenient } from '../src/shared/collabApply.js';
import type { ServerMessage } from '../src/shared/collab.js';
import { DeckWire } from '../src/server/deckWire.js';

/**
 * Whole-deck server messages are spliced from cached element and slide JSON
 * (src/server/deckWire.ts). A client must not be able to tell: what it parses
 * is what JSON.stringify(message) would have given it.
 */
function fixture(): Deck {
  return parseDeck({
    ...emptyDeck('Wire'),
    slides: [
      { id: 's1', notes: 'Quotes " and \\ and 😀 and  ', elements: [
        { id: 'e1', type: 'text', x: 0, y: 0, w: 100, h: 50, html: '<b>"elements":[]</b>' },
        { id: 'e2', type: 'html', x: 0, y: 60, w: 100, h: 50, html: '<svg></svg>' },
      ] },
      { id: 's2' },
    ],
  });
}

const parsed = (data: string | Buffer) => JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));

describe('DeckWire', () => {
  it('encodes a deck message exactly as JSON.stringify would, as UTF-8 text', () => {
    const wire = new DeckWire();
    const deck = fixture();
    const message = { kind: 'deck', seq: 3, deck, reason: 'resync' } as ServerMessage;
    expect(parsed(wire.encode(message))).toEqual(JSON.parse(JSON.stringify(message)));
    const small = { kind: 'peerLeft', clientId: 'c1' } as ServerMessage;
    expect(wire.encode(small)).toBe(JSON.stringify(small));
  });

  it('stays exact across copy-on-write edits, and shares one encoding per deck', () => {
    const wire = new DeckWire();
    let deck = fixture();
    expect(wire.deck(deck)).toBe(wire.deck(deck));
    deck = applyOpsLenient(deck, [
      { op: 'setSlideProperties', slideId: 's2', slide: { id: 's2', notes: 'Changed' } },
      { op: 'deleteElements', slideId: 's1', elementIds: ['e2'] },
    ]).deck;
    expect(parsed(wire.deck(deck))).toEqual(JSON.parse(JSON.stringify(deck)));
    const empty = parseDeck(emptyDeck('Empty'));
    expect(parsed(wire.deck(empty))).toEqual(JSON.parse(JSON.stringify(empty)));
  });
});
