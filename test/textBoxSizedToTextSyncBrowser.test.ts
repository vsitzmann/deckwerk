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
 * Boxes sized to their text never paint a stale size.
 *
 * The fitted size of such a box is a measurement: it lives in this editor's
 * store, not on the server. So every deck that arrives from elsewhere — and in
 * a hosted session the server answers every keystroke with one — carries the
 * size each box had when it was last really edited. The fit used to run a
 * frame after the render that put those sizes back, so each of them was
 * painted for a frame: turning "Size box to text" on flashed the other labels,
 * typing into one label made every other label flicker, and the label being
 * typed into jumped back to its old width every few keys and was left there
 * when the edit ended.
 *
 * Sizes are sampled in an animation-frame callback, which runs after the
 * work that changed them and before the frame is painted, so a sample is
 * what the person sees. Real input throughout.
 */
const DECK_ID = 'sized-text';

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

const text = (id: string, x: number, y: number, w: number, h: number, html: string, extra: object = {}) => ({
  id, type: 'text', x, y, w, h, rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
  html, align: 'left', valign: 'top', ...extra,
});

/** Every painted size of every text box, from now on, keyed by phase. */
const RECORD = `(() => {
  window.__painted = [];
  window.__phase = 'settled';
  const last = new Map();
  const sample = () => {
    for (const node of document.querySelectorAll('#canvas .slide-layer .element-text')) {
      const size = node.offsetLeft + ',' + node.offsetWidth + 'x' + node.offsetHeight;
      if (last.get(node.dataset.elementId) === size) continue;
      last.set(node.dataset.elementId, size);
      window.__painted.push({ phase: window.__phase, id: node.dataset.elementId, w: node.offsetWidth, h: node.offsetHeight });
    }
    requestAnimationFrame(sample);
  };
  sample();
})()`;

type Painted = { phase: string; id: string; w: number; h: number };

describe.skipIf(!electronBinary)('text boxes sized to their text, in a hosted session', () => {
  it('fit at once when switched on, and never flicker while another one is typed into', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sized-text-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const deck = emptyDeck('Sized text');
    // Two labels stored at a size that is not their text's, as a deck written
    // elsewhere holds them, and an ordinary wrapping box.
    deck.slides[0].elements = [
      text('column', 100, 100, 300, 300, 'The quick brown fox jumps over the lazy dog'),
      text('typed', 100, 600, 200, 80, 'Label one', { autoSize: true }),
      text('other', 900, 600, 200, 80, 'Label two', { autoSize: true }),
    ] as Deck['slides'][number]['elements'];
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Sized`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const cdp = editor;
    const size = (id: string) => cdp.evaluate<{ w: number; h: number }>(`(() => {
      const node = document.querySelector('#canvas [data-element-id="${id}"]');
      return node ? { w: node.offsetWidth, h: node.offsetHeight } : null;
    })()`);
    // Settled: both labels fitted to their text on open.
    const fitted = (await eventually(async () => {
      const [typed, other] = await Promise.all([size('typed'), size('other')]);
      return typed && other && typed.w !== 200 && other.w !== 200 ? { typed, other } : null;
    }, 'the labels never fitted their text'))!;
    await cdp.evaluate(RECORD);
    const painted = () => cdp.evaluate<Painted[]>('window.__painted');
    const centre = (id: string) => cdp.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('#canvas [data-element-id="${id}"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    const phase = (name: string) => cdp.evaluate(`window.__phase = ${JSON.stringify(name)}`);

    // Switch "Size box to text" on for the wrapping box.
    let at = await centre('column');
    await cdp.clickAt(at.x, at.y);
    await eventually(async () => cdp.evaluate<boolean>(`[...document.querySelectorAll('.field')]
      .some((f) => f.getBoundingClientRect().width > 0 && f.textContent.trim().startsWith('Size box to text'))`),
    'the inspector never offered Size box to text');
    await phase('toggle');
    await cdp.evaluate(`[...document.querySelectorAll('.field')]
      .find((f) => f.getBoundingClientRect().width > 0 && f.textContent.trim().startsWith('Size box to text'))
      .querySelector('input').click()`);
    const column = (await eventually(async () => {
      const s = await size('column');
      return s && s.h < 300 ? s : null;
    }, 'switching Size box to text on never fitted the box'))!;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const toggled = (await painted()).filter((p) => p.phase === 'toggle');
    // The box went straight to its fitted size; the labels were never repainted.
    expect(toggled.filter((p) => p.id === 'column')).toEqual([{ phase: 'toggle', id: 'column', ...column }]);
    expect(toggled.filter((p) => p.id !== 'column')).toEqual([]);

    // Type into one label, a key at a time, each answered by the server.
    at = await centre('typed');
    await cdp.doubleClickAt(at.x, at.y);
    await eventually(async () => cdp.evaluate<boolean>(
      `document.querySelector('#canvas [data-element-id="typed"] .text-content').isContentEditable`),
    'double-clicking the label did not open it for editing');
    await cdp.key('End', 35);
    await phase('typing');
    await cdp.typeKeys(' grows and grows', 40);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await phase('ended');
    await cdp.key('Escape', 27);
    await new Promise((resolve) => setTimeout(resolve, 800));

    const typing = (await painted()).filter((p) => p.phase === 'typing' || p.phase === 'ended');
    // The other boxes did not move at all.
    expect(typing.filter((p) => p.id !== 'typed')).toEqual([]);
    // The label grew a key at a time and never jumped back.
    const widths = typing.filter((p) => p.id === 'typed').map((p) => p.w);
    expect(widths.length).toBeGreaterThan(5);
    for (let i = 1; i < widths.length; i++) expect(widths[i], `paint ${i}: ${widths.join(', ')}`).toBeGreaterThan(widths[i - 1]);
    // Its size went to the server with its text, so it is what everyone gets.
    const final = (await size('typed'))!;
    expect(final.w).toBeGreaterThan(fitted.typed.w * 2);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/deck?deck=${DECK_ID}`);
    const saved = (await response.json() as Deck).slides[0].elements.find((e) => e.id === 'typed')!;
    expect(saved.w).toBe(final.w);
  });
});
