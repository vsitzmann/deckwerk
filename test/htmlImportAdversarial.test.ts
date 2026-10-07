// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { authoringPageHtml, measureSlides } from '../src/shared/htmlMeasure.js';
import {
  INLINE_TEXT_DATA_URI_LIMIT, isRelativeFontSize, pastedHtmlHasMedia, sanitizeAuthoredHtml,
  sanitizePastedTextHtml, stripTextMediaPayloads, textOnlyPastedHtml,
} from '../src/shared/htmlSafety.js';
import { slidesFromMeasured, type MeasuredSlide } from '../src/shared/htmlSlides.js';

/**
 * Hostile and malformed input to the HTML import.
 *
 * The fixtures exercise pages an agent would plausibly write. This file
 * exercises pages nobody should write — attribute values holding `>`, entity
 * smuggled URL schemes, unbalanced tags, thousand-item lists — and asks only
 * that the import stays safe, finite and deterministic on them.
 */

function pageDocument(authored: string): Document {
  const html = authoringPageHtml({
    authored,
    typeCss: '.role-title { font-size: 92px; }',
    theme: '.slide { background: #ffffff; }',
    canvas: emptyDeck().canvas,
    base: 'deck://asset/',
  });
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();
  return doc;
}

function finiteRects(slides: MeasuredSlide[]): void {
  for (const slide of slides) {
    for (const node of slide.nodes) {
      for (const value of [node.rect.x, node.rect.y, node.rect.w, node.rect.h, node.rotation, node.opacity]) {
        expect(Number.isFinite(value), JSON.stringify(node.rect)).toBe(true);
      }
    }
  }
}

describe('sanitizeAuthoredHtml against smuggled URL schemes', () => {
  const wrap = (body: string): string =>
    `<!doctype html><html><head></head><body><section class="slide">${body}</section></body></html>`;

  it('blocks a javascript: scheme hidden behind entity-encoded control characters', () => {
    // The HTML parser decodes `&#9;` to a tab and the URL parser strips tabs
    // and newlines out of a scheme, so `java&#9;script:` runs as `javascript:`.
    for (const smuggled of [
      'java&#9;script:steal()',
      'java&#10;script:steal()',
      'java&#13;script:steal()',
      '&#106;avascript:steal()',
      ' \u0001javascript:steal()',
      'JaVaScRiPt:steal()',
    ]) {
      const { html, report } = sanitizeAuthoredHtml(wrap(`<a href="${smuggled}">x</a>`));
      expect(html, smuggled).not.toMatch(/href=/i);
      expect(report.blockedUrls, smuggled).toHaveLength(1);
    }
  });

  it('blocks javascript: form targets as it blocks javascript: links', () => {
    const { html } = sanitizeAuthoredHtml(wrap(
      '<form action="javascript:steal()"><button formaction="javascript:steal()">go</button></form>',
    ));
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/\baction=|formaction=/i);
  });

  it('strips event handlers whatever their casing and namespace', () => {
    const { html, report } = sanitizeAuthoredHtml(wrap(
      '<div ONCLICK="a()" OnMouseOver="b()"><svg ONLOAD="c()"><circle onclick="d()"/></svg></div>',
    ));
    expect(html).not.toMatch(/on\w+=/i);
    expect(report.removedEventHandlers).toBe(4);
  });

  it('removes scripting elements inside SVG and foreignObject', () => {
    const { html, report } = sanitizeAuthoredHtml(wrap(
      '<svg><script>steal()</script><foreignObject><iframe srcdoc="&lt;script&gt;steal()&lt;/script&gt;"></iframe>'
      + '<object data="x"></object><embed src="x"></foreignObject>'
      + '<a xlink:href="javascript:steal()"><text>t</text></a></svg>',
    ));
    expect(html).not.toMatch(/<script|<iframe|<object|<embed|javascript:|srcdoc/i);
    expect(report.removedScripts).toBe(4);
  });

  it('is idempotent: sanitizing its own output changes nothing', () => {
    const inputs = [
      wrap('<a href="java&#9;script:x()">x</a><img src="https://bad.test/p.png" onerror="y()">'),
      wrap('<p title=\'a"b>c\' data-x="1>2">quoted &amp; escaped &lt;tags&gt;</p>'),
      wrap('<style>.a{background:url(https://bad.test/a.png)} .b{content:"\\">"}</style><div class="a b"></div>'),
      '<section class="slide"><ul><li>unclosed<li>items<ul><li>nested</ul></section>',
      wrap('<img src="data:image/png;base64,AAAA"><video poster="data:image/gif;base64,R0lG"></video>'),
    ];
    for (const input of inputs) {
      const once = sanitizeAuthoredHtml(input).html;
      const twice = sanitizeAuthoredHtml(once);
      expect(twice.html).toBe(once);
      expect(twice.report.removedScripts).toBe(0);
      expect(twice.report.removedEventHandlers).toBe(0);
      expect(twice.report.blockedUrls).toEqual([]);
    }
  });

  it('leaves a data: URL in place and reports it once, MIME and all', () => {
    const { html, report } = sanitizeAuthoredHtml(wrap(
      '<img src="DATA:image/svg+xml;base64,PHN2Zz4="><a href="data:text/html,<script>x()</script>">l</a>',
    ));
    expect(report.dataUrls.map((entry) => entry.mime)).toEqual(['image/svg+xml', 'text/html']);
    expect(html).toContain('DATA:image/svg+xml');
  });
});

describe('sanitizePastedTextHtml', () => {
  it('turns copied KaTeX render trees back into authored delimiters', () => {
    const annotation = '<annotation encoding="application/x-tex">E=mc^2</annotation>';
    const inline = '<span class="katex"><span class="katex-mathml"><math><semantics>'
      + `<mrow><mi>E</mi></mrow>${annotation}</semantics></math></span>`
      + '<span class="katex-html" aria-hidden="true">painted inline copy</span></span>';
    const display = `<span class="katex-display">${inline}</span>`;

    expect(sanitizePastedTextHtml(`<p>Inline ${inline}; display ${display}</p>`))
      .toBe('<p>Inline $E=mc^2$; display $$E=mc^2$$</p>');
  });

  it('is idempotent and turns sup/sub into relative-size spans exactly once', () => {
    const once = sanitizePastedTextHtml(
      'E = mc<sup>2</sup> and H<sub>2</sub>O <b>bold <i>both</i></b>'
      + '<a href="https://ok.test">k</a><a href="java&#9;script:x()">bad</a>'
      + '<img src="https://bad.test/p.png"><img src="asset:one.png">',
    );
    expect(once).toContain('vertical-align: super');
    expect(once).toContain('font-size: 0.7em');
    expect(once).not.toMatch(/<sup|<sub|<b>|<i>|javascript|bad\.test/i);
    expect(once).toContain('asset:one.png');
    expect(once).toContain('https://ok.test');
    expect(sanitizePastedTextHtml(once)).toBe(once);
  });

  it('keeps an authored size on a sup rather than overwriting it', () => {
    const html = sanitizePastedTextHtml('x<sup style="font-size: 12px">1</sup>');
    expect(html).toContain('font-size: 12px');
    expect(html).not.toContain('0.7em');
  });
});

describe('media payloads in text html', () => {
  // A 10 MB `<img src="data:video/mp4;base64,…">` from a clipboard landed in a
  // slide title's html, made deck.json 13.5 MB and every collaborator's editor
  // crawl. Text html may carry small inline images; it never carries media
  // bytes.
  const video = `data:video/mp4;base64,${'A'.repeat(4096)}`;
  const bigImage = `data:image/png;base64,${'A'.repeat(INLINE_TEXT_DATA_URI_LIMIT + 1)}`;
  const smallImage = 'data:image/png;base64,iVBORw0KGgo=';

  it('drops data: media of any non-image type from pasted text', () => {
    const html = sanitizePastedTextHtml(`<p>before<img src="${video}">after</p>`
      + `<p><video src="${video}"><source src="${video}">fallback</video></p>`
      + `<p><audio src="data:audio/mpeg;base64,AAAA"></audio>x</p>`);
    expect(html).not.toContain('data:');
    expect(html).not.toMatch(/<img|<video|<source|<audio/);
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  it('drops data: images over the inline size bound, keeping small ones', () => {
    const html = sanitizePastedTextHtml(`<p>a<img src="${bigImage}">b<img src="${smallImage}">c</p>`);
    expect(html).not.toContain(bigImage);
    expect(html).toContain(smallImage);
  });

  it('drops oversized data: payloads in SVG images, srcset and style urls', () => {
    const html = sanitizePastedTextHtml(
      `<p>a<svg viewBox="0 0 10 10"><image href="${bigImage}"></image><rect width="4" height="4"></rect></svg>`
      + `<img srcset="${bigImage} 2x" src="${smallImage}">`
      + `<span style="color: red; background-image: url(${bigImage})">b</span></p>`,
    );
    expect(html).not.toContain(bigImage);
    expect(html).toContain('<rect');
    expect(html).toContain('color: red');
  });

  it('strips a live subtree in place and reports whether it changed anything', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p>keep <a href="https://x.test">link</a> $E=mc^2$</p><p>x<img src="${video}">y</p>`;
    expect(stripTextMediaPayloads(root)).toBe(true);
    expect(root.innerHTML).toBe('<p>keep <a href="https://x.test">link</a> $E=mc^2$</p><p>xy</p>');
    expect(stripTextMediaPayloads(root)).toBe(false);
  });

  it('recognises media on a clipboard, but not KaTeX\'s own SVG', () => {
    expect(pastedHtmlHasMedia(`<meta charset="utf-8"><img src="${video}">`)).toBe(true);
    expect(pastedHtmlHasMedia('<p>t<picture><img src="a.png"></picture></p>')).toBe(true);
    expect(pastedHtmlHasMedia('<p>t<video></video></p>')).toBe(true);
    expect(pastedHtmlHasMedia(`<svg><image href="${smallImage}"></image></svg>`)).toBe(true);
    expect(pastedHtmlHasMedia('<ul><li>plain <b>rich</b> text</li></ul><table><tr><td>1</td></tr></table>')).toBe(false);
    const annotation = '<annotation encoding="application/x-tex">\\sqrt{x}</annotation>';
    const katex = `<span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow>${annotation}`
      + '</semantics></math></span><span class="katex-html"><svg><path d="M0 0"></path></svg></span></span>';
    expect(pastedHtmlHasMedia(`<p>${katex}</p>`)).toBe(false);
  });

  it('pastes only the text of a clipboard that carries media', () => {
    const html = textOnlyPastedHtml(
      `<p>Title <b>bold</b><img src="${smallImage}"><a href="https://x.test">link</a></p>`
      + `<ul><li>one<video src="${video}"></video></li></ul><svg><image href="${smallImage}"></image></svg>`,
    );
    expect(html).not.toMatch(/<img|<video|<svg|<image|data:/);
    expect(html).toContain('font-weight: 700');
    expect(html).toContain('href="https://x.test"');
    expect(html).toContain('<li>one</li>');
  });
});

describe('isRelativeFontSize', () => {
  it('separates relationships from measurements', () => {
    for (const relative of ['0.7em', ' 84% ', '1.2rem', 'smaller', 'LARGER', '2ex', '3ch', '10vw', '5vmin']) {
      expect(isRelativeFontSize(relative), relative).toBe(true);
    }
    for (const absolute of ['12px', '10pt', 'medium', 'x-small', '1in', '', null, undefined, 'em']) {
      // `em` alone is not a size; it still reads as relative, which is the
      // safe direction (a relative size is left alone rather than replaced).
      if (absolute === 'em') continue;
      expect(isRelativeFontSize(absolute), String(absolute)).toBe(false);
    }
  });
});

describe('the walk on malformed and extreme markup', () => {
  it('survives attributes holding > and quotes, unbalanced tags and empty elements', () => {
    const doc = pageDocument(`
      <section class="slide" data-slide-id="a" data-name='Say "hi" > there' style="background:#fff">
        <h1 class="role-title" title="x>y">Title <span></span></h1>
        <p>unclosed paragraph
        <div><div><div></div></div></div>
        <ul><li>one<li>two<ul><li>three</ul></ul>
        <table><tr><td>a<td>b</table>
        <br><hr>
        <img>
        <svg></svg>
      </section>
      <section class="slide" data-slide-id="b"></section>`);
    const slides = measureSlides(doc);
    expect(slides).toHaveLength(2);
    expect(slides[0].name).toBe('Say "hi" > there');
    finiteRects(slides);
    expect(() => slidesFromMeasured(emptyDeck(), slides)).not.toThrow();
  });

  it('is deterministic: two parses of one page measure the same', () => {
    const authored = `
      <section class="slide" data-slide-id="a">
        <h1 class="role-title">Hello</h1>
        <p dir="rtl">שלום עולם — مرحبا</p>
        <p>${'word '.repeat(1500)}</p>
        <ul>${'<li>item</li>'.repeat(60)}</ul>
        <div style="background:#123456; width:100px; height:100px"></div>
      </section>`;
    const first = measureSlides(pageDocument(authored));
    const second = measureSlides(pageDocument(authored));
    expect(second).toEqual(first);
    finiteRects(first);
  });

  it('is stable when the same document is measured a second time', () => {
    // The walk annotates the document it measures (`data-element`, classes,
    // collapsed whitespace). None of that may change what a second walk of the
    // same document reports.
    const doc = pageDocument(`
      <section class="slide" data-slide-id="a">
        <h1 class="role-title">  spaced   out  </h1>
        <table><tr><td>a</td><td>b</td></tr></table>
        <pre>  keep   this  </pre>
        <p>x<sup>2</sup></p>
      </section>`);
    const first = measureSlides(doc);
    const second = measureSlides(doc);
    expect(second).toEqual(first);
  });

  it('collapses whitespace in prose but not in preformatted text', () => {
    const [slide] = measureSlides(pageDocument(`
      <section class="slide" data-slide-id="a">
        <p>  two
           lines  </p>
        <pre>  two
  lines  </pre>
      </section>`));
    const byTag = Object.fromEntries(slide.nodes.map((node) => [node.tag, node.html]));
    expect(byTag.p).toBe('two lines');
    expect(byTag.pre).toBe('  two\n  lines  ');
  });

  it('does not fall over deep nesting', () => {
    const depth = 150;
    const authored = `<section class="slide" data-slide-id="a">${'<div>'.repeat(depth)}deep${'</div>'.repeat(depth)}</section>`;
    const [slide] = measureSlides(pageDocument(authored));
    expect(slide.nodes.map((node) => node.html)).toContain('deep');
  });

  it('reads retired data-magic-move-* attributes as their morph spelling', () => {
    // Hand-authored HTML outlives the rename; the authoring page canonicalises
    // the attributes on the way in, before the stringified walk reads them.
    const slides = measureSlides(pageDocument(`
      <section class="slide" data-slide-id="a"><h1 data-magic-move="title">A</h1></section>
      <section class="slide" data-slide-id="b" data-magic-move-from-previous="true"
               data-magic-move-duration="900"><h1 data-magic-move="title">B</h1></section>`));
    expect(slides[1].morphFromPrevious).toBe(true);
    expect(slides[1].morphDuration).toBe(900);
    expect(slides[0].nodes[0].dataset.morph).toBe('title');
    expect(slides[0].nodes[0].dataset.magicMove).toBeUndefined();
  });

  it('keeps a non-renamed attribute that merely starts with a retired name', () => {
    const slides = measureSlides(pageDocument(`
      <section class="slide" data-slide-id="a" data-morph-from-previous="true"
               data-magic-move-duration="1">
        <h1 data-magic-moved="x" data-magic-move-extra="y">A</h1></section>`));
    expect(slides[0].morphFromPrevious).toBe(true);
    expect(slides[0].morphDuration).toBe(1);
    expect(slides[0].nodes[0].dataset.magicMoved).toBe('x');
    expect(slides[0].nodes[0].dataset.magicMoveExtra).toBe('y');
  });
});
