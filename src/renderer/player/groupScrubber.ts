import type { SlideElement } from '@shared/deck.js';
import { formatClock, scrubFraction, scrubTime, trimWindow, unionBox } from '@shared/compare.js';
import { isolatePointer, suppressNextClick } from './pointerIsolation.js';
import { VIDEO_RATES, formatVideoRate } from './videoRate.js';

type VideoElement = Extract<SlideElement, { type: 'video' }>;

/**
 * How long the bar stays up after the pointer stops moving. It matches the
 * presentation cursor, which hides after 1 s of stillness, so the two leave
 * together.
 */
export const SCRUBBER_IDLE_MS = 1000;
/** The bar's height and its inset from the group's edges, in slide pixels. */
const BAR_HEIGHT = 48;
const BAR_INSET = 16;

export interface GroupTransport {
  /** The group's members, lowest in z first, as `syncGroupsOf` returns them. */
  members: VideoElement[];
  /**
   * The member that keeps the group's time and its `<video>`: the one the
   * rest follow, whose trim window is the group's length (videoSync.ts
   * `groupClock`). Asked afresh each time, since it is only settled once
   * every member's length is known.
   */
  clock(): { element: VideoElement; video: HTMLVideoElement } | null;
  /** Start or stop the whole group, as the presenter's own intent. */
  setPlaying(playing: boolean): void;
  /** The slide's playback speed and a way to set it (videoRate.ts). Without them the bar has no speed control. */
  getRate?(): number;
  setRate?(rate: number): void;
}

const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M7 5.5h3.4v13H7zM13.6 5.5H17v13h-3.4z" fill="currentColor"/></svg>';

/**
 * One transport for a sync group while presenting: play/pause for all of it
 * and a scrubber over the group's length -- the trim window of the clip that
 * keeps its time -- in a slim bar along the bottom of the group's combined
 * box.
 *
 * Only the clock clip is driven. The followers already track it every frame
 * (Player.syncVideoGroups), so seeking it moves the whole group and nothing
 * here can fight that loop.
 *
 * The bar is part of the presenter's hand, not of the slide: it appears only
 * while the pointer is over the group (and fades with the idle cursor, so
 * it does not sit on the audience's view while the presenter talks), passes
 * pointer events through while hidden, never shows in a capture -- a pinned
 * frame (`holdFrame`) or a print -- and keeps its clicks and drags from
 * advancing the deck. Returns the teardown.
 */
export function mountGroupScrubber(root: HTMLElement, group: GroupTransport): () => void {
  const { members } = group;
  const bounds = unionBox(members)!;

  const bar = document.createElement('div');
  bar.className = 'sync-scrubber';
  bar.dataset.syncGroup = members[0].syncGroup ?? '';
  bar.setAttribute('aria-hidden', 'true');
  Object.assign(bar.style, {
    left: `${bounds.x + BAR_INSET}px`,
    top: `${bounds.y + bounds.h - BAR_INSET - BAR_HEIGHT}px`,
    width: `${Math.max(0, bounds.w - 2 * BAR_INSET)}px`,
    height: `${BAR_HEIGHT}px`,
  });

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'sync-scrubber-play';
  // Never focusable: a focused button turns the presenter's next Space into
  // another press of it instead of the next build.
  play.tabIndex = -1;
  const track = document.createElement('div');
  track.className = 'sync-scrubber-track';
  const fill = document.createElement('div');
  fill.className = 'sync-scrubber-fill';
  const thumb = document.createElement('div');
  thumb.className = 'sync-scrubber-thumb';
  track.append(fill, thumb);
  const clock = document.createElement('span');
  clock.className = 'sync-scrubber-time';
  bar.append(play, track, clock);

  // A stepped speed slider: the same rail and thumb as the scrubber, one stop
  // per rate on the presenter's ladder, with the rate it is at beside it.
  let speed: HTMLDivElement | null = null;
  let speedThumb: HTMLDivElement | null = null;
  let speedLabel: HTMLSpanElement | null = null;
  if (group.getRate && group.setRate) {
    speed = document.createElement('div');
    speed.className = 'sync-scrubber-track sync-scrubber-speed';
    speed.title = 'Playback speed';
    const speedFill = document.createElement('div');
    speedFill.className = 'sync-scrubber-fill';
    speedThumb = document.createElement('div');
    speedThumb.className = 'sync-scrubber-thumb';
    speed.append(speedFill, speedThumb);
    speedLabel = document.createElement('span');
    speedLabel.className = 'sync-scrubber-time sync-scrubber-rate';
    bar.append(speed, speedLabel);
  }
  const rateIndex = (rate: number): number => {
    let best = 0;
    VIDEO_RATES.forEach((r, i) => { if (Math.abs(r - rate) < Math.abs(VIDEO_RATES[best] - rate)) best = i; });
    return best;
  };
  root.appendChild(bar);

  const playable = (): { video: HTMLVideoElement; start: number; end: number } | null => {
    const keeper = group.clock();
    const span = keeper && trimWindow(keeper.element, keeper.video.duration);
    return keeper && span ? { video: keeper.video, ...span } : null;
  };
  const clockPaused = (): boolean => group.clock()?.video.paused ?? true;

  let shownPlaying: boolean | null = null;
  const paint = (): void => {
    const playing = !clockPaused();
    if (playing !== shownPlaying) {
      shownPlaying = playing;
      play.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
      play.title = playing ? 'Pause the group' : 'Play the group';
    }
    const span = playable();
    const at = span ? scrubFraction(span.video.currentTime, span) : 0;
    const percent = `${(at * 100).toFixed(2)}%`;
    fill.style.width = percent;
    thumb.style.left = percent;
    clock.textContent = span
      ? `${formatClock(span.video.currentTime - span.start)} / ${formatClock(span.end - span.start)}`
      : '';
    if (speed && speedThumb && speedLabel && group.getRate) {
      const rate = group.getRate();
      const stop = `${((rateIndex(rate) / (VIDEO_RATES.length - 1)) * 100).toFixed(2)}%`;
      (speed.firstElementChild as HTMLElement).style.width = stop;
      speedThumb.style.left = stop;
      speedLabel.textContent = formatVideoRate(rate);
    }
  };

  // --- showing and hiding -------------------------------------------------
  let visible = false;
  let dragging: number | null = null;
  let overBar = false;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let frame = 0;
  const loop = (): void => {
    paint();
    frame = requestAnimationFrame(loop);
  };
  const setVisible = (on: boolean): void => {
    // A capture pins every video to one frame and owns it; the bar is never
    // part of what it photographs.
    const video = group.clock()?.video;
    if (on && video?.dataset.holdFrame === 'true') on = false;
    // Nor is there a bar over a video a later build has yet to reveal.
    if (on && video?.closest<HTMLElement>('[data-element-id]')?.style.visibility === 'hidden') on = false;
    if (on === visible) return;
    visible = on;
    bar.classList.toggle('visible', on);
    if (on) {
      paint();
      frame = requestAnimationFrame(loop);
    } else {
      cancelAnimationFrame(frame);
    }
  };
  const hideLater = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      if (dragging === null && !overBar) setVisible(false);
    }, SCRUBBER_IDLE_MS);
  };
  const inside = (event: PointerEvent): boolean => {
    const rect = root.getBoundingClientRect();
    const scale = root.offsetWidth > 0 ? rect.width / root.offsetWidth : 1;
    const x = (event.clientX - rect.left) / (scale || 1);
    const y = (event.clientY - rect.top) / (scale || 1);
    return x >= bounds.x && x <= bounds.x + bounds.w && y >= bounds.y && y <= bounds.y + bounds.h;
  };
  const onRootMove = (event: PointerEvent): void => {
    overBar = bar.contains(event.target as Node);
    if (dragging !== null) return;
    if (overBar || inside(event)) {
      setVisible(true);
      hideLater();
    } else {
      setVisible(false);
    }
  };
  const onRootLeave = (): void => {
    overBar = false;
    if (dragging === null) setVisible(false);
  };
  root.addEventListener('pointermove', onRootMove);
  root.addEventListener('pointerleave', onRootLeave);

  // --- play / pause -------------------------------------------------------
  const onPlay = (): void => {
    group.setPlaying(clockPaused());
    paint();
    hideLater();
  };
  play.addEventListener('click', onPlay);

  // --- scrubbing ----------------------------------------------------------
  // A scrub pauses the group under the finger and resumes it on release, as
  // every video player does: seeking a playing clip makes the picture lurch
  // between where it was decoding and where it was sent.
  let resume = false;
  let pendingFraction: number | null = null;
  let seekFrame = 0;
  const fractionAt = (event: PointerEvent): number => {
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
  };
  const seek = (fraction: number): void => {
    // One seek per frame, however fast the pointer reports.
    pendingFraction = fraction;
    if (seekFrame) return;
    seekFrame = requestAnimationFrame(() => {
      seekFrame = 0;
      const span = playable();
      if (span && pendingFraction !== null) span.video.currentTime = scrubTime(pendingFraction, span);
      pendingFraction = null;
      paint();
    });
  };
  const onTrackDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = event.pointerId;
    track.setPointerCapture?.(event.pointerId);
    bar.classList.add('scrubbing');
    resume = !clockPaused();
    if (resume) group.setPlaying(false);
    seek(fractionAt(event));
  };
  const onTrackMove = (event: PointerEvent): void => {
    if (dragging === event.pointerId) seek(fractionAt(event));
  };
  const onTrackUp = (event: PointerEvent): void => {
    if (dragging !== event.pointerId) return;
    dragging = null;
    bar.classList.remove('scrubbing');
    if (track.hasPointerCapture?.(event.pointerId)) track.releasePointerCapture(event.pointerId);
    suppressNextClick();
    if (resume) group.setPlaying(true);
    resume = false;
    hideLater();
  };
  // --- speed ----------------------------------------------------------------
  let speedDrag: number | null = null;
  const rateAt = (event: PointerEvent): number => {
    const rect = speed!.getBoundingClientRect();
    const fraction = rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
    return VIDEO_RATES[Math.round(fraction * (VIDEO_RATES.length - 1))];
  };
  const onSpeedDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    speedDrag = event.pointerId;
    speed!.setPointerCapture?.(event.pointerId);
    group.setRate!(rateAt(event));
    paint();
  };
  const onSpeedMove = (event: PointerEvent): void => {
    if (speedDrag !== event.pointerId) return;
    const rate = rateAt(event);
    if (rate !== group.getRate!()) group.setRate!(rate);
    paint();
  };
  const onSpeedUp = (event: PointerEvent): void => {
    if (speedDrag !== event.pointerId) return;
    speedDrag = null;
    if (speed!.hasPointerCapture?.(event.pointerId)) speed!.releasePointerCapture(event.pointerId);
    suppressNextClick();
    hideLater();
  };
  if (speed) {
    speed.addEventListener('pointerdown', onSpeedDown);
    speed.addEventListener('pointermove', onSpeedMove);
    speed.addEventListener('pointerup', onSpeedUp);
    speed.addEventListener('pointercancel', onSpeedUp);
  }

  track.addEventListener('pointerdown', onTrackDown);
  track.addEventListener('pointermove', onTrackMove);
  track.addEventListener('pointerup', onTrackUp);
  track.addEventListener('pointercancel', onTrackUp);
  const release = isolatePointer(bar);

  return () => {
    if (idle) clearTimeout(idle);
    cancelAnimationFrame(frame);
    cancelAnimationFrame(seekFrame);
    root.removeEventListener('pointermove', onRootMove);
    root.removeEventListener('pointerleave', onRootLeave);
    release();
    bar.remove();
  };
}
