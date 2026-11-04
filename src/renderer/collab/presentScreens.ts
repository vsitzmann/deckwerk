/**
 * Which screen a browser presentation goes on — the browser's counterpart of
 * src/main/presentationDisplays.ts.
 *
 * Chrome's Window Management API is the only way a page can see a second
 * screen: `screen.isExtended` says there is one (no prompt), and
 * `getScreenDetails()` lists them once the person has allowed "window
 * management" for the site. With that, the click on Present can fullscreen an
 * element on a chosen screen, and then open one pop-up on another screen in
 * the same click (the spec's "initiate multi-screen experiences" case).
 *
 * The decisions live here, free of the DOM, so they can be tested on their
 * own; presentOverlay.ts does the asking and the opening.
 */

/** What a `ScreenDetailed` offers that the decisions use. */
export interface ScreenArea {
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  /** The laptop's own panel. */
  isInternal?: boolean;
}

export interface ScreenDetailsLike<T extends ScreenArea = ScreenArea> {
  screens: readonly T[];
  currentScreen: T;
}

/** The permission as `navigator.permissions` reports it; `unknown` when it cannot say. */
export type WindowManagementPermission = 'granted' | 'prompt' | 'denied' | 'unknown';

/**
 * Before anything asynchronous: whether there is a second screen to look for.
 * Everything else (Safari, Firefox, one screen) presents exactly as before,
 * synchronously inside the click — Safari's pop-up blocker allows no await.
 */
export function mayUseSecondScreen(env: { hasApi: boolean; isExtended: boolean | undefined }): boolean {
  return env.hasApi && env.isExtended === true;
}

/**
 * Allowed: present on both screens. Not yet decided: ask. Refused: present on
 * this screen as before, and never prompt again — the person said no.
 */
export function planForPermission(permission: WindowManagementPermission): 'two-screens' | 'ask' | 'this-screen' {
  if (permission === 'granted') return 'two-screens';
  if (permission === 'denied') return 'this-screen';
  return 'ask';
}

function sameScreen(a: ScreenArea, b: ScreenArea): boolean {
  if (a === b) return true;
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height
    && a.availLeft === b.availLeft && a.availTop === b.availTop;
}

/**
 * Which screen shows the audience and which Speaker View. A laptop with
 * another screen keeps Speaker View on its own panel and puts the audience on
 * the other, wherever the editor window happened to be — the presenter is at
 * the laptop. (It used to go by the editor window alone, so an editor left on
 * the projector put Speaker View on the projector and the slides on the
 * laptop.) Screens that do not say which is the laptop's: the audience goes on
 * one the editor is not on, and Speaker View where the editor is. Null when
 * there is no second screen.
 */
export function chooseScreens<T extends ScreenArea>(screens: readonly T[], home: T): { audience: T; speaker: T } | null {
  const others = screens.filter((screen) => !sameScreen(screen, home));
  if (others.length === 0) return null;
  const laptop = screens.find((screen) => screen.isInternal === true);
  if (laptop) {
    const external = screens.filter((screen) => !sameScreen(screen, laptop));
    // Of several external screens, one the editor is not on: with a desk
    // monitor and a projector, the editor is on the monitor.
    const audience = external.find((screen) => !sameScreen(screen, home)) ?? external[0];
    if (audience) return { audience, speaker: laptop };
  }
  const audience = others.find((screen) => screen.isInternal === false) ?? others[0];
  return { audience, speaker: home };
}

/** `window.open` features for a Speaker View that fills the presenter's screen. */
export function speakerWindowFeatures(home: ScreenArea): string {
  return `popup,left=${home.availLeft},top=${home.availTop},width=${home.availWidth},height=${home.availHeight}`;
}

/**
 * `window.open` features for the audience of a Speaker View on one screen: a
 * window of its own, not a tab. Chrome opened a bare `window.open` as a tab in
 * the editor's window and brought it to the front, so the presenter saw the
 * slides and Speaker View sat in the tab behind them. A 16:9 window over the
 * lower right of the screen leaves Speaker View in view, and is the window to
 * drag to a projector the browser cannot see.
 */
export function audienceWindowFeatures(home: ScreenArea): string {
  const width = Math.round(home.availWidth * 0.45);
  const height = Math.round((width * 9) / 16);
  const left = home.availLeft + home.availWidth - width;
  const top = home.availTop + Math.max(0, home.availHeight - height);
  return `popup,left=${left},top=${top},width=${width},height=${height}`;
}

export type ScreenDecision<T extends ScreenArea> =
  | { kind: 'two-screens'; audience: T; speaker: T }
  | { kind: 'this-screen' }
  /** Fullscreen and pop-ups need a live click: start nothing and say so. */
  | { kind: 'present-again'; allowed: boolean };

/**
 * After `getScreenDetails()` settled: `details` is null when it was refused.
 * `home` is the editor's screen as it was before anything moved — the live
 * `currentScreen` follows the window once it goes fullscreen elsewhere.
 */
export function decideAfterScreenDetails<T extends ScreenArea>(input: {
  details: ScreenDetailsLike<T> | null;
  home: T | null;
  activationLive: boolean;
}): ScreenDecision<T> {
  if (!input.activationLive) return { kind: 'present-again', allowed: input.details !== null };
  if (!input.details || !input.home) return { kind: 'this-screen' };
  const chosen = chooseScreens(input.details.screens, input.home);
  return chosen ? { kind: 'two-screens', ...chosen } : { kind: 'this-screen' };
}
