import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

/**
 * Serve an exported web bundle over localhost.
 *
 * This exists so an agent can *show* a deck: `slide-agent preview` exports the
 * deck through the real player and hands back a URL a human can open — the
 * same "look at it in a browser" step the editor gives for free, for the case
 * where no editor is running. It is deliberately a static file server and
 * nothing more.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

export function serveBundle(bundleDir: string, port: number): Promise<{ url: string; close: () => void }> {
  const server = createServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent((request.url ?? '/').split('?')[0].split('#')[0]);
      const relative = normalize(path).replace(/^([/\\]|\.\.)+/, '');
      const file = join(bundleDir, relative === '' || relative === '.' ? 'index.html' : relative);
      try {
        const body = await readFile(file);
        response.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          // The agent republishes into the same bundle as it iterates; a
          // cached slide shown as "the result" cost a debugging session once.
          'cache-control': 'no-store',
        });
        response.end(body);
      } catch {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found');
      }
    })();
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolvePromise({
        url: `http://127.0.0.1:${boundPort}/index.html`,
        close: () => server.close(),
      });
    });
  });
}
