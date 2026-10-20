import type { Deck, Slide } from '@shared/deck.js';
import type { PdfBuildMode } from '@shared/ipc.js';
import { resolveState, type SlideState } from '@shared/timeline.js';
import { pdfSteps } from '@shared/pdfExport.js';
import { renderSlide } from '../player/render.js';
import { applyStaticSlideState } from '../player/staticState.js';
import { prepareCodeBlocks } from '../player/codeRender.js';

/**
 * Building the printable pages for a deck, shared by the two ways a PDF is
 * produced: Electron's hidden `printToPDF` window, and the browser collab
 * client's print tab. Both must lay out identically — a deck that exports one
 * way should be byte-for-byte the same document as the other.
 */

export interface PrintPage {
  page: HTMLElement;
  slide: Slide;
  state: SlideState;
}

export interface PrintPagesOptions {
  deck: Deck;
  mode: PdfBuildMode;
  includeHidden?: boolean;
  /** Restrict the document to a single slide id. */
  slideFilter?: string | null;
  resolveSrc: (src: string) => string;
}

/**
 * The `@page` rule for a deck, as a CSS string.
 *
 * Print at the deck's native CSS-pixel canvas. Scaling a 1920×1080 stage into
 * an inch-sized page made Chromium apply the display scale twice on Retina
 * systems, leaving the slide in only the top half of the PDF page. CSS-pixel
 * page dimensions keep the print and Player coordinate systems identical while
 * Chromium still retains vector text and shapes.
 */
export function printPageRule(deck: Deck): string {
  return `@page { size: ${deck.canvas.w}px ${deck.canvas.h}px; margin: 0; }`;
}

/** Render one `.pdf-page` per printable player state into `container`. */
export function buildPrintPages(
  container: HTMLElement,
  options: PrintPagesOptions,
): PrintPage[] {
  const { deck, mode, includeHidden = false, slideFilter = null, resolveSrc } = options;
  prepareCodeBlocks(deck);
  const pages: PrintPage[] = [];
  for (const slide of deck.slides) {
    if (slide.skipped && !includeHidden) continue;
    if (slideFilter && slide.id !== slideFilter) continue;
    for (const step of pdfSteps(slide, mode)) {
      const page = document.createElement('section');
      page.className = 'pdf-page';
      page.style.width = `${deck.canvas.w}px`;
      page.style.height = `${deck.canvas.h}px`;
      const stage = document.createElement('div');
      stage.className = 'pdf-stage';
      stage.style.width = `${deck.canvas.w}px`;
      stage.style.height = `${deck.canvas.h}px`;
      // Full preload, deliberately: this is a one-shot capture, and readiness
      // pins every video to an exact frame under a timeout. 'metadata' would
      // leave the pinned seek racing the network inside that timeout, which
      // showed up as nondeterministic frames in the PDF-vs-player pixel test.
      stage.appendChild(renderSlide(slide, { resolveSrc }));
      const state = resolveState(slide, step);
      applyStaticSlideState(stage, slide, state);
      page.appendChild(stage);
      container.appendChild(page);
      pages.push({ page, slide, state });
    }
  }
  return pages;
}
