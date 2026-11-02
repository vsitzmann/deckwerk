import type { Deck } from '@shared/deck.js';
import type { PresentationCommand, PresentationState } from '@shared/ipc.js';
import { resolveState } from '@shared/timeline.js';
import { revealImagesWhenDecoded } from '../player/imageDecode.js';
import { freezePreviewVideos, releasePreviewVideos } from '../player/previewPoster.js';
import { applyStageScale, renderSlide, rewriteCssAssetUrls } from '../player/render.js';
import { prepareCodeBlocks } from '../player/codeRender.js';
import { applyStaticSlideState } from '../player/staticState.js';
import { formatElapsed, formatWallClock, presentationLabel } from './model.js';
import { videoRateChangeForKey } from '../player/videoRate.js';

/**
 * Speaker View: current and next slide, speaker notes, build position, presentation and slide
 * timers, wall clock, and the presenter's controls.
 *
 * One component, two shells. The desktop opens it in its own Electron window
 * on the presenter's display and talks to the audience window over IPC; the
 * browser opens it in a second tab and talks to the audience tab over the
 * presentation bus. Everything above the transport — markup, previews, clocks,
 * key map — lives here so a control added for one client is never missing from
 * the other.
 */

export interface SpeakerViewOptions {
  host: HTMLElement;
  resolveSrc: (src: string) => string;
  onCommand: (command: PresentationCommand) => void;
  onNotesChange?: (slideId: string, notes: string) => void;
  /**
   * Whether to offer the audience/presenter role swap. The desktop moves its
   * two windows between displays; the browser cannot place windows, so it
   * swaps the roles of the two surfaces in place instead. A shell with only
   * one surface passes false and the control is absent rather than inert.
   */
  canSwapDisplays?: boolean;
  /** Label for the swap control, which differs between window and tab shells. */
  swapLabel?: string;
  swapTitle?: string;
  /** Label for the button that sends `exit`; a remote leaves rather than ending the show. */
  endLabel?: string;
  /** Further buttons for the footer, placed before End show (the browser's Remote…). */
  extraActions?: HTMLElement[];
  /** Injectable clock, so timer formatting is testable without waiting. */
  now?: () => number;
}

export interface SpeakerView {
  setDeck(deck: Deck | null): void;
  setTheme(css: string): void;
  setState(state: PresentationState): void;
  /** Re-scale the previews; call on resize. */
  refresh(): void;
  /** Advance the clocks. Called on a timer internally; exposed for tests. */
  tick(): void;
  toggleOverview(): void;
  toggleGrid(): void;
  closeOverview(): boolean;
  isOverviewOpen(): boolean;
  isGridOpen(): boolean;
  destroy(): void;
}

const MARKUP = `
  <section class="speaker-layout">
    <div class="preview-panel current-panel">
      <div class="panel-heading"><h2>Current slide</h2><div class="speaker-position">Slide 1</div></div>
      <div class="speaker-current preview"></div>
    </div>
    <aside class="speaker-sidebar">
      <div class="preview-panel next-panel">
        <h2>Next slide</h2>
        <div class="speaker-next preview"></div>
      </div>
      <section class="timers" aria-label="Presentation timing">
        <div class="presenter-clock presentation-clock"><span>Presentation elapsed</span><strong class="speaker-presentation-timer">00:00</strong></div>
        <div class="presenter-clock slide-clock"><span>Current slide</span><strong class="speaker-slide-timer">00:00</strong></div>
        <div class="presenter-clock wall-clock"><span>Local time</span><strong class="speaker-wall-clock">--:--</strong></div>
      </section>
      <section class="notes-panel" aria-label="Speaker notes">
        <h2>Notes</h2>
        <textarea class="speaker-notes" aria-label="Speaker notes for the current slide" placeholder="Notes for this slide…" spellcheck="true"></textarea>
      </section>
    </aside>
  </section>
  <section class="speaker-overview" role="region" aria-label="Slides" hidden>
    <div class="speaker-overview-heading"><h2>Slides</h2><button class="speaker-overview-close">Close</button></div>
    <div class="speaker-overview-list"></div>
  </section>
  <footer>
    <button class="speaker-prev">← Previous</button>
    <button class="speaker-slides" aria-expanded="false" aria-keyshortcuts="O">Slides</button>
    <button class="speaker-grid" aria-expanded="false" aria-keyshortcuts="G">All slides</button>
    <button class="speaker-blank">Blank</button>
    <button class="speaker-next-button primary">Next →</button>
    <button class="speaker-swap">Switch displays</button>
    <button class="speaker-end danger">End show</button>
  </footer>
`;

export function createSpeakerView(options: SpeakerViewOptions): SpeakerView {
  const { host, resolveSrc, onCommand, now = () => Date.now() } = options;
  const openedAt = now();
  host.classList.add('speaker-view');
  host.innerHTML = MARKUP;

  const pick = <T extends HTMLElement>(selector: string): T => {
    const node = host.querySelector<T>(selector);
    if (!node) throw new Error(`speaker view: missing ${selector}`);
    return node;
  };

  const currentHost = pick('.speaker-current');
  const nextHost = pick('.speaker-next');
  const position = pick('.speaker-position');
  const presentationTimer = pick('.speaker-presentation-timer');
  const slideTimer = pick('.speaker-slide-timer');
  const wallClock = pick('.speaker-wall-clock');
  const notes = pick<HTMLTextAreaElement>('.speaker-notes');
  const swap = pick<HTMLButtonElement>('.speaker-swap');
  const end = pick<HTMLButtonElement>('.speaker-end');
  const overview = pick('.speaker-overview');
  const overviewList = pick('.speaker-overview-list');
  const slidesButton = pick<HTMLButtonElement>('.speaker-slides');
  const gridButton = pick<HTMLButtonElement>('.speaker-grid');
  const layout = pick('.speaker-layout');
  const footer = pick('footer');
  if (options.endLabel) end.textContent = options.endLabel;
  for (const action of options.extraActions ?? []) end.before(action);

  if (options.canSwapDisplays === false) {
    swap.remove();
  } else {
    if (options.swapLabel) swap.textContent = options.swapLabel;
    swap.title = options.swapTitle ?? 'Swap the audience and speaker displays';
  }

  let deck: Deck | null = null;
  let theme: HTMLStyleElement | null = null;
  let state: PresentationState = {
    cursor: { slide: 0, step: 0 },
    steps: 1,
    startedAt: openedAt,
    slideStartedAt: openedAt,
  };
  let overviewObserver: IntersectionObserver | null = null;
  let overviewDeck: Deck | null = null;
  let overviewRange = '';
  let overviewMode: 'closed' | 'rail' | 'grid' = 'closed';
  let returnToRail = false;
  let shownNotesSlideId: string | null = null;
  let committingNotes = false;

  function commitNotes(): void {
    if (committingNotes) return;
    const slide = deck?.slides.find((item) => item.id === shownNotesSlideId);
    if (!slide || notes.value === slide.notes) return;
    const value = notes.value;
    committingNotes = true;
    try {
      options.onNotesChange?.(slide.id, value);
      slide.notes = value;
    } finally {
      committingNotes = false;
    }
  }

  notes.disabled = !options.onNotesChange;
  notes.addEventListener('change', commitNotes);
  notes.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      notes.blur();
    }
    event.stopPropagation();
  });

  function preview(target: HTMLElement, slideIndex: number, step = 0): void {
    // Every advance throws this preview away and builds another. A video still
    // waiting for its poster frame is held by the module's global capture map,
    // which would keep the whole discarded subtree alive — one leaked stage per
    // step, for the length of the talk. Hand them back before dropping them.
    releasePreviewVideos(target);
    target.replaceChildren();
    const slide = deck?.slides[slideIndex];
    if (!slide) return;
    const stage = document.createElement('div');
    stage.className = 'stage';
    stage.appendChild(renderSlide(slide, { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true }));
    target.appendChild(stage);
    applyStaticSlideState(stage, slide, resolveState(slide, step));
    const bounds = target.getBoundingClientRect();
    applyStageScale(stage, deck!, { w: bounds.width, h: bounds.height });
    for (const video of stage.querySelectorAll('video')) video.pause();
    // Large JPEGs otherwise paint their first decoded scanlines as a thin strip
    // before the complete bitmap is ready. Keep both current and next previews
    // atomic just like the audience Player.
    revealImagesWhenDecoded(stage);
    // Speaker View is a pair of still previews, not a playback surface. Capture
    // one decoded frame per source/in-point and reuse it across re-renders. In
    // particular, the next slide is warm before it becomes current, so moving
    // through a video-heavy deck never opens on an undecoded black frame.
    freezePreviewVideos(stage);
  }

  function render(): void {
    if (!deck) return;
    preview(currentHost, state.cursor.slide, state.cursor.step);
    const lastSlide = state.range?.end ?? deck.slides.length - 1;
    let nextSlide = state.cursor.slide + 1;
    while (nextSlide <= lastSlide && deck.slides[nextSlide]?.skipped) nextSlide += 1;
    preview(nextHost, nextSlide <= lastSlide ? nextSlide : -1);
    position.textContent = presentationLabel(state, deck.slides.length);
    const slide = deck.slides[state.cursor.slide];
    if (shownNotesSlideId !== slide?.id) commitNotes();
    if (shownNotesSlideId !== slide?.id || document.activeElement !== notes) {
      notes.value = slide?.notes ?? '';
    }
    shownNotesSlideId = slide?.id ?? null;
    if (!overview.hidden) {
      const range = `${state.range?.start ?? 0}:${state.range?.end ?? deck.slides.length - 1}`;
      if (deck !== overviewDeck || range !== overviewRange) buildOverview();
      for (const button of overviewList.querySelectorAll<HTMLButtonElement>('button[data-slide]')) {
        if (Number(button.dataset.slide) === state.cursor.slide) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      }
    }
  }

  function clearOverview(): void {
    overviewObserver?.disconnect();
    overviewObserver = null;
    releasePreviewVideos(overviewList);
    overviewList.replaceChildren();
    overviewDeck = null;
  }

  function buildOverview(): void {
    clearOverview();
    if (!deck) return;
    const start = state.range?.start ?? 0;
    const end = state.range?.end ?? deck.slides.length - 1;
    overviewDeck = deck;
    overviewRange = `${start}:${end}`;
    if (typeof IntersectionObserver !== 'undefined') {
      overviewObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLElement;
          if (entry.isIntersecting) preview(target, Number(target.dataset.slide));
          else {
            releasePreviewVideos(target);
            target.replaceChildren();
          }
        }
      }, { root: overviewList, rootMargin: '300px' });
    }
    for (let index = start; index <= end; index++) {
      const slide = deck.slides[index];
      if (!slide) continue;
      const button = document.createElement('button');
      button.className = `speaker-overview-slide${slide.skipped ? ' skipped' : ''}`;
      button.dataset.slide = String(index);
      button.setAttribute('aria-label', `Slide ${index + 1}: ${slide.name || 'Untitled'}${slide.skipped ? ', hidden' : ''}`);
      const thumbnail = document.createElement('div');
      thumbnail.className = 'preview';
      thumbnail.dataset.slide = String(index);
      const label = document.createElement('span');
      label.className = 'speaker-overview-label';
      label.textContent = `${index + 1}  ${slide.name || 'Untitled'}`;
      button.append(thumbnail, label);
      if (slide.skipped) {
        const badge = document.createElement('span');
        badge.className = 'speaker-overview-hidden';
        badge.textContent = 'Hidden';
        button.appendChild(badge);
      }
      button.addEventListener('click', () => {
        onCommand({ type: 'goTo', slide: index });
        if (overviewMode === 'grid') closeOverview();
      });
      overviewList.appendChild(button);
      if (overviewObserver) overviewObserver.observe(thumbnail);
      else preview(thumbnail, index);
    }
  }

  function showOverview(mode: 'closed' | 'rail' | 'grid'): void {
    overviewMode = mode;
    overview.hidden = mode === 'closed';
    host.classList.toggle('overview-open', mode === 'rail');
    host.classList.toggle('overview-grid', mode === 'grid');
    layout.inert = mode === 'grid';
    footer.inert = mode === 'grid';
    slidesButton.setAttribute('aria-expanded', String(mode === 'rail'));
    gridButton.setAttribute('aria-expanded', String(mode === 'grid'));
    overview.setAttribute('role', mode === 'grid' ? 'dialog' : 'region');
    if (mode === 'grid') overview.setAttribute('aria-modal', 'true');
    else overview.removeAttribute('aria-modal');
    if (mode === 'closed') {
      clearOverview();
      slidesButton.focus();
      return;
    }
    if (!overviewDeck) buildOverview();
    render();
    for (const thumbnail of overviewList.querySelectorAll<HTMLElement>('.preview')) {
      const stage = thumbnail.querySelector<HTMLElement>('.stage');
      if (!stage || !deck) continue;
      const bounds = thumbnail.getBoundingClientRect();
      applyStageScale(stage, deck, { w: bounds.width, h: bounds.height });
    }
    const current = overviewList.querySelector<HTMLElement>('[aria-current="true"]');
    current?.scrollIntoView?.({ block: 'nearest' });
    (current ?? pick('.speaker-overview-close')).focus();
  }

  function closeOverview(): boolean {
    if (overviewMode === 'closed') return false;
    showOverview(overviewMode === 'grid' && returnToRail ? 'rail' : 'closed');
    return true;
  }

  function toggleOverview(): void {
    showOverview(overviewMode === 'rail' ? 'closed' : 'rail');
  }

  function toggleGrid(): void {
    if (overviewMode === 'grid') closeOverview();
    else {
      returnToRail = overviewMode === 'rail';
      showOverview('grid');
    }
  }

  function tick(): void {
    const stamp = now();
    presentationTimer.textContent = formatElapsed(stamp, state.startedAt);
    slideTimer.textContent = formatElapsed(stamp, state.slideStartedAt);
    wallClock.textContent = formatWallClock(new Date(stamp));
  }

  const send = (command: PresentationCommand) => () => onCommand(command);
  pick('.speaker-prev').addEventListener('click', send({ type: 'prev' }));
  pick('.speaker-next-button').addEventListener('click', send({ type: 'next' }));
  pick('.speaker-blank').addEventListener('click', send({ type: 'toggleBlank' }));
  slidesButton.addEventListener('click', toggleOverview);
  gridButton.addEventListener('click', toggleGrid);
  pick('.speaker-overview-close').addEventListener('click', closeOverview);
  end.addEventListener('click', send({ type: 'exit' }));
  if (swap.isConnected) swap.addEventListener('click', send({ type: 'swapDisplays' }));

  tick();
  const clock = setInterval(tick, 250);

  return {
    setDeck(next) {
      commitNotes();
      deck = next;
      if (next) prepareCodeBlocks(next);
      render();
    },
    setTheme(css) {
      if (!theme) {
        theme = document.createElement('style');
        document.head.appendChild(theme);
      }
      theme.textContent = rewriteCssAssetUrls(css, resolveSrc);
    },
    setState(next) {
      state = next;
      render();
      tick();
    },
    refresh() {
      render();
      if (!deck || overview.hidden) return;
      for (const thumbnail of overviewList.querySelectorAll<HTMLElement>('.preview')) {
        const stage = thumbnail.querySelector<HTMLElement>('.stage');
        if (!stage) continue;
        const bounds = thumbnail.getBoundingClientRect();
        applyStageScale(stage, deck, { w: bounds.width, h: bounds.height });
      }
    },
    tick,
    toggleOverview,
    toggleGrid,
    closeOverview,
    isOverviewOpen: () => overviewMode !== 'closed',
    isGridOpen: () => overviewMode === 'grid',
    destroy() {
      commitNotes();
      clearInterval(clock);
      clearOverview();
      theme?.remove();
      theme = null;
      host.replaceChildren();
      host.classList.remove('speaker-view', 'overview-open', 'overview-grid');
    },
  };
}

/**
 * The presenter key map. Deliberately narrower than the audience player's: a
 * speaker surface only ever forwards commands, apart from its local overview.
 */
export function bindSpeakerKeys(
  target: Window | HTMLElement,
  onCommand: (command: PresentationCommand) => void,
  overview?: Pick<SpeakerView, 'toggleOverview' | 'toggleGrid' | 'closeOverview' | 'isOverviewOpen' | 'isGridOpen'>,
): () => void {
  const onKey = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (overview?.isGridOpen() && !['Escape', 'o', 'O', 'g', 'G'].includes(key)) return;
    const onControl = (event.target as HTMLElement | null)?.closest?.('button, input, select, textarea, [contenteditable]');
    if (onControl && (key === 'Enter' || key === ' ')) return;
    if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(key)) {
      onCommand({ type: 'next' });
    } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(key)) {
      onCommand({ type: 'prev' });
    } else if (key === 'b' || key === 'B') {
      onCommand({ type: 'toggleBlank' });
    } else if (key === 'o' || key === 'O') {
      overview?.toggleOverview();
    } else if (key === 'g' || key === 'G') {
      overview?.toggleGrid();
    } else if (key === 'Escape') {
      // Escape ends the show even with the rail open, as it does without it;
      // only the full-screen grid, a dialog over everything, closes first.
      if (!(overview?.isGridOpen() && overview.closeOverview())) onCommand({ type: 'exit' });
    } else if (videoRateChangeForKey(key)) {
      onCommand({ type: 'videoRate', change: videoRateChangeForKey(key)! });
    } else {
      return;
    }
    event.preventDefault();
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
