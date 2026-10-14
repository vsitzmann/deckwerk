// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { parseDeck, type Deck, type ThemeStyle } from '../src/shared/deck.js';
import {
  CLIPBOARD_FORMAT,
  type ClipboardReadResult,
  type ClipboardPayload,
  type ClipboardWriteRequest,
  collectAssetSrcs,
  parseClipboardPayload,
  remapElementIds,
  rewriteAssetSrcs,
} from '../src/shared/clipboard.js';
import {
  EditorStore,
  copySelectionToClipboard,
  cutSelectionToClipboard,
  copySlidesToClipboard,
  IN_APP_CLIPBOARD_TOKEN_PREFIX,
  inAppClipboardToken,
  pasteFromClipboard,
} from '../src/renderer/editor/store.js';

/**
 * Cross-instance copy/paste. Two stores stand in for two running apps; the
 * mock below plays the part of the OS pasteboard the main processes share.
 */

function sampleDeck(): Deck {
  return parseDeck({
    version: 1,
    title: 'Clipboard deck',
    slides: [
      {
        id: 'slide-1',
        background: { color: null, image: 'assets/bg.png' },
        elements: [
          { id: 'text-1', type: 'text', x: 0, y: 0, w: 400, h: 100, html: 'Hi' },
          { id: 'image-1', type: 'image', x: 10, y: 10, w: 300, h: 200, src: 'assets/fig.png' },
          {
            id: 'video-1', type: 'video', x: 20, y: 20, w: 640, h: 360,
            src: 'assets/clip.mp4', poster: 'assets/poster.jpg',
          },
        ],
        timeline: [
          {
            id: 't-1',
            trigger: { on: 'click', ref: null, delay: 0 },
            action: { type: 'appear', target: 'image-1', value: null },
          },
          {
            id: 't-2',
            trigger: { on: 'afterPrev', ref: 'text-1', delay: 100 },
            action: { type: 'play', target: 'video-1', value: null },
          },
        ],
      },
      { id: 'slide-2', elements: [], timeline: [] },
    ],
  });
}

function themeStyle(family: string): ThemeStyle {
  const role = (size: number) => ({
    family, size, weight: 400, lineHeight: 1.2, letterSpacing: 'normal',
  });
  return {
    fonts: {
      title: role(96), heading: role(64), body: role(44), caption: role(28), base: role(44),
    },
    palette: ['#336699'],
    colors: { background: '#ffffff', text: '#111111', muted: '#666666', accent: '#336699' },
  };
}

/** In-memory stand-in for the OS pasteboard, shared by every "instance". */
let pasteboard: ClipboardReadResult | null = null;

beforeEach(() => {
  pasteboard = null;
  (globalThis as unknown as { window: Window }).window.api = {
    writeClipboard: async (request: ClipboardWriteRequest) => {
      // What the main process does, minus asset path resolution: envelope,
      // serialise, validate on the way back out.
      pasteboard = parseClipboardPayload(JSON.parse(JSON.stringify({
        format: CLIPBOARD_FORMAT,
        version: 1,
        ...request,
        assets: collectAssetSrcs(request).map((src) => ({ src, absPath: `/src-deck/${src}` })),
      })));
    },
    readClipboard: async () => structuredClone(pasteboard),
  } as unknown as Window['api'];
});

describe('clipboard payload', () => {
  it('rejects foreign or stale pasteboard content', () => {
    expect(parseClipboardPayload({ hello: 'world' })).toBeNull();
    expect(parseClipboardPayload({ format: CLIPBOARD_FORMAT, version: 1, kind: 'elements', elements: [] })).toBeNull();
  });

  it('accepts slide payloads from builds before theme-aware paste', () => {
    const parsed = parseClipboardPayload({
      format: CLIPBOARD_FORMAT,
      version: 1,
      kind: 'slides',
      slides: sampleDeck().slides,
      assets: [],
    });
    expect(parsed?.kind).toBe('slides');
    if (parsed?.kind !== 'slides') throw new Error('expected slides');
    expect(parsed.sourceDeckId).toBeNull();
    expect(parsed.sourceThemeStyle).toBeNull();
  });

  it('collects every referenced asset once', () => {
    const deck = sampleDeck();
    expect(collectAssetSrcs({ kind: 'slides', slides: deck.slides }).sort()).toEqual([
      'assets/bg.png', 'assets/clip.mp4', 'assets/fig.png', 'assets/poster.jpg',
    ]);
  });

  it('rewrites srcs to the destination deck, leaving unmapped ones visible', () => {
    const deck = sampleDeck();
    const payload = {
      kind: 'slides', slides: deck.slides, format: CLIPBOARD_FORMAT, version: 1, assets: [],
      sourceDeckId: null, sourceThemeStyle: null,
    } as ClipboardPayload;
    rewriteAssetSrcs(payload, new Map([
      ['assets/fig.png', 'assets/fig.abcd1234.png'],
      ['assets/bg.png', 'assets/bg.abcd1234.png'],
    ]));
    if (payload.kind !== 'slides') throw new Error('expected slides');
    const [slide] = payload.slides;
    expect(slide.background.image).toBe('assets/bg.abcd1234.png');
    expect(slide.elements[1]).toMatchObject({ src: 'assets/fig.abcd1234.png' });
    // Unmapped: the video keeps its old path (renders broken, not vanished).
    expect(slide.elements[2]).toMatchObject({ src: 'assets/clip.mp4', poster: 'assets/poster.jpg' });
  });

  it('remaps timeline refs and nulls refs that point outside the copy', () => {
    const deck = sampleDeck();
    const [slide] = deck.slides;
    const elements = slide.elements.filter((el) => el.id !== 'text-1');
    remapElementIds(elements, slide.timeline);
    const [image, video] = elements;
    expect(image.id).not.toBe('image-1');
    expect(slide.timeline[0].action.target).toBe(image.id);
    expect(slide.timeline[1].action.target).toBe(video.id);
    // t-2 was triggered by text-1, which did not travel.
    expect(slide.timeline[1].trigger.ref).toBeNull();
  });
});

describe('cross-instance copy/paste', () => {
  it('pastes elements with their builds into a second instance', async () => {
    const source = new EditorStore(sampleDeck(), '/src-deck');
    source.select(['image-1', 'video-1']);
    expect(await copySelectionToClipboard(source)).toBe(2);

    const destDeck = sampleDeck();
    destDeck.slides = [{ ...destDeck.slides[1] }];
    const dest = new EditorStore(parseDeck(destDeck), '/dest-deck');
    const result = await pasteFromClipboard(dest);
    expect(result).toEqual({ kind: 'elements', count: 2 });

    const slide = dest.slide!;
    expect(slide.elements).toHaveLength(2);
    // Fresh ids, ancestry kept.
    expect(slide.elements.map((el) => el.id)).not.toContain('image-1');
    expect(slide.elements[0].lineageId).toBe('image-1');
    // The two timeline entries targeting copied elements travelled and were remapped.
    expect(slide.timeline).toHaveLength(2);
    expect(slide.timeline[0].action.target).toBe(slide.elements[0].id);
    expect(slide.timeline[1].trigger.ref).toBeNull();
  });

  it('pastes whole slides after the current one in a second instance', async () => {
    const source = new EditorStore(sampleDeck(), '/src-deck');
    source.selectSlide(0);
    expect(await copySlidesToClipboard(source)).toBe(1);

    const dest = new EditorStore(sampleDeck(), '/dest-deck');
    dest.selectSlide(1);
    const result = await pasteFromClipboard(dest);
    expect(result).toEqual({ kind: 'slides', count: 1 });

    const { deck, slideIndex } = dest.get();
    expect(deck.slides).toHaveLength(3);
    expect(slideIndex).toBe(2);
    const pasted = deck.slides[2];
    expect(pasted.id).not.toBe('slide-1');
    expect(pasted.elements).toHaveLength(3);
    expect(pasted.elements.map((el) => el.id)).not.toContain('image-1');
    const image = pasted.elements.find((el) => el.lineageId === 'image-1')!;
    expect(pasted.timeline[0].action.target).toBe(image.id);
    expect(pasted.morphFromPrevious).toBe(false);
  });

  it('offers to pin source typography when whole slides cross deck themes', async () => {
    const sourceDeck = sampleDeck();
    sourceDeck.themeStyle = themeStyle('Charter, Georgia, serif');
    sourceDeck.slides[0].background = { color: null, image: null };
    const title = sourceDeck.slides[0].elements[0];
    title.class = ['role-title'];
    const source = new EditorStore(sourceDeck, '/src-deck');
    source.selectSlide(0);
    await copySlidesToClipboard(source);

    const destDeck = sampleDeck();
    destDeck.themeStyle = themeStyle('Inter, sans-serif');
    const dest = new EditorStore(destDeck, '/dest-deck');
    let prompts = 0;
    const result = await pasteFromClipboard(dest, undefined, {
      chooseSlideTheme: async ({ count }) => {
        prompts += 1;
        expect(count).toBe(1);
        return 'source';
      },
    });

    expect(result).toEqual({ kind: 'slides', count: 1 });
    expect(prompts).toBe(1);
    const pasted = dest.get().deck.slides[1];
    expect(pasted.background).toEqual({ color: '#ffffff', image: null });
    expect(pasted.elements[0].style).toMatchObject({
      'font-family': 'Charter, Georgia, serif',
      'font-size': '96px',
      color: '#111111',
    });
  });

  it('cancels a cross-theme slide paste without changing the deck', async () => {
    const sourceDeck = sampleDeck();
    sourceDeck.themeStyle = themeStyle('Charter, Georgia, serif');
    const source = new EditorStore(sourceDeck, '/src-deck');
    source.selectSlide(0);
    await copySlidesToClipboard(source);

    const destDeck = sampleDeck();
    destDeck.themeStyle = themeStyle('Inter, sans-serif');
    const dest = new EditorStore(destDeck, '/dest-deck');
    const result = await pasteFromClipboard(dest, undefined, {
      chooseSlideTheme: async () => null,
    });

    expect(result).toBeNull();
    expect(dest.get().deck.slides).toHaveLength(2);
  });

  it('leaves semantic roles connected when matching the destination theme', async () => {
    const sourceDeck = sampleDeck();
    sourceDeck.themeStyle = themeStyle('Charter, Georgia, serif');
    sourceDeck.slides[0].elements[0].class = ['role-title'];
    const source = new EditorStore(sourceDeck, '/src-deck');
    source.selectSlide(0);
    await copySlidesToClipboard(source);

    const destDeck = sampleDeck();
    destDeck.themeStyle = themeStyle('Inter, sans-serif');
    const dest = new EditorStore(destDeck, '/dest-deck');
    await pasteFromClipboard(dest, undefined, {
      chooseSlideTheme: async () => 'destination',
    });

    expect(dest.get().deck.slides[1].elements[0].style['font-family']).toBeUndefined();
  });

  it('does not interrupt same-theme slide paste', async () => {
    const sourceDeck = sampleDeck();
    sourceDeck.themeStyle = themeStyle('Inter, sans-serif');
    const source = new EditorStore(sourceDeck, '/src-deck');
    source.selectSlide(0);
    await copySlidesToClipboard(source);

    const destDeck = sampleDeck();
    destDeck.themeStyle = themeStyle('Inter, sans-serif');
    const dest = new EditorStore(destDeck, '/dest-deck');
    await pasteFromClipboard(dest, undefined, {
      chooseSlideTheme: async () => {
        throw new Error('same-theme paste should not prompt');
      },
    });

    expect(dest.get().deck.slides).toHaveLength(3);
  });

  it('pasting twice mints distinct ids each time', async () => {
    const store = new EditorStore(sampleDeck(), '/src-deck');
    store.select(['text-1']);
    await copySelectionToClipboard(store);
    await pasteFromClipboard(store);
    const [first] = [...store.get().selection];
    await pasteFromClipboard(store);
    const [second] = [...store.get().selection];
    expect(first).not.toBe(second);
    expect(store.slide!.elements).toHaveLength(5);
  });

  it('pastes onto another slide at the coordinates the elements were copied from', async () => {
    const source = new EditorStore(sampleDeck(), '/src-deck');
    source.select(['image-1', 'video-1']);
    await copySelectionToClipboard(source);

    const dest = new EditorStore(sampleDeck(), '/dest-deck');
    dest.selectSlide(1);
    await pasteFromClipboard(dest);

    const pasted = dest.slide!.elements;
    expect(pasted.map((el) => [el.x, el.y])).toEqual([[10, 10], [20, 20]]);
  });

  it('offsets a paste back onto the slide it was copied from, cascading on repeat', async () => {
    const store = new EditorStore(sampleDeck(), '/src-deck');
    store.select(['image-1']);
    await copySelectionToClipboard(store);

    await pasteFromClipboard(store);
    const first = store.slide!.elements.at(-1)!;
    expect([first.x, first.y]).toEqual([34, 34]);

    await pasteFromClipboard(store);
    const second = store.slide!.elements.at(-1)!;
    expect([second.x, second.y]).toEqual([58, 58]);
  });

  it('pastes in place once the original is deleted, and after a cut', async () => {
    const store = new EditorStore(sampleDeck(), '/src-deck');
    store.select(['image-1']);
    await copySelectionToClipboard(store);
    store.deleteSelection();
    await pasteFromClipboard(store);
    const restored = store.slide!.elements.at(-1)!;
    expect([restored.x, restored.y]).toEqual([10, 10]);

    // Cut, then paste: the spot is free again, so no nudge.
    await cutSelectionToClipboard(store);
    await pasteFromClipboard(store);
    const pasted = store.slide!.elements.at(-1)!;
    expect([pasted.x, pasted.y]).toEqual([10, 10]);
    // A second paste of the cut is over the first, so it cascades.
    await pasteFromClipboard(store);
    const again = store.slide!.elements.at(-1)!;
    expect([again.x, again.y]).toEqual([34, 34]);
  });

  it('cascades repeated pastes onto another slide so copies do not stack', async () => {
    const source = new EditorStore(sampleDeck(), '/src-deck');
    source.select(['image-1']);
    await copySelectionToClipboard(source);

    const dest = new EditorStore(sampleDeck(), '/dest-deck');
    dest.selectSlide(1);
    await pasteFromClipboard(dest);
    await pasteFromClipboard(dest);

    expect(dest.slide!.elements.map((el) => [el.x, el.y])).toEqual([[10, 10], [34, 34]]);
  });

  it('pastes an Excel or web table onto the slide as one editable object', async () => {
    pasteboard = {
      kind: 'external-html',
      html: '<div><table onclick="bad()" style="position:fixed"><colgroup><col width="100"><col width="300"></colgroup><tr><th>Name</th><th>Value</th></tr><tr><td contenteditable="false" style="background-image:url(https://bad.test/x);background-color:red">A</td><td>42</td></tr></table></div>',
    };
    const store = new EditorStore(sampleDeck(), '/dest-deck');
    const result = await pasteFromClipboard(store);
    expect(result).toEqual({ kind: 'elements', count: 1 });
    const [selected] = store.selectedElements();
    expect(selected.type).toBe('text');
    expect((selected as { html: string }).html).toContain('<table>');
    expect((selected as { html: string }).html).not.toContain('onclick');
    expect((selected as { html: string }).html).not.toContain('contenteditable');
    expect((selected as { html: string }).html).not.toContain('position');
    expect((selected as { html: string }).html).not.toContain('background-image');
    expect(selected.type === 'text' && selected.table).toEqual({
      columnWidths: [100, 300],
      autoHeight: true,
    });
    expect(selected.type === 'text' && selected.autoFit).toBe(false);
  });

  it('pastes a macOS clipboard screenshot as a centered image', async () => {
    pasteboard = {
      kind: 'external-image',
      asset: {
        src: 'assets/Screenshot.abc12345.png',
        kind: 'image',
        width: 3024,
        height: 1964,
        duration: null,
      },
    };
    const store = new EditorStore(sampleDeck(), '/dest-deck');
    expect(await pasteFromClipboard(store)).toEqual({ kind: 'elements', count: 1 });
    const [selected] = store.selectedElements();
    expect(selected).toMatchObject({
      type: 'image',
      src: 'assets/Screenshot.abc12345.png',
      fit: 'contain',
      alt: 'Pasted screenshot',
    });
    expect(selected.w).toBeLessThanOrEqual(store.get().deck.canvas.w * 0.8);
    expect(selected.h).toBeLessThanOrEqual(store.get().deck.canvas.h * 0.8);
    expect(selected.x).toBe(Math.round((store.get().deck.canvas.w - selected.w) / 2));
    expect(selected.y).toBe(Math.round((store.get().deck.canvas.h - selected.h) / 2));
  });

  it('uploads and pastes a PNG from the browser collaboration clipboard', async () => {
    let uploaded: File | null = null;
    window.api = {
      importAssetFiles: async (files: File[]) => {
        [uploaded] = files;
        return [{
          src: 'assets/Screenshot.browser123.png',
          kind: 'image',
          width: 800,
          height: 600,
          duration: null,
        }];
      },
    } as Window['api'];
    const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        read: async () => [{
          types: ['image/png'],
          getType: async () => new Blob(
            [new Uint8Array([137, 80, 78, 71])],
            { type: 'image/png' },
          ),
        }],
      },
    });
    try {
      const store = new EditorStore(sampleDeck(), '/dest-deck');
      expect(await pasteFromClipboard(store)).toEqual({ kind: 'elements', count: 1 });
      expect(uploaded).toMatchObject({ name: 'Screenshot.png', type: 'image/png' });
      expect(store.selectedElements()[0]).toMatchObject({
        type: 'image',
        src: 'assets/Screenshot.browser123.png',
        w: 800,
        h: 600,
      });
    } finally {
      if (prior) Object.defineProperty(navigator, 'clipboard', prior);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  it('pastes the tab-separated fallback supplied by Google Sheets', async () => {
    pasteboard = {
      kind: 'external-html',
      html: '',
      text: 'time\texperiment id\n2026-08-18\tego\n2026-08-24\t"ego\nmix"',
    };
    const store = new EditorStore(sampleDeck(), '/dest-deck');
    expect(await pasteFromClipboard(store)).toEqual({ kind: 'elements', count: 1 });
    const [selected] = store.selectedElements();
    const html = (selected as { html: string }).html;
    expect(html).toContain('<table>');
    expect(html).toContain('<td>experiment id</td>');
    expect(html).toContain('<td>ego<br>mix</td>');
    expect(store.selectedElements()[0]).toMatchObject({
      table: { columnWidths: [1, 1], autoHeight: true },
    });
  });

  it('reads Google Sheets HTML from the browser collaboration clipboard', async () => {
    window.api = {} as Window['api'];
    const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        read: async () => [{
          types: ['text/html', 'text/plain'],
          getType: async (type: string) => ({
            text: async () => type === 'text/html'
              ? '<google-sheets-html-origin><table><tr><td>time</td><td>experiment id</td></tr></table></google-sheets-html-origin>'
              : 'time\texperiment id',
          }),
        }],
      },
    });
    try {
      const store = new EditorStore(sampleDeck(), '/dest-deck');
      expect(await pasteFromClipboard(store)).toEqual({ kind: 'elements', count: 1 });
      expect((store.selectedElements()[0] as { html: string }).html).toContain('<td>experiment id</td>');
    } finally {
      if (prior) Object.defineProperty(navigator, 'clipboard', prior);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  // Reported: select a slide, Cmd+C, Cmd+V — and an image pastes instead of
  // the slide, whenever the OS clipboard happens to hold one. The browser
  // client has no pasteboard bridge, so the slide never reached the OS
  // clipboard and the image there always won.
  it('pastes the slide copied in the app over an older image on the browser clipboard', async () => {
    let written = '';
    window.api = {
      importAssetFiles: async () => { throw new Error('the image must not be imported'); },
    } as unknown as Window['api'];
    const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => { written = text; },
        read: async () => [{
          types: ['text/plain', 'image/png'],
          // jsdom's Blob has no text(); give the text item one.
          getType: async (type: string) => (type === 'text/plain'
            ? Object.assign(new Blob([written], { type }), { text: async () => written })
            : new Blob([new Uint8Array([137, 80, 78, 71])], { type })),
        }],
      },
    });
    try {
      const source = new EditorStore(sampleDeck(), '/source-deck');
      source.selectSlide(0);
      expect(await copySlidesToClipboard(source)).toBe(1);
      expect(written.startsWith(IN_APP_CLIPBOARD_TOKEN_PREFIX)).toBe(true);
      expect(written).toBe(inAppClipboardToken());

      const dest = new EditorStore(sampleDeck(), '/dest-deck');
      expect(await pasteFromClipboard(dest)).toEqual({ kind: 'slides', count: 1 });
      expect(dest.get().deck.slides).toHaveLength(3);
    } finally {
      if (prior) Object.defineProperty(navigator, 'clipboard', prior);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });

  it('lets an image copied after the slide win, as the newest copy', async () => {
    window.api = {
      importAssetFiles: async () => [{
        src: 'assets/Screenshot.later.png', kind: 'image', width: 80, height: 60, duration: null,
      }],
    } as unknown as Window['api'];
    const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {},
        // A screenshot taken after the copy: the token is gone from the text.
        read: async () => [{
          types: ['image/png'],
          getType: async (type: string) => new Blob([new Uint8Array([137, 80, 78, 71])], { type }),
        }],
      },
    });
    try {
      const source = new EditorStore(sampleDeck(), '/source-deck');
      source.selectSlide(0);
      await copySlidesToClipboard(source);
      const dest = new EditorStore(sampleDeck(), '/dest-deck');
      expect(await pasteFromClipboard(dest)).toEqual({ kind: 'elements', count: 1 });
      expect(dest.selectedElements()[0]).toMatchObject({ type: 'image', src: 'assets/Screenshot.later.png' });
    } finally {
      if (prior) Object.defineProperty(navigator, 'clipboard', prior);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
  });
});
