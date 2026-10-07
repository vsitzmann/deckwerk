/**
 * The editor's model/DOM agreement invariant.
 *
 * The editor does not rebuild the slide for every edit. Geometry and style
 * changes are patched onto the existing nodes (see `EditorCanvas.applyGeometry`)
 * because rebuilding recreates each <video> and makes clips flicker. The cost of
 * that fast path is a second, hand-maintained copy of the render rules: every
 * property `renderElement` writes has to be mirrored by the patch, and a
 * property that is mirrored nowhere updates the deck without ever changing the
 * pixels. That failure is invisible until the slide happens to be rebuilt --
 * which is why it always surfaces as "my change only showed up after I left the
 * slide and came back".
 *
 * This module makes that class of bug loud instead of latent. Rendering the
 * slide fresh from the model must produce the same DOM the patch path left
 * behind; anything else is a missing mirror. The comparison is normalized for
 * the decorations the editor legitimately adds on top of a player render
 * (playback badges, upload HUDs, the live contenteditable, autofit's measured
 * font size), so a divergence names a real property that two code paths
 * disagree about.
 */
import type { Slide } from '../../shared/deck.js';
import { renderSlide } from '../player/render.js';

/** Nodes the editor adds on top of a player render; not part of the model. */
const EDITOR_ONLY_SELECTOR = [
  '.video-editor-badge',
  '.pending-hud',
  '.pending-progress',
  '.pending-preview',
  '[data-editor-only]',
].join(',');

/**
 * Attributes the editor owns rather than the model: playback and editing state
 * that is deliberately different on the canvas than in the player.
 */
const IGNORED_ATTRIBUTES = new Set([
  'autoplay',
  'contenteditable',
  'spellcheck',
  'tabindex',
  'draggable',
  'data-editing',
  'data-selected',
  'aria-live',
  // Load-scheduling state, not model-derived presentation: the media load
  // gate promotes preview videos 'none' → 'metadata' one at a time, and the
  // player stamps the owning element id on videos it reuses across slides.
  'preload',
  'data-player-element-id',
]);

/**
 * Style properties whose value is measured at runtime rather than derived from
 * the model, so the two renders are not expected to agree on them.
 *
 * `font-size` on an autofitting text body is written asynchronously by
 * `scheduleAutoFit` from the node's laid-out size; a freshly built node has not
 * been measured yet.
 */
const MEASURED_STYLE_PROPERTIES = new Set(['font-size']);

export interface RenderDivergence {
  /** Element the divergence was found in, or 'slide' for the slide root. */
  elementId: string;
  /** Path to the differing node inside that element, e.g. '.text-body'. */
  path: string;
  /** What differs: a style property, an attribute, or 'structure'. */
  property: string;
  live: string;
  fresh: string;
}

export function formatDivergence(d: RenderDivergence): string {
  return `${d.elementId} ${d.path} ${d.property}: canvas has ${JSON.stringify(d.live)}, `
    + `a fresh render gives ${JSON.stringify(d.fresh)}`;
}

/**
 * Compare the live canvas DOM against a fresh render of the same slide.
 *
 * Returns every divergence found; an empty array means the fast patch path and
 * `renderElement` agree, which is the invariant.
 */
export function findRenderDivergences(
  slideLayer: HTMLElement,
  slide: Slide,
  resolveSrc: (src: string) => string,
  options: { skipElementIds?: Iterable<string> } = {},
): RenderDivergence[] {
  const live = slideLayer.querySelector<HTMLElement>(':scope > .slide');
  if (!live) return [];
  const fresh = renderSlide(slide, { resolveSrc, mediaPreload: 'metadata' });
  const skip = new Set(options.skipElementIds ?? []);
  const divergences: RenderDivergence[] = [];

  compareNode(live, fresh, 'slide', '.slide', divergences);

  for (const element of slide.elements) {
    if (skip.has(element.id)) continue;
    const liveNode = live.querySelector<HTMLElement>(
      `[data-element-id="${cssEscape(element.id)}"]`,
    );
    const freshNode = fresh.querySelector<HTMLElement>(
      `[data-element-id="${cssEscape(element.id)}"]`,
    );
    if (!freshNode) continue;
    if (!liveNode) {
      divergences.push({
        elementId: element.id,
        path: '',
        property: 'structure',
        live: 'missing from the canvas',
        fresh: 'present',
      });
      continue;
    }
    compareTrees(normalize(liveNode), normalize(freshNode), element.id, divergences);
  }

  // Nodes on the canvas that the model no longer contains: a delete or an id
  // change that left its DOM behind. These are as user-visible as a missing
  // mirror -- a ghost object that cannot be selected or removed.
  const modelIds = new Set(slide.elements.map((element) => element.id));
  for (const node of live.querySelectorAll<HTMLElement>(':scope > [data-element-id]')) {
    const id = node.dataset.elementId!;
    if (modelIds.has(id) || skip.has(id)) continue;
    divergences.push({
      elementId: id,
      path: '',
      property: 'structure',
      live: 'present on the canvas',
      fresh: 'not in the model',
    });
  }
  return divergences;
}

/** Throwing form, for tests: the invariant as an assertion. */
export function assertNoRenderDivergence(
  slideLayer: HTMLElement,
  slide: Slide,
  resolveSrc: (src: string) => string,
  options: { skipElementIds?: Iterable<string>; context?: string } = {},
): void {
  const divergences = findRenderDivergences(slideLayer, slide, resolveSrc, options);
  if (divergences.length === 0) return;
  const where = options.context ? ` after ${options.context}` : '';
  throw new Error(
    `Canvas DOM disagrees with a fresh render${where}:\n`
    + divergences.map((d) => `  - ${formatDivergence(d)}`).join('\n'),
  );
}

/**
 * Dev-mode wiring. When enabled, the canvas reports divergences to the console
 * as they happen instead of waiting for a user to notice stale pixels.
 */
let reportingEnabled = false;

export function setRenderInvariantChecks(enabled: boolean): void {
  reportingEnabled = enabled;
}

export function renderInvariantChecksEnabled(): boolean {
  return reportingEnabled;
}

export function reportRenderDivergences(
  slideLayer: HTMLElement,
  slide: Slide,
  resolveSrc: (src: string) => string,
  options: { skipElementIds?: Iterable<string>; context?: string } = {},
): void {
  if (!reportingEnabled) return;
  let divergences: RenderDivergence[];
  try {
    divergences = findRenderDivergences(slideLayer, slide, resolveSrc, options);
  } catch {
    // A checker crash must never break editing.
    return;
  }
  if (divergences.length === 0) return;
  console.error(
    `[render-invariant] canvas DOM is stale${options.context ? ` after ${options.context}` : ''}:`,
    divergences.map(formatDivergence),
  );
}

/**
 * Strip the editor's own decorations and runtime-measured values so what is
 * left is only what the model is supposed to determine.
 */
function normalize(node: HTMLElement): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement;
  for (const extra of clone.querySelectorAll(EDITOR_ONLY_SELECTOR)) extra.remove();
  // Effect filter definitions carry generated ids that differ per render.
  for (const svg of clone.querySelectorAll('svg')) {
    if (svg.querySelector('filter')) svg.remove();
  }
  const autoFitting = clone.dataset.autoFit === 'true';
  const walk = (el: Element): void => {
    if (autoFitting && el.classList.contains('text-content')) {
      (el as HTMLElement).style.removeProperty('font-size');
      // The fit pass records what it measured beside the size it wrote.
      el.removeAttribute('data-fitted-font-size');
    }
    for (const name of [...el.getAttributeNames()]) {
      if (IGNORED_ATTRIBUTES.has(name)) el.removeAttribute(name);
    }
    for (const child of el.children) walk(child);
  };
  walk(clone);
  return clone;
}

function compareTrees(
  live: Element,
  fresh: Element,
  elementId: string,
  out: RenderDivergence[],
  path = '',
): void {
  compareNode(live, fresh, elementId, path || describe(fresh), out);
  // Structural comparison is by position: both sides are built from the same
  // element, so a length or tag mismatch is itself the finding and recursing
  // past it would only produce noise.
  if (live.children.length !== fresh.children.length) {
    out.push({
      elementId,
      path: path || describe(fresh),
      property: 'structure',
      live: `${live.children.length} child nodes`,
      fresh: `${fresh.children.length} child nodes`,
    });
    return;
  }
  for (let i = 0; i < fresh.children.length; i += 1) {
    const liveChild = live.children[i];
    const freshChild = fresh.children[i];
    const childPath = `${path ? `${path} > ` : ''}${describe(freshChild)}`;
    if (liveChild.tagName !== freshChild.tagName) {
      out.push({
        elementId,
        path: childPath,
        property: 'structure',
        live: liveChild.tagName.toLowerCase(),
        fresh: freshChild.tagName.toLowerCase(),
      });
      continue;
    }
    compareTrees(liveChild, freshChild, elementId, out, childPath);
  }
}

function compareNode(
  live: Element,
  fresh: Element,
  elementId: string,
  path: string,
  out: RenderDivergence[],
): void {
  const liveClasses = [...live.classList].sort().join(' ');
  const freshClasses = [...fresh.classList].sort().join(' ');
  if (liveClasses !== freshClasses) {
    out.push({ elementId, path, property: 'class', live: liveClasses, fresh: freshClasses });
  }

  const liveStyle = styleMap(live);
  const freshStyle = styleMap(fresh);
  for (const property of new Set([...liveStyle.keys(), ...freshStyle.keys()])) {
    if (MEASURED_STYLE_PROPERTIES.has(property)) continue;
    const liveValue = liveStyle.get(property) ?? '';
    const freshValue = freshStyle.get(property) ?? '';
    if (normalizeValue(liveValue) === normalizeValue(freshValue)) continue;
    out.push({ elementId, path, property: `style.${property}`, live: liveValue, fresh: freshValue });
  }

  // Media playback flags are DOM properties, not attributes, so an attribute
  // comparison alone misses them entirely -- which is exactly how Mute and Loop
  // came to be applied by the full render and not by the patch path.
  const tag = fresh.tagName.toLowerCase();
  if (tag === 'video' || tag === 'audio') {
    for (const property of ['muted', 'loop', 'controls', 'playsInline'] as const) {
      const liveValue = String((live as HTMLMediaElement & { playsInline?: boolean })[property]);
      const freshValue = String((fresh as HTMLMediaElement & { playsInline?: boolean })[property]);
      if (liveValue === freshValue) continue;
      out.push({ elementId, path, property: `.${property}`, live: liveValue, fresh: freshValue });
    }
  }

  for (const name of new Set([...live.getAttributeNames(), ...fresh.getAttributeNames()])) {
    if (name === 'style' || name === 'class') continue;
    if (IGNORED_ATTRIBUTES.has(name)) continue;
    const liveValue = live.getAttribute(name) ?? '';
    const freshValue = fresh.getAttribute(name) ?? '';
    if (liveValue === freshValue) continue;
    out.push({ elementId, path, property: `@${name}`, live: liveValue, fresh: freshValue });
  }
}

function styleMap(node: Element): Map<string, string> {
  const style = (node as HTMLElement).style;
  const map = new Map<string, string>();
  if (!style) return map;
  for (let i = 0; i < style.length; i += 1) {
    const property = style.item(i);
    map.set(property, style.getPropertyValue(property).trim());
  }
  return map;
}

/**
 * Values that mean the same thing but are spelled differently by the two paths
 * -- an unset property versus an empty string, colour and number formatting.
 */
function normalizeValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/"/g, "'");
}

function describe(node: Element): string {
  const tag = node.tagName.toLowerCase();
  const first = node.classList[0];
  return first ? `${tag}.${first}` : tag;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}
