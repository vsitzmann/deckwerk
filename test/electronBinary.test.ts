import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findElectronBinary } from '../scripts/electron-binary.cjs';

describe('findElectronBinary', () => {
  it('returns the path when the binary exists', () => {
    const binary = join(mkdtempSync(join(tmpdir(), 'electron-')), 'electron');
    writeFileSync(binary, '');
    expect(findElectronBinary(() => binary)).toBe(binary);
  });

  it('reports a half-finished install, whose package throws on require', () => {
    expect(
      findElectronBinary(() => {
        throw new Error('Electron failed to install correctly, please delete node_modules/electron and try installing again');
      }),
    ).toBe('');
  });

  it('reports a path that points at nothing', () => {
    expect(findElectronBinary(() => join(tmpdir(), 'no-such-electron-binary'))).toBe('');
  });
});
