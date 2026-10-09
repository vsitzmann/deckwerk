import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { capabilities } from '../src/shared/capabilities.js';
import {
  DeckSchema,
  ElementSchema,
  SlideSchema,
  type Deck,
  type Slide,
  type SlideElement,
  emptyDeck,
  parseDeck,
} from '../src/shared/deck.js';
import { deckOutline, deckStyleDigest, htmlToText } from '../src/shared/deckDigest.js';
import { validateDeckIntegrity } from '../src/shared/agent.js';
import { capabilitiesReport, referenceDeckPath } from '../src/cli/agentCli.js';

/**
 * What an agent is told before it starts.
 *
 * The failure this guards against is not a crash: it is an agent that reads
 * the whole deck, still does not know KaTeX exists, and lays an equation out
 * by hand. So these tests assert that the briefing is small, that it is
 * derived from the deck rather than assumed, and that every example in the
 * cookbook is a valid element the agent can paste.
 */

const text = (
  id: string,
  html: string,
  box: { x: number; y: number; w: number; h: number },
  className: string,
): SlideElement => ({
  id, type: 'text', ...box, rot: 0, z: 1, opacity: 1,
  class: [className], style: {}, html, align: 'left', valign: 'top',
});

function talk(): Deck {
  const slide = (id: string, title: string, y: number, extra: SlideElement[] = []): Slide => ({
    id, name: '', background: { color: null, image: null }, notes: '',
    elements: [text(`${id}-title`, title, { x: 160, y, w: 1600, h: 200 }, 'role-title'), ...extra],
    timeline: [],
  });
  const deck = emptyDeck('The Bitter Lesson');
  deck.slides = [
    slide('slide-1', 'The Bitter Lesson', 120),
    slide('slide-2', 'Compute wins', 120, [
      text('slide-2-body', 'Search and learning scale.', { x: 160, y: 400, w: 1600, h: 300 }, 'role-body'),
    ]),
    slide('slide-3', 'Results', 120, [{
      id: 'slide-3-figure', type: 'image', x: 300, y: 400, w: 1200, h: 500, rot: 0, z: 2,
      opacity: 1, class: [], style: {}, src: 'assets/plot.png', fit: 'contain', alt: '',
      sourceBox: null,
    }]),
  ];
  return parseDeck(deck);
}

describe('the deck outline', () => {
  it('names every slide in order with what is on it', () => {
    const outline = deckOutline(talk());

    expect(outline.map((entry) => entry.id)).toEqual(['slide-1', 'slide-2', 'slide-3']);
    expect(outline.map((entry) => entry.title))
      .toEqual(['The Bitter Lesson', 'Compute wins', 'Results']);
    expect(outline[2].elements).toEqual({ text: 1, image: 1 });
    expect(outline[0].index).toBe(0);
  });

  it('falls back to the topmost text when a slide has no title role', () => {
    const deck = talk();
    deck.slides[0].elements = [
      text('low', 'Lower text', { x: 0, y: 800, w: 800, h: 100 }, 'role-body'),
      text('high', 'Upper text', { x: 0, y: 100, w: 800, h: 100 }, 'role-body'),
    ];
    expect(deckOutline(parseDeck(deck))[0].title).toBe('Upper text');
  });

  it('reads through inline markup and entities', () => {
    expect(htmlToText('A <b>bold</b> claim&nbsp;&amp; a caveat<br>on two lines'))
      .toBe('A bold claim & a caveat on two lines');
  });
});

describe('the house style digest', () => {
  it('reports the roles this deck actually uses, with their real geometry', () => {
    const style = deckStyleDigest(talk());

    expect(style.roles.map((role) => role.class)).toEqual(['role-title', 'role-body']);
    expect(style.roles[0]).toMatchObject({ count: 3, box: { x: 160, y: 120, w: 1600, h: 200 } });
    expect(style.canvas).toEqual({ w: 1920, h: 1080 });
  });

  it('offers a template in those conventions, ready to fill in', () => {
    const style = deckStyleDigest(talk());
    const [title, body] = style.slideTemplate.elements;

    expect(title).toMatchObject({ class: ['role-title'], x: 160, y: 120, w: 1600, h: 200 });
    expect(body).toMatchObject({ class: ['role-body'], x: 160, y: 400 });
    // The placeholders are loud on purpose: a copied id would collide.
    expect(style.slideTemplate.id).toMatch(/REPLACE/);
    expect(title.id).toMatch(/REPLACE/);
  });

  it('keeps the template on the canvas even when the deck is laid out oddly', () => {
    const deck = talk();
    // An import whose titles sit half off the top of the canvas.
    for (const slide of deck.slides) slide.elements[0].y = -400;
    const style = deckStyleDigest(parseDeck(deck));

    // The reported usage stays honest…
    expect(style.roles[0].box.y).toBe(-400);
    // …while the template a new slide is built from is usable.
    const title = style.slideTemplate.elements[0];
    expect(title.y).toBeGreaterThanOrEqual(0);
    expect(title.y + title.h).toBeLessThanOrEqual(style.canvas.h);
  });

  it('describes a deck with no role classes at all without inventing any', () => {
    const deck = emptyDeck('Bare');
    deck.slides[0].elements = [text('bare', 'Just text', { x: 0, y: 0, w: 400, h: 100 }, '')];
    const style = deckStyleDigest(parseDeck(deck));

    expect(style.roles.every((role) => role.class !== 'role-title')).toBe(true);
    // The fallback template is derived from the canvas, not from nothing.
    expect(style.slideTemplate.elements[0]).toMatchObject({ class: ['role-title'], x: 159 });
  });
});

describe('the capability cookbook', () => {
  it('covers the features an agent would otherwise reimplement badly', () => {
    const ids = capabilities().map((capability) => capability.id);
    expect(ids).toEqual(expect.arrayContaining([
      'latex', 'crop', 'video', 'builds', 'morph', 'auto-fit', 'shapes', 'media-frame',
    ]));
  });

  it('teaches the maths convention explicitly, because it cannot be guessed', () => {
    const latex = capabilities().find((capability) => capability.id === 'latex')!;
    const html = latex.elements
      .filter((element): element is Extract<SlideElement, { type: 'text' }> => element.type === 'text')
      .map((element) => element.html)
      .join(' ');

    expect(html).toContain('$');
    expect(latex.notes?.join(' ')).toMatch(/\$\$…\$\$ is display/);
    expect(latex.when).toMatch(/[Nn]ever hand-build/);
  });

  it('is made of examples that are valid decks, not illustrative pseudo-JSON', () => {
    // Every capability, assembled into one deck and validated exactly as an
    // agent's own transaction would be.
    const deck = parseDeck({
      version: 1,
      slides: capabilities().map((capability) => ({
        id: capability.id,
        elements: capability.elements,
        timeline: capability.timeline ?? [],
        ...capability.slide,
      })),
    });
    expect(validateDeckIntegrity(deck)).toEqual([]);
  });

  it('can be asked about one feature instead of all of them', () => {
    const report = capabilitiesReport(['latex', 'crop']) as { capabilities: Array<{ id: string }> };
    expect(report.capabilities.map((capability) => capability.id)).toEqual(['latex', 'crop']);
  });

  it('points at a rendered screenshot and real markup for each feature', async () => {
    const report = capabilitiesReport() as {
      referenceDeck: string | null;
      capabilities: Array<{ id: string; screenshot: string | null; html: string | null }>;
    };
    // The reference deck is generated by `npm run build:reference`; skip
    // rather than fail in a checkout where it has not been built.
    if (!report.referenceDeck) return;

    for (const capability of report.capabilities) {
      expect(capability.screenshot, `${capability.id} screenshot`).not.toBeNull();
      expect(capability.html, `${capability.id} html`).not.toBeNull();
    }
    const latex = report.capabilities.find((capability) => capability.id === 'latex')!;
    expect(await readFile(latex.html!, 'utf8')).toContain('katex');
  });

  it('generates the reference deck from the cookbook, so they cannot drift', async () => {
    const deckPath = join(referenceDeckPath(), 'deck.json');
    if (!existsSync(deckPath)) return;
    const deck = parseDeck(JSON.parse(await readFile(deckPath, 'utf8')));

    expect(deck.slides.map((slide) => slide.id))
      .toEqual(capabilities().map((capability) => capability.id));
  });
});

/**
 * Does the cookbook still cover everything this editor can do?
 *
 * The cookbook is the only place an agent learns a feature exists, so a
 * feature shipped without an entry here is a feature agents reimplement by
 * hand — literal "•" bullets instead of a <ul>, a re-encoded video instead of
 * a sourceBox crop. Remembering to update it is not a plan, so these tests
 * derive the checklist from the schema itself: add a field, a type or an enum
 * variant to deck.ts and the coverage test fails until the cookbook teaches it
 * or it is exempted here with a reason.
 */
describe('cookbook coverage, derived from the schema', () => {
  /** Element types no agent should ever author. */
  const EXEMPT_TYPES: Record<string, string> = {
    unsupported: 'Keynote-importer placeholder for an object it could not map; never hand-authored.',
  };

  /** Fields the editor sets for itself, which an agent has no business writing. */
  const EXEMPT_FIELDS: Record<string, string> = {
    lineageId: 'Internal: stamped on duplication so Morph auto-pair can recognise a copy.',
    originalType: 'Importer-only, on unsupported placeholders.',
    note: 'Importer-only, on unsupported placeholders.',
  };

  const EXEMPT_ENUM_VALUES: Record<string, string> = {
    'type:unsupported': 'See EXEMPT_TYPES.',
  };

  const caps = capabilities();
  /** What the examples actually demonstrate: elements, timelines, slide props. */
  const exercised = JSON.stringify(caps.map((capability) => ({
    elements: capability.elements,
    timeline: capability.timeline ?? [],
    slide: capability.slide ?? {},
  })));
  /** What the prose explains. Teaching a feature in `notes` counts as covering it. */
  const prose = caps
    .map((capability) => [capability.what, capability.when, ...(capability.notes ?? [])].join(' '))
    .join(' ');

  const elementOptions = ElementSchema.options as unknown as Array<z.ZodObject<z.ZodRawShape>>;
  const typeOf = (option: z.ZodObject<z.ZodRawShape>): string =>
    (option.shape.type as z.ZodLiteral<string>).value;

  const mentionedInProse = (word: string): boolean =>
    new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(prose);

  it('has an example of every element type an agent can author', () => {
    const missing = elementOptions
      .map(typeOf)
      .filter((type) => !(type in EXEMPT_TYPES))
      .filter((type) => !exercised.includes(`"type":"${type}"`));

    expect(missing, 'element types with no cookbook example').toEqual([]);
  });

  it('exercises or explains every field an agent can set', () => {
    // Field names are collapsed across element types: the cookbook teaches
    // `sourceBox` once, not once per media type. Schema symmetry between
    // images and video is a separate test below.
    const fields = new Set<string>();
    for (const option of elementOptions) {
      if (typeOf(option) in EXEMPT_TYPES) continue;
      for (const key of Object.keys(option.shape)) fields.add(key);
    }

    const uncovered = [...fields]
      .filter((field) => !(field in EXEMPT_FIELDS))
      .filter((field) => !exercised.includes(`"${field}":`) && !mentionedInProse(field));

    expect(uncovered, 'element fields the cookbook neither uses nor mentions').toEqual([]);
  });

  it('exercises or explains every value in the deck vocabulary', () => {
    // Every enum and discriminator reachable from a slide (elements, their
    // per-type fields, timeline triggers and actions, media effects, layout)
    // plus the deck-level motion settings.
    const vocabulary = new Map<string, Set<string>>();
    const collect = (schema: z.ZodTypeAny, field: string, depth = 0): void => {
      if (depth > 8) return;
      let current: z.ZodTypeAny = schema;
      for (let i = 0; i < 8; i++) {
        const def = current._def as { innerType?: z.ZodTypeAny; type?: z.ZodTypeAny };
        if (current instanceof z.ZodOptional || current instanceof z.ZodNullable
          || current instanceof z.ZodDefault) current = def.innerType!;
        else if (current instanceof z.ZodArray) current = def.type!;
        else break;
      }
      const add = (value: string) => {
        const values = vocabulary.get(field) ?? new Set<string>();
        values.add(value);
        vocabulary.set(field, values);
      };
      if (current instanceof z.ZodEnum) {
        for (const value of current.options as string[]) add(value);
      } else if (current instanceof z.ZodLiteral) {
        if (typeof current.value === 'string') add(current.value);
      } else if (current instanceof z.ZodObject) {
        for (const [key, value] of Object.entries(current.shape as z.ZodRawShape)) {
          collect(value as z.ZodTypeAny, key, depth + 1);
        }
      } else if (current instanceof z.ZodDiscriminatedUnion || current instanceof z.ZodUnion) {
        for (const option of (current._def as { options: z.ZodTypeAny[] }).options) {
          collect(option, field, depth + 1);
        }
      }
    };
    collect(SlideSchema, 'slide');
    collect(DeckSchema.shape.morphEasing, 'morphEasing');

    const uncovered: string[] = [];
    for (const [field, values] of vocabulary) {
      for (const value of values) {
        if (`${field}:${value}` in EXEMPT_ENUM_VALUES) continue;
        // Matched as a field/value pair, so a shape kind of "rect" cannot
        // stand in for a mask shape of "rect".
        if (exercised.includes(`"${field}":"${value}"`)) continue;
        if (mentionedInProse(value)) continue;
        uncovered.push(`${field}: ${value}`);
      }
    }

    expect(uncovered, 'vocabulary the cookbook neither uses nor mentions').toEqual([]);
  });
});

/**
 * Images and video are the same object with a different tag, and every time
 * they drift an agent gets hurt: `maskShape` shipped on images only, so
 * setting it on a video was silently dropped on parse and the agent was left
 * debugging a renderer that looked broken. Any new media field must land on
 * both, or be declared asymmetric here on purpose.
 */
describe('image and video keep the same media vocabulary', () => {
  const IMAGE_ONLY: Record<string, string> = {
    alt: 'Alternative text; a video carries no equivalent.',
  };
  const VIDEO_ONLY: Record<string, string> = {
    autoplay: 'Playback, meaningless on a still.',
    loop: 'Playback, meaningless on a still.',
    muted: 'Playback, meaningless on a still.',
    controls: 'Playback, meaningless on a still.',
    start: 'Trim point, meaningless on a still.',
    end: 'Trim point, meaningless on a still.',
    poster: 'Still shown before playback begins.',
    syncGroup: 'Shares a playback clock, meaningless on a still (a still can still be a wipe layer).',
  };

  const shapeOf = (type: string): Set<string> => {
    const option = (ElementSchema.options as unknown as Array<z.ZodObject<z.ZodRawShape>>)
      .find((candidate) => (candidate.shape.type as z.ZodLiteral<string>).value === type)!;
    return new Set(Object.keys(option.shape));
  };

  it('gives both types every shared media field', () => {
    const image = shapeOf('image');
    const video = shapeOf('video');

    const missingOnVideo = [...image].filter((field) => !video.has(field) && !(field in IMAGE_ONLY));
    const missingOnImage = [...video].filter((field) => !image.has(field) && !(field in VIDEO_ONLY));

    expect(missingOnVideo, 'fields on images but not video').toEqual([]);
    expect(missingOnImage, 'fields on video but not images').toEqual([]);
  });
});
