import { execFile } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getFfmpegPath } from '../../src/main/ffmpeg.js';

/**
 * One small real file per media format an author is likely to drop or paste,
 * plus the expectations the importer has to meet for each.
 *
 * The point is that every entry is a *genuine* encode, not a renamed PNG: the
 * bugs this matrix exists to catch — a format Chromium cannot decode importing
 * as a blank rectangle, a codec that renders as a black box, an extension the
 * classifier silently refuses — all hide behind file *contents*, so a fixture
 * with the wrong bytes would pass while the app stayed broken.
 *
 * Everything except HEIC is generated on demand by the bundled ffmpeg, which
 * keeps the fixtures honest across platforms and out of git. HEIC is the one
 * format nothing in the toolchain can *write* (ffmpeg 6 can neither mux nor
 * demux HEIF), so a 1.4KB sample is committed instead.
 */

const execFileAsync = promisify(execFile);

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'media');

/** A 64×48 test pattern, small enough that a full matrix encodes in a second. */
const SOURCE = ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10'];

export interface MediaFixture {
  /** File name as it would arrive from a drop or a clipboard paste. */
  name: string;
  /** MIME type the OS puts on the DataTransfer item, for drop/paste tests. */
  mime: string;
  /** What `classifyMediaName` must say about it. */
  kind: 'image' | 'video' | null;
  /**
   * Pattern the deck-relative src must match after import, or null when the
   * importer is expected to refuse the file outright.
   */
  src: RegExp | null;
  /** Whether the importer has to re-encode the file to make it renderable. */
  converted: boolean;
  /** Whether ffprobe can read natural dimensions off the imported result. */
  sized: boolean;
  /** Why this format is in the matrix. */
  why: string;
  /** How to produce it; absent means "committed fixture, copied in". */
  encode?: string[];
}

export const MEDIA_FIXTURES: readonly MediaFixture[] = [
  // --- raster images Chromium decodes as-is ---
  {
    name: 'swatch.png',
    mime: 'image/png',
    kind: 'image',
    src: /^assets\/swatch\.[0-9a-f]{8}\.png$/,
    converted: false,
    sized: true,
    why: 'The default for screenshots and exported figures.',
    encode: ['-frames:v', '1'],
  },
  {
    name: 'photo.jpg',
    mime: 'image/jpeg',
    kind: 'image',
    src: /^assets\/photo\.[0-9a-f]{8}\.jpg$/,
    converted: false,
    sized: true,
    why: 'Every camera and every image on the web.',
    encode: ['-frames:v', '1'],
  },
  {
    name: 'photo.jpeg',
    mime: 'image/jpeg',
    kind: 'image',
    src: /^assets\/photo\.[0-9a-f]{8}\.jpeg$/,
    converted: false,
    sized: true,
    why: 'The four-letter spelling is a separate entry in the extension set.',
    encode: ['-frames:v', '1'],
  },
  {
    name: 'loop.gif',
    mime: 'image/gif',
    kind: 'image',
    src: /^assets\/loop\.[0-9a-f]{8}\.gif$/,
    converted: false,
    sized: true,
    why: 'Animated GIFs must stay images — a <video> cannot play one.',
    encode: ['-t', '0.5'],
  },
  {
    name: 'photo.webp',
    mime: 'image/webp',
    kind: 'image',
    src: /^assets\/photo\.[0-9a-f]{8}\.webp$/,
    converted: false,
    sized: true,
    why: 'What most sites now serve, so what most copy-paste produces.',
    encode: ['-frames:v', '1', '-c:v', 'libwebp'],
  },
  {
    name: 'photo.avif',
    mime: 'image/avif',
    kind: 'image',
    src: /^assets\/photo\.[0-9a-f]{8}\.avif$/,
    converted: false,
    // Chromium decodes AVIF but ffprobe 6 cannot demux it, so the import
    // reports no dimensions and the box comes from the client-side probe.
    sized: false,
    why: 'The AV1 still format, increasingly what a browser hands over.',
    encode: ['-frames:v', '1', '-c:v', 'libaom-av1', '-still-picture', '1', '-cpu-used', '8'],
  },

  // --- raster images that must be re-encoded ---
  {
    name: 'photo.heic',
    mime: 'image/heic',
    kind: 'image',
    src: /^assets\/photo\.[0-9a-f]{8}\.png$/,
    converted: true,
    sized: true,
    why: 'What an iPhone photo actually is; Chromium has no HEIC decoder.',
  },
  {
    name: 'photo.heif',
    mime: 'image/heif',
    kind: 'image',
    src: /^assets\/photo\.[0-9a-f]{8}\.png$/,
    converted: true,
    sized: true,
    why: 'The same container under its generic extension.',
  },

  // --- vector and page formats ---
  {
    name: 'diagram.svg',
    mime: 'image/svg+xml',
    kind: 'image',
    src: /^assets\/diagram\.[0-9a-f]{8}\.svg$/,
    converted: false,
    // ffprobe reports 0×0 for SVG; the renderer's own decode supplies the box.
    sized: false,
    why: 'Vector art from a plotting library or a logo, kept as vector.',
  },
  {
    name: 'paper.pdf',
    mime: 'application/pdf',
    kind: 'image',
    src: /^assets\/paper\.[0-9a-f]{8}\.pdf$/,
    converted: false,
    // Nothing probes a PDF; importAsset substitutes a page-shaped default box.
    sized: false,
    why: 'A figure dragged straight out of a paper.',
  },

  // --- videos Chromium plays as-is ---
  {
    name: 'clip.mp4',
    mime: 'video/mp4',
    kind: 'video',
    src: /^assets\/clip\.[0-9a-f]{8}\.mp4$/,
    converted: false,
    sized: true,
    why: 'H.264 in MP4 — the format everything exports to.',
    encode: ['-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
  },
  {
    name: 'clip.mov',
    mime: 'video/quicktime',
    kind: 'video',
    src: /^assets\/clip\.[0-9a-f]{8}\.mov$/,
    converted: false,
    sized: true,
    why: 'QuickTime is what macOS tools write, and H.264 inside it is fine.',
    encode: ['-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
  },
  {
    name: 'clip.m4v',
    mime: 'video/x-m4v',
    kind: 'video',
    src: /^assets\/clip\.[0-9a-f]{8}\.m4v$/,
    converted: false,
    sized: true,
    why: 'The Apple-flavoured MP4 extension.',
    encode: ['-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
  },
  {
    name: 'recording.mov',
    mime: 'video/quicktime',
    kind: 'video',
    src: /^assets\/recording\.[0-9a-f]{8}\.fs\.mov$/,
    converted: true,
    sized: true,
    why: 'An H.264 screen recording indexed at the tail, as the macOS recorder and cameras write it: '
      + 'playable, but Chromium must seek to the end before painting, so the index is moved up front.',
    encode: ['-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '-faststart'],
  },
  {
    name: 'clip.webm',
    mime: 'video/webm',
    kind: 'video',
    src: /^assets\/clip\.[0-9a-f]{8}\.webm$/,
    converted: false,
    sized: true,
    why: 'VP9 in WebM — what a browser screen recording produces.',
    encode: ['-t', '0.5', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p'],
  },
  {
    name: 'clip.mkv',
    mime: 'video/x-matroska',
    kind: 'video',
    src: /^assets\/clip\.[0-9a-f]{8}\.mkv$/,
    converted: false,
    sized: true,
    why: 'Matroska carrying a codec Chromium can already decode.',
    encode: ['-t', '0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
  },

  // --- videos that must be transcoded ---
  {
    name: 'screen.mov',
    mime: 'video/quicktime',
    kind: 'video',
    src: /^assets\/screen\.[0-9a-f]{8}\.h264\.mp4$/,
    converted: true,
    sized: true,
    why: 'A macOS screen recording is HEVC, which renders as nothing.',
    encode: ['-t', '0.5', '-c:v', 'libx265', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'],
  },
  {
    name: 'old.avi',
    mime: 'video/x-msvideo',
    kind: 'video',
    src: /^assets\/old\.[0-9a-f]{8}\.h264\.mp4$/,
    converted: true,
    sized: true,
    why: 'MPEG-4 Part 2 in AVI — common in decks that have been around.',
    encode: ['-t', '0.5', '-c:v', 'mpeg4'],
  },

  // --- refused ---
  {
    name: 'scan.tiff',
    mime: 'image/tiff',
    kind: 'image',
    src: /^assets\/scan\.[0-9a-f]{8}\.png$/,
    converted: true,
    sized: true,
    why: 'What scanners and Preview hand over; Chromium cannot decode it, so it becomes a PNG.',
    encode: ['-frames:v', '1'],
  },
  {
    name: 'figure.bmp',
    mime: 'image/bmp',
    kind: 'image',
    src: /^assets\/figure\.[0-9a-f]{8}\.png$/,
    converted: true,
    sized: true,
    why: 'Old tooling still writes BMP; re-encoded to PNG like TIFF.',
    encode: ['-frames:v', '1'],
  },
  {
    name: 'photo.jfif',
    mime: 'image/jpeg',
    kind: 'image',
    src: /^assets\/photo\.[0-9a-f]{8}\.jfif$/,
    converted: false,
    sized: true,
    why: 'Plain JPEG under the name Chrome on Windows saves web images with.',
    encode: ['-frames:v', '1', '-f', 'mjpeg'],
  },
  {
    name: 'notes.txt',
    mime: 'text/plain',
    kind: null,
    src: null,
    converted: false,
    sized: false,
    why: 'A non-media drop must be ignored, not imported or thrown over.',
  },
];

export function fixture(name: string): MediaFixture {
  const found = MEDIA_FIXTURES.find((entry) => entry.name === name);
  if (!found) throw new Error(`No media fixture named ${name}`);
  return found;
}

/**
 * Write every requested fixture into `dir` and return absolute paths by name.
 * Encoding the whole matrix takes about a second; callers that only need a few
 * formats pass their names.
 */
export async function writeMediaFixtures(
  dir: string,
  names: readonly string[] = MEDIA_FIXTURES.map((entry) => entry.name),
): Promise<Map<string, string>> {
  await mkdir(dir, { recursive: true });
  const paths = new Map<string, string>();
  await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name);
      await writeFixture(fixture(name), path);
      paths.set(name, path);
    }),
  );
  return paths;
}

async function writeFixture(entry: MediaFixture, path: string): Promise<void> {
  if (entry.encode) {
    await execFileAsync(getFfmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y', ...SOURCE, ...entry.encode, path,
    ]);
    return;
  }
  switch (entry.name) {
    case 'photo.heic':
    case 'photo.heif':
      await copyFile(join(FIXTURE_DIR, 'photo.heic'), path);
      return;
    case 'diagram.svg':
      await writeFile(path, SVG, 'utf8');
      return;
    case 'paper.pdf':
      await writeFile(path, minimalPdf());
      return;
    case 'notes.txt':
      await writeFile(path, 'Not media.\n', 'utf8');
      return;
    default:
      throw new Error(`No way to produce fixture ${entry.name}`);
  }
}

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48" viewBox="0 0 64 48">',
  '<rect width="64" height="48" fill="#2563eb"/>',
  '<circle cx="32" cy="24" r="16" fill="#fbbf24"/>',
  '</svg>',
].join('');

/**
 * A one-page PDF, hand-assembled because nothing in the toolchain writes one.
 * Byte offsets in the xref table have to match the body exactly, so they are
 * measured rather than written down.
 */
function minimalPdf(): Buffer {
  const content = '1 0 0 RG 4 w 10 10 120 85 re S\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 140 105] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xref = body.length;
  let out = body;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
