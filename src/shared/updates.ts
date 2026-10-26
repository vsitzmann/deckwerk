/**
 * Updating the desktop app: which way a given install updates, and whether
 * a release is newer than the running one. Pure, so the decisions are unit-tested without Electron; the main
 * process (src/main/updates.ts) wires them to electron-updater and the
 * renderer (src/renderer/editor/updateDialog.ts) to the DeckWerk menu.
 */

export const UPDATE_IPC = {
  /** Renderer → main: what this install can do, and where a check stands. */
  state: 'updates:state',
  /** Renderer → main: ask the release feed; resolves with an UpdateCheckResult. */
  check: 'updates:check',
  /** Renderer → main: download the release a check found. */
  download: 'updates:download',
  /** Main → renderer: download progress, as a 0–1 ratio. */
  progress: 'updates:progress',
  /** Renderer → main: quit and install, once every window has saved. */
  install: 'updates:install',
  /** Renderer → main: open the release page in the browser. */
  openReleasePage: 'updates:openReleasePage',
  /** Main → renderer: the native app menu's "Check for Updates…" was chosen. */
  menuCheck: 'updates:menuCheck',
  /** Main → renderer: save everything now; answered on `flushed`. */
  flush: 'updates:flush',
  /** Renderer → main: the answer to `flush`. */
  flushed: 'updates:flushed',
} as const;

export const RELEASES_URL = 'https://github.com/vsitzmann/deckwerk/releases';

/** The release page for a version, or the list of releases when none is known. */
export function releasePageUrl(version?: string | null): string {
  return version ? `${RELEASES_URL}/tag/v${version}` : `${RELEASES_URL}/latest`;
}

/**
 * How this install updates.
 * - `auto`: electron-updater downloads and installs (Squirrel.Mac, NSIS, AppImage).
 * - `release-page`: no self-update; the menu opens the release page (.deb,
 *   tar.gz, Flatpak — a package manager owns those files).
 * - `none`: nothing to update — a development run or an unpackaged checkout.
 */
export type UpdateMode =
  | { kind: 'auto'; channel: 'mac' | 'nsis' | 'appimage' }
  | { kind: 'release-page' }
  | { kind: 'none'; reason: 'development' };

export interface InstallFacts {
  platform: string;
  isPackaged: boolean;
  /** `process.env.APPIMAGE`: set by the AppImage runtime to the image's path. */
  appImage?: string;
  /** `process.env.FLATPAK_ID`: set inside every Flatpak sandbox. */
  flatpakId?: string;
  /** A feed override (`DECKWERK_UPDATE_FEED`), which makes an unpackaged run behave as packaged. */
  feedOverride?: string;
}

export function updateMode(facts: InstallFacts): UpdateMode {
  if (!facts.isPackaged && !facts.feedOverride) return { kind: 'none', reason: 'development' };
  if (facts.platform === 'darwin') return { kind: 'auto', channel: 'mac' };
  if (facts.platform === 'win32') return { kind: 'auto', channel: 'nsis' };
  // Flatpak first: the sandbox can carry an AppImage-looking environment from
  // the host, but the files inside it belong to flatpak, which updates them.
  if (facts.flatpakId) return { kind: 'release-page' };
  if (facts.appImage) return { kind: 'auto', channel: 'appimage' };
  // A .deb (or the tar.gz tree) is owned by the system package manager or
  // by whoever unpacked it; replacing files under /opt would fight dpkg.
  return { kind: 'release-page' };
}

interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  };
}

/** Semver precedence: negative, zero or positive; null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }
  // A release outranks every prerelease of the same version.
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l) ? Number(l) : null;
    const rn = /^\d+$/.test(r) ? Number(r) : null;
    if (ln !== null && rn !== null) {
      if (ln !== rn) return ln - rn;
    } else if (ln !== null) {
      return -1;
    } else if (rn !== null) {
      return 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/** Whether `candidate` is a newer release than `current`; never true for garbage. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const order = compareVersions(candidate, current);
  return order !== null && order > 0;
}

export interface UpdateRelease {
  version: string;
  /** Release notes as the feed gave them: HTML from GitHub, or plain text. */
  notes: string;
  releaseDate: string | null;
  pageUrl: string;
}

export interface UpdateState {
  currentVersion: string;
  mode: UpdateMode;
  /** The newer release a check found, if any. */
  available: UpdateRelease | null;
  downloading: boolean;
  /** The found release is downloaded and installs when the person restarts into it. */
  downloaded: boolean;
}

export type UpdateCheckResult =
  | { kind: 'available'; release: UpdateRelease }
  | { kind: 'latest'; currentVersion: string }
  | { kind: 'release-page'; url: string }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string };

export type UpdateDownloadResult = { ok: true } | { ok: false; message: string };

export type UpdateInstallResult = { ok: true } | { ok: false; message: string };

/** One editor window's answer to `flush`: whether it is saved now. */
export interface UpdateFlushReply {
  token: string;
  clean: boolean;
  /** The deck that could not be saved, to name it in the refusal. */
  deckName?: string;
}

/** Why a restart must wait, or null when every window is saved. */
export function restartBlocker(replies: readonly (UpdateFlushReply | null)[], presenting: boolean): string | null {
  if (presenting) return 'End the presentation before restarting to update.';
  const unsaved = replies.filter((reply) => !reply?.clean);
  if (unsaved.length === 0) return null;
  const names = unsaved.map((reply) => reply?.deckName).filter((name): name is string => Boolean(name));
  return names.length > 0
    ? `${names.join(', ')} could not be saved, so DeckWerk did not restart. Your changes are still open.`
    : 'A window could not confirm its changes were saved, so DeckWerk did not restart.';
}

/**
 * Release notes for the update dialog, from the feed's form: GitHub hands
 * electron-updater the release body as HTML, a generic feed may give text or
 * a per-version list.
 */
export function releaseNotesText(notes: unknown): string {
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((entry) => (entry && typeof entry === 'object' && typeof (entry as { note?: unknown }).note === 'string'
        ? (entry as { note: string }).note
        : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
