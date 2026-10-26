import { MediaBlobCache } from '../player/mediaBlobCache.js';
import {
  fillVideosFromMemory,
  mediaStackReusesBytes,
  setVideoMemory,
  type VideoMemory,
  type VideoMemoryMode,
} from '../player/videoMemory.js';
import { isMediaPending } from './mediaVariants.js';

/**
 * The collab editor's clips, held whole in memory in a browser whose media
 * stack re-downloads a clip for every `<video>` it opens (videoMemory.ts).
 *
 * The canvas shows a clip paused on a frame until somebody plays it, so a
 * file is fetched once, whole, the first time a slide shows it, one file at a
 * time in the order slides asked, and every element built for it afterwards
 * — slide changes, edits, a collaborator's edits, coming back from
 * presenting — reads the same `blob:` URL. The presentation the editor
 * embeds borrows these blobs rather than downloading the clips again
 * (present.ts).
 */

/** Past this a file streams: holding it would cost the whole file to show one paused frame. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
/** Clips kept, most recently shown first. */
const MAX_REMEMBERED = 200;

/** The page's memory, for a presentation it embeds to borrow from (present.ts). */
export interface LendingVideoMemory {
  objectUrl(url: string): string | undefined;
}

declare global {
  interface Window {
    deckwerkVideoMemory?: LendingVideoMemory;
  }
}

export class EditorVideoMemory implements VideoMemory {
  private readonly blobs = new MediaBlobCache({ maxFileBytes: MAX_FILE_BYTES });
  /** Network URLs most recently shown first: the cache's order, and what it evicts last. */
  private order: string[] = [];

  constructor(private readonly deckId: string) {
    this.blobs.onReady((url) => fillVideosFromMemory(url, this.blobs.objectUrl(url) ?? null));
    this.blobs.onGiveUp((url) => fillVideosFromMemory(url, null));
    // Never revoke a URL an element still reads: on the page, or in the
    // presentation it embeds, which borrows these blobs.
    this.blobs.setInUse((objectUrl) => readers().some((video) => video.getAttribute('src') === objectUrl));
  }

  mode(url: string, assetSrc: string): VideoMemoryMode {
    if (this.blobs.objectUrl(url)) return 'memory';
    if (isMediaPending(assetSrc)) return 'still';
    return this.blobs.covers(url) ? 'memory' : 'network';
  }

  objectUrl(url: string): string | undefined {
    return this.blobs.objectUrl(url);
  }

  request(url: string): void {
    this.order = [url, ...this.order.filter((known) => known !== url)].slice(0, MAX_REMEMBERED);
    this.blobs.want(this.order);
  }

  still(assetSrc: string, time: number): string | null {
    return `/api/video-still?deck=${encodeURIComponent(this.deckId)}&src=${encodeURIComponent(assetSrc)}&t=${time}`;
  }
}

function readers(): HTMLVideoElement[] {
  const videos = [...document.querySelectorAll('video')];
  for (const frame of document.querySelectorAll('iframe')) {
    try {
      videos.push(...(frame.contentDocument?.querySelectorAll('video') ?? []));
    } catch {
      // Another origin's frame cannot hold our blobs.
    }
  }
  return videos;
}

/** Install the editor's video memory where the media stack needs it; returns it, or null. */
export function installEditorVideoMemory(deckId: string): EditorVideoMemory | null {
  if (mediaStackReusesBytes()) return null;
  const memory = new EditorVideoMemory(deckId);
  setVideoMemory(memory);
  window.deckwerkVideoMemory = memory;
  return memory;
}
