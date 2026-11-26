/** Send rail navigation only to a presentation playing inside the editor canvas. */
export function jumpToEditorPresentation(slideIndex: number): boolean {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[data-editor-presentation]');
  if (!frame?.contentWindow) return false;
  frame.contentWindow.postMessage({ type: 'editor-present-go-to', slideIndex }, location.origin);
  frame.contentWindow.focus();
  return true;
}

/** The embedded player accepts navigation from its own editor, never another tab. */
export function bindEditorPresentationNavigation(goToSlide: (index: number) => void): void {
  window.addEventListener('message', (event: MessageEvent) => {
    if (window.parent === window || event.source !== window.parent || event.origin !== location.origin) return;
    if (event.data?.type !== 'editor-present-go-to') return;
    const index: unknown = event.data.slideIndex;
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) goToSlide(index);
  });
}
