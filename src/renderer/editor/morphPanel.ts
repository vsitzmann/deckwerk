import type { Slide } from '@shared/deck.js';
import { durationField } from './durationField.js';
import { MORPH_NAME } from '@shared/featureNames.js';
import { makeId } from '@shared/geometry.js';
import { explicitMorphPairs, suggestMorphPairs } from '@shared/morph.js';
import { recoverPreviewFrames } from '../player/previewFrameRecovery.js';
import { freezePreviewVideos } from '../player/previewPoster.js';
import { renderSlide } from '../player/render.js';
import { describeElement as describe, renderElementLabel } from './elementLabel.js';
import { sameSlideDrawing, type EditorStore } from './store.js';

const PREVIEW_WIDTH_FALLBACK = 560;

/**
 * A rendered preview surface, kept across re-renders.
 *
 * A `<video>` paints nothing until a frame is decoded, so a rebuilt preview is
 * black until its poster-frame seek lands again — and every pairing click
 * re-renders this panel. Caching the surface (and adopting decoded elements
 * when the slide itself changed) is the same "reconcile, don't rebuild" rule
 * the slide rail and editor canvas follow. See docs/media-loading.md.
 */
interface PreviewSurface {
  slide: Slide;
  canvasW: number;
  canvasH: number;
  frame: HTMLElement;
  surface: HTMLElement;
  observer: ResizeObserver | null;
}

/** Explicit Morph authoring between the selected slide and the next one. */
export class MorphPanel {
  private selectedSourceId: string | null = null;
  private message = '';
  /** Cached preview surfaces, keyed by side and compact/modal presentation. */
  private previews = new Map<string, PreviewSurface>();
  private modal: HTMLElement | null = null;
  private modalContent: HTMLElement | null = null;
  private onModalKeyDown = (event: KeyboardEvent) => {
    if (!this.modal?.isConnected) return;
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeModal();
    }
  };

  constructor(
    private host: HTMLElement,
    private store: EditorStore,
    subscribe = true,
  ) {
    if (subscribe) {
      store.subscribe(() => {
        const current = store.slide;
        if (!current?.elements.some((element) => element.id === this.selectedSourceId)) {
          this.selectedSourceId = null;
        }
        if (!this.host.closest('[hidden]')) this.render();
      });
      if (!this.host.closest('[hidden]')) this.render();
    }
  }

  /** Close any pairing UI when Props switches to object-specific controls. */
  dismiss(): void {
    this.closeModal();
  }

  render(): void {
    const { deck, slideIndex } = this.store.get();
    const selectedSlides = this.store.selectedSlides();
    if (selectedSlides.length > 1) {
      this.renderBulk(selectedSlides);
      return;
    }
    const current = deck.slides[slideIndex];
    const next = deck.slides[slideIndex + 1];
    this.host.replaceChildren();

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h4');
    title.className = 'insp-subtitle';
    title.textContent = MORPH_NAME;
    header.appendChild(title);
    this.host.appendChild(header);

    const duration = document.createElement('label');
    duration.className = 'field morph-duration';
    const durationLabel = document.createElement('span');
    durationLabel.textContent = 'Duration';
    const durationControl = durationField(
      next?.morphDuration ?? 1000,
      (ms) => {
        const value = Math.max(100, Math.min(5000, ms || 1000));
        this.store.commit((nextDeck) => {
          const destination = nextDeck.slides[slideIndex + 1];
          if (destination) destination.morphDuration = value;
        }, { label: `Change ${MORPH_NAME} duration` });
      },
      { inputClass: 'morph-duration-input', label: `${MORPH_NAME} duration`, disabled: !next },
    );
    duration.append(durationLabel, durationControl);
    this.host.appendChild(duration);

    const easing = document.createElement('label');
    easing.className = 'field morph-easing';
    const easingLabel = document.createElement('span');
    easingLabel.textContent = 'Motion curve';
    const easingSelect = document.createElement('select');
    for (const [value, text] of [
      ['ease-in-out', 'Smooth (ease in-out)'],
      ['ease-out', 'Snappy (ease out)'],
      ['linear', 'Linear'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      easingSelect.appendChild(option);
    }
    easingSelect.value = deck.morphEasing;
    easingSelect.addEventListener('change', () => {
      const value = easingSelect.value as typeof deck.morphEasing;
      this.store.commit((nextDeck) => {
        nextDeck.morphEasing = value;
      }, { label: `Change ${MORPH_NAME} easing` });
    });
    easing.append(easingLabel, easingSelect);
    this.host.appendChild(easing);

    if (!current || !next) {
      this.dropPreviews('compact');
      const hint = document.createElement('p');
      hint.className = 'insp-hint';
      hint.textContent = `Select a slide that has another slide after it to create ${MORPH_NAME} pairs.`;
      this.host.appendChild(hint);
      return;
    }

    const pairs = explicitMorphPairs(current.elements, next.elements);
    const morphEnabled = next.morphFromPrevious ?? pairs.length > 0;
    const enabled = document.createElement('label');
    enabled.className = 'field field-check morph-enable';
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = morphEnabled;
    enabledInput.addEventListener('change', () => {
      this.store.commit((nextDeck) => {
        nextDeck.slides[slideIndex + 1].morphFromPrevious = enabledInput.checked;
      }, { label: enabledInput.checked ? `Enable ${MORPH_NAME}` : `Disable ${MORPH_NAME}` });
    });
    const enabledLabel = document.createElement('span');
    enabledLabel.textContent = 'Enabled';
    enabled.append(enabledInput, enabledLabel);
    this.host.appendChild(enabled);

    const enableAndPair = document.createElement('button');
    enableAndPair.className = 'panel-action morph-enable-pair';
    enableAndPair.textContent = 'Enable and Auto-Pair';
    enableAndPair.title = `Enable ${MORPH_NAME} to the next slide and pair strongly matching objects`;
    enableAndPair.addEventListener('click', () => this.enableAndAutoPair());
    this.host.appendChild(enableAndPair);

    const pairCount = pairs.length;
    const pairNumbers = new Map<string, number>();
    pairs.forEach(([source, target], index) => {
      pairNumbers.set(source.id, index + 1);
      pairNumbers.set(target.id, index + 1);
    });
    const previews = document.createElement('div');
    previews.className = 'morph-previews morph-compact-previews';
    previews.append(
      this.preview(current, `Slide ${slideIndex + 1}`, 'source', pairNumbers, false),
      this.preview(next, `Slide ${slideIndex + 2}`, 'target', pairNumbers, false),
    );
    const summary = document.createElement('p');
    summary.className = 'insp-hint morph-summary';
    summary.textContent = morphEnabled
      ? `${pairCount} paired; every other object will fade out or in.`
      : `Disabled · ${pairCount} object${pairCount === 1 ? '' : 's'} paired.`;
    const edit = document.createElement('button');
    edit.className = 'panel-action morph-open';
    edit.textContent = `Open ${MORPH_NAME} editor…`;
    edit.addEventListener('click', () => this.openModal());
    this.host.append(previews, summary, edit);
    if (this.message) {
      const status = document.createElement('p');
      status.className = 'insp-hint morph-message';
      status.textContent = this.message;
      this.host.appendChild(status);
    }

    if (this.modal?.isConnected) this.renderModal();
  }

  /**
   * With a run of slides selected, per-pair pairing UI is useless — offer the
   * one action that makes sense across the whole run instead.
   */
  private renderBulk(slides: Slide[]): void {
    this.dropPreviews('compact');
    this.host.replaceChildren();

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('h4');
    title.className = 'insp-subtitle';
    title.textContent = MORPH_NAME;
    header.appendChild(title);

    const action = document.createElement('button');
    action.className = 'panel-action morph-bulk-pair';
    action.textContent = `Enable ${MORPH_NAME} & Auto-Pair`;
    action.addEventListener('click', () => this.autoPairAcross(slides));

    const hint = document.createElement('p');
    hint.className = 'insp-hint';
    hint.textContent = `${slides.length} slides selected.`;

    this.host.append(header, hint, action);
    if (this.message) {
      const status = document.createElement('p');
      status.className = 'insp-hint morph-message';
      status.textContent = this.message;
      this.host.appendChild(status);
    }
  }

  /** Auto-pair and enable Morph for every consecutive pair in the run. */
  private autoPairAcross(slides: Slide[]): void {
    const ids = slides.map((slide) => slide.id);
    let paired = 0;
    let transitions = 0;
    this.store.commit((deck) => {
      const byId = new Map(deck.slides.map((slide) => [slide.id, slide] as const));
      for (let i = 0; i + 1 < ids.length; i += 1) {
        const left = byId.get(ids[i]);
        const right = byId.get(ids[i + 1]);
        if (!left || !right) continue;
        for (const [source, target] of suggestMorphPairs(left.elements, right.elements)) {
          if (pairMorphObjects(left, right, source.id, target.id)) paired += 1;
        }
        right.morphFromPrevious = true;
        transitions += 1;
      }
    }, { label: `Auto-pair and enable ${MORPH_NAME}` });
    this.message = `Enabled ${MORPH_NAME} across ${transitions} transition${transitions === 1 ? '' : 's'}; paired ${paired} object${paired === 1 ? '' : 's'}.`;
    this.render();
  }

  private openModal(): void {
    if (this.modal?.isConnected) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'morph-modal-backdrop';
    const dialog = document.createElement('section');
    dialog.className = 'morph-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', `${MORPH_NAME} object pairing`);
    const header = document.createElement('header');
    const heading = document.createElement('h2');
    heading.textContent = MORPH_NAME;
    const close = document.createElement('button');
    close.className = 'morph-modal-close';
    close.textContent = 'Done';
    close.addEventListener('click', () => this.closeModal());
    header.append(heading, close);
    const content = document.createElement('div');
    content.className = 'morph-modal-content';
    dialog.append(header, content);
    backdrop.appendChild(dialog);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) this.closeModal();
    });
    this.modal = backdrop;
    this.modalContent = content;
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', this.onModalKeyDown, true);
    this.renderModal();
    close.focus();
  }

  private closeModal(): void {
    this.dropPreviews('modal');
    this.modal?.remove();
    this.modal = null;
    this.modalContent = null;
    this.selectedSourceId = null;
    document.removeEventListener('keydown', this.onModalKeyDown, true);
    if (this.host.isConnected) this.render();
  }

  private renderModal(): void {
    const content = this.modalContent;
    if (!content) return;
    const { deck, slideIndex } = this.store.get();
    const current = deck.slides[slideIndex];
    const next = deck.slides[slideIndex + 1];
    content.replaceChildren();
    if (!current || !next) {
      this.dropPreviews('modal');
      const unavailable = document.createElement('p');
      unavailable.className = 'insp-hint';
      unavailable.textContent = 'This slide has no following slide to pair with.';
      content.appendChild(unavailable);
      return;
    }

    const pairs = explicitMorphPairs(current.elements, next.elements);
    const pairNumbers = new Map<string, number>();
    pairs.forEach(([source, target], index) => {
      pairNumbers.set(source.id, index + 1);
      pairNumbers.set(target.id, index + 1);
    });
    const instruction = document.createElement('p');
    instruction.className = 'insp-hint morph-instruction';
    instruction.textContent = this.selectedSourceId
      ? 'Now choose its partner on the target slide.'
      : 'Choose an object on the source slide, then its partner on the target slide.';
    const previews = document.createElement('div');
    previews.className = 'morph-previews';
    previews.append(
      this.preview(current, `Source · Slide ${slideIndex + 1}`, 'source', pairNumbers),
      this.preview(next, `Target · Slide ${slideIndex + 2}`, 'target', pairNumbers),
    );
    const actions = document.createElement('div');
    actions.className = 'button-row morph-actions';
    const auto = document.createElement('button');
    auto.textContent = 'Auto-pair';
    auto.title = 'Pair strongly matching text, media, and shapes; leave uncertain objects alone';
    auto.addEventListener('click', () => this.autoPair());
    const clear = document.createElement('button');
    clear.textContent = 'Clear pairs';
    clear.disabled = pairs.length === 0;
    clear.addEventListener('click', () => this.clearPairs());
    actions.append(auto, clear);
    content.append(instruction, previews, actions);
    if (this.message) {
      const status = document.createElement('p');
      status.className = 'insp-hint morph-message';
      status.textContent = this.message;
      content.appendChild(status);
    }
    const unpairTargets = new Map<string, string>();
    for (const [source, target] of pairs) {
      unpairTargets.set(source.id, target.id);
      unpairTargets.set(target.id, target.id);
    }
    const lists = document.createElement('div');
    lists.className = 'morph-lists';
    lists.append(
      this.elementList(current, 'source', pairNumbers, unpairTargets),
      this.elementList(next, 'target', pairNumbers, unpairTargets),
    );
    content.appendChild(lists);
  }

  /** Scrollable list of every object on one slide; paired objects float to the top. */
  private elementList(
    slide: Slide,
    side: 'source' | 'target',
    pairNumbers: Map<string, number>,
    unpairTargets: Map<string, string>,
  ): HTMLElement {
    const list = document.createElement('div');
    list.className = 'morph-list';
    list.dataset.side = side;
    const ordered = [...slide.elements].sort((a, b) => {
      const pairA = pairNumbers.get(a.id) ?? Infinity;
      const pairB = pairNumbers.get(b.id) ?? Infinity;
      if (pairA !== pairB) return pairA - pairB;
      return slide.elements.indexOf(a) - slide.elements.indexOf(b);
    });
    for (const element of ordered) {
      const row = document.createElement('div');
      row.className = 'morph-list-item';
      const pair = pairNumbers.get(element.id);
      if (pair) row.classList.add('paired');
      if (side === 'source' && element.id === this.selectedSourceId) {
        row.classList.add('selected-source');
      }
      const pick = document.createElement('button');
      pick.className = 'morph-list-pick';
      pick.dataset.elementId = element.id;
      pick.dataset.side = side;
      const badge = document.createElement('b');
      badge.className = 'morph-list-badge';
      badge.textContent = pair ? String(pair) : '';
      const label = document.createElement('span');
      label.className = 'morph-list-label';
      renderElementLabel(label, element);
      pick.append(badge, label);
      pick.addEventListener('click', () => this.handleObjectClick(side, element.id));
      row.appendChild(pick);
      if (pair) {
        const remove = document.createElement('button');
        remove.className = 'icon-button';
        remove.textContent = '×';
        remove.title = 'Unpair these objects';
        remove.addEventListener('click', () => this.unpair(unpairTargets.get(element.id)!));
        row.appendChild(remove);
      }
      list.appendChild(row);
    }
    return list;
  }

  private handleObjectClick(side: 'source' | 'target', elementId: string): void {
    if (side === 'source') {
      this.selectedSourceId = this.selectedSourceId === elementId ? null : elementId;
      this.message = '';
      this.render();
    } else if (this.selectedSourceId) {
      this.pair(this.selectedSourceId, elementId);
    } else {
      this.message = 'Choose an object on the first slide before choosing its partner.';
      this.render();
    }
  }

  private preview(
    slide: Slide,
    labelText: string,
    side: 'source' | 'target',
    pairNumbers: Map<string, number>,
    interactive = true,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'morph-preview-wrap';
    const label = document.createElement('div');
    label.className = 'morph-preview-label';
    label.textContent = labelText;
    const canvas = this.store.get().deck.canvas;
    const frame = this.previewFrame(slide, side, interactive, canvas);
    // The label carries the slide number, which a reorder can change under a
    // surface that is otherwise still valid.
    if (!interactive) frame.setAttribute('aria-label', `Open ${MORPH_NAME} editor from ${labelText}`);

    // Hit boxes carry pair badges and the current selection, so they are
    // rebuilt every render -- unlike the surface behind them, which holds
    // decoded video frames worth keeping.
    for (const stale of [...frame.querySelectorAll('.morph-object-hit')]) stale.remove();
    for (const element of slide.elements) {
      const hit = document.createElement(interactive ? 'button' : 'div');
      hit.className = 'morph-object-hit';
      if (!interactive) hit.classList.add('morph-object-hit-readonly');
      hit.dataset.elementId = element.id;
      hit.dataset.side = side;
      hit.title = describe(element);
      hit.setAttribute('aria-label', `${side === 'source' ? 'First' : 'Next'} slide: ${describe(element)}`);
      hit.style.left = `${element.x / canvas.w * 100}%`;
      hit.style.top = `${element.y / canvas.h * 100}%`;
      hit.style.width = `${element.w / canvas.w * 100}%`;
      hit.style.height = `${element.h / canvas.h * 100}%`;
      hit.style.transform = element.rot ? `rotate(${element.rot}deg)` : '';
      const pair = pairNumbers.get(element.id);
      if (pair) {
        hit.classList.add('paired');
        hit.dataset.pairLabel = String(pair);
      }
      if (side === 'source' && element.id === this.selectedSourceId) {
        hit.classList.add('selected-source');
      }
      if (interactive) hit.addEventListener('click', () => this.handleObjectClick(side, element.id));
      frame.appendChild(hit);
    }
    wrap.append(label, frame);
    return wrap;
  }

  /**
   * The cached slide surface for one side of the pairing UI.
   *
   * Reused verbatim while the slide object is unchanged (the store hands out a
   * fresh clone only when the deck is edited, so every pairing click and
   * selection reuses it). When the slide *has* changed the surface is rebuilt,
   * but decoded `<video>` elements are carried over into slots that show the
   * same presentation, so an edit never blacks out a picture that was already
   * on screen.
   */
  private previewFrame(
    slide: Slide,
    side: 'source' | 'target',
    interactive: boolean,
    canvas: { w: number; h: number },
  ): HTMLElement {
    const key = `${side}:${interactive ? 'modal' : 'compact'}`;
    const cached = this.previews.get(key);
    if (
      cached
      && cached.canvasW === canvas.w
      && cached.canvasH === canvas.h
      && sameSlideDrawing(cached.slide, slide)
    ) {
      // A note edited since the surface was drawn changes nothing in the
      // picture; remember the current slide so the next comparison is cheap.
      cached.slide = slide;
      // The surface spends time detached between renders, and the load gate
      // aborts the fetch of a detached element -- re-queue anything that came
      // back frameless instead of re-showing a black box.
      recoverPreviewFrames(cached.frame);
      return cached.frame;
    }

    const frame = document.createElement('div');
    frame.className = 'morph-preview';
    if (!interactive) {
      frame.classList.add('morph-compact-preview');
      frame.tabIndex = 0;
      frame.setAttribute('role', 'button');
      frame.addEventListener('click', () => this.openModal());
      frame.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.openModal();
        }
      });
    }
    frame.style.aspectRatio = `${canvas.w} / ${canvas.h}`;
    const surface = document.createElement('div');
    surface.className = 'morph-preview-surface';
    surface.style.width = `${canvas.w}px`;
    surface.style.height = `${canvas.h}px`;
    const updateScale = () => {
      const width = frame.clientWidth || PREVIEW_WIDTH_FALLBACK;
      surface.style.transform = `scale(${width / canvas.w})`;
    };
    updateScale();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScale);
    observer?.observe(frame);
    surface.appendChild(renderSlide(slide, { resolveSrc: (src) => window.api.assetUrl(src), mediaPreload: 'metadata', deferVideoSrc: true }));
    for (const video of surface.querySelectorAll('video')) {
      video.removeAttribute('autoplay');
      video.pause();
    }
    if (cached) adoptDecodedVideos(cached.surface, surface);
    // Pairing previews never play either, so they show captured stills. Once
    // a frame is cached this is synchronous -- a rebuilt surface is a picture
    // immediately instead of a black box waiting on the network.
    freezePreviewVideos(surface);
    frame.appendChild(surface);

    cached?.observer?.disconnect();
    this.previews.set(key, {
      slide,
      canvasW: canvas.w,
      canvasH: canvas.h,
      frame,
      surface,
      observer,
    });
    return frame;
  }

  /** Forget cached surfaces of one presentation, releasing their observers. */
  private dropPreviews(kind: 'compact' | 'modal'): void {
    for (const [key, entry] of [...this.previews]) {
      if (!key.endsWith(`:${kind}`)) continue;
      entry.observer?.disconnect();
      this.previews.delete(key);
    }
  }

  private pair(sourceId: string, targetId: string): void {
    const slideIndex = this.store.get().slideIndex;
    this.selectedSourceId = null;
    this.message = 'Objects paired.';
    this.store.commit((deck) => {
      pairMorphObjects(deck.slides[slideIndex], deck.slides[slideIndex + 1], sourceId, targetId);
    }, { label: `Pair ${MORPH_NAME} objects` });
  }

  private unpair(targetId: string): void {
    const slideIndex = this.store.get().slideIndex;
    this.message = '';
    this.store.commit((deck) => {
      const target = deck.slides[slideIndex + 1]?.elements.find((element) => element.id === targetId);
      if (target) target.morphId = null;
    }, { label: `Unpair ${MORPH_NAME} objects` });
  }

  private clearPairs(): void {
    const slideIndex = this.store.get().slideIndex;
    this.message = '';
    this.store.commit((deck) => {
      const current = deck.slides[slideIndex];
      const next = deck.slides[slideIndex + 1];
      if (!current || !next) return;
      for (const [, target] of explicitMorphPairs(current.elements, next.elements)) {
        target.morphId = null;
      }
    }, { label: `Clear ${MORPH_NAME} pairs` });
  }

  /** One-click: turn on Morph to the next slide and auto-pair matches. */
  private enableAndAutoPair(): void {
    const { deck, slideIndex } = this.store.get();
    const current = deck.slides[slideIndex];
    const next = deck.slides[slideIndex + 1];
    if (!current || !next) return;
    const suggestions = suggestMorphPairs(current.elements, next.elements);
    this.message = suggestions.length > 0
      ? `Enabled ${MORPH_NAME}; auto-paired ${suggestions.length} object${suggestions.length === 1 ? '' : 's'}.`
      : `Enabled ${MORPH_NAME}; no confident new matches to pair.`;
    this.store.commit((nextDeck) => {
      const left = nextDeck.slides[slideIndex];
      const right = nextDeck.slides[slideIndex + 1];
      for (const [source, target] of suggestions) {
        pairMorphObjects(left, right, source.id, target.id);
      }
      right.morphFromPrevious = true;
    }, { label: `Enable and auto-pair ${MORPH_NAME}` });
  }

  private autoPair(): void {
    const { deck, slideIndex } = this.store.get();
    const current = deck.slides[slideIndex];
    const next = deck.slides[slideIndex + 1];
    if (!current || !next) return;
    const suggestions = suggestMorphPairs(current.elements, next.elements);
    if (suggestions.length === 0) {
      this.message = 'No confident new matches found.';
      this.render();
      return;
    }
    this.message = `Auto-paired ${suggestions.length} object${suggestions.length === 1 ? '' : 's'}.`;
    this.store.commit((nextDeck) => {
      const left = nextDeck.slides[slideIndex];
      const right = nextDeck.slides[slideIndex + 1];
      for (const [source, target] of suggestions) {
        pairMorphObjects(left, right, source.id, target.id);
      }
    }, { label: `Auto-pair ${MORPH_NAME} objects` });
  }
}

export function pairMorphObjects(
  current: Slide,
  next: Slide,
  sourceId: string,
  targetId: string,
): boolean {
  const source = current.elements.find((element) => element.id === sourceId);
  const target = next.elements.find((element) => element.id === targetId);
  if (!source || !target) return false;
  const matchId = source.morphId ?? makeId('morph');
  for (const element of current.elements) {
    if (element !== source && element.morphId === matchId) element.morphId = null;
  }
  for (const element of next.elements) {
    if (element !== target && element.morphId === matchId) element.morphId = null;
  }
  source.morphId = matchId;
  target.morphId = matchId;
  next.morphFromPrevious = true;
  return true;
}

/**
 * Move decoded `<video>` elements from a torn-down preview surface into the
 * matching slots of its replacement.
 *
 * Keyed by presentation (`data-media-key`: file, in-point, crop, fit, box), so
 * an adopted element is already holding exactly the frame this slot wants, at
 * exactly this slot's geometry -- no seek, and nothing for the compositor to
 * stretch in the meantime. See `videoPresentationKey` in player/render.ts.
 */
function adoptDecodedVideos(from: HTMLElement, to: HTMLElement): void {
  const pool = new Map<string, HTMLVideoElement[]>();
  for (const video of from.querySelectorAll('video')) {
    const key = video.dataset.mediaKey;
    if (!key) continue;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;
    video.pause();
    const list = pool.get(key) ?? [];
    list.push(video);
    pool.set(key, list);
  }
  if (pool.size === 0) return;
  for (const fresh of to.querySelectorAll('video')) {
    const key = fresh.dataset.mediaKey;
    const decoded = key ? pool.get(key)?.pop() : undefined;
    if (!decoded) continue;
    decoded.style.cssText = fresh.style.cssText;
    decoded.className = fresh.className;
    decoded.preload = fresh.preload;
    decoded.playsInline = true;
    decoded.removeAttribute('autoplay');
    decoded.muted = fresh.muted;
    decoded.controls = fresh.controls;
    decoded.loop = fresh.loop;
    fresh.replaceWith(decoded);
    // The fresh element's fetch is now pointless; the network is the scarce
    // resource on a remote session.
    fresh.removeAttribute('src');
    try {
      fresh.load();
    } catch {
      // jsdom stub
    }
  }
}
