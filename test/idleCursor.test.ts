// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideCursorWhenIdle } from '../src/renderer/player/idleCursor.js';

describe('presentation cursor', () => {
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.className = '';
    stop = hideCursorWhenIdle(document.body, 1000);
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  const idle = () => document.body.classList.contains('cursor-idle');

  it('starts hidden', () => {
    expect(idle()).toBe(true);
  });

  it('shows on move and hides after a second of stillness', () => {
    window.dispatchEvent(new MouseEvent('mousemove'));
    expect(idle()).toBe(false);
    vi.advanceTimersByTime(999);
    expect(idle()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(idle()).toBe(true);
  });

  it('keeps showing while the mouse keeps moving', () => {
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new MouseEvent('mousemove'));
      vi.advanceTimersByTime(800);
    }
    expect(idle()).toBe(false);
  });

  it('stops reacting once removed', () => {
    stop();
    window.dispatchEvent(new MouseEvent('mousemove'));
    expect(idle()).toBe(true);
  });
});
