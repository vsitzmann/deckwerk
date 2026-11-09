// @vitest-environment jsdom
/**
 * The deck picker's Private / Public only switch. Private is the usual
 * folder-by-folder listing and what the picker opens on; Public only lists
 * every deck anyone on the server can open, from every folder, so a deck that
 * should not be public is easy to spot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showDeckPicker } from '../src/renderer/collab/deckPicker.js';

const ADMIN = { user: 'admin@tailnet.example', name: 'Admin', admin: true };

const deck = (id: string, visibility: 'public' | 'private', publicRole: 'edit' | 'view' = 'view') => ({
  id,
  title: id.split('/').pop(),
  slides: 3,
  editedAt: '2026-11-01T12:00:00.000Z',
  editors: 0,
  folder: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
  owner: ADMIN.user,
  visibility,
  publicRole,
  canManage: true,
  sharedWithMe: false,
  role: 'owner',
});

const DECKS = [
  deck('Group Meeting', 'public', 'edit'),
  deck('Draft talk', 'private'),
  deck('Letters/Visa/O-1 slides', 'private'),
  deck('Talks/2611_Rank_symposium', 'public', 'view'),
];
const FOLDERS = [
  { path: 'Letters', name: 'Letters', parent: '', decks: 1, owner: ADMIN.user, canManage: true },
  { path: 'Letters/Visa', name: 'Visa', parent: 'Letters', decks: 1, owner: ADMIN.user, canManage: true },
  { path: 'Talks', name: 'Talks', parent: '', decks: 1, owner: ADMIN.user, canManage: true },
];

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const names = () => [...document.querySelectorAll('.deck-picker-list .deck-picker-name')].map((n) => n.textContent);
const groups = () => [...document.querySelectorAll('.deck-picker-list .deck-picker-group')].map((n) => n.textContent);
const scopeButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.deck-picker-scope-button')]
  .find((b) => b.textContent === label)!;

describe('deck picker Private / Public only switch', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith('/api/folders') ? FOLDERS : DECKS), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens on Private, folder by folder', async () => {
    showDeckPicker({ dismissable: true, onStatus: () => {}, access: ADMIN, folder: '' });
    await settle();
    expect(scopeButton('Private').getAttribute('aria-pressed')).toBe('true');
    expect(scopeButton('Public only').getAttribute('aria-pressed')).toBe('false');
    expect(names()).toEqual(['Letters', 'Talks', 'Group Meeting', 'Draft talk']);
  });

  it('Public only lists every public deck from every folder, and nothing private', async () => {
    showDeckPicker({ dismissable: true, onStatus: () => {}, access: ADMIN, folder: '' });
    await settle();
    scopeButton('Public only').click();
    await settle();
    expect(document.querySelectorAll('.deck-picker')).toHaveLength(1);
    expect(scopeButton('Public only').getAttribute('aria-pressed')).toBe('true');
    expect(groups()).toEqual(['Public · anyone can edit', 'Public · anyone can view']);
    expect(names()).toEqual(['Group Meeting', 'Talks / 2611_Rank_symposium']);

    scopeButton('Private').click();
    await settle();
    expect(names()).toEqual(['Letters', 'Talks', 'Group Meeting', 'Draft talk']);
  });

  it('says so when nothing is public', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(
      JSON.stringify(url.startsWith('/api/folders') ? [] : [deck('Draft talk', 'private')]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));
    showDeckPicker({ dismissable: true, onStatus: () => {}, access: ADMIN, folder: '', publicOnly: true });
    await settle();
    expect(names()).toEqual([]);
    expect(groups()[0]).toMatch(/^Nothing is public/);
  });

  it('has no switch without access control, where everything is open to everyone', async () => {
    showDeckPicker({ dismissable: true, onStatus: () => {}, access: null, folder: '' });
    await settle();
    expect(document.querySelector('.deck-picker-scope')).toBeNull();
  });
});
