// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDeckListing, RemoteListingResult, RemoteServerEntry, RemoteServerInfo } from '../src/shared/ipc.js';
import { serverDeckName, showUploadDialog, type UploadDialogApi } from '../src/renderer/editor/uploadDialog.js';

/**
 * Upload to server, against a scripted desktop: the folder and name a deck
 * gets, what is refused before anything is sent, and that who-can-open-it is
 * asked only of a server that controls access.
 */

const LAB: RemoteServerEntry = { id: 'lab', url: 'https://lab.example.ts.net:9443', name: 'Lab' };
const OPEN: RemoteServerEntry = { id: 'open', url: 'http://100.68.22.127:5800', name: 'Workshop' };

const LISTING: RemoteDeckListing = {
  decks: [{ id: 'Vincents talks/2610_TUM', title: 'TUM', slides: 12, editedAt: null, editors: 0, folder: 'Vincents talks' }],
  folders: [
    { path: 'Group Meeting', name: 'Group Meeting', parent: '', decks: 0 },
    { path: 'Vincents talks', name: 'Vincents talks', parent: '', decks: 1 },
  ],
};

interface Script {
  servers?: RemoteServerEntry[];
  listing?: (serverId: string) => Promise<RemoteListingResult>;
}

function open(script: Script = {}, name = '2611_CORL') {
  const api: UploadDialogApi = {
    remoteServers: async () => script.servers ?? [LAB],
    remoteServerInfo: async (serverId): Promise<RemoteServerInfo> => (serverId === 'lab'
      ? { origin: LAB.url, user: 'vincent@lab.example', userName: 'Vincent' }
      : { origin: OPEN.url, user: null, userName: null }),
    remoteListing: script.listing ?? (async () => ({ reachable: true, listing: LISTING })),
  };
  return showUploadDialog(api, { name });
}

const dialog = () => document.querySelector<HTMLFormElement>('.upload-dialog')!;
const control = <T extends HTMLElement>(name: string) => dialog().querySelector<T>(`[name="${name}"]`)!;
const note = () => dialog().querySelector<HTMLElement>('.upload-dialog-note')!;
const upload = () => dialog().querySelector<HTMLButtonElement>('button[type="submit"]')!;
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function set(name: string, value: string): void {
  const element = control<HTMLInputElement | HTMLSelectElement>(name);
  element.value = value;
  element.dispatchEvent(new Event(element.tagName === 'INPUT' ? 'input' : 'change', { bubbles: true }));
}
const submit = () => dialog().dispatchEvent(new Event('submit', { cancelable: true }));

// A storage of the test's own: which `localStorage` a jsdom test sees depends on the Node it runs under.
const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, String(value)),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('the name a server files a deck under', () => {
  it.each([
    ['2611_CORL', '2611_CORL'],
    ['CoRL: keynote (final)', 'CoRL- keynote -final'],
    ['  spaced out  ', 'spaced out'],
    ['.hidden', 'hidden'],
    ['talk.key', 'talk'],
    ['a/b\\c', 'b-c'],
    ['', ''],
  ])('%j → %j', (typed, filed) => expect(serverDeckName(typed)).toBe(filed));
});

describe('Upload to server', () => {
  it('offers the server\'s folders, named after the folder on this computer, restricted until told otherwise', async () => {
    const chosen = open();
    await settle();
    expect([...control<HTMLSelectElement>('folder').options].map((o) => o.textContent)).toEqual(['Top level', 'Group Meeting', 'Vincents talks']);
    expect(control<HTMLInputElement>('name').value).toBe('2611_CORL');
    // One server known: nothing to choose.
    expect(dialog().querySelector<HTMLElement>('.upload-dialog-server')!.hidden).toBe(true);
    expect(note().textContent).toBe('It will be “2611_CORL” on Lab. Only you can open it, until you share it from the server.');
    submit();
    expect(await chosen).toEqual({
      serverId: 'lab', serverName: 'Lab', name: '2611_CORL', folder: '',
      access: { visibility: 'private', publicRole: 'view' },
    });
  });

  it('files it in the chosen folder, public, and says what that means before sending', async () => {
    const chosen = open();
    await settle();
    set('folder', 'Vincents talks');
    expect(dialog().querySelector<HTMLElement>('.upload-dialog-role')!.hidden).toBe(true);
    set('visibility', 'public');
    expect(dialog().querySelector<HTMLElement>('.upload-dialog-role')!.hidden).toBe(false);
    expect(note().textContent).toBe('It will be “Vincents talks/2611_CORL” on Lab. Anyone on this server can open it. Only you can change it.');
    set('role', 'edit');
    expect(note().textContent).toBe('It will be “Vincents talks/2611_CORL” on Lab. Anyone on this server can open and change it.');
    submit();
    expect(await chosen).toEqual({
      serverId: 'lab', serverName: 'Lab', name: '2611_CORL', folder: 'Vincents talks',
      access: { visibility: 'public', publicRole: 'edit' },
    });
  });

  it('remembers the folder used on a server, for the next upload there', async () => {
    const first = open();
    await settle();
    set('folder', 'Vincents talks');
    submit();
    await first;
    open({}, '2612_NeurIPS');
    await settle();
    expect(control<HTMLSelectElement>('folder').value).toBe('Vincents talks');
    expect(note().textContent).toMatch(/^It will be “Vincents talks\/2612_NeurIPS” on Lab\./);
  });

  it('refuses a name the folder already holds, and an empty one, before anything is sent', async () => {
    let settled = false;
    void open().then(() => { settled = true; });
    await settle();
    set('folder', 'Vincents talks');
    set('name', '2610_TUM');
    expect(note().textContent).toBe('“Vincents talks/2610_TUM” already exists on this server. Choose another name or folder.');
    expect(note().classList.contains('is-error')).toBe(true);
    expect(upload().disabled).toBe(true);
    submit();
    await settle();
    expect(settled).toBe(false);
    // A deck may not take a folder's name either.
    set('folder', '');
    set('name', 'Group Meeting');
    expect(upload().disabled).toBe(true);
    set('name', ' - ');
    expect(note().textContent).toBe('Give the presentation a name.');
    set('name', 'CoRL: keynote');
    expect(note().textContent).toMatch(/^It will be “CoRL- keynote” on Lab\./);
    expect(upload().disabled).toBe(false);
  });

  it('does not ask who can open it on a server without access control', async () => {
    const chosen = open({ servers: [OPEN] });
    await settle();
    expect(dialog().querySelector<HTMLElement>('.upload-dialog-access')!.hidden).toBe(true);
    expect(note().textContent).toBe('It will be “2611_CORL” on Workshop. Everyone who can reach this server can open and change it.');
    submit();
    expect(await chosen).toEqual({ serverId: 'open', serverName: 'Workshop', name: '2611_CORL', folder: '' });
  });

  it('lets a server be chosen when several are known, asking each for its own folders', async () => {
    const chosen = open({
      servers: [LAB, OPEN],
      listing: async (serverId) => ({
        reachable: true,
        listing: serverId === 'lab' ? LISTING : { decks: [], folders: [{ path: 'demos', name: 'demos', parent: '', decks: 0 }] },
      }),
    });
    await settle();
    expect(dialog().querySelector<HTMLElement>('.upload-dialog-server')!.hidden).toBe(false);
    set('server', 'open');
    await settle();
    expect([...control<HTMLSelectElement>('folder').options].map((o) => o.value)).toEqual(['', 'demos']);
    expect(dialog().querySelector<HTMLElement>('.upload-dialog-access')!.hidden).toBe(true);
    set('folder', 'demos');
    submit();
    expect(await chosen).toMatchObject({ serverId: 'open', folder: 'demos' });
  });

  it('says why when the server cannot be reached, and sends nothing', async () => {
    let settled = false;
    void open({ listing: async () => ({ reachable: false, reason: 'Could not reach https://lab.example.ts.net:9443: unknown host' }) })
      .then(() => { settled = true; });
    await settle();
    expect(note().textContent).toBe('Lab cannot take an upload right now: Could not reach https://lab.example.ts.net:9443: unknown host');
    expect(upload().disabled).toBe(true);
    expect(control<HTMLSelectElement>('folder').disabled).toBe(true);
    submit();
    await settle();
    expect(settled).toBe(false);
  });

  it('is cancelled by its button and by Escape', async () => {
    const byButton = open();
    await settle();
    [...dialog().querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click();
    expect(await byButton).toBeNull();
    const byKey = open();
    await settle();
    document.querySelector('.workflow-overlay')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await byKey).toBeNull();
  });
});
