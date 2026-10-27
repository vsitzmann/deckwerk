import { constants, tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { dirname, relative, isAbsolute } from 'node:path';

/**
 * A full disk or a used-up quota, said in words someone can act on.
 *
 * On a server whose /tmp is a tmpfs mounted with `usrquota`, a render whose
 * scratch export ran into the user's quota died with
 * "Unknown system error -122: Unknown system error -122, write": libuv has no
 * name for EDQUOT, the stream write that failed carries no path, and `df`
 * still showed gigabytes free. Nobody could tell what had filled up, or where.
 */

export type DiskFull = 'quota' | 'space';

const EDQUOT = constants.errno.EDQUOT ?? null;
const ENOSPC = constants.errno.ENOSPC ?? null;

/** Whether `error` is a write that failed for want of room, and which kind. */
export function diskFullKind(error: unknown): DiskFull | null {
  if (!error || typeof error !== 'object') return null;
  const { code, errno, syscall, message } = error as {
    code?: unknown; errno?: unknown; syscall?: unknown; message?: unknown;
  };
  if (code === 'EDQUOT') return 'quota';
  if (code === 'ENOSPC') return 'space';
  // By number only on a system call's own error: Node names EDQUOT
  // "Unknown system error -122", and a reported errno is negative.
  if (typeof syscall === 'string' && typeof errno === 'number') {
    if (EDQUOT !== null && Math.abs(errno) === EDQUOT) return 'quota';
    if (ENOSPC !== null && Math.abs(errno) === ENOSPC) return 'space';
  }
  // A helper process's failure arrives as text.
  if (typeof message === 'string') {
    if (/\bEDQUOT\b|disk quota exceeded/i.test(message)
      || (EDQUOT !== null && new RegExp(`Unknown system error -${EDQUOT}\\b`).test(message))) return 'quota';
    if (/\bENOSPC\b|no space left on device/i.test(message)) return 'space';
  }
  return null;
}

/**
 * Name the file a failed write was writing, when the error does not.
 *
 * A write(2) failure from a stream or a file handle carries only the syscall:
 * the path was given to open(2), which succeeded.
 */
export function withWritePath<T>(error: T, path: string): T {
  if (error && typeof error === 'object' && typeof (error as { path?: unknown }).path !== 'string') {
    (error as { path?: string }).path = path;
  }
  return error;
}

/** `fs.promises.writeFile` whose failure names the file. */
export async function writeFileNamed(
  path: string,
  data: string | NodeJS.ArrayBufferView,
  encoding?: BufferEncoding,
): Promise<void> {
  try {
    await writeFile(path, data, encoding);
  } catch (error) {
    throw withWritePath(error, path);
  }
}

/**
 * The readable form of a full-disk error, or null for any other.
 *
 * "Disk quota exceeded writing /tmp/slide-agent-bundle-…/assets/x.mp4 — free
 * space in /tmp … or set TMPDIR …". The scratch exports renders and previews
 * make live in the OS temp folder, which is the usual culprit, so a file there
 * points at that folder and at TMPDIR; any other file at its own folder.
 */
export function diskFullMessage(error: unknown): string | null {
  const kind = diskFullKind(error);
  if (!kind) return null;
  const path = typeof (error as { path?: unknown }).path === 'string' ? (error as { path: string }).path : null;
  const temp = tmpdir();
  const what = kind === 'quota' ? 'Disk quota exceeded' : 'No space left on device';
  const where = path ? ` writing ${path}` : '';
  const fix = path && !within(temp, path)
    ? `free space on the disk holding ${dirname(path)}`
    : `free space in ${temp} (slide-agent-* folders there are scratch from earlier runs) `
      + 'or set TMPDIR to a folder on a disk with room';
  const quota = kind === 'quota'
    ? ' The quota is per user, so df can still show free space.'
    : '';
  return `${what}${where} — ${fix}.${quota}`;
}

/** What to tell a person about `error`: the full-disk wording when it is one, else its message. */
export function failureMessage(error: unknown): string {
  return diskFullMessage(error) ?? (error instanceof Error ? error.message : String(error));
}

function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
