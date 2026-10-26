import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The release's Homebrew job runs this script for the first time on a real
 * release, after everything else has published — v0.3.0's tap update failed
 * there on a syntax error. Render a cask here instead.
 */
describe('render-homebrew-cask', () => {
  it('renders a cask with each architecture\'s checksum and auto_updates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckwerk-cask-'));
    const intel = join(dir, 'x64.dmg');
    const arm = join(dir, 'arm64.dmg');
    writeFileSync(intel, 'intel dmg');
    writeFileSync(arm, 'arm dmg');
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');

    const cask = execFileSync(process.execPath, ['scripts/render-homebrew-cask.mjs', '1.2.3', intel, arm], { encoding: 'utf8' });

    expect(cask).toMatch(/^cask "deckwerk" do\n/);
    expect(cask).toContain('version "1.2.3"');
    expect(cask).toContain(`sha256 arm:   "${sha('arm dmg')}",`);
    expect(cask).toContain(`intel: "${sha('intel dmg')}"`);
    expect(cask).toContain('auto_updates true');
    expect(cask.trimEnd().endsWith('end')).toBe(true);
  });
});
