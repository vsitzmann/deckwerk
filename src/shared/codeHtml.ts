import type { CodeEl, TimelineEntry } from './deck.js';
import type { MeasuredNode } from './htmlSlides.js';
import {
  DEFAULT_CODE_FONT_SIZE,
  normalizeCodeLanguage,
  normalizeCodeScheme,
  codeSchemeColors,
  normalizeLineSteps,
} from './codeBlocks.js';

/**
 * A code block in the HTML authoring format, both ways.
 *
 * The markup is what anyone writes for code on the web:
 *
 *   <pre data-element="code" data-language="python" data-scheme="github-dark"
 *        data-font-size="28" data-line-numbers="true" data-build-lines="1-3; highlight:5"
 *        style="…"><code class="language-python">def f(x):
 *       return x &lt; 3</code></pre>
 *
 * and a bare `<pre><code class="language-python">` is a code block too (the
 * measuring walk marks it). The code is the `<code>`'s text, entity-decoded,
 * byte for byte: tabs, runs of spaces and blank lines are content. The one
 * exception is a newline straight after `<code>`, which is formatting — the
 * allowance HTML itself makes after `<pre>` — so a listing can start on its
 * own line in the source; the measuring walk drops it before it measures
 * (htmlMeasure.ts), or the box would be a line too tall. An export writes an
 * extra newline when the code itself begins with one, so the round trip is
 * exact. A newline before `</code>` is kept: it is the file's last newline,
 * which a block never draws as a line of its own.
 */

/**
 * CSS a code block's typed fields own. A measured page reports these (an
 * independent page's computed style, an export's own inline paint), but on
 * the deck object they would fight the scheme and the size: the scheme
 * paints the ground and the ink, `fontSize` sizes the type, and the renderer
 * sets the rest.
 */
const CODE_OWNED_STYLE = new Set([
  'color', 'background', 'background-color', 'background-image', 'font-size', 'font-family',
  'font-weight', 'font-style', 'font-variant', 'line-height', 'letter-spacing', 'text-transform',
  'text-decoration', 'white-space', 'word-break', 'overflow-wrap', 'overflow', 'tab-size',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'text-align',
]);

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (match, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[lower] ?? match;
  });
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

/**
 * The code a `<pre>`'s inner markup holds: its text, with tags dropped and
 * entities decoded. A `<br>` (a rich-text paste) is a newline.
 */
export function codeFromMarkup(html: string): string {
  const code = /^\s*<code\b[^>]*>([\s\S]*)<\/code>\s*$/i.exec(html);
  const inner = code ? code[1] : html;
  return decodeEntities(inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
}

/** The deck object a measured code block becomes. */
export function codeElementFromNode(
  node: MeasuredNode,
  base: Omit<CodeEl, 'type' | 'code' | 'language' | 'scheme' | 'fontSize' | 'lineNumbers'>,
): CodeEl {
  const style = Object.fromEntries(Object.entries(base.style).filter(([property]) => !CODE_OWNED_STYLE.has(property)));
  const classLanguage = /(?:^|\s)lang(?:uage)?-([\w+#-]+)/.exec(/<code\b[^>]*class="([^"]*)"/i.exec(node.html)?.[1] ?? '')?.[1];
  const sized = Number.parseFloat(node.dataset.fontSize ?? '');
  const styled = /^([\d.]+)px$/.exec(base.style['font-size'] ?? '')?.[1];
  const fontSize = sized > 0 ? sized : Number(styled) > 0 ? Number(styled) : DEFAULT_CODE_FONT_SIZE;
  return {
    ...base,
    style,
    type: 'code',
    code: codeFromMarkup(node.html),
    language: normalizeCodeLanguage(node.dataset.language ?? classLanguage),
    scheme: normalizeCodeScheme(node.dataset.scheme),
    fontSize: Math.round(fontSize * 100) / 100,
    lineNumbers: node.dataset.lineNumbers === 'true',
  };
}

/**
 * `data-build-lines="1-3; highlight:5"` as a line build, stepped by clicks.
 * A page states the steps; the trigger and the build's place among the
 * slide's other builds stay as the deck has them (`carrySlideState`).
 */
export function lineBuildFromNode(node: MeasuredNode, elementId: string, index: number): TimelineEntry | null {
  const spec = normalizeLineSteps(node.dataset.buildLines);
  if (!spec) return null;
  return {
    id: `${elementId}-lines-${index + 1}`,
    trigger: { on: 'click', ref: null, delay: 0 },
    action: { type: 'lines', target: elementId, value: spec },
  };
}

/**
 * The block as an exported page writes it. `attrs` and the geometry come
 * from the shared element writer; the ground, ink and type are written
 * inline too, so the page opened in a browser shows the block's box in its
 * scheme (uncoloured: highlighting happens where the deck renders).
 */
export function codeElementToHtml(
  element: CodeEl,
  attrs: string,
  styleAttr: (...declarations: string[]) => string,
  position: string,
  inline: string,
  lineBuild?: TimelineEntry,
): string {
  const language = normalizeCodeLanguage(element.language);
  const colors = codeSchemeColors(element.scheme);
  const spec = lineBuild ? normalizeLineSteps(String(lineBuild.action.value ?? '')) : null;
  const code = (element.code.startsWith('\n') ? '\n' : '') + escapeText(element.code);
  return `  <pre ${attrs} data-element="code" data-language="${escapeAttr(element.language)}"`
    + ` data-scheme="${escapeAttr(element.scheme)}" data-font-size="${element.fontSize}"`
    + (element.lineNumbers ? ' data-line-numbers="true"' : '')
    + (spec ? ` data-build-lines="${escapeAttr(spec)}"` : '')
    + ` ${styleAttr(position, inline, `font-size:${element.fontSize}px; background:${colors.bg}; color:${colors.fg};`)}>`
    + `<code class="language-${language}">${code}</code></pre>`;
}
