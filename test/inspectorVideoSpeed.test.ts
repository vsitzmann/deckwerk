// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck, videoSpeed, type SlideElement } from '../src/shared/deck.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { applyVideoPlaybackState } from '../src/renderer/player/render.js';

type VideoEl = Extract<SlideElement, { type: 'video' }>;

function clip(id: string, over: Partial<VideoEl> = {}): VideoEl {
  return {
    id, type: 'video', x: 400, y: 200, w: 640, h: 360, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: `assets/${id}.mp4`, fit: 'contain', sourceBox: null,
    autoplay: true, loop: true, muted: true, controls: false, start: 0, end: null, poster: null,
    ...over,
  };
}

function setup(elements: VideoEl[]): { store: EditorStore; host: HTMLElement } {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
  if (!globalThis.CSS) {
    (globalThis as unknown as { CSS: unknown }).CSS = {
      escape: (v: string) => v.replace(/["\\]/g, '\\$&'),
    };
  }
  (globalThis as unknown as { window: Window }).window.api = {
    assetUrl: (src: string) => `deck://${src}`,
    pathForFile: () => '',
    importAssets: async () => [],
    probeAsset: async () => ({ duration: 20 }),
  } as never;
  const deck = emptyDeck('Video speed');
  deck.slides[0].elements = elements;
  const store = new EditorStore(deck, '/tmp/video-speed');
  const host = document.createElement('aside');
  document.body.replaceChildren(host);
  new Inspector(host, store);
  return { store, host };
}

function speedInput(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('.video-playback-options .video-speed-field input');
  expect(input, 'the Speed field is missing').toBeTruthy();
  return input!;
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const speeds = (store: EditorStore) =>
  Object.fromEntries((store.slide?.elements ?? []).map((element) => [
    element.id, element.type === 'video' ? element.playbackRate : null,
  ]));

describe('a video\'s playback speed', () => {
  it('is set in the Playback section, cleared back to normal, and kept in range', () => {
    const { store, host } = setup([clip('a'), clip('b')]);
    store.select(['a']);
    expect(speedInput(host).value).toBe('1');
    type(speedInput(host), '2');
    expect(speeds(store)).toEqual({ a: 2, b: undefined });
    expect(store.history()[0].label).toBe('Change video speed');
    expect(speedInput(host).value).toBe('2');

    // Normal speed, typed or cleared, stores nothing.
    type(speedInput(host), '');
    expect(speeds(store)).toEqual({ a: undefined, b: undefined });
    type(speedInput(host), '1');
    expect('playbackRate' in store.slide!.elements[0]).toBe(false);

    // Beyond what browsers play, it stops at the limit.
    type(speedInput(host), '100');
    expect(speeds(store).a).toBe(16);
    type(speedInput(host), '0');
    expect(speeds(store).a).toBe(0.0625);
  });

  it('shows a mixed value for several videos and sets them all', () => {
    const { store, host } = setup([clip('a', { playbackRate: 2 }), clip('b')]);
    store.select(['a', 'b']);
    expect(speedInput(host).value).toBe('');
    expect(speedInput(host).placeholder).toBe('Mixed');
    type(speedInput(host), '0.5');
    expect(speeds(store)).toEqual({ a: 0.5, b: 0.5 });
  });

  it('gives a synced clip\'s partners the same speed, since the group shares one clock', () => {
    const { store, host } = setup([
      clip('real', { syncGroup: 'g' }), clip('sim', { syncGroup: 'g' }), clip('other'),
    ]);
    store.select(['real']);
    type(speedInput(host), '1.5');
    expect(speeds(store)).toEqual({ real: 1.5, sim: 1.5, other: undefined });
  });

  it('plays on the canvas at the stored speed, including after a reload', () => {
    const video = document.createElement('video');
    applyVideoPlaybackState(video, clip('a', { playbackRate: 0.5 }), { resolveSrc: (src: string) => src } as never);
    expect(video.playbackRate).toBe(0.5);
    expect(video.defaultPlaybackRate).toBe(0.5);
    applyVideoPlaybackState(video, clip('a'), { resolveSrc: (src: string) => src } as never);
    expect(video.playbackRate).toBe(1);
    expect(videoSpeed({ playbackRate: Number.NaN })).toBe(1);
    expect(videoSpeed({ playbackRate: 64 })).toBe(16);
  });
});
