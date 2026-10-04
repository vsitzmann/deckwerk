import { AGENT_PROTOCOL_VERSION, type AgentTransaction } from '@shared/agent.js';
import type { Deck, Slide } from '@shared/deck.js';
import type { AuthoredHtmlFile } from '@shared/ipc.js';
import renderMathInElement from 'katex/contrib/auto-render';
import { authoringPageHtml, measureSlides } from '@shared/htmlMeasure.js';
import {
  htmlChangeLabel,
  htmlSlideScope,
  htmlSyncHistoryLabel,
  htmlSyncOperations,
  renderAuthoredMath,
  slidesFromMeasured,
} from '@shared/htmlSlides.js';
import { PLAYER_TYPE_CSS } from '@shared/playerTypeCss.js';
import { browserDeckRevision } from './agentBridge.js';
import { sanitizeAuthoredHtml, type HtmlSanitizationReport } from '@shared/htmlSafety.js';

/**
 * Compiling authored HTML inside the editor itself.
 *
 * The editor is already a browser, so when it is open there is no reason to
 * start a second one: the page goes into an offscreen iframe at canvas size,
 * and the same walk the offline compiler runs measures it here. That removes a
 * whole Electron process from the save-and-watch loop — the file is saved and
 * the slides move, with no spawn in between — and it means the geometry is
 * measured by the very engine that will draw it.
 *
 * The iframe is not a nicety: the authoring page carries the deck's `theme.css`
 * without the player's positioning rules, which would wreck the editor's own
 * layout if it were mounted in this document.
 */

export interface CompiledAuthoredHtml {
  slides: Slide[];
  /** Inline style the browser silently dropped; see `MeasuredSlide.warnings`. */
  warnings: string[];
  sanitization: HtmlSanitizationReport;
}

/** Lay authored markup out at canvas size and report it as ordinary slides. */
export async function compileAuthoredHtml(
  deck: Deck,
  authored: string,
  theme: string,
): Promise<CompiledAuthoredHtml> {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  Object.assign(frame.style, {
    position: 'fixed', left: '-100000px', top: '0', border: '0', opacity: '0',
    pointerEvents: 'none', width: `${deck.canvas.w}px`, height: `${deck.canvas.h}px`,
  });
  document.body.appendChild(frame);

  try {
    const doc = frame.contentDocument;
    if (!doc) throw new Error('The authoring page has no document');
    // Written rather than handed over as `srcdoc`, because the frame's own load
    // event is not a reliable signal here: a blank frame fires one the moment
    // it is appended. What the measurement actually depends on is waited for
    // explicitly below.
    //
    // Deck-relative asset paths must resolve the way the player resolves them,
    // which in this window is the deck: scheme rather than a file URL.
    doc.open();
    const sanitized = sanitizeAuthoredHtml(authored);
    doc.write(authoringPageHtml({
      authored: sanitized.html,
      typeCss: PLAYER_TYPE_CSS,
      theme,
      themeHref: deck.theme,
      canvas: deck.canvas,
      // Not a fixed string: the asset host names the deck, so a second window
      // measuring its own authored HTML must not resolve against this one's.
      base: window.api.assetUrl(''),
    }));
    doc.close();

    // This frame's policy blocks the page's own scripts, including the KaTeX
    // it carries — so the maths pass runs here, with the editor's bundled
    // KaTeX, against the frame's document. The page's inlined KaTeX *style*
    // still applies (its fonts are data: URIs), which is what makes the
    // rendered maths measure the same here as in any other browser.
    renderAuthoredMath(doc, renderMathInElement as (el: Element, opts: unknown) => void);

    // An image that has not arrived measures as nothing and a font that has
    // not arrived measures as the fallback — either one bakes wrong geometry
    // into the deck, silently. (The theme is not in this list: it was resolved
    // into the page above rather than left as a fetch to wait on.)
    await imagesSettled(doc);
    await doc.fonts?.ready;
    await nextFrame();
    const measured = measureSlides(doc);
    return {
      slides: slidesFromMeasured(deck, measured),
      warnings: measured.flatMap((slide) => slide.warnings ?? []),
      sanitization: sanitized.report,
    };
  } finally {
    frame.remove();
  }
}

/** Resolve once every image has loaded or failed; a broken asset must not hang a save. */
function imagesSettled(doc: Document): Promise<unknown> {
  return Promise.all([...doc.images].map((image) => image.complete
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    })));
}

/**
 * Wait for layout to settle. A window that is not painting — the display
 * asleep, the screen locked — never runs animation frames, and an agent's
 * apply then waited forever behind it; layout itself does not need a paint, so
 * a timer stands in for the frame after a moment.
 */
function nextFrame(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 250);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The transaction a saved authoring file implies, or null when it implies none.
 *
 * The exported range is authoritative: slides in the file are replaced or
 * inserted, slides that were exported but are now absent are deleted, and the
 * file's order is applied — one transaction, so one undo entry.
 */
export async function authoredHtmlTransaction(
  deck: Deck,
  file: AuthoredHtmlFile,
  theme: string,
): Promise<{ transaction: AgentTransaction | null; warnings: string[] }> {
  const { transaction, warnings } = await authoredHtmlSync(deck, file, theme);
  return { transaction, warnings };
}

/**
 * The transaction plus the compiled slides themselves — the caller needs the
 * slides to stamp their assigned ids back into the authoring file, which is
 * what makes saving the same file twice idempotent — and any inline style the
 * browser silently dropped, so the save toast can say so.
 */
export async function authoredHtmlSync(
  deck: Deck,
  file: AuthoredHtmlFile,
  theme: string,
  options: { after?: string | null; label?: string } = {},
): Promise<{ transaction: AgentTransaction | null; slides: Slide[]; warnings: string[] }> {
  const scope = htmlSlideScope(file.contents);
  const { slides, warnings } = await compileAuthoredHtml(deck, file.contents, theme);
  if (slides.length === 0 && scope === null) {
    throw new Error(`No slides found in ${fileName(file.path)}`);
  }
  const operations = htmlSyncOperations(
    deck,
    slides,
    scope,
    options.after === undefined ? deck.slides[deck.slides.length - 1]?.id ?? null : options.after,
  );
  // A file that asks for nothing at all — no slides of its own and none to
  // delete — is a save to sit out, not an error to put in front of the user.
  if (operations.length === 0) return { transaction: null, slides, warnings };
  return {
    transaction: {
      version: AGENT_PROTOCOL_VERSION,
      expectedRevision: await browserDeckRevision(deck),
      label: options.label ?? htmlChangeLabel(file.contents) ?? htmlSyncHistoryLabel(operations),
      operations,
    },
    slides,
    warnings,
  };
}

export function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}
