import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import { mirrorDirFor } from '../src/main/remoteDecks.js';
import { Cdp, eventually, findTarget, stopBrowser } from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';
import { startCuttableLink, type CuttableLink } from './support/cuttableLink.js';
import { OfflineReplica } from './support/offlineReplica.js';

/**
 * The real desktop app editing a deck on a real deck server, through a link
 * the test cuts: opened from the Open dialog, edited live by typing, edited
 * offline on both sides, merged through the merge dialog, reopened after a
 * quit while offline, and fed a picture a collaborator added.
 */

const DECK_ID = 'lab/talk';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function talk(): Deck {
  return parseDeck({
    version: 1,
    title: 'Server talk',
    slides: [1, 2, 3].map((n) => ({
      id: `s${n}`,
      name: `Slide ${n}`,
      elements: [{
        id: `t${n}`, type: 'text', x: 160, y: 200, w: 1600, h: 300,
        html: `Title ${n}`, class: ['role-title'], style: { 'font-size': '96px' },
      }],
    })),
  });
}

let workDir = '';
let rootDir = '';
let remoteRoot = '';
let appDir = '';
let profileDir = '';
let server: RunningCollabServer | null = null;
let link: CuttableLink | null = null;
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;
const replicas: OfflineReplica[] = [];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'remote-desktop-'));
  rootDir = join(workDir, 'server');
  remoteRoot = join(workDir, 'mirrors');
  appDir = join(workDir, 'app');
  profileDir = join(workDir, 'profile');
  await mkdir(join(rootDir, 'lab', 'talk'), { recursive: true });
  await mkdir(appDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await saveDeck(join(rootDir, 'lab', 'talk'), talk());
  await writeFile(join(rootDir, 'lab', 'talk', 'theme.css'), '.role-title { font-family: Arial, sans-serif; color: #111; }\n');
  server = await startCollabServer({
    rootDir, port: 0, host: '127.0.0.1', localAgents: new LocalAgentRegistry({ name: 'Agent' }),
  });
  link = await startCuttableLink(server.port);
  await materializeDesktopApp(appDir, 'deckwerk-remote-deck-test');
}, 120_000);

afterEach(async () => {
  for (const replica of replicas.splice(0)) replica.close();
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  await link?.close();
  await server?.close();
  link = null;
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, 60_000);

/** `REMOTE_SHOTS=<dir>` keeps a screenshot of each step worth looking at. */
async function shot(cdp: Cdp, name: string): Promise<void> {
  const dir = process.env.REMOTE_SHOTS;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
  await writeFile(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
}

const serverUrl = () => `http://127.0.0.1:${link!.port}`;
const mirror = () => mirrorDirFor(remoteRoot, serverUrl(), DECK_ID);

async function launch(args: string[] = []): Promise<Cdp> {
  const app = await launchDesktopApp(appDir, args, { profileDir, env: { DECKWERK_REMOTE_ROOT: remoteRoot } });
  appProcess = app.process;
  const target = await findTarget(app.debugPort, isEditorTarget, app.log, 30_000);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  await cdp.call('Page.bringToFront');
  return cdp;
}

async function quit(): Promise<void> {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
}

/** A browser-style collaborator talking to the server directly. */
async function peer(): Promise<OfflineReplica> {
  const r = new OfflineReplica(`ws://127.0.0.1:${server!.port}/ws?deck=${encodeURIComponent(DECK_ID)}`, {
    name: 'Peer', plain: true,
  });
  replicas.push(r.connect());
  await r.until(() => r.welcomes > 0, 'peer welcome');
  return r;
}

const html = (deck: Deck | null, elementId: string) =>
  (deck?.slides.flatMap((s) => s.elements).find((e) => e.id === elementId) as { html?: string } | undefined)?.html ?? '';
const setHtml = (elementId: string, value: string) => (deck: Deck) => {
  (deck.slides.flatMap((s) => s.elements).find((e) => e.id === elementId) as { html: string }).html = value;
};

const chip = (cdp: Cdp) => cdp.evaluate<{ state: string; text: string } | null>(`(() => {
  const node = document.querySelector('.remote-status');
  return node && !node.hidden ? { state: node.dataset.state, text: node.textContent } : null;
})()`);

async function chipState(cdp: Cdp, state: string, what: string): Promise<void> {
  await eventually(() => chip(cdp), what, (value) => value?.state === state, 20_000);
}

async function mirroredDeck(): Promise<Deck> {
  return parseDeck(JSON.parse(await readFile(join(mirror(), 'deck.json'), 'utf8')));
}

/** Go to a slide by its rail row, then type at the end of its title. */
async function typeAtEndOfTitle(cdp: Cdp, slideId: string, elementId: string, text: string): Promise<void> {
  await cdp.click(`.rail-item[data-slide-id="${slideId}"]`, `rail row ${slideId}`);
  const content = `#canvas [data-element-id="${elementId}"] .text-content`;
  await eventually(() => cdp.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(content)}))`),
    `${elementId} on the canvas`);
  await cdp.doubleClickTextAtOffset(content, 1, `${elementId} text`);
  await cdp.key('End', 35);
  await cdp.typeKeys(text);
  await cdp.key('Escape', 27);
}

/** Welcome screen → Open from a server → connect → folder → deck. */
async function openFromServer(cdp: Cdp): Promise<void> {
  await eventually(() => cdp.evaluate<boolean>(`Boolean(document.querySelector('[data-action="server"]')?.getClientRects().length)`),
    'the welcome screen');
  await cdp.click('[data-action="server"]', 'Open from a server');
  await eventually(() => cdp.evaluate<boolean>(`Boolean(document.querySelector('.open-dialog-connect input'))`),
    'the connect form');
  await shot(cdp, '1-connect');
  await cdp.typeInto('.open-dialog-connect input', serverUrl(), 'server address');
  await eventually(() => cdp.evaluate<boolean>(`Boolean(document.querySelector('.open-dialog-row[data-folder="lab"]'))`),
    'the server listing');
  await shot(cdp, '2-listing');
  await cdp.click('.open-dialog-row[data-folder="lab"]', 'the lab folder');
  await shot(cdp, '3-folder');
  await cdp.click(`.open-dialog-row[data-deck-id="${DECK_ID}"]`, 'the deck row');
}

describe('desktop editing a server deck', () => {
  it('opens from the Open dialog, syncs live, edits offline, and merges through the dialog', async () => {
    editor = await launch();
    await openFromServer(editor);
    await chipState(editor, 'online', 'the deck to connect');
    await shot(editor, '4-online');
    expect(existsSync(join(mirror(), '.deckwerk-remote', 'sync.json'))).toBe(true);
    const other = await peer();

    // Live, both ways.
    await typeAtEndOfTitle(editor, 's1', 't1', ' live');
    await other.until(() => html(other.deck, 't1').includes('live'), 'typing to reach the server');
    other.edit('Peer', setHtml('t2', 'Peer two'));
    await eventually(async () => html(await mirroredDeck(), 't2'), 'the peer edit in the mirror',
      (value) => value === 'Peer two', 20_000);

    // Offline: the chip says so and editing goes on.
    link!.cut();
    await chipState(editor, 'offline', 'the chip to say offline');
    await typeAtEndOfTitle(editor, 's1', 't1', ' offline');
    await typeAtEndOfTitle(editor, 's3', 't3', ' mine');
    await eventually(() => chip(editor!), 'unsent changes counted', (value) => /kept on this computer/.test(value?.text ?? ''));
    other.edit('Peer 3', setHtml('t3', 'Peer three'));
    other.edit('Peer 2', setHtml('t2', 'Peer two again'));
    await other.until(() => other.bridge.unconfirmed === 0, 'peer confirmation');
    await shot(editor, '5-offline');
    // Offline edits are saved on this computer.
    await eventually(async () => html(await mirroredDeck(), 't3'), 'the offline edit on disk',
      (value) => value.includes('mine'), 20_000);

    // Back online: slide 3 changed on both sides, so the dialog asks.
    link!.restore();
    await editor.click('.remote-status', 'retry now');
    await eventually(() => editor!.evaluate<string[]>(`[...document.querySelectorAll('.merge-item')].map((n) => n.dataset.mergeKey)`),
      'the merge dialog', (keys) => keys.length > 0, 20_000);
    expect(await editor.evaluate<string[]>(`[...document.querySelectorAll('.merge-item')].map((n) => n.dataset.mergeKey)`))
      .toEqual(['slide:s3']);
    // Both versions are drawn as miniatures.
    expect(await editor.evaluate<number>(`document.querySelectorAll('.merge-item .merge-thumb .rail-thumb-inner').length`)).toBe(2);
    // …with what each side changed outlined and said in words, since two
    // versions of a busy slide look alike at that size.
    expect(await editor.evaluate<string[]>(`[...document.querySelectorAll('.merge-item .merge-thumb .merge-changed')].map((n) => n.dataset.elementId)`))
      .toEqual(['t3', 't3']);
    expect(await editor.evaluate<string[]>(`['local', 'remote'].map((side) =>
      document.querySelector('.merge-item .merge-side[data-side="' + side + '"] .merge-side-changes')?.textContent ?? '')`))
      .toEqual(['Changed “Title 3 mine”', 'Changed “Peer three”']);
    await shot(editor, '6-merge');
    await editor.click('.merge-item[data-merge-key="slide:s3"] .merge-side[data-side="local"]', 'your version');
    await shot(editor, '7-merge-chosen');
    await editor.clickByText('.merge-dialog button', 'Sync');

    await other.until(() => html(other.deck, 't3').includes('mine') && html(other.deck, 't1').includes('offline'),
      'the merge to reach the server', 20_000);
    expect(html(other.deck, 't1')).toMatch(/live.*offline/);
    expect(html(other.deck, 't2')).toBe('Peer two again');
    await chipState(editor, 'online', 'synced again');
    await shot(editor, '8-synced');
    await eventually(async () => html(await mirroredDeck(), 't2'), 'the merged deck on disk',
      (value) => value === 'Peer two again', 20_000);
  }, 180_000);

  it('keeps edits across a quit while offline, and merges them on the next open', async () => {
    editor = await launch();
    await openFromServer(editor);
    await chipState(editor, 'online', 'the deck to connect');
    link!.cut();
    await chipState(editor, 'offline', 'offline');
    await typeAtEndOfTitle(editor, 's2', 't2', ' before quitting');
    await eventually(async () => html(await mirroredDeck(), 't2'), 'the offline edit on disk',
      (value) => value.includes('before quitting'), 20_000);
    await quit();

    const other = await peer();
    other.edit('Peer', setHtml('t1', 'While the laptop was shut'));
    await other.until(() => other.bridge.unconfirmed === 0, 'peer confirmation');

    link!.restore();
    editor = await launch([mirror()]);
    await chipState(editor, 'online', 'the reopened deck to connect');
    await other.until(() => html(other.deck, 't2').includes('before quitting'), 'the offline edit to reach the server', 20_000);
    expect(html(other.deck, 't1')).toBe('While the laptop was shut');
    await eventually(async () => html(await mirroredDeck(), 't1'), 'the peer edit in the mirror',
      (value) => value === 'While the laptop was shut', 20_000);
    // No dialog: the two sides changed different slides.
    expect(await editor.evaluate<number>(`document.querySelectorAll('.merge-dialog').length`)).toBe(0);
  }, 180_000);

  it('opens a server deck from the Open dialog while the server cannot be reached', async () => {
    editor = await launch();
    await openFromServer(editor);
    await chipState(editor, 'online', 'the deck to connect');
    await quit();

    // On the plane: the server tab lists what is already on this computer.
    link!.cut();
    editor = await launch();
    const cdp = editor;
    await eventually(() => cdp.evaluate<boolean>(`Boolean(document.querySelector('[data-action="server"]')?.getClientRects().length)`),
      'the welcome screen');
    await cdp.click('[data-action="server"]', 'Open from a server');
    const row = `.open-dialog-listing.is-offline .open-dialog-row[data-deck-id="${DECK_ID}"]`;
    await eventually(() => cdp.evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(row)}))`),
      'the copies on this computer', Boolean, 20_000);
    expect(await cdp.evaluate<string>(`document.querySelector(${JSON.stringify(row)}).textContent`)).toMatch(/Server talk.*last synced/);
    await shot(cdp, '9-offline-open');
    await cdp.click(row, 'the copy of the deck');
    await chipState(cdp, 'offline', 'the copy to open offline');
    expect(await cdp.evaluate<number>(`document.querySelectorAll('.rail-item').length`)).toBe(3);
    await typeAtEndOfTitle(cdp, 's1', 't1', ' on the plane');
    await eventually(async () => html(await mirroredDeck(), 't1'), 'the offline edit on disk',
      (value) => value.includes('on the plane'), 20_000);

    // Landed: the edit goes up.
    link!.restore();
    await cdp.click('.remote-status', 'retry now');
    await chipState(cdp, 'online', 'back online');
    const other = await peer();
    await other.until(() => html(other.deck, 't1').includes('on the plane'), 'the offline edit on the server', 20_000);
  }, 180_000);

  it('fetches a picture a collaborator added and draws it', async () => {
    editor = await launch();
    await openFromServer(editor);
    await chipState(editor, 'online', 'the deck to connect');
    const other = await peer();
    await writeFile(join(rootDir, 'lab', 'talk', 'assets', 'pixel.png'), PNG).catch(async () => {
      await mkdir(join(rootDir, 'lab', 'talk', 'assets'), { recursive: true });
      await writeFile(join(rootDir, 'lab', 'talk', 'assets', 'pixel.png'), PNG);
    });
    other.edit('Add a picture', (deck) => {
      deck.slides[0].elements.push({ id: 'pic', type: 'image', x: 0, y: 0, w: 200, h: 200, src: 'assets/pixel.png' } as never);
    });
    await eventually(async () => existsSync(join(mirror(), 'assets', 'pixel.png')), 'the picture in the mirror', Boolean, 20_000);
    await eventually(() => editor!.evaluate<number>(`(() => {
      const img = document.querySelector('#canvas [data-element-id="pic"] img');
      return img && img.complete ? img.naturalWidth : 0;
    })()`), 'the picture drawn on the canvas', (width) => width > 0, 20_000);
  }, 180_000);
});
