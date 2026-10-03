/**
 * The presentation's name in the collab toolbar, which is also where it is
 * renamed: click it (or focus it and press Enter) and the name becomes a text
 * field in place — same font, same spot. Enter or leaving the field commits,
 * Escape puts the old name back. Only the last segment of the deck id is the
 * name; the folder it is filed in is shown dimmed in front of it and is not
 * part of the edit (moving between folders is the picker's Move…).
 *
 * The field knows nothing about the server. `rename` does the work and
 * resolves once it has (the shell then follows the deck to its new id, which
 * reloads the page), or rejects with a message for the status bar — at which
 * point the field shows the old name again.
 */

export interface DeckNameFieldOptions {
  deckId: string;
  /** False in a hosted session, or for someone who does not manage the deck. */
  editable: boolean;
  rename: (name: string) => Promise<void>;
  onError: (message: string) => void;
}

export interface DeckNameField {
  element: HTMLElement;
  /** Whether the text field is showing (tests, and the shell's Escape guard). */
  editing(): boolean;
}

/** Same cap the server applies to a deck name. */
const MAX_NAME_LENGTH = 80;

export function createDeckNameField(options: DeckNameFieldOptions): DeckNameField {
  const slash = options.deckId.lastIndexOf('/');
  const folder = slash === -1 ? '' : options.deckId.slice(0, slash + 1);
  let name = options.deckId.slice(slash + 1);

  const root = document.createElement('span');
  root.className = 'bar-deck-name';
  const folderLabel = document.createElement('span');
  folderLabel.className = 'bar-deck-folder';
  folderLabel.textContent = folder;
  folderLabel.hidden = folder === '';
  const label = document.createElement('span');
  label.className = 'bar-deck-label';
  label.textContent = name;
  root.append(folderLabel, label);
  root.title = options.deckId;

  let input: HTMLInputElement | null = null;
  let committing = false;

  if (options.editable) {
    root.classList.add('is-editable');
    root.title = `${options.deckId} — Rename presentation`;
    root.tabIndex = 0;
    root.setAttribute('role', 'button');
    root.setAttribute('aria-label', `Rename presentation “${name}”`);
    root.addEventListener('click', () => begin());
    root.addEventListener('keydown', (event) => {
      if (input || (event.key !== 'Enter' && event.key !== 'F2')) return;
      event.preventDefault();
      begin();
    });
  }

  /**
   * Width in `ch`: the toolbar font is monospaced, so this is exactly the
   * label's width — the box does not jump when editing starts — plus room
   * for the caret after the last character.
   */
  const fit = (field: HTMLInputElement): void => {
    field.style.width = `calc(${Math.max(field.value.length, 4)}ch + 2px)`;
  };

  function begin(): void {
    if (input || committing) return;
    const field = document.createElement('input');
    field.className = 'bar-deck-input';
    field.type = 'text';
    field.value = name;
    field.maxLength = MAX_NAME_LENGTH;
    field.spellcheck = false;
    field.autocomplete = 'off';
    field.setAttribute('aria-label', 'Presentation name');
    fit(field);
    field.addEventListener('input', () => fit(field));
    field.addEventListener('keydown', (event) => {
      // The field owns these keys; nothing behind it should see them.
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        void commit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        end(true);
      }
    });
    field.addEventListener('blur', () => void commit());
    // A click inside the field is caret placement, not a second begin().
    field.addEventListener('click', (event) => event.stopPropagation());
    input = field;
    root.classList.add('is-editing');
    root.removeAttribute('role');
    root.tabIndex = -1;
    label.replaceWith(field);
    field.focus();
    field.select();
  }

  /**
   * Back to the label, showing `name`. A keyboard ending (Enter, Escape)
   * leaves focus on the name; a click elsewhere already moved it on.
   */
  function end(refocus = false): void {
    if (!input) return;
    const field = input;
    input = null;
    label.textContent = name;
    field.replaceWith(label);
    root.classList.remove('is-editing', 'is-busy');
    root.setAttribute('role', 'button');
    root.tabIndex = 0;
    if (refocus) root.focus();
  }

  async function commit(refocus = false): Promise<void> {
    if (!input || committing) return;
    const next = input.value.trim();
    // Nothing typed, or nothing changed: there is nothing to ask the server.
    if (!next || next === name) {
      end(refocus);
      return;
    }
    committing = true;
    input.readOnly = true;
    root.classList.add('is-busy');
    try {
      await options.rename(next);
      // The shell is on its way to the deck's new id; until the page goes,
      // show the name that was accepted.
      name = next;
      end(refocus);
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
      end(refocus);
    } finally {
      committing = false;
    }
  }

  return { element: root, editing: () => input !== null };
}
