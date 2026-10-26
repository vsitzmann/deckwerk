import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkManifests, mergeMacManifests, parseManifest } from '../scripts/update-manifests.mjs';

/**
 * The release workflow's update manifests (scripts/update-manifests.mjs):
 * the two macOS runners' latest-mac.yml merged into one, and every manifest
 * checked against the files attached beside it.
 */

// electron-updater parses these with js-yaml; so does this test.
const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown };

const sha = (text: string): string => createHash('sha512').update(text).digest('base64');

// The exact shape electron-builder 25 writes.
const macManifest = (arch: 'x64' | 'arm64', version = '0.3.0'): string => `version: ${version}
files:
  - url: deckwerk-${version}-mac-${arch}.zip
    sha512: ${sha(`zip ${arch}`)}
    size: 101
  - url: deckwerk-${version}-mac-${arch}.dmg
    sha512: ${sha(`dmg ${arch}`)}
    size: 202
path: deckwerk-${version}-mac-${arch}.zip
sha512: ${sha(`zip ${arch}`)}
releaseDate: '2026-10-26T10:00:00.000Z'
`;

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('merging the macOS update manifests', () => {
  it('lists both architectures in one latest-mac.yml that js-yaml reads as electron-updater does', () => {
    const merged = mergeMacManifests(macManifest('x64'), macManifest('arm64'));
    const parsed = load(merged) as { version: string; files: { url: string; sha512: string; size: number }[]; path: string };
    expect(parsed.version).toBe('0.3.0');
    expect(parsed.files.map((file) => file.url)).toEqual([
      'deckwerk-0.3.0-mac-x64.zip',
      'deckwerk-0.3.0-mac-x64.dmg',
      'deckwerk-0.3.0-mac-arm64.zip',
      'deckwerk-0.3.0-mac-arm64.dmg',
    ]);
    expect(parsed.files[2]).toEqual({ url: 'deckwerk-0.3.0-mac-arm64.zip', sha512: sha('zip arm64'), size: 101 });
    // The legacy top-level path stays the Intel zip's.
    expect(parsed.path).toBe('deckwerk-0.3.0-mac-x64.zip');
  });

  it('gives each Mac its own zip by the rule MacUpdater applies (arm64 in the name)', () => {
    const { files } = load(mergeMacManifests(macManifest('x64'), macManifest('arm64'))) as { files: { url: string }[] };
    const zipFor = (arm: boolean): string | undefined => files
      .filter((file) => file.url.includes('arm64') === arm)
      .find((file) => file.url.endsWith('.zip'))?.url;
    expect(zipFor(true)).toBe('deckwerk-0.3.0-mac-arm64.zip');
    expect(zipFor(false)).toBe('deckwerk-0.3.0-mac-x64.zip');
  });

  it('refuses manifests from two different versions, or the same architecture twice', () => {
    expect(() => mergeMacManifests(macManifest('x64', '0.3.0'), macManifest('arm64', '0.3.1'))).toThrow(/disagree/);
    expect(() => mergeMacManifests(macManifest('x64'), macManifest('x64'))).toThrow(/Both macOS manifests list/);
  });

  it('refuses anything not shaped like an electron-builder manifest', () => {
    expect(() => parseManifest('version: 1\n  stray: line\n')).toThrow(/Unexpected line/);
  });
});

describe('checking a release folder', () => {
  async function release(files: Record<string, string>): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'deckwerk-manifests-'));
    for (const [name, contents] of Object.entries(files)) await writeFile(join(dir, name), contents);
    return dir;
  }

  const complete = (): Record<string, string> => ({
    'latest-mac.yml': mergeMacManifests(macManifest('x64'), macManifest('arm64')),
    'deckwerk-0.3.0-mac-x64.zip': 'zip x64',
    'deckwerk-0.3.0-mac-x64.zip.blockmap': '',
    'deckwerk-0.3.0-mac-x64.dmg': 'dmg x64',
    'deckwerk-0.3.0-mac-x64.dmg.blockmap': '',
    'deckwerk-0.3.0-mac-arm64.zip': 'zip arm64',
    'deckwerk-0.3.0-mac-arm64.zip.blockmap': '',
    'deckwerk-0.3.0-mac-arm64.dmg': 'dmg arm64',
    'deckwerk-0.3.0-mac-arm64.dmg.blockmap': '',
    'latest.yml': `version: 0.3.0
files:
  - url: deckwerk-0.3.0-win-x64-setup.exe
    sha512: ${sha('exe')}
    size: 3
path: deckwerk-0.3.0-win-x64-setup.exe
sha512: ${sha('exe')}
releaseDate: '2026-10-26T10:00:00.000Z'
`,
    'deckwerk-0.3.0-win-x64-setup.exe': 'exe',
    'deckwerk-0.3.0-win-x64-setup.exe.blockmap': '',
    // An AppImage carries its blockmap inside itself.
    'latest-linux.yml': `version: 0.3.0
files:
  - url: deckwerk-0.3.0-linux-x86_64.AppImage
    sha512: ${sha('appimage')}
    size: 8
    blockMapSize: 1234
path: deckwerk-0.3.0-linux-x86_64.AppImage
sha512: ${sha('appimage')}
releaseDate: '2026-10-26T10:00:00.000Z'
`,
    'deckwerk-0.3.0-linux-x86_64.AppImage': 'appimage',
  });

  it('passes a complete release', async () => {
    expect(await checkManifests(await release(complete()), { version: '0.3.0' })).toEqual({ problems: [], warnings: [] });
  });

  it('fails when a manifest is missing, names another version, or still sits per architecture', async () => {
    const files = complete();
    delete files['latest-linux.yml'];
    files['latest-mac-arm64.yml'] = macManifest('arm64');
    const { problems } = await checkManifests(await release(files), { version: '0.3.1' });
    expect(problems).toContain('latest-linux.yml is missing');
    expect(problems).toContain('latest.yml names version 0.3.0, not 0.3.1');
    expect(problems).toContain('latest-mac-arm64.yml was not merged into latest-mac.yml');
  });

  it('fails when a listed file is absent or is not the file the manifest hashed', async () => {
    const files = complete();
    delete files['deckwerk-0.3.0-mac-arm64.zip'];
    files['deckwerk-0.3.0-win-x64-setup.exe'] = 'a different build';
    const { problems } = await checkManifests(await release(files));
    expect(problems).toContain('latest-mac.yml lists deckwerk-0.3.0-mac-arm64.zip, which is not in the release');
    expect(problems).toContain('deckwerk-0.3.0-win-x64-setup.exe does not match the sha512 in latest.yml');
  });

  it('only warns about a missing blockmap: the update still works, in full', async () => {
    const files = complete();
    delete files['deckwerk-0.3.0-win-x64-setup.exe.blockmap'];
    const result = await checkManifests(await release(files));
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      'deckwerk-0.3.0-win-x64-setup.exe has no deckwerk-0.3.0-win-x64-setup.exe.blockmap beside it, so updates to it download in full',
    ]);
  });
});
