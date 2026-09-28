import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A web element is a sandboxed frame around a deck-relative page, served
 * through the deck: protocol. Every renderer window that can draw a slide has
 * to let such a frame load, or the element is a blank box there and nowhere
 * else — which is exactly how it shipped the first time (ERR_BLOCKED_BY_CSP
 * in the editor and presenter while the export worked).
 */
describe('renderer window Content Security Policies', () => {
  const root = join(__dirname, '..', 'src', 'renderer');
  // Every window that draws slides. (The trim window shows one video, not a slide.)
  const windows = ['editor', 'present', 'presenter', 'print', 'raster']
    .filter((name) => existsSync(join(root, name, 'index.html')));
  expect(windows.length).toBeGreaterThan(0);

  it.each(windows)('%s lets deck: frames load', (name) => {
    const html = readFileSync(join(root, name, 'index.html'), 'utf8');
    const policy = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/i.exec(html)?.[1];
    if (!policy) return; // no CSP at all: frames are not blocked
    const frameSrc = /frame-src([^;]*)/i.exec(policy)?.[1];
    // Without a frame-src directive, default-src governs frames.
    const governing = frameSrc ?? /default-src([^;]*)/i.exec(policy)?.[1] ?? '';
    expect(governing, `${name}: ${policy}`).toMatch(/\bdeck:/);
  });

  // The bundler inlines fonts under its asset-size limit as data: URIs — among
  // KaTeX's, KaTeX_Size3, which sets large delimiters. Without data: fonts the
  // window refuses it and tall \left( … \right) fall back to another face.
  it.each(windows)('%s lets inlined data: fonts load', (name) => {
    const html = readFileSync(join(root, name, 'index.html'), 'utf8');
    const policy = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/i.exec(html)?.[1];
    if (!policy) return;
    const governing = /font-src([^;]*)/i.exec(policy)?.[1] ?? /default-src([^;]*)/i.exec(policy)?.[1] ?? '';
    expect(governing, `${name}: ${policy}`).toMatch(/(^|\s)data:(\s|$)/);
  });

  // A deck carries a licensed webfont as assets/fonts/*.woff2 declared by
  // @font-face in its theme.css (docs/agent-themes.md), served through deck:.
  // deck: does not bypass CSP, so without it the theme's own face is refused.
  it.each(windows)('%s lets a deck\'s own fonts load', (name) => {
    const html = readFileSync(join(root, name, 'index.html'), 'utf8');
    const policy = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/i.exec(html)?.[1];
    if (!policy) return;
    const governing = /font-src([^;]*)/i.exec(policy)?.[1] ?? /default-src([^;]*)/i.exec(policy)?.[1] ?? '';
    expect(governing, `${name}: ${policy}`).toMatch(/(^|\s)deck:(\s|$)/);
  });
});
