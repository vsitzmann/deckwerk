import { z } from 'zod';
import { renameRetiredFields } from './fieldAliases.js';

/**
 * The deck format. This schema is the single source of truth: `deck.json` is
 * validated against it on load, and every other module derives its types from
 * here rather than declaring its own.
 *
 * Geometry is absolute pixels on a fixed canvas (default 1920x1080). The player
 * scales the whole stage with one CSS transform, so nothing downstream ever has
 * to reason about viewport size.
 */

const Id = z.string().min(1);

const ThemeFontRoleSchema = z.object({
  family: z.string(),
  size: z.number().positive(),
  weight: z.number(),
  lineHeight: z.number().positive(),
  letterSpacing: z.string(),
  color: z.string().optional(),
});

export const ThemeStyleSchema = z.object({
  fonts: z.object({
    title: ThemeFontRoleSchema,
    heading: ThemeFontRoleSchema,
    body: ThemeFontRoleSchema,
    caption: ThemeFontRoleSchema,
    base: ThemeFontRoleSchema,
  }),
  palette: z.array(z.string()),
  colors: z.object({
    background: z.string(),
    text: z.string(),
    muted: z.string(),
    accent: z.string(),
  }),
});

/**
 * The theme the author last applied, and which of its properties they took.
 *
 * `themeStyle` records the deck's *defaults*; this records the *choice*. They
 * come apart whenever a theme is applied to slides rather than deck-wide: that
 * writes the theme onto those slides inline and leaves the deck defaults alone,
 * so without this a slide created afterwards would have no way of knowing which
 * theme its siblings are wearing.
 */
const ThemeSelectionSchema = z.object({
  /** Preset id from shared/themes.ts. */
  preset: z.string(),
  roles: z.array(z.enum(['title', 'heading', 'body', 'caption', 'base']))
    .default(['title', 'body', 'caption']),
  fontFamily: z.boolean().default(false),
  fontWeight: z.boolean().default(false),
  typeScale: z.boolean().default(false),
  textColor: z.boolean().default(false),
  objectColors: z.boolean().default(false),
});

/**
 * A comment attached to a slide or an element. Comments live in deck.json so
 * they sync through the same element-level diff/merge as every other edit and
 * survive download/export. `ts` is an ISO-8601 timestamp.
 */
export const CommentSchema = z.object({
  id: Id,
  author: z.string().default(''),
  text: z.string(),
  ts: z.string(),
  resolved: z.boolean().default(false),
  /** Optional parent comment for a lightweight reply thread. */
  parentId: Id.optional(),
});

/** Shared geometry for every element. */
const BaseElement = z.object({
  id: Id,
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  /** Clockwise degrees about the element's centre. */
  rot: z.number().default(0),
  /** Paint order within the slide; ties break on array order. */
  z: z.number().int().default(0),
  opacity: z.number().min(0).max(1).default(1),
  /** CSS classes hooking this element up to theme.css. */
  class: z.array(z.string()).default([]),
  /** Inline style escape hatch, applied after classes. */
  style: z.record(z.string()).default({}),
  /** Explicit identity shared by elements manually paired for Morph. */
  morphId: z.string().nullable().optional(),
  /** Stable ancestry retained when an object is duplicated, for opt-in Auto-pair. */
  lineageId: z.string().nullable().optional(),
  /** Source object in a fixed layout master; synchronized copies are read-only on slides. */
  layoutMasterId: z.string().optional(),
  /** Discussion attached to this element; absent when there is none. */
  comments: z.array(CommentSchema).optional(),
});

export const MediaEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('blur'), radius: z.number().min(0).max(200) }),
  z.object({ type: z.literal('posterize'), levels: z.number().int().min(2).max(32) }),
  z.object({ type: z.literal('grayscale'), amount: z.number().min(0).max(1) }),
  z.object({
    type: z.literal('gaussianNoise'),
    /** Linear blend: zero is the source paint and one is noise only. */
    amount: z.number().min(0).max(1),
    /** Normalised spatial-frequency cutoff; larger values produce finer grain. */
    frequencyCutoff: z.number().min(0.001).max(1),
  }),
]);

const TextElement = BaseElement.extend({
  type: z.literal('text'),
  /** Inline HTML. Fonts and sizes are expected to come from theme.css. */
  html: z.string().default(''),
  /**
   * CSS applied directly to the inner text-content node rather than the
   * positioned element wrapper. This is the escape hatch for glyph paint
   * such as gradient text, clipping and text strokes that cannot work through
   * inherited wrapper CSS alone.
   */
  contentStyle: z.record(z.string()).optional(),
  /** Shrink text as needed to keep it inside its box; never enlarge past its authored size. */
  autoFit: z.boolean().optional(),
  /**
   * A text object whose sole authored child is a table. Keeping the cell HTML
   * in the existing rich-text field preserves editing and formatting, while
   * this structured layout record makes the object behave like a native slide
   * table instead of an arbitrary text box.
   *
   * Column widths are positive relative weights. The renderer normalises them
   * to percentages, so changing the outer width scales every column and moving
   * an internal divider only changes its two neighbours.
   *
   * Formatting deliberately stays in HTML/CSS: the element's classes style
   * its wrapper and classes or inline styles on table rows/cells stay in html.
   * This keeps fills, borders, padding and typography fully agent-editable.
   */
  table: z.object({
    columnWidths: z.array(z.number().positive()).min(1),
    /** Grow and shrink the element height to its laid-out rows. */
    autoHeight: z.boolean().default(true),
  }).optional(),
  /**
   * Disable automatic line wrapping: lines break only where the author wrote
   * a break. Overlong lines are compressed by the auto-fit shrink (which this
   * flag implies) rather than wrapped.
   */
  noWrap: z.boolean().optional(),
  /**
   * How a no-wrap box compresses an overlong line. 'shrink' (the default)
   * reduces the font size uniformly, preserving the glyphs' aspect ratio;
   * 'condense' keeps the font size and squeezes the type horizontally.
   * Only meaningful with noWrap.
   */
  noWrapMode: z.enum(['shrink', 'condense']).optional(),
  /**
   * Vertical gap in px between paragraphs and between bullet list items.
   * Unset keeps the theme's default spacing.
   */
  paragraphSpacing: z.number().min(0).optional(),
  align: z.enum(['left', 'center', 'right', 'justify']).default('left'),
  valign: z.enum(['top', 'middle', 'bottom']).default('top'),
  /** Ordered, non-destructive visual effects. Order is significant. */
  effects: z.array(MediaEffectSchema).optional(),
  /** Required semantic slot when this text is a fixed layout placeholder. */
  layoutPlaceholder: z.enum(['title', 'body']).optional(),
  /**
   * CSS properties the author set on the whole box deliberately (bold, a
   * chosen face, a colour). The rest of `style` may be copies the app wrote
   * to pin the box while the theme changed under it. The theme may replace
   * those copies; it never touches an override. A box with any override is
   * shown as "Body+", InDesign-style, and "Follow theme" clears them.
   */
  overrides: z.array(z.string()).optional(),
});

const ImageElement = BaseElement.extend({
  type: z.literal('image'),
  /** Deck-relative path, e.g. "assets/fig.png". */
  src: z.string(),
  fit: z.enum(['contain', 'cover', 'fill']).default('contain'),
  alt: z.string().default(''),
  /**
   * Shape of the element box's mask. 'circle' clips the visible window to the
   * box's inscribed ellipse, so the editor squares the box when it turns the
   * mask on and hands the picture to `sourceBox` at its own aspect ratio --
   * that is what makes the crop a true circle instead of an oval, and what
   * gives Keynote-style "shift the photo behind a circular mask" editing.
   * Absent means rectangular.
   */
  maskShape: z.enum(['rect', 'circle']).optional(),
  /** Ordered, non-destructive visual effects. Order is significant. */
  effects: z.array(MediaEffectSchema).optional(),
  borderColor: z.string().nullable().optional(),
  borderWidth: z.number().min(0).optional(),
  borderRadius: z.number().min(0).optional(),
  /**
   * A crop, expressed as where the *whole* image sits relative to this
   * element's box. The element box is the visible window; anything outside it
   * is clipped.
   *
   * This is how Keynote's masks survive import: Keynote keeps the full image
   * (often far larger than the slide) and a separate mask rectangle, so a
   * cropped figure cannot be represented by the element box alone.
   */
  sourceBox: z
    .object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })
    .nullable()
    .default(null),
});

const VideoElement = BaseElement.extend({
  type: z.literal('video'),
  src: z.string(),
  fit: z.enum(['contain', 'cover', 'fill']).default('contain'),
  /** Shape of the element box's mask; same semantics as on images. */
  maskShape: z.enum(['rect', 'circle']).optional(),
  autoplay: z.boolean().default(true),
  loop: z.boolean().default(true),
  muted: z.boolean().default(true),
  controls: z.boolean().default(false),
  /** Ordered, non-destructive visual effects. Order is significant. */
  effects: z.array(MediaEffectSchema).optional(),
  borderColor: z.string().nullable().optional(),
  borderWidth: z.number().min(0).optional(),
  borderRadius: z.number().min(0).optional(),
  /** Non-destructive in/out points in seconds; `end: null` means end of file. */
  start: z.number().min(0).default(0),
  end: z.number().min(0).nullable().default(null),
  poster: z.string().nullable().default(null),
  /**
   * Crop, expressed exactly as on an image: where the *whole* video sits
   * relative to this element's box, which acts as the visible window.
   *
   * Cropping is done in CSS rather than by re-encoding, so it is instant,
   * reversible and editable later. The cost is that an export still ships the
   * full source file, which is an accepted trade.
   */
  sourceBox: z
    .object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })
    .nullable()
    .default(null),
});

const ShapeElement = BaseElement.extend({
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'line', 'arrow', 'path']),
  fill: z.string().nullable().default(null),
  /**
   * A two-colour gradient: from `fill` to `to`, running in `angle` degrees
   * counter-clockwise from the right (270 is top to bottom), like the shadow
   * direction. Absent or null is a flat fill.
   */
  fillGradient: z.object({
    to: z.string(),
    angle: z.number().default(270),
    kind: z.enum(['linear', 'radial']).default('linear'),
  }).nullable().optional(),
  stroke: z.string().nullable().default(null),
  strokeWidth: z.number().min(0).default(2),
  radius: z.number().min(0).default(0),
  /**
   * SVG path data, for `shape: "path"`. This is how imported vector art and
   * Keynote connector lines keep their real geometry instead of degrading to a
   * bounding box.
   */
  path: z.string().nullable().default(null),
  /** Coordinate space `path` is drawn in; scaled to the element box on render. */
  pathSize: z
    .object({ w: z.number().positive(), h: z.number().positive() })
    .nullable()
    .default(null),
  arrowStart: z.boolean().default(false),
  arrowEnd: z.boolean().default(false),
  /** Absolute canvas-space control point for an editable quadratic curve. */
  control: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
});

/** Escape hatch: arbitrary markup that still drags and resizes like anything else. */
const HtmlElement = BaseElement.extend({
  type: z.literal('html'),
  html: z.string().default(''),
  /** Isolate new fidelity fallbacks in a ShadowRoot. Old HTML stays unisolated. */
  sandboxed: z.boolean().optional(),
  /** Styles captured from the authored document and scoped by the ShadowRoot. */
  css: z.string().optional(),
  /** Human-readable reason this region could not become native objects. */
  fallbackReason: z.string().optional(),
});

/**
 * A sandboxed web page — an interactive chart, a demo, a Claude artifact —
 * shown live inside its box. The document is a deck-relative HTML file under
 * `assets/`; it runs in an `<iframe sandbox="allow-scripts">`, so it can use
 * JavaScript but never reaches the deck, the app, or another slide. Previews
 * and print show `poster` when there is one.
 */
const WebElement = BaseElement.extend({
  type: z.literal('web'),
  /** Deck-relative path to a complete HTML document, normally `assets/web/…html`. */
  src: z.string(),
  /** Deck-relative still used wherever the page cannot run (PDF, thumbnails). */
  poster: z.string().nullable().default(null),
  /** Whether the page receives pointer input while presenting. Off, clicks advance the deck. */
  interactive: z.boolean().default(true),
  /** Accessible name and inspector label for the embedded page. */
  title: z.string().default(''),
});

/**
 * Produced by the Keynote importer when it meets an object it cannot map.
 * Carries the original geometry so the slide stays laid out correctly, and
 * renders as a labelled dashed box so the gap is visible rather than silent.
 */
const UnsupportedElement = BaseElement.extend({
  type: z.literal('unsupported'),
  /** Originating archive type, e.g. "TSD.ChartArchive". */
  originalType: z.string().default('unknown'),
  note: z.string().default(''),
});

export const ElementSchema = z.discriminatedUnion('type', [
  TextElement,
  ImageElement,
  VideoElement,
  ShapeElement,
  HtmlElement,
  WebElement,
  UnsupportedElement,
]);

const SlideBackgroundSchema = z.object({
  color: z.string().nullable().default(null),
  image: z.string().nullable().default(null),
});

const LayoutMasterSchema = z.object({
  background: SlideBackgroundSchema.default({ color: null, image: null }),
  elements: z.array(ElementSchema).default([]),
});

/**
 * Timeline entries are `trigger + action` pairs evaluated in array order.
 *
 * v1 implements the `click`/`afterPrev` triggers and the `appear`/`play`
 * actions; the rest are accepted by the schema so that richer animations can
 * land later without a format migration.
 */
export const TriggerSchema = z.object({
  on: z.enum(['click', 'afterPrev', 'withPrev', 'mediaEnd']),
  /** Element whose event we wait on. Required for `mediaEnd`. */
  ref: Id.nullable().default(null),
  /** Milliseconds to wait after the trigger fires. */
  delay: z.number().min(0).default(0),
});

export const ActionSchema = z.object({
  type: z.enum([
    'appear',
    'disappear',
    'play',
    'pause',
    'seek',
    'addClass',
    'removeClass',
  ]),
  target: Id,
  /**
   * Seconds for `seek`; class name for `addClass`/`removeClass`. On `appear`,
   * `"byParagraph"` reveals text a paragraph at a time and `"draw"` draws a
   * line or arrow in from its start to its end. On `appear` or `disappear`,
   * `"dissolve"` fades the element in or out and `"blur"` brings it into (or
   * takes it out of) focus as it fades.
   */
  value: z.union([z.number(), z.string()]).nullable().default(null),
  /** Milliseconds an animated build takes (`"draw"`, `"dissolve"`, `"blur"`). */
  duration: z.number().min(0).optional(),
});

export const TimelineEntrySchema = z.object({
  id: Id,
  trigger: TriggerSchema,
  action: ActionSchema,
});

export const SlideSchema = z.object({
  id: Id,
  name: z.string().default(''),
  background: SlideBackgroundSchema.default({ color: null, image: null }),
  notes: z.string().default(''),
  /** Geometry preset; themes may decorate it but never own its positions. */
  layout: z.enum(['freeform', 'standard', 'title']).optional(),
  /** True while the concrete slide background mirrors its selected layout master. */
  layoutBackgroundInherited: z.boolean().optional(),
  /** Animate the transition from the preceding slide, including unpaired fades. */
  morphFromPrevious: z.boolean().optional(),
  /** Duration of the Morph transition from the preceding slide, in milliseconds. */
  morphDuration: z.number().min(100).max(5000).optional(),
  /** Kept in the deck and editable, but stepped over when presenting. */
  skipped: z.boolean().optional(),
  elements: z.array(ElementSchema).default([]),
  timeline: z.array(TimelineEntrySchema).default([]),
  /** Discussion attached to the slide as a whole; absent when there is none. */
  comments: z.array(CommentSchema).optional(),
});

/**
 * A theme the deck carries itself, indistinguishable from a built-in preset
 * once resolved.
 *
 * Presets in `shared/themes.ts` ship with the app; these ship with the deck,
 * so a theme an agent wrote for this talk travels in the deck folder and
 * survives being handed to someone else. Same shape as a built-in — id, name,
 * description, the five font roles, the swatch row and the four grounds — so
 * every surface that resolves a preset id finds one either way.
 */
export const CustomThemeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'theme ids are lowercase, digits and dashes'),
  name: z.string().min(1),
  description: z.string().default(''),
  fonts: ThemeStyleSchema.shape.fonts,
  palette: z.array(z.string()),
  colors: ThemeStyleSchema.shape.colors,
});

export const DeckSchema = z.object({
  version: z.literal(1),
  title: z.string().default('Untitled'),
  canvas: z
    .object({ w: z.number().positive(), h: z.number().positive() })
    .default({ w: 1920, h: 1080 }),
  /** Deck-relative path to the stylesheet the user hand-edits. */
  theme: z.string().default('theme.css'),
  /** Installed theme preset id (see shared/themes.ts); null when none. */
  themePreset: z.string().nullable().default(null),
  /** Persistent deck defaults, composed property-by-property from theme presets. */
  themeStyle: ThemeStyleSchema.nullable().default(null),
  /** The last applied preset and properties, so new slides can match. */
  themeSelection: ThemeSelectionSchema.nullable().default(null),
  /**
   * Preset ids this deck has actually *worn*, most recently used first.
   *
   * Selecting a card in the gallery is not a use: only applying a theme to
   * slides and creating a slide under one write here. That is what lets the
   * picker point at the theme the author would go back to — the deck's real
   * previous look — rather than at whatever card they clicked through last.
   */
  themeHistory: z.array(z.string()).default([]),
  /** Deck-local theme presets, offered and applied exactly like the built-ins. */
  customThemes: z.array(CustomThemeSchema).default([]),
  /** Three fixed, deck-local layout masters. Null preserves legacy hard-coded layouts. */
  layoutMasters: z.object({
    freeform: LayoutMasterSchema,
    standard: LayoutMasterSchema,
    title: LayoutMasterSchema,
  }).nullable().default(null),
  /** Deck-wide motion curve for Morph transitions. */
  morphEasing: z.enum(['ease-in-out', 'ease-out', 'linear']).default('ease-in-out'),
  slides: z.array(SlideSchema).default([]),
});

export type Trigger = z.infer<typeof TriggerSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;
export type SlideElement = z.infer<typeof ElementSchema>;
export type ElementType = SlideElement['type'];
export type TextEl = z.infer<typeof TextElement>;
export type MediaEffect = z.infer<typeof MediaEffectSchema>;
export type ImageEl = z.infer<typeof ImageElement>;
export type VideoEl = z.infer<typeof VideoElement>;
export type ShapeEl = z.infer<typeof ShapeElement>;
export type HtmlEl = z.infer<typeof HtmlElement>;
export type UnsupportedEl = z.infer<typeof UnsupportedElement>;
export type Slide = z.infer<typeof SlideSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type Deck = z.infer<typeof DeckSchema>;
export type ThemeStyle = z.infer<typeof ThemeStyleSchema>;
export type ThemeSelection = z.infer<typeof ThemeSelectionSchema>;
export type CustomTheme = z.infer<typeof CustomThemeSchema>;
export type LayoutMaster = z.infer<typeof LayoutMasterSchema>;

export const DECK_VERSION = 1 as const;

/**
 * Parse and normalise a deck, filling in every default. Throws with a readable,
 * path-annotated message rather than a raw ZodError dump.
 */
export function parseDeck(raw: unknown): Deck {
  const result = DeckSchema.safeParse(migrateDeckMorphDuration(renameRetiredFields(raw)));
  if (result.success) return result.data;
  const details = result.error.issues
    .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('\n');
  throw new Error(`deck.json is not valid:\n${details}`);
}

/**
 * Decks written before per-slide Morph timing stored one global duration.
 * Copy that value onto slides which do not already carry an explicit duration;
 * DeckSchema then strips the retired deck-level field from the parsed result.
 */
function migrateDeckMorphDuration(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const deck = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(deck, 'morphDuration') || !Array.isArray(deck.slides)) return raw;
  const duration = deck.morphDuration;
  return {
    ...deck,
    slides: deck.slides.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
      const slide = candidate as Record<string, unknown>;
      return Object.prototype.hasOwnProperty.call(slide, 'morphDuration')
        ? candidate
        : { ...slide, morphDuration: duration };
    }),
  };
}

/**
 * Inheritable text properties that must be mirrored from a text element's
 * inline `style` onto its `.text-content` node. The element's inline style
 * lives on the outer wrapper and reaches the text only by inheritance, so a
 * theme selector that targets the content node directly (e.g.
 * `.role-title .text-content { color: … }`) silently overrides it — the
 * imported colour disappears and the inspector's colour picker goes dead.
 * Mirroring the value as an inline style on the content node restores the
 * invariant that an element's own style always wins over theme CSS.
 *
 * `font-size` is deliberately absent: auto-fit owns that property on the
 * content node and clears it when disabled.
 */
export const MIRRORED_TEXT_STYLE_PROPERTIES = [
  'color',
  'font-family',
  'font-weight',
  'font-style',
  'letter-spacing',
  'line-height',
  'text-transform',
  'text-decoration',
] as const;

export function emptyDeck(title = 'Untitled'): Deck {
  return parseDeck({
    version: DECK_VERSION,
    title,
    canvas: { w: 1920, h: 1080 },
    theme: 'theme.css',
    slides: [{ id: 'slide-1', name: 'Slide 1' }],
  });
}
