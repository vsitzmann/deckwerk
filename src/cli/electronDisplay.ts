/**
 * Switches for spawning an Electron helper on a machine without a display.
 *
 * On a headless Linux server (the collaboration server under systemd, over
 * ssh) Electron's default X11/Wayland platform refuses to start with "Missing
 * X server or $DISPLAY". Every helper we spawn renders offscreen, so Ozone's
 * headless platform is all it needs. The switch goes after the job arguments:
 * the helper scripts read their job from a fixed `process.argv` index.
 */
export function headlessElectronArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== 'linux') return [];
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return [];
  return ['--ozone-platform=headless'];
}
