import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { electronBinary, wait } from './support/browserSession.js';
import {
  TEXT_A,
  startSelectionSession,
  type SelectionSession,
} from './support/selectionSession.js';

/**
 * How the editor paints its own chrome over and beside the slide, driven by
 * real input on the selection fixture (test/support/selectionSession.ts).
 */
const DECK_ID = 'editor-chrome-paint';

let session: SelectionSession;
let close: (() => Promise<void>) | null = null;

beforeAll(async () => {
  if (!electronBinary) return;
  const started = await startSelectionSession(DECK_ID, 'Editor Chrome Paint');
  session = started.session;
  close = started.close;
}, 180_000);

afterAll(async () => {
  await close?.();
  close = null;
});

/** A real primary-button drag along a path of viewport points. */
async function dragPath(
  points: Array<{ x: number; y: number }>,
  betweenPoints?: () => Promise<void>,
): Promise<void> {
  const cdp = session.cdp;
  const start = points[0];
  const end = points[points.length - 1];
  await cdp.call('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0,
  });
  await cdp.call('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: 1, clickCount: 1,
  });
  for (const point of points.slice(1)) {
    await cdp.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, button: 'left', buttons: 1,
    });
    await wait(30);
    await betweenPoints?.();
  }
  await cdp.call('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1,
  });
}

/**
 * How opaque a CSS colour is, 0–1, whatever syntax the computed style uses
 * (rgb, oklch, color-mix): the page paints it and reads the pixel back.
 */
const ALPHA_OF = `((color) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data[3] / 255;
})`;

/** Run `body` with the editor chrome in one UI theme, then put it back. */
async function inTheme(theme: 'dark' | 'light', body: () => Promise<void>): Promise<void> {
  await session.cdp.evaluate(`document.documentElement.dataset.uiTheme = ${JSON.stringify(theme)}`);
  try {
    await body();
  } finally {
    await session.cdp.evaluate(`delete document.documentElement.dataset.uiTheme`);
  }
}

describe.skipIf(!electronBinary)('editor chrome drawn over the slide', () => {
  // The tint on a box being typed into and the marquee's fill sit on top of
  // slide content, so both must stay see-through. The 2026-10 chrome redesign
  // made the shared --accent-soft token an opaque swatch for buttons and rail
  // rows, and both rules still used it: double-clicking a text box hid
  // whatever was behind it (a black caption plate, a photograph) under solid
  // dark blue, and a marquee drag hid every object it swept.
  for (const theme of ['dark', 'light'] as const) {
    it(`keeps a box being edited see-through in ${theme} chrome`, {
      timeout: 30_000,
    }, async () => {
      await session.reset();
      await inTheme(theme, async () => {
        await session.doubleClick(TEXT_A);
        const tint = await session.cdp.evaluate<{ shadow: string; background: string; alpha: number } | null>(`(() => {
          const node = document.querySelector('.slide-layer .element.editing');
          if (!node) return null;
          const style = getComputedStyle(node);
          const shadow = style.boxShadow;
          const color = shadow === 'none' ? 'transparent'
            : shadow.match(/^([a-z-]+\\([^)]*\\)|#[0-9a-f]+|[a-z]+)/i)[1];
          return {
            shadow,
            background: style.backgroundColor,
            alpha: Math.max(${ALPHA_OF}(color), ${ALPHA_OF}(style.backgroundColor)),
          };
        })()`);
        await session.key('Escape', 27);
        expect(tint, 'double-clicking A opens it for typing').not.toBeNull();
        expect(
          tint!.alpha,
          `the edit tint lets the slide show through (box-shadow ${tint!.shadow}, background ${tint!.background})`,
        ).toBeLessThanOrEqual(0.25);
      });
    });

    it(`keeps the marquee see-through in ${theme} chrome`, {
      timeout: 30_000,
    }, async () => {
      await session.reset();
      await inTheme(theme, async () => {
        const layer = await session.cdp.evaluate<{ left: number; top: number; width: number; height: number }>(`(() => {
          const rect = document.querySelector('.slide-layer').getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        })()`);
        // From the empty lower band up across the objects, as a person sweeps.
        const at = (fx: number, fy: number) => ({ x: layer.left + layer.width * fx, y: layer.top + layer.height * fy });
        let fill: { background: string; alpha: number } | null = null;
        await dragPath([at(0.04, 0.96), at(0.3, 0.7), at(0.6, 0.4), at(0.9, 0.1)], async () => {
          fill ??= await session.cdp.evaluate<{ background: string; alpha: number } | null>(`(() => {
            const marquee = document.querySelector('.marquee');
            if (!marquee || marquee.getBoundingClientRect().width < 4) return null;
            const background = getComputedStyle(marquee).backgroundColor;
            return { background, alpha: ${ALPHA_OF}(background) };
          })()`);
        });
        expect(fill, 'dragging from empty canvas draws a marquee').not.toBeNull();
        expect(
          fill!.alpha,
          `the marquee lets the objects it sweeps show through (background ${fill!.background})`,
        ).toBeLessThanOrEqual(0.25);
      });
    });
  }
});

describe.skipIf(!electronBinary)('the slide rail while typing', () => {
  // Every live sync of a box being typed into redraws the box in its slide's
  // rail miniature. Unless that miniature is a layer of its own, Safari
  // repaints every picture on the slide to do it, scaling each full-size
  // bitmap down on the main thread: on a slide of 29 photos each keystroke
  // waited 150-300 ms for a frame (measured over safaridriver; Chromium
  // rasterises off the main thread and never showed it). Only the active
  // slide's miniature may be layered: WebKit backs such a layer at the full
  // slide size, and layering every thumbnail tripled the page's memory.
  it('gives the active slide\'s miniature, and only it, a layer of its own', {
    timeout: 30_000,
  }, async () => {
    await session.reset();
    const layered = () => session.cdp.evaluate<Array<{ index: string; active: boolean; willChange: string }>>(`
      [...document.querySelectorAll('.rail-item')].map((row) => ({
        index: row.dataset.index,
        active: row.classList.contains('active'),
        willChange: getComputedStyle(row.querySelector('.rail-thumb-inner') ?? row).willChange,
      }))`);

    await session.doubleClick(TEXT_A);
    await session.type('xy');
    await wait(400);
    const whileTyping = await layered();
    await session.key('Escape', 27);
    expect(whileTyping.find((row) => row.active)?.willChange, 'the slide being typed into').toBe('transform');
    expect(
      whileTyping.filter((row) => !row.active).map((row) => row.willChange),
      'every other miniature',
    ).toEqual(whileTyping.filter((row) => !row.active).map(() => 'auto'));

    await session.clickRail(1);
    const after = await layered();
    expect(after.find((row) => row.index === '1')?.willChange, 'the layer moves with the active slide').toBe('transform');
    expect(after.find((row) => row.index === '0')?.willChange, 'and leaves the slide it was on').toBe('auto');
  });
});
