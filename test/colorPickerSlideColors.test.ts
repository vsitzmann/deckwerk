// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { colorField, setSlideColorSource } from '../src/renderer/editor/colorPicker.js';

/** The picker offers the colours already on the current slide, and picking one commits it. */
describe('the "On this slide" row', () => {
  afterEach(() => {
    setSlideColorSource(() => []);
    document.body.replaceChildren();
  });

  it('lists the slide colours and applies the one clicked', () => {
    setSlideColorSource(() => ['#ec6b14', '#7b90e1']);
    const picked: Array<string | null> = [];
    const field = colorField('Fill', '#191918', (value) => picked.push(value));
    document.body.appendChild(field);
    field.querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    const row = document.querySelector('.color-picker-slide-palette');
    expect(row).not.toBeNull();
    const swatches = [...row!.querySelectorAll<HTMLButtonElement>('button')];
    expect(swatches.map((swatch) => swatch.title)).toEqual(['#ec6b14', '#7b90e1']);
    swatches[1].click();
    expect(picked.at(-1)?.toLowerCase()).toBe('#7b90e1');
  });

  it('shows no row when the slide has no colours of its own', () => {
    setSlideColorSource(() => []);
    const field = colorField('Fill', '#191918', () => {});
    document.body.appendChild(field);
    field.querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
    expect(document.querySelector('.color-picker-slide-palette')).toBeNull();
  });
});
