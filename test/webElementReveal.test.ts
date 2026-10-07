// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlideElement } from '../src/shared/deck.js';
import { renderElement, whenWebElementReady } from '../src/renderer/player/render.js';
import { WEB_BRIDGE_RUNTIME, WEB_BRIDGE_SOURCE } from '../src/shared/webBridge.js';

/**
 * A live web element must not show a page before the page is ready.
 *
 * A page that lays itself out from script (everything at 0,0 until a script
 * positions it after `document.fonts.ready`) used to be shown the moment its
 * frame was inserted, so presenting the slide flashed the raw pre-init state
 * — a pile of boxes in the top-left corner. The frame now stays hidden, under
 * its poster when it has one, until it has loaded and painted (or the page
 * says it is ready through `deckwerk.ready(promise)`), with a timeout so a
 * page that never loads still shows.
 */

type Web = Extract<SlideElement, { type: 'web' }>;

function web(overrides: Partial<Web> = {}): Web {
  return {
    id: 'web-1', type: 'web', x: 0, y: 0, w: 1600, h: 900, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: 'assets/web/page.html', poster: 'assets/web/page.png',
    interactive: true, title: 'Chart', ...overrides,
  };
}

const live = { resolveSrc: (src: string) => `/deck/${src}` };

function mount(element: Web, options: Parameters<typeof renderElement>[1] = live) {
  const node = renderElement(element, options);
  document.body.replaceChildren(node);
  const box = node.querySelector<HTMLElement>('.web-body')!;
  const frame = node.querySelector<HTMLIFrameElement>('iframe.web-frame');
  const poster = () => node.querySelector<HTMLImageElement>('img.web-poster');
  return { node, box, frame, poster };
}

/** What a viewer sees of the page: the frame, or not (the poster or nothing). */
function frameShown(frame: HTMLIFrameElement | null, poster: HTMLImageElement | null): boolean {
  return frame !== null && frame.style.visibility !== 'hidden' && poster === null;
}

async function frames(count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function fromPage(frame: HTMLIFrameElement, action: string): void {
  window.dispatchEvent(new MessageEvent('message', {
    data: { source: WEB_BRIDGE_SOURCE, action },
    source: frame.contentWindow,
  }));
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('a presented web element', () => {
  it('shows its poster, not the page, until the page has loaded and painted', async () => {
    const { frame, poster } = mount(web());
    expect(frame, 'the live frame is created at once so the page starts loading').not.toBeNull();
    expect(poster(), 'the poster covers the page while it loads').not.toBeNull();
    expect(poster()!.getAttribute('src')).toBe('/deck/assets/web/page.png');
    expect(frameShown(frame, poster()), 'the unready page is visible').toBe(false);

    frame!.dispatchEvent(new Event('load'));
    // Loaded is not painted: a page that positions itself on load needs a frame.
    expect(frameShown(frame, poster())).toBe(false);
    await frames(3);
    expect(frameShown(frame, poster()), 'the page never replaced its poster').toBe(true);
  });

  it('keeps a page without a poster hidden until it has loaded', async () => {
    const { box, frame, poster } = mount(web({ poster: null }));
    expect(poster()).toBeNull();
    expect(frame!.style.visibility).toBe('hidden');
    frame!.dispatchEvent(new Event('load'));
    await whenWebElementReady(box);
    expect(frame!.style.visibility).not.toBe('hidden');
  });

  it('waits for a page that holds its readiness, then shows it when it says so', async () => {
    const { box, frame, poster } = mount(web());
    fromPage(frame!, 'hold-ready');
    frame!.dispatchEvent(new Event('load'));
    await frames(4);
    expect(frameShown(frame, poster()), 'shown before the page said it was ready').toBe(false);

    fromPage(frame!, 'ready');
    await whenWebElementReady(box);
    expect(frameShown(frame, poster())).toBe(true);
  });

  it('ignores readiness messages from other windows', async () => {
    const { frame, poster } = mount(web());
    fromPage(frame!, 'hold-ready');
    frame!.dispatchEvent(new Event('load'));
    window.dispatchEvent(new MessageEvent('message', {
      data: { source: WEB_BRIDGE_SOURCE, action: 'ready' }, source: window,
    }));
    await frames(4);
    expect(frameShown(frame, poster())).toBe(false);
  });

  it('shows a page that never loads after a timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { box, frame, poster } = mount(web({ poster: null }));
    expect(frameShown(frame, poster())).toBe(false);
    vi.advanceTimersByTime(10_000);
    await whenWebElementReady(box);
    expect(frameShown(frame, poster())).toBe(true);
  });

  it('leaves previews alone: the poster, and no live frame', () => {
    const { frame, poster, node } = mount(web(), { ...live, mediaPreload: 'metadata' });
    expect(frame).toBeNull();
    expect(node.querySelector('img')).not.toBeNull();
    expect(poster()).toBeNull();
  });
});

describe('the bridge runtime', () => {
  it('offers deckwerk.ready(promise), holding first and releasing when it settles', async () => {
    const posted: unknown[] = [];
    const parent = { postMessage: (message: unknown) => posted.push(message) };
    const scope = { deckwerk: undefined as undefined | { ready(p?: Promise<unknown>): void } };
    const fakeWindow = new Proxy(scope as Record<string, unknown>, {
      get: (target, key) => {
        if (key === 'parent') return parent;
        if (key === 'addEventListener') return () => {};
        return target[key as string];
      },
      set: (target, key, value) => { target[key as string] = value; return true; },
    });
    new Function('window', WEB_BRIDGE_RUNTIME)(fakeWindow);
    let release!: () => void;
    scope.deckwerk!.ready(new Promise<void>((resolve) => { release = resolve; }));
    expect(posted).toEqual([{ action: 'hold-ready', source: WEB_BRIDGE_SOURCE }]);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(posted).toEqual([
      { action: 'hold-ready', source: WEB_BRIDGE_SOURCE },
      { action: 'ready', source: WEB_BRIDGE_SOURCE },
    ]);
    scope.deckwerk!.ready();
    expect(posted).toHaveLength(3);
  });
});
