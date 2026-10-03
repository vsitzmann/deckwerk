import '../appChrome.css';
import './trim.css';
import '../lightTheme.css';
import { applyUiTheme } from '../uiTheme.js';
import type { TrimRequest } from '@shared/ipc.js';
import { clamp } from '@shared/geometry.js';

applyUiTheme();

/**
 * Trim & crop: a thin UI over two ffmpeg operations and nothing else.
 *
 * It never modifies the source. Applying writes a new file into the deck's
 * assets/ and hands it back to the editor, which relinks the element. That
 * one-way flow is why this can be a separate window without any shared state.
 */

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const video = el<HTMLVideoElement>('video');
const scrub = el('scrub');
const cropOverlay = el('crop-overlay');
const cropRect = el('crop-rect');

interface State {
  src: string;
  elementId: string;
  duration: number;
  /** Trim points in seconds. */
  in: number;
  out: number;
  /** Crop in *source* pixels, or null for the full frame. */
  crop: { x: number; y: number; w: number; h: number } | null;
  natural: { w: number; h: number };
  busy: boolean;
}

const state: State = {
  src: '',
  elementId: '',
  duration: 0,
  in: 0,
  out: 0,
  crop: null,
  natural: { w: 0, h: 0 },
  busy: false,
};

/* --- endpoint frame previews --- */

/**
 * A second, offscreen video used purely to grab the frames at the in and out
 * points. Seeking the main preview instead would fight playback and move the
 * picture out from under the crop rectangle you are adjusting.
 */
const frameGrabber = document.createElement('video');
frameGrabber.muted = true;
frameGrabber.preload = 'auto';

const frameRequests = new Map<'in' | 'out', number>();
let grabbing = false;

/** Draw the frame at `time` into one of the endpoint canvases. */
function requestFrame(which: 'in' | 'out', time: number): void {
  frameRequests.set(which, time);
  void drainFrameQueue();
}

async function drainFrameQueue(): Promise<void> {
  // Serialised: a video element can only service one seek at a time, and
  // dragging a handle would otherwise queue hundreds.
  if (grabbing) return;
  grabbing = true;
  try {
    while (frameRequests.size > 0) {
      const [which, time] = [...frameRequests.entries()][0];
      frameRequests.delete(which);
      await drawFrame(which, time);
    }
  } finally {
    grabbing = false;
  }
}

/**
 * Resolve once the grabber has an actual decoded frame.
 *
 * Waiting only for metadata is not enough: at time zero no seek happens, so
 * there is no `seeked` event to wait on and the canvas would be painted from an
 * element that has dimensions but no picture — a black "In" thumbnail.
 */
function grabberReady(): Promise<boolean> {
  if (frameGrabber.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      frameGrabber.removeEventListener('loadeddata', onLoad);
      frameGrabber.removeEventListener('error', onError);
      clearTimeout(timer);
      resolve(ok);
    };
    const onLoad = () => done(true);
    const onError = () => done(false);
    frameGrabber.addEventListener('loadeddata', onLoad);
    frameGrabber.addEventListener('error', onError);
    const timer = setTimeout(() => done(false), 5000);
  });
}

async function drawFrame(which: 'in' | 'out', time: number): Promise<void> {
  if (!frameGrabber.src || !Number.isFinite(time)) return;
  // Seeking before metadata arrives silently does nothing and the `seeked`
  // event never fires, which would wedge the queue forever.
  if (!(await grabberReady())) return;

  return new Promise((resolve) => {
    const canvas = el<HTMLCanvasElement>(`frame-${which}`);
    const ctx = canvas.getContext('2d');
    if (!ctx) return resolve();

    // Never let a single stuck seek block every later frame request.
    const timer = setTimeout(() => finish(), 3000);
    const finish = () => {
      clearTimeout(timer);
      frameGrabber.removeEventListener('seeked', onSeeked);
      resolve();
    };

    const onSeeked = () => {
      clearTimeout(timer);
      const vw = frameGrabber.videoWidth;
      const vh = frameGrabber.videoHeight;
      if (vw && vh) {
        // Letterbox into the fixed thumbnail box, preserving aspect.
        const scale = Math.min(canvas.width / vw, canvas.height / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(
          frameGrabber,
          (canvas.width - dw) / 2,
          (canvas.height - dh) / 2,
          dw,
          dh,
        );
      }
      finish();
    };

    frameGrabber.addEventListener('seeked', onSeeked);

    const target = Math.max(
      0,
      // Seeking exactly to the duration yields no frame, so stop just inside.
      Math.min(time, Math.max(0, (frameGrabber.duration || state.duration) - 0.05)),
    );
    // An identical currentTime fires no `seeked` event at all.
    if (Math.abs(frameGrabber.currentTime - target) < 0.001) onSeeked();
    else frameGrabber.currentTime = target;
  });
}

function refreshEndpointFrames(): void {
  requestFrame('in', state.in);
  requestFrame('out', state.out);
}

/* --- load --- */

window.api.onTrimTarget(({ src, elementId }) => {
  state.src = src;
  state.elementId = elementId;
  const url = window.api.assetUrl(src);
  video.src = url;
  frameGrabber.src = url;
  document.title = `Trim & Crop — ${src.split('/').pop()}`;
});

video.addEventListener('loadedmetadata', () => {
  state.duration = video.duration;
  state.in = 0;
  state.out = video.duration;
  state.natural = { w: video.videoWidth, h: video.videoHeight };
  // The crop rectangle is always on screen, starting at the full frame. Hiding
  // it behind a checkbox meant the handles simply were not there to grab, and
  // a crop that equals the full frame costs nothing: it is not sent to ffmpeg.
  state.crop = { x: 0, y: 0, w: state.natural.w, h: state.natural.h };
  render();
  refreshEndpointFrames();
});

video.addEventListener('timeupdate', () => {
  // Loop playback inside the selected range so you audition the actual cut
  // rather than the whole file.
  if (video.currentTime >= state.out - 0.02) {
    video.currentTime = state.in;
    if (!video.paused) void video.play();
  }
  renderPlayhead();
});

/* --- transport --- */

el('play').addEventListener('click', () => {
  if (video.paused) {
    if (video.currentTime < state.in || video.currentTime >= state.out) {
      video.currentTime = state.in;
    }
    void video.play();
  } else {
    video.pause();
  }
  render();
});

el('set-in').addEventListener('click', () => {
  state.in = Math.min(video.currentTime, state.out - 0.05);
  render();
  requestFrame('in', state.in);
});

el('set-out').addEventListener('click', () => {
  state.out = Math.max(video.currentTime, state.in + 0.05);
  render();
  requestFrame('out', state.out);
});

el('reset-range').addEventListener('click', () => {
  state.in = 0;
  state.out = state.duration;
  render();
  refreshEndpointFrames();
});

/* --- scrubbing --- */

type ScrubDrag = 'in' | 'out' | 'playhead' | null;
let scrubDrag: ScrubDrag = null;

function timeAt(clientX: number): number {
  const r = scrub.getBoundingClientRect();
  return clamp(((clientX - r.left) / r.width) * state.duration, 0, state.duration);
}

/**
 * Pointer capture is a convenience, not a precondition: it throws for pointer
 * ids the browser does not recognise, and losing the drag entirely because of
 * that would be far worse than tracking without capture.
 */
function capture(node: Element, pointerId: number): void {
  try {
    node.setPointerCapture(pointerId);
  } catch {
    // Drag still works; it just stops if the pointer leaves the element.
  }
}

function releaseCapture(node: Element, pointerId: number): void {
  try {
    node.releasePointerCapture(pointerId);
  } catch {
    // Nothing was captured.
  }
}

scrub.addEventListener('pointerdown', (e) => {
  capture(scrub, e.pointerId);
  const target = e.target as HTMLElement;
  if (target.id === 'handle-in') scrubDrag = 'in';
  else if (target.id === 'handle-out') scrubDrag = 'out';
  else {
    scrubDrag = 'playhead';
    video.currentTime = timeAt(e.clientX);
  }
});

scrub.addEventListener('pointermove', (e) => {
  if (!scrubDrag) return;
  const t = timeAt(e.clientX);
  if (scrubDrag === 'in') {
    state.in = Math.min(t, state.out - 0.05);
    // The endpoint thumbnail updates live, so you can see the exact frame the
    // cut lands on without moving the main preview off the crop you're setting.
    requestFrame('in', state.in);
  } else if (scrubDrag === 'out') {
    state.out = Math.max(t, state.in + 0.05);
    requestFrame('out', state.out);
  } else {
    video.currentTime = t;
  }
  render();
});

scrub.addEventListener('pointerup', (e) => {
  releaseCapture(scrub, e.pointerId);
  scrubDrag = null;
});

/* --- crop --- */

el('crop-full').addEventListener('click', () => {
  state.crop = { x: 0, y: 0, w: state.natural.w, h: state.natural.h };
  render();
});

/**
 * A crop covering the whole frame is no crop at all. Treating it as such keeps
 * the fast stream-copy path available when you have only trimmed, even though
 * the rectangle is always on screen.
 */
function isFullFrame(): boolean {
  const c = state.crop;
  if (!c) return true;
  return (
    c.x <= 0 &&
    c.y <= 0 &&
    c.w >= state.natural.w - 1 &&
    c.h >= state.natural.h - 1
  );
}

/** The crop to send to ffmpeg, or null when the whole frame is selected. */
function effectiveCrop(): State['crop'] {
  return isFullFrame() ? null : state.crop;
}

for (const key of ['x', 'y', 'w', 'h'] as const) {
  el<HTMLInputElement>(`crop-${key}`).addEventListener('change', (e) => {
    if (!state.crop) return;
    const v = Number((e.target as HTMLInputElement).value);
    if (!Number.isFinite(v)) return;
    state.crop[key] = Math.round(v);
    clampCrop();
    render();
  });
}

/** Keep the crop box inside the source frame and non-degenerate. */
function clampCrop(): void {
  if (!state.crop) return;
  const c = state.crop;
  c.w = clamp(c.w, 16, state.natural.w);
  c.h = clamp(c.h, 16, state.natural.h);
  c.x = clamp(c.x, 0, state.natural.w - c.w);
  c.y = clamp(c.y, 0, state.natural.h - c.h);
}

/** Drag the crop box or its corners, in display space, converted to source px. */
let cropDrag:
  | { kind: 'move' | 'corner'; handle: string; startX: number; startY: number; origin: NonNullable<State['crop']> }
  | null = null;

cropOverlay.addEventListener('pointerdown', (e) => {
  if (!state.crop) return;
  e.preventDefault();
  capture(cropOverlay, e.pointerId);
  const handle = (e.target as HTMLElement).dataset.handle;
  cropDrag = {
    kind: handle ? 'corner' : 'move',
    handle: handle ?? '',
    startX: e.clientX,
    startY: e.clientY,
    origin: { ...state.crop },
  };
});

cropOverlay.addEventListener('pointermove', (e) => {
  if (!cropDrag || !state.crop) return;
  // The displayed video is letterboxed inside its box; scale by the actual
  // rendered size so a pixel of drag maps to the right number of source pixels.
  const r = video.getBoundingClientRect();
  const scale = state.natural.w / r.width;
  const dx = (e.clientX - cropDrag.startX) * scale;
  const dy = (e.clientY - cropDrag.startY) * scale;
  const o = cropDrag.origin;

  if (cropDrag.kind === 'move') {
    state.crop.x = Math.round(o.x + dx);
    state.crop.y = Math.round(o.y + dy);
  } else {
    // Each handle name names the edges it moves: "nw" drags top and left, "e"
    // drags the right edge only. Edges not named stay put.
    const handle = cropDrag.handle;
    const west = handle.includes('w');
    const east = handle.includes('e');
    const north = handle.includes('n');
    const south = handle.includes('s');

    if (west) {
      state.crop.x = Math.round(o.x + dx);
      state.crop.w = Math.round(o.w - dx);
    } else if (east) {
      state.crop.w = Math.round(o.w + dx);
    }
    if (north) {
      state.crop.y = Math.round(o.y + dy);
      state.crop.h = Math.round(o.h - dy);
    } else if (south) {
      state.crop.h = Math.round(o.h + dy);
    }

    // Dragging an edge past its opposite would invert the rectangle; pin it to
    // the minimum instead so the box stays valid and keeps tracking.
    if (state.crop.w < 16) {
      if (west) state.crop.x = o.x + o.w - 16;
      state.crop.w = 16;
    }
    if (state.crop.h < 16) {
      if (north) state.crop.y = o.y + o.h - 16;
      state.crop.h = 16;
    }
  }
  clampCrop();
  render();
});

cropOverlay.addEventListener('pointerup', (e) => {
  releaseCapture(cropOverlay, e.pointerId);
  cropDrag = null;
});

/* --- apply --- */

el('cancel').addEventListener('click', () => window.close());

el('apply').addEventListener('click', async () => {
  if (state.busy || !state.src) return;
  state.busy = true;
  render();

  try {
    setStatus('Running ffmpeg…');
    const result = await window.api.runTrim(buildRequest());
    setStatus(`Wrote ${result.src}`);
    // Close on success: the editor has already relinked the element, and
    // leaving the window open invites trimming the stale source again.
    setTimeout(() => window.close(), 700);
  } catch (err) {
    setStatus(String(err instanceof Error ? err.message : err), true);
    state.busy = false;
    render();
  }
});

window.api.onTrimProgress(({ fraction, message }) => {
  el('progress-bar').style.width = `${Math.round(fraction * 100)}%`;
  setStatus(`${message} ${Math.round(fraction * 100)}%`);
});

function buildRequest(): TrimRequest {
  return {
    // The main process knows the deck dir; this field exists for the type and
    // is authoritative only on the main side.
    deckDir: '',
    src: state.src,
    start: state.in,
    end: state.out,
    crop: effectiveCrop(),
    copyWhenPossible: el<HTMLInputElement>('copy-mode').checked,
  };
}

function setStatus(text: string, error = false): void {
  const node = el('status');
  node.textContent = text;
  node.classList.toggle('error', error);
}

/* --- render --- */

function render(): void {
  el('play').textContent = video.paused ? 'Play' : 'Pause';
  el('time').textContent = `${video.currentTime.toFixed(2)} / ${state.duration.toFixed(2)}`;

  const pct = (t: number) => (state.duration > 0 ? (t / state.duration) * 100 : 0);
  el('handle-in').style.left = `${pct(state.in)}%`;
  el('handle-out').style.left = `${pct(state.out)}%`;
  const fill = el('range-fill');
  fill.style.left = `${pct(state.in)}%`;
  fill.style.width = `${pct(state.out - state.in)}%`;
  renderPlayhead();

  // Crop box, positioned over the *rendered* video rather than its container,
  // so letterboxing never shifts it off the image.
  cropOverlay.hidden = !state.crop;
  if (state.crop) {
    const r = video.getBoundingClientRect();
    const wrap = el('video-wrap').getBoundingClientRect();
    const sx = r.width / state.natural.w;
    const sy = r.height / state.natural.h;
    cropRect.style.left = `${r.left - wrap.left + state.crop.x * sx}px`;
    cropRect.style.top = `${r.top - wrap.top + state.crop.y * sy}px`;
    cropRect.style.width = `${state.crop.w * sx}px`;
    cropRect.style.height = `${state.crop.h * sy}px`;

    for (const key of ['x', 'y', 'w', 'h'] as const) {
      const input = el<HTMLInputElement>(`crop-${key}`);
      if (document.activeElement !== input) input.value = String(state.crop[key]);
    }

    const size = cropRect.querySelector('.crop-size');
    if (size) {
      // Output dimensions, rounded to even as ffmpeg will, so what the badge
      // says is what the file gets.
      const ew = Math.max(2, Math.floor(state.crop.w / 2) * 2);
      const eh = Math.max(2, Math.floor(state.crop.h / 2) * 2);
      size.textContent = `${ew} × ${eh}`;
    }
  }
  // A crop always forces a re-encode, so the fast path is only offered when
  // the full frame is selected — saying so beats silently ignoring the box.
  const cropping = effectiveCrop() !== null;
  const copyBox = el<HTMLInputElement>('copy-mode');
  copyBox.disabled = cropping;
  el('copy-note').textContent = cropping
    ? 'Cropping requires re-encoding.'
    : copyBox.checked
      ? 'Cuts land on the nearest keyframe before the in point.'
      : 'Frame-accurate, re-encodes with H.264 CRF 18.';

  el('command').textContent = describeCommand();
  el<HTMLButtonElement>('apply').disabled = state.busy || !state.src;
}

function renderPlayhead(): void {
  const pct = state.duration > 0 ? (video.currentTime / state.duration) * 100 : 0;
  el('playhead').style.left = `${pct}%`;
  el('time').textContent = `${video.currentTime.toFixed(2)} / ${state.duration.toFixed(2)}`;
  el('time-in').textContent = state.in.toFixed(2);
  el('time-out').textContent = state.out.toFixed(2);
}

/** Human-readable preview of the ffmpeg invocation, so nothing is a black box. */
function describeCommand(): string {
  if (!state.src) return '';
  const crop = effectiveCrop();
  const parts = ['ffmpeg', '-ss', state.in.toFixed(3), '-i', quote(state.src)];
  parts.push('-t', (state.out - state.in).toFixed(3));
  if (crop) {
    const ew = Math.max(2, Math.floor(crop.w / 2) * 2);
    const eh = Math.max(2, Math.floor(crop.h / 2) * 2);
    parts.push('-vf', `crop=${ew}:${eh}:${crop.x}:${crop.y}`);
  }
  if (!crop && el<HTMLInputElement>('copy-mode').checked) {
    parts.push('-c', 'copy');
  } else {
    parts.push('-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p');
  }
  parts.push('-movflags', '+faststart', 'assets/…trim1.mp4');
  return parts.join(' ');
}

function quote(s: string): string {
  return /[\s'"]/.test(s) ? `'${s}'` : s;
}

el<HTMLInputElement>('copy-mode').addEventListener('change', render);
window.addEventListener('resize', render);
video.addEventListener('play', render);
video.addEventListener('pause', render);
render();
