// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck, type Slide, type SlideElement } from '../src/shared/deck.js';
import { EditorCanvas } from '../src/renderer/editor/canvas.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { findRenderDivergences, formatDivergence } from '../src/renderer/editor/renderInvariants.js';
import { installCanvasDomShims } from './support/canvasHarness.js';

/**
 * The model/DOM agreement invariant, applied to one editor operation at a time.
 *
 * The editor patches existing nodes for non-structural changes instead of
 * rebuilding the slide, which means every render rule exists twice: once in
 * `renderElement` and once in `EditorCanvas.applyGeometry`. A property mirrored
 * in only one of them updates the deck without changing the pixels, and stays
 * invisible until something forces a rebuild -- the "it only showed up after I
 * left the slide and came back" bug.
 *
 * Each case below performs a change the inspector can perform, then asserts the
 * canvas DOM still matches a fresh render. A failure names the property and the
 * two paths that disagree, so the class is caught by construction rather than
 * one instance at a time.
 */

function textElement(): SlideElement {
  return {
    id: 'text-1',
    type: 'text',
    x: 100, y: 100, w: 600, h: 120,
    rot: 0, z: 1, opacity: 1,
    class: [], style: {},
    html: 'Original text',
    align: 'left',
    valign: 'middle',
  };
}

function videoElement(): SlideElement {
  return {
    id: 'video-1',
    type: 'video',
    x: 100, y: 300, w: 640, h: 360,
    rot: 0, z: 2, opacity: 1,
    class: [], style: {},
    src: 'assets/clip.mp4',
    fit: 'contain',
    autoplay: true, loop: true, muted: true, controls: false,
    start: 0, end: null, poster: null, sourceBox: null,
  };
}

function imageElement(): SlideElement {
  return {
    id: 'image-1',
    type: 'image',
    x: 50, y: 50, w: 300, h: 200,
    rot: 0, z: 3, opacity: 1,
    class: [], style: {},
    src: 'assets/pic.png',
    fit: 'cover',
    alt: '', sourceBox: null,
  };
}

function shapeElement(): SlideElement {
  return {
    id: 'shape-1',
    type: 'shape',
    x: 200, y: 480, w: 240, h: 140,
    rot: 0, z: 5, opacity: 1,
    class: [], style: {},
    shape: 'rect', fill: '#3366cc', stroke: '#000000',
    strokeWidth: 2, radius: 0, path: null, pathSize: null,
    arrowStart: false, arrowEnd: false, control: null,
  };
}

function setup(elements: SlideElement[]) {
  installCanvasDomShims();
  const deck = emptyDeck('Invariants');
  deck.slides[0].elements = elements;
  const store = new EditorStore(deck);
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const canvas = new EditorCanvas(host, store);
  canvas.render();
  const slideLayer = host.querySelector<HTMLElement>('.slide-layer')
    ?? host.querySelector<HTMLElement>('.slide')?.parentElement!;
  return { store, canvas, slideLayer };
}

/**
 * Apply a change the way the editor does -- a commit that keeps the element
 * identities, so the canvas takes its in-place patch path -- then re-render and
 * report what the two paths disagree about.
 */
function divergencesAfter(
  elements: SlideElement[],
  mutate: (slide: Slide) => void,
): string[] {
  const { store, canvas, slideLayer } = setup(elements);
  store.commit((deck) => {
    mutate(deck.slides[0]);
  }, { label: 'edit' });
  canvas.render();
  const slide = store.get().deck.slides[0];
  return findRenderDivergences(slideLayer, slide, (src) => src).map(formatDivergence);
}

function firstOf<T extends SlideElement['type']>(slide: Slide, type: T) {
  const element = slide.elements.find((e) => e.type === type);
  if (!element) throw new Error(`no ${type} element`);
  return element as Extract<SlideElement, { type: T }>;
}

describe('canvas render invariant', () => {
  it('holds after a text alignment change', () => {
    expect(divergencesAfter([textElement()], (slide) => {
      firstOf(slide, 'text').align = 'center';
    })).toEqual([]);
  });

  it('treats an auto-fit text body\'s fitted size as a measurement, not a model value', () => {
    // A fit pass stamps `data-fitted-font-size` beside the font size it
    // writes; a fresh, unmeasured render has neither. Found by the rail
    // multi-delete fuzz op: the blank slide a whole-deck delete leaves has
    // auto-fitting placeholders, and the next in-place patch reported them.
    const { store, canvas, slideLayer } = setup([{ ...textElement(), autoFit: true } as SlideElement]);
    const content = slideLayer.querySelector<HTMLElement>('[data-element-id="text-1"] .text-content')!;
    content.style.fontSize = '92px';
    content.dataset.fittedFontSize = '92';
    store.commit((deck) => { deck.slides[0].elements[0].x += 10; }, { label: 'edit' });
    canvas.render();
    expect(findRenderDivergences(slideLayer, store.get().deck.slides[0], (src) => src).map(formatDivergence))
      .toEqual([]);
  });

  it('holds after a vertical alignment change', () => {
    expect(divergencesAfter([textElement()], (slide) => {
      firstOf(slide, 'text').valign = 'top';
    })).toEqual([]);
  });

  it('holds after a text colour change', () => {
    expect(divergencesAfter([textElement()], (slide) => {
      firstOf(slide, 'text').style.color = 'rgb(255, 0, 0)';
    })).toEqual([]);
  });

  it('holds after a geometry change', () => {
    expect(divergencesAfter([textElement()], (slide) => {
      const text = firstOf(slide, 'text');
      text.x = 240;
      text.w = 420;
      text.rot = 15;
    })).toEqual([]);
  });

  it('holds after an opacity change', () => {
    expect(divergencesAfter([textElement()], (slide) => {
      firstOf(slide, 'text').opacity = 0.4;
    })).toEqual([]);
  });

  it('holds after a paragraph spacing change', () => {
    expect(divergencesAfter([textElement()], (slide) => {
      firstOf(slide, 'text').paragraphSpacing = 12;
    })).toEqual([]);
  });

  it('holds after a content style change', () => {
    expect(divergencesAfter([textElement()], (slide) => {
      firstOf(slide, 'text').contentStyle = { 'letter-spacing': '2px' };
    })).toEqual([]);
  });

  it('holds after a video resize', () => {
    expect(divergencesAfter([videoElement()], (slide) => {
      const video = firstOf(slide, 'video');
      video.w = 480;
      video.h = 270;
    })).toEqual([]);
  });

  it('holds after a video fit toggle', () => {
    expect(divergencesAfter([videoElement()], (slide) => {
      firstOf(slide, 'video').fit = 'fill';
    })).toEqual([]);
  });

  it('holds after a video mute, loop and controls change', () => {
    expect(divergencesAfter([videoElement()], (slide) => {
      const video = firstOf(slide, 'video');
      video.muted = false;
      video.loop = false;
      video.controls = true;
    })).toEqual([]);
  });

  it('holds after a shape resize', () => {
    expect(divergencesAfter([shapeElement()], (slide) => {
      const shape = firstOf(slide, 'shape');
      shape.w = 400;
      shape.h = 90;
    })).toEqual([]);
  });

  it('holds after an object-position change on cropped media', () => {
    const cropped = imageElement();
    if (cropped.type === 'image') cropped.sourceBox = { x: -10, y: -10, w: 340, h: 260 };
    expect(divergencesAfter([cropped], (slide) => {
      firstOf(slide, 'image').style['object-position'] = 'top left';
    })).toEqual([]);
  });

  it('holds after a media border change', () => {
    expect(divergencesAfter([imageElement()], (slide) => {
      const image = firstOf(slide, 'image');
      image.borderWidth = 4;
      image.borderColor = '#ff0000';
    })).toEqual([]);
  });

  it('holds after a corner radius change', () => {
    expect(divergencesAfter([imageElement()], (slide) => {
      firstOf(slide, 'image').borderRadius = 18;
    })).toEqual([]);
  });

  it('holds after a mask shape change', () => {
    expect(divergencesAfter([imageElement()], (slide) => {
      firstOf(slide, 'image').maskShape = 'circle';
    })).toEqual([]);
  });

  it('holds after a crop change', () => {
    expect(divergencesAfter([imageElement()], (slide) => {
      firstOf(slide, 'image').sourceBox = { x: -20, y: -10, w: 400, h: 260 };
    })).toEqual([]);
  });

  it('holds after a visual effect change', () => {
    expect(divergencesAfter([imageElement()], (slide) => {
      firstOf(slide, 'image').effects = [{ type: 'blur', radius: 6 }];
    })).toEqual([]);
  });

  it('holds after an element class change', () => {
    expect(divergencesAfter([textElement()], (slide) => {
      firstOf(slide, 'text').class = ['role-title'];
    })).toEqual([]);
  });

  it('holds after a style property is removed', () => {
    const styled = textElement();
    styled.style = { color: 'rgb(0, 0, 255)' };
    expect(divergencesAfter([styled], (slide) => {
      delete firstOf(slide, 'text').style.color;
    })).toEqual([]);
  });

  it('holds after a slide background change', () => {
    expect(divergencesAfter([textElement()], (slide) => {
      slide.background = { ...slide.background, color: 'rgb(10, 20, 30)' };
    })).toEqual([]);
  });

  it('holds after a z-order swap', () => {
    expect(divergencesAfter([textElement(), videoElement()], (slide) => {
      firstOf(slide, 'text').z = 9;
    })).toEqual([]);
  });
});
