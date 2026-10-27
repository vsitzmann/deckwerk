/**
 * Media classification and the pending-upload sentinel, shared between the
 * main-process importer, the collab server and both renderers.
 *
 * A freshly dropped file appears on the slide immediately as a normal
 * image/video element whose `src` is `pending:<token>` — a real element, so
 * moving, resizing and collab sync all work while the bytes are still
 * uploading or transcoding. When the import finishes, the src is swapped for
 * the deck-relative asset path.
 */

export const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.svg', '.avif', '.pdf',
  '.heic', '.heif', '.tif', '.tiff', '.bmp',
]);

/**
 * Image formats Chromium has no decoder for, so the importer re-encodes them
 * to PNG on the way in. Dropping an iPhone photo without this produces a
 * blank rectangle: the file copies fine and the element is valid, but neither
 * the canvas nor the export can paint it.
 *
 * They are still `IMAGE_EXTS` — the drop is accepted, and the conversion is
 * an import detail, the same way an HEVC screen recording is transcoded to
 * H.264 without the author choosing that.
 */
export const CONVERTED_IMAGE_EXTS = new Set(['.heic', '.heif', '.tif', '.tiff', '.bmp']);
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.qt', '.m4v', '.webm', '.mkv', '.avi']);

/**
 * The extension a source file is kept under in `assets/`. A `.qt` is plain
 * QuickTime (Keynote keeps some movies that way), but nothing serves `.qt` as
 * video: it goes in as the `.mov` it is.
 */
export function importedVideoExtension(ext: string): string {
  return ext === '.qt' ? '.mov' : ext;
}

/** Classify by file name/path extension; null means "not droppable media". */
export function classifyMediaName(name: string): 'image' | 'video' | null {
  const m = /\.[^./\\]+$/.exec(name);
  const ext = m ? m[0].toLowerCase() : '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

/** Extensions for media a file names only by MIME type. */
const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/svg+xml': '.svg', 'image/avif': '.avif', 'image/heic': '.heic', 'image/heif': '.heif',
  'image/tiff': '.tiff', 'image/bmp': '.bmp', 'application/pdf': '.pdf',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'video/x-matroska': '.mkv', 'video/x-m4v': '.m4v',
};

/**
 * The name a dropped file should import under: its own when the extension is
 * one the importer knows, otherwise with the extension its MIME type calls
 * for, or null when it is not media at all. A drag out of Photos, a browser's
 * "save image" or a scanner hands over `image`, `photo.jfif` or `scan.tiff`
 * often enough; those used to be dropped on the floor without a word.
 */
export function mediaFileName(name: string, mimeType: string): string | null {
  if (classifyMediaName(name)) return name;
  const ext = EXTENSION_BY_TYPE[mimeType.toLowerCase()];
  return ext ? `${name}${ext}` : null;
}

const PENDING_PREFIX = 'pending:';

/** The file name rides in the src so collab peers can label the placeholder. */
export function makePendingSrc(token: string, name: string): string {
  return `${PENDING_PREFIX}${token}:${encodeURIComponent(name)}`;
}

export function isPendingSrc(src: string): boolean {
  return src.startsWith(PENDING_PREFIX);
}

/** The token of a pending src, or null for a real asset path. */
export function pendingToken(src: string): string | null {
  if (!isPendingSrc(src)) return null;
  return src.slice(PENDING_PREFIX.length).split(':')[0];
}

/** The original file name of a pending src, for the placeholder label. */
export function pendingName(src: string): string {
  if (!isPendingSrc(src)) return '';
  const rest = src.slice(PENDING_PREFIX.length);
  const sep = rest.indexOf(':');
  return sep === -1 ? '' : decodeURIComponent(rest.slice(sep + 1));
}

/**
 * Longest asset file stem kept, in UTF-8 bytes. A dropped file keeps its
 * name, and a name can be a whole URL (a Keynote deck carried a
 * 248-character hex-encoded one): with the content hash and a derived suffix
 * (`.h264.mp4`) added, or a copier's temporary `.<pid>.copy-tmp`, it passed
 * the 255-byte limit on a file name and the write failed with ENAMETOOLONG.
 * The Keynote importer caps its names the same way (MAX_ASSET_STEM_BYTES).
 */
export const MAX_ASSET_STEM_BYTES = 80;

/** `stem`, or its beginning and a hash of the whole when it is too long. */
export function capAssetStem(stem: string, max = MAX_ASSET_STEM_BYTES): string {
  const encoder = new TextEncoder();
  if (encoder.encode(stem).length <= max) return stem;
  const digest = fnv1a(stem);
  let cut = '';
  for (const char of stem) {
    if (encoder.encode(cut + char).length > max - digest.length - 1) break;
    cut += char;
  }
  return `${cut.replace(/[-.]+$/, '')}-${digest}`;
}

/** A file name with its stem capped (`capAssetStem`) and its extension kept. */
export function capAssetFileName(name: string, max = MAX_ASSET_STEM_BYTES): string {
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? '';
  const stem = name.slice(0, name.length - ext.length);
  return stem ? capAssetStem(stem, max) + ext : capAssetStem(name, max);
}

/** 32-bit FNV-1a as eight hex digits: short, stable, and in every runtime. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The names `importAsset` gives a file it copies into `assets/`: the dropped
 * original under its stem and an 8-hex content hash, and the browser-ready
 * copies it derives from that original when Chromium cannot use it as-is.
 * The importer writes through these and `originalAssetCandidates` reads them
 * back, so "Download original" cannot drift from what the import produced.
 */
export const importedAssetName = {
  original: (stem: string, hash: string, ext: string): string => `${stem}.${hash}${ext}`,
  /** An image format Chromium cannot decode (`CONVERTED_IMAGE_EXTS`), as PNG. */
  convertedImage: (stem: string, hash: string): string => `${stem}.${hash}.png`,
  /** A video in a codec Chromium cannot play, transcoded to H.264. */
  h264: (stem: string, hash: string): string => `${stem}.${hash}.h264.mp4`,
  /** A playable video with its index moved to the front, byte for byte otherwise. */
  fastStart: (stem: string, hash: string, ext: string): string => `${stem}.${hash}.fs${ext}`,
};

const HASH = '[0-9a-f]{8}';

/** Each derived name, and the originals it can have been made from. */
const DERIVED_NAMES: Array<{
  pattern: RegExp;
  originals: (stem: string, hash: string, ext: string) => string[];
}> = [
  {
    pattern: new RegExp(`^(.+)\\.(${HASH})\\.h264\\.mp4$`),
    originals: (stem, hash) => [...VIDEO_EXTS].map((ext) => importedAssetName.original(stem, hash, ext)),
  },
  {
    pattern: new RegExp(`^(.+)\\.(${HASH})\\.fs(\\.[a-z0-9]+)$`),
    originals: (stem, hash, ext) => [importedAssetName.original(stem, hash, ext)],
  },
  {
    pattern: new RegExp(`^(.+)\\.(${HASH})\\.png$`),
    originals: (stem, hash) => [...CONVERTED_IMAGE_EXTS].map((ext) => importedAssetName.original(stem, hash, ext)),
  },
];

/**
 * The deck-relative paths that may hold the untouched file an element's `src`
 * was imported from, best first, ending with `src` itself.
 *
 * An element shows the importer's browser-ready copy (`photo.<hash>.png` for
 * an iPhone HEIC, `clip.<hash>.h264.mp4` for an HEVC recording), while the
 * file the author dropped stays beside it as `<stem>.<hash><ext>`. Which
 * extension it had is recorded nowhere but the folder, so the caller takes
 * the first candidate that exists. A src no derived name matches is its own
 * original, and so is a plain PNG import, whose hash names no HEIC.
 */
export function originalAssetCandidates(src: string): string[] {
  const slash = src.lastIndexOf('/');
  const dir = src.slice(0, slash + 1);
  const name = src.slice(slash + 1);
  for (const derived of DERIVED_NAMES) {
    const match = derived.pattern.exec(name);
    if (match) return [...derived.originals(match[1], match[2], match[3] ?? '').map((n) => dir + n), src];
  }
  return [src];
}

/**
 * The file name an original is saved under: the author's own name, without
 * the content hash the importer added (`photo.1a2b3c4d.heic` → `photo.heic`).
 */
export function originalDownloadName(originalSrc: string): string {
  const name = originalSrc.slice(originalSrc.lastIndexOf('/') + 1);
  const match = new RegExp(`^(.+)\\.${HASH}(\\.[^./]+)$`).exec(name);
  return match ? match[1] + match[2] : name;
}
