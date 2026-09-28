/**
 * Deck chooser for the collab client: browses the server's folders, lists the
 * presentations in the one you are looking at, creates new ones, renames and
 * files them away, and imports a Keynote file, a PowerPoint file or a DeckWerk
 * deck archive server-side. Picking a deck navigates to
 * `?deck=<id>` — a full reload is the simplest correct way to re-key every
 * deck-scoped route and socket. A deck id is its folder path, so "acme/pitch"
 * is the deck "pitch" inside the folder "acme".
 *
 * On an access-controlled server (--access) both listings arrive already
 * filtered to what this tailnet user may open, with ownership and role
 * metadata; the picker then groups decks by relationship, marks the ones it
 * can only view, and offers the Share… dialog on decks the user manages. A
 * folder with nothing shared inside it is simply not in the listing.
 */
import { createToolbarPicker, type ToolbarPickerOption } from '../editor/exportPicker.js';
import { buildZip, type ZipInput } from '../../shared/zip.js';


interface DeckEntry {
  id: string;
  title: string;
  slides: number;
  /** ISO time of the last saved edit; null when the server cannot tell. */
  editedAt: string | null;
  /** People editing it right now. */
  editors: number;
  folder: string;
  owner?: string;
  visibility?: 'public' | 'private';
  canManage?: boolean;
  sharedWithMe?: boolean;
  role?: 'owner' | 'edit' | 'view';
}

interface FolderEntry {
  path: string;
  name: string;
  parent: string;
  decks: number;
  owner?: string;
  canManage?: boolean;
}

export interface PickerAccess {
  user: string;
  name: string;
  admin: boolean;
  deckRole?: 'owner' | 'edit' | 'view' | null;
}

function goTo(deckId: string): void {
  const params = new URLSearchParams(location.search);
  params.set('deck', deckId);
  location.search = params.toString();
}

/** The folder a deck id lives in; '' for the root. */
export function folderOf(deckId: string): string {
  return deckId.includes('/') ? deckId.slice(0, deckId.lastIndexOf('/')) : '';
}

const folderQuery = (folder: string): string =>
  (folder ? `&folder=${encodeURIComponent(folder)}` : '');

export async function createDeckOnServer(folder = ''): Promise<void> {
  const name = (window.prompt('Name for the new presentation?') ?? '').trim();
  if (!name) return;
  const response = await fetch(
    `/api/decks?name=${encodeURIComponent(name)}${folderQuery(folder)}`,
    { method: 'POST' },
  );
  const body = await response.json() as { id?: string; error?: string };
  if (!response.ok || !body.id) throw new Error(body.error ?? 'could not create the deck');
  goTo(body.id);
}

/**
 * What the server can turn into a deck, as the menu lists it.
 *
 * `folder: true` picks a directory rather than a file — a DeckWerk deck on
 * disk is a folder, and a file chooser set to `.zip` cannot select one: the
 * Open button just descends into it. The browser hands back the folder's
 * files, which are zipped here into exactly the archive `/api/import-deck`
 * already takes, so one server route serves both.
 */
const IMPORT_SOURCES = {
  keynote: { label: 'Keynote…', accept: '.key', route: '/api/import-keynote' },
  powerpoint: { label: 'PowerPoint…', accept: '.pptx', route: '/api/import-pptx' },
  deck: { label: 'DeckWerk deck folder…', accept: '', route: '/api/import-deck', folder: true },
  deckArchive: { label: 'DeckWerk deck archive (.zip)…', accept: '.zip', route: '/api/import-deck' },
} as const;

export type ImportSource = keyof typeof IMPORT_SOURCES;

export function importKeynoteToServer(onStatus: (text: string) => void, folder = ''): void {
  importToServer('keynote', onStatus, folder);
}

export function importPowerPointToServer(onStatus: (text: string) => void, folder = ''): void {
  importToServer('powerpoint', onStatus, folder);
}

/**
 * A dialog for the part of an import nobody can see otherwise.
 *
 * The upload reports its bytes on the status line and in the picker's footer,
 * but once they are out the server converts in silence for up to a minute.
 * This puts that wait, and any failure, in a dialog above whichever menu or
 * picker started it. Quick imports never show it: it appears after 500 ms.
 */
function importProgress(filename: string, label: string): {
  update(text: string): void;
  finish(): void;
  fail(message: string): void;
} {
  const overlay = document.createElement('div');
  overlay.className = 'workflow-overlay import-progress-overlay';
  const box = document.createElement('div');
  box.className = 'workflow-dialog import-progress-dialog';
  const title = document.createElement('h2');
  title.textContent = `Importing ${label}`;
  const status = document.createElement('div');
  status.className = 'import-progress-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-busy', 'true');
  status.textContent = `Uploading “${filename}”…`;
  box.append(title, status);
  overlay.append(box);

  let shown = false;
  const timer = window.setTimeout(() => {
    shown = true;
    document.body.append(overlay);
  }, 500);
  return {
    update: (text) => { status.textContent = text; },
    finish: () => {
      window.clearTimeout(timer);
      overlay.remove();
    },
    fail: (message) => {
      window.clearTimeout(timer);
      if (!shown) document.body.append(overlay);
      shown = true;
      title.textContent = `${label} import failed`;
      status.classList.add('failed');
      status.setAttribute('aria-busy', 'false');
      status.textContent = message;
      const actions = document.createElement('div');
      actions.className = 'workflow-actions';
      const close = document.createElement('button');
      close.textContent = 'Close';
      close.addEventListener('click', () => overlay.remove());
      actions.append(close);
      box.append(actions);
      close.focus();
    },
  };
}

/** Upload a file and open the deck the server makes of it. */
export function importToServer(
  source: ImportSource,
  onStatus: (text: string) => void,
  folder = '',
): void {
  const definition = IMPORT_SOURCES[source];
  const pickFolder = 'folder' in definition && definition.folder;
  const input = document.createElement('input');
  input.type = 'file';
  if (definition.accept) input.accept = definition.accept;
  if (pickFolder) input.webkitdirectory = true;
  input.hidden = true;
  // Keep the chooser's control in the document. Besides giving assistive and
  // browser automation tooling a real upload target, this lets Chromium own
  // the control for the whole native chooser lifetime instead of relying on a
  // detached input surviving until the user has picked a file.
  document.body.append(input);
  input.addEventListener('cancel', () => input.remove(), { once: true });
  input.addEventListener('change', () => {
    const files = [...input.files ?? []];
    input.remove();
    if (files.length === 0) return;
    const label = definition.label.replace(/…$/, '');
    const progress = importProgress(files[0].name, label);
    const report = (text: string): void => {
      onStatus(text);
      progress.update(text);
    };
    void (async () => {
      const upload = pickFolder
        ? await zipPickedFolder(files, report)
        : { name: files[0].name, body: files[0] as Blob };
      const name = upload.name.replace(/\.(key|pptx|zip)$/i, '');
      const id = await postImport(
        `${definition.route}?name=${encodeURIComponent(name)}${folderQuery(folder)}`,
        upload.body,
        (sent, total) => report(total > 0
          ? `Uploading “${upload.name}”… ${Math.round((sent / total) * 100)}% of ${formatSize(total)}`
          : `Uploading “${upload.name}”…`),
        () => report(`Converting “${upload.name}”… this can take a minute for a large deck.`),
      );
      progress.finish();
      goTo(id);
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      onStatus(`Import failed: ${message}`);
      progress.fail(message);
    });
  });
  input.click();
}

/**
 * POST the upload, reporting how much of it has gone out.
 *
 * `fetch` cannot report upload progress, and a deck with video in it is a
 * long silent wait without it — which reads as nothing happening at all.
 * XMLHttpRequest is the only API in a browser that exposes the request body's
 * progress, so this one call uses it.
 */
function postImport(
  url: string,
  body: Blob,
  onProgress: (sent: number, total: number) => void,
  onUploaded: () => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.upload.addEventListener('progress', (event) => {
      onProgress(event.loaded, event.lengthComputable ? event.total : 0);
    });
    // The bytes are all out; whatever happens now is the server working.
    request.upload.addEventListener('load', onUploaded);
    request.addEventListener('load', () => {
      let parsed: { id?: string; error?: string };
      try {
        parsed = JSON.parse(request.responseText) as typeof parsed;
      } catch {
        reject(new Error(`the server answered ${request.status} with something that is not JSON`));
        return;
      }
      if (request.status >= 400 || !parsed.id) reject(new Error(parsed.error ?? `import failed (${request.status})`));
      else resolve(parsed.id);
    });
    request.addEventListener('error', () => reject(new Error('the connection dropped during the upload')));
    request.addEventListener('abort', () => reject(new Error('the upload was cancelled')));
    request.send(body);
  });
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} kB`;
}

/**
 * Zip up the folder the chooser handed back.
 *
 * `webkitRelativePath` is the path under the folder the person picked, so the
 * archive comes out with that folder as its single wrapping directory — the
 * shape the import route already strips. The deck is named after the folder,
 * which is how a deck on disk is named anyway.
 */
async function zipPickedFolder(
  files: File[],
  onStatus: (text: string) => void,
): Promise<{ name: string; body: Blob }> {
  const deckName = files[0].webkitRelativePath.split('/')[0] || 'deck';
  if (!files.some((file) => file.webkitRelativePath.split('/').slice(1).join('/') === 'deck.json')) {
    throw new Error(`“${deckName}” holds no deck.json — pick the deck's own folder, not the one above it.`);
  }
  const entries: ZipInput[] = [];
  for (const file of files) {
    onStatus(`Reading “${deckName}”… ${entries.length + 1} of ${files.length} files.`);
    entries.push({
      name: file.webkitRelativePath,
      data: new Uint8Array(await file.arrayBuffer()),
    });
    // Let the status line actually paint between files; without this the
    // whole folder is read in one frame and nothing is ever shown.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  onStatus(`Packing “${deckName}”…`);
  return { name: deckName, body: new Blob([buildZip(entries)], { type: 'application/zip' }) };
}

/** The picker's Import menu: one entry per format the server can take. */
export function importMenuEntries(
  onStatus: (text: string) => void,
  folder: string,
): ToolbarPickerOption[] {
  return (Object.keys(IMPORT_SOURCES) as ImportSource[]).map((source) => ({
    label: IMPORT_SOURCES[source].label,
    action: () => importToServer(source, onStatus, folder),
  }));
}

/**
 * One row of the listing: a name that opens the thing, then the columns that
 * describe it. Rows and the header share this shape so the listing reads down
 * its columns, which is what makes it a file manager rather than a menu.
 */
function pickerRow(
  tag: 'button' | 'div',
  name: string,
  cells: string[],
): HTMLElement {
  const row = document.createElement(tag);
  row.className = 'deck-picker-row';
  const label = document.createElement('span');
  label.className = 'deck-picker-name';
  label.textContent = name;
  row.append(label);
  for (const text of cells) {
    const cell = document.createElement('span');
    cell.className = 'deck-picker-cell';
    cell.textContent = text;
    row.append(cell);
  }
  return row;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", then the date. */
export function editedAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!(minutes >= 1)) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return 'yesterday';
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Wrap a row with the fixed-width slot its buttons live in. */
function rowGroup(row: HTMLElement, buttons: HTMLElement[]): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'deck-picker-row-group';
  const actions = document.createElement('div');
  actions.className = 'deck-picker-actions';
  actions.append(...buttons);
  wrapper.append(row, actions);
  return wrapper;
}

/** A button in a row's action slot. */
function rowButton(label: string, hint: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'deck-picker-share';
  button.textContent = label;
  button.title = hint;
  button.addEventListener('click', onClick);
  return button;
}

/** Which picker section a deck belongs in, from this user's point of view. */
function groupOf(deck: DeckEntry, access: PickerAccess): string {
  if (deck.owner === access.user) return 'Your presentations';
  if (deck.sharedWithMe) return 'Shared with you';
  if (deck.visibility === 'public') return 'Public';
  // Only the admin ever sees a private deck that is neither theirs nor shared.
  return 'Other private presentations (admin)';
}

const GROUP_ORDER = ['Your presentations', 'Shared with you', 'Public', 'Other private presentations (admin)'];

/** Modal list of the server's decks, with New and Import at the bottom. */
export function showDeckPicker(opts: {
  dismissable: boolean;
  onStatus: (text: string) => void;
  access?: PickerAccess | null;
  /** Folder to open the picker in; defaults to the current deck's. */
  folder?: string;
}): void {
  const overlay = document.createElement('div');
  overlay.className = 'workflow-overlay';
  const box = document.createElement('div');
  box.className = 'workflow-dialog deck-picker';

  const current = new URLSearchParams(location.search).get('deck');
  let folder = opts.folder ?? (current ? folderOf(current) : '');

  const title = document.createElement('h2');
  title.textContent = 'Presentations on this server';
  const trail = document.createElement('div');
  trail.className = 'deck-picker-trail';
  const list = document.createElement('div');
  list.className = 'deck-picker-list';
  list.textContent = 'Loading…';

  const reopen = (next: string) => {
    overlay.remove();
    showDeckPicker({ ...opts, folder: next });
  };

  const folderRow = (entry: FolderEntry): HTMLElement => {
    const row = pickerRow('button', entry.name, [
      `${entry.decks} presentation${entry.decks === 1 ? '' : 's'}`,
      '',
      '',
      entry.owner ?? '',
      '',
    ]);
    row.classList.add('deck-picker-folder');
    row.addEventListener('click', () => reopen(entry.path));
    if (!entry.canManage && opts.access) return rowGroup(row, []);
    const rename = rowButton('Rename…', 'Give this folder another name', () => {
      const name = (window.prompt('New name for this folder?', entry.name) ?? '').trim();
      if (!name || name === entry.name) return;
      void (async () => {
        const response = await fetch(
          `/api/folders/rename?path=${encodeURIComponent(entry.path)}&name=${encodeURIComponent(name)}`,
          { method: 'POST' },
        );
        const body = await response.json() as { path?: string; error?: string };
        if (!response.ok || !body.path) throw new Error(body.error ?? `rename failed (${response.status})`);
        opts.onStatus(`Renamed the folder to “${name}”`);
        // Every deck inside is filed under the folder's path, so a deck open
        // in this tab is now open at a path that no longer exists.
        const open = new URLSearchParams(location.search).get('deck');
        if (open?.startsWith(`${entry.path}/`)) goTo(`${body.path}/${open.slice(entry.path.length + 1)}`);
        else reopen(folder);
      })().catch((error) => opts.onStatus(`Rename failed: ${error instanceof Error ? error.message : error}`));
    });
    const remove = rowButton('Delete…', 'Delete this folder (only when it is empty)', () => {
      if (!window.confirm(`Delete the folder “${entry.name}”?`)) return;
      void (async () => {
        const response = await fetch(`/api/folders?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
        const body = await response.json() as { error?: string };
        if (!response.ok) throw new Error(body.error ?? `delete failed (${response.status})`);
        opts.onStatus(`Deleted the folder “${entry.name}”`);
        reopen(folder);
      })().catch((error) => opts.onStatus(`Delete failed: ${error instanceof Error ? error.message : error}`));
    });
    return rowGroup(row, [rename, remove]);
  };

  const deckRow = (deck: DeckEntry, folders: FolderEntry[]): HTMLElement => {
    const access = deck.role === 'view'
      ? 'view only'
      : deck.visibility ? (deck.visibility === 'public' ? 'public' : 'private') : '';
    const row = pickerRow('button', deck.title, [
      `${deck.slides} slide${deck.slides === 1 ? '' : 's'}`,
      deck.editedAt ? editedAgo(deck.editedAt) : '',
      deck.editors > 0 ? `${deck.editors} editing` : '',
      opts.access && deck.owner && deck.owner !== opts.access.user ? deck.owner : '',
      access,
    ]);
    if (deck.editedAt) row.children[2]?.setAttribute('title', new Date(deck.editedAt).toLocaleString());
    if (deck.editors > 0) row.children[3]?.classList.add('deck-picker-live');
    if (deck.id === current) row.classList.add('active');
    row.addEventListener('click', () => {
      if (deck.id === current) overlay.remove();
      else goTo(deck.id);
    });
    // Without --access the server has no owners, so everything is yours to
    // manage — the same rule the folder rows already follow.
    if (!(deck.canManage ?? !opts.access)) return rowGroup(row, []);
    const rename = rowButton('Rename…', 'Give this presentation another name', () => {
      const name = (window.prompt('New name for this presentation?', deck.title) ?? '').trim();
      if (!name || name === deck.title) return;
      void (async () => {
        const response = await fetch(
          `/api/decks/rename?deck=${encodeURIComponent(deck.id)}&name=${encodeURIComponent(name)}`,
          { method: 'POST' },
        );
        const body = await response.json() as { id?: string; error?: string };
        if (!response.ok || !body.id) throw new Error(body.error ?? `rename failed (${response.status})`);
        opts.onStatus(`Renamed to “${name}”`);
        // The name is also the last segment of the deck id, so a deck open in
        // this tab has just moved out from under it.
        if (deck.id === current) goTo(body.id);
        else reopen(folder);
      })().catch((error) => opts.onStatus(`Rename failed: ${error instanceof Error ? error.message : error}`));
    });
    const move = rowButton('Move…', 'Put this presentation in a folder', () => {
      showMoveDialog(deck, folders, opts.onStatus, (movedTo) => reopen(movedTo));
    });
    const share = rowButton(
      'Share…',
      'Change who can open this presentation',
      () => showShareDialog(deck.id, opts.onStatus, () => reopen(folder)),
    );
    return rowGroup(row, [rename, move, share]);
  };

  const renderTrail = (folders: FolderEntry[]) => {
    trail.replaceChildren();
    const segments = folder ? folder.split('/') : [];
    const crumb = (label: string, path: string, last: boolean) => {
      const button = document.createElement('button');
      button.className = 'deck-picker-crumb';
      button.textContent = label;
      button.disabled = last;
      button.addEventListener('click', () => reopen(path));
      trail.append(button);
      if (!last) {
        const sep = document.createElement('span');
        sep.className = 'deck-picker-crumb-sep';
        sep.textContent = '›';
        trail.append(sep);
      }
    };
    crumb('All presentations', '', segments.length === 0);
    segments.forEach((segment, index) => {
      crumb(segment, segments.slice(0, index + 1).join('/'), index === segments.length - 1);
    });
    // A folder that vanished (deleted elsewhere, or never visible) must not
    // leave the picker showing an empty room with no way back.
    if (folder && !folders.some((entry) => entry.path === folder)) {
      const gone = document.createElement('span');
      gone.className = 'deck-picker-crumb-sep';
      gone.textContent = '· no longer available';
      trail.append(gone);
    }
  };

  void (async () => {
    const [decksResponse, foldersResponse] = await Promise.all([
      fetch('/api/decks'),
      fetch('/api/folders'),
    ]);
    if (!decksResponse.ok) throw new Error(`listing failed (${decksResponse.status})`);
    const decks = await decksResponse.json() as DeckEntry[];
    const folders = foldersResponse.ok ? await foldersResponse.json() as FolderEntry[] : [];
    renderTrail(folders);
    list.replaceChildren();
    const here = decks.filter((deck) => deck.folder === folder);
    const children = folders.filter((entry) => entry.parent === folder);
    for (const entry of children) list.appendChild(folderRow(entry));
    if (here.length === 0 && children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'deck-picker-group';
      empty.textContent = folder
        ? 'This folder is empty.'
        : 'No presentations yet — create one or import a Keynote or PowerPoint file.';
      list.appendChild(empty);
      return;
    }
    if (!opts.access) {
      for (const deck of here) list.appendChild(deckRow(deck, folders));
      return;
    }
    const groups = new Map<string, DeckEntry[]>();
    for (const deck of here) {
      const group = groupOf(deck, opts.access);
      groups.set(group, [...(groups.get(group) ?? []), deck]);
    }
    for (const group of GROUP_ORDER) {
      const entries = groups.get(group);
      if (!entries || entries.length === 0) continue;
      const heading = document.createElement('div');
      heading.className = 'deck-picker-group';
      heading.textContent = group;
      list.appendChild(heading);
      for (const deck of entries) list.appendChild(deckRow(deck, folders));
    }
  })().catch(() => {
    list.textContent = 'Could not reach the server.';
  });

  const actions = document.createElement('div');
  actions.className = 'workflow-actions';
  const makeButton = (label: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  actions.append(
    makeButton('New presentation…', () => {
      void createDeckOnServer(folder).catch((error) =>
        opts.onStatus(`Create failed: ${error instanceof Error ? error.message : error}`));
    }),
    makeButton('New folder…', () => {
      const name = (window.prompt('Name for the new folder?') ?? '').trim();
      if (!name) return;
      const path = folder ? `${folder}/${name}` : name;
      void (async () => {
        const response = await fetch(`/api/folders?path=${encodeURIComponent(path)}`, { method: 'POST' });
        const body = await response.json() as { path?: string; error?: string };
        if (!response.ok || !body.path) throw new Error(body.error ?? 'could not create the folder');
        opts.onStatus(`Created the folder “${name}”`);
        reopen(body.path);
      })().catch((error) => opts.onStatus(`Create failed: ${error instanceof Error ? error.message : error}`));
    }),
  );

  // Progress has to be shown inside the dialog: the toolbar's status line is
  // behind this overlay, so reporting an upload there reads as nothing
  // happening at all. It goes to both — the picker reloads the page when an
  // import lands, and the toolbar is what is left afterwards.
  const progress = document.createElement('p');
  progress.className = 'deck-picker-progress';
  progress.setAttribute('role', 'status');
  progress.hidden = true;
  const report = (text: string): void => {
    progress.hidden = text === '';
    progress.textContent = text;
    opts.onStatus(text);
  };

  // Import is one menu rather than a button per format: the list grows with
  // every format the server learns, and the dialog's footer does not. An
  // import only imports — who may open the result is the Share… dialog's
  // question, for every deck alike.
  actions.append(createToolbarPicker(
    'Import…',
    importMenuEntries(report, folder),
    { escapeClipping: true },
  ));
  if (opts.dismissable) {
    // Opened from an open deck, so leaving it must put you back where you
    // were rather than anywhere: Cancel, first in the footer's actions.
    const cancel = makeButton('Cancel', () => overlay.remove());
    actions.prepend(cancel);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) overlay.remove();
    });
    // A window-sized overlay leaves little background to click on, so the key
    // everything else here closes with has to work too.
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') overlay.remove();
    });
  }

  // Header, column labels, the listing, then the footer: the shape of a file
  // manager, and the reason the listing is the only part that scrolls.
  const head = document.createElement('div');
  head.className = 'deck-picker-head';
  head.append(title, trail);
  const columns = document.createElement('div');
  columns.className = 'deck-picker-columns';
  columns.append(rowGroup(pickerRow('div', 'Name', ['Size', 'Last edit', 'Editing', 'Owner', 'Access']), []));
  const foot = document.createElement('div');
  foot.className = 'deck-picker-foot';
  foot.append(progress, actions);

  box.append(head, columns, list, foot);
  overlay.append(box);
  document.body.append(overlay);
  // Focusable so the Escape handler above hears the key without a click first.
  box.tabIndex = -1;
  box.focus();
}

/** Move one presentation into another folder (owner or admin only). */
function showMoveDialog(
  deck: DeckEntry,
  folders: FolderEntry[],
  onStatus: (text: string) => void,
  onMoved: (folder: string) => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'workflow-overlay';
  const box = document.createElement('div');
  box.className = 'workflow-dialog';
  const title = document.createElement('h2');
  title.textContent = `Move “${deck.title}”`;
  const label = document.createElement('label');
  label.className = 'share-dialog-visibility';
  label.textContent = 'Folder: ';
  const select = document.createElement('select');
  for (const option of [{ path: '', label: 'All presentations (top level)' },
    ...folders.map((entry) => ({ path: entry.path, label: entry.path }))]) {
    const node = document.createElement('option');
    node.value = option.path;
    node.textContent = option.label;
    node.selected = option.path === deck.folder;
    select.append(node);
  }
  label.append(select);

  const actions = document.createElement('div');
  actions.className = 'workflow-actions';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => overlay.remove());
  const save = document.createElement('button');
  save.textContent = 'Move';
  save.className = 'primary';
  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true;
      const response = await fetch(
        `/api/decks/move?deck=${encodeURIComponent(deck.id)}${folderQuery(select.value)}`,
        { method: 'POST' },
      );
      const body = await response.json() as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? `move failed (${response.status})`);
      onStatus(`Moved “${deck.title}” to ${select.value || 'the top level'}`);
      overlay.remove();
      // The id changed with the folder, so a deck that is open here is now
      // open at a path that no longer exists: send the tab to the new one.
      const current = new URLSearchParams(location.search).get('deck');
      if (current === deck.id) goTo(body.id);
      else onMoved(select.value);
    })().catch((error) => {
      save.disabled = false;
      onStatus(`Move failed: ${error instanceof Error ? error.message : error}`);
    });
  });
  actions.append(cancel, save);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });
  box.append(title, label, actions);
  overlay.append(box);
  document.body.append(overlay);
}

interface DeckShare {
  login: string;
  role: 'edit' | 'view';
}

interface DeckAccessInfo {
  owner: string;
  visibility: 'public' | 'private';
  publicRole: 'edit' | 'view';
  sharedWith: DeckShare[];
  canManage: boolean;
  role: 'owner' | 'edit' | 'view' | null;
}

const ROLE_LABEL: Record<'edit' | 'view', string> = {
  edit: 'Can edit',
  view: 'Can view',
};

/** A headed block of the share dialog. */
function section(heading: string, ...content: HTMLElement[]): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'share-dialog-section';
  const label = document.createElement('h3');
  label.textContent = heading;
  wrap.append(label, ...content);
  return wrap;
}

/**
 * Visibility + share list for one deck, backed by GET/PUT /api/access.
 * Read-only for participants who can open the deck but don't manage it.
 */
export function showShareDialog(deckId: string, onStatus: (text: string) => void, onSaved?: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'workflow-overlay';
  const box = document.createElement('div');
  box.className = 'workflow-dialog share-dialog';

  const title = document.createElement('h2');
  title.textContent = `Share “${deckId}”`;
  const body = document.createElement('div');
  body.className = 'share-dialog-body';
  body.textContent = 'Loading…';

  const actions = document.createElement('div');
  actions.className = 'workflow-actions';
  const close = document.createElement('button');
  close.textContent = 'Close';
  close.addEventListener('click', () => overlay.remove());
  actions.append(close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) overlay.remove();
  });

  void (async () => {
    const response = await fetch(`/api/access?deck=${encodeURIComponent(deckId)}`);
    const info = await response.json() as DeckAccessInfo & { error?: string };
    if (!response.ok) throw new Error(info.error ?? `access lookup failed (${response.status})`);
    body.replaceChildren();

    if (!info.canManage) {
      const ownerLine = document.createElement('p');
      ownerLine.className = 'share-dialog-owner';
      ownerLine.textContent = `Owner: ${info.owner}`;
      const note = document.createElement('p');
      const what = info.role === 'view'
        ? 'You can view it, but not change it.'
        : 'You can edit it.';
      note.textContent = `${info.visibility === 'public'
        ? 'This presentation is public: everyone on this server can open it.'
        : 'This presentation is private; the owner shared it with you.'} ${what}`;
      body.append(ownerLine, note);
      return;
    }

    // Two sections, in the order the questions actually get asked: the named
    // people first, then the blanket rule for everyone else. Google Docs
    // settled on this split — "People with access" above "General access" —
    // and it is the right one here: a named grant and the public setting add
    // up rather than override, so seeing them stacked is seeing the answer.

    // People picker: the current share list as rows with a role each, plus an
    // input that autocompletes against everyone the server has seen before
    // (GET /api/users). Free-typed logins still work — the directory is a
    // convenience, not a gate on who can be shared with.
    const knownUsers = await (async () => {
      try {
        const usersResponse = await fetch('/api/users');
        if (!usersResponse.ok) return [];
        return await usersResponse.json() as Array<{ login: string; name: string }>;
      } catch {
        return [];
      }
    })();
    const nameOf = (login: string) => knownUsers.find((user) => user.login === login)?.name;
    const shares: DeckShare[] = info.sharedWith.map((share) => ({ ...share }));

    const addRow = document.createElement('div');
    addRow.className = 'share-dialog-add';
    const entry = document.createElement('input');
    entry.placeholder = knownUsers.length > 0 ? 'Add people by name or login…' : 'tailnet login, e.g. alice@example.com';
    entry.setAttribute('list', 'share-known-users');
    const newRole = document.createElement('select');
    for (const value of ['edit', 'view'] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = ROLE_LABEL[value];
      newRole.append(option);
    }
    const datalist = document.createElement('datalist');
    datalist.id = 'share-known-users';
    const syncDatalist = () => {
      datalist.replaceChildren();
      for (const user of knownUsers) {
        if (user.login === info.owner || shares.some((share) => share.login === user.login)) continue;
        const option = document.createElement('option');
        option.value = user.login;
        option.label = user.name;
        datalist.append(option);
      }
    };

    const people = document.createElement('div');
    people.className = 'share-dialog-people';

    /** One row of "People with access": who they are, and what they may do. */
    const personRow = (login: string, roleControl: HTMLElement): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'share-dialog-person';
      const who = document.createElement('span');
      who.className = 'share-dialog-person-who';
      const name = nameOf(login);
      const primary = document.createElement('span');
      primary.className = 'share-dialog-person-name';
      primary.textContent = name ?? login;
      who.append(primary);
      if (name) {
        const secondary = document.createElement('span');
        secondary.className = 'share-dialog-person-login';
        secondary.textContent = login;
        who.append(secondary);
      }
      row.append(who, roleControl);
      return row;
    };

    const renderPeople = () => {
      people.replaceChildren();

      // The owner is a person with access like any other, and showing them
      // as a row answers "why can't I remove myself" before it is asked.
      const ownerRole = document.createElement('span');
      ownerRole.className = 'share-dialog-role-fixed';
      ownerRole.textContent = 'Owner';
      people.append(personRow(info.owner, ownerRole));

      for (const share of shares) {
        const role = document.createElement('select');
        for (const value of ['edit', 'view'] as const) {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = ROLE_LABEL[value];
          option.selected = share.role === value;
          role.append(option);
        }
        role.title = `What ${share.login} can do`;
        role.addEventListener('change', () => {
          share.role = role.value === 'view' ? 'view' : 'edit';
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'share-dialog-person-remove';
        remove.textContent = '✕';
        remove.title = `Stop sharing with ${share.login}`;
        remove.addEventListener('click', () => {
          shares.splice(shares.indexOf(share), 1);
          renderPeople();
        });
        const controls = document.createElement('span');
        controls.className = 'share-dialog-person-controls';
        controls.append(role, remove);
        people.append(personRow(share.login, controls));
      }
      syncDatalist();
    };

    const addEntry = () => {
      const typed = entry.value.trim().toLowerCase();
      if (!typed) return;
      // Accept a display name typed in full as well as a login.
      const match = knownUsers.find((user) => user.login === typed || user.name.toLowerCase() === typed);
      const login = match?.login ?? typed;
      if (login !== info.owner && !shares.some((share) => share.login === login)) {
        shares.push({ login, role: newRole.value === 'view' ? 'view' : 'edit' });
      }
      entry.value = '';
      renderPeople();
    };
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'Add';
    add.addEventListener('click', addEntry);
    entry.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addEntry();
      }
    });
    // Picking a datalist suggestion fires `change`; add it right away.
    entry.addEventListener('change', () => {
      if (knownUsers.some((user) => user.login === entry.value.trim().toLowerCase())) addEntry();
    });
    addRow.append(entry, newRole, add, datalist);

    const peopleSection = section('People with access', addRow, people);

    // General access: one row saying who else can open it, with the role it
    // hands them beside it, and a plain sentence underneath saying what the
    // combination actually means. The role selector is meaningless while the
    // deck is restricted, so it is not shown then.
    const generalRow = document.createElement('div');
    generalRow.className = 'share-dialog-general';
    const visibility = document.createElement('select');
    for (const [value, label] of [
      ['private', 'Restricted'],
      ['public', 'Everyone on this server'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = info.visibility === value;
      visibility.append(option);
    }
    visibility.title = 'Who can open this presentation without being listed above';
    const publicRole = document.createElement('select');
    for (const value of ['view', 'edit'] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = ROLE_LABEL[value];
      option.selected = info.publicRole === value;
      publicRole.append(option);
    }
    publicRole.title = 'What everyone else can do';
    generalRow.append(visibility, publicRole);
    const generalNote = document.createElement('p');
    generalNote.className = 'share-dialog-note';

    const syncGeneralAccess = () => {
      const isPublic = visibility.value === 'public';
      publicRole.hidden = !isPublic;
      generalNote.textContent = isPublic
        ? (publicRole.value === 'view'
          ? 'Anyone on this server can open it. Only the people listed above can change it.'
          : 'Anyone on this server can open and change it.')
        : 'Only the people listed above can open it.';
    };
    visibility.addEventListener('change', syncGeneralAccess);
    publicRole.addEventListener('change', syncGeneralAccess);

    const generalSection = section('General access', generalRow, generalNote);

    renderPeople();
    syncGeneralAccess();

    // The link is the whole point of sharing something, and it is the one
    // thing the old dialog made you go and find in the address bar.
    const copyLink = document.createElement('button');
    copyLink.type = 'button';
    copyLink.className = 'share-dialog-copy';
    copyLink.textContent = 'Copy link';
    copyLink.addEventListener('click', () => {
      const link = `${location.origin}/?deck=${encodeURIComponent(deckId)}`;
      void navigator.clipboard?.writeText(link)
        .then(() => onStatus(`Copied the link to “${deckId}”`))
        // A clipboard a browser will not hand over is not a failure worth a
        // dialog; showing the link lets the person copy it themselves.
        .catch(() => onStatus(`Copy it by hand: ${link}`));
    });

    const save = document.createElement('button');
    save.textContent = 'Save';
    save.className = 'primary';
    save.addEventListener('click', () => {
      void (async () => {
        save.disabled = true;
        const payload = {
          visibility: visibility.value,
          publicRole: publicRole.value,
          sharedWith: shares.map((share) => ({ ...share })),
        };
        const saved = await fetch(`/api/access?deck=${encodeURIComponent(deckId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const result = await saved.json() as { error?: string };
        if (!saved.ok) throw new Error(result.error ?? `save failed (${saved.status})`);
        const viewers = payload.sharedWith.filter((share) => share.role === 'view').length;
        onStatus(payload.visibility === 'public'
          ? `“${deckId}” is now public · everyone ${payload.publicRole === 'view' ? 'can view' : 'can edit'}`
          : `“${deckId}” is private · shared with ${payload.sharedWith.length}`
            + `${viewers > 0 ? ` (${viewers} view-only)` : ''}`);
        overlay.remove();
        onSaved?.();
      })().catch((error) => {
        save.disabled = false;
        onStatus(`Sharing failed: ${error instanceof Error ? error.message : error}`);
      });
    });

    body.append(peopleSection, generalSection);
    actions.prepend(copyLink);
    actions.append(save);
  })().catch((error) => {
    body.textContent = `Could not load sharing: ${error instanceof Error ? error.message : error}`;
  });

  box.append(title, body, actions);
  overlay.append(box);
  document.body.append(overlay);
}
