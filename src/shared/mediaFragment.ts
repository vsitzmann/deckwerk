/**
 * W3C media fragments on a video `src` (`assets/clip.mp4#t=15.0,20.0`).
 *
 * The deck keeps a clip's trim in `start`/`end` and its file in a clean `src`.
 * A fragment still reaches us — an exported page puts the in-point on its
 * `<video src>` so the static page previews the right frame, and hand-written
 * pages and JSON use the browser's own syntax — so every reader turns one
 * into the trim and the bare file name.
 */

const TIME_FRAGMENT = /#t=(?:npt:)?([^#,]*)(?:,([^#]*))?$/;

/** The file a `src` names, without a time fragment. */
export function withoutFragment(src: string): string {
  return src.replace(/#t=[^#]*$/, '');
}

/** The trim a time fragment asks for, or null when `src` carries none. */
export function mediaFragmentTrim(src: string): { start: number; end: number | null } | null {
  const match = TIME_FRAGMENT.exec(src);
  if (!match) return null;
  const start = match[1] === '' ? 0 : clockSeconds(match[1]);
  const end = match[2] === undefined || match[2] === '' ? null : clockSeconds(match[2]);
  if (start === null || (match[2] !== undefined && match[2] !== '' && end === null)) return null;
  return { start, end: end !== null && end > start ? end : null };
}

/** `15`, `15.5`, `1:05` or `0:01:05.5` in seconds; null when it is none of them. */
function clockSeconds(text: string): number | null {
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}
