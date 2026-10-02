// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { angleDial } from '../src/renderer/editor/angleDial.js';

describe('the shadow angle knob', () => {
  function mount(value: number | null) {
    const calls: string[] = [];
    const dial = angleDial(value, {
      onBegin: () => calls.push('begin'),
      onInput: (degrees) => calls.push(`input ${degrees}`),
      onEnd: () => calls.push('end'),
    });
    document.body.replaceChildren(dial);
    dial.getBoundingClientRect = () => ({ left: 0, top: 0, width: 40, height: 40 } as DOMRect);
    return { dial, calls };
  }
  const pointer = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...extra });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return event;
  };

  it('points where the shadow falls: 270 is straight down', () => {
    const { dial } = mount(270);
    expect(dial.getAttribute('aria-valuenow')).toBe('270');
    expect((dial.firstElementChild as HTMLElement).style.transform).toBe('rotate(-270deg)');
  });

  it('turns to the pointer and makes a drag one begin and one end', () => {
    const { dial, calls } = mount(270);
    dial.dispatchEvent(pointer('pointerdown', 40, 20));      // right of centre: 0°
    dial.dispatchEvent(pointer('pointermove', 20, 0));       // above: 90°
    dial.dispatchEvent(pointer('pointermove', 0, 20));       // left: 180°
    dial.dispatchEvent(pointer('pointerup', 0, 20));
    expect(calls).toEqual(['begin', 'input 0', 'input 90', 'input 180', 'end']);
    expect(dial.getAttribute('aria-valuenow')).toBe('180');
  });

  it('snaps to 15° with Shift, and turns by the arrow keys', () => {
    const { dial, calls } = mount(270);
    dial.dispatchEvent(pointer('pointerdown', 40, 13, { shiftKey: true }));   // about 19° up
    dial.dispatchEvent(pointer('pointerup', 40, 13));
    expect(calls).toEqual(['begin', 'input 15', 'end']);
    calls.length = 0;
    dial.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    dial.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    expect(calls).toEqual(['begin', 'input 16', 'end', 'begin', 'input 1', 'end']);
  });
});
