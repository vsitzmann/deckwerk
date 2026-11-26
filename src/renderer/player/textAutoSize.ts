import type { TextEl } from '@shared/deck.js';

/**
 * The box a sized-to-text element should have, from its rendered node, or
 * null when it already has it (within a pixel) or cannot be measured.
 *
 * The text is laid out at its natural width (it never soft-wraps, see
 * type.css), and whatever separates the box from its text — the body's
 * padding, borders — is carried over unchanged. The box stays put at the
 * edge its alignment names and at its top.
 */
export function measureTextToSize(
  node: HTMLElement,
  el: TextEl,
): { x: number; w: number; h: number } | null {
  const body = node.querySelector<HTMLElement>('.text-body');
  const content = node.querySelector<HTMLElement>('.text-content');
  if (!body || !content || !node.isConnected) return null;
  const boxW = node.offsetWidth;
  const boxH = node.offsetHeight;
  const bodyStyle = getComputedStyle(body);
  const chromeX = boxW - content.offsetWidth;
  const chromeY = (boxH - body.clientHeight)
    + parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
  const width = content.style.width;
  content.style.width = 'max-content';
  const rect = content.getBoundingClientRect();
  const layoutW = content.offsetWidth;
  const layoutH = content.offsetHeight;
  const scale = node.getBoundingClientRect().width / (boxW || 1);
  content.style.width = width;
  // Bounding rects are in screen pixels (the canvas is zoomed) but keep the
  // fraction offsetWidth rounds away; the box is in canvas pixels. Rotation
  // skews that ratio, so a rotated box settles for the rounded layout size.
  const unscaled = !el.rot && scale > 0 ? scale : null;
  const naturalW = unscaled ? rect.width / unscaled : layoutW + 1;
  const naturalH = unscaled ? rect.height / unscaled : layoutH;
  if (naturalH < 1) return null;
  const w = Math.max(8, Math.ceil(naturalW + chromeX));
  const h = Math.max(8, Math.ceil(naturalH + chromeY));
  if (Math.abs(w - el.w) <= 1 && Math.abs(h - el.h) <= 1) return null;
  const x = el.align === 'center' ? Math.round(el.x + (el.w - w) / 2)
    : el.align === 'right' ? el.x + el.w - w
      : el.x;
  return { x, w, h };
}

const latest = new WeakMap<HTMLElement, TextEl>();
const pending = new WeakSet<HTMLElement>();
const fontWaits = new WeakMap<HTMLElement, Promise<FontFaceSet>>();

/**
 * Every surface must resolve Size box to text, even when its saved geometry
 * predates font loading or was measured in another editor. This is a paint
 * adjustment only; presenting never edits or broadcasts the shared deck.
 */
export function scheduleTextAutoSize(node: HTMLElement, element: TextEl): void {
  latest.set(node, element);
  if (!pending.has(node)) {
    pending.add(node);
    queueMicrotask(() => {
      pending.delete(node);
      const current = latest.get(node);
      if (!current?.autoSize || current.table || node.dataset.autoSize !== 'true') return;
      const box = measureTextToSize(node, current);
      if (box) {
        node.style.left = `${box.x}px`;
        node.style.width = `${box.w}px`;
        node.style.height = `${box.h}px`;
      }
      // Measuring starts the font fetches. Read ready afterwards so the
      // promise includes those fonts, and repeat when a later theme starts
      // another font-loading cycle.
      const ready = document.fonts?.ready;
      if (ready && fontWaits.get(node) !== ready) {
        fontWaits.set(node, ready);
        void ready.then(() => {
          const updated = latest.get(node);
          if (updated && node.isConnected) scheduleTextAutoSize(node, updated);
        });
      }
    });
  }
}
