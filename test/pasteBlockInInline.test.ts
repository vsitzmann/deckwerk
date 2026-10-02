// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { normalizeParagraphHtml } from '../src/shared/paragraphs.js';

describe('a block pasted into the middle of a formatted word', () => {
  it('splits the inline wrapper around it instead of nesting it (list fuzz seed 20261001)', () => {
    const pasted = '<ol><li><span style="font-weight: 700; text-decoration-line: underline;">'
      + 'f72f73b<p style="font-weight: 400;"><br></p>b</span></li></ol>';
    const out = normalizeParagraphHtml(pasted, true);
    const doc = document.createElement('div');
    doc.innerHTML = out;
    expect(doc.querySelector('span p, span div, span li'), out).toBeNull();
    // The pasted line break splits the item where it landed; the empty
    // paragraph that stood in for it goes.
    expect([...doc.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['f72f73b', 'b']);
    expect(doc.querySelector('li p'), out).toBeNull();
    // Both halves of the word keep their formatting.
    const spans = [...doc.querySelectorAll('span')].map((span) => [span.textContent, span.getAttribute('style')]);
    expect(spans).toEqual([
      ['f72f73b', 'font-weight: 700; text-decoration-line: underline;'],
      ['b', 'font-weight: 700; text-decoration-line: underline;'],
    ]);
  });

  it("keeps the wrapper's formatting on the block's text, less what the block overrides", () => {
    const out = normalizeParagraphHtml(
      '<ul><li><span style="font-weight: 700; font-style: italic;">a<p style="font-weight: 400;">mid</p>z</span></li></ul>', true);
    const doc = document.createElement('div');
    doc.innerHTML = out;
    const mid = [...doc.querySelectorAll('p')].find((p) => p.textContent === 'mid')!;
    expect(mid.getAttribute('style')).toBe('font-weight: 400;');
    expect(mid.querySelector('span')?.getAttribute('style')).toBe('font-style: italic;');
    expect(normalizeParagraphHtml(out, true)).toBe(out);
  });
});

describe('blocks that belong where they are', () => {
  it('leaves a block inside a table cell alone (paste fuzz: stray list into a cell)', () => {
    const html = '<table><tbody><tr><td><ul><li>Orphaned sub item</li></ul></td><td>Beta</td></tr></tbody></table>';
    const doc = document.createElement('div');
    doc.innerHTML = normalizeParagraphHtml(html, true);
    expect(doc.querySelector('td ul li')?.textContent).toBe('Orphaned sub item');
    expect(doc.querySelectorAll('table tr')).toHaveLength(1);
  });
});

describe('words stranded in a list outside every item', () => {
  it('go back into an item (list fuzz seed 20261004)', () => {
    const html = '<ul><li><p>beta</p><p><br></p></li><li><br></li>beta</ul>';
    const doc = document.createElement('div');
    doc.innerHTML = normalizeParagraphHtml(html, true);
    const list = doc.querySelector('ul')!;
    expect([...list.childNodes].every((node) => node instanceof Element && node.tagName === 'LI'), doc.innerHTML).toBe(true);
    expect(list.lastElementChild?.textContent).toBe('beta');
    expect(normalizeParagraphHtml(doc.innerHTML, true)).toBe(doc.innerHTML);
  });

  it('get an item of their own when no item comes before them', () => {
    const doc = document.createElement('div');
    doc.innerHTML = normalizeParagraphHtml('<ol>lead<li>one</li></ol>', true);
    expect([...doc.querySelectorAll('li')].map((item) => item.textContent)).toEqual(['lead', 'one']);
  });
});
