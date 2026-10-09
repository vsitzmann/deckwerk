import type { SlideElement } from '@shared/deck.js';
import { clampWipe, wipeClipPath, wipeOf } from '@shared/compare.js';
import { isolatePointer, suppressNextClick } from './pointerIsolation.js';

/**
 * The before/after wipe, as pixels (the model is in shared/compare.ts).
 *
 * The upper layer's media body is clipped to the left of the divider, and the
 * divider itself -- a line with a round handle -- is a child of the same
 * element, so it moves, rotates and Morphs with the box. The clip goes on the
 * body rather than on the wrapper because a clip on the wrapper would cut the
 * handle in half; the media frame overlay stays unclipped, so a bordered wipe
 * is framed as one picture.
 *
 * Every surface that draws a slide shows the divider where the deck says:
 * the editor canvas, thumbnails, the PDF. Only the player makes it draggable
 * (`mountWipeDrag`), and a drag there moves the divider on screen without
 * editing the deck -- presenting is not editing.
 */

const DIVIDER_CLASS = 'wipe-divider';

type MediaElement = Extract<SlideElement, { type: 'image' | 'video' }>;

/**
 * Draw, move or remove the wipe on a rendered media element. Called from
 * `syncMediaFrame`, which both the full render and the editor's in-place
 * patch go through, so the two can never disagree about it.
 */
export function syncWipe(
  node: HTMLElement,
  el: MediaElement,
  body: HTMLElement | SVGElement | null,
): void {
  const fraction = wipeOf(el);
  let divider = node.querySelector<HTMLElement>(`:scope > .${DIVIDER_CLASS}`);
  if (fraction === null) {
    divider?.remove();
    body?.style.removeProperty('clip-path');
    return;
  }
  if (!divider) {
    divider = document.createElement('div');
    divider.className = DIVIDER_CLASS;
    divider.setAttribute('aria-hidden', 'true');
    const handle = document.createElement('div');
    handle.className = 'wipe-handle';
    // Two chevrons pointing apart: the conventional "drag sideways" mark.
    handle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M9.5 6.5 4 12l5.5 5.5M14.5 6.5 20 12l-5.5 5.5" fill="none" '
      + 'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    divider.appendChild(handle);
  }
  // Always last, after the media frame overlay, in the patch path as in a
  // fresh render: the render invariants compare the two child for child.
  node.appendChild(divider);
  placeWipe(node, fraction, body);
}

/** The element's media body: its first child that is not decoration. */
function wipeBody(node: HTMLElement): HTMLElement | SVGElement | null {
  for (const child of node.children) {
    if (child.classList.contains('media-border-overlay') || child.classList.contains(DIVIDER_CLASS)) continue;
    if (child.tagName.toLowerCase() === 'svg' && child.querySelector('filter')) continue;
    return child as HTMLElement | SVGElement;
  }
  return null;
}

/** Put the divider at `fraction` of the box's width and clip the upper layer to match. */
export function placeWipe(
  node: HTMLElement,
  fraction: number,
  body: HTMLElement | SVGElement | null = wipeBody(node),
): void {
  const at = clampWipe(fraction);
  if (body) body.style.clipPath = wipeClipPath(at);
  const divider = node.querySelector<HTMLElement>(`:scope > .${DIVIDER_CLASS}`);
  if (divider) divider.style.left = `${Math.round(at * 10000) / 100}%`;
}

/**
 * The fraction of `node`'s width under a pointer, in the element's own frame:
 * the pointer is taken relative to the box's centre and turned back through
 * the element's rotation, so a tilted wipe still follows the finger along
 * its own axis.
 */
function fractionAt(node: HTMLElement, clientX: number, clientY: number): number {
  const rect = node.getBoundingClientRect();
  const width = node.offsetWidth;
  if (width <= 0) return 0.5;
  const slide = node.offsetParent as HTMLElement | null;
  const scale = slide && slide.offsetWidth > 0
    ? slide.getBoundingClientRect().width / slide.offsetWidth
    : 1;
  const degrees = Number(/rotate\(([-\d.e]+)deg\)/.exec(node.style.transform)?.[1] ?? 0);
  const angle = (-degrees * Math.PI) / 180;
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const local = (dx * Math.cos(angle) - dy * Math.sin(angle)) / (scale || 1);
  return clampWipe(local / width + 0.5);
}

/**
 * Make every wipe divider under `root` draggable, for the presentation.
 * Returns the teardown. A drag never reaches the deck's click-to-advance.
 */
export function mountWipeDrag(root: HTMLElement): () => void {
  const teardowns: Array<() => void> = [];
  for (const divider of root.querySelectorAll<HTMLElement>(`.element > .${DIVIDER_CLASS}`)) {
    const node = divider.parentElement!;
    divider.classList.add('wipe-live');
    let dragging: number | null = null;
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = event.pointerId;
      divider.setPointerCapture?.(event.pointerId);
      divider.classList.add('dragging');
      placeWipe(node, fractionAt(node, event.clientX, event.clientY));
    };
    const onMove = (event: PointerEvent): void => {
      if (dragging !== event.pointerId) return;
      placeWipe(node, fractionAt(node, event.clientX, event.clientY));
    };
    const onUp = (event: PointerEvent): void => {
      if (dragging !== event.pointerId) return;
      dragging = null;
      divider.classList.remove('dragging');
      if (divider.hasPointerCapture?.(event.pointerId)) divider.releasePointerCapture(event.pointerId);
      suppressNextClick();
    };
    divider.addEventListener('pointerdown', onDown);
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp);
    divider.addEventListener('pointercancel', onUp);
    const release = isolatePointer(divider);
    teardowns.push(() => {
      divider.classList.remove('wipe-live', 'dragging');
      divider.removeEventListener('pointerdown', onDown);
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
      divider.removeEventListener('pointercancel', onUp);
      release();
    });
  }
  return () => {
    for (const off of teardowns) off();
  };
}
