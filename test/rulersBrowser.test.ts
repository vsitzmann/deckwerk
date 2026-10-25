import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import { launchDesktopEditor, type DesktopEditor } from './support/desktopEditorSession.js';
import { launchWebEditor, type WebEditorSession } from './support/webEditorSession.js';
import { emptyDeck, parseDeck } from '../src/shared/deck.js';

/**
 * Canvas rulers in the REAL desktop app, with real input: Cmd/Ctrl+R shows
 * and hides them (mid text edit too) instead of Electron's default menu
 * reloading the window, their ticks stay on slide coordinates through zoom
 * and pan, the selection and the pointer are marked on them, both UI themes
 * colour them, and the choice survives a reload of the window.
 */
const TEXT = 'rulers-text';
const MOD = process.platform === 'darwin' ? 4 : 2;

let desktop: DesktopEditor | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  desktop = await launchDesktopEditor(TEXT, '<p>Measure me</p>');
}, 180_000);

afterAll(async () => {
  await desktop?.close();
  desktop = null;
});

const rulersKey = () => desktop!.cdp.chord('r', 'KeyR', 82, MOD);
const shown = () => desktop!.cdp.evaluate<boolean>(
  `!document.querySelector('#canvas .canvas-ruler-top').hasAttribute('hidden')`,
);

interface Reading {
  /** Screen pixels per slide unit, from the stage's drawn width. */
  scale: number;
  stageLeft: number;
  stageTop: number;
  /** Every labelled tick: its value and its screen position. */
  top: Array<{ value: number; at: number }>;
  left: Array<{ value: number; at: number }>;
  band: { x: number; w: number; y: number; h: number } | null;
  text: { x: number; w: number; y: number; h: number };
  pointer: { x: number; y: number } | null;
}

/** What the rulers show, in screen pixels, beside where the stage and text box are drawn. */
const read = () => desktop!.cdp.evaluate<Reading>(`(() => {
  const stage = document.querySelector('#canvas .stage').getBoundingClientRect();
  const top = document.querySelector('#canvas .canvas-ruler-top');
  const left = document.querySelector('#canvas .canvas-ruler-left');
  const topBox = top.getBoundingClientRect();
  const leftBox = left.getBoundingClientRect();
  const labels = (ruler, side, box) => [...ruler.querySelectorAll('.canvas-ruler-label')].map((label) => ({
    value: Number(label.textContent),
    at: side === 'top'
      ? box.left + Number(label.getAttribute('x')) - 3
      : box.top + Number(label.getAttribute('y')) + 3,
  }));
  const topBand = top.querySelector('.canvas-ruler-selection');
  const leftBand = left.querySelector('.canvas-ruler-selection');
  const topPointer = top.querySelector('.canvas-ruler-pointer');
  const leftPointer = left.querySelector('.canvas-ruler-pointer');
  const text = document.querySelector('#canvas .slide-layer [data-element-id="${TEXT}"]').getBoundingClientRect();
  return {
    scale: stage.width / 1920,
    stageLeft: stage.left,
    stageTop: stage.top,
    top: labels(top, 'top', topBox),
    left: labels(left, 'left', leftBox),
    band: topBand.hasAttribute('hidden') ? null : {
      x: topBox.left + Number(topBand.getAttribute('x')),
      w: Number(topBand.getAttribute('width')),
      y: leftBox.top + Number(leftBand.getAttribute('y')),
      h: Number(leftBand.getAttribute('height')),
    },
    text: { x: text.left, w: text.width, y: text.top, h: text.height },
    pointer: topPointer.hasAttribute('hidden') ? null : {
      x: topBox.left + Number(topPointer.getAttribute('x1')),
      y: leftBox.top + Number(leftPointer.getAttribute('y1')),
    },
  };
})()`);

/** Every labelled tick sits within a pixel of where the stage draws its coordinate. */
function expectAligned(reading: Reading): void {
  expect(reading.top.length).toBeGreaterThan(2);
  expect(reading.left.length).toBeGreaterThan(2);
  for (const tick of reading.top) {
    expect(Math.abs(tick.at - (reading.stageLeft + tick.value * reading.scale))).toBeLessThanOrEqual(1);
  }
  for (const tick of reading.left) {
    expect(Math.abs(tick.at - (reading.stageTop + tick.value * reading.scale))).toBeLessThanOrEqual(1);
  }
}

describe.skipIf(!electronBinary)('canvas rulers in the desktop app', () => {
  it('Cmd/Ctrl+R shows them beside the slide, without reloading the window', { timeout: 60_000 }, async () => {
    const { cdp } = desktop!;
    expect(await shown()).toBe(false);
    await cdp.evaluate('window.__rulersMarker = 1');
    const before = await cdp.evaluate<{ left: number; top: number }>(`(() => {
      const r = document.querySelector('#canvas .stage').getBoundingClientRect();
      return { left: r.left, top: r.top };
    })()`);
    await rulersKey();
    await eventually(shown, 'Cmd/Ctrl+R did not show the rulers');
    // Had the chord also reached the default menu's Reload, the page would
    // have reloaded by now. (Where the harness's synthetic keys reach the
    // native menu at all; the zoom chords rely on the same preventDefault.)
    await wait(300);
    expect(await cdp.evaluate('window.__rulersMarker')).toBe(1);
    expect(await cdp.evaluate(`localStorage.getItem('deckwerk.editor.rulers')`)).toBe('1');
    expect(await cdp.evaluate(`document.querySelector('.rulers-toggle').getAttribute('aria-pressed')`)).toBe('true');
    const reading = await read();
    // The slide moved over to make room rather than sliding under them.
    expect(reading.stageLeft).toBeGreaterThan(before.left);
    expect(reading.stageTop).toBeGreaterThan(before.top);
    expectAligned(reading);
    expect(reading.top.some((tick) => tick.value === 0)).toBe(true);
  });

  it('moves the floating speaker-notes button clear of the left ruler', { timeout: 60_000 }, async () => {
    // BUG (fixed here): the notes toggle floats 12px from the canvas's left
    // edge, which is where the left ruler is drawn, so it sat on the ruler.
    const { cdp } = desktop!;
    const place = () => cdp.evaluate<{ toggle: number; ruler: number; canvas: number }>(`(() => ({
      toggle: document.querySelector('#canvas .notes-toggle').getBoundingClientRect().left,
      ruler: document.querySelector('#canvas .canvas-ruler-left').getBoundingClientRect().right,
      canvas: document.querySelector('#canvas').getBoundingClientRect().left,
    }))()`);
    if (!(await shown())) {
      await rulersKey();
      await eventually(shown, 'Cmd/Ctrl+R did not show the rulers');
    }
    const withRulers = await place();
    // The same 12px gap it keeps from the canvas edge, measured from the ruler.
    expect(withRulers.toggle - withRulers.ruler).toBeGreaterThanOrEqual(11);
    await rulersKey();
    await eventually(async () => !(await shown()), 'Cmd/Ctrl+R did not hide the rulers');
    const without = await place();
    expect(Math.round(without.toggle - without.canvas)).toBe(12);
    await rulersKey();
    await eventually(shown, 'Cmd/Ctrl+R did not show the rulers again');
  });

  it('keeps the ticks on slide coordinates through zoom and pan', { timeout: 60_000 }, async () => {
    const { cdp } = desktop!;
    await cdp.chord('=', 'Equal', 187, MOD);
    await eventually(async () => cdp.evaluate<string>(`document.querySelector('#canvas .zoom-value').value`),
      'Cmd/Ctrl+= did not zoom', (zoom) => zoom === '125%');
    expectAligned(await read());
    const start = await read();
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: start.stageLeft + 200, y: start.stageTop + 200, deltaX: 120, deltaY: 80,
    });
    await eventually(async () => (await read()).stageLeft, 'the wheel did not pan', (left) => Math.abs(left - start.stageLeft) > 50);
    expectAligned(await read());
    await cdp.chord('0', 'Digit0', 48, MOD);
    await eventually(async () => cdp.evaluate<string>(`document.querySelector('#canvas .zoom-value').value`),
      'Cmd/Ctrl+0 did not fit', (zoom) => zoom === '100%');
    expectAligned(await read());
  });

  it('bands the selection and marks the pointer', { timeout: 60_000 }, async () => {
    const { cdp } = desktop!;
    expect((await read()).band).toBeNull();
    await cdp.click(`#canvas [data-element-id="${TEXT}"]`);
    await eventually(async () => (await read()).band, 'selecting the text box drew no band', (band) => band !== null);
    const { band, text } = await read();
    expect(Math.abs(band!.x - text.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(band!.w - text.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(band!.y - text.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(band!.h - text.h)).toBeLessThanOrEqual(1);

    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 420 });
    await eventually(async () => (await read()).pointer, 'the pointer was not marked',
      (pointer) => pointer !== null && Math.abs(pointer.x - 640.5) <= 1 && Math.abs(pointer.y - 420.5) <= 1);
  });

  it('toggles mid text edit, and colours them from the UI theme', { timeout: 60_000 }, async () => {
    const { cdp } = desktop!;
    await cdp.doubleClick(`#canvas [data-element-id="${TEXT}"] .text-content`);
    await eventually(async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('#canvas .editing'))`),
      'the text box did not enter editing');
    await rulersKey();
    await eventually(async () => !(await shown()), 'Cmd/Ctrl+R mid edit did not hide the rulers');
    expect(await cdp.evaluate<boolean>(`Boolean(document.querySelector('#canvas .editing'))`)).toBe(true);
    await rulersKey();
    await eventually(shown, 'Cmd/Ctrl+R mid edit did not show the rulers again');
    await cdp.key('Escape', 27);

    const colours = (theme: string) => cdp.evaluate<{ ruler: string; panel: string; label: string; muted: string }>(`(() => {
      document.documentElement.dataset.uiTheme = '${theme}';
      const ruler = document.querySelector('#canvas .canvas-ruler-top');
      const probe = document.createElement('div');
      probe.style.cssText = 'background: var(--panel-2); color: var(--muted)';
      document.body.append(probe);
      const result = {
        ruler: getComputedStyle(ruler).backgroundColor,
        panel: getComputedStyle(probe).backgroundColor,
        label: getComputedStyle(ruler.querySelector('.canvas-ruler-label')).fill,
        muted: getComputedStyle(probe).color,
      };
      probe.remove();
      return result;
    })()`);
    const dark = await colours('dark');
    const light = await colours('light');
    expect(dark.ruler).toBe(dark.panel);
    expect(light.ruler).toBe(light.panel);
    expect(dark.label).toBe(dark.muted);
    expect(light.label).toBe(light.muted);
    expect(light.ruler).not.toBe(dark.ruler);
  });

  it('stays on after the window reloads, and the zoom pill button hides them', { timeout: 60_000 }, async () => {
    const { cdp } = desktop!;
    await cdp.evaluate('location.reload()');
    await eventually(async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('#canvas .canvas-ruler-top')
      && document.querySelector('#canvas [data-element-id="${TEXT}"]'))`), 'the editor did not come back');
    expect(await shown()).toBe(true);
    await cdp.click('#canvas .zoom-controls .rulers-toggle');
    await eventually(async () => !(await shown()), 'the toggle did not hide the rulers');
    expect(await cdp.evaluate(`localStorage.getItem('deckwerk.editor.rulers')`)).toBe('0');
  });
});

describe.skipIf(!electronBinary)('canvas rulers in the browser editor', () => {
  let web: WebEditorSession | null = null;

  afterAll(async () => {
    await web?.close();
    web = null;
  });

  it('shows them from the zoom pill, aligned with the slide', { timeout: 120_000 }, async () => {
    const deck = parseDeck({
      ...emptyDeck('Rulers on the web'),
      slides: [{ id: 'slide-a', elements: [{
        id: TEXT, type: 'text', x: 300, y: 200, w: 800, h: 160, class: ['role-body'], html: 'Measure me',
      }] }],
    });
    web = await launchWebEditor([{ id: 'rulers', deck }], { userName: 'Ada', tmpPrefix: 'rulers-' });
    const { cdp } = web;
    await eventually(async () => cdp.evaluate<boolean>(
      `Boolean(document.querySelector('#canvas [data-element-id="${TEXT}"]'))`,
    ), 'the browser editor did not open the deck');
    const readWeb = () => cdp.evaluate<{ hidden: boolean; scale: number; stageLeft: number; ticks: Array<{ value: number; at: number }> }>(`(() => {
      const stage = document.querySelector('#canvas .stage').getBoundingClientRect();
      const top = document.querySelector('#canvas .canvas-ruler-top');
      const box = top.getBoundingClientRect();
      return {
        hidden: top.hasAttribute('hidden'),
        scale: stage.width / 1920,
        stageLeft: stage.left,
        ticks: [...top.querySelectorAll('.canvas-ruler-label')].map((label) => ({
          value: Number(label.textContent),
          at: box.left + Number(label.getAttribute('x')) - 3,
        })),
      };
    })()`);
    expect((await readWeb()).hidden).toBe(true);
    expect(await cdp.evaluate(`document.querySelector('.rulers-toggle').title`)).toBe('Show rulers');
    await cdp.click('#canvas .zoom-controls .rulers-toggle');
    await eventually(async () => !(await readWeb()).hidden, 'the toggle did not show the rulers');
    const reading = await readWeb();
    expect(reading.ticks.length).toBeGreaterThan(2);
    for (const tick of reading.ticks) {
      expect(Math.abs(tick.at - (reading.stageLeft + tick.value * reading.scale))).toBeLessThanOrEqual(1);
    }
  });
});

describe.skipIf(electronBinary)('canvas rulers in the desktop app (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
