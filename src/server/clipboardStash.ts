/**
 * Copies made in the browser editor, parked on the server.
 *
 * The desktop app carries a copied fragment between decks on the OS
 * pasteboard under a private format. A web page cannot write a private
 * format; all it can rely on is plain text. So a browser copy leaves only a
 * random token on the OS clipboard (`deckwerk-clipboard:<id>`) and hands the
 * fragment itself to the server under that id. Any tab on the same server —
 * another deck, the same deck after a reload — that finds the token on paste
 * asks for the fragment back.
 *
 * Why not the clipboard's `text/html`: whatever a page puts there every other
 * website can put there too, and a fragment is markup that lands in a shared
 * deck. A fragment from this store was written by the same signed-in person
 * through this server, and the id is unguessable.
 *
 * The bytes are stored and returned as sent, never parsed here: a copy of a
 * hundred slides must not stall every room's event loop. The paste side
 * validates them with the deck schemas. Entries live in memory only — a copy
 * is a minutes-long intention, not a document — and are evicted by age and,
 * past a total budget, oldest first.
 */

export interface StashedCopy {
  /** The deck the copy was made in; its assets are resolved against it. */
  deck: string;
  body: Buffer;
}

interface Entry extends StashedCopy {
  /** Tailnet login of whoever copied, or null with access control off. */
  owner: string | null;
  at: number;
}

/** Client-minted ids: 128 random bits as hex, or the like. */
export const CLIPBOARD_ID = /^[A-Za-z0-9_-]{16,64}$/;

export interface ClipboardStashOptions {
  /** Bytes all entries may hold together. */
  maxTotalBytes?: number;
  /** Bytes one copy may hold. */
  maxEntryBytes?: number;
  /** How long a copy stays pasteable, in ms. */
  ttlMs?: number;
  now?: () => number;
}

export class ClipboardStash {
  readonly maxEntryBytes: number;
  private readonly maxTotalBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  /** Insertion order is age order: the first entry is the oldest. */
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(options: ClipboardStashOptions = {}) {
    this.maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
    this.maxEntryBytes = Math.min(options.maxEntryBytes ?? 32 * 1024 * 1024, this.maxTotalBytes);
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Park a copy. False when the id is malformed, the copy is too large, or the
   * id already belongs to someone else (ids are client-minted; one person must
   * not be able to replace another's copy by reusing its id).
   */
  put(id: string, owner: string | null, deck: string, body: Buffer): boolean {
    if (!CLIPBOARD_ID.test(id) || body.length > this.maxEntryBytes) return false;
    const existing = this.entries.get(id);
    if (existing && existing.owner !== owner) return false;
    if (existing) this.remove(id, existing);
    this.prune();
    while (this.totalBytes + body.length > this.maxTotalBytes) {
      const [oldest] = this.entries;
      if (!oldest) break;
      this.remove(oldest[0], oldest[1]);
    }
    this.entries.set(id, { owner, deck, body, at: this.now() });
    this.totalBytes += body.length;
    return true;
  }

  /** The copy parked under `id`, if it is still there and `owner` made it. */
  get(id: string, owner: string | null): StashedCopy | null {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return null;
    return { deck: entry.deck, body: entry.body };
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.at > cutoff) break;
      this.remove(id, entry);
    }
  }

  private remove(id: string, entry: Entry): void {
    this.entries.delete(id);
    this.totalBytes -= entry.body.length;
  }
}
