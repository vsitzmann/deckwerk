import { describe, expect, it } from 'vitest';
import { captureTimeoutMs } from '../src/cli/renderSlides.js';

describe('slide capture timeout', () => {
  it('outlasts the 20-second web check for any whole talk', () => {
    // A 105-slide deck was killed after ~40 slides under the web check's
    // ceiling; the capture budget must grow with the number of slides.
    expect(captureTimeoutMs(1, false)).toBeGreaterThan(20_000);
    expect(captureTimeoutMs(105, false)).toBeGreaterThanOrEqual(105 * 10_000);
    expect(captureTimeoutMs(105, false)).toBeGreaterThan(captureTimeoutMs(40, false));
  });

  it('gives contended CI runners more room per slide', () => {
    expect(captureTimeoutMs(10, true)).toBeGreaterThan(captureTimeoutMs(10, false));
  });
});
