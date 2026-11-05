import { describe, expect, it } from 'vitest';
import { moveFullscreenWindow, type MovableWindow } from '../src/main/fullscreenMove.js';

type Event = 'enter-full-screen' | 'leave-full-screen';

/**
 * A window that behaves like macOS can: transitions report through events,
 * and the platform may drop a request or never answer it.
 */
function fakeWindow(behaviour: {
  /** Fire leave-full-screen when asked to leave. */
  leaveFires?: boolean;
  /** How many enter requests are dropped before one takes. */
  dropEnters?: number;
  /** Fire enter-full-screen when an enter takes. */
  enterFires?: boolean;
} = {}) {
  const { leaveFires = true, enterFires = true } = behaviour;
  let dropEnters = behaviour.dropEnters ?? 0;
  const listeners = new Map<Event, Set<() => void>>();
  const log: string[] = [];
  let fullscreen = true;
  const emit = (event: Event): void => {
    const set = listeners.get(event);
    if (!set) return;
    listeners.delete(event);
    for (const listener of set) listener();
  };
  const win: MovableWindow & { log: string[]; listenerCount: () => number } = {
    log,
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    isDestroyed: () => false,
    isFullScreen: () => fullscreen,
    setBounds: (bounds) => { log.push(`bounds ${bounds.x}`); },
    setFullScreen(flag) {
      log.push(`fullscreen ${flag}`);
      if (!flag) {
        fullscreen = false;
        if (leaveFires) queueMicrotask(() => emit('leave-full-screen'));
        return;
      }
      if (dropEnters > 0) { dropEnters -= 1; return; }
      fullscreen = true;
      if (enterFires) queueMicrotask(() => emit('enter-full-screen'));
    },
    once(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  return win;
}

const projector = { x: 1920, y: 0, width: 1920, height: 1080 };
const fast = { transitionTimeoutMs: 20, settleMs: 1 };

describe('moving a fullscreen window to another display', () => {
  it('leaves fullscreen, moves, and goes fullscreen on the new display', async () => {
    const win = fakeWindow();
    await moveFullscreenWindow(win, projector, fast);
    expect(win.log).toEqual(['fullscreen false', 'bounds 1920', 'fullscreen true']);
    expect(win.isFullScreen()).toBe(true);
  });

  it('finishes even when the platform never reports leaving fullscreen', async () => {
    const win = fakeWindow({ leaveFires: false });
    await moveFullscreenWindow(win, projector, fast);
    expect(win.isFullScreen()).toBe(true);
    expect(win.listenerCount()).toBe(0);
  });

  it('finishes even when the platform never reports entering fullscreen', async () => {
    const win = fakeWindow({ enterFires: false });
    await moveFullscreenWindow(win, projector, fast);
    expect(win.isFullScreen()).toBe(true);
  });

  it('asks again when the first fullscreen request was dropped mid-transition', async () => {
    const win = fakeWindow({ dropEnters: 1 });
    await moveFullscreenWindow(win, projector, fast);
    expect(win.log.filter((line) => line === 'fullscreen true')).toHaveLength(2);
    expect(win.isFullScreen()).toBe(true);
  });

  it('does nothing for a closed window', async () => {
    const win = { ...fakeWindow(), isDestroyed: () => true };
    await moveFullscreenWindow(win, projector, fast);
    expect(win.log).toEqual([]);
  });
});
