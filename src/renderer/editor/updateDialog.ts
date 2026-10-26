import type { UpdateCheckResult, UpdateRelease } from '@shared/updates.js';
import { showConfirmDialog } from './confirmDialog.js';
import type { ToolbarPickerEntry } from './exportPicker.js';
import type { OperationHandle } from './operationProgress.js';

/**
 * "Check for Updates…" in the DeckWerk menu and the dialogs between finding a
 * release and restarting into it. Nothing here runs unasked: the app never
 * checks by itself, and an update is downloaded only after the person
 * confirms it and installed only when they choose to restart. The main
 * process does the checking and installing (src/main/updates.ts); this side
 * decides what to show. Only the desktop app has `window.api.updates`, so
 * the browser editor's DeckWerk menu never offers any of it.
 */

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

/** The DeckWerk menu's update entry: none outside the desktop app. */
export function updateMenuEntries(): ToolbarPickerEntry[] {
  if (!updatesApi()) return [];
  return [{ label: 'Check for Updates…', action: () => void checkForUpdates() }];
}

/**
 * Hook this window up: the native app menu's item and the save-before-restart
 * request. `flush` saves everything the window holds and says whether it is
 * clean afterwards.
 */
export function installUpdates(options: UpdateHost & {
  flush: () => Promise<{ clean: boolean; deckName?: string }>;
}): void {
  const api = updatesApi();
  if (!api) return;
  host = { beginOperation: options.beginOperation, setStatus: options.setStatus };
  api.onMenuCheck(() => void checkForUpdates());
  api.onFlushRequest(options.flush);
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
      await offerRelease(result.release);
      return;
    case 'latest':
      await showMessage('No update available', `DeckWerk ${result.currentVersion} is the latest version.`);
      return;
    case 'release-page':
      // A .deb or a Flatpak belongs to a package manager, so DeckWerk does
      // not replace itself; the release page has the newest packages.
      await api.openReleasePage();
      host?.setStatus('Opened the DeckWerk releases page in your browser');
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

/** A newer release: its notes, and the person's go-ahead before anything is downloaded. */
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
  const update = await showConfirmDialog({
    title: 'Update available',
    description: `DeckWerk ${release.version} is available. You have ${state.currentVersion}. Update now?`,
    body: releaseNotesElement(release.notes),
    className: 'update-dialog',
    confirmLabel: 'Update',
    cancelLabel: 'Not Now',
  });
  if (!update) return;

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

/**
 * The download is done; restarting is still the person's call, since it
 * closes every window. Later installs nothing — the next Check for Updates
 * offers the restart again.
 */
async function offerRestart(release: UpdateRelease): Promise<void> {
  const api = updatesApi();
  if (!api) return;
  const restart = await showConfirmDialog({
    title: 'Ready to install',
    description: `DeckWerk ${release.version} is downloaded. Restart DeckWerk to install it? Your decks are saved first.`,
    confirmLabel: 'Restart Now',
    cancelLabel: 'Later',
  });
  if (!restart) {
    host?.setStatus(`DeckWerk ${release.version} is ready: choose Check for Updates… to install it`);
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
