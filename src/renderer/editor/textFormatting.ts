import type { SlideElement } from '@shared/deck.js';
import { isRelativeFontSize } from '@shared/htmlSafety.js';

type TextElement = Extract<SlideElement, { type: 'text' }>;
export type TextFormat = 'bold' | 'italic' | 'underline';
/**
 * Superscript and subscript are one exclusive baseline choice rather than a
 * third independent toggle, and — unlike bold, italic and underline — they
 * only ever describe a run inside a box. Raising a whole box is meaningless
 * (a block has no baseline to shift against), so these two live outside
 * `TextFormat`: the whole-box helpers below deliberately do not accept them.
 */
export type BaselineFormat = 'superscript' | 'subscript';
export type InlineTextFormat = TextFormat | BaselineFormat;

export function isBaselineFormat(format: InlineTextFormat): format is BaselineFormat {
  return format === 'superscript' || format === 'subscript';
}

function serialized(fragment: DocumentFragment): string {
  const out = document.createElement('div');
  out.append(fragment.cloneNode(true));
  return out.innerHTML;
}

function removeEmptyStyleAttribute(node: HTMLElement): void {
  if (!node.getAttribute('style')?.trim()) node.removeAttribute('style');
}

/**
 * Make a character property uniform across authored rich text. A box-level
 * declaration alone is not enough: styles on paragraphs, cells, and inline
 * runs beat an inherited value. Writing the property on every text-bearing
 * leaf keeps the existing block/list/table structure while giving every
 * character the requested formatting.
 */
function setHtmlTextProperty(
  html: string,
  property: string,
  value: string | null,
  aliases: string[] = [],
): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  const properties = [property, ...aliases];
  let changed = false;

  // A proportional run size is a relationship to its surroundings, not an
  // authored measurement: superscripts and scaled runs are written `0.7em`
  // so they keep tracking the box size, this new one included. Leave those
  // declarations alone — clearing them, as every other property is cleared,
  // would snap every raised digit up to the box's full size.
  const proportionalSize = (node: HTMLElement): boolean =>
    property === 'font-size' && isRelativeFontSize(node.style.fontSize);

  for (const node of template.content.querySelectorAll<HTMLElement>('*')) {
    if (proportionalSize(node)) continue;
    for (const candidate of properties) {
      if (node.style.getPropertyValue(candidate)) {
        node.style.removeProperty(candidate);
        changed = true;
      }
    }
    removeEmptyStyleAttribute(node);
  }

  if (value !== null) {
    const parents = new Set<HTMLElement>();
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const text = current as Text;
      if (!text.data) continue;
      if (text.parentElement) parents.add(text.parentElement);
      else {
        const span = document.createElement('span');
        text.replaceWith(span);
        span.appendChild(text);
        parents.add(span);
      }
    }
    for (const parent of parents) {
      // Anything still declaring a size after the pass above is proportional,
      // so a run under one inherits the new size already, scaled.
      if (property === 'font-size') {
        let inherited = false;
        for (
          let node: HTMLElement | null = parent;
          node && template.content.contains(node);
          node = node.parentElement
        ) {
          if (node.style.fontSize) { inherited = true; break; }
        }
        if (inherited) continue;
      }
      parent.style.setProperty(property, value);
      if (property === 'color') parent.style.setProperty('-webkit-text-fill-color', value);
    }

    // Decorations painted by an ancestor propagate through descendants and
    // cannot be cancelled by a leaf alone. Override every authored ancestor.
    if (property === 'text-decoration' && value === 'none') {
      for (const node of template.content.querySelectorAll<HTMLElement>('*')) {
        if (node.textContent) node.style.setProperty(property, value);
      }
    }
    changed = parents.size > 0;
  }

  return changed ? serialized(template.content) : html;
}

/**
 * Note that the author set (or cleared) `property` on the whole box. Pinned
 * copies the app writes never come through here, so the record separates
 * "customised" from "held still" -- the difference between "Body+" and "Body".
 */
export function recordTextOverride(element: TextElement, property: string, set: boolean): void {
  const current = new Set(element.overrides ?? []);
  if (set) current.add(property);
  else current.delete(property);
  if (current.size > 0) element.overrides = [...current];
  else delete element.overrides;
}

export function setWholeTextStyle(
  element: TextElement,
  property: 'font-family' | 'font-size' | 'font-weight' | 'font-style' | 'text-decoration',
  value: string | null,
): void {
  const style = { ...element.style };
  if (value === null) delete style[property];
  else style[property] = value;
  element.style = style;
  recordTextOverride(element, property, value !== null);
  const aliases = property === 'text-decoration' ? ['text-decoration-line'] : [];
  // Auto-fit owns the font-size on `.text-content`. Descendant sizes would
  // defeat that fitted value, so an authored box size is only the ceiling and
  // all run-level size overrides are removed.
  const inlineValue = property === 'font-size' && element.autoFit ? null : value;
  element.html = setHtmlTextProperty(element.html, property, inlineValue, aliases);
}

export function setWholeTextColor(element: TextElement, value: string | null): void {
  const style = { ...element.style };
  const contentStyle = { ...element.contentStyle };
  for (const declarations of [style, contentStyle]) {
    const textClipped = /text/i.test(
      declarations['background-clip'] ?? declarations['-webkit-background-clip'] ?? '',
    );
    delete declarations.color;
    delete declarations['-webkit-text-fill-color'];
    if (textClipped) {
      delete declarations.background;
      delete declarations['background-image'];
      delete declarations['background-clip'];
      delete declarations['-webkit-background-clip'];
    }
  }
  if (value) style.color = value;
  element.style = style;
  recordTextOverride(element, 'color', Boolean(value));
  if (Object.keys(contentStyle).length > 0) element.contentStyle = contentStyle;
  else delete element.contentStyle;
  element.html = setHtmlTextProperty(
    element.html,
    'color',
    null,
    [
      '-webkit-text-fill-color',
      'background',
      'background-image',
      'background-clip',
      '-webkit-background-clip',
    ],
  );
}

export function setWholeTextAlignment(
  element: TextElement,
  value: 'left' | 'center' | 'right' | 'justify',
): void {
  element.align = value;
  element.html = setHtmlTextProperty(element.html, 'text-align', value);
}

export function setWholeTextParagraphSpacing(element: TextElement, value: number | null): void {
  if (value === null) delete element.paragraphSpacing;
  else element.paragraphSpacing = Math.max(0, value);
  const template = document.createElement('template');
  template.innerHTML = element.html;
  let changed = false;
  for (const node of template.content.querySelectorAll<HTMLElement>('*')) {
    for (const property of ['margin-top', 'margin-bottom']) {
      if (!node.style.getPropertyValue(property)) continue;
      node.style.removeProperty(property);
      changed = true;
    }
    removeEmptyStyleAttribute(node);
  }
  if (changed) element.html = serialized(template.content);
}

/**
 * Set the whole box's line spacing, a ratio of its font size (see
 * shared/lineHeight.ts), or hand it back to the theme with null. Spacing set
 * on single paragraphs goes with it, as paragraph spacing does: the control
 * reads as the box's spacing, so the box has one afterwards.
 */
export function setWholeTextLineHeight(element: TextElement, value: number | null): void {
  const style = { ...element.style };
  if (value === null) delete style['line-height'];
  else style['line-height'] = String(value);
  element.style = style;
  recordTextOverride(element, 'line-height', value !== null);
  if (element.contentStyle?.['line-height'] !== undefined) {
    const contentStyle = { ...element.contentStyle };
    delete contentStyle['line-height'];
    if (Object.keys(contentStyle).length > 0) element.contentStyle = contentStyle;
    else delete element.contentStyle;
  }
  element.html = setHtmlTextProperty(element.html, 'line-height', null);
}

/** One text node's effective toggle state, resolved from the inside out. */
function textNodeState(text: Text, format: TextFormat): boolean {
  for (let node = text.parentElement; node; node = node.parentElement) {
    if (format === 'bold') {
      if (node.style.fontWeight) {
        const weight = Number.parseInt(node.style.fontWeight, 10);
        return node.style.fontWeight === 'bold' || weight >= 600;
      }
      if (/^(B|STRONG)$/.test(node.tagName)) return true;
    } else if (format === 'italic') {
      if (node.style.fontStyle) return node.style.fontStyle === 'italic';
      if (/^(I|EM)$/.test(node.tagName)) return true;
    } else {
      const declared = node.style.textDecorationLine || node.style.textDecoration;
      if (declared) return declared.includes('underline');
      if (node.tagName === 'U') return true;
    }
  }
  return false;
}

/** Whether every character of authored markup renders with the format. */
function htmlFormatState(html: string, format: TextFormat): boolean | null {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  let sawText = false;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const text = current as Text;
    if (!text.data.trim()) continue;
    sawText = true;
    if (!textNodeState(text, format)) return false;
  }
  return sawText ? true : null;
}

export function wholeTextFormatState(
  element: TextElement,
  format: TextFormat,
  inheritedWeight: number | null = null,
): boolean {
  // An explicit box-level declaration wins; otherwise the state is what the
  // authored markup actually renders. Reading only `element.style` made
  // Cmd/Ctrl+B on a box of pasted-bold text toggle the wrong way: the box
  // read as "not bold", so the shortcut double-bolded instead of unbolding.
  //
  // A box following its theme declares nothing and can still be bold -- the
  // theme's title weight. The caller passes the weight the cascade computed
  // so the button reads (and toggles) what is on screen.
  if (format === 'bold') {
    const declared = element.style['font-weight'];
    if (declared) {
      return declared === 'bold' || Number.parseInt(declared, 10) >= 600;
    }
    const markup = htmlFormatState(element.html, format);
    if (markup === true) return true;
    if (inheritedWeight !== null && inheritedWeight >= 600) {
      // Runs that say "not bold" in so many words override the theme's weight;
      // runs that say nothing inherit it.
      return !/font-weight:\s*(normal|lighter|[1-5]00)\b/i.test(element.html);
    }
    return markup ?? false;
  } else if (format === 'italic') {
    const declared = element.style['font-style'];
    if (declared) return declared === 'italic';
  } else {
    const declared = element.style['text-decoration'];
    if (declared) return declared.includes('underline');
  }
  return htmlFormatState(element.html, format) ?? false;
}

export function setWholeTextFormat(
  element: TextElement,
  format: TextFormat,
  active: boolean,
): void {
  if (format === 'bold') setWholeTextStyle(element, 'font-weight', active ? '700' : '400');
  else if (format === 'italic') setWholeTextStyle(element, 'font-style', active ? 'italic' : 'normal');
  else setWholeTextStyle(element, 'text-decoration', active ? 'underline' : 'none');
}

export function toggleWholeTextFormat(element: TextElement, format: TextFormat): void {
  setWholeTextFormat(element, format, !wholeTextFormatState(element, format));
}

/**
 * The type properties a theme role owns. Switching a box's role has to clear
 * every one of them: an inline declaration — on the box, on `.text-content`,
 * or on a run inside the markup — beats the role class in the cascade, so a
 * role change on imported text was otherwise invisible.
 *
 * Paint is deliberately absent. A role carries type, not colour: the deck
 * stylesheets that decks actually ship style `.role-*` with size and weight
 * and leave `color` to `.slide`, while an imported box carries an explicit
 * colour chosen for what sits behind it. Clearing that colour dropped white
 * text over a dark photograph back to the stylesheet's near-black and the box
 * read as blank. An author who wants the theme's colour clears it with the
 * Colour field's own "follow theme" control.
 */
const ROLE_PROPERTIES = [
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
] as const;

/**
 * Retag a text box with a semantic role and set it in that role's type.
 *
 * `defaults` is the current theme's type for the role, and it is written on
 * the box so it wins outright. Clearing the overrides and letting the cascade
 * decide is not enough: a deck's theme.css keeps whichever `.role-*` rules
 * were installed when the deck was made, so on a deck themed since — the
 * common case — falling through dressed the box in the *old* theme. Holding
 * its own size also keeps the box exactly as it is when the deck's default
 * size for the role is edited later; a deck-wide theme apply strips these
 * inline values again as it installs its own stylesheet.
 *
 * Pass `null` for a deck with no theme chosen at all: there is no "current
 * theme" to impose, and the deck's own stylesheet is the whole authority.
 */
export function applyTextRole(
  element: TextElement,
  role: string | null,
  defaults: {
    family: string;
    size: number;
    weight: number;
    lineHeight: number;
    letterSpacing: string;
  } | null,
): void {
  element.class = element.class.filter((name) => !name.startsWith('role-'));
  if (role) element.class.push(role.startsWith('role-') ? role : `role-${role}`);
  // Choosing a role is asking for that role's type: its properties are the
  // role's again, not the author's. Bold, italic and colour are not role
  // type and survive, as do the runs inside the markup.
  for (const property of ROLE_PROPERTIES) recordTextOverride(element, property, false);

  const style = { ...element.style };
  const contentStyle = { ...element.contentStyle };
  for (const declarations of [style, contentStyle]) {
    for (const property of ROLE_PROPERTIES) delete declarations[property];
  }

  if (role && defaults) {
    style['font-family'] = defaults.family;
    style['font-size'] = `${defaults.size}px`;
    style['font-weight'] = String(defaults.weight);
    style['line-height'] = String(defaults.lineHeight);
    style['letter-spacing'] = defaults.letterSpacing;
  }

  element.style = style;
  if (Object.keys(contentStyle).length > 0) element.contentStyle = contentStyle;
  else delete element.contentStyle;
  // Runs inside the markup are content formatting, not role formatting: a
  // bold word or a small unit after a figure survives a change of role. Only
  // the box's own copies of the type properties are the role's to replace.
}
