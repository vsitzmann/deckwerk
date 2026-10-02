// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { shapeSvg } from '../src/shared/shapeSvg.js';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import { curvedShadow, setCurvedShadow } from '../src/shared/shapeShadow.js';
import { renderSlide } from '../src/renderer/player/render.js';
import { applyStaticSlideState } from '../src/renderer/player/staticState.js';
import { resolveState } from '../src/shared/timeline.js';

/** Gradient fills and curved (paper) shadows on shapes. */

type Shape = Extract<SlideElement, { type: 'shape' }>;
const rect = (over: Partial<Shape> = {}): Shape => ({
  id: 'card', type: 'shape', shape: 'rect', x: 0, y: 0, w: 400, h: 200, rot: 0, z: 1, opacity: 1, class: [], style: {},
  fill: '#7b90e1', stroke: null, strokeWidth: 0, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
  ...over,
} as Shape);

const node = (over: Partial<MeasuredNode>): MeasuredNode => ({
  tag: 'div', elementId: null, classes: [], dataset: {}, rect: { x: 0, y: 0, w: 400, h: 200 },
  rotation: 0, opacity: 1, style: {}, html: '', attrs: {}, ...over,
});

describe('gradient fills', () => {
  it('paints a linear gradient in the stored direction, from fill to `to`', () => {
    const svg = shapeSvg(rect({ fillGradient: { to: '#ec6b14', angle: 270, kind: 'linear' } }));
    expect(svg).toContain('<linearGradient id="fill-card" x1="0.5" y1="0" x2="0.5" y2="1">');
    expect(svg).toContain('<stop offset="0" stop-color="#7b90e1"/><stop offset="1" stop-color="#ec6b14"/>');
    expect(svg).toContain('fill="url(#fill-card)"');
  });

  it('runs left to right at 0 degrees, and spreads from the centre when radial', () => {
    expect(shapeSvg(rect({ fillGradient: { to: '#000', angle: 0, kind: 'linear' } })))
      .toContain('x1="0" y1="0.5" x2="1" y2="0.5"');
    expect(shapeSvg(rect({ fillGradient: { to: '#000', angle: 0, kind: 'radial' } })))
      .toContain('<radialGradient id="fill-card"');
  });

  it('stays a flat fill when there is no gradient, or nothing to start it from', () => {
    expect(shapeSvg(rect())).not.toContain('Gradient');
    expect(shapeSvg(rect({ fill: null, fillGradient: { to: '#000', angle: 0, kind: 'linear' } }))).not.toContain('Gradient');
  });

  it('survives the HTML round trip', () => {
    const shape = rect({ fillGradient: { to: '#ec6b14', angle: 315, kind: 'linear' } });
    const slide = emptyDeck('Look').slides[0];
    slide.elements.push(shape);
    const html = slideToHtml(slide, { w: 1920, h: 1080 });
    expect(html).toContain('data-fill-to="#ec6b14"');
    expect(html).toContain('data-fill-angle="315"');
    const back = elementFromNode(node({
      dataset: { element: 'shape', shape: 'rect', fill: '#7b90e1', fillTo: '#ec6b14', fillAngle: '315', fillGradient: 'linear' },
    }), 'card', 1);
    expect(back).toMatchObject({ type: 'shape', fill: '#7b90e1', fillGradient: { to: '#ec6b14', angle: 315, kind: 'linear' } });
  });
});

describe('curved shadows', () => {
  it('are read and written as --curl-* custom properties', () => {
    const style: Record<string, string> = { filter: 'blur(1px)' };
    setCurvedShadow(style, { color: 'rgba(0, 0, 0, 0.5)', blur: 14, lift: 20 });
    expect(style).toEqual({
      filter: 'blur(1px)', '--curl-color': 'rgba(0, 0, 0, 0.5)', '--curl-blur': '14px', '--curl-lift': '20px',
    });
    expect(curvedShadow(style)).toEqual({ color: 'rgba(0, 0, 0, 0.5)', blur: 14, lift: 20 });
    setCurvedShadow(style, null);
    expect(style).toEqual({ filter: 'blur(1px)' });
    expect(curvedShadow(style)).toBeNull();
  });

  it('are kept when an authored shape is imported', () => {
    const back = elementFromNode(node({
      dataset: { element: 'shape', shape: 'rect', fill: '#ffffff' },
      style: { '--curl-color': 'rgba(0,0,0,.4)', '--curl-lift': '24px', '--unrelated': 'x' },
    }), 'card', 1);
    expect(back?.style).toEqual({ '--curl-color': 'rgba(0,0,0,.4)', '--curl-lift': '24px' });
  });
});

describe('the curl class', () => {
  it('outlives the static build state, which rebuilds every class list', () => {
    const slide = emptyDeck('Look').slides[0];
    slide.elements.push(rect({ style: { '--curl-color': 'rgba(0, 0, 0, 0.5)' } }));
    const stage = document.createElement('div');
    stage.appendChild(renderSlide(slide, { resolveSrc: (src) => src }));
    expect(stage.querySelector('[data-element-id="card"]')?.classList.contains('shadow-curved')).toBe(true);
    applyStaticSlideState(stage, slide, resolveState(slide, 0));
    expect(stage.querySelector('[data-element-id="card"]')?.classList.contains('shadow-curved')).toBe(true);
  });
});
