import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDeck } from '../src/shared/deck.js';
import { electronBinary, eventually } from './support/browserSession.js';
import { MOD, startCrossSession, type CrossSession } from './support/crossContextSession.js';

let session: CrossSession;
let close: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (!electronBinary) throw new Error('Electron is required for the appearance regression');
  const started = await startCrossSession('arrow-style', 'Arrow appearance');
  session = started.session;
  close = started.close;
}, 180_000);
afterAll(async () => { await close?.(); });

const shapes = parseDeck({ version: 1, slides: [{ id: 'shapes', elements: [
  { id: 'source', type: 'shape', shape: 'arrow', x: 200, y: 260, w: 550, h: 2,
    stroke: '#c8372d', strokeWidth: 18, strokeStyle: 'pencil', strokeDash: 'dashed',
    arrowEnd: true, arrowSize: 42, opacity: 0.7, style: { filter: 'drop-shadow(0px 0px 4px #000)' } },
  { id: 'target', type: 'shape', shape: 'line', x: 950, y: 520, w: 350, h: 2,
    stroke: '#0000ff', strokeWidth: 3, arrowStart: true, startCap: 'dot' },
] }] }).slides[0].elements;

describe('arrow Copy/Paste Appearance with real shortcuts', () => {
  for (const modifier of [1]) {
    it(`copies native line appearance with modifier ${modifier}, retaining geometry and undo`, async () => {
      await session.cdp.evaluate(`(() => {
        window.store.commit(d => { d.slides[0].elements = ${JSON.stringify(shapes)}; }, {label:'Arrow fixture'});
        window.store.selectSlide(0); window.store.clearSelection();
      })()`);
      const before = await session.deckSnapshot();
      await session.click('source');
      await session.chord('c', 'KeyC', 67, MOD | modifier);
      await session.click('target');
      await session.chord('v', 'KeyV', 86, MOD | modifier);
      // BUG: shapes were excluded from the style clipboard, so native stroke properties were never copied.
      await eventually(() => session.cdp.evaluate<number>(`window.store.slide.elements.find(e => e.id === 'target').strokeWidth`),
        'Paste Appearance did not copy arrow thickness', width => width === 18);
      const target = await session.cdp.evaluate<Record<string, unknown>>(`window.store.slide.elements.find(e => e.id === 'target')`);
      expect(target).toMatchObject({ shape: 'line', x: 950, y: 520, w: 350, h: 2,
        stroke: '#c8372d', strokeWidth: 18, strokeStyle: 'pencil', strokeDash: 'dashed',
        arrowStart: false, arrowEnd: true, arrowSize: 42, opacity: 0.7 });
      expect(target.startCap).toBeUndefined();
      await session.chord('z', 'KeyZ', 90, MOD);
      expect(await session.deckSnapshot()).toBe(before);
      expect(await session.problems()).toEqual([]);
    }, 60_000);
  }
});
