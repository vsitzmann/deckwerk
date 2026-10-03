import type { ShapeEl, TextEl } from './deck.js';
import { cssMediaBorder, cssMediaRadius } from './nativeCss.js';
import { setBoxShadow, setShapeShadow, shapeShadow } from './shapeShadow.js';
import { cssGradient } from './shapeSvg.js';

/**
 * Text inside a box.
 *
 * A rectangle or an ellipse with words in it is one object: a text box that
 * carries a fill, a border and a corner radius as CSS on its own box. The
 * player already paints that, and an HTML import already produces it, so
 * typing into a shape turns the shape into such a text box in place — same
 * id, same geometry, same look — rather than floating a second object over
 * it that is left behind the first time the shape is dragged.
 */

type Style = Record<string, string>;

/** Only closed boxes hold text; a line, an arrow or a path has no inside. */
export function canHoldText(shape: ShapeEl): boolean {
  return shape.shape === 'rect' || shape.shape === 'ellipse';
}

/** Room between the box's edge and its words. */
const BOX_PADDING = '12px 20px';

/** The text box that looks like `shape` and is ready to be typed into. */
export function shapeToTextBox(shape: ShapeEl): TextEl {
  const {
    type: _type, shape: kind, fill, fillGradient, stroke, strokeWidth, radius,
    path: _path, pathSize: _pathSize, arrowStart: _arrowStart, arrowEnd: _arrowEnd,
    control: _control,
    ...base
  } = shape;
  const style: Style = { ...shape.style };
  // The shape's shadow followed its outline; the box's own shadow does the same.
  const shadow = shapeShadow(style);
  setShapeShadow(style, null);
  if (shadow) setBoxShadow(style, shadow);
  setTextBoxFill(style, fill);
  // A gradient fill becomes the box's background image, over the flat `fill`.
  if (fill && fillGradient) style['background-image'] = cssGradient(fill, fillGradient);
  setTextBoxBorder(style, stroke && strokeWidth > 0 ? { color: stroke, width: strokeWidth } : null);
  if (kind === 'ellipse') style['border-radius'] = '50%';
  else setTextBoxRadius(style, radius);
  style.padding = BOX_PADDING;
  style['box-sizing'] = 'border-box';
  return {
    ...base,
    type: 'text',
    // The prompt is shown on the canvas only, and is replaced by the first key.
    class: [...base.class.filter((name) => name !== 'placeholder'), 'placeholder'],
    style,
    html: 'Text',
    align: 'center',
    valign: 'middle',
    autoFit: true,
  };
}

export interface TextBoxPaint {
  fill: string | null;
  border: { color: string; width: number } | null;
  /** Corner radius in px; null when the box is round (`50%`) or the radius is not a plain length. */
  radius: number | null;
  round: boolean;
}

/** A plain colour, as opposed to a gradient or an image the colour picker cannot show. */
function solidColor(value: string | undefined): string | null {
  const color = value?.trim();
  if (!color || /^(none|transparent|initial|inherit|unset)$/i.test(color)) return null;
  if (/gradient\(|url\(|\s(?![^(]*\))/.test(color)) return null;
  return color;
}

/** The box paint of a text element, as the inspector edits it. */
export function textBoxPaint(style: Style): TextBoxPaint {
  // Gradient text clips a background to the glyphs; that paint is not a box fill.
  const clipped = /text/i.test(style['background-clip'] ?? style['-webkit-background-clip'] ?? '');
  const fill = clipped ? null : solidColor(style['background-color']) ?? solidColor(style.background);
  const radius = style['border-radius'] ? cssMediaRadius(style['border-radius']) : null;
  return {
    fill,
    border: cssMediaBorder(style),
    radius: radius && 'borderRadius' in radius ? radius.borderRadius
      : style['border-radius'] ? null : 0,
    round: Boolean(radius && 'maskShape' in radius),
  };
}

/** Whether the text element paints a box at all, and so can cast a box shadow. */
export function hasTextBox(style: Style): boolean {
  const paint = textBoxPaint(style);
  return paint.fill !== null || paint.border !== null;
}

export function setTextBoxFill(style: Style, color: string | null): void {
  if (solidColor(style.background)) delete style.background;
  // Picking a flat fill replaces a gradient carried over from a shape; left in
  // place, it would paint over the colour just chosen.
  // Gradient *text* (the image clipped to the glyphs) is the letters' paint, not the box's.
  const clipped = /text/i.test(style['background-clip'] ?? style['-webkit-background-clip'] ?? '');
  if (!clipped && /gradient\(/i.test(style['background-image'] ?? '')) delete style['background-image'];
  if (color) style['background-color'] = color;
  else delete style['background-color'];
}

export function setTextBoxBorder(
  style: Style,
  border: { color: string; width: number } | null,
): void {
  for (const property of ['border', 'border-width', 'border-style', 'border-color']) {
    delete style[property];
  }
  if (border && border.width > 0) {
    style.border = `${border.width}px solid ${border.color}`;
    // Without this a border grows the box outwards, past the size on the ruler.
    style['box-sizing'] = 'border-box';
  }
}

export function setTextBoxRadius(style: Style, radius: number): void {
  if (radius > 0) style['border-radius'] = `${radius}px`;
  else delete style['border-radius'];
}
