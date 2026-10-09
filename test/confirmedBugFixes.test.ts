// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { emptyDeck, type Deck, type Slide, type SlideElement } from '../src/shared/deck.js';
import { Player } from '../src/renderer/player/player.js';
import { EditorStore } from '../src/renderer/editor/store.js';
import { diffDecks } from '../src/shared/deckDiff.js';
import { applyOpsLenient } from '../src/shared/collabApply.js';
import { installCanvasDomShims } from './support/canvasHarness.js';

/**
 * Regressions for the defects a seam-by-seam review of this codebase confirmed.
 *
 * Each case here is a bug that shipped and was reachable by ordinary use. They
 * are grouped by the seam the review walked, and every one names the symptom an
 * author would have seen, because that is what makes a failure here legible
 * later: the assertion is the mechanism, the comment is the complaint.
 */

function video(over: Partial<Extract<SlideElement, { type: 'video' }>> = {}): SlideElement {
  return {
    id: 'video-1', type: 'video',
    x: 0, y: 0, w: 480, h: 270, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: 'assets/clip.mp4', fit: 'contain',
    autoplay: false, loop: false, muted: true, controls: false,
    start: 0, end: null, poster: null, sourceBox: null,
    ...over,
  } as SlideElement;
}

function text(id: string, over: Partial<Extract<SlideElement, { type: 'text' }>> = {}): SlideElement {
  return {
    id, type: 'text',
    x: 0, y: 0, w: 400, h: 100, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, html: id, align: 'left', valign: 'middle',
    ...over,
  } as SlideElement;
}

function deckOf(...slides: Array<Partial<Slide>>): Deck {
  const deck = emptyDeck('Regressions');
  deck.slides = slides.map((slide, i) => ({
    ...deck.slides[0],
    id: `slide-${i}`,
    elements: [],
    timeline: [],
    ...slide,
  }));
  return deck;
}

function mount(deck: Deck): { stage: HTMLElement; player: Player } {
  installCanvasDomShims();
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const player = new Player({ deck, container: host, resolveSrc: (src) => `/deck/${src}` });
  return { stage: host.querySelector<HTMLElement>('.stage')!, player };
}

/** Mark a rendered video as genuinely mid-playback, which is what carry keys on. */
function setPlaying(node: HTMLVideoElement): void {
  Object.defineProperty(node, 'paused', { value: false, configurable: true });
  Object.defineProperty(node, 'currentTime', { value: 3, configurable: true });
}

describe('player: slide changes', () => {
  it('opens on the first slide the audience is meant to see, not a hidden one', () => {
    // Present walks past a skipped slide and the PDF export drops it, so a
    // standalone web export opening on one showed a slide deliberately hidden.
    const deck = deckOf(
      { id: 'hidden', skipped: true, elements: [text('a')] },
      { id: 'shown', elements: [text('b')] },
    );
    const { player } = mount(deck);
    expect(player.getCursor().slide).toBe(1);
  });

  it('pauses a playing video that the next slide has no place for', () => {
    // Chromium keeps a detached media element playing, and the player only
    // pauses videos it can still find on the stage — so the clip's audio used
    // to carry on over every remaining slide.
    const deck = deckOf(
      { elements: [video({ id: 'v' })] },
      { elements: [text('t')] },
    );
    const { stage, player } = mount(deck);
    const live = stage.querySelector<HTMLVideoElement>('video')!;
    setPlaying(live);
    const paused = vi.fn();
    live.pause = paused;

    player.goToSlide(1);

    expect(stage.querySelector('video')).toBeNull();
    expect(paused).toHaveBeenCalled();
  });

  it('continues the video that was playing, not whichever one paints first', () => {
    // Two elements, one file. Keying continuity on the file handed the live
    // element to whichever slot painted first, so the element that was really
    // playing got a fresh node — and the adopter, not in the new state's
    // playing set, was then paused. The picture dropped out of both.
    const both = [
      video({ id: 'v-back', z: 1 }),
      video({ id: 'v-front', z: 2 }),
    ];
    const deck = deckOf({ elements: both }, { elements: both.map((e) => ({ ...e })) });
    const { stage, player } = mount(deck);
    const live = stage.querySelector<HTMLVideoElement>('[data-element-id="v-front"] video')!;
    setPlaying(live);

    player.goToSlide(1);

    expect(stage.querySelector('[data-element-id="v-front"] video')).toBe(live);
  });

  it('restarts a video that something else paused while the build wants it playing', async () => {
    // Chromium suspends muted, audio-less video it treats as background media
    // "to save power": it fires `pause` and rejects the in-flight play() with an
    // AbortError. The player used to swallow that, so a deck of silent figure
    // animations sat frozen on its first frame with nothing left to restart it.
    const deck = deckOf({ elements: [video({ id: 'v', autoplay: true })] });
    const { stage } = mount(deck);
    const node = stage.querySelector<HTMLVideoElement>('video')!;

    const play = vi.fn(() => Promise.resolve());
    node.play = play as unknown as HTMLVideoElement['play'];
    expect(play).not.toHaveBeenCalled();

    // Exactly what Chromium does: pause it out from under us, and say so.
    Object.defineProperty(node, 'paused', { value: true, configurable: true });
    node.dispatchEvent(new Event('pause'));

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(play, 'the player never tried to resume the clip').toHaveBeenCalled();
  });

  it('holds a pause the viewer chose until they play it again', async () => {
    // BUG: pausing a clip from its own controls while presenting held for a
    // moment, then the keep-alive above took the pause for Chromium's and
    // started the clip again.
    const deck = deckOf(
      {
        elements: [video({ id: 'v', autoplay: true }), text('t')],
        timeline: [{ id: 'b', trigger: { on: 'click', ref: null, delay: 0 }, action: { type: 'appear', target: 't', value: null } }],
      },
      { elements: [text('other')] },
    );
    const { stage, player } = mount(deck);
    const node = stage.querySelector<HTMLVideoElement>('video')!;
    const play = vi.fn(() => Promise.resolve());
    node.play = play as unknown as HTMLVideoElement['play'];

    // The viewer presses the pause button: a press on the video, then `pause`.
    node.dispatchEvent(new Event('pointerdown'));
    Object.defineProperty(node, 'paused', { value: true, configurable: true });
    node.dispatchEvent(new Event('pause'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(play, 'the clip restarted under the viewer').not.toHaveBeenCalled();

    // A build step on the same slide does not overrule them either.
    player.next();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(play, 'a build step restarted the paused clip').not.toHaveBeenCalled();

    // Once they play it, the keep-alive guards it again.
    node.dispatchEvent(new Event('play'));
    node.dispatchEvent(new Event('pause'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(play, 'a pause nobody chose went unanswered').toHaveBeenCalled();
  });

  it('plays a viewer-paused clip again when its slide is shown afresh', async () => {
    const deck = deckOf(
      { elements: [video({ id: 'v', autoplay: true })] },
      { elements: [text('other')] },
    );
    const { stage, player } = mount(deck);
    // After mount: its DOM shims install their own play().
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const node = stage.querySelector<HTMLVideoElement>('video')!;
    // The guard on the fix: the viewer's pause belongs to that visit only.
    node.dispatchEvent(new Event('pointerdown'));
    node.dispatchEvent(new Event('pause'));

    player.goToSlide(1);
    play.mockClear();
    player.goToSlide(0);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(play, 'the clip stayed paused on a fresh visit').toHaveBeenCalled();
    play.mockRestore();
  });

  it('leaves a video alone once the build state stops wanting it', async () => {
    // The flip side: the reconciler must not fight a deliberate pause, or
    // stepping past a video would restart it forever.
    const deck = deckOf(
      { elements: [video({ id: 'v', autoplay: true })] },
      { elements: [text('t')] },
    );
    const { stage, player } = mount(deck);
    const node = stage.querySelector<HTMLVideoElement>('video')!;
    const play = vi.fn(() => Promise.resolve());
    node.play = play as unknown as HTMLVideoElement['play'];

    player.goToSlide(1); // the video is gone from the stage; intent is dropped
    Object.defineProperty(node, 'paused', { value: true, configurable: true });
    node.dispatchEvent(new Event('pause'));

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(play).not.toHaveBeenCalled();
  });

  it('does not animate a Morph between slides that are not neighbours', () => {
    // The flag describes a slide's relation to the one before it, so jumping
    // from the rail (or stepping backwards) used to animate two slides that
    // were never authored as a pair: objects flying around at random.
    const deck = deckOf(
      { elements: [text('a', { x: 0 })] },
      { elements: [text('b')] },
      { morphFromPrevious: true, elements: [text('a', { x: 900 })] },
    );
    const { stage, player } = mount(deck);
    // jsdom has no Web Animations API; a stub is enough to observe whether the
    // transition machinery tried to animate anything at all.
    const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel() {} }));
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true, writable: true, value: animate,
    });

    player.goToSlide(2); // a jump, from slide 0

    expect(animate).not.toHaveBeenCalled();
    expect(stage.querySelector('[data-element-id="a"]')).not.toBeNull();
  });
});

describe('collaboration: reconnect and merges', () => {
  it('keeps the revision log and the selection when the socket comes back', () => {
    // A dropped WebSocket is not a new document: reloading through load() threw
    // away every restorable revision the History panel held, over a blip.
    const deck = deckOf({ elements: [text('a')] });
    const store = new EditorStore(deck);
    store.select(['a']);
    store.commit((d) => { d.slides[0].name = 'renamed'; }, { label: 'Rename slide' });
    const revisions = store.history().length;
    expect(revisions).toBeGreaterThan(0);
    expect(store.canUndo()).toBe(true);

    store.resyncRemote(store.get().deck, '(collab) deck');

    expect(store.history()).toHaveLength(revisions);
    expect([...store.get().selection]).toEqual(['a']);
    // The undo stack must NOT survive: a reconnect abandons the unconfirmed
    // transactions those inverses were computed against, so replaying them
    // would apply edits to a base the server never saw.
    expect(store.canUndo()).toBe(false);
  });

  it('lets two peers edit different properties of one slide without erasing each other', () => {
    // The op used to carry every non-element field, and apply replaced the slide
    // wholesale — so editing the speaker notes silently deleted a build
    // animation a peer had just authored on the same slide.
    const base = deckOf({ elements: [text('a')] });
    const withNotes = structuredClone(base);
    withNotes.slides[0].notes = 'remember the demo';

    const withBuild = structuredClone(base);
    withBuild.slides[0].timeline = [{
      id: 't1',
      trigger: { on: 'click', ref: null, delay: 0 },
      action: { type: 'appear', target: 'a', value: null },
    }];

    // The notes edit is diffed against the shared base, then applied on top of
    // a deck that already carries the peer's build.
    const ops = diffDecks(base, withNotes);
    const merged = applyOpsLenient(withBuild, ops).deck;

    expect(merged.slides[0].notes).toBe('remember the demo');
    expect(merged.slides[0].timeline).toHaveLength(1);
  });

  it('states a cleared optional field instead of leaving it out', () => {
    // A patch says nothing about a key it omits, so a removal has to be stated:
    // otherwise un-skipping a slide, or dropping its layout preset, never
    // reached anyone else.
    const base = deckOf({ elements: [], skipped: true, layout: 'title' });
    const next = structuredClone(base);
    delete next.slides[0].skipped;
    delete next.slides[0].layout;

    const ops = diffDecks(base, next);
    const properties = ops.find((op) => op.op === 'setSlideProperties');
    expect(properties?.clear?.sort()).toEqual(['layout', 'skipped']);

    const applied = applyOpsLenient(structuredClone(base), ops).deck;
    expect(applied.slides[0].skipped).toBeUndefined();
    expect(applied.slides[0].layout).toBeUndefined();
  });

  it('sends only the slide fields that changed', () => {
    const base = deckOf({ elements: [] });
    const next = structuredClone(base);
    next.slides[0].notes = 'hello';
    const ops = diffDecks(base, next);
    const properties = ops.find((op) => op.op === 'setSlideProperties');
    expect(properties).toBeDefined();
    expect(Object.keys(properties!.slide).sort()).toEqual(['id', 'notes']);
  });
});
