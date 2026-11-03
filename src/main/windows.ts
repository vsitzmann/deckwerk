import { join } from 'node:path';
import { BrowserWindow, screen, shell } from 'electron';
import type { Rectangle } from 'electron';
import { presentationScreens } from './displays.js';
import { chooseAudienceDisplay, chooseDisplayById } from './presentationDisplays.js';

/**
 * Window creation. Three kinds: the editor, the fullscreen present window and
 * the video trim window.
 *
 * electron-vite serves the renderer from a dev server while developing and from
 * built files otherwise; `ELECTRON_RENDERER_URL` is how it signals which.
 */

const preload = () => join(import.meta.dirname, '../preload/index.mjs');
const APP_BACKGROUND = '#16161e';
const HEADLESS_TEST = process.env['DECKWERK_HEADLESS_TEST'] === '1';

export interface WindowContinuityState {
  bounds: Rectangle;
  maximized: boolean;
  fullScreen: boolean;
}

export function captureWindowContinuity(win: BrowserWindow): WindowContinuityState {
  const maximized = win.isMaximized();
  const fullScreen = win.isFullScreen();
  return {
    // Retain the window's restore geometry too: getBounds() while maximized
    // would make a later unmaximize fill the entire screen.
    bounds: maximized || fullScreen ? win.getNormalBounds() : win.getBounds(),
    maximized,
    fullScreen,
  };
}

function continuityOptions(state?: WindowContinuityState): Partial<Rectangle> {
  return state?.bounds ?? {};
}

/**
 * Where a second presentation's window goes: the same size as the window it
 * was opened from, stepped down and to the right so both are visible at once
 * and neither hides the other's title bar. Kept on the source window's display
 * and inside its work area, so a cascade near a screen edge does not walk a
 * window off it.
 */
export function cascadedEditorBounds(source: BrowserWindow): WindowContinuityState {
  const from = captureWindowContinuity(source);
  const step = 32;
  const area = screen.getDisplayMatching(from.bounds).workArea;
  const width = Math.min(from.bounds.width, area.width);
  const height = Math.min(from.bounds.height, area.height);
  return {
    bounds: {
      x: Math.min(from.bounds.x + step, area.x + area.width - width),
      y: Math.min(from.bounds.y + step, area.y + area.height - height),
      width,
      height,
    },
    // A cascade is only meaningful as an ordinary window: inheriting maximized
    // or fullscreen would put the new document exactly on top of the old one.
    maximized: false,
    fullScreen: false,
  };
}

function showWindow(win: BrowserWindow, state?: WindowContinuityState): void {
  // Production-browser integration tests drive windows through CDP. Keeping
  // them hidden prevents a successful test cleanup from looking like the
  // user's real DeckWerk app opened and then crashed.
  if (HEADLESS_TEST) return;
  if (state?.fullScreen) win.setFullScreen(true);
  else if (state?.maximized) win.maximize();
  win.show();
}

function revealWindow(win: BrowserWindow, state?: WindowContinuityState): void {
  win.once('ready-to-show', () => {
    showWindow(win, state);
  });
}

/** Reveal a window whose application-level readiness was checked elsewhere. */
export function revealReadyWindow(win: BrowserWindow, state?: WindowContinuityState): void {
  showWindow(win, state);
}

function loadRenderer(win: BrowserWindow, name: string, query = ''): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(`${devUrl}/${name}/index.html${query}`);
  } else {
    void win.loadFile(join(import.meta.dirname, `../renderer/${name}/index.html`), {
      search: query.replace(/^\?/, ''),
    });
  }
}

/** Send target=_blank web links to the user's browser, never a child app window. */
function openWebLinksExternally(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === 'http:' || protocol === 'https:') {
        void shell.openExternal(url).catch(() => {});
      }
    } catch {
      // Invalid and non-web targets stay closed.
    }
    return { action: 'deny' };
  });
}

/**
 * Showing a hidden BrowserWindow does not reliably finish its constructor-time
 * fullscreen transition on macOS when another window is entering fullscreen at
 * the same time. Reassert the state after the window is ready and visible.
 */
function showFullscreenWindow(win: BrowserWindow): void {
  if (HEADLESS_TEST) return;
  win.show();
  win.setFullScreen(true);
}

/**
 * Minimum window size, as the platform will actually honour it.
 *
 * A tiling compositor sizes windows itself: Hyprland hands each window its
 * share of the screen — two columns on a 1920px display is ~940px — and a
 * client that insists on more simply renders wider than the box it was given,
 * so its right edge disappears under the neighbour and the window stops
 * tracking the tile. The editor layout has no need for the floor anyway: the
 * rail bottoms out at 150px and the sidebar at 240px, leaving the canvas the
 * rest. So on Linux the request drops to a token floor and the compositor
 * decides; elsewhere the stated minimum stands.
 */
function minimumSize(width: number, height: number): { minWidth: number; minHeight: number } {
  if (process.platform === 'linux') return { minWidth: 480, minHeight: 360 };
  return { minWidth: width, minHeight: height };
}

export function createEditorWindow(query = '', state?: WindowContinuityState): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    ...continuityOptions(state),
    ...minimumSize(1100, 700),
    backgroundColor: APP_BACKGROUND,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      // A hidden window is never mapped, so it gets no compositor frames and
      // every DevTools input event waits out a ~1 s fallback. Offscreen
      // rendering keeps producing frames with nothing on screen.
      offscreen: HEADLESS_TEST,
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  openWebLinksExternally(win);
  revealWindow(win, state);
  loadRenderer(win, 'editor', query);
  return win;
}

/**
 * The host's window while collaborating: the same browser collab client the
 * joiners use, served over localhost. Deliberately NO preload — the collab
 * client installs its own network-backed `window.api`, which the context
 * bridge would otherwise make read-only.
 */
export function createCollabHostWindow(url: string, state?: WindowContinuityState): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    ...continuityOptions(state),
    ...minimumSize(1100, 700),
    backgroundColor: APP_BACKGROUND,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      // A hidden window is never mapped, so it gets no compositor frames and
      // every DevTools input event waits out a ~1 s fallback. Offscreen
      // rendering keeps producing frames with nothing on screen.
      offscreen: HEADLESS_TEST,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  // Unlike a static editor window, the collaboration shell is not usable when
  // its HTML first paints: it still has to connect its WebSocket and receive
  // the authoritative deck. The main process reveals it only after that
  // application-level readiness handshake succeeds.
  void win.loadURL(url);
  return win;
}

/**
 * Fullscreen presentation. Prefers an external display when one is attached,
 * which is the normal case at a talk, and keeps the editor usable behind it.
 */
export function createPresentWindow(
  cursorSlide = 0,
  displayId?: number,
  endSlideIndex?: number,
  visible = true,
): BrowserWindow {
  const { displays, primary } = presentationScreens();
  const target = chooseDisplayById(displays, displayId, chooseAudienceDisplay(displays, primary));

  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    backgroundColor: '#000000',
    fullscreen: visible,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      // A hidden window is never mapped, so it gets no compositor frames and
      // every DevTools input event waits out a ~1 s fallback. Offscreen
      // rendering keeps producing frames with nothing on screen.
      offscreen: HEADLESS_TEST,
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Videos must start on their own when a slide appears; without this the
      // whole autoplay model would depend on a click per slide.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  openWebLinksExternally(win);
  if (visible) win.once('ready-to-show', () => showFullscreenWindow(win));
  loadAudiencePage(win, { slide: cursorSlide, endSlide: endSlideIndex });
  return win;
}

/**
 * Where an audience page starts. `slide`/`endSlide` are the talk's range as
 * Present opened it; `resume` puts a page that takes over a running show
 * (Switch displays) back at its exact build step with its timers intact.
 */
export interface AudiencePageStart {
  slide: number;
  endSlide?: number;
  resume?: { slide: number; step: number; startedAt: number; slideStartedAt: number };
}

export function audiencePageQuery(start: AudiencePageStart): string {
  const query = new URLSearchParams({ slide: String(start.slide) });
  if (start.endSlide !== undefined) query.set('endSlide', String(start.endSlide));
  if (start.resume) {
    query.set('resumeSlide', String(start.resume.slide));
    query.set('resumeStep', String(start.resume.step));
    query.set('startedAt', String(start.resume.startedAt));
    query.set('slideStartedAt', String(start.resume.slideStartedAt));
  }
  return `?${query.toString()}`;
}

/** Load (or reload) the audience player into a presentation window. */
export function loadAudiencePage(win: BrowserWindow, start: AudiencePageStart): void {
  loadRenderer(win, 'present', audiencePageQuery(start));
}

/** Load (or reload) Speaker View into a presentation window. */
export function loadSpeakerPage(win: BrowserWindow): void {
  loadRenderer(win, 'presenter');
}

/** Fullscreen control surface; the audience window remains fullscreen separately. */
export function createPresenterWindow(
  displayId?: number,
  visibleAboveFullscreen = false,
): BrowserWindow {
  const { displays, primary } = presentationScreens();
  const target = chooseDisplayById(displays, displayId, primary);
  const win = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: APP_BACKGROUND,
    title: 'Speaker View',
    show: false,
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      // A hidden window is never mapped, so it gets no compositor frames and
      // every DevTools input event waits out a ~1 s fallback. Offscreen
      // rendering keeps producing frames with nothing on screen.
      offscreen: HEADLESS_TEST,
      preload: preload(), contextIsolation: true, nodeIntegration: false, sandbox: false,
      // "Switch displays" can turn this window into the audience player in
      // place, so it needs the same autoplay policy as the projector window.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  openWebLinksExternally(win);
  win.once('ready-to-show', () => {
    if (visibleAboveFullscreen) showSpeakerWindowAboveFullscreen(win);
    else showFullscreenWindow(win);
  });
  loadSpeakerPage(win);
  return win;
}

/**
 * Keep Speaker View reachable when it has to share a display with the
 * fullscreen audience window. On macOS, fullscreen windows live in their own
 * Space, so always-on-top alone is not enough to make the second window
 * visible there. The workspace setting is a no-op on Windows.
 */
export function showSpeakerWindowAboveFullscreen(win: BrowserWindow): void {
  if (HEADLESS_TEST) return;
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  showFullscreenWindow(win);
  win.focus();
}

/** Hidden document that lays every requested slide state out as print pages. */
export function createPdfWindow(query: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 960,
    height: 540,
    show: false,
    backgroundColor: '#000000',
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      // A hidden window is never mapped, so it gets no compositor frames and
      // every DevTools input event waits out a ~1 s fallback. Offscreen
      // rendering keeps producing frames with nothing on screen.
      offscreen: HEADLESS_TEST,
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  loadRenderer(win, 'print', query);
  return win;
}

export function createTrimWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    ...minimumSize(800, 640),
    backgroundColor: APP_BACKGROUND,
    title: 'Trim & Crop',
    show: false,
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      // A hidden window is never mapped, so it gets no compositor frames and
      // every DevTools input event waits out a ~1 s fallback. Offscreen
      // rendering keeps producing frames with nothing on screen.
      offscreen: HEADLESS_TEST,
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => { if (!HEADLESS_TEST) win.show(); });
  loadRenderer(win, 'trim');
  return win;
}

/** Destructive pixel editor. Like trim, it writes a derived asset on Apply. */
export function createRasterWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 860,
    ...minimumSize(760, 580),
    backgroundColor: APP_BACKGROUND,
    title: 'Raster Paint',
    show: false,
    webPreferences: {
      backgroundThrottling: !HEADLESS_TEST,
      // A hidden window is never mapped, so it gets no compositor frames and
      // every DevTools input event waits out a ~1 s fallback. Offscreen
      // rendering keeps producing frames with nothing on screen.
      offscreen: HEADLESS_TEST,
      preload: preload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.once('ready-to-show', () => { if (!HEADLESS_TEST) win.show(); });
  loadRenderer(win, 'raster');
  return win;
}
