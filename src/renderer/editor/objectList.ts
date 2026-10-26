import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { releasePreviewVideos } from '../player/previewPoster.js';
import { renderSlide } from '../player/render.js';
import { arrangeSelectionAt, paintOrder } from './arrange.js';
import { describeElement, elementKind } from './elementLabel.js';
import { previewSurface } from './slideRail.js';
import type { EditorStore } from './store.js';

/** Whether the list is open, per machine, like the panel sizes. Closed until opened. */
const VISIBLE_KEY = 'deckwerk.editor.object-list';

/** The miniature's frame, in CSS pixels; editor.css draws the same box. */
const THUMB_W = 54;
const THUMB_H = 36;

const LAYERS_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' +
  '<path d="M8 2.2 14 5.3 8 8.4 2 5.3Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<path d="M2 8.1 8 11.2 14 8.1M2 10.9 8 14 14 10.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * The object list: every object on the current slide in stacking order, the
 * front-most at the top, as in Keynote's Object List and Figma's layers. Each
 * row carries a miniature of its object, drawn by the player's renderer.
 *
 * It is another view of the canvas selection — a row lights up when its object
 * is selected, and picking rows selects objects with the canvas's modifiers —
 * and the one place an object hidden behind another, waiting for a build or
 * parked off the slide can be reached by pointing. Dragging rows restacks the
 * selection through the same edit Bring Forward and Send Backward make.
 */
export class ObjectList {
  readonly toggle: HTMLButtonElement;
  private host: HTMLElement;
  private store: EditorStore;
  private count: HTMLElement;
  private list: HTMLElement;
  /** The elements array last drawn: a selection change only moves the highlight. */
  private drawn: readonly SlideElement[] | null = null;
  /**
   * Rows by element object. The store keeps an untouched element's object
   * across commits, so an edit redraws only the rows of what it changed.
   */
  private rowCache = new Map<SlideElement, HTMLButtonElement>();
  /** What every miniature on the list shares: the slide, its ground and the canvas. */
  private drawnContext = '';
  private highlighted = new Set<string>();
  private stale = false;
  /** Ids being dragged, while a restack is in progress. */
  private dragging: Set<string> | null = null;
  private dragImage: HTMLElement | null = null;
  /** A plain press on an already-selected row narrows to it on click, not on press, so the group can still be dragged. */
  private narrowOnClick: string | null = null;

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.store = store;
    host.classList.add('object-list');

    // The toggle heads the list; the editors move it to the canvas's corner,
    // where it stays while the drawer is closed, so the list is one click away.
    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'object-list-toggle';
    this.toggle.innerHTML = LAYERS_ICON;
    this.toggle.setAttribute('aria-label', 'Object list');
    this.toggle.addEventListener('click', () => this.setVisible(!this.visible));
    const header = document.createElement('header');
    header.className = 'object-list-header';
    const title = document.createElement('h3');
    title.className = 'insp-title';
    title.textContent = 'Objects';
    this.count = document.createElement('span');
    this.count.className = 'object-list-count';
    header.append(this.toggle, title, this.count);
    const hint = document.createElement('p');
    hint.className = 'insp-hint object-list-hint';
    hint.textContent = 'Front to back. Drag to restack.';
    this.list = document.createElement('div');
    this.list.className = 'object-list-rows';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Objects on this slide, front to back');
    this.list.setAttribute('aria-multiselectable', 'true');
    host.replaceChildren(header, hint, this.list);
    this.bindDrop();

    store.subscribe(() => this.onStoreChange());
    this.setVisible(readVisible(), false);
  }

  get visible(): boolean {
    return !this.host.classList.contains('collapsed');
  }

  setVisible(visible: boolean, remember = true): void {
    this.host.classList.toggle('collapsed', !visible);
    this.toggle.setAttribute('aria-pressed', String(visible));
    this.toggle.title = visible ? 'Hide objects' : 'Objects on this slide';
    if (remember) {
      try {
        window.localStorage.setItem(VISIBLE_KEY, visible ? '1' : '0');
      } catch {
        // Private mode: the choice lasts for this window only.
      }
    }
    if (visible) this.render();
  }

  private onStoreChange(): void {
    // A folded list costs nothing; a rebuild under a drag would pull the row
    // being dragged out from under the pointer. Both catch up afterwards.
    if (!this.visible || this.dragging) {
      this.stale = true;
      return;
    }
    this.render();
  }

  render(): void {
    this.stale = false;
    const { deck } = this.store.get();
    const slide = this.store.slide;
    const elements = slide?.elements ?? [];
    let rebuilt = false;
    if (elements !== this.drawn) {
      this.build(deck, slide, elements);
      rebuilt = true;
    }
    this.syncSelection(rebuilt);
  }

  private build(deck: Deck, slide: Slide | undefined, elements: readonly SlideElement[]): void {
    this.drawn = elements;
    const context = slide
      ? `${slide.id}|${slide.layout ?? ''}|${JSON.stringify(slide.background)}|${deck.canvas.w}x${deck.canvas.h}`
      : '';
    if (context !== this.drawnContext) {
      this.drawnContext = context;
      this.dropRows(new Set());
    }
    const order = paintOrder(elements).reverse();
    const rows: HTMLElement[] = order.map((element) => {
      let row = this.rowCache.get(element);
      if (!row) {
        row = this.row(deck, slide!, element);
        this.rowCache.set(element, row);
      }
      return row;
    });
    this.dropRows(new Set(order));
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'insp-hint object-list-empty';
      empty.textContent = 'No objects on this slide.';
      rows.push(empty);
    }
    patchChildren(this.list, rows);
    this.count.textContent = elements.length > 0 ? String(elements.length) : '';
  }

  /** Forget every cached row whose element is not in `keep`. */
  private dropRows(keep: ReadonlySet<SlideElement>): void {
    for (const [element, row] of this.rowCache) {
      if (keep.has(element)) continue;
      this.rowCache.delete(element);
      releasePreviewVideos(row);
    }
  }

  private row(deck: Deck, slide: Slide, element: SlideElement): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'object-list-row';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', 'false');
    row.dataset.elementId = element.id;
    row.dataset.kind = elementKind(element);
    const name = document.createElement('span');
    name.className = 'element-label-text';
    name.textContent = describeElement(element);
    row.append(elementThumb(deck, slide, element), name);
    // A layout's own objects are drawn on the slide but edited in the layout,
    // as on the canvas: listed for the stacking order, not picked or moved.
    const locked = Boolean(element.layoutMasterId);
    row.classList.toggle('locked', locked);
    row.draggable = !locked;
    row.title = locked ? `${describeElement(element)} · part of the layout` : describeElement(element);
    if (locked) {
      row.setAttribute('aria-disabled', 'true');
      return row;
    }

    row.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // Selection runs on press, as in the slide rail: the row is draggable,
      // and Chromium swallows the click once a press drifts into a drag.
      this.narrowOnClick = null;
      const selected = this.store.get().selection.has(element.id);
      if (event.shiftKey || event.metaKey || event.ctrlKey) this.store.select([element.id], true);
      else if (!selected) this.store.select([element.id]);
      else this.narrowOnClick = element.id;
    });
    row.addEventListener('click', (event) => {
      // Enter or Space on a focused row: no press came first.
      if (event.detail === 0) {
        this.store.select([element.id], event.shiftKey || event.metaKey || event.ctrlKey);
        return;
      }
      if (this.narrowOnClick === element.id) this.store.select([element.id]);
      this.narrowOnClick = null;
    });
    row.addEventListener('dragstart', (event) => {
      this.narrowOnClick = null;
      const { selection } = this.store.get();
      if (!selection.has(element.id)) this.store.select([element.id]);
      const ids = new Set(this.store.get().selection);
      this.dragging = ids;
      for (const node of this.rows()) node.classList.toggle('dragging', ids.has(node.dataset.elementId!));
      if (event.dataTransfer) {
        event.dataTransfer.setData('text/plain', [...ids].join(' '));
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setDragImage(this.makeDragImage(ids.size === 1 ? describeElement(element) : `${ids.size} objects`), 12, 10);
      }
    });
    row.addEventListener('dragend', () => this.endDrag());
    return row;
  }

  private rows(): HTMLElement[] {
    return [...this.list.querySelectorAll<HTMLElement>('.object-list-row')];
  }

  /**
   * Drops land between rows, anywhere in the list, including the empty space
   * under the last row (the very back).
   */
  private bindDrop(): void {
    this.list.addEventListener('dragover', (event) => {
      if (!this.dragging) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      this.markGap(this.gapAt(event.clientY));
    });
    this.list.addEventListener('dragleave', (event) => {
      if (event.relatedTarget instanceof Node && this.list.contains(event.relatedTarget)) return;
      this.markGap(null);
    });
    this.list.addEventListener('drop', (event) => {
      if (!this.dragging) return;
      event.preventDefault();
      const moving = this.dragging;
      const gap = this.gapAt(event.clientY);
      const rows = this.rows();
      // The rows stay put during a drag, so the gap counts down from the front;
      // the stack is addressed from the back, by what stays underneath.
      const staying = rows.filter((row) => !moving.has(row.dataset.elementId!));
      const above = rows.slice(0, gap).filter((row) => !moving.has(row.dataset.elementId!)).length;
      this.endDrag();
      arrangeSelectionAt(this.store, staying.length - above);
    });
  }

  /** How many rows lie above the pointer: 0 is the top of the list. */
  private gapAt(clientY: number): number {
    const rows = this.rows();
    const index = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    return index < 0 ? rows.length : index;
  }

  private markGap(gap: number | null): void {
    const rows = this.rows();
    rows.forEach((row, index) => {
      row.classList.toggle('drop-before', gap !== null && index === gap);
      row.classList.toggle('drop-after', gap !== null && gap === rows.length && index === rows.length - 1);
    });
  }

  private endDrag(): void {
    this.dragging = null;
    this.dragImage?.remove();
    this.dragImage = null;
    for (const row of this.rows()) row.classList.remove('dragging', 'drop-before', 'drop-after');
    if (this.stale) this.render();
  }

  /** A small named chip for the drag, as the slide rail uses. */
  private makeDragImage(label: string): HTMLElement {
    this.dragImage?.remove();
    const chip = document.createElement('div');
    chip.className = 'rail-drag-image';
    chip.textContent = label;
    document.body.appendChild(chip);
    this.dragImage = chip;
    return chip;
  }

  private syncSelection(force = false): void {
    const { selection } = this.store.get();
    if (!force && sameSet(selection, this.highlighted)) return;
    this.highlighted = new Set(selection);
    let first: HTMLElement | null = null;
    for (const row of this.rows()) {
      const selected = selection.has(row.dataset.elementId!);
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', String(selected));
      if (selected && !first) first = row;
    }
    // Picking on the canvas brings the row into view, without scrolling a
    // list the author is already looking at.
    first?.scrollIntoView?.({ block: 'nearest' });
  }
}

/**
 * The object alone, cut out of its slide: a slide holding only this element,
 * drawn by the same renderer and machinery as the rail's thumbnails and
 * cropped to the element's rotated bounds. It sits on its slide's own ground,
 * so white text on a dark slide stays legible and the layout's rules apply,
 * and an element parked off the slide is drawn all the same.
 */
function elementThumb(deck: Deck, slide: Slide, element: SlideElement): HTMLElement {
  const frame = document.createElement('span');
  frame.className = 'object-list-thumb';
  frame.setAttribute('aria-hidden', 'true');
  const crop = thumbCrop(element);
  const surface = previewSurface({ ...slide, elements: [element], timeline: [] }, deck.canvas);
  surface.style.width = `${crop.w}px`;
  surface.style.height = `${crop.h}px`;
  surface.style.transform = `scale(${THUMB_W / crop.w})`;
  const root = surface.firstElementChild as HTMLElement | null;
  if (root) {
    // The slide keeps its canvas size and moves under the crop window, so the
    // element is drawn exactly where and how the slide draws it.
    root.style.inset = 'auto';
    root.style.left = `${-crop.x}px`;
    root.style.top = `${-crop.y}px`;
    root.style.width = `${deck.canvas.w}px`;
    root.style.height = `${deck.canvas.h}px`;
    root.style.overflow = 'visible';
    root.style.background = 'none';
    // The ground fills the whole window, past the canvas edge too.
    const ground = renderSlide({ ...slide, elements: [], timeline: [] }, {
      resolveSrc: (src) => window.api.assetUrl(src),
      mediaPreload: 'metadata',
    });
    surface.insertBefore(ground, root);
  }
  frame.appendChild(surface);
  return frame;
}

/**
 * The slide region a miniature shows: the element's bounds as drawn (rotation
 * included, with room for its stroke), widened to the frame's proportions
 * around their centre, and never magnified past the slide's own size.
 */
export function thumbCrop(el: SlideElement): { x: number; y: number; w: number; h: number } {
  const rad = ((el.rot ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const stroke = el.type === 'shape' ? el.strokeWidth ?? 0 : 0;
  const drawnW = el.w * cos + el.h * sin;
  const drawnH = el.w * sin + el.h * cos;
  const pad = Math.max(drawnW, drawnH) * 0.06 + stroke;
  const w = Math.max(drawnW + pad * 2, (drawnH + pad * 2) * (THUMB_W / THUMB_H), THUMB_W);
  const h = w * (THUMB_H / THUMB_W);
  return { x: el.x + el.w / 2 - w / 2, y: el.y + el.h / 2 - h / 2, w, h };
}

/**
 * Bring `host`'s children to `nodes` with the fewest moves, as the slide rail
 * does: a row that stays where it was never leaves the document, so its
 * miniature keeps its decoded picture.
 */
function patchChildren(host: HTMLElement, nodes: HTMLElement[]): void {
  const wanted = new Set<Element>(nodes);
  for (let k = 0; k < nodes.length; k++) {
    let current: Element | null = host.children[k] ?? null;
    while (current && !wanted.has(current)) {
      const next: Element | null = current.nextElementSibling;
      current.remove();
      current = next;
    }
    if (current !== nodes[k]) host.insertBefore(nodes[k], current);
  }
  while (host.children.length > nodes.length) host.lastElementChild?.remove();
}

function readVisible(): boolean {
  try {
    return window.localStorage.getItem(VISIBLE_KEY) === '1';
  } catch {
    return false;
  }
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
