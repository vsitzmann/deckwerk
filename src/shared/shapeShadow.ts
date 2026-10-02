/**
 * A shape's drop shadow, as the inspector edits it.
 *
 * The shadow is stored as ordinary CSS on the element, `filter:
 * drop-shadow(...)`, which the player already paints and the HTML round trip
 * already carries. A filter is used rather than `box-shadow` because it
 * follows the shape's own paint: a line, an arrow, a path or an unfilled
 * outline casts the shadow of its strokes, not of its bounding box.
 *
 * A plain `box-shadow` written by hand or by an HTML import is recognised
 * too, so a shadow that is already there shows up in the control, and is
 * rewritten as a filter the first time it is edited.
 */

export interface ShapeShadow {
  /** Horizontal offset, canvas px. */
  x: number;
  /** Vertical offset, canvas px. */
  y: number;
  /** Blur radius, canvas px. */
  blur: number;
  /** Any CSS colour, normally `rgba(...)` so the shadow can be translucent. */
  color: string;
}

export const DEFAULT_SHAPE_SHADOW: ShapeShadow = {
  x: 0, y: 8, blur: 24, color: 'rgba(0, 0, 0, 0.3)',
};

/** Glyphs are thin, so their default shadow sits closer and tighter than a box's. */
export const DEFAULT_TEXT_SHADOW: ShapeShadow = {
  x: 0, y: 4, blur: 10, color: 'rgba(0, 0, 0, 0.35)',
};

type Style = Record<string, string>;

/** Split on top-level whitespace (or commas), leaving `rgba(0, 0, 0, .3)` whole. */
function splitTopLevel(value: string, separator: 'space' | 'comma'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    const splits = depth === 0 && (separator === 'comma' ? char === ',' : /\s/.test(char));
    if (splits) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** A pixel length or a bare zero; anything else (em, %, calc) is not editable here. */
function pixels(token: string): number | null {
  const match = /^(-?(?:\d+\.?\d*|\.\d+))(px)?$/i.exec(token);
  if (!match) return null;
  const value = Number(match[1]);
  if (!match[2] && value !== 0) return null;
  return value;
}

/**
 * `<x> <y> [blur] [spread] <colour>` with the colour first or last, the two
 * orders CSS allows and the order computed styles serialise in.
 */
function parseShadowArguments(value: string, allowSpread: boolean): ShapeShadow | null {
  const tokens = splitTopLevel(value, 'space');
  if (tokens.some((token) => token.toLowerCase() === 'inset')) return null;
  const lengths: number[] = [];
  const colors: string[] = [];
  for (const token of tokens) {
    const length = pixels(token);
    if (length !== null) lengths.push(length);
    else colors.push(token);
  }
  if (colors.length !== 1 || lengths.length < 2) return null;
  if (lengths.length > (allowSpread ? 4 : 3)) return null;
  // A spread changes the shadow's size, which drop-shadow cannot express.
  if (lengths.length === 4 && lengths[3] !== 0) return null;
  const blur = lengths[2] ?? 0;
  if (blur < 0) return null;
  return { x: lengths[0], y: lengths[1], blur, color: colors[0] };
}

/** The filter's functions in order, e.g. `['blur(2px)', 'drop-shadow(...)']`. */
function filterFunctions(filter: string | undefined): string[] {
  const value = filter?.trim();
  if (!value || value.toLowerCase() === 'none') return [];
  return splitTopLevel(value, 'space');
}

const isDropShadow = (fn: string): boolean => /^drop-shadow\(/i.test(fn);

/** A box's own single, plain shadow: what a filled text box casts. */
export function boxShadow(style: Style): ShapeShadow | null {
  const value = style['box-shadow']?.trim();
  if (!value || value.toLowerCase() === 'none') return null;
  if (splitTopLevel(value, 'comma').length !== 1) return null;
  return parseShadowArguments(value, true);
}

/** The shadow the inspector can edit, or null when there is none (or none it can represent). */
export function shapeShadow(style: Style): ShapeShadow | null {
  const shadows = filterFunctions(style.filter).filter(isDropShadow);
  if (shadows.length === 1) {
    const inner = shadows[0].slice(shadows[0].indexOf('(') + 1, shadows[0].lastIndexOf(')'));
    return parseShadowArguments(inner, false);
  }
  if (shadows.length > 1) return null;
  return boxShadow(style);
}

/**
 * Offsets are stored finer than anyone types them, so that an offset set by
 * angle and distance reads back as the same angle and distance rather than
 * as 12.01 px at 45.1°.
 */
const round = (value: number): number => Math.round(value * 10000) / 10000;
const hundredths = (value: number): number => Math.round(value * 100) / 100;

/**
 * A text box's shadow is `text-shadow`, which follows the glyphs. (A filter
 * would too, but `filter` on text belongs to the typed effects list.) One
 * layer is editable; a hand-written stack of several is left alone.
 */
export function textShadow(style: Style): ShapeShadow | null {
  const value = style['text-shadow']?.trim();
  if (!value || value.toLowerCase() === 'none') return null;
  if (splitTopLevel(value, 'comma').length !== 1) return null;
  return parseShadowArguments(value, false);
}

/** Write (or, with null, remove) a text box's shadow. */
export function setTextShadow(style: Style, shadow: ShapeShadow | null): void {
  if (!shadow) {
    delete style['text-shadow'];
    return;
  }
  style['text-shadow'] = `${round(shadow.x)}px ${round(shadow.y)}px `
    + `${round(Math.max(0, shadow.blur))}px ${shadow.color}`;
}

/** Write (or, with null, remove) a box's shadow. A layered or inset one written by hand is left alone. */
export function setBoxShadow(style: Style, shadow: ShapeShadow | null): void {
  const existing = style['box-shadow']?.trim();
  if (existing && existing.toLowerCase() !== 'none' && !boxShadow(style)) return;
  if (!shadow) {
    delete style['box-shadow'];
    return;
  }
  style['box-shadow'] = `${round(shadow.x)}px ${round(shadow.y)}px `
    + `${round(Math.max(0, shadow.blur))}px ${shadow.color}`;
}

/** With no offset there is no direction; the shadow is taken to fall straight down. */
const RESTING_ANGLE = 270;

/**
 * The offset as the direction the shadow falls in and how far, the way
 * Keynote states it: degrees counter-clockwise from the right, so 270 is
 * straight down and 315 is down and to the right.
 */
export function shadowPolar(shadow: ShapeShadow): { angle: number; distance: number } {
  const distance = Math.hypot(shadow.x, shadow.y);
  if (distance < 0.005) return { angle: RESTING_ANGLE, distance: 0 };
  const degrees = (Math.atan2(-shadow.y, shadow.x) * 180) / Math.PI;
  return { angle: Math.round(((degrees % 360) + 360) % 360 * 10) / 10 % 360, distance: hundredths(distance) };
}

/** The x/y offset for an angle and a distance, rounded to what is stored. */
export function shadowOffset(angle: number, distance: number): { x: number; y: number } {
  const radians = (angle * Math.PI) / 180;
  const length = Math.max(0, distance);
  // `+ 0` turns the -0 a rounded cosine can leave into a plain zero.
  return { x: round(length * Math.cos(radians)) + 0, y: round(-length * Math.sin(radians)) + 0 };
}

/**
 * Write (or, with null, remove) the editable shadow. Other filter functions
 * are kept in place, and a `box-shadow` is only removed when it is the simple
 * one this control showed — a layered or inset shadow written by hand stays.
 */
export function setShapeShadow(style: Style, shadow: ShapeShadow | null): void {
  if (boxShadow(style)) delete style['box-shadow'];
  const kept = filterFunctions(style.filter).filter((fn) => !isDropShadow(fn));
  if (shadow) {
    kept.push(`drop-shadow(${round(shadow.x)}px ${round(shadow.y)}px `
      + `${round(Math.max(0, shadow.blur))}px ${shadow.color})`);
  }
  if (kept.length > 0) style.filter = kept.join(' ');
  else delete style.filter;
}

/**
 * A curved ("paper") shadow, as Keynote draws one: the object seems to lift
 * off the slide at its two bottom corners, so the shadow pools under them and
 * thins out towards the middle. It is two blurred, skewed slivers painted
 * behind the object by player.css; the element only carries the settings, as
 * custom properties, which keeps them in the deck's ordinary CSS and in the
 * HTML round trip.
 */
export interface CurvedShadow {
  /** Any CSS colour. */
  color: string;
  /** Blur radius, canvas px. */
  blur: number;
  /** How far the corners lift: the depth of the shadow under them, canvas px. */
  lift: number;
}

export const DEFAULT_CURVED_SHADOW: CurvedShadow = { color: 'rgba(0, 0, 0, 0.5)', blur: 14, lift: 20 };

/**
 * The class player.css draws the curl from. It is derived from the style, so
 * whatever rebuilds an element's class list must add it back (render.ts and
 * staticState.ts both go through this).
 */
export function curvedShadowClasses(style: Style): string[] {
  return style['--curl-color']?.trim() ? ['shadow-curved'] : [];
}

export function curvedShadow(style: Style): CurvedShadow | null {
  const color = style['--curl-color']?.trim();
  if (!color) return null;
  const px = (value: string | undefined, fallback: number): number => pixels(value?.trim() ?? '') ?? fallback;
  return {
    color,
    blur: px(style['--curl-blur'], DEFAULT_CURVED_SHADOW.blur),
    lift: px(style['--curl-lift'], DEFAULT_CURVED_SHADOW.lift),
  };
}

/** Write (or, with null, remove) a curved shadow. */
export function setCurvedShadow(style: Style, shadow: CurvedShadow | null): void {
  delete style['--curl-color'];
  delete style['--curl-blur'];
  delete style['--curl-lift'];
  if (!shadow) return;
  style['--curl-color'] = shadow.color;
  style['--curl-blur'] = `${round(Math.max(0, shadow.blur))}px`;
  style['--curl-lift'] = `${round(Math.max(0, shadow.lift))}px`;
}
