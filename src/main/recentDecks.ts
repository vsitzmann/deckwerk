import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * The presentations this desktop opened last, newest first: what the Open
 * dialog's Recents lists. A deck is its folder, so that is all an entry
 * names — whether the folder mirrors a server deck is read from the folder
 * when the list is shown (remoteDecks.ts), since a deck uploaded after it
 * was last opened is a server deck from then on.
 *
 * Nothing in this file imports Electron; index.ts wires it to IPC.
 */

export interface RecentDeck {
  dir: string;
  title: string;
  /** ISO time of the last open. */
  openedAt: string;
}

const LIMIT = 30;

export class RecentDecks {
  /** Writes are queued: two windows opening at once must not drop one another's entry. */
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly now: () => Date = () => new Date()) {}

  /** Every remembered deck whose folder still holds one. */
  async list(): Promise<RecentDeck[]> {
    return (await this.read()).filter((deck) => existsSync(join(deck.dir, 'deck.json')));
  }

  /** A deck was opened: put it first. */
  note(dir: string, title: string): Promise<void> {
    const folder = resolve(dir);
    const next = this.writing.then(async () => {
      const others = (await this.read()).filter((deck) => deck.dir !== folder);
      const decks = [{ dir: folder, title, openedAt: this.now().toISOString() }, ...others].slice(0, LIMIT);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ decks }, null, 2)}\n`, 'utf8');
      await rename(temporary, this.file);
    });
    this.writing = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<RecentDeck[]> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as { decks?: unknown };
      if (!Array.isArray(raw.decks)) return [];
      return raw.decks.filter((deck): deck is RecentDeck =>
        Boolean(deck) && typeof deck.dir === 'string' && typeof deck.title === 'string' && typeof deck.openedAt === 'string');
    } catch {
      return [];
    }
  }
}
