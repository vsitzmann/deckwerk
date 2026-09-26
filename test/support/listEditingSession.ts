import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { saveDeck } from '../../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../../src/shared/deck.js';
import {
  Cdp,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  textEditingState,
  wait,
  type RunningBrowser,
} from './browserSession.js';
import { collabClientDir } from './collabClient.js';
import { MARKUP_INVARIANTS } from './pasteMarkupCorpus.js';

/**
 * One real editor, driven by real keyboard and pointer input, for the list
 * editing tests.
 *
 * Everything an author does here goes through the paths the app ships: keys
 * arrive as the physical-keyboard event triples, the caret is placed by
 * clicking glyphs, and the List dropdown is changed with arrow keys the
 * browser routes into the `<select>` itself. Only fixture setup writes to the
 * store directly, which is called out where it happens.
 */

export const TEXT_ID = 'list-editing-text';
export const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
/** A second committed textbox: single-textbox fixtures hid cross-box bugs. */
export const OTHER_TEXT_ID = 'list-editing-other';
export const OTHER_CONTENT = `#canvas [data-element-id="${OTHER_TEXT_ID}"] .text-content`;
export const OTHER_HTML = '<p>other box</p>';
export const MOD = process.platform === 'darwin' ? 4 : 2;

/**
 * A readable picture of the block structure: one line per top-level block,
 * a header line for each list so that two adjacent lists can never look like
 * one, and indented items for sub-lists. This is the shape the assertions
 * talk about, because it is what an author sees.
 */
const OUTLINE = `(root) => {
  const clean = (value) => value.replace(/[\\s\\u00a0\\u200b\\u2060]+/g, ' ').trim();
  const ownText = (item) => {
    const clone = item.cloneNode(true);
    clone.querySelectorAll('ul, ol').forEach((nested) => nested.remove());
    return clean(clone.textContent ?? '');
  };
  const out = [];
  const walk = (list, depth) => {
    const start = list.getAttribute('start');
    out.push('  '.repeat(depth) + list.tagName.toLowerCase() + (start ? '@' + start : ''));
    for (const item of [...list.children]) {
      if (item.tagName !== 'LI') {
        // A sub-list Chromium wrote as a sibling of the items. It is marked,
        // and then walked like any other: an empty item inside it is an
        // empty bullet the author sees, and hiding it behind the marker is
        // exactly how an invented bullet went unnoticed.
        out.push('  '.repeat(depth) + '?' + item.tagName.toLowerCase());
        if (/^(?:UL|OL)$/.test(item.tagName)) walk(item, depth + 1);
        continue;
      }
      out.push('  '.repeat(depth) + '- ' + ownText(item));
      for (const child of [...item.children]) {
        if (/^(?:UL|OL)$/.test(child.tagName)) walk(child, depth + 1);
      }
    }
  };
  for (const child of [...root.children]) {
    if (/^(?:UL|OL)$/.test(child.tagName)) walk(child, 0);
    else out.push(child.tagName.toLowerCase() + ': ' + clean(child.textContent ?? ''));
  }
  return out;
}`;

/** The blocks an author puts a caret in; the nearest one holds the caret. */
export const TEXT_BLOCKS = 'li, p, div, td, th';

/**
 * Chromium's own list-editing output, legal in the live box and never in what
 * is stored. Its indent command writes a sub-list as a *sibling* of the item
 * it belongs to, and its Return inside such an item can leave an item nested
 * in an item; the editor repairs both on the way to the deck rather than on
 * the live surface, because rewriting the live DOM would cost the caret.
 * Suites assert against `liveProblems()` on screen and the unfiltered
 * `persistedProblems()` on what was saved.
 */
export const CHROMIUM_NESTING_QUIRKS = [
  'a list is nested directly inside a list',
  'a block is nested inside a block that cannot contain it',
  'a list item is outside a list',
];

export interface TextRun {
  /** Index of the run's block among the box's blocks, in document order. */
  block: number;
  blockTag: string;
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Computed, so an inherited size and an authored one read the same. */
  fontSize: string;
  fontFamily: string;
  color: string;
  /** `super`, `sub` or `baseline`, from the nearest ancestor that shifts it. */
  baseline: string;
}

/**
 * The formatting of one text node, resolved the way the editor's toolbar
 * resolves it (see `textNodeFormatState` in canvas.ts): the nearest inline
 * declaration or tag decides, else the computed style does.
 */
export const RUN_FORMATS = `((text, root) => {
  const state = (format) => {
    for (let node = text.parentElement; node && node !== root; node = node.parentElement) {
      if (format === 'bold' && node.style.fontWeight) {
        return node.style.fontWeight === 'bold' || Number.parseInt(node.style.fontWeight, 10) >= 600;
      }
      if (format === 'italic' && node.style.fontStyle) return node.style.fontStyle === 'italic';
      if (format === 'underline' && node.style.textDecorationLine) {
        return node.style.textDecorationLine.includes('underline');
      }
      if (format === 'bold' && node.matches('b, strong')) return true;
      if (format === 'italic' && node.matches('i, em')) return true;
      if (format === 'underline' && node.matches('u')) return true;
    }
    const computed = getComputedStyle(text.parentElement);
    if (format === 'bold') {
      return computed.fontWeight === 'bold' || Number.parseInt(computed.fontWeight, 10) >= 600;
    }
    if (format === 'italic') return computed.fontStyle === 'italic';
    return computed.textDecorationLine.includes('underline');
  };
  const computed = getComputedStyle(text.parentElement);
  let baseline = 'baseline';
  for (let node = text.parentElement; node && node !== root; node = node.parentElement) {
    const shift = getComputedStyle(node).verticalAlign;
    if (shift === 'super' || shift === 'sub') { baseline = shift; break; }
    if (node.matches('sup')) { baseline = 'super'; break; }
    if (node.matches('sub')) { baseline = 'sub'; break; }
  }
  return {
    bold: state('bold'), italic: state('italic'), underline: state('underline'),
    fontSize: computed.fontSize, fontFamily: computed.fontFamily, color: computed.color, baseline,
  };
})`;

export interface ListEditingSession {
  cdp: Cdp;
  port: number;
  /** Replace the box's markup. Fixture setup only — never the thing tested. */
  reset(html: string): Promise<void>;
  /** Enter text editing with a real double-click. */
  edit(): Promise<void>;
  /** Click the glyph at a flat text offset, putting a real caret there. */
  caretAt(offset: number): Promise<void>;
  /** Click into the first item/paragraph whose text starts with `text`. */
  caretIn(text: string, where?: 'start' | 'end'): Promise<void>;
  /** The live block structure. */
  outline(): Promise<string[]>;
  /** Own text (sub-lists excluded, whitespace collapsed) of every `selector` block, in order. */
  blocksOf(selector: string): Promise<string[]>;
  /**
   * Every text run of the box with the formatting an author sees on it, in
   * document order — the oracle for "what I typed came out underlined".
   */
  runs(): Promise<TextRun[]>;
  /** The block structure of what the collaboration server has stored. */
  persistedOutline(): Promise<string[]>;
  /** Wait until the server has stored a box matching `accept`. */
  expectPersisted(accept: (outline: string[]) => boolean, label: string): Promise<string[]>;
  /** Structural problems in the live box, by the shared markup invariants. */
  problems(): Promise<string[]>;
  /** The same, minus the shapes Chromium's own list editing leaves live. */
  liveProblems(): Promise<string[]>;
  /** The same rules applied to the stored markup. */
  persistedProblems(): Promise<string[]>;
  /** Collapsed text of the box. */
  text(): Promise<string>;
  /** The live markup, for failure messages. */
  markup(): Promise<string>;
  /**
   * Choose a List dropdown option with real key presses, returning the options
   * it settled on along the way — type-ahead can only step one option per
   * press, and every stop is applied.
   */
  chooseList(style: 'None' | 'Bulleted' | 'Numbered'): Promise<string[]>;
  /** One type-ahead press at the List dropdown; the option it settled on. */
  pressList(letter: 'n' | 'b'): Promise<string>;
  /** What the List dropdown currently shows. */
  shownList(): Promise<string>;
  /** A real Ctrl/Cmd+Z. */
  undo(): Promise<void>;
}

export async function startListEditingSession(deckId: string, name: string): Promise<{
  session: ListEditingSession;
  close: () => Promise<void>;
}> {
  const workDir = await mkdtemp(join(tmpdir(), 'list-editing-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, deckId);
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const deck = emptyDeck('List editing');
  deck.themePreset = 'basic';
  deck.slides[0].elements.push({
    id: TEXT_ID, type: 'text', x: 100, y: 100, w: 1720, h: 860,
    rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
    html: '<p>Text</p>', align: 'left', valign: 'top',
  } as never, {
    id: OTHER_TEXT_ID, type: 'text', x: 100, y: 975, w: 900, h: 100,
    rot: 0, z: 2, opacity: 1, class: ['role-body'], style: {},
    html: OTHER_HTML, align: 'left', valign: 'top',
  } as never);
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
    `http://127.0.0.1:${server.port}/?deck=${deckId}&name=${encodeURIComponent(name)}`, profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (candidate) => candidate.url.includes(`deck=${deckId}`),
    browser.log,
  );
  let cdp: Cdp | null = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => cdp!.evaluate<boolean>(
    `Boolean(document.querySelector('${CONTENT}'))`), 'the list fixture never loaded');
  await cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');

  const port = server.port;
  const session = buildSession(cdp, port, deckId);
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

function buildSession(cdp: Cdp, port: number, deckId: string): ListEditingSession {
  const persistedHtml = async (): Promise<string> => {
    const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${deckId}`);
    const live = await response.json() as Deck;
    const element = live.slides[0].elements.find((candidate) => candidate.id === TEXT_ID);
    return element && (element.type === 'text' || element.type === 'html') ? element.html : '';
  };
  const outlineOf = (html: string) => cdp.evaluate<string[]>(`(() => {
    const outline = ${OUTLINE};
    const template = document.createElement('template');
    template.innerHTML = ${JSON.stringify(html)};
    const root = document.createElement('div');
    root.append(...template.content.childNodes);
    return outline(root);
  })()`);

  const session: ListEditingSession = {
    cdp,
    port,
    async reset(html) {
      // Fixture setup, not an interaction: leave editing, then write the
      // markup the scenario starts from straight into the store. The canvas
      // does not patch the element being edited, so this has to come first.
      if (await cdp.evaluate<boolean>(
        `document.querySelector('${CONTENT}')?.isContentEditable === true`,
      )) {
        await cdp.click(CONTENT, 'the text box before leaving editing');
        await cdp.key('Escape', 27);
        await eventually(async () => cdp.evaluate<boolean>(
          `document.querySelector('${CONTENT}')?.isContentEditable !== true`,
        ), 'Escape did not leave text editing');
      }
      await cdp.evaluate(`(() => {
        window.store.commit((deck) => {
          const element = deck.slides[0].elements.find(
            (candidate) => candidate.id === ${JSON.stringify(TEXT_ID)});
          element.html = ${JSON.stringify(html)};
        }, { label: 'List editing fixture' });
        return true;
      })()`);
      await eventually(async () => session.outline(), 'the fixture markup did not render',
        (lines) => lines.length > 0);
    },
    async edit() {
      // A box whose every line is empty has no glyph to aim at; its own box
      // is still there to double-click.
      const hasGlyphs = await cdp.evaluate<boolean>(
        `((document.querySelector('${CONTENT}')?.textContent ?? '').trim().length > 0)`);
      if (hasGlyphs) await cdp.doubleClickText(CONTENT, 'text box');
      else await cdp.doubleClick(CONTENT, 'text box with no text');
      try {
        await eventually(async () => cdp.evaluate<boolean>(
          `document.querySelector('${CONTENT}')?.isContentEditable === true`,
        ), 'the text box did not enter editing');
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n`
          + `canvas state: ${await textEditingState(cdp, CONTENT)}`);
      }
    },
    async caretAt(offset) {
      await cdp.clickTextAtOffset(CONTENT, offset, `text offset ${offset}`);
    },
    async caretIn(text, where = 'start') {
      const offset = await cdp.evaluate<number>(`(() => {
        const root = document.querySelector('${CONTENT}');
        const flat = root?.textContent ?? '';
        return flat.indexOf(${JSON.stringify(text)});
      })()`);
      if (offset < 0) throw new Error(`no text starting ${JSON.stringify(text)} to click`);
      await cdp.clickTextAtOffset(CONTENT, offset, `the paragraph holding ${text}`);
      await cdp.key(where === 'start' ? 'Home' : 'End', where === 'start' ? 36 : 35);
    },
    outline() {
      return cdp.evaluate<string[]>(`(() => {
        const outline = ${OUTLINE};
        const root = document.querySelector('${CONTENT}');
        return root ? outline(root) : ['the text box is gone'];
      })()`);
    },
    blocksOf(selector) {
      return cdp.evaluate<string[]>(`(() => {
        const root = document.querySelector('${CONTENT}');
        if (!root) return [];
        return [...root.querySelectorAll(${JSON.stringify(selector)})].map((block) => {
          const clone = block.cloneNode(true);
          clone.querySelectorAll('ul, ol').forEach((nested) => nested.remove());
          return (clone.textContent ?? '').replace(/[\\s\\u00a0\\u200b\\u2060]+/g, ' ').trim();
        });
      })()`);
    },
    runs() {
      return cdp.evaluate<TextRun[]>(`(() => {
        const formats = ${RUN_FORMATS};
        const root = document.querySelector('${CONTENT}');
        if (!root) return [];
        const blocks = [...root.querySelectorAll('${TEXT_BLOCKS}')];
        const out = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.data.replace(/[\u200b\u2060]/g, '');
          if (!text) continue;
          const block = node.parentElement?.closest('${TEXT_BLOCKS}') ?? null;
          out.push({
            block: block ? blocks.indexOf(block) : -1,
            blockTag: block ? block.tagName.toLowerCase() : '',
            text,
            ...formats(node, root),
          });
        }
        return out;
      })()`);
    },
    async persistedOutline() {
      return outlineOf(await persistedHtml());
    },
    async expectPersisted(accept, label) {
      return eventually(async () => session.persistedOutline(),
        `${label}: the server never stored it`, accept, 15_000);
    },
    problems() {
      return cdp.evaluate<string[]>(`(() => {
        const check = ${MARKUP_INVARIANTS};
        const root = document.querySelector('${CONTENT}');
        return root ? check(root) : ['the text box is gone'];
      })()`);
    },
    async liveProblems() {
      const problems = await session.problems();
      const nested = await cdp.evaluate<boolean>(
        `Boolean(document.querySelector('${CONTENT} :is(ul, ol) :is(ul, ol, li li)'))`);
      return nested
        ? problems.filter((problem) => !CHROMIUM_NESTING_QUIRKS.includes(problem))
        : problems;
    },
    async persistedProblems() {
      const html = await persistedHtml();
      return cdp.evaluate<string[]>(`(() => {
        const check = ${MARKUP_INVARIANTS};
        const template = document.createElement('template');
        template.innerHTML = ${JSON.stringify(html)};
        const root = document.createElement('div');
        root.append(...template.content.childNodes);
        return check(root);
      })()`);
    },
    markup() {
      return cdp.evaluate<string>(
        `document.querySelector('${CONTENT}')?.innerHTML ?? ''`);
    },
    async text() {
      const value = await cdp.evaluate<string>(
        `document.querySelector('${CONTENT}')?.textContent ?? ''`);
      return value.replace(/[\s\u00a0\u200b\u2060]+/g, ' ').trim();
    },
    async chooseList(style) {
      // Type-ahead always moves to the *next* matching option, so asking for
      // the option already showing would walk away from it and come back,
      // applying something else on the way. Nothing to press is nothing to do.
      if (await session.shownList() === style) return [];
      const walk = await cdp.chooseByKeys(LIST_FIELD, style, `the List dropdown (${style})`);
      // The change handler runs synchronously; the caret goes back into the
      // box, and the panel redraws from the new markup.
      await wait(120);
      return walk;
    },
    async pressList(letter) {
      const value = await cdp.pressOptionKey(LIST_FIELD, letter, 'the List dropdown');
      await wait(120);
      return value;
    },
    async shownList() {
      await listFieldPresent(cdp);
      return cdp.evaluate<string>(`document.querySelector('${LIST_FIELD}').value`);
    },
    async undo() {
      await cdp.chord('z', 'KeyZ', 90, MOD);
      await wait(200);
    },
  };
  return session;
}

/**
 * The inspector's List `<select>`. Addressed by the class the panel puts on
 * the field, because applying an option redraws the panel and replaces the
 * element — an id assigned by the test would not survive the first press.
 */
const LIST_FIELD = '#inspector .text-list-style select';

async function listFieldPresent(cdp: Cdp): Promise<void> {
  const found = await cdp.evaluate<boolean>(
    `Boolean(document.querySelector('${LIST_FIELD}'))`);
  expect(found, 'the inspector List control is missing').toBe(true);
}
