export interface HtmlSanitizationReport {
  removedScripts: number;
  removedEventHandlers: number;
  blockedUrls: string[];
  dataUrls: Array<{ mime: string; value: string }>;
}

/**
 * Sanitize a complete authored document before it enters the measuring frame.
 * Imported slides can use HTML, CSS, SVG, images, video, and CSS animation.
 * They cannot run JavaScript or fetch presentation-time external resources.
 */
export function sanitizeAuthoredHtml(source: string): {
  html: string;
  report: HtmlSanitizationReport;
} {
  const parser = new DOMParser();
  const document = parser.parseFromString(source, 'text/html');
  const report: HtmlSanitizationReport = {
    removedScripts: 0,
    removedEventHandlers: 0,
    blockedUrls: [],
    dataUrls: [],
  };

  for (const node of document.querySelectorAll('script, object, embed, iframe')) {
    report.removedScripts += 1;
    node.remove();
  }
  for (const node of document.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        node.removeAttribute(attribute.name);
        report.removedEventHandlers += 1;
        continue;
      }
      if (!['src', 'href', 'poster', 'xlink:href', 'action', 'formaction'].includes(name)) continue;
      const value = attribute.value.trim();
      // The URL parser strips ASCII tabs, newlines and other control characters
      // out of a scheme before it looks at it, so `java&#9;script:` is run as
      // `javascript:`. The scheme is tested the way the browser will read it.
      const scheme = value.replace(/[\u0000-\u0020]/g, '');
      if (/^javascript:/i.test(scheme)) {
        node.removeAttribute(attribute.name);
        report.blockedUrls.push(value);
      } else if (/^https?:/i.test(value)) {
        // A normal anchor is inert slide content. Media, styles, and SVG links
        // would fetch during authoring or presentation, so remove those.
        if (!(node.tagName.toLowerCase() === 'a' && name === 'href')) {
          node.removeAttribute(attribute.name);
          report.blockedUrls.push(value);
        }
      } else if (/^data:/i.test(value)) {
        const mime = /^data:([^;,]+)/i.exec(value)?.[1] ?? 'application/octet-stream';
        report.dataUrls.push({ mime, value });
      }
    }
  }

  for (const style of document.querySelectorAll('style')) {
    const original = style.textContent ?? '';
    style.textContent = original
      .replace(/@import\s+(?:url\()?\s*['"]?https?:[^;]+;/gi, (match) => {
        report.blockedUrls.push(match);
        return '/* external import removed */';
      })
      .replace(/url\(\s*(['"]?)https?:[^)]+\)/gi, (match) => {
        report.blockedUrls.push(match);
        return 'none';
      });
  }

  const doctype = document.doctype ? '<!doctype html>\n' : '';
  return { html: doctype + document.documentElement.outerHTML, report };
}

/**
 * Markup that may live inside a text box, dropped in from another
 * application's clipboard.
 *
 * A text box holds prose: paragraphs, lists, tables, inline runs, links and
 * embedded images. Everything else on the clipboard is either a document-level
 * artefact (`<meta>`, `<style>`, Word's conditional comments), a control that
 * cannot be edited as text, or an active element — and a pasted `<iframe>` or
 * remote `<img>` would be saved into the deck and fetched again every time the
 * slide is shown. Nodes that only wrap text are unwrapped so the words stay;
 * active ones are removed outright.
 */
const PASTE_REMOVED = 'script, style, link, meta, base, iframe, object, embed, form, input,'
  + ' textarea, select, button, noscript, template, audio, source, track, canvas, map, area';
const PASTE_UNWRAPPED = 'font, marquee, center, header, footer, nav, aside, main, article,'
  + ' section, figure, figcaption, label, fieldset, legend, video';

/**
 * Declarations that describe the *box* a run was copied out of rather than
 * the run itself. Chromium serialises the computed style of the copied
 * selection onto the fragment, so text cut from a bullet arrives wearing the
 * item's hanging indent (`text-indent: -1.4em`), its line height, alignment
 * and white-space; Word wraps paragraphs in margins of its own. Pasted into a
 * box that owns all of those through its theme and inspector, they either do
 * nothing (an indent on an inline run) or fight the box (a paragraph margin
 * that ignores the paragraph spacing). Character-level formatting — weight,
 * style, colour, decoration, size, spacing — is what the author meant to
 * carry over, and stays; so does a paragraph's alignment, which the inspector
 * writes the same way.
 */
const PASTE_LAYOUT_PROPERTIES = [
  'text-indent', 'line-height', 'white-space',
  'white-space-collapse', 'text-wrap', 'text-wrap-mode', 'orphans', 'widows',
  'display', 'float', 'clear', 'position', 'top', 'right', 'bottom', 'left',
  'z-index', 'width', 'height', 'min-width', 'max-width', 'min-height',
  'max-height', 'margin', 'margin-top', 'margin-right', 'margin-bottom',
  'margin-left', 'margin-block', 'margin-block-start', 'margin-block-end',
  'margin-inline', 'margin-inline-start', 'margin-inline-end', 'padding',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'padding-block', 'padding-block-start', 'padding-block-end', 'padding-inline',
  'padding-inline-start', 'padding-inline-end', 'text-size-adjust',
  '-webkit-text-size-adjust', '-webkit-text-stroke-width', 'tab-size',
  'overflow-wrap', 'word-break', 'caret-color', 'outline', 'cursor',
  'user-select', '-webkit-user-select', 'pointer-events',
];
/** Elements whose geometry is content: an image's size, a cell's padding. */
const PASTE_LAYOUT_KEPT = 'img, video, svg, table, colgroup, col, td, th';

/**
 * How far a raised or lowered run shrinks. The value is em-relative on
 * purpose: the run then keeps tracking whatever size it inherits, including
 * the size auto-fit writes on `.text-content`.
 */
export const BASELINE_RUN_FONT_SIZE = '0.7em';

/**
 * True for a font size expressed as a ratio to its context (`0.7em`, `84%`,
 * `smaller`) rather than as a measurement. The distinction matters whenever a
 * size is applied to text: an absolute size is an authored fact that a new one
 * replaces, while a relative size is a *relationship* — it is how superscripts,
 * subscripts, and proportionally scaled runs are written, and how they keep
 * tracking the text around them (auto-fit's fitted size included). Overwriting
 * one with a measurement silently destroys that relationship: the raised digit
 * jumps to full size, and in an auto-fitting box it then drags every other
 * line down with it.
 */
export function isRelativeFontSize(value: string | null | undefined): boolean {
  return /(?:em|rem|%|ex|ch|vw|vh|vmin|vmax)$|^(?:smaller|larger)$/i
    .test((value ?? '').trim());
}

/** Tag-based inline formatting and the style-only span it canonicalizes to. */
const TAG_FORMAT_STYLES: Record<string, Array<[string, string]>> = {
  B: [['font-weight', '700']],
  STRONG: [['font-weight', '700']],
  I: [['font-style', 'italic']],
  EM: [['font-style', 'italic']],
  U: [['text-decoration-line', 'underline']],
  // A superscript is raised *and* shrunk. Keeping only the baseline shift
  // would paste a full-size character sitting above the line, which reads as
  // a layout bug rather than as a superscript.
  SUP: [['vertical-align', 'super'], ['font-size', BASELINE_RUN_FONT_SIZE]],
  SUB: [['vertical-align', 'sub'], ['font-size', BASELINE_RUN_FONT_SIZE]],
};

/**
 * Drop the box-level declarations (see PASTE_LAYOUT_PROPERTIES) from every
 * styled node under `root`, and unwrap a span that has nothing left to say.
 *
 * Paste is not the only way they arrive. When a deletion joins two blocks —
 * a cut or Backspace across a list item boundary — Chromium wraps the text it
 * moves in a span wearing the removed block's computed style, so a bullet's
 * hanging indent turns up as `text-indent: -1.4em` on an inline run. Node
 * identity is preserved (styles are edited, wrappers replaced by their own
 * children), so a live caret inside the text stays where it was.
 */
export function stripLayoutDeclarations(root: ParentNode): boolean {
  let changed = false;
  for (const node of [...root.querySelectorAll<HTMLElement>('[style]')]) {
    if (node.matches(PASTE_LAYOUT_KEPT) || !node.style) continue;
    for (const property of PASTE_LAYOUT_PROPERTIES) {
      if (!node.style.getPropertyValue(property)) continue;
      node.style.removeProperty(property);
      changed = true;
    }
    if (node.getAttribute('style')?.trim()) continue;
    node.removeAttribute('style');
    if (node.tagName === 'SPAN' && node.attributes.length === 0) node.replaceWith(...node.childNodes);
  }
  return changed;
}

/** Recover authored delimiters from KaTeX's generated HTML/MathML render tree. */
export function restoreKatexSourceHtml(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  // KaTeX embeds the exact authored TeX in an application/x-tex annotation.
  // Display wrappers must go first or their inner `.katex` node would be
  // mistaken for inline maths.
  const authoredTex = (node: Element): string | null =>
    node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? null;
  for (const display of [...root.querySelectorAll<HTMLElement>('.katex-display')]) {
    const tex = authoredTex(display);
    if (tex === null) continue;
    // auto-render wraps display output in one otherwise empty span so it can
    // replace a text-node slice. That wrapper is generated too; retaining it
    // makes a healed equation differ from its original authored source.
    const wrapper = display.parentElement;
    const generatedWrapper = wrapper?.tagName === 'SPAN'
      && wrapper.attributes.length === 0
      && wrapper.childNodes.length === 1;
    display.replaceWith(document.createTextNode(`$$${tex}$$`));
    if (generatedWrapper) wrapper.replaceWith(...wrapper.childNodes);
  }
  for (const inline of [...root.querySelectorAll<HTMLElement>('.katex')]) {
    const tex = authoredTex(inline);
    if (tex !== null) inline.replaceWith(document.createTextNode(`$${tex}$`));
  }
  return template.innerHTML;
}

/**
 * Drop solid backgrounds from pasted runs of text.
 *
 * Copying styled text makes Chromium write the background of the nearest
 * painted ancestor onto the copied run: the editor's own tint on a box being
 * edited, or the fill of the text box it came from. Pasted, that becomes a
 * coloured slab behind the words inside another box. The editor has no
 * run-level highlight to preserve, and a box's fill belongs to the box, so a
 * pasted run keeps its colour and type but never a background. Gradient text
 * (a background clipped to the glyphs) is paint of the letters and stays.
 */
function stripRunBackgrounds(root: DocumentFragment): void {
  for (const node of [...root.querySelectorAll<HTMLElement>('[style*="background"]')].reverse()) {
    const clip = node.style.getPropertyValue('background-clip')
      || node.style.getPropertyValue('-webkit-background-clip');
    if (/text/i.test(clip)) continue;
    node.style.removeProperty('background-color');
    const shorthand = node.style.getPropertyValue('background');
    if (shorthand && !/gradient\(|url\(/i.test(shorthand)) node.style.removeProperty('background');
    if (node.getAttribute('style')?.trim()) continue;
    node.removeAttribute('style');
    if (node.tagName === 'SPAN' && node.attributes.length === 0) node.replaceWith(...node.childNodes);
  }
}

export function sanitizePastedTextHtml(html: string): string {
  const template = document.createElement('template');
  // Copying rendered maths from the canvas puts KaTeX's generated render tree
  // on the clipboard, not the `$...$` source stored in the text element. That
  // tree contains both an accessible MathML copy and a painted HTML copy; if
  // it is persisted verbatim, the next render sees no delimiters and can only
  // display the stale generated markup. Recover it before generic cleanup.
  template.innerHTML = restoreKatexSourceHtml(html);
  const root = template.content;
  root.querySelectorAll(PASTE_REMOVED).forEach((node) => node.remove());
  // Innermost first, so nested wrappers all collapse in one pass.
  [...root.querySelectorAll<HTMLElement>(PASTE_UNWRAPPED)].reverse().forEach((node) => {
    node.replaceWith(...node.childNodes);
  });
  // Word namespace remnants (<o:p> and friends) are invisible plumbing.
  for (const node of [...root.querySelectorAll<HTMLElement>('*')].reverse()) {
    if (node.tagName.includes(':')) node.replaceWith(...node.childNodes);
  }
  // The editor writes inline formatting as style-only spans; readers accept
  // both dialects but the writers cancel rather than remove tag formatting,
  // so pasted <strong>/<em>/<u> accreted contradictory layers
  // (<strong><span style="font-weight:400">…) that no toggle could clean up.
  // Convert the tag dialect to the span dialect on the way in.
  for (const node of [...root.querySelectorAll<HTMLElement>(
    'b, strong, i, em, u, sup, sub',
  )].reverse()) {
    const declarations = TAG_FORMAT_STYLES[node.tagName]!;
    const span = document.createElement('span');
    for (const attribute of [...node.attributes]) {
      span.setAttribute(attribute.name, attribute.value);
    }
    for (const [property, value] of declarations) {
      if (!span.style.getPropertyValue(property)) span.style.setProperty(property, value);
    }
    span.append(...node.childNodes);
    node.replaceWith(span);
  }
  // Word's pseudo-lists arrive as MsoListParagraph paragraphs whose "bullet"
  // is a literal glyph in the text. Strip the fake marker and the vendor
  // classes; the paragraphs stay paragraphs (the author can re-list them).
  for (const node of root.querySelectorAll<HTMLElement>('[class*="Mso"]')) {
    if (/MsoListParagraph/i.test(node.className)) {
      const marker = /^\s*(?:[·•§▪◦]\s*|o\s+)/u;
      const first = node.firstChild;
      if (first instanceof Text) {
        first.data = first.data.replace(marker, '');
        if (!first.data) first.remove();
      } else if (first instanceof HTMLElement && marker.test(first.textContent ?? '')
        && !(first.textContent ?? '').replace(marker, '').trim()) {
        first.remove();
      }
    }
    const kept = [...node.classList].filter((name) => !/^Mso/i.test(name));
    if (kept.length > 0) node.className = kept.join(' ');
    else node.removeAttribute('class');
  }
  // Vendor style declarations (mso-*) mean nothing outside Office and keep
  // resurfacing in later edits; drop them, keep the rest of the style.
  for (const node of root.querySelectorAll<HTMLElement>('[style*="mso-"]')) {
    for (let index = node.style.length - 1; index >= 0; index -= 1) {
      const property = node.style.item(index);
      if (property.startsWith('mso-')) node.style.removeProperty(property);
    }
    if (!node.getAttribute('style')?.trim()) node.removeAttribute('style');
  }
  stripLayoutDeclarations(root);
  stripRunBackgrounds(root);
  for (const node of root.querySelectorAll<HTMLElement>('*')) {
    for (const attribute of [...node.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'contenteditable' || name === 'draggable') {
        node.removeAttribute(attribute.name);
        continue;
      }
      if (!['src', 'href', 'poster', 'xlink:href', 'srcset', 'background'].includes(name)) continue;
      const value = attribute.value.trim();
      const inertAnchor = node.tagName === 'A' && name === 'href' && /^https?:/i.test(value);
      if (/^(?:data|deck|asset):/i.test(value) || inertAnchor) continue;
      // Anything else would fetch while authoring or presenting.
      node.removeAttribute(attribute.name);
      if (node.tagName === 'IMG') node.remove();
    }
  }
  return template.innerHTML;
}
