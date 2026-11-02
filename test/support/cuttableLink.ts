import { createServer, connect, type Server, type Socket } from 'node:net';

/**
 * A TCP hop between a client and a server that a test can cut and restore,
 * standing in for a network that goes away (a laptop leaving the tailnet).
 *
 * `cut()` destroys every connection through it and refuses new ones without
 * stopping the server behind it, so the server keeps running — and keeps
 * accepting other people's edits — while this client is offline.
 */
export interface CuttableLink {
  port: number;
  cut(): void;
  /**
   * Keep every connection open but carry no bytes either way: a route that
   * died without a reset, which only a heartbeat can notice.
   */
  freeze(): void;
  restore(): void;
  readonly isCut: boolean;
  close(): Promise<void>;
}

export async function startCuttableLink(targetPort: number, targetHost = '127.0.0.1'): Promise<CuttableLink> {
  const sockets = new Set<Socket>();
  let down = false;
  let frozen = false;
  const server: Server = createServer((client) => {
    if (down) {
      client.destroy();
      return;
    }
    const upstream = connect(targetPort, targetHost);
    sockets.add(client);
    sockets.add(upstream);
    const drop = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop).on('close', drop);
    upstream.on('error', drop).on('close', drop);
    client.on('data', (chunk) => { if (!frozen) upstream.write(chunk); });
    upstream.on('data', (chunk) => { if (!frozen) client.write(chunk); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('link did not bind');
  return {
    port: address.port,
    get isCut() {
      return down;
    },
    cut() {
      down = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    freeze() {
      frozen = true;
    },
    restore() {
      down = false;
      frozen = false;
    },
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
