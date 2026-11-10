import type {
  RecentDeckEntry,
  RemoteDeckListing,
  RemoteListingResult,
  RemoteLocalCopy,
  RemoteServerEntry,
  RemoteServerInfo,
} from '@shared/ipc.js';

/**
 * Open: the decks opened last, decks on this computer and decks on the
 * servers this desktop knows, in one place. Recents lists both kinds, marked
 * apart. "This computer" hands off to the system folder picker; a server
 * lists its decks folder by folder, as its own web picker does, and opening
 * one makes a copy here that stays in sync (remoteDecks.ts). When the server
 * cannot be reached — or has not answered yet — its tab lists the copies
 * already here, which open without it.
 */

export type OpenChoice =
  | { kind: 'local' }
  /** A deck folder already on this computer: a recent one, local or a server deck's copy. */
  | { kind: 'folder'; dir: string; title: string }
  | { kind: 'remote'; serverId: string; deckId: string; title: string; offline?: boolean };

export interface OpenDialogApi {
  remoteServers(): Promise<RemoteServerEntry[]>;
  addRemoteServer(url: string): Promise<RemoteServerEntry & { info: RemoteServerInfo }>;
  removeRemoteServer(id: string): Promise<void>;
  remoteListing(serverId: string): Promise<RemoteListingResult>;
  remoteLocalCopies(serverId: string): Promise<RemoteLocalCopy[]>;
  recentDecks(): Promise<RecentDeckEntry[]>;
}

type Source =
  | { kind: 'recent' }
  | { kind: 'local' }
  | { kind: 'server'; server: RemoteServerEntry }
  | { kind: 'connect' };

/** How long a server may take to answer before the copies on this computer are offered meanwhile. */
const SLOW_SERVER_MS = 1200;

/** What an IPC rejection says, without Electron's wrapping. */
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);

export function showOpenDialog(
  api: OpenDialogApi,
  /** `start`: open on the connect form, or on the first server rather than on Recents. */
  options: { start?: 'connect' | 'server' } = {},
): Promise<OpenChoice | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';
    const dialog = document.createElement('section');
    dialog.className = 'workflow-dialog open-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'open-dialog-title');

    const title = document.createElement('h2');
    title.id = 'open-dialog-title';
    title.textContent = 'Open presentation';

    const sources = document.createElement('div');
    sources.className = 'segmented-buttons open-dialog-sources';
    sources.setAttribute('role', 'tablist');

    const body = document.createElement('div');
    body.className = 'open-dialog-body';

    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'open-dialog-remove';
    remove.textContent = 'Forget server';
    remove.hidden = true;
    const spacer = document.createElement('span');
    spacer.className = 'open-dialog-spacer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    actions.append(remove, spacer, cancel);

    dialog.append(title, sources, body, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let servers: RemoteServerEntry[] = [];
    let recents: RecentDeckEntry[] = [];
    let source: Source = { kind: 'local' };
    let folder = '';
    let finished = false;
    let renderToken = 0;

    // The network came back while a server tab said offline: ask it again.
    const backOnline = (): void => {
      if (source.kind === 'server') void renderBody();
    };
    window.addEventListener('online', backOnline);

    const finish = (choice: OpenChoice | null): void => {
      if (finished) return;
      finished = true;
      renderToken++;
      window.removeEventListener('online', backOnline);
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
    remove.addEventListener('click', () => {
      if (source.kind !== 'server') return;
      const gone = source.server;
      void api.removeRemoteServer(gone.id).then(async () => {
        servers = await api.remoteServers();
        select({ kind: 'local' });
      });
    });

    const renderSources = (): void => {
      sources.replaceChildren();
      const tab = (label: string, which: Source, active: boolean): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `segment-button${active ? ' is-active' : ''}`;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-selected', String(active));
        button.textContent = label;
        button.title = which.kind === 'server' ? which.server.url : label;
        button.addEventListener('click', () => select(which));
        return button;
      };
      sources.append(tab('Recents', { kind: 'recent' }, source.kind === 'recent'));
      sources.append(tab('This computer', { kind: 'local' }, source.kind === 'local'));
      for (const server of servers) {
        sources.append(tab(server.name, { kind: 'server', server },
          source.kind === 'server' && source.server.id === server.id));
      }
      sources.append(tab('+ Server…', { kind: 'connect' }, source.kind === 'connect'));
    };

    const select = (next: Source): void => {
      source = next;
      folder = '';
      remove.hidden = next.kind !== 'server';
      renderSources();
      void renderBody();
    };

    const message = (text: string, kind: 'muted' | 'error' = 'muted'): HTMLParagraphElement => {
      const p = document.createElement('p');
      p.className = `open-dialog-message${kind === 'error' ? ' is-error' : ''}`;
      p.textContent = text;
      return p;
    };

    const renderBody = async (): Promise<void> => {
      const token = ++renderToken;
      body.replaceChildren();
      if (source.kind === 'recent') {
        body.append(renderRecents());
        return;
      }
      if (source.kind === 'local') {
        body.append(message('Open a DeckWerk folder (one containing deck.json) from this computer.'));
        const choose = document.createElement('button');
        choose.type = 'button';
        choose.className = 'primary open-dialog-choose';
        choose.textContent = 'Choose folder…';
        choose.addEventListener('click', () => finish({ kind: 'local' }));
        body.append(choose);
        choose.focus();
        return;
      }
      if (source.kind === 'connect') {
        renderConnect();
        return;
      }
      const server = source.server;
      body.append(message(`Loading presentations from ${server.url}…`));
      const copies = api.remoteLocalCopies(server.id).catch((): RemoteLocalCopy[] => []);
      const retry = (): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Try again';
        button.addEventListener('click', () => void renderBody());
        return button;
      };
      // An unreachable server can take many seconds to be told apart from a
      // slow one. What is on this computer needs no answer from it: offer
      // that at once when the system says there is no network, and after a
      // moment's silence otherwise, while the question stays open.
      let answered = false;
      const meanwhile = async (waiting: boolean): Promise<void> => {
        const here = await copies;
        if (answered || token !== renderToken) return;
        if (waiting && here.length === 0) return;
        body.replaceChildren(renderOffline(server, here, waiting ? 'waiting' : 'offline', ''), ...(waiting ? [] : [retry()]));
      };
      const slow = navigator.onLine ? window.setTimeout(() => void meanwhile(true), SLOW_SERVER_MS) : 0;
      if (!navigator.onLine) void meanwhile(false);
      let result: RemoteListingResult;
      try {
        result = await api.remoteListing(server.id);
      } catch (error) {
        // The server answered, with a refusal: say so, and still offer what is here.
        answered = true;
        window.clearTimeout(slow);
        const here = await copies;
        if (token !== renderToken) return;
        const refusal = message(`Could not list presentations: ${errorText(error)}`, 'error');
        body.replaceChildren(refusal, ...(here.length > 0 ? [renderOffline(server, here, 'refused', '')] : []), retry());
        return;
      }
      answered = true;
      window.clearTimeout(slow);
      const here = await copies;
      if (token !== renderToken) return;
      if (!result.reachable) {
        body.replaceChildren(renderOffline(server, here, 'offline', result.reason), retry());
        return;
      }
      body.replaceChildren(renderListing(server, result.listing, new Set(here.map((copy) => copy.deckId))));
    };

    /** The decks opened last, wherever they live, each marked with where that is. */
    const renderRecents = (): HTMLElement => {
      if (recents.length === 0) {
        return message('No recent presentations yet. The ones you open, from this computer or from a server, are listed here.');
      }
      const list = document.createElement('div');
      list.className = 'open-dialog-list';
      list.setAttribute('role', 'listbox');
      for (const recent of recents) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'open-dialog-row is-deck is-recent';
        row.dataset.dir = recent.dir;
        row.dataset.origin = recent.server ? 'server' : 'local';
        const origin = document.createElement('span');
        origin.className = 'open-dialog-origin';
        origin.textContent = recent.server ? recent.server.name : 'This computer';
        const name = document.createElement('strong');
        name.textContent = recent.title || folderName(recent.dir);
        const detail = document.createElement('span');
        detail.className = 'open-dialog-detail';
        const opened = relativeTime(recent.openedAt);
        // A server deck is known by where it is filed there; a local one by its folder here.
        const where = recent.server
          ? recent.server.deckId.split('/').slice(0, -1).join('/')
          : pathTail(homeRelative(parentFolder(recent.dir)));
        detail.textContent = [where, opened && `opened ${opened}`].filter(Boolean).join(' · ');
        row.title = recent.server
          ? `${recent.server.deckId} on ${recent.server.url}. A copy is on this computer (${recent.dir}): `
            + 'it opens offline and syncs when the server can be reached.'
          : recent.dir;
        row.append(origin, name, detail);
        row.addEventListener('click', () => finish({ kind: 'folder', dir: recent.dir, title: name.textContent ?? '' }));
        list.append(row);
      }
      return list;
    };

    /**
     * What is on this computer from a server that is out of reach (`offline`),
     * has not answered yet (`waiting`), or refused the question (`refused`).
     */
    const renderOffline = (
      server: RemoteServerEntry,
      copies: RemoteLocalCopy[],
      state: 'offline' | 'waiting' | 'refused',
      reason: string,
    ): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.className = `open-dialog-listing is-${state === 'waiting' ? 'waiting' : 'offline'}`;
      // No network at all, or only this server out of reach: either way the
      // person is offline as far as these decks go.
      const offline = navigator.onLine ? `You are offline: ${server.name} cannot be reached.` : 'You are offline.';
      const lead = message(
        state === 'waiting'
          ? `Still looking for ${server.name}… The following presentations are available offline and open right away:`
          : state === 'refused'
            ? 'The following presentations are available offline:'
            : copies.length > 0
              ? `${offline} The following presentations are available offline and will be synced whenever you are online again:`
              : `${offline} No presentations from this server are available offline yet: `
                + 'one you open while connected stays on this computer.',
      );
      lead.classList.add('open-dialog-offline-lead');
      if (reason) lead.title = reason;
      wrap.append(lead);
      if (copies.length === 0) return wrap;
      const list = document.createElement('div');
      list.className = 'open-dialog-list';
      list.setAttribute('role', 'listbox');
      for (const copy of copies) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'open-dialog-row is-deck';
        row.dataset.deckId = copy.deckId;
        const name = document.createElement('strong');
        name.textContent = copy.title;
        const detail = document.createElement('span');
        const folder = copy.deckId.split('/').slice(0, -1).join('/');
        const synced = relativeTime(copy.savedAt);
        detail.textContent = [folder, synced && `last synced ${synced}`].filter(Boolean).join(' · ');
        row.append(name, detail);
        row.addEventListener('click', () => finish({
          kind: 'remote', serverId: server.id, deckId: copy.deckId, title: copy.title, offline: true,
        }));
        list.append(row);
      }
      wrap.append(list);
      return wrap;
    };

    const renderListing = (server: RemoteServerEntry, listing: RemoteDeckListing, here: Set<string>): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.className = 'open-dialog-listing';
      const crumbs = document.createElement('nav');
      crumbs.className = 'open-dialog-crumbs';
      const crumb = (label: string, path: string): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'open-dialog-crumb';
        button.textContent = label;
        button.disabled = path === folder;
        button.addEventListener('click', () => {
          folder = path;
          wrap.replaceWith(renderListing(server, listing, here));
        });
        return button;
      };
      crumbs.append(crumb(server.name, ''));
      let path = '';
      for (const part of folder ? folder.split('/') : []) {
        path = path ? `${path}/${part}` : part;
        const sep = document.createElement('span');
        sep.textContent = '/';
        crumbs.append(sep, crumb(part, path));
      }

      const list = document.createElement('div');
      list.className = 'open-dialog-list';
      list.setAttribute('role', 'listbox');
      const folders = listing.folders.filter((f) => f.parent === folder);
      const decks = listing.decks.filter((d) => d.folder === folder);
      for (const entry of folders) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'open-dialog-row is-folder';
        row.dataset.folder = entry.path;
        const name = document.createElement('strong');
        name.textContent = `${entry.name}/`;
        const detail = document.createElement('span');
        detail.textContent = `${entry.decks} presentation${entry.decks === 1 ? '' : 's'}`;
        row.append(name, detail);
        row.addEventListener('click', () => {
          folder = entry.path;
          wrap.replaceWith(renderListing(server, listing, here));
        });
        list.append(row);
      }
      for (const deck of decks) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'open-dialog-row is-deck';
        row.dataset.deckId = deck.id;
        const name = document.createElement('strong');
        name.textContent = deck.title || deck.id;
        const detail = document.createElement('span');
        const parts = [`${deck.slides} slide${deck.slides === 1 ? '' : 's'}`];
        if (deck.editedAt) parts.push(`edited ${relativeTime(deck.editedAt)}`);
        if (deck.editors > 0) parts.push(`${deck.editors} editing now`);
        if (here.has(deck.id)) parts.push('available offline');
        detail.textContent = parts.join(' · ');
        row.append(name, detail);
        row.addEventListener('click', () => finish({
          kind: 'remote', serverId: server.id, deckId: deck.id, title: deck.title || deck.id,
        }));
        list.append(row);
      }
      if (folders.length === 0 && decks.length === 0) {
        list.append(message(folder ? 'This folder is empty.' : 'No presentations on this server yet.'));
      }
      wrap.append(crumbs, list);
      return wrap;
    };

    const renderConnect = (): void => {
      body.append(message('Connect to a DeckWerk server (npm run collab, or the lab server) by its address. '
        + 'Its presentations open here as copies that stay in sync, and keep working offline.'));
      const form = document.createElement('form');
      form.className = 'open-dialog-connect';
      const field = document.createElement('label');
      field.className = 'field';
      const caption = document.createElement('span');
      caption.textContent = 'Server address';
      const input = document.createElement('input');
      input.type = 'text';
      input.name = 'server';
      input.placeholder = '100.68.22.127:5800 or https://lab.example.ts.net:9443';
      input.spellcheck = false;
      field.append(caption, input);
      const connect = document.createElement('button');
      connect.type = 'submit';
      connect.className = 'primary';
      connect.textContent = 'Connect';
      const status = message('');
      status.hidden = true;
      form.append(field, connect);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const url = input.value.trim();
        if (!url) return;
        connect.disabled = true;
        input.disabled = true;
        status.hidden = false;
        status.className = 'open-dialog-message';
        status.textContent = `Connecting to ${url}…`;
        void api.addRemoteServer(url).then(async (added) => {
          servers = await api.remoteServers();
          select({ kind: 'server', server: servers.find((s) => s.id === added.id) ?? added });
        }, (error) => {
          connect.disabled = false;
          input.disabled = false;
          status.className = 'open-dialog-message is-error';
          status.textContent = errorText(error);
          input.focus();
        });
      });
      body.append(form, status);
      input.focus();
    };

    void Promise.all([
      api.remoteServers(),
      api.recentDecks().catch((): RecentDeckEntry[] => []),
    ]).then(([list, recent]) => {
      servers = list;
      recents = recent;
      if (options.start === 'connect') select({ kind: 'connect' });
      else if (options.start === 'server' && servers[0]) select({ kind: 'server', server: servers[0] });
      else if (recents.length > 0) select({ kind: 'recent' });
      else select(servers[0] ? { kind: 'server', server: servers[0] } : { kind: 'local' });
    });
  });
}

const folderName = (dir: string): string => dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? dir;
const parentFolder = (dir: string): string => dir.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
/** `/Users/ada/Documents/talks` → `~/Documents/talks`, where the path says whose home it is. */
const homeRelative = (path: string): string =>
  path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/, '~');

/** The end of a long path, which is the part that tells two talks apart: `…/2026/talks`. */
function pathTail(path: string, limit = 30): string {
  if (path.length <= limit) return path;
  const parts = path.split(/[\\/]/);
  let tail = parts.pop() ?? '';
  while (parts.length > 0 && tail.length + parts[parts.length - 1].length + 1 <= limit - 2) tail = `${parts.pop()}/${tail}`;
  return `…/${tail}`;
}

function relativeTime(iso: string): string {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 86_400 * 30) return `${Math.round(seconds / 86_400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
