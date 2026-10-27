import { describe, expect, it } from 'vitest';
import { parseDeck, type SlideElement } from '../src/shared/deck.js';
import { mediaFragmentTrim, withoutFragment } from '../src/shared/mediaFragment.js';

/**
 * A video's trim lives in `start`/`end`, its file in a clean `src`. A media
 * fragment on the src (`assets/x.mp4#t=15.0,20.0`) is the browser's spelling
 * of the same trim; whoever reads one turns it into the deck's, so tools that
 * resolve asset paths never have to strip it themselves.
 */
describe('media fragments on a video src', () => {
  it('reads the trim a time fragment asks for', () => {
    expect(mediaFragmentTrim('assets/x.mp4#t=15.0,20.0')).toEqual({ start: 15, end: 20 });
    expect(mediaFragmentTrim('assets/x.mp4#t=3')).toEqual({ start: 3, end: null });
    expect(mediaFragmentTrim('assets/x.mp4#t=,8')).toEqual({ start: 0, end: 8 });
    expect(mediaFragmentTrim('assets/x.mp4#t=npt:1:05,0:01:10.5')).toEqual({ start: 65, end: 70.5 });
    expect(mediaFragmentTrim('assets/x.mp4')).toBeNull();
    expect(mediaFragmentTrim('assets/x.mp4#t=soon')).toBeNull();
    expect(withoutFragment('assets/x.mp4#t=15.0,20.0')).toBe('assets/x.mp4');
  });

  it('loads a deck whose video src carries a fragment as a clean src with the same trim', () => {
    const video = (over: Record<string, unknown>) => ({
      type: 'video', x: 0, y: 0, w: 640, h: 360, ...over,
    });
    const deck = parseDeck({
      version: 1,
      slides: [{
        id: 's', elements: [
          video({ id: 'fragment-only', src: 'assets/x.mp4#t=15.0,20.0' }),
          // The fields said it already: they win, the fragment only goes.
          video({ id: 'fields-too', src: 'assets/x.mp4#t=1,2', start: 4, end: 9 }),
          video({ id: 'clean', src: 'assets/x.mp4', start: 2 }),
        ],
      }],
    });
    const byId = (id: string) => deck.slides[0].elements.find((element) => element.id === id) as
      Extract<SlideElement, { type: 'video' }>;
    expect(byId('fragment-only')).toMatchObject({ src: 'assets/x.mp4', start: 15, end: 20 });
    expect(byId('fields-too')).toMatchObject({ src: 'assets/x.mp4', start: 4, end: 9 });
    expect(byId('clean')).toMatchObject({ src: 'assets/x.mp4', start: 2, end: null });
  });
});
