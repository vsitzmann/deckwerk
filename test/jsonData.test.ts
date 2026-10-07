import { describe, expect, it } from 'vitest';
import { cloneJson, jsonEqual } from '../src/shared/jsonData.js';

/** jsonEqual must agree with comparing JSON.stringify output, exactly. */
describe('jsonEqual', () => {
  const cases: Array<[unknown, unknown]> = [
    [{ a: 1, b: 2 }, { a: 1, b: 2 }],
    [{ a: 1, b: 2 }, { b: 2, a: 1 }],
    [{ a: 1, b: undefined }, { a: 1 }],
    [{ b: undefined, a: 1 }, { a: 1 }],
    [{ a: 1, f: () => 1 }, { a: 1 }],
    [[1, undefined, 3], [1, null, 3]],
    [{ n: Number.NaN }, { n: null }],
    [{ n: Number.POSITIVE_INFINITY }, { n: null }],
    [{ n: 0 }, { n: -0 }],
    [{ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] }],
    [{ a: [1, { b: 'x' }] }, { a: [1, { b: 'y' }] }],
    [{ a: [] }, { a: {} }],
    [{ a: null }, { a: {} }],
    [{ a: '1' }, { a: 1 }],
    [{ a: true }, { a: 1 }],
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ d: new Date(0) }, { d: new Date(0).toISOString() }],
    [undefined, undefined],
    [null, undefined],
    ['x', 'x'],
    [[{}], [{ u: undefined }]],
  ];

  it.each(cases.map((pair, index) => [index, ...pair]))('agrees with JSON.stringify, case %i', (_index, a, b) => {
    expect(jsonEqual(a, b)).toBe(JSON.stringify(a) === JSON.stringify(b));
    expect(jsonEqual(b, a)).toBe(JSON.stringify(b) === JSON.stringify(a));
  });

  it('ignores the named top-level keys only', () => {
    expect(jsonEqual({ id: 1, notes: 'a' }, { id: 1, notes: 'b' }, ['notes'])).toBe(true);
    expect(jsonEqual({ id: 1, notes: 'a' }, { id: 1 }, ['notes'])).toBe(true);
    expect(jsonEqual({ id: 1, x: { notes: 'a' } }, { id: 1, x: { notes: 'b' } }, ['notes'])).toBe(false);
  });

  it('clones deeply, keeps key order, and shares strings', () => {
    const big = 'A'.repeat(1 << 20);
    const value = { z: 1, a: [{ s: big, u: undefined }], n: null };
    const copy = cloneJson(value);
    expect(copy).not.toBe(value);
    expect(copy.a).not.toBe(value.a);
    expect(copy.a[0]).not.toBe(value.a[0]);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(value));
    expect(Object.keys(copy.a[0])).toEqual(['s', 'u']);
    expect(jsonEqual(copy, value)).toBe(true);
  });
});
