import type { Slide } from './deck.js';

export interface SlideSection {
  depth: number;
  parent: number | null;
  /** Exclusive end of this slide and its descendants. */
  end: number;
}

/** Sections are implied by each unindented slide and the indented slides after it. */
export function slideSections(slides: readonly Slide[]): SlideSection[] {
  const sections: SlideSection[] = [];
  let heading: number | null = null;
  slides.forEach((slide, index) => {
    const depth = slide.indentLevel ?? 0;
    if (depth === 0) {
      if (heading !== null) sections[heading].end = index;
      heading = index;
      sections.push({ depth, parent: null, end: slides.length });
    } else {
      sections.push({ depth, parent: heading, end: index + 1 });
    }
  });
  return sections;
}

/** A slide's indentation is independent of the slides that follow it. */
function canIndentSlide(slide: Slide, delta: 1 | -1): boolean {
  const depth = slide.indentLevel ?? 0;
  return delta === 1 ? depth === 0 : depth === 1;
}

/** A mixed selection can still change the slides that are not at the limit. */
export function canChangeSlideIndent(slides: readonly Slide[], ids: ReadonlySet<string>, delta: 1 | -1): boolean {
  return slides.some((slide) => ids.has(slide.id) && canIndentSlide(slide, delta));
}

/** Set only selected slide properties; section boundaries follow from the sequence. */
export function changeSlideIndent(slides: Slide[], ids: ReadonlySet<string>, delta: 1 | -1): boolean {
  let changed = false;
  slides.forEach((slide) => {
    if (!ids.has(slide.id) || !canIndentSlide(slide, delta)) return;
    if (delta === 1) slide.indentLevel = 1;
    else delete slide.indentLevel;
    changed = true;
  });
  return changed;
}

/** Move a section as one block, beside the target rather than inside a folded group. */
export function moveSlideSection(slides: Slide[], from: number, target: number, after: boolean): number {
  const outline = slideSections(slides);
  if (!outline[from] || !outline[target]) return from;
  const end = outline[from].end;
  if (target >= from && target < end) return from;
  let at = after ? outline[target].end : target;
  const moved = slides.splice(from, end - from);
  if (at > from) at -= moved.length;
  slides.splice(at, 0, ...moved);
  return at;
}
