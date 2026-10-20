// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizePastedTextHtml } from '../src/shared/htmlSafety.js';

/** The `text-decoration-line` each run of pasted markup ends up declaring. */
function lines(html: string): Array<[string | null, string]> {
  const box = document.createElement('div');
  box.innerHTML = sanitizePastedTextHtml(html);
  return [...box.querySelectorAll<HTMLElement>('span')]
    .filter((span) => span.style.textDecorationLine)
    .map((span) => [span.textContent, span.style.textDecorationLine]);
}

describe('pasted underline and strikethrough', () => {
  it('turns every strikethrough tag into the span the editor writes', () => {
    for (const tag of ['s', 'strike', 'del']) {
      const box = document.createElement('div');
      box.innerHTML = sanitizePastedTextHtml(`<p>keep <${tag}>gone</${tag}></p>`);
      expect(box.querySelector(tag), tag).toBeNull();
      expect(box.innerHTML, tag)
        .toBe('<p>keep <span style="text-decoration-line: line-through;">gone</span></p>');
    }
  });

  it('keeps both lines on a run nested in two tags, which the editor would merge to one', () => {
    expect(lines('<u>under <s>both</s></u>')).toEqual([
      ['under both', 'underline'],
      ['both', 'line-through underline'],
    ]);
    expect(lines('<span style="text-decoration: line-through">struck <u>both</u></span>')).toEqual([
      ['both', 'underline line-through'],
    ]);
  });
});
