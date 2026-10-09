// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeTheme } from 'shiki/core';
import { emptyDeck, parseDeck, type CodeEl, type Slide } from '../src/shared/deck.js';
import {
  CODE_SCHEMES,
  codeBlockHeight,
  codeLineState,
  codeLines,
  contrastRatio,
  deckCodeColors,
  formatLineSteps,
  normalizeCodeLanguage,
  normalizeCodeScheme,
  normalizeLineSteps,
  parseLineRanges,
  parseLineSteps,
} from '../src/shared/codeBlocks.js';
import { codeAssetsReady, highlightCode, loadCodeAssets } from '../src/shared/codeHighlight.js';
import { codeFromMarkup } from '../src/shared/codeHtml.js';
import { carrySlideState, slideFromMeasured, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import { expandTimeline, resolveState, stepCount } from '../src/shared/timeline.js';
import { THEMES, themeStyleOf } from '../src/shared/themes.js';
import { applyCodeLineState, renderCodeBody, whenCodeHighlighted } from '../src/renderer/player/codeRender.js';

/**
 * Code blocks: the line-build grammar, the Deck scheme, highlighting, the
 * HTML round trip and the rendered lines. The real browser walk and the
 * player are covered by codeBlockBrowser.test.ts.
 */

function codeEl(over: Partial<CodeEl> = {}): CodeEl {
  return {
    id: 'code-1', type: 'code', x: 100, y: 200, w: 1200, h: 300, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, code: 'x = 1\n', language: 'python', scheme: 'github-dark',
    fontSize: 28, lineNumbers: false, ...over,
  };
}

function slideWith(el: CodeEl, timeline: Slide['timeline'] = []): Slide {
  const deck = emptyDeck();
  const slide = deck.slides[0];
  slide.elements.push(el);
  slide.timeline.push(...timeline);
  return parseDeck(deck).slides[0];
}

describe('the code element schema', () => {
  it('fills defaults and keeps an unknown language rather than failing the deck', () => {
    const deck = parseDeck({
      version: 1,
      slides: [{ id: 's', elements: [{ id: 'c', type: 'code', x: 0, y: 0, w: 10, h: 10, language: 'brainfuck' }] }],
    });
    const el = deck.slides[0].elements[0] as CodeEl;
    expect(el).toMatchObject({ code: '', language: 'brainfuck', scheme: 'github-dark', fontSize: 28, lineNumbers: false });
  });
});

describe('languages and schemes', () => {
  it('reads what authors write', () => {
    expect(normalizeCodeLanguage('py')).toBe('python');
    expect(normalizeCodeLanguage('language-TS')).toBe('typescript');
    expect(normalizeCodeLanguage('cu')).toBe('cuda');
    expect(normalizeCodeLanguage('sh')).toBe('bash');
    expect(normalizeCodeLanguage('c++')).toBe('cpp');
    expect(normalizeCodeLanguage('tex')).toBe('latex');
    expect(normalizeCodeLanguage('cobol')).toBe('plaintext');
    expect(normalizeCodeScheme('One Dark')).toBe('one-dark-pro');
    expect(normalizeCodeScheme('nope')).toBe('github-dark');
  });

  it('knows each scheme\'s ground and ink before loading it, exactly as Shiki has them', async () => {
    for (const scheme of CODE_SCHEMES.filter((candidate) => candidate.id !== 'deck')) {
      const theme = (await import(`shiki/themes/${scheme.id}.mjs`)).default;
      const normalized = normalizeTheme(theme);
      const hex = (color: string) => color.toLowerCase()
        .replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3').replace(/^(#[0-9a-f]{6})ff$/, '$1');
      expect(hex(scheme.fg), scheme.id).toBe(hex(normalized.fg));
      expect(hex(scheme.bg), scheme.id).toBe(hex(normalized.bg));
    }
  });
});

describe('line ranges and steps', () => {
  it('parses ranges, forgiving typos', () => {
    expect(parseLineRanges('1-3, 7')).toEqual([1, 2, 3, 7]);
    expect(parseLineRanges('5-3')).toEqual([3, 4, 5]);
    expect(parseLineRanges('x, 2')).toEqual([2]);
  });

  it('parses a spec and writes it back canonically', () => {
    const steps = parseLineSteps('1-3 ;show 4,5; Highlight: 5 ; focus 2-3; highlight:all; ;');
    expect(steps).toEqual([
      { mode: 'reveal', lines: [1, 2, 3] },
      { mode: 'reveal', lines: [4, 5] },
      { mode: 'highlight', lines: [5] },
      { mode: 'highlight', lines: [2, 3] },
      { mode: 'highlight', lines: [] },
    ]);
    expect(formatLineSteps(steps)).toBe('1-3; 4-5; highlight:5; highlight:2-3; highlight:all');
    expect(normalizeLineSteps('  ; ')).toBeNull();
  });

  it('hides lines until their reveal, and dims around a highlight until the next step', () => {
    const steps = parseLineSteps('2-3; highlight:2; 4; highlight:9');
    expect(codeLineState(steps, 0)).toEqual({ hidden: new Set([2, 3, 4]), focus: null });
    expect(codeLineState(steps, 1)).toEqual({ hidden: new Set([4]), focus: null });
    expect(codeLineState(steps, 2)).toEqual({ hidden: new Set([4]), focus: new Set([2]) });
    // A reveal ends the highlight: new lines are never born dimmed.
    expect(codeLineState(steps, 3)).toEqual({ hidden: new Set(), focus: null });
    expect(codeLineState(steps, 4).focus).toEqual(new Set([9]));
  });

  it('drops the empty line a trailing newline would make, and sizes the block to its lines', () => {
    expect(codeLines('a\nb\n')).toEqual(['a', 'b']);
    expect(codeLines('a\n\n')).toEqual(['a', '']);
    expect(codeBlockHeight({ code: 'a\nb\nc\nd\n', fontSize: 28 })).toBe(210);
  });
});

describe('a line build on the timeline', () => {
  const lines = (value: string, on: 'click' | 'afterPrev' = 'click') => ({
    id: 'lb', trigger: { on, ref: null, delay: 0 }, action: { type: 'lines' as const, target: 'code-1', value },
  });

  it('fans out into one step per part and replays to the right state', () => {
    const slide = slideWith(codeEl({ code: 'a\nb\nc\nd\ne\n' }), [lines('1-2; 3; highlight:5')]);
    expect(expandTimeline(slide).map((unit) => unit.id)).toEqual(['lb', 'lb#p1', 'lb#p2']);
    expect(stepCount(slide)).toBe(4);
    expect(resolveState(slide, 0).lines.get('code-1')).toEqual({ spec: '1-2; 3; highlight:5', applied: 0 });
    expect(resolveState(slide, 3).lines.get('code-1')).toEqual({ spec: '1-2; 3; highlight:5', applied: 3 });
    // A line build is not a visibility action: the block shows on entry.
    expect(resolveState(slide, 0).visible.has('code-1')).toBe(true);
  });

  it('cascades the parts after the first on an afterPrev trigger', () => {
    const slide = slideWith(codeEl(), [lines('1; 2', 'afterPrev')]);
    expect(stepCount(slide)).toBe(1);
    expect(resolveState(slide, 0).lines.get('code-1')?.applied).toBe(2);
  });
});

describe('the Deck scheme', () => {
  it('derives readable, distinct roles from a theme', () => {
    const research = themeStyleOf(THEMES.find((theme) => theme.id === 'basic')!);
    const colors = deckCodeColors(research);
    expect(colors.foreground).toBe('#191918');
    expect(colors['token-comment']).toBe('#6b6862');
    expect(colors['token-keyword']).toBe('#c96442');
    // The ground is the slide's, nudged toward the text so the block reads as a panel.
    expect(colors.background).not.toBe('#faf9f5');
    expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThan(7);
    for (const role of ['token-string', 'token-constant', 'token-function'] as const) {
      expect(contrastRatio(colors[role], colors.background), role).toBeGreaterThanOrEqual(2.5);
    }
    expect(new Set([colors['token-string'], colors['token-constant'], colors['token-function']]).size).toBe(3);
    expect(deckCodeColors(research)).toEqual(colors);
  });

  it('still has three distinct roles when the palette has nothing to offer', () => {
    const colors = deckCodeColors({
      colors: { background: '#000000', text: '#ffffff', muted: '#888888', accent: '#ff3366' }, palette: [],
    });
    expect(new Set([colors['token-string'], colors['token-constant'], colors['token-function']]).size).toBe(3);
  });
});

describe('highlighting', () => {
  beforeAll(async () => {
    await Promise.all([
      loadCodeAssets('python', 'github-dark'),
      loadCodeAssets('cuda', 'one-dark-pro'),
      loadCodeAssets('python', 'deck'),
      loadCodeAssets('sql', 'nord'),
    ]);
  });

  it('is not ready before its grammar loads, and plain text never needs one', () => {
    expect(codeAssetsReady('rust', 'dracula')).toBe(false);
    expect(highlightCode('fn main() {}', 'rust', 'dracula')).toBeNull();
    expect(highlightCode('a <b>\n\tc', 'plaintext', 'dracula')).toEqual({
      lines: [[{ content: 'a <b>' }], [{ content: '\tc' }]],
    });
  });

  it('produces the same coloured runs every time', () => {
    const result = highlightCode('def f(x):\n\treturn x < 3  # hi\n', 'python', 'github-dark');
    expect(result).toEqual({
      lines: [
        [{ content: 'def', color: '#F97583' }, { content: ' ' }, { content: 'f', color: '#B392F0' }, { content: '(x):' }],
        [{ content: '\t' }, { content: 'return', color: '#F97583' }, { content: ' x ' }, { content: '<', color: '#F97583' },
          { content: ' ' }, { content: '3', color: '#79B8FF' }, { content: '  ' }, { content: '# hi', color: '#6A737D' }],
      ],
    });
    expect(highlightCode('def f(x):\n\treturn x < 3  # hi\n', 'python', 'github-dark')).toEqual(result);
  });

  it('highlights CUDA with the C++ grammar and case-insensitive SQL keywords', () => {
    const cuda = highlightCode('__global__ void k(float* a) { a[threadIdx.x] = 1.0f; }', 'cuda', 'one-dark-pro')!;
    expect(cuda.lines[0].some((run) => run.content === 'void' && run.color)).toBe(true);
    const sql = highlightCode('select a from t;', 'sql', 'nord')!;
    expect(sql.lines[0].find((run) => run.content === 'select')?.color).toBeTruthy();
  });

  it('paints the Deck scheme with the deck\'s custom properties', () => {
    const deck = highlightCode('def f():\n    return "s"  # c', 'python', 'deck')!;
    const colors = deck.lines.flat().map((run) => run.color).filter(Boolean);
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) expect(color).toMatch(/^var\(--deckwerk-code-token-[a-z-]+, #[0-9a-f]{6}\)$/);
  });
});

describe('rendered lines', () => {
  it('draws coloured runs per line, with a gutter, and follows a line build', async () => {
    const el = codeEl({ code: 'import numpy as np\nx = np.ones(3)\n\ny = x * 2\n', lineNumbers: true });
    const wrapper = document.createElement('div');
    wrapper.dataset.elementId = el.id;
    const body = renderCodeBody(el);
    wrapper.appendChild(body);
    document.body.appendChild(wrapper);
    await whenCodeHighlighted(body);
    const lines = [...body.querySelectorAll<HTMLElement>('.code-line')];
    expect(lines.map((line) => line.dataset.line)).toEqual(['1', '2', '3', '4']);
    expect(lines[0].querySelector('.code-gutter')?.textContent).toBe('1');
    expect(lines[0].querySelector('span[style*="color"]:not(.code-gutter)')).not.toBeNull();
    expect(body.dataset.highlight).toBe('done');
    // The text is the code, exactly.
    expect(lines.map((line) => [...line.childNodes].filter((n) => !(n as HTMLElement).classList?.contains('code-gutter'))
      .map((n) => n.textContent).join(''))).toEqual(['import numpy as np', 'x = np.ones(3)', '', 'y = x * 2']);

    const slide = slideWith(el, [{
      id: 'lb', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'lines', target: el.id, value: '4; highlight:2' },
    }]);
    applyCodeLineState(document.body, slide, resolveState(slide, 0));
    expect(lines[3].style.visibility).toBe('hidden');
    expect(lines[0].style.visibility).toBe('');
    applyCodeLineState(document.body, slide, resolveState(slide, 2));
    expect(lines[3].style.visibility).toBe('');
    expect(lines[1].style.opacity).toBe('');
    expect(lines[0].style.opacity).toBe('0.3');
    wrapper.remove();
  });
});

/** What the browser walk reports for a `<pre>`, read from markup by a real HTML parser. */
function measured(markup: string, id: string | null = null): MeasuredNode {
  const doc = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
  const pre = doc.querySelector('pre')!;
  // As the walk does before measuring: a newline straight after <code> is formatting.
  const first = (pre.querySelector(':scope > code') ?? pre).firstChild;
  if (first?.nodeType === 3 && (first as Text).data.startsWith('\n')) (first as Text).data = (first as Text).data.slice(1);
  return {
    tag: 'pre', elementId: id ?? pre.dataset.elementId ?? null, classes: [],
    dataset: { ...pre.dataset } as Record<string, string>,
    rect: { x: 100, y: 200, w: 1200, h: 300 }, rotation: 0, opacity: 1,
    // An exported page's object is read from its inline declarations.
    style: Object.fromEntries((pre.getAttribute('style') ?? '').split(';')
      .map((declaration) => declaration.split(':').map((part) => part.trim()))
      .filter(([property, value]) => property && value && !['position', 'left', 'top', 'width', 'height'].includes(property))),
    html: pre.innerHTML, attrs: {},
  };
}

describe('the HTML round trip', () => {
  const tricky = '\n\tif (a < b && c > d) {\n\t\treturn "x" + \'y\';   \n\t}\n// \\$HOME and $PATH &amp; <tags>\n\n';

  it('writes a code block as <pre><code> with its code escaped, and reads it back exactly', () => {
    const el = codeEl({ code: tricky, language: 'cuda', scheme: 'deck', fontSize: 24, lineNumbers: true, style: { 'border-radius': '12px' } });
    const slide = slideWith(el, [{
      id: 'lb', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'lines', target: el.id, value: '1-3;highlight:5' },
    }]);
    const html = slideToHtml(slide, { w: 1920, h: 1080 });
    expect(html).toContain('<pre data-element-id="code-1"');
    expect(html).toContain('data-element="code" data-language="cuda" data-scheme="deck" data-font-size="24" data-line-numbers="true"');
    expect(html).toContain('data-build-lines="1-3; highlight:5"');
    expect(html).toContain('<code class="language-cuda">');
    expect(html).toContain('&lt;tags&gt;');

    const node = measured(html);
    const compiled = slideFromMeasured({ id: slide.id, name: '', notes: '', background: slide.background, nodes: [node] } as never,
      { slideId: slide.id, usedIds: new Set() });
    const back = compiled.elements[0] as CodeEl;
    expect(back.code).toBe(tricky);
    expect(back).toMatchObject({ type: 'code', language: 'cuda', scheme: 'deck', fontSize: 24, lineNumbers: true });
    // The scheme owns the ground, the ink and the size; the corners stay the element's.
    expect(back.style).toEqual({ 'border-radius': '12px' });
    expect(compiled.timeline).toEqual([{
      id: 'code-1-lines-1', trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'lines', target: 'code-1', value: '1-3; highlight:5' },
    }]);
  });

  it('reads the markup an agent naturally writes', () => {
    const node = measured('<pre data-element="code" data-language="py"><code>\ndef f(x):\n    return x &lt; 3\n</code></pre>');
    const compiled = slideFromMeasured({ id: 's', name: '', notes: '', background: { color: null, image: null }, nodes: [node] } as never,
      { slideId: 's', usedIds: new Set() });
    expect(compiled.elements[0]).toMatchObject({ type: 'code', language: 'python', code: 'def f(x):\n    return x < 3\n', fontSize: 28 });
    // A bare listing names its language on the <code>.
    expect(codeFromMarkup('<code class="language-rust">fn main() {}</code>')).toBe('fn main() {}');
    const bare = measured('<pre><code class="language-rust">fn main() {}</code></pre>');
    bare.dataset.element = 'code';
    const rust = slideFromMeasured({ id: 's', name: '', notes: '', background: { color: null, image: null }, nodes: [bare] } as never,
      { slideId: 's', usedIds: new Set() });
    expect(rust.elements[0]).toMatchObject({ type: 'code', language: 'rust' });
  });

  it('lets the page state the steps while the deck keeps the build\'s trigger and place', () => {
    const el = codeEl({ code: 'a\nb\nc\n' });
    const previous = slideWith(el, [
      { id: 'other', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'appear', target: el.id, value: null } },
      { id: 'lb', trigger: { on: 'afterPrev', ref: null, delay: 300 }, action: { type: 'lines', target: el.id, value: '1; 2' } },
    ]);
    const compile = (markup: string) => slideFromMeasured(
      { id: previous.id, name: '', notes: '', background: previous.background, nodes: [measured(markup, el.id)] } as never,
      { slideId: previous.id, usedIds: new Set() },
    );
    const edited = slideToHtml(previous, { w: 1920, h: 1080 }).replace('data-build-lines="1; 2"', 'data-build-lines="2-3; highlight:1"');
    const merged = carrySlideState(previous, compile(edited));
    expect(merged.timeline.map((entry) => [entry.id, entry.trigger.on, entry.action.type, entry.action.value])).toEqual([
      ['other', 'click', 'appear', null],
      ['lb', 'afterPrev', 'lines', '2-3; highlight:1'],
    ]);
    const removed = slideToHtml(previous, { w: 1920, h: 1080 }).replace(' data-build-lines="1; 2"', '');
    expect(carrySlideState(previous, compile(removed)).timeline.map((entry) => entry.id)).toEqual(['other']);
    // Saving the page untouched changes nothing.
    const same = carrySlideState(previous, compile(slideToHtml(previous, { w: 1920, h: 1080 })));
    expect(same.timeline).toEqual(previous.timeline);
    expect(same.elements[0]).toEqual(previous.elements[0]);
  });
});
