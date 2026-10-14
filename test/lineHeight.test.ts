import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import {
  lineHeightRatio,
  lineSpacingValue,
  normalizeHtmlLineHeights,
  normalizeStyleLineHeight,
} from '../src/shared/lineHeight.js';

/**
 * Line height is a ratio of the font size wherever a deck stores it. A length
 * is inherited as that length, so a box imported at 48px with 63.36px lines
 * kept 63px lines when its text was set to 20px -- "small font with big
 * lines". These tests pin the conversion and every door it has to guard.
 */

type TextEl = Extract<SlideElement, { type: 'text' }>;

function deckWith(element: Partial<TextEl>): Deck {
  const deck = emptyDeck('Line height');
  deck.slides[0].elements.push({
    id: 'text-1', type: 'text', x: 0, y: 0, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, html: '<p>Hello</p>', align: 'left', valign: 'top',
    ...element,
  } as TextEl);
  return deck;
}

function textOf(deck: Deck): TextEl {
  return deck.slides[0].elements[0] as TextEl;
}

describe('lineHeightRatio', () => {
  it('turns a px line height into the ratio of the px size beside it', () => {
    // The real box from Vincent's deck, imported from HTML.
    expect(lineHeightRatio('63.36px', '48px')).toBe('1.32');
    expect(lineHeightRatio('39.2px', '28px')).toBe('1.4');
    expect(lineHeightRatio(' 50px ', ' 30px ')).toBe('1.667');
  });

  it('turns em and percent, which are lengths too, into ratios without a size', () => {
    expect(lineHeightRatio('1.5em')).toBe('1.5');
    expect(lineHeightRatio('120%')).toBe('1.2');
  });

  it('leaves what it cannot convert losslessly alone', () => {
    expect(lineHeightRatio('1.32', '48px')).toBeNull();
    expect(lineHeightRatio('normal', '48px')).toBeNull();
    // No size, or a size that is not a measurement: the ratio is unknowable.
    expect(lineHeightRatio('40px')).toBeNull();
    expect(lineHeightRatio('40px', '2em')).toBeNull();
    expect(lineHeightRatio('40px', '0px')).toBeNull();
    expect(lineHeightRatio('calc(1em + 4px)', '20px')).toBeNull();
  });
});

describe('normalizeStyleLineHeight', () => {
  it('returns the very same object when there is nothing to change', () => {
    const healthy = { 'font-size': '48px', 'line-height': '1.32' };
    expect(normalizeStyleLineHeight(healthy)).toBe(healthy);
    const unknowable = { 'line-height': '39.2px' };
    expect(normalizeStyleLineHeight(unknowable)).toBe(unknowable);
  });

  it('rewrites only the line height', () => {
    expect(normalizeStyleLineHeight({ color: 'red', 'font-size': '48px', 'line-height': '63.36px' }))
      .toEqual({ color: 'red', 'font-size': '48px', 'line-height': '1.32' });
  });
});

describe('normalizeHtmlLineHeights', () => {
  it('converts a block that states its own px size, and nothing that does not', () => {
    expect(normalizeHtmlLineHeights(
      '<p style="font-size: 20px; line-height: 30px;">a</p><p style="line-height: 30px">b</p>',
    )).toBe('<p style="font-size: 20px; line-height: 1.5;">a</p><p style="line-height: 30px">b</p>');
    expect(normalizeHtmlLineHeights("<li style='line-height:150%'>c</li>"))
      .toBe("<li style='line-height:1.5'>c</li>");
  });

  it('leaves markup without a length line height untouched', () => {
    const html = '<p style="line-height: 1.4">a</p><p>line-height: 30px is prose</p>';
    expect(normalizeHtmlLineHeights(html)).toBe(html);
  });
});

describe('every way in stores a ratio', () => {
  it('heals a deck written with a px line height when it is parsed', () => {
    const deck = parseDeck(JSON.parse(JSON.stringify(deckWith({
      style: { 'font-size': '48px', 'line-height': '63.36px' },
      contentStyle: { 'font-size': '20px', 'line-height': '30px' },
      html: '<p style="font-size: 20px; line-height: 25px">Hello</p>',
    }))));
    expect(textOf(deck).style).toEqual({ 'font-size': '48px', 'line-height': '1.32' });
    expect(textOf(deck).contentStyle).toEqual({ 'font-size': '20px', 'line-height': '1.5' });
    expect(textOf(deck).html).toBe('<p style="font-size: 20px; line-height: 1.25">Hello</p>');
    // Parsing again is a no-op: the deck is stable once healed.
    expect(parseDeck(JSON.parse(JSON.stringify(deck)))).toEqual(deck);
  });

  it('keeps a px line height whose size the box does not state', () => {
    const deck = parseDeck(JSON.parse(JSON.stringify(deckWith({
      style: { 'line-height': '39.2px' },
    }))));
    expect(textOf(deck).style).toEqual({ 'line-height': '39.2px' });
  });

  it('imports a measured HTML box with its computed px line height as a ratio', () => {
    const measured: MeasuredNode = {
      tag: 'p', elementId: null, classes: [], dataset: {},
      rect: { x: 100, y: 200, w: 800, h: 120 }, rotation: 0, opacity: 1,
      style: { 'font-size': '48px', 'line-height': '63.36px', color: 'rgb(0, 0, 0)' },
      html: 'Hello', attrs: {},
    };
    const element = elementFromNode(measured, 'imported', 1) as TextEl;
    expect(element.style['line-height']).toBe('1.32');
    expect(element.style['font-size']).toBe('48px');
  });

  it('exports the ratio to the agent page, so the round trip cannot bring px back', () => {
    const deck = parseDeck(JSON.parse(JSON.stringify(deckWith({
      style: { 'font-size': '48px', 'line-height': '63.36px' },
    }))));
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html).toMatch(/line-height:\s*1\.32/);
    expect(html).not.toMatch(/line-height:\s*63\.36px/);
  });
});

describe('the PowerPoint importer', () => {
  // Exact spacing in points used to land as px; it is now a ratio of the
  // box's own size. The converter's arithmetic is all stdlib, so it runs here
  // without a .pptx (the end-to-end importer suite is in the serial tier).
  it('writes exact spacing as a ratio of the box size, and percentages as before', () => {
    const python = existsSync(join(process.cwd(), '.venv-import/bin/python'))
      ? join(process.cwd(), '.venv-import/bin/python')
      : 'python3';
    const stdout = execFileSync(python, ['-c', [
      'import sys',
      'sys.path.insert(0, "importers/pptx")',
      'from import_pptx import TextConverter, ParaStyle',
      'class Importer:',
      '    def pt_to_px(self, pt): return pt * 2',
      'converter = TextConverter.__new__(TextConverter)',
      'converter.importer = Importer()',
      'converter.font_scale = 1.0',
      // 31.68pt is 63.36px: the spacing of a 48px box at 1.32.
      'print(converter.line_height(ParaStyle(line_spacing_pt=31.68), 48.0))',
      'print(converter.line_height(ParaStyle(line_spacing_pt=20), 30.4))',
      'print(converter.line_height(ParaStyle(line_spacing_pct=1.5), 48.0))',
      'print(converter.line_height(ParaStyle(), 48.0))',
    ].join('\n')], { encoding: 'utf8', cwd: process.cwd() });
    expect(stdout.trim().split('\n')).toEqual(['1.32', '1.333', '1.80', 'None']);
  });
});

describe('lineSpacingValue', () => {
  it('clamps to the control range and two decimals', () => {
    expect(lineSpacingValue(1.234)).toBe(1.23);
    expect(lineSpacingValue(0.1)).toBe(0.5);
    expect(lineSpacingValue(9)).toBe(4);
  });
});
