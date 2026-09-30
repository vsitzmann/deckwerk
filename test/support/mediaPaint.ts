/** How dropped media is read back out of a browser editor, shared by the media browser suites. */

export interface Landed {
  id: string;
  type: string;
  src: string;
  w: number;
  h: number;
}

export interface Painted {
  tag: string;
  ok: boolean;
  detail: string;
}

/**
 * Whether each element's media has really decoded in the page.
 *
 * Scoped to `#canvas`: the slide rail renders the same elements as thumbnails
 * and shows a video as a poster `<img>`, so an unscoped lookup reports every
 * video as a painted image and the branch assertions all pass wrongly.
 */
export const PAINT_READER = `((ids) => ids.map((id) => {
  const host = document.querySelector('#canvas [data-element-id="' + id + '"]');
  const img = host?.querySelector('img');
  if (img) return {
    tag: 'img',
    ok: img.complete === true && img.naturalWidth > 0,
    detail: img.naturalWidth + 'x' + img.naturalHeight,
  };
  const video = host?.querySelector('video');
  if (video) return {
    tag: 'video',
    ok: video.readyState >= 1 && video.videoWidth > 0,
    detail: video.videoWidth + 'x' + video.videoHeight,
  };
  const embed = host?.querySelector('embed');
  // A plugin surface exposes no decode state; that it exists, is typed as a
  // PDF and has a box is all the page can tell us.
  if (embed) return {
    tag: 'embed',
    ok: embed.type === 'application/pdf' && embed.getBoundingClientRect().width > 0,
    detail: embed.type,
  };
  return { tag: String(host?.firstElementChild?.tagName ?? 'missing'), ok: false, detail: '' };
}))`;

export const READ_MEDIA = `(() => window.store.get().deck.slides[0].elements
  .filter((el) => el.type === 'image' || el.type === 'video')
  .map((el) => ({ id: el.id, type: el.type, src: el.src, w: el.w, h: el.h })))()`;
