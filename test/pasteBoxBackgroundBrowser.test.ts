import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  wait,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

const DECK_ID = 'paste-background';
const BOX_ID = 'label-box';
const BOX = `#canvas [data-element-id="${BOX_ID}"]`;

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/**
 * Copy styled text out of a box being edited, paste it into a filled box.
 *
 * Chromium writes the background of the nearest painted ancestor onto the
 * copied run — the editor's editing tint, or the source box's own fill — so
 * the pasted words used to sit on a coloured slab inside their new box.
 */
describe.skipIf(!electronBinary)('pasting text copied from another box', () => {
  it('keeps its colour and type but brings no background', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'paste-background-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const deck = emptyDeck('Paste');
    deck.slides[0].elements.push({
      id: 'src', type: 'text', x: 100, y: 100, w: 800, h: 200, rot: 0, z: 1, opacity: 1,
      class: [], style: { color: '#ffffff', 'font-weight': '700', 'font-size': '60px', 'background-color': '#3f55b5' }, html: 'Something like this!', align: 'left', valign: 'middle',
    } as never, {
      id: BOX_ID, type: 'text', x: 400, y: 500, w: 640, h: 360, rot: 0, z: 2, opacity: 1,
      class: ['placeholder'], style: { 'background-color': '#000000' }, html: 'Text', align: 'center', valign: 'middle', autoFit: true,
    } as never);
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #888; color: #111; font: 400 48px/1.3 sans-serif; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=P`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await editor.call('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => {});
    const SRC = '#canvas [data-element-id="src"]';
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('${SRC}'))`), 'no fixture');
    await editor.doubleClick(`${SRC} .text-content`, 'source');
    await eventually(async () => editor!.evaluate<boolean>(`document.querySelector('${SRC} .text-content')?.isContentEditable === true`), 'no edit');
    await editor.chord('a', 'KeyA', 65, 4, ['selectAll']);
    await editor.chord('c', 'KeyC', 67, 4, ['copy']);
    await editor.key('Escape', 27);
    await wait(300);
    await editor.doubleClick(BOX, 'box');
    await eventually(async () => editor!.evaluate<boolean>(`document.querySelector('${BOX} .text-content')?.isContentEditable === true`), 'no edit 2');
    await editor.chord('v', 'KeyV', 86, 4, ['paste']);
    await wait(300);
    await editor.key('Escape', 27);
    await wait(700);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/deck?deck=${DECK_ID}`);
    const live = await response.json() as Deck;
    const pasted = live.slides[0].elements.find((e) => e.id === BOX_ID);
    expect(pasted?.type).toBe('text');
    if (pasted?.type !== 'text') return;
    expect(pasted.html).toContain('Something like this!');
    expect(pasted.html, 'the copied run keeps its look').toMatch(/font-weight:\s*700/);
    expect(pasted.html, 'but not the tint or fill it was copied from').not.toMatch(/background/);
    expect(pasted.style['background-color']).toBe('#000000');
  });
});
