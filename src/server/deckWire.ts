import { randomUUID } from 'node:crypto';
import type { Deck, Slide, SlideElement } from '../shared/deck.js';
import type { ServerMessage } from '../shared/collab.js';

/**
 * Server messages as bytes, with a whole deck spliced in from a cache.
 *
 * A welcome or resync carries the deck, and for a 20 MB deck stringifying it
 * for each person who opened it held the event loop ~60 ms a time — while
 * everyone already in the room was typing. Like DeckSerializer (which writes
 * deck.json), this leans on decks being edited copy-on-write: each element and
 * slide is stringified and encoded once and reused by identity, so a joiner
 * costs one memcpy of the deck, and joiners at the same seq share even that.
 *
 * The result is JSON.parse-equivalent to JSON.stringify(message)
 * (test/deckWire.test.ts), as bytes for a *text* frame: send it with
 * `{ binary: false }`.
 */
export class DeckWire {
  /** Stands in for a value while its surroundings are stringified; unguessable. */
  private readonly token = `\u0001${randomUUID()}\u0001`;
  private readonly quotedToken = JSON.stringify(this.token);
  private readonly elements = new WeakMap<SlideElement, Buffer>();
  private readonly slides = new WeakMap<Slide, [Buffer, Buffer]>();
  private readonly decks = new WeakMap<Deck, Buffer>();

  /** `message` serialised, as a string when it holds no deck. */
  encode(message: ServerMessage): string | Buffer {
    const deck = (message as { deck?: Deck }).deck;
    if (!deck || !Array.isArray(deck.slides)) return JSON.stringify(message);
    const [before, after] = this.split(JSON.stringify({ ...message, deck: this.token }));
    return Buffer.concat([Buffer.from(before, 'utf8'), this.deck(deck), Buffer.from(after, 'utf8')]);
  }

  /** The deck's JSON, as bytes. */
  deck(deck: Deck): Buffer {
    const cached = this.decks.get(deck);
    if (cached) return cached;
    const [head, tail] = this.split(JSON.stringify({ ...deck, slides: this.token }));
    const parts: Buffer[] = [Buffer.from(`${head}[`, 'utf8')];
    deck.slides.forEach((slide, index) => {
      if (index > 0) parts.push(COMMA);
      const [before, after] = this.slide(slide);
      parts.push(before);
      slide.elements.forEach((element, elementIndex) => {
        if (elementIndex > 0) parts.push(COMMA);
        parts.push(this.element(element));
      });
      parts.push(after);
    });
    parts.push(Buffer.from(`]${tail}`, 'utf8'));
    const bytes = Buffer.concat(parts);
    this.decks.set(deck, bytes);
    return bytes;
  }

  private slide(slide: Slide): [Buffer, Buffer] {
    let parts = this.slides.get(slide);
    if (!parts) {
      const [before, after] = this.split(JSON.stringify({ ...slide, elements: this.token }));
      parts = [Buffer.from(`${before}[`, 'utf8'), Buffer.from(`]${after}`, 'utf8')];
      this.slides.set(slide, parts);
    }
    return parts;
  }

  private element(element: SlideElement): Buffer {
    let bytes = this.elements.get(element);
    if (!bytes) {
      bytes = Buffer.from(JSON.stringify(element), 'utf8');
      this.elements.set(element, bytes);
    }
    return bytes;
  }

  private split(json: string): [string, string] {
    const at = json.indexOf(this.quotedToken);
    return [json.slice(0, at), json.slice(at + this.quotedToken.length)];
  }
}

const COMMA = Buffer.from(',', 'utf8');
