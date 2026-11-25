// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readRememberedSlide, rememberSlide } from '../src/renderer/collab/rememberedSlide.js';
import { emptyDeck } from '../src/shared/deck.js';
import { restoreEditorView } from '../src/shared/editorView.js';
import { EditorStore } from '../src/renderer/editor/store.js';

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe('the active slide remembered for refresh', () => {
  it('keeps decks separate and does not save the connecting placeholder', () => {
    rememberSlide('talk-a', 'slide-2');
    rememberSlide('talk-b', 'slide-3');
    rememberSlide(null, 'placeholder');
    rememberSlide('talk-a', undefined);
    expect(readRememberedSlide('talk-a')?.activeSlideId).toBe('slide-2');
    expect(readRememberedSlide('talk-b')?.activeSlideId).toBe('slide-3');
    expect(readRememberedSlide('new-talk')).toBeNull();
    expect(readRememberedSlide(null)).toBeNull();
  });

  it('restores the slide by identity after reordering and falls back when deleted', () => {
    const deck = emptyDeck('Slides');
    const first = deck.slides[0];
    deck.slides = [{ ...first, id: 'second' }, { ...first, id: 'first' }];
    rememberSlide('talk', 'first');
    const store = new EditorStore(deck);
    restoreEditorView(store, readRememberedSlide('talk'));
    expect(store.get().slideIndex).toBe(1);
    rememberSlide('talk', 'deleted');
    const reopened = new EditorStore(deck);
    restoreEditorView(reopened, readRememberedSlide('talk'));
    expect(reopened.get().slideIndex).toBe(0);
    expect(reopened.get().dirty).toBe(false);
  });

  it('still opens when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readRememberedSlide('talk')).toBeNull();
    expect(() => rememberSlide('talk', 'slide-2')).not.toThrow();
  });
});
