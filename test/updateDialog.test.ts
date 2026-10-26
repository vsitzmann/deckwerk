// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { releaseNotesElement } from '../src/renderer/editor/updateDialog.js';

/**
 * Release notes in the update dialog come from the release body on GitHub,
 * as HTML. They are rebuilt from structural tags with no attributes, so
 * nothing in a release body can run, load or navigate inside the editor.
 */
describe('release notes in the update dialog', () => {
  it('keeps the structure GitHub renders', () => {
    const box = releaseNotesElement(
      '<h2>What&#39;s Changed</h2><ul><li><strong>Strikethrough</strong> by <a href="https://github.com/x">@x</a> in #131</li></ul>'
      + '<p><strong>Full Changelog</strong>: <a href="https://github.com/vsitzmann/deckwerk/compare/v0.2.3...v0.3.0">v0.2.3...v0.3.0</a></p>',
    );
    expect(box.innerHTML).toBe(
      '<h3>What\'s Changed</h3><ul><li><strong>Strikethrough</strong> by @x in #131</li></ul>'
      + '<p><strong>Full Changelog</strong>: v0.2.3...v0.3.0</p>',
    );
  });

  it('drops scripts, styles, images, frames and every attribute', () => {
    const box = releaseNotesElement(
      '<p onclick="alert(1)" style="color:red" class="x">Safe</p>'
      + '<script>window.pwned = true</script><style>body{display:none}</style>'
      + '<img src="https://tracker.example/p.gif" onerror="alert(2)"><iframe src="https://evil.example"></iframe>'
      + '<svg><script>alert(3)</script></svg><a href="javascript:alert(4)">link text</a>',
    );
    expect(box.innerHTML).toBe('<p>Safe</p>link text');
    expect(box.querySelectorAll('[href], [src], [onclick], [style]')).toHaveLength(0);
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
  });

  it('keeps a plain-text body as text, line breaks and all', () => {
    const box = releaseNotesElement('Fixes:\n- one\n- <two>');
    expect(box.classList.contains('update-notes-text')).toBe(true);
    expect(box.textContent).toBe('Fixes:\n- one\n- <two>');
    expect(box.children).toHaveLength(0);
  });

  it('says so when there are no notes', () => {
    expect(releaseNotesElement('   ').textContent).toBe('No release notes.');
  });
});
