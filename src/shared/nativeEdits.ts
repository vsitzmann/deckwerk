import { z } from 'zod';
import { DeckSchema, ElementSchema, SlideSchema, parseDeck, type Deck, type SlideElement } from './deck.js';
import { diffDecks } from './deckDiff.js';
import { canonicalFieldPath } from './fieldAliases.js';
import { MORPH_NAME } from './featureNames.js';
import type { AgentOperation } from './agent.js';

const SetValuesSchema = z.record(z.unknown()).default({});
const UnsetPathsSchema = z.array(z.string().min(1)).default([]);

const ElementEditSchema = z.object({
  target: z.literal('element'),
  slideId: z.string().min(1),
  elementId: z.string().min(1),
  expectedType: z.enum(['text', 'image', 'video', 'shape', 'html', 'web', 'unsupported']).optional(),
  set: SetValuesSchema,
  unset: UnsetPathsSchema,
});

const SlideEditSchema = z.object({
  target: z.literal('slide'),
  slideId: z.string().min(1),
  set: SetValuesSchema,
  unset: UnsetPathsSchema,
});

const DeckEditSchema = z.object({
  target: z.literal('deck'),
  set: SetValuesSchema,
  unset: UnsetPathsSchema,
});

export const NativeEditSchema = z.discriminatedUnion('target', [
  ElementEditSchema,
  SlideEditSchema,
  DeckEditSchema,
]).superRefine((edit, context) => {
  if (Object.keys(edit.set).length === 0 && edit.unset.length === 0) {
    context.addIssue({ code: 'custom', message: 'an edit must set or unset at least one property' });
  }
});

export const NativeEditRequestSchema = z.object({
  expectedRevision: z.string().optional(),
  edits: z.array(NativeEditSchema).min(1),
});

export type NativeEdit = z.infer<typeof NativeEditSchema>;
export type NativeEditRequest = z.infer<typeof NativeEditRequestSchema>;

export interface NativeEditResult {
  deck: Deck;
  operations: AgentOperation[];
  affectedSlideIds: string[];
  affectedElementIds: string[];
}

interface PropertyDoc {
  path: string;
  type: string;
  description: string;
  values?: unknown[];
  example?: unknown;
  unset?: string;
}

const COMMON_ELEMENT_PROPERTIES: PropertyDoc[] = [
  { path: 'x', type: 'number', description: 'Left edge in canvas pixels.', example: 140 },
  { path: 'y', type: 'number', description: 'Top edge in canvas pixels.', example: 100 },
  { path: 'w', type: 'positive number', description: 'Element box width in canvas pixels.', example: 1640 },
  { path: 'h', type: 'positive number', description: 'Element box height in canvas pixels.', example: 120 },
  { path: 'rot', type: 'number', description: 'Clockwise rotation in degrees.', example: 0 },
  { path: 'z', type: 'integer', description: 'Paint order; larger values are in front.', example: 10 },
  { path: 'opacity', type: 'number 0..1', description: 'Element opacity.', example: 1 },
  { path: 'class', type: 'string[]', description: 'Theme classes such as role-title or role-body.', example: ['role-title'] },
  {
    path: 'style.<css-property>', type: 'string',
    description: 'Inline CSS written exactly as the editor does. Use kebab-case names such as font-family, font-size, font-weight, color, line-height, letter-spacing, background-color, text-transform, and text-decoration.',
    example: 'Inter', unset: 'Unset a style property to restore the class/theme value.',
  },
  { path: 'morphId', type: 'string|null', description: `Explicit ${MORPH_NAME} pairing identity.`, example: 'hero-title' },
];

const ELEMENT_PROPERTIES: Record<SlideElement['type'], PropertyDoc[]> = {
  text: [
    { path: 'html', type: 'string', description: 'Rich text HTML inside the text box.', example: 'A unified title' },
    {
      path: 'contentStyle.<css-property>', type: 'string',
      description: 'Safe CSS applied directly to the inner text glyph/content node. Use this for gradient text, background clipping, text strokes, shadows, and other paint that must not affect the positioned wrapper.',
      example: 'linear-gradient(90deg, #ff4fa3, #52d273)',
      unset: 'Unset an individual content style property to restore normal text paint.',
    },
    { path: 'align', type: 'enum', values: ['left', 'center', 'right', 'justify'], description: 'Horizontal paragraph alignment.', example: 'right' },
    { path: 'valign', type: 'enum', values: ['top', 'middle', 'bottom'], description: 'Vertical alignment inside the box.', example: 'top' },
    { path: 'autoFit', type: 'boolean', description: 'Shrink text until it fits its box.', example: true, unset: 'Unset to use the default off state.' },
    { path: 'autoSize', type: 'boolean', description: 'Keep the box exactly as big as its text (a label); lines break only where authored.', example: true, unset: 'Unset to make it an ordinary wrapping box.' },
    { path: 'noWrap', type: 'boolean', description: 'Break only where authored and fit long lines.', example: true, unset: 'Unset to restore normal wrapping.' },
    { path: 'noWrapMode', type: 'enum', values: ['shrink', 'condense'], description: 'How a no-wrap line is fitted.', example: 'shrink' },
    { path: 'paragraphSpacing', type: 'number >= 0', description: 'Gap in pixels between paragraphs and list items.', example: 12, unset: 'Unset to use theme spacing.' },
  ],
  image: [
    { path: 'src', type: 'deck-relative asset path', description: 'Image asset path. Import assets before setting it.', example: 'assets/figure.png' },
    { path: 'fit', type: 'enum', values: ['contain', 'cover', 'fill'], description: 'How media fits its box.', example: 'cover' },
    { path: 'alt', type: 'string', description: 'Accessible image description.', example: 'Robot reaching for an object' },
    { path: 'maskShape', type: 'enum', values: ['rect', 'circle'], description: 'Rectangular or circular visible mask.', example: 'circle', unset: 'Unset for the default rectangular mask.' },
    { path: 'sourceBox', type: '{x,y,w,h}|null', description: 'Position and size of the full image behind the visible box.', example: { x: -40, y: 0, w: 900, h: 600 } },
    { path: 'effects', type: 'effect[]', description: 'Ordered blur, posterize, grayscale, or Gaussian noise effects.', example: [{ type: 'grayscale', amount: 1 }] },
    { path: 'borderColor', type: 'CSS color|null', description: 'Media border color.', example: '#ffffff' },
    { path: 'borderWidth', type: 'number >= 0', description: 'Media border width in pixels.', example: 2 },
    { path: 'borderRadius', type: 'number >= 0', description: 'Media corner radius in pixels.', example: 24 },
  ],
  video: [
    { path: 'src', type: 'deck-relative asset path', description: 'Video asset path. Import assets before setting it.', example: 'assets/demo.mp4' },
    { path: 'poster', type: 'deck-relative asset path|null', description: 'Poster shown before playback.', example: 'assets/poster.jpg' },
    { path: 'fit', type: 'enum', values: ['contain', 'cover', 'fill'], description: 'How media fits its box.', example: 'cover' },
    { path: 'maskShape', type: 'enum', values: ['rect', 'circle'], description: 'Rectangular or circular visible mask.', example: 'circle', unset: 'Unset for the default rectangular mask.' },
    { path: 'sourceBox', type: '{x,y,w,h}|null', description: 'Position and size of the full video behind the visible box.', example: { x: -40, y: 0, w: 900, h: 600 } },
    { path: 'effects', type: 'effect[]', description: 'Ordered blur, posterize, grayscale, or Gaussian noise effects.', example: [{ type: 'gaussianNoise', amount: 0.35, frequencyCutoff: 0.12 }] },
    { path: 'borderColor', type: 'CSS color|null', description: 'Media border color.', example: '#ffffff' },
    { path: 'borderWidth', type: 'number >= 0', description: 'Media border width in pixels.', example: 2 },
    { path: 'borderRadius', type: 'number >= 0', description: 'Media corner radius in pixels.', example: 24 },
    { path: 'autoplay', type: 'boolean', description: 'Start playing when the slide appears.', example: true },
    { path: 'loop', type: 'boolean', description: 'Loop between the trim points.', example: true },
    { path: 'muted', type: 'boolean', description: 'Mute playback.', example: true },
    { path: 'controls', type: 'boolean', description: 'Show native video controls.', example: false },
    { path: 'start', type: 'number >= 0', description: 'Non-destructive trim in-point in seconds.', example: 1.5 },
    { path: 'end', type: 'number >= 0|null', description: 'Non-destructive trim out-point; null means media end.', example: 8.25 },
  ],
  shape: [
    { path: 'shape', type: 'enum', values: ['rect', 'ellipse', 'line', 'arrow', 'path'], description: 'Shape kind.', example: 'rect' },
    { path: 'fill', type: 'CSS paint|null', description: 'Fill color or gradient.', example: '#2463eb' },
    { path: 'stroke', type: 'CSS color|null', description: 'Outline color.', example: '#ffffff' },
    { path: 'strokeWidth', type: 'number >= 0', description: 'Outline width in pixels.', example: 2 },
    { path: 'radius', type: 'number >= 0', description: 'Rectangle corner radius.', example: 24 },
    { path: 'arrowStart', type: 'boolean', description: 'Arrowhead at the start of a line.', example: false },
    { path: 'arrowEnd', type: 'boolean', description: 'Arrowhead at the end of a line.', example: true },
    { path: 'control', type: '{x,y}|null', description: 'Canvas-space quadratic curve control point.', example: { x: 600, y: 300 } },
    { path: 'path', type: 'SVG path|null', description: 'SVG path data for path shapes.', example: 'M0 0 L100 100' },
    { path: 'pathSize', type: '{w,h}|null', description: 'Coordinate space of SVG path data.', example: { w: 100, h: 100 } },
  ],
  html: [
    { path: 'html', type: 'string', description: 'Markup held by this isolated fallback object.', example: '<div>Fallback</div>' },
  ],
  web: [
    { path: 'src', type: 'deck-relative asset path', description: 'The sandboxed HTML document this box shows live.', example: 'assets/web/chart.a1b2c3d4.html' },
    { path: 'poster', type: 'deck-relative asset path|null', description: 'Still shown where the page cannot run (PDF, thumbnails).', example: 'assets/web/chart.poster.png' },
    { path: 'interactive', type: 'boolean', description: 'Whether the page receives clicks while presenting. Off, clicks advance the deck.', example: true },
    { path: 'title', type: 'string', description: 'Accessible name of the embedded page.', example: 'Papers per year' },
  ],
  unsupported: [],
};

const SLIDE_PROPERTIES: PropertyDoc[] = [
  { path: 'name', type: 'string', description: 'Slide name shown in the outline.', example: 'Method overview' },
  { path: 'background.color', type: 'CSS color|null', description: 'Slide background color; null uses the theme.', example: '#101218' },
  { path: 'background.image', type: 'deck-relative asset path|null', description: 'Slide background image.', example: 'assets/background.png' },
  { path: 'notes', type: 'string', description: 'Speaker notes.', example: 'Emphasize the scaling result.' },
  { path: 'layout', type: 'enum', values: ['freeform', 'standard', 'title'], description: 'Slide layout identity.', example: 'standard' },
  { path: 'morphFromPrevious', type: 'boolean', description: 'Animate from the preceding slide.', example: true },
  { path: 'morphDuration', type: 'number 100..5000', description: `${MORPH_NAME} duration from the preceding slide, in milliseconds.`, example: 900 },
  { path: 'skipped', type: 'boolean', description: 'Keep the slide but skip it during presentation.', example: false },
  { path: 'timeline', type: 'timeline entry[]', description: 'Complete object-build sequence. Targets must remain on this slide.', example: [] },
];

const DECK_PROPERTIES: PropertyDoc[] = [
  { path: 'title', type: 'string', description: 'Presentation title.', example: 'Research update' },
  { path: 'canvas.w', type: 'positive number', description: 'Deck canvas width.', example: 1920 },
  { path: 'canvas.h', type: 'positive number', description: 'Deck canvas height.', example: 1080 },
  { path: 'themePreset', type: 'string|null', description: 'Installed design preset identity.', example: null },
  { path: 'themeStyle.fonts.<role>.<property>', type: 'theme font value', description: 'Theme typography for title, heading, body, caption, or base: family, size, weight, lineHeight, letterSpacing, and optional color.', example: 'Inter' },
  { path: 'themeStyle.colors.<role>', type: 'CSS color', description: 'Theme background, text, muted, or accent color.', example: '#f7f7f8' },
  { path: 'themeStyle.palette', type: 'CSS color[]', description: 'Theme color palette.', example: ['#101218', '#f7f7f8', '#6ea8fe'] },
  { path: 'morphEasing', type: 'enum', values: ['ease-in-out', 'ease-out', 'linear'], description: `Deck-wide ${MORPH_NAME} easing.`, example: 'ease-in-out' },
];

export function nativeEditContract(): Record<string, unknown> {
  return {
    version: 1,
    semantics: [
      'Each edit sets or unsets dotted property paths on one stable deck, slide, or element target.',
      'Unmentioned properties and unrelated objects are preserved exactly.',
      'Patch individual style and themeStyle leaves; whole style objects and overlapping parent/child paths are rejected.',
      'Preview is revision-bound and never mutates the deck. Apply is atomic, labelled, revision-checked, and idempotent.',
      'Use native edits for local changes. Use HTML preview/apply for new slides and substantial redesigns.',
      'Identity, type, lineage, comments, importer-owned fallback metadata, and slide element arrays cannot be patched. Use the dedicated comment or HTML/structural interfaces.',
    ],
    requestExample: {
      edits: [{
        target: 'element', slideId: 'slide-8', elementId: 'title-8',
        set: { align: 'right', x: 140, y: 100, w: 1640, h: 120, 'style.font-family': 'Inter', 'style.font-size': '64px' },
        unset: ['style.letter-spacing'],
      }],
    },
    element: { common: COMMON_ELEMENT_PROPERTIES, byType: ELEMENT_PROPERTIES },
    slide: SLIDE_PROPERTIES,
    deck: DECK_PROPERTIES,
  };
}

export function applyNativeEdits(input: Deck, rawEdits: unknown): NativeEditResult {
  const edits = z.array(NativeEditSchema).min(1).parse(rawEdits);
  const before = parseDeck(input);
  const next = structuredClone(before);
  const affectedSlideIds = new Set<string>();
  const affectedElementIds = new Set<string>();

  edits.forEach((edit, index) => {
    try {
      if (edit.target === 'deck') {
        patchObject(next as unknown as Record<string, unknown>, edit.set, edit.unset, (path) => allowedDeckPath(path));
        for (const slide of next.slides) affectedSlideIds.add(slide.id);
        return;
      }
      const slide = next.slides.find((candidate) => candidate.id === edit.slideId);
      if (!slide) throw new Error(`unknown slide ${edit.slideId}`);
      affectedSlideIds.add(slide.id);
      if (edit.target === 'slide') {
        patchObject(slide as unknown as Record<string, unknown>, edit.set, edit.unset, (path) => allowedSlidePath(path));
        return;
      }
      const element = slide.elements.find((candidate) => candidate.id === edit.elementId);
      if (!element) throw new Error(`unknown element ${edit.elementId} on slide ${slide.id}`);
      if (edit.expectedType && element.type !== edit.expectedType) {
        throw new Error(`element ${element.id} is ${element.type}, not expected ${edit.expectedType}`);
      }
      affectedElementIds.add(element.id);
      const previousPosition = { x: element.x, y: element.y };
      const explicitlySetsControl = Object.keys(edit.set).some((path) => path === 'control' || path.startsWith('control.'))
        || edit.unset.some((path) => path === 'control' || path.startsWith('control.'));
      patchObject(
        element as unknown as Record<string, unknown>, edit.set, edit.unset,
        (path) => allowedElementPath(element.type, path),
      );
      if (element.type === 'shape' && element.control && !explicitlySetsControl) {
        element.control.x += element.x - previousPosition.x;
        element.control.y += element.y - previousPosition.y;
      }
      validateUiBounds(element, edit.set);
      // Make type/identity invariants explicit before the whole-deck parse.
      const parsed = ElementSchema.parse(element);
      if (parsed.id !== edit.elementId || parsed.type !== element.type) throw new Error('element identity or type changed');
    } catch (error) {
      throw new Error(`native edit ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const parsed = DeckSchema.parse(next);
  // Parse slide properties separately so errors around timelines/backgrounds
  // point at the edited object rather than appearing only as a deck failure.
  for (const id of affectedSlideIds) SlideSchema.parse(parsed.slides.find((slide) => slide.id === id));
  const operations = diffDecks(before, parsed);
  if (operations.length === 0) throw new Error('native edits do not change the deck');
  return {
    deck: parsed,
    operations,
    affectedSlideIds: [...affectedSlideIds],
    affectedElementIds: [...affectedElementIds],
  };
}

function patchObject(
  target: Record<string, unknown>,
  set: Record<string, unknown>,
  unset: string[],
  allowed: (path: string) => boolean,
): void {
  const claimed = new Set<string>();
  // An agent working from an older brief still names retired properties, so
  // every path is canonicalised before it is validated, claimed or applied.
  for (const raw of Object.keys(set)) {
    const path = canonicalFieldPath(raw);
    validatePath(path, allowed);
    claimPath(claimed, path);
    setPath(target, path, structuredClone(set[raw]));
  }
  for (const raw of unset) {
    const path = canonicalFieldPath(raw);
    validatePath(path, allowed);
    claimPath(claimed, path);
    unsetPath(target, path);
  }
}

function claimPath(claimed: Set<string>, path: string): void {
  const conflict = [...claimed].find((other) => other === path
    || other.startsWith(`${path}.`)
    || path.startsWith(`${other}.`));
  if (conflict) throw new Error(`properties ${conflict} and ${path} overlap; set only the most specific path`);
  claimed.add(path);
}

function validatePath(path: string, allowed: (path: string) => boolean): void {
  const parts = path.split('.');
  if (parts.some((part) => !part || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new Error(`invalid property path ${path}`);
  }
  if (!allowed(path)) throw new Error(`property ${path} is not editable for this target`);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const valueAtPart = cursor[part];
    if (valueAtPart === null || typeof valueAtPart !== 'object' || Array.isArray(valueAtPart)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function unsetPath(target: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const value = cursor[part];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    cursor = value as Record<string, unknown>;
  }
  delete cursor[parts.at(-1)!];
}

function allowedDeckPath(path: string): boolean {
  return ['title', 'themePreset', 'morphEasing', 'canvas.w', 'canvas.h'].includes(path)
    || path.startsWith('themeStyle.');
}

function allowedSlidePath(path: string): boolean {
  return ['name', 'background.color', 'background.image', 'notes', 'layout', 'morphFromPrevious', 'morphDuration', 'skipped', 'timeline'].includes(path);
}

function allowedElementPath(type: SlideElement['type'], path: string): boolean {
  const common = new Set(['x', 'y', 'w', 'h', 'rot', 'z', 'opacity', 'class', 'morphId']);
  if (common.has(path) || path.startsWith('style.')) return true;
  if (type === 'text' && path.startsWith('contentStyle.')) return true;
  const typePaths = new Set(ELEMENT_PROPERTIES[type].map((property) => property.path.replace(/\.<[^>]+>$/, '')));
  if (typePaths.has(path)) return true;
  return ['sourceBox', 'pathSize', 'control'].some((prefix) => typePaths.has(prefix) && path.startsWith(`${prefix}.`));
}

function validateUiBounds(element: SlideElement, set: Record<string, unknown>): void {
  if (element.w < 8 || element.h < 8) throw new Error('element width and height must be at least 8 pixels');
  const fontSize = set['style.font-size'];
  if (fontSize !== undefined) {
    const match = /^([0-9]+(?:\.[0-9]+)?)px$/.exec(String(fontSize).trim());
    if (!match || Number(match[1]) < 6 || Number(match[1]) > 400) {
      throw new Error('style.font-size must be a CSS pixel value from 6px through 400px');
    }
  }
}
