import type { Slide } from '@shared/deck.js';
import { applyParagraphVisibility } from '@shared/paragraphs.js';
import type { SlideState } from '@shared/timeline.js';
import { curvedShadowClasses } from '@shared/shapeShadow.js';

/**
 * Apply the resolved, motion-free endpoint of one build state.
 *
 * The player, presenter preview, and PDF renderer use this same function. This
 * keeps visibility, paragraph builds, and build classes identical everywhere.
 */
export function applyStaticSlideState(
  stage: ParentNode,
  slide: Slide,
  state: SlideState,
): void {
  applyParagraphVisibility(stage, state);
  const nodes = new Map(
    [...stage.querySelectorAll<HTMLElement>('[data-element-id]')]
      .map((node) => [node.dataset.elementId ?? '', node] as const),
  );
  for (const element of slide.elements) {
    const node = nodes.get(element.id);
    if (!node) continue;
    const visible = state.visible.has(element.id);
    node.style.visibility = visible ? 'visible' : 'hidden';
    node.style.pointerEvents = visible ? '' : 'none';
    node.className = [
      'element',
      `element-${element.type}`,
      ...element.class,
      ...curvedShadowClasses(element.style),
      ...(state.classes.get(element.id) ?? []),
    ].join(' ');
  }
}
