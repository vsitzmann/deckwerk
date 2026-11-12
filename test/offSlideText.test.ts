import { describe, expect, it } from 'vitest';
import { composite, contrastRatio, legibleOn } from '../src/renderer/editor/offSlideText.js';

/** The pasteboards: zinc-950 (dark UI) and zinc-200 (light UI), in sRGB. */
const DARK_GROUND: [number, number, number, number] = [9, 9, 11, 1];
const LIGHT_GROUND: [number, number, number, number] = [228, 228, 231, 1];

describe('which off-slide text needs another colour', () => {
  it('uses the WCAG contrast ratio', () => {
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 5);
    expect(contrastRatio([128, 128, 128, 1], [128, 128, 128, 1])).toBe(1);
  });

  it('recolours dark text on the dark pasteboard and light text on the light one', () => {
    expect(legibleOn([17, 17, 17, 1], DARK_GROUND)).toBe(false);
    expect(legibleOn([0, 51, 153, 1], DARK_GROUND)).toBe(false);
    expect(legibleOn([250, 250, 250, 1], DARK_GROUND)).toBe(true);

    expect(legibleOn([250, 250, 250, 1], LIGHT_GROUND)).toBe(false);
    expect(legibleOn([17, 17, 17, 1], LIGHT_GROUND)).toBe(true);
  });

  it('leaves colours that read on either ground alone', () => {
    expect(legibleOn([224, 0, 0, 1], DARK_GROUND)).toBe(true);
    expect(legibleOn([224, 0, 0, 1], LIGHT_GROUND)).toBe(true);
  });

  it('judges translucent text by what shows through it', () => {
    // Half-transparent white over near-black is mid-grey: still readable.
    expect(composite([255, 255, 255, 0.5], DARK_GROUND)[0]).toBeCloseTo(132, 0);
    expect(legibleOn([255, 255, 255, 0.5], DARK_GROUND)).toBe(true);
    // A faint wash of white is not.
    expect(legibleOn([255, 255, 255, 0.1], DARK_GROUND)).toBe(false);
  });

  it('leaves transparent fills (gradient text) to their gradient', () => {
    expect(legibleOn([0, 0, 0, 0], DARK_GROUND)).toBe(true);
  });
});
