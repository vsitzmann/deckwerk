import { expect } from 'vitest';
import { Cdp, eventually, textEditingState, wait } from './browserSession.js';

/**
 * Clipboard payloads authors really paste into a slide, and the machinery to
 * paste them through the real clipboard, act on the result, and check that the
 * box is still something the editor can render and edit.
 *
 * Every payload here is markup a real application writes: Apple Notes and
 * Word emit their own class soup, Google Docs wraps everything in a guid
 * `<b>`, spreadsheets emit tables, and web pages emit whatever they like —
 * including markup that is invalid in the editor's block model (a `<ul>` in a
 * `<ul>`, a list inside a `<p>`, an `<li>` with no list) or unsafe (scripts,
 * event handlers, `javascript:` URLs).
 */

export const PASTE_TEXT_ID = 'paste-fuzz-text';
export const PASTE_CONTENT = `#canvas [data-element-id="${PASTE_TEXT_ID}"] .text-content`;
/** A second committed textbox: single-textbox fixtures hid cross-box bugs. */
export const PASTE_OTHER_ID = 'paste-fuzz-other';
export const PASTE_OTHER_CONTENT = `#canvas [data-element-id="${PASTE_OTHER_ID}"] .text-content`;
export const PASTE_OTHER_HTML = '<p>other box</p>';
export const PASTE_PANEL = '#inspector';
export const PASTE_MOD = process.platform === 'darwin' ? 4 : 2;
/** The typing run seals after 600 ms of idle; wait comfortably past that. */
export const SEAL_MS = 900;

export interface ClipboardPayload {
  name: string;
  /** Omitted for a plain-text-only clipboard, as from a terminal or editor. */
  html?: string;
  text: string;
  /** Visible words that must survive the paste. */
  expected: string[];
  /** Authored equations that must survive a rendered KaTeX clipboard round trip. */
  math?: Array<{ tex: string; display: boolean }>;
}

const NOTES_BULLETS = [
  '<ul class="ul1">',
  '<li class="li1"><span class="s1"></span></li>',
  '<li class="li1"><span class="s1"></span></li>',
  '<li class="li1"><span class="s1"></span></li>',
  '<li class="li1"><span class="s1">learn about yourself to figure out what excites'
    + ' <i>you</i> more than anything else</span></li>',
  '<li class="li1"><span class="s1">Ideally, build a personal brad for that thing.</span></li>',
  '<li class="li1"><span class="s1">Grow as a person: learn taste in problems, learn to'
    + ' operate under extraordinary uncertainty. Hone your perseverance. </span></li>',
  '<ul class="ul2"><li class="li1"><span class="s1">Learn things about the world that'
    + ' nobody else knows yet!</span></li></ul>',
  '</ul>',
].join('');

export const PASTE_CORPUS: ClipboardPayload[] = [
  {
    // The reported case: empty bullets, an italic run, and a sub-bullet that
    // Notes writes as a `<ul>` directly inside the outer `<ul>`.
    name: 'apple-notes-bullets',
    html: NOTES_BULLETS,
    text: [
      '* ', '* ', '* ',
      '* learn about yourself to figure out what excites you more than anything else',
      '* Ideally, build a personal brad for that thing.',
      '* Grow as a person: learn taste in problems, learn to operate under extraordinary'
        + ' uncertainty. Hone your perseverance. ',
      '',
      '• ⁃ Learn things about the world that nobody else knows yet!',
    ].join('\n'),
    expected: ['learn about yourself', 'personal brad', 'perseverance', 'nobody else knows yet'],
  },
  {
    name: 'apple-notes-numbered',
    html: '<ol class="ol1"><li class="li1"><span class="s1">First step</span></li>'
      + '<li class="li1"><span class="s1">Second step</span></li>'
      + '<ol class="ol2"><li class="li1"><span class="s1">Nested detail</span></li></ol></ol>',
    text: '1. First step\n2. Second step\n\t1. Nested detail',
    expected: ['First step', 'Second step', 'Nested detail'],
  },
  {
    name: 'word-list-paragraphs',
    html: '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>'
      + '<!-- p.MsoNormal { margin: 0 } --></style></head><body>'
      + '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1">'
      + '<!--[if !supportLists]--><span style="mso-list:Ignore">·<span>&nbsp;&nbsp;</span>'
      + '</span><!--[endif]-->Quarterly revenue<o:p></o:p></p>'
      + '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1">'
      + '<!--[if !supportLists]--><span style="mso-list:Ignore">·<span>&nbsp;&nbsp;</span>'
      + '</span><!--[endif]-->Operating margin<o:p></o:p></p></body></html>',
    text: '·\tQuarterly revenue\n·\tOperating margin',
    expected: ['Quarterly revenue', 'Operating margin'],
  },
  {
    name: 'google-docs-list',
    html: '<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-abc">'
      + '<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px">'
      + '<li dir="ltr" style="list-style-type:disc;font-size:11pt"><p dir="ltr" role="presentation">'
      + '<span style="font-weight:700">Findings</span></p></li>'
      + '<li dir="ltr" style="list-style-type:disc"><p dir="ltr" role="presentation">'
      + '<span>Latency dropped by half</span></p></li></ul></b>',
    text: 'Findings\nLatency dropped by half',
    expected: ['Findings', 'Latency dropped by half'],
  },
  {
    name: 'spreadsheet-table',
    html: '<google-sheets-html-origin><table><tbody>'
      + '<tr><td>Quarter</td><td>Revenue</td></tr>'
      + '<tr><td>Q1</td><td>1,250</td></tr></tbody></table>',
    text: 'Quarter\tRevenue\nQ1\t1,250',
    expected: ['Quarter', 'Revenue', 'Q1'],
  },
  {
    name: 'plain-text-markers',
    text: '* First bullet\n* Second bullet\n\n1. First step\n2. Second step\n- dashed item',
    expected: ['First bullet', 'Second bullet', 'First step', 'dashed item'],
  },
  {
    name: 'plain-text-single-line',
    text: 'One single pasted line',
    expected: ['One single pasted line'],
  },
  {
    name: 'plain-text-blank-lines',
    text: 'Above\n\n\n\nBelow',
    expected: ['Above', 'Below'],
  },
  {
    name: 'web-page-headings',
    html: '<div><h1>Chapter one</h1><h2>Background</h2><p>Body text with a '
      + '<a href="https://example.com/docs">link</a> and <strong>bold</strong>.</p>'
      + '<div>Loose div line<br>after a break</div></div>',
    text: 'Chapter one\nBackground\nBody text with a link and bold.\nLoose div line\nafter a break',
    expected: ['Chapter one', 'Background', 'Body text', 'Loose div line'],
  },
  {
    name: 'unsafe-markup',
    html: '<div>Before<script>window.__pasteOwned = true;</script>'
      + '<img src="x" onerror="window.__pasteOwned = true">'
      + '<a href="javascript:window.__pasteOwned = true">click me</a>'
      + '<iframe src="https://example.com"></iframe><p onclick="window.__pasteOwned = true">'
      + 'After</p></div>',
    text: 'Before\nclick me\nAfter',
    expected: ['Before', 'After'],
  },
  {
    name: 'deeply-nested-mixed-lists',
    html: '<ul><li>Top<ol><li>Second level<ul><li>Third level</li></ul></li></ol></li>'
      + '<li>Back to top</li></ul>',
    text: 'Top\n\tSecond level\n\t\tThird level\nBack to top',
    expected: ['Top', 'Second level', 'Third level', 'Back to top'],
  },
  {
    name: 'stray-list-and-orphan-item',
    html: '<ul><ul><li>Orphaned sub item</li></ul></ul><li>Item with no list</li>',
    text: 'Orphaned sub item\nItem with no list',
    expected: ['Orphaned sub item', 'Item with no list'],
  },
  {
    name: 'paragraphs-inside-items',
    html: '<ul><li><p>Paragraph in an item</p><p>Second paragraph</p></li>'
      + '<li><div>Div in an item</div></li></ul>',
    text: 'Paragraph in an item\nSecond paragraph\nDiv in an item',
    expected: ['Paragraph in an item', 'Second paragraph', 'Div in an item'],
  },
  {
    name: 'preformatted-code',
    html: '<pre><code>const total = items.reduce((sum, x) =&gt; sum + x, 0);\n'
      + 'if (total &lt; 10) return null;</code></pre>',
    text: 'const total = items.reduce((sum, x) => sum + x, 0);\nif (total < 10) return null;',
    expected: ['const total', 'return null'],
  },
  {
    name: 'entities-and-emoji',
    html: '<p>Ampersand &amp; angle &lt;brackets&gt;, non-breaking&nbsp;space, emoji 🎉,'
      + ' RTL עברית, and a soft­hyphen.</p>',
    text: 'Ampersand & angle <brackets>, non-breaking space, emoji 🎉,'
      + ' RTL עברית, and a soft­hyphen.',
    expected: ['Ampersand', 'brackets', '🎉'],
  },
  {
    name: 'own-editor-markup',
    html: '<p style="text-align: center"><span style="font-style: italic">Copied</span>'
      + ' from another <span style="font-weight: 700">slide</span></p>'
      + '<ul><li><span class="keep">Bulleted line</span></li></ul>',
    text: 'Copied from another slide\nBulleted line',
    expected: ['Copied from another slide', 'Bulleted line'],
  },
  {
    name: 'whitespace-only',
    html: '<p>   </p><p>&nbsp;</p>',
    text: '   \n \n',
    expected: [],
  },
  {
    name: 'own-editor-rendered-katex',
    html: '<p>Inline <span class="katex"><span class="katex-mathml"><math><semantics>'
      + '<mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow>'
      + '<annotation encoding="application/x-tex">E=mc^2</annotation>'
      + '</semantics></math></span><span class="katex-html" aria-hidden="true">E=mc²</span>'
      + '</span></p><p><span class="katex-display"><span class="katex">'
      + '<span class="katex-mathml"><math><semantics><mrow><mi>x</mi><mo>+</mo><mi>y</mi></mrow>'
      + '<annotation encoding="application/x-tex">x+y</annotation></semantics></math></span>'
      + '<span class="katex-html" aria-hidden="true">x+y</span></span></span></p>',
    text: 'Inline E=mc²\nx+y',
    expected: ['E=mc^2', 'x+y'],
    math: [
      { tex: 'E=mc^2', display: false },
      { tex: 'x+y', display: true },
    ],
  },
];

export type PasteTarget =
  | 'placeholder'
  | 'caret-at-end'
  | 'inside-word'
  | 'over-selection'
  | 'inside-list-item'
  | 'inside-table-cell';

export const PASTE_TARGETS: PasteTarget[] = [
  'placeholder',
  'caret-at-end',
  'inside-word',
  'over-selection',
  'inside-list-item',
  'inside-table-cell',
];

/**
 * What an author does to pasted text once it has landed. Every case runs a
 * seeded sequence of these, and the invariants are checked after each one:
 * pasted markup that only looks fine until it is formatted is the whole point
 * of this suite.
 */
export type PasteOperation =
  | { kind: 'list'; style: 'Bulleted' | 'Numbered' | 'None' }
  | { kind: 'inline'; format: 'bold' | 'italic' | 'underline'; route: 'shortcut' | 'button' }
  | { kind: 'align'; alignment: 'left' | 'center' | 'right' | 'justify' }
  | { kind: 'type'; text: string }
  | { kind: 'delete'; characters: number }
  | { kind: 'delete-word' }
  | { kind: 'split'; text: string }
  /**
   * Undo/redo restoration checkpoint: seal, snapshot the persisted deck, run
   * one sealed typing run (a documented single undo step), seal again, then
   * demand that one Ctrl/Cmd+Z restores the pre-op deck exactly and one
   * Ctrl/Cmd+Shift+Z re-reaches the post-op deck exactly.
   */
  | { kind: 'undo' }
  /** Double-click into the other box (no Escape first), type a nonce, return. */
  | { kind: 'cross-box' }
  /** Escape out of editing, then re-enter the main box. */
  | { kind: 'escape-reenter' };

export const PASTE_OPERATIONS: PasteOperation[] = [
  { kind: 'list', style: 'Bulleted' },
  { kind: 'list', style: 'Numbered' },
  { kind: 'list', style: 'None' },
  { kind: 'inline', format: 'bold', route: 'shortcut' },
  { kind: 'inline', format: 'bold', route: 'button' },
  { kind: 'inline', format: 'italic', route: 'shortcut' },
  { kind: 'inline', format: 'italic', route: 'button' },
  { kind: 'inline', format: 'underline', route: 'shortcut' },
  { kind: 'inline', format: 'underline', route: 'button' },
  { kind: 'align', alignment: 'left' },
  { kind: 'align', alignment: 'center' },
  { kind: 'align', alignment: 'right' },
  { kind: 'align', alignment: 'justify' },
  { kind: 'type', text: ' appended' },
  { kind: 'type', text: ' 42' },
  { kind: 'delete', characters: 3 },
  { kind: 'delete-word' },
  { kind: 'split', text: 'new line' },
  { kind: 'undo' },
  { kind: 'cross-box' },
  { kind: 'escape-reenter' },
];

export function describeOperation(operation: PasteOperation): string {
  switch (operation.kind) {
    case 'list': return `list \u2192 ${operation.style}`;
    case 'inline': return `${operation.format} by ${operation.route}`;
    case 'align': return `align ${operation.alignment}`;
    case 'type': return `type ${JSON.stringify(operation.text)}`;
    case 'delete': return `backspace \u00d7${operation.characters}`;
    case 'delete-word': return 'delete a selected word';
    case 'split': return `Enter then type ${JSON.stringify(operation.text)}`;
    case 'undo': return 'undo/redo restoration checkpoint';
    case 'cross-box': return 'a trip into the other box and back';
    case 'escape-reenter': return 'Escape then re-enter the box';
  }
}

/** The element markup each paste target starts from. */
export const TARGET_FIXTURES: Record<PasteTarget, { html: string; classes: string[] }> = {
  placeholder: { html: '<p>Text</p>', classes: ['role-body', 'placeholder'] },
  'caret-at-end': { html: '<p>Existing first line</p><p>Existing second line</p>', classes: ['role-body'] },
  'inside-word': { html: '<p>Interruption lands midword here</p>', classes: ['role-body'] },
  'over-selection': { html: '<p>Replace selected word entirely</p>', classes: ['role-body'] },
  'inside-list-item': {
    html: '<ul><li>First existing item</li><li>Second existing item</li></ul>',
    classes: ['role-body'],
  },
  'inside-table-cell': {
    html: '<table><tbody><tr><td>Alpha</td><td>Beta</td></tr>'
      + '<tr><td>Gamma</td><td>Delta</td></tr></tbody></table>',
    classes: ['role-body'],
  },
};

export interface PasteCase {
  payload: ClipboardPayload;
  target: PasteTarget;
  operations: PasteOperation[];
}

/** A small, reproducible pseudo-random source. */
function random(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/**
 * Case order: every payload against every target on demand, or a seeded spread
 * that still crosses every payload and every target by default. Each case
 * carries its own seeded sequence of edits to run on the pasted text.
 */
export function pasteCases(options: {
  exhaustive: boolean;
  sample: number;
  operationsPerCase: number;
  seed?: number;
}): PasteCase[] {
  const { exhaustive, sample, operationsPerCase, seed = 20260831 } = options;
  const next = random(seed);
  const sequence = () => Array.from(
    { length: operationsPerCase },
    () => PASTE_OPERATIONS[Math.floor(next() * PASTE_OPERATIONS.length)],
  );
  if (exhaustive) {
    return PASTE_CORPUS.flatMap((payload) => PASTE_TARGETS.map((target) => ({
      payload, target, operations: sequence(),
    })));
  }
  return Array.from({ length: sample }, (_, index) => ({
    payload: PASTE_CORPUS[index % PASTE_CORPUS.length],
    target: PASTE_TARGETS[index % PASTE_TARGETS.length],
    operations: sequence(),
  }));
}

/** Put both clipboard flavours on the real clipboard and press Cmd/Ctrl+V. */
export async function pasteFromClipboard(cdp: Cdp, payload: ClipboardPayload): Promise<void> {
  // On CI's bare Xvfb there is no window manager to keep the page focused.
  // Clipboard API calls are evaluated with a user gesture, but Chromium's
  // native paste command still requires the target page to be foregrounded.
  await cdp.call('Page.bringToFront');
  await cdp.evaluate('window.focus()');
  const written = await cdp.evaluate<string>(`(async () => {
    try {
      const items = { 'text/plain': new Blob([${JSON.stringify(payload.text)}], { type: 'text/plain' }) };
      ${payload.html === undefined ? '' : `items['text/html'] = new Blob([${JSON.stringify(payload.html)}], { type: 'text/html' });`}
      await navigator.clipboard.write([new ClipboardItem(items)]);
      return 'ok';
    } catch (error) {
      return String(error);
    }
  })()`);
  if (written !== 'ok') throw new Error(`could not write the clipboard: ${written}`);
  // `navigator.clipboard.write` resolving is not the same as the system
  // clipboard being ready to serve what it was handed. On X11 ownership of
  // the selection changes asynchronously, so a paste chord sent immediately
  // after can still deliver the *previous* payload — which reads as "pasted
  // text never appeared" against the case that just wrote. Wait for the
  // clipboard to read back what we put there before pressing paste.
  await clipboardHolds(cdp, payload.text);
  await cdp.chord('v', 'KeyV', 86, PASTE_MOD, ['paste']);
}

/**
 * Block until the clipboard reports the text just written. If reads are not
 * permitted, allow a longer fixed settle before the native paste instead.
 *
 * Reading the clipboard needs a permission this session may not have; a
 * refusal is not a reason to fail a paste test, so an unreadable clipboard
 * falls back to a short settle instead. The barrier only ever costs time on
 * platforms that need it.
 */
async function clipboardHolds(cdp: Cdp, text: string): Promise<void> {
  const wanted = settleText(text);
  const read = () => cdp.evaluate<string>(
    `navigator.clipboard.readText().then((value) => value, (error) => 'clipboard-read-failed: ' + error)`,
  );
  const first = await read();
  if (first.startsWith('clipboard-read-failed:')) {
    // Some Chromium configurations allow writes but refuse reads. We cannot
    // prove readiness there, so give X11's clipboard owner hand-off a
    // conservative settle rather than treating the refusal itself as proof
    // that the requested payload is ready.
    await wait(250);
    return;
  }
  await eventually(
    read,
    'the clipboard never reported the payload that was just written to it',
    (value) => !value.startsWith('clipboard-read-failed:') && settleText(value) === wanted,
    5_000,
  );
  await wait(50);
}

/** Compare clipboard text the way a round trip may reformat it. */
function settleText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

/**
 * Structural and safety rules the box must satisfy after any paste or edit.
 * These are the shapes the renderer, the block model and the exporters assume;
 * markup that breaks them is what makes a pasted list impossible to convert,
 * or a paragraph impossible to align.
 */
export const MARKUP_INVARIANTS = `(root) => {
  const problems = [];
  const check = (selector, message) => {
    if (root.querySelector(selector)) problems.push(message);
  };
  check(':is(ul, ol) > :is(ul, ol)', 'a list is nested directly inside a list');
  check('p :is(ul, ol)', 'a list is inside a paragraph');
  check('p > p, p > div, li > li, p > table', 'a block is nested inside a block that cannot contain it');
  check('script, iframe, object, embed, style, link, meta, base, form, input', 'unsafe or document-level markup survived');
  check('font, marquee', 'legacy markup survived');
  check('.katex, .katex-display, math, annotation', 'generated KaTeX markup survived');
  for (const node of root.querySelectorAll('li')) {
    const parent = node.parentElement;
    if (!parent || !/^(UL|OL)$/.test(parent.tagName)) problems.push('a list item is outside a list');
  }
  for (const node of root.querySelectorAll('*')) {
    for (const attribute of node.attributes) {
      if (/^on/i.test(attribute.name)) problems.push('event handler attribute ' + attribute.name);
      if (/^\\s*javascript:/i.test(attribute.value)) problems.push('javascript: url survived');
    }
  }
  for (const child of root.children) {
    if (!/^(P|UL|OL|TABLE|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE)$/.test(child.tagName)) {
      problems.push('top-level ' + child.tagName + ' is not a block the editor can format');
    }
  }
  // The box is white-space: pre-wrap, so whitespace that a web page would
  // collapse paints here. Between items and blocks it is a blank line.
  const isBlock = (node) => node && node.nodeType === 1
    && /^(P|DIV|UL|OL|LI|TABLE|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE)$/.test(node.tagName);
  // A newline at the edge of a run is only stray whitespace when nothing but
  // a block edge or a <br> sits beside it there: a soft break the author
  // typed (Chromium writes shift-return as "\\n" in a pre-wrap box) legitimately
  // ends one inline run and starts the next once a word beside it is formatted.
  const neighbour = (text, side) => {
    let node = text;
    while (node && node !== root && !isBlock(node)) {
      const sibling = side === 'previous' ? node.previousSibling : node.nextSibling;
      if (sibling) return sibling;
      node = node.parentNode;
    }
    return null;
  };
  const hardEdge = (node) => node === null || isBlock(node)
    || (node.nodeType === 1 && node.tagName === 'BR');
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const parent = text.parentNode;
    const inPre = parent && parent.closest && parent.closest('pre');
    const startsWithNewline = /^[ \\t\\r]*\\n/.test(text.data) && hardEdge(neighbour(text, 'previous'));
    const endsWithNewline = /\\n[ \\t\\r]*$/.test(text.data) && hardEdge(neighbour(text, 'next'));
    if (!inPre && (startsWithNewline || endsWithNewline)) {
      problems.push('a text run starts or ends with a newline, which paints as a line break: '
        + JSON.stringify(text.data) + ' in ' + (parent ? parent.tagName.toLowerCase() : '?'));
    }
    if (!/^[ \\t\\r\\n]*$/.test(text.data) || !text.data) continue;
    if (parent && /^(UL|OL)$/.test(parent.tagName)) problems.push('whitespace text directly inside a list');
    else if (isBlock(text.previousSibling) || isBlock(text.nextSibling)) {
      problems.push('whitespace text between blocks');
    }
  }
  // A copied run wears the computed layout of the block it came from; on an
  // inline run those declarations are junk, and on a block they fight the
  // box's paragraph spacing and indentation.
  for (const node of root.querySelectorAll('[style]')) {
    if (node.matches('img, video, svg, table, colgroup, col, td, th')) continue;
    for (const property of ['text-indent', 'line-height', 'white-space', 'margin', 'margin-top',
      'margin-bottom', 'margin-left', 'margin-right', 'display', 'float']) {
      if (node.style.getPropertyValue(property)) {
        problems.push('pasted layout declaration ' + property + ' survived on ' + node.tagName.toLowerCase());
      }
    }
  }
  return [...new Set(problems)];
}`;

export async function markupProblems(cdp: Cdp, selector: string): Promise<string[]> {
  return cdp.evaluate<string[]>(`(() => {
    const check = ${MARKUP_INVARIANTS};
    const root = document.querySelector(${JSON.stringify(selector)});
    return root ? check(root) : ['the text box is gone'];
  })()`);
}

/** The same rules applied to the markup the collaboration server persisted. */
export async function persistedMarkupProblems(cdp: Cdp, html: string): Promise<string[]> {
  return cdp.evaluate<string[]>(`(() => {
    const check = ${MARKUP_INVARIANTS};
    const template = document.createElement('template');
    template.innerHTML = ${JSON.stringify(html)};
    const root = document.createElement('div');
    root.append(...template.content.childNodes);
    return check(root);
  })()`);
}

/** Collapse a *text* value for comparison — never used on markup, because
 * pasted prose legitimately contains characters like `<brackets>`. */
export function normalizeText(value: string): string {
  return value
    .replaceAll('\u2060', '')
    .replaceAll('\u00a0', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Strip markup, then collapse. Only for HTML strings. */
export function visibleText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('⁠', '')
    .replaceAll(' ', ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The box's text as a reader sees it: `innerText`, so a block boundary is a
 * line break rather than nothing. `textContent` ran two items together
 * ("0);if") unless stray whitespace happened to sit between them, so the
 * words oracle blamed a list conversion for dropping a code block's trailing
 * newline — a newline that had painted as a blank line and had to go.
 */
export async function contentText(cdp: Cdp, selector: string): Promise<string> {
  return normalizeText(await cdp.evaluate<string>(
    `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`,
  ));
}

export async function enterEditing(cdp: Cdp, selector: string): Promise<void> {
  await cdp.doubleClickText(selector, 'text box');
  try {
    await eventually(async () => cdp.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(selector)})?.isContentEditable === true`,
    ), 'the text box did not enter editing');
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n`
      + `canvas state: ${await textEditingState(cdp, selector)}`);
  }
}

/* ------------------------------------------------------------------------ *
 * The undo-restoration oracle's state: the whole persisted deck, element by
 * element, with html normalised the way test/support/undoRestorationSession.ts
 * normalises it (word joiners stripped, markup round-tripped through the
 * browser's parser so attribute order and entity encoding are canonical).
 * ------------------------------------------------------------------------ */

export type DeckSnapshot = Record<string, string>;

const NORMALIZE_HTMLS = `(htmls) => htmls.map((html) => {
  const template = document.createElement('template');
  template.innerHTML = String(html).replaceAll('\\u2060', '');
  return template.innerHTML;
})`;

export async function deckSnapshot(cdp: Cdp, port: number, deckId: string): Promise<DeckSnapshot> {
  const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${deckId}`);
  const deck = await response.json() as {
    slides: Array<{ elements: Array<Record<string, unknown>> }>;
  };
  const elements = deck.slides.flatMap((slide, index) =>
    slide.elements.map((element) => ({ slide: index, element })));
  const htmls = elements.map(({ element }) =>
    'html' in element ? String(element.html) : '');
  const normalized = await cdp.evaluate<string[]>(
    `(${NORMALIZE_HTMLS})(${JSON.stringify(htmls)})`);
  const snapshot: DeckSnapshot = { '#slides': String(deck.slides.length) };
  elements.forEach(({ slide, element }, index) => {
    snapshot[`${slide}:${String(element.id)}`] = JSON.stringify({ ...element, html: normalized[index] });
  });
  return snapshot;
}

export function sameDeckSnapshot(a: DeckSnapshot, b: DeckSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A readable element-by-element diff of two snapshots, for failure messages. */
export function diffDeckSnapshots(expected: DeckSnapshot, observed: DeckSnapshot): string {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(observed)])].sort();
  const lines: string[] = [];
  for (const key of keys) {
    if (expected[key] === observed[key]) continue;
    lines.push(`  ${key}:`);
    lines.push(`    expected: ${expected[key] ?? '(absent)'}`);
    lines.push(`    observed: ${observed[key] ?? '(absent)'}`);
  }
  return lines.length > 0 ? lines.join('\n') : '  (identical)';
}

/** Poll until two consecutive persisted snapshots agree, then return one. */
export async function settledDeckSnapshot(
  cdp: Cdp,
  port: number,
  deckId: string,
  label: string,
): Promise<DeckSnapshot> {
  const deadline = Date.now() + 12_000;
  let previous = await deckSnapshot(cdp, port, deckId);
  while (Date.now() < deadline) {
    await wait(300);
    const current = await deckSnapshot(cdp, port, deckId);
    if (sameDeckSnapshot(current, previous)) return current;
    previous = current;
  }
  throw new Error(`${label}: the persisted deck never settled`);
}

/** Poll the persisted deck until it matches `expected` or the timeout passes. */
export async function deckSnapshotEventually(
  cdp: Cdp,
  port: number,
  deckId: string,
  expected: DeckSnapshot,
  timeoutMs = 8_000,
): Promise<DeckSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let observed = await deckSnapshot(cdp, port, deckId);
  while (!sameDeckSnapshot(observed, expected) && Date.now() < deadline) {
    await wait(250);
    observed = await deckSnapshot(cdp, port, deckId);
  }
  return observed;
}

/**
 * The selection/focus/editing invariants, evaluated inside the page.
 *
 * Sync by copy from test/support/selectionSession.ts (that module does not
 * export the string; test/support/crossContextSession.ts carries the same
 * copy under the same convention). Each returned string is one violation,
 * phrased as the thing an author would see.
 */
export const SELECTION_INVARIANTS = `() => {
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

  // --- the selection itself -------------------------------------------------
  for (const id of selection) {
    if (!ids.has(id)) problems.push('selected ' + id + ' is not on the current slide');
  }
  if (new Set(selection).size !== selection.length) {
    problems.push('the selection lists an object twice: ' + show(selection));
  }

  // --- editing implies being the selection ---------------------------------
  if (editing !== null) {
    if (!ids.has(editing)) {
      problems.push('editing ' + editing + ', which is not on the current slide');
    }
    if (selection.length !== 1 || selection[0] !== editing) {
      problems.push('editing ' + editing + ' while the selection is ' + show(selection));
    }
  }

  // --- one editable node, and it is the one being edited --------------------
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

  // --- where the keyboard points -------------------------------------------
  const active = document.activeElement;
  const activeElementId = active && active.closest
    ? active.closest('[data-element-id]')?.getAttribute('data-element-id') ?? null
    : null;
  if (editing !== null && active && layer.contains(active) && activeElementId !== editing) {
    problems.push('focus sits in ' + (activeElementId ?? 'the canvas')
      + ' while ' + editing + ' is being edited');
  }

  // --- the caret / text highlight ------------------------------------------
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

  // --- the table cell range -------------------------------------------------
  const highlighted = [...layer.querySelectorAll('.editor-table-selected')];
  const highlightOwners = [...new Set(highlighted.map((cell) =>
    cell.closest('[data-element-id]')?.getAttribute('data-element-id') ?? '(unnamed)'))];
  if (table === null) {
    if (highlighted.length > 0) {
      problems.push(highlighted.length + ' table cells stay highlighted in '
        + show(highlightOwners) + ' with no cell range selected');
    }
  } else {
    if (table.elementId !== editing) {
      problems.push('a table cell range is live in ' + table.elementId
        + ' while the edit session is on ' + (editing ?? 'nothing'));
    }
    if (!selection.includes(table.elementId)) {
      problems.push('cells of ' + table.elementId + ' are selected but the table is not: '
        + 'the selection is ' + show(selection));
    }
    const element = (slide ? slide.elements : []).find((el) => el.id === table.elementId);
    if (!element) problems.push('cells are selected in ' + table.elementId + ', which is gone');
    else if (element.type !== 'text' || (!element.table && !element.html.includes('<table'))) {
      // Native tables and tables embedded in ordinary text boxes (the paste
      // path inserts <table> blocks) both take cell selections legitimately.
      problems.push('cells are selected in ' + table.elementId + ', which holds no table');
    }
    if (highlightOwners.length > 1 || (highlightOwners[0] && highlightOwners[0] !== table.elementId)) {
      problems.push('highlighted cells are in ' + show(highlightOwners)
        + ' but the cell range belongs to ' + table.elementId);
    }
    const expectedCells = (Math.abs(table.rowEnd - table.row) + 1)
      * (Math.abs(table.columnEnd - table.column) + 1);
    if (highlighted.length !== expectedCells) {
      problems.push('the cell range covers ' + expectedCells + ' cells but '
        + highlighted.length + ' are highlighted');
    }
  }

  // --- overlay chrome matches the selection --------------------------------
  const expectedOutlines = (slide ? slide.elements : [])
    .filter((el) => state.selection.has(el.id) && !el.layoutMasterId).length;
  const outlines = overlay.querySelectorAll('.sel-box').length;
  if (outlines !== expectedOutlines) {
    problems.push('the overlay draws ' + outlines + ' selection outlines for '
      + expectedOutlines + ' selected objects');
  }

  // --- slides and objects are exclusive selections --------------------------
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

/**
 * Invariant violations that survive a short settle window: the rail and the
 * overlay redraw from store events, so reading one frame too early would
 * report a repaint in progress as a broken invariant.
 */
export async function selectionProblems(cdp: Cdp): Promise<string[]> {
  const first = await cdp.evaluate<string[]>(`(${SELECTION_INVARIANTS})()`);
  if (first.length === 0) return first;
  await wait(200);
  const second = await cdp.evaluate<string[]>(`(${SELECTION_INVARIANTS})()`);
  return second.filter((problem) => first.includes(problem));
}

export async function tagListField(cdp: Cdp): Promise<string> {
  const found = await cdp.evaluate<boolean>(`(() => {
    const field = [...document.querySelectorAll('${PASTE_PANEL} label.field')]
      .find((node) => node.querySelector('span')?.textContent === 'List');
    const select = field?.querySelector('select');
    if (!select) return false;
    select.id = 'paste-fuzz-list-field';
    return true;
  })()`);
  expect(found, 'the inspector List control is missing').toBe(true);
  return '#paste-fuzz-list-field';
}
