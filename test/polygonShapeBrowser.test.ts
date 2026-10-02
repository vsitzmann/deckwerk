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
 * A trapezoid from the Shape menu, reshaped by dragging a corner.
 *
 * (Header carried over from the line-draw suite this was copied from:)
 * Line draw on an arrow, set up the way an author does it.
 *
 * Select the arrow, Build → Add animation, pick "line draw", present, click:
 * the arrow is visible at once but only partly drawn, and whole when its
 * time is up. The rest of this header describes the rectangle suite it was
 * copied from:
 *
 * Double-click a rectangle and type.
 *
 * The rectangle becomes a text box with the same fill, border and corners,
 * the caret is in it, and what is typed is the label — one object with the
 * shape's id, so it still drags, builds and morphs as the shape did. Props
 * then shows the box's fill and a shadow for its text.
 */
const DECK_ID = 'shape-text';

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

describe.skipIf(!electronBinary)('a four-sided shape with corners to drag', () => {
  it('inserts a trapezoid and moves one corner, the rest staying put', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'polygon-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Polygon'));
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Poly`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('.shape-menu-trigger'))`), 'no toolbar');
    // The toolbar keeps a compact copy of its controls; open the visible one.
    await editor.evaluate(`[...document.querySelectorAll('.shape-menu-trigger')]
      .find((node) => node.getBoundingClientRect().width > 0 && node.textContent?.trim() === 'Shape')?.click()`);
    await editor.clickByText('.shape-menu-item', 'Trapezoid', 'Trapezoid');
    const saved = async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return (await response.json() as Deck).slides[0].elements.find((e) => e.type === 'shape');
    };
    const inserted = await eventually(saved, 'no trapezoid was inserted', (el) => el?.type === 'shape' && el.shape === 'path');
    expect(await editor.evaluate<number>(`document.querySelectorAll('.handle-corner').length`)).toBe(4);

    // Drag the top-left corner 100 canvas px to the right.
    const handle = await editor.evaluate<{ x: number; y: number; scale: number }>(`(() => {
      const box = document.querySelector('.handle-corner[data-corner="0"]').getBoundingClientRect();
      const slide = document.querySelector('#canvas .slide').getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, scale: slide.width / 1920 };
    })()`);
    const mouse = (type: string, x: number, y: number) => editor!.call('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });
    await mouse('mouseMoved', handle.x, handle.y);
    await mouse('mousePressed', handle.x, handle.y);
    await mouse('mouseMoved', handle.x + 50 * handle.scale, handle.y);
    await mouse('mouseMoved', handle.x + 100 * handle.scale, handle.y);
    await mouse('mouseReleased', handle.x + 100 * handle.scale, handle.y);
    const moved = await eventually(saved, 'the corner never moved in the saved deck',
      (el) => el?.type === 'shape' && el.path !== (inserted as { path: string }).path);
    expect(moved?.type === 'shape' && moved.path).toMatch(/^M 180 0 L 320 0 L 400 240 L 0 240 Z$/);
    if (process.env.DECKWERK_TEST_SHOTS) {
      const { data } = await editor.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile(join(process.env.DECKWERK_TEST_SHOTS, 'polygon.png'), Buffer.from(data, 'base64'));
    }
  });
});
