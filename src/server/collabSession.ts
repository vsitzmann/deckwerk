import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { DECK_FILE, loadDeck, loadTheme, saveSpeakerNotes, saveTheme } from '../main/deckStore.js';
import { DeckSerializer, writeDeckChunks } from '../main/deckSerializer.js';
import { validateDeckIntegrity, type AgentOperation } from '../shared/agent.js';
import { applyOpsLenient } from '../shared/collabApply.js';
import type { Deck } from '../shared/deck.js';
import { summarizeChange, summarizeReplacement, type EditAuthor } from '../shared/editHistory.js';
import { ChatLog } from './chatLog.js';
import { EditLog } from './editLog.js';
import { DeckVersionRecorder, type DeckVersionContent } from '../main/deckVersions.js';

const SAVE_DEBOUNCE_MS = 800;
const WATCH_DEBOUNCE_MS = 200;

/** Who made a change and what they called it, for the edit log. */
export interface EditMeta {
  label: string;
  author: EditAuthor;
  txnId?: string;
}

const UNATTRIBUTED: EditMeta = { label: '', author: { name: 'unknown', agent: false, via: 'server' } };

export interface AppliedTxn {
  seq: number;
  deck: Deck;
  skipped: Array<{ op: AgentOperation; reason: string }>;
}

export interface CollabSessionEvents {
  /** A genuine external write to deck.json (agent CLI, git, hand edit). */
  onExternalDeck: (deck: Deck, seq: number) => void;
  /** A genuine external write to theme.css. */
  onExternalTheme: (css: string) => void;
}

/**
 * The authoritative deck for one collaborative session.
 *
 * Transactions apply synchronously in arrival order — each accepted one bumps
 * `seq`, which is the total order every client replays. Persistence mirrors
 * the editor's autosave: debounced whole-file writes, with the exact written
 * bytes remembered so the fs watcher can tell our own echo from a genuine
 * external edit (same trick as the Electron main process).
 *
 * Not supported: the Electron app and this server editing the same deck
 * folder at once — both are debounced whole-file writers and would silently
 * last-write-wins each other.
 */
export class CollabSession {
  private saveTimer: NodeJS.Timeout | null = null;
  /**
   * What the last autosave wrote, and the file it left: a watcher event for
   * a deck.json with this inode, size and mtime is that save's own echo,
   * recognised without reading the file back.
   */
  private lastSaved: { chunks: string[]; ino: number; size: number; mtimeMs: number } | null = null;
  /** Re-serialises only what an edit replaced (main/deckSerializer.ts). */
  private readonly serializer = new DeckSerializer();
  private lastSavedTheme: string | null = null;
  private watchers: FSWatcher[] = [];
  private events: CollabSessionEvents | null = null;
  /**
   * Set by close(). A closed session owns nothing on disk any more — its
   * folder may already have been renamed — and `saveDeck` creates the folder
   * it is told to write into, so one late write would resurrect a copy of
   * the deck at the old path. Every write path checks this.
   */
  private closed = false;

  private constructor(
    readonly dir: string,
    public deck: Deck,
    public themeCss: string,
    /**
     * The deck's chat. Owned here so it opens, flushes and closes with the
     * session — but it is never part of `deck`, `seq` or any transaction.
     */
    readonly chat: ChatLog,
    /** Who changed what, beside deck.json (see shared/editHistory.ts). Also never part of `deck`. */
    readonly history: EditLog,
    /** What the deck was, every few minutes of editing (main/deckVersions.ts). */
    readonly versions: DeckVersionRecorder,
    public seq = 0,
  ) {}

  static async open(dir: string): Promise<CollabSession> {
    const deck = await loadDeck(dir);
    const themeCss = await loadTheme(dir, deck.theme);
    const chat = await ChatLog.load(dir);
    const session = new CollabSession(dir, deck, themeCss, chat, new EditLog(dir), new DeckVersionRecorder(dir));
    // The deck as found, before anybody edits it: the file's own bytes, so
    // opening costs no serialisation and no decoding. Identical to the newest
    // version (the one the last session closed with) unless something changed
    // it since, in which case that change is now restorable too.
    const raw = await readFile(join(dir, 'deck.json')).catch(() => null);
    if (raw !== null) session.versions.capture(session.versionContent(raw));
    session.warmSerializer();
    return session;
  }

  /**
   * Apply one client transaction. Even a fully-skipped transaction gets a
   * sequence number and must be broadcast: the sender confirms its pending
   * entry by seeing its own txnId come back, and replaying skipped ops is
   * idempotent by construction.
   *
   * Every accepted transaction is also a line in the edit log, attributed to
   * `meta` — written later, off this path.
   */
  applyOps(ops: AgentOperation[], meta: EditMeta = UNATTRIBUTED): AppliedTxn {
    if (this.closed) throw new Error('this presentation was closed (renamed or moved) — reopen it');
    const { deck: next, skipped } = applyOpsLenient(this.deck, ops);
    const errors = validateDeckIntegrity(next);
    if (errors.length > 0) {
      // Should be unreachable — lenient apply is total — but never let a
      // corrupt deck become authoritative.
      throw new Error(errors.join('\n'));
    }
    const before = this.deck;
    this.deck = next;
    this.seq += 1;
    if (skipped.length < ops.length) this.schedulePersist();
    if (ops.length > 0) {
      this.history.append({
        ts: new Date().toISOString(),
        seq: this.seq,
        kind: 'txn',
        label: meta.label,
        author: meta.author,
        ...(meta.txnId ? { txnId: meta.txnId } : {}),
        ...summarizeChange(before, next, ops, skipped),
      });
    }
    return { seq: this.seq, deck: next, skipped };
  }

  saveThemeCss(css: string): void {
    if (this.closed) return;
    this.themeCss = css;
    this.lastSavedTheme = css;
    void saveTheme(this.dir, this.deck.theme, css).catch((error) => {
      console.error(`theme save failed: ${String(error)}`);
    });
    if (this.lastSaved) this.versions.offer(this.versionContent(this.lastSaved.chunks));
  }

  watch(events: CollabSessionEvents): void {
    this.events = events;
    let deckTimer: NodeJS.Timeout | null = null;
    let themeTimer: NodeJS.Timeout | null = null;
    const onDeck = (): void => {
      if (deckTimer) clearTimeout(deckTimer);
      deckTimer = setTimeout(() => void this.reloadDeckFromDisk(), WATCH_DEBOUNCE_MS);
    };
    const onTheme = (): void => {
      if (themeTimer) clearTimeout(themeTimer);
      themeTimer = setTimeout(() => void this.reloadThemeFromDisk(), WATCH_DEBOUNCE_MS);
    };
    // The folder rather than the files: deck.json is replaced by rename on
    // every save (ours and any careful external writer's), and a watch bound
    // to that path goes deaf as soon as the inode behind it changes.
    const theme = this.deck.theme;
    const themeInDeckRoot = !theme.includes('/') && !theme.includes(sep);
    this.watchers.push(
      watch(this.dir, (_event, filename) => {
        const name = filename ? String(filename) : '';
        if (name === 'deck.json') onDeck();
        else if (themeInDeckRoot && name === theme) onTheme();
      }),
      ...(themeInDeckRoot ? [] : [watch(join(this.dir, theme), onTheme)]),
    );
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.persist();
    }
    await this.chat.flush();
    await this.history.flush();
    // Not the versions: flush runs on every mirror listing and download, and
    // must not turn into a version each time. They keep their own interval
    // and are written on close.
  }

  async close(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    // Closed first, so nothing can schedule a write while the last one runs;
    // the flush itself still persists what was accepted before this call.
    this.closed = true;
    await this.chat.close();
    await this.flush();
    await this.history.close();
    await this.versions.close();
  }

  /**
   * Close without writing. Only for a session whose folder is already gone
   * (deleted outside the server): flushing it would recreate the folder.
   */
  discard(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.closed = true;
    // Closing the log writes nothing new; it only stops appends and wakes waiters.
    void this.chat.close();
    this.history.discard();
    this.versions.discard();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private schedulePersist(): void {
    if (this.closed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persist();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Autosave. Only what changed since the last save is serialised, and the
   * file is written a slice at a time, so a save costs the event loop next
   * to nothing however large the deck (test/collabStalls.test.ts).
   */
  private async persist(): Promise<void> {
    try {
      const deck = this.deck;
      const chunks = this.serializer.serialize(deck);
      await writeDeckChunks(this.dir, DECK_FILE, chunks);
      const info = await stat(join(this.dir, DECK_FILE));
      this.lastSaved = { chunks, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
      await saveSpeakerNotes(this.dir, deck);
      this.versions.offer(this.versionContent(chunks));
    } catch (error) {
      console.error(`deck save failed: ${String(error)}`);
    }
  }

  /**
   * Fill the serializer's cache a slide per turn of the event loop after the
   * deck opens, so the first save does not serialise the whole deck at once.
   */
  private warmSerializer(): void {
    const deck = this.deck;
    let index = 0;
    const step = (): void => {
      if (this.closed || this.deck !== deck || index >= deck.slides.length) return;
      this.serializer.serialize({ ...deck, slides: [deck.slides[index++]] });
      setImmediate(step);
    };
    setImmediate(step);
  }

  private versionContent(deckJson: DeckVersionContent['deckJson']): DeckVersionContent {
    return { deckJson, theme: { file: this.deck.theme, css: this.themeCss } };
  }

  private async reloadDeckFromDisk(): Promise<void> {
    if (this.closed) return;
    try {
      const saved = this.lastSaved;
      const info = await stat(join(this.dir, DECK_FILE));
      // Our own autosave's echo, known by the file it left, not its contents.
      if (saved && info.ino === saved.ino && info.size === saved.size && info.mtimeMs === saved.mtimeMs) return;
      const raw = await readFile(join(this.dir, DECK_FILE), 'utf8');
      if (saved && raw === saved.chunks.join('')) return;
      // Watching the folder also surfaces writes this session never made but
      // which change nothing — a harness or script laying down the same
      // deck.json, a git checkout of identical content. No client needs a
      // resync for those, and each one would otherwise cost a seq bump.
      if (raw === this.serializer.serialize(this.deck).join('')) return;
      // A pending save means memory is ahead of disk. Adopting what disk holds
      // right now would drop the transaction that has not been written yet, so
      // let our own write be the one that lands. (Concurrent editing of one
      // folder by two writers stays unsupported, as above; this only decides
      // which way that race resolves, and losing an edit a user just made in
      // the app is the worse direction.)
      if (this.saveTimer) return;
      const deck = await loadDeck(this.dir);
      const before = this.deck;
      // Something outside the server (a script, `slide-agent history
      // --restore`, git) replaced the deck wholesale: keep what it replaced,
      // and what it replaced it with, whatever the interval.
      this.versions.capture(this.versionContent(saved?.chunks ?? this.serializer.serialize(before)));
      this.deck = deck;
      this.versions.capture(this.versionContent(raw));
      this.seq += 1;
      this.history.append({
        ts: new Date().toISOString(),
        seq: this.seq,
        kind: 'replace',
        label: 'deck.json changed on disk',
        author: { name: 'deck.json on disk', agent: false, via: 'disk' },
        ...summarizeReplacement(before, deck),
      });
      this.events?.onExternalDeck(deck, this.seq);
    } catch {
      // Half-written JSON mid-save; the next event will retry.
    }
  }

  private async reloadThemeFromDisk(): Promise<void> {
    try {
      const css = await loadTheme(this.dir, this.deck.theme);
      if (css === this.lastSavedTheme) return;
      this.themeCss = css;
      this.events?.onExternalTheme(css);
    } catch {
      // Transient read failure; next event retries.
    }
  }
}
