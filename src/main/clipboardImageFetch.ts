/**
 * Fetching the pixels for an image-only clipboard.
 *
 * When another app writes just `<img src="https://…">` and no bitmap — the
 * common case for Slack and most chat and web apps — pasting means going and
 * getting the bytes. Both hosts that own a deck folder do it here: the
 * Electron main process for the desktop app, and the collab server for the
 * Web UI, whose renderer cannot fetch cross-origin itself.
 *
 * The bytes land in a temp file and go through the ordinary `importAsset`
 * path, so a pasted remote image is probed, content-addressed and named
 * exactly like a dropped one.
 */

import { lookup } from 'node:dns/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importAsset } from './deckStore.js';
import {
  clipboardImageSource,
  imageMimeExtension,
  urlLooksLikeImage,
  type ClipboardImageSource,
} from '../shared/clipboardImages.js';
import type { ImportedAsset } from '../shared/ipc.js';

/** A pasted image is a picture, not a payload. Anything larger than this is
 *  not something an author meant to drop onto a slide. */
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
/** A clipboard fetch happens while the author waits, so fail fast. */
const FETCH_TIMEOUT_MS = 15_000;

export interface FetchClipboardImageOptions {
  /**
   * Refuse addresses that are not routable on the public internet.
   *
   * The collab server does this because the request arrives from whichever
   * client is connected, and an unguarded fetcher would happily read the
   * server's own metadata endpoints and intranet. The desktop app does not:
   * the paste is the local user's own action against a URL they could just as
   * easily open in a browser, and blocking private ranges there would break
   * pasting from an intranet wiki.
   */
  blockPrivateAddresses?: boolean;
  fetchImpl?: typeof fetch;
}

/** Hosts that must never be reachable through a client-supplied paste URL. */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    // Unique-local and link-local; also IPv4-mapped, checked as IPv4 below.
    if (/^f[cd]/.test(v6) || v6.startsWith('fe80')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

export async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`Could not resolve ${host}`);
  // Note: this resolves and then fetches by name, so a hostile DNS server
  // could in principle answer differently the second time. Accepted here —
  // the guard's job is to stop a paste from reaching the local network, not
  // to be a hardened SSRF proxy.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`Refusing to fetch a non-public address: ${host} (${address})`);
    }
  }
}

/** Decode `data:image/...;base64,…` without going near the network. */
function decodeDataImage(source: Extract<ClipboardImageSource, { kind: 'data' }>): {
  bytes: Uint8Array;
  ext: string;
} {
  const ext = imageMimeExtension(source.mime);
  if (!ext) throw new Error(`Unsupported inline image type: ${source.mime}`);
  const bytes = Buffer.from(source.base64, 'base64');
  if (bytes.byteLength === 0) throw new Error('Inline clipboard image was empty');
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Inline clipboard image was too large');
  return { bytes, ext };
}

/** Hops a paste URL may bounce through before it is given up on. */
const MAX_REDIRECTS = 5;

/**
 * Served types that say nothing about the bytes. Only for these -- or for no
 * type at all -- may the URL's own extension decide; a server that says
 * `text/html` is describing a page, however the path is spelled.
 */
function isGenericContentType(contentType: string): boolean {
  const type = contentType.trim().toLowerCase().split(';')[0];
  return type === '' || type === 'application/octet-stream' || type === 'binary/octet-stream';
}

async function downloadImage(
  url: string,
  options: FetchClipboardImageOptions,
): Promise<{ bytes: Uint8Array; ext: string }> {
  const doFetch = options.fetchImpl ?? fetch;
  let parsed = new URL(url);
  let response: Response | null = null;
  // Redirects are followed by hand so that every hop, not only the first URL,
  // is held to the same scheme and address rules: an innocuous public URL
  // that bounces to `http://169.254.169.254/` must be refused, not fetched.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Refusing to fetch ${parsed.protocol} on a paste`);
    }
    if (options.blockPrivateAddresses) await assertPublicHost(parsed);

    response = await doFetch(parsed.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Credentials must not ride along on a paste.
      headers: { accept: 'image/*' },
    });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    if (hop === MAX_REDIRECTS) throw new Error('Image URL redirected too many times');
    parsed = new URL(location, parsed);
    response = null;
  }
  if (!response) throw new Error('Image URL redirected too many times');
  if (!response.ok) throw new Error(`Image URL returned ${response.status}`);

  // Trust the served type over the URL's extension: chat CDNs routinely serve
  // a `.png`-looking path as WebP, and the extension decides how we store it.
  // The extension only gets a say when the server declared nothing useful.
  const contentType = response.headers.get('content-type') ?? '';
  const ext = imageMimeExtension(contentType)
    ?? (isGenericContentType(contentType) && urlLooksLikeImage(parsed.href)
      ? extensionFromUrl(parsed)
      : null);
  if (!ext) throw new Error(`Not an importable image: ${contentType || parsed.href}`);

  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error('Image URL was too large to paste');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('Image URL returned no bytes');
  // Re-check after reading: content-length is a hint, not a promise.
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('Image URL was too large to paste');
  return { bytes, ext };
}

function extensionFromUrl(url: URL): string | null {
  const match = /\.[^./]+$/.exec(url.pathname);
  return match ? match[0].toLowerCase() : null;
}

/**
 * Import the image an image-only clipboard points at, or null when this
 * clipboard is not one. Never throws: a paste that cannot reach its bytes
 * should leave the deck alone, not surface a stack trace.
 */
export async function importClipboardImageUrl(
  deckDir: string,
  html: string,
  text: string,
  options: FetchClipboardImageOptions = {},
): Promise<ImportedAsset | null> {
  const source = clipboardImageSource(html, text);
  return source ? await importImageSource(deckDir, source, options) : null;
}

/**
 * Import an image that is only a reference — the shape both an image-only
 * paste and a drag out of a web page arrive in. Never throws, for the same
 * reason: a drop that cannot reach its bytes should leave the deck alone.
 */
export async function importImageSource(
  deckDir: string,
  source: ClipboardImageSource,
  options: FetchClipboardImageOptions = {},
): Promise<ImportedAsset | null> {
  let workDir = '';
  try {
    const { bytes, ext } = source.kind === 'data'
      ? decodeDataImage(source)
      : await downloadImage(source.url, options);
    workDir = await mkdtemp(join(tmpdir(), 'deckwerk-paste-image-'));
    // `importAsset` names the asset from this file, and probes it for the
    // dimensions the new element is sized from.
    const staged = join(workDir, `Pasted image${ext}`);
    await writeFile(staged, bytes);
    return await importAsset(deckDir, staged);
  } catch (err) {
    console.error('Could not fetch the image behind the paste or drop:', err);
    return null;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
