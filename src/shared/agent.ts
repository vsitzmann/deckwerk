import { z } from 'zod';
import {
  DeckSchema,
  ElementSchema,
  SlideSchema,
  parseDeck,
  type Deck,
  type Slide,
  type SlideElement,
} from './deck.js';
import { renameRetiredFields } from './fieldAliases.js';
import { braceDepthOf } from './brace.js';

export const AGENT_PROTOCOL_VERSION = 1 as const;

const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });

export const ComputedElementSceneSchema = z.object({
  id: z.string(),
  type: z.string(),
  selected: z.boolean(),
  authored: RectSchema.extend({ rot: z.number(), z: z.number(), opacity: z.number() }),
  rendered: RectSchema.nullable(),
  computedStyle: z.record(z.string()),
  text: z.object({
    html: z.string(),
    plain: z.string(),
    fittedFontSize: z.number().nullable(),
    // Booleans when a browser measured the slide; null when the scene was
    // derived from deck.json alone and no measurement was taken.
    overflowX: z.boolean().nullable(),
    overflowY: z.boolean().nullable(),
  }).nullable(),
  media: z.object({
    src: z.string(),
    fit: z.string(),
    sourceBox: z.unknown().nullable(),
    effects: z.array(z.unknown()),
    borderColor: z.string().nullable(),
    borderWidth: z.number(),
    borderRadius: z.number(),
    duration: z.number().nullable(),
  }).nullable(),
  shape: z.object({
    kind: z.string(),
    stroke: z.string().nullable(),
    fill: z.string().nullable(),
    strokeWidth: z.number(),
    arrowStart: z.boolean(),
    arrowEnd: z.boolean(),
    control: z.object({ x: z.number(), y: z.number() }).nullable(),
    braceDepth: z.number().nullable(),
    path: z.string().nullable(),
  }).nullable(),
  morphId: z.string().nullable(),
  lineageId: z.string().nullable(),
});

export const ComputedSlideSceneSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  name: z.string(),
  active: z.boolean(),
  selected: z.boolean(),
  canvas: z.object({ w: z.number().positive(), h: z.number().positive() }),
  background: z.unknown(),
  layout: z.string(),
  morphFromPrevious: z.boolean(),
  morphDuration: z.number().min(100).max(5000),
  skipped: z.boolean(),
  timeline: z.array(z.unknown()),
  elements: z.array(ComputedElementSceneSchema),
});

export const AgentContextSchema = z.object({
  version: z.literal(AGENT_PROTOCOL_VERSION),
  live: z.boolean(),
  sessionId: z.string(),
  pid: z.number().int().positive(),
  updatedAt: z.string(),
  deckPath: z.string(),
  deckRevision: z.string(),
  activeSlideId: z.string().nullable(),
  activeSlideIndex: z.number().int().nonnegative(),
  selectedSlideIds: z.array(z.string()),
  selectedElementIds: z.array(z.string()),
  scenes: z.array(ComputedSlideSceneSchema),
});

export type AgentContext = z.infer<typeof AgentContextSchema>;
export type ComputedSlideScene = z.infer<typeof ComputedSlideSceneSchema>;
export type ComputedElementScene = z.infer<typeof ComputedElementSceneSchema>;
export type AgentContextDraft = Omit<AgentContext, 'live' | 'sessionId' | 'pid' | 'updatedAt' | 'deckPath'>;

const InsertSlidesOperation = z.object({
  op: z.literal('insertSlides'),
  afterSlideId: z.string().nullable(),
  slides: z.array(SlideSchema).min(1),
});
const ReplaceSlideOperation = z.object({
  op: z.literal('replaceSlide'),
  slideId: z.string(),
  slide: SlideSchema,
});
const DeleteSlideOperation = z.object({ op: z.literal('deleteSlide'), slideId: z.string() });
const MoveSlideOperation = z.object({
  op: z.literal('moveSlide'),
  slideId: z.string(),
  afterSlideId: z.string().nullable(),
});
const InsertElementsOperation = z.object({
  op: z.literal('insertElements'),
  slideId: z.string(),
  elements: z.array(ElementSchema).min(1),
});
const ReplaceElementOperation = z.object({
  op: z.literal('replaceElement'),
  slideId: z.string(),
  elementId: z.string(),
  element: ElementSchema,
  /**
   * Collaboration: the element's html as it was when this replacement was
   * made. If the html has moved on since (someone else typed into the same
   * box), the lenient collab apply merges the two edits three ways instead
   * of overwriting the other person's text (collabApply.ts, textMerge.ts).
   * The strict transaction apply ignores it.
   */
  baseHtml: z.string().optional(),
});
const DeleteElementsOperation = z.object({
  op: z.literal('deleteElements'),
  slideId: z.string(),
  elementIds: z.array(z.string()).min(1),
});
const UpdateDeckOperation = z.object({
  op: z.literal('updateDeck'),
  title: z.string().optional(),
  canvas: z.object({ w: z.number().positive(), h: z.number().positive() }).optional(),
  theme: z.string().optional(),
  themePreset: z.string().nullable().optional(),
  themeStyle: DeckSchema.shape.themeStyle.removeDefault().optional(),
  themeSelection: DeckSchema.shape.themeSelection.removeDefault().optional(),
  themeHistory: DeckSchema.shape.themeHistory.removeDefault().optional(),
  customThemes: DeckSchema.shape.customThemes.removeDefault().optional(),
  layoutMasters: DeckSchema.shape.layoutMasters.removeDefault().optional(),
  morphEasing: z.enum(['ease-in-out', 'ease-out', 'linear']).optional(),
});
/**
 * Replace every slide property except `elements`, so slide-level edits
 * (name, background, layout, timeline, …) can merge alongside concurrent
 * element edits on the same slide instead of stomping them via replaceSlide.
 */
/**
 * The non-element fields of a slide, each optional: an omitted field means
 * "leave as it is", not "reset".
 *
 * Sending the whole blob whenever any one field changed made every property
 * edit a full overwrite, so a peer editing the speaker notes silently deleted
 * a build animation another peer had just authored on the same slide (and the
 * other way round). A field-wise patch merges instead of stomping.
 *
 * A full blob is still a valid patch, so senders that predate this keep working.
 * `.partial()` alone is not enough: zod applies a field's `.default()` when the
 * key is absent, which would turn "unchanged" back into "reset", so the
 * defaulted fields are restated without their defaults.
 */
const SlidePropertiesPatch = SlideSchema.omit({ elements: true }).partial().extend({
  id: SlideSchema.shape.id,
  name: SlideSchema.shape.name.removeDefault().optional(),
  background: SlideSchema.shape.background.removeDefault().optional(),
  notes: SlideSchema.shape.notes.removeDefault().optional(),
  timeline: SlideSchema.shape.timeline.removeDefault().optional(),
});

export type SlidePropertiesPatchValue = z.infer<typeof SlidePropertiesPatch>;

const SetSlidePropertiesOperation = z.object({
  op: z.literal('setSlideProperties'),
  slideId: z.string(),
  slide: SlidePropertiesPatch,
  /**
   * Optional fields to remove. A patch says nothing about a key it omits, so
   * clearing one -- un-skipping a slide, dropping a layout preset or the last
   * comment -- has to be stated rather than implied by absence.
   */
  clear: z.array(z.string()).optional(),
});

export const AgentOperationSchema = z.discriminatedUnion('op', [
  InsertSlidesOperation,
  ReplaceSlideOperation,
  DeleteSlideOperation,
  MoveSlideOperation,
  InsertElementsOperation,
  ReplaceElementOperation,
  DeleteElementsOperation,
  UpdateDeckOperation,
  SetSlidePropertiesOperation,
]);

export const AgentTransactionSchema = z.object({
  version: z.literal(AGENT_PROTOCOL_VERSION),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  label: z.string().min(1).max(200),
  operations: z.array(AgentOperationSchema).min(1),
});

export type AgentOperation = z.infer<typeof AgentOperationSchema>;
export type AgentTransaction = z.infer<typeof AgentTransactionSchema>;

export const AgentRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(AGENT_PROTOCOL_VERSION),
    id: z.string(),
    kind: z.literal('transaction'),
    transaction: AgentTransactionSchema,
  }),
  z.object({
    version: z.literal(AGENT_PROTOCOL_VERSION),
    id: z.string(),
    kind: z.literal('dom'),
    expectedRevision: z.string(),
  }),
  /**
   * "Compile this authoring file and apply it" — the same thing a watched
   * save does, asked for explicitly. With the editor open the editor is the
   * one compiler: a CLI that compiled the file itself alongside the watcher
   * inserted every new section twice. The response payload carries the
   * `changes` summary and the slides, so the caller learns what happened.
   */
  z.object({
    version: z.literal(AGENT_PROTOCOL_VERSION),
    id: z.string(),
    kind: z.literal('htmlSync'),
    path: z.string(),
    contents: z.string(),
    after: z.string().nullable().optional(),
    label: z.string().optional(),
  }),
]);

export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const AgentResponseSchema = z.object({
  version: z.literal(AGENT_PROTOCOL_VERSION),
  id: z.string(),
  status: z.enum(['applied', 'ok', 'conflict', 'error']),
  revision: z.string(),
  message: z.string().optional(),
  payload: z.unknown().optional(),
});

export type AgentResponse = z.infer<typeof AgentResponseSchema>;

/** Stable input for SHA-256 in Node or the browser. */
export function canonicalDeckJson(deck: Deck): string {
  return JSON.stringify(parseDeck(deck));
}

export function applyAgentTransaction(deck: Deck, transaction: AgentTransaction): Deck {
  const tx = AgentTransactionSchema.parse(renameRetiredFields(transaction));
  return applyAgentOperations(deck, tx.operations);
}

/** Apply a validated operation batch with one clone/validation boundary. */
export function applyAgentOperations(deck: Deck, operations: AgentOperation[]): Deck {
  const next = structuredClone(parseDeck(deck));

  for (const operation of operations) {
    applyOperation(next, AgentOperationSchema.parse(renameRetiredFields(operation)));
  }
  const parsed = DeckSchema.parse(next);
  const errors = validateDeckIntegrity(parsed);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return parsed;
}

function applyOperation(deck: Deck, operation: AgentOperation): void {
  switch (operation.op) {
    case 'insertSlides': {
      const at = operation.afterSlideId === null
        ? 0
        : requireSlideIndex(deck, operation.afterSlideId) + 1;
      deck.slides.splice(at, 0, ...structuredClone(operation.slides));
      return;
    }
    case 'replaceSlide': {
      const at = requireSlideIndex(deck, operation.slideId);
      if (operation.slide.id !== operation.slideId) {
        throw new Error(`Replacement slide id must remain ${operation.slideId}`);
      }
      deck.slides[at] = structuredClone(operation.slide);
      return;
    }
    case 'deleteSlide': {
      if (deck.slides.length === 1) throw new Error('A deck must retain at least one slide');
      deck.slides.splice(requireSlideIndex(deck, operation.slideId), 1);
      return;
    }
    case 'moveSlide': {
      if (operation.afterSlideId === operation.slideId) throw new Error('A slide cannot follow itself');
      const from = requireSlideIndex(deck, operation.slideId);
      const [slide] = deck.slides.splice(from, 1);
      const at = operation.afterSlideId === null
        ? 0
        : requireSlideIndex(deck, operation.afterSlideId) + 1;
      deck.slides.splice(at, 0, slide);
      return;
    }
    case 'insertElements':
      requireSlide(deck, operation.slideId).elements.push(...structuredClone(operation.elements));
      return;
    case 'replaceElement': {
      const slide = requireSlide(deck, operation.slideId);
      const at = slide.elements.findIndex((element) => element.id === operation.elementId);
      if (at === -1) throw new Error(`Unknown element id: ${operation.elementId}`);
      if (operation.element.id !== operation.elementId) {
        throw new Error(`Replacement element id must remain ${operation.elementId}`);
      }
      slide.elements[at] = structuredClone(operation.element);
      return;
    }
    case 'deleteElements': {
      const slide = requireSlide(deck, operation.slideId);
      const ids = new Set(operation.elementIds);
      for (const id of ids) {
        if (!slide.elements.some((element) => element.id === id)) throw new Error(`Unknown element id: ${id}`);
      }
      slide.elements = slide.elements.filter((element) => !ids.has(element.id));
      slide.timeline = slide.timeline.filter((entry) =>
        !ids.has(entry.action.target) && !(entry.trigger.ref && ids.has(entry.trigger.ref)));
      return;
    }
    case 'updateDeck':
      if (operation.title !== undefined) deck.title = operation.title;
      if (operation.canvas !== undefined) deck.canvas = structuredClone(operation.canvas);
      if (operation.theme !== undefined) deck.theme = operation.theme;
      if (operation.themePreset !== undefined) deck.themePreset = operation.themePreset;
      if (operation.themeStyle !== undefined) deck.themeStyle = structuredClone(operation.themeStyle);
      if (operation.themeSelection !== undefined) {
        deck.themeSelection = structuredClone(operation.themeSelection);
      }
      if (operation.themeHistory !== undefined) deck.themeHistory = [...operation.themeHistory];
      if (operation.layoutMasters !== undefined) {
        // Slides are not synchronized here on purpose. `updateDeck` is a field
        // setter in an operation algebra that undo, redo and collaboration all
        // replay, and every slide change travels as its own operation in the
        // same batch (see deckDiff). Rewriting slides from this branch made
        // those batches order-sensitive: an undo whose masters landed before
        // its own deleteElements threw on an id this branch had already
        // removed. Callers that mean "install masters and follow them" call
        // syncDeckWithLayoutMasters alongside the operation, as the layout
        // editor does.
        deck.layoutMasters = structuredClone(operation.layoutMasters);
      }
      if (operation.customThemes !== undefined) {
        deck.customThemes = structuredClone(operation.customThemes);
      }
      if (operation.morphEasing !== undefined) deck.morphEasing = operation.morphEasing;
      return;
    case 'setSlideProperties': {
      const at = requireSlideIndex(deck, operation.slideId);
      if (operation.slide.id !== operation.slideId) {
        throw new Error(`Slide properties id must remain ${operation.slideId}`);
      }
      deck.slides[at] = {
        ...deck.slides[at],
        ...structuredClone(operation.slide),
        elements: deck.slides[at].elements,
      };
      for (const key of operation.clear ?? []) {
        if (key === 'id' || key === 'elements') continue;
        delete (deck.slides[at] as Record<string, unknown>)[key];
      }
      return;
    }
  }
}

function requireSlide(deck: Deck, id: string): Slide {
  const slide = deck.slides.find((candidate) => candidate.id === id);
  if (!slide) throw new Error(`Unknown slide id: ${id}`);
  return slide;
}

function requireSlideIndex(deck: Deck, id: string): number {
  const index = deck.slides.findIndex((slide) => slide.id === id);
  if (index === -1) throw new Error(`Unknown slide id: ${id}`);
  return index;
}

/** Semantic constraints that Zod cannot express locally. */
export function validateDeckIntegrity(deck: Deck, assetExists?: (src: string) => boolean): string[] {
  const errors: string[] = [];
  const slideIds = new Set<string>();
  const elementIds = new Set<string>();
  for (const slide of deck.slides) {
    if (slideIds.has(slide.id)) errors.push(`Duplicate slide id: ${slide.id}`);
    slideIds.add(slide.id);
    const local = new Set(slide.elements.map((element) => element.id));
    for (const element of slide.elements) {
      if (elementIds.has(element.id)) errors.push(`Duplicate element id: ${element.id}`);
      elementIds.add(element.id);
      if (assetExists && (element.type === 'image' || element.type === 'video' || element.type === 'web')) {
        if (!assetExists(element.src)) errors.push(`Missing asset for ${element.id}: ${element.src}`);
        if ((element.type === 'video' || element.type === 'web') && element.poster && !assetExists(element.poster)) {
          errors.push(`Missing poster for ${element.id}: ${element.poster}`);
        }
      }
    }
    if (assetExists && slide.background.image && !assetExists(slide.background.image)) {
      errors.push(`Missing background asset on ${slide.id}: ${slide.background.image}`);
    }
    for (const entry of slide.timeline) {
      if (!local.has(entry.action.target)) {
        errors.push(`Timeline ${entry.id} targets missing element ${entry.action.target}`);
      }
      if (entry.trigger.ref && !local.has(entry.trigger.ref)) {
        errors.push(`Timeline ${entry.id} references missing element ${entry.trigger.ref}`);
      }
    }
  }
  return errors;
}

/**
 * A scene derived from `deck.json` alone, for when no editor is running.
 *
 * Everything the authored deck states is here; everything only a rendering can
 * know — measured bounds, resolved styles, the size auto-fit settled on — is
 * explicitly null rather than guessed, so an agent can tell the difference.
 */
export function authoredScene(
  deck: Deck,
  slide: Slide,
  index: number,
  selectedSlideIds = new Set<string>(),
  selectedElementIds = new Set<string>(),
  activeSlideId: string | null = null,
): ComputedSlideScene {
  return {
    id: slide.id,
    index,
    name: slide.name,
    active: activeSlideId === null ? index === 0 : slide.id === activeSlideId,
    selected: selectedSlideIds.has(slide.id),
    canvas: deck.canvas,
    background: slide.background,
    layout: slide.layout ?? 'freeform',
    morphFromPrevious: slide.morphFromPrevious ?? false,
    morphDuration: slide.morphDuration ?? 1000,
    skipped: slide.skipped ?? false,
    timeline: slide.timeline,
    elements: slide.elements.map((element) => authoredElementScene(element, selectedElementIds)),
  };
}

function authoredElementScene(element: SlideElement, selected: Set<string>): ComputedElementScene {
  return {
    id: element.id,
    type: element.type,
    selected: selected.has(element.id),
    authored: {
      x: element.x, y: element.y, w: element.w, h: element.h,
      rot: element.rot, z: element.z, opacity: element.opacity,
    },
    rendered: null,
    computedStyle: {},
    text: element.type === 'text' ? {
      html: element.html,
      plain: element.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      fittedFontSize: null,
      overflowX: null,
      overflowY: null,
    } : null,
    media: element.type === 'image' || element.type === 'video' ? {
      src: element.src,
      fit: element.fit,
      sourceBox: element.sourceBox,
      effects: element.effects ?? [],
      borderColor: element.borderColor ?? null,
      borderWidth: element.borderWidth ?? 0,
      borderRadius: element.borderRadius ?? 0,
      duration: element.type === 'video' ? element.end : null,
    } : null,
    shape: element.type === 'shape' ? {
      kind: element.shape,
      stroke: element.stroke,
      fill: element.fill,
      strokeWidth: element.strokeWidth,
      arrowStart: element.arrowStart,
      arrowEnd: element.arrowEnd,
      control: element.control ?? null,
      braceDepth: element.shape === 'brace' ? braceDepthOf(element) : null,
      path: element.path,
    } : null,
    morphId: element.morphId ?? null,
    lineageId: element.lineageId ?? null,
  };
}
