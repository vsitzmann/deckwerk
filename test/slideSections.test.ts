import { describe, expect, it } from 'vitest';
import { parseDeck, type Slide } from '../src/shared/deck.js';
import { slideSections, changeSlideIndent, moveSlideSection, sectionSelection } from '../src/shared/slideSections.js';
import { diffDecks } from '../src/shared/deckDiff.js';
import { applyOpsLenient } from '../src/shared/collabApply.js';

const slides = (...levels: number[]): Slide[] => parseDeck({ version: 1,
  slides: levels.map((indentLevel, i) => ({ id: `s${i}`, indentLevel })),
}).slides;
const depths = (s: Slide[]) => slideSections(s).map((entry) => entry.depth);

describe('slide section structure', () => {
  it('finds one-level boundaries and repairs an orphaned first slide', () => {
    expect(slideSections(slides(0, 1, 1, 0))).toEqual([
      { depth: 0, parent: null, end: 3 }, { depth: 1, parent: 0, end: 2 },
      { depth: 1, parent: 0, end: 3 }, { depth: 0, parent: null, end: 4 },
    ]);
    expect(depths(slides(1, 1, 0, 1))).toEqual([0, 1, 0, 1]);
  });

  it('indents contiguous siblings together and outdents them atomically', () => {
    const s = slides(0, 0, 0, 0);
    expect(changeSlideIndent(s, new Set(['s1', 's2']), 1)).toBe(true);
    expect(depths(s)).toEqual([0, 1, 1, 0]);
    expect(changeSlideIndent(s, new Set(['s1', 's2']), -1)).toBe(true);
    expect(depths(s)).toEqual([0, 0, 0, 0]);
  });

  it('refuses a second level and refuses nesting an existing section, without partial changes', () => {
    const s = slides(0, 0, 1, 0);
    expect([...sectionSelection(s, new Set(['s1']))]).toEqual(['s1', 's2']);
    const before = structuredClone(s);
    expect(changeSlideIndent(s, new Set(['s1']), 1)).toBe(false);
    expect(changeSlideIndent(s, new Set(['s2']), 1)).toBe(false);
    expect(changeSlideIndent(s, new Set(['s0', 's1']), -1)).toBe(false);
    expect(s).toEqual(before);
    expect(changeSlideIndent(s, new Set(['s0']), 1)).toBe(false);
  });

  it('moves a collapsed section with all descendants and drops after the target subtree', () => {
    const s = slides(0, 1, 1, 0, 1, 0);
    expect(moveSlideSection(s, 0, 3, true)).toBe(2);
    expect(s.map((slide) => slide.id)).toEqual(['s3', 's4', 's0', 's1', 's2', 's5']);
    expect(depths(s)).toEqual([0, 1, 0, 1, 1, 0]);
    const before = structuredClone(s);
    expect(moveSlideSection(s, 2, 4, true)).toBe(2);
    expect(s).toEqual(before);
  });

  it('saves and collaborates on section nesting through semantic slide-property operations', () => {
    const before = parseDeck({ version: 1, slides: slides(0, 0, 0) });
    const after = structuredClone(before);
    changeSlideIndent(after.slides, new Set(['s1', 's2']), 1);
    const ops = diffDecks(before, after);
    expect(ops.map((op) => op.op)).toEqual(['setSlideProperties', 'setSlideProperties']);
    expect(applyOpsLenient(before, ops).deck).toEqual(parseDeck(after));
    expect(applyOpsLenient(after, diffDecks(after, before)).deck).toEqual(before);
    expect(() => parseDeck({ ...before, slides: [{ ...before.slides[0], indentLevel: 2 }] })).toThrow();
  });
});
