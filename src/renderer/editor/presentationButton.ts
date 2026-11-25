import { createToolbarSplitButton } from './exportPicker.js';

type PresentationMode = 'fullscreen' | 'windowed' | 'editor' | 'speaker';

/** The dropdown chooses a mode; only the main button starts playback. */
export function createPresentationButton(
  start: (speakerView: boolean, mode: 'fullscreen' | 'windowed' | 'editor') => void,
): HTMLElement {
  let selected: PresentationMode = 'fullscreen';
  const modes: Array<{ label: string; mode: PresentationMode }> = [
    { label: 'Fullscreen', mode: 'fullscreen' },
    { label: 'In Window', mode: 'windowed' },
    { label: 'In Editor', mode: 'editor' },
    { label: 'Speaker View', mode: 'speaker' },
  ];
  const control = createToolbarSplitButton(
    'Present',
    () => start(selected === 'speaker', selected === 'speaker' ? 'fullscreen' : selected),
    modes.map(({ label, mode }) => ({
      label,
      checked: () => selected === mode,
      action: () => { selected = mode; },
    })),
    { variant: 'primary', menuLabel: 'Presentation options' },
  );
  const button = control.querySelector<HTMLButtonElement>('.toolbar-split-main')!;
  button.dataset.action = 'present';
  button.setAttribute('aria-keyshortcuts', 'Alt+Meta+P');
  button.title = 'Present (⌥⌘P)';
  return control;
}

/** Use the same button action so the shortcut honours the selected mode. */
export function handlePresentationShortcut(event: KeyboardEvent): boolean {
  // Option changes the printable key on macOS (P becomes π), so use its code.
  if (!event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey || event.code !== 'KeyP') return false;
  const button = document.querySelector<HTMLButtonElement>('button[data-action="present"]');
  if (!button || button.disabled) return false;
  event.preventDefault();
  if (!event.repeat) button.click();
  return true;
}
