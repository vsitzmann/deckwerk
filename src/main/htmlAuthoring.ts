import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { AGENT_PROTOCOL_VERSION, type AgentTransaction } from '@shared/agent.js';
import type { Deck, Slide } from '@shared/deck.js';
import {
  htmlChangeLabel,
  htmlSlideScope,
  htmlSyncHistoryLabel,
  htmlSyncOperations,
  pageBases,
  slidesToHtml,
} from '@shared/htmlSlides.js';
import { PLAYER_TYPE_CSS } from '@shared/playerTypeCss.js';
import { compileHtmlToSlides } from '../cli/compileHtml.js';
import { deckRevision } from './agentRuntime.js';

export const HTML_EDIT_DIR = 'edit';

/** Write the selected slides as one self-describing, authoritative HTML range. */
export async function writeHtmlScope(
  deckDir: string,
  deck: Deck,
  slideIds: string[],
): Promise<{ path: string; contents: string }> {
  const wanted = new Set(slideIds);
  const slides = deck.slides.filter((slide) => wanted.has(slide.id));
  if (slides.length === 0) throw new Error('Select at least one slide to edit as HTML');
  const editDir = join(deckDir, HTML_EDIT_DIR);
  await mkdir(editDir, { recursive: true });
  const first = safeName(slides[0].id);
  const last = slides.length > 1 ? `-${safeName(slides[slides.length - 1].id)}` : '';
  const path = join(editDir, `${first}${last}.html`);
  // The file lives one folder below the deck, so that is what its assets and
  // its stylesheet are relative to when the author opens it in a browser.
  const contents = slidesToHtml(slides, deck.canvas, {
    typeCss: PLAYER_TYPE_CSS,
    base: '../',
    theme: deck.theme,
  });
  await writeFile(path, contents, 'utf8');
  return { path, contents };
}

export interface HtmlEditOptions {
  /** Where new slides land when the file carries no recorded scope. */
  after?: string | null;
  label?: string;
}

/**
 * Compile an authoring file into the transaction that syncs its range, with a
 * headless browser.
 *
 * This is the editor-closed path, behind `slide-agent apply --html`. With the
 * editor open the same compile happens in its renderer instead
 * (`renderer/editor/htmlCompile.ts`), which is faster and applies in the live
 * document — but both produce the same transaction from the same walk.
 */
export async function htmlEditTransaction(
  deckDir: string,
  deck: Deck,
  htmlPath: string,
  options: HtmlEditOptions = {},
): Promise<{ transaction: AgentTransaction | null; slides: Slide[]; warnings: string[] }> {
  const authored = await readFile(htmlPath, 'utf8');
  const scope = htmlSlideScope(authored);
  const { slides, warnings, measured } = await compileHtmlToSlides({ deckDir, deck, htmlPath });
  if (slides.length === 0 && scope === null) {
    throw new Error(`No slides found in ${basename(htmlPath)}.`
      + ' Wrap each slide in <section class="slide" data-slide-id="…">.');
  }
  const operations = htmlSyncOperations(
    deck,
    slides,
    scope,
    options.after === undefined ? deck.slides[deck.slides.length - 1]?.id ?? null : options.after,
    pageBases(measured),
  );
  // An untouched export compiles to what the deck already holds. That is a
  // sync with nothing to do — the same answer the editor and a hosted mirror
  // give — not an error.
  if (operations.length === 0) return { transaction: null, slides, warnings };
  return {
    transaction: {
      version: AGENT_PROTOCOL_VERSION,
      expectedRevision: deckRevision(deck),
      label: options.label ?? htmlChangeLabel(authored) ?? htmlSyncHistoryLabel(operations),
      operations,
    },
    slides,
    warnings,
  };
}

function safeName(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'slides';
}

/**
 * Read an authoring file that may still be being written.
 *
 * A directory watch reports a file being opened for writing, not its last
 * byte landing, and there is no later event to wait for once the write is
 * done. Reading during a large in-place write hands back a truncated
 * document — which, compiled, is an empty slide, or (when the reader gave up
 * instead) a save that never took effect at all. So: read until two reads a
 * pause apart agree, and give a stalled writer a bounded number of chances.
 */
export async function readSettledFile(
  path: string,
  options: { delayMs?: number; attempts?: number } = {},
  read: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<string> {
  const delayMs = options.delayMs ?? 150;
  const attempts = options.attempts ?? 20;
  let contents = await read(path);
  for (let attempt = 0; attempt < attempts; attempt++) {
    await new Promise((settle) => setTimeout(settle, delayMs));
    const again = await read(path);
    if (again === contents) return contents;
    contents = again;
  }
  return contents;
}

/** Editors save through hidden temporaries (`.!1234!work.html`, `.work.html.swp`); they are not documents. */
export function isAuthoringFileName(name: string): boolean {
  return name.endsWith('.html') && !name.startsWith('.');
}
