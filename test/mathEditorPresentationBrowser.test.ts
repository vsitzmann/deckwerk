import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Deck } from '../src/shared/deck.js';
import { electronBinary, eventually } from './support/browserSession.js';
import { startCrossSession, type CrossSession } from './support/crossContextSession.js';

let session: CrossSession;
let close: (() => Promise<void>) | null = null;
beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startCrossSession('math-editor-present', 'Equation alignment');
  session = started.session;
  close = started.close;
}, 180_000);
afterAll(async () => { await close?.(); });
const readDeck = () => session.cdp.evaluate<Deck>(`fetch('/api/deck?deck=math-editor-present').then(r=>r.json())`);

const equation = String.raw`$\mathcal{L}=\sum\nolimits_c\Big\lVert\,\mathbf{I}_c-\mathcal{R}_c\Big(\sum\nolimits_k\,\delta_k\ast k_k\Big)\Big\rVert_2$`;
const glyphs = `(() => {
  const node = document.querySelector('#canvas .slide-layer [data-element-id="equation"]') ?? document.querySelector('.player-root [data-element-id="equation"]');
  if (!node) return null;
  const stage = node.closest('.stage');
  const origin = stage.getBoundingClientRect();
  const scale = origin.width / 1920;
  return [...node.querySelectorAll('.katex-html *')]
    .filter(n => n.childNodes.length && [...n.childNodes].every(c => c.nodeType === 3) && n.textContent.trim())
    .map(n => { const r = n.getBoundingClientRect(); return { text: n.textContent, x: (r.x-origin.x)/scale, y: (r.y-origin.y)/scale, w: r.width/scale }; });
})()`;

const arrowBox = `(() => {
  const node = document.querySelector('#canvas .slide-layer [data-element-id="annotation"]')
    ?? document.querySelector('.player-root [data-element-id="annotation"]');
  const origin = node.closest('.stage').getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const scale = origin.width / 1920;
  return { x: (rect.x-origin.x)/scale, y: (rect.y-origin.y)/scale,
    w: rect.width/scale, h: rect.height/scale };
})()`;

describe.skipIf(!electronBinary)('equations stay aligned across editor and presentation', () => {
  it('keeps auto-sized centered math at the same slide coordinates', async () => {
    await session.cdp.evaluate(`(() => {
      window.store.commit(deck => { deck.slides[0].elements = [{
        id: 'equation', type: 'text', x: 575, y: 481, w: 770, h: 99, rot: 0, z: 1,
        opacity: 1, class: [], style: {'font-size':'48px'}, html: ${JSON.stringify(equation)},
        align: 'center', valign: 'middle', autoSize: true, noWrap: true,
      }, {
        id: 'annotation', type: 'shape', x: 1132, y: 457, w: 78, h: 2, rot: 73.3, z: 2,
        opacity: 1, class: [], style: {}, shape: 'line', fill: null, stroke: '#c8372d',
        strokeWidth: 2, radius: 0, arrowStart: false, arrowEnd: true, path: null,
      }]; }); return true;
    })()`);
    await eventually(() => session.cdp.evaluate(`document.querySelectorAll('#canvas .slide-layer [data-element-id="equation"] .katex-html').length`), 'math never rendered', n => n === 1);
    await session.cdp.evaluate('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
    const editor = await session.cdp.evaluate<Array<{text:string;x:number;y:number;w:number}>>(glyphs);
    const saved = await eventually(readDeck, 'fixture never reached the server',
      deck => deck.slides[0].elements.some(element => element.id === 'equation'));
    const arrow = await session.cdp.evaluate(arrowBox);
    await session.cdp.evaluate(`(location.href = new URL('/present.html?deck=math-editor-present&windowed=1', location.href).href, true)`);
    await eventually(() => session.cdp.evaluate(`document.querySelectorAll('[data-element-id="equation"] .katex-html').length`), 'presentation never rendered the math', n => n === 1);
    await session.cdp.evaluate('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
    const presented = await session.cdp.evaluate<Array<{text:string;x:number;y:number;w:number}>>(glyphs);
    expect(editor.length).toBeGreaterThan(10);
    expect(presented.length).toBe(editor.length);
    const after = await readDeck();
    const presentedArrow = await session.cdp.evaluate<Record<string, number>>(arrowBox);
    for (const [key, value] of Object.entries(arrow as Record<string, number>)) {
      expect(Math.abs(presentedArrow[key] - value), `annotation ${key} changed`).toBeLessThan(1);
    }
    expect(after, 'presentation must not change the saved deck or annotation positions').toEqual(saved);
    for (let i = 0; i < editor.length; i++) {
      expect(presented[i].text).toBe(editor[i].text);
      expect(Math.abs(presented[i].x-editor[i].x), `${editor[i].text} moved horizontally`).toBeLessThan(1);
      expect(Math.abs(presented[i].y-editor[i].y), `${editor[i].text} moved vertically`).toBeLessThan(1);
      expect(Math.abs(presented[i].w-editor[i].w), `${editor[i].text} changed width`).toBeLessThan(1);
    }
  }, 60_000);
});
