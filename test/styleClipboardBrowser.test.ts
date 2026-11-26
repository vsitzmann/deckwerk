import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary } from './support/browserSession.js';
import { startCrossSession, type CrossSession, MOD, IMAGE, PARA, FAR } from './support/crossContextSession.js';

let session: CrossSession;
let close: (() => Promise<void>) | null = null;
beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startCrossSession('style-clipboard', 'Style clipboard');
  session = started.session; close = started.close;
}, 180_000);
afterAll(async () => { await close?.(); });

describe.skipIf(!electronBinary)('copy and paste object style', () => {
  it('routes real style shortcuts across slides for media and text, preserving content and supporting undo', async () => {
    await session.cdp.evaluate(`window.store.commit((deck) => {
      const image = deck.slides[0].elements.find(e => e.id === '${IMAGE}');
      image.style['box-shadow'] = '0 4px 6px rgb(0, 0, 0)';
      image.borderWidth = 4; image.borderColor = '#ff0000'; image.borderRadius = 12;
      deck.slides[1].elements.push({ ...structuredClone(image), id: 'style-target', x: 700, y: 470, w: 220, h: 140, borderWidth: 1, borderRadius: 0, style: {} });
      const text = deck.slides[0].elements.find(e => e.id === '${PARA}');
      text.html = '<strong>Source style</strong>'; text.style = { 'font-size': '36px', color: '#ff0000' };
    })`);
    await session.click(IMAGE);
    await session.chord('ç', 'KeyC', 67, MOD | 1);
    await session.clickRail(1);
    await session.click('style-target');
    await session.chord('√', 'KeyV', 86, MOD | 1);
    const target = () => session.cdp.evaluate<Record<string, unknown>>(`window.store.get().deck.slides[1].elements.find(e => e.id === 'style-target')`);
    expect(await target()).toMatchObject({ x: 700, y: 470, w: 220, h: 140, borderWidth: 4, borderRadius: 12, borderColor: '#ff0000' });
    await session.chord('z', 'KeyZ', 90, MOD);
    expect(await target()).toMatchObject({ borderWidth: 1, borderRadius: 0 });
    await session.clickRail(0);
    await session.click(PARA);
    await session.chord('ç', 'KeyC', 67, MOD | 1);
    await session.clickRail(1);
    const before = await session.textOf(FAR);
    await session.click(FAR);
    await session.chord('√', 'KeyV', 86, MOD | 1);
    expect(await session.textOf(FAR)).toBe(before);
    const text = await session.cdp.evaluate<Record<string, unknown>>(`window.store.get().deck.slides[1].elements.find(e => e.id === '${FAR}')`);
    expect(text).toMatchObject({ style: { 'font-size': '36px', 'font-weight': '700', color: 'rgb(255, 0, 0)' } });
    expect(await session.problems()).toEqual([]);
  }, 120_000);
});
