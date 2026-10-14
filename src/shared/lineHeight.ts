/**
 * Line height is stored as a ratio of the font size, everywhere.
 *
 * A unitless `line-height` is the only form CSS re-resolves at every font
 * size: a run, a paragraph or the box itself set in a new size keeps the same
 * proportion of leading. A length is resolved once, where it is declared, and
 * then inherited as that length -- so a box imported at 48px with
 * `line-height: 63.36px` kept 63px lines after its text was set to 20px, and
 * auto-fit could shrink the glyphs but never the lines between them. `em` and
 * `%` are lengths in the same sense (they compute to px where declared).
 *
 * Every path that brings a deck, an element or imported markup into the app
 * goes through `normalizeStyleLineHeight` / `normalizeHtmlLineHeights`: the
 * deck schema applies them on parse (so decks written before this heal on
 * load) and the HTML importer applies them as it builds elements. A px value
 * whose font size is not stated beside it is left exactly as it is -- the
 * ratio cannot be known without guessing, and guessing would move lines.
 */

/** Three decimals is well under a pixel of leading at any size the canvas allows. */
function formatRatio(ratio: number): string {
  return String(Math.round(ratio * 1000) / 1000);
}

const NUMBER = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const PX = new RegExp(String.raw`^${NUMBER}px$`, 'i');
const EM = new RegExp(String.raw`^${NUMBER}em$`, 'i');
const PERCENT = new RegExp(String.raw`^${NUMBER}%$`);

/**
 * The unitless equivalent of `lineHeight` at `fontSize`, or null when it is
 * already unitless, a keyword (`normal`), or a px length whose ratio cannot be
 * worked out because the font size is unknown or not itself in px.
 */
export function lineHeightRatio(lineHeight: string, fontSize?: string): string | null {
  const value = lineHeight.trim();
  const em = EM.exec(value);
  if (em) return formatRatio(Number(em[1]));
  const percent = PERCENT.exec(value);
  if (percent) return formatRatio(Number(percent[1]) / 100);
  const px = PX.exec(value);
  if (!px) return null;
  const size = PX.exec((fontSize ?? '').trim());
  const sizePx = size ? Number(size[1]) : Number.NaN;
  if (!(sizePx > 0)) return null;
  return formatRatio(Number(px[1]) / sizePx);
}

/**
 * `style` with its line height as a ratio of the font size declared beside it.
 * Returns the same object when there is nothing to change, so a parse of a
 * healthy deck allocates nothing.
 */
export function normalizeStyleLineHeight<T extends Record<string, string>>(style: T): T {
  const lineHeight = style['line-height'];
  if (lineHeight === undefined) return style;
  const ratio = lineHeightRatio(lineHeight, style['font-size']);
  if (ratio === null) return style;
  return { ...style, 'line-height': ratio };
}

/** Quick reject: markup with no line-height length in it is returned untouched. */
const LENGTH_LINE_HEIGHT = /line-height\s*:\s*[\d.]+\s*(?:px|em|%)/i;
const STYLE_ATTRIBUTE = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;
const DECLARATION = /(^|;)(\s*line-height\s*:\s*)([^;]*)/i;
const FONT_SIZE = /(?:^|;)\s*font-size\s*:\s*([^;]*)/i;

/**
 * The same rule for the inline styles inside rich text: a block or run that
 * declares a line height as a length gets the ratio of the font size declared
 * on that same element. One that declares no px size of its own is left
 * alone, since what it inherits depends on where the markup is put.
 */
export function normalizeHtmlLineHeights(html: string): string {
  if (!LENGTH_LINE_HEIGHT.test(html)) return html;
  return html.replace(STYLE_ATTRIBUTE, (whole, lead: string, double?: string, single?: string) => {
    const css = double ?? single ?? '';
    const declaration = DECLARATION.exec(css);
    if (!declaration) return whole;
    const fontSize = FONT_SIZE.exec(css)?.[1];
    // The attribute is HTML-escaped; a px or em value never contains an entity.
    const ratio = lineHeightRatio(declaration[3], fontSize);
    if (ratio === null) return whole;
    const next = css.replace(DECLARATION, (_match, start: string, name: string, value: string) =>
      `${start}${name}${ratio}${/\s$/.test(value) ? ' ' : ''}`);
    const quote = double !== undefined ? '"' : "'";
    return `${lead}${quote}${next}${quote}`;
  });
}

/** The range the Line spacing controls accept, as a multiple of the font size. */
export const LINE_SPACING_MIN = 0.5;
export const LINE_SPACING_MAX = 4;

/** A typed line spacing, clamped to the controls' range and to two decimals. */
export function lineSpacingValue(value: number): number {
  const clamped = Math.max(LINE_SPACING_MIN, Math.min(LINE_SPACING_MAX, value));
  return Math.round(clamped * 100) / 100;
}
