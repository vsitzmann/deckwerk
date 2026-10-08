import { randomUUID, webcrypto } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { slices } from './deckSerializer.js';
import { promisify } from 'node:util';
import { createGzip, gunzip } from 'node:zlib';

/**
 * Point-in-time copies of a hosted deck, so any change — a person's, an
 * agent's, a script writing deck.json behind the server — can be undone by
 * putting an earlier version back (`slide-agent history --versions`,
 * `--restore`). The edit log (history.jsonl) says who changed what and when;
 * these hold what the deck *was*.
 *
 * Each version is `.versions/<time>.<hash>.json.gz` in the deck folder:
 * deck.json exactly as the server wrote it, plus the theme stylesheet. The
 * dot keeps the folder out of downloads, agent mirrors and uploaded archives,
 * like every other dotfile.
 *
 * Built so the people editing never pay for it. A version reuses the string
 * the debounced autosave already serialised — nothing is serialised again —
 * is taken at most once per VERSION_INTERVAL_MS per deck while it is edited,
 * and is compressed, hashed and written off the event loop: zlib, WebCrypto's
 * digest and fs all run on libuv's thread pool, and the deck is handed to the
 * compressor in slices with a yield between each, so even a 20 MB deck never
 * holds the event loop for more than about a millisecond at a time. `offer`,
 * the only call on the save path, just keeps a reference and maybe starts a
 * timer.
 */
export const VERSIONS_DIR = '.versions';
export const VERSION_INTERVAL_MS = 2 * 60_000;
/** Every version younger than this is kept; older ones thin to the last of each day. */
export const KEEP_EVERY_VERSION_MS = 30 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const gunzipAsync = promisify(gunzip);
/** How much of the deck is encoded per turn of the event loop. */
const SLICE = 256 * 1024;

export interface DeckVersionContent {
  /** deck.json as written to disk: its bytes when read, its chunks when serialised (main/deckSerializer.ts). */
  deckJson: string | Buffer | readonly string[];
  /** The deck's stylesheet, which lives beside deck.json rather than in it. */
  theme?: { file: string; css: string };
}

export interface DeckVersion {
  /** The file name without `.json.gz`, which is also what `--restore` takes. */
  id: string;
  at: Date;
  hash: string;
  bytes: number;
  file: string;
}

const NAME = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.([0-9a-f]{12})\.json\.gz$/;

/**
 * The version file's bytes: `{"version":1,"theme":…,"deck":<deck.json>}`,
 * gzipped. deck.json is spliced in rather than re-serialised, slice by slice.
 */
async function compressVersion(content: DeckVersionContent): Promise<Buffer> {
  const gzip = createGzip();
  const chunks: Buffer[] = [];
  gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolveDone, reject) => {
    gzip.on('end', resolveDone);
    gzip.on('error', reject);
  });
  const write = (chunk: Buffer) => new Promise<void>((resolveWrite) => {
    // Waiting for 'drain' when the stream is full keeps memory flat; the
    // yield in between lets every other room's messages through.
    if (gzip.write(chunk)) setImmediate(resolveWrite);
    else gzip.once('drain', resolveWrite);
  });
  await write(Buffer.from(`{"version":1,"theme":${JSON.stringify(content.theme ?? null)},"deck":`, 'utf8'));
  const deck = content.deckJson;
  if (Buffer.isBuffer(deck)) {
    for (let start = 0; start < deck.length; start += SLICE) await write(deck.subarray(start, start + SLICE));
  } else {
    for (const chunk of typeof deck === 'string' ? [deck] : deck) {
      for (const slice of slices(chunk, SLICE)) await write(Buffer.from(slice, 'utf8'));
    }
  }
  gzip.end(Buffer.from('}', 'utf8'));
  await done;
  return Buffer.concat(chunks);
}

/** Identifies a version's content (gzip is deterministic), hashed on the thread pool. */
async function versionHash(compressed: Buffer): Promise<string> {
  const digest = await webcrypto.subtle.digest('SHA-256', compressed);
  return Buffer.from(digest).toString('hex').slice(0, 12);
}

/** Every version of the deck in `dir`, oldest first. */
export async function listDeckVersions(dir: string): Promise<DeckVersion[]> {
  const folder = join(dir, VERSIONS_DIR);
  const names = await readdir(folder).catch(() => [] as string[]);
  const versions: DeckVersion[] = [];
  for (const name of names.sort()) {
    const match = NAME.exec(name);
    if (!match) continue;
    const at = new Date(match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
    const bytes = await stat(join(folder, name)).then((info) => info.size, () => 0);
    versions.push({ id: name.slice(0, -'.json.gz'.length), at, hash: match[2], bytes, file: join(folder, name) });
  }
  return versions;
}

/** A version's deck (unvalidated: parse it with parseDeck) and stylesheet. */
export async function readDeckVersion(
  version: DeckVersion,
): Promise<{ deck: unknown; theme: { file: string; css: string } | null }> {
  const text = (await gunzipAsync(await readFile(version.file))).toString('utf8');
  const parsed = JSON.parse(text) as { deck: unknown; theme?: { file: string; css: string } | null };
  return { deck: parsed.deck, theme: parsed.theme ?? null };
}

/**
 * Write one version, unless the newest one already holds exactly this.
 * Returns the version written, or null when it was a duplicate.
 */
export async function writeDeckVersion(
  dir: string,
  content: DeckVersionContent,
  at = new Date(),
): Promise<DeckVersion | null> {
  const compressed = await compressVersion(content);
  const hash = await versionHash(compressed);
  const folder = join(dir, VERSIONS_DIR);
  const newest = (await readdir(folder).catch(() => [] as string[])).filter((name) => NAME.test(name)).sort().at(-1);
  if (newest && NAME.exec(newest)![2] === hash) return null;
  await mkdir(folder, { recursive: true });
  const id = `${at.toISOString().replace(/:/g, '-').replace('.', '-')}.${hash}`;
  const file = join(folder, `${id}.json.gz`);
  const temporary = join(folder, `.${id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, compressed);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { id, at, hash, bytes: compressed.length, file };
}

/** Thin versions older than KEEP_EVERY_VERSION_MS to the last one of each (UTC) day. */
export async function pruneDeckVersions(dir: string, now = Date.now()): Promise<number> {
  const old = (await listDeckVersions(dir)).filter((version) => now - version.at.getTime() > KEEP_EVERY_VERSION_MS);
  const lastOfDay = new Map<string, DeckVersion>();
  for (const version of old) lastOfDay.set(version.at.toISOString().slice(0, 10), version);
  const keep = new Set(lastOfDay.values());
  let removed = 0;
  for (const version of old) {
    if (keep.has(version)) continue;
    await unlink(version.file).catch(() => {});
    removed += 1;
  }
  return removed;
}

/**
 * Takes versions of one deck for its collab session: the deck as it was
 * opened, then at most one per VERSION_INTERVAL_MS while it is edited, the
 * state on both sides of anything that replaces the deck wholesale, and the
 * final state when the session closes.
 */
export class DeckVersionRecorder {
  private pending: DeckVersionContent | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastTakenAt = 0;
  /** The last version's timestamp: names must sort in the order versions were taken. */
  private lastStamp = 0;
  private lastPrunedAt = 0;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly intervalMs = VERSION_INTERVAL_MS,
  ) {}

  /** The deck as just saved. Cheap: keeps a reference, takes a version when the interval allows. */
  offer(content: DeckVersionContent): void {
    if (this.closed) return;
    this.pending = content;
    const wait = this.lastTakenAt + this.intervalMs - Date.now();
    if (wait <= 0) {
      this.take();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.take();
    }, wait);
  }

  /** Take a version of `content` now, whatever the interval: a state about to be replaced. */
  capture(content: DeckVersionContent): void {
    if (this.closed) return;
    this.pending = content;
    this.take();
  }

  /** Resolve once every version taken so far is on disk. */
  async flush(): Promise<void> {
    this.take();
    await this.writing;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  /** Stop without writing: the deck's folder is already gone. */
  discard(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.closed = true;
  }

  private take(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const content = this.pending;
    this.pending = null;
    if (!content || this.closed) return;
    this.lastTakenAt = Date.now();
    const at = new Date(Math.max(this.lastTakenAt, this.lastStamp + 1));
    this.lastStamp = at.getTime();
    this.writing = this.writing
      .then(async () => {
        await writeDeckVersion(this.dir, content, at);
        if (Date.now() - this.lastPrunedAt > PRUNE_EVERY_MS) {
          this.lastPrunedAt = Date.now();
          await pruneDeckVersions(this.dir);
        }
      })
      .catch((error) => console.error(`deck version write failed: ${String(error)}`));
  }
}
