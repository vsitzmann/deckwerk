import type { Slide } from './deck.js';

export const MAX_SLIDE_DEPTH = 1;

export interface SlideSection {
  depth: number;
  parent: number | null;
  /** Exclusive end of this slide and its descendants. */
  end: number;
}

/** The flat presentation order is also its outline. Repair orphaned depths on view. */
export function slideSections(slides: readonly Slide[]): SlideSection[] {
  const sections: SlideSection[] = [];
  const stack: number[] = [];
  for (let i = 0; i < slides.length; i++) {
    const depth = Math.min(slides[i].indentLevel ?? 0, stack.length, MAX_SLIDE_DEPTH);
    while (stack.length > depth) sections[stack.pop()!].end = i;
    sections.push({ depth, parent: stack.at(-1) ?? null, end: slides.length });
    stack.push(i);
  }
  return sections;
}

/** Selected section heads carry their descendants through outline commands. */
export function sectionSelection(slides: readonly Slide[], ids: ReadonlySet<string>): Set<string> {
  const sections = slideSections(slides);
  const selected = new Set<string>();
  let end = 0;
  slides.forEach((slide, i) => {
    if (ids.has(slide.id)) end = Math.max(end, sections[i].end);
    if (i < end) selected.add(slide.id);
  });
  return selected;
}

/** Whether every selected subtree can take one indentation step. */
export function canChangeSlideIndent(slides: readonly Slide[], ids: ReadonlySet<string>, delta: 1 | -1): boolean {
  const outline = slideSections(slides);
  const chosen = sectionSelection(slides, ids);
  const indices = slides.flatMap((slide, i) => chosen.has(slide.id) ? [i] : []);
  if (!indices.length) return false;
  for (const i of indices) {
    if (outline[i].depth + delta < 0 || outline[i].depth + delta > MAX_SLIDE_DEPTH) return false;
    if (delta === 1 && (i === 0 || outline[i].depth + 1 > outline[i - 1].depth + (chosen.has(slides[i - 1].id) ? 1 : 0) + 1)) return false;
  }
  return true;
}

/** Indent/outdent a selection atomically, preserving every nested subtree. */
export function changeSlideIndent(slides: Slide[], ids: ReadonlySet<string>, delta: 1 | -1): boolean {
  if (!canChangeSlideIndent(slides, ids, delta)) return false;
  const outline = slideSections(slides);
  const chosen = sectionSelection(slides, ids);
  slides.forEach((slide, i) => {
    const depth = outline[i].depth + (chosen.has(slide.id) ? delta : 0);
    if (!chosen.has(slide.id) && (slide.indentLevel ?? 0) === depth) return;
    if (depth) slide.indentLevel = depth;
    else delete slide.indentLevel;
  });
  return true;
}

/** Move a section as one block, beside the target rather than inside a folded group. */
export function moveSlideSection(slides: Slide[], from: number, target: number, after: boolean): number {
  const outline = slideSections(slides);
  if (!outline[from] || !outline[target]) return from;
  const end = outline[from].end;
  if (target >= from && target < end) return from;
  let at = after ? outline[target].end : target;
  const depth = outline[target].depth;
  const levels = outline.slice(from, end).map((entry) => entry.depth - outline[from].depth + depth);
  if (levels.some((level) => level > MAX_SLIDE_DEPTH)) return from;
  const moved = slides.splice(from, end - from);
  if (at > from) at -= moved.length;
  moved.forEach((slide, i) => {
    if (levels[i]) slide.indentLevel = levels[i];
    else delete slide.indentLevel;
  });
  slides.splice(at, 0, ...moved);
  return at;
}
