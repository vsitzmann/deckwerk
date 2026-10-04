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

/** What Chromium prints when it finds no sandbox it can use, and aborts. */
const NO_SANDBOX = [
  /setuid_sandbox_host\.cc.*FATAL|FATAL:setuid_sandbox_host/,
  /The SUID sandbox helper binary was found, but is not configured correctly/,
  /No usable sandbox!/,
  /zygote_host_impl_linux\.cc.*Check failed/,
];

/**
 * Why an Electron helper died before doing anything, in terms someone can act on.
 *
 * Chromium refuses to run without its sandbox, which on Linux needs either
 * unprivileged user namespaces or a root-owned setuid `chrome-sandbox`. A
 * service that may create neither — a systemd unit with
 * `RestrictNamespaces=yes`, a syscall filter that blocks chroot(2) or
 * capset(2), a container, an AppArmor policy against user namespaces — gets a
 * FATAL line from deep inside Chromium and nothing else. On the collaboration
 * server that meant every agent save, render and page check answered 500 with
 * that line, and the bridge reported only "sync failed (500)".
 */
export function electronFailure(stderr: string, fallback: string): Error {
  const text = stderr.trim();
  if (NO_SANDBOX.some((pattern) => pattern.test(text))) {
    const fatal = text.split('\n').find((line) => /FATAL|Check failed|No usable sandbox/.test(line))?.trim();
    return new Error(
      'The headless browser could not start: Chromium found no sandbox it is allowed to use. '
      + 'It needs to create user namespaces (or a root-owned setuid chrome-sandbox), and this process may not — '
      + 'typically a systemd unit with RestrictNamespaces=yes or a syscall filter that blocks chroot/capset, '
      + 'a container, or a kernel/AppArmor policy against unprivileged user namespaces. '
      + 'Compiling, rendering and checking pages all need it; see "Running under systemd" in docs/collab.md.'
      + (fatal ? ` (${fatal.replace(/^\[[^\]]*\]\s*/, '').slice(0, 240)})` : ''),
    );
  }
  return new Error(text || fallback);
}
