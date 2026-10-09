import { createCssVariablesTheme, createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import python from 'shiki/langs/python.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import c from 'shiki/langs/c.mjs';
import cpp from 'shiki/langs/cpp.mjs';
import rust from 'shiki/langs/rust.mjs';
import glsl from 'shiki/langs/glsl.mjs';
import shellscript from 'shiki/langs/shellscript.mjs';
import json from 'shiki/langs/json.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import latex from 'shiki/langs/latex.mjs';
import html from 'shiki/langs/html.mjs';
import css from 'shiki/langs/css.mjs';
import sql from 'shiki/langs/sql.mjs';
import go from 'shiki/langs/go.mjs';
import java from 'shiki/langs/java.mjs';
import julia from 'shiki/langs/julia.mjs';
import matlab from 'shiki/langs/matlab.mjs';
import githubLight from 'shiki/themes/github-light.mjs';
import githubDark from 'shiki/themes/github-dark.mjs';
import oneDarkPro from 'shiki/themes/one-dark-pro.mjs';
import solarizedLight from 'shiki/themes/solarized-light.mjs';
import dracula from 'shiki/themes/dracula.mjs';
import nord from 'shiki/themes/nord.mjs';
import type { StandaloneCodeAssets } from './codeAssetsStandalone.js';

/**
 * `code-highlight.js`, the highlighting half of an exported deck.
 *
 * Every grammar and scheme the app ships, in one classic script that hands
 * them to the player through a global (codeAssetsStandalone.ts). Kept out of
 * player.js so an export without code blocks stays the size it was; the
 * export copies it only when a slide has code.
 */
const assets: StandaloneCodeAssets = {
  runtime: { createHighlighterCoreSync, createCssVariablesTheme, createJavaScriptRegexEngine },
  grammars: {
    python, javascript, typescript, c, cpp, rust, glsl, shellscript, json, yaml,
    latex, html, css, sql, go, java, julia, matlab,
  },
  themes: {
    'github-light': githubLight,
    'github-dark': githubDark,
    'one-dark-pro': oneDarkPro,
    'solarized-light': solarizedLight,
    dracula,
    nord,
  },
};
(globalThis as { __DECKWERK_CODE__?: StandaloneCodeAssets }).__DECKWERK_CODE__ = assets;
