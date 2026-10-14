import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeAuthoredHtml, stripFittedFontSize, stripLayoutDeclarations } from '../src/shared/htmlSafety.js';
import { ElementSchema } from '../src/shared/deck.js';

describe('HTML import safety and fallback compatibility', () => {
  const previous = globalThis.DOMParser;
  beforeEach(() => {
    globalThis.DOMParser = new JSDOM('').window.DOMParser;
  });
  afterEach(() => {
    globalThis.DOMParser = previous;
  });

  it('removes scripts, event handlers, JavaScript URLs, and external media', () => {
    const result = sanitizeAuthoredHtml(`<!doctype html><html><head>
      <style>@import url("https://bad.test/a.css"); .x{background:url(https://bad.test/a.png)}</style>
      </head><body><section class="slide" onclick="steal()">
      <script>steal()</script><img src="https://bad.test/photo.png" onerror="steal()">
      <a href="javascript:steal()">bad</a></section></body></html>`);

    expect(result.html).not.toMatch(/<script|onclick|onerror|javascript:/i);
    expect(result.html).not.toContain('https://bad.test/photo.png');
    expect(result.report.removedScripts).toBe(1);
    expect(result.report.removedEventHandlers).toBe(2);
    expect(result.report.blockedUrls.length).toBeGreaterThanOrEqual(3);
  });

  it('reports data URLs for extraction into deck assets', () => {
    const result = sanitizeAuthoredHtml('<section class="slide"><img src="data:image/png;base64,AAAA"></section>');
    expect(result.report.dataUrls).toEqual([{ mime: 'image/png', value: 'data:image/png;base64,AAAA' }]);
  });

  it('strips block layout a deletion copied onto an inline run, keeping the caret\'s text node', () => {
    // Chromium joins two list items by wrapping the moved text in a span that
    // wears the removed item's computed style (seed 9012026, step 179 of the
    // list fuzz). Character formatting stays; the box's layout goes; a span
    // with nothing left to say is unwrapped around its own text node.
    const { document } = new JSDOM('').window;
    const box = document.createElement('div');
    box.innerHTML = '<ol><li><span style="text-indent: -1.4em; line-height: 1.2;">71w174</span>'
      + '<span style="font-weight: 700; margin-left: 4px;">bold</span><br></li></ol>';
    const plainText = box.querySelector('span')!.firstChild;

    expect(stripLayoutDeclarations(box)).toBe(true);
    expect(box.innerHTML).toBe('<ol><li>71w174<span style="font-weight: 700;">bold</span><br></li></ol>');
    expect(box.querySelector('li')!.firstChild).toBe(plainText);
    expect(stripLayoutDeclarations(box)).toBe(false);
  });

  it('strips the fitted size a join baked into an auto-fit box, and only that size', () => {
    // The list fuzz's short auto-fit box (seed 9012026, step 4): Backspace at
    // the start of a paragraph joined it to the line above, and Chromium
    // wrapped the moved text in the box's fitted size, 13.8px. The box then
    // refitted to 16.5px around text that no longer followed it.
    const { document } = new JSDOM('').window;
    const box = document.createElement('div');
    box.innerHTML = '<p>gamma<span style="font-size: 13.8px;">delta</span>'
      + '<span style="font-size: 13.8px; font-weight: 700;">f1a</span>'
      + '<span style="font-size: 20px;">big</span><sup style="font-size: 0.7em;">2</sup></p>';
    const moved = box.querySelector('span')!.firstChild;

    expect(stripFittedFontSize(box, '13.8px')).toBe(true);
    // An authored size, absolute or relative, is not the fit's and stays.
    expect(box.innerHTML).toBe('<p>gammadelta<span style="font-weight: 700;">f1a</span>'
      + '<span style="font-size: 20px;">big</span><sup style="font-size: 0.7em;">2</sup></p>');
    expect(box.querySelector('p')!.childNodes[1]).toBe(moved);
    expect(stripFittedFontSize(box, '13.8px')).toBe(false);
    expect(stripFittedFontSize(box, '')).toBe(false);
  });

  it('keeps old HTML elements unchanged and accepts isolated fallback fields', () => {
    const base = { id: 'html-1', type: 'html', x: 0, y: 0, w: 100, h: 100, rot: 0, z: 0, opacity: 1, class: [], style: {}, html: '<b>Hi</b>' };
    expect(ElementSchema.parse(base)).not.toHaveProperty('sandboxed');
    expect(ElementSchema.parse({ ...base, sandboxed: true, css: '.x{}', fallbackReason: 'table' }))
      .toMatchObject({ sandboxed: true, css: '.x{}', fallbackReason: 'table' });
  });
});
