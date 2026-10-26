import {
  constrainAngle,
  serializePath,
  setSymmetricHandles,
  type PathNode,
  type SubPath,
  type XY,
} from '@shared/pathNodes.js';

/**
 * The pen, as Keynote's "Draw with Pen" and the Bézier pen in Figma or
 * Illustrator have it: click for a corner, click and drag for a smooth point
 * whose two handles mirror each other, click the first point to close the
 * shape, Return, Escape or a double-click to leave the line open.
 *
 * This is the drawing in progress, in canvas coordinates; it touches the deck
 * only when it is finished, as one new path shape (`insertPath`). The canvas
 * feeds it pointer events and draws `penOverlay` over the slide.
 */
export class PenDraft {
  readonly nodes: PathNode[] = [];
  /** Where the next segment would end, for the preview. */
  cursor: XY | null = null;
  /**
   * The press in progress: on a new point (a drag pulls out both its handles),
   * on the last point (a drag pulls out a new handle on that side alone), or
   * on the first point, which closes the shape.
   */
  private press: { index: number; mode: 'new' | 'last' | 'close'; origin: XY; pulled: boolean } | null = null;

  constructor(readonly slideId: string) {}

  /** Whether `point` is on the first point, where a click closes the shape. */
  closesAt(point: XY, tolerance: number): boolean {
    return this.nodes.length >= 2 && distance(point, this.nodes[0]) <= tolerance;
  }

  /** Whether `point` is on the most recent point. */
  onLast(point: XY, tolerance: number): boolean {
    const last = this.nodes.at(-1);
    return Boolean(last) && distance(point, last!) <= tolerance;
  }

  /** Whether a press is pulling out handles right now. */
  isPulling(): boolean {
    return Boolean(this.press?.pulled);
  }

  down(point: XY, shift: boolean, tolerance: number): void {
    if (this.closesAt(point, tolerance)) {
      this.press = { index: 0, mode: 'close', origin: { ...this.nodes[0] }, pulled: false };
      return;
    }
    if (this.onLast(point, tolerance)) {
      const index = this.nodes.length - 1;
      this.press = { index, mode: 'last', origin: { ...this.nodes[index] }, pulled: false };
      return;
    }
    const last = this.nodes.at(-1);
    const at = shift && last ? constrainAngle(last, point) : point;
    this.nodes.push({ x: at.x, y: at.y });
    this.press = { index: this.nodes.length - 1, mode: 'new', origin: at, pulled: false };
    this.cursor = null;
  }

  /** A move with the button down pulls handles; without it, the preview follows. */
  move(point: XY, shift: boolean, threshold: number): void {
    const press = this.press;
    if (!press) {
      const last = this.nodes.at(-1);
      this.cursor = shift && last ? constrainAngle(last, point) : point;
      return;
    }
    if (!press.pulled && distance(point, press.origin) < threshold) return;
    press.pulled = true;
    const node = this.nodes[press.index];
    const handle = shift ? constrainAngle(node, point) : point;
    // Pulling from the last point again turns only the way onward: it becomes
    // a cusp, the curve that arrived at it left as it was.
    if (press.mode === 'last') node.out = { ...handle };
    else setSymmetricHandles(node, handle);
  }

  /**
   * The press ends. A click (no pull) on the last point takes its outgoing
   * handle away, so the next segment leaves it straight. Returns whether the
   * press closed the shape.
   */
  up(): boolean {
    const press = this.press;
    this.press = null;
    if (press?.mode === 'last' && !press.pulled) delete this.nodes[press.index].out;
    return press?.mode === 'close';
  }

  /** Take back the most recent point (Backspace, or Cmd/Ctrl+Z while drawing). */
  removeLast(): void {
    this.press = null;
    this.nodes.pop();
  }

  /** The finished run, or null with too few points to draw anything. */
  result(closed: boolean): SubPath | null {
    if (this.nodes.length < 2) return null;
    const nodes = this.nodes.map((node) => ({ ...node }));
    if (!closed) {
      // The ends of an open line have nothing beyond them to curve toward.
      delete nodes[0].in;
      delete nodes[nodes.length - 1].out;
    }
    return { nodes, closed };
  }
}

/** One anchor drawn on the overlay. `key` is "run:index", what a drag names it by. */
export interface OverlayAnchor { at: XY; key: string; selected?: boolean; closing?: boolean }
/** One handle drawn on the overlay: a knob at `at` on a stalk from its anchor. */
export interface OverlayKnob { at: XY; from: XY; key?: string }

/**
 * The path chrome over the slide: the outline, a preview segment, anchors and
 * handles, all in canvas coordinates and counter-scaled by `--inv` like the
 * rest of the selection chrome. Shared by the pen and by point editing.
 */
export function pathOverlay(options: {
  outline: string;
  preview?: string | null;
  anchors: OverlayAnchor[];
  knobs: OverlayKnob[];
  elementId?: string;
  scale: number;
  canvas: { w: number; h: number };
}): DocumentFragment {
  const frag = document.createDocumentFragment();
  const inv = String(1 / options.scale);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('path-overlay');
  svg.setAttribute('width', String(options.canvas.w));
  svg.setAttribute('height', String(options.canvas.h));
  svg.setAttribute('aria-hidden', 'true');
  svg.style.setProperty('--inv', inv);
  const add = (className: string, d: string): void => {
    if (!d) return;
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('class', className);
    path.setAttribute('d', d);
    svg.appendChild(path);
  };
  add('path-overlay-outline', options.outline);
  add('path-overlay-preview', options.preview ?? '');
  add('path-overlay-stalks', options.knobs.map((knob) =>
    `M ${knob.from.x} ${knob.from.y} L ${knob.at.x} ${knob.at.y}`).join(' '));
  frag.appendChild(svg);

  const dot = (className: string, at: XY): HTMLDivElement => {
    const node = document.createElement('div');
    node.className = className;
    node.style.left = `${at.x}px`;
    node.style.top = `${at.y}px`;
    node.style.setProperty('--inv', inv);
    if (options.elementId) node.dataset.elementId = options.elementId;
    frag.appendChild(node);
    return node;
  };
  for (const knob of options.knobs) {
    const node = dot('path-knob', knob.at);
    if (knob.key) node.dataset.pathHandle = knob.key;
  }
  for (const anchor of options.anchors) {
    const node = dot(
      `path-anchor${anchor.selected ? ' selected' : ''}${anchor.closing ? ' closing' : ''}`,
      anchor.at,
    );
    node.dataset.pathNode = anchor.key;
  }
  return frag;
}

/** The pen's drawing so far, the segment it would add next, and its points. */
export function penOverlay(pen: PenDraft, scale: number, canvas: { w: number; h: number }): DocumentFragment {
  const { nodes, cursor } = pen;
  const last = nodes.at(-1);
  const tolerance = PEN_POINT_SCREEN_PX / scale;
  const closing = cursor !== null && pen.closesAt(cursor, tolerance);
  let preview: string | null = null;
  if (last && cursor && !pen.isPulling()) {
    const out = last.out ?? last;
    const end = closing ? nodes[0] : cursor;
    const into = closing ? nodes[0].in ?? nodes[0] : cursor;
    preview = `M ${last.x} ${last.y} C ${out.x} ${out.y} ${into.x} ${into.y} ${end.x} ${end.y}`;
  }
  // The handles of the point being placed, and of the one before it whose
  // outgoing handle shapes the segment still to come.
  const knobs: OverlayKnob[] = [];
  for (const node of nodes.slice(-2)) {
    if (node.in && node !== nodes[0]) knobs.push({ at: node.in, from: node });
    if (node.out) knobs.push({ at: node.out, from: node });
  }
  return pathOverlay({
    outline: nodes.length > 1 ? serializePath([{ nodes, closed: false }]) : '',
    preview,
    anchors: nodes.map((node, index) => ({
      at: node,
      key: `0:${index}`,
      selected: index === nodes.length - 1,
      closing: index === 0 && closing,
    })),
    knobs,
    scale,
    canvas,
  });
}

/** How close, in screen pixels, a click must be to a point to land on it. */
export const PEN_POINT_SCREEN_PX = 8;

/** The two drawing tools under the toolbar's Pen ▾: the Bézier pen and the freehand pencil. */
export type DrawingTool = 'pen' | 'pencil';

/**
 * How far, in screen pixels, a pencil stroke's samples may stray from the
 * smooth line laid through it: enough to take out the hand's tremor, not
 * its intent.
 */
export const PENCIL_TOLERANCE_SCREEN_PX = 1.5;

/**
 * The pencil's stroke while the pointer is down, in the ink and the width a
 * new line gets, so what is drawn looks like what lands.
 */
export function pencilOverlay(points: XY[], ink: string, canvas: { w: number; h: number }): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('path-overlay', 'pencil-overlay');
  svg.setAttribute('width', String(canvas.w));
  svg.setAttribute('height', String(canvas.h));
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('class', 'pencil-overlay-stroke');
  path.setAttribute('d', points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '));
  // Inline, over the chrome's accent outline: this is ink, not chrome.
  path.style.stroke = ink;
  path.style.strokeWidth = '4px';
  svg.appendChild(path);
  return svg;
}

function distance(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
