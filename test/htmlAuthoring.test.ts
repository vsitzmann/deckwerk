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
  return page.replace(/<body>[\s\S]*<\/body>/, `<body>${body}</body>`);
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
    expect(transaction!.label).toBe('Added 1 slide · Updated 1 slide · Removed 1 slide · Reordered slides');
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
});
