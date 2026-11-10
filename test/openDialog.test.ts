// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  RecentDeckEntry, RemoteDeckListing, RemoteListingResult, RemoteLocalCopy, RemoteServerEntry,
} from '../src/shared/ipc.js';
import { showOpenDialog, type OpenChoice, type OpenDialogApi } from '../src/renderer/editor/openDialog.js';

/**
 * The Open dialog against a scripted desktop: what Recents lists and how it
 * tells a server deck from a local one, and what a server's tab says while
 * the server is out of reach, slow to answer, or refusing.
 */

const LAB: RemoteServerEntry = { id: 'lab', url: 'https://lab.example.ts.net:9443', name: 'Lab' };
const NOW = Date.parse('2026-11-10T12:00:00Z');

const LISTING: RemoteDeckListing = {
  decks: [
    { id: 'Vincents talks/2611_CORL', title: 'CoRL keynote', slides: 40, editedAt: null, editors: 0, folder: 'Vincents talks' },
    { id: 'intro', title: 'Intro', slides: 3, editedAt: null, editors: 1, folder: '' },
  ],
  folders: [{ path: 'Vincents talks', name: 'Vincents talks', parent: '', decks: 1 }],
};
const COPIES: RemoteLocalCopy[] = [
  { deckId: 'Vincents talks/2611_CORL', title: 'CoRL keynote', savedAt: '2026-11-10T10:00:00Z' },
];
const RECENTS: RecentDeckEntry[] = [
  {
    dir: '/Users/vincent/Documents/talks/2611_CORL', title: 'CoRL keynote', openedAt: '2026-11-10T11:30:00Z',
    server: { name: 'Lab', url: LAB.url, deckId: 'Vincents talks/2611_CORL' },
  },
  { dir: '/Users/vincent/Documents/talks/draft', title: 'A draft', openedAt: '2026-11-09T12:00:00Z', server: null },
];

interface Script {
  servers?: RemoteServerEntry[];
  recents?: RecentDeckEntry[];
  copies?: RemoteLocalCopy[];
  listing?: () => Promise<RemoteListingResult>;
}

function open(script: Script, options: Parameters<typeof showOpenDialog>[1] = {}) {
  const listing = vi.fn(script.listing ?? (async () => ({ reachable: true as const, listing: LISTING })));
  const api: OpenDialogApi = {
    remoteServers: async () => script.servers ?? [LAB],
    addRemoteServer: async () => { throw new Error('not scripted'); },
    removeRemoteServer: async () => {},
    remoteListing: listing,
    remoteLocalCopies: async () => script.copies ?? [],
    recentDecks: async () => script.recents ?? [],
  };
  const chosen = showOpenDialog(api, options);
  return { chosen, listing };
}

const dialog = () => document.querySelector<HTMLElement>('.open-dialog')!;
const tabs = () => [...dialog().querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const activeTab = () => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent;
const tab = (label: string) => tabs().find((button) => button.textContent === label)!;
const bodyText = () => dialog().querySelector('.open-dialog-body')!.textContent ?? '';
const rows = () => [...dialog().querySelectorAll<HTMLButtonElement>('.open-dialog-row')];
/** Let the dialog's promises settle (fake timers leave microtasks alone). */
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const online = (value: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  online(true);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('Open: Recents', () => {
  it('comes first, ahead of this computer and the servers, and is where the dialog opens', async () => {
    open({ recents: RECENTS });
    await settle();
    expect(tabs().map((button) => button.textContent)).toEqual(['Recents', 'This computer', 'Lab', '+ Server…']);
    expect(activeTab()).toBe('Recents');
  });

  it('lists decks from a server and from this computer together, newest first, marked apart', async () => {
    open({ recents: RECENTS });
    await settle();
    expect(rows().map((row) => [...row.children].map((part) => part.textContent))).toEqual([
      ['Lab', 'CoRL keynote', 'Vincents talks · opened 30 min ago'],
      ['This computer', 'A draft', '~/Documents/talks · opened 1 d ago'],
    ]);
    expect(rows().map((row) => row.dataset.origin)).toEqual(['server', 'local']);
    // What a server deck's row is: a copy here that works offline.
    expect(rows()[0].title).toMatch(/Vincents talks\/2611_CORL on https:\/\/lab\.example\.ts\.net:9443.*opens offline/);
    expect(rows()[1].title).toBe('/Users/vincent/Documents/talks/draft');
  });

  it('keeps the end of a long folder path, which is the part that differs', async () => {
    open({
      recents: [{ dir: '/Volumes/Archive/Conferences and workshops/2026/Vienna/final', title: 'Vienna', openedAt: '2026-11-10T11:59:30Z', server: null }],
    });
    await settle();
    expect(rows()[0].lastElementChild!.textContent).toBe('…/2026/Vienna · opened just now');
    expect(rows()[0].title).toBe('/Volumes/Archive/Conferences and workshops/2026/Vienna/final');
  });

  it('opens a recent deck by its folder, server copy or not, without asking any server', async () => {
    for (const [index, dir] of [[0, RECENTS[0].dir], [1, RECENTS[1].dir]] as const) {
      const { chosen, listing } = open({ recents: RECENTS });
      await settle();
      rows()[index].click();
      expect(await chosen).toEqual<OpenChoice>({ kind: 'folder', dir, title: RECENTS[index].title });
      expect(listing).not.toHaveBeenCalled();
      expect(document.querySelector('.open-dialog')).toBeNull();
    }
  });

  it('says so when nothing was opened yet, and then starts on the server instead', async () => {
    open({ recents: [] });
    await settle();
    expect(activeTab()).toBe('Lab');
    tab('Recents').click();
    await settle();
    expect(bodyText()).toMatch(/No recent presentations yet/);
    expect(rows()).toEqual([]);
  });

  it('starts on the server when asked to, whatever was opened lately', async () => {
    open({ recents: RECENTS }, { start: 'server' });
    await settle();
    expect(activeTab()).toBe('Lab');
  });
});

describe('Open: a server that cannot be reached', () => {
  const unreachable = async (): Promise<RemoteListingResult> =>
    ({ reachable: false, reason: 'Could not reach https://lab.example.ts.net:9443: no answer (timed out)' });

  it('says you are offline and lists what is available offline', async () => {
    const { chosen } = open({ copies: COPIES, listing: unreachable });
    await settle();
    expect(dialog().querySelector('.open-dialog-offline-lead')!.textContent).toBe(
      'You are offline: Lab cannot be reached. The following presentations are available offline '
      + 'and will be synced whenever you are online again:',
    );
    expect(dialog().querySelector('.open-dialog-offline-lead')!.getAttribute('title')).toMatch(/timed out/);
    expect(rows().map((row) => row.textContent)).toEqual(['CoRL keynoteVincents talks · last synced 2 h ago']);
    rows()[0].click();
    expect(await chosen).toEqual<OpenChoice>({
      kind: 'remote', serverId: 'lab', deckId: 'Vincents talks/2611_CORL', title: 'CoRL keynote', offline: true,
    });
  });

  it('with no network at all, says just that — at once, before the server has failed to answer', async () => {
    online(false);
    let fail!: (result: RemoteListingResult) => void;
    open({ copies: COPIES, listing: () => new Promise((resolve) => { fail = resolve; }) });
    await settle();
    expect(dialog().querySelector('.open-dialog-offline-lead')!.textContent).toBe(
      'You are offline. The following presentations are available offline and will be synced whenever you are online again:',
    );
    expect(rows()).toHaveLength(1);
    // The answer, when it comes, changes nothing that was said.
    fail(await unreachable());
    await settle();
    expect(dialog().querySelector('.open-dialog-offline-lead')!.textContent).toMatch(/^You are offline\. /);
    expect(dialog().querySelector('.open-dialog-listing')!.classList.contains('is-offline')).toBe(true);
  });

  it('says when nothing is available offline yet', async () => {
    open({ copies: [], listing: unreachable });
    await settle();
    expect(bodyText()).toMatch(/You are offline: Lab cannot be reached\. No presentations from this server are available offline yet/);
    expect(rows()).toEqual([]);
    expect([...dialog().querySelectorAll('.open-dialog-body button')].map((button) => button.textContent)).toEqual(['Try again']);
  });

  it('offers the copies here while a slow server has yet to answer, then shows its listing', async () => {
    let answer!: (result: RemoteListingResult) => void;
    open({ copies: COPIES, listing: () => new Promise((resolve) => { answer = resolve; }) });
    await settle();
    expect(bodyText()).toMatch(/Loading presentations from https:\/\/lab\.example\.ts\.net:9443/);
    expect(rows()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1300);
    expect(dialog().querySelector('.open-dialog-listing')!.classList.contains('is-waiting')).toBe(true);
    expect(dialog().querySelector('.open-dialog-offline-lead')!.textContent).toMatch(/Still looking for Lab… .*available offline/);
    expect(rows().map((row) => row.dataset.deckId)).toEqual(['Vincents talks/2611_CORL']);
    answer({ reachable: true, listing: LISTING });
    await settle();
    expect(dialog().querySelector('.open-dialog-listing')!.className).toBe('open-dialog-listing');
    expect(rows().map((row) => row.textContent)).toEqual([
      'Vincents talks/1 presentation',
      'Intro3 slides · 1 editing now',
    ]);
  });

  it('answers quickly without ever showing the meanwhile list', async () => {
    open({ copies: COPIES });
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(dialog().querySelector('.is-waiting')).toBeNull();
    // Online, a deck with a copy here is marked as working offline too.
    rows().find((row) => row.dataset.folder === 'Vincents talks')!.click();
    expect(rows().map((row) => row.textContent)).toEqual(['CoRL keynote40 slides · available offline']);
  });

  it('asks again when the network comes back', async () => {
    let reachable = false;
    const { listing } = open({
      copies: COPIES,
      listing: async () => (reachable ? { reachable: true, listing: LISTING } : unreachable()),
    });
    await settle();
    expect(dialog().querySelector('.is-offline')).not.toBeNull();
    reachable = true;
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(listing).toHaveBeenCalledTimes(2);
    expect(dialog().querySelector('.is-offline')).toBeNull();
    expect(rows().some((row) => row.dataset.folder === 'Vincents talks')).toBe(true);
  });

  it('shows a refusal as the error it is, and still offers the copies here', async () => {
    open({
      copies: COPIES,
      listing: async () => {
        throw new Error("Error invoking remote method 'remote:listing': Error: https://lab.example.ts.net:9443 answered 403: unidentified connection");
      },
    });
    await settle();
    const error = dialog().querySelector('.open-dialog-message.is-error')!;
    expect(error.textContent).toBe('Could not list presentations: https://lab.example.ts.net:9443 answered 403: unidentified connection');
    expect(bodyText()).not.toMatch(/You are offline/);
    expect(rows().map((row) => row.dataset.deckId)).toEqual(['Vincents talks/2611_CORL']);
  });
});
