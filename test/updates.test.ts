import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isNewerVersion,
  releaseNotesText,
  releasePageUrl,
  restartBlocker,
  updateMode,
} from '../src/shared/updates.js';

/**
 * The decisions behind "Check for Updates…" (src/shared/updates.ts): which
 * way an install updates, what counts as newer, and when a restart must wait.
 */

describe('how an install updates', () => {
  it('does nothing in a development run or an unpackaged checkout', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(updateMode({ platform, isPackaged: false })).toEqual({ kind: 'none', reason: 'development' });
      // …even one that looks like an AppImage or a Flatpak from its environment.
      expect(updateMode({ platform, isPackaged: false, appImage: '/a.AppImage', flatpakId: 'x' }))
        .toEqual({ kind: 'none', reason: 'development' });
    }
  });

  it('updates itself on macOS (Squirrel.Mac) and Windows (NSIS)', () => {
    expect(updateMode({ platform: 'darwin', isPackaged: true })).toEqual({ kind: 'auto', channel: 'mac' });
    expect(updateMode({ platform: 'win32', isPackaged: true })).toEqual({ kind: 'auto', channel: 'nsis' });
  });

  it('on Linux, updates an AppImage, and sends a .deb or a Flatpak to the release page', () => {
    expect(updateMode({ platform: 'linux', isPackaged: true, appImage: '/home/me/DeckWerk.AppImage' }))
      .toEqual({ kind: 'auto', channel: 'appimage' });
    expect(updateMode({ platform: 'linux', isPackaged: true, flatpakId: 'org.deckwerk.DeckWerk' }))
      .toEqual({ kind: 'release-page' });
    expect(updateMode({ platform: 'linux', isPackaged: true })).toEqual({ kind: 'release-page' });
    expect(updateMode({ platform: 'linux', isPackaged: true, appImage: '' })).toEqual({ kind: 'release-page' });
  });

  it('lets Flatpak win over an AppImage variable leaking in from the host', () => {
    expect(updateMode({ platform: 'linux', isPackaged: true, appImage: '/x.AppImage', flatpakId: 'org.deckwerk.DeckWerk' }))
      .toEqual({ kind: 'release-page' });
  });

  it('treats a feed override as a packaged install, so an unpackaged run can be tested against it', () => {
    expect(updateMode({ platform: 'darwin', isPackaged: false, feedOverride: 'http://127.0.0.1:1/' }))
      .toEqual({ kind: 'auto', channel: 'mac' });
    expect(updateMode({ platform: 'linux', isPackaged: false, feedOverride: 'http://127.0.0.1:1/', appImage: '/x' }))
      .toEqual({ kind: 'auto', channel: 'appimage' });
  });
});

describe('what counts as a newer release', () => {
  it('orders by major, minor, patch numerically', () => {
    expect(isNewerVersion('0.3.1', '0.3.0')).toBe(true);
    expect(isNewerVersion('0.4.0', '0.3.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerVersion('0.3.0', '0.3.0')).toBe(false);
    expect(isNewerVersion('0.2.9', '0.3.0')).toBe(false);
  });

  it('reads a leading v, as tags are written', () => {
    expect(isNewerVersion('v0.3.1', '0.3.0')).toBe(true);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('ranks a release above its own prereleases, and prereleases among themselves', () => {
    expect(isNewerVersion('1.0.0', '1.0.0-beta.2')).toBe(true);
    expect(isNewerVersion('1.0.0-beta.2', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0-beta.10', '1.0.0-beta.2')).toBe(true);
    expect(isNewerVersion('1.0.0-beta', '1.0.0-alpha')).toBe(true);
    expect(isNewerVersion('1.0.0-alpha.1', '1.0.0-alpha')).toBe(true);
    expect(isNewerVersion('1.0.0-alpha', '1.0.0-1')).toBe(true);
  });

  it('ignores build metadata', () => {
    expect(compareVersions('1.0.0+abc', '1.0.0+def')).toBe(0);
  });

  it('never calls something that is not a version newer', () => {
    expect(isNewerVersion('latest', '0.3.0')).toBe(false);
    expect(isNewerVersion('', '0.3.0')).toBe(false);
    expect(isNewerVersion('1.0', '0.3.0')).toBe(false);
    expect(compareVersions('0.3.0', 'garbage')).toBeNull();
  });
});

describe('restarting into an update', () => {
  it('goes ahead only when every window says it is saved', () => {
    expect(restartBlocker([{ token: 'a', clean: true }, { token: 'b', clean: true }], false)).toBeNull();
    expect(restartBlocker([], false)).toBeNull();
  });

  it('names the decks that could not be saved', () => {
    expect(restartBlocker([
      { token: 'a', clean: true },
      { token: 'b', clean: false, deckName: 'millivid' },
    ], false)).toMatch(/millivid could not be saved/);
  });

  it('waits for a window that never answered', () => {
    expect(restartBlocker([{ token: 'a', clean: true }, null], false)).toMatch(/could not confirm/);
  });

  it('waits for a presentation to end', () => {
    expect(restartBlocker([{ token: 'a', clean: true }], true)).toMatch(/presentation/);
  });
});

describe('release notes and pages', () => {
  it('takes notes as GitHub gives them, or as a list per version', () => {
    expect(releaseNotesText('<p>Hi</p>')).toBe('<p>Hi</p>');
    expect(releaseNotesText([{ version: '0.3.1', note: 'One' }, { version: '0.3.0', note: null }, { version: '0.2.0', note: 'Two' }]))
      .toBe('One\nTwo');
    expect(releaseNotesText(null)).toBe('');
    expect(releaseNotesText(undefined)).toBe('');
  });

  it('links a version to its tag, and no version to the latest release', () => {
    expect(releasePageUrl('0.3.1')).toBe('https://github.com/vsitzmann/deckwerk/releases/tag/v0.3.1');
    expect(releasePageUrl(null)).toBe('https://github.com/vsitzmann/deckwerk/releases/latest');
  });
});
