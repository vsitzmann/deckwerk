// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  colorField,
  colorForInput,
  parseCssColor,
} from '../src/renderer/editor/colorPicker.js';
import { closePopover } from '../src/renderer/editor/ui.js';

describe('color picker', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    const palette = document.createElement('datalist');
    palette.id = 'theme-swatches';
    for (const color of ['#112233', '#abcdef', '#ff8800']) {
      const option = document.createElement('option');
      option.value = color;
      palette.appendChild(option);
    }
    document.body.appendChild(palette);
  });

  afterEach(() => closePopover());

  it('shows theme colors, full color controls, and opacity in one click', () => {
    const field = colorField('Fill', '#ff0000', vi.fn(), {
      clear: { kind: 'none', label: 'No fill (transparent)' },
    });
    document.body.appendChild(field);

    field.querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();

    const picker = document.querySelector<HTMLElement>('.color-picker-popover')!;
    expect(picker).not.toBeNull();
    expect(picker.querySelectorAll('.color-picker-palette-button')).toHaveLength(5);
    const neutrals = picker.querySelector('.color-picker-palette-neutrals')!;
    expect([...neutrals.querySelectorAll('button')].map((b) => b.title)).toEqual(['#ffffff', '#000000']);
    expect(neutrals.previousElementSibling?.getAttribute('title')).toBe('#ff8800');
    expect(picker.querySelector('.color-picker-plane')).not.toBeNull();
    expect(picker.querySelector<HTMLInputElement>('input[aria-label="Hue"]')).not.toBeNull();
    expect(picker.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')?.value).toBe('100');
    expect(picker.querySelector('.color-picker-clear')?.textContent).toBe('No fill (transparent)');
  });

  it('shows absent paint as transparent rather than as a fallback color', () => {
    const field = colorField('Fill', null, vi.fn(), {
      clear: { kind: 'none', label: 'No fill (transparent)' },
    });
    document.body.appendChild(field);
    const trigger = field.querySelector<HTMLButtonElement>('.color-picker-trigger')!;
    const preview = trigger.querySelector<HTMLElement>('.color-picker-preview')!;
    expect(preview.style.getPropertyValue('--picker-color')).toBe('transparent');

    trigger.click();
    closePopover();
    expect(preview.style.getPropertyValue('--picker-color')).toBe('transparent');
  });

  it('marks an inherited color as theme-controlled and offers an explicit reset', () => {
    const onChange = vi.fn();
    const field = colorField('Colour', null, onChange, {
      inheritedValue: '#abcdef',
      clear: { kind: 'theme', label: 'Use theme text color' },
    });
    document.body.appendChild(field);

    const trigger = field.querySelector<HTMLButtonElement>('.color-picker-trigger')!;
    expect(trigger.classList.contains('is-theme')).toBe(true);
    expect(trigger.querySelector('.color-picker-theme-badge')?.textContent).toBe('T');
    expect(trigger.getAttribute('aria-label')?.toLowerCase()).toContain('theme color');

    trigger.click();
    const themeDefault = document.querySelector<HTMLButtonElement>('.color-picker-theme-default')!;
    expect(themeDefault.classList.contains('selected')).toBe(true);
    expect(themeDefault.getAttribute('aria-label')).toBe('Use theme text color');
    themeDefault.click();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('identifies CSS paint and previews a gradient instead of inventing a solid color', () => {
    const gradient = 'linear-gradient(90deg, #56c1ff, #b500a3)';
    const field = colorField('Colour', 'transparent', vi.fn(), {
      source: { kind: 'css', preview: gradient, label: 'CSS gradient text' },
      clear: { kind: 'css', label: 'Remove CSS text paint' },
    });
    document.body.appendChild(field);

    const trigger = field.querySelector<HTMLButtonElement>('.color-picker-trigger')!;
    expect(trigger.classList.contains('is-css')).toBe(true);
    expect(trigger.classList.contains('is-theme')).toBe(false);
    expect(trigger.querySelector('.color-picker-css-badge')?.textContent).toBe('CSS');
    expect(trigger.querySelector<HTMLElement>('.color-picker-preview')!
      .style.getPropertyValue('--picker-color')).toBe(gradient);

    trigger.click();
    expect(document.querySelector('.color-picker-source-note')?.textContent)
      .toContain('CSS gradient text');
  });

  it('stores opacity on the paint itself without affecting neighboring properties', () => {
    const onChange = vi.fn();
    const field = colorField('Fill', 'rgba(10, 20, 30, 0.35)', onChange, {
      clear: { kind: 'none', label: 'No fill (transparent)' },
    });
    document.body.appendChild(field);
    field.querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();

    const opacity = document.querySelector<HTMLInputElement>('input[aria-label="Opacity"]')!;
    expect(opacity.value).toBe('35');
    opacity.value = '42';
    opacity.dispatchEvent(new Event('input', { bubbles: true }));
    opacity.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onChange).toHaveBeenLastCalledWith('rgba(10, 20, 30, 0.42)');
  });

  it('opens beside the side panel, level with its swatch, not over the rows under it', () => {
    // jsdom has no layout: give the panel, the swatch and the popover boxes.
    const boxes: Record<string, [number, number, number, number]> = {
      side: [700, 0, 324, 768],
      'color-picker-trigger': [960, 300, 46, 28],
      'color-picker-popover': [0, 0, 276, 369],
    };
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const key = this.id === 'side' ? 'side' : [...this.classList].find((name) => name in boxes);
        const [x, y, width, height] = key ? boxes[key] : [0, 0, 0, 0];
        return DOMRect.fromRect({ x, y, width, height });
      });
    try {
      const side = document.createElement('aside');
      side.id = 'side';
      const field = colorField('Border color', '#1d7d45', vi.fn());
      side.appendChild(field);
      document.body.appendChild(side);
      field.querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
      const picker = document.querySelector<HTMLElement>('.color-picker-popover')!;
      expect(picker.style.left).toBe(`${700 - 6 - 276}px`);
      expect(picker.style.top).toBe('300px');
      closePopover();

      // No room beside a panel that fills the window: under the swatch again.
      boxes.side = [0, 0, 1024, 768];
      field.querySelector<HTMLButtonElement>('.color-picker-trigger')!.click();
      const under = document.querySelector<HTMLElement>('.color-picker-popover')!;
      expect(under.style.top).toBe(`${300 + 28 + 6}px`);
    } finally {
      rect.mockRestore();
    }
  });

  it('normalizes supported CSS color forms for previewing', () => {
    expect(colorForInput('#abc8')).toBe('#aabbcc');
    expect(parseCssColor('#abc8')?.a).toBeCloseTo(0.533, 2);
    expect(parseCssColor('rgb(100% 0% 50% / 25%)')).toEqual({ r: 255, g: 0, b: 128, a: 0.25 });
  });
});
