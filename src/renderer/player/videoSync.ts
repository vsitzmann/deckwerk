import type { SlideElement } from '@shared/deck.js';

type VideoElement = Extract<SlideElement, { type: 'video' }>;

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

/**
 * Where a follower should be, given the leader's clock.
 *
 * Time is measured from each clip's own in-point, so two clips trimmed
 * differently still line up on what they show rather than on the file's zero.
 * A follower shorter than the leader holds its last kept frame until the
 * leader loops back, rather than looping early on its own.
 */
export function followerTarget(
  leader: { time: number; start: number },
  follower: { start: number; end: number | null; duration: number },
): number {
  const elapsed = Math.max(0, leader.time - leader.start);
  const end = follower.end ?? (Number.isFinite(follower.duration) ? follower.duration : Number.POSITIVE_INFINITY);
  return Math.min(follower.start + elapsed, Math.max(follower.start, end - 0.03));
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

/** A slide's sync groups that have something to sync: two or more videos, leader first (lowest z). */
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
