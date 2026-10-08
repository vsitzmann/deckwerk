import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyDeck, parseDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { applyOpsLenient } from '../src/shared/collabApply.js';
import type { AgentOperation } from '../src/shared/agent.js';
import { loadDeck, serializeDeck } from '../src/main/deckStore.js';
import { DeckSerializer, slices, writeDeckChunks } from '../src/main/deckSerializer.js';

/**
 * The collab server saves through DeckSerializer, which re-serialises only
 * the slides and elements an edit replaced. Its output must be serializeDeck's,
 * byte for byte, or every save would rewrite deck.json differently from the
 * desktop app and the CLI (and the server's own echo checks would misfire).
 */

const text = (id: string, html: string): SlideElement => parseDeck({
  ...emptyDeck('x'), slides: [{ id: 's', elements: [{ id, type: 'text', x: 0, y: 0, w: 100, h: 50, html }] }],
}).slides[0].elements[0];

function fixture(): Deck {
  return parseDeck({
    ...emptyDeck('Serializer'),
    slides: [
      { id: 's1', name: 'One', notes: 'Line one\nline two "quoted" 😀', elements: [
        { id: 'e1', type: 'text', x: 0, y: 0, w: 100, h: 50, html: 'Title <b>bold</b>', class: ['role-title'] },
        { id: 'e2', type: 'html', x: 0, y: 60, w: 400, h: 300, html: `<svg>${'<path d="M0 0L1 1"/>'.repeat(2000)}</svg>` },
      ] },
      { id: 's2', name: 'Empty' },
      { id: 's3', skipped: true, elements: [{ id: 'e3', type: 'shape', shape: 'rect', x: 1, y: 2, w: 3, h: 4 }] },
    ],
  });
}

describe('DeckSerializer', () => {
  it('writes exactly what serializeDeck writes, for every deck in the repository', async () => {
    const decks = ['decks/deckwerk_intro', 'decks/demo-deck'];
    for (const dir of decks) {
      const deck = await loadDeck(join(process.cwd(), dir));
      expect(new DeckSerializer().serialize(deck).join(''), dir).toBe(serializeDeck(deck));
    }
    for (const deck of [fixture(), parseDeck(emptyDeck('Nothing'))]) {
      expect(new DeckSerializer().serialize(deck).join('')).toBe(serializeDeck(deck));
    }
  });

  it('stays exact across edits, re-serialising only what they replaced', () => {
    const serializer = new DeckSerializer();
    let deck = fixture();
    const steps: AgentOperation[][] = [
      [{ op: 'replaceElement', slideId: 's1', elementId: 'e1', element: text('e1', 'Title typed') }],
      [{ op: 'setSlideProperties', slideId: 's2', slide: { id: 's2', notes: 'New notes' } }],
      [{ op: 'insertSlides', afterSlideId: 's1', slides: [{ ...fixture().slides[1], id: 's4', name: 'Inserted' }] }],
      [{ op: 'moveSlide', slideId: 's3', afterSlideId: null }],
      [{ op: 'insertElements', slideId: 's2', elements: [text('e5', 'Added')] }],
      [{ op: 'deleteElements', slideId: 's1', elementIds: ['e2'] }],
      [{ op: 'updateDeck', title: 'Renamed' }],
      [{ op: 'deleteSlide', slideId: 's1' }],
    ];
    expect(serializer.serialize(deck).join('')).toBe(serializeDeck(deck));
    for (const ops of steps) {
      const before = deck;
      deck = applyOpsLenient(deck, ops).deck;
      expect(deck).not.toBe(before);
      expect(serializer.serialize(deck).join(''), JSON.stringify(ops)).toBe(serializeDeck(deck));
    }
  });

  it('writes the chunks to disk as the same bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deck-serializer-'));
    const deck = fixture();
    await writeDeckChunks(dir, 'deck.json', new DeckSerializer().serialize(deck));
    expect(await readFile(join(dir, 'deck.json'), 'utf8')).toBe(serializeDeck(deck));
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('never cuts a slice between the halves of a surrogate pair', () => {
    const textWithEmoji = 'ab😀cd😀'.repeat(1000);
    for (const size of [1, 2, 3, 5, 7, 256]) {
      const pieces = [...slices(textWithEmoji, size)];
      expect(pieces.join('')).toBe(textWithEmoji);
      expect(Buffer.concat(pieces.map((piece) => Buffer.from(piece, 'utf8'))).toString('utf8')).toBe(textWithEmoji);
    }
  });
});
