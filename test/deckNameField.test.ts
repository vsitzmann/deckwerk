// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createDeckNameField } from '../src/renderer/collab/deckNameField.js';

/**
 * The toolbar name of the open deck, which is also where it is renamed. The
 * field only collects a name; the shell's `rename` does the work — so these
 * pin down what reaches it, and what the field shows when it fails.
 */
function mount(options: { deckId?: string; editable?: boolean; rename?: (name: string) => Promise<void> } = {}) {
  const rename = vi.fn(options.rename ?? (async () => {}));
  const errors: string[] = [];
  const field = createDeckNameField({
    deckId: options.deckId ?? 'clients/acme/pitch',
    editable: options.editable ?? true,
    rename,
    onError: (message) => errors.push(message),
  });
  document.body.replaceChildren(field.element);
  const input = (): HTMLInputElement | null => field.element.querySelector('input');
  const key = (target: HTMLElement, name: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
  return { field, rename, errors, input, key, root: field.element };
}

describe('deck name field', () => {
  it('shows the folder dimmed and edits only the name', () => {
    const { root, input } = mount();
    expect(root.querySelector('.bar-deck-folder')?.textContent).toBe('clients/acme/');
    expect(root.querySelector('.bar-deck-label')?.textContent).toBe('pitch');
    expect(root.title).toBe('clients/acme/pitch — Rename presentation');
    root.click();
    expect(input()?.value).toBe('pitch');
    expect(document.activeElement).toBe(input());
  });

  it('commits on Enter and hands the trimmed name to rename', async () => {
    const { root, input, key, rename, field } = mount();
    root.click();
    input()!.value = '  Big Talk ';
    key(input()!, 'Enter');
    await vi.waitFor(() => expect(field.editing()).toBe(false));
    expect(rename).toHaveBeenCalledWith('Big Talk');
    expect(root.querySelector('.bar-deck-label')?.textContent).toBe('Big Talk');
  });

  it('commits on blur, and treats an empty or unchanged name as nothing to do', async () => {
    const { root, input, rename, field } = mount();
    root.click();
    input()!.value = 'pitch';
    input()!.dispatchEvent(new FocusEvent('blur'));
    root.click();
    input()!.value = '   ';
    input()!.dispatchEvent(new FocusEvent('blur'));
    expect(field.editing()).toBe(false);
    expect(rename).not.toHaveBeenCalled();
    expect(root.querySelector('.bar-deck-label')?.textContent).toBe('pitch');
  });

  it('cancels on Escape without renaming', () => {
    const { root, input, key, rename, field } = mount();
    root.click();
    input()!.value = 'Something else';
    key(input()!, 'Escape');
    expect(field.editing()).toBe(false);
    expect(rename).not.toHaveBeenCalled();
    expect(root.querySelector('.bar-deck-label')?.textContent).toBe('pitch');
  });

  it('puts the old name back and reports why when the server refuses', async () => {
    const { root, input, key, errors, field } = mount({
      rename: async () => { throw new Error('"clients/acme/taken" already exists'); },
    });
    root.click();
    input()!.value = 'taken';
    key(input()!, 'Enter');
    await vi.waitFor(() => expect(field.editing()).toBe(false));
    expect(errors).toEqual(['"clients/acme/taken" already exists']);
    expect(root.querySelector('.bar-deck-label')?.textContent).toBe('pitch');
  });

  it('asks the server once, however the edit ends while it is answering', async () => {
    let finish!: () => void;
    const { root, input, key, rename, field } = mount({
      rename: () => new Promise<void>((done) => { finish = done; }),
    });
    root.click();
    input()!.value = 'Big Talk';
    key(input()!, 'Enter');
    input()!.dispatchEvent(new FocusEvent('blur'));
    key(input()!, 'Enter');
    expect(input()!.readOnly).toBe(true);
    finish();
    await vi.waitFor(() => expect(field.editing()).toBe(false));
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('is a plain label where renaming is not allowed', () => {
    const { root, input, field } = mount({ deckId: 'talk', editable: false });
    expect(root.classList.contains('is-editable')).toBe(false);
    expect(root.querySelector<HTMLElement>('.bar-deck-folder')?.hidden).toBe(true);
    root.click();
    expect(field.editing()).toBe(false);
    expect(input()).toBeNull();
    expect(root.title).toBe('talk');
  });
});
