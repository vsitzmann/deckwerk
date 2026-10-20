/**
 * Which glyphs of one rendered equation are "the same" glyphs in another.
 *
 * An equation Morph (`f(x) = 0` → `f(x) = y`) moves every symbol the two
 * sides share from its old place to its new one, and fades only what was
 * added or removed. Deciding what is shared is a sequence problem, not a
 * geometry one: the `x` of `f(x)` is the first `x` on both sides even when
 * the equation is re-centred, re-sized or broken onto a new line. So the
 * glyphs are matched as a longest common subsequence of their symbols, in
 * reading order, with position deciding only between equally long matchings
 * (the `x` that stays put is preferred to one that would cross the line).
 *
 * Symbols an LCS cannot keep because their order changed — the terms of
 * `a + b` → `b + a`, the exponent of `x^2` → `2x` — are then paired by
 * nearest position among same-symbol leftovers, so a term that commutes
 * travels across rather than fading out on one side and in on the other.
 *
 * Pure: boxes in, index pairs out, so it is tested without a browser.
 */

export interface GlyphBox {
  /** What the glyph is: its text, or a kind for strokes (a fraction bar, a radical). */
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** [source index, target index] pairs, in target order. */
export type GlyphPairs = Array<[number, number]>;

export function matchGlyphs(source: GlyphBox[], target: GlyphBox[]): GlyphPairs {
  const n = source.length;
  const m = target.length;
  if (n === 0 || m === 0) return [];
  const from = normalised(source);
  const to = normalised(target);
  const distance = (i: number, j: number): number =>
    Math.hypot(from[i].x - to[j].x, from[i].y - to[j].y);

  // count[i][j] / cost[i][j]: the best matching of source[0, i) against
  // target[0, j) — the most matches, then the least total displacement.
  const width = m + 1;
  const count = new Int32Array((n + 1) * width);
  const cost = new Float64Array((n + 1) * width);
  const better = (c1: number, d1: number, c2: number, d2: number): boolean =>
    c1 > c2 || (c1 === c2 && d1 < d2 - 1e-9);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const at = i * width + j;
      // Skip a source glyph, or skip a target glyph...
      let bestCount = count[at - width];
      let bestCost = cost[at - width];
      if (better(count[at - 1], cost[at - 1], bestCount, bestCost)) {
        bestCount = count[at - 1];
        bestCost = cost[at - 1];
      }
      // ...or pair the two, when they are the same symbol.
      if (source[i - 1].key === target[j - 1].key) {
        const diagonal = at - width - 1;
        const pairedCount = count[diagonal] + 1;
        const pairedCost = cost[diagonal] + distance(i - 1, j - 1);
        if (better(pairedCount, pairedCost, bestCount, bestCost)) {
          bestCount = pairedCount;
          bestCost = pairedCost;
        }
      }
      count[at] = bestCount;
      cost[at] = bestCost;
    }
  }

  // Walk the table back, taking the same decisions it was filled with.
  const pairs: GlyphPairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const at = i * width + j;
    if (source[i - 1].key === target[j - 1].key) {
      const diagonal = at - width - 1;
      if (count[diagonal] + 1 === count[at]
        && Math.abs(cost[diagonal] + distance(i - 1, j - 1) - cost[at]) < 1e-6) {
        pairs.push([i - 1, j - 1]);
        i--;
        j--;
        continue;
      }
    }
    if (count[at - width] === count[at] && Math.abs(cost[at - width] - cost[at]) < 1e-6) i--;
    else j--;
  }
  pairs.reverse();

  // Same symbols the order could not keep: nearest first.
  const usedSource = new Set(pairs.map(([s]) => s));
  const usedTarget = new Set(pairs.map(([, t]) => t));
  const leftovers: Array<{ s: number; t: number; d: number }> = [];
  for (let s = 0; s < n; s++) {
    if (usedSource.has(s)) continue;
    for (let t = 0; t < m; t++) {
      if (usedTarget.has(t) || source[s].key !== target[t].key) continue;
      leftovers.push({ s, t, d: distance(s, t) });
    }
  }
  leftovers.sort((a, b) => a.d - b.d || a.t - b.t || a.s - b.s);
  for (const { s, t } of leftovers) {
    if (usedSource.has(s) || usedTarget.has(t)) continue;
    usedSource.add(s);
    usedTarget.add(t);
    pairs.push([s, t]);
  }
  return pairs.sort((a, b) => a[1] - b[1]);
}

/**
 * Glyph centres relative to the equation's own top-left corner, in units of
 * its height: an equation that moved across the slide or changed size between
 * the two sides compares glyph for glyph as if it had stayed put.
 */
function normalised(glyphs: GlyphBox[]): Array<{ x: number; y: number }> {
  let left = Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const glyph of glyphs) {
    left = Math.min(left, glyph.x);
    top = Math.min(top, glyph.y);
    bottom = Math.max(bottom, glyph.y + glyph.h);
  }
  const unit = bottom - top > 0 ? bottom - top : 1;
  return glyphs.map((glyph) => ({
    x: (glyph.x + glyph.w / 2 - left) / unit,
    y: (glyph.y + glyph.h / 2 - top) / unit,
  }));
}
