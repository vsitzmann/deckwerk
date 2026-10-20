import type { CodeEl, Slide, ThemeStyle, TimelineEntry } from './deck.js';

/**
 * Code blocks: the vocabulary (languages, colour schemes), the line-build
 * grammar, the Deck scheme's colours and the block's natural size.
 *
 * DOM-free and Shiki-free on purpose. The editor, the player, the HTML
 * compile (which also runs in Node, beside a closed deck) and the agent CLI
 * all need these answers, and none of them should pay for a grammar to get
 * them. The highlighting itself is shared/codeHighlight.ts.
 */

export interface CodeLanguage {
  id: string;
  label: string;
  /** Other spellings an author writes: file extensions, `language-…` classes. */
  aliases: string[];
}

/**
 * Every language a code block can be set to, in the order the inspector
 * offers them. `cuda` has no grammar of its own in Shiki and is highlighted
 * with C++, which covers its syntax (`__global__` and `<<<…>>>` read as
 * plain identifiers and operators); it stays its own id so the block still
 * says what it is.
 */
export const CODE_LANGUAGES: CodeLanguage[] = [
  { id: 'python', label: 'Python', aliases: ['py', 'python3', 'py3'] },
  { id: 'javascript', label: 'JavaScript', aliases: ['js', 'mjs', 'cjs', 'jsx', 'node'] },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts', 'mts', 'cts', 'tsx'] },
  { id: 'c', label: 'C', aliases: ['h'] },
  { id: 'cpp', label: 'C++', aliases: ['c++', 'cc', 'cxx', 'hpp', 'hh', 'hxx'] },
  { id: 'cuda', label: 'CUDA', aliases: ['cu', 'cuh'] },
  { id: 'rust', label: 'Rust', aliases: ['rs'] },
  { id: 'glsl', label: 'GLSL', aliases: ['frag', 'vert', 'shader', 'hlsl'] },
  { id: 'bash', label: 'Bash / shell', aliases: ['sh', 'shell', 'shellscript', 'zsh', 'console'] },
  { id: 'json', label: 'JSON', aliases: ['jsonc', 'json5'] },
  { id: 'yaml', label: 'YAML', aliases: ['yml'] },
  { id: 'latex', label: 'LaTeX', aliases: ['tex'] },
  { id: 'html', label: 'HTML', aliases: ['htm', 'xhtml', 'xml', 'svg'] },
  { id: 'css', label: 'CSS', aliases: [] },
  { id: 'sql', label: 'SQL', aliases: [] },
  { id: 'go', label: 'Go', aliases: ['golang'] },
  { id: 'java', label: 'Java', aliases: [] },
  { id: 'julia', label: 'Julia', aliases: ['jl'] },
  { id: 'matlab', label: 'MATLAB', aliases: ['m', 'octave'] },
  { id: 'plaintext', label: 'Plain text', aliases: ['text', 'txt', 'plain', 'none', ''] },
];

const LANGUAGE_BY_NAME = new Map<string, string>();
for (const language of CODE_LANGUAGES) {
  LANGUAGE_BY_NAME.set(language.id, language.id);
  for (const alias of language.aliases) LANGUAGE_BY_NAME.set(alias, language.id);
}

/**
 * The language id an author meant: `py`, `language-python` and `Python` are
 * all `python`. Anything unrecognised is plain text rather than an error — a
 * page must not fail to compile over a fence label.
 */
export function normalizeCodeLanguage(raw: string | null | undefined): string {
  const name = (raw ?? '').trim().toLowerCase().replace(/^(?:language|lang)-/, '');
  return LANGUAGE_BY_NAME.get(name) ?? 'plaintext';
}

export interface CodeScheme {
  id: string;
  label: string;
  /**
   * The scheme's own text and ground. Known without loading the theme, so a
   * block drawn before its colours arrive already has the right box and
   * reads in the right ink; the tests check them against Shiki's themes.
   * The Deck scheme's are derived instead (`deckCodeColors`).
   */
  fg: string;
  bg: string;
  dark: boolean;
}

/** The colour schemes on offer. `deck` is derived from the deck's theme colours. */
export const CODE_SCHEMES: CodeScheme[] = [
  { id: 'github-light', label: 'GitHub Light', fg: '#24292e', bg: '#fff', dark: false },
  { id: 'github-dark', label: 'GitHub Dark', fg: '#e1e4e8', bg: '#24292e', dark: true },
  { id: 'one-dark-pro', label: 'One Dark Pro', fg: '#abb2bf', bg: '#282c34', dark: true },
  { id: 'solarized-light', label: 'Solarized Light', fg: '#657b83', bg: '#fdf6e3', dark: false },
  { id: 'dracula', label: 'Dracula', fg: '#f8f8f2', bg: '#282a36', dark: true },
  { id: 'nord', label: 'Nord', fg: '#d8dee9', bg: '#2e3440', dark: true },
  { id: 'deck', label: 'Deck', fg: '', bg: '', dark: false },
];

export const DEFAULT_CODE_SCHEME = 'github-dark';
export const DEFAULT_CODE_FONT_SIZE = 28;

/** The scheme id an author meant, or the default for anything unknown. */
export function normalizeCodeScheme(raw: string | null | undefined): string {
  const name = (raw ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  const aliases: Record<string, string> = { 'one-dark': 'one-dark-pro', onedark: 'one-dark-pro', theme: 'deck' };
  const id = aliases[name] ?? name;
  return CODE_SCHEMES.some((scheme) => scheme.id === id) ? id : DEFAULT_CODE_SCHEME;
}

/* --- geometry --------------------------------------------------------------- */

/**
 * Typography every surface lays a block out with: the renderer, the authoring
 * page's stylesheet (`CODE_AUTHORING_CSS`) and the natural-size estimate all
 * read these, so a block an agent measured in a browser is the height the
 * player then draws.
 */
export const CODE_FONT_FAMILY = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace';
export const CODE_LINE_HEIGHT = 1.5;
/** Padding in em: vertical, horizontal. */
export const CODE_PADDING_EM = [0.75, 1] as const;
export const CODE_TAB_SIZE = 4;

/**
 * The lines a block shows. A trailing newline — what a paste from an editor
 * nearly always ends with — does not make an empty last line: it would read
 * as a stray gap under the code, and as a line a build could name.
 */
export function codeLines(code: string): string[] {
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The height the block needs for all its lines, in canvas pixels. */
export function codeBlockHeight(el: Pick<CodeEl, 'code' | 'fontSize'>): number {
  const lines = codeLines(el.code).length;
  return Math.ceil(el.fontSize * (lines * CODE_LINE_HEIGHT + CODE_PADDING_EM[0] * 2));
}

/**
 * The authoring page's rule for a code block, so a hand-written
 * `<pre data-element="code">` measures as the player will draw it: browser
 * defaults (a 13px monospace, a margin) would otherwise be baked into its box.
 */
export const CODE_AUTHORING_CSS = `
  pre[data-element="code"] {
    margin: 0; box-sizing: border-box; overflow: hidden; white-space: pre;
    font-family: ${CODE_FONT_FAMILY}; font-size: ${DEFAULT_CODE_FONT_SIZE}px;
    line-height: ${CODE_LINE_HEIGHT}; tab-size: ${CODE_TAB_SIZE};
    padding: ${CODE_PADDING_EM[0]}em ${CODE_PADDING_EM[1]}em;
  }
  pre[data-element="code"] > code { font: inherit; }
`;

/* --- line builds ------------------------------------------------------------ */

export type LineStepMode = 'reveal' | 'highlight';

export interface LineStep {
  mode: LineStepMode;
  /** 1-based line numbers, ascending. Empty on a highlight step means "all lines". */
  lines: number[];
}

/**
 * Parse `"1-3,7"` into line numbers. Ranges may run backwards (`5-3`);
 * anything that is not a number or a range is ignored rather than failing a
 * whole build over a typo.
 */
export function parseLineRanges(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(part);
    if (!match) continue;
    const a = Number(match[1]);
    const b = match[2] === undefined ? a : Number(match[2]);
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    // A range is a handful of lines on a slide; refuse a typo's millions.
    for (let n = Math.max(1, lo); n <= Math.min(hi, lo + 10_000); n++) out.add(n);
  }
  return [...out].sort((x, y) => x - y);
}

/** `[1,2,3,7]` → `"1-3,7"`. */
export function formatLineRanges(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return parts.join(',');
}

/**
 * Parse a line-build spec: steps separated by `;`, each a set of line ranges,
 * optionally prefixed with its mode. `"1-3; 4-6; highlight:5; highlight:all"`
 * reveals lines 1-3, then 4-6, then dims everything but line 5, then brings
 * every line back to full strength. No prefix means `reveal`; `show` and
 * `focus` are accepted for `reveal` and `highlight`.
 */
export function parseLineSteps(spec: string | null | undefined): LineStep[] {
  const steps: LineStep[] = [];
  for (const raw of (spec ?? '').split(';')) {
    const text = raw.trim();
    if (!text) continue;
    const match = /^(reveal|show|highlight|focus)\b\s*:?\s*(.*)$/i.exec(text);
    const word = match?.[1].toLowerCase();
    const mode: LineStepMode = word === 'highlight' || word === 'focus' ? 'highlight' : 'reveal';
    const rest = (match ? match[2] : text).trim();
    if (mode === 'highlight' && /^(all|none|\*)?$/i.test(rest)) {
      steps.push({ mode, lines: [] });
      continue;
    }
    const lines = parseLineRanges(rest);
    if (lines.length > 0) steps.push({ mode, lines });
  }
  return steps;
}

/** The canonical spelling of a spec, as an export writes it. */
export function formatLineSteps(steps: LineStep[]): string {
  return steps.map((step) => {
    if (step.mode === 'reveal') return formatLineRanges(step.lines);
    return `highlight:${step.lines.length > 0 ? formatLineRanges(step.lines) : 'all'}`;
  }).join('; ');
}

/** A spec rewritten canonically, or null when it names no step at all. */
export function normalizeLineSteps(spec: string | null | undefined): string | null {
  const steps = parseLineSteps(spec);
  return steps.length > 0 ? formatLineSteps(steps) : null;
}

/** A line build is a `lines` entry on a code element. */
export function isLineBuild(entry: TimelineEntry, slide: Slide): boolean {
  return entry.action.type === 'lines'
    && slide.elements.some((el) => el.id === entry.action.target && el.type === 'code');
}

/** How many steps a line build fans out into (at least one, like a paragraph build). */
export function lineStepCount(entry: TimelineEntry): number {
  return Math.max(1, parseLineSteps(typeof entry.action.value === 'string' ? entry.action.value : '').length);
}

export interface CodeLineState {
  /** Lines not yet revealed. */
  hidden: Set<number>;
  /** Lines in focus while a highlight step holds; null when nothing is dimmed. */
  focus: Set<number> | null;
}

/**
 * Which lines are hidden and which are in focus once `applied` steps of a
 * build have run.
 *
 * Lines a reveal step names start hidden; lines no reveal step names are on
 * screen from the start, so a function's signature can stay put while its
 * body builds in. A highlight dims every other line until the next step: a
 * later highlight moves the focus, a reveal (or `highlight:all`) ends it, so
 * newly revealed lines are never born dimmed. Highlighting a line that is
 * still hidden shows it.
 */
export function codeLineState(steps: LineStep[], applied: number): CodeLineState {
  const hidden = new Set<number>();
  for (const step of steps) if (step.mode === 'reveal') for (const line of step.lines) hidden.add(line);
  let focus: Set<number> | null = null;
  for (const step of steps.slice(0, Math.max(0, applied))) {
    for (const line of step.lines) hidden.delete(line);
    focus = step.mode === 'highlight' && step.lines.length > 0 ? new Set(step.lines) : null;
  }
  return { hidden, focus };
}

/** One step described for a list row: "show 1–3", "highlight 5", "all lines". */
export function describeLineStep(step: LineStep): string {
  const ranges = formatLineRanges(step.lines).replace(/-/g, '–').replace(/,/g, ', ');
  if (step.mode === 'reveal') return `show ${ranges}`;
  return step.lines.length > 0 ? `highlight ${ranges}` : 'all lines';
}

/* --- the Deck scheme -------------------------------------------------------- */

/**
 * The roles Shiki's CSS-variables theme paints with. The Deck scheme is that
 * theme with each role pointed at a deck colour, set as custom properties
 * (`--deckwerk-code-<role>`), so changing the deck's theme recolours every
 * Deck-scheme block at once without re-highlighting anything.
 */
export const DECK_CODE_ROLES = [
  'foreground', 'background', 'token-comment', 'token-keyword', 'token-string',
  'token-string-expression', 'token-constant', 'token-function', 'token-parameter',
  'token-punctuation', 'token-link',
] as const;
export type DeckCodeRole = typeof DECK_CODE_ROLES[number];
export const DECK_CODE_VARIABLE_PREFIX = '--deckwerk-code-';

type Rgb = [number, number, number];

function parseHex(color: string): Rgb | null {
  const hex = color.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.test(hex) || hex.length === 4) return null;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

function parseColor(color: string): Rgb | null {
  const hex = parseHex(color);
  if (hex) return hex;
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(color.trim());
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

function mix(a: Rgb, b: Rgb, amountOfB: number): Rgb {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * amountOfB) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: string, b: string): number {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return 1;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * The Deck scheme's colour for every role, from the deck's theme.
 *
 * Text is the theme's text and comments its muted colour; keywords take the
 * accent, because that is the colour the deck already uses to say "look
 * here". Strings, constants and function names take the next palette
 * colours that are legible on the block's ground (contrast at least 2.6:1) and
 * are not already one of those four, in palette order; a palette that runs
 * out falls back to blends of the accent with the text, so a two-colour
 * theme still gets distinct, on-brand roles. The ground is the slide's
 * background nudged a few percent toward the text, so the block reads as a
 * panel on the slide rather than a hole in it.
 */
export function deckCodeColors(style: Pick<ThemeStyle, 'colors' | 'palette'>): Record<DeckCodeRole, string> {
  const fallback: Rgb = [17, 17, 17];
  const background = parseColor(style.colors.background) ?? [255, 255, 255];
  const text = parseColor(style.colors.text) ?? fallback;
  const muted = parseColor(style.colors.muted) ?? mix(text, background, 0.45);
  const accent = parseColor(style.colors.accent) ?? text;
  const ground = mix(background, text, luminance(background) > 0.5 ? 0.05 : 0.08);
  const groundHex = toHex(ground);
  const taken = [background, text, muted, accent, ground];
  const picks: Rgb[] = [];
  for (const entry of style.palette) {
    const color = parseColor(entry);
    if (!color) continue;
    if (taken.some((other) => distance(other, color) < 20)) continue;
    // Code is set large on a slide; large-text legibility is enough.
    if (contrastRatio(toHex(color), groundHex) < 2.6) continue;
    picks.push(color);
    taken.push(color);
  }
  const blends = [mix(accent, text, 0.45), mix(accent, text, 0.7), mix(accent, muted, 0.5)];
  while (picks.length < 3) picks.push(blends[picks.length]);
  const [string, constant, fn] = picks;
  return {
    foreground: toHex(text),
    background: groundHex,
    'token-comment': toHex(muted),
    'token-keyword': toHex(accent),
    'token-string': toHex(string),
    'token-string-expression': toHex(string),
    'token-constant': toHex(constant),
    'token-function': toHex(fn),
    'token-parameter': toHex(text),
    'token-punctuation': toHex(text),
    'token-link': toHex(accent),
  };
}

/** The custom-property declarations that put a deck's colours into the Deck scheme. */
export function deckCodeCss(style: Pick<ThemeStyle, 'colors' | 'palette'>): string {
  const colors = deckCodeColors(style);
  return DECK_CODE_ROLES.map((role) => `${DECK_CODE_VARIABLE_PREFIX}${role}: ${colors[role]};`).join(' ');
}

/** The Deck scheme's colours before a deck has set its own: the stock stylesheet's. */
export const DEFAULT_DECK_CODE_COLORS = deckCodeColors({
  colors: { background: '#ffffff', text: '#111111', muted: '#666666', accent: '#2463eb' },
  palette: [],
});

/** The block's ground and ink for a scheme, known before its theme loads. */
export function codeSchemeColors(scheme: string): { fg: string; bg: string } {
  const id = normalizeCodeScheme(scheme);
  if (id === 'deck') {
    return {
      fg: `var(${DECK_CODE_VARIABLE_PREFIX}foreground, ${DEFAULT_DECK_CODE_COLORS.foreground})`,
      bg: `var(${DECK_CODE_VARIABLE_PREFIX}background, ${DEFAULT_DECK_CODE_COLORS.background})`,
    };
  }
  const found = CODE_SCHEMES.find((candidate) => candidate.id === id)!;
  return { fg: found.fg, bg: found.bg };
}
