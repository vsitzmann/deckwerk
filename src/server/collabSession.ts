import { watch, type FSWatcher } from 'node:fs';
import { join, sep } from 'node:path';
import { loadDeck, saveDeck, loadTheme, saveTheme, serializeDeck } from '../main/deckStore.js';
import { validateDeckIntegrity, type AgentOperation } from '../shared/agent.js';
import { applyOpsLenient } from '../shared/collabApply.js';
import type { Deck } from '../shared/deck.js';

const SAVE_DEBOUNCE_MS = 800;
const WATCH_DEBOUNCE_MS = 200;

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
  private lastSavedJson: string | null = null;
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
    public seq = 0,
  ) {}

  static async open(dir: string): Promise<CollabSession> {
    const deck = await loadDeck(dir);
    const themeCss = await loadTheme(dir, deck.theme);
    return new CollabSession(dir, deck, themeCss);
  }

  /**
   * Apply one client transaction. Even a fully-skipped transaction gets a
   * sequence number and must be broadcast: the sender confirms its pending
   * entry by seeing its own txnId come back, and replaying skipped ops is
   * idempotent by construction.
   */
  applyOps(ops: AgentOperation[]): AppliedTxn {
    if (this.closed) throw new Error('this presentation was closed (renamed or moved) — reopen it');
    const { deck: next, skipped } = applyOpsLenient(this.deck, ops);
    const errors = validateDeckIntegrity(next);
    if (errors.length > 0) {
      // Should be unreachable — lenient apply is total — but never let a
      // corrupt deck become authoritative.
      throw new Error(errors.join('\n'));
    }
    this.deck = next;
    this.seq += 1;
    if (skipped.length < ops.length) this.schedulePersist();
    return { seq: this.seq, deck: next, skipped };
  }

  saveThemeCss(css: string): void {
    if (this.closed) return;
    this.themeCss = css;
    this.lastSavedTheme = css;
    void saveTheme(this.dir, this.deck.theme, css).catch((error) => {
      console.error(`theme save failed: ${String(error)}`);
    });
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
  }

  async close(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    // Closed first, so nothing can schedule a write while the last one runs;
    // the flush itself still persists what was accepted before this call.
    this.closed = true;
    await this.flush();
  }

  /**
   * Close without writing. Only for a session whose folder is already gone
   * (deleted outside the server): flushing it would recreate the folder.
   */
  discard(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.closed = true;
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

  private async persist(): Promise<void> {
    try {
      this.lastSavedJson = await saveDeck(this.dir, this.deck);
    } catch (error) {
      console.error(`deck save failed: ${String(error)}`);
    }
  }

  private async reloadDeckFromDisk(): Promise<void> {
    if (this.closed) return;
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(join(this.dir, 'deck.json'), 'utf8');
      if (raw === this.lastSavedJson) return; // our own autosave echo
      // Watching the folder also surfaces writes this session never made but
      // which change nothing — a harness or script laying down the same
      // deck.json, a git checkout of identical content. No client needs a
      // resync for those, and each one would otherwise cost a seq bump.
      if (raw === serializeDeck(this.deck)) return;
      // A pending save means memory is ahead of disk. Adopting what disk holds
      // right now would drop the transaction that has not been written yet, so
      // let our own write be the one that lands. (Concurrent editing of one
      // folder by two writers stays unsupported, as above; this only decides
      // which way that race resolves, and losing an edit a user just made in
      // the app is the worse direction.)
      if (this.saveTimer) return;
      const deck = await loadDeck(this.dir);
      this.deck = deck;
      this.seq += 1;
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
