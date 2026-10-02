import type { AgentOperation } from './agent.js';
import { MediaEffectSchema, MIRRORED_TEXT_STYLE_PROPERTIES, SlideSchema } from './deck.js';
import type { Deck, MediaEffect, Slide, SlideElement, TimelineEntry } from './deck.js';
import { fitAutoTextElement } from './autoFit.js';
import { KATEX_AUTO_RENDER_JS, KATEX_CSS, KATEX_JS } from './katexInline.js';
import { shapeSvg } from './shapeSvg.js';
import { applyTableColumnWidths } from './paragraphs.js';
import { layoutMaster, placeNewPlaceholders, syncSlideWithLayoutMaster, type FixedLayout } from './layoutMasters.js';
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
  /** `html` is a deck text box's own markup, read from inside the player's wrapper. */
  preformatted?: boolean;
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
  /** `data-base` / `data-base-ids`: what the export recorded (`pageStampOf`). */
  base?: string;
  baseIds?: string;
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
  // An escaped dollar shows as a dollar, but stays recognisably escaped: the
  // compile reads this page back into the deck, where a bare `$` would be
  // taken for a delimiter the next time anything renders it.
  const escaped: Text[] = [];
  const restore = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  while (restore.nextNode()) {
    const text = restore.currentNode as Text;
    if (text.data.includes(escapedDollar)) escaped.push(text);
  }
  for (const text of escaped) {
    const parts = text.data.split(escapedDollar);
    const pieces: Node[] = [];
    parts.forEach((part, index) => {
      if (index > 0) {
        const dollar = doc.createElement('span');
        dollar.setAttribute('data-deckwerk-escaped-dollar', '');
        dollar.textContent = '$';
        pieces.push(dollar);
      }
      if (part) pieces.push(doc.createTextNode(part));
    });
    text.replaceWith(...pieces);
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
  /* A deck object's box is its geometry: a margin a theme class gives it
     would place it somewhere its numbers do not say, and the next save would
     store that place and the player add the margin again — drifting the
     object by the margin on every round trip. The player resets it too. */
  [data-element-id] { margin: 0 !important; }
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
 * Where `apply --after <ref>` puts new slides: after the slide the ref names —
 * its id or its 1-based number — or, for `0`, before the first slide (null,
 * the transaction's "at the start"). Undefined when the ref names no slide.
 *
 * Numbers are how people name slides, so "after slide 0" is the natural way to
 * ask for a new opening slide; without it an agent asked for one had to insert
 * after slide 1 and then swap the two by hand.
 */
export function insertionAnchor(deck: Deck, ref: string): string | null | undefined {
  // An exact id wins: an imported deck may carry an id that is all digits.
  if (deck.slides.some((slide) => slide.id === ref)) return ref;
  if (!/^\d+$/.test(ref)) return undefined;
  const number = Number(ref);
  return number === 0 ? null : deck.slides[number - 1]?.id;
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
  /** What the page's slides were when it was exported (`pageBases`), if it says. */
  bases: Map<string, SlideBase> = new Map(),
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

  // A slide the file replaces keeps what its markup cannot say, and one that
  // comes back saying nothing new is not replaced at all: re-saving an export
  // untouched must not land a change in everyone's History.
  const previousSlides = new Map(deck.slides.map((slide) => [slide.id, slide]));
  const replace = (slide: Slide, into: AgentOperation[]): void => {
    const previous = previousSlides.get(slide.id)!;
    const next = carrySlideState(previous, slide, bases.get(slide.id));
    if (!sameSlideContent(previous, next)) into.push({ op: 'replaceSlide', slideId: slide.id, slide: next });
  };

  if (scope === null) {
    const operations: AgentOperation[] = [];
    const inserted: Slide[] = [];
    for (const slide of slides) {
      if (existingIds.has(slide.id)) replace(slide, operations);
      else inserted.push(slide);
    }
    if (inserted.length > 0) operations.push({ op: 'insertSlides', afterSlideId: after, slides: inserted });
    return operations;
  }

  if (new Set(scope).size !== scope.length) throw new Error('HTML scope contains duplicate slide ids');
  const unknownScope = scope.find((id) => !existingIds.has(id));
  if (unknownScope) {
    // In a shared deck this is ordinary: somebody deleted a slide this page
    // was exported with. Saving the page cannot say whether that slide should
    // come back, so it is refused — with what to do instead.
    throw new Error(`This page was exported with slide ${unknownScope}, which is no longer in the deck`
      + ' (it was deleted since). Export the slides again with inspect --html and redo the edit there;'
      + ' to bring the slide back, add its section to a new page without a data-slide-id.');
  }

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
    if (existingIds.has(slide.id)) replace(slide, operations);
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
 * A compiled slide, completed with what its authoring page cannot say.
 *
 * A page carries geometry, text, media and appear builds. A slide also holds
 * things that have no markup at all: its speaker notes, whether it is skipped,
 * the comments people left on it and on its objects, and builds that are not
 * appearances (a video that plays on a click, a disappear, a class toggle).
 * Replacing the slide with the page as compiled deleted every one of them —
 * an agent tidying a slide's wording un-skipped it, wiped its notes and closed
 * its review threads. Whatever the page cannot express comes from the slide it
 * replaces.
 */
export function carrySlideState(previous: Slide, compiled: Slide, base?: SlideBase): Slide {
  // Somebody else changed this slide after the page was exported: merge
  // object by object rather than let the page's stale copy undo their work.
  const concurrent = base !== undefined && slideBase(previous).slide !== base.slide
    ? mergedWithConcurrentEdits(previous, compiled, base)
    : null;
  const next = structuredClone(concurrent?.slide ?? compiled);
  if (!next.notes && previous.notes) next.notes = previous.notes;
  if (next.skipped === undefined && previous.skipped !== undefined) next.skipped = previous.skipped;
  if (!next.comments?.length && previous.comments?.length) next.comments = structuredClone(previous.comments);
  // A page can say "true" but never an explicit "false": an absent attribute
  // and a stored `false` mean the same, and the stored form is the deck's.
  if (next.morphFromPrevious === undefined && previous.morphFromPrevious === false) next.morphFromPrevious = false;
  if (next.layoutBackgroundInherited === undefined && previous.layoutBackgroundInherited !== undefined
    && next.layout === previous.layout) {
    next.layoutBackgroundInherited = previous.layoutBackgroundInherited;
  }
  next.elements = reconciledElements(previous, next.elements);
  next.timeline = mergedTimeline(previous, next, concurrent?.theirBuilds);
  return next;
}

/**
 * A page saved over a slide somebody changed since it was exported.
 *
 * Replacing the slide with the page undid their work wholesale: a person
 * rewords a heading while their agent tightens the body from an export a
 * minute old, the agent saves, and the heading is back as it was. The export
 * recorded what each object was (`slideBase`), so the save can tell who
 * changed what: an object the page left as exported but somebody changed
 * since keeps their version; one the page changed takes the page's, theirs
 * or not (the later edit wins, as anywhere in a session); one deleted since
 * stays deleted; one added since stays; one the page removed goes. The
 * slide's own properties merge the same way.
 */
function mergedWithConcurrentEdits(
  current: Slide,
  page: Slide,
  base: SlideBase,
): { slide: Slide; theirBuilds: Set<string> } {
  const theirs = new Map(current.elements.map((element) => [element.id, element]));
  const onPage = new Set(page.elements.map((element) => element.id));
  const exported = new Set(base.ids);
  const theirBuilds = new Set<string>();
  const elements: SlideElement[] = [];
  for (const element of page.elements) {
    const was = base.elements.get(element.id);
    const now = theirs.get(element.id);
    if (was && !now) continue;
    // Left as exported here, changed by somebody since: theirs stands.
    if (was && now && matchesBase(page, element, was) && !matchesBase(current, now, was)) {
      elements.push(structuredClone(now));
      theirBuilds.add(now.id);
      continue;
    }
    elements.push(element);
  }
  for (const element of current.elements) {
    if (onPage.has(element.id) || exported.has(element.id)) continue;
    elements.push(structuredClone(element));
    theirBuilds.add(element.id);
  }
  const slide: Slide = { ...page, elements };
  if (propsFingerprint(current) !== base.props && propsFingerprint(page) === base.props) {
    for (const key of SLIDE_PROPS) {
      if (current[key] === undefined) delete slide[key];
      else (slide as Record<string, unknown>)[key] = structuredClone(current[key]);
    }
  }
  return { slide, theirBuilds };
}

/** Whether an object on `slide` is still what the export recorded. */
function matchesBase(slide: Slide, element: SlideElement, base: ElementBase): boolean {
  return elementFingerprint(element, buildSpec(slide, element.id)) === base.content
    && (['x', 'y', 'w', 'h', 'rot'] as const).every((key, index) =>
      Math.abs(element[key] - base.box[index]) <= GEOMETRY_TOLERANCE);
}

/**
 * The page's objects, reconciled with the ones they were exported from.
 *
 * A browser measures in 1/64ths of a pixel, so a box at x 145.92 comes back
 * at 145.91; a page cannot write an explicit `false`; an HTML region's
 * captured stylesheet and a master decoration's link are not markup at all.
 * None of that is an edit, yet each made an untouched object a "change", and
 * every save rewrote every object on every slide it touched — the round trip
 * drifting the deck a hundredth of a pixel at a time. So an object that comes
 * back saying what it said is kept exactly as the deck holds it; one the
 * author did change keeps what its markup cannot carry, and its measured
 * edges snap back to where they were when they moved less than the browser
 * can resolve.
 */
function reconciledElements(previous: Slide, compiled: SlideElement[]): SlideElement[] {
  const before = new Map(previous.elements.map((element) => [element.id, element]));
  const reconciled = compiled.map((element) => {
    const old = before.get(element.id);
    if (!old || old.type !== element.type) return element;
    if (sameElement(old, element)) return { ...structuredClone(old), z: element.z };
    const next: Record<string, unknown> = { ...element };
    for (const key of ['x', 'y', 'w', 'h', 'rot'] as const) {
      if (Math.abs(element[key] - old[key]) <= GEOMETRY_TOLERANCE) next[key] = old[key];
    }
    for (const [key, value] of Object.entries(old)) {
      if ((value === false || value === null) && next[key] === undefined) next[key] = value;
    }
    if (old.comments?.length && !element.comments?.length) next.comments = structuredClone(old.comments);
    if (old.layoutMasterId && !element.layoutMasterId) next.layoutMasterId = old.layoutMasterId;
    // A region's captured stylesheet and whether it renders isolated are the
    // deck object's, not its markup's: a legacy region came back sandboxed.
    if (old.type === 'html' && element.type === 'html') {
      next.css = old.css;
      next.sandboxed = old.sandboxed;
    }
    return next as SlideElement;
  });
  // Paint order is the page's; the numbers are the deck's while the order holds.
  const order = (elements: SlideElement[]) => elements
    .map((element, index) => ({ element, index }))
    .sort((a, b) => a.element.z - b.element.z || a.index - b.index)
    .map(({ element }) => element.id);
  const unchangedOrder = reconciled.length === previous.elements.length
    && order(reconciled).join('\0') === order(previous.elements).join('\0');
  return unchangedOrder
    ? reconciled.map((element) => ({ ...element, z: before.get(element.id)!.z }))
    : reconciled;
}

/** Less than a browser's 1/64 px layout unit, plus the compile's rounding to hundredths. */
const GEOMETRY_TOLERANCE = 0.02;

/**
 * Whether a compiled object says what the deck's object says, as far as a
 * page can. Set aside: its z (paint order is compared per slide), and what is
 * never markup — its comments, a master decoration's link, an HTML region's
 * captured stylesheet and isolation. Allowed: the measurement slack and the
 * `false`-or-`null`-versus-absent equivalence above.
 */
function sameElement(old: SlideElement, compiled: SlideElement): boolean {
  const ignored = new Set(['z', 'comments', 'layoutMasterId', ...(old.type === 'html' ? ['css', 'sandboxed'] : [])]);
  const keys = new Set([...Object.keys(old), ...Object.keys(compiled)]);
  for (const key of keys) {
    if (ignored.has(key)) continue;
    const a = (old as Record<string, unknown>)[key];
    const b = (compiled as Record<string, unknown>)[key];
    if (typeof a === 'number' && typeof b === 'number' && ['x', 'y', 'w', 'h', 'rot'].includes(key)) {
      if (Math.abs(a - b) > GEOMETRY_TOLERANCE) return false;
      continue;
    }
    // `false` and `null` are what a page cannot write; absent says the same.
    if ((a === false || a === null) && b === undefined) continue;
    if (a === undefined && (b === false || b === null)) continue;
    if (sortedJson(a) !== sortedJson(b)) return false;
  }
  return true;
}

/** JSON with every object's keys in order: the order a record was written in says nothing. */
function sortedJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, inner: unknown) => (
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner
  ));
}

/**
 * The replaced slide's builds, in their order, with the page deciding which
 * objects appear and on what trigger.
 *
 * `data-build` says only "this object appears, on this trigger", and a page's
 * document order is its paint order, not its build order. So the page is
 * authoritative for *which* objects have an appear build and how it is
 * triggered; the order of the steps, a by-paragraph reveal, and every entry
 * that is not an appearance come from the slide being replaced, for objects
 * still on it. Builds the page adds follow the existing ones, in document
 * order.
 */
function mergedTimeline(previous: Slide, compiled: Slide, theirs = new Set<string>()): TimelineEntry[] {
  const present = new Set(compiled.elements.map((element) => element.id));
  const authored = new Map<string, TimelineEntry>();
  for (const entry of compiled.timeline) {
    // An object kept as somebody else left it keeps the builds they gave it.
    if (theirs.has(entry.action.target)) continue;
    if (entry.action.type === 'appear' && !authored.has(entry.action.target)) authored.set(entry.action.target, entry);
  }
  const claimed = new Set<string>();
  const merged: TimelineEntry[] = [];
  for (const entry of previous.timeline) {
    const { target } = entry.action;
    if (!present.has(target)) continue;
    const page = entry.action.type === 'appear' ? authored.get(target) : undefined;
    // The page took the build off this object.
    if (entry.action.type === 'appear' && !page && !theirs.has(target)) continue;
    if (page && !claimed.has(target)) {
      claimed.add(target);
      const kept = page.trigger.on === entry.trigger.on && entry.trigger.ref && present.has(entry.trigger.ref)
        ? entry.trigger.ref : null;
      merged.push({ ...structuredClone(entry), trigger: { ...page.trigger, ref: page.trigger.ref ?? kept } });
      continue;
    }
    // Not something a page can state — another kind of step, or a second
    // appearance of the same object — so it stands as it was, unless it
    // waits on an object the page removed and so could never fire.
    if (entry.trigger.ref && !present.has(entry.trigger.ref)) continue;
    merged.push(structuredClone(entry));
  }
  const ids = new Set(merged.map((entry) => entry.id));
  for (const entry of compiled.timeline) {
    if (theirs.has(entry.action.target)) continue;
    if (entry.action.type === 'appear' && claimed.has(entry.action.target)) continue;
    merged.push({ ...entry, id: uniqueId(entry.id, ids) });
  }
  return merged;
}

/* --- what a page was exported from ---------------------------------------- */

/** What an export recorded about one object: its content, and its box exactly. */
export interface ElementBase {
  content: string;
  /** x, y, w, h, rot — compared with the measuring slack, never hashed. */
  box: number[];
}

/**
 * What an export recorded about one slide, so that a save can tell the edits
 * its page makes from edits somebody else made meanwhile. Short fingerprints,
 * written into the page as `data-base` attributes — not the slide itself,
 * which would double the size of every export an agent reads.
 */
export interface SlideBase {
  /** Everything a page can say about the slide. */
  slide: string;
  /** The slide's own properties (name, background, layout, Morph). */
  props: string;
  /** Every object the slide held. */
  ids: string[];
  elements: Map<string, ElementBase>;
}

const SLIDE_PROPS = ['name', 'background', 'layout', 'morphFromPrevious', 'morphDuration'] as const;

export function slideBase(slide: Slide): SlideBase {
  const elements = new Map(slide.elements.map((element) => [element.id, {
    content: elementFingerprint(element, buildSpec(slide, element.id)),
    box: [element.x, element.y, element.w, element.h, element.rot],
  }]));
  const props = propsFingerprint(slide);
  const ranked = [...slide.elements]
    .map((element, index) => ({ element, index }))
    .sort((a, b) => a.element.z - b.element.z || a.index - b.index)
    .map(({ element }) => `${element.id}:${elements.get(element.id)!.content}@${elements.get(element.id)!.box.join(',')}`);
  return {
    slide: fingerprint(`${props}|${ranked.join('|')}|${sortedJson(slide.timeline)}`),
    props,
    ids: slide.elements.map((element) => element.id),
    elements,
  };
}

function propsFingerprint(slide: Slide): string {
  return fingerprint(sortedJson(Object.fromEntries(SLIDE_PROPS
    .map((key) => [key, slide[key] === false ? undefined : slide[key]])))!);
}

/**
 * An object's content as a page states it: not its box (compared with slack
 * instead), z, comments or what its markup never carries; `false` and `null`
 * as good as absent; and its appearance build, which the page states too.
 */
function elementFingerprint(element: SlideElement, build: string): string {
  const form: Record<string, unknown> = { ...element, build };
  for (const key of ['x', 'y', 'w', 'h', 'rot', 'z', 'comments', 'layoutMasterId', 'css', 'sandboxed']) delete form[key];
  for (const [key, value] of Object.entries(form)) if (value === false || value === null) delete form[key];
  return fingerprint(sortedJson(form)!);
}

/** An object's first appearance, as `data-build` states it. */
function buildSpec(slide: Slide, elementId: string): string {
  const entry = slide.timeline.find((candidate) => candidate.action.type === 'appear' && candidate.action.target === elementId);
  return entry ? `${entry.trigger.on}+${entry.trigger.delay}@${entry.trigger.ref ?? ''}` : '';
}

/** cyrb53: a quick 53-bit string hash, the same in Node and in any browser. */
function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The `data-base` attributes an export writes, per slide and per object. */
export interface PageStamp {
  [slideId: string]: { slide: string; ids: string; elements: Record<string, string> };
}

export function pageStampOf(slides: Slide[]): PageStamp {
  const stamp: PageStamp = {};
  for (const slide of slides) {
    const base = slideBase(slide);
    stamp[slide.id] = {
      slide: `${base.slide}.${base.props}`,
      ids: JSON.stringify(base.ids),
      elements: Object.fromEntries([...base.elements].map(([id, element]) =>
        [id, `${element.content}@${element.box.join(',')}`])),
    };
  }
  return stamp;
}

/** What a compiled page says its slides were when it was exported. */
export function pageBases(measured: MeasuredSlide[]): Map<string, SlideBase> {
  const bases = new Map<string, SlideBase>();
  for (const slide of measured) {
    const [whole, props] = (slide.base ?? '').split('.');
    if (!slide.id || !whole || !props) continue;
    let ids: string[] = [];
    try {
      const parsed: unknown = JSON.parse(slide.baseIds ?? '[]');
      if (Array.isArray(parsed)) ids = parsed.filter((id): id is string => typeof id === 'string');
    } catch {
      continue;
    }
    const elements = new Map<string, ElementBase>();
    for (const node of slide.nodes) {
      const match = /^([^@]+)@(.+)$/.exec(node.dataset.base ?? '');
      const box = match?.[2].split(',').map(Number);
      if (!node.elementId || !match || !box || box.length !== 5 || box.some((value) => !Number.isFinite(value))) continue;
      elements.set(node.elementId, { content: match[1], box });
    }
    bases.set(slide.id, { slide: whole, props, ids, elements });
  }
  return bases;
}

/**
 * Bring a page's `data-base` attributes up to what the page itself now says
 * (`pageStampOf` of its compiled slides).
 *
 * The next save of the same page must be compared with what this one said,
 * not with the original export — or the agent's own earlier save reads as
 * somebody else's edit. And not with the deck either: where this save kept a
 * person's newer version of an object, the page still holds the old one, and
 * stamped with theirs it would read as the agent's edit and undo it.
 */
export function stampPage(html: string, stamp: PageStamp): string {
  const elementBases = new Map<string, string>();
  for (const entry of Object.values(stamp)) {
    for (const [id, base] of Object.entries(entry.elements)) elementBases.set(id, base);
  }
  const bodyAt = Math.max(0, html.search(/<body[\s>]/i));
  const body = html.slice(bodyAt).replace(/<[a-zA-Z][^>]*>/g, (tag) => {
    const slideId = attributeValue(tag, 'data-slide-id');
    if (slideId !== null && /^<section\b/i.test(tag) && stamp[slideId]) {
      return withAttribute(withAttribute(tag, 'data-base', stamp[slideId].slide), 'data-base-ids', stamp[slideId].ids);
    }
    const elementId = attributeValue(tag, 'data-element-id');
    if (elementId !== null && elementBases.has(elementId)) return withAttribute(tag, 'data-base', elementBases.get(elementId)!);
    return tag;
  });
  return html.slice(0, bodyAt) + body;
}

function attributeValue(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return match ? decodeHtmlAttribute(match[1]) : null;
}

function withAttribute(tag: string, name: string, value: string): string {
  const attribute = `${name}="${escape(value)}"`;
  const existing = new RegExp(`\\s${name}\\s*=\\s*"[^"]*"`, 'i');
  if (existing.test(tag)) return tag.replace(existing, () => ` ${attribute}`);
  return tag.replace(/\s*(\/?)>$/, (_end, slash: string) => ` ${attribute}${slash ? ' /' : ''}>`);
}

/**
 * Whether two versions of a slide say the same thing.
 *
 * Paint order is what z means, not the numbers: an export writes objects in z
 * order and the compile numbers them 1, 2, 3…, so a slide whose objects sat at
 * z 10 and 20 comes back at 1 and 2 having changed nothing. Comparing ranks —
 * and ignoring the order keys happen to be written in — is what lets an
 * untouched export re-sync as no change rather than a replacement.
 */
export function sameSlideContent(left: Slide, right: Slide): boolean {
  return canonicalSlideJson(left) === canonicalSlideJson(right);
}

function canonicalSlideJson(slide: Slide): string {
  const parsed = SlideSchema.parse(slide);
  const elements = parsed.elements
    .map((element, index) => ({ element, index }))
    .sort((a, b) => a.element.z - b.element.z || a.index - b.index)
    .map(({ element }, rank) => ({ ...element, z: rank + 1 }));
  return sortedJson({ ...parsed, elements })!;
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
  // Freed, but not free to mint: a new section earlier in the page than a
  // slide it replaces was handed that slide's id, and the page then named one
  // slide twice. Ids the page carries are reserved for the objects carrying them.
  const reserved = new Set(measured.flatMap((slide) => [
    ...(slide.id ? [slide.id] : []),
    ...slide.nodes.flatMap((node) => (node.elementId ? [node.elementId] : [])),
  ]));

  return measured.map((slide, index) => {
    const built = slideFromMeasured(slide, {
      slideId: slide.id ?? nextSlideId(used, index, reserved),
      usedIds: used,
      reservedIds: reserved,
    });
    const layout = slide.layout;
    if (layout === undefined) return built;
    if (!FIXED_LAYOUTS.includes(layout as FixedLayout)) {
      throw new HtmlAuthoringError(`Unknown data-layout "${layout}" on a slide. Use ${FIXED_LAYOUTS.join(', ')}.`);
    }
    // A slide that already wears this layout is coming back from its own
    // export, where every box is already where the slide has it.
    const existing = deck.slides.find((candidate) => candidate.id === built.id);
    if (existing && existing.layout === layout) {
      placeNewPlaceholders(built, layout as FixedLayout, layoutMaster(deck, layout as FixedLayout), existing);
      return built;
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

function nextSlideId(used: Set<string>, index: number, reserved: Set<string> = new Set()): string {
  let candidate = `slide-${used.size + index + 1}`;
  for (let n = 1; used.has(candidate) || reserved.has(candidate); n++) candidate = `slide-${used.size + index + 1}-${n}`;
  used.add(candidate);
  return candidate;
}

/** Turn one measured slide into a deck slide, ids minted where absent. */
export function slideFromMeasured(
  measured: MeasuredSlide,
  opts: { slideId: string; usedIds: Set<string>; reservedIds?: Set<string> },
): Slide {
  const timeline: TimelineEntry[] = [];
  const elements: SlideElement[] = [];

  measured.nodes.forEach((node, index) => {
    const id = node.elementId
      ? uniqueId(node.elementId, opts.usedIds)
      : uniqueId(`${opts.slideId}-${node.tag}-${index + 1}`, opts.usedIds, opts.reservedIds);
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
    // A master decoration's copy keeps its link, or the next layout change
    // added a fresh copy beside it under the same id.
    ...(node.dataset.layoutMasterId ? { layoutMasterId: node.dataset.layoutMasterId } : {}),
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
      ...(Number.parseFloat(node.dataset.arrowSize ?? '') > 0
        ? { arrowSize: Number.parseFloat(node.dataset.arrowSize ?? '') } : {}),
      ...(node.dataset.control ? { control: { x: cx, y: cy } } : {}),
      ...(Number.isFinite(Number.parseFloat(node.dataset.braceDepth ?? ''))
        ? { braceDepth: Number.parseFloat(node.dataset.braceDepth ?? '') } : {}),
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
      // A deck text box's own markup is kept exactly: the player shows it
      // pre-wrap, so even a trailing space is something it holds.
      : node.preformatted ? node.html : node.html.trim(),
    align: alignFrom(node.attrs.textAlign),
    valign: valignFrom(node.dataset.valign),
    ...(contentStyle ? { contentStyle } : {}),
    ...(node.dataset.autofit !== undefined ? { autoFit: node.dataset.autofit !== 'false' } : {}),
    ...(node.dataset.autoSize === 'true' ? { autoSize: true } : {}),
    ...(node.dataset.layoutSlot === 'title' || node.dataset.layoutSlot === 'body'
      ? {
        layoutPlaceholder: node.dataset.layoutSlot,
        // A slot the page names for a new box brings that role's type with it;
        // a deck object coming back from its export keeps the classes it has —
        // a title box restyled as a caption stayed a caption.
        class: node.elementId !== null || base.class.includes(`role-${node.dataset.layoutSlot}`)
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
 * `data-build-effect="dissolve"` fades the element in, `"blur"` brings it into
 * focus as it fades, and on a line or arrow
 * `data-build-effect="draw"` draws it in; `data-build-duration` is the time in ms.
 *
 * Builds have no CSS analogue, so they ride on data attributes rather than in
 * a side-channel the author has to keep in sync with the markup.
 */
function isEffectName(value: unknown): value is 'draw' | 'dissolve' | 'blur' {
  return value === 'draw' || value === 'dissolve' || value === 'blur';
}

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
  // `data-build-effect` draws a line or arrow in ("draw") or fades anything in
  // ("dissolve"); its time rides beside it.
  const effect = node.dataset.buildEffect;
  const animated = effect === 'draw' || effect === 'dissolve' || effect === 'blur';
  const duration = Number(node.dataset.buildDuration);
  return {
    id: `${elementId}-build-${index + 1}`,
    trigger: { on, ref: node.dataset.buildRef ?? null, delay: Number(delay ?? 0) || 0 },
    action: {
      type: 'appear',
      target: elementId,
      value: animated ? effect : null,
      ...(animated && Number.isFinite(duration) && duration >= 0 ? { duration } : {}),
    },
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
  // An object's first appearance is the one its markup states; the compile
  // pairs the page's build with that same entry (`carrySlideState`).
  const builds = new Map<string, TimelineEntry>();
  for (const entry of slide.timeline) {
    if (entry.action.type === 'appear' && !builds.has(entry.action.target)) builds.set(entry.action.target, entry);
  }

  // What this slide is now, so a save of the page can tell its own edits
  // from edits somebody else makes meanwhile.
  const stamp = pageStampOf([slide])[slide.id];
  const body = [...slide.elements]
    .sort((a, b) => a.z - b.z)
    .map((element) => elementToHtml(element, builds.get(element.id), stamp.elements[element.id]))
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
    + ` data-base="${stamp.slide}" data-base-ids="${escape(stamp.ids)}"`
    + (slide.name ? ` data-name="${escape(slide.name)}"` : '')
    + (slide.layout ? ` data-layout="${slide.layout}"` : '')
    + (slide.morphFromPrevious ? ' data-morph-from-previous="true"' : '')
    + (slide.morphDuration !== undefined ? ` data-morph-duration="${slide.morphDuration}"` : '')
    + `${background}>\n${body}\n</section>\n`;
}

function elementToHtml(element: SlideElement, build?: TimelineEntry, base?: string): string {
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
    element.layoutMasterId ? `data-layout-master-id="${escape(element.layoutMasterId)}"` : '',
    base ? `data-base="${escape(base)}"` : '',
    build ? `data-build="${build.trigger.on}${build.trigger.delay ? `+${build.trigger.delay}` : ''}"` : '',
    build?.trigger.ref ? `data-build-ref="${escape(build.trigger.ref)}"` : '',
    build && isEffectName(build.action.value)
      ? `data-build-effect="${build.action.value}"` : '',
    build && isEffectName(build.action.value)
      && build.action.duration !== undefined
      ? `data-build-duration="${build.action.duration}"` : '',
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
        + `${element.autoSize ? ' data-auto-size="true"' : ''}`
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
      // A bare <video> means the deck's defaults (all three on), so a flag a
      // deck video has off is said out loud, or the round trip turned it on.
      const off = `${element.loop ? '' : ' data-loop="false"'}${element.muted ? '' : ' data-muted="false"'}`
        + `${element.autoplay ? '' : ' data-autoplay="false"'}`;
      return `  <video ${attrs} src="${escape(mediaFragment(element))}"${trim}${flags}${off}`
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
        + (element.arrowSize !== undefined ? ` data-arrow-size="${element.arrowSize}"` : '')
        + (element.control ? ` data-control="${element.control.x},${element.control.y}"` : '')
        + (element.braceDepth !== undefined ? ` data-brace-depth="${element.braceDepth}"` : '')
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
      return `  <div ${attrs} data-element="html"`
        + `${element.type === 'html' && element.fallbackReason ? ` data-fallback-reason="${escape(element.fallbackReason)}"` : ''}`
        + ` ${styleAttr(position, inline)}>${'html' in element ? element.html : ''}</div>`;
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

function shapeKind(value: string | undefined): 'rect' | 'ellipse' | 'line' | 'arrow' | 'path' | 'brace' {
  const kinds = ['rect', 'ellipse', 'line', 'arrow', 'path', 'brace'] as const;
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

export function uniqueId(preferred: string, used: Set<string>, reserved?: Set<string>): string {
  const base = preferred.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'element';
  let id = base;
  for (let n = 2; used.has(id) || reserved?.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
