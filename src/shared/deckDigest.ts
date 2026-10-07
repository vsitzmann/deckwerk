import type { Deck, Slide, SlideElement } from './deck.js';

/**
 * The smallest description of a deck an agent needs before it can act.
 *
 * The task an agent is usually handed is "add a few slides about X around the
 * middle" — for which it needs three things and no more: an ordered outline to
 * find the middle, the conventions this particular deck follows so new slides
 * do not look foreign, and a skeleton to fill in. Reading every slide's
 * computed scene to work those out is slow, enormous, and mostly noise.
 *
 * Everything here is derived from the deck itself rather than from a
 * house style guide, so a deck imported from someone else's Keynote is
 * described as accurately as one built here.
 */

export interface SlideOutline {
  index: number;
  id: string;
  name: string;
  /** First line of the slide's most title-like text, for recognising it. */
  title: string;
  /** Element counts by type, so an agent can spot figure and video slides. */
  elements: Record<string, number>;
  builds: number;
  morphFromPrevious: boolean;
  morphDuration: number;
  /** Kept in the deck but stepped over when presenting. */
  skipped: boolean;
}

export interface RoleUsage {
  /** The class as it appears in `element.class`, e.g. "role-title". */
  class: string;
  count: number;
  /** Median authored geometry for elements carrying this class. */
  box: { x: number; y: number; w: number; h: number };
  align: string;
}

export interface DeckStyleDigest {
  canvas: { w: number; h: number };
  /** Text roles in use, most common first. Styling lives in theme.css. */
  roles: RoleUsage[];
  /** Deck-level typography and colour, when the deck has an installed theme. */
  fonts: Record<string, unknown> | null;
  colors: Record<string, string> | null;
  palette: string[];
  /** Backgrounds actually in use, so a new slide does not clash. */
  backgrounds: Array<{ color: string | null; count: number }>;
  /**
   * A slide in this deck's own conventions, ready to be filled in and sent as
   * an `insertSlides` operation. Ids are placeholders and must be replaced.
   */
  slideTemplate: Slide;
}

const TITLE_CLASSES = ['role-title', 'title'];
const BODY_CLASSES = ['role-body', 'body'];

export function deckOutline(deck: Deck): SlideOutline[] {
  return deck.slides.map((slide, index) => ({
    index,
    id: slide.id,
    name: slide.name,
    title: slideTitle(slide),
    elements: Object.fromEntries(countBy(slide.elements.map((element) => element.type))),
    builds: slide.timeline.length,
    morphFromPrevious: slide.morphFromPrevious ?? false,
    morphDuration: slide.morphDuration ?? 1000,
    skipped: slide.skipped ?? false,
  }));
}

export function deckStyleDigest(deck: Deck): DeckStyleDigest {
  const texts = deck.slides.flatMap((slide) =>
    slide.elements.filter((element): element is Extract<SlideElement, { type: 'text' }> =>
      element.type === 'text'));

  const byClass = new Map<string, Array<Extract<SlideElement, { type: 'text' }>>>();
  for (const element of texts) {
    for (const name of element.class) {
      const bucket = byClass.get(name) ?? [];
      bucket.push(element);
      byClass.set(name, bucket);
    }
  }

  const roles: RoleUsage[] = [...byClass.entries()]
    .map(([name, elements]) => ({
      class: name,
      count: elements.length,
      box: medianBox(elements),
      align: mostCommon(elements.map((element) => element.align)) ?? 'left',
    }))
    .sort((a, b) => b.count - a.count);

  const backgrounds = [...countBy(deck.slides.map((slide) => slide.background.color ?? ''))]
    .map(([color, count]) => ({ color: color === '' ? null : color, count }))
    .sort((a, b) => b.count - a.count);

  return {
    canvas: deck.canvas,
    roles,
    fonts: (deck.themeStyle?.fonts as Record<string, unknown> | undefined) ?? null,
    colors: deck.themeStyle?.colors ?? null,
    palette: deck.themeStyle?.palette ?? [],
    backgrounds,
    slideTemplate: slideTemplate(deck, roles),
  };
}

/**
 * A blank slide laid out the way this deck lays out slides.
 *
 * Where a deck has an established title and body position, they are reused
 * verbatim; where it has none — a deck of nothing but figures, say — the
 * fallback is a plain, generous margin derived from the canvas rather than a
 * hardcoded 1920×1080 guess.
 */
function slideTemplate(deck: Deck, roles: RoleUsage[]): Slide {
  const margin = Math.round(deck.canvas.w * 0.083);
  const titleRole = pickRole(roles, TITLE_CLASSES);
  const bodyRole = pickRole(roles, BODY_CLASSES);
  const titleBox = onCanvas(titleRole?.box, deck) ?? {
    x: margin, y: Math.round(deck.canvas.h * 0.11),
    w: deck.canvas.w - margin * 2, h: Math.round(deck.canvas.h * 0.17),
  };
  const bodyBox = onCanvas(bodyRole?.box, deck) ?? {
    x: margin, y: Math.round(deck.canvas.h * 0.36),
    w: deck.canvas.w - margin * 2, h: Math.round(deck.canvas.h * 0.46),
  };

  return {
    id: 'REPLACE-WITH-A-UNIQUE-SLIDE-ID',
    name: '',
    background: { color: null, image: null },
    notes: '',
    elements: [
      {
        id: 'REPLACE-WITH-A-UNIQUE-ELEMENT-ID',
        type: 'text',
        ...titleBox,
        rot: 0, z: 1, opacity: 1,
        class: [titleRole?.class ?? 'role-title'],
        style: {},
        html: 'Slide title',
        align: (titleRole?.align ?? 'left') as 'left',
        valign: 'top',
      },
      {
        id: 'REPLACE-WITH-ANOTHER-UNIQUE-ELEMENT-ID',
        type: 'text',
        ...bodyBox,
        rot: 0, z: 2, opacity: 1,
        class: [bodyRole?.class ?? 'role-body'],
        style: {},
        html: 'Body text',
        align: (bodyRole?.align ?? 'left') as 'left',
        valign: 'top',
      },
    ],
    timeline: [],
  };
}

/**
 * Only hand back a measured box the template can actually use.
 *
 * `roles` reports what a deck really does, warts and all — a median taken over
 * a deck whose titles sit half off the canvas is still the truth about that
 * deck. A *template* built from it would just be a bad slide, so a degenerate
 * box falls through to the canvas-derived default instead.
 */
function onCanvas(
  box: { x: number; y: number; w: number; h: number } | undefined,
  deck: Deck,
): { x: number; y: number; w: number; h: number } | undefined {
  if (!box) return undefined;
  const fits = box.w > 0 && box.h > 0
    && box.x >= 0 && box.y >= 0
    && box.x + box.w <= deck.canvas.w
    && box.y + box.h <= deck.canvas.h;
  return fits ? box : undefined;
}

function pickRole(roles: RoleUsage[], candidates: string[]): RoleUsage | undefined {
  // Ordered by the deck's own usage, so the commonest spelling wins.
  return roles.find((role) => candidates.includes(role.class));
}

/** The slide's headline: an explicit title role if there is one, else the top text. */
export function slideTitle(slide: Slide): string {
  const texts = slide.elements.filter((element): element is Extract<SlideElement, { type: 'text' }> =>
    element.type === 'text');
  const titled = texts.find((element) => element.class.some((name) => TITLE_CLASSES.includes(name)));
  const chosen = titled ?? [...texts].sort((a, b) => a.y - b.y)[0];
  if (!chosen) return '';
  const plain = htmlToText(chosen.html);
  return plain.length > 90 ? `${plain.slice(0, 89)}…` : plain;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function medianBox(elements: Array<{ x: number; y: number; w: number; h: number }>) {
  return {
    x: median(elements.map((element) => element.x)),
    y: median(elements.map((element) => element.y)),
    w: median(elements.map((element) => element.w)),
    h: median(elements.map((element) => element.h)),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return Math.round(value);
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function mostCommon(values: string[]): string | undefined {
  return [...countBy(values).entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
