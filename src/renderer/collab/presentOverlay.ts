/**
 * Presenting from the editor tab, without an intermediate window.
 *
 * Browsers only grant fullscreen from a live user gesture, and a gesture does
 * not carry into a freshly opened popup — which is why Present used to land in
 * a plain window that needed a second click. Instead we mount the very same
 * present view in an iframe over the editor and fullscreen that element inside
 * the click handler, so the first click goes straight to fullscreen.
 *
 * With Speaker View the overlay takes the *speaker* role and a second window
 * carries the audience. That is the way round a browser can actually deliver:
 * the editor is already on the presenter's own screen, and the one window the
 * gesture is allowed to open is the one that has to travel to the projector.
 */

import type { Deck } from '@shared/deck.js';
import { mediaVariantsSnapshot } from './mediaVariants.js';

/** What the editor tab already knows, so the presentation need not re-fetch it. */
export interface PresentSeed {
  deck: Deck;
  themeCss: string;
}

export interface PresentOptions {
  /** Inclusive last slide index when presenting a multi-slide rail selection. */
  endSlideIndex?: number;
  /** Open the audience in its own window and make this tab the Speaker View. */
  speakerView?: boolean;
  /** Somewhere to report a blocked pop-up; presenting continues regardless. */
  onStatus?: (message: string) => void;
}

let overlay: HTMLIFrameElement | null = null;
let seedProvider: (() => PresentSeed) | null = null;
/** The audience window opened for Speaker View, so ending here ends it too. */
let audienceWindow: Window | null = null;

function teardown(): void {
  // Ending the presentation must take both surfaces with it. The audience
  // window also hears the overlay's farewell on the presentation bus, but that
  // relies on the removed iframe getting a `pagehide`; closing it from here is
  // the direct route, and closing twice is harmless.
  if (audienceWindow && !audienceWindow.closed) audienceWindow.close();
  audienceWindow = null;
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  seedProvider = null;
  window.removeEventListener('message', onMessage);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
}

function onMessage(event: MessageEvent): void {
  if (event.origin !== location.origin) return;
  const type = (event.data as { type?: string } | null)?.type;
  // The presentation asks for the deck as soon as its script runs. Answering
  // from what this tab already holds is what makes it paint immediately: its
  // own WebSocket takes about a second to hand over a welcome, and until this
  // existed that second was a black screen.
  if (type === 'present-hello') {
    const seed = seedProvider?.();
    if (seed && overlay?.contentWindow) {
      overlay.contentWindow.postMessage(
        { type: 'present-seed', deck: seed.deck, themeCss: seed.themeCss, mediaVariants: mediaVariantsSnapshot() },
        location.origin,
      );
    }
    return;
  }
  if (type !== 'present-exit') return;
  if (document.fullscreenElement) void document.exitFullscreen();
  teardown();
}

function onFullscreenChange(): void {
  // Escape (or the browser's own exit control) leaves fullscreen; that ends the
  // presentation, matching how the popup used to close.
  if (!document.fullscreenElement) teardown();
}

/** `present.html` query for one surface of a presentation. */
export function presentUrl(
  deckId: string,
  slideIndex: number,
  extra: { endSlideIndex?: number; role?: 'speaker'; embed?: boolean } = {},
): string {
  const params = new URLSearchParams({
    deck: deckId,
    slide: String(slideIndex + 1),
  });
  // Both bounds are 1-based in the URL, like `slide`.
  if (extra.endSlideIndex !== undefined) {
    params.set('endSlide', String(extra.endSlideIndex + 1));
  }
  if (extra.role) params.set('role', extra.role);
  if (extra.embed) params.set('embed', '1');
  return `present.html?${params.toString()}`;
}

export function startPresenting(
  deckId: string,
  slideIndex: number,
  seed?: () => PresentSeed,
  options: PresentOptions = {},
): void {
  teardown();
  seedProvider = seed ?? null;

  // Open the audience window first: it must happen synchronously inside the
  // gesture or the pop-up blocker takes it. A refusal is not fatal — fall back
  // to presenting in this tab, and say why Speaker View did not appear.
  let speakerView = false;
  if (options.speakerView) {
    const audience = window.open(
      presentUrl(deckId, slideIndex, { endSlideIndex: options.endSlideIndex }),
      `deckwerk-audience-${deckId}`,
    );
    if (audience) {
      speakerView = true;
      audienceWindow = audience;
      options.onStatus?.(
        'Speaker View is here — move the new window to the projector and press F for fullscreen.',
      );
    } else {
      options.onStatus?.(
        'Speaker View needs a second window — allow pop-ups for this site, then present again.',
      );
    }
  }

  const frame = document.createElement('iframe');
  frame.src = presentUrl(deckId, slideIndex, {
    endSlideIndex: options.endSlideIndex,
    role: speakerView ? 'speaker' : undefined,
    embed: true,
  });
  frame.allow = 'fullscreen';
  frame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;'
    + 'background:#000;z-index:9999;';
  document.body.appendChild(frame);
  overlay = frame;
  window.addEventListener('message', onMessage);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  frame.requestFullscreen().catch(() => {
    // Fullscreen refused: the overlay still covers the tab, so presenting works
    // and the viewer can hit F for fullscreen once they interact.
  });
  frame.focus();
}
