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

/**
 * Double-click a rectangle and type.
 *
 * The rectangle becomes a text box with the same fill, border and corners,
 * the caret is in it, and what is typed is the label — one object with the
 * shape's id, so it still drags, builds and morphs as the shape did. Props
 * then shows the box's fill and a shadow for its text.
 */
const DECK_ID = 'shape-text';
const BOX_ID = 'label-box';
const BOX = `#canvas [data-element-id="${BOX_ID}"]`;
const PANEL = '#inspector';
const SHOTS = process.env.DECKWERK_TEST_SHOTS ?? '';

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

describe.skipIf(!electronBinary)('typing into a rectangle', () => {
  it('turns it into one labelled box and offers its fill and a text shadow', {
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'shape-text-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Shape text');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: BOX_ID, type: 'shape', x: 400, y: 300, w: 640, h: 360, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, shape: 'rect', fill: '#dbe4ff', stroke: '#3f55b5',
      strokeWidth: 4, radius: 24, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    } as never);
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #fff; color: #111827; font: 400 48px/1.3 sans-serif; }', '',
    ].join('\n'), 'utf8');

    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Label`, profileDir,
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

    const saved = async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      const live = await response.json() as Deck;
      return live.slides[0].elements.find((candidate) => candidate.id === BOX_ID)!;
    };
    const shot = async (name: string) => {
      if (!SHOTS) return;
      const { data } = await editor!.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
    };

    await editor.doubleClick(BOX, 'the rectangle');
    await eventually(async () => editor!.evaluate<boolean>(
      `document.querySelector('${BOX} .text-content')?.isContentEditable === true`),
      'double-clicking the rectangle did not open it for typing');
    await editor.typeKeys('Agent');
    await wait(700);

    const element = await saved();
    expect(element.type, 'the rectangle became a text box').toBe('text');
    if (element.type !== 'text') return;
    console.log('TYPED HTML', element.html);
    expect(element.html.replace(/<[^>]+>/g, '')).toBe('Agent');
    expect(element.class).not.toContain('placeholder');
    expect(element).toMatchObject({ x: 400, y: 300, w: 640, h: 360, align: 'center', valign: 'middle' });
    expect(element.style).toMatchObject({
      'background-color': '#dbe4ff', border: '4px solid #3f55b5', 'border-radius': '24px',
    });
    // And it still looks like the rectangle on the canvas.
    const painted = await editor.evaluate<{ background: string; radius: string; width: number }>(`(() => {
      const node = document.querySelector('${BOX}');
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, radius: style.borderTopLeftRadius, width: node.offsetWidth };
    })()`);
    expect(painted).toEqual({ background: 'rgb(219, 228, 255)', radius: '24px', width: 640 });
    await shot('typing');

    // Leave the text; the box stays selected with its own sections in Props.
    await editor.key('Escape', 27);
    await eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('${PANEL} .text-box-options'))`),
      'Props has no Box section for the labelled box');
    const toggle = await editor.evaluate<boolean>(`(() => {
      const wrap = [...document.querySelectorAll('${PANEL} .text-shadow-options .field-check')]
        .find((node) => node.querySelector('span')?.textContent === 'Drop shadow');
      const input = wrap?.querySelector('input');
      if (!input) return false;
      input.id = 'test-text-shadow';
      input.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    expect(toggle, 'Props → Text shadow has a Drop shadow checkbox').toBe(true);
    await editor.click('#test-text-shadow', 'Text shadow checkbox');
    await eventually(saved, 'the text shadow never reached the saved deck',
      (live) => live.style['text-shadow'] === '0px 4px 10px rgba(0, 0, 0, 0.35)');
    expect(await editor.evaluate<boolean>(
      `Boolean(document.querySelector('${PANEL} .box-shadow-options'))`),
      'a filled box also offers a box shadow').toBe(true);
    await shot('props');
  });
});
