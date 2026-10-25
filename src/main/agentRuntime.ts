import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import { renameRetiredFields } from '@shared/fieldAliases.js';
import {
  AGENT_PROTOCOL_VERSION,
  AgentContextSchema,
  AgentRequestSchema,
  AgentResponseSchema,
  canonicalDeckJson,
  type AgentContext,
  type AgentContextDraft,
  type AgentRequest,
  type AgentResponse,
} from '@shared/agent.js';
import type { Deck } from '@shared/deck.js';
import { IPC } from '@shared/ipc.js';

/**
 * Where ephemeral agent state lives. Deliberately outside the deck folder:
 * a sidecar describing a selection is not part of the document and has no
 * business in the user's git history. Read per call so a test (or a second
 * app instance) can point it somewhere else.
 */
export function agentStateRoot(): string {
  return process.env.DECKWERK_STATE_DIR
    ? resolve(process.env.DECKWERK_STATE_DIR)
    : join(homedir(), '.deckwerk', 'runtime');
}

export function deckRevision(deck: Deck): string {
  return createHash('sha256').update(canonicalDeckJson(deck)).digest('hex');
}

export function agentRuntimeDir(deckDir: string): string {
  const canonical = resolve(deckDir);
  const key = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return join(agentStateRoot(), `${sanitize(basename(canonical))}-${key}`);
}

export function agentRuntimePaths(deckDir: string) {
  const root = agentRuntimeDir(deckDir);
  return {
    root,
    context: join(root, 'context.json'),
    inbox: join(root, 'inbox'),
    responses: join(root, 'responses'),
  };
}

/** File-only bridge between a local agent and the currently open editor. */
export class AgentRuntime {
  readonly sessionId = randomUUID();
  private deckDir: string | null = null;
  private watcher: FSWatcher | null = null;
  private processing = new Set<string>();
  private editor: () => BrowserWindow | null;
  /**
   * Sidecar writes, in the order they were asked for. open() marks the deck
   * closed and then live again, and a publish can land in between; written
   * concurrently, an older write could rename over a newer one and leave
   * `live: false` behind an editor that is up.
   */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(editor: () => BrowserWindow | null) {
    this.editor = editor;
  }

  /**
   * Take on a deck, and say so in the sidecar straight away.
   *
   * The CLI routes a change through the editor only when the sidecar says an
   * editor is live; otherwise it writes deck.json itself. Liveness used to wait
   * for the renderer's first publish, which follows a measurement of the
   * selected slides and can be late, or never come if that measurement throws.
   * Until it came the sidecar still said `live: false` from the last session,
   * so an agent wrote deck.json underneath an open editor whose next autosave
   * overwrote the change. The deck is known here, so the sidecar is written
   * here; the renderer's publishes then refine the selection and scenes.
   */
  async open(deckDir: string, deck?: Deck): Promise<void> {
    await this.close();
    this.deckDir = resolve(deckDir);
    const paths = agentRuntimePaths(deckDir);
    await mkdir(paths.inbox, { recursive: true });
    await mkdir(paths.responses, { recursive: true });
    await sweepTempFiles(paths.root);
    await this.announce(deck);
    this.watcher = watch(paths.inbox, () => void this.drain());
    await this.drain();
  }

  async close(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    if (this.deckDir) {
      const path = agentRuntimePaths(this.deckDir).context;
      await this.serialized(async () => {
        try {
          const previous = AgentContextSchema.parse(JSON.parse(await readFile(path, 'utf8')));
          await atomicJson(path, { ...previous, live: false, updatedAt: new Date().toISOString() });
        } catch {
          // No valid prior context to close.
        }
      });
    }
    this.deckDir = null;
  }

  /**
   * close(), finished before returning. For quitting: the app exits as soon
   * as `before-quit` returns, and an asynchronous close was cut off between
   * its temp write and the rename, leaving `live: true` on disk with a pid
   * that the OS is free to hand to another process.
   */
  closeSync(): void {
    this.watcher?.close();
    this.watcher = null;
    if (!this.deckDir) return;
    const path = agentRuntimePaths(this.deckDir).context;
    this.deckDir = null;
    try {
      const previous = AgentContextSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ ...previous, live: false, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
      renameSync(temp, path);
    } catch {
      // No valid prior context to close.
    }
  }

  async publish(draft: AgentContextDraft): Promise<AgentContext> {
    if (!this.deckDir) throw new Error('No deck is open');
    const deckDir = this.deckDir;
    const context = AgentContextSchema.parse({
      ...draft,
      live: true,
      sessionId: this.sessionId,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      deckPath: deckDir,
    });
    await this.serialized(async () => {
      // A publish queued behind close() belongs to a deck that is gone.
      if (this.deckDir !== deckDir) return;
      await atomicJson(agentRuntimePaths(deckDir).context, context);
    });
    return context;
  }

  /**
   * The first sidecar of a session, before the renderer has measured anything:
   * live, with the deck's revision, and the selection the last session left
   * (where it still exists) so an agent's first look lands where the author
   * was.
   */
  private async announce(deck?: Deck): Promise<void> {
    const deckDir = this.deckDir;
    if (!deckDir) return;
    const path = agentRuntimePaths(deckDir).context;
    await this.serialized(async () => {
      if (this.deckDir !== deckDir) return;
      let previous: AgentContext | null = null;
      try {
        previous = AgentContextSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      } catch {
        // First session on this deck, or an unreadable sidecar: start fresh.
      }
      const slideIds = deck ? new Set(deck.slides.map((slide) => slide.id)) : null;
      const kept = (id: string) => !slideIds || slideIds.has(id);
      const selectedSlideIds = (previous?.selectedSlideIds ?? []).filter(kept);
      const activeSlideId = previous?.activeSlideId && kept(previous.activeSlideId)
        ? previous.activeSlideId
        : deck?.slides[0]?.id ?? null;
      const activeSlideIndex = deck && activeSlideId
        ? Math.max(0, deck.slides.findIndex((slide) => slide.id === activeSlideId))
        : 0;
      await atomicJson(path, AgentContextSchema.parse({
        version: AGENT_PROTOCOL_VERSION,
        live: true,
        sessionId: this.sessionId,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        deckPath: deckDir,
        deckRevision: deck ? deckRevision(deck) : previous?.deckRevision ?? '',
        activeSlideId,
        activeSlideIndex,
        selectedSlideIds: selectedSlideIds.length > 0 ? selectedSlideIds : activeSlideId ? [activeSlideId] : [],
        selectedElementIds: [],
        scenes: [],
      }));
    });
  }

  private serialized<T>(write: () => Promise<T>): Promise<T> {
    const next = this.writes.then(write, write);
    this.writes = next.catch(() => undefined);
    return next;
  }

  async respond(response: AgentResponse): Promise<void> {
    if (!this.deckDir) return;
    const parsed = AgentResponseSchema.parse(response);
    const path = join(agentRuntimePaths(this.deckDir).responses, `${safeId(parsed.id)}.json`);
    await atomicJson(path, parsed);
  }

  private async drain(): Promise<void> {
    if (!this.deckDir) return;
    const paths = agentRuntimePaths(this.deckDir);
    const names = (await readdir(paths.inbox).catch(() => []))
      .filter((name) => name.endsWith('.json'));
    for (const name of names) {
      if (this.processing.has(name)) continue;
      this.processing.add(name);
      try {
        const path = join(paths.inbox, name);
        // One atomic write fires several watch events, so drains overlap: a
        // drain that listed this request before another one took it finds it
        // gone. Answering that with an ENOENT error would overwrite the real
        // response — and tell the agent its change failed while the editor
        // applies it.
        let text: string;
        try {
          text = await readFile(path, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        // The schema strips keys it does not know, so a request written against
        // retired field names is canonicalised before it is parsed.
        const request = AgentRequestSchema.parse(renameRetiredFields(JSON.parse(text)));
        const win = this.editor();
        if (!win || win.isDestroyed()) {
          await this.respond({
            version: 1, id: request.id, status: 'error', revision: '',
            message: 'The editor is not available',
          });
        } else {
          win.webContents.send(IPC.agentRequest, request);
        }
        await unlink(path).catch(() => undefined);
      } catch (error) {
        const id = name.replace(/\.json$/, '');
        await this.respond({
          version: 1, id, status: 'error', revision: '',
          message: error instanceof Error ? error.message : String(error),
        });
        await unlink(join(paths.inbox, name)).catch(() => undefined);
      } finally {
        this.processing.delete(name);
      }
    }
  }
}

export async function writeAgentRequest(deckDir: string, request: AgentRequest): Promise<string> {
  const paths = agentRuntimePaths(deckDir);
  await mkdir(paths.inbox, { recursive: true });
  await mkdir(paths.responses, { recursive: true });
  const path = join(paths.inbox, `${safeId(request.id)}.json`);
  await atomicJson(path, AgentRequestSchema.parse(request));
  return join(paths.responses, `${safeId(request.id)}.json`);
}

/** The sidecar as written, live or not, for stale-selection fallback. */
export async function readAgentContextFile(deckDir: string): Promise<AgentContext | null> {
  const path = agentRuntimePaths(deckDir).context;
  if (!existsSync(path)) return null;
  try {
    return AgentContextSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * The sidecar, but only when a running editor still stands behind it.
 *
 * A crashed app leaves `live: true` on disk forever, so liveness is a
 * conjunction of the flag, the deck it claims to describe, and the process
 * actually existing.
 */
export async function readLiveAgentContext(deckDir: string): Promise<AgentContext | null> {
  const context = await readAgentContextFile(deckDir);
  if (!context) return null;
  if (!context.live || resolve(context.deckPath) !== resolve(deckDir)) return null;
  try {
    process.kill(context.pid, 0);
  } catch {
    return null;
  }
  return context;
}

export async function waitForAgentResponse(
  responsePath: string,
  timeoutMs = 15_000,
): Promise<AgentResponse> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = AgentResponseSchema.parse(JSON.parse(await readFile(responsePath, 'utf8')));
      await unlink(responsePath).catch(() => undefined);
      return response;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
  throw new Error('Timed out waiting for the editor to process the request.'
    + ' The editor may still apply it: check `slide-agent context` before retrying,'
    + ' and never re-apply the same change on a timeout alone.');
}

/**
 * Replace a file somebody may be reading at that moment — an authoring page
 * in edit/ that the bridge, the editor or the CLI stamps ids into — by
 * writing beside it and renaming over it. A reader gets the old page or the
 * new one; written in place, it could get the empty file the write truncates
 * to first (an agent did, reading its page as soon as the save was reported).
 * The temporary name starts with a dot and ends in .tmp, so no edit/ watcher
 * takes it for a page.
 */
export async function replaceFileAtomically(path: string, contents: string): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, contents, 'utf8');
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

/**
 * Discard half-written sidecars from a previous run.
 *
 * `atomicJson` writes to a temp name and renames; a process killed between the
 * two leaves the temp behind forever, and there is no session it could still
 * belong to by the time a new one opens the deck.
 */
async function sweepTempFiles(root: string): Promise<void> {
  for (const name of await readdir(root).catch(() => [])) {
    if (name.endsWith('.tmp')) await unlink(join(root, name)).catch(() => undefined);
  }
}

function safeId(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`Invalid request id: ${id}`);
  return id;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
}
