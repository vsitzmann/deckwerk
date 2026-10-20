import type { HighlighterCore } from 'shiki/core';
import { loadGrammar, loadShikiRuntime, loadTheme } from './codeAssets.js';
import {
  DECK_CODE_VARIABLE_PREFIX,
  DEFAULT_DECK_CODE_COLORS,
  codeLines,
  normalizeCodeLanguage,
  normalizeCodeScheme,
} from './codeBlocks.js';

/**
 * Shiki, loaded a grammar and a scheme at a time.
 *
 * Rendering a slide is synchronous everywhere (the canvas, the rail, the
 * player, PDF pages), so highlighting has to be too: `highlightCode` answers
 * at once from what is already loaded, or returns null. Loading is the only
 * asynchronous part — each grammar and theme is its own dynamic import
 * (codeAssets.ts), so a deck without code never downloads Shiki and a deck of
 * Python never downloads C++. Callers draw the block plainly in the scheme's own ink while
 * that happens and recolour it in place when it lands (player/codeRender.ts).
 *
 * The regex engine is Shiki's JavaScript one with a fixed `ES2024` target,
 * not Oniguruma: no WASM to fetch or instantiate, and no feature detection,
 * so the same grammar produces the same tokens in Electron, in any browser a
 * collaborator opens, and in Node for the tests. Every shipped grammar
 * tokenises identically to Oniguruma under it (checked when this was
 * written); `forgiving` keeps a future grammar's one odd pattern from taking
 * the whole language down.
 */

/**
 * Each language's grammar, by Shiki's name for it. CUDA has none of its own
 * in Shiki and is highlighted as C++, which covers its syntax; shell is
 * Shiki's `shellscript`.
 */
const GRAMMAR_NAMES: Record<string, string> = {
  python: 'python', javascript: 'javascript', typescript: 'typescript', c: 'c', cpp: 'cpp',
  cuda: 'cpp', rust: 'rust', glsl: 'glsl', bash: 'shellscript', json: 'json', yaml: 'yaml',
  latex: 'latex', html: 'html', css: 'css', sql: 'sql', go: 'go', java: 'java',
  julia: 'julia', matlab: 'matlab',
};

/** Common constructs across the shipped languages, tokenised once per grammar to compile its patterns. */
const WARM_UP = [
  '#include <vector>', '// line comment', '/* block comment */', 'import numpy as np',
  'template <class T> struct V : public B<T> { void f(float* a, int n) const {',
  '  for (int i = 0; i < n; ++i) { a[i] = 1.0f * 0x1F; } return; } };',
  'def f(x: float) -> str:  # comment', '    return "s" + \'c\' + f"{x!r}"',
  'function g(a) { const b = `t${a}`; return a ?? b; }', 'let v: Vec<i32> = vec![1, 2];',
  '\\begin{equation} x^2 \\end{equation}', 'SELECT a FROM t WHERE b > 3;', 'key: [1, true, null]',
].join('\n');

/** Shiki's internal name for the Deck scheme's theme. */
const DECK_THEME_NAME = 'deckwerk-deck';

/** One run of code in one colour. `color` is absent for plain text: it inherits the block's ink. */
export interface CodeToken {
  content: string;
  color?: string;
  /** Shiki's bit flags: 1 italic, 2 bold, 4 underline. */
  fontStyle?: number;
}

export interface HighlightedCode {
  lines: CodeToken[][];
}

let highlighter: HighlighterCore | null = null;
let highlighterLoading: Promise<HighlighterCore> | null = null;
const loadedGrammars = new Set<string>();
const loadedThemes = new Set<string>();
const pending = new Map<string, Promise<void>>();

function themeName(scheme: string): string {
  return scheme === 'deck' ? DECK_THEME_NAME : scheme;
}

async function loadHighlighter(): Promise<HighlighterCore> {
  if (highlighter) return highlighter;
  highlighterLoading ??= (async () => {
    const { createHighlighterCoreSync, createCssVariablesTheme, createJavaScriptRegexEngine } = await loadShikiRuntime();
    const created = createHighlighterCoreSync({
      engine: createJavaScriptRegexEngine({ target: 'ES2024', forgiving: true }),
      themes: [],
      langs: [],
    });
    // The Deck scheme is Shiki's CSS-variables theme: every role is a custom
    // property, set from the deck's colours where the deck is shown
    // (`deckCodeCss`). The defaults are the stock look, for a surface that
    // never set them.
    const deckTheme = createCssVariablesTheme({
      name: DECK_THEME_NAME,
      variablePrefix: DECK_CODE_VARIABLE_PREFIX,
      variableDefaults: DEFAULT_DECK_CODE_COLORS,
      fontStyle: true,
    });
    // Shiki's variables theme paints operators as keywords; in the deck's
    // colours that put the accent on every `=` and `*`. Operators read as
    // punctuation instead, so the accent stays on the words that matter.
    deckTheme.tokenColors = [...(deckTheme.tokenColors ?? []), {
      scope: ['keyword.operator', 'punctuation.separator', 'punctuation.accessor'],
      settings: { foreground: `var(${DECK_CODE_VARIABLE_PREFIX}token-punctuation, ${DEFAULT_DECK_CODE_COLORS['token-punctuation']})` },
    }];
    created.loadThemeSync(deckTheme);
    loadedThemes.add('deck');
    highlighter = created;
    return created;
  })();
  return highlighterLoading;
}

/** Whether `highlightCode` can answer for this language and scheme right now. */
export function codeAssetsReady(language: string, scheme: string): boolean {
  const lang = normalizeCodeLanguage(language);
  if (lang === 'plaintext') return true;
  return highlighter !== null
    && loadedGrammars.has(lang)
    && loadedThemes.has(normalizeCodeScheme(scheme));
}

/**
 * Load what a block in this language and scheme needs. Resolves once
 * `highlightCode` can answer; never rejects — a grammar that fails to load
 * leaves the block plain, which is still the code.
 */
export function loadCodeAssets(language: string, scheme: string): Promise<void> {
  const lang = normalizeCodeLanguage(language);
  const theme = normalizeCodeScheme(scheme);
  if (codeAssetsReady(lang, theme)) return Promise.resolve();
  const key = `${lang}|${theme}`;
  let loading = pending.get(key);
  if (!loading) {
    loading = (async () => {
      const shiki = await loadHighlighter();
      const grammarName = GRAMMAR_NAMES[lang];
      const [grammar, themeRegistration] = await Promise.all([
        grammarName && !loadedGrammars.has(lang) ? loadGrammar(grammarName) : null,
        !loadedThemes.has(theme) ? loadTheme(theme) : null,
      ]);
      if (grammar) {
        shiki.loadLanguageSync(grammar);
        loadedGrammars.add(lang);
        // The JavaScript engine compiles a grammar's patterns the first time
        // they are tried: C++ takes over a second, which would land as a stall
        // the first time a slide with C++ on it renders. Pay it here, while
        // the deck is loading, on a snippet that exercises the common rules.
        shiki.codeToTokens(WARM_UP, { lang: grammarName, theme: DECK_THEME_NAME });
      }
      if (themeRegistration) {
        shiki.loadThemeSync(themeRegistration);
        loadedThemes.add(theme);
      }
    })().catch((error: unknown) => {
      console.warn(`Code highlighting for ${lang} in ${theme} is unavailable:`, error);
    }).finally(() => pending.delete(key));
    pending.set(key, loading);
  }
  return loading;
}

/** Settles when every load started so far has. */
export function whenCodeAssetsSettled(): Promise<void> {
  return Promise.all([...pending.values()]).then(() => undefined);
}

const cache = new Map<string, HighlightedCode>();
const CACHE_LIMIT = 200;

/**
 * Tokenise `code` into coloured runs, line by line, or null when its grammar
 * or scheme has not been loaded yet. Deterministic: the same code, language
 * and scheme always give the same runs. Plain text needs no grammar and is
 * one uncoloured run per line.
 */
export function highlightCode(code: string, language: string, scheme: string): HighlightedCode | null {
  const lang = normalizeCodeLanguage(language);
  const theme = normalizeCodeScheme(scheme);
  const lines = codeLines(code);
  if (lang === 'plaintext' || (highlighter && loadedThemes.has(theme) && !GRAMMAR_NAMES[lang])) {
    return { lines: lines.map((line) => (line ? [{ content: line }] : [])) };
  }
  if (!codeAssetsReady(lang, theme) || !highlighter) return null;
  const key = `${lang}|${theme}|${code}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result = highlighter.codeToTokens(lines.join('\n'), {
    lang: GRAMMAR_NAMES[lang],
    theme: themeName(theme),
  });
  const fg = (result.fg ?? '').toLowerCase();
  const highlighted: HighlightedCode = {
    lines: result.tokens.map((line) => line.map((token) => {
      const run: CodeToken = { content: token.content };
      // The scheme's default ink is the block's own colour: leaving it off
      // keeps the markup small and lets a line's dimming be one opacity.
      if (token.color && token.color.toLowerCase() !== fg) run.color = token.color;
      if (token.fontStyle && token.fontStyle > 0) run.fontStyle = token.fontStyle;
      return run;
    })),
  };
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, highlighted);
  return highlighted;
}
