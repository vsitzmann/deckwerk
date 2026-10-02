import type { AgentOperation } from './agent.js';
import { MediaEffectSchema, MIRRORED_TEXT_STYLE_PROPERTIES } from './deck.js';
import type { Deck, MediaEffect, Slide, SlideElement, TimelineEntry } from './deck.js';
import { fitAutoTextElement } from './autoFit.js';
import { KATEX_AUTO_RENDER_JS, KATEX_CSS, KATEX_JS } from './katexInline.js';
import { shapeSvg } from './shapeSvg.js';
import { applyTableColumnWidths } from './paragraphs.js';
import { layoutMaster, syncSlideWithLayoutMaster, type FixedLayout } from './layoutMasters.js';
import {
  cssMediaBorder,
  cssMediaRadius,
  cssNoWrap,
  cssVisualEffects,
  isMediaBorderPaint,
  typedPropertyOwnsCss,
} from './nativeCss.js';

/**
 * HTML as the authoring surface for slides.
 *
 * Absolute pixel geometry is the one thing a model is genuinely bad at: it has
 * written a great deal of flexbox and almost no bounding-box arithmetic. So
 * rather than asking for coordinates, we take HTML and CSS, let a real browser
 * lay it out, and bake the geometry it computed into ordinary deck objects.
 * What comes out is not a blob — it is the same draggable, snappable,
 * Morph-pairable objects you get by placing them by hand.
 *
 * This module is the pure half: the browser reports what it measured
 * (`MeasuredNode`), and everything here maps those facts onto the deck format
 * with no DOM involved, so the mapping is testable without an Electron.
 */

export interface MeasuredNode {
  /** Lowercase tag name, e.g. "h1", "img", "video", "svg". */
  tag: string;
  /** `data-element-id`, when the author kept one from a previous export. */
  elementId: string | null;
  classes: string[];
  dataset: Record<string, string>;
  /** Border box relative to the slide's top-left, in canvas pixels. */
  rect: { x: number; y: number; w: number; h: number };
  /** Clockwise degrees from the computed transform. */
  rotation: number;
  opacity: number;
  /** The node's inline declarations, as authored. Filtered on the way to an element. */
  style: Record<string, string>;
  /** innerHTML for text, outerHTML for anything preserved verbatim. */
  html: string;
  attrs: {
    src?: string;
    alt?: string;
    poster?: string;
    objectFit?: string;
    objectPosition?: string;
    textAlign?: string;
    loop?: boolean;
    muted?: boolean;
    autoplay?: boolean;
    controls?: boolean;
  };
  /** Set by the walker when a node must be preserved as raw markup. */
  verbatim?: boolean;
  /** Captured author CSS for an isolated fallback region. */
  css?: string;
  fallbackReason?: string;
}

export interface MeasuredSlide {
  id: string | null;
  name: string;
  notes: string;
  background: { color: string | null; image: string | null };
  morphFromPrevious: boolean;
  morphDuration?: number;
  /** `data-layout` on the section: one of the deck's fixed layouts. */
  layout?: string;
  /** With `layout`: the section set its own background inline. */
  ownBackground?: boolean;
  nodes: MeasuredNode[];
  /**
   * Inline style the browser silently refused: a segment with no colon, or a
   * declaration the CSS parser dropped (an unterminated quote earlier in the
   * attribute swallows everything after it). Optional so measured JSON from
   * older compilers still loads.
   */
  warnings?: string[];
}

const SCOPE_MARKER = 'slide-editor-scope:';
export const HTML_CHANGE_LABEL_META = 'deckwerk-change-label';

/** A section an author fills in — no id, so it can only ever become a new slide. */
const BLANK_SECTION = `<section class="slide" data-placeholder="true">
  <h1 class="role-title">Title</h1>
</section>`;

/**
 * A starter section nobody has touched yet. `slide-agent new > edit/add.html`
 * lands in the watched folder *before* the author edits it, and the editor
 * used to compile that save at once — four placeholder slides titled "Title"
 * in the deck, stamped with ids the author's first real save then did not
 * carry, so the real slides arrived as four more. An untouched placeholder is
 * not a slide yet; it becomes one the moment its content changes (the
 * attribute may stay — only the pristine markup is skipped).
 */
export function isPristinePlaceholder(root: Element): boolean {
  if ((root as HTMLElement).dataset?.placeholder !== 'true') return false;
  if (root.hasAttribute('data-slide-id')) return false;
  const children = [...root.children];
  return children.length === 1
    && children[0].tagName.toLowerCase() === 'h1'
    && (children[0].textContent ?? '').trim() === 'Title';
}

/**
 * The counterpart to SCOPE_RULES, for a page that governs nothing yet.
 *
 * There is deliberately no scope marker here: a file that never names an
 * existing slide cannot replace or delete one, so the destructive half of the
 * loop is simply unreachable from this page until it has been saved once.
 */
const BLANK_RULES = `<!--
  A blank authoring page. It governs no existing slide, so saving it can only
  ADD slides — every section with class "slide" below is a new one, appended
  to the deck in this order.

  Add, remove and edit sections freely; open this file in a browser to see
  exactly what the deck will get. After the first save each section is stamped
  with the id it was given, and from then on this file governs those slides:
  editing one replaces it, and removing one deletes it.
-->`;

/**
 * The rules of the file, written into the file.
 *
 * The marker above is opaque and lives in the head, where nothing about it
 * suggests that saving this document can *delete* slides. That gap has a
 * predictable cost: an author who wants to add a slide copies this file to get
 * a working skeleton, the copy inherits the scope, and saving it deletes
 * everything the original exported. Saying so here puts the warning in the one
 * place a copier is guaranteed to be looking.
 */
const SCOPE_RULES = `<!--
  This file governs exactly the slides listed in the marker above, and saving
  it is what changes them:

    * editing inside a section that has a data-slide-id - REPLACES that slide
    * adding a section with class "slide" and no data-slide-id - ADDS a slide
    * removing a section that was exported here - DELETES that slide
    * reordering exported sections - MOVES those slides in the deck

  This section list is the structural editing API. Do not search for delete,
  move or reorder commands or transaction operations; edit this file and save
  it (or apply this same file with slide-agent apply).

  To add slides, do not copy this file: the copy inherits the scope above and
  saving it would delete these slides. Run \`slide-agent new\` for a blank
  authoring page, which appends whatever sections you put in it.
-->`;

export interface HtmlExportOptions {
  /**
   * The player's semantic type rules, inlined so the file needs nothing from
   * the editor's checkout to look right.
   */
  typeCss?: string;
  /** Where the deck folder is from wherever this file is saved. */
  base?: string;
  /** The deck's stylesheet, relative to `base`. */
  theme?: string;
  /**
   * Emit a blank authoring page holding this many starter sections instead of
   * an export: no scope marker and no slide ids, so every section in it is a
   * new slide. This is the file to write when the intent is to *add* slides —
   * it cannot replace or delete one, whatever is done to it.
   */
  blank?: number;
}

/**
 * One editable HTML document for an authoritative range of slides.
 *
 * A whole document, not a fragment: opening it in a browser has to show the
 * slide, or the surface is a lie — the author would be editing markup whose
 * appearance they can only discover by saving it. So the file carries what
 * makes it a slide: the canvas box, the deck's own `theme.css`, the semantic
 * type rules, and a `<base>` so `assets/figure.png` resolves the same way the
 * player resolves it. The compiler measures this same document, with only the
 * base rewritten, so what the browser shows is what the deck gets.
 *
 * The marker records what was present when the file was exported. On import,
 * that lets the editor distinguish "the author deleted this slide" from "this
 * file never included that slide" without a second sidecar to lose or move.
 */
export function slidesToHtml(
  slides: Slide[],
  canvas: { w: number; h: number },
  options: HtmlExportOptions = {},
): string {
  const blank = options.blank ?? 0;
  const scope = encodeURIComponent(JSON.stringify(slides.map((slide) => slide.id)));
  const body = blank > 0
    ? Array.from({ length: blank }, () => BLANK_SECTION).join('\n')
    : slides.map((slide) => slideToHtml(slide, canvas)).join('\n');
  const title = blank > 0
    ? `${blank} new slide${blank === 1 ? '' : 's'}`
    : (slides.length === 1 ? slides[0].name || slides[0].id : `${slides.length} slides`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<!-- Describe the intent of this save for DeckWerk History; leave empty for an automatic change summary. -->
<meta name="${HTML_CHANGE_LABEL_META}" content="">
${blank > 0 ? BLANK_RULES : `<!-- ${SCOPE_MARKER}${scope} -->\n${SCOPE_RULES}`}
<title>${escape(title)}</title>
<base href="${escape(options.base ?? '../')}">
<style>${authoringCss(canvas)}</style>
<style>${options.typeCss ?? ''}</style>
<link rel="stylesheet" href="${escape(options.theme ?? 'theme.css')}">
<style>${PREVIEW_CSS}</style>
${usesMath(body) ? KATEX_PAGE_HTML : ''}
<script>${AUTO_FIT_SCRIPT}</script>
</head>
<body>
${body}</body>
</html>
`;
}

/**
 * Reading affordances only, and only ones that cannot move anything inside a
 * slide: the page around the slides, and the space between them. The slide is
 * shown at its true 1920×1080 — the browser's own zoom is a better fit control
 * than a transform that would then have to be undone before measuring.
 */
const PREVIEW_CSS = `
  body { background: #1b1b1f; padding: 32px 0; }
  section.slide { box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5); }
  section.slide + section.slide { margin-top: 32px; }
`;

/**
 * Auto-fitting text, the one thing on a slide that static CSS cannot express.
 *
 * The player shrinks opted-in text until it fits its box; a file that does not
 * would show it overflowing, or wrapping onto a line the slide does not have.
 * So the page carries the same shrink, as a script.
 *
 * It writes the fitted sizes into a stylesheet of its own and never touches an
 * inline `style`, because inline styles are exactly what the compiler reads
 * back into the deck — a fitted size baked in there would overwrite the
 * authored one and quietly defeat auto-fitting on the next render. For the
 * same reason it is not needed at compile time at all: an element's box is
 * fixed by its own geometry, so a browser that refuses to run this (the
 * editor's frame has a strict policy) still measures identical boxes.
 */
/**
 * Maths, rendered in a page the way the player renders it at present time.
 *
 * Without this the author sees raw `$…$`, and — worse — the compiler measures
 * the raw text: a subtitle that wraps onto three unrendered lines is baked
 * three lines tall while the player draws it as two. The pass is the player's
 * own, delimiter for delimiter (see renderer/player/render.ts): protect
 * escaped dollars, auto-render, restore. Safe to run twice — rendered maths
 * leaves no delimiters behind for a second pass to match. In the exported
 * page it runs before the auto-fit script, which the head's script order
 * guarantees.
 *
 * Self-contained (no captures) because it is serialised into the exported
 * page below; the editor's frame, whose policy blocks page scripts, calls it
 * directly with its own bundled KaTeX instead.
 */
export function renderAuthoredMath(
  doc: Document,
  renderMath: (el: Element, opts: unknown) => void,
): void {
  if (!doc.body) return;
  const escapedDollar = '\uE000';
  const texts: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const text of texts) {
    if (text.data.includes('\\$')) text.data = text.data.replace(/\\\$/g, escapedDollar);
  }
  renderMath(doc.body, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
    strict: 'ignore',
  });
  const restore = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  while (restore.nextNode()) {
    const text = restore.currentNode as Text;
    if (text.data.includes(escapedDollar)) {
      text.data = text.data.replaceAll(escapedDollar, '$');
    }
  }
}

/**
 * Whether markup holds `$…$` maths for KaTeX to render — two unescaped
 * dollars, the delimiters `renderAuthoredMath` looks for.
 *
 * KaTeX is ~640 KB inlined, and only a page someone *opens in a browser* with
 * maths on it needs its own copy: the compiler adds it to any page that lacks
 * it before measuring. Carried on every export, it made a blank `new` page
 * 660 KB, which is what an agent's terminal then truncated.
 */
function usesMath(markup: string): boolean {
  return (markup.replace(/\\\$/g, '').match(/\$/g) ?? []).length >= 2;
}

/** A closing script tag inside an inlined library would end the tag early. */
function escapeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/**
 * KaTeX, carried inside the page. The exported file must render its maths in
 * whatever browser opens it — the author's, the editor's offscreen iframe, the
 * headless compile window — offline, with no node_modules in reach, and all of
 * them must agree with the player. Marked so a measuring page can tell whether
 * the document already carries it.
 */
export const KATEX_PAGE_HTML = `<style data-katex-inline>${KATEX_CSS}</style>
<script>${escapeInlineScript(KATEX_JS)}</script>
<script>${escapeInlineScript(KATEX_AUTO_RENDER_JS)}</script>
<script>${renderAuthoredMath.toString()}
(() => {
  const run = () => {
    const render = globalThis.renderMathInElement;
    if (render) renderAuthoredMath(document, render);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();</script>`;

const AUTO_FIT_SCRIPT = `
${fitAutoTextElement.toString()}
(() => {
  const fit = () => {
    for (const node of document.querySelectorAll('[data-autofit="true"], [data-nowrap="true"]')) {
      fitAutoTextElement(node);
    }
  };
  const run = () => requestAnimationFrame(fit);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  // Web fonts replace fallback metrics after the first layout, exactly as they
  // do in the player, and a fit measured against the wrong metrics is wrong.
  if (document.fonts) document.fonts.ready.then(run);
})();
`;

/**
 * What makes a slide a slide, before any theme is involved.
 *
 * Deliberately *not* the player's stylesheet: that absolutely positions every
 * object, which is exactly what must not happen while the author's flexbox and
 * grid are doing the work. All this establishes is the canvas box and a
 * containing block for anything the author does position by hand.
 */
export function authoringCss(canvas: { w: number; h: number }): string {
  return `
  html, body { margin: 0; padding: 0; }
  body { width: ${canvas.w}px; }
  section.slide, [data-slide-id] {
    position: relative;
    width: ${canvas.w}px;
    height: ${canvas.h}px;
    overflow: hidden;
    box-sizing: border-box;
  }
  /* Compiled geometry is measured from each object's border box, and the
     player uses the same model. Keep exported native objects on that model so
     preserving padding or borders does not make them grow on the next render. */
  [data-element-id] { box-sizing: border-box; }
  /* Sensible defaults so bare markup does not arrive with browser margins
     baked into its measured geometry. */
  h1, h2, h3, h4, h5, h6, p, ul, ol, figure, blockquote { margin: 0; }
  /* No max-width: a picture that bleeds past the canvas edge is a real design,
     and clamping it to the slide silently resizes the object. The slide clips
     what overflows, which is what the player does too. */
  img, video { display: block; }
`;
}

/** Read the original ordered scope from an exported HTML document. */
export function htmlSlideScope(html: string): string[] | null {
  const match = html.match(/<!--\s*slide-editor-scope:([^\s]+)\s*-->/);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(match[1]));
    return Array.isArray(value) && value.every((id) => typeof id === 'string') ? value : null;
  } catch {
    return null;
  }
}

/**
 * The human-readable intent carried by an authoring document.
 *
 * A filename such as add.html is transport trivia, not useful History. Keeping
 * the intent in the document makes watched saves, explicit offline applies and
 * hosted mirrors agree without a race between the watcher and `apply --label`.
 */
export function htmlChangeLabel(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    }
    if (attributes.get('name')?.toLowerCase() !== HTML_CHANGE_LABEL_META) continue;
    const label = decodeHtmlAttribute(attributes.get('content') ?? '').trim();
    return label ? label.slice(0, 200) : null;
  }
  return null;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/**
 * Write the ids a compile assigned back into the authored document.
 *
 * A section without a `data-slide-id` is minted a fresh id on *every* compile,
 * so a file that is saved twice — or applied once, timed out, and applied
 * again — would insert its new slides twice. Stamping the assigned ids into
 * the file after a successful sync is what makes the loop idempotent: from
 * then on the same sections replace the same slides, however many times the
 * file lands. The scope marker is rewritten to the file's current slides for
 * the same reason — it is the record of what this file now governs.
 *
 * Returns null when there is nothing to change or when the document cannot be
 * matched against the compiled slides (better to leave a strange file alone
 * than to stamp ids onto the wrong sections).
 */
export function adoptAuthoredIds(html: string, slides: Slide[]): string | null {
  // Only the body can hold slide roots, and the head carries inlined KaTeX
  // whose script text must not be mistaken for markup.
  const bodyAt = html.search(/<body[\s>]/i);
  const from = bodyAt >= 0 ? bodyAt : 0;
  const roots = [...html.slice(from).matchAll(/<[a-zA-Z][^>]*>/g)]
    .map((match) => ({ tag: match[0], at: from + (match.index ?? 0) }))
    .filter(({ tag }) => /\bdata-slide-id\s*=/.test(tag)
      || (/^<section\b/i.test(tag) && /\bclass\s*=\s*["'][^"']*\bslide\b/.test(tag)));
  if (roots.length !== slides.length) return null;

  let out = html;
  for (let i = roots.length - 1; i >= 0; i--) {
    const { tag, at } = roots[i];
    if (/\bdata-slide-id\s*=/.test(tag)) continue;
    const stamped = tag.replace(/^<section\b/i,
      (open) => `${open} data-slide-id="${escape(slides[i].id)}"`);
    out = out.slice(0, at) + stamped + out.slice(at + tag.length);
  }

  const scope = `<!-- ${SCOPE_MARKER}${encodeURIComponent(JSON.stringify(slides.map((slide) => slide.id)))} -->`;
  const marker = /<!--\s*slide-editor-scope:[^\s]+\s*-->/;
  if (marker.test(out)) out = out.replace(marker, scope);
  else if (/<head[\s>]/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (open) => `${open}\n${scope}`);
  else out = `${scope}\n${out}`;

  return out === html ? null : out;
}

/**
 * Build the ordinary transaction that makes an exported HTML scope authoritative.
 * Files without a scope marker retain replace-or-append behaviour, so older
 * exports and hand-authored snippets remain valid.
 */
export function htmlSyncOperations(
  deck: Deck,
  slides: Slide[],
  scope: string[] | null,
  after: string | null,
): AgentOperation[] {
  const existingIds = new Set(deck.slides.map((slide) => slide.id));
  const authoredIds = slides.map((slide) => slide.id);
  if (new Set(authoredIds).size !== authoredIds.length) {
    const repeated = authoredIds.find((id, index) => authoredIds.indexOf(id) !== index);
    // Almost always a section copied to make a new slide, with the id copied
    // too. Saying which id, and what to do about it, turns a dead end into a
    // one-attribute fix.
    throw new Error(`Two sections carry data-slide-id="${repeated}".`
      + ' A slide id names one slide, so this file cannot say which one to replace.'
      + ' If one of them is meant to be a new slide, delete its data-slide-id'
      + ' attribute — a section without one is inserted, not a replacement.');
  }

  if (scope === null) {
    const operations: AgentOperation[] = [];
    const inserted: Slide[] = [];
    for (const slide of slides) {
      if (existingIds.has(slide.id)) operations.push({ op: 'replaceSlide', slideId: slide.id, slide });
      else inserted.push(slide);
    }
    if (inserted.length > 0) operations.push({ op: 'insertSlides', afterSlideId: after, slides: inserted });
    return operations;
  }

  if (new Set(scope).size !== scope.length) throw new Error('HTML scope contains duplicate slide ids');
  const unknownScope = scope.find((id) => !existingIds.has(id));
  if (unknownScope) throw new Error(`HTML scope names unknown slide id: ${unknownScope}`);

  // What the file governs is what it was exported with *plus* whatever it has
  // since created. Without that second half the loop only works once: a save
  // that adds a slide makes the very next save of the same file look like an
  // attempt to take over a slide belonging to someone else.
  const scopeSet = new Set([...scope, ...authoredIds.filter((id) => existingIds.has(id))]);
  // Deletion stays keyed to the recorded scope alone: a slide is deleted
  // because it was exported and then removed, never because it is merely absent.
  const exported = new Set(scope);

  const positions = [...scopeSet]
    .map((id) => deck.slides.findIndex((slide) => slide.id === id))
    .filter((index) => index >= 0);
  const insertionIndex = Math.min(...positions);
  const outside = deck.slides.map((slide) => slide.id).filter((id) => !scopeSet.has(id));
  const target = [...outside];
  target.splice(Number.isFinite(insertionIndex) ? insertionIndex : target.length, 0, ...authoredIds);
  if (target.length === 0) throw new Error('An HTML edit cannot delete every slide in the deck');

  const operations: AgentOperation[] = [];
  for (const slide of slides) {
    if (existingIds.has(slide.id)) operations.push({ op: 'replaceSlide', slideId: slide.id, slide });
  }

  const inserted = slides.filter((slide) => !existingIds.has(slide.id));
  // Insert before deleting so replacing the entire scope with new slides never
  // transiently violates the invariant that a deck retains at least one slide.
  if (inserted.length > 0) {
    operations.push({
      op: 'insertSlides',
      afterSlideId: deck.slides[deck.slides.length - 1]?.id ?? null,
      slides: inserted,
    });
  }
  for (const id of exported) {
    if (!authoredIds.includes(id)) operations.push({ op: 'deleteSlide', slideId: id });
  }

  const current = deck.slides.map((slide) => slide.id)
    .filter((id) => !scopeSet.has(id) || authoredIds.includes(id))
    .concat(inserted.map((slide) => slide.id));
  if (current.join('\0') !== target.join('\0')) {
    target.forEach((id, index) => operations.push({
      op: 'moveSlide', slideId: id, afterSlideId: index === 0 ? null : target[index - 1],
    }));
  }
  return operations;
}

/**
 * What a set of sync operations does to the deck, in the terms an author cares
 * about: which slides were rewritten, which are new, which are gone.
 *
 * Insert and replace look identical from the outside — both end with the deck
 * showing the words you wrote — so an author who meant to add a slide and
 * actually replaced one has nothing to notice. This is what makes the
 * difference reportable, and deletion in particular impossible to miss.
 */
export function htmlSyncSummary(operations: AgentOperation[]): {
  replaced: string[]; inserted: string[]; deleted: string[]; moved: number;
} {
  const inserted: string[] = [];
  for (const operation of operations) {
    if (operation.op === 'insertSlides') inserted.push(...operation.slides.map((slide) => slide.id));
  }
  return {
    replaced: operations.flatMap((op) => (op.op === 'replaceSlide' ? [op.slideId] : [])),
    inserted,
    deleted: operations.flatMap((op) => (op.op === 'deleteSlide' ? [op.slideId] : [])),
    moved: operations.filter((op) => op.op === 'moveSlide').length,
  };
}

/** The same summary as a phrase for a toast or a log line. */
export function describeHtmlSync(summary: ReturnType<typeof htmlSyncSummary>): string {
  const parts = [
    summary.replaced.length > 0 ? `${summary.replaced.length} replaced` : '',
    summary.inserted.length > 0 ? `${summary.inserted.length} added` : '',
    // Last and always spelled out: it is the only one that loses work.
    summary.deleted.length > 0 ? `${summary.deleted.length} DELETED` : '',
  ].filter(Boolean);
  if (parts.length === 0) return summary.moved > 0 ? 'reordered' : 'no change';
  return parts.join(', ') + (summary.moved > 0 ? ', reordered' : '');
}

/** A useful History title when the author did not supply semantic intent. */
export function htmlSyncHistoryLabel(operations: AgentOperation[]): string {
  const summary = htmlSyncSummary(operations);
  const parts = [
    summary.inserted.length > 0 ? `Added ${countSlides(summary.inserted.length)}` : '',
    summary.replaced.length > 0 ? `Updated ${countSlides(summary.replaced.length)}` : '',
    summary.deleted.length > 0 ? `Removed ${countSlides(summary.deleted.length)}` : '',
    summary.moved > 0 ? 'Reordered slides' : '',
  ].filter(Boolean);
  return parts.join(' · ') || 'Updated presentation';
}

function countSlides(count: number): string {
  return `${count} slide${count === 1 ? '' : 's'}`;
}

/**
 * Inline CSS worth keeping once an element is absolutely positioned.
 *
 * Layout declarations — display, flex, grid, margins — did their job during
 * measurement and are actively harmful afterwards: `flex: 1` is inert on an
 * absolutely positioned box, and a stray `display: flex` would re-flow text
 * the geometry was measured against. Presentation survives; layout does not.
 */
export const PRESENTATIONAL_STYLE = new Set([
  'color', 'background', 'background-color', 'background-image',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'letter-spacing', 'line-height', 'text-transform', 'text-decoration',
  'background-size', 'background-position', 'background-repeat',
  // Gradient text is background-image + background-clip + a transparent fill.
  // Drop the clip and the "gradient" is a solid box over the words.
  'background-clip', '-webkit-background-clip', '-webkit-text-fill-color',
  'text-shadow', '-webkit-text-stroke', '-webkit-text-stroke-width',
  '-webkit-text-stroke-color', 'border', 'border-radius', 'border-color', 'border-width',
  'border-style', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'box-shadow', 'filter', 'mix-blend-mode', 'padding',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'overflow', 'object-position', 'white-space', 'word-break', 'overflow-wrap',
  'writing-mode', 'text-orientation', 'list-style-type', 'list-style-position',
]);

/**
 * Tags that are never text, whatever they contain.
 *
 * The rule used to be the other way round — an allow-list of a dozen tags —
 * and every other element an author wrote came back as an inert HTML fallback:
 * a `<dt>`, a `<figure>`, an `<article>`, a `<small>` credit line. HTML has
 * around a hundred text-bearing elements and there is nothing special about
 * the twelve that happened to be listed, so the exceptions are enumerated
 * instead: embedded content, form controls, and the tags with their own
 * mapping above.
 */
const NON_TEXT_TAGS = new Set([
  'svg', 'canvas', 'iframe', 'object', 'embed', 'math', 'table',
  'img', 'video', 'audio', 'input', 'select', 'textarea', 'button', 'form',
]);

/**
 * Turn a measured page into deck slides, against the deck they are destined for.
 *
 * Ids are minted only where the markup carries none, and an id being
 * re-authored is not a clash with itself: the ids belonging to slides this
 * compile is about to replace are freed first, or every round trip would
 * rename every element it touched.
 */
export function slidesFromMeasured(deck: Deck, measured: MeasuredSlide[]): Slide[] {
  const used = new Set(deck.slides.flatMap((slide) =>
    [slide.id, ...slide.elements.map((element) => element.id)]));
  for (const slide of measured) {
    const existing = deck.slides.find((candidate) => candidate.id === slide.id);
    if (!existing) continue;
    used.delete(existing.id);
    for (const element of existing.elements) used.delete(element.id);
  }

  return measured.map((slide, index) => {
    const built = slideFromMeasured(slide, {
      slideId: slide.id ?? nextSlideId(used, index),
      usedIds: used,
    });
    const layout = slide.layout;
    if (layout === undefined) return built;
    if (!FIXED_LAYOUTS.includes(layout as FixedLayout)) {
      throw new HtmlAuthoringError(`Unknown data-layout "${layout}" on a slide. Use ${FIXED_LAYOUTS.join(', ')}.`);
    }
    // A page that names a layout gets the editor's layout behaviour: its
    // title and body boxes (data-layout-slot, or a role class on an exported
    // page) become the master's placeholders, placed by the master and styled
    // by the deck's theme rather than by what the page's browser computed.
    syncSlideWithLayoutMaster(built, layout as FixedLayout, layoutMaster(deck, layout as FixedLayout), {
      replaceStyle: true,
      forceBackground: !slide.ownBackground,
    });
    return built;
  });
}

const FIXED_LAYOUTS: FixedLayout[] = ['freeform', 'standard', 'title'];

/** A page the author must fix, as opposed to a compiler that failed. */
export class HtmlAuthoringError extends Error {}

function nextSlideId(used: Set<string>, index: number): string {
  let candidate = `slide-${used.size + index + 1}`;
  for (let n = 1; used.has(candidate); n++) candidate = `slide-${used.size + index + 1}-${n}`;
  return candidate;
}

/** Turn one measured slide into a deck slide, ids minted where absent. */
export function slideFromMeasured(
  measured: MeasuredSlide,
  opts: { slideId: string; usedIds: Set<string> },
): Slide {
  const timeline: TimelineEntry[] = [];
  const elements: SlideElement[] = [];

  measured.nodes.forEach((node, index) => {
    const id = uniqueId(node.elementId ?? `${opts.slideId}-${node.tag}-${index + 1}`, opts.usedIds);
    const element = elementFromNode(node, id, index + 1);
    if (!element) return;
    elements.push(element);
    const build = buildFromNode(node, id, timeline.length);
    if (build) timeline.push(build);
  });

  return {
    id: opts.slideId,
    name: measured.name,
    notes: measured.notes,
    background: measured.background,
    ...(measured.morphFromPrevious ? { morphFromPrevious: true } : {}),
    ...(measured.morphDuration !== undefined ? { morphDuration: measured.morphDuration } : {}),
    elements,
    timeline,
  };
}

export function elementFromNode(
  node: MeasuredNode,
  id: string,
  z: number,
): SlideElement | null {
  if (node.rect.w <= 0 || node.rect.h <= 0) return null;
  const contentStyle = contentStyleFrom(node.dataset.contentStyle);

  const base = {
    id,
    x: round(node.rect.x),
    y: round(node.rect.y),
    w: round(node.rect.w),
    h: round(node.rect.h),
    rot: round(node.rotation),
    z,
    opacity: node.opacity,
    class: node.classes,
    style: pickStyle(node.style),
    ...(node.dataset.morph !== undefined
      ? { morphId: node.dataset.morph || null } : {}),
    ...(node.dataset.lineageId !== undefined
      ? { lineageId: node.dataset.lineageId || null } : {}),
  };
  const mediaBase = { ...base, style: { ...base.style } };
  // The player wrapper clips native media for crops and rounded corners. That
  // renderer-owned `overflow:hidden` is visible to the browser walk, but it is
  // not authored element CSS and must not accumulate in the deck on every
  // HTML round trip.
  delete mediaBase.style.overflow;
  const mediaDecoration = mediaDecorationFromNode(node, mediaBase.style);

  // A cropped picture is exported as a window with the media inside it, the
  // way the player renders one, so the wrapper — not the `<img>` — is the
  // object, and it says what it is rather than being guessed from its tag.
  if (node.dataset.element === 'image' || node.dataset.element === 'video') {
    const common = {
      ...mediaBase,
      ...mediaDecoration,
      ...effectsFromNode(node, mediaBase.style),
      src: node.dataset.src ?? '',
      fit: fitFrom(node.dataset.fit),
      sourceBox: cropFrom(node.dataset.crop),
    };
    if (node.dataset.element === 'image') {
      return {
        ...common, type: 'image', alt: node.dataset.alt ?? '',
      };
    }
    const [start, end] = trimFrom(node.dataset.trim);
    return {
      ...common,
      type: 'video',
      autoplay: node.dataset.autoplay === 'true',
      loop: node.dataset.loop === 'true',
      muted: node.dataset.muted === 'true',
      controls: node.dataset.controls === 'true',
      start,
      end,
      poster: node.dataset.poster ?? null,
    };
  }

  if (node.tag === 'img') {
    return {
      ...mediaBase,
      ...mediaDecoration,
      ...effectsFromNode(node, mediaBase.style),
      type: 'image',
      src: node.attrs.src ?? '',
      fit: fitFrom(node.attrs.objectFit),
      alt: node.attrs.alt ?? '',
      sourceBox: cropFrom(node.dataset.crop),
    };
  }

  if (node.tag === 'video') {
    const [start, end] = trimFrom(node.dataset.trim);
    return {
      ...mediaBase,
      ...mediaDecoration,
      ...effectsFromNode(node, mediaBase.style),
      type: 'video',
      src: withoutFragment(node.attrs.src ?? ''),
      fit: fitFrom(node.attrs.objectFit),
      autoplay: node.attrs.autoplay ?? true,
      loop: node.attrs.loop ?? true,
      muted: node.attrs.muted ?? true,
      controls: node.attrs.controls ?? false,
      start,
      end,
      poster: node.attrs.poster ?? null,
      sourceBox: cropFrom(node.dataset.crop),
    };
  }

  if (node.dataset.element === 'shape') {
    const [cx, cy] = numbers(node.dataset.control);
    const [pw, ph] = numbers(node.dataset.pathSize);
    const shapeBase = { ...base, style: { ...base.style } };
    for (const property of Object.keys(shapeBase.style)) {
      if (isMediaBorderPaint(property) || property === 'border-radius') {
        delete shapeBase.style[property];
      }
    }
    return {
      ...shapeBase,
      type: 'shape',
      shape: shapeKind(node.dataset.shape),
      fill: node.dataset.fill ?? null,
      ...(node.dataset.fillTo ? { fillGradient: {
        to: node.dataset.fillTo,
        angle: Number(node.dataset.fillAngle ?? 270) || 0,
        kind: node.dataset.fillGradient === 'radial' ? 'radial' as const : 'linear' as const,
      } } : {}),
      stroke: node.dataset.stroke ?? null,
      strokeWidth: Number(node.dataset.strokeWidth ?? 2) || 0,
      radius: Number(node.dataset.radius ?? 0) || 0,
      path: node.dataset.path ?? null,
      pathSize: pw > 0 && ph > 0 ? { w: pw, h: ph } : null,
      arrowStart: node.dataset.arrowStart === 'true',
      arrowEnd: node.dataset.arrowEnd === 'true',
      ...(node.dataset.control ? { control: { x: cx, y: cy } } : {}),
    };
  }

  // A sandboxed web page. Its box is what the browser measured; everything
  // else rides on data attributes, because the page itself never enters the
  // measuring frame (the sanitizer strips frames, and nothing inside one is a
  // slide object anyway).
  if (node.dataset.element === 'web') {
    return {
      ...base,
      type: 'web',
      src: node.dataset.src ?? '',
      poster: node.dataset.poster || null,
      interactive: node.dataset.interactive !== 'false',
      title: node.dataset.title ?? '',
    };
  }

  if (node.dataset.element === 'unsupported') {
    // Still a gap, still conspicuous. It only stops being one when the author
    // replaces this element with markup that means something.
    return {
      ...base,
      type: 'unsupported',
      originalType: node.dataset.originalType ?? 'unknown',
      note: node.html.replace(/<[^>]*>/g, '').trim(),
    };
  }

  if (node.dataset.element === 'table' && node.tag === 'table') {
    const authored = `<table>${node.html.trim()}</table>`;
    let widths = (node.dataset.tableWidths ?? '')
      .split(',')
      .map((value) => Number.parseFloat(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (widths.length === 0) {
      const firstRow = /<tr\b[^>]*>([\s\S]*?)<\/tr>/i.exec(node.html)?.[1] ?? '';
      const columns = [...firstRow.matchAll(/<(?:td|th)\b([^>]*)>/gi)]
        .reduce((count, cell) => {
          const span = /\bcolspan\s*=\s*["']?(\d+)/i.exec(cell[1])?.[1];
          return count + Math.max(1, Number.parseInt(span ?? '1', 10) || 1);
        }, 0);
      widths = Array.from({ length: Math.max(1, columns) }, () => 1);
    }
    return {
      ...base,
      type: 'text',
      html: applyTableColumnWidths(authored, widths),
      align: alignFrom(node.attrs.textAlign),
      valign: 'top',
      autoFit: false,
      table: { columnWidths: widths, autoHeight: true },
    };
  }

  // Anything the walker could not reduce to a known object — an inline SVG
  // chart, a gradient panel, a table — is preserved verbatim rather than
  // dropped or flattened to a picture. It still drags and resizes; only its
  // innards are not individually editable.
  if (node.verbatim || node.dataset.element === 'html' || NON_TEXT_TAGS.has(node.tag)) {
    return {
      ...base,
      type: 'html',
      html: node.html,
      sandboxed: true,
      css: node.css ?? '',
      fallbackReason: node.fallbackReason ?? `Unsupported ${node.tag} region`,
    };
  }

  const noWrap = noWrapFromNode(node, base.style);
  const tableWidths = (node.dataset.tableWidths ?? '')
    .split(',')
    .map((value) => Number.parseFloat(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return {
    ...base,
    ...effectsFromNode(node, base.style),
    type: 'text',
    // A list is one text object; without its own tag around the items the
    // markers and indentation would not survive into the deck.
    html: node.tag === 'ul' || node.tag === 'ol'
      ? `<${node.tag}>${node.html.trim()}</${node.tag}>`
      : node.html.trim(),
    align: alignFrom(node.attrs.textAlign),
    valign: valignFrom(node.dataset.valign),
    ...(contentStyle ? { contentStyle } : {}),
    ...(node.dataset.autofit !== undefined ? { autoFit: node.dataset.autofit !== 'false' } : {}),
    ...(node.dataset.layoutSlot === 'title' || node.dataset.layoutSlot === 'body'
      ? {
        layoutPlaceholder: node.dataset.layoutSlot,
        class: base.class.includes(`role-${node.dataset.layoutSlot}`)
          ? base.class
          : [...base.class, `role-${node.dataset.layoutSlot}`],
      }
      : {}),
    ...(node.dataset.table === 'true' && tableWidths.length > 0 ? {
      table: {
        columnWidths: tableWidths,
        autoHeight: node.dataset.tableAutoHeight !== 'false',
      },
    } : {}),
    ...noWrap,
    ...(node.dataset.fitMode === 'condense' ? { noWrapMode: 'condense' as const } : {}),
    ...(Number.isFinite(Number.parseFloat(node.dataset.paragraphSpacing ?? ''))
      ? { paragraphSpacing: Math.max(0, Number.parseFloat(node.dataset.paragraphSpacing!)) }
      : {}),
  };
}

/**
 * `data-build="click"`, `data-build="afterPrev"`, `data-build="afterPrev+500"`.
 *
 * Builds have no CSS analogue, so they ride on data attributes rather than in
 * a side-channel the author has to keep in sync with the markup.
 */
export function buildFromNode(
  node: MeasuredNode,
  elementId: string,
  index: number,
): TimelineEntry | null {
  const spec = node.dataset.build;
  if (!spec) return null;
  const [name, delay] = spec.split('+');
  const on = (['click', 'afterPrev', 'withPrev', 'mediaEnd'] as const)
    .find((candidate) => candidate.toLowerCase() === name.trim().toLowerCase());
  if (!on) return null;
  return {
    id: `${elementId}-build-${index + 1}`,
    trigger: { on, ref: node.dataset.buildRef ?? null, delay: Number(delay ?? 0) || 0 },
    action: { type: 'appear', target: elementId, value: null },
  };
}

/**
 * A slide as HTML an agent can edit and hand back.
 *
 * Positions are emitted as inline CSS so the export is lossless: recompiling
 * an untouched export reproduces the slide. Replace those rules with flexbox
 * or grid and the compiler will measure whatever the browser makes of it.
 */
export function slideToHtml(slide: Slide, canvas: { w: number; h: number }): string {
  const builds = new Map(slide.timeline
    .filter((entry) => entry.action.type === 'appear')
    .map((entry) => [entry.action.target, entry]));

  const body = [...slide.elements]
    .sort((a, b) => a.z - b.z)
    .map((element) => elementToHtml(element, builds.get(element.id)))
    .join('\n');

  // Both halves, and as separate declarations rather than the `background`
  // shorthand: the shorthand would need parsing back out, and a slide that has
  // a picture behind it is not one whose background can be summarised as a
  // colour. Sizing matches what the player does with the same two fields.
  const declarations = [
    slide.background.color ? `background-color:${slide.background.color}` : '',
    slide.background.image
      ? `background-image:url("${escape(slide.background.image)}")`
        + '; background-size:cover; background-position:center'
      : '',
  ].filter(Boolean).join('; ');
  const background = declarations ? ` ${styleAttr(declarations)}` : '';
  return `<section class="slide" data-slide-id="${escape(slide.id)}"`
    + ` data-canvas="${canvas.w}x${canvas.h}"`
    + (slide.name ? ` data-name="${escape(slide.name)}"` : '')
    + (slide.layout ? ` data-layout="${slide.layout}"` : '')
    + (slide.morphFromPrevious ? ' data-morph-from-previous="true"' : '')
    + (slide.morphDuration !== undefined ? ` data-morph-duration="${slide.morphDuration}"` : '')
    + `${background}>\n${body}\n</section>\n`;
}

function elementToHtml(element: SlideElement, build?: TimelineEntry): string {
  const position = `position:absolute; left:${element.x}px; top:${element.y}px;`
    + ` width:${element.w}px; height:${element.h}px;`
    + (element.rot ? ` transform:rotate(${element.rot}deg);` : '')
    + (element.opacity !== 1 ? ` opacity:${element.opacity};` : '');
  const inline = Object.entries(element.style)
    .filter(([property]) => !typedPropertyOwnsCss(element, property))
    .map(([property, value]) => ` ${property}:${value};`)
    .join('');
  const attrs = [
    `data-element-id="${escape(element.id)}"`,
    // Text writes its own class attribute, because it also carries the
    // player's structural classes.
    element.class.length > 0 && element.type !== 'text'
      ? `class="${escape(element.class.join(' '))}"` : '',
    element.morphId !== undefined
      ? `data-morph="${escape(element.morphId ?? '')}"` : '',
    element.lineageId !== undefined
      ? `data-lineage-id="${escape(element.lineageId ?? '')}"` : '',
    build ? `data-build="${build.trigger.on}${build.trigger.delay ? `+${build.trigger.delay}` : ''}"` : '',
    element.type === 'text' && element.layoutPlaceholder
      ? `data-layout-slot="${element.layoutPlaceholder}"` : '',
  ].filter(Boolean).join(' ');

  switch (element.type) {
    case 'text': {
      // The player's own markup: a flex body for vertical alignment wrapping a
      // content block that holds all the text. Reproduced rather than
      // approximated, because a flatter box lays out subtly differently and
      // auto-fit then settles on a different size — which is a title that fits
      // on the projector and wraps onto a third line in the browser.
      //
      // Vertical alignment also travels as an attribute: it has no CSS
      // equivalent once a box is measured tightly around its content.
      const justify = element.valign === 'top' ? 'flex-start'
        : element.valign === 'bottom' ? 'flex-end' : 'center';
      const body = `<div class="text-body" data-element="none" `
        + styleAttr(`display:flex; flex-direction:column; justify-content:${justify};`,
          'width:100%; height:100%;')
        // Inheritable inline styles are mirrored onto the content node so a
        // theme rule targeting .text-content directly can't override them
        // (matches the live renderer — see MIRRORED_TEXT_STYLE_PROPERTIES).
        + `><div class="text-content" data-text-content ${styleAttr('width:100%;',
          MIRRORED_TEXT_STYLE_PROPERTIES
            .filter((property) => element.style[property] !== undefined)
            .map((property) => `${property}:${element.style[property]};`)
            .join(' '),
          Object.entries(element.contentStyle ?? {})
            .map(([property, value]) => `${property}:${value};`)
            .join(' '))}>`
        + `${element.table
          ? applyTableColumnWidths(element.html, element.table.columnWidths)
          : element.html}</div></div>`;
      return `  <div ${attrs} class="element element-text${element.class.length > 0
        ? ` ${escape(element.class.join(' '))}` : ''}" data-valign="${element.valign}"`
        + effectsDataAttrs(element)
        + `${element.contentStyle && Object.keys(element.contentStyle).length > 0
          ? ` data-content-style="${escape(encodeURIComponent(JSON.stringify(element.contentStyle)))}"` : ''}`
        + `${element.autoFit ? ' data-autofit="true"' : ''}`
        + `${element.table
          ? ` data-table="true" data-table-widths="${element.table.columnWidths.join(',')}" data-table-auto-height="${element.table.autoHeight}"`
          : ''}`
        + `${element.noWrap !== undefined ? ` data-nowrap="${element.noWrap}"` : ''}`
        + `${element.noWrapMode === 'condense' ? ' data-fit-mode="condense"' : ''}`
        + `${element.paragraphSpacing !== undefined
          ? ` data-paragraph-spacing="${element.paragraphSpacing}"` : ''}`
        + ` ${styleAttr(position, inline, `text-align:${element.align};`,
          element.paragraphSpacing !== undefined
            ? `--paragraph-spacing:${element.paragraphSpacing}px;` : '')}>${body}</div>`;
    }
    case 'image':
      if (element.sourceBox) {
        return `  <div ${attrs} data-element="image"`
          + ` data-src="${escape(element.src)}" data-alt="${escape(element.alt)}"`
          + ` data-fit="${element.fit}" data-crop="${boxAttr(element.sourceBox)}"`
          + effectsDataAttrs(element)
          + mediaDataAttrs(element)
          + ` ${styleAttr(position, inline, media(element), 'overflow:hidden;')}>`
          + `${notAnObject(croppedMedia('img', element.src, element.sourceBox,
            ` alt="${escape(element.alt)}"`))}</div>`;
      }
      return `  <img ${attrs} src="${escape(element.src)}" alt="${escape(element.alt)}"`
        + effectsDataAttrs(element)
        + mediaDataAttrs(element)
        + ` ${styleAttr(position, inline, media(element), `object-fit:${element.fit};`)}>`;
    case 'video': {
      const flags = `${element.loop ? ' loop' : ''}${element.muted ? ' muted' : ''}`
        + `${element.autoplay ? ' autoplay' : ''}${element.controls ? ' controls' : ''}`;
      const trim = ` data-trim="${element.start},${element.end ?? ''}"`;
      if (element.sourceBox) {
        return `  <div ${attrs} data-element="video"`
          + ` data-src="${escape(element.src)}" data-fit="${element.fit}"${trim}`
          + ` data-crop="${boxAttr(element.sourceBox)}"`
          + effectsDataAttrs(element)
          + mediaDataAttrs(element)
          + `${element.loop ? ' data-loop="true"' : ''}`
          + `${element.muted ? ' data-muted="true"' : ''}`
          + `${element.autoplay ? ' data-autoplay="true"' : ''}`
          + `${element.controls ? ' data-controls="true"' : ''}`
          + `${element.poster ? ` data-poster="${escape(element.poster)}"` : ''}`
          + ` ${styleAttr(position, inline, media(element), 'overflow:hidden;')}>`
          + `${notAnObject(croppedMedia('video', mediaFragment(element), element.sourceBox, flags))}</div>`;
      }
      // `#t=` is how a static page asks for the in-point: without it the file
      // shows frame zero while the player shows the frame the talk starts on.
      return `  <video ${attrs} src="${escape(mediaFragment(element))}"${trim}${flags}`
        + effectsDataAttrs(element)
        + mediaDataAttrs(element)
        + `${element.poster ? ` poster="${escape(element.poster)}"` : ''}`
        + ` ${styleAttr(position, inline, media(element), `object-fit:${element.fit};`)}></video>`;
    }
    case 'shape':
      // A shape has no markup of its own, so its parameters ride on data
      // attributes: readable, editable by hand, and reconstructed exactly on
      // the way back rather than being flattened into a picture.
      return `  <div ${attrs} data-element="shape" data-shape="${element.shape}"`
        + attr('data-fill', element.fill)
        + (element.fillGradient ? attr('data-fill-to', element.fillGradient.to)
          + attr('data-fill-angle', String(element.fillGradient.angle))
          + attr('data-fill-gradient', element.fillGradient.kind) : '')
        + attr('data-stroke', element.stroke)
        + ` data-stroke-width="${element.strokeWidth}" data-radius="${element.radius}"`
        + (element.arrowStart ? ' data-arrow-start="true"' : '')
        + (element.arrowEnd ? ' data-arrow-end="true"' : '')
        + (element.control ? ` data-control="${element.control.x},${element.control.y}"` : '')
        + attr('data-path', element.path)
        + (element.pathSize ? ` data-path-size="${element.pathSize.w},${element.pathSize.h}"` : '')
        // Paint effects live on the wrapper rather than the nested SVG. Give
        // that wrapper the same contour as the native shape so shadows and
        // filters do not reveal a rectangular box around circles and rounded
        // cards in the editable HTML preview.
        + ` ${styleAttr(position, inline, shapeWrapperContour(element))}>`
        // The drawing itself, from the same builder the player draws with. It
        // is marked as not-an-object so the walk keeps treating the wrapper as
        // the shape and reads the parameters off the data attributes above,
        // rather than descending into the SVG and calling it an html element.
        + `${notAnObject(shapeSvg(element))}</div>`;
    case 'web':
      // The page cannot run in an authoring file (frames are stripped before
      // measuring), so the export stands in for it: the poster when there is
      // one, otherwise a labelled box the same size. Edit the data attributes
      // to repoint it; the box's CSS is its geometry as for any element.
      return `  <div ${attrs} data-element="web" data-src="${escape(element.src)}"`
        + attr('data-poster', element.poster)
        + ` data-interactive="${element.interactive}"`
        + ` data-title="${escape(element.title)}"`
        + ` ${styleAttr(position, inline, 'overflow:hidden;')}>`
        + notAnObject(element.poster
          ? `<img src="${escape(element.poster)}" alt="${escape(element.title)}" style="display:block;width:100%;height:100%;object-fit:contain;">`
          : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;`
            + `font:24px system-ui,sans-serif;color:#667;background:#eef0f3;border:2px dashed #99a;box-sizing:border-box;">`
            + `web page: ${escape(element.title || element.src)}</div>`)
        + '</div>';
    case 'unsupported':
      // An import gap, described well enough to be fixed: replace this element
      // with real markup and it becomes a real object on the way back.
      return `  <div ${attrs} data-element="unsupported"`
        + ` data-original-type="${escape(element.originalType)}"`
        + ` ${styleAttr(position, inline)}>${escape(element.note)}</div>`;
    default:
      return `  <div ${attrs} data-element="html" ${styleAttr(position, inline)}>`
        + `${'html' in element ? element.html : ''}</div>`;
  }
}

function contentStyleFrom(encoded: string | undefined): Record<string, string> | null {
  if (!encoded) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(encoded));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (!entries.every(([key, value]) => key.length > 0 && typeof value === 'string')) return null;
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Mark markup as scenery: it is drawn, but it is not a slide object.
 *
 * The walk turns content leaves into objects, so an SVG or an `<img>` placed
 * inside an element purely to render it would otherwise *become* the element
 * and take its identity with it.
 */
function notAnObject(markup: string): string {
  return markup.replace(/^<([a-z]+)/i, '<$1 data-element="none"');
}

/**
 * A crop, drawn the way the player draws it: the element box is a window and
 * the picture is placed and sized behind it in the window's coordinates. The
 * naive alternative — squeezing the whole frame into the window with
 * `object-fit` — is how a cropped photograph came out visibly squashed.
 */
function croppedMedia(
  tag: 'img' | 'video',
  src: string,
  box: { x: number; y: number; w: number; h: number },
  extra: string,
): string {
  const close = tag === 'video' ? '</video>' : '';
  return `<${tag} src="${escape(src)}"${extra} `
    + styleAttr(`position:absolute; left:${box.x}px; top:${box.y}px;`,
      `width:${box.w}px; height:${box.h}px; object-fit:fill;`)
    + `>${close}`;
}

/** The video's source at its in-point, so a trimmed clip previews where it starts. */
function mediaFragment(element: Extract<SlideElement, { type: 'video' }>): string {
  return element.start > 0 ? `${element.src}#t=${element.start}` : element.src;
}

/** Media decoration for the editable HTML preview. */
function media(element: SlideElement): string {
  if (element.type !== 'image' && element.type !== 'video') return '';
  const radius = element.maskShape === 'circle'
    ? '50%'
    : element.borderRadius !== undefined
      ? (element.borderRadius > 0 ? `${element.borderRadius}px` : '')
      : element.maskShape === 'rect' ? '' : element.style['border-radius'] ?? '';
  const border = (element.borderWidth ?? 0) > 0
    ? `outline:${element.borderWidth}px solid ${element.borderColor ?? '#000000'};`
      + ` outline-offset:-${element.borderWidth}px;`
    : '';
  const clip = radius ? ` border-radius:${radius}; overflow:hidden;` : '';
  // Posterise and additive noise use SVG filters the player defines per
  // element; blur and greyscale are plain CSS. Only the CSS pair is reproduced
  // here, while data-effects keeps every effect losslessly round-trippable.
  const filters = (element.effects ?? [])
    .map((effect) => effect.type === 'blur' ? `blur(${effect.radius}px)`
      : effect.type === 'grayscale' ? `grayscale(${effect.amount})` : '')
    .filter(Boolean)
    .join(' ');
  return border + clip + (filters ? ` filter:${filters};` : '');
}

/** Typed media decoration survives an inspect/edit/save HTML round trip. */
function mediaDataAttrs(element: Extract<SlideElement, { type: 'image' | 'video' }>): string {
  const border = element.borderWidth !== undefined
    ? ` data-border-width="${element.borderWidth}" data-border-color="${escape(element.borderColor ?? '#000000')}"`
    : '';
  const radius = element.borderRadius !== undefined
    ? ` data-border-radius="${element.borderRadius}"`
    : '';
  const mask = element.maskShape !== undefined
    ? ` data-mask-shape="${element.maskShape}"`
    : '';
  return border + radius + mask;
}

function effectsDataAttrs(
  element: Extract<SlideElement, { type: 'text' | 'image' | 'video' }>,
): string {
  if (element.effects === undefined) return '';
  return ` data-effects="${escape(encodeURIComponent(JSON.stringify(element.effects)))}"`;
}

function effectsFromNode(
  node: MeasuredNode,
  style: Record<string, string>,
): { effects?: MediaEffect[] } {
  if (node.dataset.effects !== undefined) {
    try {
      const parsed = MediaEffectSchema.array().safeParse(
        JSON.parse(decodeURIComponent(node.dataset.effects)),
      );
      if (parsed.success) {
        // `filter` is generated beside data-effects solely for the editable
        // HTML preview. Keeping both would apply blur/greyscale twice after a
        // round trip, once to the wrapper and once to the native media body.
        delete style.filter;
        return { effects: parsed.data };
      }
    } catch {
      // Fall through to a representable authored CSS filter, if present.
    }
  }
  const effects = cssVisualEffects(style.filter);
  if (!effects) return {};
  delete style.filter;
  return { effects };
}

function noWrapFromNode(
  node: MeasuredNode,
  style: Record<string, string>,
): { noWrap?: boolean } {
  if (node.dataset.nowrap !== undefined) {
    delete style['white-space'];
    return { noWrap: node.dataset.nowrap !== 'false' };
  }
  if (!cssNoWrap(style['white-space'])) return {};
  delete style['white-space'];
  return { noWrap: true };
}

function mediaDecorationFromNode(
  node: MeasuredNode,
  style: Record<string, string>,
): {
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  maskShape?: 'rect' | 'circle';
} {
  const decoration: {
    borderColor?: string;
    borderWidth?: number;
    borderRadius?: number;
    maskShape?: 'rect' | 'circle';
  } = {};
  const width = Number(node.dataset.borderWidth);
  if (node.dataset.borderWidth !== undefined && Number.isFinite(width) && width >= 0) {
    decoration.borderWidth = width;
    decoration.borderColor = node.dataset.borderColor ?? '#000000';
    // Exported Agent HTML may carry the same border both as durable typed
    // metadata and as CSS used for preview. Keep one source of truth so later
    // inspector edits do not uncover an immutable duplicate.
    for (const property of Object.keys(style)) {
      if (isMediaBorderPaint(property)) delete style[property];
    }
    // The outline in the exported page is generated only to make the
    // authoring preview match the player. It is not a stored media style; the
    // typed fields above are the durable deck representation.
  } else {
    const border = cssMediaBorder(style);
    if (border) {
      decoration.borderWidth = border.width;
      decoration.borderColor = border.color;
      for (const property of Object.keys(style)) {
        if (isMediaBorderPaint(property)) delete style[property];
      }
    }
  }
  const typedRadius = Number(node.dataset.borderRadius);
  if (node.dataset.borderRadius !== undefined && Number.isFinite(typedRadius) && typedRadius >= 0) {
    decoration.borderRadius = typedRadius;
    delete style['border-radius'];
  } else if (node.dataset.maskShape !== 'circle') {
    // Independent Agent HTML commonly styles a video through a class, e.g.
    // `video { border-radius:28px }`. Chromium gives that to the compiler as
    // ordinary CSS, but the editor exposes the typed media field. Promote a
    // scalar pixel radius so the inspector displays and can edit the value.
    const cssRadius = cssMediaRadius(style['border-radius']);
    if (cssRadius) {
      Object.assign(decoration, cssRadius);
      delete style['border-radius'];
    }
  }
  if (node.dataset.maskShape === 'circle' || node.dataset.maskShape === 'rect') {
    decoration.maskShape = node.dataset.maskShape;
    delete style['border-radius'];
  }
  return decoration;
}

/**
 * A `style` attribute, escaped.
 *
 * Not decoration: a font stack is `font-family:"Helvetica Neue", sans-serif`,
 * and dropping that into `style="…"` unescaped ends the attribute at the first
 * quote. Everything after it — the colour, the weight, the alignment appended
 * at the end — is silently discarded, and the slide comes back in the browser's
 * default face. Every Keynote import has quoted font stacks on nearly every
 * text box, so this was most of a deck.
 */
function styleAttr(...declarations: string[]): string {
  return `style="${escape(declarations.filter(Boolean).join(' ').trim())}"`;
}

function shapeWrapperContour(element: Extract<SlideElement, { type: 'shape' }>): string {
  if (element.shape === 'ellipse') return 'border-radius:50%;';
  if (element.shape === 'rect' && element.radius > 0) return `border-radius:${element.radius}px;`;
  return '';
}

function attr(name: string, value: string | null): string {
  return value === null || value === '' ? '' : ` ${name}="${escape(value)}"`;
}

/* --- small conversions --- */

function pickStyle(style: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [property, value] of Object.entries(style)) {
    // `--curl-*` are a curved (paper) shadow's settings, read by player.css.
    if ((PRESENTATIONAL_STYLE.has(property) || property.startsWith('--curl-')) && value) kept[property] = value;
  }
  return kept;
}

function valignFrom(value: string | undefined): 'top' | 'middle' | 'bottom' {
  return value === 'middle' || value === 'bottom' ? value : 'top';
}

function shapeKind(value: string | undefined): 'rect' | 'ellipse' | 'line' | 'arrow' | 'path' {
  const kinds = ['rect', 'ellipse', 'line', 'arrow', 'path'] as const;
  return kinds.find((kind) => kind === value) ?? 'rect';
}

function numbers(spec: string | undefined): [number, number] {
  const [a, b] = (spec ?? '').split(',').map((part) => Number(part.trim()));
  return [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0];
}

function fitFrom(objectFit: string | undefined): 'contain' | 'cover' | 'fill' {
  return objectFit === 'cover' || objectFit === 'fill' ? objectFit : 'contain';
}

function alignFrom(textAlign: string | undefined): 'left' | 'center' | 'right' | 'justify' {
  if (textAlign === 'center' || textAlign === 'right' || textAlign === 'justify') return textAlign;
  // `start`/`end` resolve to left in the left-to-right decks this supports.
  return 'left';
}

function trimFrom(spec: string | undefined): [number, number | null] {
  if (!spec) return [0, null];
  const [start, end] = spec.split(',').map((part) => part.trim());
  const from = Number(start);
  const to = end === '' || end === undefined ? null : Number(end);
  return [Number.isFinite(from) ? from : 0, to !== null && Number.isFinite(to) ? to : null];
}

function cropFrom(spec: string | undefined) {
  if (!spec) return null;
  const parts = spec.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [x, y, w, h] = parts;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** `assets/clip.mp4#t=12` is a request for a frame, not a different file. */
function withoutFragment(src: string): string {
  return src.replace(/#t=[^#]*$/, '');
}

function boxAttr(box: { x: number; y: number; w: number; h: number }): string {
  return `${box.x},${box.y},${box.w},${box.h}`;
}

export function uniqueId(preferred: string, used: Set<string>): string {
  const base = preferred.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'element';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
