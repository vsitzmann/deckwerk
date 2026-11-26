import { slideProgress } from '@shared/slideNumbering.js';
import type { PresentationState } from '@shared/ipc.js';

export function formatElapsed(now: number, startedAt: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatWallClock(date: Date, locale?: string): string {
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

export function presentationLabel(state: PresentationState, slides: readonly { skipped?: boolean }[]): string {
  const { number, total } = slideProgress(slides, state.cursor.slide);
  return `Slide ${number ?? '—'} / ${total} · Build ${state.cursor.step + 1} / ${state.steps}`;
}
