import { groupIntoSteps } from '@shared/timeline.js';
import { Player } from '../player/player.js';
import type { EditorStore } from './store.js';

/** Where a preview plays: a surface over the slide, and how to take it away. */
export interface PlaybackHost {
  beginPlayback(onPress: () => void): { surface: HTMLElement; end: () => void };
}

/** The pause between one click's builds and the next, and before the slide comes back. */
export const PREVIEW_PAUSE_MS = 700;

export type BuildPreviewMode = 'builds' | 'slide';

/**
 * The Build panel's Preview, as in Keynote's Animate inspector: the selected
 * builds play in place over the slide, then the editing view comes back.
 *
 * It is the presentation's own Player on a one-slide copy of the deck, so an
 * effect previews exactly as it presents, and an effect added to the player
 * is previewed with nothing added here. Nothing is committed: the slide, the
 * selection and the undo history are as they were when it ends.
 */
export class BuildPreview {
  private readonly host: PlaybackHost;
  private readonly store: EditorStore;
  private run: {
    mode: BuildPreviewMode;
    player: Player;
    end: () => void;
    slideIndex: number;
    slideId: string;
  } | null = null;
  private listeners = new Set<() => void>();

  constructor(host: PlaybackHost, store: EditorStore) {
    this.host = host;
    this.store = store;
    // Moving to another slide (or the slide going away) ends the preview: it
    // would otherwise be playing a slide that is no longer the one edited.
    store.subscribe(() => {
      if (!this.run) return;
      const { slideIndex } = this.store.get();
      if (slideIndex !== this.run.slideIndex || this.store.slide?.id !== this.run.slideId) this.stop();
    });
  }

  /** What is playing, or null. */
  get playing(): BuildPreviewMode | null {
    return this.run?.mode ?? null;
  }

  /** Notified whenever a preview starts or ends. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The steps that animate the selected elements, as [first, last], or null
   * when nothing selected has a build.
   */
  selectedSteps(): [number, number] | null {
    const slide = this.store.slide;
    if (!slide) return null;
    const selection = this.store.get().selection;
    const steps: number[] = [];
    groupIntoSteps(slide).forEach((units, step) => {
      if (units.some((unit) => selection.has(unit.action.target))) steps.push(step);
    });
    return steps.length > 0 ? [steps[0], steps[steps.length - 1]] : null;
  }

  /**
   * Play the selected elements' builds: from the state just before the first
   * of their steps, through the last, each step whole, so what fires with or
   * after a build plays with it. With no build selected, the whole slide.
   */
  previewSelection(): void {
    const range = this.selectedSteps();
    if (range) this.play('builds', range[0], range[1]);
    else this.previewSlide();
  }

  /** Play the whole slide from its entry, advancing through every click by itself. */
  previewSlide(): void {
    const slide = this.store.slide;
    if (!slide) return;
    this.play('slide', 0, groupIntoSteps(slide).length - 1);
  }

  stop(): void {
    const run = this.run;
    if (!run) return;
    this.run = null;
    window.removeEventListener('keydown', this.onKey, true);
    run.player.destroy();
    run.end();
    this.emit();
  }

  private play(mode: BuildPreviewMode, first: number, last: number): void {
    this.stop();
    const { deck, slideIndex } = this.store.get();
    const slide = this.store.slide;
    if (!slide) return;
    const { surface, end } = this.host.beginPlayback(() => this.stop());
    const player = new Player({
      deck: { ...deck, slides: [slide] },
      container: surface,
      resolveSrc: (src) => window.api?.assetUrl?.(src) ?? src,
    });
    const run = { mode, player, end, slideIndex, slideId: slide.id };
    this.run = run;
    window.addEventListener('keydown', this.onKey, true);
    this.emit();

    // Step 0 is the slide arriving: its builds play as they do when the talk
    // reaches the slide. Any later step starts from the one before, resolved.
    if (first === 0) player.goToSlide(0, { play: true });
    else {
      player.goTo({ slide: 0, step: first - 1 });
      player.next();
    }
    void (async () => {
      for (let step = first; step <= last; step++) {
        if (step > first) player.next();
        await player.whenStepSettles();
        if (this.run !== run) return;
        await new Promise((resolve) => setTimeout(resolve, PREVIEW_PAUSE_MS));
        if (this.run !== run) return;
      }
      this.stop();
    })();
  }

  /** Escape ends the preview, and only that: nothing else hears it. */
  private onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.stop();
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
