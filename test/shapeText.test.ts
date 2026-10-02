import { describe, expect, it } from 'vitest';
import type { ShapeEl } from '../src/shared/deck.js';
import { boxShadow, shapeShadow } from '../src/shared/shapeShadow.js';
import {
  canHoldText,
  hasTextBox,
  setTextBoxBorder,
  setTextBoxFill,
  setTextBoxRadius,
  shapeToTextBox,
  textBoxPaint,
} from '../src/shared/shapeText.js';

function shape(over: Partial<ShapeEl> = {}): ShapeEl {
  return {
    id: 'box', type: 'shape', shape: 'rect', x: 100, y: 200, w: 400, h: 240, rot: 12, z: 3,
    opacity: 0.8, class: [], style: {}, fill: '#dbe4ff', stroke: '#3f55b5', strokeWidth: 4,
    radius: 24, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    morphId: 'pair-1',
    ...over,
  } as ShapeEl;
}

describe('typing into a shape turns it into a text box that looks the same', () => {
  it('keeps identity and geometry, and carries the paint as CSS on the box', () => {
    const text = shapeToTextBox(shape());
    expect(text).toMatchObject({
      id: 'box', type: 'text', x: 100, y: 200, w: 400, h: 240, rot: 12, z: 3, opacity: 0.8,
      morphId: 'pair-1', align: 'center', valign: 'middle', autoFit: true,
    });
    expect(text.style).toMatchObject({
      'background-color': '#dbe4ff',
      border: '4px solid #3f55b5',
      'border-radius': '24px',
      'box-sizing': 'border-box',
    });
    // Nothing of the shape is left behind for the schema to reject.
    for (const key of ['shape', 'fill', 'stroke', 'strokeWidth', 'radius', 'path', 'arrowEnd']) {
      expect(text).not.toHaveProperty(key);
    }
    // A prompt on the canvas, replaced by the first key and hidden when presenting.
    expect(text.class).toContain('placeholder');
    expect(textBoxPaint(text.style)).toEqual({
      fill: '#dbe4ff', border: { color: '#3f55b5', width: 4 }, radius: 24, round: false,
    });
  });

  it('makes an ellipse a round box and leaves an unpainted shape unpainted', () => {
    const round = shapeToTextBox(shape({ shape: 'ellipse', stroke: null }));
    expect(round.style['border-radius']).toBe('50%');
    expect(round.style.border).toBeUndefined();
    expect(textBoxPaint(round.style)).toMatchObject({ round: true, radius: null, border: null });

    const bare = shapeToTextBox(shape({ fill: null, stroke: null, radius: 0 }));
    expect(hasTextBox(bare.style)).toBe(false);
  });

  it('moves the shape shadow onto the box', () => {
    const text = shapeToTextBox(shape({
      style: { filter: 'drop-shadow(0px 8px 24px rgba(0, 0, 0, 0.3))' },
    }));
    expect(text.style.filter).toBeUndefined();
    expect(shapeShadow(text.style)).toEqual(boxShadow(text.style));
    expect(boxShadow(text.style)).toEqual({ x: 0, y: 8, blur: 24, color: 'rgba(0, 0, 0, 0.3)' });
  });

  it('is offered for boxes only', () => {
    expect(canHoldText(shape())).toBe(true);
    expect(canHoldText(shape({ shape: 'ellipse' }))).toBe(true);
    expect(canHoldText(shape({ shape: 'arrow' }))).toBe(false);
    expect(canHoldText(shape({ shape: 'path' }))).toBe(false);
  });
});

describe('a text box fill, border and radius', () => {
  it('reads what an HTML import stores and rewrites it cleanly', () => {
    const style: Record<string, string> = {
      background: '#dbe4ff', 'background-color': 'rgb(219, 228, 255)',
      border: '4px solid #3f55b5', 'border-radius': '28px',
    };
    expect(textBoxPaint(style)).toEqual({
      fill: 'rgb(219, 228, 255)', border: { color: '#3f55b5', width: 4 }, radius: 28, round: false,
    });
    setTextBoxFill(style, '#ffffff');
    setTextBoxBorder(style, { color: 'red', width: 2 });
    setTextBoxRadius(style, 0);
    expect(style).toEqual({
      'background-color': '#ffffff', border: '2px solid red', 'box-sizing': 'border-box',
    });
    setTextBoxFill(style, null);
    setTextBoxBorder(style, null);
    expect(hasTextBox(style)).toBe(false);
  });

  it('does not mistake gradient text for a filled box', () => {
    expect(textBoxPaint({
      'background-image': 'linear-gradient(red, blue)', 'background-clip': 'text',
      'background-color': 'red',
    }).fill).toBeNull();
    expect(textBoxPaint({ background: 'linear-gradient(red, blue)' }).fill).toBeNull();
  });
});
