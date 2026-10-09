import type { SlideElement } from '@shared/deck.js';
import { arrangeAsWipe, clampWipe, isCompareMedia } from '@shared/compare.js';
import type { EditorStore } from './store.js';

/**
 * The inspector's edits to a before/after wipe, each one named, undoable
 * change on the current slide. They address elements by id rather than
 * through the selection: the divider lives on the wipe's top layer, and the
 * person may well have the layer beneath it selected.
 */

function onSlide(store: EditorStore, fn: (elements: SlideElement[]) => void, label: string): void {
  const { slideIndex } = store.get();
  store.commit((deck) => {
    const slide = deck.slides[slideIndex];
    if (slide) fn(slide.elements);
  }, { label });
}

/** Stack two pictures into one box as a wipe (shared/compare.ts `arrangeAsWipe`). */
export function arrangeWipe(store: EditorStore, ids: readonly [string, string]): void {
  onSlide(store, (elements) => { arrangeAsWipe(elements, ids); }, 'Arrange as wipe');
}

/** Move the divider of the wipe whose top layer is `topId`. */
export function setWipe(store: EditorStore, topId: string, fraction: number): void {
  onSlide(store, (elements) => {
    const top = elements.find((element) => element.id === topId);
    if (top && isCompareMedia(top) && top.compare === 'wipe') top.wipe = clampWipe(fraction);
  }, 'Move wipe divider');
}

/**
 * Turn a wipe back into two plain layers. They stay stacked where they are:
 * moving the lower one out is an ordinary drag, and guessing where it used to
 * stand would be wrong as often as right.
 */
export function clearWipe(store: EditorStore, topId: string): void {
  onSlide(store, (elements) => {
    const top = elements.find((element) => element.id === topId);
    if (!top || !isCompareMedia(top)) return;
    delete top.compare;
    delete top.wipe;
  }, 'Turn off wipe');
}
