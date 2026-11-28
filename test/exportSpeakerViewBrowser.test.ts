import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { exportDeck } from '../src/main/exportDeck.js';
import { parseDeck } from '../src/shared/deck.js';
import { Cdp, eventually, findTarget, launchBrowser, stopBrowser } from './support/browserSession.js';

it('keeps offline export windows in sync over builds, slides, blanking and reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'export-speaker-'));
  const deckDir = join(dir, 'deck');
  const plain = join(dir, 'plain');
  const output = join(dir, 'show');
  const url = pathToFileURL(join(output, 'index.html')).href;
  const connections: Cdp[] = [];
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    await mkdir(deckDir);
    const deck = parseDeck({ version: 1, title: 'Offline speaker test', slides: [
      { id: 'first', notes: 'First note', background: { color: '#000' }, elements: [
        { id: 'build', type: 'text', html: 'Appears on click', x: 10, y: 10, w: 500, h: 100 },
      ], timeline: [
        { id: 'show', trigger: { on: 'click' }, action: { type: 'appear', target: 'build' } },
      ] },
      { id: 'hidden', skipped: true, notes: 'Hidden note' },
      { id: 'second', notes: 'Second note' },
    ] });
    await exportDeck(deckDir, deck, plain, undefined, { dropSkipped: true });
    expect(existsSync(join(plain, 'speaker.js'))).toBe(false);
    await exportDeck(deckDir, deck, output, undefined, { dropSkipped: true, speakerView: true });

    browser = await launchBrowser(url, join(dir, 'profile'));
    const { debugPort, log } = browser;
    const connect = async (filter: (targetUrl: string) => boolean): Promise<Cdp> => {
      const target = await findTarget(debugPort, ({ url: targetUrl }) => filter(targetUrl), log);
      const page = await Cdp.connect(target.webSocketDebuggerUrl!);
      connections.push(page);
      return page;
    };
    const audience = await connect((targetUrl) => targetUrl === url);
    const control = (selector: string): string =>
      `document.querySelector('[data-export-controls]')?.shadowRoot?.querySelector(${JSON.stringify(selector)})`;
    for (const [width, height] of [[1200, 420], [420, 800]]) {
      await audience.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await eventually(() => audience.evaluate<boolean>(`(() => {
        const toggle = (${control('.toggle')})?.getBoundingClientRect();
        const slide = document.querySelector('.stage')?.getBoundingClientRect();
        return !document.fullscreenElement && innerWidth === ${width} && innerHeight === ${height}
          && toggle && slide && toggle.left >= slide.left && toggle.right <= slide.right
          && toggle.top >= slide.top && toggle.bottom <= slide.bottom;
      })()`), `menu sits on the slide in a ${width} × ${height} window`);
    }
    const clickControl = async (selector: string): Promise<void> => {
      const point = await eventually(() => audience.evaluate<{ x: number; y: number } | null>(`(() => {
        const box = (${control(selector)})?.getBoundingClientRect();
        return box && box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0
          && box.right <= innerWidth && box.bottom <= innerHeight
          ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
      })()`), `${selector} fits in the small audience window`);
      await audience.clickAt(point!.x, point!.y);
    };
    const connectSpeaker = (): Promise<Cdp> => connect((targetUrl) => targetUrl.startsWith(`${url}#speaker=`));

    const controlsHidden = (): Promise<boolean> => audience.evaluate<boolean>(`(() => {
      const toggle = ${control('.toggle')};
      return toggle && getComputedStyle(toggle).opacity === '0' && (${control('.menu')}).hidden;
    })()`);
    await eventually(controlsHidden, 'presentation controls disappear when idle');
    await audience.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 210, y: 400 });
    expect(await controlsHidden()).toBe(true);
    const near = await audience.evaluate<{ x: number; y: number }>(`(() => {
      const box = (${control('.toggle')}).getBoundingClientRect();
      return { x: box.left - 20, y: box.top - 20 };
    })()`);
    await audience.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...near });
    await eventually(() => audience.evaluate(`getComputedStyle(${control('.toggle')}).opacity === '1'`),
      'hovering near the corner reveals the controls');
    await clickControl('.toggle');
    expect(await audience.evaluate(`(${control('.toggle')}).getAttribute('aria-expanded')`)).toBe('true');
    const chrome = await audience.evaluate<{ palette: string; dots: number; label: number; outline: number }>(`(() => {
      const toggleStyle = getComputedStyle(${control('.toggle')});
      const labelStyle = getComputedStyle(${control('.launch-speaker')});
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      function luminance(color) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = [...ctx.getImageData(0, 0, 1, 1).data].map((channel) => {
          const c = channel / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      }
      function contrast(foreground, background) {
        const a = luminance(foreground) + 0.05;
        const b = luminance(background) + 0.05;
        return Math.max(a, b) / Math.min(a, b);
      }
      return {
        palette: toggleStyle.getPropertyValue('--text').trim(),
        dots: contrast(toggleStyle.color, toggleStyle.backgroundColor),
        label: contrast(labelStyle.color, labelStyle.backgroundColor),
        outline: contrast(toggleStyle.borderTopColor, '#000'),
      };
    })()`);
    expect(chrome.palette, 'shared palette survives the production build inside the shadow root').not.toBe('');
    expect(chrome.dots, 'dots remain distinguishable from the button face').toBeGreaterThanOrEqual(4.5);
    expect(chrome.label, 'menu text remains readable').toBeGreaterThanOrEqual(4.5);
    expect(chrome.outline, 'button outline is distinguishable on the black slide').toBeGreaterThanOrEqual(3);
    await eventually(controlsHidden, 'an open menu also disappears in a window without fullscreen');
    await clickControl('.toggle');
    expect(await audience.evaluate(`(${control('.toggle')}).getAttribute('aria-expanded')`)).toBe('true');
    await audience.key('Escape', 27);
    expect(await audience.evaluate(`(${control('.menu')}).hidden`)).toBe(true);
    await clickControl('.toggle');
    await clickControl('.launch-speaker');
    let speaker = await connectSpeaker();
    expect(await audience.evaluate(`(${control('.menu')}).hidden`)).toBe(true);
    const positions = [
      { slide: 0, step: 0, id: 'first', notes: 'First note', visible: false },
      { slide: 0, step: 1, id: 'first', notes: 'First note', visible: true },
      { slide: 1, step: 0, id: 'second', notes: 'Second note', visible: false },
    ];
    let position = 0;
    let blanked = false;
    const assertState = async (): Promise<void> => {
      const expected = positions[position];
      await eventually(() => audience.evaluate<{ slide: number; step: number; blanked: boolean } | null>(`(() => {
        const player = window.__SLIDE_PLAYER__;
        return player ? { ...player.getCursor(), blanked: player.isBlanked() } : null;
      })()`), `audience follows cursor ${position} and blank=${blanked}`, (actual) => actual?.slide === expected.slide
        && actual.step === expected.step && actual.blanked === blanked);
      await eventually(() => speaker.evaluate<boolean>(`(() => {
        const current = document.querySelector('.speaker-current [data-slide-id]');
        const build = current?.querySelector('[data-element-id="build"]');
        return current?.dataset.slideId === ${JSON.stringify(expected.id)}
          && document.querySelector('.speaker-notes')?.value === ${JSON.stringify(expected.notes)}
          && Boolean(build && getComputedStyle(build).visibility === 'visible') === ${expected.visible};
      })()`), `speaker previews and notes follow cursor ${position}`);
    };

    await assertState();
    expect(await speaker.evaluate(`document.querySelector('.speaker-next [data-slide-id]')?.dataset.slideId`)).toBe('second');
    // A seeded walk exercises interleaved commands from both windows against
    // the same three-state model, including clamped motion at either end.
    const actions = [
      async () => { await speaker.click('.speaker-next-button'); position = Math.min(2, position + 1); },
      async () => { await speaker.click('.speaker-prev'); position = Math.max(0, position - 1); },
      async () => { await audience.key('ArrowRight', 39); position = Math.min(2, position + 1); },
      async () => { await audience.key('ArrowLeft', 37); position = Math.max(0, position - 1); },
      async () => { await speaker.click('.speaker-blank'); blanked = !blanked; },
      async () => { await audience.key('b', 66); blanked = !blanked; },
    ];
    let seed = 37;
    for (let i = 0; i < 14; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      await actions[seed % actions.length]();
      await assertState();
    }

    await speaker.click('.speaker-end');
    await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json() as Array<{ url: string }>;
      return targets.every((target) => !target.url.startsWith(`${url}#speaker=`));
    }, 'closing Speaker View leaves only the audience window');
    await audience.key('s', 83);
    speaker = await connectSpeaker();
    await assertState();
  } finally {
    for (const page of connections) page.close();
    await stopBrowser(browser?.process ?? null);
    await rm(dir, { recursive: true, force: true });
  }
}, 90_000);
