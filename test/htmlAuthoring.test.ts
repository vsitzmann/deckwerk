import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type SlideElement } from '../src/shared/deck.js';
import { htmlChangeLabel, htmlSlideScope } from '../src/shared/htmlSlides.js';
import { applyAgentTransaction } from '../src/shared/agent.js';
import { htmlEditTransaction, writeHtmlScope } from '../src/main/htmlAuthoring.js';

/** Keep an exported page's head — scope marker, base, styles — swap its slides. */
function rewriteBody(page: string, body: string): string {
  // A function replacement: bodies hold maths, and `$$` in a replacement string is `$`.
  return page.replace(/<body>[\s\S]*<\/body>/, () => `<body>${body}</body>`);
}

describe('HTML authoring files', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('writes the selected deck-order range beneath edit/', async () => {
    dir = await mkdtemp(join(tmpdir(), 'html-authoring-'));
    const deck = emptyDeck('HTML');
    deck.slides.push(
      { ...structuredClone(deck.slides[0]), id: 'middle slide' },
      { ...structuredClone(deck.slides[0]), id: 'closing' },
    );
    const result = await writeHtmlScope(dir, deck, ['closing', 'slide-1']);
    const html = await readFile(result.path, 'utf8');

    expect(result.path).toBe(join(dir, 'edit', 'slide-1-closing.html'));
    expect(htmlSlideScope(html)).toEqual(['slide-1', 'closing']);
    expect(html).not.toContain('data-slide-id="middle slide"');
  });

  it('compiles a saved range into one transaction with structural edits', async () => {
    dir = await mkdtemp(join(tmpdir(), 'html-authoring-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; }', 'utf8');
    const deck = emptyDeck('HTML');
    deck.slides.push(
      { ...structuredClone(deck.slides[0]), id: 'middle' },
      { ...structuredClone(deck.slides[0]), id: 'closing' },
    );
    const exported = await writeHtmlScope(dir, deck, ['slide-1', 'middle']);
    // Edit the exported page the way an author would: its own head, its own
    // scope marker, different slides in the body.
    await writeFile(exported.path, rewriteBody(await readFile(exported.path, 'utf8'), `
<section class="slide" data-slide-id="new-slide" data-name="New">
  <h1 class="role-title">Made in HTML</h1>
</section>
<section class="slide" data-slide-id="slide-1" data-name="First">
  <p class="role-body">Reordered</p>
</section>`), 'utf8');

    const { transaction } = await htmlEditTransaction(dir, deck, exported.path);
    const next = applyAgentTransaction(deck, transaction!);
    expect(next.slides.map((slide) => slide.id))
      .toEqual(['new-slide', 'slide-1', 'closing']);
    expect(next.slides[0].elements[0]).toMatchObject({ type: 'text', html: 'Made in HTML' });
    // The new slide lands before slide-1 and middle's place closes: no slide
    // that was already there changes place, so nothing reads as reordered.
    expect(transaction!.label).toBe('Added 1 slide · Updated 1 slide · Removed 1 slide');
    expect(transaction!.operations.some((operation) => operation.op === 'moveSlide')).toBe(false);
  }, 60_000);

  it('uses the document intent as the History label', async () => {
    dir = await mkdtemp(join(tmpdir(), 'html-authoring-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; }', 'utf8');
    const deck = emptyDeck('HTML');
    const exported = await writeHtmlScope(dir, deck, ['slide-1']);
    const authored = (await readFile(exported.path, 'utf8'))
      .replace('name="deckwerk-change-label" content=""',
        'name="deckwerk-change-label" content="Tighten the opening argument"')
      .replace('</section>', '<p class="role-body">A clearer claim</p></section>');
    await writeFile(exported.path, authored, 'utf8');

    expect(htmlChangeLabel(authored)).toBe('Tighten the opening argument');
    expect((await htmlEditTransaction(dir, deck, exported.path)).transaction!.label)
      .toBe('Tighten the opening argument');
  }, 60_000);

  // Bug #23: a group-header first row (`colspan`) used to throw away the
  // authored widths, so every column came out equal and the label column wrapped.
  it('keeps authored column widths when the first row spans columns', async () => {
    dir = await mkdtemp(join(tmpdir(), 'html-authoring-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; }', 'utf8');
    const deck = emptyDeck('HTML');
    const exported = await writeHtmlScope(dir, deck, ['slide-1']);
    const cells = (count: number, text: string) => Array.from({ length: count }, () => `<td>${text}</td>`).join('');
    const table = (header: string) => `
<table style="position:absolute; left:150px; top:300px; width:1620px; font-size:28px; border-collapse:collapse; table-layout:fixed;">
  <colgroup><col style="width:340px">${'<col style="width:140px">'.repeat(8)}<col style="width:160px"></colgroup>
  ${header}
  <tr><th>Criterion</th>${cells(9, 'x')}</tr>
  <tr><td>Architecture scales</td>${cells(9, '✓')}</tr>
</table>`;
    await writeFile(exported.path, rewriteBody(await readFile(exported.path, 'utf8'), `
<section class="slide" data-slide-id="spanned">
  ${table('<tr><th></th><th colspan="3">Autoencoders</th><th colspan="2">CLS token</th><th colspan="4">Patch features</th></tr>')}
</section>
<section class="slide" data-slide-id="cell-widths">
  <table style="position:absolute; left:150px; top:300px; width:1000px; border-collapse:collapse;">
    <tr><th colspan="2">Group</th><th>Alone</th></tr>
    <tr><td style="width:600px">wide</td><td style="width:100px">a</td><td style="width:300px">b</td></tr>
  </table>
</section>`), 'utf8');

    const { slides } = await htmlEditTransaction(dir, deck, exported.path);
    const widthsOf = (id: string): number[] => {
      const element = slides.find((slide) => slide.id === id)?.elements.find((candidate) => candidate.type === 'text');
      expect(element?.type === 'text' && element.table, id).toBeTruthy();
      const widths = element!.type === 'text' ? element!.table!.columnWidths : [];
      const total = widths.reduce((sum, width) => sum + width, 0);
      return widths.map((width) => Math.round(width / total * 1620));
    };
    // The colgroup's 340 / 140 × 8 / 160, give or take a pixel of rounding.
    const spanned = widthsOf('spanned');
    expect(spanned).toHaveLength(10);
    [340, 140, 140, 140, 140, 140, 140, 140, 140, 160]
      .forEach((width, index) => expect(Math.abs(spanned[index] - width), `column ${index}: ${spanned}`).toBeLessThanOrEqual(2));
    // Widths on a later row's cells, under a spanning first row: 6 : 1 : 3.
    const cellWidths = widthsOf('cell-widths').map((width) => width / 1620 * 10);
    [6, 1, 3].forEach((share, index) =>
      expect(Math.abs(cellWidths[index] - share), `column ${index}: ${cellWidths}`).toBeLessThan(0.05));
  }, 60_000);

  // Bug #26: a page exported with `inspect --html` counted as a theme-driven
  // deck page as a whole, so markup the agent wrote fresh inside its sections
  // never got the conversions a `new` page gives it — every one-primitive
  // <svg> landed as an inert HTML fallback, and the apply said nothing.
  // Bug #27: a converted SVG primitive lost its dashes and its opacities.
  it('converts fresh SVG inside an exported section to shapes, dashes and opacity included', async () => {
    dir = await mkdtemp(join(tmpdir(), 'html-authoring-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; }', 'utf8');
    const raw = JSON.parse(JSON.stringify(emptyDeck('HTML')));
    // An object the deck already holds as HTML: it must come back as exactly
    // that, however much its markup looks like a convertible SVG.
    const keptHtml = '<svg viewBox="0 0 10 10" style="width:100%;height:100%"><circle cx="5" cy="5" r="4" fill="#c03"></circle></svg>';
    raw.slides[0].elements.push({
      id: 'kept-region', type: 'html', x: 1500, y: 800, w: 200, h: 200, z: 1,
      html: keptHtml, sandboxed: true, css: '', fallbackReason: 'SVG is preserved as HTML',
    });
    const deck = parseDeck(raw);
    const exported = await writeHtmlScope(dir, deck, ['slide-1']);
    const page = await readFile(exported.path, 'utf8');
    // Keep the exported <section …> tag (data-canvas and all) and the kept
    // object; add fresh markup beside it, as the reporter did.
    expect(page).toMatch(/<section\b[^>]*data-canvas=/);
    const at = (left: number, top: number, w: number, h: number) =>
      `position:absolute; left:${left}px; top:${top}px; width:${w}px; height:${h}px;`;
    const fresh = [
      `<div class="role-body" style="${at(100, 40, 800, 60)}">Fresh words</div>`,
      `<svg style="${at(100, 140, 400, 20)}" viewBox="0 0 400 20"><defs><marker id="head" markerWidth="10" markerHeight="10" refX="5" refY="5" orient="auto"><path d="M0 0 L10 5 L0 10 z"></path></marker></defs>`
        + '<line x1="0" y1="10" x2="390" y2="10" stroke="#16182b" stroke-width="4" marker-end="url(#head)"></line></svg>',
      `<svg style="${at(100, 200, 300, 200)}" viewBox="0 0 300 200"><ellipse cx="150" cy="100" rx="140" ry="90" fill="none" stroke="#cc0033" stroke-width="4" stroke-dasharray="6 5"></ellipse></svg>`,
      `<svg style="${at(100, 450, 400, 20)}" viewBox="0 0 400 20"><line x1="0" y1="10" x2="400" y2="10" stroke="#16182b" stroke-width="3" stroke-dasharray="8 6" stroke-opacity="0.45"></line></svg>`,
      `<svg style="${at(600, 200, 200, 100)}" viewBox="0 0 200 100"><rect x="0" y="0" width="200" height="100" fill="#00aa00" fill-opacity="0.5" opacity="0.8"></rect></svg>`,
      `<svg style="${at(900, 200, 120, 120)}" viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" fill="none" stroke="#333333" stroke-width="4" stroke-dasharray="0 8" stroke-linecap="round"></circle></svg>`,
      // Two primitives: a picture, not a shape — kept as HTML, but said so.
      `<svg style="${at(1100, 200, 200, 100)}" viewBox="0 0 200 100"><rect width="90" height="100" fill="#123456"></rect><rect x="110" width="90" height="100" fill="#654321"></rect></svg>`,
      // A table stays an HTML region on an exported page, as it always did
      // (its deck-table conversion needs the typography only a `new` page
      // bakes), but now says so; a gradient behind words that a class paints
      // becomes a box.
      `<table style="position:absolute; left:900px; top:600px; width:600px;"><tr><td>alpha</td><td>beta</td></tr></table>`,
      `<div class="wash" style="${at(100, 600, 600, 200)}"><p class="role-body">On the wash</p></div>`,
    ].join('\n');
    await writeFile(exported.path, page
      .replace(/<\/head>/, () => '<style>.wash { background-image: linear-gradient(90deg, #123456, #abcdef); }</style>\n</head>')
      .replace(/<\/section>/, () => `${fresh}\n</section>`), 'utf8');

    const { slides, warnings } = await htmlEditTransaction(dir, deck, exported.path);
    const elements = slides.find((slide) => slide.id === 'slide-1')!.elements;
    const shapes = elements.filter((element): element is Extract<SlideElement, { type: 'shape' }> =>
      element.type === 'shape');
    const html = elements.filter((element) => element.type === 'html');

    expect(elements.find((element) => element.id === 'kept-region'), JSON.stringify(elements))
      .toMatchObject({ type: 'html', html: keptHtml });
    expect(shapes.map((shape) => shape.shape), JSON.stringify(elements))
      .toEqual(['arrow', 'ellipse', 'line', 'rect', 'ellipse']);
    const [arrow, ellipse, line, rect, dots] = shapes;
    expect(arrow).toMatchObject({ arrowEnd: true, stroke: 'rgb(22, 24, 43)' });
    expect(arrow.strokeDash).toBeUndefined();
    expect(ellipse).toMatchObject({ strokeDash: 'dashed', stroke: 'rgb(204, 0, 51)', fill: null });
    expect(line).toMatchObject({ strokeDash: 'dashed', stroke: 'rgba(22, 24, 43, 0.45)' });
    expect(rect).toMatchObject({ fill: 'rgba(0, 170, 0, 0.5)', opacity: 0.8 });
    expect(dots).toMatchObject({ strokeDash: 'dotted' });
    // The kept region, the two-primitive picture and the table; nothing else is HTML.
    expect(html).toHaveLength(3);
    expect(elements.find((element) => element.type === 'text' && /gradient/.test(element.style['background-image'] ?? '')),
      JSON.stringify(elements)).toMatchObject({ html: '' });
    expect(warnings.filter((warning) => /HTML fallback/.test(warning)), warnings.join('\n'))
      .toEqual([expect.stringMatching(/<svg>.*2 primitives/), expect.stringMatching(/<table>/)]);
  }, 60_000);

  // Bug #24: `<` in maths is a tag start to the parser; the text was cut off
  // there and the apply said nothing.
  it('warns when a < inside maths cut a text element short, and not when it is escaped', async () => {
    dir = await mkdtemp(join(tmpdir(), 'html-authoring-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'theme.css'), '.slide { background: #fff; }', 'utf8');
    const deck = emptyDeck('HTML');
    const exported = await writeHtmlScope(dir, deck, ['slide-1']);
    await writeFile(exported.path, rewriteBody(await readFile(exported.path, 'utf8'), `
<section class="slide" data-slide-id="cut">
  <p class="role-body" style="position:absolute; left:100px; top:100px; width:1200px;">$$\\big\\langle R_\\theta(x), p(y_k\\mid y_{<k}) \\big\\rangle$$</p>
</section>
<section class="slide" data-slide-id="escaped">
  <p class="role-body" style="position:absolute; left:100px; top:100px; width:1200px;">$$p(y_k\\mid y_{&lt;k}) = p(y_k\\mid y_{\\lt k})$$</p>
</section>`), 'utf8');

    const { warnings, slides } = await htmlEditTransaction(dir, deck, exported.path);
    const cut = slides.find((slide) => slide.id === 'cut')!.elements.find((element) => element.type === 'text')!;
    const maths = warnings.filter((warning) => /maths/.test(warning));
    expect(maths, warnings.join('\n')).toHaveLength(1);
    expect(maths[0]).toContain('slide cut');
    expect(maths[0]).toContain(`element ${cut.id}`);
    expect(maths[0]).toContain('y_{<k}');
    expect(maths[0]).toContain('opened with $$');
    expect(maths[0]).toMatch(/&lt;.*\\lt/);
  }, 60_000);
});
