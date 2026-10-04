import type { Deck, LayoutMaster, Slide, SlideElement, TextEl } from './deck.js';
import { ROLE_TYPE_SCALE_PROPERTIES } from './themes.js';

export type FixedLayout = 'freeform' | 'standard' | 'title';

const roleClass = (slot: 'title' | 'body'): string => `role-${slot}`;

function placeholder(
  id: string,
  slot: 'title' | 'body',
  box: Pick<TextEl, 'x' | 'y' | 'w' | 'h' | 'align' | 'valign'>,
): TextEl {
  return {
    id,
    type: 'text',
    ...box,
    rot: 0,
    z: slot === 'title' ? 10 : 11,
    opacity: 1,
    class: [roleClass(slot), 'placeholder'],
    style: {},
    html: slot === 'title' ? 'Slide title' : 'Body text',
    autoFit: true,
    layoutPlaceholder: slot,
  };
}

/** Initial masters exactly match the legacy geometry, so installing them is visually neutral. */
export function defaultLayoutMasters(): NonNullable<Deck['layoutMasters']> {
  return {
    freeform: { background: { color: null, image: null }, elements: [] },
    standard: {
      background: { color: null, image: null },
      elements: [
        placeholder('master-standard-title', 'title', {
          x: 120, y: 58, w: 1680, h: 142, align: 'left', valign: 'middle',
        }),
        placeholder('master-standard-body', 'body', {
          x: 120, y: 252, w: 1680, h: 700, align: 'left', valign: 'top',
        }),
      ],
    },
    title: {
      background: { color: null, image: null },
      elements: [
        placeholder('master-title-title', 'title', {
          x: 180, y: 350, w: 1560, h: 300, align: 'center', valign: 'middle',
        }),
      ],
    },
  };
}

export function layoutMaster(
  deck: Deck,
  layout: FixedLayout,
): LayoutMaster {
  return deck.layoutMasters?.[layout] ?? defaultLayoutMasters()[layout];
}

/** The prompt copy a fresh placeholder is created holding. */
const PROMPT_COPY: Record<'title' | 'body', string> = {
  title: 'Slide title',
  body: 'Body text',
};

/** Does this box still hold nothing but the prompt it was created with? */
function isUnwrittenPrompt(element: SlideElement, slot: 'title' | 'body'): boolean {
  if (element.type !== 'text') return false;
  const written = element.html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[\s ​⁠]+/g, ' ')
    .trim();
  return written === '' || written === PROMPT_COPY[slot];
}

function textForSlot(slide: Slide, slot: 'title' | 'body'): TextEl | undefined {
  return slide.elements.find((element): element is TextEl => element.type === 'text'
    && (element.layoutPlaceholder === slot || element.class.includes(roleClass(slot))));
}

function copyPlaceholderPresentation(
  target: TextEl,
  source: TextEl,
  replaceStyle: boolean,
): void {
  target.x = source.x;
  target.y = source.y;
  target.w = source.w;
  target.h = source.h;
  target.rot = source.rot;
  target.opacity = source.opacity;
  // Putting a slide on a layout is the author asking for that layout's look,
  // so it adopts the master's styling whole. Propagating a master edit is not:
  // there the master's declarations win and everything it is silent about
  // stays the slide's own, because that is where a theme applied to slides
  // lives. Replacing wholesale on this path meant merely opening the layout
  // editor and pressing Done dropped the deck's typography back to the
  // stylesheet's on every slide at once, as if the deck had changed theme.
  //
  // A master carries geometry and, at most, a face and weight -- never a type
  // scale. The size of a title is the deck's, set once for every title in the
  // theme; a size typed on a placeholder used to stamp itself onto every slide
  // and silently take those boxes off the deck's scale for good.
  const sourceStyle = withoutTypeScale(source.style);
  const strippedContent = source.contentStyle ? withoutTypeScale(source.contentStyle) : undefined;
  const sourceContentStyle = strippedContent && Object.keys(strippedContent).length > 0
    ? strippedContent
    : undefined;
  if (replaceStyle) {
    target.style = sourceStyle;
    target.contentStyle = sourceContentStyle;
  } else {
    target.style = { ...target.style, ...sourceStyle };
    if (sourceContentStyle) {
      target.contentStyle = { ...(target.contentStyle ?? {}), ...sourceContentStyle };
    }
  }
  target.align = source.align;
  target.valign = source.valign;
  target.autoFit = source.autoFit;
  target.noWrap = source.noWrap;
  target.noWrapMode = source.noWrapMode;
  target.paragraphSpacing = source.paragraphSpacing;
  // `placeholder` means "prompt copy the author has not replaced", and the
  // player, exports and rail thumbnails all hide such text (type.css). The
  // first real content commit retires it (see canvas.ts), so a master update
  // must never put it back: doing so blanked every authored title and body on
  // every slide the moment a layout was edited -- visibly, in the slide
  // picker, and on the projector.
  const stillPrompting = target.class.includes('placeholder');
  target.class = [
    ...source.class.filter((name) => name !== 'layout-master-element' && name !== 'placeholder'),
    roleClass(source.layoutPlaceholder ?? target.layoutPlaceholder ?? 'body'),
    ...(stillPrompting ? ['placeholder'] : []),
  ].filter((name, index, names) => names.indexOf(name) === index);
  target.layoutPlaceholder = source.layoutPlaceholder;
}

function withoutTypeScale(style: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = structuredClone(style);
  for (const property of ROLE_TYPE_SCALE_PROPERTIES) delete copy[property];
  return copy;
}

function decorationCopy(slideId: string, source: SlideElement, order: number): SlideElement {
  const copy = structuredClone(source);
  copy.id = `${slideId}--master--${source.id}`;
  copy.layoutMasterId = source.id;
  copy.morphId = null;
  copy.lineageId = undefined;
  copy.z = -10_000 + order;
  copy.class = [...copy.class.filter((name) => name !== 'placeholder'), 'layout-master-element']
    .filter((name, index, names) => names.indexOf(name) === index);
  if (copy.type === 'text') copy.layoutPlaceholder = undefined;
  return copy;
}

/**
 * Synchronize one concrete slide from its master.
 *
 * Placeholder content stays slide-owned; geometry and presentation come from
 * the master. Repeated master objects are concrete, read-only copies so every
 * renderer and exporter sees the exact same ordinary slide structure.
 */
export function syncSlideWithLayoutMaster(
  slide: Slide,
  layout: FixedLayout,
  master: LayoutMaster,
  options: { forceBackground?: boolean; replaceStyle?: boolean } = {},
): void {
  slide.layout = layout;
  const retiredCopies = new Set(slide.elements
    .filter((element) => element.layoutMasterId)
    .map((element) => element.id));
  slide.elements = slide.elements.filter((element) => !element.layoutMasterId);

  for (const source of master.elements) {
    if (source.type !== 'text' || !source.layoutPlaceholder) continue;
    let target = textForSlot(slide, source.layoutPlaceholder);
    if (!target) {
      target = structuredClone(source);
      target.id = `text-${slide.id}-${source.layoutPlaceholder}`;
      target.html = source.layoutPlaceholder === 'title' ? 'Slide title' : 'Body text';
      slide.elements.push(target);
    }
    copyPlaceholderPresentation(target, source, options.replaceStyle === true);
  }

  // A prompt the new layout has no slot for, and that nobody has written
  // into, goes: switching a fresh slide from Title + body to Title slide used
  // to leave the empty body prompt standing on top of the title. Two
  // independent things must both say "unwritten" before a box is dropped --
  // the `placeholder` class the first content commit retires, and the text
  // itself still being the prompt copy or nothing at all. Either one alone
  // would eventually eat an author's words: a path that writes html without
  // clearing the class, or a title that genuinely reads "Slide title".
  const slots = new Set(master.elements
    .map((element) => (element.type === 'text' ? element.layoutPlaceholder : undefined))
    .filter((slot): slot is 'title' | 'body' => slot !== undefined));
  slide.elements = slide.elements.filter((element) => {
    const slot = layoutSlotOf(element);
    if (slot === null || slots.has(slot)) return true;
    return !element.class.includes('placeholder') || !isUnwrittenPrompt(element, slot);
  });

  const decorations = master.elements.filter((element) => (
    element.type !== 'text' || !element.layoutPlaceholder
  ));
  slide.elements.unshift(...decorations.map((element, index) => decorationCopy(slide.id, element, index)));

  // A decoration the author removed from the master takes its per-slide copies
  // with it, so any build step aimed at one of them must go the same way --
  // every other deletion path prunes the timeline, and a step whose target no
  // longer exists is a click that does nothing during the talk.
  for (const element of slide.elements) retiredCopies.delete(element.id);
  if (retiredCopies.size > 0) {
    slide.timeline = slide.timeline.filter((entry) => (
      !retiredCopies.has(entry.action.target)
      && !(entry.trigger.ref && retiredCopies.has(entry.trigger.ref))
    ));
  }

  const inheritedAlready = slide.layoutBackgroundInherited === true;
  const hasNoExplicitBackground = slide.background.color === null && slide.background.image === null;
  if (options.forceBackground || inheritedAlready || (
    slide.layoutBackgroundInherited === undefined && hasNoExplicitBackground
  )) {
    slide.background = structuredClone(master.background);
    slide.layoutBackgroundInherited = true;
  } else if (slide.layoutBackgroundInherited === undefined) {
    slide.layoutBackgroundInherited = false;
  }
}

/**
 * An existing slide coming back from an authoring page in the layout it
 * already has.
 *
 * Such a page is an export: every box sits where the slide had it and is
 * styled the way it was. Putting the slide "on" its layout again
 * (`syncSlideWithLayoutMaster`) moved placeholders the author had placed,
 * stripped the formatting they chose, turned imported text boxes into body
 * prompts and added prompts the slide never had — on a page nobody touched.
 * Only a placeholder the page newly adds (`data-layout-slot`, under an id the
 * slide did not have) is the master's to place and style.
 */
export function placeNewPlaceholders(
  slide: Slide,
  layout: FixedLayout,
  master: LayoutMaster,
  previous: Slide,
): void {
  slide.layout = layout;
  const known = new Set(previous.elements.map((element) => element.id));
  for (const source of master.elements) {
    if (source.type !== 'text' || !source.layoutPlaceholder) continue;
    const target = slide.elements.find((element): element is TextEl => element.type === 'text'
      && !known.has(element.id) && element.layoutPlaceholder === source.layoutPlaceholder);
    if (target) copyPlaceholderPresentation(target, source, true);
  }
}

/** The layout slot a text box stands in, by its placeholder record or its role class. */
export function layoutSlotOf(element: SlideElement): 'title' | 'body' | null {
  if (element.type !== 'text') return null;
  if (element.layoutPlaceholder) return element.layoutPlaceholder;
  if (element.class.includes(roleClass('title'))) return 'title';
  if (element.class.includes(roleClass('body'))) return 'body';
  return null;
}

/**
 * Where the layout puts a text box of this role. Purely a function of the
 * role: every title-role box snaps to the title slot, every body-role box to
 * the body slot, whichever box on the slide it is. The slide's own layout
 * master answers first; a freeform slide, which places nothing, falls back to
 * the standard layout so the box still has a default to return to. Null when
 * the box has no role or no master defines the slot.
 */
export function layoutGeometryFor(
  slide: Slide,
  element: SlideElement,
  masters: Deck['layoutMasters'] = null,
): Pick<TextEl, 'x' | 'y' | 'w' | 'h' | 'rot' | 'align' | 'valign'> | null {
  const slot = layoutSlotOf(element);
  if (!slot) return null;
  const layout = (slide.layout ?? 'freeform') as FixedLayout;
  const all = masters ?? defaultLayoutMasters();
  const slotIn = (master: LayoutMaster): TextEl | undefined => master.elements.find(
    (candidate): candidate is TextEl => candidate.type === 'text' && candidate.layoutPlaceholder === slot,
  );
  const source = slotIn(all[layout]) ?? slotIn(all.standard);
  if (!source) return null;
  const { x, y, w, h, rot, align, valign } = source;
  return { x, y, w, h, rot, align, valign };
}

/** True when the box already sits exactly where its layout puts it. */
export function elementFollowsLayout(
  slide: Slide,
  element: SlideElement,
  masters: Deck['layoutMasters'] = null,
): boolean {
  const target = layoutGeometryFor(slide, element, masters);
  if (!target || element.type !== 'text') return false;
  return (['x', 'y', 'w', 'h', 'rot', 'align', 'valign'] as const)
    .every((key) => element[key] === target[key]);
}

/**
 * Put ONE text box back where its role's layout slot is: the per-box
 * counterpart of `realignSlideToLayout`, for the title that is a few pixels
 * off with no way to find the right spot but trial and error. Never touches
 * the rest of the slide; geometry and alignment only, styling and content
 * stay. Returns whether anything moved.
 */
export function realignElementToLayout(
  slide: Slide,
  elementId: string,
  masters: Deck['layoutMasters'] = null,
): boolean {
  const element = slide.elements.find((candidate) => candidate.id === elementId);
  if (!element || element.type !== 'text') return false;
  const target = layoutGeometryFor(slide, element, masters);
  if (!target) return false;
  if (elementFollowsLayout(slide, element, masters)) return false;
  Object.assign(element, target);
  return true;
}

/** Synchronize every slide that uses one of the fixed layouts. */
export function syncDeckWithLayoutMasters(deck: Deck): void {
  if (!deck.layoutMasters) return;
  for (const slide of deck.slides) {
    const layout = (slide.layout ?? 'freeform') as FixedLayout;
    syncSlideWithLayoutMaster(slide, layout, deck.layoutMasters[layout]);
  }
}


/**
 * Put a slide's text boxes back where its layout puts them.
 *
 * This is "Apply layout": the geometric counterpart of "Apply theme". Only
 * position, size, rotation and alignment travel from the master to the slot's
 * text box -- no styling, no new boxes, no decorations, no background. A slide
 * on the freeform layout has nothing to align to. Returns how many boxes moved.
 */
export function realignSlideToLayout(slide: Slide, masters: Deck['layoutMasters'] = null): number {
  const layout = (slide.layout ?? 'freeform') as FixedLayout;
  const master = masters?.[layout] ?? defaultLayoutMasters()[layout];
  let moved = 0;
  for (const source of master.elements) {
    if (source.type !== 'text' || !source.layoutPlaceholder) continue;
    const target = textForSlot(slide, source.layoutPlaceholder);
    if (!target) continue;
    target.x = source.x;
    target.y = source.y;
    target.w = source.w;
    target.h = source.h;
    target.rot = source.rot;
    target.align = source.align;
    target.valign = source.valign;
    moved += 1;
  }
  return moved;
}
