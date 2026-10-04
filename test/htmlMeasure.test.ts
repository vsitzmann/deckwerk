// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { applyAgentTransaction } from '../src/shared/agent.js';
import { emptyDeck } from '../src/shared/deck.js';
import { prepareHtmlDraftRenderPage } from '../src/cli/compileHtml.js';
import { authoringPageHtml, measureSlides, measureSlidesSource } from '../src/shared/htmlMeasure.js';
import { adoptAuthoredIds, htmlSlideScope, slidesFromMeasured, slidesToHtml, type MeasuredSlide } from '../src/shared/htmlSlides.js';
import { applySlideLayout } from '../src/renderer/editor/slideLayouts.js';
import { authoredHtmlSync, authoredHtmlTransaction, compileAuthoredHtml } from '../src/renderer/editor/htmlCompile.js';

/**
 * The one walk, shared by two browsers.
 *
 * The editor compiles a saved authoring file in an offscreen iframe of its own
 * renderer; `slide-agent apply --html` compiles it in a headless Electron
 * window, which has no bundler and so is handed the function's own source.
 * Those two must stay the same code — a copy would drift and slides would move
 * depending on who compiled them — so what is asserted here is that both
 * routes exist and agree on the page they measure.
 *
 * Whether the browser measured the *right* geometry is a different question,
 * answered by the round-trip test against a real deck.
 */

function pageHtml(body: string): string {
  return authoringPageHtml({
    authored: body,
    typeCss: '.role-title { font-size: 92px; }',
    theme: '.slide { background: #ffffff; }',
    canvas: emptyDeck().canvas,
    base: 'deck://asset/',
  });
}

function pageDocument(body: string): Document {
  return new DOMParser().parseFromString(pageHtml(body), 'text/html');
}

/**
 * The page in a frame of its own, which is how the editor compiles: the walk
 * runs from this realm against another document. A parsed document would not
 * exercise that, and has no window to ask for computed styles besides.
 */
function pageFrame(body: string): Document {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) throw new Error('the frame has no document');
  doc.open();
  doc.write(pageHtml(body));
  doc.close();
  return doc;
}

describe('the authoring page', () => {
  it('declares the deck as its base so assets resolve as the player resolves them', () => {
    const doc = pageDocument('<section class="slide" data-slide-id="a"></section>');
    expect(doc.querySelector('base')?.getAttribute('href')).toBe('deck://asset/');
  });

  it('sizes the canvas and omits the player\'s absolute positioning', () => {
    const css = [...pageDocument('').querySelectorAll('style')]
      .map((tag) => tag.textContent ?? '').join('\n');
    expect(css).toContain('width: 1920px');
    expect(css).toContain('height: 1080px');
    // The author's own flexbox and grid must be what lays the slide out.
    expect(css).not.toContain('.element { position: absolute');
  });

  it('wraps a bare fragment but leaves a whole document alone', () => {
    const bare = pageDocument('<section class="slide" data-slide-id="a"></section>');
    expect(bare.querySelector('section')).not.toBeNull();
    expect(bare.querySelectorAll('html').length).toBe(1);
  });

  it('does not inject the deck theme into an independent complete document', () => {
    const html = authoringPageHtml({
      authored: '<!doctype html><html><head><style>h1{color:gold}</style></head><body><section class="slide"><h1>Hello</h1></section></body></html>',
      typeCss: '.role-title { font-size: 92px; }',
      theme: 'h1 { color: red; font-size: 200px; }',
      themeHref: 'theme.css',
      canvas: emptyDeck().canvas,
      base: 'deck://asset/',
    });
    expect(html).toContain('data-slide-editor-independent="true"');
    expect(html).toContain('h1{color:gold}');
    expect(html).not.toContain('h1 { color: red; font-size: 200px; }');
  });
});

/**
 * The cheap half of the browser-fidelity check, so a machine without Electron
 * still notices if the export stops being a page. `htmlBrowserFidelity` is the
 * one that actually opens the file.
 */
describe('the exported document', () => {
  const exported = (): string => slidesToHtml(emptyDeck().slides, emptyDeck().canvas, {
    typeCss: '.role-title { font-size: 92px; }',
    base: '../',
    theme: 'theme.css',
  });

  it('opens with a doctype, or the browser lays it out in quirks mode', () => {
    expect(exported().startsWith('<!doctype html>')).toBe(true);
  });

  it('carries what makes it look like the slide', () => {
    const html = exported();
    // Assets and the stylesheet are relative to `edit/`, where the file lives.
    expect(html).toContain('<base href="../">');
    expect(html).toContain('<link rel="stylesheet" href="theme.css">');
    expect(html).toContain('.role-title { font-size: 92px; }');
    expect(html).toContain('width: 1920px');
  });

  it('still declares its scope, now that the marker is not the first line', () => {
    expect(htmlSlideScope(exported())).toEqual(['slide-1']);
  });

  it('is measured as itself, with only the base retargeted', () => {
    const page = authoringPageHtml({
      authored: exported(),
      typeCss: 'ignored',
      theme: '.slide { color: red; }',
      themeHref: 'theme.css',
      canvas: emptyDeck().canvas,
      base: 'deck://asset/',
    });
    // One document, not the author's wrapped inside a fresh one. Tag matches
    // only: the inlined KaTeX library mentions "<HtmlDomNode>" in an error
    // message, which is a string, not a document.
    expect(page.match(/<html[\s>]/gi)).toHaveLength(1);
    expect(page).toContain('<base href="deck://asset/">');
    expect(page).not.toContain('<base href="../">');
    // The link becomes the stylesheet itself: measuring must not wait on a fetch.
    expect(page).toContain('<style>.slide { color: red; }</style>');
    expect(page).not.toContain('<link rel="stylesheet"');
    expect(page).toContain('.role-title { font-size: 92px; }');
  });
});

describe('HTML draft file rendering', () => {
  it('retargets deck assets and inlines the HTTP-only theme', () => {
    const prepared = prepareHtmlDraftRenderPage(`<!doctype html><html><head>
      <base href="/decks/talk/">
      <link rel="stylesheet" href="/api/theme?deck=talk">
    </head><body><img src="assets/portrait.png"></body></html>`, {
      base: 'file:///Users/example/talk/',
      stylesheets: [{ href: '/api/theme?deck=talk', css: '.slide { color: rebeccapurple; }' }],
    });

    expect(prepared).toContain('<base href="file:///Users/example/talk/">');
    expect(prepared).toContain('<style>.slide { color: rebeccapurple; }</style>');
    expect(prepared).not.toContain('/api/theme?deck=talk');
    expect(prepared).toContain('src="assets/portrait.png"');
  });
});

describe('the walk', () => {
  it('bakes computed presentation styles only for independent documents', () => {
    const doc = pageFrame(`<!doctype html><html><head><style>
      .authored-title { color: rgb(12, 34, 56); font-size: 73px; letter-spacing: 2px; }
    </style></head><body><section class="slide"><h1 class="authored-title">Authored</h1></section></body></html>`);
    const [slide] = measureSlides(doc);
    expect(slide.nodes[0].classes).toEqual([]);
    expect(slide.nodes[0].style).toMatchObject({
      color: 'rgb(12, 34, 56)',
      'font-size': '73px',
      'letter-spacing': '2px',
    });
  });

  it('does not let editor semantic classes override an independent tag selector', () => {
    const doc = pageFrame(`<!doctype html><html><head><style>
      h1 { font-size:112px; line-height:.91; }
    </style></head><body><section class="slide"><h1>Large title</h1></section></body></html>`);
    const [slide] = measureSlides(doc);
    expect(slide.nodes[0].style['font-size']).toBe('112px');
  });

  it('preserves an independent CSS gradient as the smallest canvas fallback', () => {
    const doc = pageFrame(`<!doctype html><html><head><style>
      .slide { width:1920px; height:1080px; background:radial-gradient(circle, #334, #101018); }
    </style></head><body><section class="slide"><h1>Native title</h1></section></body></html>`);
    const [slide] = measureSlides(doc);
    expect(slide.nodes[0]).toMatchObject({
      verbatim: true,
      fallbackReason: 'Complex CSS slide background',
    });
    expect(slide.nodes[0].style['background-image']).toContain('radial-gradient');
    expect(slide.nodes[1].tag).toBe('h1');
  });

  it('keeps mixed rich prose in an independent document as native text', () => {
    const doc = pageFrame(`<!doctype html><html><head><style>
      .katex-display, .katex-display > .katex { display:block }
      .katex-mathml { display:none }
    </style></head><body><section class="slide">
      <p><strong style="display:block">World models</strong>Vision and robotics</p>
    </section></body></html>`);
    const [slide] = measureSlides(doc);
    expect(slide.nodes).toHaveLength(1);
    expect(slide.nodes[0]).toMatchObject({ tag: 'p', verbatim: false });
    expect(slide.nodes[0].html).toContain('<strong');
    expect(slide.nodes[0].html).toContain('display: block');
  });

  it('stores authored TeX instead of KaTeX\'s duplicated render trees', () => {
    const doc = pageFrame(`<!doctype html><html><body><section class="slide">
      <p>Energy <span class="katex"><span class="katex-mathml">
        <annotation encoding="application/x-tex">E=mc^2</annotation>
      </span><span class="katex-html">painted inline copy</span></span>.</p>
      <div class="equation"><span class="katex-display"><span class="katex">
        <span class="katex-mathml">
          <annotation encoding="application/x-tex">\\int_0^1 x^2\\,dx</annotation>
        </span><span class="katex-html">painted display copy</span>
      </span></span></div>
    </section></body></html>`);
    const [slide] = measureSlides(doc);
    const html = slide.nodes.map((node) => node.html).join('\n');
    expect(html).toContain('$E=mc^2$');
    expect(html).toContain('$$\\int_0^1 x^2\\,dx$$');
    expect(html).not.toContain('painted inline copy');
    expect(html).not.toContain('painted display copy');
    expect(html).not.toContain('katex-mathml');
  });

  it('does not double presentation on an isolated fallback wrapper', () => {
    const doc = pageFrame(`<!doctype html><html><body><section class="slide">
      <div data-element="html" style="opacity:.4; border:3px solid red; background:blue">Complex</div>
    </section></body></html>`);
    const [slide] = measureSlides(doc);
    expect(slide.nodes[0]).toMatchObject({ verbatim: true, opacity: 1, style: {} });
    expect(slide.nodes[0].html).toMatch(/opacity:\s*0?\.4/);
  });

  it('reads each slide\'s identity from the markup, in another document', () => {
    // Cross-document is the interesting part: in the editor this function is
    // called from the host realm against an iframe's document.
    const doc = pageFrame(`
      <section class="slide" data-slide-id="intro" data-name="Intro"
               data-notes="Say hello" style="background:#101014">
        <h1 class="role-title">Hello</h1>
      </section>
      <section class="slide" data-slide-id="next" data-morph-from-previous="true"
               data-morph-duration="1450"></section>
    `);
    const slides = measureSlides(doc);

    expect(slides.map((slide) => slide.id)).toEqual(['intro', 'next']);
    expect(slides[0]).toMatchObject({
      name: 'Intro',
      notes: 'Say hello',
      background: { color: '#101014', image: null },
      morphFromPrevious: false,
    });
    expect(slides[1].morphFromPrevious).toBe(true);
    expect(slides[1].morphDuration).toBe(1450);
  });

  it('treats a page with no slide sections as one slide', () => {
    expect(measureSlides(pageFrame('<h1>Just markup</h1>')).length).toBe(1);
  });

  it('compiles a page with no sections and an empty body to no slides at all', () => {
    // A scoped export whose sections were all removed asks for a deletion; the
    // body fallback must not turn that request into one fresh empty slide.
    expect(measureSlides(pageFrame(''))).toEqual([]);
  });

  it('dissolves a hand-copied element wrapper so the video inside stays a video', () => {
    // Agents copy `class="element element-video"` wrappers from exports around
    // their own <video>. Claiming the wrapper as the object baked the video
    // into a text element and lost it.
    const doc = pageFrame(`
      <section class="slide" data-slide-id="a">
        <div class="element element-video"
             style="position:absolute; left:280px; top:180px; width:1360px; height:720px;">
          <video src="assets/results.mp4"></video>
        </div>
      </section>
    `);
    const [slide] = measureSlides(doc);
    expect(slide.nodes.map((node) => node.tag)).toEqual(['video']);
    expect(slide.nodes[0].attrs.src).toBe('assets/results.mp4');
  });

  it('refuses a document it cannot measure rather than guessing', () => {
    const detached = document.implementation.createHTMLDocument('detached');
    expect(() => measureSlides(detached)).toThrow(/no window/);
  });

  it('serialises to something a bundler-less browser can evaluate', () => {
    const source = measureSlidesSource();
    // Parse it the way `executeJavaScript` will, without running it: a stray
    // reference to module scope or a syntax slip here wedged the CLI for five
    // minutes once, and only showed up as a timeout.
    expect(() => new Function(`return ${source}`)).not.toThrow();
    expect(source).toContain('data-slide-id');
    expect(source.endsWith('(document)')).toBe(true);
  });
});

/**
 * The live path: a saved file compiles inside the editor, with no second
 * browser started for it. jsdom lays nothing out, so geometry is not what is
 * under test here — the structural half is: which slides the file claims, and
 * what a save therefore does to the deck.
 */
describe('compiling a saved authoring file in the editor', () => {
  const theme = '.slide { background: #ffffff; }';

  // The compile resolves asset paths through the preload bridge, against the
  // host that names this window's deck; jsdom has no bridge, so stand one in.
  beforeEach(() => {
    (globalThis as unknown as { window: Window }).window.api = {
      assetUrl: (src: string) => `deck://test-deck/${src}`,
    } as never;
  });

  /** An export of `exportedWith`, with the author's own slides in its body. */
  const edited = (exportedWith: Parameters<typeof slidesToHtml>[0], body: string): string =>
    slidesToHtml(exportedWith, emptyDeck().canvas)
      .replace(/<body>[\s\S]*<\/body>/, `<body>${body}</body>`);

  it('reads the slides out of the markup with no compiler process', async () => {
    const deck = emptyDeck();
    const { slides } = await compileAuthoredHtml(deck, `
      <section class="slide" data-slide-id="slide-1" data-name="Opening"></section>
      <section class="slide" data-slide-id="added" data-name="Added"></section>
    `, theme);
    expect(slides.map((slide) => slide.id)).toEqual(['slide-1', 'added']);
    expect(slides[1].name).toBe('Added');
  });

  it('warns when the browser drops inline declarations the compile still reads', async () => {
    // The all_HANDS regression: a regex edit truncated an entity-escaped font
    // stack, leaving an unterminated quote. The browser then swallowed every
    // later declaration — the page measured left-aligned — while the compile,
    // reading the raw attribute, kept text-align and reported a clean apply.
    const deck = emptyDeck();
    const { slides, warnings } = await compileAuthoredHtml(deck, `
      <section class="slide" data-slide-id="slide-1">
        <h1 style='font-family:&quot;Inter; text-align:center; color:red'>Title</h1>
      </section>
    `, theme);
    expect(slides).toHaveLength(1);
    expect(warnings.some((warning) => warning.includes('unterminated'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('text-align'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('color:red'))).toBe(true);
  });

  it('warns about a style segment with no colon, and stays quiet on clean styles', async () => {
    const deck = emptyDeck();
    const { warnings } = await compileAuthoredHtml(deck, `
      <section class="slide" data-slide-id="slide-1">
        <h1 style="text-align center; color: blue">Broken</h1>
        <p style='font-family: "Fira Sans", sans-serif; background-image: url("a;b.png")'>Fine</p>
      </section>
    `, theme);
    expect(warnings.some((warning) => warning.includes('text-align center'))).toBe(true);
    // The well-formed style — quoted font stack, a semicolon inside url() —
    // must not warn: noise here would teach everyone to ignore the channel.
    expect(warnings.filter((warning) => warning.startsWith('<p'))).toEqual([]);
  });

  it('turns the exported range into one transaction that also deletes and reorders', async () => {
    const deck = emptyDeck();
    deck.slides.push(
      { ...structuredClone(deck.slides[0]), id: 'middle' },
      { ...structuredClone(deck.slides[0]), id: 'closing' },
    );
    // Exported with a recorded scope, then edited: one slide dropped, one new
    // one added, and the order changed.
    const { transaction } = await authoredHtmlTransaction(deck, {
      path: '/deck/edit/slide-1-middle.html',
      contents: edited(deck.slides.filter((slide) => slide.id !== 'closing'), `
        <section class="slide" data-slide-id="fresh"></section>
        <section class="slide" data-slide-id="slide-1"></section>`),
    }, theme);

    expect(transaction?.label).toBe('Added 1 slide · Updated 1 slide · Removed 1 slide · Reordered slides');
    const ops = transaction!.operations.map((operation) => operation.op);
    expect(ops).toContain('insertSlides');
    expect(ops).toContain('deleteSlide');
    expect(ops).toContain('moveSlide');
  });

  it('can be saved again after it has added a slide', async () => {
    // Iterating means saving the same file repeatedly. A file that inserted a
    // slide governs it from then on, or the second save reads as an attempt to
    // steal a slide from outside its range and the loop stops after one edit.
    const deck = emptyDeck();
    const file = {
      path: 'edit/slide-1.html',
      contents: edited(deck.slides, `
        <section class="slide" data-slide-id="slide-1"></section>
        <section class="slide" data-slide-id="added"></section>`),
    };

    const first = await authoredHtmlTransaction(deck, file, theme);
    const afterFirst = applyAgentTransaction(deck, first.transaction!);
    expect(afterFirst.slides.map((slide) => slide.id)).toEqual(['slide-1', 'added']);

    // Saved again unchanged, it governs both slides and asks for nothing.
    const second = await authoredHtmlTransaction(afterFirst, file, theme);
    expect(second.transaction).toBeNull();
  });

  it('deletes the exported range when its sections are removed from the file', async () => {
    const deck = emptyDeck();
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'closing' });
    const { transaction } = await authoredHtmlTransaction(deck, {
      path: 'edit/slide-1.html',
      contents: edited([deck.slides[0]], ''),
    }, theme);
    expect(transaction!.operations).toEqual([{ op: 'deleteSlide', slideId: 'slide-1' }]);
  });

  it('stamps assigned ids into the file so applying it twice does not duplicate', async () => {
    // The disaster this prevents: apply, time out, apply again — and every
    // id-less section lands in the deck a second time under a fresh id.
    const deck = emptyDeck();
    const file = {
      path: 'edit/slide-1.html',
      contents: edited(deck.slides, `
        <section class="slide" data-slide-id="slide-1"></section>
        <section class="slide" data-name="New"></section>`),
    };

    const { transaction, slides } = await authoredHtmlSync(deck, file, theme);
    const after = applyAgentTransaction(deck, transaction!);
    expect(after.slides.length).toBe(2);

    const adopted = adoptAuthoredIds(file.contents, slides)!;
    expect(adopted).toContain(`data-slide-id="${slides[1].id}"`);
    expect(htmlSlideScope(adopted)).toEqual(slides.map((slide) => slide.id));

    const second = await authoredHtmlSync(after, { path: file.path, contents: adopted }, theme);
    const afterSecond = second.transaction
      ? applyAgentTransaction(after, second.transaction) : after;
    expect(afterSecond.slides.map((slide) => slide.id))
      .toEqual(after.slides.map((slide) => slide.id));
  });

  it('adopts nothing when the document cannot be matched to the compiled slides', () => {
    expect(adoptAuthoredIds('<p>not a slide document</p>', [emptyDeck().slides[0]])).toBeNull();
  });

  it('leaves the deck\'s shape alone when the file still holds the same slides', async () => {
    const deck = emptyDeck();
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'closing' });
    const contents = slidesToHtml(deck.slides, deck.canvas);
    // Saved untouched, the page compiles to what the deck holds: there is
    // nothing to replace, and a replacement would be History noise.
    expect((await authoredHtmlTransaction(deck, { path: 'edit/slide-1-closing.html', contents }, theme)).transaction)
      .toBeNull();

    // Edited, its slides are replaced — that is the point of a save — but
    // nothing is inserted, deleted or moved, so slides keep their places.
    const edited = contents.replace('data-slide-id="closing"', 'data-slide-id="closing" data-name="Renamed"');
    const { transaction } = await authoredHtmlTransaction(deck, { path: 'edit/slide-1-closing.html', contents: edited }, theme);
    expect(transaction?.operations.map((operation) => operation.op)).toEqual(['replaceSlide']);
  });
});

describe('minting ids for compiled slides', () => {
  const measured = (over: Partial<MeasuredSlide> = {}): MeasuredSlide => ({
    id: null,
    name: '',
    notes: '',
    background: { color: null, image: null },
    morphFromPrevious: false,
    nodes: [],
    ...over,
  });

  it('names unidentified slides without colliding with the deck', () => {
    const deck = emptyDeck();
    const slides = slidesFromMeasured(deck, [measured(), measured()]);
    expect(slides.map((slide) => slide.id)).not.toContain(deck.slides[0].id);
    expect(new Set(slides.map((slide) => slide.id)).size).toBe(2);
  });

  it('lets a slide keep its own element ids when it is re-authored', () => {
    // Without freeing the ids of the slides being replaced, every round trip
    // would rename every element it touched.
    const deck = emptyDeck();
    const slide = deck.slides[0];
    applySlideLayout(slide, 'standard');
    slide.elements[0].id = `${slide.id}-title`;
    const [rebuilt] = slidesFromMeasured(deck, [measured({
      id: slide.id,
      nodes: [{
        tag: 'h1', elementId: `${slide.id}-title`, classes: [], dataset: {},
        rect: { x: 0, y: 0, w: 100, h: 50 }, rotation: 0, opacity: 1,
        style: {}, html: 'Title', attrs: {},
      }],
    })]);
    expect(rebuilt.id).toBe(slide.id);
    expect(rebuilt.elements[0].id).toBe(`${slide.id}-title`);
  });
});
