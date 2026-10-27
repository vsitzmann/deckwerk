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
 * The audience goes on a screen the editor is not on, an external one before
 * the laptop's own when there are three. Null when there is no other screen.
 */
export function chooseAudienceScreen<T extends ScreenArea>(screens: readonly T[], home: ScreenArea): T | null {
  const others = screens.filter((screen) => !sameScreen(screen, home));
  return others.find((screen) => screen.isInternal === false) ?? others[0] ?? null;
}

/** `window.open` features for a Speaker View that fills the presenter's screen. */
export function speakerWindowFeatures(home: ScreenArea): string {
  return `popup,left=${home.availLeft},top=${home.availTop},width=${home.availWidth},height=${home.availHeight}`;
}

export type ScreenDecision<T extends ScreenArea> =
  | { kind: 'two-screens'; audience: T; home: T }
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
  const audience = chooseAudienceScreen(input.details.screens, input.home);
  return audience ? { kind: 'two-screens', audience, home: input.home } : { kind: 'this-screen' };
}
