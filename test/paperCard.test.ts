import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml } from '../src/shared/htmlSlides.js';
import {
  PaperNotFoundError,
  arxivIdForTitle,
  arxivTitleSearchUrl,
  classifyPaperInput,
  formatAuthors,
  paperByline,
  paperCardElements,
  parseArxivAtom,
  parseCrossref,
  parseHtmlMeta,
  shortVenue,
  type PaperCard,
} from '../src/shared/paperCard.js';
import { fetchPaperCard, pngSize } from '../src/main/paperCard.js';
import { renderPdfFirstPage } from '../src/main/pdfFirstPage.js';

/**
 * Paper cards: what a pasted id means, what arXiv, Crossref and web pages
 * answer (recorded in test/fixtures/paper on 2026-10-08, so nothing here needs
 * the network), how the byline reads, and where the three objects land.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures/paper');
const fixture = (name: string) => readFile(join(FIXTURES, name), 'utf8');

describe('what the person pasted', () => {
  it('reads arXiv ids and links of every shape', () => {
    for (const input of [
      '2003.08934', 'arXiv:2003.08934v2', 'https://arxiv.org/abs/2003.08934v2', 'arxiv.org/pdf/2003.08934',
      'https://arxiv.org/pdf/2003.08934v2.pdf', 'https://export.arxiv.org/abs/2003.08934', 'https://www.arxiv.org/html/2003.08934',
    ]) {
      expect(classifyPaperInput(input), input).toMatchObject({ kind: 'arxiv', id: expect.stringMatching(/^2003\.08934/) });
    }
    expect(classifyPaperInput('hep-th/9901001')).toEqual({ kind: 'arxiv', id: 'hep-th/9901001' });
  });

  it('reads DOIs, and sends arXiv DOIs to arXiv', () => {
    expect(classifyPaperInput('10.1145/3503250')).toEqual({ kind: 'doi', doi: '10.1145/3503250' });
    expect(classifyPaperInput('doi:10.1109/CVPR.2016.90')).toEqual({ kind: 'doi', doi: '10.1109/CVPR.2016.90' });
    expect(classifyPaperInput('https://doi.org/10.1145/3503250')).toEqual({ kind: 'doi', doi: '10.1145/3503250' });
    expect(classifyPaperInput('https://doi.org/10.48550/arXiv.2003.08934')).toEqual({ kind: 'arxiv', id: '2003.08934' });
  });

  it('takes any other web address as a page, and refuses what is none of these', () => {
    expect(classifyPaperInput('nerf.github.io')).toEqual({ kind: 'url', url: 'https://nerf.github.io/' });
    expect(classifyPaperInput('https://openreview.net/forum?id=abc')).toMatchObject({ kind: 'url' });
    expect(classifyPaperInput('')).toBeNull();
    expect(classifyPaperInput('neural radiance fields')).toBeNull();
    expect(classifyPaperInput('ftp://example.com/paper.pdf')).toBeNull();
  });
});

describe('arXiv Atom', () => {
  it('reads title, authors, the venue from the comment, year and category', async () => {
    const meta = parseArxivAtom(await fixture('arxiv-2003.08934.xml'), '2003.08934');
    expect(meta).toEqual({
      title: 'NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis',
      authors: ['Ben Mildenhall', 'Pratul P. Srinivasan', 'Matthew Tancik', 'Jonathan T. Barron', 'Ravi Ramamoorthi', 'Ren Ng'],
      venue: 'ECCV',
      year: 2020,
      url: 'https://arxiv.org/abs/2003.08934v2',
      category: 'cs.CV',
    });
  });

  it('prefers the journal reference, shortened', async () => {
    const meta = parseArxivAtom(await fixture('arxiv-2308.04079.xml'), '2308.04079');
    expect(meta).toMatchObject({ title: '3D Gaussian Splatting for Real-Time Radiance Field Rendering', venue: 'ACM TOG', year: 2023 });
  });

  it('says plainly when there is no such paper, or no such id', async () => {
    expect(() => parseArxivAtom('', '2401.99999')).toThrow(PaperNotFoundError);
    expect(() => parseArxivAtom('<feed></feed>', 'x')).toThrow(/arXiv has no paper/);
    const missing = await fixture('arxiv-missing.xml');
    expect(() => parseArxivAtom(missing, '2401.99999')).toThrow('arXiv has no paper 2401.99999.');
    const bad = await fixture('arxiv-bad-id.xml');
    expect(() => parseArxivAtom(bad, 'notanid')).toThrow(/"notanid" is not an arXiv id \(incorrect id format/);
  });

  it('falls back to "arXiv" and the submission year when no venue is announced', () => {
    const xml = '<feed><entry><id>http://arxiv.org/abs/1512.03385v1</id><title>Deep Residual\n  Learning</title>'
      + '<published>2015-12-10T19:51:55Z</published><arxiv:comment>Submitted to CVPR 2016</arxiv:comment>'
      + '<author><name>Kaiming He</name></author></entry></feed>';
    expect(parseArxivAtom(xml, '1512.03385')).toMatchObject({ title: 'Deep Residual Learning', venue: 'arXiv', year: 2015 });
  });
});

describe('finding a published paper on arXiv', () => {
  it('searches by exact title phrase and accepts only an exact match', async () => {
    expect(arxivTitleSearchUrl('NeRF: Neural Radiance-Fields')).toBe(
      'https://export.arxiv.org/api/query?search_query=ti%3A%22NeRF%20Neural%20Radiance%20Fields%22&max_results=5');
    const xml = await fixture('arxiv-search-resnet.xml');
    expect(arxivIdForTitle(xml, 'Deep residual learning for image recognition.')).toBe('1512.03385');
    expect(arxivIdForTitle(xml, 'Deep Residual Learning')).toBeNull();
    expect(arxivIdForTitle(await fixture('arxiv-missing.xml'), 'Anything')).toBeNull();
  });
});

describe('Crossref', () => {
  it('joins title and subtitle, names the journal as slides do, and lists PDF links', async () => {
    const paper = parseCrossref(JSON.parse(await fixture('crossref-10.1145-3503250.json')), '10.1145/3503250');
    expect(paper).toMatchObject({
      title: 'NeRF: Representing scenes as neural radiance fields for view synthesis',
      venue: 'CACM',
      year: 2021,
      url: 'https://doi.org/10.1145/3503250',
      landingUrl: 'https://dl.acm.org/doi/10.1145/3503250',
      pdfUrls: ['https://dl.acm.org/doi/pdf/10.1145/3503250'],
    });
    expect(paper.authors.slice(0, 2)).toEqual(['Ben Mildenhall', 'Pratul P. Srinivasan']);
  });

  it('takes a proceedings acronym out of its long name', async () => {
    const paper = parseCrossref(JSON.parse(await fixture('crossref-10.1109-CVPR.2016.90.json')), '10.1109/CVPR.2016.90');
    expect(paper).toMatchObject({ title: 'Deep Residual Learning for Image Recognition', venue: 'CVPR', year: 2016 });
    expect(paperByline(paper)).toBe('Kaiming He et al., CVPR 2016');
  });

  it('refuses an answer with no work in it', () => {
    expect(() => parseCrossref({ status: 'ok' }, '10.1/x')).toThrow('Crossref has no record of DOI 10.1/x.');
  });
});

describe('web pages', () => {
  it('reads Highwire citation tags, turning "Family, Given" around', async () => {
    const meta = parseHtmlMeta(await fixture('arxiv-abs-2003.08934.html'), 'https://arxiv.org/abs/2003.08934');
    expect(meta).toMatchObject({
      title: 'NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis',
      year: 2020,
      pdfUrl: 'https://arxiv.org/pdf/2003.08934',
      arxivId: '2003.08934',
    });
    expect(meta.authors).toEqual(['Ben Mildenhall', 'Pratul P. Srinivasan', 'Matthew Tancik', 'Jonathan T. Barron', 'Ravi Ramamoorthi', 'Ren Ng']);
  });

  it('takes a project page’s og:title and finds the paper it links to', async () => {
    const meta = parseHtmlMeta(await fixture('project-page-nerf.html'), 'https://www.matthewtancik.com/nerf');
    expect(meta).toMatchObject({ title: 'NeRF: Neural Radiance Fields', authors: [], arxivId: '2003.08934', pdfUrl: null });
  });

  it('falls back to <title>, decoding entities', () => {
    const meta = parseHtmlMeta('<html><head><title>Fast &amp; Furious &#8212; Lab</title></head></html>', 'https://lab.example/');
    expect(meta.title).toBe('Fast & Furious — Lab');
  });
});

describe('the byline', () => {
  it('lists up to three authors, then the first author et al.', () => {
    expect(formatAuthors([])).toBe('');
    expect(formatAuthors(['Ada Lovelace'])).toBe('Ada Lovelace');
    expect(formatAuthors(['Ada Lovelace', 'Alan Turing'])).toBe('Ada Lovelace and Alan Turing');
    expect(formatAuthors(['A One', 'B Two', 'C Three'])).toBe('A One, B Two and C Three');
    expect(formatAuthors(['A One', 'B Two', 'C Three', 'D Four'])).toBe('A One et al.');
  });

  it('reads "Authors, Venue Year" and says only what is known', () => {
    expect(paperByline({ authors: ['A One', 'B Two', 'C Three', 'D Four'], venue: 'ECCV', year: 2020, url: null })).toBe('A One et al., ECCV 2020');
    expect(paperByline({ authors: ['A One'], venue: null, year: 2021, url: null })).toBe('A One, 2021');
    expect(paperByline({ authors: [], venue: 'CVPR', year: 2016, url: null })).toBe('CVPR 2016');
    expect(paperByline({ authors: [], venue: null, year: null, url: 'https://www.nerf.example/x' })).toBe('nerf.example');
  });

  it('shortens venues the way slides name them', () => {
    expect(shortVenue('2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)')).toEqual({ name: 'CVPR', year: 2016 });
    expect(shortVenue('ACM Transactions on Graphics, volume 42(4), July 2023')).toEqual({ name: 'ACM TOG', year: 2023 });
    expect(shortVenue('Advances in Neural Information Processing Systems 33')).toEqual({ name: 'NeurIPS', year: null });
    expect(shortVenue('Proceedings of the Royal Society A, 2019')).toEqual({ name: 'Royal Society A', year: 2019 });
  });
});

const CARD: PaperCard = {
  kind: 'arxiv',
  title: 'NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis',
  authors: ['Ben Mildenhall', 'Pratul P. Srinivasan', 'Matthew Tancik', 'Jonathan T. Barron'],
  venue: 'ECCV',
  year: 2020,
  url: 'https://arxiv.org/abs/2003.08934v2',
  image: { src: 'assets/arxiv-2003.08934.1a2b3c4d.png', width: 1600, height: 1138 },
};

describe('the card on the slide', () => {
  const deck = emptyDeck();
  let n = 0;
  const place = () => paperCardElements(CARD, { canvas: deck.canvas, themeStyle: deck.themeStyle, z: 5, makeId: (p) => `${p}-${++n}` });

  it('is a shadowed, rounded picture over a bold title and a caption byline, centred', () => {
    const [image, title, byline] = place();
    expect(image).toMatchObject({
      type: 'image', src: CARD.image.src, fit: 'cover', borderRadius: 6, z: 5, alt: CARD.title,
      style: { 'box-shadow': '0px 10px 32px rgba(0, 0, 0, 0.18)' },
    });
    expect(image.h / image.w).toBeCloseTo(1138 / 1600, 2);
    expect(title).toMatchObject({ type: 'text', class: ['role-body'], style: { 'font-weight': '700' }, overrides: ['font-weight'], z: 6, autoFit: true });
    expect(byline).toMatchObject({ type: 'text', class: ['role-caption'], html: 'Ben Mildenhall et al., ECCV 2020', z: 7 });
    // One column: same left edge and width, stacked without overlap.
    for (const element of [title, byline]) expect([element.x, element.w]).toEqual([image.x, image.w]);
    expect(title.y).toBeGreaterThan(image.y + image.h);
    expect(byline.y).toBeGreaterThanOrEqual(title.y + title.h);
    const top = image.y;
    const bottom = byline.y + byline.h;
    expect(Math.abs((top + bottom) / 2 - deck.canvas.h / 2)).toBeLessThan(2);
    expect(Math.abs(image.x + image.w / 2 - deck.canvas.w / 2)).toBeLessThan(1);
  });

  it('narrows for a tall picture rather than run off the slide', () => {
    const [image, , byline] = paperCardElements({ ...CARD, image: { ...CARD.image, width: 1000, height: 1400 } },
      { canvas: deck.canvas, themeStyle: deck.themeStyle, z: 1, makeId: (p) => `${p}-${++n}` });
    expect(image.y).toBeGreaterThanOrEqual(0);
    expect(byline.y + byline.h).toBeLessThanOrEqual(deck.canvas.h);
    expect(image.h / image.w).toBeCloseTo(1.4, 2);
  });

  it('escapes the text it writes', () => {
    const [, title] = paperCardElements({ ...CARD, title: 'A <b> & C' },
      { canvas: deck.canvas, themeStyle: null, z: 1, makeId: (p) => `${p}-${++n}` });
    expect(title.type === 'text' && title.html).toBe('A &lt;b&gt; &amp; C');
  });

  it('keeps its shadow and radius through the HTML authoring round trip', () => {
    const elements = place();
    const slide = { ...deck.slides[0], elements };
    const html = slideToHtml(slide, deck.canvas);
    expect(html).toContain('box-shadow:0px 10px 32px rgba(0, 0, 0, 0.18)');
    expect(html).toContain('data-border-radius="6"');
    const image = elements[0] as Extract<SlideElement, { type: 'image' }>;
    const back = elementFromNode({
      tag: 'img', elementId: image.id, classes: [], rotation: 0, opacity: 1, html: '',
      rect: { x: image.x, y: image.y, w: image.w, h: image.h },
      dataset: { borderRadius: '6' },
      style: { 'box-shadow': image.style['box-shadow'], 'border-radius': '6px', overflow: 'hidden' },
      attrs: { src: image.src, alt: image.alt, objectFit: 'cover' },
    }, image.id, image.z);
    expect(back).toMatchObject({ type: 'image', borderRadius: 6, style: { 'box-shadow': image.style['box-shadow'] } });
  });
});

/* --- the job, with the network replaced by recorded answers ----------------- */

const PYTHON = join(process.cwd(), '.venv-import/bin/python');
const pythonHasPdf = existsSync(PYTHON) && spawnSync(PYTHON, ['-c', 'import pymupdf'], { stdio: 'ignore' }).status === 0;

/** A plain white PNG, as a page capture would write. */
function whitePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y += 1) rows[y * (width * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type Route = { status?: number; type?: string; body: string | Buffer };
function fakeFetch(routes: Record<string, Route | (() => never)>): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix))?.[1];
    if (!route) return new Response('not found', { status: 404 });
    if (typeof route === 'function') return route();
    return new Response(typeof route.body === 'string' ? route.body : new Uint8Array(route.body), { status: route.status ?? 200, headers: { 'content-type': route.type ?? 'text/html' } });
  }) as typeof fetch;
}

describe('making a card', () => {
  let deckDir = '';
  afterEach(async () => {
    if (deckDir) await rm(deckDir, { recursive: true, force: true });
    deckDir = '';
  });

  it('turns a project page into a screenshot with the linked arXiv paper’s metadata', async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'paper-card-'));
    const phases: string[] = [];
    const card = await fetchPaperCard(deckDir, { input: 'https://www.matthewtancik.com/nerf' }, {
      onProgress: (message) => phases.push(message),
      fetchImpl: fakeFetch({
        'https://www.matthewtancik.com/nerf': { body: await fixture('project-page-nerf.html') },
        'https://export.arxiv.org/api/query': { type: 'application/atom+xml', body: await fixture('arxiv-2003.08934.xml') },
      }),
      capture: async (request) => {
        expect(request).toMatchObject({ width: 1440, height: 900 });
        await writeFile(request.outPng, whitePng(1440, 900));
        return { finalUrl: request.url, status: 200, title: 'NeRF', blank: false };
      },
    });
    expect(card).toMatchObject({
      kind: 'web', venue: 'ECCV', year: 2020, url: 'https://www.matthewtancik.com/nerf',
      title: 'NeRF: Representing Scenes as Neural Radiance Fields for View Synthesis',
      image: { src: expect.stringMatching(/^assets\/matthewtancik\.com\.[0-9a-f]{8}\.png$/), width: 1440, height: 900 },
    });
    expect(existsSync(join(deckDir, card.image.src))).toBe(true);
    expect(phases).toEqual([
      'Opening matthewtancik.com',
      'Looking up arXiv:2003.08934, linked from matthewtancik.com',
      'Capturing matthewtancik.com',
      expect.stringMatching(/^Adding matthewtancik\.com\.png to the deck$/),
    ]);
  });

  it('words failures for a person: offline, unknown DOI, not a paper, a 404 page', async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'paper-card-'));
    const offline = () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); };
    await expect(fetchPaperCard(deckDir, { input: '2003.08934' }, { fetchImpl: fakeFetch({ 'https://export.arxiv.org': offline }) }))
      .rejects.toThrow('Could not reach export.arxiv.org — is this computer online?');
    await expect(fetchPaperCard(deckDir, { input: '10.1234/missing' }, {
      fetchImpl: fakeFetch({ 'https://api.crossref.org': { status: 404, body: 'Resource not found.' } }),
    })).rejects.toThrow('Crossref has no record of DOI 10.1234/missing.');
    await expect(fetchPaperCard(deckDir, { input: 'https://example.com/cat.png' }, {
      fetchImpl: fakeFetch({ 'https://example.com': { type: 'image/png', body: whitePng(2, 2) } }),
    })).rejects.toThrow('https://example.com/cat.png is an image, not a paper or a project page.');
    await expect(fetchPaperCard(deckDir, { input: 'https://example.com/gone' }, {
      fetchImpl: fakeFetch({ 'https://example.com': { status: 404, body: 'nope' } }),
    })).rejects.toThrow('example.com answered 404 Not Found for https://example.com/gone.');
    await expect(fetchPaperCard(deckDir, { input: 'just some words' })).rejects.toThrow(/not something a card can be made from/);
  });

  it.runIf(pythonHasPdf)('renders the top 55% of a PDF’s first page and guesses its title past the arXiv stamp', async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'paper-card-'));
    const out = join(deckDir, 'page.png');
    const page = await renderPdfFirstPage(join(FIXTURES, 'sample-paper.pdf'), out, { width: 800 });
    expect(page).toMatchObject({ width: 800, pageWidth: 612, pageHeight: 792, pages: 1, textTitle: 'Fixture Fields: A Paper' });
    // 792 pt × 0.55 at 800/612 px per point; MuPDF rounds the clipped edge outward.
    expect(Math.abs(page.height - 792 * 0.55 * (800 / 612))).toBeLessThanOrEqual(1);
    expect(pngSize(await readFile(out))).toEqual({ width: 800, height: page.height });
  });

  it.runIf(pythonHasPdf)('makes an arXiv card from the API and the PDF', async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'paper-card-'));
    const card = await fetchPaperCard(deckDir, { input: 'https://arxiv.org/abs/2003.08934' }, {
      fetchImpl: fakeFetch({
        'https://export.arxiv.org/api/query': { type: 'application/atom+xml', body: await fixture('arxiv-2003.08934.xml') },
        'https://arxiv.org/pdf/2003.08934': { type: 'application/pdf', body: await readFile(join(FIXTURES, 'sample-paper.pdf')) },
      }),
    });
    expect(card).toMatchObject({ kind: 'arxiv', venue: 'ECCV', year: 2020, image: { width: 1600 } });
    expect(card.image.src).toMatch(/^assets\/arxiv-2003\.08934\.[0-9a-f]{8}\.png$/);
    expect((await stat(join(deckDir, card.image.src))).size).toBeGreaterThan(1000);
  });

  it('recognises a bot-check interstitial instead of capturing it', async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'paper-card-'));
    await expect(fetchPaperCard(deckDir, { input: 'https://openreview.net/pdf?id=abc' }, {
      fetchImpl: fakeFetch({ 'https://openreview.net': { body: '<html><head><title>Verifying your browser | OpenReview</title></head></html>' } }),
    })).rejects.toThrow("openreview.net answered with a bot check instead of the page. Paste the paper's arXiv link, or download the PDF and choose it.");
  });

  it('refuses a capture that came out blank rather than insert an empty card', async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'paper-card-'));
    await expect(fetchPaperCard(deckDir, { input: 'https://publisher.example/article/1' }, {
      fetchImpl: fakeFetch({ 'https://publisher.example': { body: '<html><head><title>Loading</title></head></html>' } }),
      capture: async (request) => {
        await writeFile(request.outPng, whitePng(1440, 900));
        return { finalUrl: request.url, status: 200, title: 'Loading', blank: true };
      },
    })).rejects.toThrow("publisher.example showed a blank page to the capture. Paste the paper's arXiv link or PDF instead.");
  });

  it.runIf(pythonHasPdf)('takes a DOI’s picture from its arXiv version when the publisher’s PDF is closed', async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'paper-card-'));
    const phases: string[] = [];
    const card = await fetchPaperCard(deckDir, { input: 'https://doi.org/10.1109/CVPR.2016.90' }, {
      onProgress: (message) => phases.push(message),
      fetchImpl: fakeFetch({
        'https://api.crossref.org/works/': { type: 'application/json', body: await fixture('crossref-10.1109-CVPR.2016.90.json') },
        'https://export.arxiv.org/api/query?search_query=': { type: 'application/atom+xml', body: await fixture('arxiv-search-resnet.xml') },
        'https://arxiv.org/pdf/1512.03385': { type: 'application/pdf', body: await readFile(join(FIXTURES, 'sample-paper.pdf')) },
      }),
      capture: async () => { throw new Error('the landing page must not be needed'); },
    });
    expect(card).toMatchObject({ kind: 'doi', title: 'Deep Residual Learning for Image Recognition', venue: 'CVPR', year: 2016 });
    expect(card.image.src).toMatch(/^assets\/doi-10\.1109-CVPR\.2016\.90\.[0-9a-f]{8}\.png$/);
    expect(phases).toContain('Looking for "Deep Residual Learning for Image Recognition" on arXiv');
    expect(phases).toContain('Downloading the PDF of arXiv:1512.03385');
  });

  it.runIf(pythonHasPdf)('makes a card from a PDF on disk, titled by its largest type', async () => {
    deckDir = await mkdtemp(join(tmpdir(), 'paper-card-'));
    const card = await fetchPaperCard(deckDir, { pdfPath: join(FIXTURES, 'sample-paper.pdf'), name: 'sample-paper.pdf' });
    expect(card).toMatchObject({ kind: 'pdf', title: 'Fixture Fields: A Paper', authors: [], venue: null });
  });
});
