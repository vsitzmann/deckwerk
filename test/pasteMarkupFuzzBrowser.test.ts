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
  wait,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import { extraFuzzSeeds } from './support/fuzzSeeds.js';
import {
  contentText,
  deckSnapshotEventually,
  describeOperation,
  diffDeckSnapshots,
  enterEditing,
  markupProblems,
  PASTE_CONTENT,
  PASTE_MOD as MOD,
  PASTE_OTHER_CONTENT,
  PASTE_OTHER_HTML,
  PASTE_OTHER_ID,
  PASTE_PANEL as PANEL,
  PASTE_CORPUS,
  PASTE_TEXT_ID,
  pasteCases,
  pasteFromClipboard,
  persistedMarkupProblems,
  sameDeckSnapshot,
  SEAL_MS,
  selectionProblems,
  settledDeckSnapshot,
  tagListField,
  TARGET_FIXTURES,
  normalizeText,
  type PasteCase,
  type PasteOperation,
} from './support/pasteMarkupCorpus.js';

/**
 * Pasting is how most slide text arrives, and the markup other applications
 * put on the clipboard is nothing like what the editor writes. This fuzzes
 * that boundary: real clipboard payloads from Notes, Word, Google Docs,
 * spreadsheets, web pages and plain text, pasted at every place a caret can
 * be, each followed by a seeded run of the edits an author makes next —
 * bold/italic/underline, alignment, list conversion, typing, deleting, undo.
 *
 * After every single step the box must still be markup the editor can render
 * and format: no list inside a paragraph, no list nested straight inside a
 * list, no orphan list item, nothing unsafe, and every top-level node a block.
 * The same rules are applied to what the collaboration server persisted, so a
 * box that only looks right in the DOM cannot pass.
 */
const RUN_EXHAUSTIVE = process.env.RUN_EXHAUSTIVE_PASTE_FUZZ === '1';
const MAX_REPORTED_FAILURES = 10;
const DECK_ID = 'paste-markup-fuzz';
const EXTRA_SEEDS = extraFuzzSeeds();
const CASES = [
  ...pasteCases({
    exhaustive: RUN_EXHAUSTIVE,
    // Cover the WHOLE corpus in the default gate: a sample of 12 walked
    // payload[index % 16], so the last four corpus entries never ran at all
    // outside the exhaustive matrix.
    sample: PASTE_CORPUS.length,
    operationsPerCase: RUN_EXHAUSTIVE ? 8 : 5,
  }),
  // The fixed seed above is the regression corpus; FUZZ_SEED (CI's nightly
  // exports the current date) adds one whole extra case-set per extra seed.
  ...EXTRA_SEEDS.flatMap((seed) => pasteCases({
    exhaustive: false,
    sample: PASTE_CORPUS.length,
    operationsPerCase: 5,
    seed,
  })),
];

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('pasted markup survives being edited', () => {
  it('pastes real clipboard payloads everywhere and keeps the box formattable', {
    timeout: RUN_EXHAUSTIVE ? 60 * 60_000 : 300_000 * (1 + EXTRA_SEEDS.length),
  }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'paste-markup-fuzz-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });

    const deck = emptyDeck('Paste markup fuzz');
    deck.themePreset = 'basic';
    deck.slides[0].elements.push({
      id: PASTE_TEXT_ID,
      type: 'text',
      x: 100, y: 100, w: 1720, h: 820,
      rot: 0, z: 1, opacity: 1,
      class: ['role-body'],
      style: {},
      html: '<p>Text</p>',
      align: 'left',
      valign: 'top',
    } as never);
    // A second committed textbox: cross-box selection and editing bugs are
    // unreachable in a single-textbox fixture.
    deck.slides[0].elements.push({
      id: PASTE_OTHER_ID,
      type: 'text',
      x: 100, y: 950, w: 900, h: 110,
      rot: 0, z: 2, opacity: 1,
      class: ['role-body'],
      style: {},
      html: PASTE_OTHER_HTML,
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
      `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Paste%20Fuzz`, profileDir,
    );
    const target = await findTarget(
      browser.debugPort,
      (candidate) => candidate.url.includes(`deck=${DECK_ID}`),
      browser.log,
    );
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    // Bare Xvfb has no window manager to grant the Electron window input
    // focus. Clipboard writes can still resolve in that state while the
    // following native paste command lands nowhere, leaving the fixture text
    // unchanged. Keep this target focused the same way the dedicated
    // clipboard browser suite does.
    await editor.call('Emulation.setFocusEmulationEnabled', { enabled: true });
    await editor.call('Page.bringToFront');
    await editor.evaluate('window.focus()');
    await eventually(async () => editor!.evaluate<boolean>(`(
      document.getElementById('status')?.textContent?.includes('connected as Paste Fuzz') === true
      && Boolean(document.querySelector('${PASTE_CONTENT}'))
    )`), 'the paste-fuzz browser did not finish connecting');
    await editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');

    console.log(`running ${CASES.length} paste cases (${EXTRA_SEEDS.length} extra seed(s): `
      + `${EXTRA_SEEDS.join(', ') || 'none'})`);
    // PASTE_FUZZ_ONLY="spreadsheet-table → placeholder" narrows the walk to
    // the cases whose "payload → target" label contains the text: the way to
    // replay one failing case from a CI log without the hour around it.
    const only = process.env.PASTE_FUZZ_ONLY ?? '';
    // Every case runs, whatever the ones before it found. Stopping at the
    // first failure made each night report one bug and hide the rest behind
    // it until that one was fixed — a queue drained one nightly at a time.
    // A fixture that has died fails every case the same way; the cap keeps
    // that from being an hour of identical noise.
    const failures: string[] = [];
    for (const testCase of CASES) {
      if (only && !`${testCase.payload.name} → ${testCase.target}`.includes(only)) continue;
      try {
        await runPasteCase(editor, server.port, testCase);
      } catch (error) {
        // Fixture-level failures (entering editing, resetting the box) name no
        // case: ten of them were a whole nightly's report, with nothing to
        // replay. Every message says which case it came from.
        const where = `${testCase.payload.name} → ${testCase.target}`;
        const raw = error instanceof Error ? error.message : String(error);
        const message = raw.startsWith(where) ? raw : `${where}: ${raw}`;
        failures.push(message);
        console.error(`[paste-fuzz] failing case ${failures.length}: ${message}`);
        if (failures.length >= MAX_REPORTED_FAILURES) break;
      }
    }
    if (failures.length > 0) {
      expect.fail(`${failures.length} paste case(s) failed`
        + `${failures.length >= MAX_REPORTED_FAILURES ? ' (walk stopped at the cap)' : ''}:\n\n`
        + failures.join('\n\n'));
    }
  });
});

describe.skipIf(electronBinary)('pasted markup survives being edited (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});

/* ------------------------------------------------------------------------ *
 * Minimised from the seeded walk: the undo-restoration oracle's first find.
 * ------------------------------------------------------------------------ */

/** The same editor fixture the walk uses, for the minimised repros. */
async function startPasteFixture(): Promise<{ cdp: Cdp; port: number }> {
  workDir = await mkdtemp(join(tmpdir(), 'paste-markup-min-'));
  const decksRoot = join(workDir, 'decks');
  const deckDir = join(decksRoot, DECK_ID);
  const clientDir = await collabClientDir();
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(deckDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  const deck = emptyDeck('Paste markup fuzz');
  deck.themePreset = 'basic';
  deck.slides[0].elements.push({
    id: PASTE_TEXT_ID, type: 'text', x: 100, y: 100, w: 1720, h: 820,
    rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
    html: '<p>Text</p>', align: 'left', valign: 'top',
  } as never, {
    id: PASTE_OTHER_ID, type: 'text', x: 100, y: 950, w: 900, h: 110,
    rot: 0, z: 2, opacity: 1, class: ['role-body'], style: {},
    html: PASTE_OTHER_HTML, align: 'left', valign: 'top',
  } as never);
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), [
    '.slide { background: #fff; color: #111827; }',
    '.role-body { font: 400 28px/1.35 sans-serif; }',
    '',
  ].join('\n'), 'utf8');
  server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
  browser = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Paste%20Fuzz`, profileDir);
  const target = await findTarget(browser.debugPort,
    (candidate) => candidate.url.includes(`deck=${DECK_ID}`), browser.log);
  editor = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(async () => editor!.evaluate<boolean>(
    `Boolean(document.querySelector('${PASTE_CONTENT}'))`), 'the fixture never loaded');
  await editor.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
  return { cdp: editor, port: server.port };
}

/** Type into a `target` fixture, seal, then check one undo and one redo. */
async function typeSealAndUndo(
  cdp: Cdp,
  port: number,
  target: PasteCase['target'],
  label: string,
): Promise<void> {
  await resetFixture(cdp, target);
  await enterEditing(cdp, PASTE_CONTENT);
  await wait(SEAL_MS);
  const before = await settledDeckSnapshot(cdp, port, DECK_ID, `${label}: pre-op`);
  await caretAtEnd(cdp);
  await cdp.typeKeys('zzq');
  await wait(SEAL_MS);
  const after = await settledDeckSnapshot(cdp, port, DECK_ID, `${label}: post-op`);
  expect(sameDeckSnapshot(before, after), `${label}: typing persisted`).toBe(false);
  await cdp.chord('z', 'KeyZ', 90, MOD);
  const undone = await deckSnapshotEventually(cdp, port, DECK_ID, before);
  if (!sameDeckSnapshot(undone, before)) {
    expect.fail(`${label}: one undo after a sealed typing run did not restore the pre-op deck\n`
      + diffDeckSnapshots(before, undone));
  }
  await cdp.chord('z', 'KeyZ', 90, MOD | 8);
  const redone = await deckSnapshotEventually(cdp, port, DECK_ID, after);
  if (!sameDeckSnapshot(redone, after)) {
    expect.fail(`${label}: redo did not re-reach the post-op deck\n`
      + diffDeckSnapshots(after, redone));
  }
}

describe.skipIf(!electronBinary)('minimised undo restoration bugs (paste fixture)', () => {
  // BUG: in a box carrying the `placeholder` class, Cmd/Ctrl+Z after a sealed
  // typing run restores nothing — undo is jammed. The idle seal commits the
  // run and bumps the session's coalesce key; the finish that Cmd/Cmd+Z's own
  // handler triggers (canvas.ts commitTextEdit) then commits the
  // placeholder-class strip as a separate entry under the *new* key. Undo
  // pops only that invisible class change, the handler re-enters editing, and
  // the next Cmd/Ctrl+Z finishes again, re-stripping the class — so no number
  // of undo presses ever reaches the typing. Found by the walk's restoration
  // oracle (seed 20260831, apple-notes-bullets → placeholder); the fuzz walk
  // above stays red on this case for the same reason.
  it('BUG: undo after a sealed typing run in a placeholder box restores nothing', {
    timeout: 180_000,
  }, async () => {
    const { cdp, port } = await startPasteFixture();
    await typeSealAndUndo(cdp, port, 'placeholder', 'placeholder box');
  });

  // Guard: the identical sequence in a plain committed box restores exactly.
  // This passing test pins the boundary of the bug above to the placeholder
  // class handling.
  it('guard: undo after a sealed typing run in a plain box restores exactly', {
    timeout: 180_000,
  }, async () => {
    const { cdp, port } = await startPasteFixture();
    await typeSealAndUndo(cdp, port, 'caret-at-end', 'plain box');
  });
});

async function runPasteCase(cdp: Cdp, port: number, testCase: PasteCase): Promise<void> {
  const { payload, target, operations } = testCase;
  const where = `${payload.name} → ${target}`;
  await resetFixture(cdp, target);
  await enterEditing(cdp, PASTE_CONTENT);
  await placeCaret(cdp, target);

  const beforePaste = await contentText(cdp, PASTE_CONTENT);
  await pasteFromClipboard(cdp, payload);
  if (payload.expected.length > 0) {
    await eventually(async () => contentText(cdp, PASTE_CONTENT),
      `${where}: pasted text never appeared`,
      (text) => payload.expected.every((fragment) => text.includes(normalizeText(fragment))));
  } else {
    // A whitespace-only paste must still leave the box intact.
    await eventually(async () => contentText(cdp, PASTE_CONTENT),
      `${where}: the box lost its own text`, (text) => text.length >= 0);
  }
  expect(beforePaste, `${where}: paste did nothing`).not.toBe(undefined);
  await checkBox(cdp, port, `${where}: after the paste`);
  if (payload.math) await assertPastedMathRenders(cdp, payload, where);

  for (const operation of operations) {
    const label = `${where}: after ${describeOperation(operation)}`;
    const before = await contentText(cdp, PASTE_CONTENT);
    if (operation.kind === 'undo') {
      // The restoration oracle replaces the old fire-and-forget Cmd/Ctrl+Z:
      // undo must actually restore the previous state, and redo re-reach it.
      await runUndoCheckpoint(cdp, port, label);
      await checkBox(cdp, port, label);
      continue;
    }
    try {
      await applyOperation(cdp, operation);
    } catch (error) {
      // The harness's own failures ("cannot click …") name no case; on CI
      // that left a Linux-only failure with nothing to reproduce from.
      const html = await cdp.evaluate<string>(
        `document.querySelector('${PASTE_CONTENT}')?.innerHTML ?? '(no box)'`,
      ).catch(() => '(unreadable)');
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}\n`
        + `box before the operation: ${JSON.stringify(before)}\nbox now: ${html}`);
    }
    await checkBox(cdp, port, label);
    const after = await contentText(cdp, PASTE_CONTENT);
    if (operation.kind === 'cross-box' || operation.kind === 'escape-reenter') {
      expect(after, `${label}: the excursion changed the main box`).toBe(before);
    }
    if (operation.kind === 'inline' || operation.kind === 'align' || operation.kind === 'list') {
      // Formatting rearranges markup; it must never rewrite the words. A list
      // conversion collapses the blank lines a bullet list cannot hold, so
      // compare the words rather than the exact spacing.
      expect(words(after), `${label}: formatting changed the text`).toEqual(words(before));
    }
    if (operation.kind === 'type' || operation.kind === 'split') {
      // Whitespace depends on where the caret sat and whether Enter opened a
      // new block, so compare with spacing removed. This still catches a
      // keystroke landing twice ("42" arriving as "4422") and text going
      // missing, which is what these operations can actually get wrong.
      const typed = compact(operation.text);
      expect(compact(after).length, `${label}: characters inserted`)
        .toBe(compact(before).length + typed.length);
      expect(occurrences(compact(after), typed), `${label}: copies of the typed run`)
        .toBe(occurrences(compact(before), typed) + 1);
    }
    if (operation.kind === 'delete' || operation.kind === 'delete-word') {
      expect(after.length, `${label}: deletion removed nothing`)
        .toBeLessThanOrEqual(before.length);
    }
  }
}

/** A copied equation must persist as TeX source and become KaTeX again on exit. */
async function assertPastedMathRenders(
  cdp: Cdp,
  payload: PasteCase['payload'],
  label: string,
): Promise<void> {
  const equations = payload.math ?? [];
  await cdp.evaluate('window.canvas.endTextEditing(true)');
  await eventually(async () => cdp.evaluate<number>(
    `document.querySelectorAll('${PASTE_CONTENT} .katex').length`,
  ), `${label}: pasted equations did not render`, (count) => count >= equations.length);
  const displays = equations.filter((equation) => equation.display).length;
  expect(await cdp.evaluate<number>(
    `document.querySelectorAll('${PASTE_CONTENT} .katex-display').length`,
  ), `${label}: display equation did not stay display math`).toBe(displays);
  await enterEditing(cdp, PASTE_CONTENT);
  const source = await cdp.evaluate<string>(
    `document.querySelector('${PASTE_CONTENT}')?.innerHTML ?? ''`,
  );
  for (const equation of equations) {
    const delimiter = equation.display ? `$$${equation.tex}$$` : `$${equation.tex}$`;
    expect(source, `${label}: authored TeX source survived`).toContain(delimiter);
  }
}

/** Fixture setup only: the interactions under test are all real input. */
async function resetFixture(cdp: Cdp, target: PasteCase['target']): Promise<void> {
  const fixture = TARGET_FIXTURES[target];
  // Leave editing first: the canvas deliberately does not patch the element
  // being edited, so a fixture written underneath it would never render.
  if (await cdp.evaluate<boolean>(
    `document.querySelector('${PASTE_CONTENT}')?.isContentEditable === true`,
  )) {
    // This is fixture setup, so the edit ends through the canvas rather than
    // by keystroke. Escape only works with the box focused, and after the
    // previous case focus can sit anywhere — a panel select, a menu — where
    // twenty Escapes ended nothing ("Escape did not leave text editing" was a
    // nightly's whole result). The real Escape path is covered by the
    // escape-reenter operation, which is under test.
    await cdp.evaluate(`window.canvas.endTextEditing(true)`);
    await eventually(async () => cdp.evaluate<boolean>(
      `document.querySelector('${PASTE_CONTENT}')?.isContentEditable !== true`,
    ), 'the canvas did not leave text editing');
  }
  await cdp.evaluate(`(() => {
    const store = window.store;
    store.commit((deck) => {
      const element = deck.slides[0].elements.find((candidate) => candidate.id === ${JSON.stringify(PASTE_TEXT_ID)});
      element.html = ${JSON.stringify(fixture.html)};
      element.class = ${JSON.stringify(fixture.classes)};
      element.align = 'left';
      delete element.table;
      const other = deck.slides[0].elements.find((candidate) => candidate.id === ${JSON.stringify(PASTE_OTHER_ID)});
      other.html = ${JSON.stringify(PASTE_OTHER_HTML)};
    }, { label: 'Paste fuzz fixture' });
    return true;
  })()`);
  await eventually(async () => cdp.evaluate<boolean>(
    `document.querySelector('${PASTE_CONTENT}')?.innerHTML.includes(${JSON.stringify(
      fixture.html.slice(0, 20).replace(/<[^>]*$/, ''),
    )}) === true`,
    ), 'the fixture markup did not render');
}

async function placeCaret(cdp: Cdp, target: PasteCase['target']): Promise<void> {
  switch (target) {
    case 'placeholder':
      await cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      return;
    case 'caret-at-end':
      await cdp.clickTextAtOffset(PASTE_CONTENT, 5, 'first line');
      await cdp.key('End', 35);
      return;
    case 'inside-word':
      await cdp.clickTextAtOffset(PASTE_CONTENT, 6, 'middle of a word');
      return;
    case 'over-selection':
      await cdp.dragSelectFirstWord(PASTE_CONTENT, 'first word');
      return;
    case 'inside-list-item':
      await cdp.clickTextAtOffset(PASTE_CONTENT, 20, 'second list item');
      return;
    case 'inside-table-cell':
      await cdp.click(`${PASTE_CONTENT} tbody tr:first-child td:nth-child(2)`, 'table cell B');
      return;
  }
}

async function applyOperation(cdp: Cdp, operation: PasteOperation): Promise<void> {
  // Deleting can empty the box, and there is then no word to select: those
  // operations have nothing to act on rather than something to get wrong.
  if ((operation.kind === 'inline' || operation.kind === 'delete-word')
    && !(await contentText(cdp, PASTE_CONTENT)).trim()) return;
  switch (operation.kind) {
    case 'list': {
      await cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      const field = await tagListField(cdp);
      await cdp.choose(field, operation.style, `list ${operation.style}`);
      return;
    }
    case 'inline': {
      await cdp.dragSelectFirstWord(PASTE_CONTENT, 'first word');
      if (operation.route === 'shortcut') {
        const key = operation.format === 'bold' ? 'b' : operation.format === 'italic' ? 'i' : 'u';
        await cdp.chord(key, `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), MOD);
        return;
      }
      const label = operation.format === 'bold'
        ? 'Bold (Cmd/Ctrl+B)'
        : operation.format === 'italic' ? 'Italic (Cmd/Ctrl+I)' : 'Underline (Cmd/Ctrl+U)';
      await cdp.click(`${PANEL} button[aria-label="${label}"]`, label);
      return;
    }
    case 'align': {
      await cdp.chord('a', 'KeyA', 65, MOD, ['selectAll']);
      const index = { left: 1, center: 2, right: 3, justify: 4 }[operation.alignment];
      await cdp.click(`${PANEL} .align-button:nth-of-type(${index})`, `align ${operation.alignment}`);
      return;
    }
    case 'type': {
      await caretAtEnd(cdp);
      await cdp.typeKeys(operation.text);
      return;
    }
    case 'delete': {
      await caretAtEnd(cdp);
      for (let press = 0; press < operation.characters; press += 1) {
        await cdp.key('Backspace', 8);
      }
      return;
    }
    case 'delete-word': {
      await cdp.dragSelectFirstWord(PASTE_CONTENT, 'first word');
      await cdp.key('Backspace', 8);
      return;
    }
    case 'split': {
      await caretAtEnd(cdp);
      await cdp.key('Enter', 13);
      await cdp.typeKeys(operation.text);
      return;
    }
    case 'undo':
      throw new Error('the undo operation runs through runUndoCheckpoint');
    case 'cross-box': {
      // Straight into the other box — no Escape first — type a nonce that must
      // land ONLY there, then straight back into the main box.
      if (!(await contentText(cdp, PASTE_CONTENT)).trim()) return;
      const nonce = nextNonce();
      await enterEditing(cdp, PASTE_OTHER_CONTENT);
      await cdp.key('End', 35);
      await cdp.typeKeys(nonce);
      expect(await contentText(cdp, PASTE_OTHER_CONTENT), `nonce ${nonce} landed in the other box`)
        .toContain(nonce);
      expect(await contentText(cdp, PASTE_CONTENT), `nonce ${nonce} stayed out of the main box`)
        .not.toContain(nonce);
      await enterEditing(cdp, PASTE_CONTENT);
      return;
    }
    case 'escape-reenter': {
      if (!(await contentText(cdp, PASTE_CONTENT)).trim()) return;
      // Focus may sit in the inspector, where Escape means something else.
      await cdp.click(PASTE_CONTENT, 'the text box before Escape');
      await cdp.key('Escape', 27);
      await eventually(async () => cdp.evaluate<boolean>(
        `document.querySelector('${PASTE_CONTENT}')?.isContentEditable !== true`,
      ), 'Escape did not leave text editing');
      await enterEditing(cdp, PASTE_CONTENT);
      return;
    }
  }
}

/** A nonce no other step has typed anywhere, so "landed only there" is exact. */
let nonceCounter = 0;
function nextNonce(): string {
  nonceCounter += 1;
  return `nx${nonceCounter}q`;
}

/**
 * The undo-restoration oracle, at a sealed boundary: pause past the idle seal,
 * settle the persisted deck, run one sealed typing run (a documented single
 * undo step), settle again, then demand that one Cmd/Ctrl+Z restores the whole
 * pre-op deck exactly and one Cmd/Ctrl+Shift+Z re-reaches the post-op deck.
 */
async function runUndoCheckpoint(cdp: Cdp, port: number, label: string): Promise<void> {
  await wait(SEAL_MS);
  const before = await settledDeckSnapshot(cdp, port, DECK_ID, `${label}: pre-op`);
  const nonce = nextNonce();
  try {
    await caretAtEnd(cdp);
  } catch {
    // An emptied box has no glyph to click; the box itself still takes a caret.
    await cdp.click(PASTE_CONTENT, 'the box (glyph fallback)');
  }
  await cdp.typeKeys(nonce);
  await wait(SEAL_MS);
  const after = await settledDeckSnapshot(cdp, port, DECK_ID, `${label}: post-op`);
  if (sameDeckSnapshot(before, after)) {
    // Typing landed nowhere persistable (e.g. the caret had nothing to hold
    // on to); there is no entry to undo, so there is nothing to check.
    return;
  }
  await cdp.chord('z', 'KeyZ', 90, MOD);
  const undone = await deckSnapshotEventually(cdp, port, DECK_ID, before);
  if (!sameDeckSnapshot(undone, before)) {
    expect.fail(`${label}: one undo after typing ${JSON.stringify(nonce)} did not restore `
      + `the pre-op deck\n${diffDeckSnapshots(before, undone)}`);
  }
  await cdp.chord('z', 'KeyZ', 90, MOD | 8);
  const redone = await deckSnapshotEventually(cdp, port, DECK_ID, after);
  if (!sameDeckSnapshot(redone, after)) {
    expect.fail(`${label}: redo after the undo did not re-reach the post-op deck\n`
      + diffDeckSnapshots(after, redone));
  }
}

async function caretAtEnd(cdp: Cdp): Promise<void> {
  const offset = await cdp.evaluate<number>(`(() => {
    const text = document.querySelector('${PASTE_CONTENT}')?.textContent ?? '';
    for (let index = text.length - 1; index >= 0; index -= 1) {
      if (!/[\\s\\u2060]/.test(text[index])) return index;
    }
    return -1;
  })()`);
  if (offset < 0) {
    // Earlier edits can legitimately empty the box (a drag-selected "first
    // word" that covered the whole of a short list, then Backspace). There is
    // no character to click then; the box itself is the target, and the walk
    // carries on typing into it.
    await cdp.click(PASTE_CONTENT, 'empty box');
  } else {
    await cdp.clickTextAtOffset(PASTE_CONTENT, offset, 'last visible character');
  }
  await cdp.key('End', 35);
}

/** Every rule, against the live DOM and against what the server persisted. */
async function checkBox(cdp: Cdp, port: number, label: string): Promise<void> {
  const live = await markupProblems(cdp, PASTE_CONTENT);
  if (live.length > 0) {
    const html = await cdp.evaluate<string>(`document.querySelector('${PASTE_CONTENT}')?.innerHTML ?? ''`);
    expect(live, `${label}: live markup — ${html}`).toEqual([]);
  }
  const otherLive = await markupProblems(cdp, PASTE_OTHER_CONTENT);
  expect(otherLive, `${label}: the other box's live markup`).toEqual([]);
  expect(
    await cdp.evaluate<boolean>(`document.querySelector('${PASTE_CONTENT}')?.isContentEditable === true`),
    `${label}: the box stopped being editable`,
  ).toBe(true);
  expect(
    await cdp.evaluate<boolean>(`window.__pasteOwned === true`),
    `${label}: pasted script ran`,
  ).toBe(false);
  expect(await selectionProblems(cdp), `${label}: selection/editing invariants`).toEqual([]);

  const persisted = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/deck?deck=${DECK_ID}`);
    const live = await response.json() as Deck;
    const element = live.slides[0].elements.find((candidate) => candidate.id === PASTE_TEXT_ID);
    return element && element.type === 'text' ? element.html : null;
  }, `${label}: the element left the server`, (html) => typeof html === 'string');
  const stored = await persistedMarkupProblems(cdp, persisted!);
  if (stored.length > 0) {
    expect(stored, `${label}: persisted markup — ${persisted}`).toEqual([]);
  }
}

function compact(value: string): string {
  return normalizeText(value).replace(/\s+/g, '');
}

function occurrences(haystack: string, needle: string): number {
  return needle ? haystack.split(needle).length - 1 : 0;
}

function words(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}
