import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDeck } from '../../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import { emptyDeck } from '../../src/shared/deck.js';
import {
  Cdp,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  wait,
  type RunningBrowser,
} from './browserSession.js';
import { collabClientDir } from './collabClient.js';

/**
 * A three-element editor for the cross-context fuzz walk: one textbox holding
 * plain paragraphs, one holding a committed list, and one image — plus a
 * second slide with a single textbox, so the slide rail is part of the state
 * space. Everything is driven with real input; the deck write in `reset` is
 * fixture setup, exactly as in selectionSession.ts.
 *
 * The whole-editor invariant set is the one selectionSession.ts uses (kept in
 * sync by copy — that module does not export it), evaluated in one round trip.
 */

/** Slide 1 objects. The lower band of the slide (y > 830) stays empty. */
export const PARA = 'xc-paragraphs';
export const LIST = 'xc-list';
export const IMAGE = 'xc-image';
/** The only object on slide 2. */
export const FAR = 'xc-far';

export const MOD = process.platform === 'darwin' ? 4 : 2;
/** CDP modifier bitmask: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
export const SHIFT = 8;

export const PARA_HTML = '<p>plain one</p><p>plain two</p>';
export const LIST_HTML = '<ul><li>item one</li><li>item two</li><li>item three</li></ul>';
export const FAR_HTML = '<p>far away</p>';

/** A 1x1 red PNG, enough for the image element to render. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** What the editor believes about selection and focus at one moment. */
export interface CrossState {
  slideIndex: number;
  slideSelection: string[];
  selection: string[];
  editing: string | null;
  /** Element ids on the current slide, in paint order. */
  elements: string[];
  focus: string;
  outlines: number;
}

/** The selectionSession invariant set (verbatim), plus nothing new. */
const INVARIANTS = `() => {
  const problems = [];
  const store = window.store;
  const canvas = window.canvas;
  const state = store.get();
  const selection = [...state.selection];
  const editing = canvas.editingElementId();
  const table = canvas.tableSelectionInfo();
  const slide = state.deck.slides[state.slideIndex];
  const ids = new Set((slide ? slide.elements : []).map((el) => el.id));
  const layer = document.querySelector('.slide-layer');
  const overlay = document.querySelector('.overlay-layer');
  const show = (list) => '[' + list.join(', ') + ']';
  if (!layer || !overlay) return ['the canvas layers are missing'];

  for (const id of selection) {
    if (!ids.has(id)) problems.push('selected ' + id + ' is not on the current slide');
  }
  if (new Set(selection).size !== selection.length) {
    problems.push('the selection lists an object twice: ' + show(selection));
  }

  if (editing !== null) {
    if (!ids.has(editing)) {
      problems.push('editing ' + editing + ', which is not on the current slide');
    }
    if (selection.length !== 1 || selection[0] !== editing) {
      problems.push('editing ' + editing + ' while the selection is ' + show(selection));
    }
  }

  const editingNodes = [...layer.querySelectorAll('.editing')]
    .map((node) => node.getAttribute('data-element-id') || '(unnamed)');
  const expectedEditing = editing === null ? [] : [editing];
  if (editingNodes.join('|') !== expectedEditing.join('|')) {
    problems.push('the edit outline is on ' + show(editingNodes)
      + ' but the edit session is on ' + show(expectedEditing));
  }
  const editable = [...layer.querySelectorAll('.text-content')]
    .filter((node) => node.isContentEditable)
    .map((node) => node.closest('[data-element-id]')?.getAttribute('data-element-id')
      || '(unnamed)');
  if (editable.join('|') !== expectedEditing.join('|')) {
    problems.push('typing would reach ' + show(editable)
      + ' but the edit session is on ' + show(expectedEditing));
  }

  const active = document.activeElement;
  const activeElementId = active && active.closest
    ? active.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null
    : null;
  if (editing !== null && active && layer.contains(active) && activeElementId !== editing) {
    problems.push('focus sits in ' + (activeElementId ?? 'the canvas')
      + ' while ' + editing + ' is being edited');
  }

  const nativeSelection = window.getSelection();
  const anchor = nativeSelection && nativeSelection.anchorNode;
  const anchorElement = anchor
    ? (anchor.nodeType === 1 ? anchor : anchor.parentElement)
    : null;
  if (anchorElement && layer.contains(anchorElement)) {
    const owner = anchorElement.closest('[data-element-id]')?.getAttribute('data-element-id')
      ?? '(unnamed)';
    if (editing === null && !nativeSelection.isCollapsed) {
      problems.push('a text highlight survives in ' + owner + ' with no edit session');
    } else if (editing !== null && owner !== editing) {
      problems.push('the caret is in ' + owner + ' while ' + editing + ' is being edited');
    }
  }

  const highlighted = [...layer.querySelectorAll('.editor-table-selected')];
  if (table === null && highlighted.length > 0) {
    problems.push(highlighted.length + ' table cells stay highlighted with no cell range');
  }

  const expectedOutlines = (slide ? slide.elements : [])
    .filter((el) => state.selection.has(el.id) && !el.layoutMasterId).length;
  const outlines = overlay.querySelectorAll('.sel-box').length;
  if (outlines !== expectedOutlines) {
    problems.push('the overlay draws ' + outlines + ' selection outlines for '
      + expectedOutlines + ' selected objects');
  }

  const slideSelection = [...state.slideSelection];
  if (slide && !state.slideSelection.has(slide.id)) {
    problems.push('the current slide is not part of the slide selection '
      + show(slideSelection));
  }
  if (selection.length > 0 && slideSelection.length > 1) {
    problems.push(selection.length + ' objects are selected alongside '
      + slideSelection.length + ' slides');
  }
  const railSelected = [...document.querySelectorAll('.rail-item')]
    .filter((row) => row.classList.contains('selected'))
    .map((row) => Number(row.dataset.index));
  const expectedRail = state.deck.slides
    .map((candidate, index) => (state.slideSelection.has(candidate.id) ? index : -1))
    .filter((index) => index >= 0);
  if (railSelected.join(',') !== expectedRail.join(',')) {
    problems.push('the rail highlights slides ' + show(railSelected)
      + ' but ' + show(expectedRail) + ' are selected');
  }
  const railActive = [...document.querySelectorAll('.rail-item.active')]
    .map((row) => Number(row.dataset.index));
  if (railActive.join(',') !== String(state.slideIndex)) {
    problems.push('the rail marks ' + show(railActive) + ' as the current slide, not '
      + state.slideIndex);
  }
  return problems;
}`;

const STATE = `() => {
  const store = window.store;
  const canvas = window.canvas;
  const state = store.get();
  const slide = state.deck.slides[state.slideIndex];
  const active = document.activeElement;
  const owner = active && active.closest
    ? active.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null
    : null;
  return {
    slideIndex: state.slideIndex,
    slideSelection: [...state.slideSelection],
    selection: [...state.selection],
    editing: canvas.editingElementId(),
    elements: (slide ? slide.elements : []).map((el) => el.id),
    focus: owner
      ? 'inside ' + owner
      : active
        ? (active.id ? '#' + active.id : active.tagName.toLowerCase())
        : 'nothing',
    outlines: document.querySelectorAll('.overlay-layer .sel-box').length,
  };
}`;

/** Record page-level failures the walk must never cause. */
const ERROR_TRAP = `(() => {
  if (window.__xcErrors) return true;
  window.__xcErrors = [];
  window.addEventListener('error', (event) => {
    window.__xcErrors.push('error: ' + (event.message ?? String(event)));
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.__xcErrors.push('unhandledrejection: '
      + (reason && reason.message ? reason.message : String(reason)));
  });
  const original = console.error.bind(console);
  console.error = (...args) => {
    window.__xcErrors.push('console.error: '
      + args.map((a) => (a && a.message) ? a.message : String(a)).join(' '));
    original(...args);
  };
  return true;
})()`;

export interface CrossSession {
  cdp: Cdp;
  reset(): Promise<void>;
  click(elementId: string): Promise<void>;
  shiftClick(elementId: string): Promise<void>;
  doubleClick(elementId: string): Promise<void>;
  clickEmpty(): Promise<void>;
  clickRail(index: number): Promise<void>;
  /**
   * A click on an element during which the window system reports a hover
   * elsewhere with no button held — what CI's X display sends whenever a
   * window maps. It is a click, not a drag (test/pointerDragBugs.test.ts).
   */
  clickWithStrayHover(elementId: string): Promise<void>;
  /** A real primary-button marquee drag along viewport points. */
  dragPath(points: Array<{ x: number; y: number }>): Promise<void>;
  /** Viewport box of a selector. */
  boxOf(selector: string): Promise<{ left: number; top: number; width: number; height: number }>;
  key(key: string, code: number): Promise<void>;
  chord(key: string, code: string, virtualKey: number, modifiers: number,
    commands?: string[]): Promise<void>;
  type(value: string): Promise<void>;
  state(): Promise<CrossState>;
  /** Invariant violations that survive a short settle window. */
  problems(): Promise<string[]>;
  /** Collapsed rendered text of an element on the current slide ('' if absent). */
  textOf(elementId: string): Promise<string>;
  /** Rendered text of every text element on the current slide, id → text. */
  allTexts(): Promise<Record<string, string>>;
  /** Every element id in the whole deck, slide-qualified. */
  allElementIds(): Promise<string[]>;
  /** The store's deck, htmls normalised, as one comparable JSON string. */
  deckSnapshot(): Promise<string>;
  /** Errors trapped on the page since the last drain. */
  drainPageErrors(): Promise<string[]>;
}

export function elementSelector(elementId: string): string {
  return `.slide-layer [data-element-id="${elementId}"]`;
}

export async function startCrossSession(deckId: string, name: string): Promise<{
  session: CrossSession;
  close: () => Promise<void>;
}> {
  const workDir = await mkdtemp(join(tmpdir(), 'cross-context-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, deckId);
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(join(deckDir, 'assets'), { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(deckDir, 'assets', 'pic.png'), Buffer.from(PNG_BASE64, 'base64'));

  const deck = emptyDeck('Cross context fuzz');
  deck.themePreset = 'basic';
  deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'slide-2', name: 'Slide 2' });
  for (const element of startingElements()) {
    deck.slides[0].elements.push(element as never);
  }
  deck.slides[1].elements.push(secondSlideElement() as never);
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 28px/1.4 sans-serif; }',
    '',
  ].join('\n'), 'utf8');

  const clientDir = await collabClientDir();
  let server: RunningCollabServer | null = await startCollabServer({
    rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
  });
  let browser: RunningBrowser | null = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${deckId}&name=${encodeURIComponent(name)}`,
    profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (candidate) => candidate.url.includes(`deck=${deckId}`),
    browser.log,
  );
  let cdp: Cdp | null = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => cdp!.evaluate<boolean>(
    `Boolean(document.querySelector('${elementSelector(LIST)} ul'))`,
  ), 'the cross-context fixture never loaded');
  await cdp.evaluate(ERROR_TRAP);

  const session = buildSession(cdp);
  return {
    session,
    close: async () => {
      cdp?.close();
      cdp = null;
      await stopBrowser(browser?.process ?? null);
      browser = null;
      await server?.close();
      server = null;
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

function buildSession(cdp: Cdp): CrossSession {
  const session: CrossSession = {
    cdp,
    async reset() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const editing = await cdp.evaluate<string | null>(
          'window.canvas.editingElementId()');
        if (editing === null) break;
        await cdp.key('Escape', 27);
        await wait(80);
      }
      await cdp.evaluate(`(() => {
        window.store.commit((deck) => {
          deck.slides[0].elements = ${JSON.stringify(startingElements())};
          deck.slides[1].elements = ${JSON.stringify([secondSlideElement()])};
        }, { label: 'Cross-context fixture' });
        window.store.selectSlide(0);
        window.store.clearSelection();
        return true;
      })()`);
      await eventually(async () => cdp.evaluate<boolean>(
        `Boolean(document.querySelector('${elementSelector(LIST)} ul'))`,
      ), 'the fixture deck did not render');
      await wait(60);
    },
    async click(elementId) {
      await cdp.click(elementSelector(elementId), elementId);
      await wait(60);
    },
    async shiftClick(elementId) {
      await cdp.clickModified(elementSelector(elementId), SHIFT, `shift-click ${elementId}`);
      await wait(60);
    },
    async doubleClick(elementId) {
      await cdp.doubleClick(elementSelector(elementId), elementId);
      await wait(120);
    },
    async clickEmpty() {
      await cdp.clickWithin('.slide-layer', 0.5, 0.96, 'empty canvas');
      await wait(60);
    },
    async clickRail(index) {
      await cdp.click(`.rail-item[data-index="${index}"]`, `rail slide ${index}`);
      await wait(150);
    },
    async clickWithStrayHover(elementId) {
      const box = await session.boxOf(elementSelector(elementId));
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'none', buttons: 0,
      });
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
      });
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: x + 240, y: y + 160, button: 'none', buttons: 0,
      });
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
      });
      await wait(60);
    },
    async dragPath(points) {
      const start = points[0];
      const end = points[points.length - 1];
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0,
      });
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1,
      });
      for (const point of points.slice(1)) {
        await cdp.call('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1,
        });
        await wait(30);
      }
      await cdp.call('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1,
      });
      await wait(80);
    },
    async boxOf(selector) {
      const box = await cdp.evaluate<{
        left: number; top: number; width: number; height: number;
      } | null>(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      })()`);
      if (!box) throw new Error(`no element matches ${selector}`);
      return box;
    },
    async key(key, code) {
      await cdp.key(key, code);
      await wait(60);
    },
    async chord(key, code, virtualKey, modifiers, commands) {
      await cdp.chord(key, code, virtualKey, modifiers, commands);
      await wait(80);
    },
    async type(value) {
      await cdp.typeKeys(value);
      await wait(60);
    },
    state() {
      return cdp.evaluate<CrossState>(`(${STATE})()`);
    },
    async problems() {
      const first = await cdp.evaluate<string[]>(`(${INVARIANTS})()`);
      if (first.length === 0) return first;
      await wait(200);
      const second = await cdp.evaluate<string[]>(`(${INVARIANTS})()`);
      return second.filter((problem) => first.includes(problem));
    },
    async textOf(elementId) {
      const value = await cdp.evaluate<string>(
        `document.querySelector('${elementSelector(elementId)} .text-content')?.textContent ?? ''`);
      return value.replace(/[\s ​⁠]+/g, ' ').trim();
    },
    allTexts() {
      return cdp.evaluate<Record<string, string>>(`(() => {
        const out = {};
        for (const node of document.querySelectorAll('.slide-layer [data-element-id]')) {
          const id = node.getAttribute('data-element-id');
          const body = node.querySelector('.text-content');
          out[id] = (body ? body.textContent : '')
            .replace(/[\\s\\u00a0\\u200b\\u2060]+/g, ' ').trim();
        }
        return out;
      })()`);
    },
    allElementIds() {
      return cdp.evaluate<string[]>(`(() => {
        const deck = window.store.get().deck;
        return deck.slides.flatMap((slide, index) =>
          slide.elements.map((el) => index + ':' + el.id));
      })()`);
    },
    deckSnapshot() {
      return cdp.evaluate<string>(`(() => {
        const deck = window.store.get().deck;
        const template = document.createElement('template');
        const normalize = (html) => {
          template.innerHTML = String(html).replaceAll('\\u2060', '');
          return template.innerHTML;
        };
        return JSON.stringify(deck.slides.map((slide) => slide.elements.map((el) =>
          ({ ...el, html: 'html' in el ? normalize(el.html) : undefined }))));
      })()`);
    },
    async drainPageErrors() {
      return cdp.evaluate<string[]>(
        '(() => { const e = window.__xcErrors ?? []; window.__xcErrors = []; return e; })()');
    },
  };
  return session;
}

function textElement(
  id: string,
  html: string,
  box: { x: number; y: number; w: number; h: number },
): Record<string, unknown> {
  return {
    id, type: 'text', ...box, rot: 0, z: 1, opacity: 1,
    class: ['role-body'], style: {}, html, align: 'left', valign: 'top',
  };
}

function startingElements(): Array<Record<string, unknown>> {
  return [
    textElement(PARA, PARA_HTML, { x: 120, y: 100, w: 700, h: 240 }),
    textElement(LIST, LIST_HTML, { x: 1080, y: 100, w: 700, h: 300 }),
    {
      id: IMAGE, type: 'image', src: 'assets/pic.png', fit: 'contain', alt: 'fixture',
      x: 120, y: 470, w: 420, h: 280, rot: 0, z: 2, opacity: 1, class: [], style: {},
    },
  ];
}

function secondSlideElement(): Record<string, unknown> {
  return textElement(FAR, FAR_HTML, { x: 120, y: 100, w: 800, h: 260 });
}
