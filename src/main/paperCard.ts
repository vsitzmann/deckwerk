import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import {
  PAPER_INPUT_HINT,
  PAPER_SCREENSHOT,
  PaperNotFoundError,
  arxivApiUrl,
  arxivIdForTitle,
  arxivPdfUrl,
  arxivTitleSearchUrl,
  classifyPaperInput,
  parseArxivAtom,
  parseCrossref,
  parseHtmlMeta,
  type PaperCard,
  type PaperCardJob,
  type PaperMeta,
} from '@shared/paperCard.js';
import { assertPublicHost } from './clipboardImageFetch.js';
import { importAsset } from './deckStore.js';
import { renderPdfFirstPage, type PdfFirstPage } from './pdfFirstPage.js';
import { captureWebPage, type WebCaptureResult } from './webCapture.js';

/**
 * The paper-card job, shared by the desktop main process, the collab server
 * and `slide-agent paper`: understand the input, fetch the metadata, make the
 * picture (a PDF's first page, or a screenshot of the page), and put it in the
 * deck's assets/ through the ordinary content-hash importer. What it returns
 * is everything the editor needs to lay the card out (shared/paperCard.ts).
 */

export interface PaperCardOptions {
  /** A changing, specific phase ("Downloading the PDF of arXiv:2003.08934"). */
  onProgress?: (message: string) => void;
  /** The collab server's guard: the URL comes from a client, not the machine's owner. */
  blockPrivateAddresses?: boolean;
  /** Seams for tests; the real network, renderer and browser otherwise. */
  fetchImpl?: typeof fetch;
  renderPdf?: (pdfPath: string, outPng: string) => Promise<PdfFirstPage>;
  capture?: typeof captureWebPage;
}

/** A PDF larger than this is not a paper. */
const MAX_PDF_BYTES = 80 * 1024 * 1024;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = 'DeckWerk paper cards (https://github.com/vsitzmann/deckwerk)';

export async function fetchPaperCard(
  deckDir: string,
  job: PaperCardJob,
  options: PaperCardOptions = {},
): Promise<PaperCard> {
  const work = await mkdtemp(join(tmpdir(), 'deckwerk-paper-'));
  const progress = options.onProgress ?? (() => {});
  try {
    if ('pdfPath' in job) {
      progress(`Rendering the first page of ${job.name}`);
      const png = join(work, `${stemOf(job.name)}.png`);
      const page = await (options.renderPdf ?? renderPdfFirstPage)(job.pdfPath, png);
      return await finish(deckDir, png, page, { ...pdfMeta(page, job.name), kind: 'pdf' }, progress);
    }

    const source = classifyPaperInput(job.input);
    if (!source) throw new Error(`"${job.input.trim().slice(0, 80)}" is not something a card can be made from. ${PAPER_INPUT_HINT}`);
    const net = new Net(options);

    if (source.kind === 'arxiv') {
      progress(`Looking up arXiv:${source.id}`);
      const meta = await arxivMeta(net, source.id);
      return await fromPdfUrl(net, deckDir, work, arxivPdfUrl(source.id), `arxiv-${source.id}`,
        `the PDF of arXiv:${source.id}`, { ...meta, kind: 'arxiv' }, options, progress);
    }

    if (source.kind === 'doi') {
      progress(`Looking up DOI ${source.doi} on Crossref`);
      let json: unknown;
      try {
        const response = await net.get(`https://api.crossref.org/works/${encodeURIComponent(source.doi)}`, 'application/json', MAX_PAGE_BYTES);
        json = JSON.parse(response.bytes.toString('utf8'));
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) {
          throw new PaperNotFoundError(`Crossref has no record of DOI ${source.doi}. Check it, or paste the paper's page instead.`);
        }
        throw error;
      }
      const paper = parseCrossref(json, source.doi);
      const meta: PaperMeta = { title: paper.title, authors: paper.authors, venue: paper.venue, year: paper.year, url: paper.url };
      // An open-access PDF makes the better picture; publishers' links are
      // usually paywalled or bot-walled, which is what the screenshot is for.
      for (const pdfUrl of paper.pdfUrls) {
        try {
          return await fromPdfUrl(net, deckDir, work, pdfUrl, `doi-${source.doi}`, `the PDF from ${hostOf(pdfUrl)}`,
            { ...meta, kind: 'doi' }, options, progress);
        } catch {
          // Fall through to the next link, then to arXiv, then to the landing page.
        }
      }
      // Most published CS papers are also on arXiv, whose PDF anyone may
      // fetch; Crossref's metadata (the real venue) stays, only the picture
      // comes from there. Only an exact title match counts.
      try {
        progress(`Looking for "${paper.title}" on arXiv`);
        const search = await net.get(arxivTitleSearchUrl(paper.title), 'application/atom+xml', MAX_PAGE_BYTES);
        const id = arxivIdForTitle(search.bytes.toString('utf8'), paper.title);
        if (id) {
          return await fromPdfUrl(net, deckDir, work, arxivPdfUrl(id), `doi-${source.doi}`, `the PDF of arXiv:${id}`,
            { ...meta, kind: 'doi' }, options, progress);
        }
      } catch {
        // The landing page is the last resort.
      }
      return await fromScreenshot(deckDir, work, paper.landingUrl, `doi-${source.doi}`, { ...meta, kind: 'doi' }, options, progress);
    }

    progress(`Opening ${hostOf(source.url)}`);
    const page = await net.get(source.url, 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5', MAX_PDF_BYTES);
    const type = page.contentType.split(';')[0].trim().toLowerCase();
    if (type === 'application/pdf' || isPdf(page.bytes)) {
      const pdfPath = join(work, 'paper.pdf');
      await writeFile(pdfPath, page.bytes);
      const name = basename(page.url.pathname) || hostOf(source.url);
      progress(`Rendering the first page of ${name}`);
      const png = join(work, `${stemOf(name)}.png`);
      const rendered = await (options.renderPdf ?? renderPdfFirstPage)(pdfPath, png);
      return await finish(deckDir, png, rendered, { ...pdfMeta(rendered, name), url: page.url.href, kind: 'pdf' }, progress);
    }
    if (!/html|xml/.test(type) && type !== '') {
      throw new Error(`${source.url} is ${describeType(type)}, not a paper or a project page.`);
    }
    const html = page.bytes.toString('utf8');
    const declared = parseHtmlMeta(html, page.url.href);
    if (BOT_CHECK.test(declared.title)) throw new Error(botCheckMessage(source.url));
    let meta: PaperMeta = declared;
    // A project page rarely carries citation tags but nearly always links its
    // paper; arXiv then supplies the authors and venue the page leaves out.
    if (declared.authors.length === 0 && declared.arxivId) {
      try {
        progress(`Looking up arXiv:${declared.arxivId}, linked from ${hostOf(source.url)}`);
        const arxiv = await arxivMeta(net, declared.arxivId);
        meta = { ...arxiv, url: page.url.href };
      } catch {
        // The page's own title is still a card.
      }
    }
    return await fromScreenshot(deckDir, work, page.url.href, hostOf(page.url.href), { ...meta, kind: 'web' }, options, progress);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function arxivMeta(net: Net, id: string): Promise<PaperMeta> {
  const response = await net.get(arxivApiUrl(id), 'application/atom+xml', MAX_PAGE_BYTES, { allowError: true });
  // A malformed id is answered 400 with an Atom error entry; let the parser word it.
  if (response.status >= 400 && response.status !== 400) throw new HttpError(response.status, `arXiv answered ${response.status}; try again in a moment.`);
  return parseArxivAtom(response.bytes.toString('utf8'), id);
}

async function fromPdfUrl(
  net: Net,
  deckDir: string,
  work: string,
  url: string,
  stem: string,
  what: string,
  meta: PaperMeta & { kind: PaperCard['kind'] },
  options: PaperCardOptions,
  progress: (message: string) => void,
): Promise<PaperCard> {
  progress(`Downloading ${what}`);
  const response = await net.get(url, 'application/pdf', MAX_PDF_BYTES);
  if (!isPdf(response.bytes)) throw new Error(`${hostOf(url)} did not return a PDF.`);
  const pdfPath = join(work, 'paper.pdf');
  await writeFile(pdfPath, response.bytes);
  progress(`Rendering the first page of ${what.replace(/^the PDF (of|from) /, '')}`);
  const png = join(work, `${stemOf(stem)}.png`);
  const page = await (options.renderPdf ?? renderPdfFirstPage)(pdfPath, png);
  return finish(deckDir, png, page, meta, progress);
}

async function fromScreenshot(
  deckDir: string,
  work: string,
  url: string,
  stem: string,
  meta: PaperMeta & { kind: PaperCard['kind'] },
  options: PaperCardOptions,
  progress: (message: string) => void,
): Promise<PaperCard> {
  if (options.blockPrivateAddresses) await assertPublic(new URL(url));
  progress(`Capturing ${hostOf(url)}`);
  const png = join(work, `${stemOf(stem)}.png`);
  let captured: WebCaptureResult;
  try {
    captured = await (options.capture ?? captureWebPage)({
      url, ...PAPER_SCREENSHOT, outPng: png, blockPrivateAddresses: options.blockPrivateAddresses,
    });
  } catch (error) {
    throw new Error(browserFailure(url, error));
  }
  if (captured.status !== null && captured.status >= 400) {
    throw new HttpError(captured.status, `${hostOf(url)} answered ${captured.status} ${statusText(captured.status)}.`);
  }
  if (BOT_CHECK.test(captured.title) || BOT_CHECK.test(meta.title)) throw new Error(botCheckMessage(url));
  // A blank white card is worse than none: script-only and bot-walled pages
  // (many publishers) show nothing to a headless browser.
  if (captured.blank) {
    throw new Error(`${hostOf(url)} showed a blank page to the capture. Paste the paper's arXiv link or PDF instead.`);
  }
  const size = pngSize(await readFile(png));
  const title = meta.title || captured.title || hostOf(url);
  return finish(deckDir, png, size, { ...meta, title }, progress);
}

async function finish(
  deckDir: string,
  png: string,
  size: { width: number; height: number },
  meta: PaperMeta & { kind: PaperCard['kind'] },
  progress: (message: string) => void,
): Promise<PaperCard> {
  progress(`Adding ${basename(png)} to the deck`);
  const imported = await importAsset(deckDir, png);
  return {
    ...meta,
    image: { src: imported.src, width: imported.width ?? size.width, height: imported.height ?? size.height },
  };
}

/** What a bare PDF says about itself: the largest type on its first page beats a document-info title, which is often a file name. */
function pdfMeta(page: PdfFirstPage, fileName: string): PaperMeta {
  const infoTitle = page.title && !/\.(pdf|docx?|tex|dvi)$/i.test(page.title) && !/^untitled/i.test(page.title) ? page.title : null;
  const authors = (page.author ?? '')
    .split(/\s*(?:;|,|\band\b)\s*/i)
    .map((name) => name.trim())
    .filter((name) => name.length > 1);
  return {
    title: page.textTitle ?? infoTitle ?? basename(fileName, extname(fileName)),
    authors,
    venue: null,
    year: null,
    url: null,
  };
}

/* --- network -------------------------------------------------------------- */

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

class Net {
  constructor(private readonly options: PaperCardOptions) {}

  /**
   * GET with every redirect hop held to the same rules (on the server: public
   * addresses only), a timeout, a size cap, and failures worded for a person.
   */
  async get(
    raw: string,
    accept: string,
    maxBytes: number,
    { allowError = false } = {},
  ): Promise<{ bytes: Buffer; url: URL; contentType: string; status: number }> {
    const doFetch = this.options.fetchImpl ?? fetch;
    let url = new URL(raw);
    for (let hop = 0; hop <= 5; hop += 1) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http and https links can be fetched (${url.protocol}).`);
      if (this.options.blockPrivateAddresses) await assertPublic(url);
      let response: Response;
      try {
        response = await doFetch(url.href, {
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { accept, 'user-agent': USER_AGENT },
        });
      } catch (error) {
        throw new Error(networkFailure(url, error));
      }
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url);
        continue;
      }
      if (!response.ok && !allowError) {
        throw new HttpError(response.status, `${url.hostname} answered ${response.status} ${statusText(response.status)} for ${url.href}.`);
      }
      const declared = Number(response.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${url.href} is larger than ${Math.round(maxBytes / 1048576)} MB.`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error(`${url.href} is larger than ${Math.round(maxBytes / 1048576)} MB.`);
      return { bytes, url, contentType: response.headers.get('content-type') ?? '', status: response.status };
    }
    throw new Error(`${raw} redirected too many times.`);
  }
}

async function assertPublic(url: URL): Promise<void> {
  try {
    await assertPublicHost(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Refusing/.test(message)) throw new Error(`${url.hostname} is not a public address; the server only fetches public pages.`);
    throw new Error(networkFailure(url, error));
  }
}

/** A fetch that never got an answer, said in terms someone can act on. */
function networkFailure(url: URL, error: unknown): string {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: string } | null)?.code ?? '';
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT/.test(code)) {
    return `${url.hostname} did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /Could not resolve/.test(String(error))) {
    return `Could not reach ${url.hostname} — is this computer online?`;
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return `Could not connect to ${url.hostname} (${code}).`;
  }
  return `Could not fetch ${url.href}: ${error instanceof Error ? error.message : String(error)}`;
}

/** Chromium's load errors ("ERR_NAME_NOT_RESOLVED (-105) loading …") in the same words. */
function browserFailure(raw: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const host = hostOf(raw);
  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(message)) return `Could not reach ${host} — is this computer online?`;
  if (/ERR_CONNECTION_(REFUSED|RESET|CLOSED|TIMED_OUT)|ERR_TIMED_OUT/.test(message)) return `Could not connect to ${host}.`;
  if (/ERR_BLOCKED_BY_CLIENT/.test(message)) return `${host} is not a public address; the server only fetches public pages.`;
  return `Could not capture ${host}: ${message}`;
}

/** Titles of the interstitials CDNs and publishers show a browser they do not trust. */
const BOT_CHECK = /verifying (?:that )?you|verify(?:ing)? your browser|just a moment|attention required|are you a (?:robot|human)|access denied|captcha|checking your browser/i;

function botCheckMessage(url: string): string {
  return `${hostOf(url)} answered with a bot check instead of the page. Paste the paper's arXiv link, or download the PDF and choose it.`;
}

function statusText(status: number): string {
  return ({ 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 410: 'Gone', 429: 'Too Many Requests', 500: 'Server Error', 502: 'Bad Gateway', 503: 'Unavailable' } as Record<number, string>)[status] ?? '';
}

function describeType(type: string): string {
  if (type.startsWith('image/')) return 'an image';
  if (type.startsWith('video/')) return 'a video';
  if (type.startsWith('audio/')) return 'an audio file';
  if (/zip|tar|gzip|octet-stream/.test(type)) return 'a download';
  return `a ${type} file`;
}

function isPdf(bytes: Uint8Array): boolean {
  // The header may follow a little junk; the spec allows it within the first 1 KB.
  return Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-');
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = Buffer.from(bytes);
  if (view.length < 24 || view.toString('latin1', 1, 4) !== 'PNG') throw new Error('The captured picture is not a PNG.');
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** A file stem the asset importer will keep readable: "arxiv-2003.08934", "doi-10.1145-3503250". */
function stemOf(name: string): string {
  return name.replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'paper';
}
