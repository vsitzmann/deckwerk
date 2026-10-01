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
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);

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
