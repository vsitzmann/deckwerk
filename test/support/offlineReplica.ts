import { CollabBridge, type OfflineSync, type SyncBaseline } from '../../src/renderer/collab/collabBridge.js';
import type { Deck } from '../../src/shared/deck.js';
import { parseDeck } from '../../src/shared/deck.js';
import { planMerge, resolveMerge, type MergeChoices, type MergePlan } from '../../src/shared/deckMerge.js';
import type { MergeInput, MergeResult } from '../../src/shared/deckMerge.js';

/**
 * A replica of a server deck as the desktop keeps it, minus the window: the
 * deck on "screen", a `CollabBridge` in offline mode, and a stand-in for the
 * merge dialog. Edits go through the same `localEdit` path the editor's store
 * drives; server decks land through the same hooks.
 */
export interface ReplicaOptions {
  name: string;
  /** Answers the merge dialog. Default: refuse (the test did not expect one). */
  choose?: (plan: MergePlan) => MergeChoices | Promise<MergeChoices>;
  seed?: { baseline: SyncBaseline; local: Deck; themeCss: string };
  /** A browser-style peer: no offline mode, a reconnect drops unsent edits. */
  plain?: boolean;
}

export class OfflineReplica {
  deck: Deck | null = null;
  themeCss = '';
  connected = false;
  readonly bridge: CollabBridge;
  /** Every merge the replica was asked to settle, with whether it went to the dialog. */
  readonly merges: Array<{ plan: MergePlan; dialog: boolean }> = [];
  private welcomed = 0;
  private waiters: Array<() => void> = [];

  constructor(url: string, private readonly options: ReplicaOptions) {
    const offline: OfflineSync = {
      local: () => ({ deck: this.deck!, themeCss: this.themeCss }),
      reconcile: async (input: Required<MergeInput>): Promise<MergeResult> => {
        const plan = planMerge(input);
        this.merges.push({ plan, dialog: plan.conflicts > 0 });
        queueMicrotask(() => this.notify());
        if (plan.conflicts === 0) return resolveMerge(plan);
        if (!this.options.choose) throw new Error(`${this.options.name}: unexpected merge dialog`);
        return resolveMerge(plan, await this.options.choose(plan));
      },
    };
    this.bridge = new CollabBridge(url, options.name, {
      onDeckReplaced: (deck) => {
        this.deck = deck;
        this.notify();
      },
      onWelcome: (welcome) => {
        this.deck = welcome.deck;
        this.themeCss = welcome.themeCss;
        this.welcomed += 1;
        this.notify();
      },
      onPeerPresence: () => {},
      onPeerCursor: () => {},
      onPeerLeft: () => {},
      onThemeCss: (css) => {
        this.themeCss = css;
        this.notify();
      },
      onStatus: () => {},
      onCleanChange: () => this.notify(),
      onConnectionChange: (connected) => {
        this.connected = connected;
        this.notify();
      },
    }, options.plain ? undefined : offline);
    if (options.seed) {
      this.bridge.seed(options.seed.baseline);
      this.deck = options.seed.local;
      this.themeCss = options.seed.themeCss;
    }
  }

  connect(): this {
    this.bridge.connect();
    return this;
  }

  close(): void {
    this.bridge.close();
  }

  /** Make a local edit the way the editor's store reports one. */
  edit(label: string, fn: (deck: Deck) => void): void {
    if (!this.deck) throw new Error('nothing to edit yet');
    const prev = this.deck;
    const copy = structuredClone(prev);
    fn(copy);
    const next = parseDeck(copy);
    this.deck = next;
    this.bridge.localEdit(prev, next, label);
  }

  setTheme(css: string): void {
    this.themeCss = css;
    this.bridge.sendTheme(css);
  }

  get welcomes(): number {
    return this.welcomed;
  }

  /** Resolve once `predicate` holds, re-checked on every hook. */
  until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.options.name}: timed out waiting for ${what}`)), timeoutMs);
      const check = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== check);
        resolve();
      };
      this.waiters.push(check);
    });
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
