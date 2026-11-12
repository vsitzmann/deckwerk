/**
 * Text that runs past the slide edge, kept legible on the pasteboard.
 *
 * The editor deliberately paints off-slide content (editor.css: the slide
 * layer does not clip), so an object dragged past the edge can still be found.
 * Text there sits on the editor's own ground instead of the slide's, and the
 * colours that read on a white slide are the ones that vanish on the dark
 * pasteboard (black body text on near-black), as do white titles on the light
 * one.
 *
 * Only the part outside the slide changes. A layer above the slide holds a
 * copy of each element whose text crosses the edge, clipped to everything
 * *outside* the slide rectangle; in the copy, the text whose colour lacks
 * contrast against the ground takes the editor's text colour, and everything
 * else (fills, borders, pictures, legible text) is hidden, so the copy paints
 * only over the glyphs it recolours. What is on the slide is never touched,
 * so the slide still shows exactly what will be presented.
 *
 * The copy carries no element ids, takes no pointer events and is outside the
 * slide layer, so hit-testing, editing and the render invariants never see it.
 * An element holding media or a frame is never copied: cloning a `<video>`
 * opens a new media pipeline (see agentBridge.ts, `mountSlide`).
 */

/** WCAG's minimum for large text and graphics; slide text is large text. */
export const MIN_OFF_SLIDE_CONTRAST = 3;

type Rgba = [number, number, number, number];

/** WCAG relative luminance of an sRGB colour (channels 0..255). */
export function relativeLuminance([r, g, b]: Rgba | [number, number, number]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrastRatio(a: Rgba | [number, number, number], b: Rgba | [number, number, number]): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A translucent colour as it shows over an opaque ground. */
export function composite([r, g, b, a]: Rgba, ground: Rgba): Rgba {
  return [
    r * a + ground[0] * (1 - a),
    g * a + ground[1] * (1 - a),
    b * a + ground[2] * (1 - a),
    1,
  ];
}

/** Whether text in `colour` reads on `ground`. Fully transparent text (gradient fills) is left alone. */
export function legibleOn(colour: Rgba, ground: Rgba): boolean {
  if (colour[3] === 0) return true;
  return contrastRatio(composite(colour, ground), ground) >= MIN_OFF_SLIDE_CONTRAST;
}

let probe: CanvasRenderingContext2D | null | undefined;
const resolved = new Map<string, Rgba | null>();

/**
 * Any CSS colour as sRGB, by letting the browser paint it: computed styles
 * keep `oklch(…)` and `color-mix(…)` as written, and the chrome uses both.
 */
function toRgba(css: string): Rgba | null {
  const cached = resolved.get(css);
  if (cached !== undefined) return cached;
  if (probe === undefined) {
    const surface = document.createElement('canvas');
    surface.width = 1;
    surface.height = 1;
    probe = surface.getContext('2d', { willReadFrequently: true });
  }
  let value: Rgba | null = null;
  if (probe) {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = 'rgb(0 0 0 / 0)';
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    value = [r, g, b, a / 255];
  }
  if (resolved.size > 256) resolved.clear();
  resolved.set(css, value);
  return value;
}

/** Elements whose copy would start loading something, or could not be copied faithfully. */
const NEVER_COPIED = 'video, audio, iframe, canvas, object, embed';

export class OffSlideText {
  /** The layer the canvas puts between the slide and its selection overlay. */
  readonly layer: HTMLElement;
  private frame = 0;
  private clipFor = '';

  constructor(
    private readonly slideLayer: HTMLElement,
    /** The element painting the pasteboard ground, whose `--text` is the replacement colour. */
    private readonly ground: HTMLElement,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'offslide-text-layer';
    this.layer.setAttribute('aria-hidden', 'true');
    this.layer.inert = true;

    const schedule = () => this.schedule();
    // Everything that moves, resizes, retypes or restyles an element mutates
    // the slide layer: a rebuild, a patch, every frame of a drag, a keystroke.
    new MutationObserver(schedule).observe(slideLayer, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    // The UI theme turns the ground over; a deck theme reload restyles text.
    new MutationObserver(schedule).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-ui-theme', 'class', 'style'],
    });
    new MutationObserver(schedule).observe(document.head, {
      subtree: true, childList: true, characterData: true,
    });
    document.fonts?.addEventListener?.('loadingdone', schedule);
  }

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.refresh();
    });
  }

  /** Rebuild the layer from the slide as it is painted now. */
  refresh(): void {
    const root = this.slideLayer.querySelector<HTMLElement>(':scope > .slide');
    const groundStyle = getComputedStyle(this.ground);
    const ground = toRgba(groundStyle.backgroundColor);
    if (!root || !ground || ground[3] === 0) {
      this.layer.replaceChildren();
      return;
    }
    const ink = this.inkFor(ground, groundStyle.getPropertyValue('--text').trim());
    const slideRect = root.getBoundingClientRect();

    const copies: HTMLElement[] = [];
    for (const element of root.children) {
      if (!(element instanceof HTMLElement) || !element.classList.contains('element')) continue;
      if (element.querySelector(NEVER_COPIED)) continue;
      if (!crossesEdge(element, slideRect)) continue;
      const copy = this.copyOf(element, ground, ink);
      if (copy) copies.push(copy);
    }
    if (copies.length === 0) {
      this.layer.replaceChildren();
      return;
    }

    this.clipOutside(root.offsetWidth, root.offsetHeight);
    // The slide root's own classes and inline style carry the theme's
    // inherited type (`.slide { font-family; color }`) and layout selectors
    // (`.slide.layout-title > .role-body`); editor.css removes its ground.
    const shell = root.cloneNode(false) as HTMLElement;
    for (const name of ['data-slide-id', 'id']) shell.removeAttribute(name);
    shell.append(...copies);
    this.layer.replaceChildren(shell);
  }

  /** The chrome's text colour, or black/white when a custom ground defeats it. */
  private inkFor(ground: Rgba, chromeText: string): string {
    const text = chromeText ? toRgba(chromeText) : null;
    if (text && text[3] === 1 && contrastRatio(text, ground) >= 4.5) return chromeText;
    return relativeLuminance(ground) > 0.18 ? '#000' : '#fff';
  }

  /** Paint everything outside the slide rectangle, and nothing inside it. */
  private clipOutside(w: number, h: number): void {
    const key = `${w}x${h}`;
    if (key === this.clipFor) return;
    this.clipFor = key;
    const far = 1_000_000;
    this.layer.style.clipPath = `path(evenodd, "M${-far} ${-far}H${far}V${far}H${-far}Z M0 0H${w}V${h}H0Z")`;
  }

  /**
   * A copy of `element` showing only the text that would not read on the
   * ground, recoloured; null when all of its text already reads.
   */
  private copyOf(element: HTMLElement, ground: Rgba, ink: string): HTMLElement | null {
    const nodes = [element, ...element.querySelectorAll<Element>('*')];
    const index = new Map(nodes.map((node, i) => [node, i]));
    const illegible = new Set<number>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const parent = text.parentElement;
      if (!parent || !text.textContent?.trim()) continue;
      const i = index.get(parent);
      if (i === undefined || illegible.has(i)) continue;
      const style = getComputedStyle(parent);
      const fill = toRgba(style.getPropertyValue('-webkit-text-fill-color') || style.color);
      if (fill && !legibleOn(fill, ground)) illegible.add(i);
    }
    if (illegible.size === 0) return null;

    const copy = element.cloneNode(true) as HTMLElement;
    const copies = [copy, ...copy.querySelectorAll<Element>('*')];
    for (const node of copies) {
      node.removeAttribute('data-element-id');
      node.removeAttribute('contenteditable');
      node.removeAttribute('id');
    }
    copy.classList.remove('editing');
    // Hidden by default; only the recoloured text shows. Visibility is the
    // one property a descendant can turn back on under a hidden ancestor.
    copy.style.setProperty('visibility', 'hidden', 'important');
    for (const i of illegible) {
      const node = copies[i] as HTMLElement | SVGElement;
      node.style.setProperty('color', ink, 'important');
      node.style.setProperty('-webkit-text-fill-color', ink, 'important');
      // Typeset maths draws fraction bars and radicals from borders and SVG
      // beside the glyphs, not inside them: show the whole formula.
      const shown = (node.closest('.katex') as HTMLElement | null) ?? node;
      shown.style.setProperty('visibility', 'visible', 'important');
      if (shown !== node) shown.style.setProperty('color', ink, 'important');
    }
    return copy;
  }
}

/** Whether anything `element` paints, its text included, reaches past the slide. */
function crossesEdge(element: HTMLElement, slide: DOMRect): boolean {
  const box = element.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(element);
  const text = range.getBoundingClientRect();
  const outside = (r: DOMRect) => r.width > 0 && r.height > 0 && (
    r.left < slide.left - 0.5 || r.top < slide.top - 0.5
    || r.right > slide.right + 0.5 || r.bottom > slide.bottom + 0.5
  );
  return outside(box) || outside(text);
}
