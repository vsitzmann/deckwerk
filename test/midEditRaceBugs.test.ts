import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
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

/**
 * Race conditions between live text editing, deferred commits, slide
 * navigation, and remote (collaborator) transaction application.
 *
 * Every scenario is driven with real input — physical-keyboard key triples,
 * real pointer presses at viewport coordinates — against the production
 * collab client and a real collab server, exactly like the other
 * *Browser.test.ts files. A failing test here is a confirmed bug (marked
 * `// BUG:`); the control tests prove the same harness passes when the racy
 * ordering is removed.
 */

const MOD = process.platform === 'darwin' ? 4 : 2;

let workDir = '';
let server: RunningCollabServer | null = null;
let browserA: RunningBrowser | null = null;
let browserB: RunningBrowser | null = null;
let a: Cdp | null = null;
let b: Cdp | null = null;

/* ---------------------------------------------------------------- fixtures */

function textEl(
  id: string,
  html: string,
  box: { x: number; y: number; w: number; h: number },
): SlideElement {
  return {
    id, type: 'text', ...box, rot: 0, z: 1, opacity: 1,
    class: ['role-body'], style: {}, html, align: 'left', valign: 'top',
  } as SlideElement;
}

const THEME = [
  '.slide { background: #ffffff; color: #111827; }',
  '.role-body { font: 400 40px/1.3 sans-serif; }',
  '',
].join('\n');

async function makeDeck(
  decksRoot: string,
  deckId: string,
  slides: SlideElement[][],
): Promise<void> {
  const deckDir = join(decksRoot, deckId);
  await mkdir(deckDir, { recursive: true });
  const deck = emptyDeck(deckId);
  const base = deck.slides[0];
  deck.slides = slides.map((elements, i) => ({
    ...structuredClone(base),
    id: `${deckId}-slide-${i}`,
    elements,
  }));
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), THEME, 'utf8');
}

async function fetchDeck(deckId: string): Promise<Deck> {
  const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${deckId}`);
  if (!response.ok) throw new Error(`deck request failed (${response.status})`);
  return response.json() as Promise<Deck>;
}

function serverElement(deck: Deck, id: string): SlideElement | undefined {
  for (const slide of deck.slides) {
    const el = slide.elements.find((candidate) => candidate.id === id);
    if (el) return el;
  }
  return undefined;
}

/* ---------------------------------------------------------- client helpers */

/** Navigate a connected client to a deck and wait until the session is live. */
async function open(cdp: Cdp, deckId: string, name: string): Promise<void> {
  await cdp.evaluate(
    `(() => { location.href = '/?deck=${deckId}&name=${name}'; return true; })()`,
  ).catch(() => { /* the navigation tears the context down mid-call */ });
  await eventually(async () => cdp.evaluate<boolean>(`(
    document.documentElement.dataset.collabReady === 'true'
    && (document.getElementById('status')?.textContent ?? '').includes('connected as ${name}')
    && Boolean(document.querySelector('#canvas .slide'))
  )`), `${name} did not finish opening ${deckId}`, Boolean, 60_000);
  // Uncaught exceptions from event handlers (a throwing undo, a commit that
  // indexes a vanished slide) surface here rather than only in stderr.
  await cdp.evaluate(`(() => {
    window.__pageErrors = [];
    window.addEventListener('error', (event) => {
      window.__pageErrors.push(String((event.error && event.error.stack) || event.message));
    });
    window.addEventListener('unhandledrejection', (event) => {
      window.__pageErrors.push('unhandled rejection: ' + String(event.reason));
    });
    return true;
  })()`);
}

async function pageErrors(cdp: Cdp): Promise<string[]> {
  return cdp.evaluate<string[]>(`window.__pageErrors ?? []`);
}

const content = (id: string) => `#canvas [data-element-id="${id}"] .text-content`;

async function storeHtml(cdp: Cdp, id: string): Promise<string> {
  return cdp.evaluate<string>(`(() => {
    for (const slide of window.store.get().deck.slides) {
      const el = slide.elements.find((candidate) => candidate.id === '${id}');
      if (el) return el.html;
    }
    return '(element gone)';
  })()`);
}

async function storeX(cdp: Cdp, id: string): Promise<number> {
  return cdp.evaluate<number>(`(() => {
    for (const slide of window.store.get().deck.slides) {
      const el = slide.elements.find((candidate) => candidate.id === '${id}');
      if (el) return el.x;
    }
    return -1;
  })()`);
}

async function beginEditing(cdp: Cdp, id: string): Promise<void> {
  await cdp.doubleClickText(content(id), `text box ${id}`);
  await eventually(async () => cdp.evaluate<boolean>(
    `document.querySelector('${content(id)}')?.isContentEditable === true`,
  ), `double-click did not start editing ${id}`);
  await cdp.key('End', 35);
}

/** Strip word-joiner sentinels the editor inserts for typing styles. */
const clean = (html: string) => html.replaceAll('⁠', '');

/* ------------------------------------------------------------------ setup */

beforeAll(async () => {
  if (!electronBinary) return;
  workDir = await mkdtemp(join(tmpdir(), 'mid-edit-races-'));
  const decksRoot = join(workDir, 'decks');
  const clientDir = await collabClientDir();
  await mkdir(decksRoot, { recursive: true });

  await makeDeck(decksRoot, 'race-slideswitch', [
    [textEl('s1-box', '<p>Keep me</p>', { x: 160, y: 120, w: 1600, h: 220 })],
    [textEl('s2-box', '<p>Slide two</p>', { x: 160, y: 120, w: 1600, h: 220 })],
  ]);
  await makeDeck(decksRoot, 'race-slideswitch-control', [
    [textEl('c1-box', '<p>Keep me</p>', { x: 160, y: 120, w: 1600, h: 220 })],
    [textEl('c2-box', '<p>Slide two</p>', { x: 160, y: 120, w: 1600, h: 220 })],
  ]);
  await makeDeck(decksRoot, 'race-structural', [
    [textEl('x-box', '<p>Base</p>', { x: 160, y: 90, w: 1600, h: 200 })],
  ]);
  await makeDeck(decksRoot, 'race-structural-control', [
    [textEl('xc-box', '<p>Base</p>', { x: 160, y: 90, w: 1600, h: 200 })],
  ]);
  await makeDeck(decksRoot, 'race-drag', [
    [
      textEl('drag-el', '<p>Drag me</p>', { x: 200, y: 150, w: 500, h: 160 }),
      textEl('other-el', '<p>Anchor</p>', { x: 1100, y: 700, w: 600, h: 160 }),
    ],
  ]);
  await makeDeck(decksRoot, 'race-escape', [
    [textEl('esc-box', '<p>First point</p><p>Second point</p>', { x: 160, y: 120, w: 1600, h: 420 })],
  ]);
  await makeDeck(decksRoot, 'race-lww', [
    [textEl('lww-box', '<p>Base</p>', { x: 160, y: 120, w: 1600, h: 300 })],
  ]);
  await makeDeck(decksRoot, 'race-simultaneous', [
    [textEl('sim-box', '<p>First line</p><p>Second line</p>', { x: 160, y: 120, w: 1600, h: 500 })],
  ]);
  await makeDeck(decksRoot, 'race-simultaneous-point', [
    [textEl('point-box', '<p>Base</p>', { x: 160, y: 120, w: 1600, h: 400 })],
  ]);
  await makeDeck(decksRoot, 'race-undo', [
    [
      textEl('del-box', '<p>Doomed</p>', { x: 300, y: 120, w: 1300, h: 180 }),
      textEl('keep-el', '<p>Mover</p>', { x: 300, y: 650, w: 700, h: 160 }),
    ],
  ]);

  server = await startCollabServer({
    rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0,
  });

  const profileA = join(workDir, 'profile-a');
  const profileB = join(workDir, 'profile-b');
  await mkdir(profileA, { recursive: true });
  await mkdir(profileB, { recursive: true });
  browserA = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=race-slideswitch&name=Alice`, profileA,
  );
  browserB = await launchBrowser(
    `http://127.0.0.1:${server.port}/?deck=race-structural&name=Bob`, profileB,
  );
  const targetA = await findTarget(
    browserA.debugPort,
    (t) => t.url.includes('deck=race-slideswitch') && !t.url.includes('present.html'),
    browserA.log,
  );
  const targetB = await findTarget(
    browserB.debugPort,
    (t) => t.url.includes('deck=race-structural') && !t.url.includes('present.html'),
    browserB.log,
  );
  a = await Cdp.connect(targetA.webSocketDebuggerUrl!);
  b = await Cdp.connect(targetB.webSocketDebuggerUrl!);
}, 300_000);

afterAll(async () => {
  a?.close();
  a = null;
  b?.close();
  b = null;
  await stopBrowser(browserA?.process ?? null);
  browserA = null;
  await stopBrowser(browserB?.process ?? null);
  browserB = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
}, 60_000);

/* ------------------------------------------------------------------- tests */

describe.skipIf(!electronBinary)('mid-edit race conditions', () => {
  /**
   * Hypothesis 1 — SLIDE-SWITCH TEXT LOSS.
   *
   * The slide rail selects on `pointerdown` (slideRail.ts, "Selection runs on
   * pointerdown, not click"), which runs BEFORE the browser moves focus out of
   * the contenteditable. selectSlide → store emit → canvas.render() sees the
   * changed slideIndex and calls commitTextEdit() — but every text-commit
   * closure resolves its element via
   * `deck.slides[store.get().slideIndex].elements.find(...)` at commit time
   * (canvas.ts commitTextEdit / pushLive / sealTextChunk), and slideIndex now
   * points at the destination slide. The element is not found there, so the
   * commit silently returns and the in-flight text is dropped.
   */
  it('keeps in-flight text when a rail click switches slides mid-edit', {
    timeout: 120_000,
  }, async () => {
    await open(a!, 'race-slideswitch', 'Alice');
    await beginEditing(a!, 's1-box');
    await a!.typeKeys(' hello world');
    // Switch slides with a real click on the slide-2 thumbnail, immediately,
    // without blurring the text box first.
    await a!.click('#rail .rail-item[data-index="1"]', 'slide 2 thumbnail');
    await eventually(async () => a!.evaluate<number>('window.store.get().slideIndex'),
      'the rail click did not switch slides', (index) => index === 1);
    // Give trailing seals/live syncs every chance to land.
    await wait(1_200);

    // The text must not have leaked onto slide 2's element.
    const leaked = clean(await storeHtml(a!, 's2-box'));
    expect(leaked, 'typed text leaked onto the destination slide').not.toContain('hello');

    // BUG: the word typed just before the switch is silently dropped — the
    // commit closures resolve the element on the new slide and find nothing.
    const local = clean(await storeHtml(a!, 's1-box'));
    expect(local, 'slide-1 element after switching mid-edit (local store)')
      .toContain('hello world');
    const live = serverElement(await fetchDeck('race-slideswitch'), 's1-box');
    expect(clean(live && 'html' in live ? live.html : ''),
      'slide-1 element after switching mid-edit (server)').toContain('hello world');
  });

  /** Control for hypothesis 1: ending the edit before switching keeps the text. */
  it('control: text committed by Escape before the slide switch survives', {
    timeout: 120_000,
  }, async () => {
    await open(a!, 'race-slideswitch-control', 'Alice');
    await beginEditing(a!, 'c1-box');
    await a!.typeKeys(' hello world');
    await a!.key('Escape', 27); // finish(true): commit while still on slide 1
    await a!.click('#rail .rail-item[data-index="1"]', 'slide 2 thumbnail');
    await eventually(async () => a!.evaluate<number>('window.store.get().slideIndex'),
      'the rail click did not switch slides', (index) => index === 1);
    await eventually(async () => {
      const live = serverElement(await fetchDeck('race-slideswitch-control'), 'c1-box');
      return clean(live && 'html' in live ? live.html : '');
    }, 'the committed text never reached the server',
    (html) => html.includes('hello world'));
    expect(clean(await storeHtml(a!, 'c1-box'))).toContain('hello world');
  });

  /**
   * Hypothesis 2 — REMOTE STRUCTURAL EDIT EJECTS THE CARET.
   *
   * A remote structural change (peer inserts an element on the same slide)
   * fails sameStructure() in canvas.render(), which commits and ends the local
   * text-edit session and rebuilds the slide DOM. The author's caret is gone
   * mid-word and subsequent keystrokes land nowhere.
   */
  it('lets typing continue in a text box when a peer inserts an element', {
    timeout: 120_000,
  }, async () => {
    await open(a!, 'race-structural', 'Alice');
    await open(b!, 'race-structural', 'Bob');
    await beginEditing(a!, 'x-box');
    await a!.typeKeys('abc');

    // Bob inserts a new text element — a structural change on the same slide.
    await b!.clickByText('#toolbar button', 'Text', 'Text insert button');
    await eventually(async () => a!.evaluate<number>(
      'window.store.slide.elements.length',
    ), "Bob's inserted element never arrived at Alice", (count) => count === 2, 15_000);

    const editingAfterRemote = await a!.evaluate<boolean>('window.canvas.isEditing()');

    // Alice keeps typing the same word.
    await a!.typeKeys('def');
    await wait(1_200);

    const state = await a!.evaluate<{
      html: string; domText: string; editing: boolean;
    }>(`(() => {
      const el = window.store.slide.elements.find((candidate) => candidate.id === 'x-box');
      const node = document.querySelector('${content('x-box')}');
      return {
        html: el ? el.html : '(gone)',
        domText: node ? node.textContent : '(no node)',
        editing: window.canvas.isEditing(),
      };
    })()`);

    // The session must not silently die under the author's fingers.
    expect.soft(editingAfterRemote,
      "Alice's edit session was ended by Bob's unrelated structural insert").toBe(true);
    // BUG: the keystrokes typed after the remote insert land nowhere — the
    // rebuild destroyed the contenteditable and ended the session, so 'def'
    // is lost while the UI gave no signal that editing had stopped.
    const everywhere = clean(state.html) + ' ' + clean(state.domText);
    expect(everywhere, `typed text after a peer's structural edit (html=${state.html})`)
      .toContain('abcdef');
  });

  /** Control for hypothesis 2: without the remote insert both runs land. */
  it('control: two consecutive typing runs land without a concurrent peer', {
    timeout: 120_000,
  }, async () => {
    await open(a!, 'race-structural-control', 'Alice');
    await beginEditing(a!, 'xc-box');
    await a!.typeKeys('abc');
    await wait(300);
    await a!.typeKeys('def');
    await a!.key('Escape', 27);
    await eventually(async () => {
      const live = serverElement(await fetchDeck('race-structural-control'), 'xc-box');
      return clean(live && 'html' in live ? live.html : '');
    }, 'the control typing never reached the server', (html) => html.includes('abcdef'));
  });

  /**
   * Hypothesis 3 — DRAG VS REMOTE TRANSACTION.
   *
   * store.applyRemote is not gated while a drag transaction is open
   * (store.ts): the dragged element snaps back to its pre-drag position when
   * the remote deck lands, and endTransaction diffs txnBase → current, so a
   * peer's edit absorbed mid-drag is folded into the drag's undo entry —
   * undoing your own drag then also undoes the peer's concurrent edit.
   */
  it('undoing a drag leaves a peer edit absorbed mid-drag intact', {
    timeout: 180_000,
  }, async () => {
    await open(a!, 'race-drag', 'Alice');
    await open(b!, 'race-drag', 'Bob');

    // Alice presses on drag-el and moves, then HOLDS mid-drag.
    const start = await a!.evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('#canvas [data-element-id="drag-el"]').getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    const press = (type: string, x: number, y: number, buttons: number) =>
      a!.call('Input.dispatchMouseEvent', {
        type, x, y, button: 'left', buttons, clickCount: 1,
      });
    await press('mouseMoved', start.x, start.y, 0);
    await press('mousePressed', start.x, start.y, 1);
    await press('mouseMoved', start.x + 40, start.y, 1);
    await press('mouseMoved', start.x + 90, start.y, 1);
    await eventually(async () => a!.evaluate<boolean>(
      'window.store.isTransactionActive()',
    ), 'the pointer drag never opened a transaction');
    const draggedX = await storeX(a!, 'drag-el');
    expect(draggedX, 'the drag moved the element').toBeGreaterThan(200);

    // Bob nudges the other element while Alice's drag is still open.
    await b!.click('#canvas [data-element-id="other-el"]', "Bob's element");
    await eventually(async () => b!.evaluate<string[]>('[...window.store.get().selection]'),
      'Bob could not select his element',
      (sel) => sel.length === 1 && sel[0] === 'other-el');
    await b!.chord('ArrowRight', 'ArrowRight', 39, 8); // Shift+Right: +10
    await eventually(async () => storeX(b!, 'other-el'),
      "Bob's nudge did not apply locally", (x) => x === 1110);

    // Wait for Bob's transaction to be absorbed by Alice MID-DRAG.
    await eventually(async () => storeX(a!, 'other-el'),
      "Bob's nudge never arrived at Alice mid-drag", (x) => x === 1110, 15_000);
    // Snap-back observation: Alice's optimistic drag position was clobbered
    // by the remote deck (her transaction moves are local-only until release).
    const midDragX = await storeX(a!, 'drag-el');
    expect.soft(midDragX,
      'the dragged element snapped back to its pre-drag x when the remote transaction landed mid-drag')
      .toBeGreaterThan(200);

    // Alice finishes the drag with a final move and a release.
    await press('mouseMoved', start.x + 100, start.y, 1);
    await press('mouseReleased', start.x + 100, start.y, 0);
    await eventually(async () => a!.evaluate<boolean>(
      '!window.store.isTransactionActive()',
    ), 'the drag transaction never closed');
    const finalX = await eventually(async () => storeX(a!, 'drag-el'),
      'the drag did not land', (x) => x > 200);

    // (a) Bob's edit survives the drag on the server and both clients.
    await eventually(async () => {
      const live = await fetchDeck('race-drag');
      return {
        other: serverElement(live, 'other-el')?.x,
        dragged: serverElement(live, 'drag-el')?.x,
      };
    }, "the finished drag and Bob's nudge never both reached the server",
    (v) => v.other === 1110 && v.dragged === finalX, 15_000);
    expect(await storeX(b!, 'drag-el'), "Alice's drag reached Bob").toBe(finalX);

    // (b) Alice presses Cmd/Ctrl+Z: this must undo ONLY her drag.
    await a!.chord('z', 'KeyZ', 90, MOD);
    await eventually(async () => storeX(a!, 'drag-el'),
      'undo did not revert the drag', (x) => x === 200, 15_000);
    await wait(500); // let the undo transaction propagate

    // BUG: the drag's undo entry also carries the inverse of Bob's concurrent
    // nudge (endTransaction diffed txnBase → current across the absorbed
    // remote edit), so Alice's undo reverts Bob's edit everywhere.
    expect(await storeX(a!, 'other-el'),
      "Alice's undo of her own drag reverted Bob's concurrent edit (local)").toBe(1110);
    const after = await fetchDeck('race-drag');
    expect(serverElement(after, 'other-el')?.x,
      "Alice's undo of her own drag reverted Bob's concurrent edit (server)").toBe(1110);
  });

  /**
   * Hypothesis 4 — ENDING AN EDIT SESSION CLOBBERS A PEER'S EDIT TO THE BOX.
   *
   * Note on the review's framing: Escape does NOT take the revert path in
   * this codebase — the Escape handler calls finish(true), a commit, and the
   * finish(false) revert branch (which would restore the html captured at
   * beginTextEdit) is only reachable through endTextEditing(false), which no
   * shell calls. The reachable variant of the same bug: while A is editing,
   * patchChangedHtml deliberately skips the edited element, so a peer's
   * html change to that box never reaches A's live DOM — and A's whole-box
   * commit on Escape re-asserts A's stale markup over the peer's edit.
   */
  it("Escape after a peer's html edit to the same box keeps the peer's edit", {
    timeout: 120_000,
  }, async () => {
    await open(a!, 'race-escape', 'Alice');
    await open(b!, 'race-escape', 'Bob');

    await beginEditing(a!, 'esc-box');
    await a!.typeKeys(' typed');
    // Let the idle seal (600 ms) commit Alice's word so ordering is settled.
    await wait(900);
    await eventually(async () => {
      const live = serverElement(await fetchDeck('race-escape'), 'esc-box');
      return clean(live && 'html' in live ? live.html : '');
    }, "Alice's typing never reached the server", (html) => html.includes('typed'));

    // Bob converts the same box to a bulleted list from the inspector — a
    // non-editing route that rewrites the element's html.
    await b!.click('#canvas [data-element-id="esc-box"]', 'the shared box');
    await eventually(async () => b!.evaluate<string[]>('[...window.store.get().selection]'),
      'Bob could not select the box',
      (sel) => sel.length === 1 && sel[0] === 'esc-box');
    await b!.click('#side-tabs button[data-panel="inspector"]', 'Props tab');
    const listSelect = await b!.evaluate<string>(`(() => {
      const field = [...document.querySelectorAll('#inspector label.field')]
        .find((node) => node.querySelector(':scope > span')?.textContent === 'List');
      if (!field) throw new Error('no List dropdown in the panel');
      field.querySelector('select').id = 'race-list-style';
      return '#race-list-style';
    })()`);
    await b!.choose(listSelect, 'Bulleted', 'List style dropdown');
    await eventually(async () => {
      const live = serverElement(await fetchDeck('race-escape'), 'esc-box');
      return live && 'html' in live ? live.html : '';
    }, "Bob's list conversion never reached the server", (html) => html.includes('<ul>'));
    // Alice's STORE has the list now; her editing DOM deliberately does not.
    await eventually(async () => storeHtml(a!, 'esc-box'),
      "Bob's list conversion never arrived at Alice", (html) => html.includes('<ul>'), 15_000);

    // Alice presses Escape — "done editing", which commits her whole box.
    await a!.key('Escape', 27);
    await wait(1_000);

    // BUG: Alice's commit re-asserts her pre-conversion markup wholesale,
    // wiping Bob's list conversion from the server and every client.
    const final = serverElement(await fetchDeck('race-escape'), 'esc-box');
    const finalHtml = clean(final && 'html' in final ? final.html : '');
    expect.soft(finalHtml, "Alice's own typed word must survive her commit")
      .toContain('typed');
    expect(finalHtml, "Bob's concurrent list conversion after Alice's Escape commit")
      .toContain('<ul>');
  });

  /**
   * Hypothesis 5 — CONCURRENT SAME-BOX TYPING (whole-html LWW).
   *
   * Both peers may enter the same text box. Each streams its whole box html
   * every 250 ms, each side's patchChangedHtml skips the element it is
   * editing, so neither ever sees the other's characters — and the final
   * blur commits are whole-html last-writer-wins.
   */
  it('merges words typed concurrently by two peers into the same box', {
    timeout: 120_000,
  }, async () => {
    await open(a!, 'race-lww', 'Alice');
    await open(b!, 'race-lww', 'Bob');

    await beginEditing(a!, 'lww-box');
    await beginEditing(b!, 'lww-box');

    // Interleaved real typing: two runs each, with time for live sync (250 ms
    // cadence) to exchange state between the runs.
    await a!.typeKeys(' alpha');
    await wait(400);
    await b!.typeKeys(' bravo');
    await wait(400);
    await a!.typeKeys(' apple');
    await wait(400);
    await b!.typeKeys(' banana');
    await wait(400);

    await a!.key('Escape', 27);
    await wait(600);
    await b!.key('Escape', 27);
    await wait(1_000);

    const live = serverElement(await fetchDeck('race-lww'), 'lww-box');
    const html = clean(live && 'html' in live ? live.html : '');
    // BUG: whole-html LWW at 250 ms granularity, with each editor ignoring
    // remote changes to the box it is editing, silently discards one peer's
    // characters entirely.
    expect(html, 'both peers typed into the box; the server must hold both words')
      .toContain('alpha');
    expect(html, 'both peers typed into the box; the server must hold both words')
      .toContain('bravo');
  });

  /**
   * Hypothesis 5b — SIMULTANEOUS SAME-BOX TYPING.
   *
   * The test above leaves time between the runs, which a slow CI runner eats:
   * its runs then overlap, and the box came out as `Base bra a bananapplevo
   * al`. Here both people type at the same moment, as two people writing
   * into one box do. Each streams whole-box html every 250 ms, so pushes
   * cross in flight and arrive while the other side has unsent keystrokes.
   * Whole-box last-writer-wins dropped one side's characters at every
   * crossing, and the losing editor adopted the winner's html with its caret
   * at the same numeric offset — so its next keystrokes landed inside the
   * other person's word.
   */
  const ALICE_WORDS = ['alpha', 'apple', 'avocado', 'apricot'];
  const BOB_WORDS = ['bravo', 'banana', 'blueberry', 'brownie'];
  const plainText = (html: string) => clean(html)
    .replace(/<\/p>/g, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;| /g, ' ');

  async function typeAtOnce(deckId: string, boxId: string, carets: {
    alice: () => Promise<void>;
    bob: () => Promise<void>;
  }): Promise<{ server: string; alice: string; bob: string }> {
    await open(a!, deckId, 'Alice');
    await open(b!, deckId, 'Bob');
    await beginEditing(a!, boxId);
    await carets.alice();
    await beginEditing(b!, boxId);
    await carets.bob();
    // A fast typist's pace, both at once: well over a second of typing,
    // several live-sync rounds crossing in each direction.
    await Promise.all([
      a!.typeKeys(ALICE_WORDS.map((word) => ` ${word}`).join(''), 45),
      b!.typeKeys(BOB_WORDS.map((word) => ` ${word}`).join(''), 45),
    ]);
    await wait(800);
    await a!.key('Escape', 27);
    await b!.key('Escape', 27);
    const read = async () => {
      const live = serverElement(await fetchDeck(deckId), boxId);
      return {
        server: live && 'html' in live ? live.html : '',
        alice: await storeHtml(a!, boxId),
        bob: await storeHtml(b!, boxId),
      };
    };
    const settled = await eventually(read, 'the editors never converged on the server html',
      (state) => state.server !== '' && state.alice === state.server && state.bob === state.server,
      15_000).catch(read);
    expect(await pageErrors(a!)).toEqual([]);
    expect(await pageErrors(b!)).toEqual([]);
    return settled;
  }

  it('keeps both peers\' typing when they type into different lines of one box at once', {
    timeout: 120_000,
  }, async () => {
    const settled = await typeAtOnce('race-simultaneous', 'sim-box', {
      // Alice at the end of the first line, Bob at the end of the second.
      alice: async () => {
        if (process.platform === 'darwin') await a!.chord('ArrowUp', 'ArrowUp', 38, MOD);
        else await a!.chord('Home', 'Home', 36, MOD);
        await a!.key('End', 35);
      },
      bob: async () => {
        if (process.platform === 'darwin') await b!.chord('ArrowDown', 'ArrowDown', 40, MOD);
        else await b!.chord('End', 'End', 35, MOD);
      },
    });
    // BUG: one side's characters dropped wholesale, or spliced into the
    // other's words.
    expect(plainText(settled.server).trim().split('\n').map((line) => line.trim()),
      `both lines, each with its author's words (server: ${settled.server})`).toEqual([
      `First line ${ALICE_WORDS.join(' ')}`,
      `Second line ${BOB_WORDS.join(' ')}`,
    ]);
    expect(settled.alice, "Alice's editor converged on the server html").toBe(settled.server);
    expect(settled.bob, "Bob's editor converged on the server html").toBe(settled.server);
  });

  /**
   * Both carets at the very same point is the one case plain text cannot
   * fully order: each person's leading space was typed at the same spot, and
   * whose space ends up between the two runs is undecidable without
   * per-character identity. What is guaranteed: nothing typed is lost,
   * nobody's word is split by the other's letters, and everyone converges.
   */
  it('loses nothing and splits no word when two peers type at the same point at once', {
    timeout: 120_000,
  }, async () => {
    const settled = await typeAtOnce('race-simultaneous-point', 'point-box', {
      alice: async () => {},
      bob: async () => {},
    });
    const text = plainText(settled.server);
    const letters = (value: string) => value.replace(/\s/g, '').split('').sort().join('');
    // BUG: whole runs of one side's letters went missing.
    expect(letters(text), `every letter both people typed (server: ${settled.server})`)
      .toBe(letters(['Base', ...ALICE_WORDS, ...BOB_WORDS].join('')));
    for (const words of [ALICE_WORDS, BOB_WORDS]) {
      let from = 0;
      for (const word of words) {
        const at = text.indexOf(word, from);
        expect(at, `"${word}" whole and in its author's order (server: ${settled.server})`)
          .toBeGreaterThanOrEqual(0);
        from = at + word.length;
      }
    }
    expect(settled.alice, "Alice's editor converged on the server html").toBe(settled.server);
    expect(settled.bob, "Bob's editor converged on the server html").toBe(settled.server);
  });

  /**
   * Hypothesis 6 — UNDO AFTER A PEER DELETED THE EDITED ELEMENT.
   *
   * In the collab shell, Cmd/Ctrl+Z routes through CollabBridge.undo, which
   * applies inverses via applyOpsLenient (skips ops whose target is gone) —
   * so the store.undo() pop-before-throw defect flagged by the review is not
   * reachable from real input here (the desktop shell, which does bind
   * store.undo, has no remote peers to delete the element mid-history).
   * This test pins down the reachable contract: undo over a consumed entry
   * must not throw, must not corrupt the deck, and the NEXT undo must still
   * work.
   */
  it('survives undoing a text edit whose element a peer deleted', {
    timeout: 120_000,
  }, async () => {
    await open(a!, 'race-undo', 'Alice');
    await open(b!, 'race-undo', 'Bob');

    // Alice edit #1: nudge keep-el right by 10. Re-click until the selection
    // sticks: on a slow runner the element can still be settling when the
    // first click lands, or a late collab render can clear a fresh selection.
    await eventually(async () => {
      await a!.click('#canvas [data-element-id="keep-el"]', 'the element to move');
      return a!.evaluate<string[]>('[...window.store.get().selection]');
    }, 'Alice could not select keep-el',
      (sel) => sel.length === 1 && sel[0] === 'keep-el');
    await a!.chord('ArrowRight', 'ArrowRight', 39, 8);
    await eventually(async () => storeX(a!, 'keep-el'),
      "Alice's nudge did not apply", (x) => x === 310);

    // Alice edit #2: type into del-box and finish.
    await beginEditing(a!, 'del-box');
    await a!.typeKeys(' zap');
    await a!.key('Escape', 27);
    await eventually(async () => {
      const live = serverElement(await fetchDeck('race-undo'), 'del-box');
      return clean(live && 'html' in live ? live.html : '');
    }, "Alice's text never reached the server", (html) => html.includes('zap'));

    // Bob deletes the element Alice just edited.
    await b!.click('#canvas [data-element-id="del-box"]', 'the doomed box');
    await eventually(async () => b!.evaluate<string[]>('[...window.store.get().selection]'),
      'Bob could not select the doomed box',
      (sel) => sel.length === 1 && sel[0] === 'del-box');
    await b!.key('Delete', 46);
    await eventually(async () => a!.evaluate<boolean>(
      `!window.store.slide.elements.some((el) => el.id === 'del-box')`,
    ), "Bob's delete never arrived at Alice", Boolean, 15_000);

    // Alice presses undo repeatedly. The text-edit entries target a deleted
    // element; whatever the layer does with them, it must (1) never throw,
    // (2) never corrupt the deck, and (3) still reach the keep-el move.
    let reverted = false;
    for (let press = 0; press < 6 && !reverted; press += 1) {
      await a!.chord('z', 'KeyZ', 90, MOD);
      await wait(400);
      reverted = (await storeX(a!, 'keep-el')) === 300;
    }
    expect(reverted, 'undo never reached the edit before the consumed entries').toBe(true);
    // The deleted element must not have been half-resurrected.
    const finalDeck = await fetchDeck('race-undo');
    expect(serverElement(finalDeck, 'keep-el')?.x, 'the nudge undo reached the server')
      .toBe(300);
    const errors = await pageErrors(a!);
    expect(errors, 'undoing a consumed entry threw in the page').toEqual([]);
  });
});

describe.skipIf(electronBinary)('mid-edit race conditions (skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
