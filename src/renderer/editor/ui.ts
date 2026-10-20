/** Small shared controls used by the editor and collaboration shells. */

export type MenuItem =
  | { label: string; action: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | 'separator';

export function button(
  label: string,
  action: () => void,
  options: { variant?: 'primary' | 'danger' | 'quiet'; className?: string } = {},
): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = ['ui-button', options.variant ? `ui-button-${options.variant}` : '', options.className ?? '']
    .filter(Boolean)
    .join(' ');
  node.textContent = label;
  node.addEventListener('click', action);
  return node;
}

export function menuButton(label: string, items: () => MenuItem[]): HTMLButtonElement {
  const trigger = button(label, () => openMenu(trigger, items()), { variant: 'quiet' });
  trigger.classList.add('ui-menu-trigger');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  return trigger;
}

let activePopover: HTMLElement | null = null;
let activeDismiss: ((event: Event) => void) | null = null;

export function closePopover(): void {
  activePopover?.remove();
  activePopover = null;
  if (activeDismiss) document.removeEventListener('pointerdown', activeDismiss, true);
  activeDismiss = null;
  for (const expanded of document.querySelectorAll<HTMLElement>('[aria-expanded="true"]')) {
    expanded.setAttribute('aria-expanded', 'false');
  }
}

function placePopover(popover: HTMLElement, anchor: HTMLElement, beside?: Element | null): void {
  document.body.appendChild(popover);
  const anchorRect = anchor.getBoundingClientRect();
  const rect = popover.getBoundingClientRect();
  if (beside) {
    // Outside the panel, level with the control, so the panel's other rows
    // stay in view and in reach while the popover is open.
    const panel = beside.getBoundingClientRect();
    const sideLeft = panel.left - 6 - rect.width >= 8 ? panel.left - 6 - rect.width
      : panel.right + 6 + rect.width <= window.innerWidth - 8 ? panel.right + 6
        : null;
    if (sideLeft !== null) {
      popover.style.left = `${sideLeft}px`;
      popover.style.top = `${Math.max(8, Math.min(anchorRect.top, window.innerHeight - rect.height - 8))}px`;
      return;
    }
  }
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - rect.width - 8));
  let top = anchorRect.bottom + 6;
  if (top + rect.height > window.innerHeight - 8) top = Math.max(8, anchorRect.top - rect.height - 6);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function bindDismiss(popover: HTMLElement, anchor: HTMLElement): void {
  activePopover = popover;
  anchor.setAttribute('aria-expanded', 'true');
  popover.addEventListener('pointerdown', (event) => event.stopPropagation());
  activeDismiss = (event) => {
    if (event.target instanceof Node && (popover.contains(event.target) || anchor.contains(event.target))) return;
    closePopover();
  };
  setTimeout(() => activeDismiss && document.addEventListener('pointerdown', activeDismiss, true), 0);
}

/**
 * Show editor-owned content beside a control while sharing the same singleton
 * and outside-click behaviour as menus and help. Complex controls such as the
 * colour picker use this instead of reimplementing popover positioning.
 */
export function openAnchoredPopover(
  anchor: HTMLElement,
  popover: HTMLElement,
  options: {
    focus?: boolean;
    /** Open beside this container rather than over it, when there is room. */
    beside?: Element | null;
  } = {},
): void {
  closePopover();
  placePopover(popover, anchor, options.beside);
  bindDismiss(popover, anchor);
  if (options.focus !== false) {
    popover.querySelector<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
    )?.focus();
  }
}

export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  closePopover();
  const menu = document.createElement('div');
  menu.className = 'ui-menu';
  menu.role = 'menu';
  for (const item of items) {
    if (item === 'separator') {
      const separator = document.createElement('div');
      separator.className = 'ui-menu-separator';
      separator.role = 'separator';
      menu.appendChild(separator);
      continue;
    }
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `ui-menu-item${item.danger ? ' danger' : ''}`;
    row.role = 'menuitem';
    row.disabled = item.disabled ?? false;
    const text = document.createElement('span');
    text.textContent = item.label;
    row.appendChild(text);
    if (item.hint) {
      const hint = document.createElement('kbd');
      hint.textContent = item.hint;
      row.appendChild(hint);
    }
    row.addEventListener('click', () => {
      closePopover();
      item.action();
    });
    menu.appendChild(row);
  }
  placePopover(menu, anchor);
  bindDismiss(menu, anchor);
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closePopover();
      anchor.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = Math.max(0, rows.indexOf(document.activeElement as HTMLButtonElement));
    const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
    rows[next]?.focus();
  });
}

export interface HelpContent {
  title: string;
  description: string;
  firstAction: string;
}

export function helpButton(content: HelpContent): HTMLButtonElement {
  const help = button('?', () => {
    if (activePopover?.dataset.helpId === help.dataset.helpId) {
      closePopover();
      return;
    }
    closePopover();
    const popover = document.createElement('aside');
    popover.className = 'ui-help-popover';
    popover.dataset.helpId = help.dataset.helpId;
    popover.role = 'tooltip';
    const title = document.createElement('strong');
    title.textContent = content.title;
    const description = document.createElement('p');
    description.textContent = content.description;
    const first = document.createElement('p');
    first.className = 'ui-help-first';
    first.textContent = `Start here: ${content.firstAction}`;
    popover.append(title, description, first);
    placePopover(popover, help);
    bindDismiss(popover, help);
  }, { variant: 'quiet', className: 'ui-help-button' });
  help.dataset.helpId = `help-${Math.random().toString(36).slice(2)}`;
  help.setAttribute('aria-label', `Help: ${content.title}`);
  help.setAttribute('aria-haspopup', 'true');
  help.setAttribute('aria-expanded', 'false');
  return help;
}

export function sectionHeading(title: string, help?: HelpContent): HTMLElement {
  const header = document.createElement('header');
  header.className = 'ui-section-heading';
  const heading = document.createElement('h3');
  heading.textContent = title;
  header.appendChild(heading);
  if (help) header.appendChild(helpButton(help));
  return header;
}

export function showToast(message: string, kind: 'info' | 'error' = 'info'): void {
  const region = document.getElementById('toast-region') ?? (() => {
    const node = document.createElement('div');
    node.id = 'toast-region';
    node.setAttribute('aria-live', 'polite');
    document.body.appendChild(node);
    return node;
  })();
  const toast = document.createElement('div');
  toast.className = `ui-toast ${kind}`;
  toast.textContent = message;
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 4500);
}
