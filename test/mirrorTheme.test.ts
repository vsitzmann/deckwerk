import { describe, expect, it } from 'vitest';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';
import { mirrorThemeAction } from '../src/server/mirrorTheme.js';
import { headlessElectronArgs } from '../src/cli/electronDisplay.js';
import { THEME_BLOCK_START } from '../src/shared/themes.js';

const deck = () => parseDeck({
  ...emptyDeck('Themes'),
  slides: [
    { id: 's1', elements: [{ id: 'e1', type: 'text', x: 0, y: 0, w: 400, h: 80, html: 'hello', class: ['role-title'] }] },
    { id: 's2' },
  ],
});

describe('mirror theme verbs', () => {
  it('lists the built-in gallery, Research included', () => {
    const result = mirrorThemeAction(deck(), '', { action: 'list' });
    if ('error' in result) throw new Error(result.error);
    expect(result.operations).toEqual([]);
    expect(result.body.themes).toContainEqual(expect.objectContaining({ id: 'basic', name: 'Research', source: 'built-in' }));
  });

  it('finds a theme by its name as well as its id', () => {
    const result = mirrorThemeAction(deck(), '', { action: 'show', id: 'research' });
    if ('error' in result) throw new Error(result.error);
    expect(result.body.theme).toMatchObject({ id: 'basic' });
  });

  it('applies a theme deck-wide, keeping the hand-written CSS around the generated block', () => {
    const result = mirrorThemeAction(deck(), '/* mine */\n.custom { color: red; }\n', { action: 'apply', id: 'basic' });
    if ('error' in result) throw new Error(result.error);
    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.body).toMatchObject({ scope: 'deck', slides: 2 });
    expect(result.css).toContain('.custom { color: red; }');
    expect(result.css).toContain(THEME_BLOCK_START);
    expect(result.css).toContain('Charter');
  });

  it('chooses a theme for new slides without restyling existing ones', () => {
    const result = mirrorThemeAction(deck(), '', { action: 'choose', id: 'basic' });
    if ('error' in result) throw new Error(result.error);
    expect(result.operations.some((op) => op.op === 'updateDeck')).toBe(true);
    expect(result.css).toContain('Charter');
  });

  it('refuses unknown themes and slide-scoped applies with no slides', () => {
    expect(mirrorThemeAction(deck(), '', { action: 'apply', id: 'nope' })).toMatchObject({ status: 404 });
    expect(mirrorThemeAction(deck(), '', { action: 'apply', id: 'basic', scope: 'slides', slideIds: [] })).toMatchObject({ status: 400 });
    expect(mirrorThemeAction(deck(), '', { action: 'choose' })).toMatchObject({ status: 400 });
  });
});

describe('Electron helpers on a headless server', () => {
  it('switches to the headless platform only on Linux with no display', () => {
    const expected = process.platform === 'linux' ? ['--ozone-platform=headless'] : [];
    expect(headlessElectronArgs({})).toEqual(expected);
    expect(headlessElectronArgs({ DISPLAY: ':0' })).toEqual([]);
    expect(headlessElectronArgs({ WAYLAND_DISPLAY: 'wayland-1' })).toEqual([]);
  });
});
