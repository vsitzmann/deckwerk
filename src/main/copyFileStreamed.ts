import { createReadStream, createWriteStream } from 'node:fs';
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
 */
export async function copyFileStreamed(source: string, target: string): Promise<void> {
  await pipeline(createReadStream(source), createWriteStream(target));
}
