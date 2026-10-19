// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import type { PresentationCommand } from '../src/shared/ipc.js';
import { Player } from '../src/renderer/player/player.js';
import { bindPresentKeys } from '../src/renderer/player/keys.js';
import { mountGroupScrubber } from '../src/renderer/player/groupScrubber.js';
import { bindSpeakerKeys } from '../src/renderer/presenter/speakerView.js';
import {
  VIDEO_RATES,
  formatVideoRate,
  nextVideoRate,
  videoRateChangeForKey,
} from '../src/renderer/player/videoRate.js';

/**
 * The presenter's speed control for a slide's videos: the ladder it steps
 * through, the keys that step it, the Player applying it to every video on the
 * slide together and dropping it on the next slide, and the hover bar's slider.
 */

type Video = Extract<SlideElement, { type: 'video' }>;

function video(id: string, over: Partial<Video> = {}): Video {
  return {
    id, type: 'video', x: 0, y: 0, w: 400, h: 300, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: `assets/${id}.mp4`, fit: 'cover', autoplay: true, loop: true,
    muted: true, controls: false, start: 0, end: null, poster: null, sourceBox: null,
    ...over,
  } as Video;
}

beforeEach(() => {
  document.body.replaceChildren();
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
  if (!CSS.escape) CSS.escape = (value) => value;
  // jsdom implements no media playback.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the speed ladder', () => {
  it('steps up and down one rung at a time and holds at either end', () => {
    expect(nextVideoRate(1, 'faster')).toBe(1.5);
    expect(nextVideoRate(1.5, 'faster')).toBe(2);
    expect(nextVideoRate(2, 'faster')).toBe(4);
    expect(nextVideoRate(8, 'faster')).toBe(8);
    expect(nextVideoRate(1, 'slower')).toBe(0.5);
    expect(nextVideoRate(0.25, 'slower')).toBe(0.25);
    expect(nextVideoRate(4, 'normal')).toBe(1);
  });

  it('moves a speed that is not on the ladder to its neighbour', () => {
    expect(nextVideoRate(3, 'faster')).toBe(4);
    expect(nextVideoRate(3, 'slower')).toBe(2);
  });

  it('reads > ] faster, < [ slower, = normal, and nothing else', () => {
    expect(['>', ']', '<', '[', '=', 'b', '.'].map(videoRateChangeForKey))
      .toEqual(['faster', 'faster', 'slower', 'slower', 'normal', null, null]);
  });

  it('labels a speed the way a player does', () => {
    expect(VIDEO_RATES.map(formatVideoRate)).toEqual(['0.25×', '0.5×', '1×', '1.5×', '2×', '4×', '8×']);
  });
});

describe('the Player', () => {
  function twoSlides(): { player: Player; host: HTMLElement } {
    const deck = emptyDeck('Speed');
    deck.slides[0].elements.push(video('views'), video('curve', { x: 500 }));
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'slide-b', elements: [video('other')] });
    const host = document.createElement('div');
    document.body.appendChild(host);
    return { player: new Player({ deck, container: host, resolveSrc: (src) => src }), host };
  }
  const rates = (host: HTMLElement) => [...host.querySelectorAll('video')].map((v) => v.playbackRate);

  it('speeds every video on the slide up together and shows the speed', () => {
    const { player, host } = twoSlides();
    expect(rates(host)).toEqual([1, 1]);

    expect(player.changeVideoRate('faster')).toBe(1.5);
    expect(player.changeVideoRate('faster')).toBe(2);
    expect(rates(host)).toEqual([2, 2]);

    const badge = host.querySelector<HTMLElement>('.player-rate-badge')!;
    expect(badge.textContent).toBe('2×');
    expect(badge.classList.contains('visible')).toBe(true);

    expect(player.changeVideoRate('normal')).toBe(1);
    expect(rates(host)).toEqual([1, 1]);
  });

  it('hides the badge again after a moment', () => {
    vi.useFakeTimers();
    const { player, host } = twoSlides();
    player.changeVideoRate('slower');
    const badge = host.querySelector<HTMLElement>('.player-rate-badge')!;
    expect(badge.classList.contains('visible')).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(badge.classList.contains('visible')).toBe(false);
  });

  it('returns to normal speed on the next slide, and stays there coming back', () => {
    const { player, host } = twoSlides();
    player.changeVideoRate('faster');
    player.changeVideoRate('faster');
    player.goToSlide(1);
    expect(player.getVideoRate()).toBe(1);
    expect(rates(host).every((rate) => rate === 1)).toBe(true);
    player.goToSlide(0);
    expect(player.getVideoRate()).toBe(1);
    expect(rates(host).every((rate) => rate === 1)).toBe(true);
  });

  it('keeps the speed through a build on the same slide', () => {
    const deck = emptyDeck('Builds');
    deck.slides[0].elements.push(video('views'), { ...video('late', { x: 500 }) });
    deck.slides[0].timeline = [
      { id: 'b1', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'appear', target: 'late', value: null } },
    ] as never;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });
    player.changeVideoRate('faster');
    player.next();
    expect(player.getCursor()).toEqual({ slide: 0, step: 1 });
    expect(player.getVideoRate()).toBe(1.5);
    expect(rates(host).every((rate) => rate === 1.5)).toBe(true);
  });
});

describe('the keys', () => {
  it('step the Player while presenting', () => {
    const changes: string[] = [];
    const player = { changeVideoRate: (change: string) => { changes.push(change); return 1; } } as unknown as Player;
    const unbind = bindPresentKeys(window, player);
    for (const key of ['>', ']', '<', '[', '=']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    }
    unbind();
    expect(changes).toEqual(['faster', 'faster', 'slower', 'slower', 'normal']);
  });

  it('go to a shell that relays them, when it asks', () => {
    const relayed: string[] = [];
    const player = { changeVideoRate: () => { throw new Error('should be relayed'); } } as unknown as Player;
    const unbind = bindPresentKeys(window, player, { onVideoRate: (change) => relayed.push(change) });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '>', cancelable: true }));
    unbind();
    expect(relayed).toEqual(['faster']);
  });

  it('reach the audience from Speaker View as a command', () => {
    const commands: PresentationCommand[] = [];
    const unbind = bindSpeakerKeys(window, (command) => commands.push(command));
    for (const key of ['>', '<', '=']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    }
    unbind();
    expect(commands).toEqual([
      { type: 'videoRate', change: 'faster' },
      { type: 'videoRate', change: 'slower' },
      { type: 'videoRate', change: 'normal' },
    ]);
  });

  it('leave a focused field alone', () => {
    const changes: string[] = [];
    const player = { changeVideoRate: (change: string) => { changes.push(change); return 1; } } as unknown as Player;
    const unbind = bindPresentKeys(window, player);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '>', bubbles: true, cancelable: true }));
    unbind();
    expect(changes).toEqual([]);
  });
});

describe('the hover bar’s speed slider', () => {
  function pointer(type: string, clientX: number): Event {
    const event = new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return event;
  }

  it('sets the speed from where it is pressed and dragged, and shows it', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const leaderVideo = document.createElement('video');
    let rate = 1;
    const off = mountGroupScrubber(root, {
      members: [video('a', { syncGroup: 'g' }), video('b', { x: 500, syncGroup: 'g' })],
      leaderVideo,
      setPlaying: () => {},
      getRate: () => rate,
      setRate: (next) => { rate = next; },
    });
    const speed = root.querySelector<HTMLElement>('.sync-scrubber-speed')!;
    expect(speed).not.toBeNull();
    // A 600 px rail: one ladder stop every 100 px.
    speed.getBoundingClientRect = () => ({ left: 0, width: 600, top: 0, height: 40, right: 600, bottom: 40, x: 0, y: 0, toJSON() {} });

    speed.dispatchEvent(pointer('pointerdown', 410));
    expect(rate).toBe(2);
    speed.dispatchEvent(pointer('pointermove', 590));
    expect(rate).toBe(8);
    speed.dispatchEvent(pointer('pointermove', -50));
    expect(rate).toBe(0.25);
    speed.dispatchEvent(pointer('pointerup', -50));
    speed.dispatchEvent(pointer('pointermove', 600));
    expect(rate).toBe(0.25);
    expect(root.querySelector('.sync-scrubber-rate')!.textContent).toBe('0.25×');
    off();
    expect(root.querySelector('.sync-scrubber')).toBeNull();
  });

  it('is left out for a transport that cannot change speed', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const off = mountGroupScrubber(root, {
      members: [video('a', { syncGroup: 'g' }), video('b', { x: 500, syncGroup: 'g' })],
      leaderVideo: document.createElement('video'),
      setPlaying: () => {},
    });
    expect(root.querySelector('.sync-scrubber-speed')).toBeNull();
    off();
  });
});
