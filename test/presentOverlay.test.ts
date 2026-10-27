// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck } from '../src/shared/deck.js';
import { presentUrl, startPresenting } from '../src/renderer/collab/presentOverlay.js';

/**
 * How the browser client opens a presentation: one iframe overlay, plus a
 * second window when the presenter asked for Speaker View. Both surfaces are
 * `present.html`; the query decides which role each one plays.
 */

const seed = () => ({ deck: emptyDeck('Talk'), themeCss: 'body{}' });

function overlayFrame(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>('iframe[src*="present.html"]');
}

function query(url: string): URLSearchParams {
  return new URLSearchParams(url.slice(url.indexOf('?') + 1));
}

describe('present URLs', () => {
  it('is 1-based, matching how slides are counted everywhere else', () => {
    expect(query(presentUrl('talk', 0)).get('slide')).toBe('1');
    expect(query(presentUrl('talk', 7)).get('slide')).toBe('8');
  });

  it('carries an inclusive range as a 1-based end slide', () => {
    const params = query(presentUrl('talk', 2, { endSlideIndex: 5 }));
    expect(params.get('slide')).toBe('3');
    expect(params.get('endSlide')).toBe('6');
  });

  it('omits endSlide, role and embed unless asked for', () => {
    const params = query(presentUrl('talk', 0));
    expect(params.get('endSlide')).toBeNull();
    expect(params.get('role')).toBeNull();
    expect(params.get('embed')).toBeNull();
  });

  it('escapes a deck id that would otherwise break the query', () => {
    expect(query(presentUrl('my talk&x=1', 0)).get('deck')).toBe('my talk&x=1');
  });
});

describe('starting a browser presentation', () => {
  let opened: Array<{ url: string; name: string }>;
  let audienceWindows: Array<{ closed: boolean; close: () => void }>;
  let popupsAllowed: boolean;
  let statuses: string[];

  beforeEach(() => {
    document.body.replaceChildren();
    opened = [];
    audienceWindows = [];
    popupsAllowed = true;
    statuses = [];
    vi.stubGlobal('open', (url: string, name: string) => {
      opened.push({ url, name });
      if (!popupsAllowed) return null;
      const handle = { closed: false, close: () => { handle.closed = true; } };
      audienceWindows.push(handle);
      return handle as unknown as Window;
    });
    // jsdom implements neither, and both are best-effort in the real client.
    HTMLElement.prototype.requestFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: vi.fn(() => Promise.resolve()),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setFullscreenElement(null);
    document.body.replaceChildren();
  });

  /** jsdom has no fullscreen: say which element the browser would report. */
  function setFullscreenElement(element: Element | null): void {
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => element });
  }

  it('mounts the audience in a fullscreened overlay by default', () => {
    startPresenting('talk', 3, seed);

    expect(opened).toEqual([]);
    const params = query(overlayFrame()!.src);
    expect(params.get('slide')).toBe('4');
    expect(params.get('embed')).toBe('1');
    expect(params.get('role')).toBeNull();
    expect(overlayFrame()!.requestFullscreen).toHaveBeenCalled();
  });

  it('passes a bounded range on to the presentation', () => {
    startPresenting('talk', 1, seed, { endSlideIndex: 4 });
    expect(query(overlayFrame()!.src).get('endSlide')).toBe('5');
  });

  it('puts the audience in a second window and Speaker View in this tab', () => {
    startPresenting('talk', 2, seed, { speakerView: true, onStatus: (m) => statuses.push(m) });

    // The audience is the surface that has to travel to the projector, so it
    // is the one that gets the window a click gesture is allowed to open.
    expect(opened).toHaveLength(1);
    const audience = query(opened[0].url);
    expect(audience.get('role')).toBeNull();
    expect(audience.get('slide')).toBe('3');
    expect(audience.get('embed')).toBeNull();

    expect(query(overlayFrame()!.src).get('role')).toBe('speaker');
    expect(statuses.join(' ')).toContain('Speaker View');
  });

  it('gives both surfaces the same range', () => {
    startPresenting('talk', 0, seed, { speakerView: true, endSlideIndex: 2 });
    expect(query(opened[0].url).get('endSlide')).toBe('3');
    expect(query(overlayFrame()!.src).get('endSlide')).toBe('3');
  });

  it('falls back to presenting in this tab when the pop-up is blocked', () => {
    popupsAllowed = false;
    startPresenting('talk', 0, seed, { speakerView: true, onStatus: (m) => statuses.push(m) });

    // No audience window means nothing for a Speaker View to drive; present
    // normally rather than leaving the presenter looking at dead controls.
    expect(query(overlayFrame()!.src).get('role')).toBeNull();
    expect(statuses.join(' ')).toContain('allow pop-ups');
  });

  it('replaces a previous overlay rather than stacking a second one', () => {
    startPresenting('talk', 0, seed);
    startPresenting('talk', 1, seed);

    expect(document.querySelectorAll('iframe[src*="present.html"]')).toHaveLength(1);
    expect(query(overlayFrame()!.src).get('slide')).toBe('2');
  });

  it('seeds the presentation from the editor tab so it paints without a round trip', () => {
    startPresenting('talk', 0, seed);
    const frame = overlayFrame()!;
    const posted: unknown[] = [];
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { postMessage: (message: unknown) => posted.push(message) },
    });

    window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin,
      data: { type: 'present-hello' },
    }));

    expect(posted).toHaveLength(1);
    expect((posted[0] as { type: string; themeCss: string }).type).toBe('present-seed');
    expect((posted[0] as { themeCss: string }).themeCss).toBe('body{}');
  });

  it('ignores a seed request from another origin', () => {
    startPresenting('talk', 0, seed);
    const frame = overlayFrame()!;
    const posted: unknown[] = [];
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: { postMessage: (message: unknown) => posted.push(message) },
    });

    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://evil.example',
      data: { type: 'present-hello' },
    }));

    expect(posted).toEqual([]);
  });

  it('tears the overlay down when the presentation says it is over', () => {
    startPresenting('talk', 0, seed);
    window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin,
      data: { type: 'present-exit' },
    }));

    expect(overlayFrame()).toBeNull();
  });

  it('closes the audience window when the presentation ends', () => {
    startPresenting('talk', 0, seed, { speakerView: true });
    window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin,
      data: { type: 'present-exit' },
    }));

    expect(audienceWindows).toHaveLength(1);
    expect(audienceWindows[0].closed).toBe(true);
  });

  it('hands the editor the slide the show ended on', () => {
    const ended: string[] = [];
    startPresenting('talk', 0, seed, { onEnd: (slideId) => ended.push(slideId) });
    for (const slideId of ['slide-2', 'slide-3']) {
      window.dispatchEvent(new MessageEvent('message', {
        origin: location.origin,
        data: { type: 'present-at', slideId },
      }));
    }
    window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin,
      data: { type: 'present-exit' },
    }));

    expect(ended).toEqual(['slide-3']);
  });

  it('hands over the shown slide when Escape leaves fullscreen', () => {
    const ended: string[] = [];
    startPresenting('talk', 0, seed, { onEnd: (slideId) => ended.push(slideId) });
    window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin,
      data: { type: 'present-at', slideId: 'slide-5' },
    }));
    setFullscreenElement(overlayFrame());
    document.dispatchEvent(new Event('fullscreenchange'));
    // The browser consumes Escape itself; the page only sees fullscreen end.
    setFullscreenElement(null);
    document.dispatchEvent(new Event('fullscreenchange'));

    expect(overlayFrame()).toBeNull();
    expect(ended).toEqual(['slide-5']);
  });

  it('takes the overlay down, and says why, when the presentation never loads', () => {
    vi.useFakeTimers();
    try {
      startPresenting('talk', 0, seed, { onStatus: (text) => statuses.push(text) });
      vi.advanceTimersByTime(11_000);
      expect(overlayFrame()).not.toBeNull();
      vi.advanceTimersByTime(2_000);
      expect(overlayFrame()).toBeNull();
      expect(statuses.at(-1)).toContain('The presentation did not load');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a presentation that said hello, however long it runs', () => {
    vi.useFakeTimers();
    try {
      startPresenting('talk', 0, seed, { onStatus: (text) => statuses.push(text) });
      window.dispatchEvent(new MessageEvent('message', { origin: location.origin, data: { type: 'present-hello' } }));
      vi.advanceTimersByTime(60_000);
      expect(overlayFrame()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a new show up when the last one finishes leaving fullscreen after Present is pressed again', () => {
    startPresenting('talk', 0, seed);
    setFullscreenElement(overlayFrame());
    document.dispatchEvent(new Event('fullscreenchange'));
    // End the show from inside it; leaving fullscreen is asynchronous...
    window.dispatchEvent(new MessageEvent('message', { origin: location.origin, data: { type: 'present-exit' } }));
    expect(overlayFrame()).toBeNull();
    // ...and Present is pressed again before it has.
    startPresenting('talk', 2, seed);
    const next = overlayFrame();
    setFullscreenElement(null);
    document.dispatchEvent(new Event('fullscreenchange'));

    expect(overlayFrame()).toBe(next);
    expect(next).not.toBeNull();
  });

  it('ignores a shown slide reported from another origin', () => {
    const ended: string[] = [];
    startPresenting('talk', 0, seed, { onEnd: (slideId) => ended.push(slideId) });
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://evil.example',
      data: { type: 'present-at', slideId: 'slide-9' },
    }));
    window.dispatchEvent(new MessageEvent('message', {
      origin: location.origin,
      data: { type: 'present-exit' },
    }));

    expect(ended).toEqual([]);
  });

  it('closes the previous audience window when presenting again', () => {
    startPresenting('talk', 0, seed, { speakerView: true });
    startPresenting('talk', 4, seed, { speakerView: true });

    expect(audienceWindows.map((window) => window.closed)).toEqual([true, false]);
  });
});

/**
 * Chrome on a laptop with a projector attached: the Window Management API
 * says there is a second screen. Present must put the audience fullscreen on
 * it and Speaker View on the laptop, as the desktop app and Keynote do.
 *
 * BUG (fixed): Present never looked at the screens. It fullscreened the
 * audience over the editor tab on the laptop, and Speaker View asked the
 * presenter to drag a window to the projector by hand.
 */
describe('presenting with a second screen attached', () => {
  interface FakeScreen {
    label: string;
    isInternal: boolean;
    left: number; top: number; width: number; height: number;
    availLeft: number; availTop: number; availWidth: number; availHeight: number;
  }
  const laptop: FakeScreen = {
    label: 'Built-in Retina Display', isInternal: true,
    left: 0, top: 0, width: 1512, height: 982,
    availLeft: 0, availTop: 25, availWidth: 1512, availHeight: 957,
  };
  const projector: FakeScreen = {
    label: 'Projector', isInternal: false,
    left: 1512, top: 0, width: 1920, height: 1080,
    availLeft: 1512, availTop: 0, availWidth: 1920, availHeight: 1080,
  };

  let opened: Array<{ url: string; name: string; features: string }>;
  let popups: Array<{ closed: boolean; close: () => void }>;
  let popupsAllowed: boolean;
  let statuses: string[];
  let fullscreenScreens: Array<string | null>;
  let fullscreenRefused: boolean;
  let permission: string;
  /** What the person answers when the browser asks. */
  let answer: 'allow' | 'deny';
  let promptAnswered: Promise<void>;
  let releasePrompt: () => void;
  let screenDetailsCalls: number;
  let activation: { isActive: boolean };
  let details: { screens: FakeScreen[]; currentScreen: FakeScreen };

  function define(target: object, key: string, value: unknown): void {
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
  }

  beforeEach(() => {
    document.body.replaceChildren();
    opened = [];
    popups = [];
    popupsAllowed = true;
    statuses = [];
    fullscreenScreens = [];
    fullscreenRefused = false;
    permission = 'granted';
    answer = 'allow';
    screenDetailsCalls = 0;
    promptAnswered = Promise.resolve();
    releasePrompt = () => undefined;
    activation = { isActive: true };
    details = { screens: [laptop, projector], currentScreen: laptop };

    vi.stubGlobal('open', (url: string, name: string, features = '') => {
      opened.push({ url, name, features });
      if (!popupsAllowed) return null;
      const handle = { closed: false, close: () => { handle.closed = true; } };
      popups.push(handle);
      return handle as unknown as Window;
    });
    HTMLElement.prototype.requestFullscreen = vi.fn(function (options?: { screen?: FakeScreen }) {
      fullscreenScreens.push(options?.screen?.label ?? null);
      if (fullscreenRefused) return Promise.reject(new TypeError('refused'));
      // Going fullscreen on the projector moves the editor's window there,
      // and ScreenDetails.currentScreen follows it.
      if (options?.screen) details.currentScreen = options.screen;
      return Promise.resolve();
    }) as unknown as HTMLElement['requestFullscreen'];
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: vi.fn(() => Promise.resolve()),
    });
    define(window.screen, 'isExtended', true);
    vi.stubGlobal('getScreenDetails', async () => {
      screenDetailsCalls++;
      if (permission === 'prompt') {
        await promptAnswered;
        permission = answer === 'allow' ? 'granted' : 'denied';
      }
      if (permission !== 'granted') throw new DOMException('Permission denied.', 'NotAllowedError');
      return details;
    });
    define(navigator, 'permissions', {
      query: async ({ name }: { name: string }) => {
        if (name !== 'window-management') throw new TypeError(`unknown permission ${name}`);
        return { state: permission };
      },
    });
    define(navigator, 'userActivation', activation);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window.screen as unknown as { isExtended?: boolean }).isExtended;
    delete (navigator as unknown as { permissions?: unknown }).permissions;
    delete (navigator as unknown as { userActivation?: unknown }).userActivation;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    document.body.replaceChildren();
  });

  /** The prompt stays up until the test answers it. */
  function holdPrompt(): void {
    permission = 'prompt';
    promptAnswered = new Promise((resolve) => { releasePrompt = resolve; });
  }

  it('puts the audience fullscreen on the projector and Speaker View on the laptop', async () => {
    await startPresenting('talk', 2, seed, { onStatus: (m) => statuses.push(m) });

    // The editor tab is the audience: it is the one surface the click can
    // fullscreen, and fullscreen can be sent to another screen.
    const frame = overlayFrame()!;
    expect(query(frame.src).get('role')).toBeNull();
    expect(query(frame.src).get('embed')).toBe('1');
    expect(fullscreenScreens).toEqual(['Projector']);

    // Speaker View comes automatically, filling the laptop's screen.
    expect(opened).toHaveLength(1);
    const speaker = query(opened[0].url);
    expect(speaker.get('role')).toBe('speaker');
    expect(speaker.get('slide')).toBe('3');
    expect(speaker.get('embed')).toBeNull();
    expect(opened[0].features).toBe('popup,left=0,top=25,width=1512,height=957');
    // Nobody has to drag a window anywhere.
    expect(statuses.join(' ')).not.toContain('move the new window');
  });

  it('does the same for Present in Speaker View', async () => {
    await startPresenting('talk', 0, seed, { speakerView: true, endSlideIndex: 2 });

    expect(fullscreenScreens).toEqual(['Projector']);
    expect(opened).toHaveLength(1);
    expect(query(opened[0].url).get('role')).toBe('speaker');
    expect(query(opened[0].url).get('endSlide')).toBe('3');
    expect(query(overlayFrame()!.src).get('role')).toBeNull();
    expect(query(overlayFrame()!.src).get('endSlide')).toBe('3');
  });

  it('sends the audience to the laptop when the editor is on the external monitor', async () => {
    details.currentScreen = projector;
    await startPresenting('talk', 0, seed);

    expect(fullscreenScreens).toEqual(['Built-in Retina Display']);
    expect(opened[0].features).toBe('popup,left=1512,top=0,width=1920,height=1080');
  });

  it('closes Speaker View when the show ends on the projector', async () => {
    await startPresenting('talk', 0, seed);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => overlayFrame() });
    document.dispatchEvent(new Event('fullscreenchange'));
    // Escape on the projector leaves fullscreen.
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    document.dispatchEvent(new Event('fullscreenchange'));

    expect(overlayFrame()).toBeNull();
    expect(popups.map((popup) => popup.closed)).toEqual([true]);
  });

  it('ends the projector when Speaker View ends the show', async () => {
    await startPresenting('talk', 0, seed);
    // Speaker View's End show says goodbye on the bus; the audience in the
    // overlay hears it and tells this tab.
    window.dispatchEvent(new MessageEvent('message', { origin: location.origin, data: { type: 'present-exit' } }));

    expect(overlayFrame()).toBeNull();
    expect(popups[0].closed).toBe(true);
  });

  it('keeps the projector going, and says why, when the pop-up is blocked', async () => {
    popupsAllowed = false;
    await startPresenting('talk', 0, seed, { onStatus: (m) => statuses.push(m) });

    expect(fullscreenScreens).toEqual(['Projector']);
    expect(overlayFrame()).not.toBeNull();
    expect(statuses.join(' ')).toContain('allow pop-ups');
  });

  it('presents in this tab, without Speaker View, when the projector refuses fullscreen', async () => {
    fullscreenRefused = true;
    await startPresenting('talk', 0, seed, { onStatus: (m) => statuses.push(m) });

    expect(overlayFrame()).not.toBeNull();
    expect(query(overlayFrame()!.src).get('role')).toBeNull();
    expect(opened).toEqual([]);
  });

  it('asks once, then presents on both screens when allowed straight away', async () => {
    holdPrompt();
    const started = startPresenting('talk', 0, seed, { onStatus: (m) => statuses.push(m) });
    await vi.waitFor(() => expect(screenDetailsCalls).toBe(1));
    // Nothing is on screen while the browser asks, and the status says why.
    expect(overlayFrame()).toBeNull();
    expect(statuses.at(-1)).toContain('allow window management');
    releasePrompt();
    await started;

    expect(fullscreenScreens).toEqual(['Projector']);
    expect(query(opened[0].url).get('role')).toBe('speaker');
  });

  it('starts nothing, and says to press Present again, when the click expired during the prompt', async () => {
    holdPrompt();
    const started = startPresenting('talk', 0, seed, { onStatus: (m) => statuses.push(m) });
    await vi.waitFor(() => expect(screenDetailsCalls).toBe(1));
    activation.isActive = false;
    releasePrompt();
    await started;

    expect(overlayFrame()).toBeNull();
    expect(opened).toEqual([]);
    expect(fullscreenScreens).toEqual([]);
    expect(statuses.at(-1)).toContain('press Present again');

    // Next time the permission is there: straight to both screens.
    activation.isActive = true;
    await startPresenting('talk', 0, seed);
    expect(fullscreenScreens).toEqual(['Projector']);
    expect(screenDetailsCalls).toBe(2);
  });

  it('presents on this screen as before when the prompt is refused', async () => {
    holdPrompt();
    answer = 'deny';
    const started = startPresenting('talk', 0, seed, { speakerView: true, onStatus: (m) => statuses.push(m) });
    releasePrompt();
    await started;

    // Exactly today's Speaker View: audience in a pop-up, speaker in the tab.
    expect(fullscreenScreens).toEqual([null]);
    expect(opened).toHaveLength(1);
    expect(opened[0].features).toBe('');
    expect(query(opened[0].url).get('role')).toBeNull();
    expect(query(overlayFrame()!.src).get('role')).toBe('speaker');
  });

  it('starts nothing when the prompt is refused after the click expired', async () => {
    holdPrompt();
    answer = 'deny';
    const started = startPresenting('talk', 0, seed, { onStatus: (m) => statuses.push(m) });
    await vi.waitFor(() => expect(screenDetailsCalls).toBe(1));
    activation.isActive = false;
    releasePrompt();
    await started;

    expect(overlayFrame()).toBeNull();
    expect(opened).toEqual([]);
    expect(statuses.at(-1)).toContain('press Present again');
  });

  it('never asks again once refused, and presents on this screen', async () => {
    permission = 'denied';
    await startPresenting('talk', 0, seed);

    expect(screenDetailsCalls).toBe(0);
    expect(fullscreenScreens).toEqual([null]);
    expect(opened).toEqual([]);
  });

  it('presents on this screen, without asking, when there is only one screen', () => {
    define(window.screen, 'isExtended', false);
    // Synchronous, exactly as before: nothing awaited before the overlay.
    void startPresenting('talk', 0, seed);

    expect(overlayFrame()).not.toBeNull();
    expect(screenDetailsCalls).toBe(0);
    expect(fullscreenScreens).toEqual([null]);
  });

  it('keeps one-screen Speaker View for a rehearsal', () => {
    define(window.screen, 'isExtended', false);
    void startPresenting('talk', 0, seed, { speakerView: true });

    expect(opened).toHaveLength(1);
    expect(query(opened[0].url).get('role')).toBeNull();
    expect(query(overlayFrame()!.src).get('role')).toBe('speaker');
  });

  it('presents synchronously, as before, in a browser without the API', () => {
    vi.stubGlobal('getScreenDetails', undefined);
    void startPresenting('talk', 0, seed, { speakerView: true });

    expect(screenDetailsCalls).toBe(0);
    expect(opened).toHaveLength(1);
    expect(query(overlayFrame()!.src).get('role')).toBe('speaker');
  });

  it('runs only the latest Present when it is pressed again during the prompt', async () => {
    holdPrompt();
    const first = startPresenting('talk', 0, seed);
    await vi.waitFor(() => expect(screenDetailsCalls).toBe(1));
    const second = startPresenting('talk', 3, seed);
    releasePrompt();
    await Promise.all([first, second]);

    expect(document.querySelectorAll('iframe[src*="present.html"]')).toHaveLength(1);
    expect(query(overlayFrame()!.src).get('slide')).toBe('4');
    expect(opened).toHaveLength(1);
  });
});
