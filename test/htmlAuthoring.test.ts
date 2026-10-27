import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
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
