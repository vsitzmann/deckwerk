import { describe, expect, it } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import { syncLengthOf } from '../src/shared/compare.js';
import {
  SYNC_MAX_RATE_BEND,
  clipSpan,
  followerCorrection,
  groupClock,
  memberFrame,
  stillGroupFrames,
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
  it('follows the clock measured from each clip’s own in-point', () => {
    // Clock trimmed to start at 2 s, follower at 5 s: 1.5 s into the clock is 1.5 s into the follower.
    const at = memberFrame(3.5 - 2, { start: 5, end: null, duration: 20 }, 'shortest', 15);
    expect(at).toEqual({ time: 6.5, ended: false, black: false });
  });

  it('never blocks following while a length is unknown', () => {
    expect(memberFrame(9, { start: 0, end: null, duration: Number.NaN }, 'hold', null))
      .toEqual({ time: 9, ended: false, black: false });
  });
});

describe('how long a synced group runs', () => {
  // A 2 s clip and a 5 s clip, the shapes of the test clips.
  const short = { start: 0, end: null, duration: 2 };
  const long = { start: 0, end: null, duration: 5 };

  it('measures each clip by its trim window, stopping at the end of the file', () => {
    expect(clipSpan(long)).toBe(5);
    expect(clipSpan({ start: 1, end: 3.5, duration: 5 })).toBe(2.5);
    expect(clipSpan({ start: 1, end: 9, duration: 5 })).toBe(4);
    expect(clipSpan({ start: 0, end: 4, duration: Number.NaN })).toBeNull();
  });

  it('cut to the shortest: the shortest clip keeps time, the rest never run out', () => {
    expect(groupClock([long, short], 'shortest')).toEqual({ clock: 1, length: 2 });
    // 1.9 s in, the long clip is where the short one is.
    expect(memberFrame(1.9, long, 'shortest', 2)).toEqual({ time: 1.9, ended: false, black: false });
  });

  it('to the longest, holding: the longest keeps time and the shorter freezes on its last frame', () => {
    expect(groupClock([short, long], 'hold')).toEqual({ clock: 1, length: 5 });
    const before = memberFrame(1.5, short, 'hold', 5);
    expect(before).toEqual({ time: 1.5, ended: false, black: false });
    const after = memberFrame(4, short, 'hold', 5);
    expect(after.ended).toBe(true);
    expect(after.black).toBe(false);
    expect(after.time).toBeCloseTo(1.97, 5);
  });

  it('to the longest, black: the shorter goes black once it runs out', () => {
    expect(groupClock([short, long], 'black')).toEqual({ clock: 1, length: 5 });
    expect(memberFrame(1.99, short, 'black', 5).black).toBe(false);
    expect(memberFrame(2, short, 'black', 5)).toMatchObject({ ended: true, black: true });
    // Looped back to the start, it plays again.
    expect(memberFrame(0.1, short, 'black', 5)).toEqual({ time: 0.1, ended: false, black: false });
  });

  it('respects in- and out-points in every mode', () => {
    // 1…3.5 s of a 6 s file (2.5 s) against 4…8 s of a 10 s file (4 s).
    const a = { start: 1, end: 3.5, duration: 6 };
    const b = { start: 4, end: 8, duration: 10 };
    expect(groupClock([b, a], 'shortest')).toEqual({ clock: 1, length: 2.5 });
    expect(memberFrame(2, b, 'shortest', 2.5).time).toBe(6);
    expect(groupClock([b, a], 'hold')).toEqual({ clock: 0, length: 4 });
    const held = memberFrame(3, a, 'hold', 4);
    expect(held.ended).toBe(true);
    expect(held.time).toBeCloseTo(3.47, 5);
    expect(memberFrame(3, a, 'black', 4)).toMatchObject({ ended: true, black: true });
  });

  it('never runs out a clip as long as the group, so matched clips do not flash black at the end', () => {
    const clips = [{ start: 0, end: null, duration: 4 }, { start: 0, end: null, duration: 4.02 }];
    const { length } = groupClock(clips, 'black');
    expect(memberFrame(4.01, clips[0], 'black', length)).toMatchObject({ ended: false, black: false });
  });

  it('keeps the first member as the clock until every length is known, and on a tie', () => {
    expect(groupClock([long, { start: 0, end: null, duration: Number.NaN }], 'shortest'))
      .toEqual({ clock: 0, length: null });
    expect(groupClock([short, short], 'hold')).toEqual({ clock: 0, length: 2 });
  });

  it('reads the setting off the group, lowest member first, defaulting to the shortest', () => {
    expect(syncLengthOf([video({ id: 'a' }), video({ id: 'b' })])).toBe('shortest');
    expect(syncLengthOf([video({ id: 'a', z: 4 }), video({ id: 'b', z: 2, syncLength: 'black' })])).toBe('black');
    expect(syncLengthOf([
      video({ id: 'a', z: 4, syncLength: 'black' }), video({ id: 'b', z: 2, syncLength: 'hold' }),
    ])).toBe('hold');
  });

  it('gives a still the frame the presentation would show at the same step', () => {
    const members = [
      video({ id: 'short', syncGroup: 'g', z: 1, syncLength: 'black' }),
      video({ id: 'long', syncGroup: 'g', z: 2, syncLength: 'black' }),
    ];
    const durations: Record<string, number> = { short: 2, long: 5 };
    // At the in-point every clip is showing.
    const first = stillGroupFrames(members, (id) => durations[id], new Map());
    expect(first.get('short')).toEqual({ time: 0, ended: false, black: false });
    // A build that seeks the long clock to 3 s: the short clip has gone black.
    const later = stillGroupFrames(members, (id) => durations[id], new Map([['long', 3]]));
    expect(later.get('long')).toEqual({ time: 3, ended: false, black: false });
    expect(later.get('short')).toMatchObject({ ended: true, black: true });
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
  it('groups by sync group, lowest in z first, and ignores a lone member', () => {
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

  it('carries the group’s length setting, and drops one it does not know', () => {
    const deck = emptyDeck('Sync');
    deck.slides[0].elements.push(
      video({ id: 'real', syncGroup: 'bread', syncLength: 'hold' }),
      video({ id: 'sim', syncGroup: 'bread', syncLength: 'hold', sourceBox: { x: -10, y: 0, w: 420, h: 300 } }),
      video({ id: 'plain', syncGroup: 'other' }),
    );
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html.match(/data-sync-length="hold"/g)).toHaveLength(2);
    // The default is not written out.
    expect(html.match(/data-sync-length/g)).toHaveLength(2);

    const plain = elementFromNode(measured({ dataset: { syncGroup: 'bread', syncLength: 'black' } }), 'real', 1) as Video;
    expect(plain.syncLength).toBe('black');
    const cropped = elementFromNode(measured({
      tag: 'div', dataset: { element: 'video', src: 'assets/a.mp4', syncGroup: 'bread', syncLength: 'hold' }, attrs: {},
    }), 'sim', 1) as Video;
    expect(cropped.syncLength).toBe('hold');
    expect((elementFromNode(measured({ dataset: { syncLength: 'longest' } }), 'x', 1) as Video).syncLength)
      .toBeUndefined();
  });
});
