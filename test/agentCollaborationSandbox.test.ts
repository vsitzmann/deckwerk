import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { electronBinary } from './support/browserSession.js';
import { hostedWorkspace, sectionIds, until, type HostedWorkspace } from './support/agentWorkspace.js';
import { canSandbox, chromiumSandboxesHere, installedUnitSandbox, PRODUCTION_SANDBOX } from './support/collabServerProcess.js';

/**
 * Agent collaboration on a server sandboxed the way production runs it.
 *
 * Every other suite runs the collaboration server in-process, where systemd's
 * sandbox does not exist — and that is where the hosted agent workflow broke
 * in October 2026: the server's headless browser (which compiles every saved
 * page, renders every PNG and checks every web page) needs Chromium's own
 * sandbox, which needs user namespaces plus chroot(2) and capset(2), and
 * deckwerk-collab.service forbade all three. Every agent save answered 500
 * with Chromium's abort message — which the bridge then dropped — while the
 * deck, the editor and every in-process test looked perfectly healthy.
 */

/** deckwerk-collab.service as it was before the fix: Chromium cannot start under it. */
const BROKEN_SANDBOX = [
  '-p', 'NoNewPrivileges=yes',
  '-p', 'SystemCallArchitectures=native',
  '-p', 'RestrictNamespaces=yes',
  '-p', 'SystemCallFilter=@system-service',
  '-p', 'SystemCallFilter=~@privileged @resources @mount @reboot @swap @debug @module @obsolete @raw-io @cpu-emulation',
  '-p', 'SystemCallErrorNumber=EPERM',
];

const sandboxable = Boolean(electronBinary) && canSandbox();
// The production policy leaves Chromium's sandbox to user namespaces; a host
// that forbids those to ordinary processes (GitHub's runners) cannot run it.
const hostSandboxes = sandboxable && chromiumSandboxesHere(electronBinary!);
const installed = installedUnitSandbox();

let hosted: HostedWorkspace | null = null;
afterEach(async () => {
  await hosted?.close();
  hosted = null;
});

async function addSlide(workspace: HostedWorkspace, title: string) {
  const page = (await workspace.run('new')).stdout.replace('<h1 class="role-title">Title</h1>', `<h1 class="role-title">${title}</h1>`);
  await workspace.write('add.html', page);
  return workspace.run('apply', '--html', 'edit/add.html');
}

describe.skipIf(!sandboxable)('agent collaboration under the production sandbox', { timeout: 240_000 }, () => {
  it.skipIf(!hostSandboxes)('saves, renders and checks pages on a server sandboxed as deckwerk-collab must be', async () => {
    hosted = await hostedWorkspace({ sandbox: PRODUCTION_SANDBOX });
    expect(hosted.serverProcess?.sandboxed).toBe(true);
    const applied = await addSlide(hosted, 'Made under the sandbox');
    expect(applied.json, `${applied.stdout}\n${applied.stderr}\n${hosted.logs()}`).toMatchObject({ status: 'applied', applied: true });
    await until(async () => sectionIds(await hosted!.read('add.html')).every(Boolean), 'the id stamp');
    const rendered = await hosted.run('render', '--slide', String((await hosted.deck()).slides.length), '--output', join(hosted.dir, 'shots'));
    expect(rendered.code, rendered.stderr).toBe(0);
    expect(existsSync(rendered.json.images[0].path)).toBe(true);
    // The bridge asked the server whether it can compile at all, and it can.
    expect(await hosted.bridgeLog()).not.toContain('cannot compile');
  });

  it('says why, at connect and on every save, when the server\'s browser cannot start', async () => {
    hosted = await hostedWorkspace({ sandbox: BROKEN_SANDBOX });
    // The person's Agent panel and the agent hear it as soon as the bridge connects…
    const warning = await until(async () => (await hosted!.bridgeLog()).split('\n')
      .find((line) => line.includes('this server cannot compile or render pages')), 'the connect-time warning');
    expect(warning).toMatch(/Chromium found no sandbox it is allowed to use/);
    expect(warning).toMatch(/RestrictNamespaces/);
    // …and every save says why it failed, instead of "sync failed (500)".
    const applied = await addSlide(hosted, 'Never lands');
    expect(applied.json?.status).toBe('error');
    expect(applied.json?.error).toMatch(/Chromium found no sandbox it is allowed to use/);
    const rendered = await hosted.run('render', '--slide', '1', '--output', join(hosted.dir, 'shots'));
    expect(rendered.code).not.toBe(0);
    expect(rendered.stderr).toMatch(/Chromium found no sandbox it is allowed to use/);
    expect((await hosted.deck()).slides.some((slide) => JSON.stringify(slide).includes('Never lands'))).toBe(false);
  });
});

/**
 * The unit this machine actually runs, read back from systemd. Only meaningful
 * on a machine that hosts DeckWerk, and red there until its deckwerk-collab
 * unit lets Chromium sandbox itself — see "Running under systemd" in
 * docs/collab.md for the drop-in.
 */
describe.skipIf(!sandboxable || !installed)('the deckwerk-collab unit installed on this machine', { timeout: 240_000 }, () => {
  it('lets the hosted server\'s headless browser compile an agent\'s page', async () => {
    hosted = await hostedWorkspace({ sandbox: installed! });
    const applied = await addSlide(hosted, 'Made under the installed unit');
    expect(applied.json, [
      'deckwerk-collab.service forbids what Chromium\'s sandbox needs, so agents cannot sync, render or',
      'check pages on this server. Install the drop-in from docs/collab.md ("Running under systemd").',
      applied.stdout, applied.stderr,
    ].join('\n')).toMatchObject({ status: 'applied', applied: true });
  });
});
