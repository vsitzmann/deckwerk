/**
 * Move a fullscreen window to another display.
 *
 * A fullscreen window cannot simply be given new bounds: it has to leave
 * fullscreen, move, and enter fullscreen again. On macOS that is two animated
 * Space transitions, and two things go wrong when they are driven naively:
 *
 * - `leave-full-screen` fires before the exit animation has fully settled, and
 *   a `setFullScreen(true)` issued from inside that handler is dropped. The
 *   window is left windowed, on its old display.
 * - A transition that macOS refuses (another window mid-transition, the
 *   window already on its way out) never fires its event at all. A caller
 *   that waits on the event forever never finishes, and "Switch displays"
 *   stays busy, ignoring every later press.
 *
 * So each step waits for its event *or* a deadline, lets the transition
 * settle before the next one, and checks the outcome instead of trusting it.
 */

export interface MovableWindow {
  isDestroyed(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  once(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): unknown;
  removeListener(event: 'enter-full-screen' | 'leave-full-screen', listener: () => void): unknown;
}

export interface MoveTiming {
  /** Longest wait for a fullscreen transition's event before going on anyway. */
  transitionTimeoutMs: number;
  /** Pause after a transition before starting the next one. */
  settleMs: number;
  /** Injected for tests. */
  delay: (ms: number) => Promise<void>;
}

const defaultTiming: MoveTiming = {
  transitionTimeoutMs: 1500,
  settleMs: 120,
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Wait for `event`, or for the deadline. Resolves true when the event came. */
function transition(
  win: MovableWindow,
  event: 'enter-full-screen' | 'leave-full-screen',
  start: () => void,
  timing: MoveTiming,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (arrived: boolean): void => {
      if (done) return;
      done = true;
      if (!arrived && !win.isDestroyed()) win.removeListener(event, onEvent);
      resolve(arrived);
    };
    const onEvent = (): void => finish(true);
    win.once(event, onEvent);
    void timing.delay(timing.transitionTimeoutMs).then(() => finish(false));
    start();
  });
}

export async function moveFullscreenWindow(
  win: MovableWindow | null,
  bounds: { x: number; y: number; width: number; height: number },
  overrides: Partial<MoveTiming> = {},
): Promise<void> {
  const timing = { ...defaultTiming, ...overrides };
  if (!win || win.isDestroyed()) return;

  if (win.isFullScreen()) {
    await transition(win, 'leave-full-screen', () => win.setFullScreen(false), timing);
    // The event can arrive while the exit is still animating; a fullscreen
    // request made now would be dropped.
    await timing.delay(timing.settleMs);
    if (win.isDestroyed()) return;
  }

  win.setBounds(bounds);
  await transition(win, 'enter-full-screen', () => win.setFullScreen(true), timing);
  if (win.isDestroyed() || win.isFullScreen()) return;

  // Dropped anyway (the platform was still busy): once more, after a pause.
  await timing.delay(timing.settleMs);
  if (win.isDestroyed()) return;
  win.setBounds(bounds);
  await transition(win, 'enter-full-screen', () => win.setFullScreen(true), timing);
}
