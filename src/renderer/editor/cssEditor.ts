import { css } from '@codemirror/lang-css';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, basicSetup } from 'codemirror';
import { rewriteCssAssetUrls } from '../player/render.js';

/**
 * The theme.css editor.
 *
 * This is the deliberate half of the tool that *isn't* direct manipulation:
 * fonts, sizes and colours are typed as CSS. Edits apply to the canvas live and
 * are written to disk on a debounce, so tuning type feels immediate.
 */
export class CssEditor {
  onChange?: () => void;
  private view: EditorView;
  private styleTag: HTMLStyleElement;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    host: HTMLElement,
    private readonly persist: (css: string) => Promise<void> | void =
      (css) => window.api.saveTheme(css),
    /** Where the stylesheet's relative url()s point: the deck's files. */
    private readonly resolveSrc: (src: string) => string = (src) => window.api.assetUrl(src),
  ) {
    // The live stylesheet the canvas and preview both read.
    this.styleTag = document.createElement('style');
    this.styleTag.dataset.role = 'deck-theme';
    document.head.appendChild(this.styleTag);

    this.view = new EditorView({
      parent: host,
      extensions: [
        basicSetup,
        css(),
        oneDark,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const text = update.state.doc.toString();
          this.styleTag.textContent = rewriteCssAssetUrls(text, this.resolveSrc);
          this.onChange?.();
          this.scheduleSave(text);
        }),
      ],
    });
  }

  /** Load CSS from disk without triggering a save back. */
  setValue(text: string): void {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
    });
    this.styleTag.textContent = rewriteCssAssetUrls(text, this.resolveSrc);
    this.onChange?.();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  getValue(): string {
    return this.view.state.doc.toString();
  }

  /** Whether the user is typing here — collab holds remote CSS while true. */
  hasFocus(): boolean {
    return this.view.hasFocus;
  }

  /** Flush any pending write, for use before presenting or quitting. */
  async flush(): Promise<void> {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.persist(this.getValue());
  }

  private scheduleSave(text: string): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // Long enough not to write on every keystroke, short enough that the file
    // on disk is never meaningfully behind the screen.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.persist(text);
    }, 500);
  }
}
