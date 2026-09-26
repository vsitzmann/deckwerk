/**
 * Rewrite typed page numbers so they count shown slides in order.
 *
 * PowerPoint imports freeze slide-number fields into plain text, so the
 * numbers go stale on every reorder or skip. This finds each slide's page
 * number (a text box in the bottom-right corner whose only content is a
 * number), renumbers shown slides 1..n, leaves skipped slides alone, and
 * applies the result as one transaction, so builds and notes are untouched.
 *
 *   vite-node --config vitest.config.ts scripts/renumber-pages.mts -- <deck> [--dry-run]
 *
 * ponytail: finds the page number by corner position and number-only HTML;
 * decks with the number elsewhere need PAGE adjusted.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeck } from '../src/main/deckStore.js';
import type { Deck } from '../src/shared/deck.js';

/** Top-left corner region of the footer page number on a 1920×1080 slide. */
const PAGE = { minX: 1300, minY: 980 };
const NUMBER = /^((?:<[^>]+>)*)\d+((?:<\/[^>]+>)*)$/;

type Op = { op: 'replaceElement'; slideId: string; elementId: string; element: unknown };

export function renumber(deck: Deck): Op[] {
  const ops: Op[] = [];
  let page = 0;
  for (const slide of deck.slides) {
    if (slide.skipped) continue;
    page += 1;
    const el = slide.elements.find((e) => e.type === 'text'
      && e.x >= PAGE.minX && e.y >= PAGE.minY
      && NUMBER.test(e.html.trim()));
    if (!el || el.type !== 'text') continue;
    const html = el.html.trim().replace(NUMBER, `$1${page}$2`);
    if (html !== el.html.trim()) ops.push({ op: 'replaceElement', slideId: slide.id, elementId: el.id, element: { ...el, html } });
  }
  return ops;
}

const [dir, ...flags] = process.argv.slice(2).filter((a) => a !== '--');
if (!process.env.VITEST) await main();

async function main(): Promise<void> {
if (!dir) throw new Error('usage: renumber-pages.mts <deck> [--dry-run]');
const ops = renumber(await loadDeck(dir));
for (const o of ops) console.log(`${o.slideId}: ${(o.element as { html: string }).html.replace(/<[^>]+>/g, '')}`);
if (!ops.length) console.log('page numbers already in order');
else if (!flags.includes('--dry-run')) {
  const file = join(tmpdir(), `renumber-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, label: 'Renumber pages', operations: ops }));
  console.log(execFileSync(join(import.meta.dirname ?? __dirname, '../bin/slide-agent'), ['transaction', 'apply', dir, file], { encoding: 'utf8' }));
}
}
