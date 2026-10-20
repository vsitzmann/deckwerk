/**
 * A yes/no question in the app's own workflow-dialog chrome (the same
 * overlay, panel and buttons as the paste-theme and export dialogs), never
 * the browser's native `confirm()`.
 *
 * Return confirms and Escape cancels wherever focus is inside the dialog;
 * Return on the focused Cancel button cancels, as a button press would. The
 * confirm button starts focused. A click on the backdrop cancels. Focus goes
 * back to `returnFocus` (by default whatever had it when the dialog opened)
 * when the dialog closes either way.
 */
export interface ConfirmDialogOptions {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Things the action touches, each named on its own line in a scrolling list. */
  items?: string[];
  /** Paint the confirm button as destructive (`button.danger`). */
  destructive?: boolean;
  returnFocus?: HTMLElement | null;
}

export function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const returnFocus = options.returnFocus
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';

    const dialog = document.createElement('section');
    dialog.className = 'workflow-dialog confirm-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'confirm-dialog-title');
    dialog.setAttribute('aria-describedby', 'confirm-dialog-description');

    const title = document.createElement('h2');
    title.id = 'confirm-dialog-title';
    title.textContent = options.title;
    const description = document.createElement('p');
    description.id = 'confirm-dialog-description';
    description.className = 'confirm-dialog-description';
    description.textContent = options.description;

    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = options.cancelLabel ?? 'Cancel';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = options.destructive ? 'danger' : 'primary';
    confirm.textContent = options.confirmLabel;
    actions.append(cancel, confirm);

    let finished = false;
    const finish = (confirmed: boolean): void => {
      if (finished) return;
      finished = true;
      overlay.remove();
      if (returnFocus?.isConnected) returnFocus.focus();
      resolve(confirmed);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) finish(false);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
        return;
      }
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        finish(event.target !== cancel);
        return;
      }
      // Nothing else typed here may reach the shortcuts behind the dialog:
      // a held Backspace must not delete again underneath it.
      if (event.key !== 'Tab') event.stopPropagation();
    });

    dialog.append(title, description);
    if (options.items && options.items.length > 0) {
      const list = document.createElement('ul');
      list.className = 'confirm-dialog-items';
      for (const item of options.items) {
        const row = document.createElement('li');
        row.textContent = item;
        list.appendChild(row);
      }
      dialog.appendChild(list);
    }
    dialog.append(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    confirm.focus();
  });
}
