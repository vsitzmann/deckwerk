import { showConfirmDialog } from './confirmDialog.js';

/** The DeckWerk menu's entry, the same wording on the desktop and in the browser. */
export const ASK_AGENT_LABEL = 'Question? Ask your agent!';

/**
 * "Question? Ask your agent!": the prompt a person pastes into their own agent
 * with a question about DeckWerk. The prompt only points the agent at the
 * feature reference (shared/tutorial.ts `askAgentPrompt`), so the dialog shows
 * it whole — it is short, and the person can read what they are pasting.
 *
 * Resolves with whether the prompt reached the clipboard.
 */
export async function showAskAgentDialog(prompt: string): Promise<boolean> {
  const body = document.createElement('pre');
  body.className = 'ask-agent-prompt';
  body.textContent = prompt;
  const copy = await showConfirmDialog({
    title: ASK_AGENT_LABEL,
    description: 'Copy-paste the following prompt into your favorite agent as well as any question you might have about DeckWerk.',
    body,
    confirmLabel: 'Copy prompt',
    cancelLabel: 'Close',
    className: 'ask-agent-dialog',
  });
  if (!copy) return false;
  try {
    await navigator.clipboard.writeText(prompt);
    return true;
  } catch {
    return false;
  }
}
