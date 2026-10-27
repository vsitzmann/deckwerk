import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { withWritePath } from './writeFailure.js';

/**
 * Copy a file by streaming its bytes, never through `fs.copyFile`.
 *
 * libuv's copyfile calls fchown(2) on the destination. The headless server's
 * systemd unit filters `@privileged` syscalls, which includes fchown, and a
 * filtered syscall kills the process with SIGSYS rather than failing. Any
 * `copyFile` on the server path therefore took the whole collab server down
 * mid-request ("upload failed", video never playable). A plain read/write
 * stream only needs open/read/write.
 *
 * The bytes land in a sibling temp file that is renamed into place, so a
 * failed copy never leaves a truncated file under the final name (importAsset
 * skips copying when the hashed destination already exists).
 *
 * The temp file's name is short and fixed-length, not the target's plus a
 * suffix: a file whose own name is near the 255-byte limit (Keynote keeps
 * media named by a hex-encoded URL) failed with ENAMETOOLONG on the suffix
 * alone. A dotfile, so nothing that lists or serves `assets/` picks it up.
 */
export async function copyFileStreamed(source: string, target: string): Promise<void> {
  const temporary = join(dirname(target), `.${process.pid}-${randomBytes(6).toString('hex')}.copy-tmp`);
  try {
    await pipeline(createReadStream(source), createWriteStream(temporary));
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    // A failed write names no file (only open(2) is given one): say which
    // copy it was, or a full disk reads as "Unknown system error -122, write".
    throw withWritePath(error, target);
  }
}
