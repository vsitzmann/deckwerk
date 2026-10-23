import type { SlideElement } from '@shared/deck.js';
import {
  DEFAULT_SYNC_LENGTH,
  arrangeAsWipe,
  clampWipe,
  isCompareMedia,
  type SyncLength,
} from '@shared/compare.js';
import type { EditorStore } from './store.js';

/**
 * The edits to a before/after wipe and a synced group -- from the inspector,
 * the canvas's chip and the context menu -- each one named, undoable
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

/**
 * Set how long sync group `group` runs when its clips differ in length. It is
 * written on every member, as the group itself is; the default is written as
 * nothing, so a deck that never chose stays as it was.
 */
export function setSyncLength(store: EditorStore, group: string, mode: SyncLength): void {
  onSlide(store, (elements) => {
    for (const element of elements) {
      if (element.type !== 'video' || element.syncGroup !== group) continue;
      if (mode === DEFAULT_SYNC_LENGTH) delete element.syncLength;
      else element.syncLength = mode;
    }
  }, 'Change sync length');
}

/** The menu labels and hover text for each length setting, shared by the inspector and the canvas chip. */
export const SYNC_LENGTH_CHOICES: ReadonlyArray<{ value: SyncLength; text: string; title: string }> = [
  { value: 'shortest', text: 'Shortest', title: 'End with the shortest clip, cutting the longer ones' },
  { value: 'hold', text: 'Hold last', title: 'Run to the longest clip; shorter ones freeze on their last frame' },
  { value: 'black', text: 'Black', title: 'Run to the longest clip; shorter ones go black when they end' },
];
