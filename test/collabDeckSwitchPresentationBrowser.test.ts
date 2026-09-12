import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { type Cdp, electronBinary, eventually } from './support/browserSession.js';
import { launchWebEditor, type WebDeckFixture, type WebEditorSession } from './support/webEditorSession.js';

/**
 * Which deck does Present actually present, with more than one open — on the
 * web client.
 *
 * The web twin of `deckSwitchPresentation.test.ts`. There, every deck lives in
 * a window of its own; here, one collaboration server hosts several decks and
 * each browser tab is on a different `?deck=` id. What must hold is the same:
 * nothing crosses between them. A tab's Present shows that tab's deck, an edit
 * in one deck never reaches another deck's editor or projector, and every tab
 * is served its own deck's assets.
 *
 * Presenting on the web mounts `present.html` in a same-origin iframe over the
 * editor (src/renderer/collab/presentOverlay.ts), so the audience rendering is
 * read through the editor tab's own document, and the show is ended the way an
 * audience ends it: a double-click on the presentation.
 *
 * Not mirrored, because the web client has no counterpart:
 * - "imports into a window of its own": the server-side import needs the
 *   Keynote sidecar and a file chooser; the desktop suite stubs both.
 * - "refuses a save that names another window's deck": the web client has no
 *   `saveDeck(dir, deck)` bridge — every write is keyed by the tab's own
 *   `?deck=` id, so there is no call that could name another deck.
 * - "brings an open presentation forward": on the web two tabs on one deck are
 *   simply two peers of the same room, which is the collaboration feature.
 * - the clipboard and Save As cases: the web client has neither the clipboard
 *   bridge nor Save As.
 */

const MARKER_ID = 'deck-marker';
const EDIT_ID = 'edit-target';

function textElement(id: string, y: number, html: string): Deck['slides'][number]['elements'][number] {
  return {
    id,
    type: 'text',
    x: 160,
    y,
    w: 1600,
    h: 240,
    rot: 0,
    z: 1,
    opacity: 1,
    class: [],
    style: {},
    html,
    align: 'center',
    valign: 'middle',
  };
}

/** A deck whose content is a marker the presentation can be read for, plus a box to type into. */
function markerDeck(title: string, marker: string): Deck {
  const deck = emptyDeck(title);
  deck.slides[0].elements.push(textElement(MARKER_ID, 300, marker));
  deck.slides[0].elements.push(textElement(EDIT_ID, 640, 'note text'));
  return deck;
}

/**
 * An SVG sized to say which deck it came from: the page can load an image
 * from its deck's asset route and measure it, which is how the client itself
 * uses these URLs.
 */
function probeSvg(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"></svg>`;
}

const THEME = [
  '.slide { background: #ffffff; color: #111111; }',
  '.element-text { font: 700 72px/1.1 Arial, sans-serif; }',
  '',
].join('\n');

function fixture(id: string, title: string, marker: string, probeSize: number): WebDeckFixture {
  return {
    id,
    deck: markerDeck(title, marker),
    themeCss: THEME,
    files: { 'assets/probe.svg': probeSvg(probeSize) },
  };
}

const PRESENT_FRAME = `document.querySelector('iframe[src*="present.html"]')`;

let session: WebEditorSession | null = null;
/** One debugger connection per tab, for as long as the browser runs. */
let alpha: Cdp | null = null;
let bravo: Cdp | null = null;

/** The `?deck=` id a tab is on, and what its own canvas shows. */
async function editorState(tab: Cdp): Promise<{ deck: string | null; marker: string | null; ready: boolean }> {
  return tab.evaluate(`({
    deck: new URLSearchParams(location.search).get('deck'),
    marker: document.querySelector('#canvas [data-element-id="${MARKER_ID}"]')?.textContent ?? null,
    ready: Boolean(document.querySelector('#canvas .slide'))
      && (document.getElementById('status')?.textContent ?? '').includes('connected as'),
  })`);
}

async function markerOf(tab: Cdp, marker: string, message: string): Promise<void> {
  await eventually(
    async () => (await editorState(tab)).marker,
    message,
    (value) => value === marker,
    30_000,
  );
}

/**
 * Open the editor on `deckId` in a second tab of the same browser and wait
 * for it to be connected and painted.
 *
 * `window.open` is scripted: a person would type the URL into a new tab, which
 * DevTools cannot do for a hidden browser. The tab carries its own user name so
 * the DevTools target can be told apart from other tabs on the same deck.
 */
async function openTab(deckId: string, userName: string): Promise<Cdp> {
  const url = `${session!.origin}/?deck=${encodeURIComponent(deckId)}&name=${encodeURIComponent(userName)}`;
  await session!.cdp.evaluate(`void window.open(${JSON.stringify(url)}, '_blank')`);
  const tab = await session!.connectTarget(
    (target) => target.url.includes(`name=${encodeURIComponent(userName)}`) && !target.url.includes('present.html'),
  );
  await eventually(
    async () => tab.evaluate<boolean>(`(() => (
      Boolean(document.querySelector('#canvas .slide'))
      && document.getElementById('status')?.textContent?.includes(${JSON.stringify(`connected as ${userName}`)}) === true
    ))()`),
    `the tab on ${deckId} did not finish connecting`,
    Boolean,
    30_000,
  );
  return tab;
}

interface Presented {
  /** The `?deck=` the presentation iframe was mounted for. */
  deck: string | null;
  marker: string | null;
  /** Everything the audience can read, for asserting what is *not* there. */
  text: string;
}

/**
 * Click Present in one tab, read what its presentation renders, then end it.
 *
 * The overlay's deck id is read back from the iframe the toolbar mounted, so
 * a presentation showing the right slides from the wrong deck cannot pass
 * either.
 */
async function present(tab: Cdp): Promise<Presented> {
  const leftOver = await tab.evaluate<boolean>(`Boolean(${PRESENT_FRAME})`);
  if (leftOver) throw new Error('a presentation from an earlier step is still up');
  await tab.clickByText('#toolbar button', 'Present', 'Present');
  try {
    // Wait for a rendered slide rather than for the expected content: a
    // presentation that comes up with the wrong deck must fail the assertion,
    // not be waited out until it happens to be right.
    return await eventually(
      async () => tab.evaluate<Presented | null>(`(() => {
        const frame = ${PRESENT_FRAME};
        const doc = frame && frame.contentDocument;
        if (!doc || !doc.querySelector('.slide')) return null;
        return {
          deck: new URL(frame.src, location.href).searchParams.get('deck'),
          marker: doc.querySelector('[data-element-id="${MARKER_ID}"]')?.textContent ?? null,
          text: doc.body.textContent ?? '',
        };
      })()`),
      'the presentation never rendered a slide',
      (value) => value !== null,
      30_000,
    ) as Presented;
  } finally {
    // A double-click on the audience surface ends an embedded presentation
    // (present.ts), which unmounts the overlay. The next Present must mount a
    // fresh one rather than find the toolbar covered by this one.
    await tab.doubleClick('iframe[src*="present.html"]', 'the presentation');
    await eventually(
      async () => tab.evaluate<boolean>(`!${PRESENT_FRAME}`),
      'the presentation did not close',
      Boolean,
      30_000,
    );
  }
}

/** The html of `elementId` on the first slide, as `deck` holds it. */
function htmlIn(deck: Deck, elementId: string): string {
  for (const element of deck.slides[0].elements) {
    if (element.id === elementId && element.type === 'text') return element.html;
  }
  return '';
}

describe.skipIf(!electronBinary)('presenting with several presentations open (web client)', () => {
  beforeAll(async () => {
    session = await launchWebEditor(
      [
        fixture('alpha', 'Alpha', 'ALPHA DECK', 8),
        fixture('bravo', 'Bravo', 'BRAVO DECK', 16),
      ],
      { userName: 'Alpha Author', tmpPrefix: 'collab-deck-switch-present-' },
    );
    alpha = session.cdp;
  }, 90_000);

  afterAll(async () => {
    await session?.close();
    session = null;
    alpha = null;
    bravo = null;
  }, 30_000);

  it('presents the deck the tab was opened on', async () => {
    await markerOf(alpha!, 'ALPHA DECK', 'the first deck is not open');
    const shown = await present(alpha!);
    expect(shown.deck).toBe('alpha');
    expect(shown.marker).toBe('ALPHA DECK');
  }, 60_000);

  it('opens a second presentation in a tab of its own', async () => {
    bravo = await openTab('bravo', 'Bravo Author');
    await markerOf(bravo, 'BRAVO DECK', 'the second tab did not show its deck');
    // The tab the author started from keeps the presentation it had.
    await markerOf(alpha!, 'ALPHA DECK', 'opening a second deck replaced the first');
    expect((await editorState(alpha!)).deck).toBe('alpha');
    expect((await editorState(bravo)).deck).toBe('bravo');
  }, 60_000);

  it('presents each tab its own deck', async () => {
    const first = await present(alpha!);
    expect(first).toMatchObject({ deck: 'alpha', marker: 'ALPHA DECK' });
    const second = await present(bravo!);
    expect(second).toMatchObject({ deck: 'bravo', marker: 'BRAVO DECK' });
    const again = await present(alpha!);
    expect(again).toMatchObject({ deck: 'alpha', marker: 'ALPHA DECK' });
  }, 90_000);

  it('creates a new presentation on the server and opens it, leaving the other tabs alone', async () => {
    // New asks for a name with `window.prompt`, then navigates the asking tab
    // to the created deck (deckPicker.ts `goTo`). The prompt is a native dialog
    // DevTools cannot answer, so it is pre-answered here — the web equivalent
    // of the desktop suite scripting its file panels. New is clicked in a tab
    // of its own so that alpha and bravo can be checked for staying put.
    const spare = await openTab('bravo', 'Spare Author');
    await spare.evaluate(`void (window.prompt = () => 'delta')`);
    const compactFile = await spare.evaluate<boolean>(`(() => {
      const control = document.querySelector('.toolbar-compact-file-action');
      return Boolean(control && getComputedStyle(control).display !== 'none');
    })()`);
    if (compactFile) {
      await spare.clickByText('.toolbar-compact-file-action > button', 'File', 'File');
      await spare.clickByText(
        '.toolbar-compact-file-action .shape-menu-item',
        'New',
        'File → New',
      );
    } else {
      await spare.clickByText('.toolbar-expanded-file-actions > button', 'New', 'New');
    }

    const listed = await eventually(
      async () => {
        const response = await fetch(`${session!.origin}/api/decks`);
        return (await response.json() as Array<{ id: string }>).map((entry) => entry.id).sort();
      },
      'the server never listed the new deck',
      (ids) => ids.includes('delta'),
      30_000,
    );
    expect(listed).toEqual(['alpha', 'bravo', 'delta']);

    await eventually(
      async () => editorState(spare),
      'New did not open the new deck',
      (state) => state.deck === 'delta' && state.ready,
      30_000,
    );
    await markerOf(alpha!, 'ALPHA DECK', 'New replaced the deck the author was working on');
    await markerOf(bravo!, 'BRAVO DECK', 'New replaced another tab\'s deck');
    expect((await editorState(alpha!)).deck).toBe('alpha');
    expect((await editorState(bravo!)).deck).toBe('bravo');

    const shown = await present(spare);
    expect(shown.deck).toBe('delta');
    expect(shown.marker).toBe(null);
  }, 90_000);

  it("keeps one deck's edits out of another deck's editor and projector", async () => {
    // An author keeps typing in one deck. Its own room follows; no other deck's
    // editor and no other deck's presentation may.
    const editable = `#canvas [data-element-id="${EDIT_ID}"] .text-content`;
    await alpha!.doubleClickText(editable, 'the note text');
    await eventually(
      async () => alpha!.evaluate<boolean>(`Boolean(document.querySelector('#canvas .editing'))`),
      'the double-click did not open a text edit',
    );
    await alpha!.typeKeys('ALPHAEDIT');
    await alpha!.key('Escape', 27);

    await eventually(
      async () => htmlIn(await session!.fetchDeck('alpha'), EDIT_ID),
      'the edit never reached its own deck on the server',
      (html) => html.includes('ALPHAEDIT'),
      30_000,
    );
    await markerOf(bravo!, 'BRAVO DECK', 'the other tab lost its deck');

    expect(htmlIn(await session!.fetchDeck('bravo'), EDIT_ID)).toBe('note text');
    const bravoStore = await bravo!.evaluate<string>(`(() => {
      for (const element of window.store.get().deck.slides[0].elements) {
        if (element.id === ${JSON.stringify(EDIT_ID)}) return element.html;
      }
      return '';
    })()`);
    expect(bravoStore).toBe('note text');

    const shown = await present(bravo!);
    expect(shown).toMatchObject({ deck: 'bravo', marker: 'BRAVO DECK' });
    expect(shown.text).not.toContain('ALPHAEDIT');
    const own = await present(alpha!);
    expect(own).toMatchObject({ deck: 'alpha', marker: 'ALPHA DECK' });
    expect(own.text).toContain('ALPHAEDIT');
  }, 90_000);

  it("serves each tab its own deck's assets", async () => {
    // Asset requests carry no tab identity, so the URL has to name the deck.
    // Same relative path in both decks, different bytes: a single server-wide
    // asset root would hand one tab the other's file.
    const measure = (tab: Cdp) => tab.evaluate<number>(`
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image.naturalWidth);
        image.onerror = () => reject(new Error('the deck asset did not load'));
        image.src = window.api.assetUrl('assets/probe.svg');
      })
    `);
    expect(await measure(alpha!)).toBe(8);
    expect(await measure(bravo!)).toBe(16);

    const urlOf = (tab: Cdp) => tab.evaluate<string>("window.api.assetUrl('assets/probe.svg')");
    expect(await urlOf(alpha!)).not.toBe(await urlOf(bravo!));
  }, 60_000);
});

describe.skipIf(electronBinary)('presenting with several presentations open (web client, skipped)', () => {
  it('needs Electron', () => {
    expect(electronBinary).toBe('');
  });
});
