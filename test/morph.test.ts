// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck, type SlideElement } from '../src/shared/deck.js';
import {
  essentialMorphPairs,
  explicitMorphPairs,
  suggestMorphPairs,
  unchangedMorphPairs,
} from '../src/shared/morph.js';
import { MorphPanel } from '../src/renderer/editor/morphPanel.js';
import { Inspector } from '../src/renderer/editor/inspector.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { Player, matchMorphElements } from '../src/renderer/player/player.js';

const text = (id: string, html: string, x = 0): SlideElement => ({
  id, type: 'text', x, y: 0, w: 300, h: 80, rot: 0, z: 1,
  opacity: 1, class: ['role-title'], style: {}, html, align: 'left', valign: 'top',
});

function twoSlideDeck() {
  const deck = emptyDeck('Morph');
  deck.slides[0].elements = [text('source', 'A shared title')];
  deck.slides.push({
    id: 'slide-2', name: '', background: { color: null, image: null }, notes: '',
    timeline: [], elements: [text('target', 'A shared title', 600)],
  });
  return deck;
}

describe('Morph matching', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    (globalThis as unknown as { window: Window }).window.api = {
      assetUrl: (src: string) => src,
    } as never;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    if (!globalThis.CSS) (globalThis as unknown as { CSS: typeof CSS }).CSS = {} as typeof CSS;
    if (!CSS.escape) CSS.escape = (value) => value;
  });

  it('keeps modal object hover transparent despite the global button hover', () => {
    // Strip comments so a selector quoted in prose cannot pose as the rule.
    const css = readFileSync('src/renderer/editor/editor.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const globalHover = css.lastIndexOf('button:hover:not(:disabled)');
    const objectHover = css.lastIndexOf('button.morph-object-hit:hover:not(:disabled)');
    expect(objectHover).toBeGreaterThan(globalHover);
    expect(css.slice(objectHover, objectHover + 180)).toContain('rgb(245 158 11 / 3%)');
  });

  it('essentially pairs objects that differ only by sub-epsilon drift', () => {
    const arrow = (id: string, x: number, y: number, w: number, rot: number): SlideElement => ({
      id, type: 'shape', shape: 'arrow', x, y, w, h: 1, rot, z: 1, opacity: 1,
      class: [], style: {}, fill: null, stroke: '#000000', strokeWidth: 6,
      radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: true,
    });
    // The drifted twin pairs; the relocated and restyled arrows decisively do not.
    const previous = [
      arrow('drifted-src', 367.5, 643.62, 167.35, 90.1),
      arrow('moved-src', 122.51, 566.6, 329.57, 90.07),
    ];
    const next = [
      arrow('drifted-dst', 367.12, 648.43, 167.14, 90.43),
      arrow('moved-dst', 611.75, 564.07, 329.8, 90.07),
      { ...arrow('restyled-dst', 367.5, 643.62, 167.35, 90.1), stroke: '#ff0000' },
    ];
    expect(essentialMorphPairs(previous, next).map((pair) => pair.map((el) => el.id)))
      .toEqual([['drifted-src', 'drifted-dst']]);
  });

  it('pairs nothing by default, even when visible content is identical', () => {
    const deck = twoSlideDeck();
    expect(matchMorphElements(deck.slides[0].elements, deck.slides[1].elements)).toEqual([]);
  });

  it('animates only objects sharing an explicit pairing id', () => {
    const deck = twoSlideDeck();
    deck.slides[0].elements[0].morphId = 'pair-1';
    deck.slides[1].elements[0].morphId = 'pair-1';
    expect(explicitMorphPairs(deck.slides[0].elements, deck.slides[1].elements))
      .toEqual([[deck.slides[0].elements[0], deck.slides[1].elements[0]]]);
  });

  it('pairs a duplicated pairing id with the nearest object, not the last one', () => {
    // Copied authoring HTML can put one pairing id on two objects. Whichever
    // the map happened to keep would animate from the far side of the slide.
    const previous = [
      text('far', 'Duplicated id', 1600),
      text('near', 'Duplicated id', 20),
    ];
    previous[0].morphId = 'dup';
    previous[1].morphId = 'dup';
    const target = text('landing', 'Duplicated id', 40);
    target.morphId = 'dup';

    expect(explicitMorphPairs(previous, [target])).toEqual([[previous[1], target]]);
  });

  it('gives two objects sharing one id a source each rather than one twice', () => {
    const previous = [text('left', 'Split', 0), text('right', 'Split', 900)];
    for (const element of previous) element.morphId = 'dup';
    const targets = [text('to-right', 'Split', 940), text('to-left', 'Split', 60)];
    for (const element of targets) element.morphId = 'dup';

    expect(explicitMorphPairs(previous, targets)).toEqual([
      [previous[1], targets[0]],
      [previous[0], targets[1]],
    ]);
  });

  it('skips objects that are visually identical and therefore never animate', () => {
    const source = [text('a', 'The same title')];
    const target = [text('c', 'The same title')];
    expect(suggestMorphPairs(source, target)).toEqual([]);
  });

  it('suggests strong matches without pairing unrelated same-type objects', () => {
    const source = [text('a', 'The same title'), text('b', 'Completely unrelated')];
    const target = [text('c', 'The same title', 600), text('d', 'Nothing in common', 600)];
    expect(suggestMorphPairs(source, target).map(([a, b]) => [a.id, b.id]))
      .toEqual([['a', 'c']]);
  });

  it('does not greedily pair every same-styled arrow on slides 18 and 19', () => {
    const arrow = (id: string, x: number, y: number, w: number): SlideElement => ({
      id, type: 'shape', shape: 'arrow', x, y, w, h: 1, rot: 0, z: 1,
      opacity: 1, class: [], style: {}, fill: null, stroke: '#000000',
      strokeWidth: 7, radius: 0, path: null, pathSize: null,
      arrowStart: false, arrowEnd: true,
    });
    const previous = [
      arrow('shape-589', 778.38, 718.34, 186.35),
      arrow('shape-590', 367.5, 643.62, 167.35),
      arrow('shape-591', 122.51, 566.6, 329.57),
    ];
    const next = [
      arrow('shape-604', 367.12, 648.43, 167.14),
      arrow('shape-605', 611.75, 564.07, 329.8),
    ];
    // shape-590 → shape-604 is a sub-epsilon drift the essential matcher
    // already glides at runtime, so it needs no explicit pair suggestion.
    expect(suggestMorphPairs(previous, next).map(([source, target]) =>
      [source.id, target.id])).toEqual([
      ['shape-591', 'shape-605'],
    ]);
  });

  /**
   * A `<video>` paints nothing until a frame is decoded, so a preview surface
   * that is rebuilt goes black until its poster-frame seek lands again --
   * seconds, on a remote session. Every pairing click re-renders this panel,
   * which is why the Morph previews used to flash (and, behind the load
   * gate, sometimes stay) black. The surfaces must be reconciled, not rebuilt.
   */
  describe('preview surfaces keep their decoded videos', () => {
    beforeEach(() => {
      // jsdom has no media stack; the panel only needs these to not throw.
      HTMLMediaElement.prototype.pause = function () {};
      HTMLMediaElement.prototype.load = function () {};
    });

    function videoDeck() {
      const deck = twoSlideDeck();
      const clip = (id: string, x: number): SlideElement => ({
        id, type: 'video', x, y: 200, w: 400, h: 225, rot: 0, z: 2, opacity: 1,
        class: [], style: {}, src: 'assets/clip.05a38d7a.mp4', fit: 'contain',
        start: 0, end: null, autoplay: false, loop: false, muted: true,
        controls: false, poster: null, sourceBox: null,
      } as unknown as SlideElement);
      deck.slides[0].elements.push(clip('vid-a', 100));
      deck.slides[1].elements.push(clip('vid-b', 700));
      return deck;
    }

    /** Pretend every mounted video has decoded its poster frame. */
    function markDecoded(root: ParentNode): HTMLVideoElement[] {
      const videos = [...root.querySelectorAll('video')];
      for (const video of videos) {
        Object.defineProperty(video, 'readyState', {
          configurable: true,
          get: () => HTMLMediaElement.HAVE_CURRENT_DATA,
        });
      }
      return videos;
    }

    it('reuses the same elements when only the selection changed', () => {
      const store = new EditorStore(videoDeck(), '/tmp/morph');
      const host = document.createElement('div');
      document.body.appendChild(host);
      new MorphPanel(host, store);
      host.querySelector<HTMLButtonElement>('.morph-open')!.click();
      const modal = document.querySelector('.morph-modal')!;
      const before = markDecoded(modal);
      expect(before).toHaveLength(2);

      // Selecting a source object re-renders the panel and the modal.
      modal.querySelector<HTMLButtonElement>('.morph-list-pick[data-side="source"][data-element-id="vid-a"]')!.click();

      // Identity, not structure: a rebuilt element looks identical in the DOM
      // and is exactly the black-preview bug.
      const after = [...document.querySelectorAll('.morph-modal video')];
      expect(after.length).toBe(before.length);
      expect(after.every((video, i) => video === before[i])).toBe(true);
      document.querySelector<HTMLButtonElement>('.morph-modal-close')!.click();
      host.remove();
    });

    it('adopts the decoded elements when an edit rebuilds the surface', () => {
      const store = new EditorStore(videoDeck(), '/tmp/morph');
      const host = document.createElement('div');
      document.body.appendChild(host);
      new MorphPanel(host, store);
      const before = markDecoded(host);
      expect(before).toHaveLength(2);

      // A commit clones the deck, so the surfaces are rebuilt around new
      // slide objects -- the decoded elements must come along.
      store.commit((deck) => {
        deck.slides[1].morphFromPrevious = true;
      }, { label: 'Enable Morph' });

      const after = [...host.querySelectorAll('video')];
      expect(after).toHaveLength(2);
      expect(after.every((video) => before.includes(video))).toBe(true);
      // The freshly rendered elements that they replaced must not keep
      // fetching; the network is the scarce resource on a remote session.
      for (const video of after) expect(video.getAttribute('src')).toBeTruthy();
      host.remove();
    });
  });

  it('enables Morph from the panel button even with no matches to pair', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/morph');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MorphPanel(host, store);
    expect(host.querySelector('.morph-enable .field-check, .morph-enable')!.textContent)
      .toContain('Enabled');
    host.querySelector<HTMLButtonElement>('.morph-enable-pair')!.click();
    expect(store.get().deck.slides[1].morphFromPrevious).toBe(true);
    expect(host.textContent).toContain('Enabled Morph');
    host.remove();
  });

  it('pairs objects by clicking the two large slide previews in the modal', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/morph');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MorphPanel(host, store);
    host.querySelector<HTMLButtonElement>('.morph-open')!.click();

    const modal = document.querySelector('.morph-modal')!;
    expect(modal.querySelectorAll('.morph-preview')).toHaveLength(2);
    modal.querySelector<HTMLButtonElement>('[data-side="source"][data-element-id="source"]')!.click();
    expect(modal.textContent).toContain('Now choose its partner');
    document.querySelector<HTMLButtonElement>('.morph-modal [data-side="target"][data-element-id="target"]')!.click();

    const source = store.get().deck.slides[0].elements[0];
    const target = store.get().deck.slides[1].elements[0];
    expect(source.morphId).toBeTruthy();
    expect(target.morphId).toBe(source.morphId);
    expect(store.get().deck.slides[1].morphFromPrevious).toBe(true);
    const lists = document.querySelectorAll<HTMLElement>('.morph-modal .morph-list');
    expect(lists).toHaveLength(2);
    const firstRow = lists[0].querySelector('.morph-list-item')!;
    expect(firstRow.classList.contains('paired')).toBe(true);
    expect(firstRow.querySelector('.morph-list-badge')!.textContent).toBe('1');
    document.querySelector<HTMLButtonElement>('.morph-modal-close')!.click();
  });

  it('matches every element kind with a rotated Morph selection box', () => {
    HTMLMediaElement.prototype.pause = function () {};
    HTMLMediaElement.prototype.load = function () {};
    const deck = twoSlideDeck();
    const common = {
      x: 192, y: 108, w: 384, h: 216, z: 1, opacity: 1, class: [], style: {},
    };
    const elements: SlideElement[] = [
      { ...common, id: 'text-hit', type: 'text', rot: -47, html: 'Text', align: 'left', valign: 'top' },
      { ...common, id: 'image-hit', type: 'image', rot: -33, src: 'assets/image.png', fit: 'contain', alt: '', sourceBox: null },
      {
        ...common, id: 'video-hit', type: 'video', rot: -19, src: 'assets/video.mp4', fit: 'cover',
        autoplay: false, loop: false, muted: true, controls: false, start: 0, end: null,
        poster: null, sourceBox: null,
      },
      {
        ...common, id: 'rect-hit', type: 'shape', rot: -5, shape: 'rect', fill: '#fff',
        stroke: '#000', strokeWidth: 2, radius: 0, path: null, pathSize: null,
        arrowStart: false, arrowEnd: false,
      },
      {
        ...common, id: 'ellipse-hit', type: 'shape', rot: 9, shape: 'ellipse', fill: '#fff',
        stroke: '#000', strokeWidth: 2, radius: 0, path: null, pathSize: null,
        arrowStart: false, arrowEnd: false,
      },
      {
        ...common, id: 'line-hit', type: 'shape', rot: 23, shape: 'line', fill: null,
        stroke: '#000', strokeWidth: 2, radius: 0, path: null, pathSize: null,
        arrowStart: false, arrowEnd: false,
      },
      {
        ...common, id: 'arrow-hit', type: 'shape', rot: 37, shape: 'arrow', fill: null,
        stroke: '#000', strokeWidth: 2, radius: 0, path: null, pathSize: null,
        arrowStart: false, arrowEnd: true,
      },
      {
        ...common, id: 'path-hit', type: 'shape', rot: 51, shape: 'path', fill: null,
        stroke: '#000', strokeWidth: 2, radius: 0, path: 'M 0 0 L 10 10',
        pathSize: { w: 10, h: 10 }, arrowStart: false, arrowEnd: false,
      },
      { ...common, id: 'html-hit', type: 'html', rot: 65, html: '<b>HTML</b>' },
      {
        ...common, id: 'web-hit', type: 'web', rot: 79, src: 'assets/web/chart.html',
        poster: 'assets/web/chart.png', interactive: true, title: 'Chart',
      },
      {
        ...common, id: 'unsupported-hit', type: 'unsupported', rot: 93,
        originalType: 'TSD.ChartArchive', note: 'Unsupported chart',
      },
    ];
    deck.slides[0].elements = elements;
    const store = new EditorStore(deck, '/tmp/morph');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MorphPanel(host, store);
    host.querySelector<HTMLButtonElement>('.morph-open')!.click();

    const sourcePreview = document.querySelector<HTMLElement>(
      '.morph-modal .morph-preview-wrap:first-child .morph-preview',
    )!;
    for (const element of elements) {
      const rendered = sourcePreview.querySelector<HTMLElement>(
        `.morph-preview-surface [data-element-id="${element.id}"]`,
      )!;
      const hit = sourcePreview.querySelector<HTMLElement>(
        `.morph-object-hit[data-element-id="${element.id}"]`,
      )!;
      expect(hit.style.left, element.id).toBe('10%');
      expect(hit.style.top, element.id).toBe('10%');
      expect(hit.style.width, element.id).toBe('20%');
      expect(hit.style.height, element.id).toBe('20%');
      expect(hit.style.transform, element.id).toBe(rendered.style.transform);
      expect(hit.style.transform, element.id).toBe(`rotate(${element.rot}deg)`);
    }

    document.querySelector<HTMLButtonElement>('.morph-modal-close')!.click();
    host.remove();
  });

  it('pairs objects by clicking the element lists below the previews', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/morph');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MorphPanel(host, store);
    host.querySelector<HTMLButtonElement>('.morph-open')!.click();

    const pick = (side: string, id: string) => document
      .querySelector<HTMLButtonElement>(`.morph-modal .morph-list-pick[data-side="${side}"][data-element-id="${id}"]`)!;
    pick('source', 'source').click();
    expect(document.querySelector('.morph-modal .morph-list-item.selected-source')).not.toBeNull();
    pick('target', 'target').click();

    const source = store.get().deck.slides[0].elements[0];
    expect(source.morphId).toBeTruthy();
    expect(store.get().deck.slides[1].elements[0].morphId).toBe(source.morphId);
    document.querySelector<HTMLButtonElement>('.morph-modal-close')!.click();
  });

  it('opens a large horizontal two-slide editor from Props', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/morph');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);

    const section = host.querySelector('.morph-section')!;
    const compactPreviews = section.querySelectorAll<HTMLElement>('.morph-compact-preview');
    expect(compactPreviews).toHaveLength(2);
    expect(section.querySelectorAll('.morph-object-hit-readonly')).toHaveLength(2);
    compactPreviews[0].click();
    const modal = document.querySelector('.morph-modal')!;
    const previews = [...modal.querySelectorAll<HTMLElement>('.morph-preview')];
    expect(previews).toHaveLength(2);
    expect(previews.map((preview) => preview.style.width)).toEqual(['', '']);
    expect([...modal.querySelectorAll<HTMLElement>('.morph-preview-label')]
      .map((label) => label.textContent)).toEqual(['Source · Slide 1', 'Target · Slide 2']);
    expect(modal.getAttribute('aria-modal')).toBe('true');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.morph-modal')).toBeNull();
  });

  it('removes Morph, including its modal, as soon as an object is selected', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/morph');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new Inspector(host, store);
    host.querySelector<HTMLElement>('.morph-compact-preview')!.click();
    expect(document.querySelector('.morph-modal')).not.toBeNull();

    store.select(['source']);

    expect(host.querySelector('.morph-section')).toBeNull();
    expect(document.querySelector('.morph-modal')).toBeNull();
  });

  it('auto-pairs likely matches only when the author requests it', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/morph');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MorphPanel(host, store);
    host.querySelector<HTMLButtonElement>('.morph-open')!.click();
    expect(explicitMorphPairs(store.get().deck.slides[0].elements, store.get().deck.slides[1].elements))
      .toHaveLength(0);

    [...document.querySelectorAll<HTMLButtonElement>('.morph-modal button')]
      .find((button) => button.textContent === 'Auto-pair')!.click();

    expect(explicitMorphPairs(store.get().deck.slides[0].elements, store.get().deck.slides[1].elements))
      .toHaveLength(1);
    expect(document.querySelector('.morph-modal')!.textContent).toContain('Auto-paired 1 object');
    document.querySelector<HTMLButtonElement>('.morph-modal-close')!.click();
  });

  it('runs paired movement and edge-window unpaired fades on one timeline', async () => {
    const deck = twoSlideDeck();
    deck.slides[1].morphDuration = 1350;
    deck.slides[0].elements[0].morphId = 'pair';
    deck.slides[1].elements[0].morphId = 'pair';
    deck.slides[0].elements.push(text('disappears', 'Disappears', 900));
    deck.slides[1].elements.push(text('appears', 'Appears', 1100));
    deck.slides[1].morphFromPrevious = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    expect(animate).toHaveBeenCalledTimes(3);
    expect(animate.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ duration: 1350 }),
      expect.objectContaining({ duration: 1350 }),
      expect.objectContaining({ duration: 1350 }),
    ]);
    const tracks = animate.mock.calls.map((call) => call[0] as Keyframe[]);
    // The incoming object fades in over the final quarter…
    expect(tracks.some((frames) =>
      frames[0].opacity === '0' && frames[1].offset === 0.75 &&
      frames[1].opacity === '0' && frames[2].opacity !== '0'))
      .toBe(true);
    // …and the removed object's ghost fades out over the first quarter.
    expect(tracks.some((frames) =>
      frames[0].opacity !== '0' && frames[1].offset === 0.25 &&
      frames[1].opacity === '0' && frames[2].opacity === '0'))
      .toBe(true);
    const discreteOptions = animate.mock.calls.slice(1).map((call) => call[1]);
    expect(discreteOptions).toEqual([
      expect.objectContaining({ easing: 'linear' }),
      expect.objectContaining({ easing: 'linear' }),
    ]);
    expect(host.querySelector('.morph-ghost')).not.toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.querySelector('.morph-ghost')).toBeNull();
    player.destroy();
  });

  it('translates same-size text between different-width boxes without stretching it', () => {
    const deck = twoSlideDeck();
    const source = deck.slides[0].elements[0] as Extract<SlideElement, { type: 'text' }>;
    const target = deck.slides[1].elements[0] as Extract<SlideElement, { type: 'text' }>;
    source.morphId = 'pair';
    target.morphId = 'pair';
    source.style = { 'font-size': '48px' };
    target.style = { 'font-size': '48px' };
    source.w = 949.55;
    target.w = 344.79;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    const frames = animate.mock.calls[0][0] as unknown as Keyframe[];
    expect(frames[0].transform).toBe('translate(-600px, 0px) scale(1, 1)');
    player.destroy();
  });

  it('scales paired text by its font size ratio, anchored at its alignment', () => {
    const deck = twoSlideDeck();
    const source = deck.slides[0].elements[0] as Extract<SlideElement, { type: 'text' }>;
    const target = deck.slides[1].elements[0] as Extract<SlideElement, { type: 'text' }>;
    source.morphId = 'pair';
    target.morphId = 'pair';
    source.style = { 'font-size': '80px' };
    target.style = { 'font-size': '40px' };
    source.align = 'center';
    target.align = 'center';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    const frames = animate.mock.calls[0][0] as unknown as Keyframe[];
    // Anchors: the top-centre of each box (x 0 w 300 vs x 600 w 300), scale
    // 80/40. The anchor is folded into the translate so the origin stays the
    // element centre: scaling by 2 about the centre lifts the box top by 40,
    // and the extra 40 puts it back on the source's top edge.
    expect(frames[0].transform).toBe('translate(-600px, 40px) scale(2, 2)');
    expect(frames[0].transformOrigin).toBe('center');
    player.destroy();
  });

  it('animates rotated movers about the center, matching the settled render', () => {
    const deck = twoSlideDeck();
    const arrow = (id: string, x: number, y: number, rot: number): SlideElement => ({
      id, type: 'shape', shape: 'arrow', x, y, w: 200, h: 2, rot, z: 1, opacity: 1,
      class: [], style: {}, fill: null, stroke: '#000000', strokeWidth: 6,
      radius: 0, path: null, pathSize: null, arrowStart: false, arrowEnd: true,
      morphId: 'arrow-pair',
    });
    deck.slides[0].elements = [arrow('arrow-src', 10, 20, 90)];
    deck.slides[1].elements = [arrow('arrow-dst', 14, 24, 91)];
    deck.slides[1].morphFromPrevious = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    const frames = animate.mock.calls[0][0] as unknown as Keyframe[];
    // The settled render rotates about the center; the animation must move
    // between the two centers and rotate in the same frame of reference, or a
    // thin rotated arrow lurches at frame 0 and snaps back when fill ends.
    expect(frames[0].transform).toBe('translate(-4px, -4px) rotate(90deg) scale(1, 1)');
    expect(frames[0].transformOrigin).toBe('center');
    expect(frames[frames.length - 1].transform).toBe('rotate(91deg)');
    expect(frames[frames.length - 1].transformOrigin).toBe('center');
    player.destroy();
  });

  it('keeps a mover above a removed backdrop it outranked on the source slide', () => {
    const deck = twoSlideDeck();
    deck.slides[0].elements[0].morphId = 'pair';
    deck.slides[1].elements[0].morphId = 'pair';
    deck.slides[0].elements[0].z = 5;
    const backdrop: SlideElement = {
      id: 'backdrop', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1920, h: 1080,
      rot: 0, z: 4, opacity: 1, class: [], style: {}, fill: '#ffffff', stroke: null,
      strokeWidth: 1, radius: 0, path: null, pathSize: null,
      arrowStart: false, arrowEnd: false,
    };
    deck.slides[0].elements.unshift(backdrop);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    const calls = animate.mock.calls.map((call) => call[0] as unknown as Keyframe[]);
    // The mover ranks above the backdrop for the eased first half, then drops
    // to its target DOM rank at the same wall-time midpoint as every discrete
    // switch — which requires linear overall timing with the ease on frame 0.
    const mover = calls.find((frames) => frames[0].transform !== undefined)!;
    expect(mover.map((frame) => frame.zIndex)).toEqual(['1', '1', '0', '0']);
    expect(mover[0].easing).toBe('cubic-bezier(.45,.05,.55,.95)');
    expect((animate.mock.calls[0][1] as KeyframeAnimationOptions).easing).toBe('linear');
    const ghost = calls.find((frames) =>
      frames[0].transform === undefined && frames[frames.length - 1].opacity === '0')!;
    expect(ghost.every((frame) => frame.zIndex === '0')).toBe(true);
    player.destroy();
  });

  it('keeps an identical image continuously visible without an explicit pair', () => {
    const deck = twoSlideDeck();
    const image = (id: string): SlideElement => ({
      id, type: 'image', src: 'assets/method.png', x: 19.08, y: 184.03,
      w: 922.53, h: 851.94, rot: 0, z: 1, opacity: 1, class: [], style: {},
      fit: 'fill', alt: '', sourceBox: { x: 15.33, y: -108.03, w: 4257.2, h: 1506.13 },
    });
    deck.slides[0].elements = [image('image-slide-18')];
    deck.slides[1].elements = [image('image-slide-19')];
    deck.slides[1].morphFromPrevious = true;
    expect(unchangedMorphPairs(deck.slides[0].elements, deck.slides[1].elements))
      .toHaveLength(1);
    expect(suggestMorphPairs(deck.slides[0].elements, deck.slides[1].elements))
      .toHaveLength(0);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn();
    HTMLElement.prototype.animate = animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    expect(animate).not.toHaveBeenCalled();
    expect(host.querySelector('[data-element-id="image-slide-19"]')).not.toBeNull();
    player.destroy();
  });

  it('toggles Morph independently of whether anything is paired', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/morph');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MorphPanel(host, store);
    const enabled = host.querySelector<HTMLInputElement>('.morph-enable input')!;
    expect(enabled.checked).toBe(false);
    enabled.checked = true;
    enabled.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().deck.slides[1].morphFromPrevious).toBe(true);
    expect(explicitMorphPairs(store.get().deck.slides[0].elements, store.get().deck.slides[1].elements))
      .toHaveLength(0);
  });

  it('uses the destination slide duration for every paired animation', () => {
    const deck = twoSlideDeck();
    deck.slides[1].morphDuration = 1250;
    deck.slides[0].elements[0].morphId = 'pair';
    deck.slides[1].elements[0].morphId = 'pair';
    const third = structuredClone(deck.slides[1]);
    third.id = 'slide-3';
    third.elements[0].id = 'target-3';
    third.elements[0].x = 900;
    third.morphFromPrevious = true;
    third.morphDuration = 650;
    deck.slides.push(third);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn();
    HTMLElement.prototype.animate = animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);

    expect(animate).toHaveBeenCalled();
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 1250 });
    animate.mockClear();
    player.goToSlide(2);
    expect(animate).toHaveBeenCalled();
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: 650 });
    player.destroy();
  });

  it('leaves every object identical to a direct target-slide render after Morph', async () => {
    const deck = twoSlideDeck();
    const source = deck.slides[0].elements[0];
    const target = deck.slides[1].elements[0];
    source.morphId = 'pair';
    target.morphId = 'pair';
    source.rot = -18;
    target.rot = 27;
    target.opacity = 0.65;
    target.style = { color: 'rgb(12, 34, 56)', transform: 'rotate(27deg) skewX(4deg)' };
    deck.slides[1].elements.push(text('unpaired', 'Target only', 1000));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const animate = vi.fn((
      _keyframes: Keyframe[] | PropertyIndexedKeyframes | null,
      _options?: number | KeyframeAnimationOptions,
    ) => ({ finished: Promise.resolve() }));
    HTMLElement.prototype.animate = animate as unknown as typeof HTMLElement.prototype.animate;
    const player = new Player({ deck, container: host, resolveSrc: (src) => src });

    player.goToSlide(1);
    await Promise.resolve();

    const directDeck = structuredClone(deck);
    for (const slide of directDeck.slides) {
      for (const element of slide.elements) element.morphId = null;
    }
    const directHost = document.createElement('div');
    document.body.appendChild(directHost);
    const directPlayer = new Player({ deck: directDeck, container: directHost, resolveSrc: (src) => src });
    directPlayer.goToSlide(1);
    const actualObjects = [...host.querySelectorAll<HTMLElement>('.slide > .element')];
    const expectedObjects = [...directHost.querySelectorAll<HTMLElement>('.slide > .element')];
    expect(actualObjects.map((element) => element.outerHTML))
      .toEqual(expectedObjects.map((element) => element.outerHTML));
    expect(animate.mock.calls[0][1]).toMatchObject({ fill: 'none' });
    player.destroy();
    directPlayer.destroy();
  });

  it('edits the selected transition duration from the dedicated panel', () => {
    const store = new EditorStore(twoSlideDeck(), '/tmp/morph');
    const host = document.createElement('div');
    document.body.appendChild(host);
    new MorphPanel(host, store);
    const input = host.querySelector<HTMLInputElement>('.morph-duration input')!;
    expect(input.value).toBe('1000');
    input.value = '1450';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    expect(store.get().deck.slides[1].morphDuration).toBe(1450);
    expect(host.textContent).toContain('Duration');
    expect(host.textContent).not.toContain('Duration for deck');
  });

  it('migrates a legacy deck-wide duration onto every slide', () => {
    const legacy = parseDeck({
      ...emptyDeck('Legacy Morph'),
      morphDuration: 1750,
      slides: [{ id: 'slide-1' }, { id: 'slide-2', morphDuration: 900 }],
    });
    expect(legacy.slides.map((slide) => slide.morphDuration)).toEqual([1750, 900]);
    expect(legacy).not.toHaveProperty('morphDuration');
  });
});
