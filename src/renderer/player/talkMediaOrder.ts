import type { Slide } from '@shared/deck.js';
import { isPendingSrc } from '@shared/media.js';

/** How many presentable slides ahead get their clips first (the Player's lookahead). */
export const WARM_AHEAD_SLIDES = 2;
/**
 * How many presentable slides ahead have their pictures fetched into memory
 * before any clip is (with a blob cache). Pictures are what a slide is
 * missing when it appears, and cheap next to clips.
 */
export const IMAGE_FIRST_SLIDES = 4;

/** A deck's media as network URLs, most urgent first, and which of them are pictures. */
export interface TalkMediaOrder {
  urls: string[];
  images: string[];
}

/**
 * The talk's media in the order a presentation standing on slide `here`
 * needs it, as network URLs. Pictures before clips wherever both are near:
 *
 * 1. the pictures of the slide on screen and of the next few slides, which
 *    a slide is missing the moment it appears;
 * 2. the clips of the next two slides (what the talk reaches soonest), then
 *    the slide on screen's, whose elements are already streaming them but
 *    whose revisits and loops should not have to;
 * 3. every other picture of the talk, ahead then behind, nearest first:
 *    cheap next to clips, and once in memory a slide never waits for one;
 * 4. the rest of the clips, ahead then behind.
 *
 * Skipped slides are not part of the talk. The Player's blob cache fetches
 * in this order (player.ts), and so does the editor's offline copy
 * (collab/offlineCopy.ts), so both spend the link the same way.
 */
export function talkMediaOrder(slides: Slide[], here: number, networkSrc: (src: string) => string): TalkMediaOrder {
  const ahead: number[] = [];
  const behind: number[] = [];
  for (let i = here + 1; i < slides.length; i += 1) if (!slides[i].skipped) ahead.push(i);
  for (let i = here - 1; i >= 0; i -= 1) if (!slides[i].skipped) behind.push(i);
  const images: string[] = [];
  const picturesOf = (indices: number[]): string[] => {
    const urls: string[] = [];
    for (const index of indices) {
      const slide = slides[index];
      if (!slide) continue;
      const srcs = [
        slide.background.image,
        ...slide.elements.map((el) => (el.type === 'image' && !/\.pdf(?:$|[?#])/i.test(el.src) ? el.src : null)),
        ...slide.elements.map((el) => (el.type === 'web' || el.type === 'video' ? el.poster : null)),
      ];
      for (const src of srcs) if (src && !isPendingSrc(src)) urls.push(networkSrc(src));
    }
    images.push(...urls);
    return urls;
  };
  const clipsOf = (indices: number[]): string[] => indices.flatMap((index) => (slides[index]?.elements ?? [])
    .flatMap((el) => (el.type === 'video' && !isPendingSrc(el.src) ? [networkSrc(el.src)] : [])));
  const urls = [
    ...picturesOf([here, ...ahead.slice(0, IMAGE_FIRST_SLIDES)]),
    ...clipsOf([...ahead.slice(0, WARM_AHEAD_SLIDES), here]),
    ...picturesOf([...ahead.slice(IMAGE_FIRST_SLIDES), ...behind]),
    ...clipsOf([...ahead.slice(WARM_AHEAD_SLIDES), ...behind]),
  ];
  return { urls, images };
}
