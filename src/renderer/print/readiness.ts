import type { Slide } from '@shared/deck.js';
import type { SlideState } from '@shared/timeline.js';
import { WEB_BRIDGE_SOURCE, type WebBridgeEvent } from '@shared/webBridge.js';
import { WEB_REVEAL_TIMEOUT_MS, whenWebElementReady } from '../player/render.js';
import {
  SYNC_BLACK_CLASS,
  stillGroupFrames,
  syncGroupsOf,
  type MemberFrame,
} from '../player/videoSync.js';

const eventOrTimeout = (target: EventTarget, event: string, timeout = 5_000): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      target.removeEventListener(event, finish);
      resolve();
    };
    const timer = setTimeout(finish, timeout);
    target.addEventListener(event, finish, { once: true });
  });

async function settleImage(image: HTMLImageElement): Promise<void> {
  if (!image.complete) await Promise.race([
    eventOrTimeout(image, 'load'),
    eventOrTimeout(image, 'error'),
  ]);
  if (typeof image.decode === 'function') await image.decode().catch(() => {});
}

export function isAnimatedImageSource(src: string): boolean {
  return /\.gif(?:$|[?#])/i.test(src);
}

/** PDF pages must be reproducible: an animated GIF otherwise advances while
 * Chromium is laying out/printing and lands on an arbitrary frame. Decode the
 * source as an ImageBitmap (whose GIF representation is frame zero), then pin
 * that frame into an ordinary PNG data URL. */
async function freezeAnimatedImage(image: HTMLImageElement): Promise<void> {
  const src = image.currentSrc || image.src;
  if (!isAnimatedImageSource(src) || typeof createImageBitmap !== 'function') return;
  try {
    const response = await fetch(src);
    if (!response.ok) return;
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, bitmap.width);
    canvas.height = Math.max(1, bitmap.height);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    image.src = canvas.toDataURL('image/png');
    await settleImage(image);
  } catch {
    // A failed still-frame decode is non-fatal: the original GIF remains and
    // the normal image readiness path below still prevents a blank export.
  }
}

async function settleVideo(video: HTMLVideoElement, at: number): Promise<void> {
  // Claim the frame before pausing: the Player restarts playback it believes
  // was interrupted, which would drift the frame this pins.
  video.dataset.holdFrame = 'true';
  video.autoplay = false;
  video.pause();
  if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
    await Promise.race([
      eventOrTimeout(video, 'loadedmetadata'),
      eventOrTimeout(video, 'error'),
    ]);
  }
  if (!Number.isFinite(video.duration)) return;
  const target = Math.max(0, Math.min(at, Math.max(0, video.duration - 0.03)));
  // The PDF contract pins a video to its exact poster/in-point. A two-
  // hundredths tolerance is visible on fast-motion clips and made repeated
  // exports nondeterministic by one decoded frame.
  if (Math.abs(video.currentTime - target) <= 0.0001) {
    // A newly mounted or reused video can report the target time while its
    // compositor surface still contains a stale frame. Nudge away first so
    // the seek back to the exact time necessarily asks the decoder to paint.
    const nudge = target + 0.03 <= video.duration
      ? target + 0.03
      : Math.max(0, target - 0.03);
    if (Math.abs(nudge - target) > 0.0001) {
      const nudged = eventOrTimeout(video, 'seeked');
      try { video.currentTime = nudge; } catch { return; }
      await nudged;
    }
  }
  if (Math.abs(video.currentTime - target) > 0.0001) {
    const sought = eventOrTimeout(video, 'seeked');
    try { video.currentTime = target; } catch { return; }
    await sought;
  }
  if ('requestVideoFrameCallback' in video) {
    await Promise.race([
      new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
}

/**
 * Chromium's print compositor does not reliably use the frame currently
 * presented by a paused `<video>`. It may ask the decoder for another nearby
 * frame after readiness has completed, so the PDF and an on-screen capture of
 * the same player state can disagree substantially. Copy the decoded frame to
 * a canvas before printing; a canvas is a stable bitmap while retaining the
 * video's inline crop/fit geometry.
 */
function freezeVideoFrame(video: HTMLVideoElement): void {
  if (!video.videoWidth || !video.videoHeight) return;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.className = video.className;
    canvas.style.cssText = video.style.cssText;
    // Native video paints unused `object-fit: contain` letterbox space black.
    // Canvas is transparent by default, which made those bands print white.
    canvas.style.backgroundColor = 'black';
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    video.replaceWith(canvas);

    // The canvas owns the copied pixels now, so release the decoder before
    // Chromium lays out the printable document.
    video.removeAttribute('src');
    try { video.load(); } catch { /* jsdom stub */ }
  } catch {
    // If the browser cannot copy this source, leave the settled live video in
    // place. Export remains usable, albeit with Chromium's old frame choice.
  }
}

function deepImages(root: ParentNode): HTMLImageElement[] {
  const images = [...root.querySelectorAll<HTMLImageElement>('img')];
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (element.shadowRoot) images.push(...deepImages(element.shadowRoot));
  }
  return images;
}

/**
 * Keep a print page's video from loading until its turn comes.
 *
 * A long deck prints dozens of videos, some of them 4K, and every build stage
 * of a slide repeats its clips. Mounted with a source, each one opens its own
 * decoder at once: a 90-page talk took a tab past 4 GB and crashed Chromium's
 * media thread. Taking the source away before the browser's resource
 * selection runs (it waits for the current task to end) means nothing is
 * fetched or decoded until waitForPdfDocument asks for it.
 */
export function holdVideoSource(video: HTMLVideoElement): void {
  const src = video.getAttribute('src');
  if (!src) return;
  video.dataset.printSrc = src;
  video.removeAttribute('src');
  video.load();
}

function releaseVideoSource(video: HTMLVideoElement): void {
  const src = video.dataset.printSrc;
  if (!src) return;
  delete video.dataset.printSrc;
  video.src = src;
}

/**
 * Show the still cut for this video in its place. False when the still does
 * not arrive, so the caller can fall back to the video itself.
 */
async function replaceWithStill(video: HTMLVideoElement, url: string): Promise<boolean> {
  const image = document.createElement('img');
  image.className = video.className;
  image.style.cssText = video.style.cssText;
  // Same letterbox colour as a video surface (see freezeVideoFrame).
  image.style.backgroundColor = 'black';
  image.alt = '';
  image.src = url;
  // A still cut on demand can queue behind others; give it longer than an
  // asset that only has to be read.
  await Promise.race([eventOrTimeout(image, 'load', 30_000), eventOrTimeout(image, 'error', 30_000)]);
  if (!image.naturalWidth) return false;
  await image.decode().catch(() => {});
  video.replaceWith(image);
  return true;
}

export interface PdfReadinessOptions {
  /**
   * A URL for a still of deck video `src` at `time` seconds, cut outside the
   * page (ffmpeg on the server or in the desktop's main process), or null to
   * have this page load that video and capture the frame itself.
   */
  stillFor?: (src: string, time: number) => Promise<string | null>;
  /**
   * The length in seconds of deck video `src`, probed outside the page
   * (ffprobe on the server or in the desktop's main process), or null when it
   * cannot say; the page then reads the video's metadata. Only a synced clip
   * without an out-point asks: its length decides its group's frame.
   */
  durationFor?: (src: string) => Promise<number | null>;
  /** Called as videos settle, with how many are done out of how many. */
  onProgress?: (settled: number, total: number) => void;
}

/** Stills are only image fetches; the server bounds its own ffmpeg work. */
const STILL_CONCURRENCY = 4;

type PrintPage = { page: HTMLElement; slide: Slide; state: SlideState };

const elementIdOf = (video: HTMLVideoElement): string | undefined =>
  video.closest<HTMLElement>('[data-element-id]')?.dataset.elementId;

/** A video's duration from its metadata alone: no frame is decoded. */
async function metadataDuration(url: string): Promise<number> {
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.muted = true;
  probe.src = url;
  await Promise.race([eventOrTimeout(probe, 'loadedmetadata'), eventOrTimeout(probe, 'error')]);
  const duration = probe.duration;
  probe.removeAttribute('src');
  try { probe.load(); } catch { /* jsdom stub */ }
  return duration;
}

/**
 * Show black where a synced clip has run out before its group, as the
 * presentation does (compare.css darkens the picture to black). Its whole box
 * is black whatever frame it would hold, so nothing is fetched or decoded.
 */
function replaceWithBlack(video: HTMLVideoElement): void {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  canvas.className = video.className;
  canvas.classList.add(SYNC_BLACK_CLASS);
  canvas.style.cssText = video.style.cssText;
  // Transparent pixels over a black ground: the box prints black, letterbox
  // included, as a frame darkened by the class would.
  canvas.style.backgroundColor = 'black';
  video.replaceWith(canvas);
}

/**
 * Where each member of a print page's sync groups belongs, by element id.
 *
 * A synced group is pinned as one: its clips' lengths decide which frame,
 * or black, each shows at this build step (videoSync.ts), exactly as the
 * presentation would. A trimmed clip's length is its trim; only a clip that
 * runs to the end of its file needs that file's duration, which `durationOf`
 * gets as cheaply as it can.
 */
async function syncedFramesOf(
  { page, slide, state }: PrintPage,
  durationOf: (src: string, url: string | null) => Promise<number>,
): Promise<Map<string, MemberFrame>> {
  const frames = new Map<string, MemberFrame>();
  const groups = syncGroupsOf(slide.elements);
  if (groups.size === 0) return frames;
  const urls = new Map<string, string>();
  for (const video of page.querySelectorAll<HTMLVideoElement>('video')) {
    const id = elementIdOf(video);
    const url = video.dataset.printSrc ?? video.getAttribute('src');
    if (id && url) urls.set(id, url);
  }
  for (const members of groups.values()) {
    const lengths = new Map(await Promise.all(members.map(async (member) => [
      member.id,
      // An out-point is the clip's length (clipSpan caps it by the file's).
      member.end ?? await durationOf(member.src, urls.get(member.id) ?? null),
    ] as const)));
    const memberFrames = stillGroupFrames(members, (id) => lengths.get(id) ?? Number.NaN, state.seeks);
    for (const [id, frame] of memberFrames) frames.set(id, frame);
  }
  return frames;
}

async function settlePrintVideos(
  pages: PrintPage[],
  options: PdfReadinessOptions,
): Promise<void> {
  const videos = pages.flatMap((entry) =>
    [...entry.page.querySelectorAll<HTMLVideoElement>('video')].map((video) => ({ video, entry })));
  let settled = 0;
  options.onProgress?.(0, videos.length);
  // A video that has to play in the page is the expensive case: one at a time.
  let live = Promise.resolve();
  const oneLiveVideo = (task: () => Promise<void>): Promise<void> => {
    const run = live.then(task);
    live = run.catch(() => {});
    return run;
  };
  // Every build stage repeats a slide's clips: probe each file once.
  const durations = new Map<string, Promise<number>>();
  const durationOf = (src: string, url: string | null): Promise<number> => {
    let duration = durations.get(src);
    if (!duration) {
      duration = (async () => {
        const probed = await options.durationFor?.(src).catch(() => null);
        if (typeof probed === 'number' && Number.isFinite(probed) && probed > 0) return probed;
        return url ? metadataDuration(url) : Number.NaN;
      })();
      durations.set(src, duration);
    }
    return duration;
  };
  const syncedFrames = new Map<PrintPage, Promise<Map<string, MemberFrame>>>();
  const syncedFramesFor = (entry: PrintPage): Promise<Map<string, MemberFrame>> => {
    let frames = syncedFrames.get(entry);
    if (!frames) {
      frames = syncedFramesOf(entry, durationOf);
      syncedFrames.set(entry, frames);
    }
    return frames;
  };
  const settleOne = async ({ video, entry }: typeof videos[number]): Promise<void> => {
    const { slide, state } = entry;
    const id = elementIdOf(video);
    const element = slide.elements.find((candidate) => candidate.id === id);
    const synced = id && element?.type === 'video' && element.syncGroup
      ? (await syncedFramesFor(entry)).get(id)
      : undefined;
    if (synced?.black) {
      replaceWithBlack(video);
      options.onProgress?.(++settled, videos.length);
      return;
    }
    const at = synced?.time
      ?? (element?.type === 'video' ? state.seeks.get(element.id) ?? element.start : 0);
    const url = element?.type === 'video' && options.stillFor
      ? await options.stillFor(element.src, at).catch(() => null)
      : null;
    if (!url || !(await replaceWithStill(video, url))) {
      await oneLiveVideo(async () => {
        releaseVideoSource(video);
        await settleVideo(video, at);
        freezeVideoFrame(video);
      });
    }
    options.onProgress?.(++settled, videos.length);
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(STILL_CONCURRENCY, videos.length) }, async () => {
    while (next < videos.length) await settleOne(videos[next++]);
  }));
}

/**
 * How long a web page gets to draw the step it was told before the PDF page
 * is captured. Pages that take part in builds jump to the step they enter at,
 * but some apply it only once their own loading is done, and a page entered
 * at its first step plays its opening beats; the deck cannot see inside the
 * sandboxed frame to know when that is over. 1.5 s caught a text-conditioning
 * page's opening half drawn; 5 s matched the Player on every build stage of
 * the TRI site-visit deck's eight web elements. Every page settles at once,
 * so this is added to an export once, not per page.
 */
export const WEB_STEP_SETTLE_MS = 5_000;

/** Settles once a print page's web element has had its step and time to draw it. */
const webStepShown = new WeakMap<Element, Promise<void>>();

/**
 * Show each web page on a print page at that page's build step.
 *
 * A web element draws its own builds: the Player tells it the step when its
 * slide comes on screen (`active`, which going backwards is the last step)
 * and on every click after (`step`). A print page has no clicks, so it enters
 * at its step, exactly as presenting backwards does — without this every
 * printed copy sat at step 0, a chart of empty bars.
 *
 * Being told is not enough to draw: pages animate with requestAnimationFrame,
 * which Chromium stops in a sandboxed frame scrolled out of view — and nearly
 * every print page is. So while its web pages load and settle, the print page
 * is held inside the viewport, invisible, with a spacer keeping its place in
 * the preview (print.css). Call it as soon as `page` is in the document: the
 * frames load from then, and a message sent earlier reaches the frame's blank
 * initial document.
 */
export function showWebPagesAtStep(page: HTMLElement, step: number, steps: number): void {
  const frames = [...page.querySelectorAll<HTMLIFrameElement>('iframe.web-frame')];
  if (frames.length === 0) return;
  const event: WebBridgeEvent = { source: WEB_BRIDGE_SOURCE, event: 'active', step, steps };
  const spacer = document.createElement('div');
  spacer.className = 'pdf-page-spacer';
  spacer.style.width = page.style.width;
  spacer.style.height = page.style.height;
  page.before(spacer);
  page.classList.add('web-settling');
  const settled = Promise.all(frames.map((frame) => new Promise<void>((resolve) => {
    // A page that never loads is printed as the reveal timeout leaves it.
    const giveUp = setTimeout(resolve, WEB_REVEAL_TIMEOUT_MS + WEB_STEP_SETTLE_MS);
    frame.addEventListener('load', () => {
      frame.contentWindow?.postMessage(event, '*');
      clearTimeout(giveUp);
      setTimeout(resolve, WEB_STEP_SETTLE_MS);
    }, { once: true });
  }))).then(() => {
    page.classList.remove('web-settling');
    spacer.remove();
  });
  for (const frame of frames) {
    const box = frame.closest('.web-body');
    if (box) webStepShown.set(box, settled);
  }
}

/** Wait until a PDF page's images, embeds and web pages are as the player shows them. */
async function waitForPdfPage(page: HTMLElement): Promise<void> {
  const images = deepImages(page);
  await Promise.all(images.map(freezeAnimatedImage));
  await Promise.all(images.map(settleImage));
  // A plugin-rendered <embed> (a PDF used as an image) never paints into
  // printed output, and waiting on it is all this layer can do about that; at
  // least the wait means a slow plugin cannot also cost the page its images.
  await Promise.all([...page.querySelectorAll<HTMLEmbedElement>('embed')].map((embed) =>
    Promise.race([eventOrTimeout(embed, 'load'), eventOrTimeout(embed, 'error')])));
  // A live web page stays hidden (under its poster) until it is ready, and
  // reveals itself on its own clock; print it once it has, or once its reveal
  // timeout has shown it as it is.
  await Promise.all([...page.querySelectorAll('.web-body')].map(async (box) => {
    await whenWebElementReady(box);
    await webStepShown.get(box);
  }));
}

/** Wait for font replacement, auto-fit, decoded media, and finite CSS motion. */
export async function waitForPdfDocument(
  pages: Array<{ page: HTMLElement; slide: Slide; state: SlideState }>,
  options: PdfReadinessOptions = {},
): Promise<void> {
  await document.fonts.ready;
  await Promise.all([
    ...pages.map(({ page }) => waitForPdfPage(page)),
    settlePrintVideos(pages, options),
  ]);
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  for (const animation of document.getAnimations()) {
    const iterations = animation.effect?.getComputedTiming().iterations;
    if (iterations !== Infinity) {
      try { animation.finish(); } catch { /* A non-finite animation is safe to leave alone. */ }
    }
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
