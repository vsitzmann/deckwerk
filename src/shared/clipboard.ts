import { z } from 'zod';
import {
  ElementSchema,
  SlideSchema,
  ThemeStyleSchema,
  TimelineEntrySchema,
  type Slide,
  type SlideElement,
  type ThemeStyle,
  type TimelineEntry,
} from './deck.js';
import { renameRetiredFields } from './fieldAliases.js';
import { makeId } from './geometry.js';
import type { ImportedAsset } from './ipc.js';

/**
 * Cross-instance clipboard payloads.
 *
 * Each app instance is a separate process with its own main process, so the
 * only channel between them is the OS clipboard. Copy serialises the selection
 * (elements + the timeline entries that drive them, or whole slides) into a
 * versioned JSON envelope stored under a private clipboard format; paste
 * validates it with the same Zod schemas the deck file uses, re-imports any
 * referenced assets into the destination deck, and mints fresh ids.
 *
 * Assets travel as absolute paths rather than embedded bytes: both instances
 * run on the same machine, and a 200 MB video has no business being base64'd
 * through the pasteboard. Import-by-content-hash makes re-import idempotent.
 */

/** Private pasteboard format name. Other apps never see or parse this. */
export const CLIPBOARD_FORMAT = 'com.slide-editor.deck-fragment';

const AssetRefSchema = z.object({
  /** Deck-relative path as referenced by the copied content. */
  src: z.string(),
  /** Absolute path in the source deck, for re-import at paste time. */
  absPath: z.string(),
});

const envelopeBase = {
  format: z.literal(CLIPBOARD_FORMAT),
  version: z.literal(1),
  assets: z.array(AssetRefSchema).default([]),
};

export const ClipboardPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    ...envelopeBase,
    kind: z.literal('elements'),
    elements: z.array(ElementSchema).min(1),
    /** Timeline entries whose action targets a copied element. */
    timeline: z.array(TimelineEntrySchema).default([]),
    /**
     * The slide the elements were copied from, so paste can tell "somewhere
     * else" (land at the original coordinates) from "right back here" (offset,
     * or the copy hides under its original). Absent in payloads written by
     * older builds, which then paste as a cross-slide paste.
     */
    sourceSlideId: z.string().nullable().default(null),
  }),
  z.object({
    ...envelopeBase,
    kind: z.literal('slides'),
    slides: z.array(SlideSchema).min(1),
    /** Identifies a paste back into the same presentation without exposing it to other apps. */
    sourceDeckId: z.string().nullable().default(null),
    /** The values semantic role classes resolved to when the slides were copied. */
    sourceThemeStyle: ThemeStyleSchema.nullable().default(null),
  }),
]);

export type ClipboardPayload = z.infer<typeof ClipboardPayloadSchema>;
/** Standard clipboard data supplied by another app. Spreadsheet copies
 *  normally include HTML, with tab-separated text as a portable fallback. */
export type ExternalHtmlClipboard = { kind: 'external-html'; html: string; text?: string };
/** A bitmap supplied by another app (notably a macOS screenshot). The main
 *  process imports it into the open deck before handing it to the renderer. */
export type ExternalImageClipboard = { kind: 'external-image'; asset: ImportedAsset };
export type ClipboardReadResult = ClipboardPayload | ExternalHtmlClipboard | ExternalImageClipboard;
export type AssetRef = z.infer<typeof AssetRefSchema>;

/** What the renderer hands to the main process; assets are attached there. */
export type ClipboardWriteRequest =
  | {
    kind: 'elements';
    elements: SlideElement[];
    timeline: TimelineEntry[];
    sourceSlideId: string | null;
  }
  | {
    kind: 'slides';
    slides: Slide[];
    sourceDeckId?: string | null;
    sourceThemeStyle?: ThemeStyle | null;
  };

/** Parse untrusted clipboard bytes. Null rather than a throw: foreign or stale
 *  content on the pasteboard is normal, not an error. */
export function parseClipboardPayload(raw: unknown): ClipboardPayload | null {
  // Pasting from an older build still spells retired field names; the
  // schema would strip them rather than reject the payload.
  const result = ClipboardPayloadSchema.safeParse(renameRetiredFields(raw));
  return result.success ? result.data : null;
}

/** Every deck-relative asset path the payload references, deduplicated. */
export function collectAssetSrcs(request: ClipboardWriteRequest): string[] {
  const srcs = new Set<string>();
  const fromElements = (elements: SlideElement[]) => {
    for (const el of elements) {
      if (el.type === 'image') srcs.add(el.src);
      // A web element's page is an asset like a video's file: without it the
      // pasted box shows nothing.
      if (el.type === 'video' || el.type === 'web') {
        srcs.add(el.src);
        if (el.poster) srcs.add(el.poster);
      }
    }
  };
  if (request.kind === 'elements') fromElements(request.elements);
  else {
    for (const slide of request.slides) {
      if (slide.background.image) srcs.add(slide.background.image);
      fromElements(slide.elements);
    }
  }
  return [...srcs];
}

export interface RewriteAssetOptions {
  /**
   * Remove what an unmapped src belongs to instead of leaving it pointing at
   * a file the destination deck does not have: the element, when the src is
   * what it shows; just the reference, for a poster or a slide background.
   * The browser's paste into another deck uses this, because there a stale
   * `assets/x.png` is not merely broken — the destination may hold a
   * different file under that very name.
   */
  dropUnmapped?: boolean;
}

/**
 * Point the payload at the destination deck's copies of each asset.
 * Unmapped srcs are left alone by default: a dangling reference renders as a
 * broken image, which is visible and fixable, unlike a silently dropped
 * element. Returns how many references `dropUnmapped` removed (otherwise 0),
 * so the caller can say so.
 */
export function rewriteAssetSrcs(
  payload: ClipboardWriteRequest,
  map: Map<string, string>,
  options: RewriteAssetOptions = {},
): number {
  let dropped = 0;
  const optional = (src: string | null): string | null => {
    if (!src) return src;
    const mapped = map.get(src);
    if (mapped !== undefined) return mapped;
    if (!options.dropUnmapped) return src;
    dropped++;
    return null;
  };
  const rewriteElements = (elements: SlideElement[], timeline: TimelineEntry[]) => {
    const removed = new Set<string>();
    for (const el of elements) {
      if (el.type !== 'image' && el.type !== 'video' && el.type !== 'web') continue;
      const src = map.get(el.src);
      if (src === undefined && options.dropUnmapped) {
        removed.add(el.id);
        dropped++;
        continue;
      }
      el.src = src ?? el.src;
      if (el.type !== 'image') el.poster = optional(el.poster);
    }
    if (removed.size === 0) return { elements, timeline };
    return {
      elements: elements.filter((el) => !removed.has(el.id)),
      // A build that animates a dropped element has nothing left to animate.
      timeline: timeline.filter((entry) => !removed.has(entry.action.target)),
    };
  };
  if (payload.kind === 'elements') {
    Object.assign(payload, rewriteElements(payload.elements, payload.timeline));
  } else {
    for (const slide of payload.slides) {
      slide.background.image = optional(slide.background.image);
      Object.assign(slide, rewriteElements(slide.elements, slide.timeline));
    }
  }
  return dropped;
}

/**
 * Fresh ids for pasted elements and their timeline entries, so a paste can
 * never cross-wire with the originals (which may live in the same deck).
 * Mutates its arguments; callers pass clones.
 */
export function remapElementIds(
  elements: SlideElement[],
  timeline: TimelineEntry[],
): void {
  const remap = new Map<string, string>();
  for (const el of elements) {
    // Ancestry survives the copy so Morph auto-pair can still recognise
    // the element; the explicit pairing itself does not.
    el.lineageId = el.lineageId ?? el.id;
    const id = makeId(el.type);
    remap.set(el.id, id);
    el.id = id;
    el.morphId = null;
  }
  for (const entry of timeline) {
    entry.id = makeId('t');
    entry.action.target = remap.get(entry.action.target) ?? entry.action.target;
    if (entry.trigger.ref) {
      // A ref pointing outside the copied set would dangle in the destination.
      entry.trigger.ref = remap.get(entry.trigger.ref) ?? null;
    }
  }
}

/** Fresh ids for a pasted slide and everything in it. Mutates its argument. */
export function remapSlideIds(slide: Slide): void {
  slide.id = makeId('slide');
  slide.morphFromPrevious = false;
  remapElementIds(slide.elements, slide.timeline);
}

type ThemeTextRole = keyof ThemeStyle['fonts'];

function textRole(element: SlideElement): ThemeTextRole {
  const role = element.class.find((name) => /^role-(title|heading|body|caption|base)$/.test(name));
  return (role?.slice(5) as ThemeTextRole | undefined) ?? 'base';
}

/** Typography a semantic role takes from the deck theme. */
const THEME_TYPE_PROPERTIES = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing'];

/**
 * Hand pasted slides' role text over to the destination theme. Text imported
 * from Keynote or PowerPoint pins its face and size inline and carries the
 * importer's `.kn-text` class, which a deck's theme.css may restyle above the
 * role rules; either one would keep the source look after "Match destination".
 * So role text loses both. Colours stay unless they are just the source
 * theme's own, since white type over a picture is authored, not themed. A box
 * whose size now comes from the theme shrinks to fit rather than overflow.
 */
export function matchSlidesToTheme(slides: Slide[], source: ThemeStyle): void {
  for (const slide of slides) {
    for (const element of slide.elements) {
      if (element.type !== 'text') continue;
      if (!element.class.some((name) => /^role-(title|heading|body|caption)$/.test(name))) continue;
      const font = source.fonts[textRole(element)];
      const themeColors = [font.color, source.colors.text, source.colors.muted]
        .filter((color): color is string => typeof color === 'string')
        .map((color) => color.toLowerCase());
      const style = { ...element.style };
      const hadSize = style['font-size'] !== undefined;
      for (const property of THEME_TYPE_PROPERTIES) delete style[property];
      if (style.color && themeColors.includes(style.color.toLowerCase())) delete style.color;
      element.style = style;
      element.class = element.class.filter((name) => name !== 'kn-text');
      if (hadSize && !element.autoSize) element.autoFit = true;
    }
  }
}

/** Whether adopting the destination theme can visibly change pasted slides. */
export function slideThemeStylesDiffer(source: ThemeStyle, destination: ThemeStyle): boolean {
  return JSON.stringify(source.fonts) !== JSON.stringify(destination.fonts)
    || source.colors.background !== destination.colors.background
    || source.colors.text !== destination.colors.text
    || source.colors.muted !== destination.colors.muted;
}

/**
 * Freeze theme-derived slide typography before it enters a differently themed
 * deck. Existing inline declarations win: they are authored formatting, not
 * values inferred from the source theme.
 */
export function pinSlidesToTheme(slides: Slide[], theme: ThemeStyle): void {
  for (const slide of slides) {
    if (
      slide.background.color === null
      && slide.background.image === null
      && !slide.layoutBackgroundInherited
    ) {
      slide.background = { color: theme.colors.background, image: null };
      slide.layoutBackgroundInherited = false;
    }
    for (const element of slide.elements) {
      if (element.type !== 'text') continue;
      const role = textRole(element);
      const font = theme.fonts[role];
      const color = font.color ?? (role === 'caption' ? theme.colors.muted : theme.colors.text);
      const declarations: Record<string, string> = {
        'font-family': font.family,
        'font-size': `${font.size}px`,
        'font-weight': String(font.weight),
        'line-height': String(font.lineHeight),
        'letter-spacing': font.letterSpacing,
        color,
      };
      const style = { ...element.style };
      for (const [property, value] of Object.entries(declarations)) {
        if (style[property] !== undefined || element.contentStyle?.[property] !== undefined) continue;
        style[property] = value;
      }
      element.style = style;
    }
  }
}
