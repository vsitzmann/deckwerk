import {
  AGENT_PROTOCOL_VERSION,
  applyAgentTransaction,
  canonicalDeckJson,
  type AgentContextDraft,
  type AgentRequest,
  type AgentResponse,
  type ComputedElementScene,
  type ComputedSlideScene,
} from '@shared/agent.js';
import type { Deck, Slide, SlideElement } from '@shared/deck.js';
import { fitAutoText, renderSlide } from '../player/render.js';
import { sameSlideIgnoringNotes, type EditorStore } from './store.js';

const COMPUTED_PROPERTIES = [
  'color', 'background-color', 'font-family', 'font-size', 'font-weight',
  'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration',
  'border-color', 'border-width', 'border-radius', 'filter', 'object-fit',
  'display', 'justify-content', 'align-items', 'overflow',
] as const;

export interface AgentBridgeOptions {
  publish: (context: AgentContextDraft) => Promise<void>;
  respond: (response: AgentResponse) => void;
  save: () => Promise<void>;
  resolveSrc: (src: string) => string;
  /** Compile and apply an authoring file the way a watched save does. */
  syncHtml?: (edit: { path: string; contents: string; after?: string | null; label?: string }) => Promise<HtmlSyncOutcome>;
}

/** What one authoring-file sync did, as reported back to the caller. */
export interface HtmlSyncOutcome {
  changes: { replaced: string[]; inserted: string[]; deleted: string[]; moved: number };
  slides: Array<{ id: string; elements: Array<{ id: string; type: string; box: { x: number; y: number; w: number; h: number } }> }>;
  warnings: string[];
  message: string;
}

/** Publishes the editor's live, computed selection through the file-backed main-process bridge. */
export class AgentBridge {
  private store: EditorStore;
  private options: AgentBridgeOptions;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The last measurement and what it was measured from. Measuring mounts a
   * full copy of every selected slide, images included, in a hidden host.
   * Done after each keystroke in the speaker notes drawer, that copy evicted
   * the GPU's decoded images and every sidebar thumbnail flashed blank while
   * it decoded again — so a publish whose picture has not changed reuses the
   * scenes it already has.
   */
  private lastMeasured: {
    slides: Array<{ slide: Slide; index: number }>;
    activeSlideIndex: number;
    selectionKey: string;
    canvas: Deck['canvas'];
    scenes: ComputedSlideScene[];
  } | null = null;

  constructor(store: EditorStore, options: AgentBridgeOptions) {
    this.store = store;
    this.options = options;
    store.subscribe(() => this.schedule());
    document.fonts?.ready.then(() => this.schedule());
    this.schedule();
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.publish();
    }, 140);
  }

  /** Publish now rather than on the debounce, for tests and for shutdown. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.publish();
  }

  async handle(request: AgentRequest): Promise<void> {
    const deck = this.store.get().deck;
    const revision = await browserDeckRevision(deck);
    if (request.kind === 'htmlSync') {
      try {
        if (!this.options.syncHtml) throw new Error('This editor cannot compile authoring files');
        const outcome = await this.options.syncHtml({
          // Undefined appends; null is an explicit "before the first slide".
          path: request.path, contents: request.contents, after: request.after, label: request.label,
        });
        this.options.respond({
          version: AGENT_PROTOCOL_VERSION,
          id: request.id,
          status: 'applied',
          revision: await browserDeckRevision(this.store.get().deck),
          payload: outcome,
        });
      } catch (error) {
        this.options.respond({
          version: AGENT_PROTOCOL_VERSION,
          id: request.id,
          status: 'error',
          revision,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (request.kind === 'transaction') {
      if (request.transaction.expectedRevision !== revision) {
        this.options.respond({
          version: AGENT_PROTOCOL_VERSION,
          id: request.id,
          status: 'conflict',
          revision,
          message: 'The deck changed after this transaction was prepared',
        });
        return;
      }
      try {
        const next = applyAgentTransaction(deck, request.transaction);
        this.store.replaceWithHistory(next, request.transaction.label);
        await this.options.save();
        const nextRevision = await browserDeckRevision(this.store.get().deck);
        this.options.respond({
          version: AGENT_PROTOCOL_VERSION,
          id: request.id,
          status: 'applied',
          revision: nextRevision,
        });
      } catch (error) {
        this.options.respond({
          version: AGENT_PROTOCOL_VERSION,
          id: request.id,
          status: 'error',
          revision,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (request.expectedRevision !== revision) {
      this.options.respond({
        version: AGENT_PROTOCOL_VERSION,
        id: request.id,
        status: 'conflict',
        revision,
        message: 'The deck changed before DOM inspection completed',
      });
      return;
    }
    try {
      const state = this.store.get();
      const slides = state.deck.slides.filter((slide) => state.slideSelection.has(slide.id));
      const payload = await buildInlineDom(
        state.deck,
        slides,
        state.selection,
        this.options.resolveSrc,
      );
      this.options.respond({
        version: AGENT_PROTOCOL_VERSION,
        id: request.id,
        status: 'ok',
        revision,
        payload,
      });
    } catch (error) {
      this.options.respond({
        version: AGENT_PROTOCOL_VERSION,
        id: request.id,
        status: 'error',
        revision,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async publish(): Promise<void> {
    const state = this.store.get();
    if (!state.dir) return;
    try {
      const selectedSlides = state.deck.slides
        .map((slide, index) => ({ slide, index }))
        .filter(({ slide }) => state.slideSelection.has(slide.id));
      const selectionKey = [...state.selection].sort().join(',');
      const canvas = state.deck.canvas;
      const previous = this.lastMeasured;
      const reusable = previous !== null
        && previous.activeSlideIndex === state.slideIndex
        && previous.selectionKey === selectionKey
        && previous.canvas.w === canvas.w
        && previous.canvas.h === canvas.h
        && previous.slides.length === selectedSlides.length
        && previous.slides.every((entry, i) => entry.index === selectedSlides[i].index
          && sameSlideIgnoringNotes(entry.slide, selectedSlides[i].slide));
      const scenes = reusable
        ? previous.scenes
        : await buildComputedScenes(
          state.deck,
          selectedSlides,
          state.slideIndex,
          state.slideSelection,
          state.selection,
          this.options.resolveSrc,
        );
      this.lastMeasured = {
        slides: selectedSlides,
        activeSlideIndex: state.slideIndex,
        selectionKey,
        canvas,
        scenes,
      };
      await this.options.publish({
        version: AGENT_PROTOCOL_VERSION,
        deckRevision: await browserDeckRevision(state.deck),
        activeSlideId: state.deck.slides[state.slideIndex]?.id ?? null,
        activeSlideIndex: state.slideIndex,
        selectedSlideIds: state.deck.slides
          .filter((slide) => state.slideSelection.has(slide.id))
          .map((slide) => slide.id),
        selectedElementIds: [...state.selection],
        scenes,
      });
    } catch (error) {
      console.warn('Could not publish agent context:', error);
    }
  }
}

// Decks are immutable store values: any authored mutation installs a new deck
// object, while navigation and selection keep the same one. Cache the expensive
// validate/stringify/SHA work across those view-only updates.
const deckRevisionCache = new WeakMap<Deck, Promise<string>>();

export async function browserDeckRevision(deck: Deck): Promise<string> {
  const cached = deckRevisionCache.get(deck);
  if (cached) return cached;
  const calculating = (async () => {
    const bytes = new TextEncoder().encode(canonicalDeckJson(deck));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  })();
  deckRevisionCache.set(deck, calculating);
  try {
    return await calculating;
  } catch (error) {
    deckRevisionCache.delete(deck);
    throw error;
  }
}

export async function buildComputedScenes(
  deck: Deck,
  slides: Array<{ slide: Slide; index: number }>,
  activeSlideIndex: number,
  selectedSlideIds: Set<string>,
  selectedElementIds: Set<string>,
  resolveSrc: (src: string) => string,
): Promise<ComputedSlideScene[]> {
  const output: ComputedSlideScene[] = [];
  for (const { slide, index } of slides) {
    const { host, root } = mountSlide(deck, slide, resolveSrc);
    fitAutoText(root);
    // Allow layout, fonts and media wrappers to settle before measuring.
    await nextFrame();
    const rootRect = root.getBoundingClientRect();
    const nodes = elementNodes(root);
    output.push({
      id: slide.id,
      index,
      name: slide.name,
      active: index === activeSlideIndex,
      selected: selectedSlideIds.has(slide.id),
      canvas: deck.canvas,
      background: slide.background,
      layout: slide.layout ?? 'freeform',
      morphFromPrevious: slide.morphFromPrevious ?? false,
      morphDuration: slide.morphDuration ?? 1000,
      skipped: slide.skipped ?? false,
      timeline: structuredClone(slide.timeline),
      elements: slide.elements.map((element) => computedElement(
        element,
        nodes.get(element.id) ?? null,
        rootRect,
        selectedElementIds,
      )),
    });
    host.remove();
  }
  return output;
}

async function buildInlineDom(
  deck: Deck,
  slides: Slide[],
  selectedElementIds: Set<string>,
  resolveSrc: (src: string) => string,
): Promise<Array<{ slideId: string; html: string }>> {
  const result: Array<{ slideId: string; html: string }> = [];
  for (const slide of slides) {
    const { host, root } = mountSlide(deck, slide, resolveSrc);
    fitAutoText(root);
    await nextFrame();
    for (const node of root.querySelectorAll<HTMLElement>('*')) {
      const style = getComputedStyle(node);
      let inline = '';
      // Indexed access rather than iteration: `CSSStyleDeclaration` is only
      // iterable in real browsers, and this same code runs under jsdom in tests.
      for (let i = 0; i < style.length; i++) {
        const property = style.item(i);
        inline += `${property}:${style.getPropertyValue(property)};`;
      }
      node.setAttribute('style', inline);
    }
    const nodes = elementNodes(root);
    for (const id of selectedElementIds) {
      nodes.get(id)?.setAttribute('data-agent-selected', 'true');
    }
    result.push({ slideId: slide.id, html: root.outerHTML });
    host.remove();
  }
  return result;
}

function mountSlide(deck: Deck, slide: Slide, resolveSrc: (src: string) => string) {
  const host = document.createElement('div');
  host.className = 'agent-measure-host';
  Object.assign(host.style, {
    position: 'fixed', left: '-100000px', top: '0', width: `${deck.canvas.w}px`,
    height: `${deck.canvas.h}px`, visibility: 'hidden', pointerEvents: 'none',
  });
  const root = renderSlide(slide, { resolveSrc, mediaPreload: 'metadata' });
  root.style.width = `${deck.canvas.w}px`;
  root.style.height = `${deck.canvas.h}px`;
  host.appendChild(root);
  document.body.appendChild(host);
  return { host, root };
}

/**
 * Index the rendered nodes by element id in one pass.
 *
 * Deliberately not `querySelector('[data-element-id="…"]')`: deck ids are
 * arbitrary strings, so that route needs `CSS.escape`, which is one more thing
 * to be wrong about — and it is quadratic over a busy slide besides.
 */
function elementNodes(root: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  for (const node of root.querySelectorAll<HTMLElement>('[data-element-id]')) {
    const id = node.dataset.elementId;
    if (id !== undefined && !map.has(id)) map.set(id, node);
  }
  return map;
}

function computedElement(
  element: SlideElement,
  node: HTMLElement | null,
  rootRect: DOMRect,
  selectedIds: Set<string>,
): ComputedElementScene {
  const rect = node?.getBoundingClientRect();
  const content = node?.querySelector<HTMLElement>('.text-content') ?? null;
  const body = node?.querySelector<HTMLElement>('.text-body') ?? null;
  // Typography is split across the wrapper (font, colour), the body (alignment)
  // and the content (the fitted size), so the resolved answer to "what does
  // this text look like" is the three layers merged outwards-in.
  const computedStyle: Record<string, string> = {};
  for (const layer of [node, body, content]) {
    if (!layer) continue;
    const layerStyle = getComputedStyle(layer);
    for (const property of COMPUTED_PROPERTIES) {
      const value = layerStyle.getPropertyValue(property);
      if (value) computedStyle[property] = value;
      else computedStyle[property] ??= '';
    }
  }
  return {
    id: element.id,
    type: element.type,
    selected: selectedIds.has(element.id),
    authored: {
      x: element.x, y: element.y, w: element.w, h: element.h,
      rot: element.rot, z: element.z, opacity: element.opacity,
    },
    rendered: rect ? {
      x: rect.left - rootRect.left,
      y: rect.top - rootRect.top,
      w: rect.width,
      h: rect.height,
    } : null,
    computedStyle,
    text: element.type === 'text' ? {
      html: element.html,
      plain: htmlToPlainText(element.html),
      fittedFontSize: content?.dataset.fittedFontSize
        ? Number(content.dataset.fittedFontSize)
        : null,
      overflowX: Boolean(content && body && content.scrollWidth > body.clientWidth + 0.5),
      overflowY: Boolean(content && body && content.scrollHeight > body.clientHeight + 0.5),
    } : null,
    media: element.type === 'image' || element.type === 'video' ? {
      src: element.src,
      fit: element.fit,
      sourceBox: element.sourceBox,
      effects: element.effects ?? [],
      borderColor: element.borderColor ?? null,
      borderWidth: element.borderWidth ?? 0,
      borderRadius: element.borderRadius ?? 0,
      duration: element.type === 'video' && element.end !== null
        ? Math.max(0, element.end - element.start)
        : null,
    } : null,
    shape: element.type === 'shape' ? {
      kind: element.shape,
      stroke: element.stroke,
      fill: element.fill,
      strokeWidth: element.strokeWidth,
      arrowStart: element.arrowStart,
      arrowEnd: element.arrowEnd,
      control: element.control ?? null,
      path: element.path,
    } : null,
    morphId: element.morphId ?? null,
    lineageId: element.lineageId ?? null,
  };
}

function htmlToPlainText(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
