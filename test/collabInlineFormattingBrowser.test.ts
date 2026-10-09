import { afterEach, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { Cdp, electronBinary, eventually } from './support/browserSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';

/**
 * Web-client twin of `desktopTextFormattingBrowser.test.ts`.
 *
 * The same inline-formatting journeys — chords and inspector buttons over a
 * double-clicked word, the whole box, arbitrary overlapping ranges, a freshly
 * inserted paragraph, the exclusive raised/lowered pair, list creation after
 * whole-object toggles, and re-entering an editing session through the
 * context menu — driven with real pointer and keyboard input against the
 * production browser client served by the real collaboration server. Where
 * the desktop suite waits for deck.json, this one waits for the deck the
 * server holds (`/api/deck`), which is what every peer would see.
 */
const DECK_ID = 'inline-formatting';
const TEXT_ID = 'web-format-text';
const TEXT = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ',
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ',
  'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
].join('');
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
const PANEL = '#inspector';
const MOD = process.platform === 'darwin' ? 4 : 2;
/** Shift is part of the chord for the baselines; CDP spells it as bit 8. */
const SHIFT = 8;
const THEME_CSS = [
  '.slide { background: #fff; color: #111827; }',
  '.role-body { font: 400 42px/1.35 Arial, sans-serif; }',
  '',
].join('\n');

type Format = 'bold' | 'italic' | 'underline' | 'superscript' | 'subscript';
type InputRoute = 'shortcut' | 'button';

const FORMAT_UI: Record<Format, {
  key: string; code: string; keyCode: number; label: string; shift?: boolean;
}> = {
  bold: { key: 'b', code: 'KeyB', keyCode: 66, label: 'Bold (Cmd/Ctrl+B)' },
  italic: { key: 'i', code: 'KeyI', keyCode: 73, label: 'Italic (Cmd/Ctrl+I)' },
  underline: { key: 'u', code: 'KeyU', keyCode: 85, label: 'Underline (Cmd/Ctrl+U)' },
  superscript: {
    key: '+', code: 'Equal', keyCode: 187, shift: true,
    label: 'Superscript (Cmd/Ctrl+Shift+=)',
  },
  subscript: {
    key: '_', code: 'Minus', keyCode: 189, shift: true,
    label: 'Subscript (Cmd/Ctrl+Shift+-)',
  },
};
const FORMATS: Format[] = ['bold', 'italic', 'underline', 'superscript', 'subscript'];
/** Raised and lowered are one exclusive choice, so each settles the other. */
const OPPOSITE: Partial<Record<Format, Format>> = {
  superscript: 'subscript',
  subscript: 'superscript',
};

let session: WebEditorSession | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

function fixtureDeck(): Deck {
  const deck = emptyDeck('Web formatting matrix');
  deck.slides[0].elements.push({
    id: TEXT_ID,
    type: 'text',
    x: 140,
    y: 150,
    w: 1640,
    h: 760,
    rot: 0,
    z: 1,
    opacity: 1,
    class: ['role-body'],
    style: {},
    html: `<p>${TEXT}</p>`,
    align: 'left',
    valign: 'top',
  });
  return deck;
}

async function openFixture(): Promise<WebEditorSession> {
  const opened = await launchWebEditor(
    [{ id: DECK_ID, deck: fixtureDeck(), themeCss: THEME_CSS }],
    {
      userName: 'Format Web',
      readyWhen: `document.querySelector(${JSON.stringify(CONTENT)})?.textContent === ${JSON.stringify(TEXT)}`,
      tmpPrefix: 'collab-inline-formatting-',
    },
  );
  // Nothing below assumes which side panel happened to open first: reach the
  // inspector's inline-format buttons the way an author does, via the tab.
  const panelLabels = await opened.cdp.evaluate<string[]>(
    `[...document.querySelectorAll('#side-tabs button')].map((b) => b.textContent.trim())`,
  );
  expect(panelLabels).toEqual(['Props', 'Design', 'Build', 'History', 'Media', 'Chat']);
  await opened.cdp.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
  return opened;
}

const serverHtml = async (id: string): Promise<string> => {
  const deck = await session!.fetchDeck();
  const element = deck.slides[0].elements.find((candidate) => candidate.id === id);
  return element?.type === 'text' ? element.html : '';
};

const storeHtml = (cdp: Cdp, id: string): Promise<string> => cdp.evaluate<string>(
  `window.store.get().deck.slides[0].elements.find((e) => e.id === ${JSON.stringify(id)})?.html ?? ''`,
);

const isEditing = (cdp: Cdp, selector: string): Promise<boolean> => cdp.evaluate<boolean>(
  `document.querySelector(${JSON.stringify(selector)})?.isContentEditable === true`,
);

const authoredTextOf = (cdp: Cdp, selector: string): Promise<string> => cdp.evaluate<string>(
  `document.querySelector(${JSON.stringify(selector)})?.textContent?.replaceAll('\u2060', '') ?? ''`,
);

describe.skipIf(!electronBinary)('web inline-formatting matrix', () => {
  it('formats whole text, arbitrary overlaps, and newly inserted paragraph text through chords and buttons', {
    // Several real Electron windows run in parallel on the shared machine. A
    // peer can briefly take macOS focus and blur this contenteditable; retry
    // the complete native-input scenario instead of weakening any step.
    retry: 2,
    timeout: 180_000,
  }, async () => {
    session = await openFixture();
    const editor = session.cdp;

    const selectRangeThroughPointer = async (
      range: { start: number; end: number },
      label: string,
      doubleClickSelection: boolean,
      selectBoxFirst = false,
    ) => {
      const wanted = authoredText.slice(range.start, range.end);
      let lastSelection = '';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await editor.call('Page.bringToFront');
        await editor.evaluate('window.focus()');
        if (selectBoxFirst || attempt > 0) {
          await editor.click(`#canvas [data-element-id="${TEXT_ID}"]`, `${label}: text box`);
        }
        await editor.evaluate('new Promise((resolve) => requestAnimationFrame(() => resolve(true)))');
        if (doubleClickSelection) {
          await editor.doubleClickTextAtOffset(CONTENT, range.start + 1, label);
        } else {
          await editor.selectTextRange(CONTENT, range.start, range.end, label);
        }
        try {
          return await eventually(async () => selectedText(editor), `${label} did not settle`,
            (value) => normalizeSelection(value) === normalizeSelection(wanted), 2_000);
        } catch {
          lastSelection = await selectedText(editor);
        }
      }
      throw new Error(`${label} did not settle: ${JSON.stringify(lastSelection)}`);
    };

    let authoredText = TEXT;
    const expected: Record<Format, boolean[]> = {
      bold: Array(authoredText.length).fill(false),
      italic: Array(authoredText.length).fill(false),
      underline: Array(authoredText.length).fill(false),
      superscript: Array(authoredText.length).fill(false),
      subscript: Array(authoredText.length).fill(false),
    };

    // Match the reported gesture: select the box, then double-click a word.
    const firstIpsum = wordRange(TEXT, 'ipsum');
    await selectRangeThroughPointer(firstIpsum, 'double-click did not select “ipsum”', true, true);

    const record = (format: Format, active: boolean, start = 0, end = authoredText.length) => {
      expected[format].fill(active, start, end);
      const opposite = OPPOSITE[format];
      if (opposite) expected[opposite].fill(false, start, end);
    };

    const assertAllFormats = async (label: string, expectedSelection?: string) => {
      for (const format of FORMATS) {
        const state = await readFormatState(editor, format);
        expect(state.text, `${label}: ${format} changed text`).toBe(authoredText);
        expect(state.map, `${label}: ${format} scope drifted`).toEqual(expected[format]);
        expect(state.editing, `${label}: text editing stopped`).toBe(true);
        if (expectedSelection !== undefined) {
          expect(normalizeSelection(state.selected), `${label}: selection drifted`)
            .toBe(normalizeSelection(expectedSelection));
        }
      }
    };

    const invoke = async (format: Format, route: InputRoute, label: string) => {
      const ui = FORMAT_UI[format];
      if (route === 'shortcut') {
        await editor.chord(ui.key, ui.code, ui.keyCode, ui.shift ? MOD | SHIFT : MOD);
      } else {
        await editor.click(`${PANEL} button[aria-label="${ui.label}"]`, `${label}: ${ui.label}`);
      }
    };

    const selectWholeText = async () => {
      await editor.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      await eventually(async () => selectedText(editor), 'Cmd/Ctrl+A did not select the text box',
        (value) => normalizeSelection(value) === normalizeSelection(authoredText));
    };

    const applyWhole = async (format: Format, route: InputRoute, active: boolean) => {
      await selectWholeText();
      await invoke(format, route, `whole-text ${format}`);
      record(format, active);
      await assertAllFormats(`whole-text ${format} via ${route}`, authoredText);
    };

    const applyWordShortcut = async (
      range: { start: number; end: number },
      format: Format,
      active: boolean,
      label: string,
      selectBoxFirst = true,
      doubleClickSelection = true,
    ) => {
      const wanted = authoredText.slice(range.start, range.end);
      await selectRangeThroughPointer(range, `${label}: “${wanted}”`, doubleClickSelection, selectBoxFirst);
      await invoke(format, 'shortcut', label);
      record(format, active, range.start, range.end);
      await assertAllFormats(`${label}: ${format} via shortcut`, wanted);
    };

    // Exact regression gesture: select the text box, double-click one word,
    // then Cmd/Ctrl+B or Cmd/Ctrl+I, in both directions.
    await applyWordShortcut(firstIpsum, 'bold', true, 'double-clicked word bold');
    await applyWordShortcut(firstIpsum, 'bold', false, 'double-clicked word unbold');
    const firstDolor = wordRange(authoredText, 'dolor');
    await applyWordShortcut(firstDolor, 'italic', true, 'double-clicked word italic');
    await applyWordShortcut(firstDolor, 'italic', false, 'double-clicked word unitalic');

    // Deterministic stress: exact words through the pointer path after prior
    // operations have split and normalized the inline DOM.
    const wordRanges = [...authoredText.matchAll(/[A-Za-z]+/g)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
    const random = mulberry32(0x5eedb17);
    for (let step = 0; step < 32; step += 1) {
      const range = wordRanges[Math.floor(random() * wordRanges.length)];
      const format = FORMATS[Math.floor(random() * FORMATS.length)];
      const active = !expected[format][range.start];
      await applyWordShortcut(range, format, active, `word shortcut fuzz step ${step + 1}`, false, false);
    }

    // Every format over the whole box, both routes represented each way.
    await applyWhole('bold', 'shortcut', true);
    await applyWhole('italic', 'button', true);
    await applyWhole('underline', 'shortcut', true);
    await applyWhole('bold', 'button', false);
    await applyWhole('italic', 'shortcut', false);
    await applyWhole('underline', 'button', false);

    const applyRange = async (
      start: number,
      end: number,
      format: Format,
      route: InputRoute,
      active: boolean,
      label: string,
    ) => {
      await editor.selectTextRange(CONTENT, start, end, label);
      const wanted = authoredText.slice(start, end);
      await eventually(async () => selectedText(editor), `${label}: pointer range did not settle`,
        (value) => normalizeSelection(value) === normalizeSelection(wanted));
      await invoke(format, route, label);
      record(format, active, start, end);
      await assertAllFormats(`${label}: ${format} via ${route}`, wanted);
    };

    // Arbitrary, overlapping subsets across words and punctuation.
    const ipsum = wordRange(authoredText, 'ipsum');
    const dolorPhrase = phraseRange(authoredText, 'dolor', ' amet');
    const consecteturPhrase = phraseRange(authoredText, 'consectetur', ' elit');
    const overlap = phraseRange(authoredText, 'sit', ' adipiscing');
    const laborePhrase = phraseRange(authoredText, 'labore', ' dolore');
    const nostrudPhrase = phraseRange(authoredText, 'nostrud', ' laboris');
    await applyRange(ipsum.start, ipsum.end, 'bold', 'shortcut', true, 'single word');
    await applyRange(dolorPhrase.start, dolorPhrase.end, 'italic', 'button', true, 'short phrase');
    await applyRange(consecteturPhrase.start, consecteturPhrase.end,
      'underline', 'shortcut', true, 'punctuated phrase');
    await applyRange(overlap.start, overlap.end, 'bold', 'button', true, 'overlapping bold phrase');
    await applyRange(laborePhrase.start, laborePhrase.end,
      'italic', 'shortcut', true, 'second-line italic phrase');
    await applyRange(nostrudPhrase.start, nostrudPhrase.end,
      'underline', 'button', true, 'late underline phrase');

    // Caret into unformatted text, a real paragraph break and a new word.
    const insertAt = authoredText.indexOf('tempor');
    await editor.clickTextAtOffset(CONTENT, insertAt, 'insertion point before “tempor”');
    await editor.key('Enter', 13);
    await editor.typeKeys('NOVUM ');
    const inserted = await eventually(async () => editor.evaluate<{
      text: string;
      paragraphs: number;
    }>(`(() => {
      const root = document.querySelector(${JSON.stringify(CONTENT)});
      return {
        text: root?.textContent?.replaceAll('\u2060', '') ?? '',
        paragraphs: root?.querySelectorAll('p').length ?? 0,
      };
    })()`), 'Enter plus inserted word did not settle',
    (value) => value.text.includes('NOVUM ') && value.paragraphs >= 2);
    const insertedAt = inserted.text.indexOf('NOVUM ');
    expect(insertedAt).toBeGreaterThanOrEqual(0);
    const insertedLength = inserted.text.length - authoredText.length;
    expect(insertedLength).toBe('NOVUM '.length);
    authoredText = inserted.text;
    for (const format of FORMATS) {
      expected[format].splice(insertedAt, 0, ...Array(insertedLength).fill(false));
    }
    await assertAllFormats('after inserting a paragraph and word');

    const novum = wordRange(authoredText, 'NOVUM');
    await applyRange(novum.start, novum.end, 'bold', 'shortcut', true, 'inserted word bold');
    await applyRange(novum.start, novum.end, 'italic', 'button', true, 'inserted word italic');
    await applyRange(novum.start, novum.end, 'underline', 'shortcut', true, 'inserted word underline');
    await applyRange(novum.start, novum.end, 'bold', 'button', false, 'inserted word unbold');
    await applyRange(novum.start, novum.end, 'italic', 'shortcut', false, 'inserted word unitalic');
    await applyRange(novum.start, novum.end, 'underline', 'button', false, 'inserted word ununderline');

    // The exclusive pair: raise, swap straight to lowered, back on the line.
    await applyRange(novum.start, novum.end, 'superscript', 'shortcut', true, 'inserted word raised');
    await applyRange(novum.start, novum.end, 'subscript', 'button', true, 'inserted word lowered');
    await applyRange(novum.start, novum.end, 'subscript', 'shortcut', false, 'inserted word back on the line');

    const liveHtml = await editor.evaluate<string>(
      `document.querySelector(${JSON.stringify(CONTENT)})?.innerHTML ?? ''`,
    );
    expect(liveHtml).toContain('NOVUM');
    expect((liveHtml.match(/<p\b/g) ?? []).length).toBeGreaterThanOrEqual(2);

    // Persistence is part of the contract: text edits sync live, so the
    // store and the deck the server holds must agree on the formatted HTML.
    const persisted = await eventually(async () => ({
      store: await storeHtml(editor, TEXT_ID),
      server: await serverHtml(TEXT_ID),
    }), 'formatted Lorem Ipsum did not reach the server',
    (value) => value.store.includes('NOVUM') && value.server === value.store, 30_000);
    expect(persisted.server).toContain('NOVUM');
    expect((persisted.server.match(/<p\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // The saved markup carries the same ranges the canvas paints.
    expect(persisted.server).toMatch(/<(?:b|strong)\b[^>]*>ipsum<\/(?:b|strong)>|font-weight:\s*(?:700|bold)[^>]*>ipsum/);
    expect(persisted.server).toMatch(/<u\b|text-decoration(?:-line)?:\s*underline/);
    expect(persisted.server).toMatch(/<(?:i|em)\b|font-style:\s*italic/);
  });

  it('does not leak whole-object bold/italic toggles into a list created by typing "- "', {
    retry: 2,
    timeout: 180_000,
  }, async () => {
    session = await openFixture();
    const editor = session.cdp;

    // Start through the production Text toolbar, as reported.
    await editor.click('#toolbar .bar-icon-button', 'Text toolbar button');
    const listTextId = await eventually(async () => editor.evaluate<string>(`(() => {
      const nodes = [...document.querySelectorAll('#canvas [data-element-id]')];
      return nodes.find((node) => node.dataset.elementId !== ${JSON.stringify(TEXT_ID)}
        && node.querySelector('.text-content')?.textContent === 'New text')?.dataset.elementId ?? '';
    })()`), 'Text toolbar did not create and select a placeholder');
    const listContent = `#canvas [data-element-id="${listTextId}"] .text-content`;

    // Apply and remove whole-box bold and italic while the object (rather
    // than an inline range) is selected.
    await editor.chord('b', 'KeyB', 66, MOD);
    await editor.chord('i', 'KeyI', 73, MOD);
    await editor.chord('b', 'KeyB', 66, MOD);
    await editor.chord('i', 'KeyI', 73, MOD);
    const resetBoxState = await editor.evaluate<{ weight: string; style: string }>(`(() => {
      const style = getComputedStyle(document.querySelector(${JSON.stringify(listContent)}));
      return { weight: style.fontWeight, style: style.fontStyle };
    })()`);
    expect(Number.parseInt(resetBoxState.weight, 10)).toBeLessThan(600);
    expect(resetBoxState.style).toBe('normal');

    await editor.doubleClickTextAtOffset(listContent, 1, 'new text placeholder');
    await eventually(async () => isEditing(editor, listContent), 'new text placeholder did not enter editing');
    await editor.chord('a', 'KeyA', 65, MOD, ['selectAll']);
    await editor.typeKeys('Lorem plain ');
    await editor.chord('b', 'KeyB', 66, MOD);
    await editor.typeKeys('bold words');
    await editor.chord('b', 'KeyB', 66, MOD);
    await editor.typeKeys(' plain ');
    await editor.chord('i', 'KeyI', 73, MOD);
    await editor.typeKeys('italic words');
    await editor.chord('i', 'KeyI', 73, MOD);
    await editor.typeKeys(' plain ending.');
    const listParagraph = 'Lorem plain bold words plain italic words plain ending.';
    await eventually(async () => authoredTextOf(editor, listContent),
      'placeholder text was not replaced', (value) => value === listParagraph);

    // The collapsed-caret toggles create and then seal typing-style runs; the
    // final characters are plain before Enter.
    const paragraphRuns = await editor.evaluate<Array<{ text: string; weight: string; style: string }>>(`(() => {
      const root = document.querySelector(${JSON.stringify(listContent)});
      const runs = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.data.replaceAll('\u2060', '');
        if (!text) continue;
        const style = getComputedStyle(node.parentElement);
        runs.push({ text, weight: style.fontWeight, style: style.fontStyle });
      }
      return runs;
    })()`);
    expect(paragraphRuns.some((run) => run.text.includes('bold words')
      && Number.parseInt(run.weight, 10) >= 600)).toBe(true);
    expect(paragraphRuns.some((run) => run.text.includes('italic words') && run.style === 'italic')).toBe(true);
    const endingRun = paragraphRuns.find((run) => run.text.includes('plain ending.'));
    expect(Number.parseInt(endingRun?.weight ?? '', 10)).toBeLessThan(600);
    expect(endingRun?.style).toBe('normal');

    await editor.key('End', 35);
    await editor.key('Enter', 13);
    await eventually(async () => editor.evaluate<boolean>(`(() => {
      const root = document.querySelector(${JSON.stringify(listContent)});
      return document.activeElement === root
        && getSelection()?.isCollapsed === true
        && root.children.length >= 2;
    })()`), 'Enter did not create a second editable paragraph');
    await editor.typeKeys('- some text');
    await editor.key('Enter', 13);

    const listState = await eventually(async () => editor.evaluate<{
      itemTexts: string[];
      textRuns: Array<{ text: string; weight: string; style: string }>;
      items: Array<{ weight: string; style: string; markerWeight: string; markerStyle: string }>;
    }>(`(() => {
      const root = document.querySelector(${JSON.stringify(listContent)});
      const list = root?.querySelector('ul');
      if (!root || !list) return { itemTexts: [], textRuns: [], items: [] };
      const textRuns = [];
      const walker = document.createTreeWalker(list, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const style = getComputedStyle(node.parentElement);
        textRuns.push({ text: node.data, weight: style.fontWeight, style: style.fontStyle });
      }
      const items = [...list.querySelectorAll(':scope > li')].map((item) => {
        const style = getComputedStyle(item);
        const marker = getComputedStyle(item, '::marker');
        return {
          weight: style.fontWeight,
          style: style.fontStyle,
          markerWeight: marker.fontWeight,
          markerStyle: marker.fontStyle,
        };
      });
      return {
        itemTexts: [...list.querySelectorAll(':scope > li')].map((item) => item.textContent ?? ''),
        textRuns,
        items,
      };
    })()`), 'hyphen paragraph did not become a list',
    (value) => value.itemTexts[0] === 'some text' && value.itemTexts.length >= 2);
    expect(listState.textRuns.some((run) => run.text.includes('some text'))).toBe(true);
    expect(listState.textRuns.every((run) => Number.parseInt(run.weight, 10) < 600)).toBe(true);
    expect(listState.textRuns.every((run) => run.style === 'normal')).toBe(true);
    expect(listState.items.every((item) => Number.parseInt(item.weight, 10) < 600)).toBe(true);
    expect(listState.items.every((item) => item.style === 'normal')).toBe(true);
    expect(listState.items.every((item) => Number.parseInt(item.markerWeight, 10) < 600)).toBe(true);
    expect(listState.items.every((item) => item.markerStyle === 'normal')).toBe(true);

    // The server holds the list, and nothing in it is bold or italic.
    const persistedList = await eventually(async () => serverHtml(listTextId),
      'automatically created list did not reach the server',
      (html) => /<ul>.*some text/s.test(html), 30_000);
    expect(persistedList).not.toMatch(/<ul[^>]*>.*font-(?:weight|style):\s*(?:700|bold|italic)/s);
    expect(persistedList).not.toMatch(/<ul[^>]*>.*<(?:b|strong|i|em)\b/s);
    expect(await storeHtml(editor, listTextId)).toBe(persistedList);
  });

  it('replaces the editing session when "Edit text" is chosen while already editing, so typing is not doubled', {
    retry: 2,
    timeout: 180_000,
  }, async () => {
    session = await openFixture();
    const editor = session.cdp;

    /*
     * Re-entering text editing on a box that is already being edited — the
     * context menu's "Edit text", which stays offered while the caret is in
     * the box — must replace that session rather than stack a second one on
     * it. Two sessions means two beforeinput handlers, and a pending
     * collapsed-caret Cmd+I run is inserted by that handler, so every
     * keystroke after the shortcut used to arrive twice ("not" as "nnoott").
     */
    await editor.click(`#canvas [data-element-id="${TEXT_ID}"]`, 'text box for re-entry');
    await editor.doubleClickTextAtOffset(CONTENT, 1, 'text for re-entry');
    await eventually(async () => isEditing(editor, CONTENT), 're-entry fixture did not enter text editing');
    await editor.rightClick(`#canvas [data-element-id="${TEXT_ID}"]`, 'context menu while editing');
    await editor.clickByText('#ctx-menu button', 'Edit text', 'Edit text menu item');
    await eventually(async () => isEditing(editor, CONTENT), 'Edit text did not re-open the editor');
    await editor.key('End', 35);
    // Doubling shows up as extra characters wherever the caret is: the text
    // grows by exactly what was typed, and the run appears exactly once more.
    const typeAfterReentry = async (typed: string, label: string) => {
      const before = await authoredTextOf(editor, CONTENT);
      await editor.typeKeys(typed);
      const after = await eventually(async () => authoredTextOf(editor, CONTENT),
        `${label}: typed text did not appear`, (value) => value.length >= before.length + typed.length);
      expect(after.length - before.length, `${label}: characters inserted`).toBe(typed.length);
      expect(after.split(typed).length - 1, `${label}: occurrences of the typed run`)
        .toBe((before.split(typed).length - 1) + 1);
    };
    await typeAfterReentry(' plain', 'plain typing after re-entry');
    await editor.chord('i', 'KeyI', 73, MOD);
    await typeAfterReentry('not', 'typing inside a pending italic run after re-entry');
    await editor.chord('b', 'KeyB', 66, MOD);
    await typeAfterReentry('bold', 'typing inside a pending bold run after re-entry');

    // End moves to the end of the visual line, so the run may sit mid-text;
    // what matters is that it arrived exactly once and nothing else changed.
    const finalText = await authoredTextOf(editor, CONTENT);
    expect(finalText.length).toBe(TEXT.length + ' plainnotbold'.length);
    expect(finalText.split(' plainnotbold')).toHaveLength(2);
    expect(finalText.replace(' plainnotbold', '')).toBe(TEXT);
    const persisted = await eventually(async () => ({
      store: await storeHtml(editor, TEXT_ID),
      server: await serverHtml(TEXT_ID),
    }), 'text typed after re-entry did not reach the server',
    (value) => value.server === value.store && stripMarkup(value.server) === finalText, 30_000);
    expect(stripMarkup(persisted.server)).toBe(finalText);
    // Formatting that came from the pending runs also survives the round trip.
    expect(persisted.server).toMatch(/<(?:i|em)\b|font-style:\s*italic/);
    expect(persisted.server).toMatch(/<(?:b|strong)\b|font-weight:\s*(?:700|bold)/);
  });
});

describe.skipIf(electronBinary)('web inline-formatting matrix (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});

function wordRange(text: string, word: string): { start: number; end: number } {
  const start = text.indexOf(word);
  if (start < 0) throw new Error(`missing word ${JSON.stringify(word)}`);
  return { start, end: start + word.length };
}

function phraseRange(text: string, startWord: string, endFragment: string): {
  start: number;
  end: number;
} {
  const start = text.indexOf(startWord);
  const endStart = text.indexOf(endFragment, start);
  if (start < 0 || endStart < 0) {
    throw new Error(`missing phrase ${JSON.stringify(startWord)}…${JSON.stringify(endFragment)}`);
  }
  return { start, end: endStart + endFragment.length };
}

function normalizeSelection(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripMarkup(html: string): string {
  return html.replace(/<[^>]+>/g, '').replaceAll('\u2060', '').replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function selectedText(cdp: Cdp): Promise<string> {
  return cdp.evaluate(`getSelection()?.toString() ?? ''`);
}

async function readFormatState(cdp: Cdp, format: Format): Promise<{
  text: string;
  selected: string;
  map: boolean[];
  editing: boolean;
}> {
  return cdp.evaluate(`(() => {
    const root = document.querySelector(${JSON.stringify(CONTENT)});
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const map = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const style = getComputedStyle(node.parentElement);
      const active = ${JSON.stringify(format)} === 'italic'
        ? style.fontStyle === 'italic'
        : ${JSON.stringify(format)} === 'underline'
          ? style.textDecorationLine.includes('underline')
          : ${JSON.stringify(format)} === 'superscript'
            ? style.verticalAlign === 'super'
            : ${JSON.stringify(format)} === 'subscript'
              ? style.verticalAlign === 'sub'
              : (style.fontWeight === 'bold' || Number.parseInt(style.fontWeight, 10) >= 600);
      const authored = node.data.replaceAll('\u2060', '');
      for (let index = 0; index < authored.length; index += 1) map.push(active);
    }
    return {
      text: root?.textContent?.replaceAll('\u2060', '') ?? '',
      selected: getSelection()?.toString() ?? '',
      map,
      editing: root?.isContentEditable === true,
    };
  })()`);
}
