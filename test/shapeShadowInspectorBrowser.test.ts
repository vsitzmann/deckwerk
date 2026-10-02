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
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Props → Shadow on a shape.
 *
 * The control is a checkbox plus colour, offset and blur. It has to do three
 * things an author can see: tick it and the shape on the canvas casts a
 * shadow, change a number and that shadow changes, untick it and the shadow
 * is gone — and each of those has to reach the saved deck, not only the DOM.
 */
const DECK_ID = 'shape-shadow';
const BOX_ID = 'shadow-box';
const BOX = `#canvas [data-element-id="${BOX_ID}"]`;
const PANEL = '#inspector';

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

describe.skipIf(!electronBinary)('giving a shape a drop shadow from the inspector', () => {
  it('adds, tunes and removes the shadow on the canvas and in the deck', {
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'shape-shadow-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Shape shadow');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: BOX_ID, type: 'shape', x: 400, y: 300, w: 600, h: 360, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, shape: 'rect', fill: '#dbe4ff', stroke: null,
      strokeWidth: 0, radius: 24, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    } as never);
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111827; }\n', 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Shadow`, profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('${BOX}'))`), 'the shape fixture never loaded');
    await editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
    await editor.click(BOX, 'the shape');

    const savedFilter = async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      const live = await response.json() as Deck;
      return live.slides[0].elements.find((candidate) => candidate.id === BOX_ID)?.style.filter ?? '';
    };
    const paintedFilter = async () => editor!.evaluate<string>(
      `getComputedStyle(document.querySelector('${BOX}')).filter`);
    /** Give the control a stable id so it can be clicked like any element. */
    const tag = async (kind: 'check' | 'number', label: string, id: string) => {
      const found = await editor!.evaluate<boolean>(`(() => {
        const wrap = [...document.querySelectorAll('${PANEL} .shape-shadow-options .field-${kind}')]
          .find((node) => node.querySelector('span')?.textContent === ${JSON.stringify(label)});
        const input = wrap?.querySelector('input');
        if (!input) return false;
        input.id = ${JSON.stringify(id)};
        return true;
      })()`);
      expect(found, `Props → Shadow has a "${label}" control`).toBe(true);
    };

    // Off by default, with nothing to tune yet.
    await eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('${PANEL} .shape-shadow-options'))`),
      'the Shadow section is missing for a selected shape');
    expect(await paintedFilter()).toBe('none');
    expect(await editor.evaluate<number>(
      `document.querySelectorAll('${PANEL} .shape-shadow-options .field-number').length`)).toBe(0);

    // Tick it: the default shadow is painted and saved.
    await tag('check', 'Drop shadow', 'test-shadow-toggle');
    await editor.click('#test-shadow-toggle', 'Drop shadow checkbox');
    await eventually(paintedFilter, 'the shape never cast a shadow on the canvas',
      (filter) => filter.includes('drop-shadow'));
    await eventually(savedFilter, 'the shadow never reached the saved deck',
      (filter) => filter === 'drop-shadow(0px 8px 24px rgba(0, 0, 0, 0.3))');

    // Change the blur: the same shadow, retuned.
    await tag('number', 'BLUR', 'test-shadow-blur');
    await editor.click('#test-shadow-blur', 'Blur field');
    await editor.evaluate('document.getElementById("test-shadow-blur").select()');
    await editor.typeKeys('40');
    await editor.key('Enter', 13);
    await eventually(savedFilter, 'the new blur never reached the saved deck',
      (filter) => filter === 'drop-shadow(0px 8px 40px rgba(0, 0, 0, 0.3))');
    await eventually(paintedFilter, 'the canvas kept the old blur',
      (filter) => filter.includes('40px'));

    // Turn it: the same 8 px offset, now falling to the right instead of down.
    await tag('number', 'ANGLE', 'test-shadow-angle');
    expect(await editor.evaluate<string>('document.getElementById("test-shadow-angle").value')).toBe('270');
    await editor.click('#test-shadow-angle', 'Angle field');
    await editor.evaluate('document.getElementById("test-shadow-angle").select()');
    await editor.typeKeys('0');
    await editor.key('Enter', 13);
    await eventually(savedFilter, 'the new angle never reached the saved deck',
      (filter) => filter === 'drop-shadow(8px 0px 40px rgba(0, 0, 0, 0.3))');

    // Turn it with the knob: dragging to the top points the shadow up, and
    // the whole drag is one change to the deck.
    const dial = await editor.evaluate<{ x: number; y: number; r: number } | null>(`(() => {
      const node = document.querySelector('${PANEL} .shape-shadow-options .angle-dial');
      if (!node) return null;
      node.scrollIntoView({ block: 'center' });
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, r: box.width / 2 - 3 };
    })()`);
    expect(dial, 'the Shadow section has an angle knob').not.toBeNull();
    const mouse = (type: string, x: number, y: number) => editor!.call('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });
    await mouse('mouseMoved', dial!.x + dial!.r, dial!.y);
    await mouse('mousePressed', dial!.x + dial!.r, dial!.y);
    await mouse('mouseMoved', dial!.x + dial!.r * 0.7, dial!.y - dial!.r * 0.7);
    await mouse('mouseMoved', dial!.x, dial!.y - dial!.r);
    await mouse('mouseReleased', dial!.x, dial!.y - dial!.r);
    await eventually(savedFilter, 'turning the knob never reached the saved deck',
      (filter) => filter === 'drop-shadow(0px -8px 40px rgba(0, 0, 0, 0.3))');
    expect(await editor.evaluate<string>(
      `document.querySelector('${PANEL} .shape-shadow-options .angle-dial').getAttribute('aria-valuenow')`)).toBe('90');
    if (process.env.DECKWERK_TEST_SHOTS) {
      const { data } = await editor.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile(join(process.env.DECKWERK_TEST_SHOTS, 'shadow-knob.png'), Buffer.from(data, 'base64'));
    }

    // Untick it: no filter left behind.
    await tag('check', 'Drop shadow', 'test-shadow-toggle-2');
    await editor.click('#test-shadow-toggle-2', 'Drop shadow checkbox');
    await eventually(savedFilter, 'the shadow stayed in the saved deck', (filter) => filter === '');
    await eventually(paintedFilter, 'the shadow stayed on the canvas', (filter) => filter === 'none');
  });
});
