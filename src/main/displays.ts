import { screen, type Display } from 'electron';

/**
 * The displays a presentation can use, with one seam for integration tests.
 *
 * Presenting with Speaker View, and switching which display shows what, only
 * happens with two displays, and the machines tests run on have one. When
 * `DECKWERK_TEST_DISPLAYS` is `2`, the real primary display is reported as two
 * side-by-side halves (the left one primary), so the real IPC handlers and
 * windows run a two-display show instead of being stubbed out wholesale. The
 * same pattern as `DECKWERK_TEST_DIALOGS` in dialogs.ts.
 */
export function presentationScreens(): { displays: Display[]; primary: Display } {
  const primary = screen.getPrimaryDisplay();
  if (process.env['DECKWERK_TEST_DISPLAYS'] !== '2') {
    return { displays: screen.getAllDisplays(), primary };
  }
  const { x, y, width, height } = primary.bounds;
  const half = Math.floor(width / 2);
  const left: Display = {
    ...primary,
    bounds: { x, y, width: half, height },
    workArea: { x, y, width: half, height },
    size: { width: half, height },
    workAreaSize: { width: half, height },
    label: 'Test laptop',
    internal: true,
  };
  const right: Display = {
    ...left,
    id: primary.id + 1,
    bounds: { x: x + half, y, width: width - half, height },
    workArea: { x: x + half, y, width: width - half, height },
    size: { width: width - half, height },
    workAreaSize: { width: width - half, height },
    label: 'Test projector',
    internal: false,
  };
  return { displays: [left, right], primary: left };
}
