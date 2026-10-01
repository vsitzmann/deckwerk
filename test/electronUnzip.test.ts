import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// Electron's postinstall unpacks its binary with extract-zip. Under yauzl 2,
// on Node 26, extract-zip wrote the first entry whose compressed size passed
// ~64 KB and then stopped without resolving or rejecting, so `npm ci` left
// node_modules/electron/dist holding one locale file and no binary.
const extract = createRequire(createRequire(import.meta.url).resolve('electron/install.js'))('extract-zip') as (
  zip: string,
  options: { dir: string },
) => Promise<void>;

/** A minimal zip of deflated entries, written with the same layout as Electron's. */
function writeZip(path: string, files: Record<string, Buffer>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = Buffer.from(name);
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...locals, directory, end]));
}

describe("Electron's installer unzip", () => {
  it('unpacks every entry of an archive whose entries compress past 64 KB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'electron-unzip-'));
    const zip = join(root, 'electron.zip');
    const names = ['locales/hr.pak', 'v8_context_snapshot.bin', 'electron'];
    // Random bytes do not compress, so each entry stays ~200 KB on disk.
    writeZip(zip, Object.fromEntries(names.map((name) => [name, randomBytes(200_000)])));

    const out = join(root, 'dist');
    const settled = await Promise.race([
      extract(zip, { dir: out }).then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('stalled'), 5_000)),
    ]);

    expect(settled).toBe('resolved');
    expect(names.filter((name) => !existsSync(join(out, name)))).toEqual([]);
  });
});
