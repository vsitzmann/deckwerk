import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * Shared plumbing for the production-browser tests: launch a hidden Electron
 * window on a real HTTP origin, attach to it over the DevTools protocol, and
 * drive it with genuine input events.
 *
 * `evaluate` is for reading state and for setup the UI has no control for.
 * `click`, `typeInto`, and `choose` go through `Input.dispatch*`, so the browser
 * itself does hit-testing, focus, and event dispatch — a control hidden behind
 * an overlay, sized to nothing, or never wired up cannot pass.
 */

/** The Electron binary, or `''` when the install has no downloaded binary. */
export const electronBinary = (() => {
  try {
    const path = createRequire(import.meta.url)('electron') as unknown;
    return typeof path === 'string' && existsSync(path) ? path : '';
  } catch {
    return '';
  }
})();

export interface DevToolsTarget {
  id?: string;
  /** For an out-of-process frame, the target id of the page that embeds it. */
  parentId?: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** A point in viewport coordinates plus the box it came from. */
interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** See `Cdp.call`. Five minutes: longer than any command, shorter than any test budget it could hide behind. */
const CDP_COMMAND_TIMEOUT_MS = 5 * 60_000;

export class Cdp {
  private nextId = 1;
  private clickTargets = 0;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();

  private constructor(private socket: WebSocket, private commandTimeoutMs: number) {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.on('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('Electron DevTools connection closed'));
      }
      this.pending.clear();
    });
  }

  /**
   * `commandTimeoutMs` lowers the cap of every `call` on this connection, for
   * a test whose own budget is shorter than the default: a command that never
   * answers then fails naming itself rather than as a bare test timeout.
   */
  static async connect(
    webSocketDebuggerUrl: string,
    { commandTimeoutMs = CDP_COMMAND_TIMEOUT_MS }: { commandTimeoutMs?: number } = {},
  ): Promise<Cdp> {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const cdp = new Cdp(socket, commandTimeoutMs);
    await cdp.call('Runtime.enable');
    return cdp;
  }

  /**
   * One DevTools command. A reply that never comes — a renderer that stopped
   * pumping tasks, an `awaitPromise` on a promise nothing will resolve — used
   * to hang the caller until the *test* timeout killed it, which reports
   * nothing but "timed out" for however long that budget was (the nightly
   * exhaustive matrix: 30 minutes of CI). The cap is generous, because no
   * single command legitimately runs anywhere near it, and the error names the
   * command so the log says what the browser never answered.
   */
  call(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.commandTimeoutMs,
  ): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`DevTools command ${method} got no reply in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'renderer evaluation failed';
      throw new Error(detail);
    }
    return result.result?.value as T;
  }

  /**
   * Scroll a selector into view and report the visible box the mouse can hit.
   * A control that is missing, zero-sized, or scrolled outside the viewport is
   * reported as such rather than silently clicked at (0, 0).
   */
  private async boxOf(selector: string, label: string): Promise<ElementBox> {
    const box = await this.evaluate<ElementBox | { error: string }>(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return { error: 'no element matches' };
      // 'nearest' scrolls only what is out of view. 'center' scrolled even a
      // visible control's container to centre it — the canvas host included,
      // shifting the slide for the rest of the test.
      node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return { error: 'element has no size' };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
        return { error: 'element centre is outside the viewport' };
      }
      const hit = document.elementFromPoint(x, y);
      if (hit !== node && !node.contains(hit)) {
        return { error: 'another element covers it: ' + (hit?.className || hit?.tagName) };
      }
      return { x, y, width: rect.width, height: rect.height };
    })()`);
    if ('error' in box) throw new Error(`cannot click ${label}: ${box.error} (${selector})`);
    return box;
  }

  /** A real left click at the centre of the first node matching `selector`. */
  async click(selector: string, label = selector): Promise<void> {
    const box = await this.boxOf(selector, label);
    await this.mouse('mouseMoved', box.x, box.y, 0);
    await this.mouse('mousePressed', box.x, box.y, 1);
    await this.mouse('mouseReleased', box.x, box.y, 1);
  }

  /**
   * Real left click on the first node matching `selector` whose trimmed text
   * is `text`. Controls are usually identified by their label rather than by
   * a selector; this keeps that lookup while still delivering a real click
   * instead of calling `.click()` on the node.
   */
  async clickByText(selector: string, text: string, label = text): Promise<void> {
    const handle = `test-click-target-${this.clickTargets++}`;
    const found = await this.evaluate<boolean>(`(() => {
      // A responsive toolbar keeps a hidden copy of a control in its compact
      // menu; the one a person can see is the one they would click.
      const matches = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)});
      const node = matches.find((candidate) => candidate.getClientRects().length > 0) ?? matches[0];
      if (!node) return false;
      node.id = ${JSON.stringify(handle)};
      return true;
    })()`);
    if (!found) throw new Error(`no ${selector} is labelled ${JSON.stringify(text)} (${label})`);
    await this.click(`#${handle}`, label);
  }

  /** A real right click at the centre of a visible node, opening its menu. */
  async rightClick(selector: string, label = selector): Promise<void> {
    const box = await this.boxOf(selector, label);
    await this.mouse('mouseMoved', box.x, box.y, 0);
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: box.x, y: box.y, button: 'right', buttons: 2, clickCount: 1,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: box.x, y: box.y, button: 'right', buttons: 0, clickCount: 1,
    });
  }

  /** A real right click at an absolute viewport coordinate, opening a menu there. */
  async rightClickAt(x: number, y: number): Promise<void> {
    await this.mouse('mouseMoved', x, y, 0);
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1,
    });
  }

  /** A real left click at an absolute viewport coordinate. */
  async clickAt(x: number, y: number): Promise<void> {
    await this.mouse('mouseMoved', x, y, 0);
    await this.mouse('mousePressed', x, y, 1);
    await this.mouse('mouseReleased', x, y, 1);
  }

  /**
   * A real double-click at a point. The second press carries clickCount 2, the
   * way the OS reports it: two clickCount-1 presses rely on Chromium pairing
   * them by wall-clock interval, which a loaded CI runner routinely exceeds.
   */
  async doubleClickAt(x: number, y: number): Promise<void> {
    await this.mouse('mouseMoved', x, y, 0);
    await this.mouse('mousePressed', x, y, 1);
    await this.mouse('mouseReleased', x, y, 1);
    await wait(35);
    await this.mouse('mousePressed', x, y, 2);
    await this.mouse('mouseReleased', x, y, 2);
  }

  /** A real left click at a point inside the matching node, given as 0..1. */
  async clickWithin(
    selector: string,
    fractionX: number,
    fractionY: number,
    label = selector,
  ): Promise<void> {
    const box = await this.boxOf(selector, label);
    const x = box.x + (fractionX - 0.5) * box.width;
    const y = box.y + (fractionY - 0.5) * box.height;
    await this.mouse('mouseMoved', x, y, 0);
    await this.mouse('mousePressed', x, y, 1);
    await this.mouse('mouseReleased', x, y, 1);
  }

  /** Move the real pointer to a fractional point inside a visible element. */
  async hoverWithin(
    selector: string,
    fractionX: number,
    fractionY: number,
    label = selector,
  ): Promise<void> {
    const box = await this.boxOf(selector, label);
    const x = box.x + (fractionX - 0.5) * box.width;
    const y = box.y + (fractionY - 0.5) * box.height;
    await this.mouse('mouseMoved', x, y, 0);
  }

  /**
   * Move the real pointer through a path expressed in fractional element
   * coordinates. Useful for collaboration tests where one final hover cannot
   * reveal dropped, flickering, or prematurely-cleared cursor frames.
   */
  async hoverPathWithin(
    selector: string,
    points: Array<{ x: number; y: number }>,
    intervalMs = 0,
    label = selector,
  ): Promise<void> {
    const box = await this.boxOf(selector, label);
    for (const point of points) {
      const x = box.x + (point.x - 0.5) * box.width;
      const y = box.y + (point.y - 0.5) * box.height;
      await this.mouse('mouseMoved', x, y, 0);
      if (intervalMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  }

  /** Drag from the centre of one visible element to another with the primary pointer. */
  async dragBetween(startSelector: string, endSelector: string, label = 'drag'): Promise<void> {
    const start = await this.boxOf(startSelector, `${label} start`);
    const end = await this.boxOf(endSelector, `${label} end`);
    await this.mouse('mouseMoved', start.x, start.y, 0);
    await this.mouse('mousePressed', start.x, start.y, 1);
    await this.mouse('mouseMoved', end.x, end.y, 1);
    await this.mouse('mouseReleased', end.x, end.y, 1);
  }

  /**
   * Press the primary button at a viewport point and keep it down, so a test
   * can walk the pointer and inspect what the drag shows *while it is still in
   * progress* — snap guides, drop targets and marquees only exist mid-drag.
   */
  async beginDrag(x: number, y: number): Promise<{
    moveTo: (toX: number, toY: number) => Promise<void>;
    drop: (atX?: number, atY?: number) => Promise<void>;
  }> {
    await this.mouse('mouseMoved', x, y, 0);
    await this.mouse('mousePressed', x, y, 1);
    let at = { x, y };
    return {
      moveTo: async (toX: number, toY: number) => {
        at = { x: toX, y: toY };
        await this.mouse('mouseMoved', toX, toY, 1);
      },
      drop: async (atX = at.x, atY = at.y) => {
        await this.mouse('mouseReleased', atX, atY, 1);
      },
    };
  }

  /** Click near the leading edge of a rendered character at a text offset. */
  async clickTextAtOffset(
    selector: string,
    offset: number,
    label = selector,
  ): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number } | { error: string }>(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'no element matches' };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let remaining = ${JSON.stringify(offset)};
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (remaining >= node.data.length) {
          remaining -= node.data.length;
          continue;
        }
        const range = document.createRange();
        range.setStart(node, remaining);
        range.setEnd(node, Math.min(node.data.length, remaining + 1));
        const rect = range.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return { error: 'character has no rendered box' };
        return { x: rect.left + rect.width * 0.2, y: rect.top + rect.height / 2 };
      }
      return { error: 'offset is outside rendered text' };
    })()`);
    if ('error' in point) throw new Error(`cannot click ${label}: ${point.error}`);
    await this.mouse('mouseMoved', point.x, point.y, 0);
    await this.mouse('mousePressed', point.x, point.y, 1);
    await this.mouse('mouseReleased', point.x, point.y, 1);
  }

  private mouse(
    type: string,
    x: number,
    y: number,
    clickCount: number,
    modifiers = 0,
  ): Promise<void> {
    const pressed = type === 'mousePressed' || (type === 'mouseMoved' && clickCount > 0);
    return this.call('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      clickCount,
      modifiers,
      button: clickCount ? 'left' : 'none',
      buttons: pressed ? 1 : 0,
    });
  }

  /**
   * A real left click with modifier keys held down (the CDP modifier bitmask:
   * 1 Alt, 2 Ctrl, 4 Meta, 8 Shift).
   *
   * Shift-click is how a second object joins a selection, so it has to arrive
   * as a genuinely modified mouse event rather than as a plain click the test
   * merely calls "shift-click".
   */
  async clickModified(selector: string, modifiers: number, label = selector): Promise<void> {
    const box = await this.boxOf(selector, label);
    await this.mouse('mouseMoved', box.x, box.y, 0, modifiers);
    await this.mouse('mousePressed', box.x, box.y, 1, modifiers);
    await this.mouse('mouseReleased', box.x, box.y, 1, modifiers);
  }

  /** A real modified left click at a fractional point inside a visible node. */
  async clickWithinModified(
    selector: string,
    fractionX: number,
    fractionY: number,
    modifiers: number,
    label = selector,
  ): Promise<void> {
    const box = await this.boxOf(selector, label);
    const x = box.x + (fractionX - 0.5) * box.width;
    const y = box.y + (fractionY - 0.5) * box.height;
    await this.mouse('mouseMoved', x, y, 0, modifiers);
    await this.mouse('mousePressed', x, y, 1, modifiers);
    await this.mouse('mouseReleased', x, y, 1, modifiers);
  }

  /**
   * Focus a text field by clicking it, replace what is there, and commit with
   * Enter — the keypress an editor number or hex field waits for.
   *
   * The text itself is typed key by key through `typeKeys`, the same physical
   * keyboard path an author uses. `Input.insertText` would insert the whole
   * string in one event and hide per-keystroke faults.
   */
  async typeInto(selector: string, value: string, label = selector): Promise<void> {
    await this.click(selector, label);
    const focused = await this.evaluate<boolean>(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (document.activeElement !== node) return false;
      node.select?.();
      return true;
    })()`);
    if (!focused) throw new Error(`clicking ${label} did not focus it (${selector})`);
    if (value === '') await this.key('Delete', 46);
    else await this.typeKeys(value);
    const typed = await this.evaluate<string>(
      `document.querySelector(${JSON.stringify(selector)}).value`);
    if (typed !== value) {
      throw new Error(`typing into ${label} left ${JSON.stringify(typed)}, not ${JSON.stringify(value)}`);
    }
    await this.key('Enter', 13);
    // Enter commits some fields; Tab commits the rest by moving focus, which is
    // the other way an author leaves a box. Both are real key events.
    await this.key('Tab', 9);
  }

  async key(key: string, windowsVirtualKeyCode: number): Promise<void> {
    const text = key === 'Enter' ? '\r' : key === 'Tab' ? '\t' : undefined;
    for (const type of ['keyDown', 'keyUp']) {
      await this.call('Input.dispatchKeyEvent', {
        type,
        key,
        code: key,
        text: type === 'keyDown' ? text : undefined,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode: windowsVirtualKeyCode,
      });
    }
  }

  /**
   * Type text the way a person does: the exact event sequence Chromium
   * receives from a physical keyboard — `rawKeyDown`, then the `char` event
   * that carries the character, then `keyUp` — one triple per character.
   *
   * This is deliberately not `Input.insertText`: that is the IME/paste path
   * and inserts a whole string in a single `beforeinput`, so it cannot
   * reproduce a per-keystroke fault such as a character being inserted twice.
   * A synthesised `keyDown` carrying `text` is not the real path either.
   */
  async typeKeys(value: string, delayMs = 0): Promise<void> {
    for (const character of value) {
      if (delayMs > 0) await wait(delayMs);
      const upper = character.toUpperCase();
      const code = character === ' '
        ? 'Space'
        : /[a-z]/i.test(character) ? `Key${upper}`
          : /[0-9]/.test(character) ? `Digit${character}` : '';
      // Punctuation is reached through a modifier on a layout-specific key, so
      // there is no honest virtual key code for it: send the character event
      // that actually carries the text and leave the code out.
      const windowsVirtualKeyCode = character === ' ' ? 32 : code ? upper.charCodeAt(0) : 0;
      const key = { key: character, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode };
      await this.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
      await this.call('Input.dispatchKeyEvent', {
        type: 'char', text: character, unmodifiedText: character, ...key,
      });
      await this.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    }
  }

  /** Dispatch a real modified key chord (Ctrl/Meta/Shift/Alt bitmask from CDP). */
  async chord(
    key: string,
    code: string,
    windowsVirtualKeyCode: number,
    modifiers: number,
    commands?: string[],
  ): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) {
      await this.call('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        modifiers,
        commands: type === 'keyDown' ? commands : undefined,
        windowsVirtualKeyCode,
        nativeVirtualKeyCode: windowsVirtualKeyCode,
      });
    }
  }

  /** A real double-click at the centre of a visible node. */
  async doubleClick(selector: string, label = selector): Promise<void> {
    const box = await this.boxOf(selector, label);
    await this.mouse('mouseMoved', box.x, box.y, 0);
    await this.mouse('mousePressed', box.x, box.y, 1);
    await this.mouse('mouseReleased', box.x, box.y, 1);
    await this.mouse('mousePressed', box.x, box.y, 2);
    await this.mouse('mouseReleased', box.x, box.y, 2);
  }

  /** Double-click the first rendered word in a node, using its glyph box. */
  async doubleClickText(selector: string, label = selector): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number } | { error: string }>(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'no element matches' };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const offset = node.data.search(/\\S/);
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, Math.min(node.data.length, offset + 1));
        const rect = range.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (!root.contains(hit)) {
          return { error: 'its first glyph is covered by ' + (hit?.className || hit?.tagName) };
        }
        return { x, y };
      }
      return { error: 'node has no rendered text' };
    })()`);
    if ('error' in point) throw new Error(`cannot double-click ${label}: ${point.error}`);
    await this.mouse('mouseMoved', point.x, point.y, 0);
    await this.mouse('mousePressed', point.x, point.y, 1);
    await this.mouse('mouseReleased', point.x, point.y, 1);
    // Keep the two clicks inside the native double-click interval without
    // collapsing them into the same event-loop instant. Back-to-back CDP
    // packets can exercise renderer coalescing that no physical mouse can.
    await wait(35);
    await this.mouse('mousePressed', point.x, point.y, 2);
    await this.mouse('mouseReleased', point.x, point.y, 2);
  }

  /** Double-click the rendered word containing a flat text offset. */
  async doubleClickTextAtOffset(
    selector: string,
    offset: number,
    label = selector,
  ): Promise<void> {
    const point = await this.textGlyphPoint(selector, offset, 0.5, label);
    await this.mouse('mouseMoved', point.x, point.y, 0);
    await this.mouse('mousePressed', point.x, point.y, 1);
    await this.mouse('mouseReleased', point.x, point.y, 1);
    await wait(35);
    await this.mouse('mousePressed', point.x, point.y, 2);
    await this.mouse('mouseReleased', point.x, point.y, 2);
  }

  /**
   * Select a flat character range with genuine pointer clicks over glyphs.
   * A leading click establishes the native caret and Shift-click extends it to
   * the trailing glyph. This covers native Selection boundary creation instead
   * of installing a Range through Runtime.evaluate, which can hide hit-testing
   * and focus bugs.
   */
  async selectTextRange(
    selector: string,
    start: number,
    end: number,
    label = selector,
  ): Promise<void> {
    if (end <= start) throw new Error(`cannot select empty range ${start}..${end}`);
    const from = await this.textGlyphPoint(selector, start, 0.15, `${label} start`);
    const to = await this.textGlyphPoint(selector, end - 1, 0.85, `${label} end`);
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: from.x, y: from.y,
      button: 'left', buttons: 1, clickCount: 1,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: from.x, y: from.y,
      button: 'left', buttons: 0, clickCount: 1,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: to.x, y: to.y, button: 'none', buttons: 0,
    });
    await this.call('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8,
      windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: to.x, y: to.y,
      button: 'left', buttons: 1, clickCount: 1, modifiers: 8,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: to.x, y: to.y,
      button: 'left', buttons: 0, clickCount: 1, modifiers: 8,
    });
    await this.call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0,
      windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16,
    });
  }

  /** Viewport point inside one glyph at a flat text offset. */
  private async textGlyphPoint(
    selector: string,
    offset: number,
    fraction: number,
    label: string,
  ): Promise<{ x: number; y: number }> {
    const point = await this.evaluate<{ x: number; y: number } | { error: string }>(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'no element matches' };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const characters = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (let domOffset = 0; domOffset < node.data.length; domOffset += 1) {
          if (node.data[domOffset] !== '\u2060') characters.push({ node, domOffset });
        }
      }
      const requested = ${JSON.stringify(offset)};
      if (requested < 0 || requested >= characters.length) {
        return { error: 'offset is outside rendered text' };
      }
      const rectAt = (index) => {
        const { node, domOffset } = characters[index];
        const range = document.createRange();
        range.setStart(node, domOffset);
        range.setEnd(node, Math.min(node.data.length, domOffset + 1));
        return range.getBoundingClientRect();
      };
      let index = requested;
      let pointFraction = ${JSON.stringify(fraction)};
      let rect = rectAt(index);
      if (rect.width <= 0 || rect.height <= 0) {
        // A TeX delimiter or collapsed formatting boundary can be zero-width.
        // For a range start, the trailing edge of the previous visible glyph
        // is the same caret boundary; for an end, use the leading edge of the
        // following glyph. Selection remains entirely native pointer input.
        const direction = pointFraction >= 0.5 ? 1 : -1;
        for (index += direction; index >= 0 && index < characters.length; index += direction) {
          rect = rectAt(index);
          if (rect.width > 0 && rect.height > 0) {
            pointFraction = direction > 0 ? 0.01 : 0.99;
            break;
          }
        }
        if (rect.width <= 0 || rect.height <= 0) {
          return { error: 'character and adjacent caret boundary have no rendered box' };
        }
      }
      return {
        x: rect.left + rect.width * pointFraction,
        y: rect.top + rect.height / 2,
      };
    })()`);
    if ('error' in point) throw new Error(`cannot locate ${label}: ${point.error}`);
    return point;
  }

  /** Select all rendered text in a node by dragging from its first to last glyph. */
  async dragSelectText(selector: string, label = selector): Promise<void> {
    const points = await this.evaluate<{
      start: { x: number; y: number };
      end: { x: number; y: number };
    } | { error: string }>(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'no element matches' };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const texts = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.data.length) texts.push(node);
      }
      if (!texts.length) return { error: 'node has no text' };
      const first = document.createRange();
      first.setStart(texts[0], 0);
      first.setEnd(texts[0], Math.min(1, texts[0].data.length));
      const lastText = texts[texts.length - 1];
      const last = document.createRange();
      last.setStart(lastText, Math.max(0, lastText.data.length - 1));
      last.setEnd(lastText, lastText.data.length);
      const a = first.getBoundingClientRect();
      const b = last.getBoundingClientRect();
      return {
        start: { x: a.left + 1, y: a.top + a.height / 2 },
        end: { x: b.right - 1, y: b.top + b.height / 2 }
      };
    })()`);
    if ('error' in points) throw new Error(`cannot select ${label}: ${points.error}`);
    await this.sweepSelect(points.start, points.end, label);
  }

  /** Select the first rendered word with a real pointer drag. */
  async dragSelectFirstWord(selector: string, label = selector): Promise<void> {
    const points = await this.evaluate<{
      start: { x: number; y: number };
      end: { x: number; y: number };
    } | { error: string }>(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'no element matches' };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const match = /\\S+/.exec(node.data);
        if (!match) continue;
        const first = document.createRange();
        first.setStart(node, match.index);
        first.setEnd(node, match.index + 1);
        const last = document.createRange();
        last.setStart(node, match.index + match[0].length - 1);
        last.setEnd(node, match.index + match[0].length);
        const a = first.getBoundingClientRect();
        const b = last.getBoundingClientRect();
        return {
          start: { x: a.left + 1, y: a.top + a.height / 2 },
          end: { x: b.right - 1, y: b.top + b.height / 2 }
        };
      }
      return { error: 'node has no rendered word' };
    })()`);
    if ('error' in points) throw new Error(`cannot select ${label}: ${points.error}`);
    await this.sweepSelect(points.start, points.end, label);
  }

  /**
   * Press at `start`, move to `end` and release: the drag that selects text.
   *
   * A press on text that is already selected does not start a new selection:
   * it picks the selected text up for drag-and-drop, under a person's mouse
   * and under CDP alike. That is never what these helpers mean, and under CDP
   * it can be worse than a wrong selection. On Linux the drag becomes a native
   * drag-and-drop session that waits for the pointer's own release; when the
   * synthetic release lost the race to it (a slow CI runner), every later
   * mouse and key event went to the stuck drag instead of the page, and each
   * case after it failed with "the text box did not enter editing" (paste
   * fuzz, nightly 2026-10-06; a select-all or a double-clicked word ahead of
   * the sweep is enough). A person clicks into the selected text first, which
   * clears it, and so does this. If the gesture still starts a drag-and-drop
   * it is reported here, by name, not as whatever fails next.
   */
  private async sweepSelect(
    start: { x: number; y: number },
    end: { x: number; y: number },
    label: string,
  ): Promise<void> {
    const pressOnSelection = `(() => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
      const x = ${JSON.stringify(start.x)};
      const y = ${JSON.stringify(start.y)};
      return [...selection.getRangeAt(0).getClientRects()].some((rect) =>
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    })()`;
    if (await this.evaluate<boolean>(pressOnSelection)) {
      await this.mouse('mouseMoved', start.x, start.y, 0);
      await this.mouse('mousePressed', start.x, start.y, 1);
      await this.mouse('mouseReleased', start.x, start.y, 1);
      if (await this.evaluate<boolean>(pressOnSelection)) {
        throw new Error(`cannot select ${label}: clicking the selected text did not clear the selection`);
      }
    }
    await this.evaluate(`(() => {
      window.__sweepDragStarts = 0;
      window.__sweepCountDragStart ??= () => { window.__sweepDragStarts += 1; };
      window.addEventListener('dragstart', window.__sweepCountDragStart, true);
      return true;
    })()`);
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: start.x, y: start.y, button: 'none', buttons: 0,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: start.x, y: start.y,
      button: 'left', buttons: 1, clickCount: 1,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: end.x, y: end.y,
      button: 'left', buttons: 1,
    });
    await this.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: end.x, y: end.y,
      button: 'left', buttons: 0, clickCount: 1,
    });
    const dragStarts = await this.evaluate<number>(`(() => {
      window.removeEventListener('dragstart', window.__sweepCountDragStart, true);
      return window.__sweepDragStarts;
    })()`);
    if (dragStarts > 0) {
      throw new Error(`selecting ${label} started a drag-and-drop of the selected text instead`);
    }
  }

  /**
   * Choose a `<select>` option. Native dropdowns render outside the page, so
   * the browser's own change event is the closest faithful stand-in for the
   * click; the assertion still proves the listener is wired.
   */
  async choose(selector: string, value: string, label = selector): Promise<void> {
    const ok = await this.evaluate<boolean>(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)});
      if (!select) return false;
      if (![...select.options].some((option) => option.value === ${JSON.stringify(value)})) {
        return false;
      }
      select.focus();
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`cannot choose ${JSON.stringify(value)} in ${label} (${selector})`);
  }

  /**
   * Press one character key at a focused `<select>` and report the value it
   * settles on.
   *
   * This is the one keyboard route a native dropdown really implements:
   * type-ahead, which moves to the next option starting with that letter and
   * fires `change` for it. Arrow keys, Alt-arrow and clicking all open the
   * platform popup, a window outside the page that CDP cannot drive, so they
   * cannot be used to pick an option here. Taking focus is the only
   * programmatic step; the keystroke itself is the physical-keyboard triple.
   *
   * The element is re-resolved on every call, because applying an option
   * usually redraws the panel it lives in.
   */
  async pressOptionKey(selector: string, letter: string, label = selector): Promise<string> {
    const focused = await this.evaluate<string>(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)});
      if (!select) return 'missing';
      if (select.tagName !== 'SELECT') return 'not a select';
      if (select.disabled) return 'disabled';
      select.focus();
      return document.activeElement === select ? 'ok' : 'will not take focus';
    })()`);
    if (focused !== 'ok') throw new Error(`cannot use ${label} (${selector}): ${focused}`);
    const key = {
      key: letter,
      code: `Key${letter.toUpperCase()}`,
      windowsVirtualKeyCode: letter.toUpperCase().charCodeAt(0),
      nativeVirtualKeyCode: letter.toUpperCase().charCodeAt(0),
    };
    await this.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await this.call('Input.dispatchKeyEvent', {
      type: 'char', text: letter, unmodifiedText: letter, ...key,
    });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    await wait(80);
    return this.evaluate<string>(
      `document.querySelector(${JSON.stringify(selector)})?.value ?? 'gone'`);
  }

  /**
   * Choose a `<select>` option with real key presses, and report every option
   * it settled on along the way.
   *
   * Type-ahead walks the options starting with the same letter one press at a
   * time, and each stop is a real `change` the page acts on. That is what a
   * keyboard user gets, so a caller that needs an unambiguous single change
   * should check the returned walk rather than assume one happened.
   */
  async chooseByKeys(selector: string, value: string, label = selector): Promise<string[]> {
    const options = await this.evaluate<string[]>(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)});
      return select ? [...select.options].map((option) => option.value) : [];
    })()`);
    if (!options.includes(value)) {
      throw new Error(`${label} has no option ${JSON.stringify(value)}: ${options.join(', ') || 'none'}`);
    }
    const walk: string[] = [];
    for (let press = 0; press < options.length; press++) {
      walk.push(await this.pressOptionKey(selector, value[0].toLowerCase(), label));
      if (walk[walk.length - 1] === value) return walk;
    }
    throw new Error(`${label} never reached ${JSON.stringify(value)}: walked ${walk.join(' → ')}`);
  }

  close(): void {
    this.socket.close();
  }
}

export interface RunningBrowser {
  process: ChildProcess;
  debugPort: number;
  /** The main process's Node inspector, when it was launched with `--inspect=0`. */
  inspectorPort?: number;
  log: () => string;
}

/** Launch the hidden Electron browser used by the production-browser tests. */
export async function launchBrowser(
  url: string,
  profileDir: string,
  /** Extra Electron switches, e.g. `--inspect=0` for the main process. */
  electronArgs: string[] = [],
): Promise<RunningBrowser> {
  const child = spawn(electronBinary, [
    join(process.cwd(), 'scripts/eval-browser.cjs'),
    url,
    // Chromium picks the port; see `reportedPorts`.
    '0',
    profileDir,
    ...electronArgs,
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });
  const log = collectProcessOutput(child);
  return { process: child, log, ...await reportedPorts(child, electronArgs, log) };
}

const DEVTOOLS_LISTENING = /DevTools listening on ws:\/\/[^\s/]+:(\d+)\//;
const INSPECTOR_LISTENING = /Debugger listening on ws:\/\/[^\s/]+:(\d+)\//;

/**
 * The ports an Electron launched with `--remote-debugging-port=0` (and, when
 * `args` asks for it, `--inspect=0`) actually bound, as it reports them on
 * stderr.
 *
 * Asking the OS for a free port and handing the number to Electron was a race:
 * the probe socket closes before Electron binds, and with a tier's worth of
 * Electrons starting at once another one took the port in between. The loser
 * logged "bind() failed: Address already in use", exposed no DevTools at all,
 * and its suite timed out waiting for a target. Port 0 cannot collide.
 */
export function reportedPorts(
  child: ChildProcess,
  args: string[],
  log: () => string,
  timeoutMs = FIND_TARGET_TIMEOUT_MS,
): Promise<{ debugPort: number; inspectorPort?: number }> {
  const wantsInspector = args.includes('--inspect=0');
  return new Promise((resolve, reject) => {
    let text = '';
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
      if (error) {
        reject(error);
        return;
      }
      const inspector = INSPECTOR_LISTENING.exec(text);
      resolve({
        debugPort: Number(DEVTOOLS_LISTENING.exec(text)![1]),
        ...(inspector ? { inspectorPort: Number(inspector[1]) } : {}),
      });
    };
    const onData = (chunk: unknown) => {
      text += String(chunk);
      if (DEVTOOLS_LISTENING.test(text) && (!wantsInspector || INSPECTOR_LISTENING.test(text))) {
        finish();
      }
    };
    const onExit = () => finish(new Error(`Electron exited before exposing DevTools\n${log()}`));
    const timer = setTimeout(
      () => finish(new Error(`Electron did not report its DevTools port in ${timeoutMs} ms\n${log()}`)),
      timeoutMs,
    );
    child.stderr?.on('data', onData);
    child.once('exit', onExit);
  });
}

/**
 * How long a freshly spawned Electron may take to expose its DevTools target.
 * The first launch in a CI job is a cold one -- font cache, page cache, a
 * two-core runner -- and twice in six nightlies it missed 15 s with nothing in
 * its log; every later launch in the same job was fine. Locally 15 s stays.
 */
const FIND_TARGET_TIMEOUT_MS = process.env.CI ? 60_000 : 30_000;

export async function findTarget(
  port: number,
  predicate: (target: DevToolsTarget) => boolean,
  browserLog: () => string,
  timeoutMs = FIND_TARGET_TIMEOUT_MS,
): Promise<DevToolsTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json() as DevToolsTarget[];
      const target = targets.find((candidate) => candidate.webSocketDebuggerUrl && predicate(candidate));
      if (target) return target;
    } catch {
      // Electron is still starting.
    }
    await wait(100);
  }
  throw new Error(`timed out waiting for Electron target\n${browserLog()}`);
}

/**
 * How long `eventually` waits by default. Everything it waits for — a
 * renderer applying a transaction, a server storing a deck, a page painting —
 * finishes in well under a second on an idle machine; the budget is for the
 * machine that is also running several other Electron suites. A test that
 * knows its wait is long passes its own.
 */
export const EVENTUALLY_TIMEOUT_MS = process.env.CI ? 40_000 : 20_000;

export async function eventually<T>(
  read: () => Promise<T>,
  message: string,
  accept: (value: T) => boolean = Boolean,
  timeoutMs = EVENTUALLY_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  const detail = lastError instanceof Error ? lastError.message : JSON.stringify(last);
  throw new Error(`${message}: ${detail}`);
}

/**
 * What the canvas thought was going on when a text box would not enter
 * editing. "did not enter editing: false" was a nightly's entire report, with
 * nothing to tell a lost click from a box the canvas refused to open.
 */
export async function textEditingState(cdp: Cdp, selector: string): Promise<string> {
  return cdp.evaluate<string>(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const describe = (node) => node
      ? node.tagName.toLowerCase() + (node.id ? '#' + node.id : '')
        + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '')
      : null;
    const rect = nodes[0]?.getBoundingClientRect();
    const hit = rect ? document.elementFromPoint(rect.left + 8, rect.top + rect.height / 2) : null;
    return JSON.stringify({
      matches: nodes.length,
      editable: nodes.map((node) => node.isContentEditable),
      editingId: window.canvas ? window.canvas.editingId : '(no window.canvas)',
      selection: window.store ? [...window.store.get().selection] : '(no window.store)',
      activeElement: describe(document.activeElement),
      hitInsideBox: nodes[0] ? nodes[0].contains(hit) : false,
      hit: describe(hit),
      overlays: [...document.querySelectorAll('#ctx-menu, .color-picker-popover, dialog[open], .modal')]
        .filter((node) => node.getClientRects().length > 0).map(describe),
    }) + (window.__deckwerkTrace
      ? '\\ntrace (ms since install, newest last):\\n  ' + window.__deckwerkTrace.slice(-80).join('\\n  ')
      : '');
  })()`).catch((error) => `(state unreadable: ${error instanceof Error ? error.message : String(error)})`);
}

/**
 * Record, in the page, every pointer and key event the canvas could see and
 * every change to the selection, the document and the edit session, with the
 * call site that made it. `textEditingState` prints the tail. A lost
 * double-click leaves only its end state behind ("selection: []"); this says
 * whether the press arrived, what it hit, and what took the selection away.
 *
 * Needs `window.store` and `window.canvas` (both shells expose them).
 */
export async function installEditingTrace(cdp: Cdp): Promise<void> {
  await cdp.evaluate(`(() => {
    if (window.__deckwerkTrace || !window.store || !window.canvas) return false;
    const log = [];
    window.__deckwerkTrace = log;
    const t0 = performance.now();
    const push = (line) => {
      log.push((performance.now() - t0).toFixed(0).padStart(7) + ' ' + line);
      if (log.length > 400) log.shift();
    };
    const describe = (node) => node instanceof Element
      ? node.tagName.toLowerCase() + (typeof node.className === 'string' && node.className.trim()
        ? '.' + node.className.trim().split(/\\s+/).slice(0, 3).join('.') : '')
      : String(node);
    // The caller of a wrapped method: skip this wrapper's own frame.
    const caller = () => (new Error().stack ?? '').split('\\n').slice(3, 6)
      .map((frame) => frame.trim().replace(/^at /, '').replace(/\\(?https?:\\/\\/[^/]+\\//, '(')).join(' < ');
    // Moves are only interesting while a press is held: that is when the
    // canvas reads one as a drag. Log each, with the buttons it reports.
    let held = 0;
    window.addEventListener('pointerdown', () => { held = 8; }, true);
    window.addEventListener('pointerup', () => { held = 0; }, true);
    window.addEventListener('pointermove', (event) => {
      if (held <= 0) return;
      held -= 1;
      push('pointermove ' + describe(event.target) + ' x=' + Math.round(event.clientX)
        + ' y=' + Math.round(event.clientY) + ' buttons=' + event.buttons
        + ' trusted=' + event.isTrusted + ' t=' + event.timeStamp.toFixed(0));
    }, true);
    // Where the slide view sits: a re-fit under a held pointer remaps it.
    const stage = document.querySelector('#canvas .stage');
    if (stage) {
      new MutationObserver(() => push('stage ' + stage.style.left + ',' + stage.style.top
        + ' ' + stage.style.transform)).observe(stage, { attributes: true, attributeFilter: ['style'] });
    }
    for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'dblclick', 'keydown']) {
      window.addEventListener(type, (event) => push(type + ' ' + describe(event.target)
        + (event.key ? ' key=' + event.key : '')
        + (event.pointerId !== undefined ? ' x=' + Math.round(event.clientX) + ' y=' + Math.round(event.clientY)
          + ' buttons=' + event.buttons : '')
        + (event.detail ? ' detail=' + event.detail : '')
        + ' t=' + event.timeStamp.toFixed(0)), true);
    }
    const store = window.store;
    const canvas = window.canvas;
    const state = () => '[' + [...store.get().selection].join(',') + '] editing=' + canvas.editingId;
    const wrap = (owner, name, label) => {
      const original = owner[name];
      if (typeof original !== 'function') return;
      owner[name] = function (...args) {
        const before = state();
        try {
          return original.apply(this, args);
        } finally {
          push(label + '.' + name + ' ' + before + ' -> ' + state() + ' from ' + caller());
        }
      };
    };
    for (const name of ['select', 'clearSelection', 'load', 'resyncRemote', 'replaceExternal',
      'undo', 'redo', 'restoreHistory', 'deleteSelection', 'selectSlide']) wrap(store, name, 'store');
    for (const name of ['beginTextEdit', 'commitTextEdit', 'endTextEditing']) wrap(canvas, name, 'canvas');
    // Remote and local commits are frequent; log them only by label.
    const applyRemote = store.applyRemote;
    store.applyRemote = function (deck, label, ...rest) {
      push('store.applyRemote ' + JSON.stringify(label));
      return applyRemote.call(this, deck, label, ...rest);
    };
    const commit = store.commit;
    store.commit = function (fn, opts = {}) {
      push('store.commit ' + JSON.stringify(opts.label ?? '') + (opts.transient ? ' transient' : '')
        + (opts.measurement ? ' measurement' : ''));
      return commit.call(this, fn, opts);
    };
    let last = state();
    store.subscribe(() => {
      const now = state();
      if (now !== last) push('state ' + last + ' -> ' + now);
      last = now;
    });
    return true;
  })()`);
}

export function collectProcessOutput(child: ChildProcess): () => string {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
  return () => [stdout, stderr].filter(Boolean).join('\n').trim();
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron browser did not exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Stop a launched browser, escalating to SIGKILL if it ignores SIGTERM. */
export async function stopBrowser(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await waitForProcessExit(child, 5_000).catch(() => child.kill('SIGKILL'));
}
