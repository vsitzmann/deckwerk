/**
 * Three-way merge of a text box's html, for two people typing into the same
 * box at the same time.
 *
 * Live text sync streams a box's whole html every few hundred milliseconds.
 * Replacing the html wholesale made concurrent typing last-writer-wins at
 * that granularity: whenever two peers' pushes crossed in flight (or one
 * arrived while the other had unsent keystrokes), one side's characters were
 * dropped, and the losing editor then adopted the winner's html with its
 * caret at the same numeric offset, so its next keystrokes landed in the
 * middle of the other person's word. Merging against the html the edit was
 * made from keeps both people's text.
 *
 * The merge works on tokens — a whole tag, a whole character reference, or
 * one character — so markup is never split. Changes in different places
 * both apply. Two insertions at the same place keep `incoming` first: the
 * incoming side is the one whose author is typing there (the transaction
 * being applied, or the local DOM), so a word continued across two syncs
 * stays one word and the other person's text moves along behind it. Both
 * are kept even when identical: each is something a person typed. Changes
 * that overlap the same base text resolve to `incoming`'s version of just
 * that region (last writer wins, but only for the contested words). A result
 * whose tags no longer nest falls back to `incoming` whole.
 *
 * Deterministic: the server and every client apply the same transactions in
 * the same order through this function (collabApply), so replicas converge.
 */

const TOKEN = /<!--[\s\S]*?-->|<[^>]*>|&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);|[\s\S]/gu;

export function htmlTokens(html: string): string[] {
  return html.match(TOKEN) ?? [];
}

/** Base range [start, end) replaced by `insert`. */
export interface Hunk<T> {
  start: number;
  end: number;
  insert: T[];
}

/** Above this many cells the middle of a diff is one replacement hunk. */
const LCS_CELL_LIMIT = 1_000_000;

/**
 * Edit hunks turning `a` into `b`, in ascending base order and never
 * overlapping. Common prefix and suffix are trimmed first, so the typical
 * edit (a run typed or deleted at one place) is a single exact hunk.
 */
export function diffSequences<T>(a: readonly T[], b: readonly T[]): Array<Hunk<T>> {
  let prefix = 0;
  const shorter = Math.min(a.length, b.length);
  while (prefix < shorter && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shorter - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix += 1;
  const aEnd = a.length - suffix;
  const bEnd = b.length - suffix;
  const n = aEnd - prefix;
  const m = bEnd - prefix;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > LCS_CELL_LIMIT) {
    return [{ start: prefix, end: aEnd, insert: b.slice(prefix, bEnd) }];
  }
  // lcs[i * (m + 1) + j]: longest common subsequence of a[prefix+i..aEnd)
  // and b[prefix+j..bEnd).
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[prefix + i] === b[prefix + j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const hunks: Array<Hunk<T>> = [];
  let open: Hunk<T> | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[prefix + i] === b[prefix + j]
      && lcs[i * width + j] === lcs[(i + 1) * width + j + 1] + 1) {
      if (open) {
        hunks.push(open);
        open = null;
      }
      i += 1;
      j += 1;
      continue;
    }
    open ??= { start: prefix + i, end: prefix + i, insert: [] };
    if (j < m && (i >= n || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
      open.insert.push(b[prefix + j]);
      j += 1;
    } else {
      i += 1;
      open.end = prefix + i;
    }
  }
  if (open) hunks.push(open);
  return hunks;
}

interface Sided<T> extends Hunk<T> {
  side: 'current' | 'incoming';
}

/**
 * Merge two token sequences that both descend from `base`. See the module
 * comment for the rules; returns the merged tokens.
 */
export function mergeSequences<T>(
  base: readonly T[],
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const hunks: Array<Sided<T>> = [
    ...diffSequences(base, incoming).map((hunk) => ({ ...hunk, side: 'incoming' as const })),
    ...diffSequences(base, current).map((hunk) => ({ ...hunk, side: 'current' as const })),
  ];
  // By start; at one start, pure insertions before replacements, and
  // incoming before current. The sort is stable, so each side keeps its order.
  hunks.sort((x, y) => x.start - y.start
    || Number(x.end > x.start) - Number(y.end > y.start)
    || Number(x.side === 'current') - Number(y.side === 'current'));

  const out: T[] = [];
  let cursor = 0;
  let k = 0;
  while (k < hunks.length) {
    // A group: hunks whose base ranges overlap. An insertion at the very end
    // of a replaced range, or two insertions at one point, do not overlap.
    const group = [hunks[k]];
    let end = hunks[k].end;
    k += 1;
    while (k < hunks.length && hunks[k].start < end) {
      group.push(hunks[k]);
      end = Math.max(end, hunks[k].end);
      k += 1;
    }
    const start = group[0].start;
    out.push(...base.slice(cursor, start));
    const sides = new Set(group.map((hunk) => hunk.side));
    if (sides.size === 1) {
      for (const hunk of group) out.push(...hunk.insert);
    } else {
      // Both edited the same base text: incoming's version of the region.
      let at = start;
      for (const hunk of group) {
        if (hunk.side !== 'incoming') continue;
        out.push(...base.slice(at, hunk.start), ...hunk.insert);
        at = hunk.end;
      }
      out.push(...base.slice(at, end));
    }
    cursor = end;
  }
  out.push(...base.slice(cursor));
  return out;
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/** Do the tags in a token list open and close in properly nested pairs? */
export function tagsBalanced(tokens: readonly string[]): boolean {
  const open: string[] = [];
  for (const token of tokens) {
    if (token.length < 3 || token[0] !== '<' || token.startsWith('<!')) continue;
    const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(token);
    if (!match) continue;
    const name = match[2].toLowerCase();
    if (match[1]) {
      if (open.pop() !== name) return false;
    } else if (!VOID_TAGS.has(name) && !token.endsWith('/>')) {
      open.push(name);
    }
  }
  return open.length === 0;
}

/**
 * Three-way merge of html strings: `current` (what is there now) and
 * `incoming` (an edit made from `base`). Falls back to `incoming` when the
 * merged markup would not nest.
 */
export function mergeTextHtml(base: string, current: string, incoming: string): string {
  if (current === base) return incoming;
  if (incoming === base) return current;
  // Not short-circuited when current === incoming: two people who both typed
  // a space at the same point typed two spaces, and collapsing them glued
  // their next words together.
  const merged = mergeSequences(htmlTokens(base), htmlTokens(current), htmlTokens(incoming));
  return tagsBalanced(merged) ? merged.join('') : incoming;
}

/**
 * Where a caret at `offset` in `before` belongs in `after`, by the edits
 * between them. Text inserted exactly at the caret goes after it, so a
 * collaborator's words arriving where the author is typing never pull the
 * caret into (or past) them. Offsets are UTF-16 code units, as Range
 * measures them.
 */
export function mapTextOffset(before: string, after: string, offset: number): number {
  let delta = 0;
  for (const hunk of diffSequences(before.split(''), after.split(''))) {
    if (hunk.end < offset || (hunk.end === offset && hunk.start < offset)) {
      delta += hunk.insert.length - (hunk.end - hunk.start);
      continue;
    }
    // The caret was inside text that was replaced: put it after the replacement.
    if (hunk.start < offset) return hunk.start + delta + hunk.insert.length;
    break;
  }
  return Math.max(0, Math.min(after.length, offset + delta));
}
