import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Cdp, type DevToolsTarget } from '../../test/support/browserSession.js';
import { SERVER_TUTORIAL_DECK_ID } from '../../src/shared/tutorial.js';

export interface ShotServer {
  /** The deck server's port on 127.0.0.1. */
  port: number;
  /** The DevTools port of a hidden browser already showing it. */
  debugPort: number;
}

export interface ShotContext {
  editor: Cdp;
  /** Starts (once) a deck server with a few decks and a browser on it. */
  server: () => Promise<ShotServer>;
  deckDir: string;
  debugPort: number;
  out: string;
  window: { width: number; height: number };
}

export interface Shot {
  name: string;
  run: (context: ShotContext) => Promise<void>;
}

interface Rect { x: number; y: number; width: number; height: number }

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The bounding box of every element matching any of `selectors`, in CSS pixels. */
async function boxOf(editor: Cdp, selectors: string[], pad = 0): Promise<Rect> {
  const box = await editor.evaluate<Rect | null>(`(() => {
    const rects = ${JSON.stringify(selectors)}
      .flatMap((s) => [...document.querySelectorAll(s)])
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => el.getBoundingClientRect());
    if (rects.length === 0) return null;
    const x = Math.min(...rects.map((r) => r.left));
    const y = Math.min(...rects.map((r) => r.top));
    return { x, y, width: Math.max(...rects.map((r) => r.right)) - x, height: Math.max(...rects.map((r) => r.bottom)) - y };
  })()`);
  if (!box) throw new Error(`nothing on screen matches ${selectors.join(', ')}`);
  return { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
}

/** Write part of the window (default: all of it) to `<out>/<name>.webp`, at the 2x the run emulates. */
async function capture(context: ShotContext, name: string, clip?: Rect, page: Cdp = context.editor): Promise<void> {
  const { window } = context;
  const area = clip ?? { x: 0, y: 0, ...window };
  const x = Math.max(0, Math.floor(area.x));
  const y = Math.max(0, Math.floor(area.y));
  const rect = {
    x, y,
    width: Math.min(window.width - x, Math.ceil(area.width)),
    height: Math.min(window.height - y, Math.ceil(area.height)),
  };
  // Let anything just opened finish its transition and paint.
  await wait(400);
  const { data } = await page.call('Page.captureScreenshot', {
    format: 'webp', quality: 92, clip: { ...rect, scale: 1 }, captureBeyondViewport: false,
  }) as { data: string };
  await writeFile(join(context.out, `${name}.webp`), Buffer.from(data, 'base64'));
}

const ESC = 27;

/** Close whatever is open — menus, popovers, dialogs, modes — and select nothing. */
async function settle(editor: Cdp): Promise<void> {
  const state = () => editor.evaluate<{ dialog: boolean; menu: boolean; agent: boolean; panel: string | null }>(`(() => {
    const shows = (pattern) => [...document.querySelectorAll('body *')].some((n) =>
      n.children.length === 0 && pattern.test(n.textContent.trim()) && n.getClientRects().length > 0);
    // Toolbar panels that only their own button closes, by what they show.
    const panels = [
      [/^\\d+ × \\d+ table$/, 'Table'],
      [/^Edit history$/, 'History'],
      [/^Drag a file onto the slide/, 'Media'],
      [/^Front to back\\. Drag to restack\\.$/, 'Objects on this slide'],
    ];
    const open = panels.find(([pattern]) => shows(pattern));
    return {
      dialog: [...document.querySelectorAll('.workflow-overlay')].some((m) => m.getClientRects().length > 0),
      menu: [...document.querySelectorAll('.shape-menu')].some((m) => m.getClientRects().length > 0),
      agent: shows(/^Open your agent here:$/),
      panel: open ? open[1] : null,
    };
  })()`);
  // Cdp.clickByText marks its target with a numbered id that restarts with
  // every connection: clear earlier runs' marks, or a click finds a stale one.
  await editor.evaluate(`document.querySelectorAll('[id^="test-click-target-"]').forEach((n) => n.removeAttribute('id'))`);
  for (let attempt = 0; attempt < 4; attempt++) {
    await editor.evaluate('document.activeElement?.blur?.()');
    for (let i = 0; i < 2; i++) {
      await editor.key('Escape', ESC);
      await wait(80);
    }
    // Context menus close on a click elsewhere, not on Escape: click the bare
    // canvas above the slide, which also selects nothing.
    await editor.clickAt(900, 150);
    await wait(150);
    const now = await state();
    if (process.env.SHOTS_DEBUG) console.log("settle", attempt, JSON.stringify(now));
    // The agent popover stays open until its button is pressed again, and
    // the button saves the deck first, so it closes a moment later.
    if (now.agent) {
      await closeAgentPopover(editor);
      continue;
    }
    if (now.dialog) {
      // A dialog a shot left open: its own Cancel or Close button dismisses it.
      await editor.evaluate(`(() => {
        const overlays = [...document.querySelectorAll('.workflow-overlay')].filter((m) => m.getClientRects().length > 0);
        const top = overlays[overlays.length - 1];
        const button = [...top.querySelectorAll('button')].find((b) => ['Cancel', 'Close'].includes(b.textContent.trim()));
        button?.click();
      })()`);
      await wait(300);
      continue;
    }
    if (now.panel) {
      const toggles: Record<string, string> = {
        Table: '.table-picker-trigger', History: '.bar-history-button', Media: '.bar-icon-button:not(.bar-history-button):not(.pen-tool-button)',
        'Objects on this slide': '.object-list-toggle',
      };
      if (now.panel === 'Media') await editor.clickByText('button', 'Media');
      else await editor.click(toggles[now.panel]!, now.panel);
      await wait(300);
      continue;
    }
    if (!now.menu) break;
  }
  const end = await state();
  if (end.dialog || end.menu || end.agent || end.panel) throw new Error(`could not settle the editor: ${JSON.stringify(end)}`);
  await editor.evaluate(`(() => {
    // Shots of the rail start from its top.
    for (const el of document.querySelectorAll('#rail, #rail *')) if (el.scrollTop > 0) el.scrollTop = 0;
  })()`);
}

async function goTo(editor: Cdp, slideId: string): Promise<void> {
  await settle(editor);
  await editor.click(`#rail .rail-item[data-slide-id="${slideId}"]`, slideId);
  await wait(500);
  await closeAgentPopover(editor);
  // Every shot starts on the Props tab.
  const props = await editor.evaluate<boolean>("(document.querySelector('#inspector')?.getClientRects().length ?? 0) > 0");
  if (!props) {
    await editor.clickByText('button', 'Props');
    await wait(400);
  }
}

async function select(editor: Cdp, elementId: string): Promise<void> {
  await editor.click(`.canvas-host [data-element-id="${elementId}"]`, elementId);
  await wait(250);
}

/** Click the visible control whose label is `text` (buttons, menu items, tabs). */
async function press(editor: Cdp, text: string, selector = 'button, [role="menuitem"], .shape-menu-item'): Promise<void> {
  await editor.clickByText(selector, text);
  await wait(350);
}

/** Show the profile the way a person's machine names it, not the scratch run's temp path. */
async function tidyPaths(context: ShotContext): Promise<void> {
  // The run's deck sits beside its profile; both stand for the person's profile folder.
  const work = context.deckDir.replace(/\/Tutorial$/, '');
  await context.editor.evaluate(`(() => {
    const swaps = [[${JSON.stringify(`${work}/profile`)}, '~/Library/Application Support/DeckWerk'],
      [${JSON.stringify(work)}, '~/Library/Application Support/DeckWerk']];
    const tidy = (text) => swaps.reduce((out, [from, to]) => out.split(from).join(to), text);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) node.nodeValue = tidy(node.nodeValue);
    for (const field of document.querySelectorAll('textarea, input')) field.value = tidy(field.value);
  })()`);
}

/** The box of the innermost floating element (menu, popover) whose text includes `text`. */
async function floatingWith(editor: Cdp, text: string, pad = 0): Promise<Rect> {
  const box = await editor.evaluate<Rect | null>(`(() => {
    const floating = [...document.querySelectorAll('body *')].filter((el) => {
      const style = getComputedStyle(el);
      return (style.position === 'fixed' || style.position === 'absolute')
        && el.getClientRects().length > 0 && el.textContent.includes(${JSON.stringify(text)});
    });
    const innermost = floating.filter((el) => !floating.some((other) => other !== el && el.contains(other)));
    const el = innermost[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  if (!box) throw new Error(`no floating element shows ${JSON.stringify(text)}`);
  return { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
}

function union(...rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x, y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

/** The open toolbar menu with the button that opened it. */
async function menuWithTrigger(editor: Cdp, triggerText: string, pad = 14): Promise<Rect> {
  const menu = await boxOf(editor, ['.shape-menu']);
  const trigger = await editor.evaluate<Rect>(`(() => {
    const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === ${JSON.stringify(triggerText)} && n.getClientRects().length);
    const r = b.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  const box = union(menu, trigger);
  return { x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad };
}

/** A window the app opened besides the editor, once its page has loaded. */
async function otherWindow(context: ShotContext, matches: (target: DevToolsTarget) => boolean): Promise<Cdp> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const targets = await (await fetch(`http://127.0.0.1:${context.debugPort}/json/list`)).json() as DevToolsTarget[];
    const target = targets.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl && matches(candidate));
    if (target) {
      const page = await Cdp.connect(target.webSocketDebuggerUrl!);
      await page.call('Emulation.setDeviceMetricsOverride', { ...context.window, deviceScaleFactor: 2, mobile: false });
      return page;
    }
    await wait(200);
  }
  throw new Error('the window never opened');
}

/**
 * The inspector from the heading `first` down to the end of section `last`
 * (default: just `first`), scrolled so that it shows.
 */
async function inspectorSections(editor: Cdp, first: string, last = first): Promise<Rect> {
  const box = await editor.evaluate<Rect | { error: string }>(`(() => {
    const panel = document.querySelector('.inspector, #inspector');
    const heads = [...panel.querySelectorAll('h4.insp-subtitle')].filter((h) => h.getClientRects().length);
    const from = heads.findIndex((h) => h.textContent.trim() === ${JSON.stringify(first)});
    const to = heads.findIndex((h) => h.textContent.trim() === ${JSON.stringify(last)});
    if (from < 0 || to < 0) return { error: heads.map((h) => h.textContent.trim()).join(', ') };
    heads[from].scrollIntoView({ block: 'start' });
    const p = panel.getBoundingClientRect();
    const top = heads[from].getBoundingClientRect().top - 10;
    const next = heads[to + 1];
    const bottom = next ? next.getBoundingClientRect().top - 6 : Math.min(p.bottom, innerHeight - 24);
    return { x: p.left, y: Math.max(top, p.top), width: p.width, height: Math.min(bottom, p.bottom) - Math.max(top, p.top) };
  })()`);
  if ('error' in box) throw new Error(`inspector sections ${first}…${last} not found among: ${box.error}`);
  return box;
}

/** The tabbed panel on the right, whichever tab shows. */
const SIDE_PANEL: Rect = { x: 1281, y: 44, width: 319, height: 932 };

/**
 * Keep the agent popover out of shots. Its button opens it only after saving
 * the deck, so a click can open it long after the shot that made it; hiding
 * its panel outright is the only reliable way. `showAgentPopover` undoes it.
 */
async function closeAgentPopover(editor: Cdp): Promise<void> {
  await editor.evaluate(`(() => {
    const connect = document.querySelector('.agent-chat-connect');
    let panel = connect;
    while (panel && panel.parentElement && getComputedStyle(panel).position !== 'fixed') panel = panel.parentElement;
    if (panel) panel.style.setProperty('display', 'none', 'important');
  })()`);
}

async function showAgentPopover(editor: Cdp): Promise<void> {
  await editor.evaluate(`(() => {
    const connect = document.querySelector('.agent-chat-connect');
    let panel = connect;
    while (panel && panel.parentElement && getComputedStyle(panel).position !== 'fixed' && panel.style.display !== 'none') panel = panel.parentElement;
    if (panel) panel.style.removeProperty('display');
  })()`);
}

async function openTab(editor: Cdp, tab: 'Props' | 'Design' | 'Build'): Promise<void> {
  await closeAgentPopover(editor);
  const active = () => editor.evaluate<boolean>(`[...document.querySelectorAll('button')]
    .some((b) => b.textContent.trim() === ${JSON.stringify(tab)} && b.classList.contains('active'))`);
  for (let attempt = 0; attempt < 4 && !(await active()); attempt++) {
    await editor.clickByText('button', tab);
    await wait(400);
  }
  if (!(await active())) throw new Error(`the ${tab} tab would not open`);
}

async function dialogBox(editor: Cdp, pad = 24): Promise<Rect> {
  return boxOf(editor, ['.workflow-dialog'], pad);
}

/** The server's browser page, sized like the editor window (or a phone), showing `path`. */
async function browserAt(context: ShotContext, path: string, phone = false): Promise<{ page: Cdp; size: { width: number; height: number } }> {
  const { port, debugPort } = await context.server();
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as DevToolsTarget[];
  const target = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!target) throw new Error('the server browser has no page');
  const page = await Cdp.connect(target.webSocketDebuggerUrl!);
  const size = phone ? { width: 390, height: 844 } : { width: 1280, height: 760 };
  await page.call('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: phone ? 3 : 2, mobile: phone });
  await page.call('Emulation.setTouchEmulationEnabled', { enabled: phone });
  await page.call('Emulation.setUserAgentOverride', {
    userAgent: phone
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  });
  await page.call('Page.enable');
  await page.call('Page.navigate', { url: `http://127.0.0.1:${port}${path}` });
  await wait(3500);
  return { page, size };
}

/** Like `capture`, for a page that is not the editor and may be phone-sized. */
async function captureOther(context: ShotContext, name: string, page: Cdp): Promise<void> {
  await wait(300);
  const { data } = await page.call('Page.captureScreenshot', { format: 'webp', quality: 92 }) as { data: string };
  await writeFile(join(context.out, `${name}.webp`), Buffer.from(data, 'base64'));
}

const NOTES = 'Three shapes, one Morph: press → and each glides to its new place, size, colour and angle. Pause here, then say what changed.';

export const SHOTS: Shot[] = [
  {
    name: 'window',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-264');
      await select(editor, 'slide-264-p-4');
      await capture(context, 'window');
      await settle(editor);
    },
  },
  {
    name: 'file-menu',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await press(editor, 'File', 'button');
      await capture(context, 'file-menu', await menuWithTrigger(editor, 'File'));
      await settle(editor);
    },
  },
  {
    name: 'present-menu',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await editor.click('button[aria-label="Presentation options"], .toolbar-split-menu.primary', 'Presentation options');
      await wait(350);
      const menu = await boxOf(editor, ['.shape-menu']);
      const split = await boxOf(editor, ['.toolbar-split-main.primary', '.toolbar-split-menu.primary']);
      const box = union(menu, split);
      await capture(context, 'present-menu', { x: box.x - 14, y: box.y - 14, width: box.width + 28, height: box.height + 28 });
      await settle(editor);
    },
  },
  {
    name: 'rail-menu',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await editor.rightClick('#rail .rail-item[data-slide-id="slide-62"]', 'rail row');
      await wait(400);
      const menu = await floatingWith(editor, 'Add slide below');
      const row = await boxOf(editor, ['#rail .rail-item[data-slide-id="slide-62"]']);
      const box = union(menu, row);
      await capture(context, 'rail-menu', { x: 0, y: box.y - 16, width: box.x + box.width + 16, height: box.height + 32 });
      await settle(editor);
    },
  },
  {
    name: 'light-table',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await editor.click('.light-table-toggle', 'All slides');
      await wait(900);
      await capture(context, 'light-table');
      await settle(editor);
    },
  },
  {
    name: 'ask-agent',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await editor.click('.brand-button', 'DeckWerk');
      await wait(300);
      await press(editor, 'Question? Ask your agent!');
      await tidyPaths(context);
      await capture(context, 'ask-agent', await boxOf(editor, ['.ask-agent-dialog'], 24));
      await settle(editor);
    },
  },
  {
    name: 'agent-panel',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await showAgentPopover(editor);
      const open = () => editor.evaluate<boolean>(`[...document.querySelectorAll('p')]
        .some((p) => p.textContent === 'Open your agent here:' && p.getClientRects().length > 0)`);
      if (!(await open())) await press(editor, 'Agent…', 'button');
      for (let i = 0; i < 30 && !(await open()); i++) await wait(100);
      await tidyPaths(context);
      const popover = await floatingWith(editor, 'Open your agent here:');
      const button = await boxOf(editor, ['#agent-chat-trigger']).catch(async () => editor.evaluate<Rect>(`(() => {
        const r = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Agent…' && b.getClientRects().length).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`));
      const box = union(popover, button);
      await capture(context, 'agent-panel', { x: box.x - 16, y: box.y - 12, width: box.width + 32, height: box.height + 28 });
      await settle(editor);
    },
  },
  {
    name: 'notes-drawer',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-188');
      const drawerOpen = () => editor.evaluate<boolean>("(document.querySelector('.notes-drawer-text')?.getClientRects().length ?? 0) > 0");
      if (!(await drawerOpen())) await editor.click('.notes-toggle', 'Speaker notes');
      await wait(500);
      await editor.click('.notes-drawer-text', 'notes');
      await editor.evaluate("document.querySelector('.notes-drawer-text').select()");
      await editor.typeKeys(NOTES);
      await wait(400);
      const drawer = await boxOf(editor, ['.notes-drawer', '.notes-drawer-text']);
      await capture(context, 'notes-drawer', { x: 220, y: drawer.y - 230, width: 1061, height: 976 - (drawer.y - 230) });
      await editor.key('Escape', ESC);
      await wait(200);
      if (await drawerOpen()) await editor.click('.notes-toggle', 'Speaker notes');
      await wait(300);
    },
  },
  {
    name: 'speaker-view',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-188');
      await editor.click('.toolbar-split-menu.primary', 'Presentation options');
      await wait(300);
      await press(editor, 'Present in Speaker View');
      const presenter = await otherWindow(context, (target) => /presenter/i.test(target.url));
      try {
        await wait(2500);
        await capture(context, 'speaker-view', undefined, presenter);
        // Escape ends the show and closes this window, taking the connection with it.
        await presenter.key('Escape', ESC).catch(() => undefined);
      } finally {
        presenter.close();
      }
      await wait(1000);
    },
  },
  {
    name: 'pdf-dialog',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await press(editor, 'File', 'button');
      await press(editor, 'Export PDF…');
      await wait(400);
      await capture(context, 'pdf-dialog', await dialogBox(editor));
      await press(editor, 'Cancel', 'button');
    },
  },
  {
    name: 'web-dialog',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await press(editor, 'File', 'button');
      await press(editor, 'Export Web…');
      await wait(400);
      await capture(context, 'web-dialog', await dialogBox(editor));
      await press(editor, 'Cancel', 'button');
    },
  },
  {
    name: 'media-library',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-95');
      await press(editor, 'Media', 'button');
      await wait(700);
      const panel = await floatingWith(editor, 'Drag a file onto the slide');
      const button = await editor.evaluate<Rect>(`(() => {
        const r = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Media' && b.getClientRects().length).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`);
      const box = union(panel, button);
      await capture(context, 'media-library', { x: box.x - 16, y: box.y - 12, width: box.width + 32, height: box.height + 28 });
      await press(editor, 'Media', 'button');
    },
  },
  {
    name: 'video-props',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-95');
      await select(editor, 'slide-95-video-2');
      await capture(context, 'video-props', await inspectorSections(editor, 'Playback', 'Trim'));
    },
  },
  {
    name: 'shape-menu',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await press(editor, 'Shape', 'button');
      await capture(context, 'shape-menu', await menuWithTrigger(editor, 'Shape'));
    },
  },
  {
    name: 'text-menu',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await press(editor, 'Text', 'button');
      await capture(context, 'text-menu', await menuWithTrigger(editor, 'Text'));
    },
  },
  {
    name: 'table-picker',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await press(editor, 'Table', 'button');
      await wait(300);
      const picker = await floatingWith(editor, 'table');
      await capture(context, 'table-picker', { x: picker.x - 16, y: picker.y - 50, width: picker.width + 32, height: picker.height + 66 });
    },
  },
  {
    name: 'align-props',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await select(editor, 'slide-62-div-2');
      await editor.clickModified('.canvas-host [data-element-id="slide-62-div-4"]', 8, 'second shape');
      await wait(400);
      await capture(context, 'align-props', await inspectorSections(editor, 'Align'));
    },
  },
  {
    name: 'history',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await editor.click('.bar-history-button', 'History');
      await wait(600);
      const panel = await floatingWith(editor, 'Edit history');
      await capture(context, 'history', { x: panel.x - 16, y: panel.y - 50, width: panel.width + 32, height: panel.height + 66 });
    },
  },
  {
    name: 'build-tab',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await select(editor, 'slide-62-div-2');
      await openTab(editor, 'Build');
      await capture(context, 'build-tab', { ...SIDE_PANEL, height: 720 });
      await openTab(editor, 'Props');
    },
  },
  {
    name: 'theme-gallery',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await openTab(editor, 'Design');
      await editor.evaluate(`(() => {
        const card = [...document.querySelectorAll('.theme-current-section')].find((n) => n.getClientRects().length > 0);
        card.id = 'shot-current-theme';
      })()`);
      await editor.click('#shot-current-theme .theme-card, #shot-current-theme button, #shot-current-theme', 'Current theme');
      await wait(1200);
      await capture(context, 'theme-gallery');
      await press(editor, 'Close', 'button');
      await openTab(editor, 'Props');
    },
  },
  {
    name: 'layout-props',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await capture(context, 'layout-props', await inspectorSections(editor, 'Layout'));
    },
  },
  {
    name: 'server-decks',
    run: async (context) => {
      const { page } = await browserAt(context, '/?name=Ada');
      try { await captureOther(context, 'server-decks', page); } finally { page.close(); }
    },
  },
  {
    name: 'server-phone',
    run: async (context) => {
      const { page } = await browserAt(context, `/?deck=${encodeURIComponent('Thesis defense')}&slide=slide-332&name=Ada`, true);
      try {
        const asksName = await page.evaluate<boolean>("[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Join' && b.getClientRects().length)");
        if (asksName) {
          await page.typeInto('input', 'Ada');
          await wait(300);
          const still = await page.evaluate<boolean>("[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Join' && b.getClientRects().length)");
          if (still) await page.clickByText('button', 'Join');
          await wait(2500);
        }
        await captureOther(context, 'server-phone', page);
      } finally { page.close(); }
    },
  },
  {
    name: 'open-dialog-server',
    run: async (context) => {
      const { editor } = context;
      const { port } = await context.server();
      await goTo(editor, 'slide-62');
      await press(editor, 'File', 'button');
      await press(editor, 'Connect to Server…');
      await wait(600);
      const hasTab = await editor.evaluate<boolean>(`[...document.querySelectorAll('.workflow-dialog button')].some((b) => b.textContent.trim() === '127.0.0.1:${port}')`);
      if (!hasTab) {
        await editor.evaluate(`[...document.querySelectorAll('.workflow-dialog button')].find((b) => b.textContent.trim() === '+ Server…').click()`);
        await wait(400);
        await editor.evaluate(`(() => {
          const input = document.querySelector('.workflow-dialog input');
          input.focus();
          input.value = '127.0.0.1:${port}';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await editor.evaluate(`[...document.querySelectorAll('.workflow-dialog button')].find((b) => b.textContent.trim() === 'Connect').click()`);
        await wait(2500);
      }
      await editor.evaluate(`[...document.querySelectorAll('.workflow-dialog button')].find((b) => b.textContent.trim() === '127.0.0.1:${port}').click()`);
      await wait(1500);
      // Name the server the way a real one reads, not by this run's loopback port.
      await editor.evaluate(`(() => {
        const walker = document.createTreeWalker(document.querySelector('.workflow-dialog'), NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) n.nodeValue = n.nodeValue.split('127.0.0.1:${port}').join('lab.example.ts.net:9443');
      })()`);
      await capture(context, 'open-dialog-server', await dialogBox(editor));
      await settle(editor);
    },
  },
  {
    name: 'comments',
    run: async (context) => {
      const { editor } = context;
      await goTo(editor, 'slide-62');
      await editor.rightClick('.canvas-host [data-element-id="slide-62-div-2"]', 'orange square');
      await wait(400);
      await press(editor, 'Comment…');
      const box = 'textarea[placeholder="Comment on this object…"]';
      for (let i = 0; i < 30 && !(await editor.evaluate<boolean>(`Boolean(document.querySelector('${box}')?.getClientRects().length)`)); i++) await wait(100);
      await editor.click(box, 'comment box');
      await editor.typeKeys('Could this pop in a little slower?');
      await press(editor, 'Comment', 'button');
      await wait(600);
      await capture(context, 'comments', await floatingWith(editor, 'Resolve', 16));
      await settle(editor);
    },
  },
];

export { boxOf, capture, floatingWith, wait };
