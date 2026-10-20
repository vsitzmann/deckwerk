import type { SlideElement } from '@shared/deck.js';
import type { Rect } from '@shared/geometry.js';
import { rotatedBounds, type EditorCanvas } from './canvas.js';
import type { EditorStore } from './store.js';

/**
 * Rulers along the top and left of the canvas, as in Keynote's View > Show
 * Rulers. They count in slide units (the deck's 1920 × 1080), with 0 at the
 * slide's top-left corner, and follow the stage through zoom, pan and window
 * resizes. The selection's extent is a band on each ruler and the pointer a
 * moving tick, so a box can be placed by eye against the numbers.
 *
 * Whether they are shown is a per-machine view preference in localStorage,
 * like the comment highlights: it carries across sessions and decks and never
 * touches deck.json. The toggle sits at the start of the canvas's zoom pill,
 * beside the other controls for how the slide is viewed.
 */

/** Thickness of each ruler, in screen pixels. */
export const RULER_SIZE = 20;

const STORAGE_KEY = 'deckwerk.editor.rulers';
/** Labelled ticks closer than this, in screen pixels, would crowd their numbers. */
const MIN_LABEL_GAP = 56;
/** Unlabelled ticks closer than this read as a grey smear. */
const MIN_MINOR_GAP = 6;
const SVG_NS = 'http://www.w3.org/2000/svg';

/* --- the preference --------------------------------------------------------- */

const listeners = new Set<() => void>();
let shown = readShown();
let followingStorage = false;

function readShown(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function rulersShown(): boolean {
  return shown;
}

export function setRulersShown(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  if (next === shown) return;
  shown = next;
  for (const listener of listeners) listener();
}

export function toggleRulers(): void {
  setRulersShown(!shown);
}

function onRulersShownChange(listener: () => void): () => void {
  listeners.add(listener);
  // A choice made in another window of the app (a second editor) lands here.
  if (!followingStorage) {
    followingStorage = true;
    window.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY) return;
      const next = readShown();
      if (next === shown) return;
      shown = next;
      for (const notify of listeners) notify();
    });
  }
  return () => listeners.delete(listener);
}

/** Cmd/Ctrl+R, Keynote's Show/Hide Rulers. Shift and Option are left alone. */
export function isRulersShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r';
}

/* --- tick layout ------------------------------------------------------------ */

export interface RulerSpacing {
  /** Slide units between labelled ticks: 1, 2 or 5 times a power of ten. */
  major: number;
  /** Slide units between all ticks; equal to `major` when no finer ones fit. */
  minor: number;
}

/**
 * The tick spacing for `scale` screen pixels per slide unit: the finest
 * 1-2-5 step whose labels stay `MIN_LABEL_GAP` apart, split into the finest
 * subdivision that stays readable.
 */
export function rulerSpacing(scale: number): RulerSpacing {
  if (!(scale > 0)) return { major: 1000, minor: 1000 };
  for (let power = 1; ; power *= 10) {
    for (const [mantissa, divisions] of [[1, [10, 5, 2]], [2, [10, 4, 2]], [5, [10, 5]]] as const) {
      const major = mantissa * power;
      if (major * scale < MIN_LABEL_GAP) continue;
      const fits = divisions.find((count) => (major / count) * scale >= MIN_MINOR_GAP);
      return { major, minor: fits ? major / fits : major };
    }
  }
}

export interface RulerTick {
  /** Screen position along the ruler, in pixels from its start. */
  at: number;
  /** Slide coordinate the tick stands for. */
  value: number;
  /** Major ticks carry a label; mid marks the half-way point between them. */
  kind: 'major' | 'mid' | 'minor';
}

/**
 * The ticks a ruler `length` pixels long shows, when slide coordinate 0 sits
 * at `origin` pixels along it and one slide unit is `scale` pixels.
 */
export function rulerTicks(origin: number, scale: number, length: number): RulerTick[] {
  if (!(scale > 0) || !(length > 0)) return [];
  const { major, minor } = rulerSpacing(scale);
  const divisions = Math.round(major / minor);
  const first = Math.floor(-origin / scale / minor);
  const last = Math.ceil((length - origin) / scale / minor);
  const ticks: RulerTick[] = [];
  for (let i = first; i <= last; i++) {
    // Whole multiples of the minor step, so no rounding drift along the ruler.
    const value = Math.round(i * minor * 1000) / 1000;
    const at = origin + value * scale;
    if (at < 0 || at > length) continue;
    const step = ((i % divisions) + divisions) % divisions;
    const kind = step === 0 ? 'major' : divisions % 2 === 0 && step === divisions / 2 ? 'mid' : 'minor';
    ticks.push({ at, value, kind });
  }
  return ticks;
}

/** The axis-aligned extent of `elements` as drawn, rotation included; null for none. */
export function selectionExtent(elements: SlideElement[]): Rect | null {
  if (elements.length === 0) return null;
  const boxes = elements.map((element) => rotatedBounds(element));
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const bottom = Math.max(...boxes.map((box) => box.y + box.h));
  return { x, y, w: right - x, h: bottom - y };
}

/* --- the rulers ------------------------------------------------------------- */

/** One ruler: its SVG, and the parts that move without the ticks being redrawn. */
interface Ruler {
  root: SVGSVGElement;
  slide: SVGRectElement;
  ticks: SVGPathElement;
  labels: SVGGElement;
  selection: SVGRectElement;
  pointer: SVGLineElement;
}

export interface CanvasRulersOptions {
  /** Shown in the toggle's tooltip; omitted where the shell binds no key. */
  shortcutHint?: string;
}

export class CanvasRulers {
  readonly toggleButton: HTMLButtonElement;
  private readonly top: Ruler;
  private readonly left: Ruler;
  private readonly corner: HTMLElement;
  /** What the ticks were last drawn for, so a selection change alone skips them. */
  private drawnKey = '';
  private pointer: { x: number; y: number } | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly canvas: EditorCanvas,
    private readonly store: EditorStore,
    private readonly options: CanvasRulersOptions = {},
  ) {
    this.top = createRuler('top');
    this.left = createRuler('left');
    this.corner = document.createElement('div');
    this.corner.className = 'canvas-ruler canvas-ruler-corner deck-only';
    this.corner.setAttribute('aria-hidden', 'true');
    host.append(this.top.root, this.left.root, this.corner);

    this.toggleButton = document.createElement('button');
    this.toggleButton.type = 'button';
    this.toggleButton.className = 'zoom-button rulers-toggle';
    this.toggleButton.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">'
      + '<rect x="1.5" y="5" width="13" height="6" rx="1"/><path d="M4 5v2.5M6.5 5v1.5M9 5v2.5M11.5 5v1.5"/></svg>';
    // Keep the pointer-down from taking focus: a focus change would end a
    // live text edit, and looking at the rulers is not a reason to stop typing.
    this.toggleButton.addEventListener('pointerdown', (event) => event.preventDefault());
    this.toggleButton.addEventListener('click', () => toggleRulers());
    canvas.addViewControl(this.toggleButton);

    canvas.addViewportListener(() => this.draw());
    store.subscribe(() => this.drawSelection());
    onRulersShownChange(() => this.sync());
    host.addEventListener('pointermove', (event) => this.trackPointer(event));
    host.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.drawPointer();
    });
    this.sync();
  }

  /** Show or hide the rulers to match the preference. */
  private sync(): void {
    const visible = rulersShown();
    for (const node of [this.top.root, this.left.root, this.corner]) {
      node.toggleAttribute('hidden', !visible);
    }
    this.host.classList.toggle('rulers-shown', visible);
    const action = visible ? 'Hide rulers' : 'Show rulers';
    this.toggleButton.title = this.options.shortcutHint ? `${action} (${this.options.shortcutHint})` : action;
    this.toggleButton.setAttribute('aria-label', action);
    this.toggleButton.setAttribute('aria-pressed', String(visible));
    this.toggleButton.classList.toggle('active', visible);
    this.drawnKey = '';
    // The inset rescales the canvas, which draws the rulers.
    this.canvas.setRulerInset(visible ? RULER_SIZE : 0);
    this.draw();
  }

  private draw(): void {
    if (!rulersShown()) return;
    const { left, top, scale } = this.canvas.stagePlacement();
    const width = Math.max(0, this.host.clientWidth - RULER_SIZE);
    const height = Math.max(0, this.host.clientHeight - RULER_SIZE);
    const { w, h } = this.store.get().deck.canvas;
    // Positions along each ruler, which starts after the corner square.
    const originX = left - RULER_SIZE;
    const originY = top - RULER_SIZE;
    const key = [originX, originY, scale, width, height, w, h].join(' ');
    if (key !== this.drawnKey) {
      this.drawnKey = key;
      drawTicks(this.top, 'top', originX, scale, width, w);
      drawTicks(this.left, 'left', originY, scale, height, h);
    }
    this.drawSelection();
    this.drawPointer();
  }

  private drawSelection(): void {
    if (!rulersShown()) return;
    const { left, top, scale } = this.canvas.stagePlacement();
    const extent = this.store.slide ? selectionExtent(this.store.selectedElements()) : null;
    placeBand(this.top, 'top', extent && { start: left - RULER_SIZE + extent.x * scale, size: extent.w * scale });
    placeBand(this.left, 'left', extent && { start: top - RULER_SIZE + extent.y * scale, size: extent.h * scale });
  }

  private trackPointer(event: PointerEvent): void {
    if (!rulersShown()) return;
    const rect = this.host.getBoundingClientRect();
    this.pointer = { x: event.clientX - rect.left - RULER_SIZE, y: event.clientY - rect.top - RULER_SIZE };
    this.drawPointer();
  }

  private drawPointer(): void {
    placeMarker(this.top, 'top', this.pointer?.x ?? null);
    placeMarker(this.left, 'left', this.pointer?.y ?? null);
  }
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, className: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  node.setAttribute('class', className);
  return node;
}

function createRuler(side: 'top' | 'left'): Ruler {
  const root = svg('svg', `canvas-ruler canvas-ruler-${side} deck-only`);
  root.setAttribute('aria-hidden', 'true');
  root.dataset.ruler = side;
  const ruler: Ruler = {
    root,
    slide: svg('rect', 'canvas-ruler-slide'),
    selection: svg('rect', 'canvas-ruler-selection'),
    ticks: svg('path', 'canvas-ruler-ticks'),
    labels: svg('g', 'canvas-ruler-labels'),
    pointer: svg('line', 'canvas-ruler-pointer'),
  };
  root.append(ruler.slide, ruler.selection, ruler.ticks, ruler.labels, ruler.pointer);
  return ruler;
}

/**
 * Lay out one ruler for a slide `extent` units long. Along the top, `at` runs
 * left to right and ticks hang from the bottom edge; along the left, `at` runs
 * top to bottom and ticks reach in from the right edge, labels turned to read
 * bottom-up as in Keynote.
 */
function drawTicks(
  ruler: Ruler,
  side: 'top' | 'left',
  origin: number,
  scale: number,
  length: number,
  extent: number,
): void {
  const across = RULER_SIZE;
  ruler.root.setAttribute('width', String(side === 'top' ? length : across));
  ruler.root.setAttribute('height', String(side === 'top' ? across : length));
  setSpan(ruler.slide, side, origin, extent * scale);

  const reach = { major: across, mid: 8, minor: 4 } as const;
  let path = '';
  const labels: SVGTextElement[] = [];
  for (const tick of rulerTicks(origin, scale, length)) {
    // Half-pixel positions keep one-pixel strokes sharp.
    const at = Math.round(tick.at) + 0.5;
    const from = across - reach[tick.kind];
    path += side === 'top' ? `M${at} ${from}V${across}` : `M${from} ${at}H${across}`;
    if (tick.kind !== 'major') continue;
    const label = svg('text', 'canvas-ruler-label');
    label.textContent = String(tick.value);
    if (side === 'top') {
      label.setAttribute('x', String(at + 3));
      label.setAttribute('y', '9');
    } else {
      // Turned a quarter anticlockwise about its start, the text runs up
      // from just above the tick with its glyphs to the left of x = 9.
      label.setAttribute('x', '9');
      label.setAttribute('y', String(at - 3));
      label.setAttribute('transform', `rotate(-90 9 ${at - 3})`);
    }
    labels.push(label);
  }
  ruler.ticks.setAttribute('d', path);
  ruler.labels.replaceChildren(...labels);
}

function placeBand(ruler: Ruler, side: 'top' | 'left', span: { start: number; size: number } | null): void {
  ruler.selection.toggleAttribute('hidden', !span);
  if (span) setSpan(ruler.selection, side, span.start, Math.max(1, span.size));
}

function placeMarker(ruler: Ruler, side: 'top' | 'left', at: number | null): void {
  ruler.pointer.toggleAttribute('hidden', at === null);
  if (at === null) return;
  const position = String(Math.round(at) + 0.5);
  const [x1, y1, x2, y2] = side === 'top'
    ? [position, '0', position, String(RULER_SIZE)]
    : ['0', position, String(RULER_SIZE), position];
  ruler.pointer.setAttribute('x1', x1);
  ruler.pointer.setAttribute('y1', y1);
  ruler.pointer.setAttribute('x2', x2);
  ruler.pointer.setAttribute('y2', y2);
}

/** A rect covering `start`..`start + size` along the ruler, full thickness across it. */
function setSpan(rect: SVGRectElement, side: 'top' | 'left', start: number, size: number): void {
  const along = { start: String(start), size: String(Math.max(0, size)) };
  rect.setAttribute(side === 'top' ? 'x' : 'y', along.start);
  rect.setAttribute(side === 'top' ? 'width' : 'height', along.size);
  rect.setAttribute(side === 'top' ? 'y' : 'x', '0');
  rect.setAttribute(side === 'top' ? 'height' : 'width', String(RULER_SIZE));
}
