/** How long the presentation cursor stays after the mouse stops moving. */
export const CURSOR_IDLE_MS = 1000;

/**
 * The presentation cursor shows while the mouse moves and hides once it has
 * been still for `delayMs`, so it never sits on the slide during a talk.
 * Hiding is a class on `target`; the page's CSS decides what hidden means.
 * Returns a function that removes the listeners.
 */
export function hideCursorWhenIdle(target: HTMLElement, delayMs = CURSOR_IDLE_MS): () => void {
  let timer = 0;
  const hide = () => {
    timer = 0;
    target.classList.add('cursor-idle');
  };
  const wake = () => {
    target.classList.remove('cursor-idle');
    window.clearTimeout(timer);
    timer = window.setTimeout(hide, delayMs);
  };
  hide();
  window.addEventListener('mousemove', wake);
  window.addEventListener('mousedown', wake);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('mousemove', wake);
    window.removeEventListener('mousedown', wake);
  };
}
