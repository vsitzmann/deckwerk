import type { LanguageRegistration, ThemeRegistrationAny } from 'shiki/core';
import type { createCssVariablesTheme, createHighlighterCoreSync } from 'shiki/core';
import type { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * Where Shiki's pieces come from: one dynamic import per grammar and per
 * theme, written out so the bundler splits exactly these into chunks and an
 * app page fetches only what its deck uses.
 *
 * The exported standalone player cannot do that — it is one classic script
 * opened from `file://`, where module imports are refused — so its build
 * swaps this module for player/../export/codeAssetsStandalone.ts, which
 * reads the same pieces from a single `code-highlight.js` the export copies
 * beside it only when the deck has code. The two modules export the same
 * names; codeHighlight.ts never knows which one it got.
 */

export interface ShikiRuntime {
  createHighlighterCoreSync: typeof createHighlighterCoreSync;
  createCssVariablesTheme: typeof createCssVariablesTheme;
  createJavaScriptRegexEngine: typeof createJavaScriptRegexEngine;
}

type GrammarModule = { default: LanguageRegistration[] };
type ThemeModule = { default: ThemeRegistrationAny };

const GRAMMAR_IMPORTS: Record<string, () => Promise<GrammarModule>> = {
  python: () => import('shiki/langs/python.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  glsl: () => import('shiki/langs/glsl.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  latex: () => import('shiki/langs/latex.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  julia: () => import('shiki/langs/julia.mjs'),
  matlab: () => import('shiki/langs/matlab.mjs'),
};

const THEME_IMPORTS: Record<string, () => Promise<ThemeModule>> = {
  'github-light': () => import('shiki/themes/github-light.mjs'),
  'github-dark': () => import('shiki/themes/github-dark.mjs'),
  'one-dark-pro': () => import('shiki/themes/one-dark-pro.mjs'),
  'solarized-light': () => import('shiki/themes/solarized-light.mjs'),
  dracula: () => import('shiki/themes/dracula.mjs'),
  nord: () => import('shiki/themes/nord.mjs'),
};

export async function loadShikiRuntime(): Promise<ShikiRuntime> {
  const [core, engine] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')]);
  return {
    createHighlighterCoreSync: core.createHighlighterCoreSync,
    createCssVariablesTheme: core.createCssVariablesTheme,
    createJavaScriptRegexEngine: engine.createJavaScriptRegexEngine,
  };
}

/** A grammar by Shiki's name for it (with the grammars it embeds), or null if none ships. */
export async function loadGrammar(name: string): Promise<LanguageRegistration[] | null> {
  const load = GRAMMAR_IMPORTS[name];
  return load ? (await load()).default : null;
}

/** A colour scheme's Shiki theme by id, or null if none ships. */
export async function loadTheme(id: string): Promise<ThemeRegistrationAny | null> {
  const load = THEME_IMPORTS[id];
  return load ? (await load()).default : null;
}
