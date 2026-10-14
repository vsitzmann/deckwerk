// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import type { ClipboardWriteRequest } from '../src/shared/clipboard.js';
import type { ClipboardActions, ShellDeps } from '../src/renderer/editor/shellWiring.js';

/**
 * Copy in one browser tab, paste in another — another deck on the same
 * server, or the same deck after a reload. Reported: "you can't copy-paste
 * images between slideshows". The in-page copy lived in module memory, which
 * a second tab (and opening a deck, which reloads the page) never sees, and
 * even had it survived, its `assets/…` srcs named files of the deck it came
 * from.
 *
 * Each "tab" here is a fresh instance of the editor modules (the in-page
 * clipboard is module state) over the same fake server, which plays the
 * parts collabServer.ts plays for real: it keeps parked copies, and it copies
 * a deck's asset into another deck only if the file is there to copy.
 * test/collabCrossDeckPasteBrowser.test.ts drives the real server and client.
 */

interface FakeServer {
  stash: Map<string, { deck: string; body: string }>;
  /** `<deck>/<src>` for every asset file that exists. */
  files: Set<string>;
  imports: string[];
}

let server: FakeServer;

beforeEach(() => {
  server = { stash: new Map(), files: new Set(), imports: [] };
});

/** What netApi.ts installs as `window.api` for a tab open on `deckId`. */
function netApi(deckId: string) {
  return {
    stashClipboard: async (id: string, request: ClipboardWriteRequest) => {
      server.stash.set(id, { deck: deckId, body: JSON.stringify(request) });
    },
    fetchClipboard: async (id: string) => {
      const entry = server.stash.get(id);
      return entry ? { sourceDeck: entry.deck, request: JSON.parse(entry.body) as unknown } : null;
    },
    importDeckAsset: async (sourceDeck: string, src: string) => {
      if (sourceDeck === deckId) return src;
      server.imports.push(`${sourceDeck}/${src}`);
      if (!server.files.has(`${sourceDeck}/${src}`)) return null;
      const name = src.slice(src.lastIndexOf('/') + 1).replace(/(\.[a-z0-9]+)$/i, '.c0ffee00$1');
      server.files.add(`${deckId}/assets/${name}`);
      return `assets/${name}`;
    },
  };
}

async function openTab(deckId: string, deck: Deck) {
  vi.resetModules();
  const editor = await import('../src/renderer/editor/store.js');
  const shell = await import('../src/renderer/editor/shellWiring.js');
  (window as unknown as { api: unknown }).api = netApi(deckId);
  const store = new editor.EditorStore(deck, `(collab) ${deckId}`);
  return { editor, shell, store, activate: () => {
    (window as unknown as { api: unknown }).api = netApi(deckId);
  } };
}

function sourceDeck(): Deck {
  return parseDeck({
    version: 1,
    title: 'Source',
    slides: [{
      id: 'slide-a',
      background: { color: null, image: 'assets/bg.png' },
      elements: [
        { id: 'text-a', type: 'text', x: 0, y: 0, w: 400, h: 100, html: 'Hello' },
        { id: 'image-a', type: 'image', x: 100, y: 120, w: 300, h: 200, src: 'assets/fig.png' },
        {
          id: 'video-a', type: 'video', x: 500, y: 120, w: 640, h: 360,
          src: 'assets/clip.mp4', poster: 'assets/poster.jpg',
        },
        { id: 'web-a', type: 'web', x: 100, y: 600, w: 400, h: 300, src: 'assets/web/chart.1234abcd.html' },
      ],
      timeline: [{
        id: 't-a',
        trigger: { on: 'click', ref: null, delay: 0 },
        action: { type: 'appear', target: 'image-a', value: null },
      }],
    }],
  });
}

function destinationDeck(): Deck {
  return parseDeck({
    version: 1,
    title: 'Destination',
    slides: [{ id: 'slide-b', elements: [], timeline: [] }],
  });
}

function addFiles(deck: string, ...srcs: string[]): void {
  for (const src of srcs) server.files.add(`${deck}/${src}`);
}

describe('pasting a browser copy into another tab', () => {
  it('pastes an image copied in another deck, with the image copied into this deck', async () => {
    addFiles('talk-a', 'assets/fig.png');
    const a = await openTab('talk-a', sourceDeck());
    a.store.select(['image-a']);
    expect(await a.editor.copySelectionToClipboard(a.store)).toBe(1);
    // What the copy left on the OS clipboard: nothing but its token.
    const token = a.editor.inAppClipboardToken()!;
    expect(token.startsWith(a.editor.IN_APP_CLIPBOARD_TOKEN_PREFIX)).toBe(true);

    // Deck B opens in a page of its own; its in-page clipboard is empty.
    const b = await openTab('talk-b', destinationDeck());
    const status: string[] = [];
    const clipboard = b.shell.createClipboardActions({
      store: b.store, rail: {}, setStatusMessage: (text: string) => status.push(text),
    } as unknown as ShellDeps) as ClipboardActions;
    b.shell.bindEditorKeys({
      store: b.store, rail: {}, save: vi.fn(), setStatusMessage: vi.fn(),
      canvas: { isEditing: () => false },
    } as unknown as ShellDeps, clipboard);

    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? token : ''), items: [] },
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    await vi.waitFor(() => expect(b.store.get().deck.slides[0].elements).toHaveLength(1));
    const [pasted] = b.store.get().deck.slides[0].elements as Array<Extract<SlideElement, { type: 'image' }>>;
    expect(pasted).toMatchObject({ type: 'image', x: 100, y: 120, src: 'assets/fig.c0ffee00.png' });
    expect(pasted.id).not.toBe('image-a');
    expect(server.files.has(`talk-b/${pasted.src}`)).toBe(true);
    // Its build came along, retargeted at the new id.
    expect(b.store.get().deck.slides[0].timeline).toMatchObject([{ action: { target: pasted.id } }]);
    await vi.waitFor(() => expect(status).toContain('Pasted 1 element.'));
  });

  it('pastes whole slides from another deck with every file they show', async () => {
    addFiles('talk-a', 'assets/bg.png', 'assets/fig.png', 'assets/clip.mp4', 'assets/poster.jpg',
      'assets/web/chart.1234abcd.html');
    const a = await openTab('talk-a', sourceDeck());
    a.store.selectSlide(0);
    expect(await a.editor.copySlidesToClipboard(a.store)).toBe(1);
    const token = a.editor.inAppClipboardToken()!;

    const b = await openTab('talk-b', destinationDeck());
    const id = b.editor.stashedClipboardId(token)!;
    expect(id).toBeTruthy();
    expect(await b.editor.pasteStashedClipboard(b.store, id)).toEqual({ kind: 'slides', count: 1 });
    const slide = b.store.get().deck.slides[1];
    expect(slide.background.image).toBe('assets/bg.c0ffee00.png');
    expect(slide.elements.map((el) => ('src' in el ? el.src : null))).toEqual([
      null, 'assets/fig.c0ffee00.png', 'assets/clip.c0ffee00.mp4', 'assets/chart.1234abcd.c0ffee00.html',
    ]);
    expect(slide.elements[2]).toMatchObject({ poster: 'assets/poster.c0ffee00.jpg' });
  });

  it('leaves out what could not be brought over, pastes the rest, and says so', async () => {
    // The picture and the poster are gone from deck A (or this person may no
    // longer see it): neither may paste pointing at a file deck B lacks, or
    // at a different file B happens to keep under the same name.
    addFiles('talk-a', 'assets/clip.mp4');
    addFiles('talk-b', 'assets/fig.png');
    const a = await openTab('talk-a', sourceDeck());
    a.store.select(['text-a', 'image-a', 'video-a']);
    await a.editor.copySelectionToClipboard(a.store);
    const token = a.editor.inAppClipboardToken()!;

    const b = await openTab('talk-b', destinationDeck());
    const pasted = await b.editor.pasteStashedClipboard(b.store, b.editor.stashedClipboardId(token)!);
    expect(pasted).toEqual({
      kind: 'elements',
      count: 2,
      notice: '2 pictures or videos could not be copied from the other presentation and were left out.',
    });
    const slide = b.store.get().deck.slides[0];
    expect(slide.elements.map((el) => el.type)).toEqual(['text', 'video']);
    expect(slide.elements[1]).toMatchObject({ src: 'assets/clip.c0ffee00.mp4', poster: null });
    // The build of the image that stayed behind did not come without it.
    expect(slide.timeline).toEqual([]);
  });

  it('pastes into the same deck after a reload without copying anything', async () => {
    const a = await openTab('talk-a', sourceDeck());
    a.store.select(['image-a']);
    await a.editor.copySelectionToClipboard(a.store);
    const token = a.editor.inAppClipboardToken()!;

    const reloaded = await openTab('talk-a', sourceDeck());
    expect(reloaded.editor.isInAppClipboardToken(token)).toBe(false);
    const id = reloaded.editor.stashedClipboardId(token)!;
    expect(await reloaded.editor.pasteStashedClipboard(reloaded.store, id)).toEqual({ kind: 'elements', count: 1 });
    expect(reloaded.store.selectedElements()[0]).toMatchObject({ type: 'image', src: 'assets/fig.png' });
    expect(server.imports).toEqual([]);
  });

  it('says so when the copy is no longer on the server', async () => {
    const b = await openTab('talk-b', destinationDeck());
    const id = b.editor.stashedClipboardId(`${b.editor.IN_APP_CLIPBOARD_TOKEN_PREFIX}${'0'.repeat(32)}`)!;
    expect(await b.editor.pasteStashedClipboard(b.store, id)).toEqual({
      kind: 'elements', count: 0, notice: 'Nothing pasted: that copy is no longer available. Copy it again.',
    });
    expect(b.store.get().deck.slides[0].elements).toEqual([]);
  });

  it('pastes this tab\'s own copy from memory, and ignores text that is not a token', async () => {
    const a = await openTab('talk-a', sourceDeck());
    a.store.select(['image-a']);
    await a.editor.copySelectionToClipboard(a.store);
    expect(a.editor.stashedClipboardId(a.editor.inAppClipboardToken())).toBeNull();
    expect(a.editor.stashedClipboardId('plain prose')).toBeNull();
    expect(a.editor.stashedClipboardId(`${a.editor.IN_APP_CLIPBOARD_TOKEN_PREFIX}short`)).toBeNull();
  });
});
