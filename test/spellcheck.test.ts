// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { LocalLinter } from 'harper.js';
import { binaryInlined } from 'harper.js/binaryInlined';
import { maskNonProse, proseOf, rangeFor, toSpellingLints, type RawLint } from '../src/renderer/editor/spellcheck.js';

function box(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('spellcheck prose extraction', () => {
  it('puts each block on its own line and maps offsets back to text nodes', () => {
    const body = box('<p>Hello <b>wrold</b></p><p>second</p>');
    const prose = proseOf(body);
    expect(prose.text).toBe('Hello wrold\nsecond\n');
    const start = prose.text.indexOf('wrold');
    expect(rangeFor(prose, start, start + 5)!.toString()).toBe('wrold');
    const s2 = prose.text.indexOf('second');
    expect(rangeFor(prose, s2, s2 + 6)!.toString()).toBe('second');
  });

  it('keeps a range that crosses formatting runs', () => {
    const prose = proseOf(box('<p>mis<i>spel</i>led</p>'));
    expect(rangeFor(prose, 0, 10)!.toString()).toBe('misspelled');
  });

  it('masks TeX maths and URLs with same-length spaces', () => {
    const text = 'see $x_i^2$ and \\(\\alpha\\) at https://example.com/abc now';
    const masked = maskNonProse(text);
    expect(masked).toHaveLength(text.length);
    expect(masked).toBe(`see ${' '.repeat(7)} and ${' '.repeat(10)} at ${' '.repeat(23)} now`);
  });

  it('skips rendered KaTeX and code', () => {
    const prose = proseOf(box('<p>a <span class="katex">xyzzq</span> <code>fooo()</code> b</p>'));
    expect(prose.text).not.toMatch(/xyzzq|fooo/);
  });
});

describe('spellcheck lint mapping', () => {
  const raw = (kind: string, start: number, end: number, sugg: string[] = []): RawLint => ({
    lint_kind: () => kind,
    message: () => 'msg `x`',
    span: () => ({ start, end }),
    suggestions: () => sugg.map((s) => ({ get_replacement_text: () => s })),
  });

  it('drops formatting and whitespace lints, classifies the rest', () => {
    const text = 'Teh  cat are';
    const lints = toSpellingLints(text, [
      raw('Typo', 0, 3, ['The']),
      raw('Formatting', 3, 5),
      raw('Agreement', 9, 12, ['is']),
      raw('Spelling', 3, 5),
    ]);
    expect(lints.map((l) => [l.kind, text.slice(l.start, l.end), l.suggestions])).toEqual([
      ['spelling', 'Teh', ['The']],
      ['grammar', 'are', ['is']],
    ]);
    expect(lints[0].message).toBe('msg "x"');
  });

  it('honours ignored words', () => {
    const lints = toSpellingLints('NeRF', [raw('Spelling', 0, 4)], (w) => w === 'NeRF');
    expect(lints).toEqual([]);
  });

  it('flags a real misspelling end to end with Harper', async () => {
    const linter = new LocalLinter({ binary: binaryInlined });
    await linter.setup();
    const prose = proseOf(box('<p>We propsoe a method for $f(x)$.</p>'));
    const lints = toSpellingLints(prose.text, await linter.lint(prose.text, { language: 'plaintext' }) as unknown as RawLint[]);
    expect(lints).toHaveLength(1);
    expect(prose.text.slice(lints[0].start, lints[0].end)).toBe('propsoe');
    expect(lints[0].kind).toBe('spelling');
    expect(lints[0].suggestions).toContain('propose');
  }, 60_000);
});
