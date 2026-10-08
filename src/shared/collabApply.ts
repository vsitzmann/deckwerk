import { DeckSchema, ElementSchema, SlideSchema, type Deck, type Slide, type SlideElement } from './deck.js';
import type { AgentOperation } from './agent.js';
import { jsonEqual } from './jsonData.js';
import { mergeTextHtml } from './textMerge.js';

export interface LenientApplyResult {
  deck: Deck;
  /** Ops (or parts of ops) that could not apply against the current state. */
  skipped: Array<{ op: AgentOperation; reason: string }>;
}

/**
 * Apply operations with last-write-wins merge semantics.
 *
 * Unlike applyAgentTransaction — which rejects a whole transaction the moment
 * any id fails to resolve, the right contract for a CLI agent working against
 * a pinned revision — this function is total and deterministic: every op
 * either applies or is skipped by a fixed rule, and the same deck plus the
 * same op list always produces the same output. The server and every client
 * replay the same server-ordered stream through this function, which is what
 * makes replicas converge.
 *
 * Skip rules (delete wins over edit; inserts are idempotent):
 * - replaceElement / setSlideProperties / replaceSlide: target gone → skip.
 * - deleteElements: filtered to ids that still exist; deleteSlide of the last
 *   remaining slide → skip.
 * - moveSlide: slide or anchor gone → skip (slide stays put).
 * - insertElements: target slide gone → skip; elements whose id already
 *   exists deck-wide are dropped.
 * - insertSlides: slides whose id already exists are dropped; a vanished
 *   anchor appends at the end rather than discarding the user's new slide.
 * - updateDeck: always applies.
 * - setSlideProperties `clear` of a field with a default (notes, timeline,
 *   …) leaves the default, as a parse of the slide would.
 * - replaceElement carrying `baseHtml` (live text sync) onto an element
 *   whose html changed since that base: the two html edits are merged
 *   three ways (textMerge.ts) rather than the later one overwriting.
 *
 * Afterwards, timeline entries referencing elements that no longer exist on
 * their slide are pruned, so a concurrent element delete can never leave a
 * slide's timeline dangling (validateDeckIntegrity treats that as an error).
 *
 * Copy-on-write. Every client runs this on every transaction, so its cost
 * must follow what the transaction touched, never the size of the deck (a
 * deck holding a 10 MB inline image once saturated every browser editing it).
 * The input is never mutated; the result is a new deck object with a new
 * slides array, in which every slide no op touched is the *same object* as in
 * the input, and every untouched element of a touched slide is too. That
 * sharing is what lets EditorStore.applyRemote and diffDecks skip untouched
 * slides by reference. The input deck is taken to be a parsed Deck already;
 * what enters from the ops (slides, elements, slide properties, deck
 * properties) is parsed here, so every touched part of the result is exactly
 * what `DeckSchema.parse` would make of it — defaults filled, unknown keys
 * dropped, keys in schema order.
 */
export function applyOpsLenient(deck: Deck, ops: AgentOperation[]): LenientApplyResult {
  const draft = new DraftDeck(deck);
  const skipped: LenientApplyResult['skipped'] = [];
  const skip = (op: AgentOperation, reason: string) => skipped.push({ op, reason });

  for (const op of ops) applyLenient(draft, op, skip);
  return { deck: draft.finish(), skipped };
}

/**
 * The copy-on-write working state of one applyOpsLenient call.
 *
 * `deck` is a shallow copy of the input with its own slides array. A slide is
 * copied (shallowly, with its own elements array) the first time an op
 * changes it; `owned` holds those copies and every slide that entered from an
 * op, which are the only slide objects this draft may mutate.
 */
class DraftDeck {
  readonly deck: Deck;
  private readonly owned = new Set<Slide>();
  private propsTouched = false;

  constructor(private readonly base: Deck) {
    this.deck = { ...base, slides: base.slides.slice() };
  }

  get slides(): Slide[] {
    return this.deck.slides;
  }

  indexOf(id: string): number {
    return this.deck.slides.findIndex((slide) => slide.id === id);
  }

  /** The slide at `at`, made mutable (copied once per apply if it is the input's). */
  own(at: number): Slide {
    const slide = this.deck.slides[at];
    if (this.owned.has(slide)) return slide;
    const copy: Slide = { ...slide, elements: slide.elements.slice() };
    this.deck.slides[at] = copy;
    this.owned.add(copy);
    return copy;
  }

  /** A slide entering from an op: validated, private to this apply. */
  admit(slide: Slide): Slide {
    const parsed = SlideSchema.parse(structuredClone(slide));
    this.owned.add(parsed);
    return parsed;
  }

  touchProps(): void {
    this.propsTouched = true;
  }

  finish(): Deck {
    const slides = this.deck.slides;
    // Normalise what changed exactly as a whole-deck DeckSchema.parse would
    // have: elements were parsed as they entered, so a touched slide needs
    // only its own properties parsed around them. First, so that a field a
    // patch cleared is back at its default (`timeline: []`) before pruning.
    for (let i = 0; i < slides.length; i++) {
      if (!this.owned.has(slides[i])) continue;
      slides[i] = normaliseSlideProperties(slides[i]);
      this.owned.add(slides[i]);
    }
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      if (slide.timeline.length === 0) continue;
      const local = new Set(slide.elements.map((element) => element.id));
      const live = (entry: Slide['timeline'][number]) =>
        local.has(entry.action.target) && (!entry.trigger.ref || local.has(entry.trigger.ref));
      if (slide.timeline.every(live)) continue;
      const own = this.own(i);
      own.timeline = own.timeline.filter(live);
    }
    if (!this.propsTouched) return this.deck;
    const { slides: _slides, ...props } = this.deck;
    const parsed = DeckSchema.parse({ ...props, slides: [] }) as unknown as Record<string, unknown>;
    // A property the update left as it was stays the input's object.
    const base = this.base as unknown as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      if (key !== 'slides' && parsed[key] !== base[key] && jsonEqual(parsed[key], base[key])) {
        parsed[key] = base[key];
      }
    }
    parsed.slides = slides;
    return parsed as unknown as Deck;
  }
}

function normaliseSlideProperties(slide: Slide): Slide {
  const { elements, ...props } = slide;
  const parsed = SlideSchema.parse({ ...props, elements: [] });
  parsed.elements = elements;
  return parsed;
}

function admitElement(element: SlideElement): SlideElement {
  return ElementSchema.parse(structuredClone(element));
}

function applyLenient(
  draft: DraftDeck,
  op: AgentOperation,
  skip: (op: AgentOperation, reason: string) => void,
): void {
  switch (op.op) {
    case 'insertSlides': {
      const existing = new Set(draft.slides.map((slide) => slide.id));
      const fresh = op.slides.filter((slide) => !existing.has(slide.id));
      if (fresh.length === 0) return skip(op, 'all slide ids already present');
      const anchor = op.afterSlideId === null ? -1 : draft.indexOf(op.afterSlideId);
      const at = op.afterSlideId === null
        ? 0
        : anchor === -1
          ? draft.slides.length // anchor deleted concurrently: keep the new slides, append
          : anchor + 1;
      draft.slides.splice(at, 0, ...fresh.map((slide) => draft.admit(slide)));
      return;
    }
    case 'replaceSlide': {
      const at = draft.indexOf(op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      if (op.slide.id !== op.slideId) return skip(op, 'replacement changes slide id');
      draft.slides[at] = draft.admit(op.slide);
      return;
    }
    case 'deleteSlide': {
      const at = draft.indexOf(op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} already deleted`);
      if (draft.slides.length === 1) return skip(op, 'a deck must retain at least one slide');
      draft.slides.splice(at, 1);
      return;
    }
    case 'moveSlide': {
      if (op.afterSlideId === op.slideId) return skip(op, 'slide cannot follow itself');
      const from = draft.indexOf(op.slideId);
      if (from === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      if (op.afterSlideId !== null && draft.indexOf(op.afterSlideId) === -1) {
        return skip(op, `anchor ${op.afterSlideId} no longer exists`);
      }
      const [slide] = draft.slides.splice(from, 1);
      const at = op.afterSlideId === null ? 0 : draft.indexOf(op.afterSlideId) + 1;
      draft.slides.splice(at, 0, slide);
      return;
    }
    case 'insertElements': {
      const at = draft.indexOf(op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      const existing = new Set<string>();
      for (const slide of draft.slides) for (const element of slide.elements) existing.add(element.id);
      const fresh = op.elements.filter((element) => !existing.has(element.id));
      if (fresh.length === 0) return skip(op, 'all element ids already present');
      draft.own(at).elements.push(...fresh.map(admitElement));
      return;
    }
    case 'replaceElement': {
      const at = draft.indexOf(op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      const index = draft.slides[at].elements.findIndex((element) => element.id === op.elementId);
      if (index === -1) return skip(op, `element ${op.elementId} no longer exists`);
      if (op.element.id !== op.elementId) return skip(op, 'replacement changes element id');
      const current = draft.slides[at].elements[index];
      draft.own(at).elements[index] = withMergedHtml(current, admitElement(op.element), op.baseHtml);
      return;
    }
    case 'deleteElements': {
      const at = draft.indexOf(op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      const ids = new Set(op.elementIds);
      const current = draft.slides[at];
      const elements = current.elements.filter((element) => !ids.has(element.id));
      if (elements.length === current.elements.length) return skip(op, 'no listed element still exists');
      const slide = draft.own(at);
      slide.elements = elements;
      slide.timeline = slide.timeline.filter((entry) =>
        !ids.has(entry.action.target) && !(entry.trigger.ref && ids.has(entry.trigger.ref)));
      return;
    }
    case 'updateDeck': {
      const deck = draft.deck;
      if (op.title !== undefined) deck.title = op.title;
      if (op.canvas !== undefined) deck.canvas = structuredClone(op.canvas);
      if (op.theme !== undefined) deck.theme = op.theme;
      if (op.themePreset !== undefined) deck.themePreset = op.themePreset;
      if (op.themeStyle !== undefined) deck.themeStyle = structuredClone(op.themeStyle);
      if (op.themeSelection !== undefined) deck.themeSelection = structuredClone(op.themeSelection);
      if (op.themeHistory !== undefined) deck.themeHistory = [...op.themeHistory];
      if (op.customThemes !== undefined) deck.customThemes = structuredClone(op.customThemes);
      if (op.layoutMasters !== undefined) deck.layoutMasters = structuredClone(op.layoutMasters);
      if (op.morphEasing !== undefined) deck.morphEasing = op.morphEasing;
      draft.touchProps();
      return;
    }
    case 'setSlideProperties': {
      const at = draft.indexOf(op.slideId);
      if (at === -1) return skip(op, `slide ${op.slideId} no longer exists`);
      if (op.slide.id !== op.slideId) return skip(op, 'properties change slide id');
      // Merge, never replace: the op carries only the fields that changed, so
      // a concurrent edit to a different field of the same slide survives.
      const slide = draft.own(at);
      const elements = slide.elements;
      Object.assign(slide, structuredClone(op.slide));
      slide.elements = elements;
      // Absence in a patch means "unchanged", so a removal is stated instead.
      for (const key of op.clear ?? []) {
        if (key === 'id' || key === 'elements') continue;
        delete (slide as Record<string, unknown>)[key];
      }
      return;
    }
  }
}

/**
 * A replacement made from `baseHtml` while the element's html has moved on
 * since: two people typing into one box. Both edits to the html are kept
 * (mergeTextHtml); without a base, or when nothing moved, it is the plain
 * replacement it always was.
 */
function withMergedHtml(
  current: SlideElement,
  replacement: SlideElement,
  baseHtml: string | undefined,
): SlideElement {
  if (baseHtml === undefined || !('html' in current) || !('html' in replacement)) return replacement;
  if (typeof current.html !== 'string' || typeof replacement.html !== 'string') return replacement;
  if (current.html === baseHtml) return replacement;
  return { ...replacement, html: mergeTextHtml(baseHtml, current.html, replacement.html) } as SlideElement;
}
