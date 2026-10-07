import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck } from '../src/shared/deck.js';
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
import {
  contentText,
  enterEditing,
  normalizeText,
  pasteFromClipboard,
  PASTE_MOD as MOD,
  type ClipboardPayload,
} from './support/pasteMarkupCorpus.js';

/**
 * Targeted paste-pipeline state bugs, each hypothesised by a code review of
 * the paste path (canvas.ts repairPastedMarkup / authoredTextHtml,
 * htmlSafety.ts sanitizePastedTextHtml, textFormatting.ts
 * wholeTextFormatState). Every test drives the production browser with the
 * real clipboard and real keystrokes; a FAILING test is a confirmed bug.
 */

const DECK_ID = 'paste-state-bugs';
const TEXT_ID = 'paste-state-text';
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
const CONTAINER = `#canvas [data-element-id="${TEXT_ID}"]`;

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let cdp: Cdp | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  workDir = await mkdtemp(join(tmpdir(), 'paste-state-bugs-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, DECK_ID);
  const clientDir = await collabClientDir();
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  const deck = emptyDeck('Paste state bugs');
  deck.themePreset = 'basic';
  deck.slides[0].elements.push({
    id: TEXT_ID,
    type: 'text',
    x: 100, y: 100, w: 1720, h: 820,
    rot: 0, z: 1, opacity: 1,
    class: ['role-body'],
    style: {},
    html: '<p>Text</p>',
    align: 'left',
    valign: 'top',
  } as never);
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 28px/1.35 sans-serif; }',
    '',
  ].join('\n'), 'utf8');

  server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
  browser = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Paste%20Bugs`, profileDir,
  );
  const target = await findTarget(
    browser.debugPort,
    (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
    browser.log,
  );
  cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => cdp!.evaluate<boolean>(`(
    document.getElementById('status')?.textContent?.includes('connected as Paste Bugs') === true
    && Boolean(document.querySelector('${CONTENT}'))
  )`), 'the browser did not finish connecting');
}, 300_000);

afterAll(async () => {
  cdp?.close();
  cdp = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/** Fixture setup only; all interactions under test are real input. */
async function resetBox(html: string): Promise<void> {
  if (await cdp!.evaluate<boolean>(
    `document.querySelector('${CONTENT}')?.isContentEditable === true`,
  )) {
    await cdp!.click(CONTENT, 'the text box before leaving editing');
    await cdp!.key('Escape', 27);
    await eventually(async () => cdp!.evaluate<boolean>(
      `document.querySelector('${CONTENT}')?.isContentEditable !== true`,
    ), 'Escape did not leave text editing');
  }
  await cdp!.evaluate(`(() => {
    const store = window.store;
    store.commit((deck) => {
      const element = deck.slides[0].elements.find((candidate) => candidate.id === ${JSON.stringify(TEXT_ID)});
      element.html = ${JSON.stringify(html)};
      element.class = ['role-body'];
      element.style = {};
      element.align = 'left';
      delete element.table;
    }, { label: 'Paste-state fixture' });
    return true;
  })()`);
  await eventually(async () => cdp!.evaluate<boolean>(
    `document.querySelector('${CONTENT}')?.innerHTML === ${JSON.stringify(html)}`,
  ), `the fixture markup did not render: ${html}`);
}

/** The element html the editor has committed to the deck. */
async function committedHtml(): Promise<string> {
  return cdp!.evaluate<string>(`(() => {
    const element = window.store.get().deck.slides[0].elements
      .find((candidate) => candidate.id === ${JSON.stringify(TEXT_ID)});
    return element ? element.html : '';
  })()`);
}

/** Leave editing with Escape, which commits ("done editing"). */
async function commitByEscape(): Promise<void> {
  await cdp!.key('Escape', 27);
  await eventually(async () => cdp!.evaluate<boolean>(
    `document.querySelector('${CONTENT}')?.isContentEditable !== true`,
  ), 'Escape did not leave text editing');
}

/** Raw flattened text of the live box, with caret sentinels removed. */
async function flatText(): Promise<string> {
  return cdp!.evaluate<string>(
    `(document.querySelector('${CONTENT}')?.textContent ?? '').replaceAll('\\u2060', '')`,
  );
}

/** Select a unique word with real pointer clicks over its glyphs. */
async function selectWord(word: string): Promise<void> {
  const text = await flatText();
  const start = text.indexOf(word);
  expect(start, `the box no longer contains ${JSON.stringify(word)}: ${text}`)
    .toBeGreaterThanOrEqual(0);
  await cdp!.selectTextRange(CONTENT, start, start + word.length, word);
}

/** Place the caret at the very end of the block containing `word`. */
async function caretAtEndOfBlockWith(word: string): Promise<void> {
  const offset = await cdp!.evaluate<number>(`(() => {
    const raw = document.querySelector('${CONTENT}')?.textContent ?? '';
    const index = raw.indexOf(${JSON.stringify(word)});
    return index < 0 ? -1 : index + ${JSON.stringify(word.length)} - 1;
  })()`);
  expect(offset, `no rendered ${JSON.stringify(word)} to click`).toBeGreaterThanOrEqual(0);
  await cdp!.clickTextAtOffset(CONTENT, offset, `last character of ${JSON.stringify(word)}`);
  await cdp!.key('End', 35);
}

async function selectAll(): Promise<void> {
  await cdp!.chord('a', 'KeyA', 65, MOD, ['selectAll']);
}

async function formatChord(letter: 'b' | 'i' | 'u'): Promise<void> {
  await cdp!.chord(letter, `Key${letter.toUpperCase()}`, letter.toUpperCase().charCodeAt(0), MOD);
}

/** A real Shift+Enter: the soft-line-break keystroke. */
async function shiftEnter(): Promise<void> {
  const key = {
    key: 'Enter', code: 'Enter', modifiers: 8,
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  };
  await cdp!.call('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key });
  await cdp!.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

async function pasteAndWaitFor(payload: ClipboardPayload, fragment: string, copies = 1): Promise<void> {
  await pasteFromClipboard(cdp!, payload);
  await eventually(async () => contentText(cdp!, CONTENT),
    `pasted text never appeared (${fragment})`,
    (text) => text.split(normalizeText(fragment)).length - 1 >= copies);
}

/** Per-block flat text of an html string, using the browser's parser. */
async function blockTextsOf(html: string): Promise<string[]> {
  return cdp!.evaluate<string[]>(`(() => {
    const template = document.createElement('template');
    template.innerHTML = ${JSON.stringify(html)};
    return [...template.content.children].map((child) => child.textContent ?? '');
  })()`);
}

/** outerHTML of every top-level block in the live editing DOM. */
async function liveBlocks(): Promise<string[]> {
  return cdp!.evaluate<string[]>(
    `[...document.querySelector('${CONTENT}').children].map((child) => child.outerHTML)`,
  );
}

/** Rendered state of the text node containing `word` in the live box. */
async function wordRendering(word: string): Promise<{
  fontWeight: string;
  ancestorTags: string[];
  spanDepth: number;
  boldTagWithLightSpan: boolean;
}> {
  return cdp!.evaluate(`(() => {
    const root = document.querySelector('${CONTENT}');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.data.includes(${JSON.stringify(word)})) continue;
      const ancestorTags = [];
      let spanDepth = 0;
      let boldTagWithLightSpan = false;
      for (let parent = node.parentElement; parent && parent !== root; parent = parent.parentElement) {
        ancestorTags.push(parent.tagName);
        if (parent.tagName === 'SPAN') spanDepth += 1;
        if (/^(B|STRONG)$/.test(parent.tagName)) {
          const inner = node.parentElement === parent ? null : node.parentElement;
          if (inner && Number.parseInt(getComputedStyle(inner).fontWeight, 10) < 600) {
            boldTagWithLightSpan = true;
          }
        }
      }
      return {
        fontWeight: getComputedStyle(node.parentElement).fontWeight,
        ancestorTags,
        spanDepth,
        boldTagWithLightSpan,
      };
    }
    return { fontWeight: 'missing', ancestorTags: [], spanDepth: -1, boldTagWithLightSpan: false };
  })()`);
}

async function nodeCount(): Promise<number> {
  return cdp!.evaluate<number>(
    `document.querySelector('${CONTENT}').querySelectorAll('*').length`,
  );
}

describe.skipIf(!electronBinary)('paste pipeline state bugs', () => {
  it('H1: an authored soft break survives pasting elsewhere in the box', { timeout: 120_000 }, async () => {
    await resetBox('<p>Text</p>');
    await enterEditing(cdp!, CONTENT);
    await selectAll();
    await cdp!.typeKeys('line one');
    await shiftEnter();
    await cdp!.typeKeys('line two');
    await commitByEscape();

    // Soundness control: the soft break must have been committed as one.
    // (In this box white-space is pre-wrap, so Chromium writes Shift+Enter as
    // a literal "\n" rather than a <br>; both are soft breaks.)
    const authored = await committedHtml();
    const authoredBlocks = await blockTextsOf(authored);
    const together = (blocks: string[]) =>
      blocks.some((text) => text.includes('line one') && text.includes('line two'));
    const softBreak = (html: string) => html.includes('<br>') || /line one\n/.test(html);
    expect(
      together(authoredBlocks) && softBreak(authored),
      `control failed: Shift+Enter did not commit a soft break — ${JSON.stringify(authored)}`,
    ).toBe(true);

    // Re-enter and paste a small rich payload at the very end.
    await enterEditing(cdp!, CONTENT);
    await caretAtEndOfBlockWith('line two');
    await pasteAndWaitFor(
      { name: 'small-rich', html: '<b>tail</b> <i>rich</i>', text: 'tail rich', expected: ['tail'] },
      'tail',
    );
    await commitByEscape();

    const after = await committedHtml();
    const afterBlocks = await blockTextsOf(after);
    // Hypothesised: repairPastedMarkup rewrites the whole box with
    // splitBreaks=true, promoting the soft break into separate paragraphs.
    // Observed: NOT reproduced — collectParagraphs only splits <br>s that are
    // top-level or inside attribute-less <div>s; a soft break inside an
    // authored <p> block is passed through untouched.
    expect(
      together(afterBlocks) && softBreak(after),
      `the typed soft break was promoted to separate blocks — ${JSON.stringify(after)}`,
    ).toBe(true);

    // Same scenario with the soft break authored as a literal <br> — the
    // exact markup the exit serializer preserves (splitBreaks=false) but the
    // paste-time repair splits (splitBreaks=true).
    await resetBox('<p>line one<br>line two</p>');
    await enterEditing(cdp!, CONTENT);
    await caretAtEndOfBlockWith('line two');
    await pasteAndWaitFor(
      { name: 'small-rich-2', html: '<b>more</b> <i>markup</i>', text: 'more markup', expected: ['more'] },
      'more',
    );
    await commitByEscape();
    const afterBr = await committedHtml();
    const afterBrBlocks = await blockTextsOf(afterBr);
    expect(
      together(afterBrBlocks) && afterBr.includes('<br>'),
      `the authored <br> soft break was promoted to separate blocks — ${JSON.stringify(afterBr)}`,
    ).toBe(true);
  });

  it('H2: paragraphs the paste never touched stay byte-identical', { timeout: 120_000 }, async () => {
    await resetBox([
      '<p>Alpha plain paragraph</p>',
      '<p><span style="font-weight: 700">Beta bold</span> mixed</p>',
      '<ul><li>Gamma item one</li><li>Delta item two</li></ul>',
      '<p>Omega last</p>',
    ].join(''));
    await enterEditing(cdp!, CONTENT);
    const baseline = await liveBlocks();
    expect(baseline.length, 'fixture should render four blocks').toBe(4);

    // Soundness control: with no paste, the blocks do not drift on their own.
    await wait(300);
    expect(await liveBlocks(), 'control failed: blocks drift without a paste').toEqual(baseline);

    await caretAtEndOfBlockWith('Omega last');
    await pasteAndWaitFor(
      {
        name: 'rich-tail',
        html: '<p><span style="font-style: italic">pasted</span> extra</p>',
        text: 'pasted extra',
        expected: ['pasted'],
      },
      'pasted',
    );
    const after = await liveBlocks();
    // BUG (hypothesised): the whole-box repair renormalizes markup the paste
    // never touched. Only the final block (the insertion point) may change.
    expect(
      after.slice(0, baseline.length - 1),
      'untouched paragraphs were rewritten by the paste',
    ).toEqual(baseline.slice(0, baseline.length - 1));
  });

  it('H3: pasted <strong> can be genuinely unbolded without contradictory layers', { timeout: 120_000 }, async () => {
    await resetBox('<p>Text</p>');
    await enterEditing(cdp!, CONTENT);
    await selectAll();
    await pasteAndWaitFor(
      {
        name: 'strong-word',
        html: '<p>The <strong>Foo</strong> word</p>',
        text: 'The Foo word',
        expected: ['Foo'],
      },
      'The Foo word',
    );

    // Soundness control: the pasted strong renders bold before we touch it.
    const before = await wordRendering('Foo');
    expect(
      Number.parseInt(before.fontWeight, 10),
      `control failed: pasted <strong>Foo</strong> is not rendered bold (${JSON.stringify(before)})`,
    ).toBeGreaterThanOrEqual(600);

    await selectWord('Foo');
    await formatChord('b'); // unbold: the selection state reads the <strong>
    await wait(150);

    const unbolded = await wordRendering('Foo');
    expect(
      Number.parseInt(unbolded.fontWeight, 10),
      `Cmd+B did not unbold the pasted <strong> text (${JSON.stringify(unbolded)})`,
    ).toBeLessThan(600);
    // BUG: the formatting writer only emits style-only spans, so unbolding
    // pasted <strong> leaves the contradictory layering
    // <strong><span style="font-weight:400">Foo</span></strong> — observed
    // ancestor chain SPAN > STRONG > P.
    expect.soft(
      unbolded.boldTagWithLightSpan,
      `contradictory markup: a <b>/<strong> ancestor is being cancelled by an inner light span (${unbolded.ancestorTags.join(' > ')})`,
    ).toBe(false);
    expect.soft(
      unbolded.ancestorTags.filter((tag) => tag === 'B' || tag === 'STRONG'),
      'the <strong> wrapper should be gone once the text is unbolded',
    ).toEqual([]);

    // Toggling further must not grow the DOM without bound.
    for (let toggle = 0; toggle < 4; toggle += 1) {
      await selectWord('Foo');
      await formatChord('b');
      await wait(120);
    }
    const settled = await wordRendering('Foo');
    expect(
      settled.spanDepth,
      `span nesting around "Foo" grew unbounded: ${settled.ancestorTags.join(' > ')}`,
    ).toBeLessThanOrEqual(3);
  });

  it('H4: formatting over a classed span stays bounded', { timeout: 180_000 }, async () => {
    await resetBox('<p>Text</p>');
    await enterEditing(cdp!, CONTENT);
    await selectAll();
    await pasteAndWaitFor(
      {
        name: 'classed-span',
        html: '<p>alpha <span class="s1">classy</span> omega</p>',
        text: 'alpha classy omega',
        expected: ['classy'],
      },
      'alpha classy omega',
    );

    const baseline = await wordRendering('classy');
    const baselineNodes = await nodeCount();
    expect(baseline.spanDepth, 'control failed: the classy text is missing').toBeGreaterThanOrEqual(0);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      for (const letter of ['b', 'b', 'i', 'i'] as const) {
        await selectWord('classy');
        await formatChord(letter);
        await wait(120);
      }
    }

    const after = await wordRendering('classy');
    const afterNodes = await nodeCount();
    // BUG (hypothesised): normalizeInlineStyleSpans skips spans that carry a
    // class, so repeated toggles nest new spans inside/around it forever.
    expect(
      after.spanDepth,
      `span depth around "classy" grew from ${baseline.spanDepth} to ${after.spanDepth}: ${after.ancestorTags.join(' > ')}`,
    ).toBeLessThanOrEqual(baseline.spanDepth + 2);
    expect(
      afterNodes,
      `element count grew from ${baselineNodes} to ${afterNodes} across 5 format cycles`,
    ).toBeLessThanOrEqual(baselineNodes + 6);
  });

  it('H5: Cmd+B on a selected box of pasted <strong> text unbolds it', { timeout: 120_000 }, async () => {
    await resetBox('<p>Text</p>');
    await enterEditing(cdp!, CONTENT);
    await selectAll();
    await pasteAndWaitFor(
      {
        name: 'all-strong',
        html: '<p><strong>Solid bold words</strong></p>',
        text: 'Solid bold words',
        expected: ['Solid bold words'],
      },
      'Solid bold words',
    );
    await commitByEscape();

    // Soundness control: the committed box renders bold.
    const before = await wordRendering('Solid');
    expect(
      Number.parseInt(before.fontWeight, 10),
      `control failed: the committed box is not rendered bold (${JSON.stringify(before)})`,
    ).toBeGreaterThanOrEqual(600);

    // Element selection (not text editing), then the whole-box shortcut.
    // A click on the still-selected element re-enters editing, so first
    // deselect by clicking empty canvas below the box.
    await cdp!.clickWithin('#canvas .slide', 0.5, 0.95, 'empty slide area');
    await cdp!.click(CONTAINER, 'the text element');
    await eventually(async () => cdp!.evaluate<boolean>(`(
      document.querySelector('${CONTENT}')?.isContentEditable !== true
      && window.store.selectedElements().some((element) => element.id === ${JSON.stringify(TEXT_ID)})
    )`), 'clicking the element did not select it (without editing)');
    await formatChord('b');
    await wait(200);

    const after = await wordRendering('Solid');
    const style = await cdp!.evaluate<Record<string, string>>(`(() => {
      const element = window.store.get().deck.slides[0].elements
        .find((candidate) => candidate.id === ${JSON.stringify(TEXT_ID)});
      return element ? element.style : {};
    })()`);
    // BUG: wholeTextFormatState reads only element.style, so a box whose
    // boldness lives in its html (pasted <strong>) reads as "not bold" and
    // Cmd+B applies bold instead of removing it — observed: element.style
    // becomes {"font-weight":"700"} and the text stays computed 700.
    expect(
      Number.parseInt(after.fontWeight, 10),
      `Cmd+B on the bold box did not unbold it (computed ${after.fontWeight}, element.style ${JSON.stringify(style)})`,
    ).toBeLessThan(600);
  });

  it('H6: typing right after pasting sanitized content lands at the paste point', { timeout: 120_000 }, async () => {
    await resetBox('<p>Existing start</p>');
    await enterEditing(cdp!, CONTENT);
    await caretAtEndOfBlockWith('Existing start');
    await pasteAndWaitFor(
      {
        name: 'sanitized-img',
        html: 'before<img src="https://example.com/x.png">after',
        text: 'before after',
        expected: ['before', 'after'],
      },
      'after',
    );
    await cdp!.typeKeys('XYZ');
    const text = await flatText();
    // BUG (hypothesised): the caret is restored through flattened offsets of a
    // DOM the sanitizer then rewrites, so the next keystrokes land elsewhere.
    expect(
      text.includes('afterXYZ'),
      `typed text landed away from the paste point: ${JSON.stringify(text)}`,
    ).toBe(true);
    expect(text.split('XYZ').length - 1, `typed text duplicated: ${JSON.stringify(text)}`).toBe(1);
  });

  it('H7: a Word pseudo-list paste leaves no marker glyphs, mso styles or conditional comments', { timeout: 120_000 }, async () => {
    await resetBox('<p>Text</p>');
    await enterEditing(cdp!, CONTENT);
    await selectAll();
    await pasteAndWaitFor(
      {
        name: 'word-pseudo-list',
        html: '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>'
          + '<!-- p.MsoListParagraph { margin: 0 } --></style></head><body>'
          + '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1">'
          + '<!--[if !supportLists]--><span style="mso-list:Ignore">·<span>&nbsp;&nbsp;</span>'
          + '</span><!--[endif]-->Item text<o:p></o:p></p></body></html>',
        text: '·\tItem text',
        expected: ['Item text'],
      },
      'Item text',
    );
    await commitByEscape();
    const committed = await committedHtml();
    expect(committed, 'control failed: the pasted words are gone').toContain('Item text');
    // BUG: sanitizePastedTextHtml is a blacklist, so Word's fake bullet glyph
    // survives into the committed markup (Chromium's own clipboard
    // sanitization strips the conditional comments and mso-* style values,
    // but the "·" text, the MsoListParagraph class and <o:p> all remain) —
    // observed: <p class="MsoListParagraph" style="...">·&nbsp;&nbsp;Item
    // text<o:p></o:p></p>.
    expect.soft(committed.includes('·'), `the literal "·" bullet glyph survived — ${committed}`).toBe(false);
    expect.soft(/mso-/i.test(committed), `mso-* styles survived — ${committed}`).toBe(false);
    expect.soft(/supportLists|<!--/.test(committed), `conditional comments survived — ${committed}`).toBe(false);
  });

  it('H8: a second paste does not rewrite the first pasted region', { timeout: 120_000 }, async () => {
    await resetBox('<p>First anchor paragraph</p><p>Second middle paragraph</p><p>Third tail paragraph</p>');
    await enterEditing(cdp!, CONTENT);
    const payload: ClipboardPayload = {
      name: 'repeat-paste',
      html: '<span style="font-weight:700">Alpha</span> beta',
      text: 'Alpha beta',
      expected: ['Alpha beta'],
    };

    await caretAtEndOfBlockWith('First anchor paragraph');
    await pasteAndWaitFor(payload, 'Alpha beta', 1);
    const firstRegion = await cdp!.evaluate<string>(`(() => {
      const blocks = [...document.querySelector('${CONTENT}').children];
      const block = blocks.find((child) => (child.textContent ?? '').includes('Alpha'));
      return block ? block.outerHTML : '';
    })()`);
    expect(firstRegion, 'control failed: the first paste landed in no block').not.toBe('');

    await caretAtEndOfBlockWith('Third tail paragraph');
    await pasteAndWaitFor(payload, 'Alpha beta', 2);
    const firstRegionAfter = await cdp!.evaluate<string>(`(() => {
      const blocks = [...document.querySelector('${CONTENT}').children];
      const block = blocks.find((child) => (child.textContent ?? '').includes('Alpha'));
      return block ? block.outerHTML : '';
    })()`);
    // BUG (hypothesised): the whole-box renormalization on the second paste
    // rewrites the markup the first paste produced.
    expect(firstRegionAfter, 'the second paste rewrote the first pasted region').toBe(firstRegion);
  });

  it('H9: media on the clipboard never lands inside the text, as markup or as data: bytes', { timeout: 120_000 }, async () => {
    // A clipboard carrying `<img src="data:video/mp4;base64,…">` (10 MB) once
    // ended up in a slide title's html: deck.json grew to 13.5 MB and every
    // collaborator's editor crawled. Text-edit paste falls through to the
    // native contenteditable paste, and nothing on the commit path stripped
    // data: media from text html.
    await resetBox('<p>Existing start</p>');
    await enterEditing(cdp!, CONTENT);
    await caretAtEndOfBlockWith('Existing start');
    const video = `data:video/mp4;base64,${'AAAAIGZ0eXBpc29t'.repeat(20_000)}`;
    await pasteAndWaitFor(
      {
        name: 'data-video-in-img',
        html: `<meta charset="utf-8"><span>before</span><img src="${video}"><span>after</span>`,
        text: 'before after',
        expected: ['before', 'after'],
      },
      'after',
    );
    const live = await cdp!.evaluate<{ media: number; bytes: number }>(`(() => {
      const body = document.querySelector('${CONTENT}');
      return { media: body.querySelectorAll('img, video, audio, picture, svg').length, bytes: body.innerHTML.length };
    })()`);
    // BUG: the pasted <img src="data:video/mp4…"> stays in the live text.
    expect(live.media, 'pasted media landed inside the text').toBe(0);
    expect(live.bytes, 'the pasted data: bytes landed inside the text').toBeLessThan(5_000);
    expect(await cdp!.evaluate<string>(`document.getElementById('status')?.textContent ?? ''`))
      .toMatch(/not placed inside a text box/);

    await commitByEscape();
    const html = await committedHtml();
    expect(html, 'the committed text html carries data: media').not.toContain('data:');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });
});

describe.skipIf(electronBinary)('paste pipeline state bugs (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
