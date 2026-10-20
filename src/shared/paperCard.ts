import type { Deck, SlideElement } from './deck.js';
import { setBoxShadow } from './shapeShadow.js';

/**
 * Paper cards: a related-work figure made from an arXiv id, a DOI, a project
 * page or a PDF — the paper's first page (or the page's screenshot) with a soft
 * shadow, and its title and "Authors, Venue Year" as editable text.
 *
 * This module is the pure half, shared by the desktop main process, the collab
 * server, the CLI and both editors: what the user typed means, what the
 * metadata services answered means, and where the three objects go. Fetching
 * and rendering live in src/main/paperCard.ts.
 */

/** What the person pasted, once understood. */
export type PaperSource =
  | { kind: 'arxiv'; id: string }
  | { kind: 'doi'; doi: string }
  | { kind: 'url'; url: string };

/** Everything the card's text is made of. Empty fields stay empty: the card says less rather than guess. */
export interface PaperMeta {
  title: string;
  authors: string[];
  /** Short venue name ("ECCV", "ACM TOG", "arXiv"), or null when unknown. */
  venue: string | null;
  year: number | null;
  /** Where the paper lives, for the person and for a later re-fetch. */
  url: string | null;
  /** arXiv's primary category ("cs.CV"), when the paper came from arXiv. */
  category?: string | null;
}

/** A finished card: the picture already in the deck's assets, and its text. */
export interface PaperCard extends PaperMeta {
  /** Which path produced it, so a reply can say what was fetched. */
  kind: 'arxiv' | 'doi' | 'web' | 'pdf';
  image: { src: string; width: number; height: number };
}

/** A card job as the desktop main process, the server and the CLI accept it. */
export type PaperCardJob = { input: string } | { pdfPath: string; name: string };

/** Shown when the input is none of the things a card can be made from. */
export const PAPER_INPUT_HINT = 'Paste an arXiv link or id, a DOI, or a web address — or choose a PDF.';

// New-style ids (2003.08934, 2401.12345v2) and the old archive/number form
// (hep-th/9901001, math.GT/0309136).
const ARXIV_ID = /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i;
const DOI = /^10\.\d{4,9}\/\S+$/;

/**
 * Read what the person pasted. Order matters: an arXiv link and an arXiv DOI
 * (10.48550/arXiv.…) both go to arXiv, whose metadata and PDF are better than
 * anything a landing page offers; any other link is a web page.
 */
export function classifyPaperInput(raw: string): PaperSource | null {
  const text = raw.trim().replace(/^<|>$/g, '');
  if (!text) return null;

  const bareArxiv = text.replace(/^arxiv:\s*/i, '');
  if (ARXIV_ID.test(bareArxiv)) return { kind: 'arxiv', id: bareArxiv };

  const bareDoi = text.replace(/^doi:\s*/i, '');
  if (DOI.test(bareDoi)) return doiSource(bareDoi);

  let url: URL;
  try {
    // "nerf.github.io" is a web address too; only a scheme-less word with a
    // dot in its host gets the https:// it was obviously meant to have.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'arxiv.org' || host === 'export.arxiv.org') {
    const match = /^\/(?:abs|pdf|html|format)\/(.+?)(?:\.pdf)?\/?$/i.exec(url.pathname);
    if (match && ARXIV_ID.test(match[1])) return { kind: 'arxiv', id: match[1] };
  }
  if (host === 'doi.org' || host === 'dx.doi.org') {
    const doi = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (DOI.test(doi)) return doiSource(doi);
  }
  return { kind: 'url', url: url.href };
}

function doiSource(doi: string): PaperSource {
  // arXiv mints DOIs for every paper; its own API knows more than Crossref does.
  const arxiv = /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
  if (arxiv && ARXIV_ID.test(arxiv[1])) return { kind: 'arxiv', id: arxiv[1] };
  return { kind: 'doi', doi };
}

/* --- arXiv ---------------------------------------------------------------- */

/** arXiv's own answer for a missing paper or a malformed id. */
export class PaperNotFoundError extends Error {}

/**
 * One paper from the arXiv API's Atom feed
 * (`https://export.arxiv.org/api/query?id_list=…`).
 *
 * The feed is small and regular, so it is read with patterns rather than an
 * XML parser — the server and the CLI have no DOM. An unknown id comes back as
 * an empty feed, a malformed one as an entry titled "Error"; both throw
 * PaperNotFoundError with something a person can act on.
 */
export function parseArxivAtom(xml: string, requestedId: string): PaperMeta {
  const entry = /<entry\b[^>]*>([\s\S]*?)<\/entry>/i.exec(xml)?.[1];
  if (!entry) throw new PaperNotFoundError(`arXiv has no paper ${requestedId}.`);
  const id = xmlText(tag(entry, 'id'));
  if (/\/api\/errors/i.test(id)) {
    throw new PaperNotFoundError(`"${requestedId}" is not an arXiv id (${xmlText(tag(entry, 'summary')) || 'arXiv refused it'}).`);
  }
  const title = collapse(xmlText(tag(entry, 'title')));
  if (!title) throw new PaperNotFoundError(`arXiv has no paper ${requestedId}.`);

  const authors = [...entry.matchAll(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
    .map((match) => collapse(xmlText(match[1])))
    .filter(Boolean);
  const published = Number(/^(\d{4})/.exec(xmlText(tag(entry, 'published')))?.[1]) || null;
  const journalRef = collapse(xmlText(tag(entry, 'arxiv:journal_ref')));
  const comment = collapse(xmlText(tag(entry, 'arxiv:comment')));
  const category = /<arxiv:primary_category\b[^>]*\bterm="([^"]+)"/i.exec(entry)?.[1] ?? null;
  const abs = /<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/i.exec(entry)?.[1]
    ?? /<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="alternate"/i.exec(entry)?.[1]
    ?? `https://arxiv.org/abs/${requestedId}`;

  // A journal reference is the published venue; failing that, authors
  // routinely announce acceptance in the comment ("ECCV 2020 (oral)").
  const venue = (journalRef ? shortVenue(journalRef) : null) ?? (comment ? venueInComment(comment) : null);
  return {
    title,
    authors,
    venue: venue?.name ?? 'arXiv',
    year: venue?.year ?? published,
    url: abs.replace(/^http:/, 'https:'),
    category,
  };
}

/** The PDF link for an arXiv id. */
export function arxivPdfUrl(id: string): string {
  return `https://arxiv.org/pdf/${id}`;
}

/** The API query for one arXiv id. */
export function arxivApiUrl(id: string): string {
  return `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`;
}

/** An exact-phrase title search, for finding a published paper's arXiv version. */
export function arxivTitleSearchUrl(title: string): string {
  const phrase = title.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`ti:"${phrase}"`)}&max_results=5`;
}

/**
 * The arXiv id of the search result whose title is `title` (ignoring case,
 * spacing and punctuation), or null. A near miss is not the same paper.
 */
export function arxivIdForTitle(xml: string, title: string): string | null {
  const key = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const wanted = key(title);
  if (!wanted) return null;
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const id = /arxiv\.org\/abs\/([^<\s]+?)(?:v\d+)?\s*$/i.exec(xmlText(tag(match[1], 'id')))?.[1];
    if (id && key(xmlText(tag(match[1], 'title'))) === wanted) return id;
  }
  return null;
}

/* --- Crossref ------------------------------------------------------------- */

interface CrossrefAuthor { given?: string; family?: string; name?: string }
interface CrossrefWork {
  title?: string[];
  subtitle?: string[];
  author?: CrossrefAuthor[];
  'container-title'?: string[];
  'short-container-title'?: string[];
  event?: { name?: string } | null;
  issued?: { 'date-parts'?: Array<Array<number | null>> };
  published?: { 'date-parts'?: Array<Array<number | null>> };
  'published-print'?: { 'date-parts'?: Array<Array<number | null>> };
  type?: string;
  URL?: string;
  resource?: { primary?: { URL?: string } };
  link?: Array<{ URL?: string; 'content-type'?: string }>;
}

/** Crossref's metadata for one DOI, plus where its landing page and any PDF are. */
export interface CrossrefPaper extends PaperMeta {
  landingUrl: string;
  /** Links Crossref lists as PDFs. Often paywalled; the caller tries them and falls back. */
  pdfUrls: string[];
}

/** One work from `https://api.crossref.org/works/<doi>`. */
export function parseCrossref(json: unknown, doi: string): CrossrefPaper {
  const work = (json as { message?: CrossrefWork } | null)?.message;
  if (!work || typeof work !== 'object') throw new PaperNotFoundError(`Crossref has no record of DOI ${doi}.`);
  const main = collapse(stripTags(work.title?.[0] ?? ''));
  const subtitle = collapse(stripTags(work.subtitle?.[0] ?? ''));
  // "NeRF" with the subtitle "representing scenes as …" is one title to a reader.
  const title = subtitle && !main.toLowerCase().includes(subtitle.toLowerCase())
    ? `${main}: ${subtitle.charAt(0).toUpperCase()}${subtitle.slice(1)}`
    : main;
  const authors = (work.author ?? [])
    .map((author) => collapse(author.name ?? [author.given, author.family].filter(Boolean).join(' ')))
    .filter(Boolean);
  const year = firstYear(work.issued) ?? firstYear(work['published-print']) ?? firstYear(work.published);
  const containers = [
    ...(work['short-container-title'] ?? []),
    ...(work['container-title'] ?? []),
    ...(work.event?.name ? [work.event.name] : []),
  ].map((name) => collapse(stripTags(name))).filter(Boolean);
  const venue = containers.map((name) => shortVenue(name)).find((found) => found !== null) ?? null;
  const landingUrl = work.resource?.primary?.URL ?? work.URL ?? `https://doi.org/${doi}`;
  const pdfUrls = (work.link ?? [])
    .filter((link) => link.URL && /pdf/i.test(link['content-type'] ?? ''))
    .map((link) => link.URL!)
    .filter((url, index, all) => all.indexOf(url) === index);
  return {
    title: title || doi,
    authors,
    venue: venue?.name ?? null,
    year: venue?.year ?? year,
    url: `https://doi.org/${doi}`,
    landingUrl,
    pdfUrls,
  };
}

function firstYear(date: { 'date-parts'?: Array<Array<number | null>> } | undefined): number | null {
  const year = date?.['date-parts']?.[0]?.[0];
  return typeof year === 'number' && year > 1000 ? year : null;
}

/* --- web pages ------------------------------------------------------------ */

/** What a web page says about itself, and the papers it points at. */
export interface PageMeta extends PaperMeta {
  /** `citation_pdf_url`, when the page names its PDF. */
  pdfUrl: string | null;
  /** The arXiv paper the page links to most, for a project page with no citation tags. */
  arxivId: string | null;
}

/**
 * The title, authors and venue a page declares: Highwire `citation_*` tags
 * (Google Scholar's convention, on arXiv, OpenReview, most publishers and many
 * project pages), then Open Graph, then `<title>`.
 */
export function parseHtmlMeta(html: string, pageUrl: string): PageMeta {
  const head = html.slice(0, 400_000);
  const metas: Array<{ key: string; content: string }> = [];
  for (const match of head.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = attributes(match[1]);
    const key = (attrs.name ?? attrs.property ?? attrs.itemprop ?? '').toLowerCase();
    if (key && attrs.content !== undefined) metas.push({ key, content: collapse(decodeEntities(attrs.content)) });
  }
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const found = metas.find((meta) => meta.key === key && meta.content);
      if (found) return found.content;
    }
    return null;
  };
  const pageTitle = collapse(decodeEntities(stripTags(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '')));
  const title = first('citation_title', 'dc.title', 'og:title', 'twitter:title') ?? pageTitle;
  const authors = metas
    .filter((meta) => meta.key === 'citation_author' || meta.key === 'dc.creator')
    .map((meta) => personName(meta.content))
    .filter(Boolean);
  const dated = first('citation_publication_date', 'citation_date', 'citation_online_date', 'dc.date');
  const year = Number(/(\d{4})/.exec(dated ?? '')?.[1]) || null;
  const container = first('citation_conference_title', 'citation_journal_title', 'citation_conference', 'citation_journal_abbrev');
  const venue = container ? shortVenue(container) : null;
  let pdfUrl = first('citation_pdf_url');
  try {
    if (pdfUrl) pdfUrl = new URL(pdfUrl, pageUrl).href;
  } catch {
    pdfUrl = null;
  }
  return {
    title,
    authors,
    venue: venue?.name ?? null,
    year: venue?.year ?? year,
    url: pageUrl,
    pdfUrl,
    arxivId: first('citation_arxiv_id') ?? linkedArxivId(html),
  };
}

/** The arXiv paper a page links to most often (a project page's "Paper" button). */
function linkedArxivId(html: string): string | null {
  const counts = new Map<string, number>();
  for (const match of html.matchAll(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v\d+)?/gi)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [id, count] of counts) if (best === null || count > counts.get(best)!) best = id;
  return best;
}

function attributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

/** "Mildenhall, Ben" (the Highwire convention) reads as "Ben Mildenhall". */
function personName(raw: string): string {
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  return collapse(parts.length === 2 ? `${parts[1]} ${parts[0]}` : raw);
}

/* --- venues --------------------------------------------------------------- */

const VENUE_ACRONYMS = [
  'SIGGRAPH Asia', 'SIGGRAPH', 'CVPR', 'ICCV', 'ECCV', 'NeurIPS', 'NIPS', 'ICML', 'ICLR', 'AAAI', 'IJCAI',
  '3DV', 'WACV', 'BMVC', 'ACCV', 'CoRL', 'RSS', 'ICRA', 'IROS', 'ACL', 'EMNLP', 'NAACL', 'COLING', 'KDD',
  'AISTATS', 'UAI', 'COLT', 'MICCAI', 'CHI', 'UIST', 'ISMAR', 'TPAMI', 'TVCG', 'TOG', 'IJCV', 'JMLR',
  'TMLR', 'Eurographics', 'EGSR', 'HPG', 'I3D', 'SCA', 'Pacific Graphics',
];
const ACRONYM_PATTERN = VENUE_ACRONYMS
  .map((name) => name.replace(/ /g, '\\s+'))
  .join('|');

/** Long journal names people shorten on slides. */
const LONG_VENUES: Array<[RegExp, string]> = [
  [/ACM\s+Trans(?:actions|\.)\s+(?:on\s+)?Graph(?:ics|\.)/i, 'ACM TOG'],
  [/Pattern\s+Analysis\s+and\s+Machine\s+Intelligence/i, 'TPAMI'],
  [/International\s+Journal\s+of\s+Computer\s+Vision/i, 'IJCV'],
  [/Visualization\s+and\s+Computer\s+Graphics/i, 'TVCG'],
  [/Journal\s+of\s+Machine\s+Learning\s+Research/i, 'JMLR'],
  [/Transactions\s+on\s+Machine\s+Learning\s+Research/i, 'TMLR'],
  [/Computer\s+Graphics\s+Forum/i, 'CGF'],
  [/Commun(?:ications|\.)\s+(?:of\s+the\s+)?ACM/i, 'CACM'],
  [/Neural\s+Information\s+Processing\s+Systems/i, 'NeurIPS'],
  [/Computer\s+Vision\s+and\s+Pattern\s+Recognition/i, 'CVPR'],
  [/International\s+Conference\s+on\s+Computer\s+Vision/i, 'ICCV'],
  [/European\s+Conference\s+on\s+Computer\s+Vision/i, 'ECCV'],
  [/International\s+Conference\s+on\s+Machine\s+Learning/i, 'ICML'],
  [/International\s+Conference\s+on\s+Learning\s+Representations/i, 'ICLR'],
];

/**
 * A venue as a slide would name it, with the year when the name carries one:
 * "2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)" →
 * CVPR 2016, "ACM Transactions on Graphics, volume 42(4), July 2023" → ACM TOG
 * 2023. Anything unrecognised keeps its own name up to the first comma.
 */
export function shortVenue(raw: string): { name: string; year: number | null } | null {
  const text = collapse(raw);
  if (!text) return null;
  const year = Number(/\b((?:19|20)\d{2})\b/.exec(text)?.[1]) || null;
  const parenthesised = /\(([A-Z][A-Za-z0-9-]{1,11})(?:\s*'?\d{2,4})?\)/.exec(text)?.[1];
  if (parenthesised && !/^(Oral|Poster|Spotlight)$/i.test(parenthesised)) return { name: parenthesised, year };
  const acronym = new RegExp(`\\b(${ACRONYM_PATTERN})\\b`).exec(text)?.[1];
  if (acronym) return { name: acronym.replace(/\s+/g, ' ').replace(/^NIPS$/, 'NeurIPS'), year };
  const long = LONG_VENUES.find(([pattern]) => pattern.test(text));
  if (long) return { name: long[1], year };
  const name = text
    .split(',')[0]
    .replace(/^(?:\d{4}\s+)?(?:Proceedings\s+of\s+(?:the\s+)?)?/i, '')
    .replace(/\s+(?:19|20)\d{2}$/, '')
    .trim();
  return name ? { name, year } : null;
}

/**
 * A venue announced in an arXiv comment. "Accepted to CVPR 2024" counts;
 * "Submitted to CVPR" and "under review at NeurIPS" do not.
 */
function venueInComment(comment: string): { name: string; year: number | null } | null {
  const pattern = new RegExp(`(^|[^A-Za-z])(${ACRONYM_PATTERN})(?:\\s*'?((?:19|20)?\\d{2}))?\\b`, 'g');
  for (const match of comment.matchAll(pattern)) {
    const before = comment.slice(Math.max(0, (match.index ?? 0) - 30), match.index ?? 0);
    if (/(submitted|under\s+review|in\s+submission|rejected|review)\W*(to|at|for)?\W*$/i.test(before)) continue;
    const digits = match[3];
    const year = digits ? Number(digits.length === 2 ? `20${digits}` : digits) : null;
    return { name: match[2].replace(/\s+/g, ' ').replace(/^NIPS$/, 'NeurIPS'), year };
  }
  return null;
}

/* --- the byline ----------------------------------------------------------- */

/**
 * Authors as a slide lists them: everyone up to three ("A, B and C"), the
 * first author and "et al." beyond that.
 */
export function formatAuthors(authors: string[]): string {
  const names = authors.map(collapse).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length > 3) return `${names[0]} et al.`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Authors, Venue Year", saying only what is known; the host name when nothing is. */
export function paperByline(meta: Pick<PaperMeta, 'authors' | 'venue' | 'year' | 'url'>): string {
  const venueYear = [meta.venue, meta.year].filter((part) => part !== null && part !== '').join(' ');
  const byline = [formatAuthors(meta.authors), venueYear].filter(Boolean).join(', ');
  if (byline) return byline;
  try {
    return meta.url ? new URL(meta.url).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

/* --- layout --------------------------------------------------------------- */

/** How a card's picture is dressed: a small radius and a soft shadow, like a print on the table. */
export const PAPER_CARD_RADIUS = 6;
export const PAPER_CARD_SHADOW = { x: 0, y: 10, blur: 32, color: 'rgba(0, 0, 0, 0.18)' };

/** Fraction of a PDF's first page kept: title, authors and abstract read at slide size. */
export const PAPER_PAGE_CROP = 0.55;
/** Pixel width a first page is rendered at, and the size a web page is captured at (16:10). */
export const PAPER_RENDER_WIDTH = 1600;
export const PAPER_SCREENSHOT = { width: 1440, height: 900 };

export interface PaperCardPlacement {
  canvas: Deck['canvas'];
  themeStyle: Deck['themeStyle'];
  /** Centre of the card; the canvas centre when absent. */
  center?: { x: number; y: number };
  /** z of the picture; the two text boxes stack just above it. */
  z: number;
  makeId: (prefix: string) => string;
}

/**
 * The card as three ordinary objects — picture, bold title, muted byline —
 * stacked in one column and centred where asked. The deck has no groups, so
 * the caller selects all three; they move together until deselected.
 *
 * Type comes from the theme's roles (body for the title, caption for the
 * byline, which the theme already mutes); only the title's weight is the
 * card's own. Box heights are estimated from the role sizes and the text
 * shrinks to fit if an unusually long title would overflow them.
 */
export function paperCardElements(card: PaperCard, placement: PaperCardPlacement): SlideElement[] {
  const { canvas } = placement;
  const fonts = placement.themeStyle?.fonts;
  const body = { size: fonts?.body.size ?? 32, lineHeight: fonts?.body.lineHeight ?? 1.25 };
  const caption = { size: fonts?.caption.size ?? 24, lineHeight: fonts?.caption.lineHeight ?? 1.3 };
  const byline = paperByline(card);

  const aspect = card.image.width > 0 && card.image.height > 0 ? card.image.height / card.image.width : 0.625;
  let w = Math.round(Math.min(800, canvas.w * 0.42));
  const lines = (text: string, size: number, max: number) =>
    Math.max(1, Math.min(max, Math.ceil((text.length * size * 0.52) / w)));
  const titleLines = lines(card.title, body.size, 3);
  const bylineLines = lines(byline, caption.size, 2);
  const titleH = Math.ceil(titleLines * body.size * body.lineHeight);
  const bylineH = Math.ceil(bylineLines * caption.size * caption.lineHeight);
  const gap = Math.round(body.size * 0.75);
  // A tall picture (a whole portrait page) narrows the card rather than run off the slide.
  const textH = gap + titleH + 6 + bylineH;
  const maxImageH = canvas.h * 0.9 - textH;
  if (w * aspect > maxImageH) w = Math.max(240, Math.round(maxImageH / aspect));
  const imageH = Math.round(w * aspect);
  const totalH = imageH + textH;

  const center = placement.center ?? { x: canvas.w / 2, y: canvas.h / 2 };
  const x = Math.round(Math.min(Math.max(0, center.x - w / 2), canvas.w - w));
  const y = Math.round(Math.min(Math.max(0, center.y - totalH / 2), Math.max(0, canvas.h - totalH)));

  const imageStyle: Record<string, string> = {};
  setBoxShadow(imageStyle, PAPER_CARD_SHADOW);
  const base = { rot: 0, opacity: 1, morphId: null } as const;
  return [
    {
      ...base,
      id: placement.makeId('image'),
      type: 'image',
      x, y, w, h: imageH, z: placement.z,
      class: [], style: imageStyle,
      src: card.image.src,
      fit: 'cover',
      alt: card.title,
      borderRadius: PAPER_CARD_RADIUS,
      sourceBox: null,
    },
    {
      ...base,
      id: placement.makeId('text'),
      type: 'text',
      x, y: y + imageH + gap, w, h: titleH, z: placement.z + 1,
      class: ['role-body'], style: { 'font-weight': '700' }, overrides: ['font-weight'],
      html: escapeHtml(card.title),
      align: 'left', valign: 'top', autoFit: true,
    },
    {
      ...base,
      id: placement.makeId('text'),
      type: 'text',
      x, y: y + imageH + gap + titleH + 6, w, h: bylineH, z: placement.z + 2,
      class: ['role-caption'], style: {},
      html: escapeHtml(byline),
      align: 'left', valign: 'top', autoFit: true,
    },
  ] as SlideElement[];
}

/**
 * The same card as authoring HTML, for `slide-agent paper`: a figure whose
 * flex column the compile bakes into the three objects the editor inserts.
 */
export function paperCardHtml(card: PaperCard, width = 800): string {
  const shadow: Record<string, string> = {};
  setBoxShadow(shadow, PAPER_CARD_SHADOW);
  return `<figure style="width: ${width}px; margin: 0; display: flex; flex-direction: column; gap: 6px;">\n`
    + `  <img src="${escapeHtml(card.image.src)}" alt="${escapeHtml(card.title)}"`
    + ` style="width: 100%; aspect-ratio: ${card.image.width} / ${card.image.height}; object-fit: cover;`
    + ` border-radius: ${PAPER_CARD_RADIUS}px; box-shadow: ${shadow['box-shadow']}; margin-bottom: 18px;">\n`
    + `  <p class="role-body" style="font-weight: 700;">${escapeHtml(card.title)}</p>\n`
    + `  <p class="role-caption">${escapeHtml(paperByline(card))}</p>\n`
    + '</figure>';
}

/* --- text helpers --------------------------------------------------------- */

function tag(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)</${escaped}>`, 'i').exec(source)?.[1] ?? '';
}

function xmlText(source: string): string {
  return decodeEntities(source.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
}

function stripTags(source: string): string {
  return source.replace(/<[^>]*>/g, ' ');
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', middot: '·',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
