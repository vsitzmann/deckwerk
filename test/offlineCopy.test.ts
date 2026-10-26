import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { OfflineCopy, type OfflineCopyOptions } from '../src/renderer/collab/offlineCopy.js';
import {
  answerFromKept,
  DECKS_CACHE,
  INDEX_KEY,
  isImmutableMedia,
  isMediaPath,
  MEDIA_CACHE,
  parseRange,
  snapshotKey,
  STAGING_CACHE,
  STAGING_HEADER,
} from '../src/renderer/collab/offlineShared.js';
import { talkMediaOrder } from '../src/renderer/player/talkMediaOrder.js';

/** Cache Storage as the browser keeps it: responses by URL, read back as new responses. */
class FakeCache {
  readonly entries = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();

  private key(request: RequestInfo | URL): string {
    const url = typeof request === 'string' ? request : request instanceof URL ? request.href : request.url;
    const parsed = new URL(url, 'http://deck.test');
    return `${parsed.pathname}${parsed.search}`;
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const entry = this.entries.get(this.key(request));
    return entry ? new Response(entry.body.slice(0), entry.init) : undefined;
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const body = await response.arrayBuffer();
    this.entries.set(this.key(request), { body, init: { status: response.status, headers: [...response.headers] } });
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(this.key(request));
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((key) => new Request(`http://deck.test${key}`));
  }
}

class FakeCaches {
  readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }

  cache(name: string): FakeCache {
    return this.caches.get(name) ?? new FakeCache();
  }
}

function el(id: string, type: 'image' | 'video', src: string): SlideElement {
  return {
    id, type, x: 0, y: 0, w: 100, h: 100, rot: 0, z: 1, opacity: 1, class: [], style: {}, src, fit: 'contain',
    sourceBox: null,
    ...(type === 'video'
      ? { start: 0, end: null, autoplay: true, loop: true, muted: true, controls: false, poster: null }
      : { alt: '' }),
  } as SlideElement;
}

/** Five slides: pictures and clips spread out, the fourth skipped. */
function talk(): Deck {
  const deck = emptyDeck('Talk');
  const base = deck.slides[0];
  const slide = (n: number, elements: SlideElement[], skipped = false) => ({ ...base, id: `s${n}`, elements, skipped });
  deck.slides = [
    slide(1, [el('a', 'image', 'assets/a.jpg')]),
    slide(2, [el('c1', 'video', 'assets/clip1.mp4')]),
    slide(3, [el('b', 'image', 'assets/b.jpg'), el('c2', 'video', 'assets/clip2.mp4')]),
    slide(4, [el('d', 'image', 'assets/hidden.jpg')], true),
    slide(5, [el('e', 'image', 'assets/e.jpg')]),
  ];
  return deck;
}

const SIZE = 4096;
const urlOf = (src: string) => `/media/o${src.replace(/\W/g, '').padEnd(24, '0').slice(0, 24)}.bin`;

interface Harness {
  copy: OfflineCopy;
  storage: FakeCaches;
  fetches: Array<{ url: string; range: string | null }>;
  posted: unknown[];
  options: OfflineCopyOptions;
}

function harness(overrides: Partial<OfflineCopyOptions> = {}, deck = talk()): Harness {
  const storage = new FakeCaches();
  const fetches: Harness['fetches'] = [];
  const posted: unknown[] = [];
  // The worker's half of a download (sw.ts): reading it back from staging.
  const readBack = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
    if (!new Headers(init?.headers).has(STAGING_HEADER)) return null;
    return (await storage.cache(STAGING_CACHE).match(String(input))) ?? new Response(null, { status: 404 });
  };
  const options: OfflineCopyOptions = {
    deckId: 'talk',
    deck: () => deck,
    slideIndex: () => 0,
    themeCss: () => '.slide { color: red; }',
    mediaVariants: () => ({ 'assets/a.jpg': 'oa' }),
    pendingMedia: () => [],
    resolveSrc: urlOf,
    isPending: () => false,
    busy: () => false,
    rangeReuse: false,
    onChange: () => undefined,
    caches: storage as unknown as CacheStorage,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const staged = await readBack(input, init);
      if (staged) return staged;
      const url = String(input);
      const range = new Headers(init?.headers).get('range');
      fetches.push({ url, range });
      const body = new Uint8Array(SIZE).fill(7);
      if (range === 'bytes=0-') {
        return new Response(body, { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes 0-${SIZE - 1}/${SIZE}`, 'content-length': String(SIZE) } });
      }
      return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(SIZE), etag: '"x"' } });
    }) as typeof fetch,
    storage: { estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 }), persist: async () => true },
    locks: null,
    worker: () => ({ postMessage: (message) => posted.push(message) }),
    controlled: () => true,
    ...overrides,
  };
  // A test's own fetch still has the worker answering read-backs.
  if (overrides.fetch) {
    const own = overrides.fetch;
    options.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (await readBack(input, init)) ?? own(input, init)) as typeof fetch;
  }
  const copy = new OfflineCopy(options);
  copy.setShellReady(true);
  return { copy, storage, fetches, posted, options };
}

describe('the offline copy', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("downloads in the presentation's order, then what the talk shows only in passing", async () => {
    const { copy, fetches } = harness();
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const presented = talkMediaOrder(talk().slides, 0, urlOf).urls;
    expect(fetches.map((f) => f.url)).toEqual([...presented, urlOf('assets/hidden.jpg')]);
    expect(copy.status()).toMatchObject({ state: 'ready', remaining: 0, total: 6 });
    expect(copy.statusText()).toBe('Available offline');
  });

  it('counts outward from the slide the editor is on', async () => {
    const { copy, fetches } = harness({ slideIndex: () => 4 });
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetches[0].url).toBe(urlOf('assets/e.jpg'));
  });

  it('says how many files are left while it downloads', async () => {
    let busy = true;
    const { copy, fetches } = harness({ busy: () => busy });
    copy.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetches).toEqual([]);
    expect(copy.statusText()).toBe('Downloading for offline: 6 files left');
    busy = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(copy.statusText()).toBe('Available offline');
  });

  it('starts nothing until the editor has been quiet for a second', async () => {
    let busy = true;
    const { copy, fetches } = harness({ busy: () => busy });
    copy.start();
    await vi.advanceTimersByTimeAsync(400);
    busy = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(fetches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetches.length).toBeGreaterThan(0);
  });

  it('is not ready before the service worker is, and says nothing where there can be none', async () => {
    const { copy, options } = harness();
    const pending = new OfflineCopy(options);
    pending.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pending.ready()).toBe(false);
    expect(pending.statusText()).toBe('Preparing for offline…');
    pending.setShellReady(true);
    expect(pending.ready()).toBe(true);
    copy.setShellReady(false);
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(copy.status().state).toBe('unavailable');
    expect(copy.statusText()).toBe('');
  });

  it('keeps every file whole, and tells the service worker', async () => {
    const { copy, storage, posted } = harness({ rangeReuse: true });
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const kept = await storage.cache(MEDIA_CACHE).match(urlOf('assets/clip1.mp4'));
    expect(kept?.status).toBe(200);
    expect(kept?.headers.get('content-length')).toBe(String(SIZE));
    expect((await kept!.arrayBuffer()).byteLength).toBe(SIZE);
    expect(posted).toContainEqual({ type: 'offline-media', added: [urlOf('assets/clip1.mp4')] });
  });

  it("asks for clips from byte 0 where the HTTP cache assembles them from the media stack's parts", async () => {
    const { copy, fetches } = harness({ rangeReuse: true });
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetches.filter((f) => f.range === 'bytes=0-').map((f) => f.url).sort())
      .toEqual([urlOf('assets/clip1.mp4'), urlOf('assets/clip2.mp4')].sort());
    expect(fetches.find((f) => f.url === urlOf('assets/a.jpg'))?.range).toBeNull();
  });

  it("reads a clip the editor already holds in memory from there", async () => {
    const { copy, fetches } = harness({ borrow: (url) => (url === urlOf('assets/clip1.mp4') ? 'blob:held' : undefined) });
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetches.map((f) => f.url)).toContain('blob:held');
    expect(fetches.map((f) => f.url)).not.toContain(urlOf('assets/clip1.mp4'));
  });

  it('downloads no clip still waiting for its streaming version, and counts it as left', async () => {
    const { copy, fetches } = harness({ isPending: (src) => src === 'assets/clip2.mp4' });
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetches.map((f) => f.url)).not.toContain(urlOf('assets/clip2.mp4'));
    expect(copy.statusText()).toBe('Downloading for offline: 1 file left');
    expect(copy.ready()).toBe(false);
  });

  it('leaves to the network what there is no room for, and says so', async () => {
    const { copy } = harness({ storage: { estimate: async () => ({ usage: 0, quota: SIZE * 4 }) } });
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    // 80% of the quota: three files fit in the estimate's eyes, every one of them asked alone.
    expect(copy.status()).toMatchObject({ state: 'ready' });
    const tight = harness({ storage: { estimate: async () => ({ usage: SIZE * 3, quota: SIZE * 4 }) } });
    tight.copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tight.copy.status()).toMatchObject({ state: 'incomplete', noRoom: 6 });
    expect(tight.copy.statusText()).toBe('Not enough storage to keep 6 files offline');
  });

  it('gives up on a file that keeps failing, and says so', async () => {
    const failing = urlOf('assets/b.jpg');
    const base = harness().options.fetch!;
    const { copy } = harness({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => (String(input) === failing
        ? new Response('nope', { status: 500 })
        : base(input, init))) as typeof fetch,
    });
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(copy.status()).toMatchObject({ state: 'incomplete', failed: 1 });
    expect(copy.statusText()).toBe('Offline copy incomplete: 1 file could not be downloaded');
  });

  it('lets a clip held back for the editor go at once for whoever waits for it', async () => {
    let busy = false;
    const clip = urlOf('assets/clip1.mp4');
    const CHUNKS = 8;
    const pulled = new Map<string, number>();
    const { copy } = harness({
      busy: () => busy,
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            const sent = pulled.get(url) ?? 0;
            if (sent === CHUNKS) return controller.close();
            pulled.set(url, sent + 1);
            // The network takes its time over each chunk.
            await new Promise((resolve) => setTimeout(resolve, 100));
            controller.enqueue(new Uint8Array(SIZE / CHUNKS));
          },
        }, { highWaterMark: 0 });
        return new Response(body, { status: 200, headers: { 'content-length': String(SIZE) } });
      }) as typeof fetch,
    });
    copy.start();
    // Pictures first; then the clip starts, and the editor gets busy mid-clip.
    while ((pulled.get(clip) ?? 0) < 2) await vi.advanceTimersByTimeAsync(10);
    busy = true;
    const atBusy = pulled.get(clip)!;
    await vi.advanceTimersByTimeAsync(5_000);
    // What was already asked of the network arrives; nothing more is read.
    expect(pulled.get(clip)).toBeLessThanOrEqual(atBusy + 2);
    const settled = copy.settled(clip);
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
    expect(pulled.get(clip)).toBe(CHUNKS);
  });

  it('waits for the server, rather than giving files up, while the connection is gone', async () => {
    let online = false;
    const base = harness().options.fetch!;
    const { copy } = harness({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!online) throw new TypeError('Failed to fetch');
        return base(input, init);
      }) as typeof fetch,
    });
    copy.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(copy.status()).toMatchObject({ state: 'downloading', failed: 0 });
    expect(copy.statusText()).toBe('Offline copy waits for the server: 6 files left');
    online = true;
    copy.resume();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(copy.statusText()).toBe('Available offline');
  });

  it('tries again by itself once the server is back', async () => {
    let online = false;
    const base = harness().options.fetch!;
    const { copy } = harness({
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!online) throw new TypeError('Failed to fetch');
        return base(input, init);
      }) as typeof fetch,
    });
    copy.start();
    await vi.advanceTimersByTimeAsync(5_000);
    online = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(copy.ready()).toBe(true);
  });

  it('writes the snapshot as the deck opens, however steadily it is edited after', async () => {
    const { copy, storage } = harness();
    copy.start();
    for (let i = 0; i < 10; i++) {
      copy.deckChanged();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(await OfflineCopy.loadSnapshot('talk', storage as unknown as CacheStorage)).not.toBeNull();
  });

  it('counts an edit at once, before its coalescing timer fires', async () => {
    const deck = talk();
    const { copy } = harness({}, deck);
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(copy.ready()).toBe(true);
    deck.slides[0].elements.push(el('new', 'image', 'assets/new.jpg'));
    copy.deckChanged();
    expect(copy.ready()).toBe(false);
  });

  it('keeps the deck to open without the server', async () => {
    const { copy, storage } = harness();
    copy.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const snapshot = await OfflineCopy.loadSnapshot('talk', storage as unknown as CacheStorage);
    expect(snapshot).toMatchObject({ deckId: 'talk', themeCss: '.slide { color: red; }', mediaVariants: { 'assets/a.jpg': 'oa' } });
    expect(snapshot?.deck.slides).toHaveLength(5);
    expect(await OfflineCopy.loadSnapshot('other', storage as unknown as CacheStorage)).toBeNull();
  });

  it("forgets a deck this person may no longer open, keeping another deck's copy of the same file", async () => {
    const { copy, storage } = harness();
    const shared = urlOf('assets/a.jpg');
    const decks = await storage.open(DECKS_CACHE);
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const index = await (await decks.match(INDEX_KEY))!.json();
    index.decks.other = { openedAt: Date.now(), files: [shared] };
    await decks.put(INDEX_KEY, new Response(JSON.stringify(index)));
    await copy.forget();
    const left = [...storage.cache(MEDIA_CACHE).entries.keys()];
    expect(left).toEqual([shared]);
    expect(await decks.match(snapshotKey('talk'))).toBeUndefined();
  });

  it('drops the files of decks opened longest ago', async () => {
    const storage = new FakeCaches();
    const decks = await storage.open(DECKS_CACHE);
    const media = await storage.open(MEDIA_CACHE);
    const old: Record<string, { openedAt: number; files: string[] }> = {};
    for (let i = 0; i < 8; i++) {
      old[`old-${i}`] = { openedAt: Date.now() - (i + 1) * 1000, files: [`/media/o${String(i).padStart(24, '0')}.jpg`] };
      await media.put(`/media/o${String(i).padStart(24, '0')}.jpg`, new Response('x'));
      await decks.put(snapshotKey(`old-${i}`), new Response('{}'));
    }
    await decks.put(INDEX_KEY, new Response(JSON.stringify({ decks: old })));
    const { copy } = harness({ caches: storage as unknown as CacheStorage });
    copy.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(media.entries.has('/media/o000000000000000000000007.jpg')).toBe(false);
    expect(await decks.match(snapshotKey('old-7'))).toBeUndefined();
    expect(media.entries.has('/media/o000000000000000000000006.jpg')).toBe(true);
  });
});

describe('answering from a kept file', () => {
  it('reads ranges the way the server does', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBeNull();
    expect(parseRange('bytes=5-1', 100)).toBeNull();
    expect(parseRange('bytes=0-1,4-5', 100)).toBeNull();
  });

  it('answers a range with exactly those bytes', async () => {
    const bytes = new Uint8Array(100).map((_, i) => i);
    const kept = () => new Response(bytes, { headers: { 'content-type': 'video/mp4', etag: '"e"' } });
    const partial = await answerFromKept(new Request('http://deck.test/media/x', { headers: { range: 'bytes=10-19' } }), kept());
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(partial.headers.get('content-type')).toBe('video/mp4');
    expect([...new Uint8Array(await partial.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    const whole = await answerFromKept(new Request('http://deck.test/media/x'), kept());
    expect(whole.status).toBe(200);
    const beyond = await answerFromKept(new Request('http://deck.test/media/x', { headers: { range: 'bytes=200-' } }), kept());
    expect(beyond.status).toBe(416);
  });

  it('knows which paths are the decks\' files, and which name their bytes for good', () => {
    expect(isMediaPath('/media/o0123456789abcdef01234567.jpg')).toBe(true);
    expect(isMediaPath('/decks/talk/assets/a.png')).toBe(true);
    expect(isMediaPath('/api/video-still')).toBe(true);
    expect(isMediaPath('/app/index-abc.js')).toBe(false);
    expect(isImmutableMedia('/media/o0123456789abcdef01234567.jpg')).toBe(true);
    expect(isImmutableMedia('/decks/talk/assets/a.png')).toBe(false);
  });
});
