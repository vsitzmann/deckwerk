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
 * Gradient fills and curved (paper) shadows in the real editor.
 *
 * A deck with one gradient rectangle that casts a curved shadow. The shape
 * renders its gradient as an SVG paint server and carries the curl class;
 * Props shows the fill style and the shadow's Curved style, and switching the
 * fill to radial is saved.
 */
const DECK_ID = 'shape-look';

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

const shot = async (name: string): Promise<void> => {
  if (!process.env.DECKWERK_TEST_SHOTS) return;
  const { data } = await editor!.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
  await writeFile(join(process.env.DECKWERK_TEST_SHOTS, name), Buffer.from(data, 'base64'));
};

describe.skipIf(!electronBinary)('gradient fills and curved shadows', () => {
  it('paints a gradient with a paper shadow and edits both', { timeout: 150_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'look-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const deck = emptyDeck('Look');
    deck.slides[0].elements.push({
      id: 'card', type: 'shape', shape: 'rect', x: 560, y: 300, w: 800, h: 460, rot: 0, z: 1, opacity: 1,
      class: [], style: { '--curl-color': 'rgba(0, 0, 0, 0.5)', '--curl-blur': '14px', '--curl-lift': '20px' },
      fill: '#7b90e1', fillGradient: { to: '#ec6b14', angle: 270, kind: 'linear' },
      stroke: null, strokeWidth: 0, radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    } as Deck['slides'][number]['elements'][number]);
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #f3f1ec; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Look`;
    browser = await launchBrowser(url, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const card = '.slide-layer [data-element-id="card"]';
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('${card} svg'))`), 'no card');

    // The gradient is a paint server, and the curl is on.
    const painted = await editor.evaluate<{ fill: string; stops: string[]; curl: boolean }>(`(() => {
      const node = document.querySelector('${card}');
      const rect = node.querySelector('svg rect');
      return {
        fill: rect.getAttribute('fill'),
        stops: [...node.querySelectorAll('stop')].map((s) => s.getAttribute('stop-color')),
        curl: node.classList.contains('shadow-curved'),
      };
    })()`);
    expect(painted.fill).toMatch(/^url\(#fill-card\)$/);
    expect(painted.stops).toEqual(['#7b90e1', '#ec6b14']);
    expect(painted.curl).toBe(true);

    await editor.click(card, 'the card');
    await eventually(async () => editor!.evaluate<boolean>(`[...document.querySelectorAll('.field select')]
      .some((s) => s.value === 'Linear gradient')`), 'no fill style field');
    const shadowStyle = await editor.evaluate<string | null>(`(() => {
      const s = [...document.querySelectorAll('.field')].find((f) => f.querySelector('span')?.textContent === 'Style');
      return s?.querySelector('select')?.value ?? null;
    })()`);
    expect(shadowStyle).toBe('Curved');
    await shot('look-dark.png');

    // Radial, through the inspector, saved to the deck.
    await editor.evaluate(`(() => {
      const select = [...document.querySelectorAll('.field select')].find((s) => s.value === 'Linear gradient');
      select.value = 'Radial gradient';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const saved = async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return (await response.json() as Deck).slides[0].elements[0];
    };
    await eventually(saved, 'the radial gradient was not saved',
      (el) => el.type === 'shape' && el.fillGradient?.kind === 'radial');
  });
});
