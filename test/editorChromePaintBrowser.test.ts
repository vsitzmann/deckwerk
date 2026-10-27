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

describe.skipIf(!electronBinary)('the slide rail\'s miniatures', () => {
  // Unless a miniature is a layer of its own, Safari repaints its pictures,
  // scaling each full-size bitmap down on the main thread, whenever anything
  // in its row changes: each live sync of a box being typed into (a slide of
  // 29 photos made every keystroke wait 150-300 ms) and each step through the
  // deck, when two rows change their highlight (350-820 ms a step). The
  // stroke over a miniature changes with the highlight, so it is a layer too.
  // The layer is the miniature's small frame: layering the slide-sized
  // surface inside it cost WebKit 60 MB a row.
  it('gives every miniature, and the stroke over it, a small layer of its own', {
    timeout: 30_000,
  }, async () => {
    await session.reset();
    const layers = () => session.cdp.evaluate<Array<{ frame: string; stroke: string; surface: string; width: number }>>(`
      [...document.querySelectorAll('.rail-item > .rail-thumb')].map((thumb) => ({
        frame: getComputedStyle(thumb).willChange,
        stroke: getComputedStyle(thumb, '::after').willChange,
        surface: getComputedStyle(thumb.querySelector('.rail-thumb-inner') ?? thumb).willChange,
        width: thumb.getBoundingClientRect().width,
      }))`);

    const expectLayered = (rows: Awaited<ReturnType<typeof layers>>, when: string) => {
      expect(rows.length, when).toBeGreaterThan(1);
      for (const row of rows) {
        expect(row, when).toMatchObject({ frame: 'transform', stroke: 'transform', surface: 'auto' });
        expect(row.width, `${when}: the layer is the small frame`).toBeLessThan(400);
      }
    };
    expectLayered(await layers(), 'at rest');
    await session.doubleClick(TEXT_A);
    await session.type('xy');
    await wait(400);
    expectLayered(await layers(), 'while typing');
    await session.key('Escape', 27);
    await session.clickRail(1);
    expectLayered(await layers(), 'after stepping to another slide');
  });
});
