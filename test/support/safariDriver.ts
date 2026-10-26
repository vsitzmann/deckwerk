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
 * The surface is deliberately the one the media budget suite needs and no
 * more: evaluate an expression, navigate, reload.
 */

export interface SafariPage {
  evaluate<T>(expression: string): Promise<T>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
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
    async close(): Promise<void> {
      await call('DELETE', session).catch(() => null);
      driver.kill();
    },
  };
}
