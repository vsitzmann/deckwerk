import { type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import {
  COLLAB_PROTOCOL_VERSION,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type ServerWelcomeMessage,
} from '../src/shared/collab.js';
import { emptyDeck } from '../src/shared/deck.js';
// The production-input harness: real pointer and key events, not `.click()`.
import { Cdp } from './support/browserSession.js';
import { isEditorTarget, launchDesktopApp, materializeDesktopApp } from './support/desktopApp.js';

/**
 * Regression for the embedded-Agent presentation hand-off.
 *
 * The collaboration server owns deck.json while an Agent session is active,
 * but Present is opened by Electron's main process. Before the renderer began
 * mirroring its authoritative collaboration state back to main memory, the
 * editor showed Agent-created slides while the audience window received the
 * stale pre-Agent deck (often an empty white slide).
 *
 * This deliberately uses no model, login, or external network. FakeAgent is a
 * deterministic peer speaking the real localhost collaboration protocol, and
 * the assertion is made in the real audience renderer after clicking the real
 * Present button.
 */

const electron = (() => {
  try {
    const path = createRequire(import.meta.url)('electron') as unknown;
    return typeof path === 'string' && existsSync(path) ? path : '';
  } catch {
    return '';
  }
})();

const runnable = Boolean(electron);

class FakeAgent {
  private queue: ServerMessage[] = [];
  private waiters: Array<(message: ServerMessage) => void> = [];

  private constructor(private socket: WebSocket) {
    socket.on('message', (raw) => {
      const message = ServerMessageSchema.parse(JSON.parse(String(raw)));
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  static async connect(wsUrl: string): Promise<{ agent: FakeAgent; welcome: ServerWelcomeMessage }> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const agent = new FakeAgent(socket);
    agent.send({ kind: 'hello', version: COLLAB_PROTOCOL_VERSION, name: 'Fake Agent' });
    // Opening the room reads the deck and its history off disk; on a loaded
    // machine (the rest of the suite, a second Electron app) that can take
    // longer than the per-message default.
    const welcome = await agent.nextOfKind('welcome', 20_000);
    return { agent, welcome };
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  async nextOfKind<K extends ServerMessage['kind']>(kind: K, timeoutMs = 5_000):
    Promise<Extract<ServerMessage, { kind: K }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for Agent ${kind} message`);
      const message = await this.next(remaining);
      if (message.kind === kind) return message as Extract<ServerMessage, { kind: K }>;
    }
  }

  /** Wait until the native editor has completed its own room handshake. */
  async waitForPeer(
    welcome: ServerWelcomeMessage,
    name: string,
    timeoutMs = 20_000,
  ): Promise<void> {
    const isNativeEditor = (peer: ServerWelcomeMessage['peers'][number]) =>
      peer.name === name && peer.agent !== true;
    if (welcome.peers.some(isNativeEditor)) return;

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for the native editor peer');
      const joined = await this.nextOfKind('presence', remaining);
      if (isNativeEditor(joined.state)) return;
    }
  }

  close(): void {
    this.socket.close();
  }

  private next(timeoutMs: number): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for Agent message')), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}

interface DevToolsTarget {
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

let workDir = '';
let appProcess: ChildProcess | null = null;
let editor: Cdp | null = null;
let audience: Cdp | null = null;
let fakeAgent: FakeAgent | null = null;

afterEach(async () => {
  fakeAgent?.close();
  fakeAgent = null;
  audience?.close();
  audience = null;
  editor?.close();
  editor = null;
  if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
    appProcess.kill('SIGTERM');
    await waitForProcessExit(appProcess, 5_000).catch(() => appProcess?.kill('SIGKILL'));
  }
  appProcess = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!runnable)('embedded Agent presentation synchronization', () => {
  it('presents a fake Agent edit in the real audience window before the session ends', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'agent-present-sync-'));
    const deckDir = join(workDir, 'deck');
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Agent presentation regression'));
    await writeFile(join(deckDir, 'theme.css'), [
      '.slide { background: #fff; color: #111; }',
      '.element-text { font: 700 72px/1.1 sans-serif; }',
      '',
    ].join('\n'), 'utf8');

    const appDir = join(workDir, 'app');
    await materializeDesktopApp(appDir, 'deckwerk-agent-presentation-sync');
    const app = await launchDesktopApp(appDir, [deckDir], { profileDir });
    appProcess = app.process;
    const debugPort = app.debugPort;
    const appLog = app.log;

    const editorTarget = await findTarget(
      debugPort,
      isEditorTarget,
      appLog,
    );
    editor = await Cdp.connect(editorTarget.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(
      `window.api.getDeck().then((session) => session?.deck?.slides?.[0]?.id === 'slide-1')`,
    ), 'editor did not open the regression deck');

    const connection = await editor.evaluate<{ wsUrl: string; name: string }>(`window.api.startAgentSession({
      agent: true,
      activeSlideId: 'slide-1',
      selectedSlideIds: ['slide-1'],
      selectedElementIds: []
    })`);
    const connected = await FakeAgent.connect(connection.wsUrl);
    fakeAgent = connected.agent;

    // startAgentSession returns once the server is listening, then the
    // renderer joins that server as an ordinary peer through an IPC state
    // notification. A fast fake Agent can receive its own welcome first; a
    // transaction sent in that gap is a broadcast the editor cannot replay.
    // Observe the host in the welcome snapshot or its later presence frame
    // before sending the regression edit.
    await fakeAgent.waitForPeer(connected.welcome, connection.name);

    const marker = 'FAKE AGENT PRESENTS THIS';
    const txnId = 'fake-agent-presentation-edit';
    fakeAgent.send({
      kind: 'txn',
      txnId,
      baseSeq: connected.welcome.seq,
      label: 'Fake Agent: add presentation marker',
      ops: [{
        op: 'insertElements',
        slideId: 'slide-1',
        elements: [{
          id: 'fake-agent-marker',
          type: 'text',
          x: 180,
          y: 400,
          w: 1560,
          h: 200,
          rot: 0,
          z: 0,
          opacity: 1,
          class: [],
          style: {},
          html: marker,
          align: 'center',
          valign: 'middle',
        }],
      }],
    });
    const echoed = await fakeAgent.nextOfKind('txn');
    expect(echoed.txnId).toBe(txnId);

    // Wait for the native editor peer to apply the collaboration transaction;
    // the subsequent toolbar click exercises its normal save/present sequence.
    await eventually(async () => editor!.evaluate<boolean>(
      `document.querySelector('[data-element-id="fake-agent-marker"]')?.textContent?.includes(${JSON.stringify(marker)}) === true`,
    // The native peer applies it over its WebSocket bridge; on a loaded machine
    // the round trip can outlast the default wait.
    ), 'native editor did not receive the fake Agent transaction', Boolean, 30_000);
    await eventually(async () => editor!.evaluate<boolean>(`
      window.api.getDeck().then((session) => session?.deck?.slides?.[0]?.elements
        ?.some((element) => element.id === 'fake-agent-marker') === true)
    `), 'main process did not receive the authoritative Agent-session snapshot');

    await editor!.clickByText('button', 'Present', 'Present');

    const audienceTarget = await findTarget(
      debugPort,
      (target) => target.title === 'Present' || target.url.includes('/present/index.html'),
      appLog,
    );
    audience = await Cdp.connect(audienceTarget.webSocketDebuggerUrl!);
    const rendered = await eventually(async () => audience!.evaluate<{
      markerText: string | null;
      elementCount: number;
      slideId: string | null;
      width: number;
      height: number;
    }>(`(() => {
      const element = document.querySelector('[data-element-id="fake-agent-marker"]');
      const rect = element?.getBoundingClientRect();
      return {
        markerText: element?.textContent ?? null,
        elementCount: document.querySelectorAll('[data-element-id]').length,
        slideId: document.querySelector('.slide')?.getAttribute('data-slide-id') ?? null,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0
      };
    })()`), 'audience window did not render the fake Agent edit', (value) => (
      value.markerText?.includes(marker) === true && value.width > 0 && value.height > 0
    ));

    expect(rendered).toMatchObject({
      markerText: marker,
      elementCount: 1,
      slideId: 'slide-1',
    });

    // The contract ends once the live main-process snapshot reaches a real
    // audience renderer. Session shutdown has its own unit/integration paths;
    // awaiting it here coupled an otherwise deterministic presentation test
    // to every Chromium worker and filesystem flush in the full suite.
    fakeAgent.close();
    fakeAgent = null;
    await audience.evaluate(`window.close()`);
    audience.close();
    audience = null;
  }, 40_000);
});

describe.skipIf(runnable)('embedded Agent presentation synchronization (skipped)', () => {
  it('needs the built Electron app and collaboration client', () => {
    expect(runnable).toBe(false);
  });
});

async function findTarget(
  port: number,
  predicate: (target: DevToolsTarget) => boolean,
  appLog: () => string,
  timeoutMs = 15_000,
): Promise<DevToolsTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as
        unknown as DevToolsTarget[];
      const target = targets.find((candidate) => candidate.webSocketDebuggerUrl && predicate(candidate));
      if (target) return target;
    } catch {
      // Electron is still starting.
    }
    await wait(100);
  }
  throw new Error(`timed out waiting for Electron target\n${appLog()}`);
}

async function eventually<T>(
  read: () => Promise<T>,
  message: string,
  accept: (value: T) => boolean = Boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  const detail = lastError instanceof Error ? lastError.message : JSON.stringify(last);
  throw new Error(`${message}: ${detail}`);
}



function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Electron did not exit')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
