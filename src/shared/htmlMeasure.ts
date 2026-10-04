import { renameRetiredDataAttributes } from './fieldAliases.js';
import { authoringCss, KATEX_PAGE_HTML, type MeasuredNode, type MeasuredSlide } from './htmlSlides.js';

/**
 * The browser half of HTML authoring: assemble a page, walk it, measure it.
 *
 * There are two browsers that can do this — the editor's own renderer, when it
 * is open, and a headless Electron window when it is not — and they must agree
 * to the pixel, or a slide would move depending on who compiled it. So both the
 * page and the walk live here, once. `measureSlides` is called directly by the
 * renderer against an iframe's document; `measureSlidesSource` serialises the
 * very same function for `webContents.executeJavaScript`, which is why every
 * helper it uses is nested inside it rather than shared at module scope.
 */

export interface AuthoringPage {
  authored: string;
  /** `src/renderer/player/type.css`, the semantic type rules the player uses. */
  typeCss: string;
  /** The deck's own `theme.css`, as text. */
  theme: string;
  /** How an exported file links that stylesheet, so the link can be resolved here. */
  themeHref?: string;
  canvas: { w: number; h: number };
  /** What deck-relative asset paths resolve against: a `file://` or `deck://` root. */
  base: string;
}

/**
 * The page the compiler measures.
 *
 * An exported authoring file is already a complete page — canvas box, type
 * rules, its own link to the deck's `theme.css` — because it has to look like
 * the slide when the author opens it in a browser. Measuring it is therefore
 * measuring *their* document, with one change: the `<base>` is retargeted from
 * the path the file sits at to wherever this browser can reach the deck from
 * (a `file://` folder offline, the `deck:` scheme inside the editor). Nothing
 * else is injected, so what the author saw is what the deck gets.
 *
 * A hand-written fragment gets the same page built around it instead, with the
 * theme passed in as text rather than fetched.
 */
export function authoringPageHtml(input: AuthoringPage): string {
  // Retired `data-*` spellings are canonicalised here, on the way into the
  // page, because `measureSlides` is stringified into that page and cannot
  // import the alias table.
  const page = { ...input, authored: renameRetiredDataAttributes(input.authored) };
  if (/<html[\s>]/i.test(page.authored)) {
    const structured = withStructuralCss(withBase(page.authored, page.base), page);
    const linkedTheme = themeLink(page.themeHref).test(structured);
    const themed = inlineTheme(structured, page.themeHref, page.theme, false);
    // An exported deck page — the theme linked, and the deck's own objects in
    // it — must remain theme-driven. Anything else is an authored document
    // that owns its CSS, whether or not it links theme.css to borrow the
    // deck's look: an agent's draft with `h1 { font-size: 80px }` in its own
    // <style> means that heading, and treating the page as an export kept
    // only the inline declarations and silently dropped the rest. Nor may the
    // deck theme be imported after a standalone page's <style> blocks, which
    // would change the design before we even start converting it.
    // A slide with no objects exports with no `data-element-id` at all; the
    // `data-canvas` every exported section carries says "deck page" then, or
    // the theme's computed background was frozen into the empty slide. (Not
    // the scope marker: a `new` page is stamped with one after its first
    // save, and must not change modes between its first compile and its
    // second.)
    const exported = linkedTheme
      && (/\bdata-element-id\s*=/.test(structured) || /<section\b[^>]*\sdata-canvas\s*=/i.test(structured));
    return withKatex(exported ? themed : markIndependentDocument(themed));
  }
  // Same order as the player: structural defaults, then the semantic type
  // fallback, then the deck's own theme, which wins.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<base href="${page.base}">
<style>${authoringCss(page.canvas)}</style>
<style>${page.typeCss}</style>
<style>${page.theme}</style>
${KATEX_PAGE_HTML}
</head>
<body>
${page.authored}
</body>
</html>
`;
}

/**
 * A document that predates the inlined KaTeX — an old export, a hand-written
 * page — must still be measured with its maths rendered, or its geometry
 * would depend on which vintage of file it came in as.
 */
function withKatex(html: string): string {
  if (html.includes('data-katex-inline')) return html;
  // Function-form replacement, and not as a nicety: the KaTeX bundle is full
  // of `$$`/`$&` sequences, which a *string* replacement would interpret as
  // replacement patterns and quietly corrupt the injected script — the maths
  // then simply never rendered, and every equation in a hand-authored full
  // document was measured at its raw-text height.
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, () => `${KATEX_PAGE_HTML}\n</head>`);
  return html;
}

/**
 * The structural rules a page cannot look like a slide without: the canvas
 * box, `box-sizing`, the semantic type fallback. An exported file carries them
 * already; a full document an author wrote from scratch does not, and without
 * them its slides measure against browser defaults — visibly, as boxes a few
 * pixels off and text at the wrong size.
 */
function withStructuralCss(html: string, page: AuthoringPage): string {
  // The selector below only ever appears inside the authoring CSS itself.
  if (html.includes('section.slide, [data-slide-id]')) return html;
  const style = `<style>${authoringCss(page.canvas)}</style>\n<style>${page.typeCss}</style>`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (open) => `${open}\n${style}`);
  }
  return html;
}

/**
 * Turn the exported file's link to `theme.css` into the stylesheet itself.
 *
 * The author's browser should fetch the deck's theme — that is what makes the
 * file look like the slide when they open it. A compile should not: fetching is
 * asynchronous, and measuring one frame too early sizes every heading at the
 * browser default and bakes that into the deck. The compiler already holds the
 * theme text, and in the editor it holds the *live* one, unsaved edits and all,
 * so it resolves the link itself and measures something deterministic.
 */
function themeLink(href: string | undefined): RegExp {
  const name = (href ?? 'theme.css').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`<link\\b[^>]*href=["']\\.?/?${name}["'][^>]*>`, 'i');
}

function inlineTheme(
  html: string,
  href: string | undefined,
  theme: string,
  injectWhenMissing = true,
): string {
  // Function-form replacements: theme CSS may legitimately contain `$`
  // sequences, which a string replacement would treat as patterns.
  const style = `<style>${theme}</style>`;
  const link = themeLink(href);
  if (link.test(html)) return html.replace(link, () => style);
  if (!injectWhenMissing) return html;
  // No link to resolve — the deck's theme still governs the deck, so it goes
  // in last, where the author's own rules can still be more specific than it.
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, () => `${style}\n</head>`);
  return html;
}

function markIndependentDocument(html: string): string {
  if (/\bdata-slide-editor-independent\s*=/.test(html)) return html;
  return html.replace(/<html\b([^>]*)>/i,
    (_match, attrs: string) => `<html${attrs} data-slide-editor-independent="true">`);
}

/**
 * Point a document's `<base>` somewhere else, adding one if it has none.
 *
 * The exported file resolves its assets relative to where it is saved, which
 * is right for the author's browser and wrong everywhere else: the offline
 * compiler assembles its page in a temp folder, and the editor writes it into
 * a frame whose own URL is the editor's. Both reach the deck by a different
 * route, and this is where that route is applied.
 */
export function withBase(html: string, base: string): string {
  const tag = `<base href="${base}">`;
  if (/<base[\s>]/i.test(html)) return html.replace(/<base\b[^>]*>/i, tag);
  if (/<head[\s>]/i.test(html)) return html.replace(/<head\b[^>]*>/i, (match) => `${match}\n${tag}`);
  return html.replace(/<html\b[^>]*>/i, (match) => `${match}\n<head>${tag}</head>`);
}

/**
 * The walk.
 *
 * A node becomes a slide object when it is a leaf of the *content* tree: media,
 * or a block that contains no further blocks. Everything above that is layout
 * — flex rows, grids, wrappers — and exists only to position its children, so
 * it contributes geometry and then disappears. That rule is what lets an agent
 * write ordinary nested markup and get flat, editable slide objects back.
 *
 * Self-contained on purpose: it is serialised with `Function.prototype
 * .toString` for the offscreen window, so a reference to anything outside this
 * body would arrive there undefined.
 */
export function measureSlides(doc: Document): MeasuredSlide[] {
  const view = doc.defaultView;
  if (!view) throw new Error('The document being measured has no window');
  const computed = (node: Element): CSSStyleDeclaration => view.getComputedStyle(node);
  const capturedCss = [...doc.styleSheets].flatMap((sheet) => {
    try { return [...sheet.cssRules].map((rule) => rule.cssText); } catch { return []; }
  }).join('\n');
  const independent = doc.documentElement.dataset.slideEditorIndependent === 'true';
  // jsdom accepts the pseudo-element overload but emits a noisy
  // "not implemented" diagnostic for every call. Real imports are measured
  // in Chromium, where the overload is available; unit tests simply skip this
  // optional native-shape promotion.
  const supportsPseudoComputedStyle = !/jsdom/i.test(view.navigator.userAgent);

  const COMPUTED_TEXT_STYLE = [
    'color', 'font-family', 'font-size', 'font-weight', 'font-style',
    'font-variant', 'letter-spacing', 'line-height', 'text-transform',
    'text-decoration', 'text-shadow', 'white-space', 'word-break',
    'overflow-wrap', 'writing-mode', 'text-orientation', 'list-style-type',
    'list-style-position', 'display', 'margin-top', 'margin-right',
    'margin-bottom', 'margin-left', '-webkit-text-stroke',
    '-webkit-text-stroke-width', '-webkit-text-stroke-color',
  ];
  const COMPUTED_BOX_STYLE = [
    'background-color', 'background-image', 'background-size',
    'background-position', 'background-repeat', 'background-clip',
    '-webkit-background-clip', '-webkit-text-fill-color', 'border-radius',
    'border', 'box-shadow', 'filter', 'mix-blend-mode', 'overflow', 'object-position',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  ];
  // A computed style always answers, so most of what it reports is the CSS
  // initial value rather than anything the author asked for. Baking those into
  // the element is not merely noise: an inline `line-height:normal` outranks
  // the deck's own typography for ever after, so a theme edit stops reaching
  // the text. Only declarations that actually say something are kept.
  // Only properties the deck's own baseline (`type.css`, and a theme's
  // `.element-text` rules) never sets. An initial value that the deck *would*
  // override is not noise but a measurement: dropping the browser's
  // `line-height:normal` handed imported text the deck's 1.28 instead and
  // moved every line on the slide.
  const INITIAL_COMPUTED: Record<string, string[]> = {
    'font-variant': ['normal'],
    'font-variant-ligatures': ['normal'],
    'text-shadow': ['none'],
    'writing-mode': ['horizontal-tb'],
    'text-orientation': ['mixed'],
    'background-size': ['auto', 'auto auto'],
    'background-position': ['0% 0%'],
    'background-repeat': ['repeat', 'repeat repeat'],
    'object-position': ['50% 50%'],
    'mix-blend-mode': ['normal'],
    'overflow': ['visible'],
    'display': ['inline'],
    '-webkit-background-clip': ['border-box'],
    'background-clip': ['border-box'],
    '-webkit-text-fill-color': ['currentcolor'],
  };
  const ignorableComputed = (property: string, value: string): boolean => {
    if (!value) return true;
    if (INITIAL_COMPUTED[property]?.includes(value)) return true;
    if (['background-image', 'box-shadow', 'filter'].includes(property) && value === 'none') return true;
    if (property.startsWith('padding-') && parseFloat(value) === 0) return true;
    if (property === 'border-radius' && value.split(/\s+/).every((part) => parseFloat(part) === 0)) return true;
    if (property === 'background-color'
      && (/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(value) || value === 'transparent')) return true;
    // `text-decoration` computes to a four-part value whose first word is the
    // line; "none solid rgb(...)" is simply the absence of one.
    if (property === 'text-decoration' && /^none\b/.test(value)) return true;
    // A zero-width border and a zero-width text stroke paint nothing, but they
    // arrive carrying a colour that reads like a deliberate one.
    if ((property === 'border' || property === '-webkit-text-stroke')
      && /^0(?:px)?\s/.test(value)) return true;
    if (property === '-webkit-text-stroke-width' && parseFloat(value) === 0) return true;
    if (property === 'display' && value === 'inline') return true;
    if (property.startsWith('margin-') && parseFloat(value) === 0) return true;
    return false;
  };
  /**
   * A computed `background-image` has already been resolved against the page,
   * so `assets/cover.jpg` arrives as an absolute `file://` or `deck://` URL.
   * Storing that in the deck breaks the moment the folder moves — the same
   * reason the slide background is read from the authored declaration.
   */
  const deckRelativeUrls = (value: string): string => {
    const base = doc.baseURI;
    return value.replace(/url\((["']?)([^"')]+)\1\)/g, (whole, quote, url: string) =>
      url.startsWith(base) ? `url(${quote}${url.slice(base.length)}${quote})` : whole);
  };

  const computedPresentation = (node: HTMLElement, includeText: boolean): Record<string, string> => {
    if (!independent) return {};
    const style = computed(node);
    const kept: Record<string, string> = {};
    const properties = includeText
      ? [...COMPUTED_TEXT_STYLE, ...COMPUTED_BOX_STYLE]
      : COMPUTED_BOX_STYLE;
    // The stroke colour only means anything with a width behind it, and the
    // fill colour only when it differs from the text colour it shadows.
    const strokeless = parseFloat(style.getPropertyValue('-webkit-text-stroke-width')) === 0;
    for (const property of properties) {
      const value = style.getPropertyValue(property).trim();
      if (strokeless && property.startsWith('-webkit-text-stroke')) continue;
      if (property === '-webkit-text-fill-color'
        && value === style.getPropertyValue('color').trim()) continue;
      // The `border` shorthand serialises to nothing when the four sides
      // disagree, which is exactly the case an accent rule (`border-left:6px
      // solid`) or a CSS triangle is. Reading only the shorthand dropped both
      // silently, so the sides answer when it cannot.
      if (property === 'border' && !value) {
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const width = style.getPropertyValue(`border-${side}-width`).trim();
          const kind = style.getPropertyValue(`border-${side}-style`).trim();
          if (!(parseFloat(width) > 0) || !kind || kind === 'none') continue;
          kept[`border-${side}`] = `${width} ${kind} `
            + `${style.getPropertyValue(`border-${side}-color`).trim()}`;
        }
        continue;
      }
      if (!ignorableComputed(property, value)) {
        kept[property] = property === 'background-image' ? deckRelativeUrls(value) : value;
      }
    }
    return kept;
  };

  const DEFAULT_DISPLAY: Record<string, string> = {
    li: 'list-item', ul: 'block', ol: 'block', p: 'block', div: 'block',
    h1: 'block', h2: 'block', h3: 'block', h4: 'block', h5: 'block', h6: 'block',
    section: 'block', article: 'block', header: 'block', footer: 'block',
    blockquote: 'block', figure: 'block', figcaption: 'block', pre: 'block',
    dl: 'block', dd: 'block', dt: 'block', table: 'table', tr: 'table-row',
    td: 'table-cell', th: 'table-cell', thead: 'table-header-group',
    tbody: 'table-row-group', tfoot: 'table-footer-group',
  };

  /**
   * Put a text box's markup back the way its author wrote it: finds the
   * maths in `root` now and returns the step that replaces it, in place.
   *
   * The page renders its maths before anything is measured, so equations get
   * their real geometry. KaTeX's output is two parallel trees (accessible
   * MathML and painted HTML) inside a span auto-render made for it: stored as
   * the text, the player carries and paints both, and the equation can never
   * again be edited as TeX — which is what an agent's untouched export did to
   * every formula it carried. Each formula goes back to the `$…$` / `$$…$$` it
   * was rendered from (KaTeX keeps the source in an annotation), and a dollar
   * the author escaped, `\$`, which renders as a plain `$`, is escaped again:
   * left bare, the next render pairs it with another dollar.
   */
  const authoredMathIn = (root: HTMLElement): (() => void) => {
    const tex = (node: Element): string | null =>
      node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? null;
    // Found now, replaced when asked: a caller may strip classes in between.
    const displays = [...root.querySelectorAll('.katex-display')];
    const inlines = [...root.querySelectorAll('.katex')].filter((math) => !math.closest('.katex-display'));
    const dollars = [...root.querySelectorAll('[data-deckwerk-escaped-dollar]')];
    const replace = (math: Element, source: string): void => {
      const wrapper = math.parentElement;
      const generated = wrapper !== null && wrapper !== root && wrapper.tagName === 'SPAN'
        && wrapper.attributes.length === 0 && wrapper.childNodes.length === 1;
      (generated ? wrapper : math).replaceWith(root.ownerDocument.createTextNode(source));
    };
    return () => {
      for (const display of displays) {
        const source = tex(display);
        if (source !== null) replace(display, `$$${source}$$`);
      }
      for (const inline of inlines) {
        const source = tex(inline);
        if (source !== null) replace(inline, `$${source}$`);
      }
      for (const dollar of dollars) dollar.replaceWith(root.ownerDocument.createTextNode('\\$'));
      root.normalize();
    };
  };

  /** A node's markup with its maths and escaped dollars as authored. */
  const authoredMarkup = (node: HTMLElement): string => {
    const clone = node.cloneNode(true) as HTMLElement;
    authoredMathIn(clone)();
    return clone.innerHTML;
  };

  const independentTextHtml = (node: HTMLElement): string => {
    const authoredTex = (root: Element): string | null =>
      root.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? null;
    // The authoring page renders TeX before measurement so equations get their
    // real browser geometry. KaTeX's output contains two parallel trees
    // (accessible MathML and painted HTML); storing that generated DOM as the
    // text element makes the player carry both trees and can stack them when
    // the computed styles are baked. Recover the authored delimiter form and
    // let the player perform the one canonical render instead.
    if (node.classList.contains('katex-display')) {
      const tex = authoredTex(node);
      if (tex !== null) return `$$${tex}$$`;
    }
    if (node.classList.contains('katex')) {
      const tex = authoredTex(node);
      if (tex !== null) return node.parentElement?.classList.contains('katex-display')
        ? `$$${tex}$$` : `$${tex}$`;
    }
    const clone = node.cloneNode(true) as HTMLElement;
    const restoreMath = authoredMathIn(clone);
    const originals = [node, ...node.querySelectorAll<HTMLElement>('*')];
    const copies = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
    copies.forEach((copy, index) => {
      copy.removeAttribute('class');
      if (index === 0) return;
      // Only what this node changes about its parent. Everything else it
      // reports is inherited, and stamping the inherited half onto every
      // `<strong>` and `<span>` buried the actual emphasis in a hundred
      // characters of repeated font stack — and froze the deck's typography
      // one level deeper than the element style already does.
      const inherited = originals[index].parentElement
        ? computed(originals[index].parentElement!) : null;
      const defaultDisplay = DEFAULT_DISPLAY[originals[index].tagName.toLowerCase()];
      for (const [property, value] of Object.entries(computedPresentation(originals[index], true))) {
        if (inherited && inherited.getPropertyValue(property).trim() === value) continue;
        // `display:list-item` on an `<li>` is not a style, it is the tag.
        if (property === 'display' && value === defaultDisplay) continue;
        copy.style.setProperty(property, value);
      }
    });
    restoreMath();
    return clone.innerHTML;
  };

  const CONTENT_TAGS = new Set(['img', 'video', 'svg', 'canvas', 'table', 'iframe']);

  const found = doc.querySelectorAll<HTMLElement>('section.slide, [data-slide-id]');
  // The body fallback exists for hand-written fragments. A page with no slide
  // roots *and* nothing in its body — a scoped export whose sections were all
  // deleted — must compile to no slides, not to one empty slide made from the
  // body itself: with a scope recorded, "no sections" means "delete the range".
  const bodyHasContent = [...doc.body.children]
    .some((child) => !/^(script|style|link|template)$/i.test(child.tagName));
  // A starter section straight out of `slide-agent new`, not yet edited, is
  // not a slide. Inlined rather than imported: this function is serialised
  // into the headless compile page, where no module import can be reached.
  // Mirrors isPristinePlaceholder in htmlSlides.ts.
  const pristinePlaceholder = (root: HTMLElement): boolean => {
    if (root.dataset.placeholder !== 'true' || root.hasAttribute('data-slide-id')) return false;
    const children = [...root.children];
    return children.length === 1
      && children[0].tagName.toLowerCase() === 'h1'
      && (children[0].textContent ?? '').trim() === 'Title';
  };
  const roots: HTMLElement[] = (found.length > 0 ? [...found] : bodyHasContent ? [doc.body] : [])
    .filter((root) => !pristinePlaceholder(root));

  const isBlock = (node: HTMLElement): boolean => {
    const display = computed(node).display;
    return display !== 'inline' && display !== 'contents' && display !== 'none';
  };

  const hidden = (node: HTMLElement): boolean => {
    const style = computed(node);
    return style.display === 'none' || style.visibility === 'hidden';
  };

  /**
   * `clip-path: circle()` centred on the box — the other way a page writes a
   * round portrait. On media it is the deck's circular mask, not something
   * that needs an HTML fallback.
   */
  // Only on a square box: there `50%` and `closest-side` are both the
  // inscribed circle, which is what the deck's mask draws.
  const centredCircleClip = (node: HTMLElement): boolean => {
    const clip = (computed(node).getPropertyValue('clip-path') || '').trim().replace(/\s+/g, ' ');
    if (!/^circle\((?:50%|closest-side)?\s*(?:at (?:50% 50%|center(?: center)?))?\)$/.test(clip)) {
      return false;
    }
    const box = node.getBoundingClientRect();
    return box.width > 0 && Math.abs(box.width - box.height) <= 1;
  };

  const clippedOrMasked = (node: HTMLElement): boolean => {
    const style = computed(node);
    const value = (property: string): string => style.getPropertyValue(property) || 'none';
    const tag = node.tagName.toLowerCase();
    const media = tag === 'img' || tag === 'video' || clippingMediaFrame(node) !== null;
    if (media && centredCircleClip(node) && value('mask-image') === 'none'
      && value('-webkit-mask-image') === 'none') return false;
    return value('clip-path') !== 'none'
      || value('mask-image') !== 'none'
      || value('-webkit-mask-image') !== 'none';
  };

  const complexClippedMediaFrame = (node: HTMLElement): boolean => {
    if (!independent || !supportsPseudoComputedStyle
      || !node.querySelector(':scope > img, :scope > video')) return false;
    const style = computed(node);
    if (style.overflow !== 'hidden' && style.overflow !== 'clip') return false;
    // A frame-wide pseudo overlay (typically a tonal gradient over a portrait)
    // cannot sit between a native media object and a separate native border:
    // those are separate stacking atoms. Preserve this smallest containing
    // subtree, while small badges/dots remain eligible for native conversion.
    return ['::before', '::after'].some((pseudo) => {
      const paint = view.getComputedStyle(node, pseudo);
      if (!paint.content || paint.content === 'none' || paint.content === 'normal') return false;
      const covers = parseFloat(paint.left) === 0 && parseFloat(paint.right) === 0
        && parseFloat(paint.top) === 0 && parseFloat(paint.bottom) === 0;
      const hasPaint = paint.backgroundImage !== 'none'
        || !ignorableComputed('background-color', paint.backgroundColor);
      return covers && hasPaint;
    });
  };

  /**
   * The one `<img>`/`<video>` a decorative frame exists to hold.
   *
   * `<div class="frame"><img></div>` is how a front-end author writes a
   * bordered picture, and dissolving that frame into a separate ring shape
   * gave the deck two objects that no longer move together: dragging the
   * photograph left its frame behind. Media carries a typed border of its own,
   * so the frame is folded onto the picture instead — but only when the
   * picture really is the whole of the frame's content, or a caption or badge
   * inside it would be swallowed by the fold.
   */
  const soleMediaChild = (node: HTMLElement): HTMLElement | null => {
    const children = [...node.children] as HTMLElement[];
    const visible = children.filter((child) => !hidden(child));
    if (visible.length !== 1) return null;
    const media = visible[0];
    const tag = media.tagName.toLowerCase();
    if (tag !== 'img' && tag !== 'video') return null;
    if (node.textContent!.trim() !== '') return null;
    const frame = node.getBoundingClientRect();
    const inner = media.getBoundingClientRect();
    const style = computed(node);
    const border = parseFloat(style.borderTopWidth) || 0;
    const pad = (side: string): number => parseFloat(style.getPropertyValue(`padding-${side}`)) || 0;
    const fills = Math.abs(inner.width - (frame.width - border * 2 - pad('left') - pad('right'))) <= 1
      && Math.abs(inner.height - (frame.height - border * 2 - pad('top') - pad('bottom'))) <= 1;
    return fills ? media : null;
  };

  /**
   * A frame whose whole paint the picture inside it can carry itself.
   *
   * `<div class="crop"><img></div>` — a round window with a ring around it —
   * is the single most common way a page frames a photograph, and it used to
   * import as two objects stacked exactly on top of each other: a shape
   * holding the ring, and the picture. Selecting one and moving it left the
   * other behind, and the deck cannot express "these two travel together".
   * Media carries a border, a radius, a mask, a shadow and a backdrop colour
   * of its own, so every one of those goes onto the picture instead.
   */
  /**
   * The one picture a clipping frame shows only part of.
   *
   * `<div style="overflow:hidden"><img style="width:180%; margin-left:-40%"></div>`
   * is a crop: the frame is the window and the picture sits wherever the page
   * moved it. That is exactly the deck's `sourceBox`, so the pair becomes one
   * cropped picture. The picture must cover the whole window — otherwise the
   * frame's own paint shows around it and this is a card, not a crop.
   */
  const clippingMediaFrame = (node: HTMLElement): HTMLElement | null => {
    const style = computed(node);
    const clips = style.overflow === 'hidden' || style.overflow === 'clip'
      || centredCircleClip(node);
    if (!clips) return null;
    const visible = ([...node.children] as HTMLElement[]).filter((child) => !hidden(child));
    if (visible.length !== 1) return null;
    const media = visible[0];
    const tag = media.tagName.toLowerCase();
    if (tag !== 'img' && tag !== 'video') return null;
    if (node.textContent!.trim() !== '') return null;
    const frame = node.getBoundingClientRect();
    const inner = media.getBoundingClientRect();
    if (!(frame.width > 0) || !(frame.height > 0)) return null;
    const covers = inner.left <= frame.left + 1 && inner.top <= frame.top + 1
      && inner.right >= frame.right - 1 && inner.bottom >= frame.bottom - 1;
    return covers ? media : null;
  };

  /** A clipping frame whose picture is larger than it, so the frame is a crop. */
  const croppingFrame = (node: HTMLElement): boolean => {
    const media = clippingMediaFrame(node);
    if (!media) return false;
    const frame = node.getBoundingClientRect();
    const inner = media.getBoundingClientRect();
    return Math.abs(inner.left - frame.left) > 1 || Math.abs(inner.top - frame.top) > 1
      || Math.abs(inner.width - frame.width) > 1 || Math.abs(inner.height - frame.height) > 1;
  };

  const foldableMediaFrame = (node: HTMLElement): HTMLElement | null => {
    if (croppingFrame(node)) {
      const style = computed(node);
      if (!ignorableComputed('background-image', style.backgroundImage.trim())) return null;
      if (['top', 'right', 'bottom', 'left']
        .some((side) => parseFloat(style.getPropertyValue(`padding-${side}`)) > 0)) return null;
      const width = parseFloat(style.borderTopWidth) || 0;
      return width > 0 ? null : clippingMediaFrame(node);
    }
    const media = soleMediaChild(node);
    if (!media) return null;
    const style = computed(node);
    const width = parseFloat(style.borderTopWidth) || 0;
    const uniform = ['Top', 'Right', 'Bottom', 'Left'].every((side) =>
      (parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0) === width
      && style.getPropertyValue(`border-${side.toLowerCase()}-style`) === style.borderTopStyle
      && style.getPropertyValue(`border-${side.toLowerCase()}-color`) === style.borderTopColor);
    if (width > 0 && (!uniform || style.borderTopStyle !== 'solid')) return null;
    // A picture cannot carry a frame's own background *picture*, and padding
    // is what makes a frame's colour visible around the one it holds.
    if (!ignorableComputed('background-image', style.backgroundImage.trim())) return null;
    if (['top', 'right', 'bottom', 'left']
      .some((side) => parseFloat(style.getPropertyValue(`padding-${side}`)) > 0)) return null;
    const carries = width > 0
      || centredCircleClip(node)
      || !ignorableComputed('box-shadow', style.boxShadow.trim())
      || !ignorableComputed('border-radius', style.borderRadius.trim());
    return carries ? media : null;
  };

  /**
   * Explicitly declared, media, an exported element wrapper, or a block with
   * no content anywhere inside it. The descent matters: a row of columns of
   * leaves has content two levels down, and stopping the check at the direct
   * children made whole layout trees read as one text object — the compiled
   * slide then reflowed an entire diagram inside a single box.
   */
  // `containsContent` asks `isContent` of every child, and `isContent` asks
  // `containsContent` of the node again — twice, on some paths. Without a
  // memo that is exponential in nesting depth: a chain of sixty wrapper divs,
  // which a framework export produces without trying, took the compile
  // minutes. The answers cannot change during a walk (the only mutation is
  // `isContent` stamping `data-element` on a node it already decided is
  // content), so each node is decided once.
  const contentMemo = new Map<HTMLElement, boolean>();
  const containsMemo = new Map<HTMLElement, boolean>();
  const containsContent = (node: HTMLElement): boolean => {
    const known = containsMemo.get(node);
    if (known !== undefined) return known;
    const result = [...node.children].some((child) =>
      !hidden(child as HTMLElement)
      && isBlock(child as HTMLElement)
      && (isContent(child as HTMLElement) || containsContent(child as HTMLElement)));
    containsMemo.set(node, result);
    return result;
  };

  const isContent = (node: HTMLElement): boolean => {
    const known = contentMemo.get(node);
    if (known !== undefined) return known;
    const result = decideContent(node);
    contentMemo.set(node, result);
    return result;
  };

  const decideContent = (node: HTMLElement): boolean => {
    if (node.dataset.element === 'none') return false;
    // A styled equation wrapper (padding/background/accent border around one
    // display equation) is itself the editable text object. Dissolving through
    // it measures only KaTeX's glyph span and loses the wrapper's vertical
    // room, so the same equation later overflows by exactly its margins and
    // padding in the player.
    if (node.children.length === 1
      && node.firstElementChild?.classList.contains('katex-display')) return true;
    // KaTeX display output is one semantic text object. If the walker dissolves
    // through it, the accessible MathML tree and painted HTML tree become
    // separate slide objects and the equation is visibly duplicated.
    if (node.classList.contains('katex-display')) return true;
    // Any declared element — html, shape, image, video, unsupported — is one
    // object no matter what markup it carries inside.
    if (node.dataset.element) return true;
    const tag = node.tagName.toLowerCase();
    if (complexClippedMediaFrame(node)) {
      node.dataset.element = 'html';
      node.dataset.fallbackReason = 'Clipped media frame with a CSS pseudo-element overlay';
      return true;
    }
    // A clip path or a mask is the whole point of the element it is on, and
    // neither a shape nor a text box can carry one. Reducing such a node to
    // its paint alone turned a clipped triangle into a plain orange rectangle
    // and a masked panel into a solid one — silently, which is worse than the
    // conspicuous fallback.
    if (independent && clippedOrMasked(node)) {
      node.dataset.element = 'html';
      node.dataset.fallbackReason = 'Clipped or masked CSS region';
      return true;
    }
    if (CONTENT_TAGS.has(tag)) return true;
    // A list is one object, bullets and all — splitting it into per-item text
    // boxes loses the markers and the semantics.
    if (tag === 'ul' || tag === 'ol') return true;
    if (!isBlock(node)) return false;
    // A container holding its own prose *and* block children cannot dissolve —
    // the loose text nodes would simply vanish. Kept whole, verbatim.
    if (containsContent(node)
      && [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent!.trim() !== '')) {
      // In an independent authored document, a prose wrapper such as
      // `<p><strong>Label</strong>body copy</p>` is still ordinary rich text.
      // Keeping the wrapper as the text object preserves both the loose text
      // and its nested inline/block markup, while `independentTextHtml` bakes
      // the descendant typography. Exported deck documents retain the older
      // verbatim behaviour because their nested player wrappers are structural.
      if (!independent) node.dataset.element = 'html';
      return true;
    }
    // An exported text element carries the player's own wrappers (.text-body,
    // .text-content), which are block children; the wrapper is still the object.
    // But a hand-written wrapper *around media* — `<div class="element
    // element-video"><video …></video></div>`, copied from an export — must
    // dissolve so the media inside becomes the object; claiming the wrapper
    // would bake the video into a text element and lose it.
    if (node.classList.contains('element')) {
      return !node.querySelector(':scope > img, :scope > video');
    }
    return !containsContent(node);
  };

  /**
   * Paint that would be lost if this node dissolved as layout.
   *
   * Inline declarations are read as authored; where there are none, the
   * *computed* style answers instead, so a card styled through a class — the
   * way a front-end author actually writes one — keeps its background, border
   * and radius too. Computed values are safe here precisely because this
   * becomes a fresh synthetic shape each compile, not a stored element whose
   * literal styles must round-trip.
   */
  const boxPaint = (node: HTMLElement): Record<string, string> | null => {
    const declared = inlineDeclarationsOf(node.getAttribute('style') ?? '');
    const style = computed(node);
    const painted = (color: string | undefined): string | undefined =>
      color && color !== 'transparent' && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(color)
        ? color : undefined;
    const fill = declared['background-color']
      ?? (declared['background']?.match(/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)$/) ? declared['background'] : undefined)
      ?? painted(style.backgroundColor);
    const inlineBorder = declared['border']?.match(/^([\d.]+)px\s+\w+\s+(.+)$/);
    const computedBorderWidth = parseFloat(style.borderTopWidth || '');
    const border = inlineBorder
      ? { width: inlineBorder[1], color: inlineBorder[2] }
      : computedBorderWidth > 0 && style.borderTopStyle !== 'none' && painted(style.borderTopColor)
        ? { width: String(computedBorderWidth), color: style.borderTopColor }
        : null;
    const radiusSpec = declared['border-radius'] ?? style.borderRadius ?? style.borderTopLeftRadius ?? '';
    const radius = parseFloat(radiusSpec);
    const ellipse = /^\s*50%/.test(radiusSpec);
    if (!fill && !border) return null;
    return {
      element: 'shape',
      shape: ellipse ? 'ellipse' : 'rect',
      ...(fill ? { fill } : {}),
      ...(border ? { stroke: border.color, strokeWidth: border.width } : { strokeWidth: '0' }),
      ...(!ellipse && Number.isFinite(radius) && radius > 0 ? { radius: String(radius) } : {}),
    };
  };

  const inlineDeclarationsOf = (raw: string): Record<string, string> => {
    const kept: Record<string, string> = {};
    for (const declaration of raw.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const value = declaration.slice(colon + 1).trim();
      if (value) kept[declaration.slice(0, colon).trim().toLowerCase()] = value;
    }
    return kept;
  };

  const inlineDeclarations = (node: HTMLElement, raw?: string | null): Record<string, string> => {
    const kept: Record<string, string> = {};
    for (const declaration of (raw ?? node.getAttribute('style') ?? '').split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const value = declaration.slice(colon + 1).trim();
      // Every inline declaration, as authored. Which of them are worth
      // carrying onto an element is a mapping decision, and it is made once in
      // `htmlSlides.PRESENTATIONAL_STYLE` — a second list in here would be a
      // second thing to keep in step, and the one that fell behind would drop
      // whatever it had not heard of.
      if (value) kept[property] = value;
    }
    return kept;
  };

  /**
   * Inline style the browser silently threw away.
   *
   * The compile reads declarations out of the raw `style` attribute, but the
   * browser lays the page out from its *parsed* CSSOM — and CSS error recovery
   * is silent. One unterminated quote (a regex edit truncating
   * `font-family:&quot;…&quot;` is how this was first hit) swallows every
   * declaration after it: the page measures left-aligned, the compile keeps
   * the authored `text-align`, and the apply reports success. So every styled
   * node is checked both ways — a segment that does not parse as a
   * declaration, and a declaration the CSSOM does not hold — and the mismatch
   * is reported instead of baked in.
   */
  const styleWarnings = (root: HTMLElement): string[] => {
    const describeNode = (node: Element): string => {
      const id = node.getAttribute('data-element-id') ?? node.id;
      const classes = [...node.classList].slice(0, 2).map((name) => `.${name}`).join('');
      return `<${node.tagName.toLowerCase()}${id ? `#${id}` : ''}${classes}>`;
    };
    const clip = (text: string): string => (text.length > 90 ? `${text.slice(0, 87)}…` : text);
    const out: string[] = [];
    for (const node of [root, ...root.querySelectorAll('[style]')]) {
      const raw = node.getAttribute('style');
      if (!raw || !raw.trim()) continue;
      // Split on semicolons outside quotes and parens — a data: URI or a
      // quoted font name may hold semicolons of its own — and notice a quote
      // that never closes: from there on the parser is inside a string, and
      // every later declaration is silently part of it.
      const segments: string[] = [];
      let buffer = '';
      let quote: string | null = null;
      let depth = 0;
      for (const char of raw) {
        if (quote) {
          if (char === quote) quote = null;
          buffer += char;
        } else if (char === '"' || char === "'") {
          quote = char;
          buffer += char;
        } else if (char === ';' && depth === 0) {
          segments.push(buffer);
          buffer = '';
        } else {
          if (char === '(') depth += 1;
          else if (char === ')') depth = Math.max(0, depth - 1);
          buffer += char;
        }
      }
      segments.push(buffer);
      if (quote) {
        out.push(`${describeNode(node)}: the inline style has an unterminated ${quote} quote — `
          + 'the browser ignores everything after it');
      }
      const style = (node as HTMLElement).style;
      for (const segment of segments) {
        const text = segment.trim();
        if (!text) continue;
        const colon = text.indexOf(':');
        if (colon <= 0) {
          out.push(`${describeNode(node)}: unparseable inline style segment "${clip(text)}"`);
          continue;
        }
        const property = text.slice(0, colon).trim().toLowerCase();
        if (!style || style.getPropertyValue(property)) continue;
        out.push(`${describeNode(node)}: inline declaration "${clip(text)}" was dropped by the `
          + 'browser\'s CSS parser and is not applied');
      }
    }
    return out;
  };

  /**
   * CSS the deck cannot carry, reported rather than silently dropped.
   *
   * These are the cases where the import still produces a sensible object, so
   * there is no conspicuous fallback to notice — the slide simply comes back
   * subtly different. A warning goes back with the apply, which is the only
   * moment an agent is looking.
   */
  const unsupportedCssWarnings = (root: HTMLElement): string[] => {
    if (!independent) return [];
    const out: string[] = [];
    const describe = (node: Element): string => {
      const classes = [...node.classList].slice(0, 2).map((name) => `.${name}`).join('');
      return `<${node.tagName.toLowerCase()}${classes}>`;
    };
    for (const node of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      const style = computed(node);
      const matrix = style.transform.match(/matrix\(([^)]+)\)/);
      if (matrix) {
        const [a, b, c, d] = matrix[1].split(',').map(Number);
        const scaleX = Math.hypot(a, b);
        const scaleY = Math.hypot(c, d);
        const skewed = Math.abs(a * c + b * d) > 0.001;
        if (Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001 || skewed) {
          out.push(`${describe(node)}: only rotation survives a transform — the object is `
            + 'baked at its untransformed size, so scale/skew is lost. Size it directly.');
        }
      }
      if ((style.getPropertyValue('backdrop-filter') || 'none') !== 'none'
        || (style.getPropertyValue('-webkit-backdrop-filter') || 'none') !== 'none') {
        out.push(`${describe(node)}: backdrop-filter has no deck equivalent and is dropped; `
          + 'use a translucent fill instead.');
      }
    }
    return [...new Set(out)];
  };

  const angleOf = (node: HTMLElement): number => {
    const transform = computed(node).transform;
    if (!transform || transform === 'none') return 0;
    const values = transform.match(/matrix\(([^)]+)\)/);
    if (!values) return 0;
    const [a, b] = values[1].split(',').map(Number);
    return Math.round(Math.atan2(b, a) * (180 / Math.PI) * 100) / 100;
  };

  const typeOf = (node: HTMLElement): string => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'img') return 'image';
    if (tag === 'video') return 'video';
    // A converted table is a text element in the deck, and it needs the text
    // half of the computed presentation: without the authored font size it
    // came back rendered at the deck's default body size, columns and all.
    if (node.dataset.element === 'table') return 'text';
    if (node.dataset.element === 'html' || CONTENT_TAGS.has(tag)) return 'html';
    return 'text';
  };

  /**
   * An inline SVG that draws exactly one primitive, as a native deck shape.
   *
   * An arrow between two boxes, a rule, a circle, an icon path: front-end
   * authors reach for SVG for all of them, and every one used to arrive as an
   * inert HTML region that could be moved but never restyled, re-coloured or
   * re-pointed. The deck's own shapes are rects, ellipses, lines, arrows and
   * paths — the same primitives — so a one-primitive SVG converts exactly.
   * Anything richer (a diagram of several primitives, text inside the SVG,
   * gradients, clip paths) stays a fallback: it is a picture, not a shape.
   */
  const svgShape = (
    svg: HTMLElement,
    origin: DOMRect,
    rotation: number,
  ): MeasuredNode | null => {
    const tag = (node: Element): string => node.tagName.toLowerCase();
    if (!independent) return null;
    if (svg.querySelector('text, image, foreignObject, use, tspan')) return null;
    const drawn = [...svg.querySelectorAll<SVGGraphicsElement>(
      'rect, circle, ellipse, line, path, polygon, polyline',
    )].filter((node) => !node.closest('defs, marker, clipPath, mask, pattern, symbol'));
    if (drawn.length !== 1) return null;
    const shape = drawn[0];
    const style = computed(shape as unknown as Element);
    const paint = (value: string): string | null =>
      !value || value === 'none' || value === 'rgba(0, 0, 0, 0)' ? null : value;
    // An open stroke is not flood-filled; SVG's default black `fill` on a
    // line means nothing and would arrive as a deck shape's fill colour.
    const fill = tag(shape) === 'line' || tag(shape) === 'polyline' ? null : paint(style.fill);
    const stroke = paint(style.stroke);
    if (!fill && !stroke) return null;
    if (style.getPropertyValue('clip-path') !== 'none'
      || style.getPropertyValue('mask') !== 'none') return null;
    // A gradient or pattern paint server is a URL reference; a deck shape
    // holds a colour.
    if ([fill, stroke].some((value) => value?.includes('url('))) return null;

    const svgRect = svg.getBoundingClientRect();
    const box = svg as unknown as SVGSVGElement;
    const view = box.viewBox?.baseVal;
    const scale = view && view.width > 0 ? svgRect.width / view.width : 1;
    const strokeWidth = (parseFloat(style.strokeWidth) || 0) * (stroke ? 1 : 0);
    const marker = (side: 'marker-start' | 'marker-end'): boolean => {
      const value = style.getPropertyValue(side) || shape.getAttribute(side) || 'none';
      return value !== 'none' && value.trim() !== '';
    };
    const common = {
      tag: 'div',
      elementId: svg.dataset.elementId ?? null,
      classes: [],
      rotation,
      opacity: Number(computed(svg).opacity) || 1,
      style: {},
      html: '',
      attrs: {},
    };
    const dataset = (extra: Record<string, string>): Record<string, string> => ({
      ...svg.dataset as Record<string, string>,
      element: 'shape',
      ...(fill ? { fill } : {}),
      ...(stroke ? { stroke } : {}),
      ...(marker('marker-start') ? { arrowStart: 'true' } : {}),
      ...(marker('marker-end') ? { arrowEnd: 'true' } : {}),
      ...extra,
    });
    const relative = (rect: DOMRect) => ({
      x: rect.left - origin.left,
      y: rect.top - origin.top,
      w: rect.width,
      h: rect.height,
    });

    // A line keeps its own geometry rather than its bounding box: a diagonal
    // connector's box says nothing about where the line runs, and the deck
    // draws a line across its box horizontally, turned by `rot`.
    if (tag(shape) === 'line') {
      const matrix = shape.getScreenCTM?.();
      if (!matrix) return null;
      const point = (x: number, y: number) => ({
        x: matrix.a * x + matrix.c * y + matrix.e,
        y: matrix.b * x + matrix.d * y + matrix.f,
      });
      const geometry = shape as unknown as SVGLineElement;
      const from = point(geometry.x1.baseVal.value, geometry.y1.baseVal.value);
      const to = point(geometry.x2.baseVal.value, geometry.y2.baseVal.value);
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      if (length <= 0) return null;
      const thickness = Math.max(1, strokeWidth * scale);
      const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x)
        * (180 / Math.PI) * 100) / 100;
      return {
        ...common,
        rotation: Math.round((rotation + angle) * 100) / 100,
        dataset: dataset({
          shape: marker('marker-start') || marker('marker-end') ? 'arrow' : 'line',
          strokeWidth: String(Math.round(thickness * 100) / 100),
        }),
        // The stored box is the untransformed one, centred on the line's
        // midpoint, exactly as a rotated element is stored everywhere else.
        rect: {
          x: (from.x + to.x) / 2 - length / 2 - origin.left,
          y: (from.y + to.y) / 2 - thickness / 2 - origin.top,
          w: length,
          h: thickness,
        },
      };
    }

    if (['rect', 'circle', 'ellipse'].includes(tag(shape))) {
      const radius = tag(shape) === 'rect'
        ? (parseFloat(shape.getAttribute('rx') ?? style.getPropertyValue('rx')) || 0) * scale
        : 0;
      // A shape's bounding box excludes its stroke, which SVG centres on the
      // geometry's edge; the deck draws a rect's or ellipse's stroke *inside*
      // its box. So the box grows by half the stroke on every side, or the
      // converted shape comes back a whole stroke width smaller than it was
      // drawn. The SVG viewport clips its content by default, so what grew
      // past the viewport was never visible and is trimmed back to it.
      const half = (strokeWidth * scale) / 2;
      const inner = shape.getBoundingClientRect();
      const left = Math.max(inner.left - half, svgRect.left);
      const top = Math.max(inner.top - half, svgRect.top);
      const right = Math.min(inner.right + half, svgRect.right);
      const bottom = Math.min(inner.bottom + half, svgRect.bottom);
      return {
        ...common,
        dataset: dataset({
          shape: tag(shape) === 'rect' ? 'rect' : 'ellipse',
          strokeWidth: String(Math.round(strokeWidth * scale * 100) / 100),
          ...(radius > 0 ? { radius: String(Math.round(radius * 100) / 100) } : {}),
        }),
        rect: {
          x: left - origin.left,
          y: top - origin.top,
          w: Math.max(0, right - left),
          h: Math.max(0, bottom - top),
        },
      };
    }

    // Paths keep their authored coordinates and are drawn into the element
    // box through the viewBox the author already wrote, so the drawing scales
    // with the object instead of being re-fitted to a bounding box.
    const coordinates = (shape.getAttribute('points') ?? '')
      .trim().split(/[\s,]+/).map(Number).filter((value) => Number.isFinite(value));
    const vertices: string[] = [];
    for (let index = 0; index + 1 < coordinates.length; index += 2) {
      vertices.push(`${coordinates[index]},${coordinates[index + 1]}`);
    }
    const d = tag(shape) === 'path'
      ? shape.getAttribute('d') ?? ''
      : vertices.length >= 2
        ? `M${vertices.join(' L')}${tag(shape) === 'polygon' ? ' Z' : ''}`
        : '';
    if (!d.trim()) return null;
    // The deck draws a path into `0 0 w h`; a viewBox that starts elsewhere
    // would shift every coordinate, so such an SVG stays a fallback.
    if (view && (view.x !== 0 || view.y !== 0)) return null;
    const width = view?.width || svgRect.width;
    const height = view?.height || svgRect.height;
    if (!(width > 0) || !(height > 0)) return null;
    return {
      ...common,
      dataset: dataset({
        shape: 'path',
        path: d,
        pathSize: `${width},${height}`,
        strokeWidth: String(Math.round(strokeWidth * 100) / 100),
      }),
      rect: relative(svgRect),
    };
  };

  const measure = (
    node: HTMLElement,
    origin: DOMRect,
    rotation: number,
    rawStyle: string | null,
  ): MeasuredNode => {
    const rect = node.getBoundingClientRect();
    const style = computed(node);
    const tag = node.tagName.toLowerCase();
    if (tag === 'svg') {
      const shape = svgShape(node, origin, rotation);
      if (shape) return shape;
    }
    // Inline declarations only, never computed ones. A computed style is
    // mostly inherited theme values, and baking those into the element would
    // freeze the deck's typography at compile time: editing theme.css
    // afterwards would stop changing anything. What the author wrote inline is
    // a deliberate one-off and belongs on the element; everything else stays
    // where it belongs, in the stylesheet.
    // Read the raw declarations rather than the parsed CSSOM: going through
    // node.style would hand back a normalised value, turning every authored
    // #000000 into rgb(0, 0, 0) and churning the deck on every round trip.
    // The snapshot, never the live attribute: by now the walk has parked
    // `transform:none` on the node, and a node that had no `style` of its own
    // (`rawStyle === null`) must not pick that scaffolding up as authored CSS.
    const authored = inlineDeclarations(node, rawStyle ?? '');
    const kept = independent
      ? { ...computedPresentation(node, typeOf(node) === 'text'), ...authored }
      : authored;

    // A very common frontend pattern is a media element filling an
    // `overflow:hidden` rounded frame. The layout container dissolves, so pass
    // its clip to the still-native image/video instead of turning the whole
    // photograph into HTML merely to retain rounded corners.
    //
    // None of this depends on the deck theme, so it applies to a page that
    // links theme.css just as much as to a standalone one: an agent writing
    // a circular portrait in a themed page means the same circle.
    const isMedia = tag === 'img' || tag === 'video';
    // A frame that shows only part of the picture: the frame is the object's
    // box, and where the picture sits behind it becomes the crop below.
    const cropWindow = isMedia && node.parentElement && croppingFrame(node.parentElement)
      && foldableMediaFrame(node.parentElement) === node
      ? node.parentElement.getBoundingClientRect()
      : null;
    if (isMedia && centredCircleClip(node)) {
      kept['border-radius'] = '50%';
      delete kept['clip-path'];
    }
    if (isMedia && node.parentElement) {
      const parentStyle = computed(node.parentElement);
      const clipped = parentStyle.overflow === 'hidden' || parentStyle.overflow === 'clip';
      const radius = parentStyle.borderRadius.trim();
      if (clipped && radius && radius.split(/\s+/).some((part) => parseFloat(part) > 0)) {
        kept['border-radius'] = radius;
      }
      if (centredCircleClip(node.parentElement) && clippingMediaFrame(node.parentElement) === node) {
        kept['border-radius'] = '50%';
      }
      // The frame becomes the media's own typed border. The picture keeps its
      // own box: the deck paints a media border *inside* the element, so the
      // photograph stays exactly where and how large it was drawn and the
      // frame lands on its outer edge rather than resampling the whole
      // picture up by twice the border.
      if (foldableMediaFrame(node.parentElement) === node) {
        const width = parseFloat(parentStyle.borderTopWidth) || 0;
        if (width > 0) kept.border = `${width}px solid ${parentStyle.borderTopColor}`;
        if (radius && radius.split(/\s+/).some((part) => parseFloat(part) > 0)) {
          kept['border-radius'] = radius;
        }
        // The frame's own ring, shadow and backdrop belong to the framed
        // picture now; they used to travel on the shape this fold replaces,
        // and without them every framed figure lost its lift — and a picture
        // with transparency lost the colour it was sitting on.
        for (const property of ['box-shadow', 'filter', 'mix-blend-mode', 'background-color']) {
          const value = parentStyle.getPropertyValue(property).trim();
          if (!ignorableComputed(property, value) && !kept[property]) kept[property] = value;
        }
      }
    }

    // A picture framed by `object-fit` and `object-position` is *cropped*, and
    // the deck has a crop of its own: `sourceBox`, the rectangle the whole
    // picture occupies behind the element's window. Leaving the framing as CSS
    // renders correctly but cannot be edited — the editor's crop tool works on
    // `sourceBox`, and with none recorded it assumes the picture is stretched
    // to fill the box, so the first nudge of a `cover` portrait snapped it to
    // the window's aspect and threw the framing away. Baking it here is what
    // makes an imported circular portrait behave like one the editor cropped.
    // (`paintedMediaBox` in shared/mediaMask.ts is the same placement rule,
    // for media whose crop is still implicit.)
    if (isMedia && !node.dataset.crop) {
      const source = tag === 'img'
        ? { w: (node as HTMLImageElement).naturalWidth, h: (node as HTMLImageElement).naturalHeight }
        : { w: (node as HTMLVideoElement).videoWidth, h: (node as HTMLVideoElement).videoHeight };
      const fit = style.objectFit;
      // A deck picture coming back from its export is framed by what it
      // stores; an `object-position` its theme class adds is the theme's to
      // keep applying, not a crop to freeze into it.
      const position = (!independent && node.dataset.elementId !== undefined
        ? inlineDeclarations(node)['object-position'] ?? '50% 50%'
        : style.objectPosition || '50% 50%').trim();
      const circular = /^\s*50%/.test(kept['border-radius'] ?? '');
      // Only a *deliberate* framing is worth freezing: a plain centred cover
      // is reproduced exactly by the deck's own `fit`, and keeping it implicit
      // leaves the picture free to re-cover when the box is resized. A
      // circular mask is always deliberate — nudging the face inside the
      // circle is the whole reason it exists.
      const framed = position !== '50% 50%' || circular || cropWindow !== null;
      // Offset of the picture's own box inside the frame that crops it.
      const shift = cropWindow
        ? { x: rect.left - cropWindow.left, y: rect.top - cropWindow.top }
        : { x: 0, y: 0 };
      const hundredth = (value: number): number => Math.round(value * 100) / 100;
      if (framed && source.w > 0 && source.h > 0 && (fit === 'cover' || fit === 'contain')
        && rect.width > 0 && rect.height > 0) {
        const scale = fit === 'cover'
          ? Math.max(rect.width / source.w, rect.height / source.h)
          : Math.min(rect.width / source.w, rect.height / source.h);
        const drawn = { w: source.w * scale, h: source.h * scale };
        const place = (spec: string, box: number, size: number): number => {
          const keywords: Record<string, string> = {
            left: '0%', top: '0%', center: '50%', right: '100%', bottom: '100%',
          };
          const resolved = keywords[spec] ?? spec;
          const percent = /^([+-]?[\d.]+)%$/.exec(resolved);
          if (percent) return (box - size) * (Number(percent[1]) / 100);
          const length = /^([+-]?[\d.]+)px$/.exec(resolved);
          return length ? Number(length[1]) : (box - size) / 2;
        };
        const parts = position.toLowerCase().split(/\s+/);
        const vertical = ['top', 'bottom'].includes(parts[0]) && parts.length === 2;
        const [x, y] = vertical ? [parts[1], parts[0]] : parts;
        node.dataset.crop = [
          hundredth(shift.x + place(x ?? '50%', rect.width, drawn.w)),
          hundredth(shift.y + place(y ?? '50%', rect.height, drawn.h)),
          hundredth(drawn.w),
          hundredth(drawn.h),
        ].join(',');
        delete kept['object-position'];
      } else if (cropWindow && rect.width > 0 && rect.height > 0) {
        // Stretched to its own box (`fill`), so that box is the whole picture.
        node.dataset.crop = [shift.x, shift.y, rect.width, rect.height].map(hundredth).join(',');
        delete kept['object-position'];
      }
    }

    const verbatim = node.dataset.element === 'html'
      || (CONTENT_TAGS.has(tag) && tag !== 'img' && tag !== 'video'
        && node.dataset.element !== 'table');

    const frameRect = cropWindow ?? rect;
    const box = {
      x: frameRect.left - origin.left,
      y: frameRect.top - origin.top,
      w: frameRect.width,
      h: frameRect.height,
    };
    // A text box the browser sized to its content — a flex item, an
    // inline-block, a table cell's label — is exactly as wide as its glyphs,
    // to the hundredth of a pixel. Stored that way, the slide holds only in
    // the renderer that measured it: a rail thumbnail drawn at another scale,
    // or the same text pasted into a deck whose theme measures a hair wider,
    // wraps the last word onto a second line. Give such a box a little slack
    // on the side the text does not align to, so ordinary rounding never
    // wraps it. A box whose width the author wrote inline — every export, in
    // particular — is left alone, which is what keeps a round trip stable.
    if (typeOf(node) === 'text' && !verbatim && !/(^|;)\s*width\s*:/i.test(rawStyle ?? '')) {
      const range = node.ownerDocument.createRange();
      range.selectNodeContents(node);
      // Layout-less DOMs (jsdom) have no Range geometry; there is nothing to
      // protect there either.
      const content = typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : null;
      range.detach?.();
      if (content && content.width > 0 && rect.width - content.width < 1) {
        const slack = Math.max(4, Math.round(rect.width * 0.02 * 100) / 100);
        const align = style.textAlign;
        if (align === 'center') {
          box.x -= slack / 2;
        } else if (align === 'right' || align === 'end') {
          box.x -= slack;
        }
        box.w += slack;
      }
    }

    return {
      tag,
      elementId: node.dataset.elementId ?? null,
      // The structural classes are the renderer's to add, not the deck's to
      // store; only the author's own classes belong in the element.
      classes: independent ? [] : [...node.classList].filter((name) =>
        name !== 'slide' && name !== 'element' && !name.startsWith('element-')),
      dataset: { ...node.dataset } as Record<string, string>,
      rect: box,
      rotation,
      // Verbatim markup still carries its authored CSS inside the isolated
      // shadow root. Reapplying presentation or opacity to the slide-element
      // wrapper doubles filters, borders and alpha (a .24 SVG became .0576).
      opacity: verbatim ? 1 : (Number(style.opacity) || 1),
      style: verbatim ? {} : kept,
      // A text box exported from a deck carries the player's own wrappers so
      // that it lays out identically; the deck stores only what is inside
      // them. Hand-authored markup has no such wrapper and is read whole.
      html: verbatim ? (() => {
        // An HTML region exported from the deck: the export wrapped the
        // stored markup in a positioned box of its own. That box is the
        // object, not part of its markup — kept, it nested the region one
        // wrapper deeper on every round trip.
        if (!independent && node.dataset.element === 'html' && node.dataset.elementId !== undefined) {
          return node.innerHTML;
        }
        const clone = node.cloneNode(true) as HTMLElement;
        // A fallback is rendered inside an element-sized shadow root. Its
        // authored absolute position belongs to the original page and must
        // not be applied a second time inside that new local coordinate space.
        clone.setAttribute('data-slide-editor-fallback-root', '');
        // The walk parks `transform:none` on every object while it measures
        // an axis-aligned box. That is scaffolding, not markup: baked into the
        // preserved region it overrode whatever transform the author's own CSS
        // gave it, for ever.
        if (rawStyle === null || rawStyle.trim() === '') clone.removeAttribute('style');
        else clone.setAttribute('style', rawStyle);
        return clone.outerHTML;
      })()
        : (node.querySelector(':scope > .text-body > [data-text-content]')
          ? authoredMarkup(node.querySelector(':scope > .text-body > [data-text-content]') as HTMLElement)
          : independent ? independentTextHtml(node) : authoredMarkup(node)),
      preformatted: !verbatim && node.querySelector(':scope > .text-body > [data-text-content]') !== null,
      attrs: {
        src: node.getAttribute('src') ?? undefined,
        alt: node.getAttribute('alt') ?? undefined,
        poster: node.getAttribute('poster') ?? undefined,
        objectFit: style.objectFit || undefined,
        objectPosition: style.objectPosition || undefined,
        textAlign: style.textAlign || undefined,
        // Absent means "the deck's default" (all three on: a slide video
        // normally plays itself) — unless the export said "false", which it
        // does for a deck video that has the flag off.
        loop: node.hasAttribute('loop') || (node.dataset.loop === 'false' ? false : undefined),
        muted: node.hasAttribute('muted') || (node.dataset.muted === 'false' ? false : undefined),
        autoplay: node.hasAttribute('autoplay') || (node.dataset.autoplay === 'false' ? false : undefined),
        controls: node.hasAttribute('controls') || undefined,
      },
      verbatim,
      ...(verbatim ? {
        css: capturedCss,
        fallbackReason: node.dataset.element === 'html'
          ? (node.dataset.fallbackReason ?? 'Explicit HTML fallback')
          : `${tag.toUpperCase()} is preserved as HTML`,
      } : {}),
    };
  };

  /**
   * A CSS pseudo-element as an ordinary slide object.
   *
   * `::before`/`::after` carry a great deal of real design — badges, accent
   * bars, arrowheads, decorative rules — and the deck has no pseudo-elements,
   * so whatever is not converted here is simply *gone* from the slide with no
   * trace in the file the author saved. Solid paint becomes a native shape;
   * anything richer (a gradient bar, a shadowed chip, the border-triangle
   * arrowhead, a `content:"→"`) becomes an ordinary styled text object, which
   * is editable and, unlike an HTML fallback, does not take the owner's own
   * text down with it.
   */
  const pseudoElement = (
    owner: HTMLElement,
    pseudo: '::before' | '::after',
    origin: DOMRect,
  ): MeasuredNode | null => {
    if (!independent || !supportsPseudoComputedStyle
      || owner.closest('[data-element="html"]')) return null;
    const style = view.getComputedStyle(owner, pseudo);
    if (!style.content || style.content === 'none' || style.content === 'normal') return null;
    // A generated counter or image has no literal to carry across.
    if (/\b(?:counter|counters|url|attr|image-set)\(/.test(style.content)) return null;
    const text = /^"([\s\S]*)"$/.exec(style.content)?.[1] ?? '';

    const contentW = parseFloat(style.width);
    const contentH = parseFloat(style.height);
    if (!Number.isFinite(contentW) || !Number.isFinite(contentH)
      || contentW < 0 || contentH < 0) return null;
    const borders = ['Top', 'Right', 'Bottom', 'Left'].map((side) => ({
      side: side.toLowerCase(),
      width: parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) || 0,
      color: style.getPropertyValue(`border-${side.toLowerCase()}-color`),
      kind: style.getPropertyValue(`border-${side.toLowerCase()}-style`),
    }));
    const first = borders[0];
    const uniformBorder = borders.every((border) => border.width === first.width
      && border.color === first.color && border.kind === first.kind);
    const borderBox = style.boxSizing === 'border-box';
    const inset = borders.map((border) => (border.kind === 'none' ? 0 : border.width));
    const width = contentW + (borderBox ? 0 : inset[1] + inset[3]);
    const height = contentH + (borderBox ? 0 : inset[0] + inset[2]);
    // A zero content box is not an empty pseudo-element: the border-triangle
    // arrowhead — `width:0; border-left:28px solid; border-top:14px solid
    // transparent` — is drawn entirely out of its borders.
    if (width <= 0 || height <= 0) return null;
    const ownerRect = owner.getBoundingClientRect();
    const left = parseFloat(style.left);
    const right = parseFloat(style.right);
    const top = parseFloat(style.top);
    const bottom = parseFloat(style.bottom);
    const x = ownerRect.left - origin.left + (Number.isFinite(left)
      ? left : Number.isFinite(right) ? ownerRect.width - right - width : 0);
    const y = ownerRect.top - origin.top + (Number.isFinite(top)
      ? top : Number.isFinite(bottom) ? ownerRect.height - bottom - height : 0);
    const fill = ignorableComputed('background-color', style.backgroundColor)
      ? undefined : style.backgroundColor;
    const image = style.backgroundImage && style.backgroundImage !== 'none'
      ? style.backgroundImage : undefined;
    const shadow = style.boxShadow && style.boxShadow !== 'none' ? style.boxShadow : undefined;
    const painted = Boolean(fill || image || shadow) || inset.some((value) => value > 0);
    if (!painted && !text.trim()) return null;
    const radius = style.borderRadius || style.borderTopLeftRadius || '';
    const ellipse = /^\s*50%/.test(radius);
    const matrix = style.transform.match(/matrix\(([^)]+)\)/);
    const [a, b] = matrix ? matrix[1].split(',').map(Number) : [1, 0];
    const rotation = Math.round(Math.atan2(b, a) * (180 / Math.PI) * 100) / 100;
    const common = {
      tag: 'div',
      elementId: null,
      classes: [] as string[],
      rect: { x, y, w: width, h: height },
      rotation,
      opacity: Number(style.opacity) || 1,
      attrs: {},
      fallbackReason: undefined,
    };
    const borderW = first.kind !== 'none' ? first.width : 0;
    if (uniformBorder && !image && !shadow && !text.trim() && (fill || borderW > 0)) {
      return {
        ...common,
        dataset: {
          element: 'shape',
          shape: ellipse ? 'ellipse' : 'rect',
          ...(fill ? { fill } : {}),
          ...(borderW > 0
            ? { stroke: first.color, strokeWidth: String(borderW) }
            : { strokeWidth: '0' }),
          ...(!ellipse && parseFloat(radius) > 0 ? { radius: String(parseFloat(radius)) } : {}),
        },
        style: {},
        html: '',
      };
    }
    // Everything else keeps its paint literally, as element CSS on an
    // otherwise empty text object.
    const kept: Record<string, string> = {};
    for (const property of [
      'background-color', 'background-image', 'background-size',
      'background-position', 'background-repeat', 'border-radius', 'box-shadow',
      'filter', 'mix-blend-mode', 'color', 'font-family', 'font-size',
      'font-weight', 'font-style', 'line-height', 'letter-spacing',
    ]) {
      const value = style.getPropertyValue(property).trim();
      if (!ignorableComputed(property, value)) kept[property] = value;
    }
    for (const border of borders) {
      if (border.kind === 'none' || border.width <= 0) continue;
      kept[`border-${border.side}`] = `${border.width}px ${border.kind} ${border.color}`;
    }
    return {
      ...common,
      dataset: {},
      style: kept,
      html: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    };
  };

  return roots.map((root) => {
    // Checked before anything below touches a node: assigning through
    // node.style re-serialises the attribute from the CSSOM, which would
    // repair the very breakage this is meant to catch.
    const warnings = [...styleWarnings(root), ...unsupportedCssWarnings(root)];
    // Collect first, then style, then measure. The player wraps every object
    // in an element wrapper carrying the type class, and the deck's type
    // sizes hang off those classes -- so without this pass the compiler would
    // measure browser-default 16px text and bake geometry that the deck then
    // renders at 44px.
    const objects: HTMLElement[] = [];
    const synthetic = new Set<HTMLElement>();
    /** Dissolved layout boxes kept only for the picture or gradient they paint. */
    const backdrops = new Set<HTMLElement>();
    // A build declared on a layout container belongs to everything inside it:
    // the first baked object keeps the author's trigger and the rest appear
    // with it, so dissolving the container does not silently drop the build.
    const collect = (node: HTMLElement, build: { spec: string | null }): void => {
      for (const child of [...node.children] as HTMLElement[]) {
        if (hidden(child)) continue;
        if (isContent(child)) {
          if (!child.dataset.build && build.spec) {
            child.dataset.build = build.spec;
            build.spec = 'withPrev';
          }
          objects.push(child);
        } else {
          const scope = child.dataset.build
            ? { spec: child.dataset.build } : build;
          // Layout dissolves, but paint it carries (a card's background, a
          // panel's border) must not: it becomes a rect shape behind its
          // children, in document order so it stays underneath them.
          // A frame around one picture is folded onto the picture itself
          // (see `foldableMediaFrame`), so it must not also become a ring
          // shape of its own -- that is the pair of objects the fold exists
          // to avoid.
          const paint = foldableMediaFrame(child) ? null : boxPaint(child);
          if (paint) {
            for (const [key, value] of Object.entries(paint)) child.dataset[key] = value;
            if (scope.spec) { child.dataset.build = scope.spec; scope.spec = 'withPrev'; }
            objects.push(child);
            synthetic.add(child);
          } else if (independent && !ignorableComputed(
            'background-image', computed(child).backgroundImage.trim())) {
            // A photograph or gradient *behind* content is not something a
            // deck shape can hold, and the layout box carrying it is about to
            // dissolve. Keep it as a painted box of its own, underneath its
            // children in document order, rather than losing the picture the
            // slide was designed around.
            if (scope.spec) { child.dataset.build = scope.spec; scope.spec = 'withPrev'; }
            objects.push(child);
            backdrops.add(child);
          }
          collect(child, scope);
        }
      }
    };
    collect(root, { spec: null });

    root.classList.add('slide');
    for (const node of objects) {
      if (synthetic.has(node)) continue;
      // A hand-authored `<table>` is a deck table, not an inert HTML region.
      // The deck's table *is* a text element with column widths, so the only
      // thing missing was the measurement: take the widths the browser just
      // computed and the rest of the mapping already exists.
      if (independent && node.tagName.toLowerCase() === 'table' && !node.dataset.element) {
        node.dataset.element = 'table';
        const row = node.querySelector('tr');
        const cells = row ? ([...row.children] as HTMLElement[]) : [];
        const spanned = cells.some((cell) => (cell as HTMLTableCellElement).colSpan > 1);
        const widths = cells.map((cell) => Math.round(cell.getBoundingClientRect().width));
        // Column widths are proportions; a spanning first row cannot supply
        // them, and the mapping falls back to equal columns without them.
        if (!spanned && widths.length > 0 && widths.every((width) => width > 0)) {
          node.dataset.tableWidths = widths.join(',');
        }
      }
      // A leaf with nothing to say but paint — an empty div with a background
      // — is a rectangle, not an empty text box.
      if (!node.dataset.element && typeOf(node) === 'text' && node.textContent!.trim() === ''
        && node.children.length === 0) {
        const paint = boxPaint(node);
        if (paint) {
          for (const [key, value] of Object.entries(paint)) node.dataset[key] = value;
          synthetic.add(node);
          continue;
        }
      }
      // Theme-driven exports need the player's semantic classes in order to
      // measure their typography. Adding those classes to an independent web
      // page changes its cascade, however: `.element-text { font-size:44px }`
      // outranks an authored `h1 { font-size:112px }`. Independent documents
      // are measured exactly as authored and their computed styles are baked.
      if (!independent) node.classList.add('element', `element-${typeOf(node)}`);
      // HTML collapses whitespace; the deck renders text with pre-wrap. So
      // normalise here, where it still affects the measurement, rather than
      // shipping the author's source indentation into the slide as newlines.
      // A text box exported from the deck is the exception: it is already
      // the deck's own text inside the player's pre-wrap wrapper, so its
      // newlines are line breaks the slide shows, and a trailing space is
      // part of what it holds.
      if (typeOf(node) === 'text' && !/^(pre|code)$/.test(node.tagName.toLowerCase())
        && !node.querySelector(':scope > .text-body > [data-text-content]')) {
        const collapsed = node.innerHTML.replace(/\s+/g, ' ').trim();
        if (collapsed !== node.innerHTML) node.innerHTML = collapsed;
      }
    }
    // Force layout with the new classes applied before anything is measured.
    void doc.body.offsetHeight;

    // Rotation is recorded, then taken off before measuring: a bounding rect
    // is axis-aligned, so a 543x1 rule at 90 degrees would otherwise measure
    // 1x543 and come back as a different shape. The deck stores the
    // *untransformed* box and rotates about its centre at render time, which
    // is exactly what the page reports with the transform removed.
    const angles = objects.map(angleOf);
    // Snapshot the style attributes first: assigning through node.style
    // re-serialises the whole attribute, which would rewrite every authored
    // #000000 as rgb(0, 0, 0) before we ever read it.
    const rawStyles = objects.map((node) => node.getAttribute('style'));
    for (const node of objects) node.style.transform = 'none';
    void doc.body.offsetHeight;

    const origin = root.getBoundingClientRect();
    const nodes = objects.map((node, index) => measure(node, origin, angles[index], rawStyles[index]));
    // Put the attribute back exactly as authored — not through the CSSOM, which
    // would leave an empty `style=""` behind and re-serialise every colour — so
    // measuring the same document again reads what the first pass read.
    objects.forEach((node, index) => {
      const raw = rawStyles[index];
      if (raw === null) node.removeAttribute('style');
      else node.setAttribute('style', raw);
    });
    // A synthetic rect's paint lives on the shape itself, and the layout that
    // positioned its children died with the container: carrying either in the
    // element's inline style would paint the background twice or inset the
    // drawing by a padding that no longer has anything to pad.
    objects.forEach((node, index) => {
      if (backdrops.has(node)) {
        // Its layout died with the container; only the paint is left, and the
        // text it used to hold now lives in objects of its own.
        nodes[index].style = Object.fromEntries(Object.entries(nodes[index].style)
          .filter(([property]) => property.startsWith('background')
            || ['border-radius', 'box-shadow', 'filter', 'mix-blend-mode'].includes(property)));
        nodes[index].html = '';
        return;
      }
      if (!synthetic.has(node)) return;
      // Layout declarations and the paint represented by the shape itself are
      // discarded, but effects around that paint still belong on its wrapper.
      // This preserves rings, glows and shadows without painting the fill or
      // border twice.
      nodes[index].style = Object.fromEntries(Object.entries(nodes[index].style)
        .filter(([property]) => [
          'box-shadow', 'filter', 'mix-blend-mode',
        ].includes(property)));
      nodes[index].html = '';
    });
    // CSS pseudo-elements are ordinary editable slide objects in disguise:
    // solid paint as a native shape, richer decoration as a styled text
    // object. Either way they reach the deck instead of vanishing from it.
    // Paint order is part of the design: `::before` sits behind its owner's
    // content and `::after` in front of it. Appending every decoration to the
    // end of the slide instead put accent bars and gradient washes on top of
    // the words they were drawn behind.
    const decorations: Array<{ at: number; node: MeasuredNode }> = [];
    for (const owner of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      for (const pseudo of ['::before', '::after'] as const) {
        const decoration = pseudoElement(owner, pseudo, origin);
        if (!decoration) continue;
        const own = objects.indexOf(owner);
        const inside = objects
          .map((object, index) => ({ object, index }))
          .filter(({ object }) => owner.contains(object));
        const anchor = own >= 0 ? [own, own]
          : inside.length > 0 ? [inside[0].index, inside[inside.length - 1].index]
            : [nodes.length, nodes.length];
        decorations.push({
          at: pseudo === '::before' ? anchor[0] - 0.5 : anchor[1] + 0.5,
          node: decoration,
        });
      }
    }
    decorations.sort((a, b) => a.at - b.at);
    decorations.forEach((decoration, order) => {
      nodes.splice(Math.max(0, Math.ceil(decoration.at) + order), 0, decoration.node);
    });

    // Same reasoning as element styles: an authored background keeps its
    // literal value, and only a class-driven one falls back to the computed
    // colour.
    // Inline only, exactly as for element styles: a slide whose colour comes
    // from `.slide` in theme.css must keep getting it from there. Reading the
    // computed value instead froze the theme into the deck — a title slide
    // with `color: null` and a photograph behind it came back opaque white,
    // and editing theme.css afterwards would no longer reach it.
    const authoredBackground = inlineDeclarations(root);
    const rootComputed = computed(root);
    const rootBackgroundImage = rootComputed.backgroundImage?.trim() || 'none';
    const background = authoredBackground['background']
      ?? authoredBackground['background-color']
      ?? (independent && rootBackgroundImage === 'none'
        && !ignorableComputed('background-color', rootComputed.backgroundColor)
        ? rootComputed.backgroundColor : null);
    // Read the authored URL, not the computed one: by the time the browser has
    // resolved it, `assets/cover.jpg` has become an absolute file:// or deck://
    // URL, and storing that in the deck would break the moment the folder moved.
    const image = (authoredBackground['background-image'] ?? '')
      .match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
    // The deck background model deliberately stays simple (colour + image),
    // but an independently authored page may use layered gradients. Preserve
    // that paint as one isolated canvas-sized fallback underneath the native
    // objects instead of throwing the visual foundation away or rasterising
    // the entire slide.
    if (independent && rootBackgroundImage !== 'none' && !image) {
      const backgroundStyle: Record<string, string> = {};
      for (const property of [
        'background-color', 'background-image', 'background-size',
        'background-position', 'background-repeat', 'background-clip',
      ]) {
        const value = rootComputed.getPropertyValue(property).trim();
        if (!ignorableComputed(property, value)) backgroundStyle[property] = value;
      }
      nodes.unshift({
        tag: 'div',
        elementId: null,
        classes: [],
        dataset: {},
        rect: { x: 0, y: 0, w: origin.width, h: origin.height },
        rotation: 0,
        opacity: 1,
        style: backgroundStyle,
        html: '<div data-slide-editor-fallback-root></div>',
        attrs: {},
        verbatim: true,
        css: '',
        fallbackReason: 'Complex CSS slide background',
      });
    }
    return {
      id: root.dataset.slideId ?? null,
      name: root.dataset.name ?? '',
      notes: root.dataset.notes ?? '',
      background: { color: background, image: image ? image[1] : null },
      morphFromPrevious: root.dataset.morphFromPrevious === 'true',
      ...(root.dataset.layout !== undefined ? {
        layout: root.dataset.layout,
        // Whether the section paints its own background, rather than wearing
        // the deck's: only then does a layout slide keep it.
        ownBackground: Boolean(root.style.background || root.style.backgroundColor || root.style.backgroundImage),
      } : {}),
      ...(root.dataset.morphDuration !== undefined
        ? { morphDuration: Number(root.dataset.morphDuration) }
        : {}),
      ...(root.dataset.base !== undefined ? { base: root.dataset.base, baseIds: root.dataset.baseIds } : {}),
      nodes,
      warnings,
    };
  });
}

/** One text element whose content no longer fits its box, even after auto-fit. */
export interface TextOverflow {
  slideId: string | null;
  elementId: string | null;
  overflowX: boolean;
  overflowY: boolean;
  /** How far past the box the content reaches, in canvas pixels. */
  beyond: { x: number; y: number };
  /** The size auto-fit settled on, when the element opts in. */
  fittedFontSize: number | null;
}

/**
 * Find text that spills out of its box in a *built* page — the export
 * `slidesToHtml` produces, where every element already sits in the player's
 * own markup and the page carries the auto-fit script.
 *
 * This is the check the compile walk cannot make: the walk measures the
 * author's free-flowing markup, but whether a text box clips is a fact about
 * the built slide, after its box is fixed and auto-fit has settled. Auto-fit
 * is re-run here synchronously (the page's own pass runs on a later animation
 * frame), so a box that stays overflowing did so at the fit's minimum size.
 *
 * Self-contained for the same reason as `measureSlides`: it is serialised
 * into a bare offscreen window.
 */
export function measureTextOverflows(doc: Document): TextOverflow[] {
  const view = doc.defaultView;
  if (!view) throw new Error('The document being measured has no window');
  const fit = (view as unknown as {
    fitAutoTextElement?: (node: HTMLElement) => number | null;
  }).fitAutoTextElement;

  const found: TextOverflow[] = [];
  for (const root of doc.querySelectorAll<HTMLElement>('section.slide')) {
    for (const node of root.querySelectorAll<HTMLElement>('.element-text')) {
      const body = node.querySelector<HTMLElement>(':scope > .text-body');
      const content = body?.querySelector<HTMLElement>(':scope > .text-content');
      if (!body || !content) continue;
      if ((node.dataset.autofit === 'true' || node.dataset.nowrap === 'true') && fit) fit(node);
      // A condensed box squeezes horizontally with a transform, which scroll
      // sizes ignore; the fit records its scale so width can be judged as painted.
      const scaleX = Number.parseFloat(content.dataset.fittedScaleX ?? '1') || 1;
      const x = Math.round((content.scrollWidth * scaleX - body.clientWidth) * 10) / 10;
      // A box that clips (auto-fit, no-wrap) loses whatever its content's
      // scroll size exceeds — the same test auto-fit fits to. One that does
      // not still paints the ascenders and descenders a tight line-height
      // hangs past its lines, so only the lines themselves count there: read
      // by scroll size, every title set `line-height: 1` reported a few pixels
      // of "clipping" and an agent went to fix text that was fine. (No layout,
      // as in jsdom, means no line height to read.)
      const clips = view.getComputedStyle(body).overflowY !== 'visible';
      const height = clips ? content.scrollHeight : content.offsetHeight || content.scrollHeight;
      const y = Math.round((height - body.clientHeight) * 10) / 10;
      // One pixel of grace, not auto-fit's half: scroll and client sizes are
      // integer-quantised, and the fitted size is rounded to a tenth of a
      // pixel after a fit that itself tolerates half a pixel — so a correctly
      // fitted element can measure a pixel over. Real clipping (a wrapped
      // line, a cut descender row) is an order of magnitude larger.
      if (x <= 1 && y <= 1) continue;
      const fitted = content.dataset.fittedFontSize;
      found.push({
        slideId: root.dataset.slideId ?? null,
        elementId: node.dataset.elementId ?? null,
        overflowX: x > 1,
        overflowY: y > 1,
        beyond: { x: Math.max(0, x), y: Math.max(0, y) },
        fittedFontSize: fitted ? Number(fitted) : null,
      });
    }
  }
  return found;
}

/** `measureTextOverflows` as an expression a bare browser window can evaluate. */
export function measureTextOverflowsSource(): string {
  return `(${measureTextOverflows.toString()})(document)`;
}

/**
 * `measureSlides` as an expression a bare browser window can evaluate.
 *
 * The offscreen compiler is a plain Electron script with no bundler, so it
 * cannot import this module — it is handed the function's own source instead.
 * That keeps one implementation for both browsers rather than a copy that
 * quietly drifts.
 */
export function measureSlidesSource(): string {
  return `(${measureSlides.toString()})(document)`;
}
