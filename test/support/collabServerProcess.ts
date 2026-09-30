import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

/**
 * The collab server in a child process, sandboxed the way production runs it.
 *
 * Mirrors the syscall policy of /etc/systemd/system/deckwerk-collab.service.
 * In-process test servers cannot see that policy at all, and it is where the
 * Sept 2026 upload failures lived: libuv's copyfile calls fchown(2), the
 * filter killed the server with SIGSYS mid-upload, and every browser saw
 * "upload failed". Keep this list in step with the unit.
 */
export const PRODUCTION_SANDBOX = [
  '-p', 'NoNewPrivileges=yes',
  '-p', 'SystemCallArchitectures=native',
  '-p', 'SystemCallFilter=@system-service',
  '-p', 'SystemCallFilter=~@privileged @resources @mount @reboot @swap @debug @module @obsolete @raw-io @cpu-emulation',
  // The drop-in deckwerk-collab.service.d/syscall-eperm.conf: a filtered
  // syscall fails with EPERM rather than killing the process with SIGSYS.
  '-p', 'SystemCallErrorNumber=EPERM',
];

const REPO = resolve(import.meta.dirname, '..', '..');

export interface CollabServerProcess {
  port: number;
  /** False where no user systemd session exists (CI): the server then runs unsandboxed. */
  sandboxed: boolean;
  /** Everything the server wrote to stderr so far, for failure messages. */
  stderr: () => string;
  /** Whether the server process is still running. */
  alive: () => boolean;
  close: () => Promise<void>;
}

let sandboxAvailable: boolean | undefined;

/** Whether this machine can run a transient unit under the production sandbox. */
export function canSandbox(): boolean {
  if (sandboxAvailable === undefined) {
    try {
      execFileSync('systemd-run', ['--user', '--wait', '--quiet', '--collect', ...PRODUCTION_SANDBOX, 'true'], { stdio: 'ignore' });
      sandboxAvailable = true;
    } catch {
      sandboxAvailable = false;
    }
  }
  return sandboxAvailable;
}

export async function startCollabServerProcess(options: { rootDir: string; clientDir?: string }): Promise<CollabServerProcess> {
  const command = [
    join(REPO, 'node_modules/.bin/vite-node'),
    '--config', 'vitest.config.ts', 'test/support/collabServerMain.mts',
  ];
  const config = JSON.stringify(options);
  const sandboxed = canSandbox();
  // Named, because the transient unit outlives a killed systemd-run client:
  // liveness and shutdown both have to go through the unit itself.
  const unit = `deckwerk-test-${randomUUID().slice(0, 8)}.service`;
  const child: ChildProcess = sandboxed
    ? spawn('systemd-run', [
      '--user', '--pipe', '--wait', '--quiet', '--collect', `--unit=${unit}`,
      `--working-directory=${REPO}`, `--setenv=PATH=${process.env.PATH}`,
      `--setenv=DECKWERK_TEST_SERVER=${config}`,
      ...PRODUCTION_SANDBOX, ...command,
    ])
    : spawn(command[0], command.slice(1), { cwd: REPO, env: { ...process.env, DECKWERK_TEST_SERVER: config } });

  let stderr = '';
  let exited = false;
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  child.once('exit', () => { exited = true; });
  const unitActive = (): boolean => {
    try {
      execFileSync('systemctl', ['--user', 'is-active', '--quiet', unit], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const port = await new Promise<number>((resolvePort, reject) => {
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      const match = /"status":"serving","port":(\d+)/.exec(stdout);
      if (match) resolvePort(Number(match[1]));
    });
    child.once('exit', (code, signal) => reject(new Error(`collab server exited (${code ?? signal}) before serving:\n${stderr}`)));
  });
  return {
    port,
    sandboxed,
    stderr: () => stderr,
    alive: () => !exited && (!sandboxed || unitActive()),
    close: async () => {
      if (sandboxed) execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore' });
      if (exited) return;
      const done = new Promise((resolveExit) => child.once('exit', resolveExit));
      child.kill();
      await done;
    },
  };
}
