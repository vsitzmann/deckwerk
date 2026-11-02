import type { RemoteDeckListing, RemoteLocalCopy, RemoteServerEntry, RemoteServerInfo } from '@shared/ipc.js';

/**
 * Open: decks on this computer and on the deck servers this desktop knows,
 * in one place. "This computer" hands off to the system folder picker; a
 * server lists its decks folder by folder, as its own web picker does, and
 * opening one makes a copy here that stays in sync (remoteDecks.ts). When
 * the server cannot be reached, its tab lists the copies already here, which
 * open without it.
 */

export type OpenChoice =
  | { kind: 'local' }
  | { kind: 'remote'; serverId: string; deckId: string; title: string; offline?: boolean };

export interface OpenDialogApi {
  remoteServers(): Promise<RemoteServerEntry[]>;
  addRemoteServer(url: string): Promise<RemoteServerEntry & { info: RemoteServerInfo }>;
  removeRemoteServer(id: string): Promise<void>;
  remoteListing(serverId: string): Promise<RemoteDeckListing>;
  remoteLocalCopies(serverId: string): Promise<RemoteLocalCopy[]>;
}

type Source = { kind: 'local' } | { kind: 'server'; server: RemoteServerEntry } | { kind: 'connect' };

export function showOpenDialog(
  api: OpenDialogApi,
  options: { start?: 'connect' } = {},
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
    let source: Source = { kind: 'local' };
    let folder = '';
    let finished = false;
    let renderToken = 0;

    const finish = (choice: OpenChoice | null): void => {
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
      let listing: RemoteDeckListing;
      try {
        listing = await api.remoteListing(server.id);
      } catch (error) {
        const here = await copies;
        if (token !== renderToken) return;
        const reason = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Try again';
        retry.addEventListener('click', () => void renderBody());
        if (here.length === 0) {
          body.replaceChildren(message(`Could not list presentations: ${reason}`, 'error'), retry);
          return;
        }
        body.replaceChildren(renderOffline(server, here, reason), retry);
        return;
      }
      const here = new Set((await copies).map((copy) => copy.deckId));
      if (token !== renderToken) return;
      body.replaceChildren(renderListing(server, listing, here));
    };

    /** The server is out of reach: what is already on this computer opens anyway. */
    const renderOffline = (server: RemoteServerEntry, copies: RemoteLocalCopy[], reason: string): HTMLElement => {
      const wrap = document.createElement('div');
      wrap.className = 'open-dialog-listing is-offline';
      const lead = message(`${server.name} cannot be reached right now. These presentations are on this computer: `
        + 'they open now, and your changes sync when the server is back.');
      lead.title = reason;
      wrap.append(lead);
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
        if (here.has(deck.id)) parts.push('on this computer');
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
          status.textContent = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
          input.focus();
        });
      });
      body.append(form, status);
      input.focus();
    };

    void api.remoteServers().then((list) => {
      servers = list;
      if (options.start === 'connect') select({ kind: 'connect' });
      else select(servers[0] ? { kind: 'server', server: servers[0] } : { kind: 'local' });
    });
  });
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
