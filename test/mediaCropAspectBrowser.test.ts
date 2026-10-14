import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { getFfmpegPath } from '../src/main/ffmpeg.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * Unticking "Keep aspect ratio" frees the crop window. It did not: Vincent
 * unticked it on a video in 2610_TRI_site_visit and every crop handle still
 * kept the window's proportions, because a media drag ignored the checkbox and
 * only Shift freed it. Real media, the real inspector checkbox and Edit mask
 * button, real pointer input; test/mediaCrop.test.ts walks every option.
 */
const DECK_ID = 'crop-aspect';

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

const media = (id: string, type: 'image' | 'video', x: number, src: string) => ({
  id, type, x, y: 300, w: 480, h: 270, rot: 0, z: 1, opacity: 1, class: [], style: {}, src,
  fit: 'contain', sourceBox: null,
  ...(type === 'video'
    ? { autoplay: false, loop: true, muted: true, controls: false, start: 0, end: null, poster: null }
    : { alt: '' }),
});

type Saved = { x: number; y: number; w: number; h: number; fit: string; sourceBox: { x: number; y: number; w: number; h: number } | null };

describe.skipIf(!electronBinary)('cropping media with "Keep aspect ratio" off', () => {
  it('crops freely once the box is unticked, and in proportion once it is ticked', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'crop-aspect-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(join(deckDir, 'assets'), { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const pattern = ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=1'];
    execFileSync(getFfmpegPath(), [...pattern, '-frames:v', '1', join(deckDir, 'assets', 'pic.png')]);
    execFileSync(getFfmpegPath(), [...pattern, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', join(deckDir, 'assets', 'clip.mp4')]);
    const deck = emptyDeck('Crop aspect');
    deck.slides[0].elements = [
      media('pic', 'image', 120, 'assets/pic.png'),
      media('clip', 'video', 1000, 'assets/clip.mp4'),
    ] as Deck['slides'][number]['elements'];
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Crop`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const cdp = editor;

    const saved = async (id: string, ok: (el: Saved) => boolean, what: string): Promise<Saved> => (await eventually(async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      const el = (await response.json() as Deck).slides[0].elements.find((e) => e.id === id) as unknown as Saved;
      return el && ok(el) ? el : null;
    }, `${id}: ${what}`))!;
    await eventually(async () => cdp.evaluate<boolean>(`(() => {
      const img = document.querySelector('#canvas [data-element-id="pic"] img');
      const video = document.querySelector('#canvas [data-element-id="clip"] video');
      return img?.naturalWidth > 0 && video?.videoWidth > 0;
    })()`), 'the media never loaded');

    const scale = await cdp.evaluate<number>(`document.querySelector('#canvas .slide').getBoundingClientRect().width / 1920`);
    /** Click the middle of an inspector control picked out by `selector` and its text. */
    const clickControl = async (selector: string, text: string) => {
      const at = await eventually(() => cdp.evaluate<{ x: number; y: number } | null>(`(() => {
        const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((n) => n.textContent.trim() === ${JSON.stringify(text)});
        if (!node) return null;
        node.scrollIntoView({ block: 'center' });
        const r = (node.querySelector('input') ?? node).getBoundingClientRect();
        return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      })()`), `no visible "${text}" control`);
      await cdp.clickAt(at!.x, at!.y);
    };
    const mouse = (type: string, x: number, y: number, shift: boolean) => cdp.call('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, modifiers: shift ? 8 : 0,
    });
    /** Drag the south-east handle by (dx, dy) slide pixels. */
    const dragCorner = async (id: string, dx: number, dy: number, shift: boolean) => {
      const handle = await cdp.evaluate<{ x: number; y: number }>(`(() => {
        const r = document.querySelector('.handle-se[data-element-id="${id}"]').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await mouse('mouseMoved', handle.x, handle.y, shift);
      await mouse('mousePressed', handle.x, handle.y, shift);
      await mouse('mouseMoved', handle.x + (dx / 2) * scale, handle.y + (dy / 2) * scale, shift);
      await mouse('mouseMoved', handle.x + dx * scale, handle.y + dy * scale, shift);
      await mouse('mouseReleased', handle.x + dx * scale, handle.y + dy * scale, shift);
    };
    /** Where the whole picture sits on the slide: a crop must leave it alone. */
    const picture = (el: Saved) => {
      const box = el.sourceBox ?? { x: 0, y: 0, w: el.w, h: el.h };
      return { x: el.x + box.x, y: el.y + box.y, w: box.w, h: box.h };
    };

    for (const [id, x] of [['pic', 120], ['clip', 1000]] as const) {
      await cdp.clickAt((x + 240) * scale + await cdp.evaluate<number>(
        `document.querySelector('#canvas .slide').getBoundingClientRect().left`,
      ), 435 * scale + await cdp.evaluate<number>(
        `document.querySelector('#canvas .slide').getBoundingClientRect().top`,
      ));
      // The inspector must be showing this element, still ticked and settled,
      // before the click: on a slow machine it can still be the previous one's.
      await eventually(() => cdp.evaluate<boolean>(`(() => {
        const selection = [...window.store.get().selection];
        const box = [...document.querySelectorAll('label.field-check')]
          .find((n) => n.textContent.trim() === 'Keep aspect ratio')?.querySelector('input');
        // A video's panel renders again once its clip length is probed,
        // shifting everything under a click aimed before that.
        const settled = !document.querySelector('#inspector')?.textContent.includes('Reading clip length');
        return selection.length === 1 && selection[0] === ${JSON.stringify(id)} && box?.checked === true && settled;
      })()`), `${id} never became the inspector's only, ticked selection`);
      await clickControl('label.field-check', 'Keep aspect ratio');
      const original = await saved(id, (el) => el.fit === 'fill', 'unticking "Keep aspect ratio" never saved');

      await clickControl('.mask-action-row .panel-action', 'Edit mask');
      await eventually(() => cdp.evaluate<boolean>(`!!document.querySelector('#canvas .sel-box.masking')`), 'mask mode never began');

      // Unticked: the window follows the pointer, wider than it is tall now.
      await dragCorner(id, -80, -120, false);
      const free = await saved(id, (el) => el.h < 200, 'the free crop never saved');
      expect(free.w, `${id} crop width`).toBeGreaterThan(390);
      expect(free.w / free.h, `${id} crop kept its proportions`).toBeGreaterThan(2.3);
      expect(picture(free), `${id} picture moved or reshaped`).toEqual(picture(original));

      // Ticked again: the next crop keeps the window's new proportions.
      await clickControl('label.field-check', 'Keep aspect ratio');
      await saved(id, (el) => el.fit === 'contain', 'ticking "Keep aspect ratio" never saved');
      await dragCorner(id, -120, -60, false);
      const locked = await saved(id, (el) => el.w < free.w - 60, 'the locked crop never saved');
      expect(locked.w / locked.h, `${id} locked crop`).toBeCloseTo(free.w / free.h, 1);
      expect(picture(locked), `${id} picture moved or reshaped`).toEqual(picture(original));

      await clickControl('.mask-action-row .panel-action', 'Done editing mask');
    }
  });
});
