import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { MediaInfo, TrimRequest } from '@shared/ipc.js';

/**
 * All ffmpeg/ffprobe use goes through here.
 *
 * Binaries are resolved in this order: the bundled per-platform binaries from
 * ffmpeg-static/ffprobe-static, then whatever is on PATH. The bundled path is
 * what makes the app work on a fresh Linux box with nothing installed; the
 * PATH fallback keeps development working if the optional dependency wasn't
 * fetched for this platform.
 */

const require = createRequire(import.meta.url);

let ffmpegPath: string | null | undefined;
let ffprobePath: string | null | undefined;

function resolveBinary(
  pkg: string,
  pick: (mod: unknown) => string | undefined,
  fallback: string,
): string {
  try {
    const mod = require(pkg) as unknown;
    const p = pick(mod);
    // In a packaged app the binary lives under app.asar.unpacked, and the
    // path baked in by the module still points inside the archive.
    const unpacked = p?.replace('app.asar', 'app.asar.unpacked');
    if (unpacked && existsSync(unpacked)) return unpacked;
    if (p && existsSync(p)) return p;
  } catch {
    // Optional dependency missing for this platform; fall through to PATH.
  }
  return fallback;
}

export function getFfmpegPath(): string {
  if (ffmpegPath === undefined) {
    ffmpegPath = resolveBinary(
      'ffmpeg-static',
      (m) => (typeof m === 'string' ? m : (m as { default?: string })?.default),
      'ffmpeg',
    );
  }
  return ffmpegPath as string;
}

export function getFfprobePath(): string {
  if (ffprobePath === undefined) {
    ffprobePath = resolveBinary(
      'ffprobe-static',
      (m) => (m as { path?: string })?.path,
      'ffprobe',
    );
  }
  return ffprobePath as string;
}

/** Codecs Chromium decodes on macOS and Linux alike. */
const WEB_SAFE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);

/** The file's video codec name, or null when it cannot be determined. */
export async function videoCodec(absolutePath: string): Promise<string | null> {
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', absolutePath,
    ]);
    return out.stdout.trim().split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function isWebSafeCodec(codec: string | null): boolean {
  // Unknown codec: assume playable rather than transcode blindly.
  return codec === null || WEB_SAFE_VIDEO_CODECS.has(codec);
}

/** Transcode to H.264/AAC in place-adjacent file; returns the new path. */
export async function transcodeToH264(
  input: string,
  output: string,
  onProgress?: (ratio: number | null) => void,
): Promise<void> {
  // Duration bounds the progress ratio; without it we can still report that
  // work is happening (null ratio → indeterminate spinner).
  const duration = onProgress ? (await probeMedia(input)).duration : null;
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y', '-i', input,
      '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output,
    ]);
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!onProgress) return;
      for (const line of chunk.split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (!m) continue;
        if (duration && duration > 0) {
          onProgress(Math.min(1, Number(m[1]) / 1_000_000 / duration));
        } else {
          onProgress(null);
        }
      }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`transcode failed: ${stderr}`)),
    );
  });
}

/**
 * Cut one frame of `input` at `seconds` to a JPEG at `output`.
 *
 * `-ss` before `-i` seeks by index, so this is a few frames of decoding even
 * on a long clip. The frame is bounded to 960px on its long edge: it is for
 * thumbnails, and a full-size still of a screen recording would cost more to
 * decode in the renderer than it is worth.
 */
export async function extractPosterFrame(input: string, seconds: number, output: string): Promise<void> {
  await run(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', Math.max(0, seconds).toFixed(3), '-i', input,
    '-frames:v', '1', '-an',
    '-vf', "scale='min(960,iw)':-2",
    '-q:v', '4', '-f', 'image2', output,
  ]);
}

/**
 * Write raw RGBA pixels out as a PNG.
 *
 * Node has no image encoder and the main process has no canvas, so the one
 * encoder already bundled does the work. Used by the HEIC importer, whose
 * wasm decoder hands back nothing but a pixel buffer.
 */
export async function encodeRgbaToPng(
  pixels: Buffer,
  width: number,
  height: number,
  output: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-i', 'pipe:0',
      // Without these the image2 muxer treats the output as a numbered
      // sequence and warns on every single-frame write.
      '-frames:v', '1', '-update', '1',
      output,
    ]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`png encode failed: ${stderr}`)),
    );
    // A large photo is tens of megabytes of RGBA; let the stream drain rather
    // than blocking, and ignore EPIPE if ffmpeg died first (handled above).
    child.stdin.on('error', () => {});
    child.stdin.end(pixels);
  });
}

/** Natural dimensions and duration, or nulls if the file can't be probed. */
export async function probeMedia(absolutePath: string): Promise<MediaInfo> {
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json',
      absolutePath,
    ]);
    const parsed = JSON.parse(out.stdout) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const stream = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration);
    return {
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      duration: Number.isFinite(duration) ? duration : null,
    };
  } catch {
    // A still image, an exotic container, or no ffprobe. The caller falls back
    // to a default box size rather than refusing the drop.
    return { width: null, height: null, duration: null };
  }
}

/** Build the ffmpeg argv for a trim/crop, so the UI can show the exact command. */
export function buildTrimArgs(
  req: TrimRequest,
  input: string,
  output: string,
): string[] {
  const args: string[] = ['-hide_banner', '-y'];

  // -ss before -i seeks by index rather than decoding up to the cut, which is
  // the difference between instant and minutes on a long clip.
  if (req.start > 0) args.push('-ss', req.start.toFixed(3));
  args.push('-i', input);
  if (req.end > req.start) args.push('-t', (req.end - req.start).toFixed(3));

  if (req.crop) {
    const { w, h, x, y } = req.crop;
    // Even dimensions: yuv420p chroma subsampling cannot represent odd sizes,
    // and libx264 fails outright on them.
    const ew = Math.max(2, Math.floor(w / 2) * 2);
    const eh = Math.max(2, Math.floor(h / 2) * 2);
    args.push('-vf', `crop=${ew}:${eh}:${Math.round(x)}:${Math.round(y)}`);
  }

  if (!req.crop && req.copyWhenPossible) {
    // Lossless and instant, but the cut lands on the nearest keyframe before
    // the requested start. The UI says so.
    args.push('-c', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-crf', '18',
      '-preset', 'veryfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
    );
  }

  // Puts the moov atom first so the file starts playing without a full read —
  // it matters when a slide appears and the video must start immediately.
  args.push('-movflags', '+faststart', output);
  return args;
}

/**
 * Run a trim/crop, reporting progress parsed from ffmpeg's `-progress` stream.
 * Writes to `output`; the input is never touched.
 */
export async function runTrim(
  req: TrimRequest,
  input: string,
  output: string,
  onProgress: (fraction: number, message: string) => void,
): Promise<void> {
  const duration = Math.max(0.001, req.end - req.start);
  const args = [...buildTrimArgs(req, input, output)];
  // -progress on stdout gives machine-readable `out_time_us=` lines, far more
  // reliable than scraping the human-readable stderr banner.
  args.splice(2, 0, '-progress', 'pipe:1', '-nostats');

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(getFfmpegPath(), args);
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (!m) continue;
        const seconds = Number(m[1]) / 1_000_000;
        onProgress(Math.min(1, seconds / duration), 'Encoding');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Keep only the tail: ffmpeg is verbose, and the error is always last.
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on('error', (err) =>
      reject(new Error(`Could not run ffmpeg (${getFfmpegPath()}): ${err.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) {
        onProgress(1, 'Done');
        resolvePromise();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.trim()}`));
      }
    });
  });
}

export function run(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise({ stdout, stderr })
        : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-2000)}`)),
    );
  });
}

/** A still Chromium cannot decode (TIFF, BMP), re-encoded as PNG. */
export async function convertImageToPng(input: string, output: string): Promise<void> {
  await run(getFfmpegPath(), [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-f', 'image2', '-c:v', 'png', output,
  ]);
}

/** Pixel dimensions and pixel format of a still image, or nulls if unknown. */
export async function probeImage(
  absolutePath: string,
): Promise<{ width: number | null; height: number | null; pixFmt: string | null; frames: number | null }> {
  try {
    const out = await run(getFfprobePath(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-count_frames', '-show_entries', 'stream=width,height,pix_fmt,nb_read_frames',
      '-of', 'json', absolutePath,
    ]);
    const parsed = JSON.parse(out.stdout) as {
      streams?: Array<{ width?: number; height?: number; pix_fmt?: string; nb_read_frames?: string }>;
    };
    const stream = parsed.streams?.[0];
    const frames = Number(stream?.nb_read_frames);
    return {
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      pixFmt: stream?.pix_fmt ?? null,
      frames: Number.isFinite(frames) ? frames : null,
    };
  } catch {
    return { width: null, height: null, pixFmt: null, frames: null };
  }
}

export interface WebVideoEncode {
  /** VP9 in WebM is a third smaller than H.264 at equal quality and plays in every current browser. */
  codec: 'h264' | 'vp9';
  /** Constant rate factor for the codec; higher is smaller. */
  crf: number;
  /** libx264 preset or libvpx `-cpu-used` speed (0 slowest, 5 fastest). */
  speed: string;
  audioBitrate: string;
  /** Output size when the source has to shrink; omit to keep the source size. */
  width?: number;
  height?: number;
  /** Keep only this stretch of the clip, in seconds from the source's start. */
  trim?: { start: number; duration: number };
}

/**
 * Re-encode a clip for the web, optionally cut down and downscaled.
 * `onProgress` receives the fraction of the output written so far, or null
 * when the duration is unknown.
 */
export async function transcodeVideoForWeb(
  input: string,
  output: string,
  encode: WebVideoEncode,
  onProgress?: (ratio: number | null) => void,
): Promise<void> {
  const duration = encode.trim
    ? encode.trim.duration
    : onProgress ? (await probeMedia(input)).duration : null;
  // yuv420p cannot hold odd dimensions and libx264 refuses them outright, so
  // the scale filter always lands on even numbers, resized or not.
  const scale = encode.width && encode.height
    ? `scale=${Math.max(2, Math.floor(encode.width / 2) * 2)}:${Math.max(2, Math.floor(encode.height / 2) * 2)}`
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const args = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', '-y'];
  // `-ss` before `-i` seeks by index and, because the stream is re-encoded,
  // ffmpeg decodes and discards up to the exact frame: fast and accurate.
  if (encode.trim && encode.trim.start > 0) args.push('-ss', encode.trim.start.toFixed(3));
  args.push('-i', input);
  if (encode.trim) args.push('-t', encode.trim.duration.toFixed(3));
  args.push('-map', '0:v:0', '-map', '0:a?', '-vf', `${scale},format=yuv420p`);
  if (encode.codec === 'vp9') {
    args.push(
      '-c:v', 'libvpx-vp9', '-crf', String(encode.crf), '-b:v', '0',
      '-deadline', 'good', '-cpu-used', encode.speed, '-row-mt', '1',
      '-c:a', 'libopus', '-b:a', encode.audioBitrate, '-f', 'webm', output,
    );
  } else {
    args.push(
      '-c:v', 'libx264', '-crf', String(encode.crf), '-preset', encode.speed,
      '-c:a', 'aac', '-b:a', encode.audioBitrate,
      '-movflags', '+faststart', '-f', 'mp4', output,
    );
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(getFfmpegPath(), args);
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!onProgress) return;
      for (const line of chunk.split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (!m) continue;
        onProgress(duration && duration > 0 ? Math.min(1, Number(m[1]) / 1_000_000 / duration) : null);
      }
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`web transcode failed: ${stderr}`)),
    );
  });
}

export interface WebImageEncode {
  /** libwebp quality, 0–100. */
  quality: number;
  width?: number;
  height?: number;
}

/**
 * Re-encode a still image as lossy WebP, keeping any alpha channel, optionally
 * downscaled. WebP is the one format that is both smaller than JPEG for photos
 * and able to carry transparency, so a deck's figures need no per-file choice.
 */
export async function encodeImageWebp(
  input: string,
  output: string,
  encode: WebImageEncode,
): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-update', '1'];
  if (encode.width && encode.height) {
    args.push('-vf', `scale=${Math.max(1, Math.round(encode.width))}:${Math.max(1, Math.round(encode.height))}`);
  }
  args.push(
    '-c:v', 'libwebp', '-quality', String(encode.quality), '-compression_level', '6',
    '-f', 'webp', output,
  );
  await run(getFfmpegPath(), args);
}
