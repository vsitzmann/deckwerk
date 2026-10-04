import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

/**
 * The collab server in a child process, sandboxed the way production runs it.
 *
 * In-process test servers cannot see the systemd sandbox at all, and it is
 * where two production failures lived that every in-process suite passed:
 * - Sept 2026: libuv's copyfile calls fchown(2), the syscall filter killed the
 *   server with SIGSYS mid-upload, and every browser saw "upload failed".
 * - Oct 2026: Chromium's sandbox needs user namespaces plus chroot(2) and
 *   capset(2); `RestrictNamespaces=yes` and the filter forbade them, so every
 *   headless-browser launch aborted and every agent save, render and page
 *   check on the hosted server answered 500.
 *
 * This is the policy deckwerk-collab.service must have — the unit plus the
 * drop-in in docs/collab.md, "Running under systemd". Whether the unit
 * installed on a machine actually matches is checked separately, against the
 * live unit (`installedUnitSandbox`).
 */
export const PRODUCTION_SANDBOX = [
  '-p', 'NoNewPrivileges=yes',
  '-p', 'SystemCallArchitectures=native',
  // The drop-in deckwerk-collab.service.d/syscall-eperm.conf: a filtered
  // syscall fails with EPERM rather than killing the process with SIGSYS.
  '-p', 'SystemCallErrorNumber=EPERM',
  // The namespaces and syscall filter, read from the drop-in itself so the
  // policy tested here and the one documented for servers cannot drift apart.
  ...chromiumSandboxDropIn(),
];

/** The [Service] settings of packaging/linux/deckwerk-collab-chromium-sandbox.conf, as systemd-run properties. */
function chromiumSandboxDropIn(): string[] {
  const file = resolve(import.meta.dirname, '..', '..', 'packaging', 'linux', 'deckwerk-collab-chromium-sandbox.conf');
  return readFileSync(file, 'utf8').split('\n')
    .map((line) => line.trim())
    // A transient unit starts with no filter, so the drop-in's reset is moot.
    .filter((line) => /^[A-Z]\w*=/.test(line) && line !== 'SystemCallFilter=')
    .flatMap((line) => ['-p', line]);
}

const UNIT = 'deckwerk-collab.service';
const SANDBOX_PROPERTIES = [
  'NoNewPrivileges', 'SystemCallArchitectures', 'RestrictNamespaces', 'SystemCallFilter', 'SystemCallErrorNumber',
] as const;

/**
 * The sandbox of the deckwerk-collab unit installed on this machine, as
 * `systemd-run` properties, or null where there is none.
 *
 * Read from what systemd resolved — the unit and every drop-in merged — so a
 * test running under it is a test of production, not of this file's idea of
 * production.
 */
export function installedUnitSandbox(): string[] | null {
  let shown: string;
  try {
    shown = execFileSync('systemctl', ['show', UNIT, '-p', 'LoadState', ...SANDBOX_PROPERTIES.flatMap((name) => ['-p', name])], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const values = new Map(shown.split('\n').filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)] as const;
  }));
  if (values.get('LoadState') !== 'loaded') return null;
  const properties: string[] = [];
  for (const name of SANDBOX_PROPERTIES) {
    const value = values.get(name);
    if (!value) continue;
    // The resolved errno is numeric (EPERM is 1); systemd-run takes either.
    properties.push('-p', `${name}=${value}`);
  }
  return properties;
}

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

export async function startCollabServerProcess(options: {
  rootDir: string;
  clientDir?: string;
  /** Let filesystem agents connect (the bridge and `./deck` routes). */
  localAgents?: boolean;
  /** systemd-run properties to run under instead of PRODUCTION_SANDBOX. */
  sandbox?: string[];
}): Promise<CollabServerProcess> {
  const command = [
    join(REPO, 'node_modules/.bin/vite-node'),
    '--config', 'vitest.config.ts', 'test/support/collabServerMain.mts',
  ];
  const config = JSON.stringify({ rootDir: options.rootDir, clientDir: options.clientDir, localAgents: options.localAgents });
  const sandboxed = canSandbox();
  // Named, because the transient unit outlives a killed systemd-run client:
  // liveness and shutdown both have to go through the unit itself.
  const unit = `deckwerk-test-${randomUUID().slice(0, 8)}.service`;
  const child: ChildProcess = sandboxed
    ? spawn('systemd-run', [
      '--user', '--pipe', '--wait', '--quiet', '--collect', `--unit=${unit}`,
      `--working-directory=${REPO}`, `--setenv=PATH=${process.env.PATH}`,
      `--setenv=DECKWERK_TEST_SERVER=${config}`,
      ...(options.sandbox ?? PRODUCTION_SANDBOX), ...command,
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
