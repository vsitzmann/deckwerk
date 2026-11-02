import type { Deck } from '@shared/deck.js';
import { planMerge, resolveMerge, type MergeInput, type MergeResult } from '@shared/deckMerge.js';
import { showMergeDialog } from './mergeDialog.js';

/**
 * Settle a reconnect after offline edits (CollabBridge's OfflineSync): merge
 * silently when the two sides changed different things, otherwise ask, slide
 * by slide, in the merge dialog.
 */
export async function reconcileOffline(
  input: Required<MergeInput>,
  options: {
    serverName: string;
    /** Bring the server version's pictures here first, so the dialog can show them. */
    prefetch?: (deck: Deck) => Promise<unknown>;
  },
): Promise<MergeResult & { asked: boolean }> {
  const plan = planMerge(input);
  if (plan.conflicts === 0) return { ...resolveMerge(plan), asked: false };
  if (options.prefetch) {
    await Promise.race([
      options.prefetch(input.remote).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
  }
  const choices = await showMergeDialog(plan, {
    serverName: options.serverName,
    validate: (picked) => {
      try {
        resolveMerge(plan, picked);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
  return { ...resolveMerge(plan, choices), asked: true };
}
