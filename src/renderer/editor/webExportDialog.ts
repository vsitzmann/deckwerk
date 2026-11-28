import type { WebExportQuality } from '@shared/ipc.js';

export interface WebExportChoice {
  quality: WebExportQuality;
  speakerView: boolean;
}

const QUALITIES: Array<{ value: WebExportQuality; label: string; detail: string }> = [
  {
    value: 'balanced',
    label: 'Balanced — for the web',
    detail: 'Video is cut to what the slides play and re-encoded as VP9 at up to 1920 px; stills become '
      + 'WebP at twice their on-slide size. A projector cannot tell; the folder is a fraction of the original.',
  },
  {
    value: 'compact',
    label: 'Compact — smallest folder',
    detail: 'Cut video as VP9 at up to 1280 px and stills at their on-slide size. Right for a web host, '
      + 'slightly softer when projected.',
  },
  {
    value: 'original',
    label: 'Original — no re-encoding',
    detail: 'Every referenced file is copied byte for byte. Largest, and exactly what the editor shows.',
  },
];

const STORAGE_KEY = 'deckwerk.webExport.quality';

/** Ask how much to compress the media before choosing where the export goes. */
export function showWebExportDialog(): Promise<WebExportChoice | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'workflow-overlay';

    const dialog = document.createElement('section');
    dialog.className = 'workflow-dialog web-export-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'web-export-title');

    const title = document.createElement('h2');
    title.id = 'web-export-title';
    title.textContent = 'Export for the web';

    const field = document.createElement('label');
    field.className = 'field web-export-quality';
    const caption = document.createElement('span');
    caption.textContent = 'Media quality';
    const select = document.createElement('select');
    for (const option of QUALITIES) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }
    select.value = rememberedQuality();
    field.append(caption, select);

    const detail = document.createElement('p');
    detail.className = 'web-export-detail';
    const describe = (): void => {
      detail.textContent = QUALITIES.find((q) => q.value === select.value)?.detail ?? '';
    };
    describe();
    select.addEventListener('change', describe);

    const speakerOption = document.createElement('label');
    speakerOption.className = 'field-check';
    const speakerView = document.createElement('input');
    speakerView.type = 'checkbox';
    const speakerLabel = document.createElement('span');
    speakerLabel.textContent = 'Enable offline Speaker View (shows speaker notes)';
    speakerOption.append(speakerView, speakerLabel);

    const actions = document.createElement('div');
    actions.className = 'workflow-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'primary';
    submit.textContent = 'Export';
    actions.append(cancel, submit);

    let finished = false;
    const finish = (choice: WebExportChoice | null): void => {
      if (finished) return;
      finished = true;
      overlay.remove();
      resolve(choice);
    };
    cancel.addEventListener('click', () => finish(null));
    submit.addEventListener('click', () => {
      const quality = select.value as WebExportQuality;
      try {
        localStorage.setItem(STORAGE_KEY, quality);
      } catch {
        // Storage can be unavailable; the choice simply is not remembered.
      }
      finish({ quality, speakerView: speakerView.checked });
    });
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) finish(null);
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') finish(null);
      if (event.key === 'Enter' && event.target === select) submit.click();
    });

    dialog.append(title, field, detail, speakerOption, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    select.focus();
  });
}

function rememberedQuality(): WebExportQuality {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (QUALITIES.some((q) => q.value === stored)) return stored as WebExportQuality;
  } catch {
    // Fall through to the default.
  }
  return 'balanced';
}
