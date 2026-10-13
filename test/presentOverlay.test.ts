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
    document.body.replaceChildren();
  });

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
    // The browser consumes Escape itself; the page only sees fullscreen end.
    document.dispatchEvent(new Event('fullscreenchange'));

    expect(overlayFrame()).toBeNull();
    expect(ended).toEqual(['slide-5']);
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
