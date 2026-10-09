import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DeckSchema, ElementSchema, SlideSchema, type Deck, type Slide, type SlideElement } from '@shared/deck.js';
import { renameRetiredFields } from '@shared/fieldAliases.js';
import { serializeDeck } from './deckStore.js';

/**
 * `serializeDeck`, for a deck that is edited while it is being served.
 *
 * serializeDeck validates and stringifies the whole deck. For a 20 MB deck
 * (HTML figures with their data inline) that held the collab server's event
 * loop for ~35 ms on every autosave — and every other person's keystrokes
 * waited behind it. Decks are edited copy-on-write (shared/collabApply.ts):
 * a slide or element nobody touched is the very same object in the next
 * deck. So each slide and element is validated and stringified once, cached
 * by identity, and a save re-does only what changed — typing in one text box
 * re-serialises that text box.
 *
 * The output is byte-for-byte serializeDeck's (test/deckSerializer.test.ts):
 * the deck schema has no rule spanning slides or elements, so parsing piece
 * by piece is parsing the whole, and each piece is indented for its depth in
 * the file. It comes back as chunks — references to cached strings, never one
 * 20 MB string — which writeDeckChunks hands to the disk a slice at a time.
 */
export class DeckSerializer {
  /** An element's JSON, indented for its depth in deck.json. */
  private readonly elements = new WeakMap<SlideElement, string>();
  /** A slide's JSON around its elements: [before, after]. */
  private readonly slides = new WeakMap<Slide, [string, string]>();

  serialize(deck: Deck): string[] {
    // The pre-per-slide-Morph migration rewrites slides from a deck-level
    // field; such a deck is loaded once and never cached here.
    if (Object.prototype.hasOwnProperty.call(deck, 'morphDuration')) return [serializeDeck(deck)];
    const { slides, ...rest } = deck;
    const shell = JSON.stringify(DeckSchema.parse({ ...renameRetiredFields(rest), slides: [] }), null, 2);
    if (slides.length === 0) return [shell, '\n'];
    const [head, tail] = splitAt(shell, '\n  "slides": []', '\n  "slides": [\n', '\n  ]');
    const chunks = [head];
    slides.forEach((slide, index) => {
      if (index > 0) chunks.push(',\n');
      const [before, after] = this.slide(slide);
      chunks.push(before);
      slide.elements.forEach((element, elementIndex) => {
        if (elementIndex > 0) chunks.push(',\n');
        chunks.push(this.element(element));
      });
      chunks.push(after);
    });
    chunks.push(tail, '\n');
    return chunks;
  }

  private slide(slide: Slide): [string, string] {
    const cached = this.slides.get(slide);
    if (cached) return cached;
    const { elements, ...rest } = slide;
    const shell = indent(JSON.stringify(SlideSchema.parse({ ...renameRetiredFields(rest), elements: [] }), null, 2), 4);
    const parts: [string, string] = elements.length === 0
      ? [shell, '']
      : splitAt(shell, '\n      "elements": []', '\n      "elements": [\n', '\n      ]');
    this.slides.set(slide, parts);
    return parts;
  }

  private element(element: SlideElement): string {
    let json = this.elements.get(element);
    if (json === undefined) {
      json = indent(JSON.stringify(ElementSchema.parse(renameRetiredFields(element)), null, 2), 8);
      this.elements.set(element, json);
    }
    return json;
  }
}

/**
 * Split pretty JSON at the one line holding an empty array, opening the array
 * on the left and closing it on the right. A real newline only ever appears
 * between JSON tokens (string contents escape theirs), and only one key sits
 * at this indentation, so the marker is unique.
 */
function splitAt(json: string, marker: string, open: string, close: string): [string, string] {
  const at = json.indexOf(marker);
  if (at < 0) throw new Error(`deck serializer: no ${marker.trim()} in the parsed shell`);
  return [json.slice(0, at) + open, close + json.slice(at + marker.length)];
}

function indent(json: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return pad + json.replace(/\n/g, `\n${pad}`);
}

/** How much is encoded per write, so no single write holds the event loop. */
const WRITE_SLICE = 256 * 1024;

/**
 * Write deck.json from chunks, atomically (beside it, then renamed over it,
 * as saveDeck does), encoding at most WRITE_SLICE characters per write so a
 * large deck is written over many turns of the event loop rather than in one.
 */
export async function writeDeckChunks(dir: string, file: string, chunks: readonly string[]): Promise<void> {
  const target = join(dir, file);
  const temporary = join(dir, `.${file}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'w');
  try {
    let batch = '';
    for (const chunk of chunks) {
      for (const slice of slices(chunk, WRITE_SLICE)) {
        batch += slice;
        if (batch.length >= WRITE_SLICE) {
          await handle.write(batch);
          batch = '';
        }
      }
    }
    if (batch) await handle.write(batch);
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * `text` in pieces of about `size` UTF-16 units, never cutting between the two
 * halves of a surrogate pair: each piece is encoded on its own, and a lone half
 * would become U+FFFD in the file.
 */
export function* slices(text: string, size: number): Generator<string> {
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    const last = text.charCodeAt(end - 1);
    // Back up off a high surrogate, or, if that would leave nothing, take
    // the whole pair: either way the loop always advances.
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end += end - 1 > start ? -1 : 1;
    yield text.slice(start, end);
    start = end;
  }
}
