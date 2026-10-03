import { MIRRORED_TEXT_STYLE_PROPERTIES } from '@shared/deck.js';
import type { Deck, MediaEffect, Slide, SlideElement } from '@shared/deck.js';
import { fitScale } from '@shared/geometry.js';
import { fitAutoTextElement } from '@shared/autoFit.js';
import { isPendingSrc, pendingName, pendingToken } from '@shared/media.js';
import { gateVideoLoad } from './mediaLoadGate.js';
import { previewPosterProvider } from './previewPosterProvider.js';
import { prepareSlideLinks } from './links.js';
import { quadraticPath, shapeSvg } from '@shared/shapeSvg.js';
import { isMediaBorderPaint, typedPropertyOwnsCss } from '@shared/nativeCss.js';
import { applyTableColumnWidths } from '@shared/paragraphs.js';
import { isEmbeddableWebSrc } from '@shared/webBridge.js';
import renderMathInElement from 'katex/contrib/auto-render';
import 'katex/dist/katex.min.css';

/**
 * deck.json -> DOM.
 *
 * This module is deliberately free of Electron and of editor state: the exact
 * same code renders the editor preview, the fullscreen present window and the
 * exported standalone bundle, so there is no chance of the three drifting apart
 * and a deck looking different on the projector than it did while authoring.
 *
 * `resolveSrc` maps a deck-relative asset path onto whatever URL scheme the
 * host needs (a `file://` URL in Electron, a plain relative path in an export).
 */
export interface RenderOptions {
  resolveSrc: (src: string) => string;
  /**
   * How much of each video to fetch when the slide mounts.
   *
   * 'auto' — the player, where playback is imminent and buffering ahead is the
   * point. 'metadata' — every preview surface (editor canvas, slide rail,
   * Morph panel, PDF pages): fetch the container header, then seek one
   * frame so the element shows a picture. The distinction is not a tuning
   * detail. A deck that reuses one clip across N elements otherwise issues N
   * full downloads of the same file the moment it opens; those transfers
   * monopolise the six connections a browser gives an origin, and everything
   * behind them — other assets, the present view's bundle, its WebSocket —
   * queues for seconds while videos sit black. See docs/media-loading.md.
   */
  mediaPreload?: 'auto' | 'metadata';
  /**
   * Preview surfaces that will freeze their videos into stills
   * (`freezePreviewVideos`) set this so the `<video>` is built *without* a
   * source: the still comes from the poster provider (previewPosterProvider.ts)
   * and no media pipeline is ever opened for it. The element keeps the source
   * in `data-gate-aborted-src`, so a surface without a provider can restore
   * it and capture the frame in the page as before. Only meaningful with
   * `mediaPreload: 'metadata'`.
   */
  deferVideoSrc?: boolean;
}

export { quadraticPath };
export { fitAutoTextElement };

/** Build the `<div class="slide">` for a slide, with elements absolutely placed. */
export function renderSlide(slide: Slide, opts: RenderOptions): HTMLElement {
  const root = document.createElement('div');
  root.dataset.slideId = slide.id;
  applySlideRootStyles(root, slide, opts);

  // Sort by z so paint order is explicit rather than relying on array order;
  // a stable sort keeps array order as the tie-breaker.
  for (const el of [...slide.elements].sort((a, b) => a.z - b.z)) {
    root.appendChild(renderElement(el, opts));
  }
  return root;
}

/**
 * The child of an element wrapper that holds its content, as opposed to the
 * decorations `renderElement` puts around it: the media border overlay and the
 * SVG filter definitions backing a visual effect.
 *
 * Needed because the content node is not always the tag itself. Cropped media
 * is a positioning wrapper containing the `<img>`/`<video>`, and properties that
 * belong on the body -- a corner radius, a circular mask -- belong on that
 * wrapper. Reaching for the first `img, video` *descendant* instead put the
 * radius on the inner tag, where the crop wrapper's own box then clipped it
 * square: a rounded or circular crop stayed rectangular after any in-place
 * edit, and matched only after a rebuild.
 */
export function elementBody(node: HTMLElement): HTMLElement | SVGElement | null {
  for (const child of node.children) {
    if (child.classList.contains('media-border-overlay')) continue;
    // Effect definitions are inert <svg><filter> holders, never the content.
    if (child.tagName.toLowerCase() === 'svg' && child.querySelector('filter')) continue;
    return child as HTMLElement | SVGElement;
  }
  return null;
}

/**
 * Write a video element's playback flags onto a `<video>` node.
 *
 * Shared with the editor's patch path, which keeps the existing `<video>` for a
 * non-structural change -- rebuilding it would reload the clip and lose the
 * playhead. Before this was shared, the patch path mirrored `controls` alone, so
 * toggling Mute or Loop in the inspector updated the deck while the video on the
 * canvas kept playing under its old flags until the slide was rebuilt.
 */
export function applyVideoPlaybackState(
  video: HTMLVideoElement,
  el: Extract<SlideElement, { type: 'video' }>,
  opts: RenderOptions,
): void {
  // Chromium refuses unmuted autoplay without a user gesture, so an unmuted
  // autoplaying video would silently never start. Muting is the only way the
  // default actually plays; sound is opt-in per element.
  video.muted = el.muted;
  video.controls = el.controls;
  // Native looping always restarts at zero, which would ignore the trim. The
  // player's runtime loops start -> end instead, so the flag stays off whenever
  // an in- or out-point is set.
  video.loop = el.loop && el.start <= 0 && el.end === null;
  if (el.poster) video.poster = opts.resolveSrc(el.poster);
  else video.removeAttribute('poster');
}

/**
 * Write the fit and crop geometry of a media element onto the inner `<img>` or
 * `<video>` tag.
 *
 * Shared for the same reason as the playback flags: these live on the media tag
 * rather than the wrapper, so the editor's in-place patch has to reach through
 * to them, and `object-position` in particular was applied only when the node
 * was first built -- nudging a cover-cropped image's focal point did nothing
 * until the slide was rebuilt.
 */
export function applyMediaFitStyles(
  node: HTMLElement,
  el: Extract<SlideElement, { type: 'image' | 'video' }>,
): void {
  const body = elementBody(node);
  if (!body) return;
  const tag = /^(img|video|embed)$/.test(body.tagName.toLowerCase())
    ? (body as HTMLElement)
    : body.querySelector<HTMLElement>('img, video, embed');
  if (!tag) return;

  // A patched element keeps its DOM node, so its pooling identity has to be
  // rewritten in place: leaving a stale key here would let the video be
  // reused later for the crop, fit or in-point it no longer has — the very
  // mismatch `videoPresentationKey` exists to prevent. This runs on every
  // media patch (the editor's in-place path calls it unconditionally), so it
  // covers a changed box and in-point as well as a changed fit or crop.
  if (el.type === 'video' && tag.tagName.toLowerCase() === 'video') {
    tag.dataset.mediaKey = videoPresentationKey(el, tag.getAttribute('src') ?? '');
    // The poster-frame stamp is part of that same identity: a recovery pass
    // reads it to re-seek an element whose frame was dropped, and a stale
    // in-point here would restore the frame the clip no longer starts at.
    const video = tag as HTMLVideoElement;
    const posterTime = posterFrameTime(el, video.preload === 'auto');
    if (posterTime === null) delete video.dataset.posterTime;
    else video.dataset.posterTime = String(posterTime);
  }

  if (el.sourceBox) {
    // Cropped: the element box is a window onto a larger frame, so the media is
    // positioned in the window's coordinates and always fills its own box.
    tag.style.position = 'absolute';
    tag.style.objectFit = 'fill';
    tag.style.left = `${el.sourceBox.x}px`;
    tag.style.top = `${el.sourceBox.y}px`;
    tag.style.width = `${el.sourceBox.w}px`;
    tag.style.height = `${el.sourceBox.h}px`;
    return;
  }

  tag.style.width = '100%';
  tag.style.height = '100%';
  tag.style.objectFit = el.fit;
  const position = el.style['object-position'];
  if (position) tag.style.objectPosition = position;
  else tag.style.removeProperty('object-position');
}

/**
 * Rebuild a shape's SVG for its current size.
 *
 * A shape's geometry lives in its `viewBox` and in its child primitive's own
 * width/height, not in the wrapper's CSS box, so resizing the wrapper alone
 * left the drawing at its original dimensions. The editor patches wrappers in
 * place for a resize -- rebuilding the slide would recreate every `<video>` --
 * which meant dragging a shape's handle moved its bounds while the rectangle
 * inside kept its old size. The SVG holds no state worth preserving, so the
 * cheapest correct patch is to build it again.
 */
export function syncShapeBody(
  node: HTMLElement,
  el: Extract<SlideElement, { type: 'shape' }>,
): void {
  const body = elementBody(node);
  if (!body || body.tagName.toLowerCase() !== 'svg') return;
  const next = renderShape(el);
  // Preserve any effect filter applied to the body it replaces.
  const filter = (body as SVGElement).style.filter;
  if (filter) next.style.filter = filter;
  body.replaceWith(next);
}

/**
 * Write the slide root's layout class and background onto a node.
 *
 * Shared with the editor's patch path, which keeps the existing root when a
 * change does not alter the element structure. Before this was shared, that
 * path updated the layout class but not the background, so changing a slide's
 * background colour left the canvas untouched until the slide was rebuilt.
 */
export function applySlideRootStyles(
  root: HTMLElement,
  slide: Slide,
  opts: RenderOptions,
): void {
  root.className = `slide layout-${slide.layout ?? 'freeform'}`;
  if (slide.background.color) root.style.background = slide.background.color;
  else root.style.removeProperty('background');
  if (slide.background.image) {
    root.style.backgroundImage = `url("${opts.resolveSrc(slide.background.image)}")`;
    root.style.backgroundSize = 'cover';
    root.style.backgroundPosition = 'center';
  } else {
    root.style.removeProperty('background-image');
    root.style.removeProperty('background-size');
    root.style.removeProperty('background-position');
  }
}

/** Build the positioned wrapper for one element and fill in its type-specific body. */
export function renderElement(
  el: SlideElement,
  opts: RenderOptions,
): HTMLElement {
  const node = document.createElement('div');
  node.className = ['element', `element-${el.type}`, ...el.class].join(' ');
  node.dataset.elementId = el.id;
  node.dataset.elementType = el.type;

  applyElementBoxStyles(node, el, undefined, opts.resolveSrc);

  const body = renderBody(el, opts);
  if (
    (el.type === 'text' || el.type === 'image' || el.type === 'video')
    && el.effects?.length
  ) {
    const renderedEffects = renderVisualEffects(el.id, el.effects);
    body.style.filter = renderedEffects.filter;
    for (const definition of renderedEffects.definitions) node.appendChild(definition);
  }

  node.appendChild(body);
  prepareSlideLinks(node);
  if (el.type === 'image' || el.type === 'video') syncMediaFrame(node, el, body);
  applyTextRenderState(node, el);
  return node;
}

/**
 * Write the wrapper box -- geometry, opacity, rotation and the element's own
 * CSS -- onto a node.
 *
 * Shared with the editor rather than private to `renderElement`, because the
 * editor patches existing nodes in place for non-structural changes instead of
 * rebuilding the slide (rebuilding recreates every `<video>` and makes clips
 * flicker on each edit). When the patch path kept its own copy of these rules,
 * any property added to one side and not the other updated the deck without
 * ever changing the pixels -- visible only once something forced a rebuild.
 * One function, called by both paths, removes that whole failure mode.
 *
 * `previous` is the element as it was last rendered, when known: keys it had
 * and this one does not must be cleared from a reused node. `resolveSrc`
 * points a deck-relative `url(assets/…)` in the element's own CSS (a
 * background image, text filled with a picture) at the deck's files; without
 * it the URL resolves against the app's page and the picture never loads.
 */
export function applyElementBoxStyles(
  node: HTMLElement,
  el: SlideElement,
  previous?: SlideElement,
  resolveSrc?: (src: string) => string,
): void {
  const s = node.style;
  if (previous) {
    for (const key of Object.keys(previous.style)) {
      if (!(key in el.style) || typedPropertyOwnsCss(el, key)) s.removeProperty(key);
    }
  }
  s.position = 'absolute';
  s.left = `${el.x}px`;
  s.top = `${el.y}px`;
  s.width = `${el.w}px`;
  s.height = `${el.h}px`;
  s.opacity = String(el.opacity);
  s.transform = el.rot ? `rotate(${el.rot}deg)` : '';
  for (const [k, v] of Object.entries(el.style)) {
    if (typedPropertyOwnsCss(el, k)) {
      s.removeProperty(k);
      continue;
    }
    s.setProperty(k, resolveSrc && v.includes('url(') ? rewriteCssAssetUrls(v, resolveSrc) : v);
  }
  // Shape paint lives in an SVG child, but CSS effects such as box-shadow live
  // on this positioned wrapper. Give that wrapper the same contour as the SVG
  // or a circular imported frame casts a square shadow and a rounded card casts
  // a sharp-cornered one. Typed shape geometry owns this property, so also
  // clear a stale radius when a shape is changed to a line or square.
  if (el.type === 'shape') {
    const radius = el.shape === 'ellipse' ? '50%'
      : el.shape === 'rect' && el.radius > 0 ? `${el.radius}px`
        : '';
    if (radius) s.borderRadius = radius;
    else s.removeProperty('border-radius');
  }
}

/**
 * Write the text-specific render state -- the fit and wrapping flags on the
 * wrapper, alignment on the body, and the styles mirrored onto the content
 * node -- onto an already-built node. A no-op for every other element type.
 *
 * Called after the body exists, since autofit measures it. Shared with the
 * editor's patch path for the reason given on `applyElementBoxStyles`: text
 * alignment used to be mirrored only by `renderElement`, so choosing an
 * alignment updated the deck and left the pixels alone until the slide was
 * rebuilt.
 */
export function applyTextRenderState(
  node: HTMLElement,
  el: SlideElement,
  previous?: SlideElement,
): void {
  if (el.type !== 'text') return;

  if (el.table) node.dataset.table = 'true';
  else delete node.dataset.table;

  if (el.paragraphSpacing !== undefined) {
    node.dataset.paragraphSpacing = String(el.paragraphSpacing);
    node.style.setProperty('--paragraph-spacing', `${el.paragraphSpacing}px`);
  } else {
    delete node.dataset.paragraphSpacing;
    node.style.removeProperty('--paragraph-spacing');
  }

  if (el.noWrap) node.dataset.noWrap = 'true';
  else delete node.dataset.noWrap;
  if (el.autoSize) node.dataset.autoSize = 'true';
  else delete node.dataset.autoSize;
  if (el.noWrap && el.noWrapMode === 'condense') node.dataset.fitMode = 'condense';
  else delete node.dataset.fitMode;

  const body = node.querySelector<HTMLElement>('.text-body');
  if (body) {
    body.style.textAlign = el.align;
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.justifyContent =
      el.valign === 'top' ? 'flex-start' : el.valign === 'bottom' ? 'flex-end' : 'center';
    body.style.width = '100%';
    body.style.height = '100%';
  }

  // Element inline styles sit on the wrapper and reach the text only by
  // inheritance; a theme rule targeting .text-content directly would beat them.
  // Mirror them here so the element's own style always wins.
  const content = node.querySelector<HTMLElement>('.text-content');
  if (content) {
    content.style.width = '100%';
    for (const property of MIRRORED_TEXT_STYLE_PROPERTIES) {
      const value = el.style[property];
      if (value !== undefined) content.style.setProperty(property, value);
      else content.style.removeProperty(property);
    }
    // Keys the last render wrote and this one does not must be cleared, or the
    // old declaration keeps winning. Gradient text is the case that bites:
    // clipped-text markup leaves `-webkit-text-fill-color: transparent` behind,
    // so picking a solid colour afterwards left the glyphs invisible until the
    // slide was rebuilt.
    if (previous?.type === 'text') {
      for (const property of Object.keys(previous.contentStyle ?? {})) {
        if (!(property in (el.contentStyle ?? {}))) content.style.removeProperty(property);
      }
    }
    for (const [property, value] of Object.entries(el.contentStyle ?? {})) {
      content.style.setProperty(property, value);
    }
    if (el.table) {
      const table = content.querySelector<HTMLTableElement>(':scope > table');
      if (table) {
        const template = document.createElement('template');
        template.innerHTML = applyTableColumnWidths(table.outerHTML, el.table.columnWidths);
        const nextGroup = template.content.querySelector('colgroup');
        const priorGroup = table.querySelector(':scope > colgroup');
        if (nextGroup) {
          if (priorGroup) priorGroup.replaceWith(nextGroup);
          else table.insertBefore(nextGroup, table.firstChild);
        }
      }
    }
  }

  // noWrap implies the fit: with soft wrapping off, shrinking is the only way
  // an overlong line stays inside the box.
  // A box sized to its text has nothing to shrink into: the box follows the
  // text instead.
  if ((el.autoFit || el.noWrap) && !el.autoSize) {
    node.dataset.autoFit = 'true';
    scheduleAutoFit(node);
  } else {
    delete node.dataset.autoFit;
    // Everything a fit pass writes has to come off together. Only the font size
    // used to be cleared, so turning no-wrap off left the condense mode's
    // horizontal squeeze on the text: it re-wrapped while staying distorted.
    if (content) {
      content.style.removeProperty('font-size');
      content.style.removeProperty('transform');
      content.style.removeProperty('transform-origin');
      delete content.dataset.fittedScaleX;
      delete content.dataset.fittedFontSize;
    }
  }
}

/**
 * The CSS corner radius for a media element, or '' for square corners.
 *
 * A circular mask clips the box to its inscribed ellipse — the editor squares
 * the box when it turns the mask on, so the crop is a circle — and wins over
 * a numeric corner radius; a raw `border-radius` in the element's own style is
 * honoured as authored.
 */
export function mediaRadius(
  el: Extract<SlideElement, { type: 'image' | 'video' }>,
): string {
  if (el.maskShape === 'circle') return '50%';
  // Presence matters here. Older Agent HTML imports stored the radius only in
  // `style`; once the inspector writes a typed value, even an explicit zero
  // must take ownership and suppress that stale CSS copy.
  if (el.borderRadius !== undefined) {
    return el.borderRadius > 0 ? `${el.borderRadius}px` : '';
  }
  if (el.maskShape === 'rect') return '';
  return el.style['border-radius'] ?? '';
}

/**
 * Paint a media border over the media instead of putting it in the wrapper's
 * box model. The latter has `box-sizing:border-box`, so a normal CSS border
 * steals pixels from the image/video content even though the authored element
 * keeps the same outer dimensions.
 *
 * This is exported because the editor updates existing DOM nodes in place for
 * inspector changes rather than rebuilding the whole slide.
 */
export function syncMediaFrame(
  node: HTMLElement,
  el: Extract<SlideElement, { type: 'image' | 'video' }>,
  body: HTMLElement | SVGElement | null = null,
): void {
  let overlay = node.querySelector<HTMLElement>(':scope > .media-border-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'media-border-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    node.appendChild(overlay);
  }
  overlay.style.cssText = [
    'position:absolute',
    'inset:0',
    'box-sizing:border-box',
    'pointer-events:none',
    'z-index:1',
  ].join(';');
  // Confine that z-index to this element. Element wrappers are positioned but
  // have no z-index of their own, so they paint in document order and do not
  // form stacking contexts -- which let the overlay's `z-index:1` be resolved
  // against the *slide*, painting one element's border on top of every later
  // element. Dragging a front video over a bordered one put the bordered
  // one's frame across it. `isolation` makes the wrapper a stacking context
  // without changing where the wrapper itself sits among its siblings.
  node.style.isolation = 'isolate';

  // A border authored directly in element.style has the same media semantics
  // as the inspector's typed border. Move its paint to the overlay too.
  for (const [property, value] of Object.entries(el.style)) {
    if (!isMediaBorderPaint(property)) continue;
    // Typed media fields take precedence over the CSS copy left by older
    // imports. CSS remains supported when no typed width has ever been set.
    if (el.borderWidth === undefined) overlay.style.setProperty(property, value);
    node.style.removeProperty(property);
    // jsdom (and some older Chromium CSSOM builds) retains the expanded
    // longhands after removing the shorthand.
    if (property === 'border') node.style.border = '';
  }
  // Once a typed width exists, the inspector owns the border completely.
  // Older Agent imports can contain both typed media fields and the original
  // CSS border; an explicit 0 must suppress that stale CSS copy rather than
  // revealing it again underneath the editable value.
  if (el.borderWidth !== undefined) {
    if (el.borderWidth > 0) {
      overlay.style.border = `${el.borderWidth}px solid ${el.borderColor ?? '#000000'}`;
    }
  }

  const radius = mediaRadius(el);
  if (radius) node.style.borderRadius = radius;
  else node.style.removeProperty('border-radius');
  if (radius) node.style.overflow = 'hidden';
  else if (el.style.overflow !== undefined) node.style.overflow = el.style.overflow;
  else node.style.removeProperty('overflow');
  overlay.style.borderRadius = radius;

  // The radius goes on the media node itself as well as on the wrapper: a
  // <video> gets its own compositing layer, which an ancestor's overflow clip
  // does not always constrain consistently.
  const mediaBody = body ?? elementBody(node);
  if (mediaBody) {
    if (radius) mediaBody.style.borderRadius = radius;
    else mediaBody.style.removeProperty('border-radius');
  }
}

function renderVisualEffects(
  elementId: string,
  effects: MediaEffect[],
): { filter: string; definitions: SVGSVGElement[] } {
  const filters: string[] = [];
  const definitions: SVGSVGElement[] = [];
  effects.forEach((effect, index) => {
    if (effect.type === 'blur') {
      filters.push(`blur(${effect.radius}px)`);
    } else if (effect.type === 'grayscale') {
      filters.push(`grayscale(${effect.amount})`);
    } else if (effect.type === 'posterize') {
      const id = `posterize-${elementId}-${index}`.replace(/[^a-zA-Z0-9_-]/g, '-');
      definitions.push(posterizeDefinition(id, effect.levels));
      filters.push(`url("#${id}")`);
    } else {
      const id = `gaussian-noise-${elementId}-${index}`
        .replace(/[^a-zA-Z0-9_-]/g, '-');
      definitions.push(gaussianNoiseDefinition(
        id,
        effect.amount,
        effect.frequencyCutoff,
        noiseSeed(elementId, index),
      ));
      filters.push(`url("#${id}")`);
    }
  });
  return { filter: filters.join(' '), definitions };
}

/**
 * A deterministic, spatially band-limited noise field linearly mixed with the
 * source. Masking the noise by SourceAlpha keeps transparent text backgrounds
 * transparent while still replacing every painted video/image pixel at 1.
 */
function gaussianNoiseDefinition(
  id: string,
  amount: number,
  frequencyCutoff: number,
  seed: number,
): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('media-effect-definition');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');

  const filter = document.createElementNS(ns, 'filter');
  filter.id = id;
  filter.setAttribute('color-interpolation-filters', 'sRGB');

  // Several independent octaves summed by fractalNoise give a bell-shaped
  // field while baseFrequency is the user-facing spatial-frequency cutoff.
  const turbulence = document.createElementNS(ns, 'feTurbulence');
  turbulence.setAttribute('type', 'fractalNoise');
  turbulence.setAttribute('baseFrequency', String(frequencyCutoff));
  turbulence.setAttribute('numOctaves', '4');
  turbulence.setAttribute('seed', String(seed));
  turbulence.setAttribute('result', 'gaussianNoise');

  const masked = document.createElementNS(ns, 'feComposite');
  masked.setAttribute('in', 'gaussianNoise');
  masked.setAttribute('in2', 'SourceAlpha');
  masked.setAttribute('operator', 'in');
  masked.setAttribute('result', 'maskedNoise');

  const blend = document.createElementNS(ns, 'feComposite');
  blend.setAttribute('in', 'maskedNoise');
  blend.setAttribute('in2', 'SourceGraphic');
  blend.setAttribute('operator', 'arithmetic');
  blend.setAttribute('k1', '0');
  blend.setAttribute('k2', String(amount));
  blend.setAttribute('k3', String(1 - amount));
  blend.setAttribute('k4', '0');

  filter.append(turbulence, masked, blend);
  svg.appendChild(filter);
  return svg;
}

function noiseSeed(elementId: string, index: number): number {
  let hash = index + 1;
  for (const char of elementId) hash = ((hash * 31) + char.charCodeAt(0)) | 0;
  return Math.abs(hash % 32767) + 1;
}

function posterizeDefinition(id: string, levels: number): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('media-effect-definition');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('aria-hidden', 'true');
  const filter = document.createElementNS(ns, 'filter');
  filter.id = id;
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const transfer = document.createElementNS(ns, 'feComponentTransfer');
  const values = Array.from({ length: levels }, (_, i) => i / (levels - 1)).join(' ');
  for (const channel of ['R', 'G', 'B']) {
    const fn = document.createElementNS(ns, `feFunc${channel}`);
    fn.setAttribute('type', 'discrete');
    fn.setAttribute('tableValues', values);
    transfer.appendChild(fn);
  }
  filter.appendChild(transfer);
  svg.appendChild(filter);
  return svg;
}

const pendingTextFits = new WeakSet<HTMLElement>();
const fontRefitsRegistered = new WeakSet<HTMLElement>();

/** Fit every opted-in text element below a freshly rendered slide or stage. */
export function fitAutoText(root: ParentNode): void {
  for (const node of root.querySelectorAll<HTMLElement>('.element-text[data-auto-fit="true"]')) {
    fitAutoTextElement(node);
  }
}

/** Defer until the rendered node has been attached and therefore has layout. */
export function scheduleAutoFit(node: HTMLElement): void {
  if (pendingTextFits.has(node)) return;
  pendingTextFits.add(node);
  const run = () => {
    pendingTextFits.delete(node);
    if (node.isConnected) fitAutoTextElement(node);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);

  // Web fonts can replace fallback metrics after the first layout pass.
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (fonts && !fontRefitsRegistered.has(node)) {
    fontRefitsRegistered.add(node);
    void fonts.ready.then(() => {
      if (node.isConnected) scheduleAutoFit(node);
    });
  }
}

function renderBody(el: SlideElement, opts: RenderOptions): HTMLElement | SVGElement {
  switch (el.type) {
    case 'text': {
      // Structure only: alignment and the mirrored content styles are written
      // by `applyTextRenderState`, which the editor's patch path shares.
      const div = document.createElement('div');
      div.className = 'text-body';
      // Keep vertical alignment on the outer flex box, but put all authored
      // markup inside one flow container. Otherwise every KaTeX inline span
      // becomes its own flex item and is forced onto a separate line.
      const content = document.createElement('div');
      content.className = 'text-content';
      // KaTeX auto-render does not exclude escaped delimiter characters before
      // pairing `$...$`. Protect literal dollars, render, then restore them.
      const escapedDollar = '\uE000';
      const authored = el.table
        ? applyTableColumnWidths(el.html, el.table.columnWidths)
        : el.html;
      content.innerHTML = authored.replace(/\\\$/g, escapedDollar);
      renderMathInElement(content, {
        // Standard TeX convention: display math first so $$ is not consumed
        // as two empty inline expressions. A literal dollar is written as \$.
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
        strict: 'ignore',
      });
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const text = walker.currentNode as Text;
        if (text.data.includes(escapedDollar)) {
          text.data = text.data.replaceAll(escapedDollar, '$');
        }
      }
      div.appendChild(content);
      return div;
    }

    case 'image': {
      if (isPendingSrc(el.src)) return renderPendingPlaceholder(el.src);
      if (/\.pdf(?:$|[?#])/i.test(el.src)) {
        const pdf = document.createElement('embed');
        pdf.src = `${opts.resolveSrc(el.src)}#page=1&toolbar=0&navpanes=0`;
        pdf.type = 'application/pdf';
        pdf.style.width = '100%';
        pdf.style.height = '100%';
        pdf.style.pointerEvents = 'none';
        return pdf;
      }
      const img = document.createElement('img');
      img.src = opts.resolveSrc(el.src);
      img.alt = el.alt;
      img.draggable = false;

      if (el.sourceBox) {
        // Cropped: the element box is a window onto a larger image, so the
        // image is positioned and sized in the window's coordinates and the
        // wrapper clips it.
        const wrap = document.createElement('div');
        wrap.style.position = 'relative';
        wrap.style.width = '100%';
        wrap.style.height = '100%';
        wrap.style.overflow = 'hidden';
        img.style.position = 'absolute';
        img.style.objectFit = 'fill';
        img.style.left = `${el.sourceBox.x}px`;
        img.style.top = `${el.sourceBox.y}px`;
        img.style.width = `${el.sourceBox.w}px`;
        img.style.height = `${el.sourceBox.h}px`;
        wrap.appendChild(img);
        return wrap;
      }

      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = el.fit;
      if (el.style['object-position']) img.style.objectPosition = el.style['object-position'];
      return img;
    }

    case 'video':
      return renderVideo(el, opts);

    case 'shape':
      return renderShape(el);

    case 'html': {
      const div = document.createElement('div');
      div.style.width = '100%';
      div.style.height = '100%';
      if (el.sandboxed) {
        const root = div.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `:host { display:block; width:100%; height:100%; overflow:hidden; }\n${rewriteCssAssetUrls(el.css ?? '', opts.resolveSrc)}\n[data-slide-editor-fallback-root] { position:relative !important; left:0 !important; top:0 !important; width:100% !important; height:100% !important; margin:0 !important; transform:none !important; }`;
        const body = document.createElement('div');
        body.style.width = '100%';
        body.style.height = '100%';
        body.innerHTML = el.html;
        resolveHtmlAssetRefs(body, opts.resolveSrc);
        root.append(style, body);
      } else {
        div.innerHTML = el.html;
        // Deck-relative references need resolving whether or not the region is
        // sandboxed: without this they resolve against the host page, so an
        // unsandboxed html element's images were simply missing everywhere the
        // host page is not the deck folder (the app, and every export).
        resolveHtmlAssetRefs(div, opts.resolveSrc);
        if (el.css) {
          const style = document.createElement('style');
          style.textContent = rewriteCssAssetUrls(el.css, opts.resolveSrc);
          div.prepend(style);
        }
      }
      return div;
    }

    case 'web':
      return renderWeb(el, opts);

    case 'unsupported': {
      // Visible on purpose: an import gap you can see and fix beats content
      // that vanished silently.
      const div = document.createElement('div');
      div.className = 'unsupported-body';
      div.textContent = el.note || el.originalType;
      return div;
    }
  }
}

/**
 * A web element is a sandboxed frame around a deck-relative HTML document.
 *
 * `sandbox="allow-scripts"` and nothing else: the page runs with an opaque
 * origin, so it can neither read the deck folder it is served from nor reach
 * the host page, open windows, navigate the presentation, or submit forms.
 * Only deck-relative documents are shown — a remote URL would make the talk
 * depend on the network and let a shared deck load an arbitrary site.
 *
 * Preview surfaces (`mediaPreload: 'metadata'`: the editor canvas, the rail,
 * Morph and layout previews) show the poster when there is one and otherwise
 * an inert frame — inert so the editor's own pointer handling keeps working
 * over it. The live frame only exists where the deck is being presented.
 */
function renderWeb(
  el: Extract<SlideElement, { type: 'web' }>,
  opts: RenderOptions,
): HTMLElement {
  const box = document.createElement('div');
  box.className = 'web-body';
  box.style.width = '100%';
  box.style.height = '100%';
  box.style.overflow = 'hidden';
  const preview = opts.mediaPreload === 'metadata';

  if (preview && el.poster) {
    const poster = document.createElement('img');
    poster.src = opts.resolveSrc(el.poster);
    poster.alt = el.title;
    poster.style.width = '100%';
    poster.style.height = '100%';
    // A poster is evidence, not decorative media. If the authored web box
    // changes aspect ratio after capture, keep the whole still visible rather
    // than cropping chart labels and controls off its edges.
    poster.style.objectFit = 'contain';
    poster.style.display = 'block';
    box.appendChild(poster);
    return box;
  }

  if (!isEmbeddableWebSrc(el.src)) {
    box.className = 'web-body unsupported-body';
    box.textContent = el.src
      ? `Web page must be a deck-relative .html file: ${el.src}`
      : 'Web page: no document set';
    return box;
  }

  const frame = document.createElement('iframe');
  frame.className = 'web-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', '');
  frame.setAttribute('loading', preview ? 'lazy' : 'eager');
  frame.title = el.title || 'Embedded web page';
  frame.src = opts.resolveSrc(el.src);
  frame.style.width = '100%';
  frame.style.height = '100%';
  frame.style.border = '0';
  frame.style.display = 'block';
  frame.style.background = 'transparent';
  // Inert in previews (the editor selects and drags through it) and when the
  // author wants clicks on the page to advance the deck instead.
  frame.style.pointerEvents = preview || !el.interactive ? 'none' : 'auto';
  box.appendChild(frame);
  return box;
}

/**
 * Point every deck-relative `src`/`poster` in a subtree at the host's resolved
 * URL, leaving absolute, data and blob references alone.
 */
function resolveHtmlAssetRefs(root: HTMLElement, resolveSrc: (src: string) => string): void {
  for (const media of root.querySelectorAll<HTMLElement>('[src], [poster]')) {
    for (const attribute of ['src', 'poster']) {
      const value = media.getAttribute(attribute);
      if (value && !/^(?:[a-z]+:|\/)/i.test(value)) {
        media.setAttribute(attribute, resolveSrc(value));
      }
    }
  }
}

/**
 * Point a stylesheet's relative `url()`s at the deck's own files.
 *
 * A stylesheet pasted into a `<style>` resolves `url(assets/…)` against the
 * page, which is the app's bundle, not the deck folder. Slide CSS and the
 * deck's theme.css both need this: the theme is where a deck declares the
 * webfonts it carries in `assets/fonts/`.
 */
export function rewriteCssAssetUrls(css: string, resolveSrc: (src: string) => string): string {
  return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, _quote: string, src: string) => {
    // Anything with a scheme (data:, blob:, https:, deck:), a rooted path or
    // a fragment (an SVG filter's #id) already says where it lives.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(src.trim())) return match;
    return `url("${resolveSrc(src)}")`;
  });
}

/**
 * A media element whose file is still uploading or transcoding. Rendered as a
 * labelled box with a progress ring; the ring is indeterminate by default
 * (that's all a collab peer knows), and the uploading client's canvas layers
 * live progress and a local preview frame on top after each render.
 */
function renderPendingPlaceholder(src: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'pending-asset';
  box.dataset.pendingToken = pendingToken(src) ?? '';

  const preview = document.createElement('div');
  preview.className = 'pending-asset-preview';
  box.appendChild(preview);

  const hud = document.createElement('div');
  hud.className = 'pending-asset-hud';
  const ring = document.createElement('div');
  ring.className = 'pending-asset-ring indeterminate';
  const label = document.createElement('div');
  label.className = 'pending-asset-label';
  label.textContent = pendingName(src);
  const status = document.createElement('div');
  status.className = 'pending-asset-status';
  status.textContent = 'Uploading…';
  hud.append(ring, label, status);
  box.appendChild(hud);
  return box;
}

/**
 * How a video element will be presented: the file, the frame it should show,
 * and the geometry the frame is painted through.
 *
 * This is the identity a pooled `<video>` must match to be reusable. Pooling
 * by source alone is not enough, and the failure is visible: a deck showing
 * one clip through several different crops (Keynote imports do this
 * constantly) would hand a cropped slot's element — its last frame decoded
 * stretched into an 886x1268 box under `object-fit: fill` — to a square
 * `contain` slot, and vice versa. Each then needs a seek to the other's
 * in-point, and while that seek is pending the compositor keeps painting the
 * old texture scaled into the new box: a tall frame squeezed into a square
 * box reads as a vertically squished video that "pops" straight when the seek
 * lands, which on a remote server takes about half a second.
 *
 * Elements that share a key are interchangeable: same bytes, same frame, same
 * shape, so a swap is invisible and needs no seek at all.
 */
export function videoPresentationKey(
  el: Extract<SlideElement, { type: 'video' }>,
  resolvedSrc: string,
): string {
  const crop = el.sourceBox
    ? `${el.sourceBox.x},${el.sourceBox.y},${el.sourceBox.w},${el.sourceBox.h}`
    : 'none';
  // The box size matters even under `width: 100%`: the percentage resolves
  // against the wrapper, so two slots of different sizes composite the same
  // frame at different scales.
  return [resolvedSrc, el.start, crop, el.fit, el.w, el.h].join('|');
}

/** Whether a resolved media URL will be read as cross-origin by the canvas. */
function isCrossOrigin(url: string): boolean {
  if (typeof location === 'undefined') return false;
  try {
    return new URL(url, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

/**
 * The frame a paused element should show: its in-point, or a hair past zero on
 * a preview surface.
 *
 * A `<video>` paints nothing until a frame is decoded, so a preview that never
 * seeks is a black box; under `preload="metadata"` nothing else will decode
 * one. The hair past zero matters — seeking to the current position completes
 * without decoding anything. A live surface with no in-point needs no seek at
 * all, because playback is about to decode frames anyway.
 */
export function posterFrameTime(
  el: Extract<SlideElement, { type: 'video' }>,
  live: boolean,
): number | null {
  if (el.start > 0) return el.start;
  return live ? null : 0.03;
}

/**
 * Seek to the element's poster frame as soon as metadata arrives.
 *
 * Idempotent and safe to call again after a reload: the listener is `once`, so
 * a video whose buffer was dropped (a hidden page's media can be reclaimed)
 * needs it re-armed or it comes back frameless — black — however long it
 * stays on screen.
 */
export function armPosterFrameSeek(video: HTMLVideoElement): void {
  const posterTime = Number(video.dataset.posterTime);
  if (!Number.isFinite(posterTime)) return;
  video.addEventListener(
    'loadedmetadata',
    () => {
      // A capture path (PDF export) may have claimed the frame already.
      if (video.dataset.holdFrame === 'true') return;
      video.currentTime = posterTime;
    },
    { once: true },
  );
}

function renderVideo(
  el: Extract<SlideElement, { type: 'video' }>,
  opts: RenderOptions,
): HTMLElement {
  if (isPendingSrc(el.src)) return renderPendingPlaceholder(el.src);
  const video = document.createElement('video');
  video.playsInline = true;
  video.dataset.mediaKey = videoPresentationKey(el, opts.resolveSrc(el.src));
  // Black only once decoding has failed (player.css): a black surface behind a
  // working video shows as a dark hairline at its scaled edges on light slides.
  video.addEventListener('error', () => video.classList.add('media-failed'));
  const preload = opts.mediaPreload ?? 'auto';
  // The preload hint must be in place before src: assigning src is what
  // starts resource selection, and it reads the hint of that moment.
  video.preload = preload === 'metadata' ? 'none' : preload;
  const src = opts.resolveSrc(el.src);
  // A preview's frame is captured into a canvas (previewPoster.ts), and
  // drawing a cross-origin frame taints the canvas so the pixels cannot be
  // read back. The desktop app is exactly that case -- the renderer is
  // http(s) or file: while assets are served from deck: -- so ask for CORS.
  // Both asset servers answer `Access-Control-Allow-Origin: *`. Same-origin
  // media (the collab client) is left alone: the attribute would only add a
  // preflight-shaped failure mode for no gain.
  if (preload === 'metadata' && isCrossOrigin(src)) video.crossOrigin = 'anonymous';
  // Deferral only pays when someone will supply the still. Without a provider
  // (the browser collab client) the element takes its source now, exactly as
  // before: a source assigned later runs the load algorithm on an element
  // Chromium has already put in NETWORK_NO_SOURCE, whose queued 'emptied'
  // the load gate would read as a freed slot.
  const deferSrc = preload === 'metadata' && opts.deferVideoSrc === true && previewPosterProvider() !== null;
  if (deferSrc) {
    // No src, no fetch, no decoder: the still is cut elsewhere. Stashed where
    // the gate keeps an aborted source, so recovery and capture code that
    // already read that slot need no second path.
    video.dataset.gateAbortedSrc = src;
    video.dataset.posterPending = 'true';
  } else {
    video.src = src;
  }
  applyVideoPlaybackState(video, el, opts);
  if (preload === 'metadata' && !deferSrc) {
    // Preview surfaces mount many videos at once (one per rail thumbnail);
    // letting them all fetch together monopolises the origin's connections.
    // They start as 'none' — src set, nothing fetched — and the gate promotes
    // a few at a time to 'metadata' (docs/media-loading.md).
    gateVideoLoad(video);
  }

  // Autoplay is driven by the timeline runtime, not the `autoplay` attribute,
  // so that reveal-then-play ordering stays under our control. The seek below
  // doubles as the poster frame (see posterFrameTime).
  const posterTime = posterFrameTime(el, preload !== 'metadata');
  if (posterTime !== null) {
    // Stamped so a later recovery pass can re-arm the same seek without the
    // deck element in hand (see previewFrameRecovery.ts).
    video.dataset.posterTime = String(posterTime);
    armPosterFrameSeek(video);
  }

  if (el.sourceBox) {
    // Cropped: the element box is a window onto a larger frame, identical in
    // shape to how a cropped image is rendered.
    const wrap = document.createElement('div');
    wrap.style.position = 'relative';
    wrap.style.width = '100%';
    wrap.style.height = '100%';
    wrap.style.overflow = 'hidden';
    video.style.position = 'absolute';
    video.style.objectFit = 'fill';
    video.style.left = `${el.sourceBox.x}px`;
    video.style.top = `${el.sourceBox.y}px`;
    video.style.width = `${el.sourceBox.w}px`;
    video.style.height = `${el.sourceBox.h}px`;
    wrap.appendChild(video);
    return wrap;
  }

  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = el.fit;
  if (el.style['object-position']) video.style.objectPosition = el.style['object-position'];
  return video;
}

/**
 * The shape's own drawing, parsed from the one implementation in
 * `@shared/shapeSvg`. The exporter writes the same markup into the authoring
 * file, so a shape looks the same in the browser as it does on the projector.
 */
function renderShape(el: Extract<SlideElement, { type: 'shape' }>): SVGElement {
  const template = document.createElement('template');
  template.innerHTML = shapeSvg(el);
  return template.content.firstElementChild as SVGElement;
}



/**
 * Size the stage so the fixed canvas fills the viewport without cropping.
 * Everything inside the stage stays in canvas pixels.
 */
export function applyStageScale(
  stage: HTMLElement,
  deck: Deck,
  viewport: { w: number; h: number },
): number {
  const scale = fitScale(deck.canvas, viewport);
  stage.style.width = `${deck.canvas.w}px`;
  stage.style.height = `${deck.canvas.h}px`;
  stage.style.transform = `scale(${scale})`;
  stage.style.transformOrigin = 'top left';
  stage.style.position = 'absolute';
  stage.style.left = `${(viewport.w - deck.canvas.w * scale) / 2}px`;
  stage.style.top = `${(viewport.h - deck.canvas.h * scale) / 2}px`;
  return scale;
}
