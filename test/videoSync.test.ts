import { describe, expect, it } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import {
  SYNC_MAX_RATE_BEND,
  followerCorrection,
  followerTarget,
  syncGroupsOf,
} from '../src/renderer/player/videoSync.js';

/**
 * Synced videos: a real clip and its simulation, side by side, that must show
 * the same moment for as long as the slide is up.
 */

type Video = Extract<SlideElement, { type: 'video' }>;

function video(over: Partial<Video> = {}): Video {
  return {
    id: 'v', type: 'video', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: 'assets/a.mp4', fit: 'cover', autoplay: true, loop: true,
    muted: true, controls: false, start: 0, end: null, poster: null, sourceBox: null,
    ...over,
  } as Video;
}

describe('where a follower should be', () => {
  it('follows the leader measured from each clip’s own in-point', () => {
    // Leader trimmed to start at 2 s, follower at 5 s: 1.5 s into the leader is 1.5 s into the follower.
    expect(followerTarget({ time: 3.5, start: 2 }, { start: 5, end: null, duration: 20 })).toBe(6.5);
  });

  it('holds a shorter follower on its last kept frame instead of looping early', () => {
    const target = followerTarget({ time: 9, start: 0 }, { start: 0, end: 4, duration: 20 });
    expect(target).toBeCloseTo(3.97, 5);
    // Unknown duration (metadata not loaded yet) never blocks following.
    expect(followerTarget({ time: 9, start: 0 }, { start: 0, end: null, duration: NaN })).toBe(9);
  });
});

describe('bringing a follower back in step', () => {
  it('leaves a follower that is in step alone', () => {
    expect(followerCorrection(1.005, 1, true)).toEqual({ rate: 1 });
  });

  it('bends the playback rate for small drift, toward the leader', () => {
    const behind = followerCorrection(0.9, 1, true);
    expect(behind.seek).toBeUndefined();
    expect(behind.rate).toBeGreaterThan(1);
    expect(behind.rate).toBeLessThanOrEqual(1 + SYNC_MAX_RATE_BEND);
    const ahead = followerCorrection(1.1, 1, true);
    expect(ahead.rate).toBeLessThan(1);
  });

  it('seeks after a loop or a stall rather than racing to catch up', () => {
    expect(followerCorrection(7.8, 0.1, true)).toEqual({ seek: 0.1, rate: 1 });
  });

  it('matches a paused group exactly', () => {
    expect(followerCorrection(1.2, 1, false)).toEqual({ seek: 1, rate: 1 });
    expect(followerCorrection(1, 1, false)).toEqual({ rate: 1 });
  });
});

describe('which videos sync', () => {
  it('groups by sync group, leader lowest in z, and ignores a lone member', () => {
    const groups = syncGroupsOf([
      video({ id: 'sim', syncGroup: 'bread', z: 3 }),
      video({ id: 'real', syncGroup: 'bread', z: 2 }),
      video({ id: 'alone', syncGroup: 'solo' }),
      video({ id: 'plain' }),
    ]);
    expect([...groups.keys()]).toEqual(['bread']);
    expect(groups.get('bread')!.map((el) => el.id)).toEqual(['real', 'sim']);
  });
});

describe('the sync group in the HTML an agent edits', () => {
  function measured(over: Partial<MeasuredNode>): MeasuredNode {
    return {
      tag: 'video', elementId: null, classes: [], dataset: {}, rect: { x: 0, y: 0, w: 400, h: 300 },
      rotation: 0, opacity: 1, style: {}, html: '', attrs: { src: 'assets/a.mp4' }, ...over,
    };
  }

  it('is written out and read back, on a plain and on a cropped video', () => {
    const deck = emptyDeck('Sync');
    deck.slides[0].elements.push(
      video({ id: 'real', syncGroup: 'bread' }),
      video({ id: 'sim', syncGroup: 'bread', sourceBox: { x: -10, y: 0, w: 420, h: 300 } }),
    );
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html.match(/data-sync-group="bread"/g)).toHaveLength(2);

    const plain = elementFromNode(measured({ dataset: { syncGroup: 'bread' } }), 'real', 1) as Video;
    expect(plain.syncGroup).toBe('bread');
    const cropped = elementFromNode(measured({
      tag: 'div', dataset: { element: 'video', src: 'assets/a.mp4', syncGroup: 'bread' }, attrs: {},
    }), 'sim', 1) as Video;
    expect(cropped.syncGroup).toBe('bread');
    // No group, no attribute and no field.
    expect((elementFromNode(measured({}), 'x', 1) as Video).syncGroup).toBeUndefined();
  });
});
