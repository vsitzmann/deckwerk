/**
 * Presenter speed control for a slide's videos (`>` / `<`, `]` / `[`, `=`).
 *
 * A long clip is often only interesting in places; the presenter speeds it up
 * through the rest. The rate is the slide's, not the clip's: every video on the
 * slide moves together, so clips that tell one story side by side (a camera
 * view beside the curve it produced) stay in step.
 */

export type VideoRateChange = 'faster' | 'slower' | 'normal';

/** The speeds a presenter steps through, slowest first. 1 is normal speed. */
export const VIDEO_RATES = [0.25, 0.5, 1, 1.5, 2, 4, 8] as const;

/** The rate one step from `current`, held at either end of `VIDEO_RATES`. */
export function nextVideoRate(current: number, change: VideoRateChange): number {
  if (change === 'normal') return 1;
  // A rate that is not on the ladder steps to its nearest neighbour in that direction.
  if (change === 'faster') return VIDEO_RATES.find((rate) => rate > current + 1e-9) ?? VIDEO_RATES.at(-1)!;
  return [...VIDEO_RATES].reverse().find((rate) => rate < current - 1e-9) ?? VIDEO_RATES[0];
}

/** The key that asks for a rate change, or null. Shared by every presenting surface. */
export function videoRateChangeForKey(key: string): VideoRateChange | null {
  if (key === '>' || key === ']') return 'faster';
  if (key === '<' || key === '[') return 'slower';
  if (key === '=') return 'normal';
  return null;
}

/** How the rate reads on the badge: `2×`, `0.5×`. */
export function formatVideoRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}
