import { describe, expect, it } from 'vitest';
import { applyAgentOperations } from '../src/shared/agent.js';
import { emptyDeck, parseDeck, type Deck, type Slide, type SlideElement } from '../src/shared/deck.js';
import {
  authoringListCss,
  buildFromNode,
  elementFromNode,
  htmlChangeLabel,
  htmlSlideScope,
  htmlSyncOperations,
  htmlSyncSummary,
  slideFromMeasured,
  slidesFromMeasured,
  slideToHtml,
  slidesToHtml,
  type MeasuredNode,
} from '../src/shared/htmlSlides.js';
import { parsePath, pathGeometry } from '../src/shared/pathNodes.js';
import { PLAYER_TYPE_CSS } from '../src/shared/playerTypeCss.js';

/**
 * The pure half of HTML authoring: browser-measured facts in, deck objects out.
 *
 * These tests are about *meaning* — that a measured `<img>` becomes an image
 * element with its crop, that a build attribute becomes a timeline entry. The
 * question of whether the browser measured the right thing is a different one,
 * answered by the round-trip test.
 */

function node(over: Partial<MeasuredNode> = {}): MeasuredNode {
  return {
    tag: 'p',
    elementId: null,
    classes: [],
    dataset: {},
    rect: { x: 100, y: 200, w: 800, h: 120 },
    rotation: 0,
    opacity: 1,
    style: {},
    html: 'Hello',
    attrs: {},
    ...over,
  };
}

describe('measured nodes become deck objects', () => {
  it('maps explicitly authored tables to native resizable table text', () => {
    const element = elementFromNode(node({
      tag: 'table',
      classes: ['results-table'],
      dataset: { element: 'table', tableWidths: '1,3' },
      html: '<tbody><tr class="highlight"><td class="metric" style="background-color:#123456;border:3px solid #ffffff">A</td><td>B</td></tr></tbody>',
    }), 'table-1', 2);
    expect(element).toMatchObject({
      type: 'text',
      class: ['results-table'],
      html: expect.stringContaining('<table>'),
      table: { columnWidths: [1, 3], autoHeight: true },
      autoFit: false,
    });
    expect(element?.type === 'text' && element.html).toContain('class="metric"');
    expect(element?.type === 'text' && element.html).toContain('border:3px solid #ffffff');
  });

  it('maps a text node, keeping its classes and authored inline style', () => {
    const element = elementFromNode(node({
      tag: 'h1',
      classes: ['role-title'],
      style: { color: '#ff3366', 'font-size': '80px' },
      attrs: { textAlign: 'center' },
      html: 'A title',
    }), 'title-1', 3);

    expect(element).toMatchObject({
      id: 'title-1', type: 'text', x: 100, y: 200, w: 800, h: 120, z: 3,
      class: ['role-title'], align: 'center', valign: 'top', html: 'A title',
    });
    expect(element?.style).toEqual({ color: '#ff3366', 'font-size': '80px' });
  });

  it('keeps text a flex container centres where the browser drew it', () => {
    // A banner or badge centring its own text with flexbox was stored top-left.
    const banner = elementFromNode(node({
      attrs: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
    }), 'banner', 1);
    expect(banner).toMatchObject({ type: 'text', align: 'center', valign: 'middle' });

    const column = elementFromNode(node({
      attrs: { flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' },
    }), 'column', 1);
    expect(column).toMatchObject({ align: 'center', valign: 'bottom' });

    // An explicit data-valign (every export carries one) still wins, and a
    // deck text box's own markup keeps the alignment it states.
    const stated = elementFromNode(node({
      dataset: { valign: 'top' },
      attrs: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center' },
    }), 'stated', 1);
    expect(stated).toMatchObject({ align: 'center', valign: 'top' });
    const exported = elementFromNode(node({
      preformatted: true,
      attrs: { textAlign: 'left', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' },
    }), 'exported', 1);
    expect(exported).toMatchObject({ align: 'left', valign: 'top' });
  });

  it('drops layout declarations that did their job during measurement', () => {
    // `display: flex` on an absolutely positioned box would re-flow the text
    // the geometry was measured against.
    const element = elementFromNode(node({
      style: { display: 'flex', margin: '20px', color: '#111111' },
    }), 'text-1', 1);
    expect(element?.style).toEqual({ color: '#111111' });
  });

  it('maps media with its crop, trim and fit', () => {
    const image = elementFromNode(node({
      tag: 'img',
      attrs: { src: 'assets/figure.png', alt: 'Figure', objectFit: 'cover' },
      dataset: { crop: '-100,-50,1920,1080' },
    }), 'figure', 2) as Extract<SlideElement, { type: 'image' }>;
    expect(image).toMatchObject({ type: 'image', src: 'assets/figure.png', alt: 'Figure', fit: 'cover' });
    expect(image.sourceBox).toEqual({ x: -100, y: -50, w: 1920, h: 1080 });

    const video = elementFromNode(node({
      tag: 'video',
      attrs: { src: 'assets/clip.mp4', loop: true, muted: true },
      dataset: { trim: '2,8' },
    }), 'clip', 2) as Extract<SlideElement, { type: 'video' }>;
    expect(video).toMatchObject({ type: 'video', start: 2, end: 8, loop: true });

    // An open-ended trim means "to the end of the file", not zero.
    const untrimmed = elementFromNode(node({
      tag: 'video', attrs: { src: 'a.mp4' }, dataset: { trim: '3,' },
    }), 'clip2', 2) as Extract<SlideElement, { type: 'video' }>;
    expect(untrimmed).toMatchObject({ start: 3, end: null });
  });

  it('reads a media fragment on a video src as its trim, and keeps the file name clean', () => {
    // Hand-written: the fragment is the only place the trim is said.
    const fragment = elementFromNode(node({
      tag: 'video', attrs: { src: 'assets/clip.mp4#t=15.0,20.0' },
    }), 'clip', 2) as Extract<SlideElement, { type: 'video' }>;
    expect(fragment).toMatchObject({ src: 'assets/clip.mp4', start: 15, end: 20 });

    // Exported: `#t=` is the preview in-point, `data-trim` the trim.
    const exported = elementFromNode(node({
      tag: 'video', attrs: { src: 'assets/clip.mp4#t=2' }, dataset: { trim: '2,8' },
    }), 'clip2', 2) as Extract<SlideElement, { type: 'video' }>;
    expect(exported).toMatchObject({ src: 'assets/clip.mp4', start: 2, end: 8 });

    // A cropped clip's file rides on data-src.
    const cropped = elementFromNode(node({
      tag: 'div', html: '',
      dataset: { element: 'video', src: 'assets/clip.mp4#t=4,6', crop: '0,0,800,120' },
    }), 'clip3', 2) as Extract<SlideElement, { type: 'video' }>;
    expect(cropped).toMatchObject({ src: 'assets/clip.mp4', start: 4, end: 6 });
  });

  it('lands an imported round crop as one editable picture', () => {
    // What the walk hands over for `<div class="crop"><img></div>`: the
    // frame's ring, its backdrop and its round window folded onto the picture,
    // and the `object-fit`/`object-position` framing measured into a crop.
    // The whole point is that this is *one* object -- the ring used to arrive
    // as a second shape stacked exactly on top, which moved on its own -- and
    // that its crop is the editor's own, so the crop tool starts where the
    // picture actually is instead of snapping it to the window.
    const portrait = elementFromNode(node({
      tag: 'img',
      rect: { x: 120, y: 300, w: 260, h: 260 },
      attrs: { src: 'assets/bird.jpg', alt: 'Crimson sunbird', objectFit: 'cover' },
      dataset: { crop: '-19.07,0,346.67,260' },
      style: {
        'border-radius': '50%',
        'box-shadow': 'rgb(22, 24, 43) 0px 0px 0px 5px',
        'background-color': 'rgb(233, 229, 220)',
      },
    }), 'bird', 3) as Extract<SlideElement, { type: 'image' }>;

    expect(portrait).toMatchObject({
      type: 'image', fit: 'cover', maskShape: 'circle',
      w: 260, h: 260,
    });
    expect(portrait.sourceBox).toEqual({ x: -19.07, y: 0, w: 346.67, h: 260 });
    // The radius became the typed mask; ring and backdrop stay as element CSS.
    expect(portrait.style['border-radius']).toBeUndefined();
    expect(portrait.style['box-shadow']).toBe('rgb(22, 24, 43) 0px 0px 0px 5px');
    expect(portrait.style['background-color']).toBe('rgb(233, 229, 220)');
    // A crop and a leftover `object-position` would fight over the framing.
    expect(portrait.style['object-position']).toBeUndefined();
  });

  it('promotes a CSS-authored media radius into the editable typed field', () => {
    const video = elementFromNode(node({
      tag: 'video',
      attrs: { src: 'assets/clip.mp4' },
      style: { 'border-radius': '28px' },
    }), 'clip', 2);

    expect(video).toMatchObject({ type: 'video', borderRadius: 28, style: {} });
  });

  it('promotes representable CSS media decoration into every editable typed field', () => {
    const video = elementFromNode(node({
      tag: 'video',
      attrs: { src: 'assets/clip.mp4' },
      style: {
        border: '5px solid rgba(255, 255, 255, 0.8)',
        'border-radius': '50%',
        filter: 'blur(6px) grayscale(40%)',
      },
    }), 'clip', 2);

    expect(video).toMatchObject({
      type: 'video',
      borderWidth: 5,
      borderColor: 'rgba(255, 255, 255, 0.8)',
      maskShape: 'circle',
      effects: [
        { type: 'blur', radius: 6 },
        { type: 'grayscale', amount: 0.4 },
      ],
      style: {},
    });
  });

  it('previews and round-trips round media masks without requiring a border', () => {
    const deck = emptyDeck('Masks');
    deck.slides[0].elements = [{
      id: 'video', type: 'video', x: 10, y: 20, w: 500, h: 300, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, src: 'assets/demo.mp4', fit: 'cover',
      autoplay: true, loop: true, muted: true, controls: false, start: 0, end: null,
      poster: null, sourceBox: null, maskShape: 'circle', effects: [{ type: 'blur', radius: 8 }],
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-mask-shape="circle"');
    expect(html).toContain('border-radius:50%');
    expect(html).toContain('overflow:hidden');
    expect(html).toContain('filter:blur(8px)');

    const measured = elementFromNode(node({
      tag: 'video', dataset: { maskShape: 'circle' }, attrs: { src: 'assets/demo.mp4' },
    }), 'video', 1);
    expect(measured).toMatchObject({ type: 'video', maskShape: 'circle' });
  });

  it('round-trips Gaussian noise settings on text and video', () => {
    const encoded = encodeURIComponent(JSON.stringify([{
      type: 'gaussianNoise', amount: 0.45, frequencyCutoff: 0.2,
    }]));
    const text = elementFromNode(node({
      tag: 'p', dataset: { effects: encoded }, html: 'Noisy title',
    }), 'title', 1);
    expect(text).toMatchObject({
      type: 'text',
      effects: [{ type: 'gaussianNoise', amount: 0.45, frequencyCutoff: 0.2 }],
    });

    const video = elementFromNode(node({
      tag: 'video', dataset: { effects: encoded }, attrs: { src: 'assets/demo.mp4' },
    }), 'clip', 2);
    expect(video).toMatchObject({
      type: 'video',
      effects: [{ type: 'gaussianNoise', amount: 0.45, frequencyCutoff: 0.2 }],
    });

    const deck = emptyDeck('Noise');
    deck.slides[0].elements = [text!, video!];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html.match(/data-effects=/g)).toHaveLength(2);
    expect(html).toContain('gaussianNoise');

    const roundTripped = elementFromNode(node({
      tag: 'video',
      dataset: { effects: encoded },
      attrs: { src: 'assets/demo.mp4' },
      style: { filter: 'grayscale(0.5)' },
    }), 'clip', 2);
    expect(roundTripped).toMatchObject({
      type: 'video',
      effects: [{ type: 'gaussianNoise', amount: 0.45, frequencyCutoff: 0.2 }],
      style: {},
    });
  });

  it('previews media borders as overlays and keeps their typed fields on round trip', () => {
    const deck = emptyDeck('Borders');
    deck.slides[0].elements = [{
      id: 'image', type: 'image', x: 10, y: 20, w: 500, h: 300, rot: 0, z: 1,
      opacity: 1, class: [], style: { border: '8px solid #ff3366' }, src: 'assets/demo.png', fit: 'cover', alt: '',
      sourceBox: null, borderColor: '#ff3366', borderWidth: 8, borderRadius: 14,
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-border-width="8"');
    expect(html).toContain('data-border-color="#ff3366"');
    expect(html).toContain('data-border-radius="14"');
    expect(html).toContain('outline:8px solid #ff3366');
    expect(html).toContain('outline-offset:-8px');
    expect(html).not.toContain('border:8px solid #ff3366');

    deck.slides[0].elements[0] = { ...deck.slides[0].elements[0], borderWidth: 0 } as SlideElement;
    const withoutBorder = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(withoutBorder).not.toContain('outline:');
    expect(withoutBorder).not.toContain('border:8px solid #ff3366');

    const measured = elementFromNode(node({
      tag: 'img',
      dataset: { borderWidth: '8', borderColor: '#ff3366', borderRadius: '14' },
      attrs: { src: 'assets/demo.png' },
      style: { 'border-radius': '14px', border: '8px solid #ff3366' },
    }), 'image', 1);
    expect(measured).toMatchObject({
      type: 'image', borderColor: '#ff3366', borderWidth: 8, borderRadius: 14,
      style: {},
    });

    const explicitlySquare = {
      ...deck.slides[0].elements[0],
      style: { 'border-radius': '22px' },
      borderRadius: 0,
    } as SlideElement;
    deck.slides[0].elements = [explicitlySquare];
    const squareHtml = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(squareHtml).not.toContain('border-radius:22px');
    expect(squareHtml).toContain('data-border-width="0"');
    expect(squareHtml).toContain('data-border-radius="0"');

    deck.slides[0].elements[0] = {
      ...explicitlySquare,
      maskShape: 'rect',
      effects: [],
      style: {
        border: '7px solid red',
        'border-radius': '50%',
        filter: 'blur(12px)',
      },
    } as SlideElement;
    const clearedHtml = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(clearedHtml).toContain('data-mask-shape="rect"');
    expect(clearedHtml).toContain('data-effects="%5B%5D"');
    expect(clearedHtml).not.toContain('border:7px solid red');
    expect(clearedHtml).not.toContain('border-radius:50%');
    expect(clearedHtml).not.toContain('filter:blur(12px)');
  });

  it('reconstructs shapes from their parameters rather than flattening them', () => {
    const shape = elementFromNode(node({
      tag: 'div',
      dataset: {
        element: 'shape', shape: 'arrow', stroke: '#111111', strokeWidth: '6',
        arrowEnd: 'true', control: '950,300',
      },
      style: {
        border: '6px solid #111111',
        'border-radius': '24px',
        'box-shadow': '0 8px 24px #0008',
      },
    }), 'arrow-1', 2) as Extract<SlideElement, { type: 'shape' }>;

    expect(shape).toMatchObject({
      type: 'shape', shape: 'arrow', stroke: '#111111', strokeWidth: 6,
      arrowEnd: true, arrowStart: false,
    });
    expect(shape.control).toEqual({ x: 950, y: 300 });
    expect(shape.style).toEqual({ 'box-shadow': '0 8px 24px #0008' });
  });

  it('keeps an import gap conspicuous instead of quietly dropping it', () => {
    const gap = elementFromNode(node({
      tag: 'div',
      dataset: { element: 'unsupported', originalType: 'TSD.ChartArchive' },
      html: 'TSD.ChartArchive: a bar chart',
    }), 'gap-1', 1) as Extract<SlideElement, { type: 'unsupported' }>;

    expect(gap).toMatchObject({ type: 'unsupported', originalType: 'TSD.ChartArchive' });
    expect(gap.note).toBe('TSD.ChartArchive: a bar chart');
  });

  it('preserves markup it cannot reduce to a known object', () => {
    const svg = elementFromNode(node({
      tag: 'svg', verbatim: true, html: '<svg viewBox="0 0 10 10"><circle r="4"/></svg>',
    }), 'chart', 1);
    expect(svg).toMatchObject({ type: 'html' });
    expect((svg as Extract<SlideElement, { type: 'html' }>).html).toContain('<circle');
  });

  it('reads ordinary semantic tags as text rather than inert markup', () => {
    // The rule used to be an allow-list of a dozen tags, so a definition
    // list, a figure caption or an <article> came back as an HTML fallback
    // nobody could edit.
    for (const tag of ['dt', 'dd', 'figure', 'article', 'small', 'cite', 'label']) {
      expect(elementFromNode(node({ tag, html: 'words' }), `${tag}-1`, 1))
        .toMatchObject({ type: 'text', html: 'words' });
    }
    // Embedded content is still preserved verbatim: it is a picture, not prose.
    for (const tag of ['canvas', 'iframe', 'object']) {
      expect(elementFromNode(node({ tag, html: `<${tag}></${tag}>` }), `${tag}-1`, 1))
        .toMatchObject({ type: 'html' });
    }
  });

  it('rebuilds a one-primitive SVG as the shape it draws', () => {
    // The walker recognises the primitive and hands the mapping the same data
    // attributes a hand-written shape carries, so an arrow authored in SVG is
    // as re-colourable and re-pointable as one drawn in the editor.
    const arrow = elementFromNode(node({
      tag: 'div',
      dataset: {
        element: 'shape', shape: 'arrow', stroke: 'rgb(22, 24, 43)',
        strokeWidth: '6', arrowEnd: 'true',
      },
      rect: { x: 100, y: 300, w: 300, h: 6 },
      html: '',
    }), 'arrow-1', 1);
    expect(arrow).toMatchObject({
      type: 'shape', shape: 'arrow', stroke: 'rgb(22, 24, 43)',
      strokeWidth: 6, arrowEnd: true, fill: null,
    });

    const icon = elementFromNode(node({
      tag: 'div',
      dataset: {
        element: 'shape', shape: 'path', path: 'M12 2 L22 20 L2 20 Z',
        pathSize: '24,24', stroke: '#ffad52', strokeWidth: '2',
      },
      html: '',
    }), 'icon-1', 2);
    expect(icon).toMatchObject({
      type: 'shape', shape: 'path', path: 'M12 2 L22 20 L2 20 Z',
      pathSize: { w: 24, h: 24 },
    });
  });

  it('refuses a node with no area, which would be an invisible object', () => {
    expect(elementFromNode(node({ rect: { x: 0, y: 0, w: 0, h: 40 } }), 'empty', 1)).toBeNull();
  });

  it('turns build attributes into timeline entries', () => {
    expect(buildFromNode(node({ dataset: { build: 'click' } }), 'bullet', 0)).toMatchObject({
      trigger: { on: 'click', delay: 0 },
      action: { type: 'appear', target: 'bullet' },
    });
    expect(buildFromNode(node({ dataset: { build: 'afterPrev+500' } }), 'bullet', 1))
      .toMatchObject({ trigger: { on: 'afterPrev', delay: 500 } });
    expect(buildFromNode(node(), 'bullet', 0)).toBeNull();
  });

  it('mints ids only where the author has not kept one, and never collides', () => {
    const slide = slideFromMeasured({
      id: 'results',
      name: 'Results',
      notes: '',
      background: { color: '#ffffff', image: null },
      morphFromPrevious: false,
      nodes: [
        node({ elementId: 'kept-id' }),
        node({ tag: 'h1' }),
        node({ tag: 'h1' }),
      ],
    }, { slideId: 'results', usedIds: new Set(['results-h1-2']) });

    const ids = slide.elements.map((element) => element.id);
    expect(ids[0]).toBe('kept-id');
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain('results-h1-2');
    // Paint order follows document order.
    expect(slide.elements.map((element) => element.z)).toEqual([1, 2, 3]);
  });

  it('never mints a new slide an id the same page already gives an existing slide', () => {
    // The ids of the slides a page replaces are freed so they can keep them;
    // minting from the freed set handed a new section the id of a slide in
    // the very same page, and the save was refused as naming one slide twice.
    // (Found by the agent collaboration fuzz.)
    const deck = parseDeck({
      version: 1,
      slides: [
        { id: 'elsewhere' },
        { id: 'slide-2', elements: [{ id: 'kept', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'a' }] },
      ],
    });
    const blank = { name: '', notes: '', background: { color: null, image: null }, morphFromPrevious: false };
    // The new section comes first, so it is minted before slide-2 is reached.
    const slides = slidesFromMeasured(deck, [
      { ...blank, id: null, nodes: [node({ tag: 'h1' })] },
      { ...blank, id: 'slide-2', nodes: [node({ elementId: 'kept' })] },
    ]);
    const ids = slides.map((slide) => slide.id);
    expect(ids[1]).toBe('slide-2');
    expect(new Set(ids).size).toBe(2);
    const elementIds = slides.flatMap((slide) => slide.elements.map((element) => element.id));
    expect(elementIds).toContain('kept');
    expect(new Set(elementIds).size).toBe(elementIds.length);
  });
});

describe('deck objects become authored HTML', () => {
  it('records the ordered authoritative scope in the exported document', () => {
    const deck = emptyDeck('Scope');
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'résults / 2' });
    const html = slidesToHtml(deck.slides, deck.canvas);

    expect(htmlSlideScope(html)).toEqual(['slide-1', 'résults / 2']);
    expect(html.match(/slide-editor-scope:/g)).toHaveLength(1);
    expect(html).toContain('This section list is the structural editing API');
    expect(html).toContain('reordering exported sections - MOVES those slides');
    expect(htmlSlideScope('<section class="slide"></section>')).toBeNull();
    expect(htmlChangeLabel(html)).toBeNull();
    expect(htmlChangeLabel(html.replace('content=""', 'content="Add &amp; explain results"')))
      .toBe('Add & explain results');
  });

  it('carries KaTeX only for pages that have maths on them', () => {
    // ~640 KB inlined: on every export it made a blank page too big for an
    // agent's terminal. The compiler adds it to any page that lacks it.
    const blank = slidesToHtml([], { w: 1920, h: 1080 }, { blank: 1 });
    expect(blank).not.toContain('data-katex-inline');
    expect(blank.length).toBeLessThan(40_000);

    const deck = emptyDeck('Maths');
    deck.slides[0].elements = [{
      id: 'eq', type: 'text', x: 0, y: 0, w: 800, h: 100, rot: 0, z: 1, opacity: 1,
      class: [], style: {}, html: 'Energy: $E = mc^2$', autoFit: false, align: 'left', valign: 'top',
    } as SlideElement];
    expect(slidesToHtml(deck.slides, deck.canvas)).toContain('data-katex-inline');
    // An escaped dollar is a price, not a delimiter.
    (deck.slides[0].elements[0] as { html: string }).html = 'Costs \\$5 and \\$7';
    expect(slidesToHtml(deck.slides, deck.canvas)).not.toContain('data-katex-inline');
  });

  it('renders exported object dimensions as the measured border box', () => {
    const html = slidesToHtml(emptyDeck('Boxes').slides, { w: 1920, h: 1080 });

    expect(html).toContain('[data-element-id] { box-sizing: border-box; }');
  });

  it('round-trips a shape through its data attributes', () => {
    const deck = emptyDeck('Shapes');
    deck.slides[0].elements = [{
      id: 'arrow', type: 'shape', x: 200, y: 300, w: 400, h: 120, rot: 15, z: 2,
      opacity: 1, class: [], style: {}, shape: 'arrow', fill: null, stroke: '#111111',
      strokeWidth: 6, radius: 0, path: null, pathSize: null, arrowStart: false,
      arrowEnd: true, control: { x: 400, y: 240 },
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });

    expect(html).toContain('data-element="shape"');
    expect(html).toContain('data-shape="arrow"');
    // The bend is said relative to the box's top-left corner, so it moves
    // with the arrow when an agent edits only `left`/`top`.
    expect(html).toContain('data-control-offset="200,-60"');
    expect(html).not.toContain('data-control=');
    expect(html).toContain('data-arrow-end="true"');
    expect(html).not.toContain('data-arrow-start');
  });

  it('moves a bent arrow\'s control point with its box', () => {
    const arrow = (dataset: Record<string, string>) => elementFromNode(node({
      tag: 'div', html: '', rect: { x: 900, y: 500, w: 400, h: 120 },
      dataset: { element: 'shape', shape: 'arrow', stroke: '#111111', strokeWidth: '6', arrowEnd: 'true', ...dataset },
    }), 'arrow', 2);
    // Exported at x 200, y 300 with the point at (400, 240); the page moved
    // the box to (900, 500) and left the attribute alone.
    expect(arrow({ controlOffset: '200,-60' })).toMatchObject({ x: 900, y: 500, control: { x: 1100, y: 440 } });
    // A page written before the offset existed still means slide coordinates.
    expect(arrow({ control: '400,240' })).toMatchObject({ control: { x: 400, y: 240 } });
  });

  it('round-trips a path drawn with the pen, curves and all', () => {
    const deck = emptyDeck('Paths');
    const drawn = pathGeometry([{
      closed: true,
      nodes: [
        { x: 200, y: 300, in: { x: 150, y: 350 }, out: { x: 250, y: 250 } },
        { x: 500, y: 300 },
        { x: 350, y: 500, in: { x: 450, y: 520 }, out: { x: 250, y: 480 } },
      ],
    }]);
    const shape = {
      id: 'pen', type: 'shape' as const, ...drawn, rot: 0, z: 2, opacity: 1, class: [],
      style: { filter: 'drop-shadow(0px 8px 24px rgba(0, 0, 0, 0.3))' }, shape: 'path' as const,
      fill: '#c96442', stroke: '#111111', strokeWidth: 3, radius: 0, arrowStart: false, arrowEnd: false,
    };
    deck.slides[0].elements = [shape];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain(`data-path="${drawn.path}"`);
    expect(html).toContain(`data-path-size="${drawn.pathSize!.w},${drawn.pathSize!.h}"`);
    // Drawn by the same builder as the player's: the curves, in the path's own space.
    expect(html).toContain(`viewBox="0 0 ${drawn.pathSize!.w} ${drawn.pathSize!.h}"`);
    expect(html).toContain(`<path d="${drawn.path}"`);

    const back = elementFromNode(node({
      tag: 'div', html: '', rect: { x: drawn.x, y: drawn.y, w: drawn.w, h: drawn.h },
      dataset: {
        element: 'shape', shape: 'path', path: drawn.path!, pathSize: `${drawn.pathSize!.w},${drawn.pathSize!.h}`,
        fill: '#c96442', stroke: '#111111', strokeWidth: '3',
      },
    }), 'pen', 2);
    expect(back).toMatchObject({ shape: 'path', path: drawn.path, pathSize: drawn.pathSize, fill: '#c96442' });
    expect(parsePath((back as { path: string }).path)).toEqual(parsePath(drawn.path!));
  });

  it('round-trips a curly brace and its signed depth', () => {
    const deck = emptyDeck('Braces');
    const brace = {
      id: 'brace', type: 'shape' as const, x: 200, y: 300, w: 400, h: 2, rot: 30, z: 2,
      opacity: 1, class: [], style: {}, shape: 'brace' as const, fill: null, stroke: '#111111',
      strokeWidth: 6, radius: 0, path: null, pathSize: null, arrowStart: false,
      arrowEnd: false, braceDepth: -45,
    };
    deck.slides[0].elements = [brace];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-shape="brace"');
    expect(html).toContain('data-brace-depth="-45"');

    const back = elementFromNode(node({
      tag: 'div', html: '',
      dataset: { element: 'shape', shape: 'brace', stroke: '#111111', strokeWidth: '6', braceDepth: '-45' },
    }), 'brace', 2);
    expect(back).toMatchObject({ shape: 'brace', braceDepth: -45 });
    // A brace written without a depth stays without one and draws the default.
    const bare = elementFromNode(node({
      tag: 'div', html: '', dataset: { element: 'shape', shape: 'brace' },
    }), 'bare', 2);
    expect(bare).toMatchObject({ shape: 'brace' });
    expect('braceDepth' in bare!).toBe(false);
  });

  it('matches the HTML preview wrapper to rounded shape effect contours', () => {
    const deck = emptyDeck('Shape effects');
    const shape = {
      id: 'shape', type: 'shape', x: 200, y: 300, w: 400, h: 120, rot: 0, z: 2,
      opacity: 1, class: [], style: { 'box-shadow': '0 8px 24px #0008' },
      shape: 'ellipse', fill: '#ffffff', stroke: null, strokeWidth: 0, radius: 0,
      path: null, pathSize: null, arrowStart: false, arrowEnd: false, control: null,
    } satisfies Extract<SlideElement, { type: 'shape' }>;
    deck.slides[0].elements = [shape];

    const ellipseHtml = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(ellipseHtml).toContain('box-shadow:0 8px 24px #0008; border-radius:50%;');

    deck.slides[0].elements = [{ ...shape, shape: 'rect', radius: 31 }];
    const roundedRectHtml = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(roundedRectHtml).toContain('box-shadow:0 8px 24px #0008; border-radius:31px;');
  });

  it('exports text with the attributes that have no CSS equivalent', () => {
    const deck = emptyDeck('Text');
    deck.slides[0].elements = [{
      id: 'quote', type: 'text', x: 10, y: 20, w: 300, h: 100, rot: 0, z: 1,
      opacity: 1, class: ['role-title'], style: {}, html: 'Hi', align: 'center',
      valign: 'middle', autoFit: true,
    }];
    deck.slides[0].timeline = [{
      id: 't1',
      trigger: { on: 'afterPrev', ref: null, delay: 250 },
      action: { type: 'appear', target: 'quote', value: null },
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });

    expect(html).toContain('data-valign="middle"');
    expect(html).toContain('data-autofit="true"');
    expect(html).toContain('data-build="afterPrev+250"');
    expect(html).toContain('text-align:center');
  });

  it('exports native table layout metadata and its colgroup', () => {
    const deck = emptyDeck('Table');
    deck.slides[0].elements = [{
      id: 'table', type: 'text', x: 100, y: 200, w: 900, h: 240, rot: 0, z: 1,
      opacity: 1, class: ['role-body', 'results-table'], style: {}, align: 'left', valign: 'top',
      html: '<table><tbody><tr><td class="metric" style="border-width:4px">A</td><td>B</td></tr></tbody></table>',
      table: { columnWidths: [1, 2], autoHeight: true },
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], deck.canvas);
    expect(html).toContain('data-table="true"');
    expect(html).toContain('data-table-widths="1,2"');
    expect(html).toContain('results-table');
    expect(html).toContain('class="metric"');
    expect(html).toContain('border-width:4px');
    expect(html).toContain('<colgroup><col style="width: 33.333');
  });

  it('promotes CSS no-wrap into the editable text option and preserves an explicit clear', () => {
    const imported = elementFromNode(node({
      tag: 'p',
      html: 'One line',
      style: { 'white-space': 'nowrap', color: '#ffffff' },
    }), 'nowrap', 1);
    expect(imported).toMatchObject({
      type: 'text', noWrap: true, style: { color: '#ffffff' },
    });

    const deck = emptyDeck('Wrap');
    deck.slides[0].elements = [{
      ...(imported as Extract<SlideElement, { type: 'text' }>),
      noWrap: false,
      style: { 'white-space': 'nowrap' },
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-nowrap="false"');
    expect(html).not.toContain('white-space:nowrap');
  });

  it('mirrors inheritable inline text styles onto the content node', () => {
    // A theme rule targeting `.text-content` directly would otherwise beat
    // the wrapper's inline style; the mirror keeps the element's colour
    // authoritative in the compiled document too.
    const deck = emptyDeck('Mirror');
    deck.slides[0].elements = [{
      id: 'title', type: 'text', x: 10, y: 20, w: 300, h: 100, rot: 0, z: 1,
      opacity: 1, class: ['role-title'],
      style: { color: '#ffffff', 'font-size': '112px' },
      html: 'Hi', align: 'left', valign: 'middle',
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });

    expect(html).toMatch(/class="text-content"[^>]*style="[^"]*color:#ffffff/);
    // font-size stays off the content node — auto-fit owns it there.
    expect(html).not.toMatch(/class="text-content"[^>]*style="[^"]*font-size/);
  });

  it('round-trips advanced inner text CSS independently of wrapper CSS', () => {
    const gradient = {
      'background-image': 'linear-gradient(90deg, #ff4fa3, #52d273)',
      'background-clip': 'text',
      '-webkit-text-fill-color': 'transparent',
    };
    const element = elementFromNode(node({
      dataset: { contentStyle: encodeURIComponent(JSON.stringify(gradient)) },
      html: 'Gradient title',
    }), 'gradient-title', 1);
    expect(element).toMatchObject({ type: 'text', contentStyle: gradient });

    const deck = emptyDeck('Gradient');
    deck.slides[0].elements = [element!];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-content-style=');
    expect(html).toMatch(/class="text-content"[^>]*background-image:linear-gradient/);
    expect(html).not.toMatch(/class="element element-text"[^>]*background-image:linear-gradient/);
  });

  it('round-trips paragraph spacing through the data attribute', () => {
    const deck = emptyDeck('Spacing');
    deck.slides[0].elements = [{
      id: 'list', type: 'text', x: 10, y: 20, w: 300, h: 100, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, html: '<ul><li>a</li><li>b</li></ul>',
      align: 'left', valign: 'top', paragraphSpacing: 24,
    }];
    const html = slideToHtml(parseDeck(deck).slides[0], { w: 1920, h: 1080 });
    expect(html).toContain('data-paragraph-spacing="24"');
    expect(html).toContain('--paragraph-spacing:24px');

    const parsed = elementFromNode(node({
      tag: 'ul',
      html: '<li>a</li><li>b</li>',
      dataset: { paragraphSpacing: '24' },
    }), 'list', 1);
    expect(parsed).toMatchObject({ type: 'text', paragraphSpacing: 24 });
  });

  it('carries the slide identity a bake-back needs to find its target', () => {
    const slide = emptyDeck('Deck').slides[0];
    slide.morphDuration = 1450;
    const html = slideToHtml(slide, { w: 1920, h: 1080 });
    expect(html).toContain('data-slide-id="slide-1"');
    expect(html).toContain('data-canvas="1920x1080"');
    expect(html).toContain('data-morph-duration="1450"');
  });
});

describe('the authoring page\'s list rules', () => {
  // They are cut out of the player's type.css between two markers. Lose a
  // marker and the cut is empty: every bare list measured on browser
  // defaults again, silently, a dozen pixels short per item.
  it('are the player\'s own list rules, rescoped to bare lists', () => {
    const css = authoringListCss(PLAYER_TYPE_CSS);
    expect(css).toMatch(/^@layer deckwerk-authoring-lists \{\n@scope \(body\) to/);
    expect(css).toContain('li {\n  margin: 0.15em 0;');
    expect(css).toContain('ol > li::before {\n  content: counter(list-item)');
    expect(css).not.toContain('.text-body ');
    expect(css).not.toContain('border-collapse');
  });

  it('go into every page an author opens', () => {
    const page = slidesToHtml([], { w: 1920, h: 1080 }, { typeCss: PLAYER_TYPE_CSS, blank: 1 });
    expect(page).toContain(`<style data-authoring-lists>${authoringListCss(PLAYER_TYPE_CSS)}</style>`);
  });
});

describe('what a section carries besides its objects', () => {
  const step = (id: string, type: string, target: string, value: string | null = null, on = 'click', ref: string | null = null) => ({
    id, trigger: { on, ref, delay: 0 }, action: { type, target, value },
  });

  it('exports notes, the skip, and the timeline when the attributes cannot say it', () => {
    const deck = parseDeck({
      version: 1,
      slides: [{
        id: 's', notes: 'Say <this> & that', skipped: true,
        elements: [
          { id: 'a', type: 'text', x: 0, y: 0, w: 100, h: 50, z: 1, html: 'A' },
          { id: 'b', type: 'text', x: 0, y: 60, w: 100, h: 50, z: 2, html: 'B' },
        ],
        timeline: [step('t1', 'appear', 'b'), step('t2', 'appear', 'a'), step('t3', 'disappear', 'a', 'dissolve')],
      }, {
        id: 'plain', elements: [{ id: 'p', type: 'text', x: 0, y: 0, w: 100, h: 50, html: 'P' }],
        timeline: [step('p1', 'appear', 'p')],
      }],
    });
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html).toContain('data-skipped="true"');
    expect(html).toContain('<aside class="notes">Say &lt;this&gt; &amp; that</aside>');
    const block = /<script type="application\/deckwerk-timeline">([\s\S]*?)<\/script>/.exec(html);
    expect(JSON.parse(block![1])).toEqual(deck.slides[0].timeline);
    // Appearances in paint order and nothing else: the attributes say it all.
    expect(slideToHtml(deck.slides[1], deck.canvas)).not.toContain('deckwerk-timeline');
  });

  it('compiles a timeline block with the ids its objects were given, the attributes winning', () => {
    const deck = parseDeck({ version: 1, slides: [{ id: 'taken', elements: [{ id: 'a', type: 'text', x: 0, y: 0, w: 10, h: 10, html: 'x' }] }] });
    const [slide] = slidesFromMeasured(deck, [{
      id: null, name: '', notes: '\n      First line\n        indented\n    ', skipped: true,
      background: { color: null, image: null }, morphFromPrevious: false,
      nodes: [
        node({ elementId: 'a', dataset: { build: 'afterPrev+200' }, html: 'A' }),
        node({ elementId: 'b', html: 'B' }),
        node({ elementId: 'c', dataset: { build: 'click', buildOrder: '1' }, html: 'C' }),
      ],
      timeline: JSON.stringify([
        step('t1', 'appear', 'b'), step('t2', 'appear', 'a', 'byParagraph'),
        step('t3', 'disappear', 'a', null, 'mediaEnd', 'b'),
      ]),
    }]);
    const a = slide.elements[0].id;
    // `a` is taken in this deck: renamed, and every step follows it.
    expect(a).not.toBe('a');
    expect(slide.notes).toBe('First line\n  indented');
    expect(slide.skipped).toBe(true);
    expect(slide.timeline.map((entry) => [entry.action.type, entry.action.target, entry.action.value, entry.trigger.on, entry.trigger.ref]))
      .toEqual([
        // data-build-order="1" puts c's appearance first.
        ['appear', 'c', null, 'click', null],
        // b's data-build is gone from the page: its appearance goes.
        // a's attribute states its trigger; the block keeps its by-paragraph reveal.
        ['appear', a, 'byParagraph', 'afterPrev', null],
        ['disappear', a, null, 'mediaEnd', 'b'],
      ]);
  });

  it('refuses a timeline block that is not a timeline', () => {
    const measured = {
      id: null, name: '', notes: '', background: { color: null, image: null }, morphFromPrevious: false, nodes: [node()],
    };
    expect(() => slidesFromMeasured(emptyDeck('x'), [{ ...measured, timeline: '[{' }])).toThrow(/not valid JSON/);
    expect(() => slidesFromMeasured(emptyDeck('x'), [{ ...measured, timeline: '[{"id":"t"}]' }])).toThrow(/Entry 1 .* not a timeline entry/);
  });
});

describe('an exported range synced back', () => {
  /** A deck of `count` one-line slides, `s1` … `sN`. */
  function deckOf(count: number): Deck {
    return parseDeck({
      version: 1,
      slides: Array.from({ length: count }, (_, index) => ({
        id: `s${index + 1}`,
        name: `Slide ${index + 1}`,
        elements: [{
          id: `s${index + 1}-title`, type: 'text', x: 100, y: 100, w: 800, h: 120, html: `Slide ${index + 1}`,
        }],
      })),
    });
  }
  const edited = (deck: Deck, id: string): Slide => {
    const slide = structuredClone(deck.slides.find((candidate) => candidate.id === id)!);
    (slide.elements[0] as { html: string }).html = `${id}, edited`;
    return slide;
  };
  const fresh = (id: string): Slide => parseDeck({
    version: 1, slides: [{ id, elements: [{ id: `${id}-title`, type: 'text', x: 0, y: 0, w: 100, h: 50, html: id }] }],
  }).slides[0];
  const sync = (deck: Deck, slides: Slide[], scope: string[]) => {
    const operations = htmlSyncOperations(deck, slides, scope, null);
    const next = applyAgentOperations(deck, operations);
    return { summary: htmlSyncSummary(operations), order: next.slides.map((slide) => slide.id) };
  };

  // Bug #21: a non-contiguous export, edited only inside its sections, moved
  // every slide it named to sit right after the first one, and reported a
  // move for every slide in the deck.
  it('replaces the slides of a scattered export in place, moving nothing', () => {
    const deck = deckOf(100);
    const scope = ['s2', 's39', 's77', 's91'];
    const { summary, order } = sync(deck, scope.map((id) => edited(deck, id)), scope);
    expect(summary.replaced).toEqual(scope);
    expect(summary.moved).toBe(0);
    expect(order).toEqual(deck.slides.map((slide) => slide.id));
  });

  it('reorders a scattered export only among its own places, counting only what moved', () => {
    const deck = deckOf(100);
    const scope = ['s2', 's39', 's77'];
    const { summary, order } = sync(deck, [edited(deck, 's77'), edited(deck, 's2'), edited(deck, 's39')], scope);
    const expected = deck.slides.map((slide) => slide.id);
    expected[1] = 's77';
    expected[38] = 's2';
    expected[76] = 's39';
    expect(order).toEqual(expected);
    expect(summary.moved).toBeGreaterThan(0);
    expect(summary.moved).toBeLessThanOrEqual(3);
  });

  it('puts a new section of a scattered export after the slide of the section before it', () => {
    const deck = deckOf(60);
    const scope = ['s2', 's39', 's50'];
    const { summary, order } = sync(deck, [
      fresh('lead'), edited(deck, 's2'), edited(deck, 's39'), fresh('after-39'), edited(deck, 's50'), fresh('tail'),
    ], scope);
    const expected = deck.slides.map((slide) => slide.id);
    expected.splice(expected.indexOf('s50') + 1, 0, 'tail');
    expected.splice(expected.indexOf('s39') + 1, 0, 'after-39');
    expected.splice(expected.indexOf('s2'), 0, 'lead');
    expect(order).toEqual(expected);
    expect([...summary.inserted].sort()).toEqual(['after-39', 'lead', 'tail']);
    expect(summary.moved).toBe(0);
  });

  it('deletes a slide a scattered export dropped and leaves the others where they are', () => {
    const deck = deckOf(30);
    const scope = ['s3', 's10', 's20'];
    const { summary, order } = sync(deck, [edited(deck, 's3'), edited(deck, 's20')], scope);
    expect(summary.deleted).toEqual(['s10']);
    expect(summary.moved).toBe(0);
    expect(order).toEqual(deck.slides.map((slide) => slide.id).filter((id) => id !== 's10'));
  });

  it('still treats a contiguous export as one block, counting only the slides that moved', () => {
    const deck = deckOf(10);
    const scope = ['s4', 's5', 's6'];
    const { summary, order } = sync(deck, [edited(deck, 's6'), fresh('new'), edited(deck, 's4')], scope);
    expect(order).toEqual(['s1', 's2', 's3', 's6', 'new', 's4', 's7', 's8', 's9', 's10']);
    expect(summary.deleted).toEqual(['s5']);
    expect(summary.moved).toBe(1);
  });
});
