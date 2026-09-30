import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

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
 */
export async function copyFileStreamed(source: string, target: string): Promise<void> {
  const temporary = `${target}.${process.pid}.copy-tmp`;
  try {
    await pipeline(createReadStream(source), createWriteStream(temporary));
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
