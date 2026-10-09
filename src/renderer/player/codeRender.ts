import type { CodeEl, Deck, Slide } from '@shared/deck.js';
import { effectiveThemeStyle } from '@shared/themes.js';
import {
  CODE_FONT_FAMILY,
  CODE_LINE_HEIGHT,
  CODE_PADDING_EM,
  CODE_TAB_SIZE,
  codeLineState,
  codeSchemeColors,
  codeLines,
  deckCodeCss,
  normalizeCodeLanguage,
  normalizeCodeScheme,
  parseLineSteps,
} from '@shared/codeBlocks.js';
import { highlightCode, loadCodeAssets, type CodeToken } from '@shared/codeHighlight.js';
import type { SlideState } from '@shared/timeline.js';

/**
 * A code element as DOM, shared by every surface that draws slides — the
 * editor canvas, the rail, the player, the web export and PDF pages — for the
 * same reason as the rest of render.ts: one builder cannot drift.
 *
 * The block is a box in its scheme's ground with one `.code-line` per line,
 * each holding an optional gutter number and the line's coloured runs. Lines
 * are separate blocks so a line build can hide or dim them one at a time
 * without the code reflowing. When the grammar or scheme is still loading the
 * lines are drawn plainly in the scheme's ink, and recoloured in place the
 * moment it arrives (`upgradePending`), keeping whatever build state the
 * lines already carry.
 */

/** Dimmed lines' strength while a highlight holds. */
export const CODE_DIM_OPACITY = 0.3;

/** The element each rendered code body draws, for recolouring it once its grammar lands. */
const drawn = new WeakMap<HTMLElement, CodeEl>();
/** Bodies drawn plain and waiting for their grammar and scheme. */
const pendingBodies = new Set<HTMLElement>();
/** Settles once a body is highlighted (or its load failed and it stays plain). */
const settled = new WeakMap<HTMLElement, Promise<void>>();

export function renderCodeBody(el: CodeEl): HTMLElement {
  const body = document.createElement('div');
  body.className = 'code-body';
  const colors = codeSchemeColors(el.scheme);
  const s = body.style;
  s.width = '100%';
  s.height = '100%';
  s.boxSizing = 'border-box';
  s.overflow = 'hidden';
  // Corners follow the element's own radius (its style lives on the wrapper).
  s.borderRadius = 'inherit';
  s.background = colors.bg;
  s.color = colors.fg;
  s.fontFamily = el.style['font-family'] ?? CODE_FONT_FAMILY;
  s.fontSize = `${el.fontSize}px`;
  s.lineHeight = String(CODE_LINE_HEIGHT);
  s.padding = `${CODE_PADDING_EM[0]}em ${CODE_PADDING_EM[1]}em`;
  s.textAlign = 'left';
  s.setProperty('tab-size', String(CODE_TAB_SIZE));
  s.fontWeight = 'normal';
  s.fontStyle = 'normal';
  s.letterSpacing = 'normal';
  s.textTransform = 'none';
  body.dataset.language = normalizeCodeLanguage(el.language);
  body.dataset.scheme = normalizeCodeScheme(el.scheme);
  drawn.set(body, el);
  fillLines(body, el);
  return body;
}

function fillLines(body: HTMLElement, el: CodeEl): void {
  const highlighted = highlightCode(el.code, el.language, el.scheme);
  const lines = highlighted?.lines ?? codeLines(el.code).map((line) => (line ? [{ content: line }] : []));
  const digits = String(lines.length).length;
  const existing = [...body.querySelectorAll<HTMLElement>(':scope > .code-line')];
  const rebuilt = lines.map((runs, index) => {
    // Reusing the line nodes keeps a build's hidden and dimmed state across
    // a recolour; only their contents are redrawn.
    const line = existing[index] ?? document.createElement('div');
    line.className = 'code-line';
    line.dataset.line = String(index + 1);
    line.style.whiteSpace = 'pre';
    // An empty line still takes a line's height.
    line.style.minHeight = `${CODE_LINE_HEIGHT}em`;
    line.replaceChildren();
    if (el.lineNumbers) {
      const gutter = document.createElement('span');
      gutter.className = 'code-gutter';
      gutter.setAttribute('aria-hidden', 'true');
      gutter.textContent = String(index + 1);
      gutter.style.display = 'inline-block';
      gutter.style.minWidth = `${digits}ch`;
      gutter.style.textAlign = 'right';
      gutter.style.marginRight = '1.5ch';
      gutter.style.opacity = '0.45';
      gutter.style.userSelect = 'none';
      line.appendChild(gutter);
    }
    for (const run of runs) line.appendChild(runNode(run));
    return line;
  });
  for (const stale of existing.slice(lines.length)) stale.remove();
  for (const line of rebuilt) if (!line.isConnected || line.parentElement !== body) body.appendChild(line);
  body.dataset.highlight = highlighted ? 'done' : 'pending';
  if (highlighted) {
    pendingBodies.delete(body);
    if (!settled.has(body)) settled.set(body, Promise.resolve());
    return;
  }
  pendingBodies.add(body);
  settled.set(body, loadCodeAssets(el.language, el.scheme).then(() => {
    upgradePending();
    // A load that failed leaves the block plain; it is as ready as it gets.
    if (pendingBodies.delete(body)) body.dataset.highlight = 'plain';
  }));
}

function runNode(run: CodeToken): Node {
  if (!run.color && !run.fontStyle) return document.createTextNode(run.content);
  const span = document.createElement('span');
  span.textContent = run.content;
  if (run.color) span.style.color = run.color;
  if (run.fontStyle) {
    if (run.fontStyle & 1) span.style.fontStyle = 'italic';
    if (run.fontStyle & 2) span.style.fontWeight = 'bold';
    if (run.fontStyle & 4) span.style.textDecoration = 'underline';
  }
  return span;
}

/** Recolour every body still drawn plain whose grammar and scheme have now loaded. */
function upgradePending(): void {
  for (const body of [...pendingBodies]) {
    const el = drawn.get(body);
    if (!el) {
      pendingBodies.delete(body);
      continue;
    }
    if (highlightCode(el.code, el.language, el.scheme)) fillLines(body, el);
  }
}

/**
 * Resolves once a rendered `.code-body` shows its colours (or has settled
 * for plain text because its grammar could not load). PDF readiness waits on
 * this so a page is never captured mid-highlight.
 */
export function whenCodeHighlighted(body: Element): Promise<void> {
  return settled.get(body as HTMLElement) ?? Promise.resolve();
}

/**
 * Bring an already-rendered code element up to date in place, for the
 * editor's patch path: a moved or resized block keeps its DOM, and only a
 * change to what it draws rebuilds the body.
 */
export function syncCodeBody(node: HTMLElement, el: CodeEl): void {
  const body = node.querySelector<HTMLElement>(':scope > .code-body');
  const before = body ? drawn.get(body) : undefined;
  if (body && before
    && before.code === el.code && before.language === el.language && before.scheme === el.scheme
    && before.fontSize === el.fontSize && before.lineNumbers === el.lineNumbers
    && before.style['font-family'] === el.style['font-family']) return;
  const next = renderCodeBody(el);
  if (body) {
    pendingBodies.delete(body);
    body.replaceWith(next);
  } else node.appendChild(next);
}

/**
 * Show each code block's lines as its line build leaves them at this state:
 * revealed-later lines hidden (visibility, so nothing reflows), and other
 * lines dimmed while a highlight holds. Called from `applyStaticSlideState`,
 * so the player, presenter preview and PDF pages agree.
 */
export function applyCodeLineState(stage: ParentNode, slide: Slide, state: SlideState): void {
  for (const element of slide.elements) {
    if (element.type !== 'code') continue;
    const escaped = typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(element.id)
      : element.id.replace(/[\\"]/g, '\\$&');
    const body = stage.querySelector<HTMLElement>(`[data-element-id="${escaped}"] > .code-body`);
    if (!body) continue;
    const build = state.lines?.get(element.id);
    const { hidden, focus } = build
      ? codeLineState(parseLineSteps(build.spec), build.applied)
      : { hidden: new Set<number>(), focus: null };
    for (const line of body.querySelectorAll<HTMLElement>(':scope > .code-line')) {
      const n = Number(line.dataset.line);
      const isHidden = hidden.has(n);
      // Only opacity animates, so a revealed line fades in and a dimmed one
      // fades down while presenting; a freshly built page (PDF) has no
      // previous style to transition from and lands on the end state.
      line.style.transition = 'opacity 250ms ease';
      line.style.visibility = isHidden ? 'hidden' : '';
      line.style.opacity = isHidden ? '0' : focus && !focus.has(n) ? String(CODE_DIM_OPACITY) : '';
      if (focus?.has(n)) line.dataset.focus = 'true';
      else delete line.dataset.focus;
    }
  }
}

let deckCss = '';

/**
 * Point the Deck scheme at a deck's colours and start loading the grammars
 * and schemes its code blocks use.
 *
 * The colours are custom properties on the document root, which every slide
 * drawn in this document inherits — so a theme change recolours every Deck
 * block, on the canvas, in the rail and in the player, without rebuilding
 * any of them. Loading ahead means the first slide with code is already
 * coloured when it appears, rather than recolouring as it is shown.
 */
export function prepareCodeBlocks(deck: Deck): void {
  if (typeof document === 'undefined') return;
  // The deck's composed defaults, or the preset (or stock stylesheet) they
  // would be: the same answer on every surface, so a block matches its slides.
  const css = deckCodeCss(effectiveThemeStyle(deck));
  if (css !== deckCss) {
    deckCss = css;
    const root = document.documentElement.style;
    for (const declaration of css.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) root.setProperty(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
  }
  for (const slide of deck.slides) {
    for (const element of slide.elements) {
      if (element.type === 'code') void loadCodeAssets(element.language, element.scheme);
    }
  }
}
