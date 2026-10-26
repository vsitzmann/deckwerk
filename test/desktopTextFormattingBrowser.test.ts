import { type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { emptyDeck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  stopBrowser,
} from './support/browserSession.js';
import {
  isEditorTarget,
  launchDesktopApp,
  materializeDesktopApp,
  NEEDS_VISIBLE_WINDOW_ON_CI,
} from './support/desktopApp.js';

/**
 * Production-desktop coverage for the complete inline-formatting journey.
 *
 * Unlike the collaboration-browser stress test, this launches the real main
 * process and preload, establishes selections with pointer gestures, and
 * waits for the resulting deck to reach disk. The app is built into the test's
 * temporary directory so an old checkout-level `out/` cannot mask a regression.
 */
const TEXT_ID = 'desktop-format-text';
const TEXT = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ',
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ',
  'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
].join('');
const CONTENT = `#canvas [data-element-id="${TEXT_ID}"] .text-content`;
const PANEL = '#inspector';
const MOD = process.platform === 'darwin' ? 4 : 2;

type Format = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'superscript' | 'subscript';
type InputRoute = 'shortcut' | 'button';

/** Shift is part of the chord for the baselines; CDP spells it as bit 8. */
const SHIFT = 8;
const FORMAT_UI: Record<Format, {
  key: string; code: string; keyCode: number; label: string; shift?: boolean;
}> = {
  bold: { key: 'b', code: 'KeyB', keyCode: 66, label: 'Bold (Cmd/Ctrl+B)' },
  italic: { key: 'i', code: 'KeyI', keyCode: 73, label: 'Italic (Cmd/Ctrl+I)' },
  underline: { key: 'u', code: 'KeyU', keyCode: 85, label: 'Underline (Cmd/Ctrl+U)' },
  strikethrough: {
    key: 'X', code: 'KeyX', keyCode: 88, shift: true,
    label: 'Strikethrough (Cmd/Ctrl+Shift+X)',
  },
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
/** Every format the matrix reads back after each step. */
const CHECKED: Format[] = [...FORMATS, 'strikethrough'];
/** Raised and lowered are one exclusive choice, so each settles the other. */
const OPPOSITE: Partial<Record<Format, Format>> = {
  superscript: 'subscript',
  subscript: 'superscript',
};

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(appProcess);
  appProcess = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('desktop inline-formatting matrix', () => {
  it('formats whole text, arbitrary overlaps, and newly inserted paragraph text through chords and buttons', {
    // The default suite launches several real Electron windows in parallel.
    // A peer window can briefly take macOS focus and blur this contenteditable;
    // retry the complete native-input scenario instead of weakening any step.
    retry: 2,
    timeout: 120_000,
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-desktop-formatting-'));
    const appDir = join(workDir, 'app');
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(appDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    await materializeDesktopApp(appDir, 'deckwerk-formatting-test');

    const deck = emptyDeck('Desktop formatting matrix');
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
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #fff; color: #111827; }',
      '.role-body { font: 400 42px/1.35 Arial, sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    // Real clipboard traffic and keyboard chords need the window focused.
    const app = await launchDesktopApp(appDir, [deckDir], { profileDir, visible: NEEDS_VISIBLE_WINDOW_ON_CI });
    appProcess = app.process;
    const debugPort = app.debugPort;
    const appLog = app.log;
    const target = await findTarget(
      debugPort,
      isEditorTarget,
      appLog,
      20_000,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`window.api.getDeck().then(
      (session) => session?.dir === ${JSON.stringify(deckDir)}
        && document.querySelector(${JSON.stringify(CONTENT)})?.textContent === ${JSON.stringify(TEXT)}
    )`), 'desktop editor did not open the formatting fixture');
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');

    const selectRangeThroughPointer = async (
      range: { start: number; end: number },
      label: string,
      doubleClickSelection: boolean,
      selectBoxFirst = false,
    ) => {
      const wanted = TEXT.slice(range.start, range.end);
      let lastSelection = '';
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // Other production-browser files run concurrently and can take the OS
        // focus between CDP packets. Reacquire this page and repeat the same
        // native pointer gesture rather than installing a DOM Range directly.
        await editor!.call('Page.bringToFront');
        await editor!.evaluate('window.focus()');
        if (selectBoxFirst || attempt > 0) {
          await editor!.click(`#canvas [data-element-id="${TEXT_ID}"]`, `${label}: text box`);
        }
        // A hidden window under CI's bare Xvfb may never get a compositor
        // frame, so a bare rAF await hangs (see settleFrames in
        // support/exhaustiveTextFormatting.ts); the timer bounds the wait.
        await editor!.evaluate(`new Promise((resolve) => {
          const timer = setTimeout(() => resolve('timer'), 100);
          requestAnimationFrame(() => { clearTimeout(timer); resolve('frame'); });
        })`);
        if (doubleClickSelection) {
          await editor!.doubleClickTextAtOffset(CONTENT, range.start + 1, label);
        } else {
          await editor!.selectTextRange(CONTENT, range.start, range.end, label);
        }
        try {
          return await eventually(async () => selectedText(editor!), `${label} did not settle`,
            (value) => normalizeSelection(value) === normalizeSelection(wanted), 1_500);
        } catch {
          lastSelection = await selectedText(editor!);
        }
      }
      throw new Error(`${label} did not settle: ${JSON.stringify(lastSelection)}`);
    };

    // Match the reported gesture: select the box, then double-click a word.
    const firstIpsum = wordRange(TEXT, 'ipsum');
    await selectRangeThroughPointer(firstIpsum, 'double-click did not select “ipsum”', true, true);

    let authoredText = TEXT;
    const expected: Record<Format, boolean[]> = {
      bold: Array(authoredText.length).fill(false),
      italic: Array(authoredText.length).fill(false),
      underline: Array(authoredText.length).fill(false),
      strikethrough: Array(authoredText.length).fill(false),
      superscript: Array(authoredText.length).fill(false),
      subscript: Array(authoredText.length).fill(false),
    };

    /**
     * Record what one command is expected to have done. A baseline command
     * writes an absolute answer over its whole range — raised, lowered, or
     * back on the line — so it always settles the opposite baseline too.
     */
    const record = (format: Format, active: boolean, start = 0, end = authoredText.length) => {
      expected[format].fill(active, start, end);
      const opposite = OPPOSITE[format];
      if (opposite) expected[opposite].fill(false, start, end);
    };

    const assertAllFormats = async (label: string, expectedSelection?: string) => {
      for (const format of CHECKED) {
        const state = await readFormatState(editor!, format);
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
        await editor!.chord(ui.key, ui.code, ui.keyCode, ui.shift ? MOD | SHIFT : MOD);
      } else {
        await editor!.click(
          `${PANEL} button[aria-label="${ui.label}"]`,
          `${label}: ${ui.label}`,
        );
      }
    };

    const selectWholeText = async () => {
      await editor!.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      await eventually(async () => selectedText(editor!), 'Cmd/Ctrl+A did not select the text box',
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
      await selectRangeThroughPointer(
        range,
        `${label}: “${wanted}”`,
        doubleClickSelection,
        selectBoxFirst,
      );
      await invoke(format, 'shortcut', label);
      record(format, active, range.start, range.end);
      await assertAllFormats(`${label}: ${format} via shortcut`, wanted);
    };

    // Exact regression gesture: select the text box, double-click one word,
    // then use Cmd/Ctrl+B or Cmd/Ctrl+I. Exercise both activation and removal
    // so either shortcut becoming a no-op or losing the range is observable.
    await applyWordShortcut(firstIpsum, 'bold', true, 'double-clicked word bold');
    await applyWordShortcut(firstIpsum, 'bold', false, 'double-clicked word unbold');
    const firstDolor = wordRange(authoredText, 'dolor');
    await applyWordShortcut(firstDolor, 'italic', true, 'double-clicked word italic');
    await applyWordShortcut(firstDolor, 'italic', false, 'double-clicked word unitalic');

    // Deterministic stress coverage for the intermittent case. Repeatedly
    // select exact words through the real pointer path after prior operations
    // have split and normalized the inline DOM, then send the native shortcut.
    const wordRanges = [...authoredText.matchAll(/[A-Za-z]+/g)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
    const random = mulberry32(0x5eedb17);
    for (let step = 0; step < 32; step += 1) {
      const range = wordRanges[Math.floor(random() * wordRanges.length)];
      const format = FORMATS[Math.floor(random() * FORMATS.length)];
      const active = !expected[format][range.start];
      await applyWordShortcut(
        range,
        format,
        active,
        `word shortcut fuzz step ${step + 1}`,
        false,
        false,
      );
    }

    // Every format over the whole box, with both routes represented in each
    // direction. Keeping the selection active also catches toolbar focus loss.
    await applyWhole('bold', 'shortcut', true);
    await applyWhole('italic', 'button', true);
    await applyWhole('underline', 'shortcut', true);
    await applyWhole('bold', 'button', false);
    await applyWhole('italic', 'shortcut', false);
    await applyWhole('underline', 'button', false);
    await applyWhole('strikethrough', 'shortcut', true);
    await applyWhole('strikethrough', 'button', false);

    const applyRange = async (
      start: number,
      end: number,
      format: Format,
      route: InputRoute,
      active: boolean,
      label: string,
    ) => {
      await editor!.selectTextRange(CONTENT, start, end, label);
      const wanted = authoredText.slice(start, end);
      await eventually(async () => selectedText(editor!), `${label}: pointer range did not settle`,
        (value) => normalizeSelection(value) === normalizeSelection(wanted));
      await invoke(format, route, label);
      record(format, active, start, end);
      await assertAllFormats(`${label}: ${format} via ${route}`, wanted);
    };

    // Arbitrary, overlapping subsets across words and punctuation. Each format
    // runs once through each route, and later operations cross earlier spans.
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
    // Into the underlined phrase and back out of it: the underline stays put
    // under both, and the strikethrough on the words before it survives.
    const struckPhrase = phraseRange(authoredText, 'amet', ' adipiscing');
    await applyRange(struckPhrase.start, struckPhrase.end,
      'strikethrough', 'shortcut', true, 'strikethrough over part of an underline');
    await applyRange(consecteturPhrase.start, consecteturPhrase.end,
      'strikethrough', 'button', false, 'strikethrough off an underlined phrase');

    // Put the caret in unformatted text, insert a real paragraph break and a
    // new word, then exercise all three formats over the newly created run.
    const insertAt = authoredText.indexOf('tempor');
    await editor.clickTextAtOffset(CONTENT, insertAt, 'insertion point before “tempor”');
    await editor.key('Enter', 13);
    await editor.typeKeys('NOVUM ');
    const inserted = await eventually(async () => editor!.evaluate<{
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
    for (const format of CHECKED) {
      expected[format].splice(insertedAt, 0, ...Array(insertedLength).fill(false));
    }
    await assertAllFormats('after inserting a paragraph and word');

    const novum = wordRange(authoredText, 'NOVUM');
    await applyRange(novum.start, novum.end, 'bold', 'shortcut', true, 'inserted word bold');
    await applyRange(novum.start, novum.end, 'italic', 'button', true, 'inserted word italic');
    await applyRange(novum.start, novum.end, 'underline', 'shortcut', true, 'inserted word underline');

    // Toggle each format back off over the inserted word using the opposite
    // route, proving repeated edits preserve the paragraph and selection.
    await applyRange(novum.start, novum.end, 'bold', 'button', false, 'inserted word unbold');
    await applyRange(novum.start, novum.end, 'italic', 'shortcut', false, 'inserted word unitalic');
    await applyRange(novum.start, novum.end, 'underline', 'button', false, 'inserted word ununderline');

    // The exclusive pair, over one word: raise it, swap it to lowered without
    // an intervening "off", then put it back on the line.
    await applyRange(novum.start, novum.end, 'superscript', 'shortcut', true, 'inserted word raised');
    await applyRange(novum.start, novum.end, 'subscript', 'button', true, 'inserted word lowered');
    await applyRange(novum.start, novum.end, 'subscript', 'shortcut', false, 'inserted word back on the line');

    // Regression journey: whole-object formatting must not leave a latent
    // bold/italic typing state that later leaks into an automatically created
    // list. This deliberately starts through the production Text toolbar.
    await editor.click('#toolbar .text-insert-trigger', 'Text toolbar menu');
    await editor.clickByText('#toolbar .shape-menu-item', 'Text box', 'Text box in the Text menu');
    const listTextId = await eventually(async () => editor!.evaluate<string>(`(() => {
      const nodes = [...document.querySelectorAll('#canvas [data-element-id]')];
      return nodes.find((node) => node.dataset.elementId !== ${JSON.stringify(TEXT_ID)}
        && node.querySelector('.text-content')?.textContent === 'New text')?.dataset.elementId ?? '';
    })()`), 'Text toolbar did not create and select a placeholder');
    const listContent = `#canvas [data-element-id="${listTextId}"] .text-content`;

    // Apply and remove whole-box bold and italic exactly as reported, while
    // the object (rather than an inline range) is selected.
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
    await eventually(async () => editor!.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(listContent)})?.isContentEditable === true`,
    ), 'new text placeholder did not enter editing');
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
    await eventually(async () => editor!.evaluate<string>(
      `document.querySelector(${JSON.stringify(listContent)})?.textContent?.replaceAll('\u2060', '') ?? ''`,
    ), 'placeholder text was not replaced', (value) => value === listParagraph);

    // The collapsed-caret format toggles above create and then seal internal
    // typing-style runs. The final characters are plain before Enter.
    const paragraphRuns = await editor.evaluate<Array<{
      text: string;
      weight: string;
      style: string;
    }>>(`(() => {
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
    expect(paragraphRuns.some((run) => run.text.includes('italic words')
      && run.style === 'italic')).toBe(true);
    const endingRun = paragraphRuns.find((run) => run.text.includes('plain ending.'));
    expect(Number.parseInt(endingRun?.weight ?? '', 10)).toBeLessThan(600);
    expect(endingRun?.style).toBe('normal');

    await editor.key('End', 35);
    await editor.key('Enter', 13);
    await eventually(async () => editor!.evaluate<boolean>(`(() => {
      const root = document.querySelector(${JSON.stringify(listContent)});
      return document.activeElement === root
        && getSelection()?.isCollapsed === true
        && root.children.length >= 2;
    })()`), 'Enter did not create a second editable paragraph');
    await editor.typeKeys('- some text');
    await editor.key('Enter', 13);

    const listState = await eventually(async () => editor!.evaluate<{
      html: string;
      itemTexts: string[];
      textRuns: Array<{ text: string; weight: string; style: string }>;
      items: Array<{ weight: string; style: string; markerWeight: string; markerStyle: string }>;
    }>(`(() => {
      const root = document.querySelector(${JSON.stringify(listContent)});
      const list = root?.querySelector('ul');
      if (!root || !list) return { html: root?.innerHTML ?? '', itemTexts: [], textRuns: [], items: [] };
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
        html: root.innerHTML,
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

    /*
     * Re-entering text editing on a box that is already being edited — the
     * context menu's "Edit text", which stays offered while the caret is in
     * the box — must replace that session rather than stack a second one on
     * it. Two sessions means two beforeinput handlers, and a pending
     * collapsed-caret Cmd+I run is inserted by that handler, so every
     * keystroke after the shortcut used to arrive twice ("not" as "nnoott").
     */
    await editor.click(`#canvas [data-element-id="${listTextId}"]`, 'text box for re-entry');
    // A word mid-paragraph: a new text box is centred and grows about its
    // centre as it is sized to its text, so this long line's first letters
    // can sit under the slide rail, where a double-click would land on it.
    await editor.doubleClickTextAtOffset(listContent, listParagraph.indexOf('italic') + 1, 'text for re-entry');
    await eventually(async () => editor!.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(listContent)})?.isContentEditable === true`,
    ), 're-entry fixture did not enter text editing');
    await editor.rightClick(`#canvas [data-element-id="${listTextId}"]`, 'context menu while editing');
    await editor.clickByText('#ctx-menu button', 'Edit text', 'Edit text menu item');
    await eventually(async () => editor!.evaluate<boolean>(
      `document.querySelector(${JSON.stringify(listContent)})?.isContentEditable === true`,
    ), 'Edit text did not re-open the editor');
    const reentryText = async () => editor!.evaluate<string>(
      `document.querySelector(${JSON.stringify(listContent)})?.textContent?.replaceAll('\u2060', '') ?? ''`,
    );
    await editor.key('End', 35);
    // Doubling shows up as extra characters wherever the caret is: assert the
    // text grows by exactly what was typed, and that the run appears once.
    const typeAfterReentry = async (typed: string, label: string) => {
      const before = await reentryText();
      await editor!.typeKeys(typed);
      const after = await reentryText();
      expect(after.length - before.length, `${label}: characters inserted`).toBe(typed.length);
      expect(after.split(typed).length - 1, `${label}: occurrences of the typed run`)
        .toBe((before.split(typed).length - 1) + 1);
    };
    await typeAfterReentry(' plain', 'plain typing after re-entry');
    await editor.chord('i', 'KeyI', 73, MOD);
    await typeAfterReentry('not', 'typing inside a pending italic run after re-entry');
    await editor.chord('b', 'KeyB', 66, MOD);
    await typeAfterReentry('bold', 'typing inside a pending bold run after re-entry');

    const liveHtml = await editor.evaluate<string>(
      `document.querySelector(${JSON.stringify(CONTENT)})?.innerHTML ?? ''`,
    );
    expect(liveHtml).toContain('NOVUM');
    expect((liveHtml.match(/<p\b/g) ?? []).length).toBeGreaterThanOrEqual(2);

    // Autosave is part of the contract: a renderer-only visual change is not
    // enough. Wait until the main-process snapshot and deck.json agree.
    const persistedHtml = await eventually(async () => {
      const sessionHtml = await editor!.evaluate<string>(`window.api.getDeck().then((session) => (
        session.deck.slides[0].elements.find((element) => element.id === ${JSON.stringify(TEXT_ID)})?.html ?? ''
      ))`);
      const disk = JSON.parse(await readFile(join(deckDir, 'deck.json'), 'utf8')) as {
        slides: Array<{ elements: Array<{ id: string; html?: string }> }>;
      };
      const diskHtml = disk.slides[0].elements.find((element) => element.id === TEXT_ID)?.html ?? '';
      return { sessionHtml, diskHtml };
    }, 'formatted Lorem Ipsum did not autosave',
    (value) => value.sessionHtml.includes('NOVUM') && value.diskHtml === value.sessionHtml,
    15_000);
    expect(persistedHtml.diskHtml).toContain('NOVUM');
    expect((persistedHtml.diskHtml.match(/<p\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const persistedList = await eventually(async () => {
      const disk = JSON.parse(await readFile(join(deckDir, 'deck.json'), 'utf8')) as {
        slides: Array<{ elements: Array<{ id: string; html?: string }> }>;
      };
      return disk.slides[0].elements.find((element) => element.id === listTextId)?.html ?? '';
    }, 'automatically created list did not autosave', (html) => /<ul>.*some text/s.test(html));
    expect(persistedList).not.toMatch(/<ul[^>]*>.*font-(?:weight|style):\s*(?:700|bold|italic)/s);
  });
});

describe.skipIf(electronBinary)('desktop inline-formatting matrix (skipped)', () => {
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
          : ${JSON.stringify(format)} === 'strikethrough'
            ? style.textDecorationLine.includes('line-through')
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
