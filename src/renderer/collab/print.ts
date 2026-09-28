import '../player/player.css';
import '../print/print.css';
import './print.css';
import type { Deck } from '@shared/deck.js';
import type { PdfBuildMode } from '@shared/ipc.js';
import { buildPrintPages, printPageRule } from '../print/pages.js';
import { waitForPdfDocument } from '../print/readiness.js';
import { rewriteCssAssetUrls } from '../player/render.js';

/**
 * The collab client's PDF export.
 *
 * The headless collab server is plain Node — it has no Chromium, so there is no
 * server-side equivalent of the desktop app's `printToPDF`. Instead this tab
 * lays out the very same `.pdf-page` document the desktop exporter renders and
 * hands it to the browser's own print pipeline, where "Save as PDF" produces
 * the same vector output. The deck comes from `/api/deck`, so the pages are the
 * live session every collaborator is currently looking at.
 */

const params = new URLSearchParams(location.search);
const deckId = params.get('deck');
const mode: PdfBuildMode = params.get('mode') === 'initial' || params.get('mode') === 'every'
  ? params.get('mode') as PdfBuildMode
  : 'final';
const includeHidden = params.get('includeHidden') === '1';
const slideFilter = params.get('slide');

const status = document.getElementById('status')!;
const printButton = document.getElementById('print') as HTMLButtonElement;
const pagesRoot = document.getElementById('pages')!;

if (!deckId) {
  status.textContent = 'Missing ?deck= parameter.';
  throw new Error('missing deck');
}
const deckParam = encodeURIComponent(deckId);
const assetUrl = (src: string): string =>
  `/decks/${deckParam}/${src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`;

/** Fit the native-pixel pages into the window; print media ignores `zoom`. */
function fitPreview(deck: Deck): void {
  const available = window.innerWidth - 48;
  const scale = available > 0 ? Math.min(1, available / deck.canvas.w) : 1;
  document.documentElement.style.setProperty('--preview-zoom', String(scale));
}

/**
 * The readiness wait needs painted frames, and browsers suspend
 * requestAnimationFrame in a background tab — a tab opened behind the editor
 * would otherwise sit at "Rendering slides…" for as long as it stays there. So
 * the wait is bounded: past the deadline the pages are offered anyway, with the
 * caveat stated, rather than the export hanging.
 */
const READINESS_TIMEOUT_MS = 20_000;

function hiddenTabHint(): void {
  if (document.visibilityState === 'visible') return;
  status.textContent = 'Switch to this tab to finish preparing the PDF.';
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !document.documentElement.dataset.ready) {
      status.textContent = 'Rendering slides…';
    }
  }, { once: true });
}

void (async () => {
  const [deckResponse, themeCss] = await Promise.all([
    fetch(`/api/deck?deck=${deckParam}`),
    fetch(`/api/theme?deck=${deckParam}`).then((r) => (r.ok ? r.text() : '')),
  ]);
  if (!deckResponse.ok) throw new Error(`could not load the deck (${deckResponse.status})`);
  const deck = await deckResponse.json() as Deck;
  document.title = `${deck.title} — PDF`;

  const theme = document.createElement('style');
  theme.textContent = rewriteCssAssetUrls(themeCss, assetUrl);
  document.head.appendChild(theme);

  const pageRule = document.createElement('style');
  pageRule.textContent = printPageRule(deck);
  document.head.appendChild(pageRule);

  fitPreview(deck);
  window.addEventListener('resize', () => fitPreview(deck));

  const pages = buildPrintPages(pagesRoot, {
    deck,
    mode,
    includeHidden,
    slideFilter,
    resolveSrc: assetUrl,
  });
  printButton.addEventListener('click', () => window.print());
  hiddenTabHint();

  const settled = await Promise.race([
    waitForPdfDocument(pages).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), READINESS_TIMEOUT_MS)),
  ]);
  const count = `${pages.length} page${pages.length === 1 ? '' : 's'}`;
  printButton.disabled = false;
  document.documentElement.dataset.ready = settled ? 'true' : 'partial';
  if (settled) {
    status.textContent = `${count} ready — choose "Save as PDF" as the destination.`;
    // Opening the dialog straight away is the expected flow; a browser that
    // refuses it without a gesture still leaves the button.
    window.print();
    return;
  }
  status.textContent = `${count} rendered, but some media did not finish loading`
    + `${document.visibilityState === 'visible' ? '' : ' while this tab was in the background'}`
    + '. Check the preview, then save.';
})().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = `PDF export failed: ${message}`;
  document.documentElement.dataset.error = message;
});
