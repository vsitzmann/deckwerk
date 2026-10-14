import { describe, expect, it } from 'vitest';
import { ClipboardStash } from '../src/server/clipboardStash.js';

/** The server's memory of browser copies, between one tab's copy and another's paste. */

const ID = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const THIRD = 'c'.repeat(32);

describe('clipboard stash', () => {
  it('gives a copy back, as sent, only to whoever made it', () => {
    const stash = new ClipboardStash();
    expect(stash.put(ID, 'ada', 'talks/a', Buffer.from('{"kind":"elements"}'))).toBe(true);
    expect(stash.get(ID, 'ada')).toEqual({ deck: 'talks/a', body: Buffer.from('{"kind":"elements"}') });
    expect(stash.get(ID, 'bob')).toBeNull();
    expect(stash.get(OTHER, 'ada')).toBeNull();
  });

  it('refuses malformed ids, oversized copies, and someone else\'s id', () => {
    const stash = new ClipboardStash({ maxEntryBytes: 8 });
    expect(stash.put('short', 'ada', 'a', Buffer.from('{}'))).toBe(false);
    expect(stash.put('../../etc/passwd-0000000000', 'ada', 'a', Buffer.from('{}'))).toBe(false);
    expect(stash.put(ID, 'ada', 'a', Buffer.alloc(9))).toBe(false);
    expect(stash.put(ID, 'ada', 'a', Buffer.from('{}'))).toBe(true);
    expect(stash.put(ID, 'bob', 'b', Buffer.from('[]'))).toBe(false);
    expect(stash.get(ID, 'ada')?.deck).toBe('a');
    // The same person copying again under the same id replaces the copy.
    expect(stash.put(ID, 'ada', 'c', Buffer.from('[]'))).toBe(true);
    expect(stash.get(ID, 'ada')?.deck).toBe('c');
  });

  it('forgets copies once they are old, and the oldest first when full', () => {
    let now = 0;
    const stash = new ClipboardStash({ maxTotalBytes: 10, ttlMs: 1000, now: () => now });
    stash.put(ID, null, 'a', Buffer.alloc(4));
    now = 100;
    stash.put(OTHER, null, 'b', Buffer.alloc(4));
    now = 200;
    // Over budget: the oldest goes, the newest stays.
    stash.put(THIRD, null, 'c', Buffer.alloc(4));
    expect(stash.get(ID, null)).toBeNull();
    expect(stash.get(OTHER, null)?.deck).toBe('b');
    expect(stash.get(THIRD, null)?.deck).toBe('c');
    now = 1150;
    expect(stash.get(OTHER, null)).toBeNull();
    expect(stash.get(THIRD, null)?.deck).toBe('c');
    now = 1250;
    expect(stash.get(THIRD, null)).toBeNull();
    expect(stash.size).toBe(0);
  });
});
