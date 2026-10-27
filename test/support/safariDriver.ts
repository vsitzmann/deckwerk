import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * Real Safari, driven over WebDriver by Apple's own `safaridriver`.
 *
 * Safari's media stack (AVFoundation) is what makes it re-download clips, and
 * it exists only on macOS: Playwright's WebKit on Linux plays video through
 * GStreamer and proves nothing about it. So the Safari tier needs a Mac, with
 * Develop › Allow Remote Automation on (or `safaridriver --enable` once).
 *
 * The surface is deliberately the one the media budget and editing latency
 * suites need and no more: evaluate an expression, navigate, reload, and
 * real input — WebDriver actions, which Safari delivers as trusted events
 * through its own event pipeline, as a person's clicks and keystrokes are.
 */

/** Keys a test presses by name, as WebDriver spells them. */
const WEBDRIVER_KEYS = {
  ArrowDown: '\uE015',
  ArrowUp: '\uE013',
  End: '\uE010',
  Escape: '\uE00C',
  Enter: '\uE007',
} as const;
export type SafariKey = keyof typeof WEBDRIVER_KEYS;

export interface SafariPage {
  evaluate<T>(expression: string): Promise<T>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  /** Size the window, so layouts (the rail, the canvas) match a laptop's. */
  setWindowSize(width: number, height: number): Promise<void>;
  /** A real click, or two in quick succession, at the centre of the first node matching `selector`. */
  click(selector: string, count?: 1 | 2): Promise<void>;
  /** Real keystrokes, one key down and up per character. */
  type(text: string): Promise<void>;
  /** A real press of a named key. */
  press(key: SafariKey): Promise<void>;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export async function launchSafari(): Promise<SafariPage> {
  const port = await freePort();
  const driver: ChildProcess = spawn('/usr/bin/safaridriver', ['--port', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json() as { value: T & { error?: string; message?: string } };
    if (!response.ok) throw new Error(`safaridriver ${method} ${path}: ${payload.value?.error} ${payload.value?.message ?? ''}`);
    return payload.value;
  };

  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await call<{ ready: boolean }>('GET', '/status')).ready) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      driver.kill();
      throw new Error('safaridriver did not start; run `safaridriver --enable` once and allow remote automation in Safari');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // A cold Safari on a busy machine (a hosted macOS runner) can miss
  // safaridriver's launch timeout: "The session timed out while connecting to
  // a Safari instance". That is a slow start, not a refusal, so it is asked
  // again; anything else (remote automation off) fails at once.
  let sessionId = '';
  for (let attempt = 1; !sessionId; attempt += 1) {
    try {
      ({ sessionId } = await call<{ sessionId: string }>('POST', '/session', {
        capabilities: { alwaysMatch: { browserName: 'safari' } },
      }));
    } catch (error) {
      const message = (error as Error).message;
      if (attempt < 3 && /timed out/i.test(message)) continue;
      driver.kill();
      throw new Error(`Safari refused an automation session (Develop › Allow Remote Automation): ${message}`);
    }
  }
  const session = `/session/${sessionId}`;

  return {
    async evaluate<T>(expression: string): Promise<T> {
      // The expression is evaluated globally, like CDP's Runtime.evaluate, and
      // a promise it returns is awaited.
      const result = await call<{ ok?: T; error?: string }>('POST', `${session}/execute/async`, {
        script: `const done = arguments[arguments.length - 1];
          Promise.resolve().then(() => (0, eval)(arguments[0]))
            .then((ok) => done({ ok }), (error) => done({ error: String(error && error.stack || error) }));`,
        args: [expression],
      });
      if (result.error) throw new Error(result.error);
      return result.ok as T;
    },
    async goto(url: string): Promise<void> {
      await call('POST', `${session}/url`, { url });
    },
    async reload(): Promise<void> {
      await call('POST', `${session}/refresh`, {});
    },
    async setWindowSize(width: number, height: number): Promise<void> {
      await call('POST', `${session}/window/rect`, { width, height });
    },
    async click(selector: string, count: 1 | 2 = 1): Promise<void> {
      const found = await call<Record<string, string>>('POST', `${session}/element`, { using: 'css selector', value: selector });
      const origin = { 'element-6066-11e4-a52e-4f735466cecf': Object.values(found)[0] };
      const press = [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }];
      await call('POST', `${session}/actions`, {
        actions: [{
          type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', origin, x: 0, y: 0 },
            ...press,
            ...(count === 2 ? [{ type: 'pause', duration: 60 }, ...press] : []),
          ],
        }],
      });
    },
    async type(text: string): Promise<void> {
      for (const character of text) {
        await call('POST', `${session}/actions`, {
          actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: character }, { type: 'keyUp', value: character }] }],
        });
      }
    },
    async press(key: SafariKey): Promise<void> {
      const value = WEBDRIVER_KEYS[key];
      await call('POST', `${session}/actions`, {
        actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }],
      });
    },
    async close(): Promise<void> {
      await call('DELETE', session).catch(() => null);
      driver.kill();
    },
  };
}
