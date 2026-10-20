import type { Player } from './player.js';
import { videoRateChangeForKey, type VideoRateChange } from './videoRate.js';

/**
 * The presenting key map, shared by the present window and the export bundle so
 * the keys behave identically whether or not the app is installed.
 */
export interface KeyHandlers {
  onExit?: () => void;
  onOverview?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  onHome?: () => void;
  /** Video speed changed from the keyboard, for a shell that relays it elsewhere. */
  onVideoRate?: (change: VideoRateChange) => void;
}

export function bindPresentKeys(
  target: Window | HTMLElement,
  player: Player,
  handlers: KeyHandlers = {},
): () => void {
  const onKey = (ev: Event) => {
    const e = ev as KeyboardEvent;
    // Never steal keys from a focused field; the editor preview shares this map.
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
      return;
    }

    const rateChange = videoRateChangeForKey(e.key);
    if (rateChange) {
      e.preventDefault();
      if (handlers.onVideoRate) handlers.onVideoRate(rateChange);
      else player.changeVideoRate(rateChange);
      return;
    }

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case ' ':
      case 'PageDown':
      case 'Enter':
        e.preventDefault();
        if (handlers.onNext) handlers.onNext();
        else player.next();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
      case 'Backspace':
        e.preventDefault();
        if (handlers.onPrev) handlers.onPrev();
        else player.prev();
        break;
      case 'Home':
        e.preventDefault();
        if (handlers.onHome) handlers.onHome();
        else player.goToSlide(0);
        break;
      case 'b':
      case 'B':
        e.preventDefault();
        player.toggleBlank();
        break;
      case 'Escape':
        e.preventDefault();
        handlers.onExit?.();
        break;
      case 'o':
      case 'O':
        e.preventDefault();
        handlers.onOverview?.();
        break;
    }
  };

  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
