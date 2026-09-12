import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

describe('shared application chrome', () => {
  it('is loaded by every interactive renderer', () => {
    for (const entry of [
      'src/renderer/editor/main.ts',
      'src/renderer/collab/main.ts',
      'src/renderer/presenter/main.ts',
      'src/renderer/raster/main.ts',
      'src/renderer/trim/main.ts',
    ]) {
      expect(source(entry)).toContain("import '../appChrome.css';");
    }
  });

  it('keeps auxiliary windows from redefining the shared palette or buttons', () => {
    for (const stylesheet of [
      'src/renderer/presenter/presenter.css',
      'src/renderer/raster/raster.css',
      'src/renderer/trim/trim.css',
    ]) {
      const css = source(stylesheet);
      expect(css).not.toMatch(/:root\s*\{/);
      expect(css).not.toMatch(/(?:^|\n)button\s*\{/);
    }
  });

  it('uses the same semantic action variants in Speaker View', () => {
    // The markup moved into the component the desktop window and the browser
    // collaboration client now share, so both get the same button variants.
    const view = source('src/renderer/presenter/speakerView.ts');
    expect(view).toContain('class="speaker-next-button primary"');
    expect(view).toContain('class="speaker-end danger"');
  });

  it('reserves the macOS traffic-light gutter only in the inset desktop window', () => {
    const css = source('src/renderer/editor/editor.css');
    const shell = source('src/renderer/editor/main.ts');
    expect(css).toContain('body.mac-titlebar #toolbar { padding-left: 84px; }');
    expect(shell).toContain("document.body.classList.add('mac-titlebar')");
    expect(css.match(/padding-left:\s*84px/g)).toHaveLength(1);
  });
});
