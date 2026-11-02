import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { saveDeck } from '../../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../../src/server/collabServer.js';
import { emptyDeck, type Deck, type SlideElement } from '../../src/shared/deck.js';
import { themeById, themeStyleOf } from '../../src/shared/themes.js';
import {
  Cdp,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  textEditingState,
  type RunningBrowser,
} from './browserSession.js';
import { collabClientDir } from './collabClient.js';
import { recordRecovery } from './exhaustiveTextFormatting.js';

/**
 * Shared fixture and helpers for the production-browser formatting/undo
 * suites (test/collabFormattingUndo*.test.ts). Each suite starts its own
 * collaboration server, deck directory, and hidden Electron window, so the
 * files can run in parallel Vitest workers; the deck id keeps their URLs and
 * on-disk state apart.
 *
 * Every mutation is initiated through the shipping control with real
 * pointer/key input, then Ctrl/Cmd+Z is dispatched through Chromium and the
 * exact original element is required to return on the collaboration server.
 */

export const NORMAL_ID = 'normal-text';
export const OL_ID = 'ordered-list';
export const UL_ID = 'bullet-list';
export const TABLE_ID = 'format-table';
export const PANEL = '#inspector';
export const ON_CANVAS = (id: string) => `#canvas [data-element-id="${id}"]`;
// CDP modifier mask: Control=2, Meta=4. Native contenteditable follows the
// platform convention (Cmd+A/Z on macOS, Ctrl+A/Z elsewhere).
export const MOD = process.platform === 'darwin' ? 4 : 2;
// The invisible word joiner an unsealed collapsed-caret style run carries.
export const TYPING_SENTINEL = '⁠';
export const FORMAT_COMMANDS = { b: 'bold', i: 'italic', u: 'underline' } as const;

export type PersistedCellBorders = {
  widths: Record<'top' | 'right' | 'bottom' | 'left', string>;
  colors: Record<'top' | 'right' | 'bottom' | 'left', string>;
};

export function count(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

/** Inline formatting must not add, drop, or split the fixture's blocks. */
export function hasOriginalStructure(
  id: string,
  html: string,
  tag: string,
  amount: number,
): boolean {
  return count(html, tag) === amount
    && (id !== OL_ID || count(html, '<ol') === 1)
    && (id !== UL_ID || count(html, '<ul') === 1)
    && count(html, '<br') === 0;
}

function text(id: string, y: number, html: string, h = 180): SlideElement {
  return {
    id, type: 'text', x: 100, y, w: 1720, h, rot: 0, z: 1, opacity: 1,
    class: ['role-body'], style: { 'font-family': 'Arial' }, html,
    align: 'left', valign: 'top',
  } as SlideElement;
}

/**
 * The full inline-format matrix for one text kind: every path is a real
 * click (or real keystrokes) followed by a real Ctrl/Cmd+Z, and per-keystroke
 * typing brackets each B/I/U toggle so a pending collapsed-caret style run or
 * duplicated editing listener shows up as wrong characters.
 */
export async function runInlineFormatMatrix(
  session: FormattingSession,
  id: string,
  tag: string,
  amount: number,
): Promise<void> {
  const { editor } = session;
  await session.beginSelectAll(id);
  await session.chooseFontFamily('', `${id} font family`);
  await session.expectHtml(id, (html) => hasOriginalStructure(id, html, tag, amount)
    && html.includes('font-family: inherit'));
  await session.undoEditing(id);

  for (const [label, marker] of [
    ['Bold (Cmd/Ctrl+B)', /<(b|strong)\b|font-weight/i],
    ['Italic (Cmd/Ctrl+I)', /<(i|em)\b|font-style/i],
    ['Underline (Cmd/Ctrl+U)', /<u\b|text-decoration/i],
    ['Superscript (Cmd/Ctrl+Shift+=)', /<sup\b|vertical-align: super/i],
    ['Subscript (Cmd/Ctrl+Shift+-)', /<sub\b|vertical-align: sub/i],
  ] as const) {
    await session.beginSelectFirstWord(id);
    await session.typeAtEnd(id, ' pre', `${id} ${label} typing before the change`);
    await session.beginSelectFirstWord(id);
    await editor.click(`${PANEL} button[aria-label="${label}"]`, `${id} ${label}`);
    await session.expectHtml(id, (html) => marker.test(html)
      && hasOriginalStructure(id, html, tag, amount));
    await session.expectFormatButtonPressed(label);
    await session.typeAtEnd(id, ' post', `${id} ${label} typing after the change`);
    await session.restore(id);
  }

  await session.beginSelectAll(id);
  const weight = await session.idField(
    'Font weight', `test-${id}-selected-font-weight`, '.field-number');
  await editor.typeInto(weight, '700', `${id} 700 font weight`);
  await session.expectHtml(id, (html) => hasOriginalStructure(id, html, tag, amount)
    && html.includes('font-weight: 700'));
  await session.undoEditing(id);

  for (const [label, expectedTheme, upDeclaration, downDeclaration] of [
    ['Font size', '36', 'font-size: 37px', 'font-size: 35px'],
    ['Font weight', '400', 'font-weight: 425', 'font-weight: 375'],
  ] as const) {
    for (const [direction, declaration] of [
      ['up', upDeclaration], ['down', downDeclaration],
    ] as const) {
      await session.beginSelectAll(id);
      const selector = await session.idField(
        label, `test-${id}-${label.replace(' ', '-')}-${direction}`, '.field-number');
      const inheritedField = await editor.evaluate<{ value: string; theme: string | null }>(`(() => {
        const input = document.querySelector('${selector}');
        return { value: input.value, theme: input.parentElement.querySelector('.theme-value-indicator')?.textContent ?? null };
      })()`);
      expect({ ...inheritedField, theme: inheritedField.theme?.toLowerCase() ?? null })
        .toEqual({ value: expectedTheme, theme: '(theme)' });
      await editor.click(`${PANEL} button[aria-label="${label} ${direction}"]`,
        `${id} ${label} ${direction} stepper`);
      await session.expectHtml(id, (html) => hasOriginalStructure(id, html, tag, amount)
        && html.includes(declaration));
      await session.undoEditing(id);
    }
  }

  await session.beginSelectAll(id);
  await editor.click(`${PANEL} .align-button:nth-of-type(2)`, `${id} selected paragraph alignment`);
  await session.expectHtml(id, (html) => hasOriginalStructure(id, html, tag, amount)
    && count(html, 'text-align: center') === 2);
  await session.undoEditing(id);

  await session.beginSelectAll(id);
  await editor.click(`${PANEL} .field-color .color-picker-trigger[aria-label^="Colour"]`, `${id} colour`);
  await editor.click('.color-picker-popover .color-picker-palette-button[title="#1d7d45"]', `${id} green`);
  await session.expectHtml(id, (html) => hasOriginalStructure(id, html, tag, amount)
    && /color:\s*(?:#1d7d45|rgb\(29, 125, 69\))/i.test(html));
  await session.undoEditing(id);
}

export class FormattingSession {
  readonly original = new Map<string, SlideElement>();

  private constructor(
    readonly deckId: string,
    private workDir: string,
    private server: RunningCollabServer,
    private browser: RunningBrowser,
    readonly editor: Cdp,
  ) {}

  get port(): number {
    return this.server.port;
  }

  /**
   * Launch the standard four-element formatting fixture (two-paragraph text,
   * ordered list, bullet list, 2×2 table) and connect a real editor to it.
   */
  static async start(deckId: string, userName: string): Promise<FormattingSession> {
    const workDir = await mkdtemp(join(tmpdir(), `collab-format-undo-${deckId}-`));
    let server: RunningCollabServer | null = null;
    let browser: RunningBrowser | null = null;
    let editor: Cdp | null = null;
    try {
      const decksRoot = join(workDir, 'decks');
      const deckDir = join(decksRoot, deckId);
      const clientDir = await collabClientDir();
      const profileDir = join(workDir, 'electron-profile');
      await mkdir(deckDir, { recursive: true });
      await mkdir(profileDir, { recursive: true });

      const deck = emptyDeck('Formatting focus and undo');
      deck.themePreset = 'basic';
      const basicTheme = themeById('basic');
      if (!basicTheme) throw new Error('basic theme fixture is unavailable');
      deck.themeStyle = themeStyleOf(basicTheme);
      // These suites exercise a known colour through every formatting scope.
      // Keep that fixture colour explicit instead of depending on a preset's
      // evolving product palette.
      deck.themeStyle.palette[4] = '#1d7d45';
      deck.slides[0].elements.push(
        text(NORMAL_ID, 30, '<p>Normal first</p><p>Normal second</p>', 130),
        text(OL_ID, 190, '<ol><li><span class="keep">Ordered</span> one</li><li>Ordered two</li></ol>', 170),
        text(UL_ID, 390, '<ul><li><span class="keep">Bullet</span> one</li><li>Bullet two</li></ul>', 170),
        text(TABLE_ID, 590,
          '<table><tbody><tr><td>A</td><td>B</td></tr>'
            + '<tr><td>C</td><td>D</td></tr></tbody></table>', 400),
      );
      await saveDeck(deckDir, deck);
      await writeFile(join(deckDir, 'theme.css'), [
        '.slide { background: #fff; color: #111827; }',
        '.role-body { font: 400 36px/1.3 sans-serif; }',
        '',
      ].join('\n'), 'utf8');

      server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
      browser = await launchBrowser(
        `http://127.0.0.1:${server.port}/?deck=${deckId}&name=${encodeURIComponent(userName)}`,
        profileDir,
      );
      const target = await findTarget(
        browser.debugPort,
        (candidate) => candidate.url.includes(`deck=${deckId}`),
        browser.log,
      );
      editor = await Cdp.connect(target.webSocketDebuggerUrl!);
      // CI shows every suite's window on one bare Xvfb, where the window
      // mapped last takes the keyboard. Losing it blurs the field being typed
      // into, the blur commits it, and the rebuilt panel drops the field a
      // test is still typing into. This page stands for the window an author
      // is working in, so it keeps focus.
      await editor.call('Emulation.setFocusEmulationEnabled', { enabled: true });
      await eventually(async () => editor!.evaluate<boolean>(`(
        document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${userName}`)}) === true
        && Boolean(document.querySelector('${ON_CANVAS(TABLE_ID)} table'))
      )`), 'formatting browser did not finish connecting');
      return new FormattingSession(deckId, workDir, server, browser, editor);
    } catch (error) {
      editor?.close();
      await stopBrowser(browser?.process ?? null);
      await server?.close();
      await rm(workDir, { recursive: true, force: true });
      throw error;
    }
  }

  async close(): Promise<void> {
    this.editor.close();
    await stopBrowser(this.browser.process);
    await this.server.close();
    await rm(this.workDir, { recursive: true, force: true });
  }

  /** Snapshot the exact server state every later undo must restore. */
  async captureOriginals(): Promise<void> {
    for (const id of [NORMAL_ID, OL_ID, UL_ID, TABLE_ID]) {
      this.original.set(id, await this.liveElement(id));
    }
  }

  async fetchDeck(): Promise<Deck> {
    const response = await fetch(`http://127.0.0.1:${this.port}/api/deck?deck=${this.deckId}`);
    if (!response.ok) throw new Error(`deck request failed (${response.status})`);
    return response.json() as Promise<Deck>;
  }

  async liveElement(id: string): Promise<SlideElement> {
    const deck = await this.fetchDeck();
    const element = deck.slides[0].elements.find((candidate) => candidate.id === id);
    if (!element) throw new Error(`missing ${id}`);
    return element;
  }

  async expectRestored(id: string, original: SlideElement): Promise<void> {
    await eventually(async () => this.liveElement(id), `${id} did not undo exactly`,
      (element) => JSON.stringify(element) === JSON.stringify(original));
  }

  async expectHtml(id: string, accept: (html: string) => boolean): Promise<void> {
    await eventually(async () => {
      const element = await this.liveElement(id);
      return element.type === 'text' ? element.html : '';
    }, `${id} html did not change as expected`, accept);
  }

  /**
   * Choose a font family once the picker holds the option. The select fills
   * asynchronously (installed families are enumerated or probed after the
   * field renders), so a fast suite can reach it before the option exists.
   */
  /**
   * Choose a font family, returning the one actually chosen. `preferred` is a
   * fallback list: the first option present in the dropdown wins. The font set
   * differs by OS — Georgia is on macOS, not stock Ubuntu — so a test that
   * hardcodes one font fails on CI for want of that font, not a real defect;
   * callers assert against the returned name instead. '' (theme font) is
   * always present. The list is awaited because the dropdown populates async.
   */
  async chooseFontFamily(preferred: string | string[], label: string): Promise<string> {
    const wanted = Array.isArray(preferred) ? preferred : [preferred];
    const chosen = await eventually(async () => this.editor.evaluate<string | null>(`(() => {
      const select = document.querySelector('${PANEL} .font-family-field select');
      if (!select) return null;
      const have = new Set([...select.options].map((option) => option.value));
      return ${JSON.stringify(wanted)}.find((family) => have.has(family)) ?? null;
    })()`), `${label}: none of ${JSON.stringify(wanted)} appeared in the font list`,
      (value) => value !== null, 30_000);
    await this.editor.choose(`${PANEL} .font-family-field select`, chosen!, label);
    return chosen!;
  }

  async openProps(): Promise<void> {
    await this.editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
  }

  /** Bare Xvfb can lose a drag and leave a caret; retry once and report it. */
  async beginSelectAll(id: string): Promise<void> {
    const content = `${ON_CANVAS(id)} .text-content`;
    await this.editor.call('Page.bringToFront');
    await this.editor.evaluate('window.focus()');
    const editing = await this.editor.evaluate<boolean>(
      `document.querySelector('${content}')?.isContentEditable === true`,
    );
    if (!editing) await this.editor.doubleClick(content, `${id} text`);
    await eventually(async () => this.editor.evaluate<boolean>(
      `document.querySelector('${content}')?.isContentEditable === true`,
    ), `${id} did not enter text editing`);
    const selectionState = () => this.editor.evaluate<{ editing: boolean; caret: boolean; selected: boolean }>(`(() => {
      const node = document.querySelector('${content}');
      const selection = window.getSelection();
      const inside = Boolean(selection?.rangeCount && node?.contains(selection.anchorNode));
      return {
        editing: node?.isContentEditable === true,
        caret: inside && selection.isCollapsed && document.activeElement === node,
        selected: inside && !selection.isCollapsed && selection.toString().trim().length > 0,
      };
    })()`);
    for (let attempt = 0; ; attempt += 1) {
      if (editing || attempt > 0) {
        await this.editor.click(content, `${id} reset caret`);
        await eventually(selectionState, `${id} reset click did not place a caret`, (now) => now.caret);
      }
      await this.editor.dragSelectText(content, `${id} text`);
      const after = await eventually(selectionState, '', (now) => now.selected, 5_000)
        .catch(() => selectionState());
      if (after.selected) return;
      if (after.editing && after.caret && attempt === 0) {
        recordRecovery(`${id}: the drag over all text left a caret; dragged again`);
        continue;
      }
      throw new Error(`${id} text was not selected: ${JSON.stringify(after)}\n`
        + `canvas state: ${await textEditingState(this.editor, content)}`);
    }
  }

  /**
   * Select the box's first word with a real pointer drag, in edit mode.
   *
   * On CI this window is a real X11 window on a bare Xvfb that the other
   * Electron suites of the tier share, so the window can lose focus and the
   * pointer state can change under a gesture; a drag that lost its moves
   * leaves a bare caret. This used to fire the drag once and then wait 40 s
   * for a selection that could no longer appear ("first word was not
   * selected: false"). Now each step waits for what the next one needs —
   * the window in front, the box editing, the caret placed in it — and a
   * drag that left only a caret in a box still being edited is made again,
   * once, and recorded. A box that left editing is a failure, with the
   * canvas state.
   */
  async beginSelectFirstWord(id: string, descendant = ''): Promise<void> {
    const content = `${ON_CANVAS(id)} .text-content`;
    const target = `${content}${descendant ? ` ${descendant}` : ''}`;
    await this.editor.call('Page.bringToFront');
    await this.editor.evaluate('window.focus()');
    const editing = await this.editor.evaluate<boolean>(
      `document.querySelector('${content}')?.isContentEditable === true`,
    );
    if (!editing) await this.editor.doubleClickText(content, `${id} first word`);
    await eventually(async () => this.editor.evaluate<boolean>(
      `document.querySelector('${content}')?.isContentEditable === true`,
    ), `${id} did not enter text editing`);
    const state = () => this.editor.evaluate<{ editing: boolean; caret: boolean; word: boolean }>(`(() => {
      const content = document.querySelector('${content}');
      const selection = window.getSelection();
      const inside = Boolean(selection?.rangeCount && content?.contains(selection.anchorNode));
      return {
        editing: content?.isContentEditable === true,
        caret: inside && selection.isCollapsed && document.activeElement === content,
        word: inside && !selection.isCollapsed && selection.toString().trim().length > 0,
      };
    })()`);
    for (let attempt = 0; ; attempt += 1) {
      if (editing || attempt > 0) {
        await this.editor.click(target, `${id} reset caret`);
        await eventually(state, `${id} reset click did not place a caret`, (now) => now.caret);
      }
      await this.editor.dragSelectFirstWord(target, `${id} selected word`);
      const after = await eventually(state, '', (now) => now.word, 5_000).catch(() => state());
      if (after.word) return;
      if (after.editing && after.caret && attempt === 0) {
        recordRecovery(`${id}: the drag over the first word left a caret; dragged again`);
        continue;
      }
      throw new Error(`${id} first word was not selected: ${JSON.stringify(after)}\n`
        + `canvas state: ${await textEditingState(this.editor, content)}`);
    }
  }

  async undoEditing(id: string, preserveTextSelection = true): Promise<void> {
    // The selection being formatted: the live one when the text box holds
    // focus, otherwise the editor's offset bookmark — while a panel field
    // has the keyboard, Chromium clears the live contenteditable selection
    // (focusing a text input collapses it), and the bookmark is what the
    // panel's commits actually format.
    const selectedText = preserveTextSelection
      ? await this.editor.evaluate<string>(`(() => {
          const live = window.getSelection()?.toString() ?? '';
          if (live) return live;
          const offsets = window.canvas.editingSelectionOffsets?.();
          const body = document.querySelector('${ON_CANVAS(id)} .text-content');
          if (!offsets || !body) return '';
          return (body.textContent ?? '').slice(offsets.start, offsets.end);
        })()`)
      : '';
    await this.editor.chord('z', 'KeyZ', 90, MOD);
    await this.expectRestored(id, this.original.get(id)!);
    if (preserveTextSelection) {
      await eventually(async () => this.editor.evaluate<{
        editing: boolean;
        collapsed: boolean;
        selected: string;
      }>(`(() => ({
        editing: document.querySelector('${ON_CANVAS(id)} .text-content')?.isContentEditable === true,
        collapsed: window.getSelection()?.isCollapsed ?? true,
        selected: window.getSelection()?.toString() ?? '',
      }))()`), `${id} lost its text selection after undo`, (state) =>
        state.editing && !state.collapsed
          // Whitespace-insensitive: Selection.toString() renders block
          // boundaries as newlines, while the offset-bookmark capture above
          // reads textContent, which has none.
          && state.selected.replace(/\s+/g, '') === selectedText.replace(/\s+/g, ''));
    }
  }

  async undoChrome(id: string): Promise<void> {
    await this.openProps();
    await this.editor.chord('z', 'KeyZ', 90, MOD);
    await this.expectRestored(id, this.original.get(id)!);
  }

  plainTextOf(value: string): string {
    return value
      .replace(/<[^>]+>/g, '')
      .replaceAll('&nbsp;', ' ')
      .replaceAll(' ', ' ')
      .replaceAll(TYPING_SENTINEL, '');
  }

  async domText(id: string): Promise<string> {
    return this.plainTextOf(await this.editor.evaluate<string>(
      `document.querySelector('${ON_CANVAS(id)} .text-content')?.textContent ?? ''`,
    ));
  }

  async placeCaretAtEnd(id: string): Promise<void> {
    // Click the last character that actually paints (a pending typing-style
    // run ends in an invisible word joiner), then End to reach the very end
    // of that line — the caret an author leaves before typing on.
    const offset = await this.editor.evaluate<number>(`(() => {
      const text = document.querySelector('${ON_CANVAS(id)} .text-content')?.textContent ?? '';
      for (let index = text.length - 1; index >= 0; index -= 1) {
        if (!/[\\s\\u2060]/.test(text[index])) return index;
      }
      return 0;
    })()`);
    await this.editor.clickTextAtOffset(
      `${ON_CANVAS(id)} .text-content`, offset, `${id} last character`,
    );
    await this.editor.key('End', 35);
  }

  /**
   * Real per-keystroke typing where the caret already is, asserted both in
   * the live DOM and on the collaboration server. A click would discard a
   * pending collapsed-caret style run before the keystrokes could inherit it.
   *
   * Formatting is not the end of an author's sentence: they keep typing.
   * A pending collapsed-caret style run, or a duplicated editing listener
   * left behind by a formatting path, only shows up as wrong characters —
   * `Input.insertText` inserts a whole string in one `beforeinput` and would
   * hide a per-key fault such as "not" arriving as "nnoott".
   */
  async typeHere(id: string, typed: string, label: string): Promise<void> {
    const before = await this.domText(id);
    await this.editor.typeKeys(typed);
    const expected = before + typed;
    await eventually(async () => this.domText(id), `${label}: typed characters are wrong on screen`,
      (text) => text === expected);
    await eventually(async () => {
      const element = await this.liveElement(id);
      return element.type === 'text' ? this.plainTextOf(element.html) : '';
    }, `${label}: typed characters are wrong on the server`, (text) => text === expected);
  }

  async typeAtEnd(id: string, typed: string, label: string): Promise<void> {
    await this.placeCaretAtEnd(id);
    await this.typeHere(id, typed, label);
  }

  /**
   * Typing adds its own history entries, so undo until the fixture returns.
   * Whether another undo is needed is judged once the server has confirmed
   * every edit this editor sent, the last undo included: a fixed pause let a
   * slow runner press one more undo than the history held.
   */
  async restore(id: string): Promise<void> {
    const original = JSON.stringify(this.original.get(id)!);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await eventually(async () => this.editor.evaluate<boolean>('window.bridge.pending.length === 0'),
        `${id}: the server did not confirm this editor's edits`);
      if (JSON.stringify(await this.liveElement(id)) === original) return;
      await this.editor.chord('z', 'KeyZ', 90, MOD);
    }
    await this.expectRestored(id, this.original.get(id)!);
  }

  async idField(label: string, id: string, selector: string): Promise<string> {
    const found = await this.editor.evaluate<boolean>(`(() => {
      const field = [...document.querySelectorAll('${PANEL} ${selector}')]
        .find((node) => node.querySelector('span')?.textContent === ${JSON.stringify(label)}
          || node.textContent?.trim() === ${JSON.stringify(label)});
      const input = field?.querySelector('input, select');
      if (!input) return false;
      input.id = ${JSON.stringify(id)};
      return true;
    })()`);
    expect(found).toBe(true);
    return `#${id}`;
  }

  async checkboxId(label: string, id: string): Promise<string> {
    const found = await this.editor.evaluate<boolean>(`(() => {
      const field = [...document.querySelectorAll('${PANEL} .field-check')]
        .find((node) => node.textContent?.trim() === ${JSON.stringify(label)});
      const input = field?.querySelector('input');
      if (!input) return false;
      input.id = ${JSON.stringify(id)};
      return true;
    })()`);
    expect(found).toBe(true);
    return `#${id}`;
  }

  async buttonId(label: string, id: string): Promise<string> {
    const found = await this.editor.evaluate<boolean>(`(() => {
      const button = [...document.querySelectorAll('${PANEL} button')]
        .find((node) => node.textContent?.trim() === ${JSON.stringify(label)});
      if (!button) return false;
      button.id = ${JSON.stringify(id)};
      return true;
    })()`);
    expect(found).toBe(true);
    return `#${id}`;
  }

  async expectFormatButtonPressed(label: string): Promise<void> {
    await eventually(async () => this.editor.evaluate<{
      pressed: string | null;
      background: string;
      border: string;
      peerBackground: string;
      peerBorder: string;
    }>(`(() => {
      const button = document.querySelector('${PANEL} button[aria-label="${label}"]');
      const peer = button?.parentElement?.querySelector('button[aria-pressed="false"]');
      const style = getComputedStyle(button);
      const peerStyle = getComputedStyle(peer);
      return {
        pressed: button?.getAttribute('aria-pressed') ?? null,
        background: style.backgroundColor,
        border: style.borderColor,
        peerBackground: peerStyle.backgroundColor,
        peerBorder: peerStyle.borderColor,
      };
    })()`), `${label} did not appear toggled`, (state) =>
      state.pressed === 'true'
        && state.background !== state.peerBackground
        && state.border !== state.peerBorder);
  }

  /** Parse the server's saved cell styles through Chromium's real CSSOM. */
  async tableBordersFromServer(): Promise<PersistedCellBorders[]> {
    const element = await this.liveElement(TABLE_ID);
    if (element.type !== 'text') return [];
    return this.editor.evaluate<PersistedCellBorders[]>(`(() => {
      const template = document.createElement('template');
      template.innerHTML = ${JSON.stringify(element.html)};
      return [...template.content.querySelectorAll('td, th')].map((cell) => ({
        widths: {
          top: cell.style.borderTopWidth,
          right: cell.style.borderRightWidth,
          bottom: cell.style.borderBottomWidth,
          left: cell.style.borderLeftWidth,
        },
        colors: {
          top: cell.style.borderTopColor,
          right: cell.style.borderRightColor,
          bottom: cell.style.borderBottomColor,
          left: cell.style.borderLeftColor,
        },
      }));
    })()`);
  }

  async expectTableStyled(declaration: string, countExpected: number): Promise<void> {
    await this.expectHtml(TABLE_ID, (html) => count(html, declaration) === countExpected);
  }

  async tableCellCount(): Promise<number> {
    const element = await this.liveElement(TABLE_ID);
    if (element.type !== 'text') return 0;
    return count(element.html, '<td');
  }

  /** A real cell drag determines cell, horizontal, vertical, or rectangular scope. */
  async enterTable(scope: 'Cell' | 'Row' | 'Column' | 'Range'): Promise<void> {
    await this.editor.doubleClick(`${ON_CANVAS(TABLE_ID)} .text-content`, 'table text');
    const cells = {
      A: `${ON_CANVAS(TABLE_ID)} tbody tr:first-child td:first-child`,
      B: `${ON_CANVAS(TABLE_ID)} tbody tr:first-child td:nth-child(2)`,
      D: `${ON_CANVAS(TABLE_ID)} tbody tr:nth-child(2) td:nth-child(2)`,
    };
    if (scope === 'Cell') await this.editor.click(cells.B, 'table cell B');
    else if (scope === 'Row') await this.editor.dragBetween(cells.A, cells.B, 'table row drag');
    else if (scope === 'Column') await this.editor.dragBetween(cells.B, cells.D, 'table column drag');
    else await this.editor.dragBetween(cells.A, cells.D, 'table rectangular drag');
    const expected = { Cell: 1, Row: 2, Column: 2, Range: 4 }[scope];
    await eventually(async () => this.editor.evaluate<number>(
      `document.querySelectorAll('${ON_CANVAS(TABLE_ID)} .editor-table-selected').length`,
    ), `${scope} drag did not select the expected cells`, (value) => value === expected);
    expect(await this.editor.evaluate<boolean>(
      `document.querySelector('${ON_CANVAS(TABLE_ID)} .text-content')?.isContentEditable === true`,
    )).toBe(true);
  }

  async refocusTableAndUndo(): Promise<void> {
    await this.editor.click(
      `${ON_CANVAS(TABLE_ID)} tbody tr:first-child td:first-child`, 'remaining table cell');
    await this.undoEditing(TABLE_ID, false);
  }
}
