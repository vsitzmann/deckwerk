import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { emptyDeck, type Deck, type SlideElement } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { extractStillFrame } from '../src/main/ffmpeg.js';
import type { RenditionEvent } from '../src/server/streamingRenditions.js';
import { startCollabServer, type CollabServerOptions, type RunningCollabServer } from '../src/server/collabServer.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import { COLLAB_PROTOCOL_VERSION, type ClientMessage } from '../src/shared/collab.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';
import { bodyAfter, ThrottledLink, type LinkResponse } from './support/throttledLink.js';
import { launchSafari, type SafariPage } from './support/safariDriver.js';

/**
 * No byte of a deck's media crosses the wire twice.
 *
 * Editing a video-heavy deck through the hosted server stayed slow, and the
 * server's asset log said why: in one twelve-minute Safari session (Oct 2026)
 * a 26 MB clip served `immutable` was requested about 25 times, 75 MB in all,
 * and in a day of editing in Chromium one 1.7 MB clip went out in full nine
 * times within a second, then nine times again. The browser cache is the
 * browser's business; what reaches the server is ours to bound.
 *
 * So this suite measures on the wire, where every browser has to come
 * through: a throttled link in front of the server (support/throttledLink.ts)
 * records which bytes of which file each response delivered. It drives the
 * real collab editor over that link through the ways people use it — open,
 * browse, edit, collaborate, present, replace a clip, reload, open a copy of
 * the deck — and holds it to budgets computed from the files, never from what
 * the code happens to do:
 *
 * - no byte of a file arrives twice, reloads and deck copies included (bytes
 *   are identified by content, so a copy of a clip in another deck is the
 *   same bytes), beyond the block a media stack probes when it opens a clip;
 * - browsing again, editing, a collaborator's edit and coming back from
 *   presenting re-download nothing and revalidate nothing (a 304 is a round
 *   trip too). The browser may go on fetching parts of a clip it never had —
 *   Chromium resumes buffering a partly loaded clip when its slide redraws —
 *   since those bytes still cross once;
 * - a file keeps one URL for the whole session, so nothing the browser holds
 *   is orphaned under a URL nobody asks for again;
 * - a deck whose clips were prepared before it was opened is sent only their
 *   streaming versions; a clip still waiting for its streaming version (it
 *   just arrived) fetches only enough of the original to show its frame, and
 *   once the version exists costs at most one streaming version more.
 *
 * Each scenario runs once (`beforeAll`) and each budget is its own test.
 * Budgets marked `pendingIn` (`it.fails` in the browsers it names) describe
 * behaviour not built yet, each under a PENDING note naming the change that
 * makes it pass;
 * when it lands, the test passes, `it.fails` reports it, and the marker comes
 * off. When the server encodes and keeps streaming versions is
 * mediaIngest.test.ts's subject.
 *
 * Chromium runs everywhere. Real Safari runs on a Mac when asked
 * (RUN_SAFARI_MEDIA_BUDGET=1, see support/safariDriver.ts), held to the same
 * budgets. Its media stack keeps no bytes from one <video> to the next, so
 * the editor reads its clips from memory there (videoMemory.ts).
 */

const execFileAsync = promisify(execFile);
const DECK_ID = 'media-budget';

/**
 * Bytes already held that one request may fetch again: the block a media
 * stack reads when a new element opens a clip it has (Chromium probes the
 * start before it finds its cache), never a download. A file's re-reads in
 * all stay within one such block per request it may make.
 */
const PROBE_ALLOWANCE_BYTES = 64 * 1024;
/** Answered requests one file may take over a whole session, reload included. */
const REQUESTS_PER_FILE = 4;
/** A clip waiting for its streaming version may fetch this much of its original, in seconds of playback. */
const PREVIEW_SECONDS = 3;
/** A link like the hosted server's over the tailnet: ~4 MB/s, 30 ms. */
const LINK = { bytesPerSecond: 4_000_000, latencyMs: 30 };
/** How long a phase waits for stragglers before its transfers are counted. */
const QUIET_MS = 2_000;

const ffmpeg = (() => {
  try {
    return createRequire(import.meta.url)('ffmpeg-static') as string;
  } catch {
    return '';
  }
})();

/* Every process the server starts, so encodes can be counted. */
const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[] }>);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((command: string, args?: readonly string[], ...rest: unknown[]) => {
      spawned.push({ command, args: [...(args ?? [])] });
      return (actual.spawn as (...all: unknown[]) => unknown)(command, args, ...rest);
    }) as typeof actual.spawn,
  };
});

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;
let peer: Peer | null = null;
let link: ThrottledLink | null = null;
let safari: SafariPage | null = null;

async function teardown(): Promise<void> {
  peer?.close();
  peer = null;
  await safari?.close();
  safari = null;
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await link?.close();
  link = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
  spawned.length = 0;
}

/* ------------------------------------------------------------------------ */
/* Fixture                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The kinds of file a real deck holds: a content-hashed clip shown through
 * several crops and in-points (a Keynote import), a clip whose name carries
 * no hash, one whose index sits at the end, a hashed photo and an unhashed
 * diagram.
 */
const FILES = {
  alpha: 'assets/alpha.1a2b3c4d.mp4',
  beta: 'assets/beta-1234.mp4',
  gamma: 'assets/gamma.5e6f7a8b.mp4',
  photo: 'assets/photo.0a1b2c3d.jpg',
  diagram: 'assets/diagram-55.png',
} as const;
/** Arrives mid-session: a clip someone replaces another with. */
const LATE_CLIP = 'assets/delta.9f8e7d6c.mp4';
/** A screen recording: over the server's size and bitrate thresholds, unhashed like a Keynote import. */
const BIG_CLIP = 'assets/recording-4242.mp4';
/** Seconds of BIG_CLIP. */
const BIG_CLIP_SECONDS = 20;
/** A clip whose slow encode keeps the queue busy. */
const DECOY_CLIP = 'assets/noise-recording-17.mp4';

async function makeClip(out: string, seconds: number, faststart: boolean, pattern = 'testsrc2'): Promise<void> {
  await execFileAsync(ffmpeg, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `${pattern}=size=640x360:rate=24`,
    // Noise keeps the encoder at its bitrate, so every clip has real size.
    '-vf', 'noise=alls=12:allf=t', '-t', String(seconds), '-an',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-b:v', '1500k', '-maxrate', '1500k', '-bufsize', '3000k',
    ...(faststart ? ['-movflags', '+faststart'] : []),
    out,
  ]);
}

/**
 * A clip like a screen recording: 12 Mbit/s of a picture that compresses
 * well, so the server's streaming encode comes out several times smaller
 * (about 30 MB to 6 MB for 20 s), as real recordings do.
 */
async function makeRecording(out: string, seconds: number): Promise<void> {
  await execFileAsync(ffmpeg, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24', '-t', String(seconds), '-an',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
    // Constant bitrate with filler: the size a recorder writes, not what the picture needs.
    '-b:v', '12M', '-minrate', '12M', '-maxrate', '12M', '-bufsize', '12M',
    '-x264-params', 'nal-hrd=cbr:force-cfr=1', '-movflags', '+faststart',
    out,
  ]);
}

/** Full-HD noise at 20 Mbit/s: seconds of encoding for the server, whose result it then discards. */
async function makeDecoy(out: string, seconds: number): Promise<void> {
  await execFileAsync(ffmpeg, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24',
    '-vf', 'noise=alls=30:allf=t', '-t', String(seconds), '-an',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-b:v', '20M', '-maxrate', '20M', '-bufsize', '40M', '-movflags', '+faststart',
    out,
  ]);
}

async function makeStill(out: string, size: string): Promise<void> {
  await execFileAsync(ffmpeg, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}`, '-frames:v', '1', out,
  ]);
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 16);
}

function text(id: string, html: string): SlideElement {
  return {
    id, type: 'text', x: 160, y: 60, w: 1600, h: 140, rot: 0, z: 1, opacity: 1,
    class: ['role-title'], style: {}, html, align: 'center', valign: 'middle',
  } as SlideElement;
}

function video(id: string, src: string, x: number, extra: Partial<SlideElement> = {}): SlideElement {
  return {
    id, type: 'video', x, y: 300, w: 560, h: 315, rot: 0, z: 2, opacity: 1,
    class: [], style: {}, src, fit: 'contain', start: 0, end: null,
    autoplay: false, loop: true, muted: true, controls: false, poster: null, sourceBox: null,
    ...extra,
  } as SlideElement;
}

function image(id: string, src: string, x: number): SlideElement {
  return {
    id, type: 'image', x, y: 300, w: 560, h: 315, rot: 0, z: 2, opacity: 1,
    class: [], style: {}, src, fit: 'contain', alt: '', sourceBox: null,
  } as SlideElement;
}

function fixtureDeck(): Deck {
  const deck = emptyDeck('Media budget');
  const base = deck.slides[0];
  const slide = (n: number, elements: SlideElement[]) => ({ ...base, id: `s${n}`, elements: [text(`t${n}`, `SLIDE ${n}`), ...elements] });
  deck.slides = [
    slide(1, [video('v1a', FILES.alpha, 100)]),
    slide(2, [video('v2b', FILES.beta, 100), image('i2', FILES.photo, 1000)]),
    slide(3, [
      video('v3a', FILES.alpha, 60, { start: 3 }),
      video('v3a2', FILES.alpha, 680, { sourceBox: { x: 0, y: -120, w: 900, h: 600 } }),
      video('v3c', FILES.gamma, 1300),
    ]),
    slide(4, [image('i4', FILES.diagram, 600)]),
    slide(5, [video('v5a', FILES.alpha, 60), video('v5b', FILES.beta, 680), video('v5c', FILES.gamma, 1300)]),
  ];
  return deck;
}

/** One slide per clip, in the order given; the second showing of a clip starts later in it. */
function clipsDeck(title: string, srcs: string[]): Deck {
  const deck = emptyDeck(title);
  const base = deck.slides[0];
  deck.slides = srcs.map((src, i) => ({
    ...base, id: `s${i + 1}`,
    elements: [text(`t${i + 1}`, `${title} ${i + 1}`), video(`v${i + 1}`, src, 400, srcs.indexOf(src) < i ? { start: 10 } : {})],
  }));
  return deck;
}

/* ------------------------------------------------------------------------ */
/* Measurement                                                               */
/* ------------------------------------------------------------------------ */

interface Recorded extends LinkResponse {
  phase: string;
  deck: string;
  /** Deck-relative: `assets/…`. */
  path: string;
  /** Which bytes: the file's content hash, plus `#rendition` for its streaming version. */
  content: string;
  variant: 'original' | 'rendition';
  /** Body bytes that had already arrived for this content before (see `repeats`). */
  again?: number;
}

/** The link's asset responses, each labelled with the phase that asked for it. */
class TransferLog {
  phase = 'setup';
  private labels: string[] = [];
  /** Content hash of every asset the test put in a deck, by `<deck>/<path>`. */
  private hashes = new Map<string, string>();

  constructor(private readonly link: ThrottledLink, private readonly decksRoot: string) {}

  /** Identify a deck file by its content, so copies in other decks count as the same bytes. */
  async learn(deck: string, path: string): Promise<void> {
    this.hashes.set(`${deck}/${path}`, await hashFile(join(this.decksRoot, deck, path)));
  }

  /** Label everything the link has seen since the last call with the phase that was running. */
  private sync(): void {
    while (this.labels.length < this.link.responses.length) this.labels.push(this.phase);
  }

  start(name: string): void {
    this.sync();
    this.phase = name;
  }

  get count(): number {
    return this.link.responses.length;
  }

  in(phases: string[]): Recorded[] {
    this.sync();
    return this.link.responses.flatMap((response, i) => {
      if (!phases.includes(this.labels[i])) return [];
      const url = decodeURIComponent(response.url.split('?')[0]);
      const asset = /^\/decks\/(.+)\/(assets\/.+)$/.exec(url);
      if (asset) {
        const [, deck, path] = asset;
        // The server salts a rendition's ETag; that is how a response says which variant it carried.
        const variant = response.etag?.startsWith('"rendition') ? 'rendition' as const : 'original' as const;
        const content = `${this.hashes.get(`${deck}/${path}`) ?? `${deck}/${path}`}${variant === 'rendition' ? '#rendition' : ''}`;
        return [{ ...response, phase: this.labels[i], deck, path, content, variant }];
      }
      // Content-addressed: /media/<o|r><key>, the key being the start of the
      // file's SHA-256, as `hashFile` names it.
      const media = /^\/media\/([or])([0-9a-f]{24})/.exec(url);
      if (!media) return [];
      const hash = media[2].slice(0, 16);
      const variant = media[1] === 'r' ? 'rendition' as const : 'original' as const;
      const [deck, path] = this.fileOf(hash) ?? ['media', url];
      return [{ ...response, phase: this.labels[i], deck, path, content: `${hash}${variant === 'rendition' ? '#rendition' : ''}`, variant }];
    });
  }

  /** The first deck file learned with this content hash, for naming /media responses. */
  private fileOf(hash: string): [string, string] | null {
    for (const [file, known] of this.hashes) {
      if (known !== hash) continue;
      const at = file.indexOf('/assets/');
      return [file.slice(0, at), file.slice(at + 1)];
    }
    return null;
  }

  all(): Recorded[] {
    this.sync();
    return this.in([...new Set(this.labels)]);
  }

  static table(records: Recorded[]): string {
    if (records.length === 0) return '  (no requests)';
    const t0 = records[0].startedAt;
    const seconds = (time: number) => ((time - t0) / 1000).toFixed(1);
    return records.map((r) => [
      `  +${seconds(r.startedAt).padStart(5)}s–${r.endedAt ? `${seconds(r.endedAt)}s` : 'open'}`.padEnd(18),
      r.phase.padEnd(14),
      `${r.deck === DECK_ID ? '' : `${r.deck}/`}${r.path}${r.variant === 'rendition' ? ' (rendition)' : ''}`.padEnd(30),
      String(r.status),
      (r.range ?? '-').padEnd(22),
      `${r.body}`.padStart(9), 'B',
      r.again ? `(${r.again} B again)` : '',
      r.abandoned ? `abandoned of ${r.declared ?? '?'}` : '',
      r.conditional ? 'revalidate' : '',
      r.url.includes('?') ? r.url.slice(r.url.indexOf('?')) : '',
    ].join(' ')).join('\n');
  }
}

/** Run `act`, then wait for the link to go quiet, attributing its transfers to `name`. */
async function phase(log: TransferLog, name: string, act: () => Promise<void>): Promise<Recorded[]> {
  log.start(name);
  await act();
  // Quiet: no new request for QUIET_MS.
  let seen = -1;
  while (seen !== log.count) {
    seen = log.count;
    await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  }
  return log.in([name]);
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...groups.get(key(item)) ?? [], item]);
  return groups;
}

const sum = (records: Recorded[], bytes: (r: Recorded) => number = (r) => r.body) =>
  records.reduce((total, r) => total + bytes(r), 0);

const where = (records: Recorded[]) =>
  `${[...new Set(records.map((r) => `${r.deck === DECK_ID ? '' : `${r.deck}/`}${r.path}`))].join(', ')}`
  + `${records[0]?.variant === 'rendition' ? ' (rendition)' : ''}`;

/**
 * Each record with `again`: how many of its body bytes had already arrived
 * for the same content, in the order the browser asked.
 */
function repeats(records: Recorded[]): Recorded[] {
  const held = new Map<string, Array<[number, number]>>();
  return records.map((r) => {
    if (r.body === 0) return { ...r, again: 0 };
    // An encoded body is not the file's own bytes; count it from the start.
    const start = r.encoding ? 0 : r.offset;
    const end = start + r.body;
    const intervals = held.get(r.content) ?? [];
    let again = 0;
    for (const [a, b] of intervals) again += Math.max(0, Math.min(end, b) - Math.max(start, a));
    const merged: Array<[number, number]> = [];
    for (const [a, b] of [...intervals, [start, end] as [number, number]].sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    held.set(r.content, merged);
    return { ...r, again };
  });
}

/* Each budget returns its violations, so a failure lists every one of them. */

/** Any request at all. */
function anyTransfer(records: Recorded[]): string[] {
  return records.length === 0 ? [] : [`${records.length} asset requests (${sum(records)} B)\n${TransferLog.table(records)}`];
}

/**
 * What revisiting may not cost: bytes that already arrived, or a round trip
 * to revalidate them. Judged over the whole session, reported for `phases`.
 */
function revisitCost(records: Recorded[], phases: string[]): string[] {
  const revalidated = records.filter((r) => phases.includes(r.phase) && (r.conditional || r.status === 304));
  return [
    ...bytesTwice(records, phases),
    ...(revalidated.length > 0 ? [`${revalidated.length} revalidations\n${TransferLog.table(revalidated)}`] : []),
  ];
}

/**
 * Bytes that had already arrived, arriving again, in the responses of
 * `phases` (all of them by default). Order is judged over all of `records`.
 */
function bytesTwice(records: Recorded[], phases?: string[]): string[] {
  const annotated = repeats(records).filter((r) => !phases || phases.includes(r.phase));
  const violations: string[] = [];
  for (const [, served] of groupBy(annotated, (r) => r.content)) {
    const again = sum(served, (r) => r.again ?? 0);
    const worst = Math.max(0, ...served.map((r) => r.again ?? 0));
    if (worst > PROBE_ALLOWANCE_BYTES || again > REQUESTS_PER_FILE * PROBE_ALLOWANCE_BYTES) {
      violations.push(`${again} B of ${where(served)} arrived again, ${worst} B in one response `
        + `(allowance ${PROBE_ALLOWANCE_BYTES} B a request)\n${TransferLog.table(served)}`);
    }
  }
  return violations;
}

/** Round trips per file. A request the browser cancelled before any answer cost the link nothing. */
function overRequestBudget(records: Recorded[]): string[] {
  const violations: string[] = [];
  for (const [, served] of groupBy(records, (r) => `${r.deck}/${r.path}`)) {
    const answered = served.filter((r) => r.status > 0).length;
    if (answered > REQUESTS_PER_FILE) {
      violations.push(`${where(served)}: ${answered} answered requests (budget ${REQUESTS_PER_FILE})\n${TransferLog.table(served)}`);
    }
  }
  return violations;
}

/**
 * More than one URL for one file and variant. A second URL for the same bytes
 * orphans whatever the browser cached under the first.
 */
function severalUrls(records: Recorded[]): string[] {
  const violations: string[] = [];
  // A redirect is not where bytes live: judge the URLs that answered with them.
  const answered = records.filter((r) => r.status < 300 || r.status >= 400);
  for (const [, served] of groupBy(answered, (r) => `${r.deck}/${r.path} (${r.variant})`)) {
    const urls = [...new Set(served.map((r) => r.url))];
    if (urls.length > 1) violations.push(`${where(served)} under ${urls.length} URLs:\n${urls.map((url) => `  ${url}`).join('\n')}`);
  }
  return violations;
}

function ffmpegRuns(): Array<{ command: string; args: string[] }> {
  return spawned.filter(({ command }) => /ffmpeg(\.exe)?$/.test(command));
}

type TimedRendition = RenditionEvent & { at: number };

function encodeTimeline(events: TimedRendition[], t0: number): string {
  return events.map((e) => `  +${((e.at - t0) / 1000).toFixed(1)}s ${e.status} ${e.source.split('/decks/')[1] ?? e.source}${e.detail ? ` (${e.detail})` : ''}`).join('\n');
}

/* ------------------------------------------------------------------------ */
/* Driving the editor                                                        */
/* ------------------------------------------------------------------------ */

/** A second participant on a plain socket: a collaborator whose edits arrive. */
class Peer {
  private socket: WebSocket;
  private messages: Array<{ kind: string; txnId?: string }> = [];

  constructor(port: number, deck = DECK_ID) {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws?deck=${encodeURIComponent(deck)}`);
    this.socket.on('message', (raw) => this.messages.push(JSON.parse(String(raw))));
  }

  async hello(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.send({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name: 'Peer' });
    await eventually(async () => this.messages.some((m) => m.kind === 'welcome'), 'peer was never welcomed');
  }

  async txn(label: string, ops: Extract<ClientMessage, { kind: 'txn' }>['ops']): Promise<void> {
    const txnId = `txn-${Math.random().toString(36).slice(2)}`;
    this.send({ kind: 'txn', txnId, baseSeq: 0, label, ops });
    await eventually(async () => this.messages.some((m) => m.kind === 'txn' && m.txnId === txnId), `peer edit "${label}" was not applied`);
  }

  private send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

/** What the suite needs from a browser, whichever drives it. */
interface Page {
  evaluate<T>(expression: string): Promise<T>;
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
}

type BrowserKind = 'Chromium' | 'Safari';

/**
 * Safari runs only where it exists and only when asked, like the OS-input
 * tier: `RUN_SAFARI_MEDIA_BUDGET=1` on a Mac. Once asked, a Safari that will
 * not be automated is a loud failure, never a skip.
 */
const SAFARI = process.platform === 'darwin' && process.env.RUN_SAFARI_MEDIA_BUDGET === '1';
const BROWSERS: BrowserKind[] = [
  ...(electronBinary ? ['Chromium' as const] : []),
  ...(SAFARI ? ['Safari' as const] : []),
];

async function openBrowser(kind: BrowserKind, profileDir: string): Promise<Page> {
  if (kind === 'Safari') {
    safari = await launchSafari();
    return safari;
  }
  browser = await launchBrowser('about:blank', profileDir);
  const target = await findTarget(browser.debugPort, (c) => c.url.startsWith('about:blank'), browser.log);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  editor = cdp;
  return {
    evaluate: (expression) => cdp.evaluate(expression),
    goto: async (url) => { await cdp.evaluate(`(location.href = ${JSON.stringify(url)}, true)`); },
    reload: async () => { await cdp.evaluate('(location.reload(), true)'); },
  };
}

interface CanvasState {
  slide: number;
  videos: number;
  readyVideos: number;
  images: number;
  readyImages: number;
  /** Each video that is not painted yet, for the message when one never is. */
  unpainted: string[];
}

/**
 * A video is painted once it has a decoded frame, or when it shows the
 * server's still of a clip whose streaming version is still being prepared
 * (videoMemory.ts): that is the picture the slide shows until then.
 */
const canvasState = (page: Page) => page.evaluate<CanvasState>(`(() => {
  const videos = [...document.querySelectorAll('#canvas video')];
  const images = [...document.querySelectorAll('#canvas img')];
  const painted = (v) => v.readyState >= 2 || (v.dataset.streamPending === 'true' && Boolean(v.getAttribute('poster')));
  return {
    slide: window.store.get().slideIndex,
    videos: videos.length,
    readyVideos: videos.filter(painted).length,
    images: images.length,
    readyImages: images.filter((i) => i.complete && i.naturalWidth > 0).length,
    unpainted: videos.filter((v) => !painted(v)).map((v) => [
      v.closest('[data-element-id]')?.dataset.elementId, 'readyState', v.readyState, 'networkState', v.networkState,
      'error', v.error?.code ?? '-', 'preload', v.preload, 'src', (v.getAttribute('src') ?? 'none').slice(0, 40),
      'pending', v.dataset.memoryPending ?? '-', v.dataset.streamPending ?? '-',
    ].join(' ')),
  };
})()`);

/** Show slide `index` (0-based) the way a click on its rail thumbnail does, and wait until it has painted. */
async function showSlide(page: Page, index: number): Promise<void> {
  await page.evaluate(`(() => {
    const item = document.querySelectorAll('.rail-item')[${index}];
    item.scrollIntoView({ block: 'nearest' });
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
    return true;
  })()`);
  await eventually(
    () => canvasState(page),
    `slide ${index + 1} never finished painting its media`,
    (state) => state.slide === index && state.readyVideos === state.videos && state.readyImages === state.images,
    60_000,
  );
}

async function browseAll(page: Page, slideCount: number): Promise<void> {
  for (let i = 1; i < slideCount; i++) await showSlide(page, i);
  for (let i = slideCount - 2; i >= 0; i--) await showSlide(page, i);
}

async function waitForEditor(page: Page, slideCount: number): Promise<void> {
  await eventually(
    () => page.evaluate<number>(`document.querySelectorAll('.rail-item').length`),
    'the rail never listed the fixture slides',
    (count) => count === slideCount,
    60_000,
  );
  await eventually(
    () => canvasState(page),
    'the first slide never painted its media',
    (state) => state.readyVideos === state.videos && state.readyImages === state.images,
    60_000,
  );
}

async function startServer(
  decksRoot: string,
  onRendition?: (event: RenditionEvent) => void,
  extra: Partial<CollabServerOptions> = {},
): Promise<RunningCollabServer> {
  server = await startCollabServer({
    rootDir: decksRoot,
    clientDir: await collabClientDir(),
    host: '127.0.0.1',
    port: 0,
    mediaRenditions: { cacheDir: join(workDir, 'renditions'), onProgress: onRendition },
    printStillCacheDir: join(workDir, 'print-stills'),
    ...extra,
  });
  return server;
}

interface Session {
  page: Page;
  log: TransferLog;
  /** The editor's origin, through the throttled link. */
  origin: string;
}

/** The real server and client, a browser behind the link, nothing loaded yet. */
async function startSession(
  kind: BrowserKind,
  decksRoot: string,
  profileDir: string,
  onRendition?: (event: RenditionEvent) => void,
): Promise<Session> {
  const running = await startServer(decksRoot, onRendition);
  link = new ThrottledLink(running.port, LINK);
  const linkPort = await link.listen();
  const page = await openBrowser(kind, profileDir);
  return { page, log: new TransferLog(link, decksRoot), origin: `http://127.0.0.1:${linkPort}` };
}

async function freshWorkDir(name: string): Promise<{ decksRoot: string; profileDir: string }> {
  workDir = await mkdtemp(join(tmpdir(), `media-budget-${name}-`));
  const decksRoot = join(workDir, 'decks');
  const profileDir = join(workDir, 'electron-profile');
  await mkdir(decksRoot, { recursive: true });
  await mkdir(profileDir, { recursive: true });
  return { decksRoot, profileDir };
}

/* ------------------------------------------------------------------------ */
/* Scenarios                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * A whole editing session over the fixture deck: open, browse twice, edit
 * text and clips, a collaborator's edits, present and come back, a
 * collaborator swapping in a clip nobody has, a reload.
 */
async function editingSession(kind: BrowserKind): Promise<{ log: TransferLog; encodes: Array<{ args: string[] }> }> {
  const { decksRoot, profileDir } = await freshWorkDir('session');
  const deckDir = join(decksRoot, DECK_ID);
  await mkdir(join(deckDir, 'assets'), { recursive: true });
  await Promise.all([
    makeClip(join(deckDir, FILES.alpha), 8, true),
    makeClip(join(deckDir, FILES.beta), 6, true, 'mandelbrot'),
    makeClip(join(deckDir, FILES.gamma), 6, false, 'smptehdbars'),
    makeClip(join(workDir, 'delta.mp4'), 5, true, 'rgbtestsrc'),
    makeStill(join(deckDir, FILES.photo), '1920x1080'),
    makeStill(join(deckDir, FILES.diagram), '1200x800'),
  ]);
  const deck = fixtureDeck();
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111; }\n', 'utf8');
  // The encode count is only worth something if the counter sees the
  // server's own ffmpeg calls: prove it on one.
  const probesBefore = ffmpegRuns().length;
  await extractStillFrame(join(deckDir, FILES.alpha), 1, join(workDir, 'probe.jpg'));
  if (ffmpegRuns().length <= probesBefore) throw new Error('the ffmpeg counter missed a server-side ffmpeg call');
  const encodesAtStart = ffmpegRuns().length;

  const { page, log, origin } = await startSession(kind, decksRoot, profileDir);
  for (const file of Object.values(FILES)) await log.learn(DECK_ID, file);
  const slides = deck.slides.length;

  await phase(log, 'open', async () => {
    await page.goto(`${origin}/?deck=${DECK_ID}&name=Budget`);
    await waitForEditor(page, slides);
  });
  await phase(log, 'browse-1', () => browseAll(page, slides));
  await phase(log, 'browse-2', () => browseAll(page, slides));

  await showSlide(page, 4);
  await phase(log, 'text-edit', async () => {
    await page.evaluate(`(() => {
      window.store.select(['t5']);
      window.store.updateSelected((el) => { el.html = 'SLIDE 5, edited'; }, { label: 'Budget: text' });
      window.store.select(['v5b']);
      window.store.updateSelected((el) => { el.x += 40; el.y += 20; }, { label: 'Budget: move clip' });
      return true;
    })()`);
    await showSlide(page, 4);
  });

  await phase(log, 'media-edit', async () => {
    await page.evaluate(`(() => {
      window.store.select(['v5a']);
      window.store.updateSelected((el) => {
        el.sourceBox = { x: 40, y: 0, w: 560, h: 315 };
        el.start = 2;
      }, { label: 'Budget: crop and trim' });
      window.store.select(['v5c']);
      window.store.updateSelected((el) => { el.w = 420; el.h = 236; el.fit = 'cover'; }, { label: 'Budget: resize' });
      return true;
    })()`);
    await showSlide(page, 4);
  });

  peer = new Peer(server!.port);
  await peer.hello();
  await phase(log, 'peer-edit', async () => {
    const live = deck.slides[4].elements;
    await peer!.txn('Peer: retitle', [{
      op: 'replaceElement', slideId: 's5', elementId: 't5',
      element: { ...live[0], html: 'SLIDE 5, from a peer' } as never,
    }]);
    await peer!.txn('Peer: move clip', [{
      op: 'replaceElement', slideId: 's5', elementId: 'v5b',
      element: { ...live[2], x: 700, y: 400 } as never,
    }]);
    await eventually(
      () => page.evaluate<string>(`document.querySelector('#canvas [data-element-id="t5"]')?.textContent ?? ''`),
      'the peer edit never reached the editor',
      (html) => html.includes('from a peer'),
    );
    await showSlide(page, 4);
  });

  await showSlide(page, 0);
  await phase(log, 'present', async () => {
    await page.evaluate(`(() => {
      const present = [...document.querySelectorAll('#toolbar button')]
        .filter((button) => button.textContent?.trim() === 'Present')
        .find((button) => button.getClientRects().length > 0);
      present.click();
      return true;
    })()`);
    await eventually(
      () => page.evaluate<boolean>(`Boolean(document.querySelector('iframe')?.contentDocument?.querySelector('.slide'))`),
      'the presentation stayed blank', Boolean, 60_000,
    );
    for (let i = 1; i < slides; i++) {
      await page.evaluate(`(() => {
        const win = document.querySelector('iframe').contentWindow;
        win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    await page.evaluate(`(window.postMessage({ type: 'present-exit' }, location.origin), true)`);
    await eventually(
      () => page.evaluate<boolean>(`!document.querySelector('iframe')`),
      'the presentation overlay never closed', Boolean, 30_000,
    );
  });
  await phase(log, 'after-present', () => browseAll(page, slides));

  await copyFile(join(workDir, 'delta.mp4'), join(deckDir, LATE_CLIP));
  await log.learn(DECK_ID, LATE_CLIP);
  await showSlide(page, 4);
  await phase(log, 'new-clip', async () => {
    await peer!.txn('Peer: replace clip', [{
      op: 'replaceElement', slideId: 's5', elementId: 'v5c',
      element: { ...deck.slides[4].elements[3], src: LATE_CLIP } as never,
    }]);
    await eventually(
      () => page.evaluate<boolean>(`document.querySelector('#canvas [data-element-id="v5c"] video')?.dataset.assetSrc === ${JSON.stringify(LATE_CLIP)}`),
      'the replaced clip never reached the editor canvas',
    );
    await showSlide(page, 4);
    await browseAll(page, slides);
  });

  await phase(log, 'reload', async () => {
    await page.reload();
    await waitForEditor(page, slides);
    await browseAll(page, slides);
    await browseAll(page, slides);
  });

  console.log(`media transfer budget (${kind}, editing session) — every asset response:\n${TransferLog.table(repeats(log.all()))}`);
  return { log, encodes: ffmpegRuns().slice(encodesAtStart) };
}

/**
 * A screen recording in a deck and in a copy of that deck, on disk when the
 * server starts, opened one after the other and worked on.
 */
async function streamingVersions(kind: BrowserKind): Promise<{ log: TransferLog; renditions: TimedRendition[]; size: number }> {
  const { decksRoot, profileDir } = await freshWorkDir('copies');
  const decks = ['talk-a', 'talk-b'];
  const sources = decks.map((id) => join(decksRoot, id, BIG_CLIP));
  for (const id of decks) await mkdir(join(decksRoot, id, 'assets'), { recursive: true });
  await makeRecording(sources[0], BIG_CLIP_SECONDS);
  // The copy is the same bytes, written later: that is what copying a deck does.
  await copyFile(sources[0], sources[1]);
  const later = new Date(Date.now() + 60_000);
  await utimes(sources[1], later, later);
  for (const id of decks) await saveDeck(join(decksRoot, id), clipsDeck(id, [BIG_CLIP, BIG_CLIP]));

  const renditions: TimedRendition[] = [];
  const { page, log, origin } = await startSession(kind, decksRoot, profileDir, (event) => renditions.push({ ...event, at: Date.now() }));
  for (const id of decks) await log.learn(id, BIG_CLIP);
  const settled = () => renditions.filter((e) => e.status === 'started').length
    === renditions.filter((e) => e.status !== 'started').length;
  // The premise: prepared before anyone opens the deck. The startup sweep
  // does it; on a slow machine the editor must not beat it there.
  await eventually(
    async () => renditions.some((e) => e.status === 'done'),
    'the startup sweep never prepared the recording', Boolean, 180_000,
  );

  for (const id of decks) {
    await phase(log, id, async () => {
      await page.goto(`${origin}/?deck=${id}&name=Budget`);
      await waitForEditor(page, 2);
      await browseAll(page, 2);
      // Work on while the server prepares the streaming version, as a person would.
      await eventually(async () => {
        await browseAll(page, 2);
        return renditions.length > 0 && settled();
      }, `${id}: the streaming version never finished`, Boolean, 180_000);
      await browseAll(page, 2);
    });
  }
  const t0 = log.all()[0]?.startedAt ?? 0;
  console.log(`media transfer budget (${kind}, streaming versions) — encodes:\n${encodeTimeline(renditions, t0)}`);
  console.log(`media transfer budget (${kind}, streaming versions) — every asset response:\n${TransferLog.table(repeats(log.all()))}`);
  return { log, renditions, size: (await stat(sources[0])).size };
}

/**
 * A recording shown, paused, while its encode waits behind a slow one: the
 * window every freshly uploaded clip has, made long enough to measure.
 */
async function waitingClip(kind: BrowserKind): Promise<{
  log: TransferLog; renditions: TimedRendition[]; source: string; size: number; shownAt: number;
}> {
  const { decksRoot, profileDir } = await freshWorkDir('waiting');
  const deckId = 'waiting';
  await mkdir(join(decksRoot, deckId, 'assets'), { recursive: true });
  const source = join(decksRoot, deckId, BIG_CLIP);
  await Promise.all([makeDecoy(join(decksRoot, deckId, DECOY_CLIP), 40), makeRecording(source, BIG_CLIP_SECONDS)]);
  // At first the deck shows only the decoy; the recording arrives once the
  // decoy's encode is running, as an upload lands while another encode is busy.
  const deck = clipsDeck(deckId, [DECOY_CLIP, BIG_CLIP]);
  const arriving = deck.slides[1].elements[1];
  deck.slides[1].elements = deck.slides[1].elements.slice(0, 1);
  await saveDeck(join(decksRoot, deckId), deck);

  const renditions: TimedRendition[] = [];
  const { page, log, origin } = await startSession(kind, decksRoot, profileDir, (event) => renditions.push({ ...event, at: Date.now() }));
  await log.learn(deckId, BIG_CLIP);
  await log.learn(deckId, DECOY_CLIP);
  let shownAt = 0;
  await phase(log, 'waiting', async () => {
    await page.goto(`${origin}/?deck=${deckId}&name=Budget`);
    await waitForEditor(page, 2);
    await eventually(
      async () => renditions.some((e) => e.source.endsWith(DECOY_CLIP) && e.status === 'started'),
      'the decoy never started encoding', Boolean, 60_000,
    );
    peer = new Peer(server!.port, deckId);
    await peer.hello();
    await peer.txn('Peer: add the recording', [{ op: 'insertElements', slideId: 's2', elements: [arriving] as never }]);
    await showSlide(page, 1);
    shownAt = Date.now();
    await eventually(
      async () => renditions.some((e) => e.source === source && e.status !== 'started'),
      'the recording was never prepared', Boolean, 180_000,
    );
  });
  const t0 = log.all()[0]?.startedAt ?? shownAt;
  console.log(`media transfer budget (${kind}, waiting clip) — encodes:\n${encodeTimeline(renditions, t0)}`);
  console.log(`media transfer budget (${kind}, waiting clip) — every asset response:\n${TransferLog.table(log.all())}`);
  return { log, renditions, source, size: (await stat(source)).size, shownAt };
}

/**
 * A talk of photos and clips, as a Keynote import leaves it: photos with no
 * hash in their names, an image-heavy slide right after each clip, clips big
 * enough that downloading one holds the link for seconds.
 */
const PHOTOS_DECK = 'photos';
/** Seconds of each clip: about 11 MB, three seconds of the link. */
const PHOTOS_CLIP_SECONDS = 60;

async function makePhoto(out: string, size: string, seed: number): Promise<void> {
  // Noise, so a photo weighs what a photo weighs (a test pattern compresses to nothing).
  await execFileAsync(ffmpeg, [
    '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}`, '-vf', `noise=alls=10:allf=t:all_seed=${seed}`,
    '-frames:v', '1', '-q:v', '5', out,
  ]);
}

function photosDeck(photos: string[], clips: string[]): Deck {
  const deck = emptyDeck('Photos and clips');
  const base = deck.slides[0];
  let next = 0;
  const grid = (count: number): SlideElement[] => Array.from({ length: count }, (_, i) => ({
    ...image(`p${next}`, photos[next++], 60 + (i % 4) * 460),
    y: 220 + Math.floor(i / 4) * 300, w: 440, h: 280,
  }) as SlideElement);
  const slide = (n: number, elements: SlideElement[]) => ({ ...base, id: `s${n}`, elements: [text(`t${n}`, `SLIDE ${n}`), ...elements] });
  deck.slides = [
    slide(1, grid(2)),
    slide(2, [video('c1', clips[0], 400, { autoplay: true })]),
    slide(3, grid(8)),
    slide(4, [video('c2', clips[1], 100, { autoplay: true }), ...grid(1)]),
    slide(5, grid(6)),
    slide(6, []),
  ];
  if (next !== photos.length) throw new Error(`the fixture places ${next} of ${photos.length} photos`);
  return deck;
}

/** What each slide's images looked like in the frame the slide first appeared in. */
interface FirstFrame {
  slide: string;
  images: number;
  /** Images not complete, decoded and visible in that frame. */
  missing: string[];
}

/**
 * Record, for every slide the Player puts on its stage, which images were not
 * on screen with it. A MutationObserver runs before the browser next renders,
 * so this is the frame the slide is first painted in.
 */
const watchFirstFrames = (target: string) => `(() => {
  const win = ${target};
  const doc = win.document;
  win.__firstFrames = [];
  win.__firstFrameWatch?.disconnect();
  const stage = doc.getElementById('stage');
  let last = null;
  win.__firstFrameWatch = new win.MutationObserver(() => {
    const root = stage.querySelector('.stage > .slide');
    if (!root || root === last) return;
    last = root;
    const images = [...root.querySelectorAll('img')];
    const missing = images.filter((i) => !(i.complete && i.naturalWidth > 0 && win.getComputedStyle(i).visibility !== 'hidden'))
      .map((i) => (i.getAttribute('src') || 'no src').split('/').pop().slice(0, 8)
        + ' (complete ' + i.complete + ', ' + i.naturalWidth + ' px, ' + (i.style.visibility || 'visible') + ')');
    win.__firstFrames.push({ slide: root.dataset.slideId, images: images.length, missing });
  });
  win.__firstFrameWatch.observe(stage, { childList: true, subtree: true });
  return true;
})()`;

const PRESENT_FRAME = `document.querySelector('iframe').contentWindow`;

/** A clip on the stage, watched for up to three seconds: is it playing? */
interface ClipSample {
  slide: string;
  readyState: number;
  from: number;
  to: number;
  error: number | null;
  /** How long its time took to move, from the first look. */
  waitedMs: number;
}

const sampleClips = (target: string) => `(async () => {
  const win = ${target};
  const videos = [...win.document.querySelectorAll('#stage .stage > .slide video')];
  const first = videos.map((v) => v.currentTime);
  const started = performance.now();
  const moved = () => videos.every((v, i) => v.currentTime > first[i]);
  while (!moved() && performance.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 100));
  return videos.map((v, i) => ({
    slide: v.closest('.slide')?.dataset.slideId ?? '?',
    readyState: v.readyState, from: first[i], to: v.currentTime, error: v.error?.code ?? null,
    waitedMs: Math.round(performance.now() - started),
  }));
})()`;

/** Clips that were not playing when sampled: no frame, a failed load, or time standing still. */
function stalledClips(samples: ClipSample[]): string[] {
  return samples.filter((s) => s.readyState < 2 || s.error !== null || !(s.to > s.from))
    .map((s) => `${s.slide}: readyState ${s.readyState}, currentTime ${s.from} → ${s.to} in ${s.waitedMs} ms, error ${s.error}`);
}

/** Jump the way Speaker View does: a goTo on the presentation bus. */
const jumpTo = (target: string, slide: number) => `(() => {
  const win = ${target};
  const bus = new win.BroadcastChannel('deckwerk-present:${PHOTOS_DECK}');
  bus.postMessage({ kind: 'command', command: { type: 'goTo', slide: ${slide} } });
  bus.close();
  return true;
})()`;

async function presentKey(page: Page, target: string, key: string): Promise<void> {
  await page.evaluate(`(() => {
    const win = ${target};
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
    return true;
  })()`);
}

/**
 * Present the deck cold, in a page of its own, then move about it; open the
 * editor and present it twice from there. Every step waits about as long as
 * a presenter talks over a slide, and each presentation is given the time to
 * fetch the talk's photos before it moves. A jump goes to a slide shown
 * before in the same presentation (Home, to where it opened): a slide never
 * shown nor about to be may decode its photos a frame late.
 */
async function presentingPhotos(kind: BrowserKind): Promise<{
  log: TransferLog; photos: string[]; frames: Record<string, FirstFrame[]>;
  offline: { clips: ClipSample[]; attempts: Array<{ method: string; url: string }>; moves: number };
}> {
  const { decksRoot, profileDir } = await freshWorkDir('photos');
  const deckDir = join(decksRoot, PHOTOS_DECK);
  await mkdir(join(deckDir, 'assets'), { recursive: true });
  const photos = Array.from({ length: 17 }, (_, i) => `assets/photo-${i + 1}.jpg`);
  const clips = ['assets/talk-clip-1.mp4', 'assets/talk-clip-2.mp4'];
  await Promise.all([
    ...photos.map((photo, i) => makePhoto(join(deckDir, photo), '1600x1000', i + 1)),
    makeClip(join(deckDir, clips[0]), PHOTOS_CLIP_SECONDS, true),
    makeClip(join(deckDir, clips[1]), PHOTOS_CLIP_SECONDS, true, 'mandelbrot'),
  ]);
  const deck = photosDeck(photos, clips);
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; color: #111; }\n', 'utf8');
  let photoBytes = 0;
  for (const photo of photos) photoBytes += (await stat(join(deckDir, photo))).size;

  const { page, log, origin } = await startSession(kind, decksRoot, profileDir);
  for (const file of [...photos, ...clips]) await log.learn(PHOTOS_DECK, file);
  const slides = deck.slides.length;
  const frames: Record<string, FirstFrame[]> = {};
  const collect = async (name: string, target: string) => {
    frames[name] = [...frames[name] ?? [], ...await page.evaluate<FirstFrame[]>(`${target}.__firstFrames`)];
  };
  const talk = () => new Promise((resolve) => setTimeout(resolve, 1_500));

  // Long enough for every photo to cross the link twice over: the background
  // fetch has reached every slide by the time the talk does.
  const settle = Math.max(4_000, Math.round((2 * photoBytes * 1000) / LINK.bytesPerSecond));
  await phase(log, 'present-cold', async () => {
    await page.goto(`${origin}/present.html?deck=${PHOTOS_DECK}`);
    await eventually(
      () => page.evaluate<boolean>(`Boolean(document.querySelector('#stage .slide'))`),
      'the presentation stayed blank', Boolean, 60_000,
    );
    await page.evaluate(watchFirstFrames('window'));
    await new Promise((resolve) => setTimeout(resolve, settle));
    for (let i = 1; i < slides; i++) {
      await presentKey(page, 'window', 'ArrowRight');
      await talk();
    }
    await collect('present-cold', 'window');
  });

  await phase(log, 'present-again', async () => {
    await page.evaluate(watchFirstFrames('window'));
    for (let i = 1; i < slides; i++) {
      await presentKey(page, 'window', 'ArrowLeft');
      await talk();
    }
    await presentKey(page, 'window', 'Home');
    await talk();
    for (let i = 1; i < slides; i++) {
      await presentKey(page, 'window', 'ArrowRight');
      await talk();
    }
    await collect('present-again', 'window');
  });

  await phase(log, 'editor', async () => {
    await page.goto(`${origin}/?deck=${PHOTOS_DECK}&name=Budget`);
    await waitForEditor(page, slides);
    await browseAll(page, slides);
  });

  for (const name of ['editor-present', 'editor-present-again']) {
    await showSlide(page, 0);
    await phase(log, name, async () => {
      await page.evaluate(`(() => {
        const present = [...document.querySelectorAll('#toolbar button')]
          .filter((button) => button.textContent?.trim() === 'Present')
          .find((button) => button.getClientRects().length > 0);
        present.click();
        return true;
      })()`);
      await eventually(
        () => page.evaluate<boolean>(`Boolean(document.querySelector('iframe')?.contentDocument?.querySelector('#stage .slide'))`),
        'the presentation stayed blank', Boolean, 60_000,
      );
      await page.evaluate(watchFirstFrames(PRESENT_FRAME));
      await new Promise((resolve) => setTimeout(resolve, settle));
      for (let i = 1; i < slides; i++) {
        await presentKey(page, PRESENT_FRAME, 'ArrowRight');
        await talk();
      }
      await presentKey(page, PRESENT_FRAME, 'ArrowLeft');
      await talk();
      await presentKey(page, PRESENT_FRAME, 'Home');
      await talk();
      await presentKey(page, PRESENT_FRAME, 'ArrowRight');
      await talk();
      await collect(name, PRESENT_FRAME);
      await page.evaluate(`(window.postMessage({ type: 'present-exit' }, location.origin), true)`);
      await eventually(
        () => page.evaluate<boolean>(`!document.querySelector('iframe')`),
        'the presentation overlay never closed', Boolean, 30_000,
      );
    });
  }

  // The connection goes once the talk is in memory, as a tailnet route
  // drops mid-talk: the show goes on, forward, back, home, end and a jump.
  const offline = { clips: [] as ClipSample[], attempts: [] as Array<{ method: string; url: string }>, moves: 0 };
  await showSlide(page, 0);
  await phase(log, 'offline', async () => {
    await page.evaluate(`(() => {
      const present = [...document.querySelectorAll('#toolbar button')]
        .filter((button) => button.textContent?.trim() === 'Present')
        .find((button) => button.getClientRects().length > 0);
      present.click();
      return true;
    })()`);
    await eventually(
      () => page.evaluate<boolean>(`Boolean(${PRESENT_FRAME}?.deckwerkPresentationMemory?.holdsAll())`),
      'the presentation never held the whole talk in memory', Boolean, 120_000,
    );
    link!.cut();
    await page.evaluate(watchFirstFrames(PRESENT_FRAME));
    const move = async (act: () => Promise<void>) => {
      await act();
      offline.moves += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
      offline.clips.push(...await page.evaluate<ClipSample[]>(sampleClips(PRESENT_FRAME)));
      await new Promise((resolve) => setTimeout(resolve, 500));
    };
    for (let i = 1; i < slides; i++) await move(() => presentKey(page, PRESENT_FRAME, 'ArrowRight'));
    for (let i = 1; i < slides; i++) await move(() => presentKey(page, PRESENT_FRAME, 'ArrowLeft'));
    await move(async () => { await page.evaluate(jumpTo(PRESENT_FRAME, slides - 1)); });
    await move(() => presentKey(page, PRESENT_FRAME, 'Home'));
    await move(async () => { await page.evaluate(jumpTo(PRESENT_FRAME, 3)); });
    await move(async () => { await page.evaluate(jumpTo(PRESENT_FRAME, 1)); });
    await collect('offline', PRESENT_FRAME);
    offline.attempts = link!.attempts.map(({ method, url }) => ({ method, url }));
  });

  console.log(`media transfer budget (${kind}, presenting photos) — first frames:\n${JSON.stringify(frames, null, 1)}`);
  console.log(`media transfer budget (${kind}, presenting photos) — offline:\n${JSON.stringify(offline, null, 1)}`);
  console.log(`media transfer budget (${kind}, presenting photos) — every asset response:\n${TransferLog.table(repeats(log.all()))}`);
  return { log, photos, frames, offline };
}

/** Slides that appeared without all of their images. */
function lateImages(frames: FirstFrame[]): string[] {
  return frames.filter((frame) => frame.missing.length > 0)
    .map((frame) => `${frame.slide}: ${frame.missing.length} of ${frame.images} images not on screen (${frame.missing.join(', ')})`);
}

/* ------------------------------------------------------------------------ */
/* The suite                                                                 */
/* ------------------------------------------------------------------------ */

for (const kind of ffmpeg ? BROWSERS : []) describe(`media transfer budget (${kind})`, () => {
  // A budget not met yet in these browsers, under a PENDING note for each.
  const pendingIn = (...browsers: BrowserKind[]) => (browsers.includes(kind) ? it.fails : it);

  describe('an editing session', () => {
    let log: TransferLog;
    let encodes: Array<{ args: string[] }> = [];
    beforeAll(async () => {
      ({ log, encodes } = await editingSession(kind));
    }, 600_000);
    afterAll(teardown);

    it('downloads each byte once on first contact', () => {
      expect(bytesTwice(log.in(['open', 'browse-1']))).toEqual([]);
    });
    it('re-downloads nothing when browsing again', () => {
      expect(revisitCost(log.all(), ['browse-2'])).toEqual([]);
    });
    it('re-downloads nothing when text is edited', () => {
      expect(revisitCost(log.all(), ['text-edit'])).toEqual([]);
    });
    it("re-downloads nothing when a clip's crop, trim and size change", () => {
      expect(revisitCost(log.all(), ['media-edit'])).toEqual([]);
    });
    it("re-downloads nothing when a collaborator's edit arrives", () => {
      expect(revisitCost(log.all(), ['peer-edit'])).toEqual([]);
    });
    it('re-downloads nothing coming back from presenting', () => {
      expect(revisitCost(log.all(), ['after-present'])).toEqual([]);
    });
    it('asks for no other file when a collaborator swaps in a clip nobody has', () => {
      // Only the new clip is new; the rest may at most finish what they started.
      expect(revisitCost(log.all(), ['new-clip'])).toEqual([]);
      const others = log.in(['new-clip']).filter((r) => r.path !== LATE_CLIP);
      const before = new Set(log.all().filter((r) => r.phase !== 'new-clip' && r.phase !== 'reload').map((r) => r.path));
      expect(anyTransfer(others.filter((r) => !before.has(r.path)))).toEqual([]);
    });
    it('encodes nothing small and web-safe', () => {
      // A still cut for a thumbnail is not an encode of the clip.
      expect(encodes.filter((run) => !run.args.includes('-frames:v')).map((run) => run.args.join(' '))).toEqual([]);
    });

    it('downloads nothing for the presentation that the editor already has', () => {
      expect(bytesTwice(log.all(), ['present'])).toEqual([]);
    });
    it('asks for a clip added by an edit under one URL for the whole session', () => {
      expect(severalUrls(log.all())).toEqual([]);
    });
    it('downloads nothing at a reload that already arrived', () => {
      expect(bytesTwice(log.all(), ['reload'])).toEqual([]);
    });
    // PENDING(fast-start streaming versions) in Chromium: the one file over budget keeps
    // its index at the end, so a first look takes three requests (head, index,
    // rest), and Chromium revalidates the scattered parts it holds (a 304)
    // before the presentation fetches the remainder. A fast-start remux as the
    // streaming version of such clips would cut both.
    //
    // Safari met this budget once pictures were served from /media/<key>
    // immutably (Oct 2026): before, a document it had reloaded revalidated
    // the unhashed diagram, served `no-cache`, each time it was shown.
    pendingIn('Chromium')(`takes at most ${REQUESTS_PER_FILE} requests per file over the session`, () => {
      expect(overRequestBudget(log.all())).toEqual([]);
    });
  });

  describe('a deck whose clips were prepared ahead, and a copy of it', () => {
    let log: TransferLog;
    beforeAll(async () => {
      ({ log } = await streamingVersions(kind));
    }, 600_000);
    afterAll(teardown);

    // The server prepares what is on disk when it starts, so nobody who
    // opens the deck afterwards is handed the 30 MB original.
    it('sends only the streaming version, never the original', () => {
      const original = log.all().filter((r) => r.variant === 'original');
      expect(sum(original), `bytes of the original\n${TransferLog.table(log.all())}`).toBeLessThanOrEqual(PROBE_ALLOWANCE_BYTES);
    });

    it('downloads nothing for a copy of a deck already seen', () => {
      const copy = repeats(log.all()).filter((r) => r.phase === 'talk-b');
      const fresh = sum(copy, (r) => r.body - (r.again ?? 0));
      expect(fresh, `bytes the copy needed that had not arrived\n${TransferLog.table(copy)}`).toBeLessThanOrEqual(PROBE_ALLOWANCE_BYTES);
      expect(bytesTwice(log.all())).toEqual([]);
    });

    it('asks for each version of a clip under one URL', () => {
      expect(severalUrls(log.all())).toEqual([]);
    });
  });

  // Presenting a hosted talk, Oct 2026: every slide appeared at once, and its
  // photos seconds later (15 s for one 4.7 MB photo). The presentation spent
  // the link on the next slides' clips first, looked only two slides ahead
  // for photos, and revalidated every photo it had already seen, each 304
  // queued behind a clip's download.
  describe('presenting a talk of photos and clips', () => {
    let result: Awaited<ReturnType<typeof presentingPhotos>>;
    beforeAll(async () => {
      result = await presentingPhotos(kind);
    }, 600_000);
    afterAll(teardown);
    const photoRequests = (phases?: string[]) => result.log.all()
      .filter((r) => result.photos.includes(r.path) && (!phases || phases.includes(r.phase)));

    it('fixture: every slide was shown and checked', () => {
      for (const name of ['present-cold', 'present-again', 'editor-present', 'editor-present-again']) {
        expect(result.frames[name]?.length ?? 0, name).toBeGreaterThanOrEqual(5);
      }
      expect(result.frames['present-cold'].some((frame) => frame.images >= 8)).toBe(true);
    });

    it("shows each slide's photos in the frame the slide appears, once the background fetch has reached it", () => {
      expect(lateImages(result.frames['present-cold'])).toEqual([]);
    });

    it("shows each slide's photos with it moving back, jumping and presenting again", () => {
      expect([
        ...lateImages(result.frames['present-again']),
        ...lateImages(result.frames['editor-present']),
        ...lateImages(result.frames['editor-present-again']),
      ]).toEqual([]);
    });

    it('downloads each photo once, under one URL', () => {
      const violations: string[] = [];
      for (const [, served] of groupBy(photoRequests(), (r) => r.content)) {
        const urls = new Set(served.map((r) => r.url));
        if (served.length !== 1 || urls.size !== 1) {
          violations.push(`${where(served)}: ${served.length} requests under ${urls.size} URLs\n${TransferLog.table(served)}`);
        }
      }
      expect(violations).toEqual([]);
      expect(new Set(photoRequests().map((r) => r.content)).size).toBe(result.photos.length);
    });

    // "Once everything is downloaded, it should be possible to present the
    // slides even if the connection to the server is subsequently lost."
    it('presents the whole talk from memory once the connection is lost', () => {
      expect(result.offline.moves).toBeGreaterThanOrEqual(2 * 5 + 4);
      expect(result.frames.offline?.length ?? 0).toBeGreaterThanOrEqual(2 * 5 + 2);
      expect(lateImages(result.frames.offline)).toEqual([]);
      expect(result.offline.clips.length, 'clips sampled after the cut').toBeGreaterThanOrEqual(4);
      expect(stalledClips(result.offline.clips)).toEqual([]);
      const media = result.offline.attempts.filter((a) => /^\/(?:media|decks)\//.test(a.url));
      expect(media, 'media requests after the connection was lost').toEqual([]);
    });

    it('asks the server nothing about a photo once it has arrived: moving about, the editor, presenting again', () => {
      expect(anyTransfer(photoRequests(['present-again', 'editor', 'editor-present', 'editor-present-again']))).toEqual([]);
    });
  });

  describe('a clip waiting for its streaming version', () => {
    let result: Awaited<ReturnType<typeof waitingClip>>;
    beforeAll(async () => {
      result = await waitingClip(kind);
    }, 600_000);
    afterAll(teardown);
    const readyAt = () => result.renditions.find((e) => e.source === result.source && e.status !== 'started')!.at;

    it('fixture: the clip waited long enough to measure', () => {
      expect(readyAt() - result.shownAt).toBeGreaterThan(2_000);
    });

    it('costs at most one streaming version more, once that version exists', () => {
      const done = result.renditions.find((e) => e.source === result.source && e.status === 'done');
      expect(done, 'the server produced a streaming version').toBeDefined();
      const versionSize = result.size - (done!.savedBytes ?? 0);
      const records = result.log.all().filter((r) => r.path === BIG_CLIP);
      const after = sum(records, (r) => bodyAfter(r, done!.at));
      expect(after, `bytes of the clip after its ${versionSize} B streaming version was ready\n${TransferLog.table(records)}`)
        .toBeLessThanOrEqual(versionSize + PROBE_ALLOWANCE_BYTES);
    });

    it('fetches only enough of the original to show its frame', () => {
      const budget = Math.round((PREVIEW_SECONDS * result.size) / BIG_CLIP_SECONDS);
      const at = readyAt();
      const original = result.log.all().filter((r) => r.path === BIG_CLIP && r.variant === 'original');
      const before = sum(original, (r) => r.body - bodyAfter(r, at));
      expect(before, `bytes of the original before its streaming version was ready (budget ${budget} B)\n${TransferLog.table(original)}`)
        .toBeLessThanOrEqual(budget);
    });
  });
});

describe.skipIf(!electronBinary || !ffmpeg)("a video embedded in an agent's HTML", () => {
  afterAll(teardown);

  // The other ways in are mediaIngest.test.ts's; this one needs Electron, for the compile.
  it('gets its streaming version as it arrives', async () => {
    const { decksRoot } = await freshWorkDir('html');
    await saveDeck(join(decksRoot, 'talk'), emptyDeck('talk'));
    const clip = join(workDir, 'embedded.mp4');
    await makeRecording(clip, 8);
    await startServer(decksRoot, undefined, { localAgents: new LocalAgentRegistry({ name: 'Agent' }) });

    // What `slide-agent connect` sends when the agent saves a page in its mirror.
    const html = `<!doctype html><html><body><section class="slide">
      <video src="data:video/mp4;base64,${(await readFile(clip)).toString('base64')}" style="width: 960px; height: 540px;"></video>
    </section></body></html>`;
    const response = await fetch(`http://127.0.0.1:${server!.port}/api/agent-mirror/sync-html?deck=talk`, {
      method: 'POST', headers: { 'content-type': 'text/html', 'x-deckwerk-bridge': '1' }, body: html,
    });
    const answer = await response.text();
    const assets = join(decksRoot, 'talk', 'assets');
    const arrived = (await readdir(assets).catch(() => [] as string[])).filter((name) => name.endsWith('.mp4')).map((name) => join(assets, name));
    expect(arrived.length, `the embedded video was imported (the server said ${response.status} ${answer.slice(0, 300)})`).toBe(1);
    const encoded = () => ffmpegRuns().filter(({ args }) => args.includes(arrived[0]) && args.includes('-c:v')).length;
    await eventually(async () => encoded(), 'the embedded video was never encoded', (count) => count > 0, 8_000)
      .catch(() => null);
    expect(encoded()).toBe(1);
  }, 180_000);
});

describe.skipIf(BROWSERS.length > 0 && ffmpeg)('media transfer budget (skipped)', () => {
  it('needs ffmpeg and Electron (or Safari, on a Mac, with RUN_SAFARI_MEDIA_BUDGET=1)', () => {
    expect(BROWSERS.length === 0 || !ffmpeg).toBe(true);
  });
});
