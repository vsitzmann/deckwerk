import { createServer, connect, type Server, type Socket } from 'node:net';

/**
 * A slow link in front of a local server, and a meter on it.
 *
 * Browser and server on one machine talk over loopback, where nothing is ever
 * slow and the kernel accepts megabytes at once: the server writes a whole
 * clip into a socket buffer whether or not the browser ever reads it, so the
 * server cannot tell a download from an abandoned one. This proxy sits where
 * the tailnet would. It forwards bytes to the browser no faster than the
 * link's rate, holding the rest back at the server (backpressure, as a real
 * congested link would), adds a round trip to every request, and records
 * what each response actually delivered to the browser.
 *
 * It works for any browser, because it is just a TCP endpoint: Chromium
 * driven over CDP and Safari driven over WebDriver both meet the same link.
 *
 * Attribution relies on HTTP/1.1 without pipelining, which is what every
 * browser speaks to a plain-http origin: a connection carries one request at
 * a time, so every byte flowing back between one request and the next
 * belongs to the first.
 */

export interface LinkOptions {
  /** Downstream rate, shared by every connection, in bytes per second. */
  bytesPerSecond: number;
  /** Added before each request reaches the server: one round trip. */
  latencyMs: number;
}

export interface LinkResponse {
  method: string;
  /** Path and query, as the browser asked. */
  url: string;
  range?: string;
  /** The browser revalidated (If-None-Match / If-Modified-Since). */
  conditional: boolean;
  /** 0 until the status line arrived. */
  status: number;
  /** Content-Length the server declared, when it did. */
  declared?: number;
  /** Offset of the first body byte in the file: from Content-Range, else 0. */
  offset: number;
  /** The response's ETag, which names the variant served (a rendition's is salted). */
  etag?: string;
  /** Content-Encoding, when the body is not the file's own bytes. */
  encoding?: string;
  /** Bytes that reached the browser, headers included. */
  delivered: number;
  /** Body bytes that reached the browser. */
  body: number;
  /** When body bytes arrived: cumulative `body` at each moment it grew. */
  marks: Array<{ at: number; body: number }>;
  startedAt: number;
  /** Set once the response is over: the next request began, or the connection closed. */
  endedAt?: number;
  /** The response ended before its declared length arrived. */
  abandoned: boolean;
}

interface Pipe {
  client: Socket;
  upstream: Socket;
  /** Response bytes waiting for link capacity. */
  queue: Buffer[];
  queued: number;
  current: LinkResponse | null;
  /** The response's header bytes until the blank line is seen. */
  head: Buffer | null;
  /** Request bytes not yet parsed into a request. */
  pending: Buffer;
  /** Body bytes of the current request still to skip (an upload). */
  requestBodyLeft: number;
  /** After a 101, the connection is a WebSocket and is no longer parsed. */
  upgraded: boolean;
}

/** Stop reading from the server while this much waits for the link. */
const HIGH_WATER = 64 * 1024;
const TICK_MS = 5;

/**
 * How the link is doing: carrying traffic, refusing every connection (the
 * server process is gone, or an SSH forward was killed), or a black hole
 * that accepts connections and never answers (a tailnet route that dropped:
 * nothing refuses, everything hangs).
 */
export type LinkState = 'up' | 'refused' | 'blackhole';

export class ThrottledLink {
  readonly responses: LinkResponse[] = [];
  /** Requests the browser tried after `cut`, none of which reached the server. */
  readonly attempts: Array<{ at: number; method: string; url: string }> = [];
  private server: Server | null = null;
  private port = 0;
  private host = '127.0.0.1';
  private state: LinkState = 'up';
  private pipes = new Set<Pipe>();
  /** Connections accepted while a black hole (after `cut`), held open and never answered. */
  private dead = new Set<Socket>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tokens = 0;
  private lastTick = Date.now();
  private cursor = 0;

  constructor(private readonly targetPort: number, private readonly options: LinkOptions) {}

  async listen(host = '127.0.0.1', port = 0): Promise<number> {
    this.host = host;
    this.server = createServer((client) => this.accept(client));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, resolve);
    });
    this.timer ??= setInterval(() => this.pump(), TICK_MS);
    this.port = (this.server.address() as { port: number }).port;
    return this.port;
  }

  /**
   * Lose the link, as a tailnet route drops: every open connection goes
   * (the WebSocket with them), and a connection opened afterwards is accepted
   * but never answered and nothing reaches the server, so the browser waits
   * as it would on a dead route. What it tries is recorded in `attempts`.
   */
  cut(): void {
    this.state = 'blackhole';
    for (const pipe of [...this.pipes]) {
      pipe.client.destroy();
      pipe.upstream.destroy();
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.dropAll();
    await this.stopListening();
  }

  /** What the link is doing now. */
  get linkState(): LinkState {
    return this.state;
  }

  /**
   * Take the link down: every connection is cut, and `refused` turns new
   * ones away while `blackhole` accepts them and never answers.
   */
  async down(mode: Exclude<LinkState, 'up'> = 'refused'): Promise<void> {
    this.dropAll();
    if (mode === 'refused') await this.stopListening();
    else if (!this.server) await this.listen(this.host, this.port);
    this.state = mode;
  }

  /** Bring the link back on the same port, so the browser's origin is unchanged. */
  async up(): Promise<void> {
    for (const socket of this.dead) socket.destroy();
    this.dead.clear();
    this.state = 'up';
    if (!this.server) await this.listen(this.host, this.port);
  }

  /** Cut only the WebSockets: the page's session drops, its HTTP requests still go through. */
  dropWebSockets(): number {
    let dropped = 0;
    for (const pipe of [...this.pipes]) {
      if (!pipe.upgraded) continue;
      pipe.client.destroy();
      pipe.upstream.destroy();
      dropped++;
    }
    return dropped;
  }

  private dropAll(): void {
    for (const pipe of this.pipes) {
      pipe.client.destroy();
      pipe.upstream.destroy();
    }
    for (const socket of this.dead) socket.destroy();
    this.dead.clear();
  }

  private async stopListening(): Promise<void> {
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  private accept(client: Socket): void {
    if (this.state === 'blackhole') {
      this.dead.add(client);
      let pending = '';
      client.on('data', (chunk) => {
        pending += chunk.toString('latin1');
        for (let blank = pending.indexOf('\r\n\r\n'); blank >= 0; blank = pending.indexOf('\r\n\r\n')) {
          const [method = '', url = ''] = pending.slice(0, blank).split('\r\n')[0].split(' ');
          this.attempts.push({ at: Date.now(), method, url });
          pending = pending.slice(blank + 4);
        }
      });
      client.on('error', () => this.dead.delete(client));
      client.on('close', () => this.dead.delete(client));
      return;
    }
    const upstream = connect(this.targetPort, '127.0.0.1');
    const pipe: Pipe = {
      client, upstream, queue: [], queued: 0, current: null, head: null,
      pending: Buffer.alloc(0), requestBodyLeft: 0, upgraded: false,
    };
    this.pipes.add(pipe);
    client.setNoDelay(true);
    upstream.setNoDelay(true);

    client.on('data', (chunk) => {
      if (!pipe.upgraded) this.parseRequests(pipe, chunk);
      setTimeout(() => upstream.write(chunk), this.options.latencyMs);
    });
    upstream.on('data', (chunk) => {
      pipe.queue.push(chunk);
      pipe.queued += chunk.length;
      if (pipe.queued > HIGH_WATER) upstream.pause();
    });
    const end = () => {
      if (!this.pipes.has(pipe)) return;
      this.pipes.delete(pipe);
      this.finish(pipe);
      client.destroy();
      upstream.destroy();
    };
    client.on('close', end);
    client.on('error', end);
    upstream.on('error', end);
    // The server finishing its side still leaves queued bytes to deliver.
    upstream.on('end', () => {
      const drain = setInterval(() => {
        if (pipe.queued === 0 || !this.pipes.has(pipe)) {
          clearInterval(drain);
          end();
        }
      }, TICK_MS);
    });
  }

  /** Start a record for each request head the browser sends. */
  private parseRequests(pipe: Pipe, chunk: Buffer): void {
    let data = Buffer.concat([pipe.pending, chunk]);
    for (;;) {
      if (pipe.requestBodyLeft > 0) {
        const skip = Math.min(pipe.requestBodyLeft, data.length);
        pipe.requestBodyLeft -= skip;
        data = data.subarray(skip);
        if (pipe.requestBodyLeft > 0) break;
      }
      const blank = data.indexOf('\r\n\r\n');
      if (blank < 0) break;
      const head = data.subarray(0, blank).toString('latin1');
      data = data.subarray(blank + 4);
      const [requestLine, ...headerLines] = head.split('\r\n');
      const [method = '', url = ''] = requestLine.split(' ');
      const headers = new Map(headerLines.map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const;
      }));
      this.finish(pipe);
      pipe.current = {
        method, url,
        range: headers.get('range'),
        conditional: headers.has('if-none-match') || headers.has('if-modified-since'),
        status: 0, delivered: 0, body: 0, marks: [], offset: 0, startedAt: Date.now(), abandoned: false,
      };
      pipe.head = Buffer.alloc(0);
      this.responses.push(pipe.current);
      pipe.requestBodyLeft = Number(headers.get('content-length') ?? 0) || 0;
    }
    pipe.pending = Buffer.from(data);
  }

  private finish(pipe: Pipe): void {
    const response = pipe.current;
    if (!response || response.endedAt !== undefined) return;
    response.endedAt = Date.now();
    response.abandoned = response.status === 0
      || (response.declared !== undefined && response.body < response.declared);
  }

  /** Hand out link capacity round-robin, so parallel downloads share it as on a real link. */
  private pump(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.tokens + ((now - this.lastTick) / 1000) * this.options.bytesPerSecond,
      this.options.bytesPerSecond * 0.02,
    );
    this.lastTick = now;
    const pipes = [...this.pipes].filter((pipe) => pipe.queued > 0);
    if (pipes.length === 0) return;
    let progress = true;
    while (this.tokens >= 1 && progress) {
      progress = false;
      const share = Math.max(1, Math.floor(this.tokens / pipes.length));
      for (let i = 0; i < pipes.length && this.tokens >= 1; i++) {
        const pipe = pipes[(this.cursor + i) % pipes.length];
        if (pipe.queued === 0) continue;
        const sent = this.deliver(pipe, Math.min(share, Math.floor(this.tokens)));
        this.tokens -= sent;
        if (sent > 0) progress = true;
      }
      this.cursor++;
    }
  }

  private deliver(pipe: Pipe, budget: number): number {
    let sent = 0;
    while (sent < budget && pipe.queue.length > 0) {
      const first = pipe.queue[0];
      const take = Math.min(first.length, budget - sent);
      const piece = first.subarray(0, take);
      if (take === first.length) pipe.queue.shift();
      else pipe.queue[0] = first.subarray(take);
      pipe.queued -= take;
      sent += take;
      this.account(pipe, piece);
      pipe.client.write(piece);
    }
    if (pipe.queued <= HIGH_WATER / 2 && pipe.upstream.isPaused()) pipe.upstream.resume();
    return sent;
  }

  private account(pipe: Pipe, piece: Buffer): void {
    const response = pipe.current;
    if (!response || pipe.upgraded) return;
    response.delivered += piece.length;
    if (pipe.head === null) {
      response.body += piece.length;
      mark(response);
      return;
    }
    pipe.head = Buffer.concat([pipe.head, piece]);
    const blank = pipe.head.indexOf('\r\n\r\n');
    if (blank < 0) return;
    const head = pipe.head.subarray(0, blank).toString('latin1');
    response.body += pipe.head.length - blank - 4;
    mark(response);
    pipe.head = null;
    response.status = Number(head.split(' ')[1]) || 0;
    const header = (name: string) => new RegExp(`\\r\\n${name}:\\s*([^\\r]*)`, 'i').exec(head)?.[1];
    const length = header('content-length');
    if (length) response.declared = Number(length);
    response.offset = Number(/^bytes (\d+)-/.exec(header('content-range') ?? '')?.[1] ?? 0);
    response.etag = header('etag');
    response.encoding = header('content-encoding');
    if (response.status === 304 || response.status === 204 || response.method === 'HEAD') response.declared = 0;
    if (response.status === 101) pipe.upgraded = true;
  }
}

function mark(response: LinkResponse): void {
  const now = Date.now();
  const last = response.marks[response.marks.length - 1];
  if (last && last.at === now) last.body = response.body;
  else response.marks.push({ at: now, body: response.body });
}

/** Body bytes of `response` that arrived after `time`. */
export function bodyAfter(response: LinkResponse, time: number): number {
  let before = 0;
  for (const { at, body } of response.marks) {
    if (at > time) break;
    before = body;
  }
  return response.body - before;
}
