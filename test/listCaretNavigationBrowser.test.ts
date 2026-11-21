import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  wait,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import { launchSafari, type SafariKey } from './support/safariDriver.js';

/**
 * The caret goes where the author sends it in a list, in Chromium and in real
 * Safari.
 *
 * Reported in Safari (Nov 2026): press Return at the end of a bullet, ArrowUp
 * back to it, ArrowDown to the new bullet -- and the caret stays where it is,
 * so whatever is typed next lands on the line above. WebKit cannot move the
 * caret vertically into or out of a line that holds an atomic inline and
 * nothing but a `<br>`, and every marker type.css draws is an inline-block:
 * an empty bullet was a wall. While a box is edited, editor.css draws the
 * markers of such lines with boxes WebKit can move past, painting the same
 * pixels. Chromium never had the wall; it runs every case too, so the change
 * cannot cost it anything.
 *
 * Also reported in Safari: Cmd+I, type, Cmd+I, and the caret is drawn across
 * the last letter instead of after it. The oracle is the same in both
 * engines: a collapsed caret is drawn at the edge of the glyph it follows.
 *
 * The walk at the end is the fuzz the report asked for: arrows, typing,
 * Return, Tab and Shift+Tab, to a line's start and end, Backspace and format toggles in a
 * seeded order, and after every ArrowUp or ArrowDown the caret must be on the
 * neighbouring line of the box -- the very next one, not the same one and not
 * one further on.
 *
 * Chromium runs in the browser tier. Real Safari runs on a Mac when asked,
 * RUN_SAFARI_CARET=1 (as the CI `safari` job does).
 */

const DECK_ID = 'list-caret-navigation';
const BOX = 'caret-navigation-box';
const CONTENT = `#canvas [data-element-id="${BOX}"] .text-content`;

const SAFARI = process.platform === 'darwin' && process.env.RUN_SAFARI_CARET === '1';
type BrowserKind = 'Chromium' | 'Safari';
const BROWSERS: BrowserKind[] = [
  ...(electronBinary ? ['Chromium' as const] : []),
  ...(SAFARI ? ['Safari' as const] : []),
];

/** Keys the walk presses by name. */
type Key = Extract<SafariKey, 'ArrowUp' | 'ArrowDown' | 'Enter' | 'Tab' | 'Backspace' | 'Escape'>;
const KEY_CODES: Record<Key, number> = {
  ArrowUp: 38, ArrowDown: 40, Enter: 13, Tab: 9, Backspace: 8, Escape: 27,
};

interface Page {
  evaluate<T>(expression: string): Promise<T>;
  doubleClickAt(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  press(key: Key): Promise<void>;
  /** Shift+Tab. */
  outdent(): Promise<void>;
  /** To the start or end of the line: Home and End, or Cmd+Left and Cmd+Right on a Mac, where Home and End scroll. */
  lineEdge(edge: 'start' | 'end'): Promise<void>;
  /** Cmd (Ctrl off a Mac) with a letter: the format toggles. */
  format(letter: 'b' | 'i'): Promise<void>;
  close(): Promise<void>;
}

async function openPage(kind: BrowserKind, url: string, profileDir: string): Promise<Page> {
  if (kind === 'Safari') {
    const safari = await launchSafari();
    await safari.setWindowSize(1600, 1000);
    await safari.goto(url);
    return {
      evaluate: (expression) => safari.evaluate(expression),
      doubleClickAt: (x, y) => safari.clickAt(x, y, 2),
      type: (text) => safari.type(text),
      press: (key) => safari.press(key),
      outdent: () => safari.chord(['Shift'], 'Tab'),
      lineEdge: (edge) => safari.chord(['Meta'], edge === 'end' ? 'ArrowRight' : 'ArrowLeft'),
      format: (letter) => safari.chord(['Meta'], letter),
      close: () => safari.close(),
    };
  }
  const browser = await launchBrowser(url, profileDir);
  const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  // A blurred page commits the box being typed into (see listEditingSession).
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  const mod = process.platform === 'darwin' ? 4 : 2;
  return {
    evaluate: (expression) => cdp.evaluate(expression),
    doubleClickAt: (x, y) => cdp.doubleClickAt(x, y),
    type: (text) => cdp.typeKeys(text),
    press: (key) => cdp.key(key, KEY_CODES[key]),
    outdent: () => cdp.chord('Tab', 'Tab', 9, 8),
    lineEdge: (edge) => (process.platform === 'darwin'
      ? cdp.chord(edge === 'end' ? 'ArrowRight' : 'ArrowLeft', edge === 'end' ? 'ArrowRight' : 'ArrowLeft',
        edge === 'end' ? 39 : 37, 4)
      : cdp.key(edge === 'end' ? 'End' : 'Home', edge === 'end' ? 35 : 36)),
    format: (letter) => cdp.chord(letter, `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0), mod),
    close: async () => {
      cdp.close();
      await stopBrowser(browser.process);
    },
  };
}

/**
 * Where the caret is, read from the live selection: the text block holding it
 * (an item that only holds a list is not one), that block's own text, and the
 * visual line of the box it is drawn on. Lines are the line boxes of the
 * text, and an empty block's one line, top to bottom.
 */
interface Caret {
  block: number;
  text: string;
  line: number;
  lines: number;
  /** The caret's x, where the engine reports a rectangle for it. */
  x: number | null;
}

const CARET = `(() => {
  const body = document.querySelector(${JSON.stringify(CONTENT)});
  if (!body || !body.isContentEditable) return { error: 'the box is not being edited' };
  const selection = getSelection();
  if (!selection.rangeCount) return { error: 'no selection' };
  const range = selection.getRangeAt(0);
  const anchor = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  if (!body.contains(anchor)) return { error: 'the caret left the box' };
  const blocks = [...body.querySelectorAll('li, p')].filter((block) => !block.hasAttribute('data-list-holder'));
  const visible = (value) => value.replace(/\\u2060/g, '');
  const own = (block) => {
    let text = '';
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest('li, p') === block) text += node.data;
    }
    return visible(text);
  };
  const tops = [];
  const add = (top) => { if (!tops.some((seen) => Math.abs(seen - top) < 4)) tops.push(top); };
  for (const block of blocks) {
    let any = false;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest('li, p') !== block || !visible(node.data)) continue;
      const span = document.createRange();
      span.selectNodeContents(node);
      for (const rect of span.getClientRects()) { add(rect.top); any = true; }
    }
    if (!any) { const rect = block.getClientRects()[0]; if (rect) add(rect.top); }
  }
  tops.sort((a, b) => a - b);
  const block = anchor.closest('li, p');
  const rect = [...range.getClientRects()].find((candidate) => candidate.height > 0) ?? null;
  const top = rect ? rect.top : block?.getClientRects()[0]?.top ?? null;
  return {
    block: blocks.indexOf(block),
    text: block ? own(block) : '',
    line: top === null ? -1 : tops.findIndex((seen) => Math.abs(seen - top) < 6),
    lines: tops.length,
    x: rect ? rect.left : null,
  };
})()`;

let workDir = '';
let server: RunningCollabServer | null = null;

beforeAll(async () => {
  if (BROWSERS.length === 0) return;
  workDir = await mkdtemp(join(tmpdir(), 'list-caret-navigation-'));
  const deckDir = join(workDir, 'decks', DECK_ID);
  await mkdir(deckDir, { recursive: true });
  const deck = emptyDeck('List caret navigation');
  deck.themePreset = 'basic';
  deck.slides[0].elements.push({
    id: BOX, type: 'text', x: 100, y: 100, w: 1720, h: 860, rot: 0, z: 1, opacity: 1,
    class: ['role-body'], style: {}, html: '<p>Text</p>', align: 'left', valign: 'top',
  } as never);
  await saveDeck(deckDir, deck);
  // The reporter's deck's typeface, where the machine has it (a Mac does).
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #191918; }',
    '.role-body { font: 400 42px/1.34 "Avenir Next", Avenir, "Helvetica Neue", sans-serif; }',
    '',
  ].join('\n'), 'utf8');
  server = await startCollabServer({
    rootDir: join(workDir, 'decks'), clientDir: await collabClientDir(), host: '127.0.0.1', port: 0,
  });
}, 300_000);

afterAll(async () => {
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

for (const kind of BROWSERS) {
  describe(`${kind}: the caret in a list`, () => {
    let page: Page;

    beforeAll(async () => {
      const profileDir = join(workDir, `profile-${kind}`);
      await mkdir(profileDir, { recursive: true });
      page = await openPage(kind, `http://127.0.0.1:${server!.port}/?deck=${DECK_ID}&name=Caret`, profileDir);
      await eventually(async () => page.evaluate<boolean>(
        `Boolean(document.querySelector(${JSON.stringify(CONTENT)}) && window.store)`),
      'the deck never loaded', Boolean, 60_000);
    }, 180_000);

    afterAll(async () => {
      await page?.close();
    });

    const caret = async (label: string): Promise<Caret> => {
      const found = await page.evaluate<Caret & { error?: string }>(CARET);
      if (found.error) throw new Error(`${label}: ${found.error}`);
      return found;
    };

    /** Write the box's markup (out of editing), then double-click into one of its blocks at its end. */
    const start = async (html: string, block: number): Promise<void> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!await page.evaluate<boolean>(`document.querySelector(${JSON.stringify(CONTENT)})?.isContentEditable === true`)) break;
        await page.press('Escape');
        await wait(150);
      }
      await page.evaluate(`(() => {
        window.store.commit((deck) => {
          deck.slides[0].elements.find((element) => element.id === ${JSON.stringify(BOX)}).html = ${JSON.stringify(html)};
        }, { label: 'Caret fixture' });
        return true;
      })()`);
      await eventually(async () => page.evaluate<boolean>(`(() => {
        const body = document.querySelector(${JSON.stringify(CONTENT)});
        const wanted = document.createElement('div');
        wanted.innerHTML = ${JSON.stringify(html)};
        return body?.textContent === wanted.textContent;
      })()`), 'the fixture never rendered');
      const point = await page.evaluate<{ x: number; y: number }>(`(() => {
        const body = document.querySelector(${JSON.stringify(CONTENT)});
        const target = [...body.querySelectorAll('li, p')].filter((b) => !b.hasAttribute('data-list-holder'))[${block}];
        const text = [...target.childNodes].filter((node) => node.nodeType === 3 && node.data.trim()).pop();
        const range = document.createRange();
        range.selectNodeContents(text);
        const rect = [...range.getClientRects()].pop();
        return { x: rect.right - 2, y: rect.top + rect.height / 2 };
      })()`);
      await page.doubleClickAt(point.x, point.y);
      await eventually(async () => page.evaluate<boolean>(
        `document.querySelector(${JSON.stringify(CONTENT)})?.isContentEditable === true`), 'the box never opened');
      // The double-click selects a word; the line's end is a plain caret after it.
      await page.lineEdge('end');
      await wait(100);
    };

    const markup = () => page.evaluate<string>(`document.querySelector(${JSON.stringify(CONTENT)}).innerHTML`);
    const press = async (key: Key) => {
      await page.press(key);
      await wait(60);
    };

    it(`${kind}: Return, ArrowUp and ArrowDown reach the new empty bullet`, {
      timeout: 180_000,
    }, async () => {
      const shapes = [
        { name: 'bulleted', html: '<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>' },
        { name: 'numbered', html: '<ol><li>alpha</li><li>beta</li><li>gamma</li></ol>' },
        { name: 'indented', html: '<ul><li>top<ul><li>alpha</li><li>beta</li><li>gamma</li></ul></li></ul>' },
      ];
      const wrong: string[] = [];
      for (const { name, html } of shapes) {
        const beta = name === 'indented' ? 2 : 1;
        await start(html, beta);
        await press('Enter');
        const opened = await caret(`${name}: after Return`);
        await press('ArrowUp');
        const up = await caret(`${name}: after ArrowUp`);
        await press('ArrowDown');
        const down = await caret(`${name}: after ArrowDown`);
        await press('ArrowDown');
        const further = await caret(`${name}: after a second ArrowDown`);
        await press('ArrowUp');
        await page.type('X');
        await wait(100);
        const typed = await caret(`${name}: after typing`);
        const seen = `Return → block ${opened.block}, ↑ → ${up.block} "${up.text}", ↓ → ${down.block} "${down.text}", `
          + `↓ → ${further.block} "${further.text}", ↑ and X → ${typed.block} "${typed.text}"; ${await markup()}`;
        if (opened.block !== beta + 1 || opened.text !== '') wrong.push(`${name}: Return opened no empty bullet: ${seen}`);
        else if (up.block !== beta) wrong.push(`${name}: ArrowUp did not reach beta: ${seen}`);
        else if (down.block !== beta + 1) wrong.push(`${name}: ArrowDown from beta stayed out of the empty bullet: ${seen}`);
        else if (further.block !== beta + 2) wrong.push(`${name}: ArrowDown from the empty bullet did not reach gamma: ${seen}`);
        else if (typed.block !== beta + 1 || typed.text !== 'X') wrong.push(`${name}: X did not land in the empty bullet: ${seen}`);
      }
      expect(wrong, 'vertical caret moves through an empty bullet').toEqual([]);
    });

    it(`${kind}: ArrowUp and ArrowDown pass an indented empty bullet's empty line`, {
      timeout: 180_000,
    }, async () => {
      // Tab on an empty bullet below another makes this shape: an item whose
      // first line is empty, holding the indented list.
      await start('<ul><li>alpha</li><li><br><ul><li>beta</li></ul></li><li>gamma</li></ul>', 2);
      const visits: string[] = [];
      for (const key of ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowDown'] as const) {
        await press(key);
        const at = await caret(key);
        visits.push(`${key === 'ArrowUp' ? '↑' : '↓'}${at.block}`);
      }
      expect(visits.join(' '), await markup()).toBe('↑1 ↑0 ↓1 ↓2 ↓3');
    });

    it(`${kind}: the caret after a format toggle is drawn after the last letter`, {
      timeout: 180_000,
    }, async () => {
      const wrong: string[] = [];
      for (const letter of ['i', 'b'] as const) {
        await start('<ul><li>alpha</li><li>beta</li></ul>', 0);
        await page.type(' ab');
        await page.format(letter);
        await page.type('fil');
        await wait(100);
        const inside = await page.evaluate<{ caret: number | null; glyph: number; width: number }>(GLYPH_EDGE);
        await page.format(letter);
        await wait(100);
        const toggled = await page.evaluate<{ caret: number | null; glyph: number; width: number }>(GLYPH_EDGE);
        await page.type('xy');
        await wait(100);
        const after = await page.evaluate<{ caret: number | null; glyph: number; width: number }>(GLYPH_EDGE);
        const check = (label: string, edge: { caret: number | null; glyph: number; width: number }) => {
          if (edge.caret === null) {
            wrong.push(`Cmd+${letter} ${label}: no caret rectangle`);
          } else if (Math.abs(edge.caret - edge.glyph) > 1) {
            wrong.push(`Cmd+${letter} ${label}: the caret is at x=${edge.caret.toFixed(1)}, the last letter `
              + `ends at x=${edge.glyph.toFixed(1)} (it is ${edge.width.toFixed(1)} wide)`);
          }
        };
        check('typing in the format', inside);
        check('just toggled off', toggled);
        check('typing after it', after);
        const typed = await caret('after typing');
        if (typed.block !== 0 || typed.text !== 'alpha abfilxy') {
          wrong.push(`Cmd+${letter}: the words landed as "${typed.text}" in block ${typed.block}: ${await markup()}`);
        }
      }
      expect(wrong, 'carets drawn away from the end of the letter they follow').toEqual([]);
    });

    it(`${kind}: a seeded walk keeps every vertical move on the neighbouring line`, {
      timeout: 600_000,
    }, async () => {
      const seeds = (process.env.LIST_CARET_SEEDS ?? '1,2,3').split(',').map(Number);
      const steps = Number(process.env.LIST_CARET_STEPS ?? 45);
      const wrong: string[] = [];
      for (const seed of seeds) {
        let state = seed % 2147483647;
        const next = () => {
          state = (state * 16807) % 2147483647;
          return (state - 1) / 2147483646;
        };
        const html = next() < 0.5
          ? '<ul><li>alpha</li><li>beta gamma</li><li>delta</li></ul>'
          : '<ol><li>alpha</li><li>beta gamma</li><li>delta</li></ol>';
        await start(html, 1);
        const trace: string[] = [];
        for (let step = 0; step < steps && wrong.length === 0; step += 1) {
          const before = await caret(`seed ${seed} step ${step}`);
          const roll = next();
          let move: string;
          if (roll < 0.16) {
            move = ['ab', 'word', 'x', 'two words'][Math.floor(next() * 4)];
            await page.type(move);
            move = `type "${move}"`;
          } else if (roll < 0.28) {
            move = 'Enter';
            await press('Enter');
          } else if (roll < 0.34) {
            move = 'Tab';
            await press('Tab');
          } else if (roll < 0.38) {
            move = 'Shift+Tab';
            await page.outdent();
          } else if (roll < 0.45) {
            const letter = next() < 0.5 ? 'b' : 'i';
            move = `Cmd+${letter}`;
            await page.format(letter);
          } else if (roll < 0.51) {
            const edge = next() < 0.5 ? 'end' : 'start';
            move = `line ${edge}`;
            await page.lineEdge(edge);
          } else if (roll < 0.55) {
            move = 'Backspace';
            await press('Backspace');
          } else {
            move = next() < 0.5 ? 'ArrowUp' : 'ArrowDown';
            await press(move as Key);
          }
          await wait(40);
          const after = await caret(`seed ${seed} step ${step}: ${move}`);
          trace.push(`${move} → line ${after.line}/${after.lines}, block ${after.block} "${after.text}"`);
          if ((move === 'ArrowUp' || move === 'ArrowDown') && before.line >= 0) {
            const wanted = move === 'ArrowUp'
              ? Math.max(0, before.line - 1)
              : Math.min(before.lines - 1, before.line + 1);
            if (after.line !== wanted) {
              wrong.push(`seed ${seed} step ${step}: ${move} from line ${before.line} ("${before.text}") went to `
                + `line ${after.line} ("${after.text}"), not ${wanted}\n  ${trace.slice(-8).join('\n  ')}\n  ${await markup()}`);
            }
          }
        }
      }
      expect(wrong, 'vertical moves that did not reach the neighbouring line').toEqual([]);
    });
  });
}

/**
 * The live caret's x, and the right edge of the visible letter just before
 * it.
 */
const GLYPH_EDGE = `(() => {
  const range = getSelection().getRangeAt(0);
  const caret = [...range.getClientRects()].find((rect) => rect.height > 0) ?? null;
  const body = document.querySelector(${JSON.stringify(CONTENT)});
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const before = document.createRange();
    before.setStart(node, 0);
    before.collapse(true);
    if (range.compareBoundaryPoints(Range.START_TO_START, before) < 0) break;
    const limit = node === range.startContainer ? range.startOffset : node.data.length;
    for (let index = limit - 1; index >= 0; index -= 1) {
      if (node.data[index] !== '\\u2060') { last = { node, index }; break; }
    }
  }
  if (!last) return { caret: caret ? caret.left : null, glyph: NaN, width: NaN };
  // The letter with the invisible sentinels after it: Core Text shapes a
  // letter and a following U+2060 as one cluster, and WebKit splits a
  // cluster's width evenly between its characters, so a range over the
  // letter alone would end where the caret wrongly is.
  let end = last.index + 1;
  while (last.node.data[end] === '\u2060') end += 1;
  const glyph = document.createRange();
  glyph.setStart(last.node, last.index);
  glyph.setEnd(last.node, end);
  const box = glyph.getBoundingClientRect();
  return { caret: caret ? caret.left : null, glyph: box.right, width: box.width };
})()`;

describe.skipIf(BROWSERS.length > 0)('the caret in a list (skipped)', () => {
  it('needs Electron (or Safari, on a Mac, with RUN_SAFARI_CARET=1)', () => {
    expect(BROWSERS).toEqual([]);
  });
});
