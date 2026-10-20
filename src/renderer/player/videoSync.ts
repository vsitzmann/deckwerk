import type { SlideElement } from '@shared/deck.js';
import { syncLengthOf, trimWindow, type SyncLength } from '@shared/compare.js';

type VideoElement = Extract<SlideElement, { type: 'video' }>;

/**
 * On a member that has run out before a group set to end in black. A class
 * rather than an inline style, so the slide's own styling of the `<video>` is
 * untouched (player/compare.css).
 */
export const SYNC_BLACK_CLASS = 'sync-black';

/** Seek instead of easing when a follower is this far off (seconds). */
export const SYNC_SEEK_THRESHOLD = 0.3;
/** Below this a follower counts as in step and plays at normal speed. */
export const SYNC_TOLERANCE = 0.02;
/** How far a follower's playback rate may bend to catch up or fall back. */
export const SYNC_MAX_RATE_BEND = 0.1;

export interface FollowerCorrection {
  /** Jump straight to this time, when easing would take too long. */
  seek?: number;
  /** Playback rate that closes the remaining gap over the next second or so. */
  rate: number;
}

/** A member of a sync group as its clock sees it: its trim, and its file's length once known. */
export interface SyncClip {
  start: number;
  end: number | null;
  duration: number;
}

/**
 * How long a clip plays: its trim window's length, or null until the file's
 * duration is known. An out-point past the end of the file stops at the end.
 */
export function clipSpan(clip: SyncClip): number | null {
  if (!(Number.isFinite(clip.duration) && clip.duration > 0)) return null;
  const window = trimWindow({ start: clip.start, end: clip.end === null ? null : Math.min(clip.end, clip.duration) }, clip.duration);
  return window ? window.end - window.start : null;
}

/**
 * Which member keeps the group's time, and how long the group runs.
 *
 * The clock is the clip whose own length is the group's: the shortest one
 * when the group is cut to the shortest, the longest one otherwise. Its own
 * end (or loop) is then the group's, through the same trim and loop handling
 * any single video gets, and nothing has to run a clock of its own. Until
 * every member's length is known the first member keeps time. Ties go to
 * the earlier member.
 */
export function groupClock(
  clips: readonly SyncClip[],
  mode: SyncLength,
): { clock: number; length: number | null } {
  const spans = clips.map(clipSpan);
  if (spans.length === 0 || spans.some((span) => span === null)) return { clock: 0, length: null };
  let clock = 0;
  spans.forEach((span, index) => {
    const best = spans[clock]!;
    if (mode === 'shortest' ? span! < best : span! > best) clock = index;
  });
  return { clock, length: spans[clock] };
}

/** A member's frame at a moment of the group's clock. */
export interface MemberFrame {
  /** Where the member's playhead belongs. */
  time: number;
  /** It has run out before the group: it waits, paused, for the group to loop. */
  ended: boolean;
  /** …and shows black while it waits, rather than its last frame. */
  black: boolean;
}

/**
 * Where a member belongs `elapsed` seconds into the group (`length` long).
 *
 * Time is measured from each clip's own in-point. A clip shorter than the
 * group runs out once `elapsed` reaches its own length and then holds its
 * last kept frame, or goes black, until the group loops back. One as long as
 * the group never runs out, so a group whose clips all match never flashes
 * black at its end.
 */
export function memberFrame(
  elapsed: number,
  clip: SyncClip,
  mode: SyncLength,
  length: number | null,
): MemberFrame {
  const at = Math.max(0, elapsed);
  const span = clipSpan(clip);
  if (span === null) return { time: clip.start + at, ended: false, black: false };
  const ended = length !== null && span < length - SYNC_LENGTH_SLACK && at >= span;
  return {
    time: Math.min(clip.start + at, clip.start + Math.max(0, span - END_HOLD)),
    ended,
    black: ended && mode === 'black',
  };
}

/** Clips within this much of the group's length count as its length (seconds, about a frame). */
const SYNC_LENGTH_SLACK = 0.05;
/** A held clip rests this far before its out-point, where a frame is still decoded. */
const END_HOLD = 0.03;

/**
 * Every member's frame for a still of the group: a PDF page, a thumbnail.
 *
 * The group's moment is read off its clock clip -- its seek on this build, or
 * its in-point -- exactly as the live player reads it, so a capture shows what
 * the presentation would at the same step. Durations come from the loaded
 * `<video>`s; members whose length is unknown are left out.
 */
export function stillGroupFrames(
  members: readonly VideoElement[],
  durationOf: (id: string) => number,
  seeks: ReadonlyMap<string, number>,
): Map<string, MemberFrame> {
  const mode = syncLengthOf(members);
  const clips = members.map((el) => ({ start: el.start, end: el.end, duration: durationOf(el.id) }));
  const { clock, length } = groupClock(clips, mode);
  const keeper = members[clock];
  const elapsed = (seeks.get(keeper.id) ?? keeper.start) - keeper.start;
  const frames = new Map<string, MemberFrame>();
  members.forEach((el, index) => frames.set(el.id, memberFrame(elapsed, clips[index], mode, length)));
  return frames;
}

/**
 * How to bring a follower back in step: small drift is absorbed by bending
 * its playback rate (no visible jump), large drift (a loop, a scrub, a stall)
 * by seeking. A paused group is matched exactly, since nobody sees a seek.
 */
export function followerCorrection(current: number, target: number, playing: boolean): FollowerCorrection {
  const drift = current - target;
  if (!playing) return Math.abs(drift) > SYNC_TOLERANCE / 2 ? { seek: target, rate: 1 } : { rate: 1 };
  if (Math.abs(drift) > SYNC_SEEK_THRESHOLD) return { seek: target, rate: 1 };
  if (Math.abs(drift) <= SYNC_TOLERANCE) return { rate: 1 };
  const bend = Math.min(SYNC_MAX_RATE_BEND, Math.abs(drift));
  return { rate: drift > 0 ? 1 - bend : 1 + bend };
}

/** A slide's sync groups that have something to sync: two or more videos, lowest in z first. */
export function syncGroupsOf(elements: readonly SlideElement[]): Map<string, VideoElement[]> {
  const groups = new Map<string, VideoElement[]>();
  for (const el of elements) {
    if (el.type !== 'video' || !el.syncGroup) continue;
    groups.set(el.syncGroup, [...(groups.get(el.syncGroup) ?? []), el]);
  }
  for (const [id, members] of groups) {
    if (members.length < 2) groups.delete(id);
    else members.sort((a, b) => a.z - b.z);
  }
  return groups;
}
