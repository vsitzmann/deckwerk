// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';
import { MediaBlobCache } from '../src/renderer/player/mediaBlobCache.js';

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
  const cache = new MediaBlobCache({
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

describe('MediaBlobCache', () => {
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

/**
 * A fetch that answers at once and streams each body as the test pushes it:
 * every file is 1000 bytes under a strong ETag, and a `Range: bytes=N-` is
 * answered 206 from N.
 */
function streamingFetch() {
  const SIZE = 1000;
  const requests: Array<{ url: string; range: string | null; ifRange: string | null; signal: AbortSignal; push: (bytes: number) => void; end: () => void }> = [];
  const fetchFile = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = headers.range ?? null;
    const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => { controller = c; } });
    const signal = init!.signal!;
    signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    requests.push({
      url, range, ifRange: headers['if-range'] ?? null, signal,
      push: (bytes) => controller.enqueue(new Uint8Array(bytes)),
      end: () => controller.close(),
    });
    return Promise.resolve(new Response(body, {
      status: range ? 206 : 200,
      headers: {
        'content-length': String(SIZE - from),
        etag: '"v1"',
        ...(range ? { 'content-range': `bytes ${from}-${SIZE - 1}/${SIZE}` } : {}),
      },
    }));
  }) as typeof fetch;
  return { requests, fetchFile };
}

/** The blobs the cache made, by object URL, to check what a resumed file holds. */
function blobCacheWith(fetchFile: typeof fetch) {
  const blobs = new Map<string, Blob>();
  let next = 0;
  const cache = new MediaBlobCache({
    fetch: fetchFile,
    createObjectUrl: (blob) => {
      const url = `blob:test/${next++}`;
      blobs.set(url, blob);
      return url;
    },
    revokeObjectUrl: () => {},
  });
  return { cache, blobs };
}

// Presenting a hosted talk, Oct 2026: a slide's photos showed up seconds
// after the slide, because the cache was downloading the next slides' clips
// and the photos waited behind them on the same link.
describe('MediaBlobCache, with pictures', () => {
  it('fetches pictures ranked above a clip first, several at once, and the clip only once they are in', async () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile);
    cache.want(['/a.jpg', '/clip.mp4', '/b.jpg'], { images: ['/a.jpg', '/b.jpg'] });
    expect(requests.map((r) => r.url)).toEqual(['/a.jpg', '/b.jpg']);
    requests[0].respond();
    await flush();
    // Only the pictures ranked above a clip hold it back; b is further away.
    expect(requests.map((r) => r.url)).toEqual(['/a.jpg', '/b.jpg', '/clip.mp4']);
    expect(cache.objectUrl('/a.jpg')).toBeDefined();
  });

  it('fetches pictures while clips are held', () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile);
    cache.want(['/clip.mp4', '/a.jpg'], { images: ['/a.jpg'], hold: true });
    cache.want(['/clip.mp4', '/a.jpg', '/b.jpg'], { images: ['/a.jpg', '/b.jpg'], hold: true });
    expect(requests.map((r) => r.url)).toEqual(['/a.jpg', '/b.jpg']);
  });

  it('sets a clip aside for a picture the talk now needs, and resumes it where it stopped', async () => {
    const { requests, fetchFile } = streamingFetch();
    const { cache, blobs } = blobCacheWith(fetchFile);
    cache.want(['/clip.mp4']);
    await flush();
    requests[0].push(400);
    await flush();

    // The talk moved on: a slide whose photo is not in memory is next.
    cache.want(['/a.jpg', '/clip.mp4'], { images: ['/a.jpg'] });
    await flush();
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests.map((r) => r.url)).toEqual(['/clip.mp4', '/a.jpg']);
    expect(cache.onItsWay('/clip.mp4')).toBe(true);

    requests[1].push(1000);
    requests[1].end();
    await flush();
    expect(requests.map((r) => r.url)).toEqual(['/clip.mp4', '/a.jpg', '/clip.mp4']);
    expect(requests[2].range).toBe('bytes=400-');
    expect(requests[2].ifRange).toBe('"v1"');
    requests[2].push(600);
    requests[2].end();
    await flush();
    const objectUrl = cache.objectUrl('/clip.mp4');
    expect(objectUrl).toBeDefined();
    expect(blobs.get(objectUrl!)!.size).toBe(1000);
  });

  it('never sets aside a clip the slide on screen waits for, and starts one while held', async () => {
    const { requests, fetchFile } = streamingFetch();
    const { cache } = blobCacheWith(fetchFile);
    cache.want(['/clip.mp4', '/a.jpg'], { images: ['/a.jpg'], hold: true });
    cache.prioritize(['/clip.mp4']);
    await flush();
    expect(requests.map((r) => r.url)).toEqual(['/a.jpg', '/clip.mp4']);
    cache.want(['/b.jpg', '/clip.mp4', '/a.jpg'], { images: ['/a.jpg', '/b.jpg'] });
    await flush();
    expect(requests[1].signal.aborted).toBe(false);
  });

  it('resolves a waiter when its file lands, and with nothing when it is no longer wanted', async () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile);
    cache.want(['/a.jpg', '/b.jpg'], { images: ['/a.jpg', '/b.jpg'] });
    const a = cache.whenHeld('/a.jpg');
    const b = cache.whenHeld('/b.jpg');
    requests[0].respond();
    await flush();
    await expect(a).resolves.toBe(cache.objectUrl('/a.jpg'));
    cache.want(['/a.jpg'], { images: ['/a.jpg'] });
    await expect(b).resolves.toBeUndefined();
  });
});

function imageElement(id: string, src: string): SlideElement {
  return {
    id, type: 'image', x: 0, y: 0, w: 640, h: 360, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src, fit: 'contain', alt: '', sourceBox: null,
  } as unknown as SlideElement;
}

describe('the Player with pictures in memory', () => {
  it("fetches the next slides' pictures before the next slide's clip, and shows them from memory", async () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile);
    const deck = deckWith([
      [imageElement('p0', 'assets/zero.jpg')],
      [videoElement('v', 'assets/clip.05a38d7a.mp4')],
      [imageElement('p2', 'assets/two.jpg'), imageElement('p3', 'assets/three.jpg')],
    ]);
    // WebKit starts an <img>'s request the moment `src` is set, detached or
    // not: a picture the cache is fetching must never be given its network URL.
    const assigned: string[] = [];
    const srcProperty = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement, value: string) {
      assigned.push(value);
      srcProperty.set!.call(this, value);
    });
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}`, mediaBlobs: cache });
    // The slide on screen waits for its picture, which the cache fetches first.
    expect(host.querySelector('img')!.getAttribute('src')).toBeNull();
    expect(assigned.filter((url) => !url.startsWith('blob:'))).toEqual([]);
    expect(requests.map((r) => r.url)).toEqual(['/x/assets/zero.jpg', '/x/assets/two.jpg', '/x/assets/three.jpg']);
    for (const request of requests) request.respond();
    await flush();
    expect(host.querySelector('img')!.getAttribute('src')).toBe(cache.objectUrl('/x/assets/zero.jpg'));
    expect(requests.at(-1)!.url).toBe('/x/assets/clip.05a38d7a.mp4');
    requests.at(-1)!.respond();
    await flush();

    const asked = requests.length;
    player.goToSlide(2);
    expect([...host.querySelectorAll('img')].map((image) => image.getAttribute('src')))
      .toEqual([cache.objectUrl('/x/assets/two.jpg'), cache.objectUrl('/x/assets/three.jpg')]);
    player.goToSlide(0);
    player.goToSlide(1);
    player.goToSlide(2);
    await flush();
    expect(requests).toHaveLength(asked);
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
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}`, mediaBlobs: cache });
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
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}`, mediaBlobs: cache });

    const warming = () => created.filter((video) => !video.isConnected && video.hasAttribute('src'));
    expect(warming()).toHaveLength(0);
    requests[0].respond();
    await flush();
    expect(warming().map((video) => video.getAttribute('src'))).toEqual(['blob:test/0']);
  });

  // The CI browser job, Oct 2026 (mediaTransferBudgetBrowser): the presenter
  // reached the next slide while its clip was still on its way into memory,
  // and the slide's <video> opened the same URL from the network beside the
  // download. Chromium's HTTP cache serves a range request only after the
  // writer before it has finished, and gives up on waiting after 25 ms: the
  // element's `bytes=0-` went straight to the server and the whole clip
  // crossed the wire a second time.
  it('shows a clip that is on its way into memory from memory, never from a second download', async () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile);
    const deck = deckWith([
      [],
      [videoElement('v', 'assets/clip.05a38d7a.mp4', { autoplay: true })],
    ]);
    const plays: Array<string | null> = [];
    HTMLMediaElement.prototype.play = function () {
      plays.push(this.getAttribute('src'));
      return Promise.resolve();
    };
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}`, mediaBlobs: cache });
    expect(requests.map((r) => r.url)).toEqual(['/x/assets/clip.05a38d7a.mp4']);

    // The talk arrives before the download has finished.
    player.goToSlide(1, { play: true });
    const video = host.querySelector('video')!;
    expect(video.getAttribute('src')).toBeNull();

    requests[0].respond();
    await flush();
    expect(host.querySelector('video')).toBe(video);
    expect(video.getAttribute('src')).toBe('blob:test/0');
    expect(video.dataset.mediaKey).toContain('blob:test/0');
    // It was asked to play on arrival, and still is once it has a source.
    expect(plays.at(-1)).toBe('blob:test/0');
    expect(requests).toHaveLength(1);
  });

  it('streams a clip whose download into memory fails, once that download has ended', async () => {
    const { requests, fetchFile } = controlledFetch();
    const { cache } = cacheWith(fetchFile);
    const deck = deckWith([[], [videoElement('v', 'assets/clip.05a38d7a.mp4')]]);
    player = new Player({ deck, container: host, resolveSrc: (src) => `/x/${src}`, mediaBlobs: cache });
    player.goToSlide(1);
    const video = host.querySelector('video')!;
    expect(video.getAttribute('src')).toBeNull();

    requests[0].fail();
    await flush();
    expect(video.getAttribute('src')).toBe('/x/assets/clip.05a38d7a.mp4');
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
