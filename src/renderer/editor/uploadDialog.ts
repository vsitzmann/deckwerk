import type {
  RemoteDeckListing,
  RemoteListingResult,
  RemoteServerEntry,
  RemoteServerInfo,
  RemoteUploadRequest,
} from '@shared/ipc.js';

/**
 * Upload to server: where a deck that lives on this computer should go on a
 * deck server — which server, which of its folders, under what name — and,
 * on a server that controls access, who may open it there. The upload itself
 * (remoteDecks.ts) leaves the folder where it is and makes it the copy that
 * stays in sync.
 */

export interface UploadChoice extends RemoteUploadRequest {
  serverName: string;
}

export interface UploadDialogApi {
  remoteServers(): Promise<RemoteServerEntry[]>;
  remoteServerInfo(serverId: string): Promise<RemoteServerInfo>;
  remoteListing(serverId: string): Promise<RemoteListingResult>;
}

/** The folder last uploaded to on each server, so a person who files every talk in one place picks it once. */
const FOLDER_KEY = 'deckwerk.upload.folder';

/**
 * The name the server will file a deck under: its own cleaning of a typed
 * name (collabServer's sanitizeDeckId), so the dialog can show the result and
 * notice a clash before anything is sent.
 */
export function serverDeckName(typed: string): string {
  return typed
    .replace(/^.*\//, '')
    .replace(/\.(key|pptx|zip)$/i, '')
    .replace(/[^a-zA-Z0-9._ -]+/g, '-')
    .replace(/^[.\s-]+|[\s-]+$/g, '')
    .slice(0, 80);
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);

export function showUploadDialog(
  api: UploadDialogApi,
  deck: { name: string },
): Promise<UploadChoice | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';
    const dialog = document.createElement('form');
    dialog.className = 'workflow-dialog upload-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'upload-dialog-title');
    dialog.noValidate = true;

    const title = document.createElement('h2');
    title.id = 'upload-dialog-title';
    title.textContent = 'Upload to server';

    const lead = document.createElement('p');
    lead.className = 'upload-dialog-message';
    lead.textContent = 'Puts this presentation on a DeckWerk server. Its folder stays where it is on this computer, '
      + 'and from then on the two are kept in sync: live while you are connected, and merged when you come back from working offline.';

    const field = <T extends HTMLElement>(caption: string, control: T, extra = ''): { label: HTMLLabelElement; control: T } => {
      const label = document.createElement('label');
      label.className = `field${extra ? ` ${extra}` : ''}`;
      const text = document.createElement('span');
      text.textContent = caption;
      label.append(text, control);
      return { label, control };
    };

    const server = field('Server', document.createElement('select'), 'upload-dialog-server');
    server.control.name = 'server';
    const folder = field('Folder', document.createElement('select'), 'upload-dialog-folder');
    folder.control.name = 'folder';
    const name = field('Name', document.createElement('input'), 'upload-dialog-name');
    name.control.type = 'text';
    name.control.name = 'name';
    name.control.spellcheck = false;
    name.control.value = serverDeckName(deck.name) || 'Presentation';

    // Who may open it: the server's Share dialog, in its own words.
    const access = document.createElement('div');
    access.className = 'upload-dialog-access';
    access.hidden = true;
    const visibility = field('Who can open it', document.createElement('select'), 'upload-dialog-visibility');
    visibility.control.name = 'visibility';
    for (const [value, label] of [['private', 'Restricted'], ['public', 'Everyone on this server']] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      visibility.control.append(option);
    }
    const role = field('What they can do', document.createElement('select'), 'upload-dialog-role');
    role.control.name = 'role';
    for (const [value, label] of [['view', 'Can view'], ['edit', 'Can edit']] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      role.control.append(option);
    }
    access.append(visibility.label, role.label);

    const note = document.createElement('p');
    note.className = 'upload-dialog-message upload-dialog-note';

    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = 'Upload';
    actions.append(cancel, submit);

    dialog.append(title, lead, server.label, folder.label, name.label, access, note, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let servers: RemoteServerEntry[] = [];
    /** What the chosen server said; null while asking, or when it cannot be asked. */
    let listing: RemoteDeckListing | null = null;
    let accessControlled = false;
    let problem = '';
    let finished = false;
    let asked = 0;

    const finish = (choice: UploadChoice | null): void => {
      if (finished) return;
      finished = true;
      overlay.remove();
      resolve(choice);
    };
    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) finish(null);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(null);
    });

    const rememberedFolder = (serverId: string): string => {
      try {
        return (JSON.parse(localStorage.getItem(FOLDER_KEY) ?? '{}') as Record<string, string>)[serverId] ?? '';
      } catch {
        return '';
      }
    };
    const rememberFolder = (serverId: string, path: string): void => {
      try {
        const all = JSON.parse(localStorage.getItem(FOLDER_KEY) ?? '{}') as Record<string, string>;
        localStorage.setItem(FOLDER_KEY, JSON.stringify({ ...all, [serverId]: path }));
      } catch {
        // Storage refused: the folder is simply asked for again next time.
      }
    };

    /** Say what will happen, or why it cannot, and whether Upload may be pressed. */
    const sync = (): void => {
      const cleaned = serverDeckName(name.control.value);
      const id = folder.control.value ? `${folder.control.value}/${cleaned}` : cleaned;
      const isPublic = visibility.control.value === 'public';
      role.label.hidden = !isPublic;
      let error = problem;
      if (!error && listing) {
        if (!cleaned) error = 'Give the presentation a name.';
        else if (listing.decks.some((deck) => deck.id === id) || listing.folders.some((entry) => entry.path === id)) {
          error = `“${id}” already exists on this server. Choose another name or folder.`;
        }
      }
      note.classList.toggle('is-error', Boolean(error));
      if (error) note.textContent = error;
      else if (!listing) note.textContent = 'Asking the server for its folders…';
      else {
        const who = !accessControlled
          ? 'Everyone who can reach this server can open and change it.'
          : !isPublic
            ? 'Only you can open it, until you share it from the server.'
            : role.control.value === 'view'
              ? 'Anyone on this server can open it. Only you can change it.'
              : 'Anyone on this server can open and change it.';
        const where = servers.find((entry) => entry.id === server.control.value)?.name ?? 'the server';
        note.textContent = `It will be “${id}” on ${where}. ${who}`;
      }
      submit.disabled = Boolean(error) || !listing;
    };

    /** Ask the chosen server for its folders and whether it controls access. */
    const ask = async (): Promise<void> => {
      const token = ++asked;
      const chosen = servers.find((entry) => entry.id === server.control.value);
      listing = null;
      problem = '';
      access.hidden = true;
      folder.control.replaceChildren();
      folder.control.disabled = true;
      sync();
      if (!chosen) return;
      try {
        const [info, result] = await Promise.all([api.remoteServerInfo(chosen.id), api.remoteListing(chosen.id)]);
        if (token !== asked || finished) return;
        if (!result.reachable) throw new Error(result.reason);
        listing = result.listing;
        accessControlled = info.user !== null;
      } catch (error) {
        if (token !== asked || finished) return;
        problem = `${chosen.name} cannot take an upload right now: ${errorText(error)}`;
        sync();
        return;
      }
      const top = document.createElement('option');
      top.value = '';
      top.textContent = 'Top level';
      folder.control.append(top);
      for (const entry of listing.folders) {
        const option = document.createElement('option');
        option.value = entry.path;
        option.textContent = entry.path;
        folder.control.append(option);
      }
      const remembered = rememberedFolder(chosen.id);
      folder.control.value = listing.folders.some((entry) => entry.path === remembered) ? remembered : '';
      folder.control.disabled = false;
      access.hidden = !accessControlled;
      sync();
    };

    server.control.addEventListener('change', () => void ask());
    for (const control of [folder.control, visibility.control, role.control]) control.addEventListener('change', sync);
    name.control.addEventListener('input', sync);

    dialog.addEventListener('submit', (event) => {
      event.preventDefault();
      const chosen = servers.find((entry) => entry.id === server.control.value);
      if (submit.disabled || !chosen || !listing) return;
      rememberFolder(chosen.id, folder.control.value);
      finish({
        serverId: chosen.id,
        serverName: chosen.name,
        name: serverDeckName(name.control.value),
        folder: folder.control.value,
        ...(accessControlled ? {
          access: {
            visibility: visibility.control.value === 'public' ? 'public' as const : 'private' as const,
            publicRole: role.control.value === 'edit' ? 'edit' as const : 'view' as const,
          },
        } : {}),
      });
    });

    sync();
    void api.remoteServers().then((list) => {
      if (finished) return;
      servers = list;
      for (const entry of servers) {
        const option = document.createElement('option');
        option.value = entry.id;
        option.textContent = entry.name;
        option.title = entry.url;
        server.control.append(option);
      }
      // One server is the usual case: nothing to choose, so do not ask.
      server.label.hidden = servers.length < 2;
      void ask();
      name.control.focus();
      name.control.select();
    }, (error) => {
      problem = errorText(error);
      sync();
    });
  });
}
