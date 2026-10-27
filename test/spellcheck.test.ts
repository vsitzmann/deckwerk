// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { LocalLinter } from 'harper.js';
import { binaryInlined } from 'harper.js/binaryInlined';
import {
  maskNonProse, proseOf, rangeFor, rawLint, toSpellingLints,
  type RawLint, type SpellcheckReply, type SpellcheckRequest,
} from '../src/renderer/editor/spellcheck.js';

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

  // The page reads lints the worker sends as plain data: harper.js's own
  // WorkerLinter rebuilt them as WebAssembly objects on the page, which made
  // the page load the whole binary too.
  it('lints in spellcheckWorker.ts and answers with plain data', async () => {
    const replies: SpellcheckReply[] = [];
    vi.stubGlobal('postMessage', (reply: SpellcheckReply) => replies.push(reply));
    try {
      await import('../src/renderer/editor/spellcheckWorker.js');
      const ask = async (request: SpellcheckRequest) => {
        const before = replies.length;
        (self.onmessage as (event: { data: SpellcheckRequest }) => void)({ data: request });
        await vi.waitFor(() => expect(replies.length).toBe(before + 1), { timeout: 60_000 });
        return replies[before];
      };
      const prose = proseOf(box('<p>We propsoe a method.</p>'));
      const linted = await ask({ id: 7, op: 'lint', text: prose.text });
      expect(linted.id).toBe(7);
      expect(structuredClone(linted), 'nothing but plain data crosses back').toEqual(linted);
      const lints = toSpellingLints(prose.text, linted.lints!.map(rawLint));
      expect(lints.map((lint) => prose.text.slice(lint.start, lint.end))).toEqual(['propsoe']);
      expect(lints[0].suggestions).toContain('propose');

      expect(await ask({ id: 8, op: 'importWords', words: ['propsoe'] })).toEqual({ id: 8 });
      expect((await ask({ id: 9, op: 'lint', text: prose.text })).lints).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 120_000);
});
