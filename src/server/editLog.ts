import { appendFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  HISTORY_FILE,
  HISTORY_ROTATE_BYTES,
  HISTORY_ROTATED_FILE,
  type EditHistoryEntry,
} from '../shared/editHistory.js';

const FLUSH_DELAY_MS = 250;

/**
 * One deck's edit log (`history.jsonl`, see shared/editHistory.ts), owned by
 * its collab session.
 *
 * Appending never touches the disk on the transaction's path: lines are
 * queued and written together a moment later, in order, by one write at a
 * time, so a burst of typing costs one append rather than one per keystroke.
 * Past `rotateBytes` the file becomes `history.1.jsonl` (replacing the one
 * before) and a fresh one starts. `close` writes whatever is queued;
 * `discard` drops it, for a session whose folder is already gone.
 */
export class EditLog {
  private queue: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private size: number | null = null;
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly rotateBytes = HISTORY_ROTATE_BYTES,
  ) {}

  append(entry: EditHistoryEntry): void {
    if (this.closed) return;
    this.queue.push(`${JSON.stringify(entry)}\n`);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
  }

  /** Resolve once every line appended so far is on disk. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length > 0) {
      const batch = this.queue.join('');
      this.queue = [];
      this.writing = this.writing
        .then(() => this.write(batch))
        .catch((error) => console.error(`edit log write failed: ${String(error)}`));
    }
    return this.writing;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  discard(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
  }

  private async write(batch: string): Promise<void> {
    const file = join(this.dir, HISTORY_FILE);
    const bytes = Buffer.byteLength(batch);
    this.size ??= (await stat(file).catch(() => null))?.size ?? 0;
    if (this.size > 0 && this.size + bytes > this.rotateBytes) {
      await rename(file, join(this.dir, HISTORY_ROTATED_FILE)).catch(() => undefined);
      this.size = 0;
    }
    await appendFile(file, batch, 'utf8');
    this.size += bytes;
  }
}
