import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * One journal line per deck-asset response, and a periodic census of the
 * responses still in flight per person.
 *
 * Written for a live incident: with a dozen people in one video-heavy deck,
 * the server held ~800 unfinished media responses and one collaborator pulled
 * ~15 MB/s for an hour, re-fetching the same clips, while a slide's videos
 * took minutes to start for them. Nothing on the server said who asked for
 * what. These lines do: who, which file, which range, how many bytes it
 * handed over, how long the response stayed open, and whether the browser
 * abandoned it.
 *
 * The cost is one short write to stdout (journald) per asset response, at
 * close — nothing on the streaming path.
 */

interface InFlight {
  login: string;
  startedAt: number;
}

const inFlight = new Set<InFlight>();
const CENSUS_MS = 60_000;
let census: ReturnType<typeof setInterval> | null = null;

/** Log this asset response once it ends, and count it while it is open. */
export function trackAssetResponse(
  request: IncomingMessage,
  response: ServerResponse,
  login: string | null,
  file: string,
): void {
  const entry: InFlight = { login: login ?? 'local', startedAt: Date.now() };
  inFlight.add(entry);
  ensureCensus();
  // A keep-alive socket serves one response at a time, so the difference in
  // bytes written over this response's lifetime is what this response handed
  // to the connection (headers included), even when the browser walked away
  // mid-body. It counts what the kernel accepted, not what arrived: a few MB
  // fit in socket buffers, so only a larger file shows a stall as done: 0.
  const socket = request.socket;
  const writtenBefore = socket.bytesWritten;
  response.once('close', () => {
    inFlight.delete(entry);
    const ua = String(request.headers['user-agent'] ?? '');
    const target = request.url ?? '';
    console.log(`asset ${JSON.stringify({
      user: entry.login,
      file,
      q: target.includes('?') ? target.slice(target.indexOf('?')) : undefined,
      range: request.headers.range,
      inm: request.headers['if-none-match'] ? 1 : undefined,
      status: response.statusCode,
      sent: socket.bytesWritten - writtenBefore,
      ms: Date.now() - entry.startedAt,
      done: response.writableFinished ? 1 : 0,
      ua: browserOf(ua),
    })}`);
  });
}

function ensureCensus(): void {
  if (census !== null) return;
  census = setInterval(() => {
    if (inFlight.size === 0) return;
    const now = Date.now();
    const byUser = new Map<string, { open: number; olderThan60s: number }>();
    for (const entry of inFlight) {
      const counts = byUser.get(entry.login) ?? { open: 0, olderThan60s: 0 };
      counts.open += 1;
      if (now - entry.startedAt > 60_000) counts.olderThan60s += 1;
      byUser.set(entry.login, counts);
    }
    console.log(`asset-census ${JSON.stringify(Object.fromEntries(byUser))}`);
  }, CENSUS_MS);
  census.unref();
}

/** "Chrome 141", "Safari 18", "Firefox 131" — enough to tell media stacks apart. */
function browserOf(ua: string): string {
  const platform = /Mac OS X/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'win' : /iPhone|iPad/.test(ua) ? 'ios' : /Linux/.test(ua) ? 'linux' : '?';
  const match = /(Edg|Firefox|Chrome)\/(\d+)/.exec(ua);
  if (match) return `${match[1] === 'Edg' ? 'Edge' : match[1]} ${match[2]} ${platform}`;
  const safari = /Version\/(\d+).*Safari/.exec(ua);
  if (safari) return `Safari ${safari[1]} ${platform}`;
  return ua.slice(0, 40);
}
