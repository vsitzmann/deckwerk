import { openContextMenu } from './contextMenuPlacement.js';
import { makeId } from '@shared/geometry.js';
import { recoverPreviewFrames } from '../player/previewFrameRecovery.js';
import { freezePreviewVideos, releasePreviewVideos } from '../player/previewPoster.js';
import { renderSlide } from '../player/render.js';
import { applyDeckThemeToNewSlide } from '@shared/themes.js';
import { LAYOUT_LABELS_BY_ID } from './layoutPreview.js';
import { LAYOUT_LABELS, applySlideLayout, type SlideLayout } from './slideLayouts.js';
import { newComment, openCommentsPopover, openCount } from './comments.js';
import type { Deck, Slide } from '@shared/deck.js';
import { sameSlideIgnoringNotes, type EditorStore } from './store.js';
import { showConfirmDialog } from './confirmDialog.js';

/**
 * The slide list. Text-first rather than thumbnail-first: rendering live
 * thumbnails of video-heavy slides would mean decoding every clip in the deck
 * at once, which is exactly the cost this tool exists to avoid.
 */
/** Rendered width of a slide thumbnail, in CSS pixels. */
const THUMB_WIDTH = 168;
/** Enough decoded thumbnails for the viewport plus generous scroll overscan. */
const THUMB_CACHE_LIMIT = 40;

interface MenuItem {
  label: string;
  action?: () => void;
  /** A non-interactive section label rather than a command. */
  heading?: boolean;
  /** Present for a radio-style row; true draws its tick. */
  checked?: boolean;
}

/**
 * 1-based slide numbers as a reader says them: runs collapse to ranges, so
 * [3, 4, 5, 8] reads "3–5, 8".
 */
export function slideNumbersLabel(indices: readonly number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let at = 0; at < sorted.length;) {
    let end = at;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    parts.push(end === at ? `${sorted[at] + 1}` : `${sorted[at] + 1}–${sorted[end] + 1}`);
    at = end + 1;
  }
  return parts.join(', ');
}

function undoShortcutLabel(): string {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform ?? '';
  return /Mac|iPhone|iPad/i.test(platform) ? '⌘Z' : 'Ctrl+Z';
}

export interface RailPresence {
  name: string;
  color: string;
  selectedElementIds: string[];
}

export class SlideRail {
  private host: HTMLElement;
  private store: EditorStore;
  /** Keeps cached slide surfaces scaled to the fluid thumbnail frame. */
  private thumbResizeObserver: ResizeObserver | null = null;
  /** Mount full slide DOM only near the scroll viewport. */
  private thumbVisibilityObserver: IntersectionObserver | null = null;
  private pendingThumbs = new WeakMap<HTMLElement, { deck: Deck; slide: Slide }>();
  /** Index of the slide being dragged, while a reorder is in progress. */
  private dragFrom: number | null = null;
  /** Off-screen node used as the drag image while reordering. */
  private dragImage: HTMLElement | null = null;
  /** The slides array last drawn, so a selection change can skip the rebuild. */
  private renderedSlides: unknown = null;
  /** Selection chrome last applied to rows; ordinary navigation updates its delta only. */
  private highlightedSlideIndex = -1;
  private highlightedSelection = new Set<string>();
  private rowBySlideId = new Map<string, HTMLElement>();
  /**
   * Row DOM cached per slide object and position, like `thumbCache`. A rebuild
   * keeps every row whose slide and index are unchanged attached exactly where
   * it is: detaching a row, even for a moment, makes Chromium re-decode the
   * images in its thumbnail, which showed as every thumbnail flashing white on
   * each drop and each keystroke in the notes drawer.
   */
  private rowCache = new Map<Slide, { row: HTMLElement; index: number }>();
  /** The slide object last drawn for each id, so a note edit can keep its row and thumbnail. */
  private slideById = new Map<string, Slide>();
  /**
   * Thumbnail DOM cached per slide *object*. The store clones the deck on
   * every commit but untouched slides keep their object identity, so only the
   * edited slide's thumbnail is rebuilt. Rebuilding all of them recreated
   * every <video> in the rail on every edit — none of which had loaded a frame
   * yet, so the previews went black.
   */
  private thumbCache = new Map<unknown, HTMLElement>();
  /**
   * Runs of consecutive hidden slides the user has expanded, keyed by the id
   * of the run's first slide. Runs of two or more hidden slides collapse into
   * a single placeholder by default; expanding is an explicit, per-run choice
   * that survives re-renders but not a reload.
   */
  private expandedRuns = new Set<string>();
  /**
   * The active hidden slide whose run the user explicitly collapsed.
   *
   * Normally selecting a hidden slide auto-expands its run so the rail never
   * loses the selection. The collapse bracket is an explicit exception: keep
   * editing that slide even though its row is now represented by the run
   * placeholder. Selecting another slide clears the exception.
   */
  private collapsedActiveSlideId: string | null = null;
  /**
   * Collaboration presence: who is on which slide, drawn as colored dots on
   * the rail rows. Unset outside collab sessions.
   */
  presenceForSlide?: (slideId: string) => RailPresence[];
  /** Runs for an explicit thumbnail pick, including the already-active slide. */
  onSlideActivate?: (slideIndex: number) => void;
  /** The shell's status bar: what a slide command just did. */
  onStatus?: (message: string) => void;
  /** A keyboard deletion waiting on its confirmation dialog. */
  private confirmingDelete = false;

  constructor(host: HTMLElement, store: EditorStore) {
    this.host = host;
    this.store = store;
    if (typeof ResizeObserver !== 'undefined') {
      this.thumbResizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) this.scaleThumb(entry.target as HTMLElement);
        // Remote-selection boxes share the thumbnail's scale, so they must
        // track the frame without forcing its cached slide DOM to be rebuilt.
        this.refreshPresence();
      });
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.thumbVisibilityObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          const pending = this.pendingThumbs.get(target);
          if (!pending || !target.isConnected) {
            this.thumbVisibilityObserver?.unobserve(target);
            continue;
          }
          if (target.classList.contains('rail-thumb-placeholder')) {
            if (!entry.isIntersecting) continue;
            this.thumbVisibilityObserver?.unobserve(target);
            const thumb = this.thumbFor(pending.deck, pending.slide);
            target.replaceWith(thumb);
            this.watchMountedThumb(thumb, pending.deck, pending.slide);
            continue;
          }
          if (entry.isIntersecting || target.closest('.rail-item.active')) continue;
          // IntersectionObserver originally upgraded placeholders but never
          // demoted surfaces that left its overscan. Walking a long deck could
          // therefore mount every thumbnail despite the 40-entry cache. Keep
          // the decoded DOM in that bounded cache, but return the connected row
          // to a geometry-only shell until it comes near the viewport again.
          this.thumbVisibilityObserver?.unobserve(target);
          // An uncaptured preview video is not useful cached state: it retains
          // Chromium's large internal media subtree and often never reaches a
          // frame after detachment. Drop that surface entirely; promotion can
          // build a fresh gated preview if the row comes back.
          if (target.querySelector('video')) {
            this.thumbCache.delete(pending.slide);
            this.thumbResizeObserver?.unobserve(target);
            releasePreviewVideos(target);
          }
          target.replaceWith(this.thumbPlaceholder(pending.deck, pending.slide));
        }
        this.refreshPresence();
      }, { root: this.host, rootMargin: '400px 0px' });
    }
    store.subscribe(() => this.onStoreChange());
    this.bindKeys();
    this.render();
  }

  /**
   * Redraw only what changed.
   *
   * Rebuilding the rail recreates every thumbnail, which tears down and
   * reloads each slide's media — the visible symptom being every video in the
   * sidebar flickering on any click, and vanishing during a drag. A selection
   * change only needs the highlight moved.
   */
  private onStoreChange(): void {
    const { deck, slideIndex, slideSelection } = this.store.get();
    const activeSlide = deck.slides[slideIndex];
    if (
      this.collapsedActiveSlideId !== null
      && (activeSlide?.id !== this.collapsedActiveSlideId || !activeSlide.skipped)
    ) {
      this.collapsedActiveSlideId = null;
    }
    // Pointer movement replaces the active slide on every frame. Rebuilding
    // the rail for those transient values detaches every thumbnail, briefly
    // blanking the whole sidebar. Keep the last committed previews mounted;
    // endTransaction emits once more after the gesture finishes.
    if (this.store.isTransactionActive()) {
      this.highlight(slideIndex, slideSelection);
      return;
    }
    if (deck.slides === this.renderedSlides) {
      this.highlight(slideIndex, slideSelection);
      return;
    }
    this.render();
  }

  private highlight(slideIndex: number, slideSelection: Set<string>): void {
    // Selecting a slide inside a collapsed run (keyboard navigation, agent
    // edits) must reveal it — its row doesn't exist until the run expands.
    if (!this.host.querySelector(`.rail-item[data-index="${slideIndex}"]`)) {
      this.render();
      return;
    }
    // The store emits for every keystroke in the notes drawer and for every
    // frame of a drag. Re-setting the active row's attributes and scrolling it
    // into view each time invalidates the rail's paint, and with a deck full
    // of large images that repaint shows the thumbnails blank while their
    // pictures decode again. Nothing to do when the highlight is unchanged.
    if (
      slideIndex === this.highlightedSlideIndex
      && slideSelection.size === this.highlightedSelection.size
      && [...slideSelection].every((id) => this.highlightedSelection.has(id))
    ) {
      return;
    }
    const changedIds = new Set<string>();
    for (const id of this.highlightedSelection) {
      if (!slideSelection.has(id)) changedIds.add(id);
    }
    for (const id of slideSelection) {
      if (!this.highlightedSelection.has(id)) changedIds.add(id);
    }
    const rows = new Set<HTMLElement>();
    for (const index of [this.highlightedSlideIndex, slideIndex]) {
      if (index < 0) continue;
      const row = this.host.querySelector<HTMLElement>(`.rail-item[data-index="${index}"]`);
      if (row) rows.add(row);
    }
    for (const id of changedIds) {
      const row = this.rowBySlideId.get(id);
      if (row) rows.add(row);
    }
    const deck = this.store.get().deck;
    for (const item of rows) {
      const index = Number(item.dataset.index);
      const active = index === slideIndex;
      const slide = deck.slides[index];
      const selected = Boolean(slide && slideSelection.has(slide.id));
      item.classList.toggle('active', active);
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-selected', String(selected));
      if (active) item.scrollIntoView({ block: 'nearest' });
    }
    this.highlightedSlideIndex = slideIndex;
    this.highlightedSelection = new Set(slideSelection);
  }

  /** Show or hide the per-slide layout captions; the Design tab turns them on. */
  setDesignLabels(on: boolean): void {
    this.host.classList.toggle('rail-design-labels', on);
  }

  render(): void {
    const { deck, slideIndex, slideSelection } = this.store.get();
    this.renderedSlides = deck.slides;
    this.highlightedSlideIndex = slideIndex;
    this.highlightedSelection = new Set(slideSelection);
    this.thumbVisibilityObserver?.disconnect();
    this.rowBySlideId.clear();
    this.rekeyNoteOnlyChanges(deck);
    // Drop cache entries for slides that no longer exist in this deck version.
    const live = new Set<unknown>(deck.slides);
    for (const key of this.thumbCache.keys()) {
      if (!live.has(key)) {
        const thumb = this.thumbCache.get(key);
        if (thumb) {
          this.thumbResizeObserver?.unobserve(thumb);
          releasePreviewVideos(thumb);
        }
        this.thumbCache.delete(key);
      }
    }
    for (const key of this.rowCache.keys()) {
      if (!live.has(key)) this.rowCache.delete(key);
    }
    const children: HTMLElement[] = [];

    // Group consecutive hidden slides: runs of 2+ collapse to one placeholder
    // unless expanded. A run holding the active slide normally stays expanded;
    // an explicit bracket click may hide that row while preserving the editor.
    for (let i = 0; i < deck.slides.length; ) {
      if (!deck.slides[i].skipped) {
        children.push(this.buildItem(deck, i, slideIndex, slideSelection));
        i += 1;
        continue;
      }
      let end = i;
      while (end + 1 < deck.slides.length && deck.slides[end + 1].skipped) end += 1;
      if (end === i) {
        children.push(this.buildItem(deck, i, slideIndex, slideSelection));
        i += 1;
        continue;
      }
      const runKey = deck.slides[i].id;
      const containsActive = slideIndex >= i && slideIndex <= end;
      const explicitlyCollapsed = containsActive
        && deck.slides[slideIndex]?.id === this.collapsedActiveSlideId;
      if (!this.expandedRuns.has(runKey) && (!containsActive || explicitlyCollapsed)) {
        children.push(this.buildCollapsedRun(deck, i, end, runKey, slideSelection));
      } else {
        this.expandedRuns.add(runKey);
        children.push(this.buildExpandedRun(deck, i, end, runKey, slideIndex, slideSelection));
      }
      i = end + 1;
    }

    const actions = document.createElement('div');
    actions.className = 'rail-actions';
    actions.append(
      railButton('+ Slide', () => this.addSlide()),
      railButton('Duplicate', () => this.duplicateSlide()),
      railButton(
        deck.slides[slideIndex]?.skipped ? 'Show' : 'Hide',
        () => this.toggleHidden(),
      ),
      railButton('Delete', () => this.deleteSlide()),
    );
    children.push(actions);
    this.patchChildren(children);
  }

  /**
   * Bring the host's children to `nodes` with the fewest moves: a node already
   * in place is not touched, a node no longer wanted is removed, and only new
   * or reordered nodes are inserted. Rows kept from the previous render never
   * leave the document, so their thumbnails keep their decoded pictures.
   */
  private patchChildren(nodes: HTMLElement[]): void {
    const wanted = new Set<Element>(nodes);
    for (let k = 0; k < nodes.length; k++) {
      let current: Element | null = this.host.children[k] ?? null;
      while (current && !wanted.has(current)) {
        const next: Element | null = current.nextElementSibling;
        current.remove();
        current = next;
      }
      if (current !== nodes[k]) this.host.insertBefore(nodes[k], current);
    }
    while (this.host.children.length > nodes.length) this.host.lastElementChild?.remove();
  }

  /**
   * A speaker-note edit hands out a new slide object that draws the same
   * picture. Move that slide's cached row and thumbnail over to the new object
   * so the rebuild treats it as unchanged.
   */
  private rekeyNoteOnlyChanges(deck: Deck): void {
    for (const slide of deck.slides) {
      const previous = this.slideById.get(slide.id);
      if (previous && previous !== slide && sameSlideIgnoringNotes(previous, slide)) {
        const thumb = this.thumbCache.get(previous);
        if (thumb) {
          this.thumbCache.delete(previous);
          this.thumbCache.set(slide, thumb);
        }
        const row = this.rowCache.get(previous);
        if (row) {
          this.rowCache.delete(previous);
          this.rowCache.set(slide, row);
        }
      }
    }
    this.slideById = new Map(deck.slides.map((slide) => [slide.id, slide]));
  }

  /** Bring a kept row's selection chrome up to date without touching what is unchanged. */
  private syncRowState(item: HTMLElement, active: boolean, selected: boolean): void {
    if (item.classList.contains('active') !== active) item.classList.toggle('active', active);
    if (item.classList.contains('selected') !== selected) item.classList.toggle('selected', selected);
    if (item.getAttribute('aria-selected') !== String(selected)) {
      item.setAttribute('aria-selected', String(selected));
    }
  }

  /**
   * Placeholder row standing in for a collapsed run of hidden slides: a
   * normal-sized row whose thumbnail is the first hidden slide drawn as the
   * top card of a stack, so the collapsed run reads as "slides live here".
   */
  private buildCollapsedRun(
    deck: ReturnType<EditorStore['get']>['deck'],
    start: number,
    end: number,
    runKey: string,
    slideSelection: Set<string>,
  ): HTMLElement {
    const row = document.createElement('button');
    const selected = deck.slides
      .slice(start, end + 1)
      .some((slide) => slideSelection.has(slide.id));
    row.className = `rail-item rail-collapsed${selected ? ' selected' : ''}`;
    row.setAttribute('aria-selected', String(selected));
    row.title = `Show hidden slides ${start + 1}–${end + 1}`;

    const num = document.createElement('span');
    num.className = 'rail-num';
    num.textContent = `${start + 1}…${end + 1}`;

    const stack = document.createElement('div');
    stack.className = 'rail-stack';
    stack.style.setProperty('--rail-thumb-aspect', `${deck.canvas.w} / ${deck.canvas.h}`);
    stack.appendChild(this.thumbFor(deck, deck.slides[start]));

    const badge = document.createElement('span');
    badge.className = 'rail-skipped-badge';
    badge.textContent = `${end - start + 1} hidden`;

    row.append(num, stack, badge);
    // A collapsed run is also the only affordable target for selecting a
    // large hidden range. Shift-clicking it selects the represented run and
    // deliberately leaves the thumbnails folded.
    // Expanding a media-heavy suffix merely to select it can create dozens of
    // video surfaces at once and exhaust Chromium's renderer.
    row.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      this.collapsedActiveSlideId = deck.slides[end]?.id ?? null;
      this.store.selectSlideRange(start, end);
      this.host.focus({ preventScroll: true });
    });
    row.addEventListener('click', (event) => {
      // pointerdown above synchronously re-renders the row; keep this guard for
      // synthetic clicks and browsers that still dispatch the trailing click.
      if (event.shiftKey) return;
      this.expandedRuns.add(runKey);
      this.collapsedActiveSlideId = null;
      this.render();
    });
    return row;
  }

  /**
   * An expanded run of hidden slides: the rows themselves, with a bracket
   * along their left edge that collapses the run again when clicked.
   */
  private buildExpandedRun(
    deck: ReturnType<EditorStore['get']>['deck'],
    start: number,
    end: number,
    runKey: string,
    slideIndex: number,
    slideSelection: Set<string>,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'rail-run';
    const bracket = document.createElement('button');
    bracket.className = 'rail-run-bracket';
    bracket.title = `Collapse hidden slides ${start + 1}–${end + 1}`;
    bracket.setAttribute('aria-label', bracket.title);
    bracket.addEventListener('click', () => {
      this.expandedRuns.delete(runKey);
      if (slideIndex >= start && slideIndex <= end) {
        this.collapsedActiveSlideId = deck.slides[slideIndex]?.id ?? null;
      }
      this.render();
    });
    const col = document.createElement('div');
    col.className = 'rail-run-items';
    for (let i = start; i <= end; i += 1) {
      col.appendChild(this.buildItem(deck, i, slideIndex, slideSelection));
    }
    wrap.append(bracket, col);
    return wrap;
  }

  /**
   * A real miniature, cached by slide identity so untouched slides keep
   * their live DOM (and their already-decoded video frames) across edits.
   */
  private thumbFor(
    deck: ReturnType<EditorStore['get']>['deck'],
    slide: ReturnType<EditorStore['get']>['deck']['slides'][number],
  ): HTMLElement {
    let thumb = this.thumbCache.get(slide);
    if (thumb) {
      // Map insertion order is the LRU order.
      this.thumbCache.delete(slide);
      this.thumbCache.set(slide, thumb);
      // A cached thumbnail spends time detached while the rail rebuilds, and
      // the load gate aborts the fetch of a detached element. Re-queue
      // anything that came back without a frame rather than re-appending a
      // black box. See previewFrameRecovery.ts.
      recoverPreviewFrames(thumb);
    }
    if (!thumb) {
      thumb = document.createElement('div');
      thumb.className = 'rail-thumb';
      thumb.dataset.canvasWidth = String(deck.canvas.w);
      thumb.style.setProperty('--rail-thumb-aspect', `${deck.canvas.w} / ${deck.canvas.h}`);
      const inner = document.createElement('div');
      inner.className = 'rail-thumb-inner';
      inner.style.width = `${deck.canvas.w}px`;
      inner.style.height = `${deck.canvas.h}px`;
      if (slide.background.color) inner.style.background = slide.background.color;
      inner.appendChild(
        renderSlide(slide, { resolveSrc: (src) => window.api.assetUrl(src), mediaPreload: 'metadata', deferVideoSrc: true }),
      );
      for (const video of inner.querySelectorAll('video')) {
        video.removeAttribute('autoplay');
        // renderSlide's 'metadata' preload decodes exactly one poster frame,
        // so the thumbnail shows a picture without buffering the clip.
        video.pause();
      }
      // A thumbnail needs one frame, never playback, and a live <video> is
      // what makes it go black when the page is hidden, occluded or holding
      // more players than Chromium wants resident. Freeze it into a still.
      freezePreviewVideos(inner);
      thumb.appendChild(inner);
      this.scaleThumb(thumb);
      this.thumbResizeObserver?.observe(thumb);
      this.thumbCache.set(slide, thumb);
      if (this.thumbVisibilityObserver) this.trimThumbCache();
    }
    return thumb;
  }

  /** A geometry-only shell upgraded to a real slide when it nears the viewport. */
  private deferredThumb(
    deck: ReturnType<EditorStore['get']>['deck'],
    slide: Slide,
    eager: boolean,
  ): HTMLElement {
    if (eager || !this.thumbVisibilityObserver) {
      const thumb = this.thumbFor(deck, slide);
      this.watchMountedThumb(thumb, deck, slide);
      return thumb;
    }
    return this.thumbPlaceholder(deck, slide);
  }

  /** Geometry-only shell observed for promotion into a cached slide surface. */
  private thumbPlaceholder(deck: Deck, slide: Slide): HTMLElement {
    const placeholder = document.createElement('div');
    placeholder.className = 'rail-thumb rail-thumb-placeholder';
    placeholder.dataset.canvasWidth = String(deck.canvas.w);
    placeholder.style.setProperty('--rail-thumb-aspect', `${deck.canvas.w} / ${deck.canvas.h}`);
    this.pendingThumbs.set(placeholder, { deck, slide });
    this.thumbVisibilityObserver?.observe(placeholder);
    return placeholder;
  }

  /** Observe a real surface so it can be demoted after leaving overscan. */
  private watchMountedThumb(thumb: HTMLElement, deck: Deck, slide: Slide): void {
    if (!this.thumbVisibilityObserver) return;
    this.pendingThumbs.set(thumb, { deck, slide });
    this.thumbVisibilityObserver.observe(thumb);
  }

  private trimThumbCache(): void {
    while (this.thumbCache.size > THUMB_CACHE_LIMIT) {
      const oldest = this.thumbCache.entries().next().value as [unknown, HTMLElement] | undefined;
      if (!oldest) return;
      const [key, thumb] = oldest;
      this.thumbCache.delete(key);
      this.thumbResizeObserver?.unobserve(thumb);
      releasePreviewVideos(thumb);
    }
  }

  /** Scale the canonical slide surface into its current fluid-width frame. */
  private scaleThumb(thumb: HTMLElement): void {
    const canvasWidth = Number(thumb.dataset.canvasWidth);
    const inner = thumb.querySelector<HTMLElement>('.rail-thumb-inner');
    if (!inner || !Number.isFinite(canvasWidth) || canvasWidth <= 0) return;
    inner.style.transform = `scale(${this.thumbWidth(thumb) / canvasWidth})`;
  }

  private thumbWidth(thumb: HTMLElement): number {
    // jsdom and detached nodes have no layout; retain the historical width as
    // a stable fallback until ResizeObserver reports the on-screen frame.
    return thumb.clientWidth || thumb.getBoundingClientRect().width || THUMB_WIDTH;
  }

  /** Re-decorate presence in place, without invalidating thumbnails. */
  refreshPresence(): void {
    for (const dots of this.host.querySelectorAll<HTMLElement>('.rail-presence')) {
      const slideId = dots.dataset.slideId;
      if (slideId) this.paintPresence(dots, slideId);
    }
  }

  private paintPresence(container: HTMLElement, slideId: string): void {
    const peers = this.presenceForSlide?.(slideId) ?? [];
    // One shared tooltip naming everyone on the slide, on the group and on
    // each dot, so hovering anywhere over the cluster shows the full list.
    const names = peers.map((peer) => peer.name).join(', ');
    container.title = names;
    container.replaceChildren(...peers.map((peer) => {
      const dot = document.createElement('span');
      dot.className = 'rail-presence-dot';
      dot.style.background = peer.color;
      dot.title = names;
      return dot;
    }));

    const item = container.closest<HTMLElement>('.rail-item');
    const thumb = item?.querySelector<HTMLElement>('.rail-thumb');
    const { deck } = this.store.get();
    const index = Number(item?.dataset.index);
    const indexedSlide = Number.isInteger(index) ? deck.slides[index] : undefined;
    const slide = indexedSlide?.id === slideId ? indexedSlide : undefined;
    if (!thumb || !slide) return;

    let selections = thumb.querySelector<HTMLElement>('.rail-presence-selections');
    if (!selections) {
      selections = document.createElement('span');
      selections.className = 'rail-presence-selections';
      thumb.appendChild(selections);
    }

    const scale = this.thumbWidth(thumb) / deck.canvas.w;
    const byId = new Map(slide.elements.map((element) => [element.id, element]));
    const boxes: HTMLElement[] = [];
    for (const [peerIndex, peer] of peers.entries()) {
      for (const id of peer.selectedElementIds) {
        const element = byId.get(id);
        if (!element) continue;
        const box = document.createElement('span');
        box.className = 'rail-presence-selection';
        box.title = peer.name;
        box.style.cssText = [
          `left:${element.x * scale}px`,
          `top:${element.y * scale}px`,
          `width:${element.w * scale}px`,
          `height:${element.h * scale}px`,
          `transform:rotate(${element.rot}deg)`,
          `outline:2px solid ${peer.color}`,
          `outline-offset:${peerIndex * 2}px`,
          `background:color-mix(in srgb, ${peer.color} 14%, transparent)`,
        ].join(';');
        boxes.push(box);
      }
    }
    selections.replaceChildren(...boxes);
  }

  /** One slide row: number, cached thumbnail, hidden badge, handlers. */
  private buildItem(
    deck: ReturnType<EditorStore['get']>['deck'],
    i: number,
    slideIndex: number,
    slideSelection: Set<string>,
  ): HTMLElement {
    const slide = deck.slides[i];
    const cached = this.rowCache.get(slide);
    if (cached && cached.index === i && cached.row.parentElement === this.host) {
      // Same slide object at the same position: the row's listeners, comment
      // badge and hidden badge are all still right. Refresh only what the
      // store decides per render, and re-arm the visibility observer the
      // rebuild disconnected.
      const item = cached.row;
      this.rowBySlideId.set(slide.id, item);
      this.syncRowState(item, i === slideIndex, slideSelection.has(slide.id));
      const thumb = item.querySelector<HTMLElement>(':scope > .rail-thumb');
      if (thumb) {
        this.pendingThumbs.set(thumb, { deck, slide });
        this.thumbVisibilityObserver?.observe(thumb);
      }
      const dots = item.querySelector<HTMLElement>(':scope > .rail-presence');
      if (dots) this.paintPresence(dots, slide.id);
      return item;
    }
    {
      const item = document.createElement('button');
      item.className = `rail-item${slideSelection.has(slide.id) ? ' selected' : ''}${i === slideIndex ? ' active' : ''}${slide.skipped ? ' skipped' : ''}`;
      item.setAttribute('aria-selected', String(slideSelection.has(slide.id)));
      item.draggable = true;
      item.dataset.index = String(i);
      item.dataset.slideId = slide.id;
      this.rowBySlideId.set(slide.id, item);
      this.bindReorder(item, i);

      const num = document.createElement('span');
      num.className = 'rail-num';
      num.textContent = String(i + 1);

      const thumb = this.deferredThumb(deck, slide, i === slideIndex);
      item.append(num, thumb);
      // The slide's design facts, shown only while the Design tab is open
      // (see `setDesignLabels`): which layout it is on, and whether its
      // ground is its own rather than the theme's.
      const design = document.createElement('span');
      design.className = 'rail-design-label';
      const ownGround = slide.background.color !== null || slide.background.image !== null;
      design.textContent = `${LAYOUT_LABELS_BY_ID[(slide.layout ?? 'freeform') as keyof typeof LAYOUT_LABELS_BY_ID]}${ownGround ? ' · own background' : ''}`;
      item.appendChild(design);
      // Presence dots live on the row (not the cached thumbnail), in the left
      // gutter beside the slide's top edge. Rows are rebuilt fresh each time,
      // so no stale container can linger here.
      const dots = document.createElement('span');
      dots.className = 'rail-presence';
      dots.dataset.slideId = slide.id;
      item.appendChild(dots);
      this.paintPresence(dots, slide.id);
      if (slide.skipped) {
        const badge = document.createElement('span');
        badge.className = 'rail-skipped-badge';
        badge.textContent = 'Hidden';
        item.appendChild(badge);
      }
      // Comment affordance in the row's bottom-right corner: hidden until
      // hover when the slide has no comments, always visible (with the open
      // count) when it does. A <span>, not a <button> — the row itself is a
      // button and nesting them is invalid HTML.
      {
        const open = openCount(slide.comments);
        const bubble = document.createElement('span');
        bubble.className = `rail-comment${open > 0 ? ' has-comments' : ''}`;
        bubble.setAttribute('role', 'button');
        bubble.title = open > 0
          ? `${open} open comment${open === 1 ? '' : 's'}`
          : 'Add comment';
        bubble.textContent = open > 0 ? String(open) : '+';
        bubble.addEventListener('pointerdown', (e) => e.stopPropagation());
        bubble.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openComments(slide.id, i, bubble.getBoundingClientRect());
        });
        item.appendChild(bubble);
      }
      // Selection runs on pointerdown, not click: the row is draggable for
      // reorder, and Chromium starts a native drag on a few pixels of drift,
      // which suppresses the click entirely — every real (slightly wobbly)
      // click on a thumbnail then did nothing.
      item.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        // Shift extends a range from the anchor; Cmd/Ctrl picks or drops this
        // one row on its own, so a scattered set of slides can be deleted,
        // hidden or duplicated in one go.
        if (event.metaKey || event.ctrlKey) this.store.toggleSlideSelection(i);
        else this.store.selectSlide(i, event.shiftKey);
        this.onSlideActivate?.(i);
        // Picking slides makes the rail the active surface, so Backspace is a
        // slide command from here on. Without this the keystroke reaches the
        // window handler, which only knows about canvas objects, and selecting
        // slides then pressing Backspace appears to do nothing at all.
        this.host.focus({ preventScroll: true });
      });
      item.addEventListener('contextmenu', (event) => this.onContextMenu(event, i));
      this.rowCache.set(slide, { row: item, index: i });
      return item;
    }
  }

  /**
   * Right-click menu on a slide row. Shares the canvas menu's #ctx-menu
   * styling so the two menus read as one control.
   */
  private onContextMenu(ev: MouseEvent, index: number): void {
    ev.preventDefault();
    ev.stopPropagation();
    document.getElementById('ctx-menu')?.remove();

    // Right-clicking outside the current selection retargets it, matching how
    // the canvas menu (and every desktop list control) behaves.
    const { deck, slideSelection } = this.store.get();
    const slide = deck.slides[index];
    if (!slide) return;
    if (!slideSelection.has(slide.id)) this.store.selectSlide(index);
    this.host.focus({ preventScroll: true });

    const hidden = Boolean(this.store.get().deck.slides[index]?.skipped);
    // The layout rows mirror the Props tab's Preset picker. A tick marks the
    // layout every targeted slide already wears; a mixed selection shows none.
    const targeted = this.store.get().deck.slides
      .filter((s) => this.store.get().slideSelection.has(s.id));
    const layouts = new Set(targeted.map((s) => s.layout ?? 'freeform'));
    const current = layouts.size === 1 ? [...layouts][0] : null;
    const items: Array<MenuItem | 'separator'> = [
      { label: hidden ? 'Show slide' : 'Hide slide', action: () => this.toggleHidden() },
      'separator',
      { label: 'Add slide below', action: () => this.addSlide() },
      { label: 'Duplicate', action: () => this.duplicateSlide() },
      'separator',
      { label: 'Layout', heading: true },
      ...LAYOUT_LABELS.map(([layout, label]): MenuItem => ({
        label,
        checked: layout === current,
        action: () => this.applyLayout(layout, label),
      })),
      'separator',
      { label: 'Delete', action: () => this.deleteSlide() },
    ];

    const menu = document.createElement('div');
    menu.id = 'ctx-menu';
    for (const item of items) {
      if (item === 'separator') {
        const hr = document.createElement('div');
        hr.className = 'ctx-sep';
        menu.appendChild(hr);
        continue;
      }
      if (item.heading) {
        const heading = document.createElement('div');
        heading.className = 'ctx-heading';
        heading.textContent = item.label;
        menu.appendChild(heading);
        continue;
      }
      const row = document.createElement('button');
      row.textContent = item.label;
      if (item.checked !== undefined) {
        row.classList.add('ctx-check');
        row.setAttribute('role', 'menuitemradio');
        row.setAttribute('aria-checked', String(item.checked));
      }
      const action = item.action;
      row.addEventListener('click', () => {
        menu.remove();
        action?.();
      });
      menu.appendChild(row);
    }
    openContextMenu(menu, { x: ev.clientX, y: ev.clientY });
    // Same ordering fix as the canvas menu: a document-level pointerdown must
    // not tear the menu down before its row can receive the click.
    menu.addEventListener('pointerdown', (event) => event.stopPropagation());
    const close = () => menu.remove();
    setTimeout(() => document.addEventListener('pointerdown', close, { once: true }), 0);
  }

  /** Keyboard navigation and quick insertion while the rail has focus. */
  private bindKeys(): void {
    this.host.tabIndex = 0;
    this.host.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        // Suppress the focused button's synthetic click: Return inserts once.
        e.preventDefault();
        e.stopPropagation();
        this.addSlide();
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // When the rail or its active thumbnail owns focus, either deletion
        // key is a slide command. Stop it here so the window-level shortcut
        // cannot also delete a selected canvas object.
        e.preventDefault();
        e.stopPropagation();
        void this.deleteSlidesFromKeyboard();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      e.stopPropagation();
      const { slideIndex, deck } = this.store.get();
      // Arrow keys walk visible slides only: hidden slides (and collapsed
      // runs of them) are skipped, never revealed. Clicking is the only way
      // to select a hidden slide.
      const step = e.key === 'ArrowDown' ? 1 : -1;
      let next = slideIndex + step;
      while (next >= 0 && next < deck.slides.length && deck.slides[next].skipped) next += step;
      if (next < 0 || next >= deck.slides.length) return;
      this.store.selectSlide(next);
    });
  }

  /**
   * A compact "Slide N" chip standing in for the dragged row. It has to be in
   * the document and rendered when setDragImage runs, so it lives off-screen
   * until dragend.
   */
  private makeDragImage(index: number): HTMLElement {
    this.clearDragImage();
    const chip = document.createElement('div');
    chip.className = 'rail-drag-image';
    chip.textContent = `Slide ${index + 1}`;
    document.body.appendChild(chip);
    this.dragImage = chip;
    return chip;
  }

  private clearDragImage(): void {
    this.dragImage?.remove();
    this.dragImage = null;
  }

  /**
   * Drag a slide onto another to reorder.
   *
   * Uses native HTML drag-and-drop rather than pointer events: the rail is a
   * list, the drop target is a whole row, and the browser's own drop indicator
   * and auto-scrolling come free.
   */
  private bindReorder(item: HTMLElement, index: number): void {
    item.addEventListener('dragstart', (e) => {
      this.dragFrom = index;
      e.dataTransfer?.setData('text/plain', String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      // Chromium's default drag image for a row whose thumbnail is a
      // transform-scaled full-size slide surface ends up being a snapshot of
      // the whole window, so the entire UI appeared to follow the cursor in
      // the browser client. A small explicit drag image avoids the snapshot.
      if (e.dataTransfer) e.dataTransfer.setDragImage(this.makeDragImage(index), 12, 10);
      item.classList.add('dragging');
    });

    item.addEventListener('dragend', () => {
      this.dragFrom = null;
      this.clearDragImage();
      // The row's own marks come off here rather than being left to the
      // re-render: a drag that reordered nothing leaves every slide object
      // identical, so `render` reuses this very node from the row cache and
      // the dimming stayed on it for good. `dragend` fires however the drag
      // ended -- dropped, released over nothing, or cancelled with Escape.
      // The insertion marks belong to whichever row the pointer was last
      // over, which is not necessarily this one when a drag is cancelled.
      for (const row of this.host.querySelectorAll('.rail-item')) {
        row.classList.remove('dragging', 'drop-before', 'drop-after');
      }
      this.render();
    });

    item.addEventListener('dragover', (e) => {
      if (this.dragFrom === null || this.dragFrom === index) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      // Which half of the row the pointer is in decides whether the slide
      // lands before or after it.
      const r = item.getBoundingClientRect();
      item.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
      item.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drop-before', 'drop-after');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this.dragFrom;
      item.classList.remove('drop-before', 'drop-after');
      if (from === null || from === index) return;

      const r = item.getBoundingClientRect();
      const after = e.clientY >= r.top + r.height / 2;
      let to = after ? index + 1 : index;
      // Removing the dragged slide first shifts every later index down by one.
      if (from < to) to -= 1;

      this.dragFrom = null;
      if (to === from) return;

      this.store.commit((deck) => {
        const [moved] = deck.slides.splice(from, 1);
        deck.slides.splice(to, 0, moved);
      });
      this.store.selectSlide(to);
    });
  }

  /** Open the comments popover for a slide; edits commit like any other. */
  private openComments(slideId: string, index: number, anchor: DOMRect): void {
    const current = () =>
      this.store.get().deck.slides.find((s) => s.id === slideId)?.comments ?? [];
    const mutate = (label: string, fn: (slide: Slide) => void) => {
      this.store.commit((deck) => {
        const slide = deck.slides.find((s) => s.id === slideId);
        if (slide) fn(slide);
      }, { label });
      pop.refresh(current());
    };
    const pop = openCommentsPopover({
      anchor,
      title: `Comments — slide ${index + 1}`,
      comments: current(),
      onAdd: (text) => mutate('Add comment', (slide) => {
        (slide.comments ??= []).push(newComment(text));
      }),
      onResolve: (id, resolved) => mutate(resolved ? 'Resolve comment' : 'Reopen comment', (slide) => {
        const comment = slide.comments?.find((c) => c.id === id);
        if (comment) comment.resolved = resolved;
      }),
      onDelete: (id) => mutate('Delete comment', (slide) => {
        slide.comments = (slide.comments ?? []).filter((c) => c.id !== id);
        if (slide.comments.length === 0) delete slide.comments;
      }),
    });
  }

  /** Give every selected slide `layout`, as the Props tab's Preset picker does. */
  applyLayout(layout: SlideLayout, label: string): void {
    const selected = this.store.get().slideSelection;
    this.store.commit((deck) => {
      for (const slide of deck.slides) {
        if (selected.has(slide.id)) applySlideLayout(slide, layout, deck.layoutMasters);
      }
    }, { label: `Apply ${label} layout` });
  }

  addSlide(): void {
    const at = this.store.get().slideIndex + 1;
    this.store.commit((deck) => {
      const slide = blankSlide();
      deck.slides.splice(at, 0, slide);
      applySlideLayout(slide, 'standard', deck.layoutMasters);
      // Layout gives the slide its geometry; the deck's theme gives it its
      // voice, so a new slide never lands looking unthemed beside its siblings.
      applyDeckThemeToNewSlide(deck, at);
    }, { label: 'Add slide' });
    this.store.selectSlide(at);
  }

  duplicateSlide(): void {
    const { slideIndex } = this.store.get();
    this.store.commit((deck) => {
      const source = deck.slides[slideIndex];
      if (!source) return;
      const copy = structuredClone(source);
      copy.id = makeId('slide');
      copy.name = source.name ? `${source.name} copy` : '';
      // Fresh ids, or the duplicate's timeline would drive the original's
      // elements as well.
      const remap = new Map<string, string>();
      for (const el of copy.elements) {
        // Preserve ancestry independently from the fresh deck id. Auto-pair
        // can then recognize an edited duplicate without animating it until
        // the author explicitly asks for suggestions.
        el.lineageId = el.lineageId ?? el.id;
        const id = makeId(el.type);
        remap.set(el.id, id);
        el.id = id;
        // A duplicated slide starts with no Morph decisions. Auto-pair is
        // available in the dedicated panel when that is what the author wants.
        el.morphId = null;
      }
      copy.morphFromPrevious = false;
      for (const entry of copy.timeline) {
        entry.id = makeId('t');
        entry.action.target = remap.get(entry.action.target) ?? entry.action.target;
        if (entry.trigger.ref) {
          entry.trigger.ref = remap.get(entry.trigger.ref) ?? entry.trigger.ref;
        }
      }
      deck.slides.splice(slideIndex + 1, 0, copy);
    });
    this.store.selectSlide(slideIndex + 1);
  }

  /**
   * Toggle "skipped" for every slide selected in the rail.
   *
   * Hidden slides stay in the deck and remain editable; the player steps over
   * them when presenting. The current slide decides the direction, so a mixed
   * selection lands in one consistent state rather than inverting each slide.
   */
  toggleHidden(): void {
    const { deck, slideIndex, slideSelection } = this.store.get();
    const current = deck.slides[slideIndex];
    if (!current) return;
    const hide = !current.skipped;
    const ids = new Set(
      deck.slides.filter((s) => slideSelection.has(s.id)).map((s) => s.id),
    );
    if (ids.size === 0) ids.add(current.id);
    this.store.commit((d) => {
      for (const slide of d.slides) {
        if (ids.has(slide.id)) slide.skipped = hide ? true : undefined;
      }
    }, { label: hide ? 'Hide slide' : 'Show slide' });
  }

  /**
   * Delete every slide selected in the rail, not just the current one.
   *
   * A multi-slide selection is a single unit as far as the user is concerned,
   * so deleting it is one undo entry. A deck must keep at least one slide: a
   * selection covering the whole deck deletes all of it and lands on one
   * fresh blank slide, rather than silently refusing the keystroke.
   */
  deleteSlide(options: { ids?: ReadonlySet<string>; verb?: string } = {}): void {
    const { deck, slideIndex, slideSelection } = this.store.get();
    const chosen = options.ids ?? slideSelection;
    const doomed = deck.slides
      .map((slide, index) => ({ slide, index }))
      .filter(({ slide }) => chosen.has(slide.id));
    if (doomed.length === 0) return;
    // Nothing to gain from swapping the last slide for another empty one.
    if (deck.slides.length === 1) return;
    // Selecting the whole deck still has to leave a slide behind. The first
    // row stays put and is emptied in place rather than deleted and re-added:
    // the deck is never momentarily slide-less, which both the operation log
    // and the collaboration merge refuse to replay.
    const wholeDeck = doomed.length >= deck.slides.length;
    const survivor = wholeDeck ? doomed[0].slide.id : null;

    const ids = new Set(doomed.map(({ slide }) => slide.id));
    if (survivor) ids.delete(survivor);
    const first = Math.min(...doomed.map(({ index }) => index), slideIndex);
    this.store.commit((d) => {
      d.slides = d.slides.filter((slide) => !ids.has(slide.id));
      if (!survivor) return;
      const kept = { ...blankSlide(), id: survivor };
      d.slides[0] = kept;
      applySlideLayout(kept, 'standard', d.layoutMasters);
      applyDeckThemeToNewSlide(d, 0);
    }, { label: doomed.length === 1 ? 'Delete slide' : `Delete ${doomed.length} slides` });
    this.store.selectSlide(wholeDeck ? 0 : Math.max(0, first - 1));
    const numbers = slideNumbersLabel(doomed.map(({ index }) => index));
    const one = doomed.length === 1;
    this.onStatus?.(`${options.verb ?? 'Deleted'} slide${one ? '' : 's'} ${numbers}. `
      + `Undo (${undoShortcutLabel()}) restores ${one ? 'it' : 'them'}.`);
  }

  /**
   * Backspace/Delete with the rail focused. Focus stays on the rail after a
   * thumbnail is clicked, so a deletion key meant for text lands here, and a
   * multi-slide selection once vanished from a shared deck that way. More
   * than one slide therefore asks first; a single slide goes at once, as it
   * always has (and undo brings it back). The confirmation names exactly the
   * slides selected when the key was pressed, so a remote edit while the
   * dialog is open cannot widen what is deleted.
   */
  async deleteSlidesFromKeyboard(): Promise<void> {
    if (this.confirmingDelete) return;
    const { deck, slideSelection } = this.store.get();
    const doomed = deck.slides
      .map((slide, index) => ({ slide, index }))
      .filter(({ slide }) => slideSelection.has(slide.id));
    if (doomed.length <= 1) {
      this.deleteSlide();
      return;
    }
    const ids = new Set(doomed.map(({ slide }) => slide.id));
    const count = doomed.length;
    const numbers = slideNumbersLabel(doomed.map(({ index }) => index));
    this.confirmingDelete = true;
    try {
      const confirmed = await showConfirmDialog({
        title: `Delete ${count} slides?`,
        description: `Slides ${numbers} are selected. Undo (${undoShortcutLabel()}) brings them back.`,
        confirmLabel: `Delete ${count} slides`,
        destructive: true,
        returnFocus: this.host,
      });
      if (confirmed) this.deleteSlide({ ids });
    } finally {
      this.confirmingDelete = false;
    }
  }
}

/** An empty slide, before a layout and the deck's theme are applied to it. */
function blankSlide(): Slide {
  return {
    id: makeId('slide'),
    name: '',
    background: { color: null, image: null },
    notes: '',
    elements: [],
    timeline: [],
  };
}

function railButton(label: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
