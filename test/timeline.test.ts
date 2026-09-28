import { describe, expect, it } from 'vitest';
import { type Deck, type Slide, parseDeck } from '../src/shared/deck.js';
import {
  groupIntoSteps,
  initiallyHidden,
  nextCursor,
  prevCursor,
  resolveState,
  stepCount,
} from '../src/shared/timeline.js';
import { reorderBuildEntry } from '../src/renderer/editor/timelinePanel.js';

/** A slide with three elements and whatever timeline the test needs. */
function slideWith(timeline: unknown[]): Slide {
  const deck: Deck = parseDeck({
    version: 1,
    slides: [
      {
        id: 's1',
        elements: [
          { id: 'a', type: 'text', x: 0, y: 0, w: 100, h: 50, html: 'a' },
          { id: 'b', type: 'text', x: 0, y: 60, w: 100, h: 50, html: 'b' },
          {
            id: 'v',
            type: 'video',
            x: 0,
            y: 120,
            w: 320,
            h: 180,
            src: 'assets/x.mp4',
          },
        ],
        timeline,
      },
    ],
  });
  return deck.slides[0];
}

const reveal = (id: string, on = 'click') => ({
  id: `t-${id}`,
  trigger: { on },
  action: { type: 'appear', target: id },
});

describe('step grouping', () => {
  it('treats a slide with no timeline as a single step', () => {
    const slide = slideWith([]);
    expect(stepCount(slide)).toBe(1);
    expect(groupIntoSteps(slide)).toEqual([[]]);
  });

  it('opens a new step per click trigger', () => {
    const slide = slideWith([reveal('a'), reveal('b')]);
    expect(stepCount(slide)).toBe(3);
  });

  it('attaches non-click entries to the step opened by the last click', () => {
    const slide = slideWith([reveal('a'), reveal('b', 'afterPrev')]);
    const steps = groupIntoSteps(slide);
    expect(steps).toHaveLength(2);
    expect(steps[1].map((e) => e.action.target)).toEqual(['a', 'b']);
  });

  it('puts entries preceding any click into step 0', () => {
    const slide = slideWith([reveal('a', 'afterPrev')]);
    expect(stepCount(slide)).toBe(1);
    expect(groupIntoSteps(slide)[0]).toHaveLength(1);
  });
});

describe('initial visibility', () => {
  it('shows everything when there is no timeline', () => {
    expect(initiallyHidden(slideWith([])).size).toBe(0);
  });

  it('hides only elements whose first visibility action is appear', () => {
    const slide = slideWith([reveal('a')]);
    const hidden = initiallyHidden(slide);
    expect([...hidden]).toEqual(['a']);
  });

  it('leaves an element visible when it is only ever hidden later', () => {
    const slide = slideWith([
      { id: 't1', trigger: { on: 'click' }, action: { type: 'disappear', target: 'a' } },
    ]);
    expect(initiallyHidden(slide).size).toBe(0);
  });
});

describe('resolveState', () => {
  it('reveals elements progressively as steps advance', () => {
    const slide = slideWith([reveal('a'), reveal('b')]);
    expect(resolveState(slide, 0).visible.has('a')).toBe(false);
    expect(resolveState(slide, 1).visible.has('a')).toBe(true);
    expect(resolveState(slide, 1).visible.has('b')).toBe(false);
    expect(resolveState(slide, 2).visible.has('b')).toBe(true);
  });

  it('autoplays a visible video on slide entry', () => {
    expect(resolveState(slideWith([]), 0).playing.has('v')).toBe(true);
  });

  it('does not play a video that has not been revealed yet', () => {
    const slide = slideWith([reveal('v')]);
    expect(resolveState(slide, 0).playing.has('v')).toBe(false);
    expect(resolveState(slide, 1).playing.has('v')).toBe(true);
  });

  it('clamps a step beyond the end to the final state', () => {
    const slide = slideWith([reveal('a')]);
    expect(resolveState(slide, 99).visible.has('a')).toBe(true);
  });

  it('applies pause after autoplay when ordered that way', () => {
    const slide = slideWith([
      { id: 't1', trigger: { on: 'click' }, action: { type: 'pause', target: 'v' } },
    ]);
    expect(resolveState(slide, 0).playing.has('v')).toBe(true);
    expect(resolveState(slide, 1).playing.has('v')).toBe(false);
  });

  it('removeClass takes away a class the element was authored with', () => {
    const slide = slideWith([
      { id: 't1', trigger: { on: 'click' }, action: { type: 'removeClass', target: 'a', value: 'frost' } },
    ]);
    slide.elements[0].class = ['glass', 'frost'];
    expect([...resolveState(slide, 0).classes.get('a')!]).toEqual(['glass', 'frost']);
    expect([...resolveState(slide, 1).classes.get('a')!]).toEqual(['glass']);
  });
});

describe('deck navigation', () => {
  const slides = [slideWith([reveal('a')]), slideWith([]), slideWith([reveal('b')])];

  it('advances through steps before changing slide', () => {
    expect(nextCursor(slides, { slide: 0, step: 0 })).toEqual({ slide: 0, step: 1 });
    expect(nextCursor(slides, { slide: 0, step: 1 })).toEqual({ slide: 1, step: 0 });
  });

  it('stops at the end of the deck', () => {
    const last = { slide: 2, step: 1 };
    expect(nextCursor(slides, last)).toEqual(last);
  });

  it('steps back onto the fully-built state of the previous slide', () => {
    expect(prevCursor(slides, { slide: 1, step: 0 })).toEqual({ slide: 0, step: 1 });
  });

  it('stops at the start of the deck', () => {
    expect(prevCursor(slides, { slide: 0, step: 0 })).toEqual({ slide: 0, step: 0 });
  });

  it('steps over skipped slides in both directions', () => {
    const deck = [slideWith([reveal('a')]), { ...slideWith([]), skipped: true }, slideWith([])];
    expect(nextCursor(deck, { slide: 0, step: 1 })).toEqual({ slide: 2, step: 0 });
    expect(prevCursor(deck, { slide: 2, step: 0 })).toEqual({ slide: 0, step: 1 });
  });

  it('clamps rather than landing on a trailing skipped slide', () => {
    const deck = [slideWith([]), { ...slideWith([]), skipped: true }];
    expect(nextCursor(deck, { slide: 0, step: 0 })).toEqual({ slide: 0, step: 0 });
  });
});

describe('build authoring order', () => {
  it('reorders click reveals and fuses a dropped entry with its target', () => {
    const slide = slideWith([reveal('a'), reveal('b'), reveal('v')]);
    reorderBuildEntry(slide.timeline, 't-v', 't-a', 'fuse');
    expect(slide.timeline.map((entry) => entry.id)).toEqual([
      't-a', 't-v', 't-b',
    ]);
    expect(slide.timeline[1].trigger.on).toBe('withPrev');
    expect(groupIntoSteps(slide)[1].map((entry) => entry.action.target)).toEqual(['a', 'v']);
  });

  it('moves an entry between click positions without fusing it', () => {
    const slide = slideWith([reveal('a'), reveal('b'), reveal('v')]);
    reorderBuildEntry(slide.timeline, 't-v', 't-a', 'before');
    expect(slide.timeline.map((entry) => entry.id)).toEqual([
      't-v', 't-a', 't-b',
    ]);
    expect(slide.timeline[0].trigger.on).toBe('click');
  });
});
