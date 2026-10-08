import { describe, expect, it } from 'vitest';
import {
  diffSequences, htmlTokens, mapTextOffset, mergeSequences, mergeTextHtml, tagsBalanced,
} from '../src/shared/textMerge.js';

const chars = (text: string) => text.split('');
const merge = (base: string, current: string, incoming: string) =>
  mergeSequences(chars(base), chars(current), chars(incoming)).join('');

describe('diffSequences', () => {
  it('trims the common ends to one exact hunk for a typed run', () => {
    expect(diffSequences(chars('Base alp'), chars('Base alpha'))).toEqual([
      { start: 8, end: 8, insert: ['h', 'a'] },
    ]);
    expect(diffSequences(chars('Base alpha'), chars('Bse alpha'))).toEqual([
      { start: 1, end: 2, insert: [] },
    ]);
    expect(diffSequences(chars('same'), chars('same'))).toEqual([]);
  });

  it('finds separate hunks for separate edits', () => {
    const hunks = diffSequences(chars('one two three'), chars('one TWO three!'));
    let rebuilt = '';
    let at = 0;
    const base = 'one two three';
    for (const hunk of hunks) {
      rebuilt += base.slice(at, hunk.start) + hunk.insert.join('');
      at = hunk.end;
    }
    rebuilt += base.slice(at);
    expect(rebuilt).toBe('one TWO three!');
    expect(hunks.length).toBeGreaterThan(1);
  });
});

describe('mergeSequences', () => {
  it('applies edits made in different places on both sides', () => {
    expect(merge('Base and more', 'Base alpha and more', 'Base and more bravo'))
      .toBe('Base alpha and more bravo');
  });

  it('keeps both runs typed at one point, incoming first', () => {
    expect(merge('Base', 'Base alpha', 'Base bravo')).toBe('Base bravo alpha');
  });

  it('keeps a word continued across two syncs in one piece', () => {
    // Bob had synced "Base bra"; Alice's " alp" was merged in behind it at the
    // server; Bob meanwhile typed "vo". His "vo" continues his own word.
    expect(merge('Base bra', 'Base bra alp', 'Base bravo')).toBe('Base bravo alp');
    // The same from Alice's side: her "ha" continues "alp".
    expect(merge('Base alp', 'Base bra alp', 'Base alpha')).toBe('Base bra alpha');
  });

  it('resolves only the contested region to incoming', () => {
    expect(merge('a cat sat. end', 'a dog sat. end!', 'a cow sat. end'))
      .toBe('a cow sat. end!');
  });

  it('applies a deletion on one side and an insertion elsewhere on the other', () => {
    expect(merge('keep drop keep', 'keep keep', 'keep drop keep more'))
      .toBe('keep keep more');
  });
});

describe('mergeTextHtml', () => {
  it('never splits a tag or a character reference', () => {
    expect(htmlTokens('<p class="a">x&amp;y</p>')).toEqual([
      '<p class="a">', 'x', '&amp;', 'y', '</p>',
    ]);
  });

  it('merges concurrent typing into one paragraph', () => {
    expect(mergeTextHtml('<p>Base</p>', '<p>Base alpha</p>', '<p>Base bravo</p>'))
      .toBe('<p>Base bravo alpha</p>');
  });

  it('merges typing in different paragraphs and around formatting', () => {
    expect(mergeTextHtml(
      '<p>One</p><p>Two <b>bold</b></p>',
      '<p>One more</p><p>Two <b>bold</b></p>',
      '<p>One</p><p>Two <b>bolder</b> end</p>',
    )).toBe('<p>One more</p><p>Two <b>bolder</b> end</p>');
  });

  it('falls back to incoming when the merged tags would not nest', () => {
    expect(tagsBalanced(htmlTokens('<p><b>x</p></b>'))).toBe(false);
    expect(tagsBalanced(htmlTokens('<p>a<br>b<img src="x"></p>'))).toBe(true);
    // One side wraps "ab" in bold, the other wraps "bc" in italics.
    const incoming = '<p>a<i>bc</i></p>';
    const merged = mergeTextHtml('<p>abc</p>', '<p><b>ab</b>c</p>', incoming);
    expect(tagsBalanced(htmlTokens(merged))).toBe(true);
  });

  it('is plain replacement when nothing happened concurrently', () => {
    expect(mergeTextHtml('<p>a</p>', '<p>a</p>', '<p>b</p>')).toBe('<p>b</p>');
    expect(mergeTextHtml('<p>a</p>', '<p>c</p>', '<p>a</p>')).toBe('<p>c</p>');
  });
});

describe('identical concurrent typing', () => {
  it('keeps a space each person typed at the same point', () => {
    expect(mergeTextHtml('<p>Base</p>', '<p>Base&nbsp;</p>', '<p>Base&nbsp;</p>'))
      .toBe('<p>Base&nbsp;&nbsp;</p>');
  });

  it('keeps the words apart when both continue after their own space', () => {
    // Each editor turns its trailing nbsp into a space as its author types on.
    const afterAlice = mergeTextHtml('<p>Base&nbsp;</p>', '<p>Base&nbsp;&nbsp;</p>', '<p>Base alpha</p>');
    expect(afterAlice).toBe('<p>Base alpha&nbsp;</p>');
    expect(mergeTextHtml('<p>Base&nbsp;</p>', afterAlice, '<p>Base bravo</p>'))
      .toBe('<p>Base alpha bravo</p>');
  });
});

describe('mapTextOffset', () => {
  it('moves a caret past text inserted before it', () => {
    expect(mapTextOffset('Base bravo', 'Base alpha bravo', 10)).toBe(16);
  });

  it('keeps a caret in front of text inserted exactly at it', () => {
    expect(mapTextOffset('Base bra', 'Base bra alp', 8)).toBe(8);
    expect(mapTextOffset('Base', 'Base alpha', 4)).toBe(4);
  });

  it('leaves a caret before an edit alone and clamps to the text', () => {
    expect(mapTextOffset('Base alpha', 'Base alpha!', 2)).toBe(2);
    expect(mapTextOffset('Base alpha', 'Base', 10)).toBe(4);
  });

  it('puts a caret inside replaced text after the replacement', () => {
    expect(mapTextOffset('a cat sat', 'a dog sat', 4)).toBe(5);
  });
});
