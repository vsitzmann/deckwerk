// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizePastedTextHtml } from '../src/shared/htmlSafety.js';

describe('pasted text never brings a background slab with it', () => {
  it('drops the tint or box fill Chromium copies onto a run, keeping the type', () => {
    // What copying out of a box being edited used to put on the clipboard.
    expect(sanitizePastedTextHtml(
      '<span style="color: rgb(255, 255, 255); font-size: 60px; font-weight: 700; '
      + 'background-color: rgba(122, 162, 247, 0.12);">Something like this!</span>',
    )).toBe('<span style="color: rgb(255, 255, 255); font-size: 60px; font-weight: 700;">Something like this!</span>');
    expect(sanitizePastedTextHtml('<span style="background: #000000;">plain</span>')).toBe('plain');
  });

  it('keeps gradient text, which is paint of the letters', () => {
    const gradient = '<span style="background-image: linear-gradient(100deg, red 0%, blue 92%); '
      + '-webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;">4D</span>';
    expect(sanitizePastedTextHtml(gradient)).toContain('linear-gradient');
  });
});
