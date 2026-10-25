import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  installEditingTrace,
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

/** The list box as the deck is created with it (see `startListEditingSession`). */
const LIST_BOX = {
  id: TEXT_ID, type: 'text', x: 100, y: 100, w: 1720, h: 860,
  rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
  html: '<p>Text</p>', align: 'left', valign: 'top',
};

/**
 * The list box in a deck, put back first if a test lost it: a walk that
 * deletes the box has failed already, and every later test failing on the
 * missing box only buried what it found (seed 2026101501).
 */
const FIXTURE_BOX = `((deck) => {
  let element = deck.slides[0].elements.find((candidate) => candidate.id === ${JSON.stringify(TEXT_ID)});
  if (!element) {
    element = ${JSON.stringify(LIST_BOX)};
    deck.slides[0].elements.push(element);
  }
  return element;
})`;

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
      if (item.hasAttribute('data-list-holder')) {
        // An item that only holds an indented list draws no line of its own
        // (the first item of a list, indented): its lists are what is seen.
        for (const child of [...item.children]) {
          if (/^(?:UL|OL)$/.test(child.tagName)) walk(child, depth + 1);
        }
        continue;
      }
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

/**
 * The blocks an author puts a caret in; the nearest one holds the caret. An
 * item that only holds an indented list is not one: it draws no line.
 */
export const TEXT_BLOCKS = 'li:not([data-list-holder]), p, div, td, th';

/** Nested lists: the block holding a caret is always the nearest match. */
export const CARET_BLOCKS = TEXT_BLOCKS;

/**
 * Where the caret is, and where the block it sits in lets text start.
 *
 * `lineStart` is the x the block's first line box begins at; `contentStart` is
 * the x its content edge sits at, and `blockLeft` its border-box edge. A list
 * item reserves the strip between `blockLeft` and `contentStart` for the
 * marker it draws inside its own line (see type.css). A caret on a line with
 * no text is drawn at `lineStart`, so `lineStart` landing anywhere other than
 * where text goes is a caret drawn on the wrong side of the marker.
 */
export interface CaretGeometry {
  error?: string;
  /** Index of the caret's block among the box's blocks, in document order. */
  blockIndex: number;
  blockTag: string;
  /** The block's own text, sub-lists excluded. */
  blockText: string;
  /** True when the caret sits in a text node rather than at a block boundary. */
  anchoredInText: boolean;
  /** x the collapsed caret reports, or null when it reports no position. */
  caretX: number | null;
  /** x the block's first line box begins at. */
  lineStart: number;
  /** x the block's content edge sits at. */
  contentStart: number;
  blockLeft: number;
}

/** A block's own text, sub-lists excluded and whitespace collapsed. */
const OWN_TEXT = `((block) => {
  const clone = block.cloneNode(true);
  clone.querySelectorAll('ul, ol').forEach((nested) => nested.remove());
  return (clone.textContent ?? '').replace(/[\\s\\u00a0\\u200b\\u2060]+/g, ' ').trim();
})`;

/** One character with a glyph box, typed to find out where text lands. */
const PROBE_CHARACTER = 'x';

/**
 * A point where a click reaches the list box, as the canvas hit-tests it:
 * inside the box's frame -- text running out of a short box is painted, but
 * a click on it lands on the slide -- and clear of the resize handles a
 * selected box puts up: in a short box the first glyph sits right on the
 * top-left one, and an empty box overflowing with blank lines centres on the
 * bottom one. A glyph that is both, or failing that (a box whose lines are
 * empty, or whose text all sits in a corner) a bare point: anywhere in the
 * frame for a double-click, which enters editing there, but on the text
 * itself for a click while editing -- the empty part of a box below its
 * lines is the box, and a click there ends editing.
 */
const REACHABLE_POINT = `((onText) => {
  const root = document.querySelector('${CONTENT}');
  const node = root?.closest('.element');
  if (!root || !node) return null;
  const box = node.getBoundingClientRect();
  const text = root.getBoundingClientRect();
  const handles = [0, 0.5, 1].flatMap((fx) => [0, 0.5, 1]
    .filter((fy) => fx !== 0.5 || fy !== 0.5)
    .map((fy) => [box.left + box.width * fx, box.top + box.height * fy]));
  const reaches = (x, y) => x > box.left + 2 && x < box.right - 2
    && y > box.top + 2 && y < box.bottom - 2
    && handles.every(([hx, hy]) => Math.hypot(hx - x, hy - y) > 20)
    && (onText ? root : node).contains(document.elementFromPoint(x, y));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    for (let i = 0; i < text.data.length; i++) {
      if (/\\s/.test(text.data[i])) continue;
      const range = document.createRange();
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const r = range.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (r.width > 0 && reaches(x, y)) return { x, y };
    }
  }
  // Where the text and the frame overlap: lines run past a short box's
  // frame, and only the part inside it takes a click.
  const area = onText
    ? {
      left: Math.max(text.left, box.left),
      top: Math.max(text.top, box.top),
      width: Math.min(text.right, box.right) - Math.max(text.left, box.left),
      height: Math.min(text.bottom, box.bottom) - Math.max(text.top, box.top),
    }
    : box;
  for (const fy of [0.5, 0.3, 0.7]) {
    for (const fx of [0.25, 0.75, 0.4, 0.6]) {
      const x = area.left + area.width * fx;
      const y = area.top + area.height * fy;
      if (reaches(x, y)) return { x, y };
    }
  }
  return null;
})`;

/** One line of a box as a reader sees it; see `ListEditingSession.seenLines`. */
/**
 * The ways a person stops editing a box: Escape (once, which keeps the box
 * selected, or twice), a click on bare slide, or a click on another box.
 */
export type LeaveRoute = 'escape' | 'escape twice' | 'slide' | 'other box';
export const LEAVE_ROUTES: LeaveRoute[] = ['escape', 'escape twice', 'slide', 'other box'];

export interface SeenLine {
  /** The line's top, in the slide's own pixels below the top of the box's text. */
  top: number;
  /** The markers drawn on it: `•`, `-`, a number such as `2.`, or `*` for a browser marker. */
  markers: string;
  /** Its glyphs, whitespace dropped. */
  text: string;
}

/**
 * The box line by line, from what is painted rather than from the markup:
 * leaving editing re-renders the box from the stored html, whose markup is
 * legitimately not the live surface's (Chromium's sibling sub-lists are
 * repaired on the way), so only the picture can be compared. Numbers are
 * worked out the way CSS counts `list-item`, which the page cannot be asked.
 */
const SEEN_LINES = `((selector) => {
  const root = document.querySelector(selector);
  if (!root) return null;
  const origin = root.getBoundingClientRect();
  const scale = origin.width / (root.offsetWidth || 1);
  const numbers = new Map();
  for (const list of root.querySelectorAll('ol')) {
    let count = (Number.parseInt(list.getAttribute('start') ?? '', 10) || 1) - 1;
    for (const item of list.children) {
      if (item.tagName !== 'LI' || getComputedStyle(item).display !== 'list-item') continue;
      const value = Number.parseInt(item.getAttribute('value') ?? '', 10);
      const step = /list-item\\s+(-?\\d+)/.exec(getComputedStyle(item).counterIncrement);
      count = Number.isFinite(value) ? value : count + (step ? Number(step[1]) : 1);
      numbers.set(item, count);
    }
  }
  const rows = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (let at = 0; at < node.data.length; at += 1) {
      if (/[\\s\\u00a0\\u200b\\u2060]/.test(node.data[at])) continue;
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const rect = range.getBoundingClientRect();
      if (rect.height <= 0) continue;
      const middle = (rect.top + rect.bottom) / 2;
      const row = rows.find((candidate) => middle >= candidate.top && middle <= candidate.bottom);
      if (row) {
        row.text += node.data[at];
        row.top = Math.min(row.top, rect.top);
        row.bottom = Math.max(row.bottom, rect.bottom);
      } else {
        rows.push({ top: rect.top, bottom: rect.bottom, markers: [], text: node.data[at] });
      }
    }
  }
  for (const item of root.querySelectorAll('li')) {
    const before = getComputedStyle(item, '::before');
    const own = getComputedStyle(item);
    let marker = '';
    if (before.content && before.content !== 'none' && before.display !== 'none') {
      if (before.content.includes('counter')) marker = (numbers.get(item) ?? '?') + '.';
      else if (before.content === '""') marker = before.backgroundImage !== 'none' ? '•' : '';
      else marker = before.content.replace(/^"|"$/g, '');
    } else if (own.listStyleType !== 'none' && getComputedStyle(item, '::marker').content !== '""') {
      marker = '*';
    }
    if (!marker) continue;
    const box = item.getBoundingClientRect();
    const top = box.top + (Number.parseFloat(own.paddingTop) || 0) * scale;
    const line = (Number.parseFloat(own.lineHeight) || Number.parseFloat(own.fontSize) * 1.2) * scale;
    const row = rows.find((candidate) => top + line / 2 >= candidate.top && top + line / 2 <= candidate.bottom);
    if (row) row.markers.push(marker);
    else rows.push({ top, bottom: top + line, markers: [marker], text: '' });
  }
  rows.sort((a, b) => a.top - b.top);
  return rows.map((row) => ({
    top: Math.round((row.top - origin.top) / scale),
    markers: row.markers.join(' '),
    text: row.text,
  }));
})`;

/**
 * How two pictures of a box differ, or null when a reader would see the same
 * lines: the same text and markers on each, no line more or less, and every
 * line within `tolerance` slide pixels of where it was.
 */
export function seenDifference(before: SeenLine[], after: SeenLine[], tolerance = 2): string | null {
  const show = (lines: SeenLine[]) => lines
    .map((line) => `${line.top}: ${line.markers ? `${line.markers} ` : ''}${line.text}`).join(' | ');
  const differs = before.length !== after.length || before.some((line, index) => (
    line.text !== after[index].text
    || line.markers !== after[index].markers
    || Math.abs(line.top - after[index].top) > tolerance
  ));
  return differs ? `before: ${show(before)}\n after: ${show(after)}` : null;
}

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

/**
 * The one rule the caret suites check: the caret is drawn where your text
 * goes. A caret anchored in text reports its own position; a caret at a block
 * boundary — all an empty line has — reports nothing, so the place it is drawn
 * is the start of that block's line. Returns the author's complaint, or null.
 */
export function caretDisagreement(
  caret: CaretGeometry,
  typedX: number,
  tolerance = 1,
): string | null {
  if (caret.error) return caret.error;
  const drawnAt = caret.caretX ?? caret.lineStart;
  if (Math.abs(drawnAt - typedX) <= tolerance) return null;
  const where = caret.caretX === null
    ? `the start of its <${caret.blockTag}> line (x=${caret.lineStart})`
    : `x=${caret.caretX}`;
  return `caret drawn at ${where}, text typed there lands at x=${typedX}`;
}

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

/** The list box's geometry, style and auto-fit, for walks in boxes of other shapes. */
export interface BoxShape {
  h: number;
  style: Record<string, string>;
  autoFit: boolean;
}

/** The shared list box: tall enough that nothing typed in a test overflows it. */
export const BOX_DEFAULTS: BoxShape = { h: 860, style: {}, autoFit: false };

/**
 * The type-size oracle, run in the page. Waits two frames, so a fit that an
 * edit scheduled has run before anything is read.
 */
const TYPE_SIZE_PROBLEMS = `((selector) => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const root = document.querySelector(selector);
    const node = root?.closest('.element');
    const body = root?.parentElement;
    if (!root || !node || !body) return resolve(['the text box is gone']);
    const own = Number.parseFloat(getComputedStyle(node).fontSize);
    const problems = [];
    const runs = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      const words = text.data.replace(/[\\s\\u00a0\\u200b\\u2060]+/g, '');
      if (words) runs.push([words, Number.parseFloat(getComputedStyle(text.parentElement).fontSize)]);
    }
    const wrongRuns = (expected, why) => {
      for (const [words, size] of runs) {
        if (Math.abs(size - expected) > 0.05) problems.push(JSON.stringify(words) + ' is ' + size + 'px, ' + why);
      }
    };
    if (node.dataset.autoFit !== 'true') {
      if (root.dataset.fittedFontSize !== undefined) {
        problems.push('a box without auto-fit was fitted to ' + root.dataset.fittedFontSize + 'px');
      }
      if (root.style.fontSize) problems.push('a box without auto-fit carries font-size ' + root.style.fontSize);
      wrongRuns(own, 'the box without auto-fit is ' + own + 'px');
    } else {
      const fitted = Number.parseFloat(root.dataset.fittedFontSize ?? '');
      if (!Number.isFinite(fitted)) problems.push('the auto-fit box was never fitted');
      else {
        if (fitted > own + 0.05) problems.push('fitted to ' + fitted + 'px, above its own ' + own + 'px');
        wrongRuns(fitted, 'the box was fitted to ' + fitted + 'px');
        // At the 6px floor there is nothing smaller to try.
        const overflows = root.scrollHeight > body.clientHeight + 1 || root.scrollWidth > body.clientWidth + 1;
        if (overflows && fitted > 6.05) {
          problems.push('fitted to ' + fitted + 'px and still overflows: ' + root.scrollWidth + 'x'
            + root.scrollHeight + ' in ' + body.clientWidth + 'x' + body.clientHeight);
        }
      }
    }
    resolve(problems);
  }));
}))`;

/**
 * Collect what the render-invariant checker reports. It only writes to the
 * console, which no test reads, so wrap `console.error` in the page.
 */
async function captureRenderDivergences(cdp: Cdp): Promise<void> {
  await cdp.evaluate(`(() => {
    if (window.__renderDivergences) return true;
    window.__renderDivergences = [];
    const original = console.error.bind(console);
    console.error = (...args) => {
      if (typeof args[0] === 'string' && args[0].startsWith('[render-invariant]')) {
        window.__renderDivergences.push(args[0] + ' ' + JSON.stringify(args.slice(1)));
      }
      original(...args);
    };
    return true;
  })()`);
}

export interface ListEditingSession {
  cdp: Cdp;
  port: number;
  /** Replace the box's markup. Fixture setup only — never the thing tested. */
  reset(html: string): Promise<void>;
  /**
   * Resize the box and set its style and auto-fit, leaving editing first.
   * Fixture setup only; `BOX_DEFAULTS` puts the shared box back.
   */
  shapeBox(box: BoxShape): Promise<void>;
  /**
   * What is wrong with the type size of `selector`'s box (default: the list
   * box), read after a scheduled fit has run. A box without auto-fit keeps its
   * own size on every run and carries no fit residue; an auto-fit box shows
   * every run at the size it fitted, no larger than its own, and fits.
   */
  typeSizeProblems(selector?: string): Promise<string[]>;
  /**
   * What the canvas's render-invariant checker reported since the last call:
   * a patched node that no longer matches a fresh render of the deck.
   */
  renderDivergences(): Promise<string[]>;
  /** Enter text editing with a real double-click. */
  edit(): Promise<void>;
  /** A real click at a point of the box that a click reaches (see `REACHABLE_POINT`). */
  clickIntoBox(label: string): Promise<void>;
  /** Click the glyph at a flat text offset, putting a real caret there. */
  caretAt(offset: number): Promise<void>;
  /** Click into the first item/paragraph whose text starts with `text`. */
  caretIn(text: string, where?: 'start' | 'end'): Promise<void>;
  /** The box's blocks in document order, as `tag:own text`. */
  blocks(): Promise<string[]>;
  /**
   * Click the middle of block `index`'s first line, clear of any list marker —
   * the gesture an author uses to put the caret on a line, including a line
   * with nothing on it.
   */
  caretInBlock(index: number): Promise<void>;
  /** Where the caret is, and where its block lets text start. */
  caretGeometry(): Promise<CaretGeometry>;
  /**
   * The x a character typed at the caret is actually drawn at, measured by
   * typing one and taking it back. This is the place the author sees their
   * text appear, so it is the place the caret should already have been.
   */
  typedCharacterStart(): Promise<number>;
  /** The live block structure. */
  outline(): Promise<string[]>;
  /**
   * The box (default: the list box) as a reader sees it, line by line, after
   * two frames so a re-render or a fit has landed. Leaving text editing must
   * not change it: an empty bullet that turns up when the box stops being
   * edited is invisible to every structural check, because an empty bullet
   * is a perfectly sound thing to have.
   */
  seenLines(selector?: string): Promise<SeenLine[]>;
  /**
   * Leave text editing the way `route` says a person does, and wait until
   * the box is no longer being edited.
   */
  leaveEditing(route: LeaveRoute): Promise<void>;
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

/**
 * `textStyle` is the list box's style as it is saved on disk before the app
 * opens the deck -- what a deck written by an importer looks like on load,
 * which a later `shapeBox` (a live store commit) cannot reproduce.
 */
export async function startListEditingSession(deckId: string, name: string, options: {
  textStyle?: Record<string, string>;
} = {}): Promise<{
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
  deck.slides[0].elements.push({ ...LIST_BOX } as never, {
    id: OTHER_TEXT_ID, type: 'text', x: 100, y: 975, w: 900, h: 100,
    rot: 0, z: 2, opacity: 1, class: ['role-body'], style: {},
    html: OTHER_HTML, align: 'left', valign: 'top',
  } as never);
  await saveDeck(deckDir, deck);
  if (options.textStyle) {
    // Written past saveDeck, which would put the style through the schema:
    // the point is the bytes an older app or an importer left on disk.
    const saved = JSON.parse(await readFile(join(deckDir, 'deck.json'), 'utf8')) as Deck;
    const element = saved.slides[0].elements.find((candidate) => candidate.id === TEXT_ID)!;
    element.style = options.textStyle;
    await writeFile(join(deckDir, 'deck.json'), `${JSON.stringify(saved, null, 2)}\n`, 'utf8');
  }
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
  // CI shows every suite's window on one bare Xvfb, where the window mapped
  // last takes the keyboard. Losing it blurs the field being typed into, and
  // a blur commits the field: half of a typed "20" became the size. These
  // pages stand for the window an author is typing in, so they keep focus.
  await cdp.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await eventually(async () => cdp!.evaluate<boolean>(
    `Boolean(document.querySelector('${CONTENT}'))`), 'the list fixture never loaded');
  await cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
  await installEditingTrace(cdp);
  await captureRenderDivergences(cdp);

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

  const reachablePoint = (onText: boolean) => cdp.evaluate<{ x: number; y: number } | null>(
    `${REACHABLE_POINT}(${onText})`);
  const clickIntoBox = async (label: string): Promise<void> => {
    const point = await reachablePoint(true);
    if (!point) {
      const where = await cdp.evaluate<string>(`(() => {
        const root = document.querySelector('${CONTENT}');
        const frame = root.closest('.element').getBoundingClientRect();
        const text = root.getBoundingClientRect();
        const r = (b) => [b.left, b.top, b.width, b.height].map(Math.round).join(',');
        const hit = document.elementFromPoint(frame.left + frame.width / 2, frame.top + frame.height / 2);
        return 'frame ' + r(frame) + ' text ' + r(text) + ' window ' + innerWidth + 'x' + innerHeight
          + ' centre hits ' + (hit ? hit.tagName + '.' + hit.className : 'nothing');
      })()`);
      throw new Error(`no point of the text box is left to click: ${label}; ${where}`);
    }
    await cdp.clickAt(point.x, point.y);
  };

  const leaveEditing = async (): Promise<void> => {
    if (!await cdp.evaluate<boolean>(
      `document.querySelector('${CONTENT}')?.isContentEditable === true`,
    )) return;
    // Focus back in the box first: Escape in the inspector means something else.
    await clickIntoBox('before leaving editing');
    await cdp.key('Escape', 27);
    await eventually(async () => cdp.evaluate<boolean>(
      `document.querySelector('${CONTENT}')?.isContentEditable !== true`,
    ), 'Escape did not leave text editing');
  };

  const session: ListEditingSession = {
    cdp,
    port,
    clickIntoBox,
    async shapeBox(box) {
      await leaveEditing();
      await cdp.evaluate(`(() => {
        window.store.commit((deck) => {
          const element = ${FIXTURE_BOX}(deck);
          element.h = ${box.h};
          element.style = ${JSON.stringify(box.style)};
          if (${box.autoFit}) element.autoFit = true;
          else delete element.autoFit;
        }, { label: 'List editing fixture' });
        return true;
      })()`);
    },
    typeSizeProblems(selector = CONTENT) {
      return cdp.evaluate<string[]>(`${TYPE_SIZE_PROBLEMS}(${JSON.stringify(selector)})`);
    },
    renderDivergences() {
      return cdp.evaluate<string[]>(
        `(window.__renderDivergences ?? ['the checker capture is not installed']).splice(0)`);
    },
    async reset(html) {
      // Fixture setup, not an interaction: leave editing, then write the
      // markup the scenario starts from straight into the store. The canvas
      // does not patch the element being edited, so this has to come first.
      await leaveEditing();
      await cdp.evaluate(`(() => {
        window.store.commit((deck) => {
          const element = ${FIXTURE_BOX}(deck);
          element.html = ${JSON.stringify(html)};
        }, { label: 'List editing fixture' });
        return true;
      })()`);
      await eventually(async () => session.outline(), 'the fixture markup did not render',
        (lines) => lines.length > 0);
    },
    async edit() {
      // A double-click enters editing only where the canvas hands it to the
      // box. Falling back to the first glyph grabbed the handle (nightly
      // seeds 20261015, 20261020, 20261023) or the slide (20261017).
      const point = await reachablePoint(false);
      if (!point) throw new Error('no point of the text box is left to double-click');
      await cdp.doubleClickAt(point.x, point.y);
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
    blocks() {
      return cdp.evaluate<string[]>(`(() => {
        const own = ${OWN_TEXT};
        const root = document.querySelector('${CONTENT}');
        if (!root) return ['the text box is gone'];
        return [...root.querySelectorAll('${CARET_BLOCKS}')]
          .map((block) => block.tagName.toLowerCase() + ':' + own(block));
      })()`);
    },
    async caretInBlock(index) {
      const point = await cdp.evaluate<{ x: number; y: number } | { error: string }>(`(() => {
        const root = document.querySelector('${CONTENT}');
        const block = root?.querySelectorAll('${CARET_BLOCKS}')[${index}];
        if (!block) return { error: 'no block ${index} in the text box' };
        const box = block.getBoundingClientRect();
        const style = getComputedStyle(block);
        // Computed lengths are in the slide's own pixels, client rects in
        // screen ones; the canvas paints under a transform between them.
        const scale = block.offsetWidth > 0 ? box.width / block.offsetWidth : 1;
        const line = (parseFloat(style.lineHeight) || 0) * scale;
        // The content edge, which is where the block's text starts and where a
        // marker drawn in the line has already ended. A click there is a click
        // on the line, never on the marker.
        const x = box.left + (parseFloat(style.paddingLeft) || 0) * scale + 4;
        // The block's *first* line: an item holding a sub-list is as tall as
        // the sub-list, and its middle is a different item entirely.
        const y = box.top + Math.min(line || box.height, box.height) / 2;
        return { x: Math.round(x), y: Math.round(y) };
      })()`);
      if ('error' in point) throw new Error(point.error);
      await cdp.clickAt(point.x, point.y);
    },
    caretGeometry() {
      return cdp.evaluate<CaretGeometry>(`(() => {
        const own = ${OWN_TEXT};
        const root = document.querySelector('${CONTENT}');
        const selection = window.getSelection();
        const blank = { blockIndex: -1, blockTag: '', blockText: '', anchoredInText: false,
                        caretX: null, lineStart: 0, contentStart: 0, blockLeft: 0 };
        if (!root) return { ...blank, error: 'the text box is gone' };
        if (!selection || selection.rangeCount === 0) return { ...blank, error: 'there is no caret' };
        const range = selection.getRangeAt(0);
        if (!root.contains(range.startContainer)) {
          return { ...blank, error: 'the caret is outside the text box' };
        }
        const node = range.startContainer;
        const holder = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        const block = holder && holder.closest('${CARET_BLOCKS}');
        if (!block || !root.contains(block)) {
          return { ...blank, error: 'the caret is not in a block' };
        }
        const box = block.getBoundingClientRect();
        const style = getComputedStyle(block);
        // The canvas paints the slide under a transform, so client rects are
        // in screen pixels while computed lengths are in the slide's own. A
        // hanging indent measured in one and applied to the other is wrong by
        // the zoom — invisibly so while padding and indent cancel out.
        const scale = block.offsetWidth > 0 ? box.width / block.offsetWidth : 1;
        const padding = (parseFloat(style.paddingLeft) || 0) * scale;
        const indent = (parseFloat(style.textIndent) || 0) * scale;
        // Only a collapsed caret anchored in text reports a position at all;
        // one anchored at a block boundary reports nothing, which is why the
        // block's own geometry has to say where such a caret must be.
        const rects = [...range.getClientRects()];
        return {
          blockIndex: [...root.querySelectorAll('${CARET_BLOCKS}')].indexOf(block),
          blockTag: block.tagName.toLowerCase(),
          blockText: own(block),
          anchoredInText: node.nodeType === Node.TEXT_NODE,
          caretX: rects.length ? +rects[0].left.toFixed(2) : null,
          lineStart: +(box.left + padding + indent).toFixed(2),
          contentStart: +(box.left + padding).toFixed(2),
          blockLeft: +box.left.toFixed(2),
        };
      })()`);
    },
    async typedCharacterStart() {
      await cdp.typeKeys(PROBE_CHARACTER);
      await wait(80);
      // The caret now sits just after the character it typed, so the character
      // is the one before it — and its left edge is the x the caret was asked
      // to be at. Reading it this way holds at any offset, not only at the
      // start of a block.
      const x = await cdp.evaluate<number | null>(`(() => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        const node = range.startContainer;
        if (node.nodeType !== Node.TEXT_NODE || range.startOffset < 1) return null;
        const probe = document.createRange();
        probe.setStart(node, range.startOffset - 1);
        probe.setEnd(node, range.startOffset);
        if (probe.toString() !== ${JSON.stringify(PROBE_CHARACTER)}) return null;
        const rects = [...probe.getClientRects()];
        return rects.length ? +rects[0].left.toFixed(2) : null;
      })()`);
      await cdp.key('Backspace', 8);
      await wait(80);
      if (x === null) throw new Error('the probe character left no measurable glyph');
      return x;
    },
    outline() {
      return cdp.evaluate<string[]>(`(() => {
        const outline = ${OUTLINE};
        const root = document.querySelector('${CONTENT}');
        return root ? outline(root) : ['the text box is gone'];
      })()`);
    },
    async seenLines(selector = CONTENT) {
      const lines = await cdp.evaluate<SeenLine[] | null>(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(
          ${SEEN_LINES}(${JSON.stringify(selector)}))));
      })`);
      if (!lines) throw new Error(`no ${selector} to look at`);
      return lines;
    },
    async leaveEditing(route) {
      let way = route;
      if (way === 'other box') {
        // The list box can grow down over the other box; then there is none
        // of it left to click, for a person either, and bare slide will do.
        const reachable = await cdp.evaluate<boolean>(`(() => {
          const root = document.querySelector('${OTHER_CONTENT}');
          const text = root && document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
          if (!text) return false;
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, 1);
          const r = range.getBoundingClientRect();
          return root.contains(document.elementFromPoint(r.left + r.width * 0.2, r.top + r.height / 2));
        })()`);
        if (reachable) await cdp.clickTextAtOffset(OTHER_CONTENT, 0, 'the other text box');
        else way = 'slide';
      }
      if (way === 'slide') {
        const point = await cdp.evaluate<{ x: number; y: number } | null>(`(() => {
          const slide = document.querySelector('#canvas .slide');
          if (!slide) return null;
          const r = slide.getBoundingClientRect();
          for (const [fx, fy] of [[0.97, 0.97], [0.97, 0.5], [0.97, 0.03], [0.5, 0.97], [0.03, 0.97]]) {
            const x = r.left + r.width * fx;
            const y = r.top + r.height * fy;
            const hit = document.elementFromPoint(x, y);
            if (hit && slide.contains(hit) && !hit.closest('.element, .handle')) return { x, y };
          }
          return null;
        })()`);
        if (!point) throw new Error('no bare slide left to click');
        await cdp.clickAt(point.x, point.y);
      }
      if (way === 'escape' || way === 'escape twice') {
        await cdp.key('Escape', 27);
        if (way === 'escape twice') await cdp.key('Escape', 27);
      }
      await eventually(async () => cdp.evaluate<boolean>(
        `document.querySelector('${CONTENT}')?.isContentEditable !== true`,
      ), `${route} did not leave text editing`);
    },
    blocksOf(selector) {
      return cdp.evaluate<string[]>(`(() => {
        const root = document.querySelector('${CONTENT}');
        if (!root) return [];
        return [...root.querySelectorAll(${JSON.stringify(selector)})]
          .filter((block) => !block.hasAttribute('data-list-holder')).map((block) => {
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
