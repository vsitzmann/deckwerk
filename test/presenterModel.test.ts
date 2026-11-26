import { describe, expect, it } from 'vitest';
import { formatElapsed, formatWallClock, presentationLabel } from '../src/renderer/presenter/model.js';

describe('presenter view model', () => {
  it('formats an elapsed presentation timer beyond one hour', () => {
    expect(formatElapsed(3_725_000, 0)).toBe('62:05');
  });

  it('reports slide and build progress', () => {
    expect(presentationLabel({
      cursor: { slide: 4, step: 1 }, steps: 3, startedAt: 0, slideStartedAt: 1_000,
    }, Array.from({ length: 12 }, () => ({})))).toBe('Slide 5 / 12 · Build 2 / 3');
  });

  it('formats local wall-clock time without seconds', () => {
    expect(formatWallClock(new Date('2026-08-18T13:07:00Z'), 'en-US')).toContain(':07');
  });
});
