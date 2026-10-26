import type { Deck, Slide, SlideElement, TimelineEntry } from '@shared/deck.js';
import {
  type Cursor,
  type SlideState,
  type ExpandedEntry,
  applyAction,
  buildEffect,
  effectDuration,
  groupIntoSteps,
  nextCursor,
  popScales,
  prevCursor,
  resolveState,
  stepCount,
} from '@shared/timeline.js';
import { shapeSvg } from '@shared/shapeSvg.js';
import { parsePath, serializePath } from '@shared/pathNodes.js';
import { strokeStyleOf } from '@shared/strokeStyles.js';
import {
  followerCorrection,
  groupClock,
  memberFrame,
  SYNC_BLACK_CLASS,
  syncGroupsOf,
  type SyncClip,
} from './videoSync.js';
import { syncLengthOf, type SyncLength } from '@shared/compare.js';
import { mountGroupScrubber } from './groupScrubber.js';
import { mountWipeDrag } from './wipe.js';
import {
  applyStageScale,
  fitAutoTextElement,
  renderSlide,
  videoPresentationKey,
} from './render.js';
import { decodeImage, revealImagesWhenDecoded } from './imageDecode.js';
import {
  DecodedVideoPool,
  decodeVideoFrame,
  releaseDecodedVideo,
} from './decodedVideoPool.js';
import { applyStaticSlideState } from './staticState.js';
import type { VideoBlobCache } from './videoBlobCache.js';
import {
  essentialMorphPairs,
  explicitMorphPairs,
  restyledMorphPairs,
  unchangedMorphPairs,
  type MorphPair,
} from '@shared/morph.js';
import { morphTransforms, type Rect, type TextLayout } from './morphTransform.js';
import { prepareEquationEffect } from './equationBuilds.js';
import { morphEquationGlyphs } from './equationMorph.js';
import { isPendingSrc } from '@shared/media.js';
import { WEB_BRIDGE_SOURCE, isWebBridgeAction, type WebBridgeEvent } from '@shared/webBridge.js';
import { formatVideoRate, nextVideoRate, type VideoRateChange } from './videoRate.js';
import { prepareCodeBlocks } from './codeRender.js';

/**
 * The runtime that owns navigation and turns timeline entries into DOM and
 * media effects. Shared by the editor preview, the present window and exports.
 *
 * Two paths reach the same place by design:
 *  - jumping (arrow back, opening mid-deck) replays `resolveState` with delays
 *    collapsed, so the state is correct instantly;
 *  - stepping forward schedules the same actions honouring `delay` and
 *    `mediaEnd`, so builds animate the way they were authored.
 */
export interface PlayerOptions {
  deck: Deck;
  container: HTMLElement;
  resolveSrc: (src: string) => string;
  /** Notified on every cursor change, for slide counters and the editor rail. */
  onCursor?: (cursor: Cursor, steps: number) => void;
  /**
   * Hold the deck's video files in memory and play them from there. The
   * browser presentation passes one; see videoBlobCache.ts for why.
   */
  videoBlobs?: VideoBlobCache;
}

/**
 * How hard to insist that a video the deck wants running is actually running.
 * Chromium can pause muted, audio-less video the moment it treats the frame as
 * background; a handful of spaced retries recovers from that without turning a
 * genuinely hidden tab into a busy loop.
 */
const PLAY_RETRY_LIMIT = 12;
const PLAY_RETRY_DELAY_MS = 400;

/** How many presentable slides ahead get their media cache-warmed. */
const WARM_AHEAD_SLIDES = 2;
/** Two typical 24 MP images, with a count fallback when dimensions are unavailable. */
const IMAGE_WARM_PIXEL_LIMIT = 48_000_000;
const IMAGE_WARM_COUNT_LIMIT = 4;
/** How many upcoming videos are decoded into ready-to-adopt elements. */
const VIDEO_WARM_ELEMENT_LIMIT = 4;
/** How long one lookahead decode may run before its element is given up on. */
const VIDEO_WARM_TIMEOUT_MS = 20_000;
/** How long the lookahead waits for the visible slide before starting anyway. */
const LOOKAHEAD_HOLD_MS = 2_000;

type VideoEl = Extract<SlideElement, { type: 'video' }>;

/** A sync group's clock, as `Player.groupClockOf` finds it on the stage. */
interface GroupClock {
  /** Which member keeps time, and its element and `<video>`. */
  index: number;
  element: VideoEl;
  video: HTMLVideoElement;
  /** Every member's `<video>` and clip, in member order. */
  videos: Array<HTMLVideoElement | null>;
  clips: SyncClip[];
  mode: SyncLength;
  /** The group's length in seconds, once every member's is known. */
  length: number | null;
}

/** A video the lookahead wants decoded before its slide is reached. */
interface VideoWarmTarget {
  src: string;
  key: string;
  start: number;
}

/** Paint a text can change without moving a single glyph. */
const TEXT_PAINT = new Set(['color', 'background', 'background-color', 'filter', 'opacity', 'text-shadow',
  'border-color', 'box-shadow', 'text-decoration-color', '-webkit-text-stroke-color']);

/**
 * Everything about a text that decides where its glyphs land: its box size,
 * alignment, classes and every style but paint, and its markup with colour
 * declarations taken out. Two texts with the same layout overlay exactly.
 */
function textLayout(element: Extract<SlideElement, { type: 'text' }>): string {
  const style = Object.entries(element.style).filter(([key]) => !TEXT_PAINT.has(key)).sort();
  // A colour run is a span whose only style is its colour: without the
  // colour it is no span at all, so recolouring a word is not a relayout.
  const html = element.html
    .replace(/(^|[;"'\s])(?:background-)?color\s*:[^;"']*;?/gi, '$1')
    .replace(/\sstyle="\s*"/g, '')
    .replace(/<span>|<\/span>/g, '');
  return JSON.stringify([Math.round(element.w), Math.round(element.h), element.align, element.valign,
    element.class, style, html]);
}

export class Player {
  private deck: Deck;
  private container: HTMLElement;
  /** Deck src → URL, preferring a clip's in-memory copy once there is one. */
  private resolveSrc: (src: string) => string;
  /** Deck src → URL on the network, whatever the blob cache holds. */
  private networkSrc: (src: string) => string;
  private videoBlobs: VideoBlobCache | null;
  private offBlobReady: (() => void) | null = null;
  private onCursor?: (cursor: Cursor, steps: number) => void;

  private stage: HTMLElement;
  private cursor: Cursor = { slide: 0, step: 0 };
  private blanked = false;

  /** Timers and media listeners owned by the current step, cleared on any move. */
  private pending: ReturnType<typeof setTimeout>[] = [];
  /** Build animations in flight. Calling one jumps it to its finished state. */
  private effects: Array<() => void> = [];
  private mediaListeners: Array<() => void> = [];
  /** Builds of the current step not yet run; see `whenStepSettles`. */
  private buildsDue = 0;
  /** When the last build animation started on the current step ends, in `performance.now()` time. */
  private animatedUntil = 0;
  private settleWaiters: Array<() => void> = [];
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Videos already given a trim watcher, so listeners are not stacked. */
  private trimmed = new Set<string>();
  /** Sync groups whose clock is already running on the current slide. */
  private syncedGroups = new Set<string>();
  /** Wipe dividers and group scrubbers are live for the current step. */
  private compareMounted = false;
  /** Sync groups the presenter paused from their scrubber, on slide `heldSlide`. */
  private heldGroups = new Set<string>();
  private heldSlide: string | null = null;
  /**
   * The presenter's playback speed for the videos on slide `rateSlide`
   * (videoRate.ts). It belongs to the slide: leaving it returns to 1×.
   */
  private videoRate = 1;
  private rateSlide: string | null = null;
  private rateBadge: HTMLElement | null = null;
  private rateBadgeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Videos the current build state says should be running, and the recovery
   * bookkeeping for keeping them that way. See `keepPlaying`.
   */
  private intendedPlaying = new Set<string>();
  /**
   * Sync-group followers that have run out before their group and wait,
   * paused, for it to loop back (`syncVideoGroups`). Intended to play, yet
   * not to be restarted by the play recovery.
   */
  private parkedVideos = new Set<HTMLVideoElement>();
  private playAttempts = new Map<string, number>();
  private playWatched = new WeakSet<HTMLVideoElement>();
  /** Videos whose retry budget ran out mid-load, waiting for `canplay` to try again. */
  private resumeArmed = new WeakSet<HTMLVideoElement>();
  private resizeObserver: ResizeObserver;
  /**
   * Decoded-but-idle <video> nodes rescued from slides that left the screen,
   * keyed by presentation (`videoPresentationKey`) rather than by file, so a
   * node is only ever reused where it shows the same frame of the same file
   * through the same geometry. Re-entering a slide adopts these instead of
   * creating fresh elements, so the picture is back instantly and no bytes are
   * re-fetched. Same pattern as the editor canvas's pool (docs/media-loading.md,
   * "DOM churn").
   */
  private videoPool = new DecodedVideoPool(24);
  /** Resolved video URLs already warmed into the HTTP cache. */
  private warmedSrcs = new Set<string>();
  private warmQueue: string[] = [];
  private warmInFlight = false;
  /**
   * Lookahead videos being decoded into pool-ready elements: one in flight,
   * the rest queued. See `warmUpcomingVideoElements`.
   */
  private videoWarmQueue: VideoWarmTarget[] = [];
  private videoWarmInFlight: { key: string; video: HTMLVideoElement } | null = null;
  /** Stops a lookahead that is still waiting for the visible slide to paint. */
  private lookaheadHold: (() => void) | null = null;
  /** Fully decoded images for the next presentable slides, kept alive until use. */
  private warmedImages = new Map<string, HTMLImageElement>();
  private imageWarmGeneration = 0;

  constructor(opts: PlayerOptions) {
    this.deck = opts.deck;
    prepareCodeBlocks(opts.deck);
    this.container = opts.container;
    this.networkSrc = opts.resolveSrc;
    this.videoBlobs = opts.videoBlobs ?? null;
    // Every URL the player renders, pools or warms goes through here, so a
    // clip's presentation key names the same URL everywhere at any moment.
    this.resolveSrc = (src) => {
      const url = this.networkSrc(src);
      return this.videoBlobs?.objectUrl(url) ?? url;
    };
    this.onCursor = opts.onCursor;
    if (this.videoBlobs) {
      this.videoBlobs.setInUse((objectUrl) => this.readsUrl(objectUrl));
      // A clip landing in memory is one the lookahead was waiting for.
      this.offBlobReady = this.videoBlobs.onReady(() => {
        if (!this.lookaheadHold) this.warmUpcomingMedia();
      });
    }

    this.container.classList.add('player-root');
    this.stage = document.createElement('div');
    this.stage.className = 'stage';
    this.container.replaceChildren(this.stage);

    this.resizeObserver = new ResizeObserver(() => this.rescale());
    this.resizeObserver.observe(this.container);

    // A skipped slide is hidden from the audience everywhere else -- Present
    // walks past it and the PDF export drops it -- so opening a standalone web
    // export on one would show a slide the author had explicitly hidden.
    const first = opts.deck.slides.findIndex((slide) => !slide.skipped);
    this.goTo({ slide: first < 0 ? 0 : first, step: 0 });

    // Chromium pauses muted video in a hidden or occluded page, and
    // retryPlayback deliberately declines to fight that while hidden. Becoming
    // visible again is therefore a required re-kick, not an optimisation:
    // without it, a presenter who switches Spaces or is briefly occluded comes
    // back to every clip frozen on its last frame, intent still recorded but
    // nothing left to act on it.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('message', this.onWebBridgeMessage);
    }
  }

  /** The last deck → page event, replayed to a frame that finishes loading after it was sent. */
  private lastWebEvent: WebBridgeEvent | null = null;

  /**
   * Tell every web frame on the stage what the deck is doing. A frame that is
   * still loading has no listener yet, so the message is repeated when it
   * loads — a page's `onActive` then fires exactly once, whichever came first.
   */
  private notifyWebFrames(event: WebBridgeEvent): void {
    this.lastWebEvent = event;
    for (const frame of this.stage.querySelectorAll<HTMLIFrameElement>('iframe.web-frame')) {
      if (frame.dataset.bridgeBound !== 'true') {
        frame.dataset.bridgeBound = 'true';
        frame.addEventListener('load', () => {
          if (frame.isConnected && this.lastWebEvent) {
            frame.contentWindow?.postMessage(this.lastWebEvent, '*');
          }
        });
      }
      frame.contentWindow?.postMessage(event, '*');
    }
  }

  /**
   * A web page asking the deck to move. Only frames on this stage are heard —
   * the message's `source` window must be one of ours — so a page cannot drive
   * a presentation it is not part of. Forwarded keys are re-dispatched on the
   * host window, where whatever bound the presenting keys handles them.
   */
  private onWebBridgeMessage = (event: MessageEvent): void => {
    if (!isWebBridgeAction(event.data)) return;
    const frames = [...this.stage.querySelectorAll<HTMLIFrameElement>('iframe.web-frame')];
    if (!frames.some((frame) => frame.contentWindow === event.source)) return;
    const message = event.data;
    if (message.action === 'next') this.next();
    else if (message.action === 'prev') this.prev();
    else {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: message.key, bubbles: true, cancelable: true,
      }));
    }
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible' || this.blanked) return;
    for (const [id, video] of this.intendedVideos()) {
      if (video.dataset.holdFrame === 'true') continue;
      // A fresh budget: the pauses that exhausted it were the hidden page's.
      this.playAttempts.delete(id);
      void video.play().catch(() => this.retryPlayback(id, video));
    }
  };

  /** The <video> nodes the build state currently wants running. */
  private *intendedVideos(): Iterable<[string, HTMLVideoElement]> {
    for (const id of this.intendedPlaying) {
      const video = this.stage.querySelector<HTMLVideoElement>(
        `[data-element-id="${CSS.escape(id)}"] video`,
      );
      if (video && video.isConnected) yield [id, video];
    }
  }

  destroy(): void {
    this.clearPending();
    if (this.rateBadgeTimer) clearTimeout(this.rateBadgeTimer);
    this.rateBadge?.remove();
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleWaiters = [];
    this.offBlobReady?.();
    this.offBlobReady = null;
    this.videoBlobs?.setInUse(null);
    this.resizeObserver.disconnect();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.onWebBridgeMessage);
    }
    // Detached media elements keep playing and keep downloading; a destroyed
    // player must leave neither a voice nor an open connection behind.
    for (const video of this.stage.querySelectorAll('video')) {
      releaseDecodedVideo(video);
    }
    this.lookaheadHold?.();
    this.videoWarmQueue = [];
    if (this.videoWarmInFlight) {
      releaseDecodedVideo(this.videoWarmInFlight.video);
      this.videoWarmInFlight = null;
    }
    this.videoPool.clear();
    for (const image of this.warmedImages.values()) image.removeAttribute('src');
    this.warmedImages.clear();
    this.container.replaceChildren();
  }

  getCursor(): Cursor {
    return { ...this.cursor };
  }

  /**
   * Resolves once every build of the current step has run and finished
   * animating: the moment a presenter's next click would find nothing still
   * moving. For a caller that steps a slide by itself, like the editor's build
   * preview. A build waiting on a video that never ends never settles, just as
   * it never fires when presenting; moving to another step settles at once.
   */
  whenStepSettles(): Promise<void> {
    return new Promise((resolve) => {
      this.settleWaiters.push(resolve);
      this.checkSettled();
    });
  }

  private checkSettled(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.buildsDue > 0 || this.settleWaiters.length === 0) return;
    const left = this.animatedUntil - performance.now();
    if (left > 0) {
      this.settleTimer = setTimeout(() => this.checkSettled(), left);
      return;
    }
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Swap in a new deck, keeping the cursor where it still makes sense. */
  setDeck(deck: Deck): void {
    this.deck = deck;
    prepareCodeBlocks(deck);
    const slide = Math.min(this.cursor.slide, Math.max(0, deck.slides.length - 1));
    const steps = deck.slides[slide] ? stepCount(deck.slides[slide]) : 1;
    this.goTo({ slide, step: Math.min(this.cursor.step, steps - 1) });
  }

  next(): void {
    const target = nextCursor(this.deck.slides, this.cursor);
    if (target.slide === this.cursor.slide && target.step === this.cursor.step) return;
    // Advancing within a slide plays the new step's build; changing slide is a
    // fresh render.
    if (target.slide === this.cursor.slide) this.advanceStep(target.step);
    else this.goTo(target, { play: true });
  }

  prev(): void {
    const target = prevCursor(this.deck.slides, this.cursor);
    if (target.slide === this.cursor.slide && target.step === this.cursor.step) return;
    this.goTo(target);
  }

  /**
   * Open a slide at its first step. A presentation passes `play` — starting
   * the show, Home, the presenter's "go to slide" — so builds set to run on
   * arriving at the slide run, as they do when the talk advances onto it.
   */
  goToSlide(index: number, opts: { play?: boolean } = {}): void {
    this.goTo({ slide: index, step: 0 }, opts);
  }

  /**
   * Full render of a slide at a given step, with the state resolved instantly.
   *
   * With `play`, arriving at step 0 plays that step's builds as authored —
   * the ones set to run after (or with) the slide appearing, with their
   * delays and effects — the way advancing to any later step does. Builds
   * that land at once with no effect are still part of the first paint, so a
   * Morph into the slide sees them. Jumping never plays: it resolves.
   *
   * `morph: false` is a jump that must not animate even onto the very next
   * slide: a deep link, or a capture that renders slides one after another in
   * the same page and would otherwise photograph the transition in flight.
   */
  goTo(cursor: Cursor, opts: { play?: boolean; morph?: boolean } = {}): void {
    this.clearPending();
    // Released by the lookahead once this slide can paint.
    this.videoBlobs?.hold();
    const slides = this.deck.slides;
    if (slides.length === 0) {
      this.stage.replaceChildren();
      return;
    }
    const previousSlideIndex = this.cursor.slide;
    const slide = slides[Math.min(Math.max(cursor.slide, 0), slides.length - 1)];
    const previousSlide = slides[previousSlideIndex];
    const explicitPairs = previousSlide
      ? explicitMorphPairs(previousSlide.elements, slide.elements)
      : [];
    const morphEnabled = slide.morphFromPrevious ?? explicitPairs.length > 0;
    // Only the step from one slide to the very next one is a Morph. The
    // flag describes a slide's relationship to the slide before it, so jumping
    // -- a rail click, goToSlide, or stepping backwards -- used to animate
    // between two slides that were never authored as a pair, which reads as
    // objects flying around at random.
    const morph = opts.morph !== false && slides.indexOf(slide) === previousSlideIndex + 1
      && previousSlide !== undefined && morphEnabled;
    const steps = stepCount(slide);
    this.cursor = {
      slide: slides.indexOf(slide),
      step: Math.min(Math.max(cursor.step, 0), steps - 1),
    };

    // A video that appears on consecutive slides (Keynote's "plays across
    // slides") must continue, not restart: keep the playing element itself and
    // adopt it into the new slide. A freshly created element — even seeked to
    // the same position — paints nothing until its decoder produces a frame,
    // which shows as a white flash at the slide switch. The live element keeps
    // its decoded frame, so the picture never drops out.
    // Keyed by file, but a *queue* per file: a deck routinely shows the same
    // clip in several elements at once, and one live element can only continue
    // in one of them. Handing it to every slot in turn would move it out of
    // each one as the next claimed it, leaving empty wrappers whose border
    // overlays still paint — a video that reads as having gone transparent.
    // Identity first, file second. Keying on the file alone handed the live
    // element to whichever slot happened to paint first, so a deck showing one
    // clip in two elements continued the wrong one: the element that was really
    // playing got a fresh node, and the adopter -- not in the new state's
    // playing set -- was then paused. Matching on element id keeps continuity
    // with the object it belongs to, and the file is the fallback for the case
    // the feature exists for: the same clip re-placed under a new id.
    // Paused videos are carried too: a revisited slide's clip already holds a
    // decoded frame and (usually) the file's bytes, and recreating the element
    // meant a black box plus a full re-fetch — on a slow link, a slide whose
    // videos never came back. Playing ones continue in place; parked ones are
    // adopted as instant pictures and reset to their in-point below.
    const carried: Array<{
      video: HTMLVideoElement;
      id: string | null;
      src: string;
      key: string;
      playing: boolean;
      failed: boolean;
    }> = [];
    for (const video of this.stage.querySelectorAll('video')) {
      carried.push({
        video,
        id: video.closest<HTMLElement>('[data-element-id]')?.dataset.elementId ?? null,
        src: video.getAttribute('src') ?? '',
        key: video.dataset.mediaKey ?? '',
        playing: !video.paused && video.currentTime > 0,
        failed: Boolean(video.error),
      });
    }
    const previousNodes = new Map<string, HTMLElement>();
    if (morph) {
      for (const node of this.stage.querySelectorAll<HTMLElement>('[data-element-id]')) {
        const id = node.dataset.elementId;
        if (id && node.style.visibility !== 'hidden') {
          const clone = node.cloneNode(true) as HTMLElement;
          freezeClonedVideos(node, clone);
          previousNodes.set(id, clone);
        }
      }
    }

    const rendered = renderSlide(slide, { resolveSrc: this.resolveSrc });
    this.adoptWarmedImages(rendered);
    revealImagesWhenDecoded(rendered);
    this.stage.replaceChildren(rendered);
    this.notifyWebFrames({ source: WEB_BRIDGE_SOURCE, event: 'active', step: this.cursor.step, steps });

    // Two passes, because identity has to win globally rather than per node: a
    // single pass let an earlier-painting element claim the live video by file
    // before the element it actually belongs to was even considered.
    const adopted = new Set<HTMLVideoElement>();
    const inPointOf = (video: HTMLVideoElement): number => {
      const id = video.closest<HTMLElement>('[data-element-id]')?.dataset.elementId;
      const el = slide.elements.find((e) => e.id === id);
      return el && el.type === 'video' ? el.start : 0;
    };
    const adopt = (rendered: HTMLVideoElement, live: HTMLVideoElement, playing: boolean): void => {
      adopted.add(live);
      // The rendered element carries the new slide's presentation (crop
      // offsets, fit, trim-aware loop flag); move all of it onto the live
      // element before it takes the rendered one's place.
      live.style.cssText = rendered.style.cssText;
      live.loop = rendered.loop;
      live.muted = rendered.muted;
      live.controls = rendered.controls;
      // The adopted element now presents this slot, so it carries this slot's
      // identity: the pool must file it under where it ends up, not where it
      // came from.
      if (rendered.dataset.mediaKey) live.dataset.mediaKey = rendered.dataset.mediaKey;
      rendered.replaceWith(live);
      // The rendered element is off the document, but its preload fetch is
      // not: a detached media element keeps downloading. Every adoption used
      // to leak one full-file fetch this way, and a few slide changes were
      // enough to occupy all six of the origin's connections with downloads
      // nobody would ever watch — which is why a revisited slide's videos
      // could sit on a spinner forever.
      rendered.removeAttribute('src');
      rendered.load();
      // A parked video continues nothing: it is adopted purely as an instant
      // picture, so it restarts from its in-point like a fresh element would.
      if (!playing && live.dataset.holdFrame !== 'true') {
        const inPoint = inPointOf(live);
        if (Math.abs(live.currentTime - inPoint) > 0.05) live.currentTime = inPoint;
      }
    };
    const idOf = (video: HTMLVideoElement): string | null =>
      video.closest<HTMLElement>('[data-element-id]')?.dataset.elementId ?? null;

    // Playing clips claim their slots first, by identity then by file: a video
    // that "plays across slides" must continue in the object it belongs to,
    // and a continuously decoding element re-paints every frame, so moving one
    // into a differently shaped slot is safe.
    for (const pass of ['id', 'src'] as const) {
      for (const video of [...this.stage.querySelectorAll('video')]) {
        if (adopted.has(video)) continue;
        const id = idOf(video);
        const src = video.getAttribute('src') ?? '';
        const match = pass === 'id'
          ? carried.find((c) =>
            !adopted.has(c.video) && !c.failed && c.playing && c.id !== null && c.id === id)
          : carried.find((c) => !adopted.has(c.video) && !c.failed && c.playing && c.src === src);
        if (!match || match.video === video) continue;
        adopt(video, match.video, true);
      }
    }

    // Parked elements are adopted purely as an instant picture, and only into a
    // slot with the same presentation key — same file, same frame, same
    // geometry. Reusing across shapes needs a seek, and until that seek lands
    // the compositor keeps painting the old frame stretched into the new box:
    // a video that is visibly squished for half a second (docs/media-loading.md).
    for (const source of [carried, null] as const) {
      for (const video of [...this.stage.querySelectorAll('video')]) {
        if (adopted.has(video)) continue;
        const key = video.dataset.mediaKey ?? '';
        if (!key) continue;
        // An element with no decoded frame is worth nothing: adopting it would
        // just move the black box, so leave the fresh element to load. The
        // pool is checked before taking from it, so an unusable entry is not
        // silently dropped on the floor still holding an open fetch.
        // Nor is one whose load failed, even with a frame on screen: a media
        // element never recovers from an error by itself, so reusing it made
        // a clip that lost its connection once dead on every later visit.
        const usable = (candidate: HTMLVideoElement | undefined): boolean =>
          candidate !== undefined
          && candidate !== video
          && !candidate.error
          && candidate.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        let match: HTMLVideoElement | undefined;
        if (source) {
          match = source.find((c) => !adopted.has(c.video) && !c.playing && c.key === key)?.video;
          if (!usable(match)) continue;
        } else {
          const candidate = this.videoPool.take(key);
          if (!usable(candidate)) {
            if (candidate) releaseDecodedVideo(candidate);
            continue;
          }
          match = candidate;
        }
        adopt(video, match!, false);
      }
    }

    // Anything left over is detached but still active: in Chromium a media
    // element removed from the document keeps playing *and keeps downloading*,
    // and `applyState` only ever pauses videos it can still find under the
    // stage. Decoded elements go to the pool for the next visit; the rest are
    // aborted outright so they stop occupying a connection.
    for (const { video, key } of carried) {
      if (adopted.has(video) || video.isConnected) continue;
      video.pause();
      if (key && !video.error && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        this.videoPool.add(key, video);
      } else {
        releaseDecodedVideo(video);
      }
    }
    this.awaitClipsOnTheirWayIntoMemory(slide, adopted);

    this.rescale();

    const entering = opts.play === true && this.cursor.step === 0;
    const entry = entering ? groupIntoSteps(slide)[0] ?? [] : [];
    // Everything up to the first build that waits or animates happens now.
    const waits = entry.findIndex((unit) => unit.trigger.on === 'mediaEnd'
      || unit.trigger.delay > 0 || buildEffect(unit, slide) !== null);
    const instant = waits < 0 ? entry : entry.slice(0, waits);
    const played = waits < 0 ? [] : entry.slice(waits);
    const state = resolveState(slide, played.length > 0 ? -1 : this.cursor.step);
    if (played.length > 0) for (const unit of instant) applyAction(state, unit, slide);
    this.applyState(slide, state);
    if (morph && previousSlide) this.runMorph(previousSlide, slide, previousNodes);
    if (played.length > 0) this.playEntries(slide, played, state);
    this.startLookaheadWhenVisibleSlideCanPaint();
    this.onCursor?.(this.getCursor(), steps);
  }

  /**
   * A fresh element whose clip the blob cache is downloading right now takes
   * no source until that download ends, then the clip from memory (or, if it
   * did not land, from the network).
   *
   * The cache fetches the next slides' clips first, so a presenter who
   * advances quickly reaches a slide whose clip is still on its way. Opening
   * the network URL beside the download made two transfers of one file, and
   * Chromium's HTTP cache does not share an entry between them: the media
   * stack's range request waits 25 ms for the download writing the entry,
   * then bypasses the cache, and the whole clip crossed the wire again (the
   * intermittent "downloads nothing for the presentation" failure in
   * mediaTransferBudgetBrowser). The download is the most urgent transfer
   * there is at that point, and the loading ring shows while it finishes.
   *
   * Runs in the task that rendered the slide: the element's resource
   * selection waits for a stable state, so taking the source away here means
   * it never opened a connection. Adopted elements keep what they are
   * already playing.
   */
  private awaitClipsOnTheirWayIntoMemory(slide: Slide, adopted: Set<HTMLVideoElement>): void {
    const cache = this.videoBlobs;
    if (!cache) return;
    for (const video of this.stage.querySelectorAll('video')) {
      if (adopted.has(video)) continue;
      const network = video.getAttribute('src');
      if (!network || !cache.fetching(network)) continue;
      video.removeAttribute('src');
      void cache.settled(network).then((objectUrl) => {
        // The slide moved on, or the element was handed elsewhere: nothing to load.
        if (!video.isConnected || !this.stage.contains(video) || video.hasAttribute('src')) return;
        const src = objectUrl ?? network;
        const id = video.closest<HTMLElement>('[data-element-id]')?.dataset.elementId;
        const el = slide.elements.find((candidate) => candidate.id === id);
        // Filed under the URL it now reads, so the pool and the lookahead
        // match it with elements made for the same bytes.
        if (el?.type === 'video') video.dataset.mediaKey = videoPresentationKey(el, src);
        video.src = src;
        // A play() made while it had no source cannot start it; ask again
        // now that it has one, with a fresh retry budget.
        if (id && this.intendedPlaying.has(id) && !this.blanked && video.dataset.holdFrame !== 'true') {
          this.playAttempts.delete(id);
          this.keepPlaying(id, video);
        }
      });
    }
  }

  /**
   * Pull the video files of the next couple of slides into the HTTP cache,
   * one file at a time, while the current slide is on screen.
   *
   * A slide's own `<video>` elements only start fetching when the slide
   * renders, so over a remote server every transition used to open on clips
   * that pop in only once their bytes arrive. Assets are content-hashed and
   * served immutable (docs/media-loading.md), so a file warmed here is served
   * from cache the moment a slide's element asks for it. Strictly one transfer
   * in flight, and never a file the current slide is already fetching itself:
   * flooding the origin's six connections is the bug class this file is
   * defending against.
   */
  /**
   * Hold the lookahead until the slide on screen can actually paint.
   *
   * The lookahead competes with the visible slide for the origin's six
   * connections. On a remote server that is the difference between clicking
   * Present and seeing the opening clip, and clicking Present and watching a
   * black rectangle while bytes for a slide nobody has reached yet come down
   * the same pipe. The wait is capped: a clip that never loads must not
   * disable the lookahead for the rest of the talk, and a slide whose videos
   * are slow is exactly the deck that needs the next ones prepared.
   */
  private startLookaheadWhenVisibleSlideCanPaint(): void {
    this.lookaheadHold?.();
    const paints = (video: HTMLVideoElement): boolean =>
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || Boolean(video.error);
    const waiting = [...this.stage.querySelectorAll('video')].filter((v) => !paints(v));
    if (waiting.length === 0) {
      this.lookaheadHold = null;
      this.warmUpcomingMedia();
      return;
    }
    const offs: Array<() => void> = [];
    const release = (): void => {
      clearTimeout(timer);
      for (const off of offs) off();
      this.lookaheadHold = null;
    };
    const timer = setTimeout(() => {
      release();
      this.warmUpcomingMedia();
    }, LOOKAHEAD_HOLD_MS);
    const check = (): void => {
      if (!waiting.every(paints)) return;
      release();
      this.warmUpcomingMedia();
    };
    for (const video of waiting) {
      for (const name of ['loadeddata', 'seeked', 'error'] as const) {
        video.addEventListener(name, check);
        offs.push(() => video.removeEventListener(name, check));
      }
    }
    this.lookaheadHold = release;
  }

  private warmUpcomingMedia(): void {
    this.videoBlobs?.want(this.videoBlobOrder());
    const onCurrentSlide = new Set<string>();
    for (const el of this.deck.slides[this.cursor.slide]?.elements ?? []) {
      if (el.type === 'video' && !isPendingSrc(el.src)) onCurrentSlide.add(this.resolveSrc(el.src));
    }
    this.warmQueue = [];
    const upcomingSlides: Slide[] = [];
    const videoTargets: VideoWarmTarget[] = [];
    let slidesAhead = 0;
    for (let i = this.cursor.slide + 1;
      i < this.deck.slides.length && slidesAhead < WARM_AHEAD_SLIDES;
      i += 1) {
      const upcoming = this.deck.slides[i];
      if (upcoming.skipped) continue;
      slidesAhead += 1;
      upcomingSlides.push(upcoming);
      for (const el of upcoming.elements) {
        if (el.type !== 'video' || isPendingSrc(el.src)) continue;
        // A clip on its way into memory is decoded once it lands (the cache's
        // ready listener calls back here); warming it from the network now
        // would download it twice.
        const network = this.networkSrc(el.src);
        if (this.videoBlobs?.covers(network) && !this.videoBlobs.objectUrl(network)) continue;
        const src = this.resolveSrc(el.src);
        if (onCurrentSlide.has(src)) continue;
        // A decoded element is strictly better than cached bytes, so the
        // first few videos ahead are warmed as elements and only the overflow
        // falls back to a plain transfer.
        const key = videoPresentationKey(el, src);
        if (videoTargets.length < VIDEO_WARM_ELEMENT_LIMIT) {
          if (!videoTargets.some((target) => target.key === key)) {
            videoTargets.push({ src, key, start: el.start });
          }
          continue;
        }
        // Bytes already in memory need no HTTP cache.
        if (this.warmedSrcs.has(src) || src !== network) continue;
        if (!this.warmQueue.includes(src)) this.warmQueue.push(src);
      }
    }
    this.warmUpcomingVideoElements(videoTargets);
    this.warmUpcomingImages(upcomingSlides);
    this.pumpWarmQueue();
  }

  /**
   * The deck's clips in the order the blob cache should fetch them: the next
   * two slides first (what the talk reaches soonest), then the slide on
   * screen, whose elements are already streaming it but whose revisits and
   * loops should not have to, then the rest of the talk ahead, then what lies
   * behind, nearest first. Skipped slides are not part of the talk.
   */
  private videoBlobOrder(): string[] {
    const slides = this.deck.slides;
    const here = this.cursor.slide;
    const ahead: number[] = [];
    const behind: number[] = [];
    for (let i = here + 1; i < slides.length; i += 1) if (!slides[i].skipped) ahead.push(i);
    for (let i = here - 1; i >= 0; i -= 1) if (!slides[i].skipped) behind.push(i);
    const order = [...ahead.slice(0, WARM_AHEAD_SLIDES), here, ...ahead.slice(WARM_AHEAD_SLIDES), ...behind];
    const urls: string[] = [];
    for (const index of order) {
      for (const el of slides[index]?.elements ?? []) {
        if (el.type === 'video' && !isPendingSrc(el.src)) urls.push(this.networkSrc(el.src));
      }
    }
    return urls;
  }

  /** Whether any element this player owns, on the stage or parked, reads `url`. */
  private readsUrl(url: string): boolean {
    const videos = [
      ...this.stage.querySelectorAll('video'),
      ...this.videoPool.values(),
      ...(this.videoWarmInFlight ? [this.videoWarmInFlight.video] : []),
    ];
    return videos.some((video) => video.getAttribute('src') === url);
  }

  /**
   * Decode the next slides' videos into real elements, parked in the pool.
   *
   * Byte-warming alone leaves exactly the gap this closes: a `<video>` paints
   * nothing until its decoder produces a frame, so even with the file already
   * in cache a slide change opens on a black box for a beat while the fresh
   * element attaches, demuxes and decodes — the "videos take a second to show
   * up on every slide" report. A lookahead element does that work while the
   * previous slide is still on screen, and `goTo` already adopts pool entries
   * into matching slots, so the picture is there in the frame the slide
   * appears.
   *
   * One decode at a time (the connection budget in docs/media-loading.md is
   * the whole reason this file meters anything), capped, and keyed by
   * presentation so an entry is only adopted into a slot showing the same
   * file, frame and geometry.
   */
  private warmUpcomingVideoElements(targets: VideoWarmTarget[]): void {
    const inFlight = this.videoWarmInFlight;
    // A decode nothing is walking towards any more is a connection held for a
    // slide that left the lookahead: drop it rather than let it finish.
    if (inFlight && !targets.some((target) => target.key === inFlight.key)) {
      releaseDecodedVideo(inFlight.video);
      this.videoWarmInFlight = null;
    }
    this.videoWarmQueue = targets.filter(
      (target) => target.key !== this.videoWarmInFlight?.key,
    );
    this.pumpVideoWarmQueue();
  }

  private pumpVideoWarmQueue(): void {
    if (this.videoWarmInFlight || typeof document === 'undefined') return;
    let target = this.videoWarmQueue.shift();
    while (target && this.videoPool.has(target.key)) target = this.videoWarmQueue.shift();
    if (!target) return;
    const video = document.createElement('video');
    // Hint before src, like renderVideo: assigning src is what starts
    // resource selection, and it reads the preload hint of that moment.
    video.preload = 'auto';
    video.playsInline = true;
    video.muted = true;
    video.dataset.mediaKey = target.key;
    video.addEventListener('error', () => video.classList.add('media-failed'));
    const entry = { key: target.key, video };
    this.videoWarmInFlight = entry;
    // Listeners first, then the source: assigning src is what starts the load,
    // and its events are queued rather than fired synchronously.
    const warming = decodeVideoFrame(video, target.start, VIDEO_WARM_TIMEOUT_MS);
    video.src = target.src;
    void warming.then((decoded) => {
      // Superseded: warmUpcomingVideoElements already released this element.
      if (this.videoWarmInFlight !== entry) return;
      this.videoWarmInFlight = null;
      // add() releases whatever it declines to keep.
      if (decoded) this.videoPool.add(entry.key, video);
      else releaseDecodedVideo(video);
      this.pumpVideoWarmQueue();
    });
  }

  /**
   * Decode upcoming still images before they become visible.
   *
   * Byte caching alone is insufficient for large JPEGs: Chromium may paint
   * the scanlines decoded so far, which looks like a thin strip at the top of
   * the element. Keeping the decoded `<img>` itself alive lets `goTo` adopt a
   * complete bitmap atomically. Only the current lookahead is retained, so a
   * long image-heavy deck does not accumulate decoded 4K/6K frames in memory.
   */
  private warmUpcomingImages(slides: Slide[]): void {
    const generation = ++this.imageWarmGeneration;
    const desired = new Set<string>();
    for (const slide of slides) {
      if (slide.background.image && !isPendingSrc(slide.background.image)) {
        desired.add(this.resolveSrc(slide.background.image));
      }
      for (const el of slide.elements) {
        if (el.type !== 'image' || isPendingSrc(el.src) || /\.pdf(?:$|[?#])/i.test(el.src)) continue;
        desired.add(this.resolveSrc(el.src));
      }
    }

    for (const [src, image] of this.warmedImages) {
      if (desired.has(src)) continue;
      image.removeAttribute('src');
      this.warmedImages.delete(src);
    }
    void this.warmImageSources([...desired], generation);
  }

  /** Decode sequentially so two upcoming media-wall slides cannot spike memory. */
  private async warmImageSources(sources: string[], generation: number): Promise<void> {
    let retainedPixels = [...this.warmedImages.values()].reduce(
      (sum, image) => sum + image.naturalWidth * image.naturalHeight,
      0,
    );
    for (const src of sources) {
      if (
        generation !== this.imageWarmGeneration
        || this.warmedImages.size >= IMAGE_WARM_COUNT_LIMIT
        || retainedPixels >= IMAGE_WARM_PIXEL_LIMIT
      ) return;
      if (this.warmedImages.has(src)) continue;
      const image = document.createElement('img');
      image.decoding = 'async';
      image.src = src;
      this.warmedImages.set(src, image);
      await decodeImage(image);
      if (generation !== this.imageWarmGeneration) return;
      retainedPixels += image.naturalWidth * image.naturalHeight;
    }
  }

  /** Move an already decoded lookahead image into the rendered slide. */
  private adoptWarmedImages(root: HTMLElement): void {
    for (const fresh of root.querySelectorAll<HTMLImageElement>('img')) {
      const src = fresh.getAttribute('src');
      if (!src) continue;
      const warmed = this.warmedImages.get(src);
      // A still-loading warmer is useful too: move its one in-flight request
      // into the slide and keep it hidden until decode completes, rather than
      // aborting it and starting the same large image again from a fresh node.
      if (!warmed || (warmed.complete && warmed.naturalWidth <= 0)) continue;
      warmed.className = fresh.className;
      warmed.style.cssText = fresh.style.cssText;
      warmed.alt = fresh.alt;
      warmed.draggable = fresh.draggable;
      fresh.replaceWith(warmed);
      this.warmedImages.delete(src);
    }
  }

  private pumpWarmQueue(): void {
    if (this.warmInFlight || typeof fetch !== 'function') return;
    const src = this.warmQueue.shift();
    if (src === undefined) return;
    this.warmInFlight = true;
    // Marked warmed up front: a failed warm just means the element fetches for
    // itself like before, and retrying a failing URL on every slide change
    // would be its own connection leak.
    this.warmedSrcs.add(src);
    let transfer: Promise<unknown>;
    try {
      transfer = fetch(src).then((response) => (response.ok ? response.blob() : null));
    } catch {
      transfer = Promise.resolve(null);
    }
    void transfer.catch(() => null).then(() => {
      this.warmInFlight = false;
      this.pumpWarmQueue();
    });
  }

  private runMorph(
    previous: Slide,
    next: Slide,
    previousNodes: Map<string, HTMLElement>,
  ): void {
    const duration = next.morphDuration ?? 1000;
    // The named curves map to beziers chosen for object motion, not the CSS
    // keywords of the same name: 'ease-out' front-loads the motion (snappy
    // arrival), while the default symmetric ease-in-out keeps mid-transition
    // speed high so paths don't crawl toward the end.
    const easing = {
      'ease-in-out': 'cubic-bezier(.45,.05,.55,.95)',
      'ease-out': 'cubic-bezier(.2,.8,.2,1)',
      linear: 'linear',
    }[this.deck.morphEasing];
    const targetSlide = this.stage.querySelector<HTMLElement>('.slide');
    if (!targetSlide) return;
    const pairs = matchMorphElements(previous.elements, next.elements);
    const pairedSources = new Set(pairs.map(([source]) => source.id));
    const pairedTargets = new Set(pairs.map(([, target]) => target.id));
    const unchanged = unchangedMorphPairs(
      previous.elements.filter((element) => !pairedSources.has(element.id)),
      next.elements.filter((element) => !pairedTargets.has(element.id)),
    );
    for (const [source, target] of unchanged) {
      pairedSources.add(source.id);
      pairedTargets.add(target.id);
    }
    // Near-identical leftovers (same object up to a few pixels of drift, as
    // imports routinely produce) glide the tiny delta as ordinary movers
    // instead of fading out and back in as two objects.
    const essential = essentialMorphPairs(
      previous.elements.filter((element) => !pairedSources.has(element.id)),
      next.elements.filter((element) => !pairedTargets.has(element.id)),
    );
    for (const pair of essential) {
      pairs.push(pair);
      pairedSources.add(pair[0].id);
      pairedTargets.add(pair[1].id);
    }
    // The same object recoloured on the next slide blends its paint rather
    // than fading out while a recoloured copy fades in.
    const restyled = restyledMorphPairs(
      previous.elements.filter((element) => !pairedSources.has(element.id)),
      next.elements.filter((element) => !pairedTargets.has(element.id)),
    );
    for (const pair of restyled) {
      pairs.push(pair);
      pairedSources.add(pair[0].id);
      pairedTargets.add(pair[1].id);
    }

    // Stacking during the transition. Paint order is normally DOM order (the
    // slide renders its elements z-sorted), but ghosts have to be appended
    // last, which would paint every removed object — a near-opaque backdrop
    // included — over objects it sat *below* on the source slide. So while the
    // transition runs, each participant carries an explicit z-index: the
    // source slide's z rank for the first half, the target's DOM rank for the
    // second, switching discretely at the same midpoint as the content. The
    // keyframes use fill 'none', so the settled stage keeps no trace of it.
    const sourceRank = new Map(
      [...previous.elements].sort((a, b) => a.z - b.z).map((element, i) => [element.id, i]),
    );
    const domRank = new Map<string, number>();
    [...targetSlide.children].forEach((child, i) => {
      const id = (child as HTMLElement).dataset.elementId;
      if (id) domRank.set(id, i);
    });
    const sourceOf = new Map<string, string>(
      [...pairs, ...unchanged].map(([source, target]) => [target.id, source.id]),
    );
    const stackingFrames = (targetId: string): Keyframe[] | null => {
      const src = sourceRank.get(sourceOf.get(targetId) ?? '');
      const dom = domRank.get(targetId);
      if (src === undefined || dom === undefined) return null;
      return [
        { zIndex: String(src), offset: 0 },
        { zIndex: String(src), offset: 0.499 },
        { zIndex: String(dom), offset: 0.5 },
        { zIndex: String(dom), offset: 1 },
      ];
    };

    // Whether anything in this transition carries an explicit z-index. Objects
    // that do would otherwise paint over every untouched object regardless of
    // authored order, since a settled slide relies on DOM order alone.
    let zIndexInUse = false;

    // Text is positioned from what the DOM actually laid out, so measure both
    // slides' glyphs before any transform is written.
    const textLayouts = measureTextLayouts(targetSlide, pairs, previousNodes);

    for (const [from, to] of pairs) {
      const node = this.stage.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(to.id)}"]`,
      );
      if (!node?.animate) continue;
      // A target that a build step has not revealed yet is not on screen, so
      // there is nothing to animate into. Release the source instead, so it
      // fades out as a ghost rather than popping out of existence.
      if (node.style.visibility === 'hidden') {
        pairedSources.delete(from.id);
        continue;
      }
      // Two equations that say different things move glyph by glyph: every
      // symbol they share travels to its new place, and only what was added
      // or removed fades. Nothing shared falls back to the object motion below.
      if (morphEquationGlyphs({
        from, to, node, source: previousNodes.get(from.id), duration, easing,
        zIndex: domRank.get(to.id),
      })) {
        zIndexInUse ||= domRank.has(to.id);
        continue;
      }
      const {
        start: startTransform,
        final: finalTransform,
        origin,
      } = morphTransforms(from, to, textLayouts.get(to.id) ?? null);
      const stacking = stackingFrames(to.id) ?? [];
      if (stacking.length) zIndexInUse = true;
      // The ease lives on the first keyframe, not the timing options: keyframe
      // easing applies per property segment, so the motion still eases across
      // the whole duration while the stacking offsets below stay in wall time,
      // flipping at the same real midpoint as every discrete switch.
      const motion = (opacity: [string, string]): Keyframe[] => [
        {
          transform: startTransform,
          transformOrigin: origin,
          opacity: opacity[0],
          offset: 0,
          easing,
          ...(stacking.length ? { zIndex: stacking[0].zIndex } : {}),
        },
        ...stacking.slice(1, 3),
        {
          transform: finalTransform,
          transformOrigin: origin,
          opacity: opacity[1],
          offset: 1,
          ...(stacking.length ? { zIndex: stacking[3].zIndex } : {}),
        },
      ];
      node.animate(motion([String(from.opacity), String(to.opacity)]), { duration, easing: 'linear', fill: 'none' });
      this.blendMorphPaint(from, to, node, previousNodes, motion, { duration, easing });
    }

    // Genuinely new objects (nothing on the source slide is even essentially
    // the same) fade in over the final quarter, after the movers have mostly
    // settled. The windows are fixed fractions of wall time and linear, so
    // dense arrow diagrams fade as one — the stagger that discrete switching
    // was introduced to avoid came from easing the fades, not from fading.
    for (const target of next.elements) {
      if (pairedTargets.has(target.id)) continue;
      const node = this.stage.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(target.id)}"]`,
      );
      if (!node?.animate || node.style.visibility === 'hidden') continue;
      const dom = domRank.get(target.id);
      const zIndex = dom === undefined ? {} : { zIndex: String(dom) };
      if (dom !== undefined) zIndexInUse = true;
      node.animate([
        { opacity: '0', offset: 0, ...zIndex },
        { opacity: '0', offset: 0.75, ...zIndex },
        { opacity: String(target.opacity), offset: 1, ...zIndex },
      ], { duration, easing: 'linear', fill: 'none' });
    }

    // Removed, unpaired source objects no longer exist in the target render.
    // Animate exact clones of the visible old DOM, then remove them so the
    // settled stage remains byte-for-byte the target slide.
    let hasGhosts = false;
    for (const source of previous.elements) {
      if (pairedSources.has(source.id)) continue;
      const ghost = previousNodes.get(source.id);
      if (!ghost) continue;
      ghost.classList.add('morph-ghost');
      ghost.dataset.morphSourceId = source.id;
      delete ghost.dataset.elementId;
      ghost.style.pointerEvents = 'none';
      ghost.style.visibility = 'visible';
      targetSlide.appendChild(ghost);
      if (!ghost.animate) {
        ghost.remove();
        continue;
      }
      hasGhosts = true;
      // Removed objects fade out over the first quarter, clearing the stage
      // before the incoming objects' final-quarter fade begins.
      const zIndex = String(sourceRank.get(source.id) ?? 0);
      const animation = ghost.animate([
        { opacity: String(source.opacity), offset: 0, zIndex },
        { opacity: '0', offset: 0.25, zIndex },
        { opacity: '0', offset: 1, zIndex },
      ], { duration, easing: 'linear', fill: 'forwards' });
      void animation.finished.then(() => ghost.remove(), () => ghost.remove());
    }

    // Anything given an explicit z-index paints above everything without one,
    // so once a single participant is stacked, the visually-unchanged objects
    // have to join the same scale -- otherwise a mover slides over the box that
    // is meant to cover it. A transition where nothing was stacked stays free
    // of animations entirely.
    if (zIndexInUse || hasGhosts) {
      for (const [, target] of unchanged) {
        const node = this.stage.querySelector<HTMLElement>(
          `[data-element-id="${CSS.escape(target.id)}"]`,
        );
        const frames = stackingFrames(target.id);
        if (!node?.animate || !frames || node.style.visibility === 'hidden') continue;
        node.animate(frames, { duration, easing: 'linear', fill: 'none' });
      }
    }
  }

  /**
   * Carry a paired object's paint across a Morph instead of switching it.
   *
   * A shape's fill, stroke, stroke width and filter (its shadow) are
   * interpolated on the shape itself, so a recoloured box changes colour as
   * it moves. Anything else whose look changed (a text's colour, a text box's
   * fill) is blended: a copy of the source object rides exactly over the
   * target, with the same motion, and fades away while the target stays
   * opaque beneath it, so every pixel moves in a straight line from the old
   * paint to the new instead of the object dipping out and back in.
   */
  private blendMorphPaint(
    from: SlideElement,
    to: SlideElement,
    node: HTMLElement,
    previousNodes: Map<string, HTMLElement>,
    motion: (opacity: [string, string]) => Keyframe[],
    timing: { duration: number; easing: string },
  ): void {
    const { duration, easing } = timing;
    const style = (element: SlideElement, property: string): string => element.style[property] ?? '';
    const filterChanged = style(from, 'filter') !== style(to, 'filter');

    // A gradient cannot be tweened as one paint value, so a gradient fill that
    // changes at all crossfades like any other restyle below; so does a
    // styled stroke, drawn apart from its fill.
    const gradientChanged = from.type === 'shape' && to.type === 'shape'
      && (Boolean(from.fillGradient || to.fillGradient)
        || strokeStyleOf(from) !== 'pen' || strokeStyleOf(to) !== 'pen');
    if (from.type === 'shape' && to.type === 'shape' && !gradientChanged) {
      const paint = (shape: typeof from): Keyframe => ({
        // A shape with no fill blends from (or to) the same colour, clear.
        fill: shape.shape === 'line' || shape.shape === 'arrow' ? 'none' : shape.fill ?? 'transparent',
        stroke: shape.stroke ?? 'transparent',
        strokeWidth: `${shape.strokeWidth}px`,
      });
      const start = paint(from);
      const end = paint(to);
      const changed = start.fill !== end.fill || start.stroke !== end.stroke
        || start.strokeWidth !== end.strokeWidth;
      const svg = node.querySelector('svg');
      const drawn = svg?.querySelector<SVGElement>(':scope > :is(rect, ellipse, line, path)');
      if (changed && drawn?.animate) {
        drawn.animate([{ ...start, easing }, end], { duration, fill: 'none' });
        // Heads and a curve's round ends are filled with the stroke colour:
        // a line's heads are paths of their own, a drawn path's sit in a marker.
        if (start.stroke !== end.stroke) {
          for (const head of svg?.querySelectorAll<SVGElement>(':scope > path.arrowhead, :scope > circle, marker path') ?? []) {
            head.animate?.([{ fill: start.stroke, easing }, { fill: end.stroke }], { duration, fill: 'none' });
          }
        }
      }
      if (filterChanged && node.animate) {
        node.animate([
          { filter: style(from, 'filter') || 'none', easing },
          { filter: style(to, 'filter') || 'none' },
        ], { duration, fill: 'none' });
      }
      return;
    }

    const {
      x: _fx, y: _fy, w: _fw, h: _fh, rot: _fr, flipX: _ffx, flipY: _ffy, z: _fz, id: _fi, morphId: _fm, lineageId: _fl,
      ...fromLook
    } = from;
    const {
      x: _tx, y: _ty, w: _tw, h: _th, rot: _tr, flipX: _tfx, flipY: _tfy, z: _tz, id: _ti, morphId: _tm, lineageId: _tl,
      ...toLook
    } = to;
    if (JSON.stringify(fromLook) === JSON.stringify(toLook)) return;
    const source = previousNodes.get(from.id);
    if (!source || !node.animate) return;
    const ghost = source.cloneNode(true) as HTMLElement;
    ghost.classList.add('morph-ghost');
    delete ghost.dataset.elementId;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.pointerEvents = 'none';
    ghost.style.visibility = 'visible';
    // Laid in the target's box, so the target's motion is the ghost's too.
    for (const property of ['left', 'top', 'width', 'height', 'transform'] as const) {
      ghost.style[property] = node.style[property];
    }
    node.after(ghost);
    // Text that changed its words is a different title in the same place:
    // dissolving one through the other shows both, overlapping, for most of
    // the transition. So is text laid out differently (another alignment,
    // size, face or box): the copy, laid in the target's box, sits beside
    // the target rather than over it. Either moves as one object and swaps
    // at the midpoint; only a change of paint dissolves.
    const words = (element: SlideElement): string | null => (element.type === 'text'
      ? element.html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
      : null);
    const swap = from.type === 'text' && to.type === 'text'
      && (words(from) !== words(to) || textLayout(from) !== textLayout(to));
    const animation = ghost.animate(
      motion(swap ? [String(from.opacity), String(from.opacity)] : [String(from.opacity), '0']),
      { duration, easing: 'linear', fill: 'forwards' },
    );
    if (swap) {
      const hard = (before: string, after: string): Keyframe[] => [
        { opacity: before, offset: 0 }, { opacity: before, offset: 0.5 },
        { opacity: after, offset: 0.5 }, { opacity: after, offset: 1 },
      ];
      ghost.animate(hard(String(from.opacity), '0'), { duration, easing: 'linear', fill: 'forwards' });
      node.animate(hard('0', String(to.opacity)), { duration, easing: 'linear', fill: 'none' });
    }
    const remove = (): void => ghost.remove();
    void animation.finished.then(remove, remove);
  }

  /**
   * Run the entries belonging to `step` against the DOM already on screen,
   * honouring delays and media-end chaining so builds play as authored.
   */
  private advanceStep(step: number): void {
    this.clearPending();
    const slide = this.deck.slides[this.cursor.slide];
    this.cursor = { slide: this.cursor.slide, step };
    this.notifyWebFrames({ source: WEB_BRIDGE_SOURCE, event: 'step', step, steps: stepCount(slide) });

    // State is tracked incrementally so each action lands on top of what the
    // previous ones did, matching what `resolveState` would produce.
    this.playEntries(slide, groupIntoSteps(slide)[step] ?? [], resolveState(slide, step - 1));
    this.onCursor?.(this.getCursor(), stepCount(slide));
  }

  /**
   * Run a step's entries against the DOM already on screen, honouring
   * delays, media-end chaining and effects so builds play as authored.
   */
  private playEntries(slide: Slide, entries: ExpandedEntry[], state: SlideState): void {
    let cumulativeDelay = 0;
    // An animated build takes time, and "after previous" means after it has
    // finished, as in Keynote: the next one waits until everything started
    // so far has ended — a slow dissolve is not over just because something
    // instant ran with it.
    let latestEnd = 0;
    for (const entry of entries) {
      this.buildsDue += 1;
      const run = () => {
        this.buildsDue -= 1;
        const duration = this.runEntry(slide, entry, state);
        this.animatedUntil = Math.max(this.animatedUntil, performance.now() + duration);
        this.checkSettled();
      };

      if (entry.trigger.on === 'mediaEnd' && entry.trigger.ref) {
        this.onMediaEnd(entry.trigger.ref, () => {
          if (entry.trigger.delay > 0) this.later(run, entry.trigger.delay);
          else run();
        });
        continue;
      }

      // `click` opens the step and `afterPrev` chains from the previous entry;
      // `withPrev` fires alongside it, so only the chaining forms accumulate.
      if (entry.trigger.on === 'afterPrev') cumulativeDelay = latestEnd + entry.trigger.delay;
      else if (entry.trigger.on === 'withPrev') {
        // keep cumulativeDelay as-is: fire together with the previous action
      } else cumulativeDelay = entry.trigger.delay;
      const effect = buildEffect(entry, slide);
      latestEnd = Math.max(latestEnd, cumulativeDelay + (effect ? effectDuration(entry, effect) : 0));

      if (cumulativeDelay > 0) this.later(run, cumulativeDelay);
      else run();
    }
  }

  /** One entry, live: its action, and the animation it is authored with. Returns how long that animation takes. */
  private runEntry(slide: Slide, entry: ExpandedEntry, state: SlideState): number {
    const effect = buildEffect(entry, slide);
    const duration = effect ? effectDuration(entry, effect) : 0;
    const target = entry.action.target;
    // A dissolve out is a copy fading over the spot the element is leaving,
    // so the element itself is hidden at once and the state stays exact.
    const fade = effect === 'dissolve' || effect === 'blur' ? effect : null;
    if (fade && entry.action.type === 'disappear') this.dissolveOut(target, duration, fade === 'blur');
    // An equation build animates from what is on screen now (a term's old
    // colour), so it looks before the state lands and plays after.
    const equation = prepareEquationEffect(this.stage, slide, entry, duration);
    applyAction(state, entry, slide);
    this.applyState(slide, state);
    if (effect === 'draw') this.drawIn(slide, entry, duration);
    else if (fade && entry.action.type === 'appear') this.dissolveIn(target, duration, fade === 'blur');
    else if (effect === 'pop') this.popIn(target, duration, popScales(entry));
    if (equation) this.effects.push(equation());
    return duration;
  }

  /**
   * Keyframes for a fade, and for a blur the focus pull with it. The blur is
   * added in front of any filter the element already has (a drop shadow, an
   * effect), so the same filter list interpolates and the element's own look
   * is untouched once the animation ends.
   */
  private fadeFrames(node: HTMLElement, blurred: boolean, inward: boolean): Keyframe[] {
    const style = getComputedStyle(node);
    const opacity = style.opacity || '1';
    const own = style.filter && style.filter !== 'none' ? ` ${style.filter}` : '';
    const hidden: Keyframe = { opacity: '0', ...(blurred ? { filter: `blur(${BLUR_RADIUS}px)${own}` } : {}) };
    const shown: Keyframe = { opacity, ...(blurred ? { filter: `blur(0px)${own}` } : {}) };
    return inward ? [hidden, shown] : [shown, hidden];
  }

  private nodeFor(id: string): HTMLElement | null {
    return this.stage.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(id)}"]`);
  }

  /** Fade an element that has just been made visible up from nothing (and into focus, for a blur). */
  private dissolveIn(id: string, duration: number, blurred = false): void {
    const node = this.nodeFor(id);
    if (!node?.animate || duration <= 0 || node.style.visibility === 'hidden') return;
    const animation = node.animate(
      this.fadeFrames(node, blurred, true),
      { duration, easing: 'ease-in-out', fill: 'none' },
    );
    this.effects.push(() => animation.finish());
  }

  /**
   * Pop an element in: it fades in while growing from smaller, overshoots its
   * size a little and settles. `scale` composes with the element's own
   * transform (a rotation), so nothing about its resting look changes.
   */
  private popIn(id: string, duration: number, scales: { from: number; peak: number }): void {
    const node = this.nodeFor(id);
    if (!node?.animate || duration <= 0 || node.style.visibility === 'hidden') return;
    const opacity = getComputedStyle(node).opacity || '1';
    const animation = node.animate(
      [
        { opacity: '0', scale: String(scales.from), easing: 'cubic-bezier(.2,.8,.3,1)' },
        { opacity, scale: String(scales.peak), offset: 0.6, easing: 'cubic-bezier(.4,0,.4,1)' },
        { opacity, scale: '1' },
      ],
      { duration, fill: 'none' },
    );
    this.effects.push(() => animation.finish());
  }

  /**
   * Fade an element out: a copy of it, laid exactly over it in the same
   * paint order, fades while the element itself is already gone.
   */
  private dissolveOut(id: string, duration: number, blurred = false): void {
    const node = this.nodeFor(id);
    if (!node?.animate || duration <= 0 || node.style.visibility === 'hidden') return;
    const ghost = node.cloneNode(true) as HTMLElement;
    freezeClonedVideos(node, ghost);
    ghost.removeAttribute('data-element-id');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.pointerEvents = 'none';
    node.after(ghost);
    const animation = ghost.animate(
      this.fadeFrames(node, blurred, false),
      { duration, easing: 'ease-in-out', fill: 'forwards' },
    );
    const remove = (): void => ghost.remove();
    void animation.finished.then(remove, remove);
    this.effects.push(() => { animation.cancel(); remove(); });
  }

  /** Reconcile the DOM and media playback with a computed slide state. */
  private applyState(slide: Slide, state: SlideState): void {
    applyStaticSlideState(this.stage, slide, state);
    if (this.rateSlide !== slide.id) {
      this.rateSlide = slide.id;
      this.videoRate = 1;
    }
    for (const el of slide.elements) {
      const node = this.stage.querySelector<HTMLElement>(
        `[data-element-id="${CSS.escape(el.id)}"]`,
      );
      if (!node) continue;

      if (el.type !== 'video') continue;
      const video = node.querySelector('video');
      if (!video) continue;

      const seek = state.seeks.get(el.id);
      if (seek !== undefined && Math.abs(video.currentTime - seek) > 0.05) {
        video.currentTime = seek;
      }

      this.enforceTrim(el, video);

      // A capture path -- the PDF renderer, the export comparison -- pins each
      // video to an exact frame and owns it from then on. Reconciling playback
      // underneath that would drift the frame it just pinned.
      if (video.dataset.holdFrame === 'true') {
        this.intendedPlaying.delete(el.id);
        continue;
      }

      // Pooled videos arrive with whatever speed their last slide left them at.
      if (video.playbackRate !== this.videoRate) video.playbackRate = this.videoRate;

      if (state.playing.has(el.id) && state.visible.has(el.id) && !this.blanked) {
        this.keepPlaying(el.id, video);
      } else {
        this.intendedPlaying.delete(el.id);
        this.playAttempts.delete(el.id);
        if (!video.paused) video.pause();
      }
    }
    this.syncVideoGroups(slide);
    this.mountCompareControls(slide);
  }

  /**
   * The presenter's hands on a comparison: a draggable wipe divider, and a
   * scrubber with play/pause for each sync group and each lone video
   * (wipe.ts, groupScrubber.ts).
   *
   * A group the presenter paused stays paused through the slide's later
   * builds -- they would otherwise restart it -- until it is played again or
   * the slide is left. Pausing withdraws the play intent `keepPlaying`
   * records, or its recovery would start the clips again a moment later.
   */
  private mountCompareControls(slide: Slide): void {
    if (this.heldSlide !== slide.id) {
      this.heldGroups.clear();
      this.heldSlide = slide.id;
    }
    const groups = syncGroupsOf(slide.elements);
    // A video outside any group gets the same bar, as a group of one. One that
    // shows its own controls already has a scrubber.
    for (const el of slide.elements) {
      if (el.type !== 'video' || el.controls || (el.syncGroup && groups.has(el.syncGroup))) continue;
      groups.set(`solo:${el.id}`, [el]);
    }
    const setPlaying = (members: Array<{ id: string }>, playing: boolean): void => {
      for (const el of members) {
        const video = this.videoFor(el.id);
        if (!video || video.dataset.holdFrame === 'true') continue;
        const node = video.closest<HTMLElement>('[data-element-id]');
        if (playing && !this.blanked && node?.style.visibility !== 'hidden') {
          this.keepPlaying(el.id, video);
        } else if (!playing) {
          this.intendedPlaying.delete(el.id);
          this.playAttempts.delete(el.id);
          if (!video.paused) video.pause();
        }
      }
    };
    for (const [group, members] of groups) {
      if (this.heldGroups.has(group)) setPlaying(members, false);
    }
    if (this.compareMounted) return;
    const root = this.stage.firstElementChild as HTMLElement | null;
    if (!root) return;
    this.compareMounted = true;
    this.mediaListeners.push(mountWipeDrag(root));
    for (const [group, members] of groups) {
      if (!this.groupClockOf(members)) continue;
      this.mediaListeners.push(mountGroupScrubber(root, {
        members,
        clock: () => this.groupClockOf(members),
        setPlaying: (playing) => {
          if (playing) this.heldGroups.delete(group);
          else this.heldGroups.add(group);
          setPlaying(members, playing);
        },
        getRate: () => this.videoRate,
        setRate: (rate) => this.setVideoRate(rate, false),
      }));
    }
  }

  /**
   * The member of a sync group that keeps its time (videoSync.ts
   * `groupClock`): the shortest clip when the group is cut to the shortest,
   * the longest otherwise, once every member's length is known. Null while
   * the clock's `<video>` is not on the stage.
   */
  private groupClockOf(members: readonly VideoEl[]): GroupClock | null {
    const videos = members.map((el) => this.videoFor(el.id));
    const mode = syncLengthOf(members);
    const clips = members.map((el, index) => ({
      start: el.start, end: el.end, duration: videos[index]?.duration ?? Number.NaN,
    }));
    const { clock, length } = groupClock(clips, mode);
    const video = videos[clock];
    return video ? { index: clock, element: members[clock], video, videos, clips, mode, length } : null;
  }

  private videoFor(id: string): HTMLVideoElement | null {
    return this.stage
      .querySelector<HTMLElement>(`[data-element-id="${CSS.escape(id)}"]`)?.querySelector('video') ?? null;
  }

  /**
   * Run one clock per sync group on the slide.
   *
   * The clock clip plays as any video does, and its own end -- a loop back to
   * its in-point, or a stop -- is the group's. Every frame, each other member
   * is put where the clock's elapsed time says it should be. Followers keep
   * their own play intent (a follower hidden by a build stays paused), but
   * while they play they are kept in step: by bending the playback rate for
   * small drift, so nothing visibly jumps, and by seeking after a loop or a
   * stall. A follower that runs out before the group parks on its last frame,
   * or under black, until the group loops back to it.
   */
  private syncVideoGroups(slide: Slide): void {
    for (const [group, members] of syncGroupsOf(slide.elements)) {
      if (this.syncedGroups.has(group)) continue;
      if (!this.groupClockOf(members)) continue;
      this.syncedGroups.add(group);
      const touched = new Set<HTMLVideoElement>();
      let frame = 0;
      const tick = (): void => {
        const clock = this.groupClockOf(members);
        if (!clock || !clock.video.isConnected) return;
        const playing = !clock.video.paused;
        const elapsed = clock.video.currentTime - clock.element.start;
        members.forEach((el, index) => {
          const video = clock.videos[index];
          if (!video || video.dataset.holdFrame === 'true') return;
          touched.add(video);
          if (index === clock.index) {
            // The clock may have been a follower a moment ago, before every
            // length was known: it runs at the presenter's speed, unbent.
            this.parkedVideos.delete(video);
            video.classList.remove(SYNC_BLACK_CLASS);
            if (video.playbackRate !== this.videoRate) video.playbackRate = this.videoRate;
            return;
          }
          const at = memberFrame(elapsed, clock.clips[index], clock.mode, clock.length);
          if (at.ended) this.parkedVideos.add(video);
          else this.parkedVideos.delete(video);
          video.classList.toggle(SYNC_BLACK_CLASS, at.black);
          const followerPlaying = playing && !at.ended && this.intendedPlaying.has(el.id);
          const fix = followerCorrection(video.currentTime, at.time, followerPlaying);
          if (fix.seek !== undefined) video.currentTime = fix.seek;
          // The correction bends the presenter's speed, not normal speed.
          const rate = fix.rate * this.videoRate;
          if (video.playbackRate !== rate) video.playbackRate = rate;
          if (!followerPlaying && !video.paused) video.pause();
          if (followerPlaying && video.paused) void video.play().catch(() => {});
        });
        frame = requestAnimationFrame(tick);
      };
      // The first correction is made now rather than on the next frame: a
      // build step tears the previous tick down, and a parked clip would
      // otherwise show its last frame for one frame between the two.
      tick();
      this.mediaListeners.push(() => {
        cancelAnimationFrame(frame);
        for (const video of touched) {
          this.parkedVideos.delete(video);
          video.classList.remove(SYNC_BLACK_CLASS);
          video.playbackRate = this.videoRate;
        }
      });
    }
  }

  /**
   * Start a video and keep it started.
   *
   * `play()` is not a promise you can ignore. Chromium pauses muted,
   * audio-less video it decides is "background media ... to save power", which
   * both rejects the in-flight play() with an AbortError and fires `pause` --
   * and a deck full of silent, looping clips is exactly that kind of media. The
   * old code swallowed the rejection, so a slide's videos sat on their first
   * frame for the whole presentation with nothing left to restart them.
   *
   * So intent is recorded and reconciled: whenever a video stops while the
   * build state still wants it running, it is started again. Retries are capped
   * and only attempted while the page is actually visible, so a genuinely
   * hidden tab settles instead of spinning.
   */
  private keepPlaying(id: string, video: HTMLVideoElement): void {
    this.intendedPlaying.add(id);
    // The element outlives the slide that created it (navigation adopts and
    // pools videos), so the watchers must always act for the element id the
    // video currently belongs to, not the one it had when first watched.
    video.dataset.playerElementId = id;
    if (!this.playWatched.has(video)) {
      this.playWatched.add(video);
      const currentId = () => video.dataset.playerElementId ?? id;
      // Resetting on a real start is what stops a long presentation from
      // exhausting the retry budget on its first hiccup.
      video.addEventListener('playing', () => this.playAttempts.delete(currentId()));
      video.addEventListener('pause', () => {
        if (!this.intendedPlaying.has(currentId()) || this.blanked
          || video.dataset.holdFrame === 'true') return;
        this.retryPlayback(currentId(), video);
      });
    }
    void video.play().catch(() => {
      if (!this.intendedPlaying.has(id) || this.blanked
        || video.dataset.holdFrame === 'true') return;
      this.retryPlayback(id, video);
    });
  }

  private retryPlayback(id: string, video: HTMLVideoElement): void {
    // A clip that played to its end has stopped, not been interrupted:
    // `play()` would start it over. Nor is a parked follower to be restarted.
    if (this.playedToEnd(id, video) || this.parkedVideos.has(video)) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const attempts = this.playAttempts.get(id) ?? 0;
    if (attempts >= PLAY_RETRY_LIMIT) {
      // The budget is for a browser that keeps pausing a clip it could play.
      // A clip still loading is not that case. Giving up on it left a slide's
      // clips frozen once their bytes did arrive, until the presenter stepped
      // back and forward. So start it again once it can play.
      if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA && !video.error
        && !this.resumeArmed.has(video)) {
        this.resumeArmed.add(video);
        const resume = (): void => {
          this.resumeArmed.delete(video);
          if (!this.intendedPlaying.has(id) || this.blanked || !video.isConnected
            || video.dataset.holdFrame === 'true') return;
          this.playAttempts.delete(id);
          void video.play().catch(() => this.retryPlayback(id, video));
        };
        video.addEventListener('canplay', resume, { once: true });
        this.mediaListeners.push(() => {
          video.removeEventListener('canplay', resume);
          this.resumeArmed.delete(video);
        });
      }
      return;
    }
    this.playAttempts.set(id, attempts + 1);
    const timer = setTimeout(() => {
      if (!this.intendedPlaying.has(id) || this.blanked || !video.isConnected
        || video.dataset.holdFrame === 'true') return;
      void video.play().catch(() => {
        if (this.intendedPlaying.has(id) && !this.blanked
          && video.dataset.holdFrame !== 'true') this.retryPlayback(id, video);
      });
    }, PLAY_RETRY_DELAY_MS);
    this.pending.push(timer);
  }

  /**
   * Whether a video that does not loop has finished: at the end of its file,
   * or held at its out-point by `enforceTrim`.
   */
  private playedToEnd(id: string, video: HTMLVideoElement): boolean {
    if (video.ended) return true;
    const el = this.deck.slides[this.cursor.slide]?.elements.find((candidate) => candidate.id === id);
    return el?.type === 'video' && !el.loop && el.end !== null && video.currentTime >= el.end - 0.05;
  }

  /**
   * Keep a video inside its trim window.
   *
   * Trimming is non-destructive — the file still holds the whole clip — so the
   * in and out points have to be enforced during playback. The native `loop`
   * attribute cannot do this: it always restarts at zero, which would replay
   * the material the trim was meant to remove. A trimmed clip therefore loops
   * back to `start` here instead.
   */
  private enforceTrim(
    el: Extract<Slide['elements'][number], { type: 'video' }>,
    video: HTMLVideoElement,
  ): void {
    if (this.trimmed.has(el.id)) return;
    const hasTrim = el.start > 0 || el.end !== null;
    if (!hasTrim) return;
    this.trimmed.add(el.id);

    const onTime = () => {
      const end = el.end ?? Number.POSITIVE_INFINITY;
      if (video.currentTime >= end - 0.03) {
        if (el.loop) {
          video.currentTime = el.start;
          void video.play().catch(() => {});
        } else {
          video.pause();
          // Hold on the last kept frame rather than the file's final frame.
          video.currentTime = Math.max(el.start, end - 0.03);
        }
      } else if (video.currentTime < el.start - 0.05) {
        video.currentTime = el.start;
      }
    };

    video.addEventListener('timeupdate', onTime);
    this.mediaListeners.push(() => video.removeEventListener('timeupdate', onTime));
  }

  /** Watch a video element for its `ended` event, once, for `mediaEnd` triggers. */
  private onMediaEnd(elementId: string, fn: () => void): void {
    const node = this.stage.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(elementId)}"]`,
    );
    const video = node?.querySelector('video');
    if (!video) return;
    // A looping video never fires `ended`, so a mediaEnd trigger on one would
    // hang the build. Fall through immediately instead of stalling the talk.
    if (video.loop) {
      fn();
      return;
    }
    const handler = () => fn();
    video.addEventListener('ended', handler, { once: true });
    this.mediaListeners.push(() => video.removeEventListener('ended', handler));
  }

  private later(fn: () => void, ms: number): void {
    this.pending.push(setTimeout(fn, ms));
  }

  /**
   * Draw a line, an arrow or an open path in from its start to its end.
   *
   * The element has just been made visible at full length; this shortens its
   * stroke to nothing in the same task, so the whole line is never painted,
   * and then lengthens it frame by frame. Only live forward playback draws:
   * jumping to a step resolves the slide instantly, the way a delay collapses.
   */
  private drawIn(slide: Slide, entry: TimelineEntry, duration: number): void {
    const el = slide.elements.find((candidate) => candidate.id === entry.action.target);
    if (!el || el.type !== 'shape') return;
    const svg = this.stage.querySelector<SVGSVGElement>(`[data-element-id="${CSS.escape(el.id)}"] svg`);
    // The stroke is the SVG's own child; an arrowhead's path sits in <defs>.
    const stroke = svg?.querySelector<SVGElement>(':scope > :is(line, path, rect, ellipse, g)') ?? null;
    if (!svg || !stroke || duration <= 0) return;

    // A line — a line or an arrow, or an open path with nothing to fill —
    // is redrawn each frame as the piece of itself drawn so far (shapeSvg's
    // drawProgress), caps and all, so an arrowhead rides the tip and the last
    // frame is the static drawing exactly. An outline (a box, an ellipse, a
    // closed path) is traced first, and coloured in after.
    const open = el.shape === 'line' || el.shape === 'arrow'
      || (el.shape === 'path' && !el.fill && (parsePath(el.path ?? '') ?? []).every((run) => !run.closed));
    const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
    let show: (t: number) => void;
    if (open) {
      const template = document.createElement('template');
      show = (t) => {
        template.innerHTML = shapeSvg(el, { drawProgress: t >= 1 ? 1 : ease(t) });
        const fresh = template.content.firstElementChild;
        if (fresh) svg.replaceChildren(...fresh.childNodes);
      };
    } else {
      const traced = traceOutline(el, svg, ease);
      if (!traced) return;
      show = traced;
    }

    let done = false;
    let frame = 0;
    const finish = (): void => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
      show(1);
    };
    const started = performance.now();
    const tick = (now: number): void => {
      if (done) return;
      // A re-render replaced the slide; the new node is already complete.
      if (!svg.isConnected || (!open && !stroke.isConnected)) { done = true; clearTimeout(fallback); return; }
      const t = Math.min(1, Math.max(0, (now - started) / duration));
      if (t >= 1) finish();
      else {
        show(t);
        frame = requestAnimationFrame(tick);
      }
    };
    show(0);
    frame = requestAnimationFrame(tick);
    // A window that is hidden or throttled gets no animation frames, and a
    // line must never be left half drawn because nobody was watching it.
    const fallback = setTimeout(finish, duration + 250);
    this.effects.push(finish);
  }

  private clearPending(): void {
    for (const t of this.pending) clearTimeout(t);
    this.pending = [];
    // The next step (or the next slide) starts from finished animations.
    for (const finish of this.effects) finish();
    this.effects = [];
    for (const off of this.mediaListeners) off();
    this.mediaListeners = [];
    // The listeners those ids refer to have just been removed, so a fresh
    // watcher must be attached when the slide is drawn again.
    this.trimmed.clear();
    this.syncedGroups.clear();
    this.compareMounted = false;
    // Whatever the step was waiting on will no longer run.
    this.buildsDue = 0;
    this.animatedUntil = 0;
    this.checkSettled();
  }

  /**
   * Speed every video on the current slide up or down together (the `>` and
   * `<` keys), and show the new speed for a moment. Returns the new rate.
   */
  changeVideoRate(change: VideoRateChange): number {
    return this.setVideoRate(nextVideoRate(this.videoRate, change));
  }

  /** Set the current slide's video speed directly (the hover bar's slider). */
  setVideoRate(rate: number, badge = true): number {
    this.videoRate = rate;
    this.rateSlide = this.deck.slides[this.cursor.slide]?.id ?? null;
    // Sync-group followers pick the rate up on their next correction tick.
    for (const video of this.stage.querySelectorAll('video')) video.playbackRate = this.videoRate;
    if (badge) this.showRateBadge();
    return this.videoRate;
  }

  getVideoRate(): number {
    return this.videoRate;
  }

  private showRateBadge(): void {
    if (typeof document === 'undefined') return;
    if (!this.rateBadge) {
      const badge = document.createElement('div');
      badge.className = 'player-rate-badge';
      badge.setAttribute('role', 'status');
      this.rateBadge = badge;
    }
    if (!this.rateBadge.isConnected) {
      if (getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
      this.container.appendChild(this.rateBadge);
    }
    this.rateBadge.textContent = formatVideoRate(this.videoRate);
    this.rateBadge.classList.add('visible');
    if (this.rateBadgeTimer) clearTimeout(this.rateBadgeTimer);
    this.rateBadgeTimer = setTimeout(() => this.rateBadge?.classList.remove('visible'), 1200);
  }

  /** Blank the screen (the `B` key) without losing position. */
  toggleBlank(): boolean {
    this.blanked = !this.blanked;
    // Element build state writes `visibility: visible` on descendants, which
    // can override an inherited `visibility: hidden` on the stage. Opacity is
    // composited for the stage as a whole, so no slide element can punch
    // through while the audience display is blanked. Keeping the stage laid
    // out also lets navigation and auto-fit continue while it is blank.
    this.stage.style.opacity = this.blanked ? '0' : '1';
    for (const video of this.stage.querySelectorAll('video')) {
      if (this.blanked) video.pause();
    }
    if (!this.blanked) {
      const slide = this.deck.slides[this.cursor.slide];
      if (slide) this.applyState(slide, resolveState(slide, this.cursor.step));
    }
    return this.blanked;
  }

  private rescale(): void {
    const r = this.container.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    applyStageScale(this.stage, this.deck, { w: r.width, h: r.height });
  }
}

/**
 * Where the glyphs of every paired text element actually sit, on both slides,
 * in slide coordinates.
 *
 * The deck model cannot answer this. Autofit and condense change the rendered
 * size, an overlong no-wrap line is pinned to the box's left edge whatever
 * `align` says, and a box that grew wider does not move its text at all — so a
 * transform derived from box geometry alone can start a title half its own
 * width away from where it was, which reads as a fly-in. The source slide's
 * clones are laid out (hidden, and with their element ids stripped so nothing
 * else can find them) purely to be measured, then removed.
 */
function measureTextLayouts(
  slide: HTMLElement,
  pairs: MorphPair[],
  previousNodes: Map<string, HTMLElement>,
): Map<string, TextLayout> {
  const layouts = new Map<string, TextLayout>();
  const scale = slide.offsetWidth > 0
    ? slide.getBoundingClientRect().width / slide.offsetWidth
    : 0;
  const probes: Array<{
    from: Extract<SlideElement, { type: 'text' }>;
    to: Extract<SlideElement, { type: 'text' }>;
    target: HTMLElement;
    sourceClone: HTMLElement | undefined;
    probe: HTMLElement | null;
  }> = [];
  for (const [from, to] of pairs) {
    if (from.type !== 'text' || to.type !== 'text') continue;
    const target = slide.querySelector<HTMLElement>(
      `[data-element-id="${CSS.escape(to.id)}"]`,
    );
    if (!target) continue;
    // The target's own fit is scheduled for the next frame, after the
    // animation has already read its geometry; settle it now.
    if (to.autoFit || to.noWrap) fitAutoTextElement(target);
    const sourceClone = previousNodes.get(from.id);
    let probe: HTMLElement | null = null;
    if (sourceClone && scale > 0) {
      probe = sourceClone.cloneNode(true) as HTMLElement;
      delete probe.dataset.elementId;
      probe.style.visibility = 'hidden';
      probe.style.pointerEvents = 'none';
      slide.appendChild(probe);
    }
    probes.push({ from, to, target, sourceClone, probe });
  }
  // Ink is measured in each element's own untransformed frame: a rotated
  // element reports a rotated bounding box, and the transform below applies
  // the source's rotation itself, so measuring through it would count the
  // rotation twice — which lands the object off its source by the width of
  // the swing.
  const restore: Array<() => void> = [];
  for (const { target, probe } of probes) {
    for (const node of [target, probe]) {
      if (!node || !node.style.transform) continue;
      const previous = node.style.transform;
      node.style.transform = 'none';
      restore.push(() => { node.style.transform = previous; });
    }
  }
  // One layout pass for every probe, then one read pass.
  const origin = scale > 0 ? slide.getBoundingClientRect() : null;
  for (const { from, to, target, sourceClone, probe } of probes) {
    const sourceInk = origin ? inkRect(probe, origin, scale) : null;
    const targetInk = origin ? inkRect(target, origin, scale) : null;
    const sourceFont = renderedFontSize(probe);
    const targetFont = renderedFontSize(target);
    const measured = sourceInk && targetInk && sourceFont > 0 && targetFont > 0;
    layouts.set(to.id, measured
      ? {
        sourceInk,
        targetInk,
        fontScale: sourceFont / targetFont,
        squeeze: condenseScale(probe) / condenseScale(target),
      }
      : {
        sourceInk: null,
        targetInk: null,
        fontScale: textFontScale(from, to, sourceClone, target),
        squeeze: 1,
      });
  }
  for (const undo of restore) undo();
  for (const { probe } of probes) probe?.remove();
  return layouts;
}

/**
 * The box the rendered glyphs occupy inside an element, in slide coordinates.
 *
 * A range over the content reports where the text really is — alignment, wrap,
 * condense squeeze and KaTeX boxes included — rather than where its container
 * is. Returns null wherever there is no layout to read (a headless DOM), which
 * is the signal to fall back to the box-alignment estimate.
 */
function inkRect(
  node: HTMLElement | null | undefined,
  origin: DOMRect,
  scale: number,
): Rect | null {
  const content = node?.querySelector<HTMLElement>('.text-content');
  if (!content || typeof document.createRange !== 'function') return null;
  const range = document.createRange();
  range.selectNodeContents(content);
  const rect = range.getBoundingClientRect();
  range.detach?.();
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    x: (rect.left - origin.left) / scale,
    y: (rect.top - origin.top) / scale,
    w: rect.width / scale,
    h: rect.height / scale,
  };
}

/**
 * The horizontal squeeze a condensed no-wrap line settled on, or 1 for text
 * that shrank (or never overflowed) instead.
 */
function condenseScale(node: HTMLElement | null | undefined): number {
  const raw = node?.querySelector<HTMLElement>('.text-content')?.dataset.fittedScaleX;
  const value = raw ? Number.parseFloat(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** The font size the text actually rendered at, theme rules included. */
function renderedFontSize(node: HTMLElement | null | undefined): number {
  const content = node?.querySelector<HTMLElement>('.text-content');
  if (!content || typeof getComputedStyle !== 'function') return 0;
  const size = Number.parseFloat(getComputedStyle(content).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

/**
 * The visual scale between two renders of a paired text element when nothing
 * could be measured: the ratio of rendered font sizes, not of box sizes.
 * Auto-fitted text reports the size it actually settled on; otherwise the
 * authored size decides.
 */
function textFontScale(
  from: Extract<SlideElement, { type: 'text' }>,
  to: Extract<SlideElement, { type: 'text' }>,
  sourceClone: HTMLElement | undefined,
  targetNode: HTMLElement,
): number {
  const fitted = (root: HTMLElement | undefined): number | undefined => {
    const raw = root?.querySelector<HTMLElement>('.text-content')?.dataset.fittedFontSize;
    const value = raw ? Number.parseFloat(raw) : NaN;
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const authored = (style: Record<string, string>): number | undefined => {
    const value = Number.parseFloat(style['font-size'] ?? '');
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const toSize = fitted(targetNode) ?? authored(to.style);
  const fromSize = fitted(sourceClone) ?? authored(from.style);
  return fromSize !== undefined && toSize !== undefined && toSize > 0 ? fromSize / toSize : 1;
}

/** Backwards-compatible export for tests and callers; runtime matching is explicit only. */
export function matchMorphElements(
  previous: SlideElement[],
  next: SlideElement[],
): Array<[SlideElement, SlideElement]> {
  return explicitMorphPairs(previous, next);
}

/** How far out of focus a blur build starts (or ends), in canvas px. */
const BLUR_RADIUS = 24;

/**
 * Replace the `<video>` nodes in a cloned subtree with a still of the frame the
 * live video is showing.
 *
 * A cloned video carries no decoded frame: it paints its own black background
 * until it loads, while the cloned border overlay paints at once. During a
 * Morph fade that reads exactly as the video having vanished and left its
 * frame behind. A canvas holding the current frame fades out as the picture.
 */
function freezeClonedVideos(source: HTMLElement, clone: HTMLElement): void {
  const live = source.querySelectorAll('video');
  const copies = clone.querySelectorAll('video');
  for (let i = 0; i < copies.length; i += 1) {
    const video = live[i];
    const copy = copies[i];
    if (!video) continue;
    const width = video.videoWidth || Math.round(video.getBoundingClientRect().width);
    const height = video.videoHeight || Math.round(video.getBoundingClientRect().height);
    if (!width || !height) continue;
    try {
      const still = document.createElement('canvas');
      still.width = width;
      still.height = height;
      const context = still.getContext('2d');
      if (!context) continue;
      context.drawImage(video, 0, 0, width, height);
      still.style.cssText = copy.style.cssText;
      copy.replaceWith(still);
    } catch {
      // No frame available (or no canvas support): leaving the cloned video in
      // place is no worse than before.
    }
  }
}

/** Of an outline's time, the part its tracing takes; a fill fades in over the rest. */
const OUTLINE_TRACE_SHARE = 0.7;

/**
 * Line Draw on an outline — a box, an ellipse, a closed or a filled path.
 * Returns what to show at each moment of the build (`t`, 0..1; 1 puts the
 * static drawing back exactly), or null when there is nothing to draw.
 *
 * The outline is traced by copies of the shape's stroke laid over it, one
 * per run of the path, each one after the other: a dash starts afresh at
 * every subpath, so one dashed outline drew all of a shape's runs at once.
 * Only when the outline is complete does the fill fade in. A shape with no
 * stroke is traced in a hairline of its fill colour, which fades out as the
 * fill comes in. A brush stroke is an outline filled in, and a dashed or
 * dotted stroke already has dashes of its own, so neither can be drawn by a
 * dash: each is uncovered instead by a mask of dashed runs along its path.
 * Caps (arrowheads, dots, bars) join when the outline is complete.
 */
function traceOutline(
  el: Extract<SlideElement, { type: 'shape' }>,
  svg: SVGSVGElement,
  ease: (t: number) => number,
): ((t: number) => void) | null {
  const SVG = 'http://www.w3.org/2000/svg';
  const paint = (node: SVGElement | null, name: string): string | null => {
    const value = node?.getAttribute(name);
    return value && value !== 'none' ? value : null;
  };
  // A styled stroke is drawn apart from its fill (strokeStyles.ts); a plain
  // one is the shape's single element, fill and stroke both.
  const first = svg.querySelector<SVGGeometryElement>(':scope > :is(path, rect, ellipse)');
  // (A see-through stroke with caps sits in a group with them: strokeStyles.ts.)
  const styled = svg.querySelector<SVGGeometryElement>(':scope > .shape-stroke, :scope > .stroke-ink > .shape-stroke');
  const node = styled ?? first;
  if (!node) return null;
  const fillNode = styled ? svg.querySelector<SVGGeometryElement>(':scope > .shape-fill') : first;
  const brush = Boolean(styled?.classList.contains('brush-stroke'));
  const strokePaint = brush ? paint(node, 'fill') : paint(node, 'stroke');
  const fillPaint = paint(fillNode, 'fill');
  const stroked = strokePaint !== null && el.strokeWidth > 0;
  if (!stroked && !fillPaint) return null;
  const dashed = stroked && !brush && Boolean(el.strokeDash);
  const masked = brush || dashed;
  const size = el.shape === 'path' && el.pathSize ? el.pathSize : { w: el.w, h: el.h };
  const runs = el.shape === 'path'
    // The runs the stroke follows: as drawn, where a head cut it short;
    // a brush's own data is its outline, so its runs are the path's.
    ? (parsePath((brush ? el.path : node.getAttribute('d') ?? el.path) ?? '') ?? []).map((run) => serializePath([run]))
    : [null];

  let mask: SVGMaskElement | null = null;
  // What the mask uncovers: the brush's own outline, a styled dashed stroke,
  // or for a plain dashed one a stroke-only copy laid over the shape.
  let uncovered: SVGGeometryElement | null = null;
  const traces = runs.map((d) => {
    let trace: SVGGeometryElement;
    if (masked) {
      // A band wider than the stroke at its fullest, along the path.
      trace = (d !== null || node.tagName !== 'path'
        ? node.cloneNode(false)
        : document.createElementNS(SVG, 'path')) as SVGGeometryElement;
      for (const name of ['class', 'filter', 'stroke-dasharray', 'stroke-opacity', 'mask', 'style']) trace.removeAttribute(name);
      trace.setAttribute('fill', 'none');
      trace.setAttribute('stroke', '#fff');
      trace.setAttribute('stroke-width', String(el.strokeWidth * 2 + 4));
      trace.setAttribute('stroke-linejoin', 'round');
    } else {
      trace = node.cloneNode(false) as SVGGeometryElement;
      trace.setAttribute('fill', 'none');
    }
    if (d !== null) trace.setAttribute('d', d);
    trace.setAttribute('class', 'draw-trace');
    if (!stroked) {
      // Two canvas pixels, whatever the units the path is drawn in.
      const scale = Math.sqrt((el.w / size.w) * (el.h / size.h)) || 1;
      trace.setAttribute('stroke', fillPaint!);
      trace.setAttribute('stroke-width', String(2 / scale));
    }
    return trace;
  });
  if (masked) {
    mask = document.createElementNS(SVG, 'mask') as SVGMaskElement;
    mask.id = `draw-${el.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const margin = el.strokeWidth * 2 + 8;
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    mask.setAttribute('x', String(-margin));
    mask.setAttribute('y', String(-margin));
    mask.setAttribute('width', String(size.w + margin * 2));
    mask.setAttribute('height', String(size.h + margin * 2));
    mask.append(...traces);
    svg.appendChild(mask);
    if (styled) uncovered = node;
    else {
      uncovered = node.cloneNode(false) as SVGGeometryElement;
      uncovered.setAttribute('fill', 'none');
      uncovered.classList.add('draw-trace');
      node.after(uncovered);
    }
    uncovered.setAttribute('mask', `url(#${mask.id})`);
  } else {
    node.after(...traces);
  }
  const lengths = traces.map((trace) => trace.getTotalLength?.() ?? 0);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const caps = [...svg.querySelectorAll<SVGElement>(':scope > :is(.arrowhead, .line-cap), :scope > .stroke-ink > :is(.arrowhead, .line-cap)')];
  const restore = (): void => {
    for (const trace of traces) trace.remove();
    mask?.remove();
    if (uncovered === node) node.removeAttribute('mask');
    else uncovered?.remove();
    node.style.removeProperty('stroke');
    node.style.removeProperty('visibility');
    fillNode?.style.removeProperty('fill-opacity');
    for (const cap of caps) cap.style.removeProperty('visibility');
  };
  if (!(total > 0)) {
    restore();
    return null;
  }
  const share = fillPaint ? OUTLINE_TRACE_SHARE : 1;

  // While the copies trace, the shape keeps only its fill, held back; a
  // masked stroke stays, uncovered by the mask as the copies go.
  if (!(masked && styled)) {
    if (styled) node.style.visibility = 'hidden';
    else node.style.stroke = 'none';
  }
  if (fillNode) fillNode.style.fillOpacity = '0';
  for (const cap of caps) cap.style.visibility = 'hidden';
  return (t) => {
    if (t >= 1) {
      restore();
      return;
    }
    const progress = ease(Math.min(1, t / share));
    const drawn = progress * total;
    let before = 0;
    traces.forEach((trace, index) => {
      const length = lengths[index];
      const visible = Math.min(length, Math.max(0, drawn - before));
      before += length;
      if (visible >= length) {
        // Whole, it is the run itself: a closed run joins at its start
        // again, where the ends of a dash would meet in two square caps.
        trace.style.removeProperty('stroke-dasharray');
        trace.style.removeProperty('stroke-dashoffset');
      } else {
        trace.style.strokeDasharray = `${length} ${length}`;
        trace.style.strokeDashoffset = String(length - visible);
      }
      // An empty dash still paints its round caps as a dot.
      trace.style.visibility = visible > 0 ? '' : 'hidden';
    });
    const fill = fillPaint ? Math.min(1, Math.max(0, (t - share) / (1 - share))) : 0;
    if (fillNode) fillNode.style.fillOpacity = String(fill);
    if (!stroked) for (const trace of traces) trace.style.strokeOpacity = String(1 - fill);
    if (progress >= 1) for (const cap of caps) cap.style.removeProperty('visibility');
  };
}
