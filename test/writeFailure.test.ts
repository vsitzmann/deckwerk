import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { electronFailure } from '../src/cli/electronDisplay.js';
import { diskFullKind, failureMessage } from '../src/main/writeFailure.js';

/**
 * A full disk or used-up quota, from whichever process hit it, reaches the
 * person as "<what> writing <file> — <what to free>".
 *
 * The error shapes are the real ones: Node calls EDQUOT "Unknown system error
 * -122" and a failed write(2) carries no path; an Electron helper's failure
 * arrives as stderr text (scripts/child-failure.cjs prints the fields that
 * would otherwise be lost).
 */

const { failureReport, writeFileNamed } = createRequire(import.meta.url)('../scripts/child-failure.cjs') as {
  failureReport: (error: unknown) => string;
  writeFileNamed: (file: string, data: Buffer) => void;
};

const edquot = (path?: string) => Object.assign(
  new Error('Unknown system error -122: Unknown system error -122, write'),
  { errno: -122, code: 'Unknown system error -122', syscall: 'write' },
  path ? { path } : {},
);

describe.runIf(process.platform === 'linux')('full-disk errors in words', () => {
  it('reads EDQUOT by number, with the file and the temp folder to free', () => {
    const file = join(tmpdir(), 'slide-agent-bundle-abc', 'assets', 'x.mp4');
    expect(diskFullKind(edquot())).toBe('quota');
    expect(failureMessage(edquot(file))).toBe(
      `Disk quota exceeded writing ${file} — free space in ${tmpdir()} `
      + '(slide-agent-* folders there are scratch from earlier runs) or set TMPDIR to a folder on a disk with room. '
      + 'The quota is per user, so df can still show free space.',
    );
  });

  it('carries an Electron helper\'s EDQUOT, code and file, across the process boundary', () => {
    const png = '/srv/talks/shots/slide-3.png';
    const stderr = `Fontconfig warning: noise\n${failureReport(edquot(png))}`;
    const error = electronFailure(stderr, 'Slide capture failed with exit code 1');
    expect(failureMessage(error)).toMatch(
      /^Disk quota exceeded writing \/srv\/talks\/shots\/slide-3\.png — free space on the disk holding \/srv\/talks\/shots\./,
    );
    // Anything else keeps its old text: the stack, with the marker line taken out.
    const other = electronFailure(failureReport(Object.assign(new Error('EACCES: permission denied, open'), {
      code: 'EACCES', errno: -13, syscall: 'open', path: '/srv/x.png',
    })), 'fallback');
    expect(failureMessage(other)).toMatch(/^Error: EACCES: permission denied, open\n/);
    expect(failureMessage(other)).not.toContain('slide-agent-failure:');
  });

  it('still recognises a helper that printed only the bare error text', () => {
    const error = electronFailure('Error: Unknown system error -122: Unknown system error -122, write\n    at writeSync', 'x');
    expect(failureMessage(error)).toMatch(/^Disk quota exceeded — free space in /);
  });

  it.runIf(existsSync('/dev/full'))('names the file a helper\'s synchronous write ran out of space on', () => {
    // /dev/full fails every write with ENOSPC; Node's error names no path.
    let caught: unknown;
    try {
      writeFileNamed('/dev/full', Buffer.alloc(16));
    } catch (error) {
      caught = error;
    }
    expect(failureMessage(electronFailure(failureReport(caught), 'x')))
      .toMatch(/^No space left on device writing \/dev\/full — free space on the disk holding \/dev\./);
  });

  it('leaves every other error alone', () => {
    expect(diskFullKind(new Error('ENOENT: no such file or directory'))).toBeNull();
    expect(diskFullKind(Object.assign(new Error('x'), { errno: -122 }))).toBeNull(); // not a system call's
    expect(failureMessage(new Error('Nothing to render'))).toBe('Nothing to render');
  });
});
