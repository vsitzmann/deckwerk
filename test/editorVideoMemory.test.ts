// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { SlideElement } from '../src/shared/deck.js';
import { renderElement, startVideoSource, videoNetworkSrc } from '../src/renderer/player/render.js';
import { VideoBlobCache } from '../src/renderer/player/videoBlobCache.js';
import {
  fillVideosFromMemory,
  mediaStackReusesBytes,
  setVideoMemory,
  type VideoMemory,
  type VideoMemoryMode,
} from '../src/renderer/player/videoMemory.js';
import { gatedLoadsPending, resetMediaLoadGateForTests } from '../src/renderer/player/mediaLoadGate.js';
import { isMediaPending, setPendingMedia } from '../src/renderer/collab/mediaVariants.js';

/**
 * Safari's media stack re-downloads a clip for every <video> that opens it:
 * on the media transfer budget suite (Oct 2026) each slide change, edit,
 * collaborator's edit and return from presenting fetched the slide's clips
 * again, and a clip waiting for its streaming version pulled its whole
 * original to show a paused frame. The collab editor there reads clips from
 * memory (videoMemory.ts, collab/editorVideoMemory.ts). These tests hold the
 * pieces; mediaTransferBudgetBrowser.test.ts holds the wire.
 */

const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ELECTRON = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) DeckWerk/0.3.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0';

function clip(src: string, extra: Record<string, unknown> = {}): Extract<SlideElement, { type: 'video' }> {
  return {
    id: 'v', type: 'video', x: 0, y: 0, w: 640, h: 360, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src, poster: null, start: 0, end: null,
    autoplay: false, loop: true, muted: true, controls: false, fit: 'contain', sourceBox: null,
    ...extra,
  } as unknown as Extract<SlideElement, { type: 'video' }>;
}

class FakeMemory implements VideoMemory {
  held = new Map<string, string>();
  modes = new Map<string, VideoMemoryMode>();
  requested: string[] = [];
  mode(url: string): VideoMemoryMode {
    return this.held.has(url) ? 'memory' : this.modes.get(url) ?? 'memory';
  }
  objectUrl(url: string): string | undefined {
    return this.held.get(url);
  }
  request(url: string): void {
    this.requested.push(url);
  }
  still(assetSrc: string, time: number): string {
    return `/still/${assetSrc}@${time}`;
  }
}

const resolveSrc = (src: string) => `/net/${src}`;
const render = (el: SlideElement) => {
  const node = renderElement(el, { resolveSrc, mediaPreload: 'metadata' });
  document.body.appendChild(node);
  return node.querySelector('video')!;
};

afterEach(() => {
  setVideoMemory(null);
  resetMediaLoadGateForTests();
  document.body.replaceChildren();
  setPendingMedia([]);
});

describe('which browsers read clips from memory', () => {
  it('is every WebKit media stack, and no Chromium one', () => {
    expect(mediaStackReusesBytes(SAFARI)).toBe(false);
    expect(mediaStackReusesBytes(IPHONE_CHROME)).toBe(false);
    expect(mediaStackReusesBytes(CHROME)).toBe(true);
    expect(mediaStackReusesBytes(ELECTRON)).toBe(true);
    expect(mediaStackReusesBytes(FIREFOX)).toBe(true);
  });
});

describe('an editing surface with clips in memory', () => {
  it('plays a clip already in memory from its blob, and never queues it on the network gate', () => {
    const memory = new FakeMemory();
    memory.held.set('/net/a.mp4', 'blob:a');
    setVideoMemory(memory);
    const video = render(clip('a.mp4'));
    expect(video.getAttribute('src')).toBe('blob:a');
    expect(videoNetworkSrc(video)).toBe('/net/a.mp4');
    expect(gatedLoadsPending()).toBe(false);
  });

  it('shows the still and reads nothing until the clip lands, then reads the blob', () => {
    const memory = new FakeMemory();
    setVideoMemory(memory);
    const video = render(clip('a.mp4', { start: 4 }));
    expect(video.hasAttribute('src')).toBe(false);
    expect(video.getAttribute('poster')).toBe('/still/a.mp4@4');
    expect(memory.requested).toEqual(['/net/a.mp4']);
    fillVideosFromMemory('/net/b.mp4', 'blob:b');
    expect(video.hasAttribute('src')).toBe(false);
    fillVideosFromMemory('/net/a.mp4', 'blob:a');
    expect(video.getAttribute('src')).toBe('blob:a');
    expect(video.dataset.memoryPending).toBeUndefined();
  });

  it('streams a clip the memory gave up on', () => {
    setVideoMemory(new FakeMemory());
    const video = render(clip('huge.mp4'));
    fillVideosFromMemory('/net/huge.mp4', null);
    expect(video.getAttribute('src')).toBe('/net/huge.mp4');
  });

  it('reads nothing of a clip waiting for its streaming version until somebody plays it', () => {
    const memory = new FakeMemory();
    memory.modes.set('/net/rec.mp4', 'still');
    setVideoMemory(memory);
    const video = render(clip('rec.mp4'));
    expect(video.hasAttribute('src')).toBe(false);
    expect(video.dataset.streamPending).toBe('true');
    expect(video.getAttribute('poster')).toBe('/still/rec.mp4@0');
    expect(memory.requested).toEqual([]);
    expect(startVideoSource(video)).toBe(true);
    expect(video.getAttribute('src')).toBe('/net/rec.mp4');
  });

  it('keys an element by its network URL, so pooling and patches agree with a fresh render', () => {
    const memory = new FakeMemory();
    memory.held.set('/net/a.mp4', 'blob:a');
    setVideoMemory(memory);
    const fromMemory = render(clip('a.mp4')).dataset.mediaKey;
    setVideoMemory(null);
    expect(render(clip('a.mp4')).dataset.mediaKey).toBe(fromMemory);
  });

  it('leaves preview surfaces, which have stills of their own, alone', () => {
    const memory = new FakeMemory();
    setVideoMemory(memory);
    const node = renderElement(clip('a.mp4'), { resolveSrc, mediaPreload: 'metadata', deferVideoSrc: true });
    expect(node.querySelector('video')!.dataset.networkSrc).toBeUndefined();
    expect(memory.requested).toEqual([]);
  });
});

describe('VideoBlobCache, for the editor', () => {
  function fetchOf(sizes: Record<string, number>) {
    const asked: string[] = [];
    const fetchFile = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      const bytes = sizes[String(input)] ?? 100;
      return new Response(new Uint8Array(Math.min(bytes, 1000)), { headers: { 'content-length': String(bytes) } });
    }) as typeof fetch;
    return { asked, fetchFile };
  }
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('gives up a file over its size limit for good, and says so', async () => {
    const { asked, fetchFile } = fetchOf({ big: 5_000 });
    let next = 0;
    const cache = new VideoBlobCache({ fetch: fetchFile, maxFileBytes: 1_000, createObjectUrl: () => `blob:${next++}` });
    const gaveUp: string[] = [];
    cache.onGiveUp((url) => gaveUp.push(url));
    cache.want(['big', 'small']);
    await flush();
    expect(gaveUp).toEqual(['big']);
    expect(cache.covers('big')).toBe(false);
    expect(cache.objectUrl('small')).toBe('blob:0');
    cache.want(['big', 'small']);
    await flush();
    expect(asked).toEqual(['big', 'small']);
  });

  it('hands out a lender’s blob instead of downloading the file', async () => {
    const { asked, fetchFile } = fetchOf({});
    const cache = new VideoBlobCache({ fetch: fetchFile, borrow: (url) => (url === 'lent' ? 'blob:lent' : undefined) });
    cache.want(['lent']);
    await flush();
    expect(asked).toEqual([]);
    expect(cache.objectUrl('lent')).toBe('blob:lent');
    expect(cache.covers('lent')).toBe(true);
  });
});

describe('clips waiting for a streaming version', () => {
  it('are replaced wholesale by each announcement, which names the srcs that changed', () => {
    expect(setPendingMedia(['a.mp4', 'b.mp4']).sort()).toEqual(['a.mp4', 'b.mp4']);
    expect(isMediaPending('a.mp4')).toBe(true);
    expect(setPendingMedia(['b.mp4'])).toEqual(['a.mp4']);
    expect(isMediaPending('a.mp4')).toBe(false);
    expect(setPendingMedia(undefined)).toEqual([]);
    expect(isMediaPending('b.mp4')).toBe(true);
  });
});
