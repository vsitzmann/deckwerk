// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';
import { VideoBlobCache } from '../src/renderer/player/videoBlobCache.js';

/**
 * Presenting from the server in Safari, Oct 2026 (the TRI site visit): a
 * slide with four clips was downloaded again on every visit, its clips spun,
 * then showed without playing, and only stepping back and forward got them
 * going. The server's asset log showed why: Safari's media loader keeps no
 * bytes from one <video> to the next, so the HTTP-cache warming and element
 * pooling that make Chromium fast did nothing for it.
 *
 * The browser presentation therefore downloads each clip once, whole, and
 * plays it from a blob. These tests hold that, plus two failure modes the
 * same session exposed: a clip whose load failed was reused dead on every
 * later visit, and a clip that took longer to load than the play-retry budget
 * stayed frozen once it had loaded.
 */

function videoElement(id: string, src: string, extra: Record<string, unknown> = {}): SlideElement {
  return {
    id,
    type: 'video',
    x: 0, y: 0, w: 640, h: 360, rot: 0, z: 1, opacity: 1,
    class: [], style: {},
    src,
    poster: null, start: 0, end: null,
    autoplay: false, loop: true, muted: true, controls: false,
    fit: 'contain',
    ...extra,
  } as unknown as SlideElement;
}

function deckWith(slides: SlideElement[][]): Deck {
  const deck = emptyDeck('From memory');
  deck.slides = slides.map((elements, i) => ({ ...deck.slides[0], id: `s${i}`, elements }));
  return deck;
}

function fakeReadyState(video: HTMLVideoElement, value: number): void {
  Object.defineProperty(video, 'readyState', { value, configurable: true });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fetch whose responses the test releases one by one. */
function controlledFetch() {
  const requests: Array<{ url: string; signal: AbortSignal; respond: (bytes?: number) => void; fail: () => void }> = [];
  const fetchFile = ((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    const url = String(input);
    const signal = init!.signal!;
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    requests.push({
      url,
      signal,
      respond: (bytes = 100) => resolve(new Response(new Uint8Array(bytes), {
        headers: { 'content-length': String(bytes) },
      })),
      fail: () => reject(new TypeError('network')),
    });
  })) as typeof fetch;
  return { requests, fetchFile };
}

function cacheWith(fetchFile: typeof fetch, budgetBytes?: number) {
  const revoked: string[] = [];
  let next = 0;
  const cache = new VideoBlobCache({
    fetch: fetchFile,
    budgetBytes,
    createObjectUrl: () => `blob:test/${next++}`,
    revokeObjectUrl: (url) => { revoked.push(url); },
  });
  return { cache, revoked };
}

let host: HTMLElement;
let player: Player | null = null;

beforeEach(() => {
  document.body.replaceChildren();
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
  if (!CSS.escape) CSS.escape = (value) => value;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  HTMLMediaElement.prototype.load = function () {
    this.dispatchEvent(new Event('emptied'));
  };
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  player?.destroy();
  player = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('VideoBlobCache', () => {
  it('downloads one file at a time, in the order asked, and serves each from memory', async () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile);
    cache.want(['/a.mp4', '/b.mp4']);
    expect(requests.map((r) => r.url)).toEqual(['/a.mp4']);
    expect(cache.objectUrl('/a.mp4')).toBeUndefined();

    requests[0].respond();
    await flush();
    expect(cache.objectUrl('/a.mp4')).toBe('blob:test/0');
    expect(requests.map((r) => r.url)).toEqual(['/a.mp4', '/b.mp4']);
  });

  it('starts nothing new while held, and abandons a file no longer wanted', async () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile);
    cache.want(['/a.mp4', '/b.mp4']);
    cache.hold();
    requests[0].respond();
    await flush();
    expect(requests).toHaveLength(1);

    cache.want(['/c.mp4']);
    expect(requests.map((r) => r.url)).toEqual(['/a.mp4', '/c.mp4']);
    cache.want(['/d.mp4']);
    expect(requests[1].signal.aborted).toBe(true);
    expect(requests.at(-1)!.url).toBe('/d.mp4');
  });

  it('makes room by dropping what the talk reaches last, never what an element reads', async () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache, revoked } = cacheWith(fetchFile, 250);
    cache.want(['/a.mp4', '/b.mp4']);
    requests[0].respond(100);
    await flush();
    requests[1].respond(100);
    await flush();

    // The talk moved: c is now most urgent, b furthest away.
    cache.setInUse((url) => url === cache.objectUrl('/a.mp4'));
    cache.want(['/c.mp4', '/a.mp4', '/b.mp4']);
    requests[2].respond(100);
    await flush();
    expect(cache.objectUrl('/c.mp4')).toBeDefined();
    expect(cache.objectUrl('/b.mp4')).toBeUndefined();
    expect(revoked).toEqual(['blob:test/1']);
    expect(cache.heldBytes).toBe(200);
  });

  it('leaves a file it cannot hold, or keeps failing to fetch, to stream', async () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile, 50);
    cache.want(['/huge.mp4', '/flaky.mp4']);
    requests[0].respond(100);
    await flush();
    expect(cache.covers('/huge.mp4')).toBe(false);

    requests[1].fail();
    await flush();
    expect(cache.covers('/flaky.mp4')).toBe(true);
    requests[2].fail();
    await flush();
    expect(cache.covers('/flaky.mp4')).toBe(false);
    expect(requests).toHaveLength(3);
  });
});

describe('the Player with clips in memory', () => {
  it('plays a clip from memory once it is there, so a revisit fetches nothing', async () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile);
    const deck = deckWith([
      [],
      [videoElement('v', 'assets/clip.05a38d7a.mp4')],
      [],
    ]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}`, videoBlobs: cache });
    // The next slide's clip is fetched while this one is on screen.
    expect(requests.map((r) => r.url)).toEqual(['/x/assets/clip.05a38d7a.mp4']);
    requests[0].respond();
    await flush();

    player.goToSlide(1);
    expect(host.querySelector('video')!.getAttribute('src')).toBe('blob:test/0');
    player.goToSlide(2);
    player.goToSlide(1);
    expect(host.querySelector('video')!.getAttribute('src')).toBe('blob:test/0');
    expect(requests).toHaveLength(1);
  });

  it('decodes an upcoming clip from memory rather than downloading it a second time', async () => {
    const created: HTMLVideoElement[] = [];
    const real = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const element = real(tag, options);
      if (tag === 'video') created.push(element as HTMLVideoElement);
      return element;
    }) as typeof document.createElement);
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile);
    const deck = deckWith([[], [videoElement('v', 'assets/clip.05a38d7a.mp4')]]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}`, videoBlobs: cache });

    const warming = () => created.filter((video) => !video.isConnected && video.hasAttribute('src'));
    expect(warming()).toHaveLength(0);
    requests[0].respond();
    await flush();
    expect(warming().map((video) => video.getAttribute('src'))).toEqual(['blob:test/0']);
  });

  it('does not reuse an element whose load failed', () => {
    const deck = deckWith([
      [videoElement('a', 'assets/clip.05a38d7a.mp4')],
      [],
      [videoElement('b', 'assets/clip.05a38d7a.mp4')],
    ]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    const first = host.querySelector('video')!;
    fakeReadyState(first, HTMLMediaElement.HAVE_ENOUGH_DATA);
    // A connection dropped mid-clip: a frame is on screen, but the element is dead.
    Object.defineProperty(first, 'error', { value: { code: 2 }, configurable: true });

    player.goToSlide(1);
    player.goToSlide(2);
    expect(host.querySelector('video')).not.toBe(first);
  });

  it('starts a clip whose retries ran out while it was still loading, once it can play', async () => {
    vi.useFakeTimers();
    let plays = 0;
    let refuse = true;
    HTMLMediaElement.prototype.play = function () {
      plays += 1;
      return refuse ? Promise.reject(new DOMException('aborted', 'AbortError')) : Promise.resolve();
    };
    const deck = deckWith([[videoElement('v', 'assets/clip.05a38d7a.mp4', { autoplay: true })]]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}` });
    // Every attempt in the budget is refused while the bytes are on their way.
    await vi.advanceTimersByTimeAsync(20_000);
    const spent = plays;
    expect(spent).toBeGreaterThan(1);

    refuse = false;
    const video = host.querySelector('video')!;
    fakeReadyState(video, HTMLMediaElement.HAVE_ENOUGH_DATA);
    video.dispatchEvent(new Event('canplay'));
    await vi.advanceTimersByTimeAsync(0);
    expect(plays).toBe(spent + 1);
  });
});
