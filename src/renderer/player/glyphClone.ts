/**
 * Copies of a rendered text object that show only some of its glyphs.
 *
 * Moving part of an equation — one glyph across a Morph, one term in a pulse —
 * cannot be done to the glyph itself: KaTeX's glyphs are inline boxes, which
 * ignore `transform`, and making one an inline-block to move it would nudge
 * the line it sits on, so the equation would snap when the animation ends.
 * Instead a whole copy of the object is laid over it, with every glyph but
 * the chosen ones made invisible. The copy lays out exactly as the original
 * does, because it *is* the original's markup in the original's place, so
 * the chosen glyphs start pixel-for-pixel where they are painted — and the
 * copy, an absolutely positioned block, can be transformed freely. The
 * original's own layout is never touched, which is what keeps the settled
 * render exact.
 */

export interface LocalRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How much the stage is scaled on screen: canvas pixels per CSS pixel of the slide. */
export function slideScale(node: HTMLElement): number {
  const slide = node.closest<HTMLElement>('.slide') ?? node.parentElement;
  if (!slide || !(slide.offsetWidth > 0)) return 0;
  const scale = slide.getBoundingClientRect().width / slide.offsetWidth;
  return Number.isFinite(scale) && scale > 0 ? scale : 0;
}

/** Child-index path from `root` down to `node`, so the same node can be found in a copy. */
export function nodePath(root: Node, node: Node): number[] {
  const path: number[] = [];
  let at: Node | null = node;
  while (at && at !== root) {
    const parent: Node | null = at.parentNode;
    if (!parent) return [];
    path.push(Array.prototype.indexOf.call(parent.childNodes, at) as number);
    at = parent;
  }
  return path.reverse();
}

export function nodeAtPath(root: Node, path: number[]): Node | null {
  let at: Node | null = root;
  for (const index of path) {
    at = at?.childNodes[index] ?? null;
    if (!at) return null;
  }
  return at;
}

/**
 * A copy of `template` in which only the nodes at `paths` paint. A bare text
 * node is given an inline span of its own to carry its visibility; wrapping a
 * whole text node changes nothing about how it lays out.
 */
export function isolatedClone(template: HTMLElement, paths: number[][]): HTMLElement {
  const clone = template.cloneNode(true) as HTMLElement;
  clone.removeAttribute('data-element-id');
  clone.setAttribute('aria-hidden', 'true');
  clone.classList.add('morph-ghost');
  clone.style.pointerEvents = 'none';
  clone.style.visibility = 'hidden';
  const targets = paths.map((path) => nodeAtPath(clone, path));
  for (const node of targets) {
    if (!node) continue;
    if (node.nodeType === Node.TEXT_NODE) {
      const span = clone.ownerDocument.createElement('span');
      node.parentNode?.replaceChild(span, node);
      span.appendChild(node);
      span.style.visibility = 'visible';
    } else if (node instanceof HTMLElement || node instanceof SVGElement) {
      node.style.visibility = 'visible';
    }
  }
  return clone;
}

/**
 * Rectangles of `nodes` in `element`'s own frame (canvas pixels from its
 * border box's top-left), measured with any transform on the element set
 * aside: a rotated object would otherwise report a rotated bounding box.
 */
export function localRects(element: HTMLElement, nodes: Node[], scale: number): LocalRect[] {
  const saved = element.style.transform;
  if (saved) element.style.transform = 'none';
  const box = element.getBoundingClientRect();
  const rects = nodes.map((node) => {
    const rect = rectOf(node);
    return {
      x: (rect.left - box.left) / scale,
      y: (rect.top - box.top) / scale,
      w: rect.width / scale,
      h: rect.height / scale,
    };
  });
  if (saved) element.style.transform = saved;
  return rects;
}

function rectOf(node: Node): DOMRect {
  if (node instanceof Element) return node.getBoundingClientRect();
  const range = node.ownerDocument!.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  range.detach?.();
  return rect;
}

/** A scale factor that never degenerates (a zero-width rule is ordinary content). */
export function safeRatio(source: number, target: number): number {
  if (!(target > 0.01) || !(source > 0.01)) return 1;
  const value = source / target;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Transforms are compared in tests; keep them short and stable. */
export function px(value: number): number {
  return Math.round(value * 1000) / 1000;
}
