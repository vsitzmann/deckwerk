import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
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
 * Text formatting in the browser collaboration edition, driven by real clicks.
 *
 * `test/textFormattingControls.test.ts` proves the same inspector controls in
 * jsdom, where a click is a synthetic dispatch on a node the test looked up.
 * This test proves the shipping web UI: Vite builds the production client, the
 * real server hosts it, and every format below is applied by dispatching mouse
 * and key events at viewport coordinates, so the browser does its own layout,
 * hit-testing, and focus. A control that renders off-panel, sits under an
 * overlay, or collapses to zero size fails here and nowhere else.
 *
 * Each format is then checked three ways: the canvas repaint the author sees,
 * the deck the server persisted, and the live presentation view.
 */

const DECK_ID = 'text-formatting';
const TITLE_ID = 'fmt-title';
const BODY_ID = 'fmt-body';
// A colour from the 'basic' preset palette: the theme panel publishes exactly
// that palette into the swatch row every colour picker shows.
const THEME_SWATCH = '#c96442';

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;
let presentation: Cdp | null = null;

afterEach(async () => {
  presentation?.close();
  presentation = null;
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

/* --- inspector selectors, as the panel actually renders them -------------- */

const PANEL = '#inspector';
const ALIGN_BUTTON = (index: number) => `${PANEL} .align-button:nth-of-type(${index + 1})`;
// Scope to the typography colour: the panel also carries slide background and
// border colour fields, and picking the wrong one would pass for the wrong reason.
const COLOR_TRIGGER = `${PANEL} .field-color .color-picker-trigger[aria-label^="Colour"]`;
const SWATCH = (color: string) => `.color-picker-popover .color-picker-palette-button[title="${color}"]`;
const CLEAR_COLOR = '.color-picker-popover .color-picker-clear';
const HEX_INPUT = '.color-picker-popover input[aria-label="Hex color"]';
const VERTICAL_SELECT = `${PANEL} .compact-field-row label.field select`;
// The slide rail paints the same `data-element-id` thumbnails, so canvas
// selectors must say which surface they mean.
const ON_CANVAS = (id: string) => `#canvas [data-element-id="${id}"]`;

describe.skipIf(!electronBinary)('text formatting in the collaboration browser', () => {
  it('aligns, colours, bullets, and spaces text from real clicks on the inspector', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'collab-text-format-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Text formatting in the browser');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: TITLE_ID, type: 'text', x: 160, y: 90, w: 1600, h: 160,
      rot: 0, z: 1, opacity: 1, class: ['role-title'], style: {},
      html: 'Formatting title', align: 'left', valign: 'middle',
    }, {
      id: BODY_ID, type: 'text', x: 160, y: 340, w: 1600, h: 420,
      rot: 0, z: 2, opacity: 1, class: ['role-body'], style: {},
      html: '<p>First point</p><p>Second point</p>', align: 'left', valign: 'top',
    });
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #ffffff; color: #111827; }',
      '.role-title { font: 700 72px/1.1 sans-serif; }',
      '.role-body { font: 400 40px/1.3 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    server = await startCollabServer({
      rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
    });

    browser = await launchBrowser(
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Format%20Browser`,
      profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`)
        && !candidate.url.includes('present.html'),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`(
      document.getElementById('status')?.textContent?.includes('connected as Format Browser') === true
      && Boolean(document.querySelector('#canvas [data-element-id="${BODY_ID}"] .text-body'))
    )`), 'browser editor did not finish connecting');

    /* --- select the body text by clicking it on the canvas ---------------- */

    await editor.click(ON_CANVAS(BODY_ID), 'body text on the canvas');
    await eventually(
      async () => editor!.evaluate<string[]>(`[...window.store.get().selection]`),
      'clicking the canvas did not select the body text',
      (selection) => selection.length === 1 && selection[0] === BODY_ID,
    );
    // Reach the typography controls the way an author does: click the Props
    // tab. Nothing below assumes which side panel happened to open first.
    const panelLabels = await editor.evaluate<string[]>(
      `[...document.querySelectorAll('#side-tabs button')].map((b) => b.textContent.trim())`);
    expect(panelLabels).toEqual(['Props', 'Design', 'Build', 'History']);
    await editor.click('#side-tabs button[data-panel="themePanel"]', 'Design tab');
    await editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
    expect(await editor.evaluate<boolean>(
      `document.getElementById('inspector').hidden === false
        && document.querySelector('#side-tabs button[data-panel="inspector"]').classList.contains('active')`,
    )).toBe(true);

    /* --- horizontal alignment -------------------------------------------- */

    const alignTitles = await eventually(async () => editor!.evaluate<string[]>(
      `[...document.querySelectorAll('${PANEL} .align-button')].map((b) => b.title)`,
    ), 'the panel never showed the text alignment buttons',
      (titles) => titles.length === 4);
    expect(alignTitles).toEqual(['Align left', 'Align centre', 'Align right', 'Justify']);

    for (const [index, align] of ['left', 'center', 'right', 'justify'].entries()) {
      await editor.click(ALIGN_BUTTON(index), `${align} alignment button`);
      const state = await eventually(async () => editor!.evaluate<{
        stored: string; painted: string; pressed: string[];
      }>(`(() => {
        const element = window.store.get().deck.slides[0].elements
          .find((candidate) => candidate.id === '${BODY_ID}');
        return {
          stored: element.align,
          painted: document.querySelector('#canvas [data-element-id="${BODY_ID}"] .text-body').style.textAlign,
          pressed: [...document.querySelectorAll('${PANEL} .align-button')]
            .map((button) => button.getAttribute('aria-pressed'))
        };
      })()`), `clicking ${align} did not take effect`, (value) => value.stored === align);
      expect(state.painted).toBe(align);
      expect(state.pressed[index]).toBe('true');
      expect(state.pressed.filter((value) => value === 'true')).toHaveLength(1);
    }

    /* --- vertical alignment ---------------------------------------------- */

    await editor.choose(VERTICAL_SELECT, 'bottom', 'vertical alignment select');
    expect(await eventually(async () => editor!.evaluate<string>(
      `document.querySelector('#canvas [data-element-id="${BODY_ID}"] .text-body').style.justifyContent`,
    ), 'vertical alignment did not repaint', (value) => value === 'flex-end')).toBe('flex-end');

    /* --- list style ------------------------------------------------------- */

    const listSelect = await editor.evaluate<string>(`(() => {
      const field = [...document.querySelectorAll('${PANEL} label.field')]
        .find((node) => node.querySelector(':scope > span')?.textContent === 'List');
      if (!field) throw new Error('no List dropdown in the panel');
      field.querySelector('select').id = 'test-list-style';
      return '#test-list-style';
    })()`);
    await editor.choose(listSelect, 'Bulleted', 'List style dropdown');
    const bulleted = await eventually(async () => editor!.evaluate<{
      html: string; items: string[];
    }>(`(() => ({
      html: window.store.get().deck.slides[0].elements
        .find((candidate) => candidate.id === '${BODY_ID}').html,
      items: [...document.querySelectorAll('#canvas [data-element-id="${BODY_ID}"] .text-body li')]
        .map((item) => item.textContent)
    }))()`), 'the list dropdown did not convert the paragraphs',
      (value) => value.items.length === 2);
    expect(bulleted.html).toBe('<ul><li>First point</li><li>Second point</li></ul>');
    // Markers must actually paint; a list that renders `list-style: none` looks
    // identical in the deck data and wrong on screen. type.css draws the
    // marker itself in the item's `::before` box (so the hanging indent is
    // exactly the marker's width), which is what counts as painting here.
    expect(await editor.evaluate<boolean>(`(() => {
      const item = document.querySelector('#canvas [data-element-id="${BODY_ID}"] .text-body li');
      if (getComputedStyle(item).listStyleType !== 'none') return true;
      const marker = getComputedStyle(item, '::before');
      const painted = marker.content !== 'none' && marker.display !== 'none'
        && parseFloat(marker.minWidth || marker.width) > 0
        && (marker.content !== '""' || marker.backgroundImage !== 'none');
      return painted;
    })()`), 'the bullet marker does not paint').toBe(true);

    /* --- paragraph spacing ------------------------------------------------ */

    const spacingInput = await editor.evaluate<string>(`(() => {
      const field = [...document.querySelectorAll('${PANEL} .field-number')]
        .find((node) => node.querySelector('span')?.textContent === 'Paragraph spacing');
      if (!field) throw new Error('no Paragraph spacing field in the panel');
      field.querySelector('input').id = 'test-paragraph-spacing';
      field.querySelector('.icon-button').id = 'test-paragraph-spacing-clear';
      return '#test-paragraph-spacing';
    })()`);
    await editor.typeInto(spacingInput, '36', 'Paragraph spacing field');
    const spaced = await eventually(async () => editor!.evaluate<{
      stored: number | null; variable: string;
    }>(`(() => {
      const node = document.querySelector('#canvas [data-element-id="${BODY_ID}"]');
      return {
        stored: window.store.get().deck.slides[0].elements
          .find((candidate) => candidate.id === '${BODY_ID}').paragraphSpacing ?? null,
        variable: node.style.getPropertyValue('--paragraph-spacing')
      };
    })()`), 'typing paragraph spacing did not take effect', (value) => value.stored === 36);
    expect(spaced.variable).toBe('36px');

    /* --- text colour, through the picker popover -------------------------- */

    await editor.click(COLOR_TRIGGER, 'text colour swatch');
    await eventually(async () => editor!.evaluate<boolean>(
      `Boolean(document.querySelector('.color-picker-popover'))`,
    ), 'the colour picker did not open');
    const swatches = await editor.evaluate<string[]>(
      `[...document.querySelectorAll('.color-picker-popover .color-picker-palette-button')]
        .map((button) => button.title)`);
    expect(swatches).toContain(THEME_SWATCH);

    await editor.click(SWATCH(THEME_SWATCH), `theme swatch ${THEME_SWATCH}`);
    expect(await eventually(async () => editor!.evaluate<string | null>(
      `window.store.get().deck.slides[0].elements
        .find((candidate) => candidate.id === '${BODY_ID}').style.color ?? null`,
    ), 'the swatch click did not colour the text',
      (value) => value === THEME_SWATCH)).toBe(THEME_SWATCH);
    expect(await editor.evaluate<string>(`getComputedStyle(
      document.querySelector('#canvas [data-element-id="${BODY_ID}"] .text-body')
    ).color`)).toBe('rgb(201, 100, 66)');

    // Clearing goes back to the colour the stylesheet paints, not to black.
    // This deck's palette lives in theme.css rather than an installed
    // themeStyle, so the picker offers the inherited value as the reset.
    await editor.click(COLOR_TRIGGER, 'text colour swatch');
    expect(await editor.evaluate<string>(`document.querySelector('${CLEAR_COLOR}').textContent`))
      .toBe('Use inherited text color');
    await editor.click(CLEAR_COLOR, 'clear text colour');
    expect(await eventually(async () => editor!.evaluate<string | null>(
      `window.store.get().deck.slides[0].elements
        .find((candidate) => candidate.id === '${BODY_ID}').style.color ?? null`,
    ), 'clearing the colour did not drop the explicit value',
      (value) => value === null)).toBeNull();
    expect(await editor.evaluate<string>(`getComputedStyle(
      document.querySelector('#canvas [data-element-id="${BODY_ID}"] .text-body')
    ).color`)).toBe('rgb(17, 24, 39)');

    await editor.click(COLOR_TRIGGER, 'text colour swatch');
    await editor.click(SWATCH(THEME_SWATCH), `theme swatch ${THEME_SWATCH}`);
    await eventually(async () => editor!.evaluate<string | null>(
      `window.store.get().deck.slides[0].elements
        .find((candidate) => candidate.id === '${BODY_ID}').style.color ?? null`,
    ), 'the colour did not come back', (value) => value === THEME_SWATCH);

    /* --- a second box keeps its own formatting ---------------------------- */

    await editor.click(ON_CANVAS(TITLE_ID), 'title text on the canvas');
    await eventually(
      async () => editor!.evaluate<string[]>(`[...window.store.get().selection]`),
      'clicking the canvas did not select the title',
      (selection) => selection.length === 1 && selection[0] === TITLE_ID,
    );
    await editor.click(ALIGN_BUTTON(1), 'centre alignment button');
    await editor.click(COLOR_TRIGGER, 'title colour swatch');
    await editor.typeInto(HEX_INPUT, '#b3261e', 'hex colour box');
    // A real click on the status bar, the way an author dismisses the popover.
    await editor.click('#status', 'status bar to dismiss the colour popover');

    const formatted = await eventually(async () => editor!.evaluate<{
      titleAlign: string; titleColor: string | null; bodyAlign: string; bodyColor: string | null;
    }>(`(() => {
      const byId = (id) => window.store.get().deck.slides[0].elements
        .find((candidate) => candidate.id === id);
      return {
        titleAlign: byId('${TITLE_ID}').align,
        titleColor: byId('${TITLE_ID}').style.color ?? null,
        bodyAlign: byId('${BODY_ID}').align,
        bodyColor: byId('${BODY_ID}').style.color ?? null
      };
    })()`), 'the title did not pick up its own formatting',
      (value) => value.titleColor === '#b3261e');
    expect(formatted).toEqual({
      titleAlign: 'center', titleColor: '#b3261e',
      bodyAlign: 'justify', bodyColor: THEME_SWATCH,
    });

    /* --- the server has all of it ---------------------------------------- */

    const live = await eventually(async () => fetchDeck(server!.port),
      'formatting did not reach the server', (value) => {
        const body = value.slides[0].elements.find((element) => element.id === BODY_ID);
        return body?.type === 'text' && body.style.color === THEME_SWATCH;
      });
    const body = live.slides[0].elements.find((element) => element.id === BODY_ID)!;
    const title = live.slides[0].elements.find((element) => element.id === TITLE_ID)!;
    expect(body).toMatchObject({
      align: 'justify',
      valign: 'bottom',
      paragraphSpacing: 36,
      html: '<ul><li>First point</li><li>Second point</li></ul>',
      style: { color: THEME_SWATCH },
    });
    expect(title).toMatchObject({ align: 'center', style: { color: '#b3261e' } });

    /* --- and the audience sees the same formatting ------------------------ */

    await editor.clickByText('#toolbar button', 'Present', 'Present');
    // The present view is mounted in a same-origin iframe over the editor, not
    // in a second window, so it has no DevTools target of its own and is read
    // through the editor's document.
    const presented = await eventually(async () => editor!.evaluate<{
      bodyAlign: string; bodyColor: string; items: number; titleAlign: string; spacing: string;
    } | null>(`(() => {
      const frame = document.querySelector('iframe[src*="present.html"]');
      const doc = frame?.contentDocument;
      const bodyNode = doc?.querySelector('[data-element-id="${BODY_ID}"]');
      const titleText = doc?.querySelector('[data-element-id="${TITLE_ID}"] .text-body');
      const bodyText = bodyNode?.querySelector('.text-body');
      if (!bodyText || !titleText) return null;
      const view = frame.contentWindow;
      return {
        bodyAlign: view.getComputedStyle(bodyText).textAlign,
        bodyColor: view.getComputedStyle(bodyText).color,
        items: bodyNode.querySelectorAll('li').length,
        titleAlign: view.getComputedStyle(titleText).textAlign,
        spacing: bodyNode.style.getPropertyValue('--paragraph-spacing')
      };
    })()`), 'the presentation did not paint the formatted deck',
      (value) => value !== null && value.items === 2);
    expect(presented).toEqual({
      bodyAlign: 'justify',
      bodyColor: 'rgb(201, 100, 66)',
      items: 2,
      titleAlign: 'center',
      spacing: '36px',
    });
  }, 90_000);
});

describe.skipIf(electronBinary)('text formatting in the collaboration browser (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});

async function fetchDeck(port: number): Promise<Deck> {
  const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${DECK_ID}`);
  if (!response.ok) throw new Error(`deck request failed (${response.status})`);
  return response.json() as Promise<Deck>;
}
