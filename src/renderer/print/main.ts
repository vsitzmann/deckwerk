import '../player/player.css';
import './print.css';
import { buildPrintPages, printPageRule } from './pages.js';
import { waitForPdfDocument } from './readiness.js';
import { rewriteCssAssetUrls } from '../player/render.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === 'initial' || params.get('mode') === 'every'
  ? params.get('mode') as 'initial' | 'every'
  : 'final';
const includeHidden = params.get('includeHidden') === '1';
const slideFilter = params.get('slide');
const jobId = params.get('job') ?? '';

void (async () => {
  const session = await window.api.getDeck();
  if (!session) throw new Error('No deck is open');
  const theme = document.createElement('style');
  theme.textContent = rewriteCssAssetUrls(await window.api.loadTheme(), window.api.assetUrl);
  document.head.appendChild(theme);

  const { deck } = session;
  const pageRule = document.createElement('style');
  pageRule.textContent = printPageRule(deck);
  document.head.appendChild(pageRule);

  const pages = buildPrintPages(document.getElementById('pages')!, {
    deck,
    mode,
    includeHidden,
    slideFilter,
    resolveSrc: window.api.assetUrl,
  });
  await waitForPdfDocument(pages, {
    // Cut by ffmpeg in the main process, like the rail's posters, so the
    // window never decodes every video in the deck at once.
    stillFor: async (src, time) => (await window.api.videoPoster({ src, time, print: true })).url,
    // A synced clip's length, from ffprobe in the main process.
    durationFor: async (src) => (await window.api.probeAsset(src)).duration,
  });
  document.documentElement.dataset.ready = 'true';
  window.api.pdfReady(jobId);
})().catch((error) => {
  document.documentElement.dataset.error = String(error instanceof Error ? error.message : error);
  window.api.pdfReady(jobId);
});
