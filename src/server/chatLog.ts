import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHAT_FILE, CHAT_HISTORY_LIMIT, ChatMessageSchema, chatSince, type ChatMessage } from '../shared/chat.js';

interface Waiter {
  matches: (message: ChatMessage) => boolean;
  resolve: (messages: ChatMessage[]) => void;
  timer: NodeJS.Timeout;
}

/**
 * One deck's chat, held by its collab session and persisted to `chat.jsonl`
 * beside deck.json — never inside it (see shared/chat.ts).
 *
 * The file is append-only, one JSON message per line, so a post costs one
 * small write however long the conversation is, and a crash mid-write can
 * damage at most the last line. Loading skips any line that does not parse
 * rather than refusing the deck: chat is never worth losing a room over.
 *
 * Long-poll readers (`slide-agent chat --wait`) park here until a message
 * they care about is appended, the wait times out, or the session closes.
 */
export class ChatLog {
  private writing: Promise<void> = Promise.resolve();
  private waiters = new Set<Waiter>();
  private closed = false;

  private constructor(
    private readonly file: string,
    private readonly messages: ChatMessage[],
  ) {}

  static async load(deckDir: string): Promise<ChatLog> {
    const file = join(deckDir, CHAT_FILE);
    const messages: ChatMessage[] = [];
    let raw = '';
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      // No chat yet.
    }
    const seen = new Set<string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const message = ChatMessageSchema.parse(JSON.parse(line));
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        messages.push(message);
      } catch {
        // A torn last line or a hand edit gone wrong; keep the rest.
      }
    }
    return new ChatLog(file, messages);
  }

  /** Everything, oldest first. */
  all(): ChatMessage[] {
    return [...this.messages];
  }

  /** The newest messages, oldest first — what a joining peer is sent. */
  recent(limit = CHAT_HISTORY_LIMIT): ChatMessage[] {
    return this.messages.slice(-limit);
  }

  since(sinceId: string | null | undefined): ChatMessage[] {
    return chatSince(this.messages, sinceId);
  }

  has(id: string): boolean {
    return this.messages.some((message) => message.id === id);
  }

  /**
   * Accept a message: in memory at once, on disk in arrival order. Returns
   * false (and changes nothing) once the session has closed — its folder may
   * already be somewhere else — or for an id already posted (a resend).
   */
  append(message: ChatMessage): boolean {
    if (this.closed || this.has(message.id)) return false;
    this.messages.push(message);
    const line = `${JSON.stringify(message)}\n`;
    this.writing = this.writing
      .then(() => appendFile(this.file, line, 'utf8'))
      .catch((error) => console.error(`chat save failed: ${String(error)}`));
    for (const waiter of [...this.waiters]) {
      if (!waiter.matches(message)) continue;
      this.settle(waiter, [message]);
    }
    return true;
  }

  /**
   * Messages after `sinceId` that `matches` accepts — at once if there are
   * any, otherwise the first one appended within `timeoutMs`, otherwise [].
   * `cancel` (the reader hung up) drops the wait.
   */
  wait(
    sinceId: string | null | undefined,
    matches: (message: ChatMessage) => boolean,
    timeoutMs: number,
  ): { result: Promise<ChatMessage[]>; cancel: () => void } {
    const ready = sinceId ? this.since(sinceId).filter(matches) : [];
    if (ready.length > 0 || this.closed) {
      return { result: Promise.resolve(ready), cancel: () => {} };
    }
    let waiter!: Waiter;
    const result = new Promise<ChatMessage[]>((resolve) => {
      waiter = {
        matches,
        resolve,
        timer: setTimeout(() => this.settle(waiter, []), timeoutMs),
      };
      this.waiters.add(waiter);
    });
    return { result, cancel: () => this.settle(waiter, []) };
  }

  /** Resolve once every accepted message is on disk. */
  async flush(): Promise<void> {
    await this.writing;
  }

  /** Stop accepting messages, release every waiter, and finish writing. */
  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of [...this.waiters]) this.settle(waiter, []);
    await this.flush();
  }

  private settle(waiter: Waiter, messages: ChatMessage[]): void {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(messages);
  }
}
