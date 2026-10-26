/**
 * Who is on the other end of a tailnet connection, asked of the local
 * Tailscale daemon.
 *
 * `tailscale serve` used to answer that by stamping `Tailscale-User-Login`
 * headers on the requests it proxied to loopback. It also accepts those
 * connections in tailscaled's own userspace TCP stack, which over a real
 * round trip moves a tenth of what the tunnel carries (0.5–2 MB/s against
 * 14–28 MB/s to the same laptop), so a hosted deck's images and clips took
 * seconds each. The server now terminates TLS itself on the tailnet address,
 * over the kernel's TCP, and asks tailscaled the same question serve did:
 * `whois` for the connection's peer address. That answer comes from the
 * WireGuard key the packet arrived under, so unlike a header it cannot be
 * forged by the peer.
 */

import { request } from 'node:http';
import type { Identity } from './accessControl.js';
import { normalizeLogin } from './accessControl.js';

export const DEFAULT_TAILSCALED_SOCKET = '/run/tailscale/tailscaled.sock';

interface WhoIsResponse {
  Node?: { Tags?: string[] | null };
  UserProfile?: { LoginName?: string; DisplayName?: string };
}

/**
 * The tailnet user behind `address:port`, or null when tailscaled does not
 * know the peer, cannot be reached, or the peer is a tagged device (which
 * has no user: tailscaled reports it as `tagged-devices`). Null means
 * "refuse", exactly as a proxied request without a login did.
 */
export function tailnetWhoIs(
  address: string,
  port: number,
  socketPath = DEFAULT_TAILSCALED_SOCKET,
  timeoutMs = 3000,
): Promise<Identity | null> {
  // An IPv4 peer on a dual-stack socket reads as ::ffff:100.x.y.z.
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address;
  const addr = ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
  return new Promise((resolve) => {
    const req = request({
      socketPath,
      path: `/localapi/v0/whois?addr=${encodeURIComponent(addr)}`,
      // tailscaled's LocalAPI only answers this Host (it refuses requests
      // that look like they came from a browser).
      headers: { host: 'local-tailscaled.sock' },
      timeout: timeoutMs,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return resolve(null);
        try {
          resolve(identityFromWhoIs(JSON.parse(body) as WhoIsResponse));
        } catch {
          resolve(null);
        }
      });
      response.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

export function identityFromWhoIs(whois: WhoIsResponse): Identity | null {
  if (whois.Node?.Tags?.length) return null;
  const login = whois.UserProfile?.LoginName?.trim();
  if (!login || login === 'tagged-devices') return null;
  return {
    login: normalizeLogin(login),
    name: whois.UserProfile?.DisplayName?.trim() || login,
  };
}
