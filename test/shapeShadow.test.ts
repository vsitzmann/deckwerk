import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHAPE_SHADOW,
  DEFAULT_TEXT_SHADOW,
  setShapeShadow,
  setTextShadow,
  shadowOffset,
  shadowPolar,
  shapeShadow,
  textShadow,
} from '../src/shared/shapeShadow.js';

describe('a shape drop shadow stored as CSS', () => {
  it('writes a filter the player paints and reads the same values back', () => {
    const style: Record<string, string> = {};
    setShapeShadow(style, { x: 4, y: 12, blur: 30, color: 'rgba(10, 20, 30, 0.4)' });
    expect(style).toEqual({ filter: 'drop-shadow(4px 12px 30px rgba(10, 20, 30, 0.4))' });
    expect(shapeShadow(style)).toEqual({ x: 4, y: 12, blur: 30, color: 'rgba(10, 20, 30, 0.4)' });
  });

  it('reads the colour-first order computed styles serialise in', () => {
    // What an HTML round trip stores: the browser moves the colour to the front.
    expect(shapeShadow({ filter: 'drop-shadow(rgba(0, 0, 0, 0.3) 0px 8px 24px)' }))
      .toEqual(DEFAULT_SHAPE_SHADOW);
    expect(shapeShadow({ filter: 'drop-shadow(#112233 -2px 0 0)' }))
      .toEqual({ x: -2, y: 0, blur: 0, color: '#112233' });
  });

  it('shows a plain box-shadow and converts it on the first edit', () => {
    const style: Record<string, string> = { 'box-shadow': 'rgba(0, 0, 0, 0.35) 0px 18px 40px 0px' };
    const shadow = shapeShadow(style);
    expect(shadow).toEqual({ x: 0, y: 18, blur: 40, color: 'rgba(0, 0, 0, 0.35)' });
    setShapeShadow(style, { ...shadow!, blur: 20 });
    expect(style).toEqual({ filter: 'drop-shadow(0px 18px 20px rgba(0, 0, 0, 0.35))' });
  });

  it('leaves shadows it cannot represent alone', () => {
    const layered = { 'box-shadow': '0 1px 2px red, 0 8px 24px blue' };
    expect(shapeShadow(layered)).toBeNull();
    expect(shapeShadow({ 'box-shadow': 'inset 0 1px 2px red' })).toBeNull();
    expect(shapeShadow({ 'box-shadow': '0 8px 24px 6px red' })).toBeNull();
    expect(shapeShadow({ filter: 'drop-shadow(0 1em 2em red)' })).toBeNull();
    expect(shapeShadow({ filter: 'drop-shadow(0 1px 2px red) drop-shadow(0 8px 9px blue)' })).toBeNull();
    // Adding a shadow does not delete a hand-written layered one.
    const style: Record<string, string> = { ...layered };
    setShapeShadow(style, DEFAULT_SHAPE_SHADOW);
    expect(style['box-shadow']).toBe(layered['box-shadow']);
    expect(shapeShadow(style)).toEqual(DEFAULT_SHAPE_SHADOW);
  });

  it('keeps other filter functions and removes only the shadow', () => {
    const style: Record<string, string> = { filter: 'blur(2px) drop-shadow(0px 8px 24px rgba(0, 0, 0, 0.3))' };
    expect(shapeShadow(style)).toEqual(DEFAULT_SHAPE_SHADOW);
    setShapeShadow(style, null);
    expect(style).toEqual({ filter: 'blur(2px)' });
    setShapeShadow(style, null);
    expect(style).toEqual({ filter: 'blur(2px)' });
    const only: Record<string, string> = { filter: 'drop-shadow(0px 8px 24px red)', fill: 'x' };
    setShapeShadow(only, null);
    expect(only).toEqual({ fill: 'x' });
  });
});

describe('a text box shadow', () => {
  it('is text-shadow on the glyphs, read in either colour order', () => {
    const style: Record<string, string> = { color: '#111' };
    setTextShadow(style, DEFAULT_TEXT_SHADOW);
    expect(style['text-shadow']).toBe('0px 4px 10px rgba(0, 0, 0, 0.35)');
    expect(textShadow(style)).toEqual(DEFAULT_TEXT_SHADOW);
    expect(textShadow({ 'text-shadow': 'rgba(0, 0, 0, 0.4) 0px 8px 18px' }))
      .toEqual({ x: 0, y: 8, blur: 18, color: 'rgba(0, 0, 0, 0.4)' });
    setTextShadow(style, null);
    expect(style).toEqual({ color: '#111' });
  });

  it('does not claim a layered shadow', () => {
    expect(textShadow({ 'text-shadow': '0 1px 0 #fff, 0 2px 6px #000' })).toBeNull();
    expect(textShadow({ 'text-shadow': 'none' })).toBeNull();
  });
});

describe('a shadow offset as an angle and a distance', () => {
  it('measures the angle counter-clockwise from the right, so 270 is straight down', () => {
    expect(shadowPolar({ x: 0, y: 8, blur: 0, color: 'red' })).toEqual({ angle: 270, distance: 8 });
    expect(shadowPolar({ x: 8, y: 0, blur: 0, color: 'red' })).toEqual({ angle: 0, distance: 8 });
    expect(shadowPolar({ x: 0, y: -8, blur: 0, color: 'red' })).toEqual({ angle: 90, distance: 8 });
    expect(shadowPolar({ x: 6, y: 6, blur: 0, color: 'red' })).toEqual({ angle: 315, distance: 8.49 });
    // No offset has no direction; it rests pointing down.
    expect(shadowPolar({ x: 0, y: 0, blur: 9, color: 'red' })).toEqual({ angle: 270, distance: 0 });
  });

  it('turns an angle and a distance back into the stored offset', () => {
    expect(shadowOffset(270, 8)).toEqual({ x: 0, y: 8 });
    expect(shadowOffset(0, 8)).toEqual({ x: 8, y: 0 });
    expect(shadowOffset(315, 10)).toEqual({ x: 7.0711, y: 7.0711 });
    expect(shadowOffset(135, 10)).toEqual({ x: -7.0711, y: -7.0711 });
    expect(shadowOffset(90, -5)).toEqual({ x: 0, y: 0 });
    // Turning a shadow keeps its length.
    const turned = shadowOffset(45, shadowPolar({ x: 0, y: 12, blur: 0, color: 'red' }).distance);
    expect(shadowPolar({ ...turned, blur: 0, color: 'red' })).toEqual({ angle: 45, distance: 12 });
  });
});
