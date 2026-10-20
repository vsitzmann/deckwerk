import type { SlideElement } from '@shared/deck.js';
import { matchGlyphs, type GlyphBox } from '@shared/glyphMatch.js';
import { isolatedClone, nodePath, px, safeRatio, slideScale } from './glyphClone.js';

/**
 * Morph between two equations, glyph by glyph.
 *
 * Without this, a Morph pair whose maths changed (`f(x) = 0` → `f(x) = y`)
 * moves as one object and swaps its content at the midpoint, which reads as a
 * blur. Here the rendered KaTeX glyphs of both sides are matched (by symbol
 * and reading order, `shared/glyphMatch.ts`) and each matched glyph travels
 * from its old box to its new one; glyphs only one side has fade out or in.
 *
 * Every moving glyph is a copy of the whole target object showing only that
 * glyph (`glyphClone.ts`), animated with a transform from where the source
 * painted it to `none`. The last frame is therefore the target's own layout,
 * the copies are removed as the real object — hidden only by a fill-none
 * opacity animation — reappears underneath, and nothing snaps. The glyphs
 * are live type at every frame, so a glyph that grows stays crisp.
 */

/** A glyph of a rendered text object: something with a box that reads as one symbol. */
export interface Glyph {
  key: string;
  node: Node;
  path: number[];
  /** Box in canvas pixels, relative to the slide. */
  box: GlyphBox;
  /** Text glyphs scale uniformly (by their font size); strokes stretch to fit. */
  stroke: boolean;
  color: string;
}

/** Strokes KaTeX draws as empty boxes with a border rather than as type. */
const STROKES = ['frac-line', 'overline-line', 'underline-line', 'hline', 'rule'];

export interface EquationMorphInput {
  from: SlideElement;
  to: SlideElement;
  /** The target object, rendered and on the stage. */
  node: HTMLElement;
  /** A copy of the source object as it was painted on the slide before. */
  source: HTMLElement | undefined;
  duration: number;
  easing: string;
  /** The target's paint rank while the transition runs, if stacking is in use. */
  zIndex?: number;
}

/** Whether markup holds `$…$` maths: two unescaped dollars. */
function hasMath(html: string): boolean {
  return (html.replace(/\\\$/g, '').match(/\$/g) ?? []).length >= 2;
}

function words(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Animate the pair glyph by glyph. Returns false — leaving the pair to the
 * ordinary object motion — when it is not two different equations, when an
 * object is rotated (glyph boxes would be rotated boxes), or when no glyph
 * is shared at all.
 */
export function morphEquationGlyphs(input: EquationMorphInput): boolean {
  const { from, to, node, source, duration, easing } = input;
  if (from.type !== 'text' || to.type !== 'text' || !source || duration <= 0) return false;
  if (!hasMath(from.html) || !hasMath(to.html) || words(from.html) === words(to.html)) return false;
  if (from.rot || to.rot || from.style.transform || to.style.transform) return false;
  const slide = node.parentElement;
  const scale = slideScale(node);
  if (!slide || !(scale > 0) || typeof node.animate !== 'function') return false;
  if (!node.querySelector('.katex-html') || !source.querySelector('.katex-html')) return false;

  // The source copy is laid out where it was, invisibly, just to be measured.
  // Transparent rather than hidden: a term a build had not revealed yet is
  // `visibility: hidden` inside it, and must stay told apart.
  const probe = source.cloneNode(true) as HTMLElement;
  probe.removeAttribute('data-element-id');
  probe.style.opacity = '0';
  probe.style.pointerEvents = 'none';
  slide.appendChild(probe);
  let before: Glyph[];
  let after: Glyph[];
  let targetBox: GlyphBox;
  let sourceBox: GlyphBox;
  try {
    const origin = slide.getBoundingClientRect();
    before = glyphsOf(probe, origin, scale);
    after = glyphsOf(node, origin, scale);
    targetBox = boxOf(node, origin, scale);
    sourceBox = boxOf(probe, origin, scale);
  } finally {
    probe.remove();
  }
  const pairs = matchGlyphs(before.map((glyph) => glyph.box), after.map((glyph) => glyph.box));
  if (pairs.length === 0) return false;

  const clones: HTMLElement[] = [];
  const place = (clone: HTMLElement): HTMLElement => {
    if (input.zIndex !== undefined) clone.style.zIndex = String(input.zIndex);
    // Beside the target, so paint order on the slide is what it will be.
    (clones[clones.length - 1] ?? node).after(clone);
    clones.push(clone);
    return clone;
  };
  const timing: KeyframeAnimationOptions = { duration, easing: 'linear', fill: 'forwards' };
  const settle = (animation: Animation, clone: HTMLElement): void => {
    const remove = (): void => clone.remove();
    void animation.finished.then(remove, remove);
  };

  // The real equation steps aside for the duration and is what remains.
  const content = node.querySelector<HTMLElement>('.text-content') ?? node;
  content.animate([{ opacity: 0 }, { opacity: 0 }], { duration, fill: 'none' });

  const still: number[][] = [];
  for (const [s, t] of pairs) {
    const a = before[s];
    const b = after[t];
    const sx = b.stroke ? safeRatio(a.box.w, b.box.w) : safeRatio(a.box.h, b.box.h);
    const sy = safeRatio(a.box.h, b.box.h);
    const dx = a.box.x + a.box.w / 2 - (b.box.x + b.box.w / 2);
    const dy = a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2);
    const recoloured = a.color !== b.color;
    if (Math.hypot(dx, dy) < 0.25 && Math.abs(sx - 1) < 0.002 && Math.abs(sy - 1) < 0.002 && !recoloured) {
      still.push(b.path);
      continue;
    }
    // Scaled about the glyph's own centre, in the object's frame.
    const origin = `${px(b.box.x + b.box.w / 2 - targetBox.x)}px ${px(b.box.y + b.box.h / 2 - targetBox.y)}px`;
    const moved = `translate(${px(dx)}px, ${px(dy)}px) scale(${px(sx)}, ${px(sy)})`;
    const settled = 'translate(0px, 0px) scale(1, 1)';
    const glyph = place(isolatedClone(node, [b.path]));
    settle(glyph.animate([
      { transform: moved, transformOrigin: origin, opacity: recoloured ? 0 : 1, offset: 0, easing },
      { transform: settled, transformOrigin: origin, opacity: 1, offset: 1 },
    ], timing), glyph);
    if (!recoloured) continue;
    // A glyph that changed colour: its old paint rides the same path and
    // fades, so the colour blends rather than switching.
    const sourceOrigin = `${px(a.box.x + a.box.w / 2 - sourceBox.x)}px ${px(a.box.y + a.box.h / 2 - sourceBox.y)}px`;
    const old = place(isolatedClone(source, [a.path]));
    settle(old.animate([
      { transform: settled, transformOrigin: sourceOrigin, opacity: 1, offset: 0, easing },
      {
        transform: `translate(${px(-dx)}px, ${px(-dy)}px) scale(${px(1 / sx)}, ${px(1 / sy)})`,
        transformOrigin: sourceOrigin, opacity: 0, offset: 1,
      },
    ], timing), old);
  }
  if (still.length > 0) {
    const kept = place(isolatedClone(node, still));
    settle(kept.animate([{ opacity: 1 }, { opacity: 1 }], timing), kept);
  }

  // What only the target has arrives over the second half, once the shared
  // glyphs have mostly made room for it; what only the source had clears in
  // the first four tenths.
  const matchedTargets = new Set(pairs.map(([, t]) => t));
  const added = after.filter((_, index) => !matchedTargets.has(index)).map((glyph) => glyph.path);
  if (added.length > 0) {
    const arriving = place(isolatedClone(node, added));
    settle(arriving.animate([
      { opacity: 0, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 1 },
    ], timing), arriving);
  }
  const matchedSources = new Set(pairs.map(([s]) => s));
  const removed = before.filter((_, index) => !matchedSources.has(index)).map((glyph) => glyph.path);
  if (removed.length > 0) {
    const leaving = place(isolatedClone(source, removed));
    settle(leaving.animate([
      { opacity: 1, offset: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 0, offset: 1 },
    ], timing), leaving);
  }
  return true;
}

function boxOf(element: Element, origin: DOMRect, scale: number): GlyphBox {
  const rect = element.getBoundingClientRect();
  return {
    key: '',
    x: (rect.left - origin.left) / scale,
    y: (rect.top - origin.top) / scale,
    w: rect.width / scale,
    h: rect.height / scale,
  };
}

/**
 * The glyphs of a rendered text object, in reading (document) order: each
 * KaTeX leaf that holds text, each stroke KaTeX draws as a box or an SVG, and
 * each run of ordinary text around the maths. Hidden ones (an unrevealed
 * term) are not on screen and take no part.
 */
export function glyphsOf(root: HTMLElement, origin: DOMRect, scale: number): Glyph[] {
  const content = root.querySelector<HTMLElement>('.text-content') ?? root;
  const glyphs: Glyph[] = [];
  const add = (node: Node, key: string, stroke: boolean): void => {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden') return;
    const rect = node instanceof Element ? node.getBoundingClientRect() : textRect(node);
    if (!(rect.width > 0) && !(rect.height > 0)) return;
    glyphs.push({
      key,
      node,
      path: nodePath(root, node),
      box: {
        key,
        x: (rect.left - origin.left) / scale,
        y: (rect.top - origin.top) / scale,
        w: rect.width / scale,
        h: rect.height / scale,
      },
      stroke,
      color: style.color,
    });
  };
  const visit = (node: Node, inMath: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      // A KaTeX leaf is taken whole below; text here is the prose around it.
      if (!inMath) add(node, `text:${text}`, false);
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.classList.contains('katex-mathml')) return;
    if (node.tagName.toLowerCase() === 'svg') {
      if (inMath) add(node, `svg:${node.closest('.sqrt') ? 'sqrt' : 'stretchy'}`, true);
      return;
    }
    const math = inMath || node.classList.contains('katex-html');
    if (math) {
      const stroke = STROKES.find((name) => node.classList.contains(name));
      if (stroke) {
        add(node, `stroke:${stroke}`, true);
        return;
      }
      const leaf = node.childNodes.length > 0
        && [...node.childNodes].every((child) => child.nodeType === Node.TEXT_NODE);
      if (leaf) {
        const text = (node.textContent ?? '').trim();
        if (text) add(node, text, false);
        return;
      }
    }
    for (const child of node.childNodes) visit(child, math);
  };
  visit(content, false);
  return glyphs;
}

function textRect(node: Node): DOMRect {
  const range = node.ownerDocument!.createRange();
  range.selectNodeContents(node);
  const rect = range.getBoundingClientRect();
  range.detach?.();
  return rect;
}
