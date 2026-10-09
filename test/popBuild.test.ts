import { describe, expect, it } from 'vitest';
import type { Slide, TimelineEntry } from '../src/shared/deck.js';
import { DEFAULT_POP_DURATION, buildEffect, effectDuration } from '../src/shared/timeline.js';

const slide = { id: 's', elements: [], timeline: [] } as unknown as Slide;
const entry = (type: 'appear' | 'disappear', value: string | null, duration?: number): TimelineEntry => ({
  id: 'b', trigger: { on: 'click', ref: null, delay: 0 },
  action: { type, target: 'e', value, ...(duration === undefined ? {} : { duration }) },
}) as TimelineEntry;

describe('pop builds', () => {
  it('is an animated appear with its own default time', () => {
    expect(buildEffect(entry('appear', 'pop'), slide)).toBe('pop');
    expect(effectDuration(entry('appear', 'pop'), 'pop')).toBe(DEFAULT_POP_DURATION);
    expect(effectDuration(entry('appear', 'pop', 300), 'pop')).toBe(300);
  });

  it('has no disappear form', () => {
    expect(buildEffect(entry('disappear', 'pop'), slide)).toBeNull();
  });
});
