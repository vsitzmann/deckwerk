import {
  shouldCheckAtLaunch,
  type UpdateCheckResult,
  type UpdateRelease,
} from '@shared/updates.js';
import { showConfirmDialog } from './confirmDialog.js';
import type { ToolbarPickerEntry } from './exportPicker.js';
import type { OperationHandle } from './operationProgress.js';

/**
 * "Check for Updates…" in the DeckWerk menu, the quiet daily check at launch,
 * and the dialogs between finding a release and restarting into it. The main
 * process does the checking and installing (src/main/updates.ts); this side
 * decides what to show. Only the desktop app has `window.api.updates`, so
 * the browser editor's DeckWerk menu never offers any of it.
 *
 * Whether to check automatically is a per-machine preference in localStorage,
 * like Appearance and Interface size beside it in the same menu.
 */

const AUTOMATIC_KEY = 'deckwerk.updates.automatic';
const LAST_CHECK_KEY = 'deckwerk.updates.lastCheck';
/** Let the deck open first: the launch check is never what someone is waiting for. */
const LAUNCH_DELAY_MS = 8000;

export interface UpdateHost {
  /** The shared status-bar activity indicator (DelayedOperationProgress). */
  beginOperation: (message: string) => OperationHandle;
  /** A message left in the status bar once the work is done. */
  setStatus: (message: string) => void;
}

let host: UpdateHost | null = null;

type UpdatesApi = NonNullable<Window['api']['updates']>;

function updatesApi(): UpdatesApi | null {
  return (window as { api?: { updates?: UpdatesApi } }).api?.updates ?? null;
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // A locked-down profile keeps the choice for this window only.
  }
}

export function automaticUpdateChecks(): boolean {
  return readStorage(AUTOMATIC_KEY) !== 'off';
}

function setAutomaticUpdateChecks(enabled: boolean): void {
  writeStorage(AUTOMATIC_KEY, enabled ? null : 'off');
}

/** The DeckWerk menu's update entries: empty outside the desktop app. */
export function updateMenuEntries(): { check: ToolbarPickerEntry[]; settings: ToolbarPickerEntry[] } {
  if (!updatesApi()) return { check: [], settings: [] };
  return {
    check: [{ label: 'Check for Updates…', action: () => void checkForUpdates() }],
    settings: [{
      label: 'Update checks',
      options: [
        { label: 'Daily at launch', action: () => setAutomaticUpdateChecks(true), checked: () => automaticUpdateChecks() },
        { label: 'Only when asked', action: () => setAutomaticUpdateChecks(false), checked: () => !automaticUpdateChecks() },
      ],
    }],
  };
}

/**
 * Hook this window up: the native app menu's item, the save-before-restart
 * request, and the quiet launch check. `flush` saves everything the window
 * holds and says whether it is clean afterwards.
 */
export function installUpdates(options: UpdateHost & {
  flush: () => Promise<{ clean: boolean; deckName?: string }>;
}): void {
  const api = updatesApi();
  if (!api) return;
  host = { beginOperation: options.beginOperation, setStatus: options.setStatus };
  api.onMenuCheck(() => void checkForUpdates());
  api.onFlushRequest(options.flush);
  setTimeout(() => void launchCheck(), LAUNCH_DELAY_MS);
}

async function launchCheck(): Promise<void> {
  const api = updatesApi();
  if (!api) return;
  const previous = readStorage(LAST_CHECK_KEY);
  const lastCheckedAt = previous === null ? null : Number(previous);
  if (!shouldCheckAtLaunch({ enabled: automaticUpdateChecks(), lastCheckedAt, now: Date.now() })) return;
  const state = await api.state();
  // Only an install that updates itself checks unasked; a .deb or a Flatpak
  // has its own channel, and a development run has none.
  if (state.mode.kind !== 'auto') return;
  // Claim today's check before asking, so a second window opening at the
  // same moment does not ask too — and give the claim back if the check
  // failed, so being offline at launch does not skip a day.
  writeStorage(LAST_CHECK_KEY, String(Date.now()));
  const result = await api.check();
  if (result.kind === 'error') {
    writeStorage(LAST_CHECK_KEY, previous);
    return;
  }
  if (result.kind === 'available') await offerRelease(result.release);
}

/** The menu item: ask, and say what came back — including "nothing new". */
export async function checkForUpdates(): Promise<void> {
  const api = updatesApi();
  if (!api) return;
  const operation = host?.beginOperation('Checking github.com/vsitzmann/deckwerk for updates');
  let result: UpdateCheckResult;
  try {
    result = await api.check();
  } finally {
    operation?.finish();
  }
  await showCheckResult(result);
}

async function showCheckResult(result: UpdateCheckResult): Promise<void> {
  const api = updatesApi();
  if (!api) return;
  switch (result.kind) {
    case 'available':
      writeStorage(LAST_CHECK_KEY, String(Date.now()));
      await offerRelease(result.release);
      return;
    case 'latest':
      writeStorage(LAST_CHECK_KEY, String(Date.now()));
      await showMessage('No update available', `DeckWerk ${result.currentVersion} is the latest version.`);
      return;
    case 'release-page':
      // A .deb belongs to the system's package manager, so DeckWerk does not
      // replace itself; the release page has the newest package.
      await api.openReleasePage();
      host?.setStatus('Opened the DeckWerk releases page in your browser');
      return;
    case 'store':
      await showMessage(
        'Updates come from Flathub',
        'This copy of DeckWerk was installed from Flathub, which delivers its updates. '
          + 'Update it from your software center, or run: flatpak update org.deckwerk.DeckWerk',
      );
      return;
    case 'disabled': {
      const state = await api.state();
      await showMessage(
        'Updates are off in development',
        `This DeckWerk (${state.currentVersion}) runs from a source checkout, which does not update itself.`,
      );
      return;
    }
    case 'error':
      if (await showConfirmDialog({
        title: 'Could not check for updates',
        description: result.message,
        confirmLabel: 'Open Releases Page',
        cancelLabel: 'Close',
      })) await api.openReleasePage();
      return;
  }
}

function showMessage(title: string, description: string): Promise<boolean> {
  return showConfirmDialog({ title, description, confirmLabel: 'OK', cancelLabel: null });
}

/** A newer release: its notes, then Download (or Restart, if already downloaded). */
async function offerRelease(release: UpdateRelease): Promise<void> {
  const api = updatesApi();
  if (!api) return;
  const state = await api.state();
  if (state.downloaded) {
    await offerRestart(release);
    return;
  }
  if (state.downloading) {
    host?.setStatus(`DeckWerk ${release.version} is downloading`);
    return;
  }
  const download = await showConfirmDialog({
    title: 'Update available',
    description: `DeckWerk ${release.version} is available. You have ${state.currentVersion}.`,
    body: releaseNotesElement(release.notes),
    className: 'update-dialog',
    confirmLabel: 'Download',
    cancelLabel: 'Later',
  });
  if (!download) return;

  const label = `Downloading DeckWerk ${release.version}`;
  const operation = host?.beginOperation(label);
  const stop = api.onProgress((ratio) => operation?.update(label, ratio));
  let result: Awaited<ReturnType<UpdatesApi['download']>>;
  try {
    result = await api.download();
  } finally {
    stop();
    operation?.finish();
  }
  if (!result.ok) {
    if (await showConfirmDialog({
      title: 'Download failed',
      description: `DeckWerk ${release.version} could not be downloaded: ${result.message}`,
      confirmLabel: 'Open Release Page',
      cancelLabel: 'Close',
    })) await api.openReleasePage(release.version);
    return;
  }
  await offerRestart(release);
}

async function offerRestart(release: UpdateRelease): Promise<void> {
  const api = updatesApi();
  if (!api) return;
  const restart = await showConfirmDialog({
    title: 'Ready to install',
    description: `DeckWerk ${release.version} is downloaded. Restart now to install it, or it installs the next time you quit DeckWerk. Your decks are saved before restarting.`,
    confirmLabel: 'Restart',
    cancelLabel: 'Later',
  });
  if (!restart) {
    host?.setStatus(`DeckWerk ${release.version} installs when you quit`);
    return;
  }
  const operation = host?.beginOperation('Saving open decks before restarting');
  let result: Awaited<ReturnType<UpdatesApi['install']>>;
  try {
    result = await api.install();
  } finally {
    operation?.finish();
  }
  if (!result.ok) await showMessage('Not restarted', result.message);
}

/** Tags release notes keep; anything else is unwrapped to its text, and its attributes always dropped. */
const NOTE_TAGS: Record<string, string> = {
  P: 'p', UL: 'ul', OL: 'ol', LI: 'li', BR: 'br', PRE: 'pre', CODE: 'code',
  STRONG: 'strong', B: 'strong', EM: 'em', I: 'em', BLOCKQUOTE: 'blockquote',
  H1: 'h3', H2: 'h3', H3: 'h3', H4: 'h4', H5: 'h4', H6: 'h4',
};
const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT', 'SVG', 'MATH', 'IMG', 'VIDEO', 'AUDIO', 'FORM']);

/**
 * Release notes as inert markup. GitHub gives electron-updater the release
 * body as HTML; it is rebuilt here from a whitelist of structural tags with
 * no attributes at all, so nothing in a release body can run, load or link
 * anywhere from inside the editor. A plain-text body keeps its line breaks.
 */
export function releaseNotesElement(notes: string, doc: Document = document): HTMLElement {
  const box = doc.createElement('div');
  box.className = 'update-notes';
  const trimmed = notes.trim();
  if (!trimmed) {
    box.classList.add('update-notes-empty');
    box.textContent = 'No release notes.';
    return box;
  }
  // HTML only if it uses HTML's own tags: a text body may well mention `<file>`.
  if (!/<\/?(?:p|ul|ol|li|h[1-6]|br|div|span|strong|em|b|i|a|code|pre|blockquote)\b[^>]*>/i.test(trimmed)) {
    box.classList.add('update-notes-text');
    box.textContent = trimmed;
    return box;
  }
  const parsed = new DOMParser().parseFromString(trimmed, 'text/html');
  const copy = (from: Node, to: Node): void => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === 3) {
        to.appendChild(doc.createTextNode(child.textContent ?? ''));
        continue;
      }
      if (child.nodeType !== 1) continue;
      const tag = (child as Element).tagName.toUpperCase();
      if (DROPPED_TAGS.has(tag)) continue;
      const kept = NOTE_TAGS[tag];
      if (!kept) {
        copy(child, to);
        continue;
      }
      const element = doc.createElement(kept);
      to.appendChild(element);
      copy(child, element);
    }
  };
  copy(parsed.body, box);
  return box;
}
