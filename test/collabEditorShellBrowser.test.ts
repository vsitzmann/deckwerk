import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
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
 * The editor shell's keyboard map and clipboard, in the browser collaboration
 * edition, driven by real input.
 *
 * The desktop suites (`desktopTextFormattingBrowser`, `clipboardImageBrowser`,
 * `webImageDropBrowser`, ...) prove these journeys through Electron's preload
 * bridge and the OS pasteboard. The Web UI has neither: `window.api` is the
 * HTTP stand-in from `netApi.ts`, Cmd+C parks the selection in an in-memory
 * clipboard, and Cmd+V reaches the page as a native `paste` event whose
 * `clipboardData` holds nothing of ours. That seam was untested, and copying
 * a video from one slide to another silently did nothing.
 *
 * So this file mirrors the desktop coverage for the shell: every chord below
 * is a genuine CDP key event (Cmd+V carries Chromium's `paste` editing
 * command, which is what makes the browser emit the ClipboardEvent), every
 * click lands on laid-out pixels, and every outcome is read from three places
 * the author cares about: the canvas, the store, and the deck the server
 * persisted.
 */

const DECK_ID = 'shell-browser';
const OTHER_DECK_ID = 'shell-browser-other';
const USER = 'Shell Browser';
const MP4 = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'testclip.mp4');
const PNG = join(process.cwd(), 'decks', 'demo-deck', 'assets', 'swatch.png');

const TEXT_ID = 'shell-text';
const SHAPE_ID = 'shell-shape';
const VIDEO_ID = 'shell-video';
const IMAGE_ID = 'shell-image';
const PASTE_OFFSET = 24;

/** CDP modifier bits. */
const MOD = process.platform === 'darwin' ? 4 : 2;
const SHIFT = 8;

const ON_CANVAS = (id: string) => `#canvas [data-element-id="${id}"]`;

interface ElementSummary {
  id: string;
  type: string;
  x: number;
  y: number;
  src?: string;
}

interface StoreSnapshot {
  slideIndex: number;
  selection: string[];
  slideSelection: string[];
  slides: ElementSummary[][];
  status: string;
}

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

function fixtureDeck(): Deck {
  const deck = emptyDeck('Shell shortcuts');
  deck.slides[0].elements.push(
    {
      id: TEXT_ID, type: 'text', x: 120, y: 80, w: 900, h: 120, rot: 0, z: 1, opacity: 1,
      class: ['role-body'], style: {}, html: 'Shell text box', align: 'left', valign: 'top',
    },
    {
      id: SHAPE_ID, type: 'shape', x: 1200, y: 100, w: 400, h: 240, rot: 0, z: 2, opacity: 1,
      class: [], style: {}, shape: 'rect', fill: '#f59e0b', stroke: '#111827', strokeWidth: 4,
      radius: 16, path: null, pathSize: null, arrowStart: false, arrowEnd: false,
    },
    {
      id: VIDEO_ID, type: 'video', x: 120, y: 400, w: 800, h: 450, rot: 0, z: 3, opacity: 1,
      class: [], style: {}, src: 'assets/testclip.mp4', fit: 'contain', autoplay: false,
      loop: true, muted: true, controls: false, start: 0, end: null, poster: null, sourceBox: null,
    },
    {
      id: IMAGE_ID, type: 'image', x: 1200, y: 500, w: 400, h: 300, rot: 0, z: 4, opacity: 1,
      class: [], style: {}, src: 'assets/swatch.png', fit: 'contain', alt: 'Swatch', sourceBox: null,
    },
  );
  deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'slide-two', elements: [] });
  return deck;
}

async function openEditor(): Promise<Cdp> {
  workDir = await mkdtemp(join(tmpdir(), 'collab-shell-browser-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, DECK_ID);
  const clientDir = await collabClientDir();
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(join(deckDir, 'assets'), { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await copyFile(MP4, join(deckDir, 'assets', 'testclip.mp4'));
  await copyFile(PNG, join(deckDir, 'assets', 'swatch.png'));
  await saveDeck(deckDir, fixtureDeck());
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #ffffff; color: #111827; }',
    '.role-body { font: 400 40px/1.3 sans-serif; }',
    '',
  ].join('\n'), 'utf8');

  // A second presentation on the same server, to paste into from this one.
  await mkdir(join(decksRoot, OTHER_DECK_ID), { recursive: true });
  await saveDeck(join(decksRoot, OTHER_DECK_ID), emptyDeck('Other talk'));
  await copyFile(join(deckDir, 'theme.css'), join(decksRoot, OTHER_DECK_ID, 'theme.css'));

  server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
  browser = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=${encodeURIComponent(USER)}`,
    profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (t) => t.url.includes(`deck=${DECK_ID}`) && !t.url.includes('present.html'),
    browser.log,
  );
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => editor!.evaluate<boolean>(`(() => (
    document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${USER}`)}) === true
    && Boolean(document.querySelector(${JSON.stringify(`${ON_CANVAS(VIDEO_ID)} video`)}))
  ))()`), 'browser editor did not finish connecting');
  return editor;
}

function cdp(): Cdp {
  if (!editor) throw new Error('editor is not connected');
  return editor;
}

async function snapshot(): Promise<StoreSnapshot> {
  return cdp().evaluate<StoreSnapshot>(`(() => {
    const state = window.store.get();
    return {
      slideIndex: state.slideIndex,
      selection: [...state.selection],
      slideSelection: [...state.slideSelection],
      slides: state.deck.slides.map((slide) => slide.elements.map((el) => ({
        id: el.id, type: el.type, x: el.x, y: el.y, src: el.src,
      }))),
      status: document.getElementById('status')?.textContent ?? '',
    };
  })()`);
}

async function serverDeck(): Promise<Deck> {
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
  if (!response.ok) throw new Error(`deck request failed (${response.status})`);
  return response.json() as Promise<Deck>;
}

/** The server's copy of a slide, once it has caught up with the browser. */
async function serverSlide(index: number, accept: (elements: SlideElement[]) => boolean): Promise<SlideElement[]> {
  const elements = await eventually(
    async () => (await serverDeck()).slides[index]?.elements ?? [],
    `server slide ${index + 1} did not catch up`,
    accept,
  );
  return elements;
}

/** Click the n-th slide row in the rail (0-based), the way the author does. */
async function clickRail(index: number): Promise<void> {
  const handle = `test-rail-${index}`;
  const found = await cdp().evaluate<boolean>(`(() => {
    const rows = [...document.querySelectorAll('#rail .rail-item')]
      .filter((row) => !row.classList.contains('rail-collapsed'));
    const row = rows[${index}];
    if (!row) return false;
    row.id = ${JSON.stringify(handle)};
    return true;
  })()`);
  if (!found) throw new Error(`no rail row ${index}`);
  await cdp().click(`#${handle}`, `rail row ${index + 1}`);
  await eventually(async () => (await snapshot()).slideIndex, 'rail click did not change slide', (i) => i === index);
}

/** Select one canvas element with a real click on it. */
async function selectOnCanvas(id: string): Promise<void> {
  await cdp().click(ON_CANVAS(id), id);
  await eventually(async () => (await snapshot()).selection, `click did not select ${id}`,
    (selection) => selection.length === 1 && selection[0] === id);
}

const copyChord = () => cdp().chord('c', 'KeyC', 67, MOD);
const cutChord = () => cdp().chord('x', 'KeyX', 88, MOD);
/** Cmd+V with Chromium's `paste` editing command, which is what emits the ClipboardEvent. */
const pasteChord = () => cdp().chord('v', 'KeyV', 86, MOD, ['paste']);
const undoChord = () => cdp().chord('z', 'KeyZ', 90, MOD);
const redoChord = () => cdp().chord('z', 'KeyZ', 90, MOD | SHIFT);

async function expectStatus(fragment: string): Promise<void> {
  await eventually(async () => (await snapshot()).status, `status never said ${JSON.stringify(fragment)}`,
    (status) => status.includes(fragment));
}

/** Blur whatever control has focus so a chord reaches the window handler. */
async function focusCanvasBackground(): Promise<void> {
  // The stage's bottom-right corner is empty in the fixture on both slides.
  const box = await cdp().evaluate<{ x: number; y: number }>(`(() => {
    const r = document.querySelector('#canvas .slide').getBoundingClientRect();
    return { x: r.right - 10, y: r.bottom - 10 };
  })()`);
  await cdp().clickAt(box.x, box.y);
}

/**
 * Put plain prose on the machine's clipboard. The Web UI's Cmd+V is a native
 * paste event, and a spreadsheet range or a screenshot left there by an
 * earlier suite (or by the author's last real copy) would rightly win over the
 * in-app copy. This tier runs serially for exactly that reason; the suite
 * still has to start from a known pasteboard.
 */
async function neutraliseClipboard(): Promise<void> {
  // `writeText` needs a focused document; a page nobody has clicked yet has none.
  await focusCanvasBackground();
  const wrote = await cdp().evaluate<boolean>(
    `navigator.clipboard.writeText('plain prose, no table').then(() => true, () => false)`,
  );
  if (wrote) return;
  // Fall back to a genuine copy: select prose in a scratch field and send
  // Chromium's copy command, which needs no clipboard permission at all.
  await cdp().evaluate<void>(`(() => {
    const field = document.createElement('textarea');
    field.id = 'test-clipboard-scratch';
    field.value = 'plain prose, no table';
    document.body.appendChild(field);
    field.focus();
    field.select();
  })()`);
  await cdp().chord('c', 'KeyC', 67, MOD, ['copy']);
  await cdp().evaluate<void>(`document.getElementById('test-clipboard-scratch')?.remove()`);
  await focusCanvasBackground();
}

describe.skipIf(!electronBinary)('editor shell in the collaboration browser', () => {
  beforeAll(async () => {
    await openEditor();
    await neutraliseClipboard();
  }, 120_000);

  afterAll(async () => {
    // The last test leaves a spreadsheet range on the OS clipboard; the next
    // serial suite must not inherit it.
    if (editor) await neutraliseClipboard().catch(() => undefined);
    editor?.close();
    editor = null;
    await stopBrowser(browser?.process ?? null);
    browser = null;
    await server?.close();
    server = null;
    if (workDir) await rm(workDir, { recursive: true, force: true });
    workDir = '';
  }, 60_000);

  it('copies a video with Cmd+C and pastes it onto another slide with Cmd+V, at the same place', async () => {
    await clickRail(0);
    await selectOnCanvas(VIDEO_ID);
    await copyChord();
    await expectStatus('Copied 1 element.');

    await clickRail(1);
    await pasteChord();
    await expectStatus('Pasted 1 element.');

    const state = await snapshot();
    expect(state.slides[1]).toHaveLength(1);
    const pasted = state.slides[1][0];
    expect(pasted.type).toBe('video');
    expect(pasted.src).toBe('assets/testclip.mp4');
    expect(pasted.id).not.toBe(VIDEO_ID);
    // A paste onto a *different* slide keeps the composed position.
    expect([pasted.x, pasted.y]).toEqual([120, 400]);
    expect(state.selection).toEqual([pasted.id]);

    // The canvas paints it as a video whose source the server actually serves.
    const painted = await eventually(async () => cdp().evaluate<{ tag: string; src: string } | null>(`(() => {
      const video = document.querySelector(${JSON.stringify(`${ON_CANVAS(pasted.id)} video`)});
      return video ? { tag: video.tagName, src: video.currentSrc || video.src } : null;
    })()`), 'pasted video was not painted', (v) => v !== null);
    expect(painted!.tag).toBe('VIDEO');
    const asset = await fetch(new URL(painted!.src));
    expect(asset.status).toBe(200);

    const persisted = await serverSlide(1, (els) => els.length === 1);
    expect(persisted[0].type).toBe('video');
    expect(persisted[0].id).toBe(pasted.id);
  }, 60_000);

  it('cascades repeated pastes of the same clipboard onto the same slide', async () => {
    await focusCanvasBackground();
    await pasteChord();
    await eventually(async () => (await snapshot()).slides[1].length, 'second paste did not land', (n) => n === 2);
    const state = await snapshot();
    const [first, second] = state.slides[1];
    expect([second.x, second.y]).toEqual([first.x + PASTE_OFFSET, first.y + PASTE_OFFSET]);
    await serverSlide(1, (els) => els.length === 2);
  }, 60_000);

  it('offsets a paste back onto the slide the element came from', async () => {
    await clickRail(0);
    await selectOnCanvas(SHAPE_ID);
    await copyChord();
    await expectStatus('Copied 1 element.');
    await pasteChord();
    await eventually(async () => (await snapshot()).slides[0].length, 'same-slide paste did not land', (n) => n === 5);
    const state = await snapshot();
    const copy = state.slides[0].find((el) => el.type === 'shape' && el.id !== SHAPE_ID)!;
    expect(copy).toBeDefined();
    expect([copy.x, copy.y]).toEqual([1200 + PASTE_OFFSET, 100 + PASTE_OFFSET]);
    await serverSlide(0, (els) => els.length === 5);
  }, 60_000);

  it('cuts with Cmd+X, pastes elsewhere, and undoes the paste with Cmd+Z through the collab bridge', async () => {
    await clickRail(0);
    await selectOnCanvas(TEXT_ID);
    await cutChord();
    await expectStatus('Cut 1 element.');
    await eventually(async () => (await snapshot()).slides[0].some((el) => el.id === TEXT_ID),
      'cut did not remove the text', (present) => !present);

    await clickRail(1);
    await pasteChord();
    await eventually(async () => (await snapshot()).slides[1].length, 'pasted text did not land', (n) => n === 3);
    let state = await snapshot();
    const pastedText = state.slides[1].find((el) => el.type === 'text')!;
    expect(pastedText).toBeDefined();
    expect(pastedText.id).not.toBe(TEXT_ID);
    await serverSlide(1, (els) => els.some((el) => el.type === 'text'));

    await undoChord();
    await eventually(async () => (await snapshot()).slides[1].length, 'undo did not remove the paste', (n) => n === 2);
    await serverSlide(1, (els) => !els.some((el) => el.type === 'text'));

    await redoChord();
    await eventually(async () => (await snapshot()).slides[1].length, 'redo did not restore the paste', (n) => n === 3);
    state = await snapshot();
    expect(state.slides[1].some((el) => el.type === 'text')).toBe(true);
    await serverSlide(1, (els) => els.some((el) => el.type === 'text'));
  }, 60_000);

  it('copies and pastes an image through the canvas context menu', async () => {
    await clickRail(0);
    const countBefore = (await snapshot()).slides[0].length;
    await cdp().rightClick(ON_CANVAS(IMAGE_ID), 'image context menu');
    await cdp().clickByText('#ctx-menu button', 'Copy');
    await eventually(async () => (await snapshot()).status, 'context-menu copy did not report',
      (status) => status.includes('Copied 1 element.') || status.includes('1 selected'));
    expect((await snapshot()).slides[0]).toHaveLength(countBefore);

    await clickRail(1);
    const empty = await cdp().evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('#canvas .slide').getBoundingClientRect();
      return { x: r.left + 20, y: r.bottom - 20 };
    })()`);
    await cdp().rightClickAt(empty.x, empty.y);
    await cdp().clickByText('#ctx-menu button', 'Paste');
    await eventually(async () => (await snapshot()).slides[1].length, 'context-menu paste did not land', (n) => n === 4);
    const state = await snapshot();
    const image = state.slides[1].find((el) => el.type === 'image')!;
    expect(image.src).toBe('assets/swatch.png');
    expect(image.id).not.toBe(IMAGE_ID);
    await serverSlide(1, (els) => els.some((el) => el.type === 'image'));
  }, 60_000);

  it('copies a whole slide from the rail and pastes it after the current one', async () => {
    await clickRail(0);
    const before = await snapshot();
    expect(before.slideSelection).toHaveLength(1);
    await copyChord();
    await expectStatus('Copied 1 slide.');

    await pasteChord();
    await expectStatus('Pasted 1 slide.');
    const state = await snapshot();
    expect(state.slides).toHaveLength(3);
    expect(state.slideIndex).toBe(1);
    // The copy sits right after its source, with the same content under fresh ids.
    expect(state.slides[1].map((el) => el.type)).toEqual(before.slides[0].map((el) => el.type));
    const originalIds = new Set(before.slides[0].map((el) => el.id));
    expect(state.slides[1].every((el) => !originalIds.has(el.id))).toBe(true);

    const persisted = await eventually(async () => (await serverDeck()).slides.length,
      'server did not receive the pasted slide', (n) => n === 3);
    expect(persisted).toBe(3);
  }, 60_000);

  it('nudges, duplicates, deletes, clears, and selects all from the keyboard', async () => {
    await clickRail(0);
    await selectOnCanvas(IMAGE_ID);
    const start = (await snapshot()).slides[0].find((el) => el.id === IMAGE_ID)!;

    await cdp().key('ArrowRight', 39);
    await cdp().chord('ArrowDown', 'ArrowDown', 40, SHIFT);
    await eventually(async () => {
      const el = (await snapshot()).slides[0].find((e) => e.id === IMAGE_ID)!;
      return [el.x, el.y];
    }, 'arrow keys did not move the shape', ([x, y]) => x === start.x + 1 && y === start.y + 10);

    const countBefore = (await snapshot()).slides[0].length;
    await cdp().chord('d', 'KeyD', 68, MOD);
    await eventually(async () => (await snapshot()).slides[0].length, 'Cmd+D did not duplicate', (n) => n === countBefore + 1);
    let state = await snapshot();
    expect(state.selection).toHaveLength(1);
    const duplicate = state.slides[0].find((el) => el.id === state.selection[0])!;
    expect(duplicate.id).not.toBe(IMAGE_ID);
    expect([duplicate.x, duplicate.y]).toEqual([start.x + 1 + PASTE_OFFSET, start.y + 10 + PASTE_OFFSET]);

    await cdp().key('Delete', 46);
    await eventually(async () => (await snapshot()).slides[0].length, 'Delete did not remove the duplicate', (n) => n === countBefore);
    await serverSlide(0, (els) => els.length === countBefore);

    await selectOnCanvas(IMAGE_ID);
    await cdp().key('Escape', 27);
    await eventually(async () => (await snapshot()).selection.length, 'Escape did not clear the selection', (n) => n === 0);

    await focusCanvasBackground();
    await cdp().chord('a', 'KeyA', 65, MOD);
    state = await snapshot();
    expect([...state.selection].sort()).toEqual(state.slides[0].map((el) => el.id).sort());
  }, 60_000);

  it('adds a slide with n and reports Cmd+S as automatic saving', async () => {
    const slidesBefore = (await snapshot()).slides.length;
    await focusCanvasBackground();
    await cdp().typeKeys('n');
    await eventually(async () => (await snapshot()).slides.length, 'n did not add a slide', (n) => n === slidesBefore + 1);
    await eventually(async () => (await serverDeck()).slides.length, 'server did not receive the new slide',
      (n) => n === slidesBefore + 1);

    await cdp().chord('s', 'KeyS', 83, MOD);
    await expectStatus('Saved automatically');
  }, 60_000);

  it('pastes tab-separated text from the real clipboard as a table', async () => {
    await focusCanvasBackground();
    const slideIndex = (await snapshot()).slideIndex;
    const countBefore = (await snapshot()).slides[slideIndex].length;
    const wrote = await cdp().evaluate<boolean>(
      `navigator.clipboard.writeText('time\\texperiment\\n2026-09-11\\tshell').then(() => true, () => false)`,
    );
    expect(wrote).toBe(true);

    await pasteChord();
    await eventually(async () => (await snapshot()).slides[slideIndex].length, 'table paste did not land',
      (n) => n === countBefore + 1);
    const table = await cdp().evaluate<{ rows: number; cells: number }>(`(() => {
      const state = window.store.get();
      const el = state.deck.slides[state.slideIndex].elements.find((e) => state.selection.has(e.id));
      const holder = document.createElement('div');
      holder.innerHTML = el?.html ?? '';
      return { rows: holder.querySelectorAll('tr').length, cells: holder.querySelectorAll('td').length };
    })()`);
    expect(table).toEqual({ rows: 2, cells: 4 });
  }, 60_000);

  // Last: it leaves this deck for the other one.
  it('copies an image with Cmd+C and pastes it into another presentation with Cmd+V', async () => {
    // Reported: "you can't copy-paste images between slideshows". Opening the
    // other deck reloads the page, which emptied the in-page copy.
    await clickRail(0);
    await selectOnCanvas(IMAGE_ID);
    // Earlier tests nudge it; the paste lands wherever it is now.
    const source = (await snapshot()).slides[0].find((el) => el.id === IMAGE_ID)!;
    // With Chromium's `copy` command, as a real Cmd+C has: its copy event is
    // what puts the copy's token on the OS clipboard.
    await cdp().chord('c', 'KeyC', 67, MOD, ['copy']);
    await expectStatus('Copied 1 element.');

    await cdp().evaluate(`void setTimeout(() => {
      location.href = ${JSON.stringify(`/?deck=${OTHER_DECK_ID}&name=${encodeURIComponent(USER)}`)};
    }, 0)`);
    await eventually(async () => cdp().evaluate<boolean>(`(() => (
      new URLSearchParams(location.search).get('deck') === ${JSON.stringify(OTHER_DECK_ID)}
      && document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${USER}`)}) === true
      && Boolean(document.querySelector('#canvas .slide'))
    ))()`).catch(() => false), 'the other presentation did not open', (ok) => ok);
    await focusCanvasBackground();
    await pasteChord();
    await expectStatus('Pasted 1 element.');

    const [pasted] = (await snapshot()).slides[0];
    expect(pasted.type).toBe('image');
    // The other deck's own copy of the file, not a path into this one.
    expect(pasted.src).toMatch(/^assets\/swatch\.[0-9a-f]{8}\.png$/);
    expect([pasted.x, pasted.y]).toEqual([source.x, source.y]);
    const painted = await eventually(async () => cdp().evaluate<boolean>(`(() => {
      const img = document.querySelector(${JSON.stringify(`${ON_CANVAS(pasted.id)} img`)});
      return Boolean(img?.complete && img.naturalWidth > 0);
    })()`), 'the pasted image did not render', (ok) => ok);
    expect(painted).toBe(true);
    expect(existsSync(join(workDir, 'decks', OTHER_DECK_ID, pasted.src!))).toBe(true);
  }, 60_000);
});

describe.skipIf(electronBinary)('editor shell in the collaboration browser (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
