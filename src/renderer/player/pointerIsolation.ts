/**
 * Controls drawn over a presented slide (a wipe divider, a group scrubber)
 * belong to the presenter's hand, not to the deck. The present pages advance
 * on a window `click`, retreat on a right `mousedown` and go fullscreen on a
 * `dblclick`, all in the bubble phase, so stopping those at the control keeps
 * a press on it from also changing the slide. `mousedown` is also cancelled,
 * so the press neither starts a text selection (which would then veto the
 * next real advance) nor moves focus onto the control, where the next Space
 * would press it again instead of advancing.
 */
const STOPPED = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'] as const;

export function isolatePointer(control: HTMLElement): () => void {
  const stop = (event: Event): void => {
    event.stopPropagation();
    if (event.type === 'mousedown') event.preventDefault();
  };
  for (const type of STOPPED) control.addEventListener(type, stop);
  return () => {
    for (const type of STOPPED) control.removeEventListener(type, stop);
  };
}

/**
 * Swallow the click that ends a drag. A drag that starts on a control and is
 * released off it produces a click on the nearest common ancestor -- the
 * slide -- which the control never sees and which would advance the deck. The
 * click is dispatched in the same task as the pointerup that calls this, so
 * the guard is gone again before any later, genuine click.
 */
export function suppressNextClick(): void {
  const swallow = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}
