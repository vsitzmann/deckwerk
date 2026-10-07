/**
 * Copy and compare deck-shaped JSON data in time proportional to its
 * structure rather than its bytes.
 *
 * Strings are immutable, so a copy may share them and an equality check that
 * meets the same string on both sides is a pointer compare. A deck that holds
 * a 10 MB inline image therefore clones and compares as cheaply as one that
 * does not — `structuredClone` and `JSON.stringify` both pay for every byte,
 * every time, and on a collaborative deck that was every keystroke on every
 * client.
 */

/**
 * A deep copy of plain JSON data (plain objects, arrays, primitives), sharing
 * strings with the source. Anything that is not a plain object or array is
 * handed to `structuredClone`, so exotic values copy exactly as they did.
 */
export function cloneJson<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = cloneJson(value[i]);
    return out as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return structuredClone(value);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) out[key] = cloneJson(source[key]);
  return out as T;
}

const ABSENT = Symbol('absent');

/** The value as JSON.stringify would see it, or ABSENT for an omitted property. */
function jsonView(value: unknown, inArray: boolean): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return inArray ? null : ABSENT;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (value && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return jsonView((value as { toJSON: () => unknown }).toJSON(), inArray);
  }
  return value;
}

function equalViews(a: unknown, b: unknown, ignoreKeys: ReadonlySet<string> | null): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const array = Array.isArray(a);
  if (array !== Array.isArray(b)) return false;
  if (array) {
    const left = a as unknown[];
    const right = b as unknown[];
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (!equalViews(jsonView(left[i], true), jsonView(right[i], true), null)) return false;
    }
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  // The same present keys in the same order, as JSON.stringify would see
  // them. Key order is not cosmetic here: a store that kept its own
  // differently-ordered copy of a slide the server sent back normalised would
  // never converge on the normalised form, and every key-order-sensitive
  // comparison downstream (diffDecks, snapshots) would see a change.
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  const skipped = (source: Record<string, unknown>, key: string) =>
    Boolean(ignoreKeys?.has(key)) || jsonView(source[key], false) === ABSENT;
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < leftKeys.length && skipped(left, leftKeys[i])) i++;
    while (j < rightKeys.length && skipped(right, rightKeys[j])) j++;
    if (i === leftKeys.length || j === rightKeys.length) {
      return i === leftKeys.length && j === rightKeys.length;
    }
    const key = leftKeys[i];
    if (key !== rightKeys[j]) return false;
    if (!equalViews(jsonView(left[key], false), jsonView(right[key], false), null)) return false;
    i++;
    j++;
  }
}

/**
 * Whether two values serialize to the same JSON —
 * `JSON.stringify(a) === JSON.stringify(b)`, key order included, without
 * building either string.
 * Identical references short-circuit at every level, so comparing two decks
 * that share most of their slides costs only what differs.
 *
 * `ignoreKeys` drops those keys from the top-level objects only.
 */
export function jsonEqual(a: unknown, b: unknown, ignoreKeys?: readonly string[]): boolean {
  const left = jsonView(a, false);
  const right = jsonView(b, false);
  if (left === ABSENT || right === ABSENT) return left === right;
  return equalViews(left, right, ignoreKeys?.length ? new Set(ignoreKeys) : null);
}
