import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, eventually, wait } from './support/browserSession.js';
import { launchDesktopEditor, type DesktopEditor } from './support/desktopEditorSession.js';

/**
 * Zooming and panning the canvas with a plain mouse and the keyboard, in the
 * REAL desktop app with real CDP input: a wheel notch with Ctrl/Cmd, Shift
 * and the wheel, a middle-button drag, Space and a drag, Cmd/Ctrl + - 0.
 *
 * The desktop app runs Electron's default menu, whose View zoom roles answer
 * Cmd/Ctrl + - 0 for the whole window; the canvas must take those keys
 * first, so devicePixelRatio (which carries the page zoom) never moves.
 */
const TEXT = 'viewport-text';
const MOD = process.platform === 'darwin' ? 4 : 2;
const SHIFT = 8;

let desktop: DesktopEditor | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  desktop = await launchDesktopEditor(TEXT, '<p>Pan and zoom</p>');
}, 180_000);

afterAll(async () => {
  await desktop?.close();
  desktop = null;
});

interface View {
  zoom: string;
  left: number;
  top: number;
  /** The text box's offset inside the stage: changes only if it moved. */
  textLeft: number;
  textTop: number;
  handles: number;
  editing: boolean;
  pixelRatio: number;
  cursor: string;
}

const view = () => desktop!.cdp.evaluate<View>(`(() => {
  const stage = document.querySelector('#canvas .stage').getBoundingClientRect();
  const text = document.querySelector('#canvas [data-element-id="${TEXT}"]').getBoundingClientRect();
  return {
    zoom: document.querySelector('#canvas .zoom-value').value,
    left: stage.left,
    top: stage.top,
    textLeft: (text.left - stage.left) / stage.width,
    textTop: (text.top - stage.top) / stage.height,
    handles: document.querySelectorAll('#canvas .handle').length,
    editing: Boolean(document.querySelector('#canvas .editing')),
    pixelRatio: window.devicePixelRatio,
    cursor: getComputedStyle(document.getElementById('canvas')).cursor,
  };
})()`);

/** A point on the text box, and one on empty pasteboard beside the slide. */
const points = () => desktop!.cdp.evaluate<{ text: { x: number; y: number }; empty: { x: number; y: number } }>(`(() => {
  const text = document.querySelector('#canvas [data-element-id="${TEXT}"]').getBoundingClientRect();
  const stage = document.querySelector('#canvas .stage').getBoundingClientRect();
  return {
    text: { x: text.left + 40, y: text.top + text.height / 2 },
    empty: { x: stage.left + stage.width / 2, y: stage.bottom - 10 },
  };
})()`);

async function mouse(
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  x: number,
  y: number,
  button: 'none' | 'left' | 'middle',
  buttons: number,
): Promise<void> {
  await desktop!.cdp.call('Input.dispatchMouseEvent', {
    type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
}

async function wheelAt(x: number, y: number, deltaY: number, modifiers: number): Promise<void> {
  await desktop!.cdp.call('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers,
  });
  await wait(80);
}

async function recenter(): Promise<void> {
  await desktop!.cdp.chord('0', 'Digit0', 48, MOD);
  await eventually(async () => (await view()).zoom === '100%', 'Ctrl/Cmd+0 did not fit the slide');
}

/** Read the slide without the pan any test left behind. */
async function fresh(): Promise<View> {
  const start = await points();
  await mouse('mousePressed', start.empty.x, start.empty.y, 'left', 1);
  await mouse('mouseReleased', start.empty.x, start.empty.y, 'left', 0);
  await wait(80);
  await recenter();
  return view();
}

describe.skipIf(!electronBinary)('canvas zoom and pan with a plain mouse and the keyboard', () => {
  it('zooms one wheel notch by ×1.1 about the pointer, and back', { timeout: 60_000 }, async () => {
    const start = await fresh();
    const { text } = await points();
    // Chromium's notch on Linux: 120 px. Wheel away from you zooms in.
    await wheelAt(text.x, text.y, -120, MOD);
    const zoomed = await view();
    expect(zoomed.zoom).toBe('110%');
    expect(zoomed.pixelRatio).toBe(start.pixelRatio);
    await wheelAt(text.x, text.y, 120, MOD);
    const back = await view();
    expect(back.zoom).toBe('100%');
    expect(back.left).toBeCloseTo(start.left, 0);
    expect(back.top).toBeCloseTo(start.top, 0);
    // Windows reports 100 px a notch; the same ×1.1.
    await wheelAt(text.x, text.y, -100, MOD);
    expect((await view()).zoom).toBe('110%');
  });

  it('pans sideways with Shift and the wheel', { timeout: 60_000 }, async () => {
    const start = await fresh();
    const { empty } = await points();
    await wheelAt(empty.x, empty.y, 100, SHIFT);
    const after = await view();
    expect(after.left).toBeCloseTo(start.left - 100, 0);
    expect(after.top).toBeCloseTo(start.top, 0);
  });

  it('pans with a middle-button drag over a text box, which stays put and unselected', {
    timeout: 60_000,
  }, async () => {
    const start = await fresh();
    expect(start.handles).toBe(0);
    const { text } = await points();
    await mouse('mouseMoved', text.x, text.y, 'none', 0);
    await mouse('mousePressed', text.x, text.y, 'middle', 4);
    for (let i = 1; i <= 5; i++) {
      await mouse('mouseMoved', text.x + 12 * i, text.y + 8 * i, 'middle', 4);
      await wait(16);
    }
    await mouse('mouseReleased', text.x + 60, text.y + 40, 'middle', 0);
    await wait(120);
    const after = await view();
    expect(after.left).toBeCloseTo(start.left + 60, 0);
    expect(after.top).toBeCloseTo(start.top + 40, 0);
    expect(after.handles).toBe(0);
    expect(after.editing).toBe(false);
    expect(after.textLeft).toBeCloseTo(start.textLeft, 6);
    expect(after.textTop).toBeCloseTo(start.textTop, 6);
  });

  it('pans with Space held and a drag, then a plain press selects again', { timeout: 60_000 }, async () => {
    const start = await fresh();
    const { text } = await points();
    const space = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
    await desktop!.cdp.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...space });
    await desktop!.cdp.call('Input.dispatchKeyEvent', { type: 'char', text: ' ', unmodifiedText: ' ', ...space });
    await wait(60);
    expect((await view()).cursor).toBe('grab');
    await mouse('mouseMoved', text.x, text.y, 'none', 0);
    await mouse('mousePressed', text.x, text.y, 'left', 1);
    for (let i = 1; i <= 5; i++) {
      await mouse('mouseMoved', text.x - 10 * i, text.y + 6 * i, 'left', 1);
      await wait(16);
    }
    expect((await view()).cursor).toBe('grabbing');
    await mouse('mouseReleased', text.x - 50, text.y + 30, 'left', 0);
    await desktop!.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...space });
    await wait(120);
    const after = await view();
    expect(after.left).toBeCloseTo(start.left - 50, 0);
    expect(after.top).toBeCloseTo(start.top + 30, 0);
    expect(after.handles).toBe(0);
    expect(after.textLeft).toBeCloseTo(start.textLeft, 6);
    expect(after.textTop).toBeCloseTo(start.textTop, 6);
    expect(after.cursor).not.toBe('grab');

    const moved = await points();
    await mouse('mousePressed', moved.text.x, moved.text.y, 'left', 1);
    await mouse('mouseReleased', moved.text.x, moved.text.y, 'left', 0);
    await eventually(async () => (await view()).handles > 0, 'a plain press after Space did not select');
  });

  it('zooms with Ctrl/Cmd = + - and fits with 0, never zooming the window', { timeout: 60_000 }, async () => {
    const start = await fresh();
    await desktop!.cdp.chord('=', 'Equal', 187, MOD);
    await eventually(async () => (await view()).zoom === '125%', 'Ctrl/Cmd+= did not zoom in');
    await desktop!.cdp.chord('+', 'Equal', 187, MOD | SHIFT);
    await eventually(async () => (await view()).zoom === '150%', 'Ctrl/Cmd++ did not zoom in');
    await desktop!.cdp.chord('-', 'Minus', 189, MOD);
    await eventually(async () => (await view()).zoom === '125%', 'Ctrl/Cmd+- did not zoom out');
    const { empty } = await points();
    await wheelAt(empty.x, empty.y, 100, SHIFT);
    await recenter();
    const after = await view();
    expect(after.left).toBeCloseTo(start.left, 0);
    expect(after.top).toBeCloseTo(start.top, 0);
    // Give a menu accelerator that also fired time to land.
    await wait(300);
    expect((await view()).pixelRatio).toBe(start.pixelRatio);
  });
});

describe.skipIf(electronBinary)('canvas zoom and pan with a plain mouse (skipped)', () => {
  it('needs Electron', () => expect(electronBinary).toBe(''));
});
