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
 *
 * Unless the browser can see the projector. Chrome's Window Management API
 * lists the screens, and lets the click fullscreen an element on a chosen one
 * and then open a pop-up on another. With a second screen the overlay is the
 * *audience*, fullscreened onto the other screen, and the pop-up is Speaker
 * View, filling the screen the editor is on — automatically, for plain Present
 * too, as the desktop app does (presentScreens.ts decides which is which).
 */

import type { Deck } from '@shared/deck.js';
import { mediaVariantsSnapshot } from './mediaVariants.js';
import {
  decideAfterScreenDetails,
  mayUseSecondScreen,
  planForPermission,
  speakerWindowFeatures,
  type ScreenArea,
  type ScreenDetailsLike,
  type WindowManagementPermission,
} from './presentScreens.js';

/** What the editor tab already knows, so the presentation need not re-fetch it. */
export interface PresentSeed {
  deck: Deck;
  themeCss: string;
  /** The editor tab's own peer id: its person is presenting, so is never offered the remote. */
  hostClientId?: string;
}

export interface PresentOptions {
  /** Inclusive last slide index when presenting a multi-slide rail selection. */
  endSlideIndex?: number;
  /**
   * Speaker View on one screen: the audience in its own window, this tab the
   * Speaker View. With a second screen Speaker View comes regardless.
   */
  speakerView?: boolean;
  /** Somewhere to report a blocked pop-up or a screen question; presenting continues regardless. */
  onStatus?: (message: string) => void;
  /** The show ended, by any route, while showing this slide. */
  onEnd?: (slideId: string) => void;
}

let overlay: HTMLIFrameElement | null = null;
/** Whether the current overlay has been fullscreen: only then does leaving fullscreen end it. */
let overlayFullscreen = false;
/**
 * A presentation that has not said hello by now never loaded: the editor
 * thought the server was there (a browser takes a moment to notice a dead
 * connection) and nothing could answer for present.html. Without this the
 * overlay stayed up, black, until Escape.
 */
const PRESENT_LOAD_TIMEOUT_MS = 12_000;
let helloTimer = 0;
export const PRESENT_DID_NOT_LOAD = 'The presentation did not load: the server is not answering. '
  + 'Present again once it is back, or once this browser holds the talk (the status line says "Available offline").';
export const PRESENT_NEEDS_POPUP = 'Speaker View needs a second window — allow pop-ups for this site, then present again.';
export const PRESENT_ASKING_FOR_SCREENS = 'To present on the other screen, allow window management in the browser\'s prompt.';
export const PRESENT_SCREENS_ALLOWED = 'Window management allowed — press Present again to show the slides on the other screen.';
export const PRESENT_SCREENS_REFUSED = 'Window management was not allowed, so Present uses this screen — press Present again to start.';
export const PRESENT_ON_THIS_SCREEN = 'Presenting on this screen — allow window management for this site to use the other screen.';
let seedProvider: (() => PresentSeed) | null = null;
/**
 * The pop-up that is the presentation's other surface — the audience for a
 * one-screen Speaker View, Speaker View itself with two screens — so ending
 * here ends it too.
 */
let companionWindow: Window | null = null;
/** Bumped by every Present, so one that was overtaken while it waited gives up. */
let starts = 0;
/** The slide the presentation last reported showing, and who wants it at the end. */
let shownSlideId: string | null = null;
let onEnd: ((slideId: string) => void) | null = null;

function teardown(): void {
  // Ending the presentation must take both surfaces with it. The audience
  // window also hears the overlay's farewell on the presentation bus, but that
  // relies on the removed iframe getting a `pagehide`; closing it from here is
  // the direct route, and closing twice is harmless.
  if (companionWindow && !companionWindow.closed) companionWindow.close();
  companionWindow = null;
  clearTimeout(helloTimer);
  if (!overlay) return;
  overlay.remove();
  overlay = null;
  seedProvider = null;
  const ended = onEnd;
  const slideId = shownSlideId;
  onEnd = null;
  shownSlideId = null;
  window.removeEventListener('message', onMessage);
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  if (ended && slideId) ended(slideId);
}

function onMessage(event: MessageEvent): void {
  if (event.origin !== location.origin) return;
  const type = (event.data as { type?: string } | null)?.type;
  // The presentation asks for the deck as soon as its script runs. Answering
  // from what this tab already holds is what makes it paint immediately: its
  // own WebSocket takes about a second to hand over a welcome, and until this
  // existed that second was a black screen.
  if (type === 'present-hello') {
    clearTimeout(helloTimer);
    const seed = seedProvider?.();
    if (seed && overlay?.contentWindow) {
      overlay.contentWindow.postMessage(
        {
          type: 'present-seed',
          deck: seed.deck,
          themeCss: seed.themeCss,
          mediaVariants: mediaVariantsSnapshot(),
          hostClientId: seed.hostClientId,
        },
        location.origin,
      );
    }
    return;
  }
  if (type === 'present-at') {
    const slideId = (event.data as { slideId?: unknown }).slideId;
    if (typeof slideId === 'string') shownSlideId = slideId;
    return;
  }
  if (type !== 'present-exit') return;
  if (document.fullscreenElement) void document.exitFullscreen();
  teardown();
}

function onFullscreenChange(): void {
  // Escape (or the browser's own exit control) leaves fullscreen; that ends the
  // presentation, matching how the popup used to close. Only a presentation
  // that was fullscreen itself ends so: leaving fullscreen is asynchronous,
  // and the previous show's exit, landing after Present was pressed again,
  // took the new show down with it.
  if (overlay && document.fullscreenElement === overlay) {
    overlayFullscreen = true;
    return;
  }
  if (!document.fullscreenElement && overlayFullscreen) teardown();
}

/** Whether a presentation is running over this tab. */
export function isPresenting(): boolean {
  return overlay !== null;
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

/** The Window Management API, where the browser has it (Chrome, Edge). */
interface WindowManagement {
  getScreenDetails: () => Promise<ScreenDetailsLike<ScreenArea>>;
}

function windowManagement(): WindowManagement | null {
  const getScreenDetails = (window as { getScreenDetails?: WindowManagement['getScreenDetails'] }).getScreenDetails;
  const isExtended = (window.screen as { isExtended?: boolean } | undefined)?.isExtended;
  if (!mayUseSecondScreen({ hasApi: typeof getScreenDetails === 'function', isExtended })) return null;
  return { getScreenDetails: () => getScreenDetails!.call(window) };
}

async function windowManagementPermission(): Promise<WindowManagementPermission> {
  try {
    const status = await navigator.permissions.query({ name: 'window-management' as PermissionName });
    return status.state;
  } catch {
    // A browser that does not know the name (Chrome before 111 called it
    // window-placement): the prompt is the way to find out.
    return 'unknown';
  }
}

/**
 * Whether the click that pressed Present still counts. Chrome's lasts a few
 * seconds, so it survives the quick awaits of an allowed lookup, but not a
 * person reading a permission prompt.
 */
function clickStillCounts(): boolean {
  const activation = (navigator as { userActivation?: { isActive: boolean } }).userActivation;
  return activation ? activation.isActive : true;
}

/**
 * Present the deck. One screen (or a browser that cannot tell): synchronously,
 * inside the click, exactly as always. A second screen that the person has let
 * the site see: the audience fullscreen on it and Speaker View on this one.
 * The first time, the browser asks; a presentation never starts half-way.
 */
export async function startPresenting(
  deckId: string,
  slideIndex: number,
  seed?: () => PresentSeed,
  options: PresentOptions = {},
): Promise<void> {
  teardown();
  const start = ++starts;
  const screens = windowManagement();
  if (!screens) {
    presentOnThisScreen(deckId, slideIndex, seed, options);
    return;
  }
  const plan = planForPermission(await windowManagementPermission());
  if (start !== starts) return;
  if (plan === 'this-screen') {
    presentOnThisScreen(deckId, slideIndex, seed, options);
    return;
  }
  if (plan === 'ask') options.onStatus?.(PRESENT_ASKING_FOR_SCREENS);
  let details: ScreenDetailsLike<ScreenArea> | null = null;
  let home: ScreenArea | null = null;
  try {
    details = await screens.getScreenDetails();
    // The screen the editor is on now. `currentScreen` is live and follows the
    // window once it goes fullscreen on the other screen.
    home = details.currentScreen;
  } catch {
    details = null;
  }
  if (start !== starts) return;
  const decision = decideAfterScreenDetails({ details, home, activationLive: clickStillCounts() });
  if (decision.kind === 'present-again') {
    options.onStatus?.(decision.allowed ? PRESENT_SCREENS_ALLOWED : PRESENT_SCREENS_REFUSED);
    return;
  }
  if (decision.kind === 'this-screen') {
    if (plan === 'ask' && !details) options.onStatus?.(PRESENT_ON_THIS_SCREEN);
    presentOnThisScreen(deckId, slideIndex, seed, options);
    return;
  }
  await presentOnTwoScreens(deckId, slideIndex, seed, options, decision.audience, decision.home);
}

/**
 * The audience in this tab's overlay, fullscreen on the other screen; then
 * Speaker View as a pop-up filling the editor's screen. Chrome lets a click
 * that fullscreened onto another screen open that one pop-up as well.
 */
async function presentOnTwoScreens(
  deckId: string,
  slideIndex: number,
  seed: (() => PresentSeed) | undefined,
  options: PresentOptions,
  audience: ScreenArea,
  home: ScreenArea,
): Promise<void> {
  const frame = mountOverlay(deckId, slideIndex, seed, options, 'audience');
  try {
    await frame.requestFullscreen({ screen: audience } as FullscreenOptions);
  } catch {
    // Refused: the audience still covers this tab, as when fullscreen is
    // refused on one screen. Without the fullscreen there is no pop-up to be
    // had, and a Speaker View over the audience would hide it.
    return;
  }
  if (overlay !== frame) return;
  const speaker = window.open(
    presentUrl(deckId, slideIndex, { endSlideIndex: options.endSlideIndex, role: 'speaker' }),
    `deckwerk-speaker-${deckId}`,
    speakerWindowFeatures(home),
  );
  if (speaker) companionWindow = speaker;
  else options.onStatus?.(PRESENT_NEEDS_POPUP);
}

/** Today's single-screen presentation, synchronously inside the click. */
function presentOnThisScreen(
  deckId: string,
  slideIndex: number,
  seed: (() => PresentSeed) | undefined,
  options: PresentOptions,
): void {
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
      companionWindow = audience;
      options.onStatus?.(
        'Speaker View is here — move the new window to the projector and press F for fullscreen.',
      );
    } else {
      options.onStatus?.(PRESENT_NEEDS_POPUP);
    }
  }

  const frame = mountOverlay(deckId, slideIndex, seed, options, speakerView ? 'speaker' : 'audience');
  frame.requestFullscreen().catch(() => {
    // Fullscreen refused: the overlay still covers the tab, so presenting works
    // and the viewer can hit F for fullscreen once they interact.
  });
}

/** The presentation over this tab, in the given role, ending when it says so. */
function mountOverlay(
  deckId: string,
  slideIndex: number,
  seed: (() => PresentSeed) | undefined,
  options: PresentOptions,
  role: 'audience' | 'speaker',
): HTMLIFrameElement {
  seedProvider = seed ?? null;
  onEnd = options.onEnd ?? null;
  const frame = document.createElement('iframe');
  frame.src = presentUrl(deckId, slideIndex, {
    endSlideIndex: options.endSlideIndex,
    role: role === 'speaker' ? 'speaker' : undefined,
    embed: true,
  });
  frame.allow = 'fullscreen';
  frame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;'
    + 'background:#000;z-index:9999;';
  document.body.appendChild(frame);
  overlay = frame;
  overlayFullscreen = false;
  window.addEventListener('message', onMessage);
  document.addEventListener('fullscreenchange', onFullscreenChange);
  frame.focus();
  helloTimer = window.setTimeout(() => {
    if (overlay !== frame) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    teardown();
    options.onStatus?.(PRESENT_DID_NOT_LOAD);
  }, PRESENT_LOAD_TIMEOUT_MS);
  return frame;
}
