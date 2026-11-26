import type { PlaybackHost } from './buildPreview.js';

/** Reuse the player page inside the editor, retaining its live state underneath. */
export function presentInEditorWindow(
  slideIndex: number,
  endSlideIndex: number | undefined,
  onEnd: (slideIndex: number) => void,
  playbackHost?: PlaybackHost,
): void {
  if (document.querySelector('.in-window-presentation')) return;
  const frame = document.createElement('iframe');
  frame.className = 'in-window-presentation';
  frame.title = 'Presentation';
  const url = new URL('../present/index.html', location.href);
  url.searchParams.set('slide', String(slideIndex));
  url.searchParams.set('embed', '1');
  if (endSlideIndex !== undefined) url.searchParams.set('endSlide', String(endSlideIndex));
  frame.src = url.href;
  const playback = playbackHost?.beginPlayback(() => {});
  if (playback) frame.dataset.editorPresentation = 'true';
  frame.style.cssText = `position:${playback ? 'absolute' : 'fixed'};inset:0;width:100%;height:100%;border:0;background:#000;z-index:9999`;
  const end = (): void => {
    window.removeEventListener('message', onMessage);
    window.removeEventListener('keydown', onKey, true);
    frame.remove();
    playback?.end();
    onEnd(shown);
    window.focus();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    end();
  };
  let shown = slideIndex;
  const onMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) return;
    if (event.data?.type === 'present-at' && Number.isInteger(event.data.slideIndex)) shown = event.data.slideIndex;
    if (event.data?.type !== 'present-exit') return;
    end();
  };
  window.addEventListener('message', onMessage);
  if (playback) window.addEventListener('keydown', onKey, true);
  (playback?.surface ?? document.body).appendChild(frame);
  frame.focus();
}
