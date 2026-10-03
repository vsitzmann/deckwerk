import { classifyMediaName } from './media.js';

/**
 * Local file paths named by a file manager's Copy.
 *
 * Nautilus, Dolphin, Finder and Explorer put no bytes on the clipboard, only
 * references to the files: a `text/uri-list` (RFC 2483: one URI per line,
 * `#` comments), GNOME's `x-special/gnome-copied-files` (the same list after
 * a `copy`/`cut` line), or a single macOS `public.file-url`. Anything that is
 * not a `file:` URL is ignored, so a copied web link never reads as a file.
 */
export function clipboardFilePaths(list: string, platform: string = process.platform): string[] {
  const paths: string[] = [];
  for (const raw of list.replace(/\0+$/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.toLowerCase().startsWith('file:')) continue;
    try {
      const url = new URL(line);
      if (url.host && url.host !== 'localhost') continue;
      let path = decodeURIComponent(url.pathname);
      // file:///C:/Users/... is a Windows drive path, not a root-level folder.
      if (platform === 'win32' && /^\/[a-z]:/i.test(path)) path = path.slice(1).replace(/\//g, '\\');
      paths.push(path);
    } catch {
      // A malformed line is simply not a file.
    }
  }
  return paths;
}

/** The first copied file the media importer accepts, or null. */
export function firstClipboardMediaPath(paths: readonly string[]): string | null {
  return paths.find((path) => classifyMediaName(path) !== null) ?? null;
}
