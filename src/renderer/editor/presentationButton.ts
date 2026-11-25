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
  return createToolbarSplitButton(
    'Present',
    () => start(selected === 'speaker', selected === 'speaker' ? 'fullscreen' : selected),
    modes.map(({ label, mode }) => ({
      label,
      checked: () => selected === mode,
      action: () => { selected = mode; },
    })),
    { variant: 'primary', menuLabel: 'Presentation options' },
  );
}
