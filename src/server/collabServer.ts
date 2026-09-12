import { renameRetiredFields } from '@shared/fieldAliases.js';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { createDeck, importAsset, loadTheme, resolveAsset } from '../main/deckStore.js';
import { exportDeck, webExportUnavailableReason } from '../main/exportDeck.js';
import { AGENT_BRIEF, agentClipboardPrompt } from './agentBrief.js';
import { capabilities } from '../shared/capabilities.js';
import { probeMedia } from '../main/ffmpeg.js';
import { ClientMessageSchema, COLLAB_PROTOCOL_VERSION, type PresenceState, type ServerMessage } from '../shared/collab.js';
import { CollabSession } from './collabSession.js';
import { writeZip, type ZipFile } from './zip.js';
import {
  compileHtmlToSlides,
  measureBuiltTextOverflows,
  renderHtmlDraftPng,
} from '../cli/compileHtml.js';
import { htmlSlideScope, htmlSyncOperations, htmlSyncSummary, slidesToHtml } from '../shared/htmlSlides.js';
import { PLAYER_TYPE_CSS } from '../shared/playerTypeCss.js';
import { authoringPageHtml, type TextOverflow } from '../shared/htmlMeasure.js';
import { deckRevision } from '../main/agentRuntime.js';
import { applyAgentTransaction, validateDeckIntegrity, type AgentOperation } from '../shared/agent.js';
import { NativeEditRequestSchema, applyNativeEdits, nativeEditContract } from '../shared/nativeEdits.js';
import { SlideSchema, type Deck, type Slide, type SlideElement } from '../shared/deck.js';
import type { AgentChatState } from '../shared/ipc.js';
import type { SharedAgentRuntimeLike } from './sharedAgent.js';
import type { LocalAgentRegistry } from './localAgents.js';
import { planHtmlReplacement } from './htmlReplacement.js';
import { htmlDraftWorkflow, type HtmlDraftWorkflow } from './htmlDraftWorkflow.js';
import {
  canAccessDeck,
  canManageDeck,
  normalizeLogin,
  readDeckAccess,
  resolveIdentity,
  UserDirectory,
  writeDeckAccess,
  type AccessControlConfig,
  type DeckAccess,
  type Identity,
} from './accessControl.js';

/** A local agent bridge identifies its own requests with this header. */
export const BRIDGE_HEADER = 'x-deckwerk-bridge';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

/** Distinguishable hues for peer cursors; assigned least-used-first per deck. */
const PALETTE = [
  '#e0533d', '#3d7de0', '#3daf5e', '#c33dbf', '#e09c3d',
  '#3dbfc3', '#7a5ce0', '#a0b23d', '#e05c8a', '#5c8fa0',
];

interface Peer {
  socket: WebSocket;
  state: PresenceState;
  greeted: boolean;
  /** Tailnet identity the socket was admitted under; null without --access. */
  identity: Identity | null;
  /** Set when this peer is a local agent bridge: whose agent it is. */
  agentFor: string | null;
}

/** One hosted deck: its authoritative session plus the peers editing it. */
interface Room {
  session: CollabSession;
  peers: Map<string, Peer>;
  guestCounter: number;
  /** Synthetic HTTP-agent presence, retained so peers joining later see it. */
  agentPresence: PresenceState | null;
  /**
   * With --access: which tailnet login each browser participant id belongs
   * to, so a bridge claiming `agentFor` that participant must be the same
   * person. Without access control there is no identity to pin it to.
   */
  participantLogins: Map<string, string>;
}

interface HttpHtmlDraft {
  id: string;
  deckId: string;
  revision: string;
  slides: import('../shared/deck.js').Slide[];
  target: { mode: 'insert' | 'replace'; afterSlideId?: string | null; slideIds?: string[] };
  sourceHtml: string;
  importedHtml: string;
  report: Record<string, unknown>;
  workflow: HtmlDraftWorkflow;
  renderCache: Map<string, Promise<Buffer>>;
  createdAt: number;
}

export interface HtmlDraftPreview {
  draftId: string;
  deckId: string;
  slideCount: number;
  sourceUrl: string;
  importedUrl: string;
  comparisonUrl: string;
  sourceContactSheetUrl: string;
  importedContactSheetUrl: string;
  report: Record<string, unknown>;
}

export interface NativeDraftPreview {
  draftId: string;
  deckId: string;
  slideCount: number;
  beforeUrl: string;
  afterUrl: string;
  comparisonUrl: string;
}

interface HttpNativeDraft {
  id: string;
  deckId: string;
  revision: string;
  before: Deck;
  after: Deck;
  operations: AgentOperation[];
  affectedSlideIds: string[];
  affectedElementIds: string[];
  report: {
    beforeOverflows: unknown[];
    afterOverflows: unknown[];
    newOrWorsenedOverflows: unknown[];
  };
  createdAt: number;
}

export interface CollabServerOptions {
  /**
   * The single directory this server exposes. Every immediate subdirectory
   * containing a deck.json is an openable deck; nothing outside this
   * directory is ever readable or writable.
   */
  rootDir: string;
  /** Directory holding the built browser client; may be absent in dev (vite proxy). */
  clientDir?: string;
  port?: number;
  host?: string;
  /**
   * Hosted-session mode: the desktop app sharing the one deck it has open.
   * Only this deck id is joinable; listing shows nothing else, and creating
   * or importing decks is disabled — joiners edit the host's presentation,
   * they don't browse the host's disk.
   */
  hostedDeckId?: string;
  /** Show agent-specific onboarding for invite links created for an agent. */
  agentMode?: boolean;
  /** Optional evaluation-only folder that receives every submitted HTML draft. */
  draftArchiveDir?: string;
  /** Publish the newest HTML work-in-progress to the embedded agent chat. */
  onHtmlDraft?: (draft: HtmlDraftPreview) => void;
  /** Publish the newest native Before/After work-in-progress to the scratchpad. */
  onNativeDraft?: (draft: NativeDraftPreview) => void;
  /** Attribute Agent HTTP edits to the embedded conversation that made them. */
  getAgentChatId?: (deckId: string) => string | null;
  /**
   * Browser-backed Agent runtime. Headless test mode exposes it to every
   * participant; the desktop uses sharedAgentAccess to keep its private Agent
   * on the loopback host. Account management always remains loopback-only.
   */
  sharedAgent?: SharedAgentRuntimeLike;
  /** Limit an app-owned Agent panel to the host while people still collaborate. */
  sharedAgentAccess?: 'all' | 'loopback';
  /**
   * Let every participant connect their own local agent (`slide-agent
   * connect`). Used when no server-owned `sharedAgent` is configured; the
   * browser's Agent panel then shows the connect command instead of a
   * composer, and bridges pair with participants over the WebSocket.
   */
  localAgents?: LocalAgentRegistry;
  /** Override the external Keynote adapter in focused server tests. */
  keynoteImporter?: (keyFile: string, outDir: string) => Promise<unknown>;
  /** Override the external PowerPoint adapter in focused server tests. */
  pptxImporter?: (pptxFile: string, outDir: string) => Promise<unknown>;
  /**
   * Opt-in multi-user access control (`--access <adminLogin>`). When absent —
   * every desktop flow and every deployment that predates it — the server
   * behaves exactly as before: no identity, every deck open to whoever can
   * reach the port. When present, identity comes from Tailscale (see
   * accessControl.ts), decks carry public/private/shared permissions in an
   * access.json sidecar, and the named admin sees everything.
   */
  accessControl?: AccessControlConfig;
  /**
   * Called when the host requests the session end (POST /api/end from
   * loopback in a hosted session). The owner tears the server down; the
   * endpoint itself only notifies peers.
   */
  onSessionEnd?: () => void;
}

export interface RunningCollabServer {
  urls: string[];
  port: number;
  /** Persist every room immediately instead of waiting for its save debounce. */
  flush: () => Promise<void>;
  /** Tell connected peers this was an intentional host end, not a network loss. */
  notifyEnded: () => void;
  close: () => Promise<void>;
}

export async function startCollabServer(options: CollabServerOptions): Promise<RunningCollabServer> {
  const rootDir = resolve(options.rootDir);
  const clientDir = options.clientDir;
  const host = options.host ?? '0.0.0.0';
  const hostedDeckId = options.hostedDeckId;
  const agentMode = Boolean(options.agentMode);
  // A server-owned agent takes the panel when both are configured; otherwise
  // participants' own local agents stand behind the same routes and streams.
  const localAgents = options.sharedAgent ? undefined : options.localAgents;
  const sharedAgent = options.sharedAgent ?? localAgents;
  const sharedAgentAccess = options.sharedAgentAccess ?? 'all';
  const accessControl = options.accessControl
    ? { admin: normalizeLogin(options.accessControl.admin) }
    : null;
  // Everyone the server has ever identified, for share-dialog autocomplete.
  const userDirectory = accessControl ? new UserDirectory(join(resolve(options.rootDir), 'users.json')) : null;
  const rooms = new Map<string, Room>();
  const roomsOpening = new Map<string, Promise<Room>>();
  const htmlDrafts = new Map<string, HttpHtmlDraft>();
  const latestHtmlDrafts = new Map<string, string>();
  const htmlIdempotency = new Map<string, { revision: string; slideIds: string[]; label: string }>();
  const nativeDrafts = new Map<string, HttpNativeDraft>();
  const nativeIdempotency = new Map<string, {
    digest: string; revision: string; slideIds: string[]; elementIds: string[]; label: string;
  }>();
  /** Known once listen() succeeds; /api/config reports the invite URLs. */
  let boundPort: number | null = null;
  const sharedAgentStreams = new Set<{
    deckId: string;
    participantId: string;
    canManageAccount: boolean;
    response: ServerResponse;
  }>();

  /** Deck ids are immediate-child directory names; reject anything else. */
  function deckDirOf(deckId: string): string {
    if (!deckId || deckId.includes('/') || deckId.includes('\\') || deckId === '.' || deckId === '..') {
      throw new Error(`invalid deck id: ${deckId}`);
    }
    if (hostedDeckId && deckId !== hostedDeckId) {
      throw new Error(`this session only hosts "${hostedDeckId}"`);
    }
    const dir = resolve(rootDir, deckId);
    if (dir !== join(rootDir, deckId)) throw new Error(`invalid deck id: ${deckId}`);
    return dir;
  }

  interface DeckListEntry {
    id: string;
    title: string;
    slides: number;
    /** Present only with access control on. */
    owner?: string;
    visibility?: 'public' | 'private';
    canManage?: boolean;
    sharedWithMe?: boolean;
  }

  async function listDecks(identity: Identity | null): Promise<DeckListEntry[]> {
    const out: DeckListEntry[] = [];
    for (const entry of await readdir(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (hostedDeckId && entry.name !== hostedDeckId) continue;
      const deckPath = join(rootDir, entry.name, 'deck.json');
      if (!existsSync(deckPath)) continue;
      let listed: DeckListEntry;
      try {
        const raw = JSON.parse(await readFile(deckPath, 'utf8')) as {
          title?: string; slides?: unknown[];
        };
        listed = {
          id: entry.name,
          title: raw.title ?? entry.name,
          slides: Array.isArray(raw.slides) ? raw.slides.length : 0,
        };
      } catch {
        // Half-written or invalid deck.json; skip rather than fail the listing.
        continue;
      }
      if (accessControl && identity) {
        const access = await readDeckAccess(join(rootDir, entry.name), accessControl);
        if (!canAccessDeck(identity.login, access, accessControl)) continue;
        listed.owner = access.owner;
        listed.visibility = access.visibility;
        listed.canManage = canManageDeck(identity.login, access, accessControl);
        listed.sharedWithMe = access.sharedWith.includes(identity.login);
      }
      out.push(listed);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Whether this identity may touch the deck at all; access control off = yes. */
  async function deckAllowed(identity: Identity | null, deckId: string): Promise<boolean> {
    if (!accessControl) return true;
    if (!identity) return false;
    let deckDir: string;
    try {
      deckDir = deckDirOf(deckId);
    } catch {
      // Invalid ids fall through to the route's own error handling.
      return true;
    }
    return canAccessDeck(identity.login, await readDeckAccess(deckDir, accessControl), accessControl);
  }

  async function getRoom(deckId: string): Promise<Room> {
    const existing = rooms.get(deckId);
    if (existing) return existing;
    // A page opens its WebSocket and its agent-state stream at the same
    // moment; both miss the cache. Two sessions on one folder would each
    // become "the" room for whoever asked — the loser's peers orphaned in a
    // room nobody else can see — so the first opener's promise is shared.
    let opening = roomsOpening.get(deckId);
    if (!opening) {
      opening = openRoom(deckId).finally(() => roomsOpening.delete(deckId));
      roomsOpening.set(deckId, opening);
    }
    return opening;
  }

  async function openRoom(deckId: string): Promise<Room> {
    const session = await CollabSession.open(deckDirOf(deckId));
    const room: Room = {
      session, peers: new Map(), guestCounter: 0, agentPresence: null, participantLogins: new Map(),
    };
    session.watch({
      onExternalDeck: (deck, seq) => broadcast(room, {
        kind: 'deck',
        seq,
        deck,
        reason: options.agentMode ? 'agent-edit' : 'external-edit',
        ...(options.agentMode
          ? {
              label: 'The Agent updated the deck through its file-based authoring workspace.',
              agentChatId: options.getAgentChatId?.(deckId) ?? undefined,
            }
          : {}),
      }),
      onExternalTheme: (css) => broadcast(room, { kind: 'theme', css, byClientId: '' }),
    });
    rooms.set(deckId, room);
    return room;
  }

  const send = (peer: Peer, message: ServerMessage) => {
    if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(JSON.stringify(message));
  };
  const broadcast = (room: Room, message: ServerMessage, except?: string) => {
    for (const [id, peer] of room.peers) {
      if (id !== except && peer.greeted) send(peer, message);
    }
  };
  const publishAgentPresence = (room: Room, slideId: string): void => {
    if (!agentMode && !sharedAgent) return;
    room.agentPresence = {
      clientId: 'agent-http',
      name: sharedAgent?.name ?? 'Agent',
      color: PALETTE[0],
      activeSlideId: slideId,
      selectedSlideIds: [slideId],
      selectedElementIds: [],
      editingElementId: null,
      cursor: null,
    };
    broadcast(room, { kind: 'presence', state: room.agentPresence });
  };

  /**
   * Whether the request comes from the server's owner. Without --access that
   * is the loopback socket (the desktop app's own window). With it, every
   * request is loopback — tailscale serve proxies them all — so the owner is
   * the admin identity, or nobody.
   */
  const isHostRequest = (request: IncomingMessage): boolean => accessControl
    ? resolveIdentity(request, accessControl)?.login === accessControl.admin
    : isLoopbackRequest(request);
  const canUseSharedAgent = (request: IncomingMessage): boolean => Boolean(sharedAgent)
    && (sharedAgentAccess === 'all' || isHostRequest(request));

  const agentChatId = (deckId: string, participantId: string | null): string | null => {
    if (sharedAgent && participantId) return sharedAgent.chatId(deckDirOf(deckId), participantId);
    return options.getAgentChatId?.(deckId) ?? null;
  };

  const publicAgentState = (
    state: AgentChatState,
    deckId: string,
    canManageAccount: boolean,
  ): AgentChatState => ({
    ...state,
    // Never expose the server's absolute deck path or the demo owner's email
    // to remote participants. The loopback owner retains normal account UI.
    // A participant's own local agent is theirs to see by name.
    deckPath: deckId,
    accountLabel: canManageAccount || localAgents
      ? state.accountLabel
      : sharedAgent?.name ?? 'Shared Agent',
  });

  const emitSharedAgentState = (state: AgentChatState, participantId: string): void => {
    for (const stream of sharedAgentStreams) {
      if (stream.participantId !== participantId) continue;
      if (resolve(state.deckPath) !== deckDirOf(stream.deckId)) continue;
      stream.response.write(
        `data: ${JSON.stringify(publicAgentState(state, stream.deckId, stream.canManageAccount))}\n\n`,
      );
    }
  };
  // Subscribe only after the server owns its port. A failed listen (most
  // commonly EADDRINUSE before the desktop retries on an ephemeral port) must
  // not leak a duplicate listener into the shared Agent runtime.
  let unsubscribeSharedAgent: (() => void) | undefined;

  const httpServer = createServer((request, response) => {
    void handleHttp(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(`server error: ${String(error)}`);
    });
  });

  /**
   * Compile authored HTML the way every HTML route does — sanitised, measured
   * in a headless window, diagnosed — and register it as a draft the
   * scratchpad routes can serve. Shared by the preview route (which only
   * previews) and the mirror sync route (which also applies).
   */
  async function compileHtmlDraft(
    deckParam: string,
    room: Room,
    html: string,
    requestedTarget: HttpHtmlDraft['target'] | undefined,
    agentSessionParam: string | null,
    startedAt: number,
  ): Promise<{ draft: HttpHtmlDraft; preview: HtmlDraftPreview; body: Record<string, unknown> } | { error: string }> {
    const sanitized = await sanitizeServerHtml(html, room.session.dir);
    const sanitizedAt = Date.now();
    const temp = await mkdtemp(join(tmpdir(), 'slide-http-preview-'));
    const htmlPath = join(temp, 'slides.html');
    try {
      await writeFile(htmlPath, sanitized.html, 'utf8');
      const compiled = await compileHtmlToSlides({ deckDir: room.session.dir, deck: room.session.deck, htmlPath });
      const compiledAt = Date.now();
      if (compiled.slides.length === 0) return { error: 'no slides found' };
      const all = compiled.slides.flatMap((slide) => slide.elements);
      const fallback = all.filter((element) => element.type === 'html');
      const native = all.length - fallback.length;
      const overflows = await measureBuiltTextOverflows(room.session.dir, room.session.deck, compiled.slides);
      const overflowMeasuredAt = Date.now();
      const id = randomUUID();
      const target = requestedTarget ?? {
        mode: 'insert' as const,
        afterSlideId: room.session.deck.slides.at(-1)?.id ?? null,
      };
      const report = {
        nativeObjectRatio: all.length === 0 ? 1 : native / all.length,
        nativeObjects: native,
        fallbackObjects: fallback.length,
        fallbackReasons: [...new Set(fallback.map((element) => element.fallbackReason ?? 'Unsupported HTML region'))],
        warnings: compiled.warnings,
        missingAssets: sanitized.missing,
        blockedResources: sanitized.blocked,
        extractedAssets: sanitized.assets,
        overflows,
        pixelDifference: null,
        tolerance: 0.002,
        timingsMs: {
          sanitize: sanitizedAt - startedAt,
          compile: compiledAt - sanitizedAt,
          overflowCheck: overflowMeasuredAt - compiledAt,
          total: 0,
        },
      };
      const workflow = htmlDraftWorkflow({
        overflows,
        missingAssets: sanitized.missing,
        blockedResources: sanitized.blocked,
        warnings: compiled.warnings,
      });
      if (options.draftArchiveDir) {
        await mkdir(options.draftArchiveDir, { recursive: true });
        const stamp = `${Date.now()}-${id}`;
        await writeFile(join(options.draftArchiveDir, `${stamp}.html`), html, 'utf8');
        await writeFile(join(options.draftArchiveDir, `${stamp}.json`), JSON.stringify({
          draftId: id,
          deckId: deckParam,
          revision: deckRevision(room.session.deck),
          target,
          report,
          workflow,
        }, null, 2), 'utf8');
      }
      const themeCss = await loadTheme(room.session.dir, room.session.deck.theme);
      const sourceHtml = authoringPageHtml({
        authored: sanitized.html,
        typeCss: PLAYER_TYPE_CSS,
        theme: themeCss,
        themeHref: room.session.deck.theme,
        canvas: room.session.deck.canvas,
        base: `/decks/${encodeURIComponent(deckParam)}/`,
      });
      const importedHtml = slidesToHtml(compiled.slides, room.session.deck.canvas, {
        typeCss: PLAYER_TYPE_CSS,
        base: `/decks/${encodeURIComponent(deckParam)}/`,
        theme: `/api/theme?deck=${encodeURIComponent(deckParam)}`,
      });
      const draft: HttpHtmlDraft = {
        id, deckId: deckParam, revision: deckRevision(room.session.deck), slides: compiled.slides,
        target, sourceHtml, importedHtml,
        report, workflow, renderCache: new Map(), createdAt: Date.now(),
      };
      const scratchpadDir = join(room.session.dir, 'edit', '.scratchpad');
      await mkdir(scratchpadDir, { recursive: true });
      await Promise.all([
        writeFile(join(scratchpadDir, 'source.html'), authoringPageHtml({
          authored: sanitized.html,
          typeCss: PLAYER_TYPE_CSS,
          theme: themeCss,
          themeHref: room.session.deck.theme,
          canvas: room.session.deck.canvas,
          base: '../../',
        }), 'utf8'),
        writeFile(join(scratchpadDir, 'imported.html'), slidesToHtml(
          compiled.slides,
          room.session.deck.canvas,
          { typeCss: PLAYER_TYPE_CSS, base: '../../', theme: room.session.deck.theme },
        ), 'utf8'),
      ]);
      htmlDrafts.set(id, draft);
      report.timingsMs.total = Date.now() - startedAt;
      latestHtmlDrafts.set(deckParam, id);
      const query = `?deck=${encodeURIComponent(deckParam)}`;
      const sourcePath = `/api/html-drafts/${id}/source`;
      const importedPath = `/api/html-drafts/${id}/imported`;
      const sourceContactSheetPath = `/api/html-drafts/${id}/source/contact-sheet.png`;
      const importedContactSheetPath = `/api/html-drafts/${id}/imported/contact-sheet.png`;
      const comparisonPath = `/api/html-drafts/${id}/compare`;
      const preview: HtmlDraftPreview = {
        draftId: id,
        deckId: deckParam,
        slideCount: draft.slides.length,
        sourceUrl: `http://127.0.0.1:${boundPort}${sourcePath}${query}`,
        importedUrl: `http://127.0.0.1:${boundPort}${importedPath}${query}`,
        comparisonUrl: `http://127.0.0.1:${boundPort}${comparisonPath}${query}`,
        sourceContactSheetUrl: `http://127.0.0.1:${boundPort}${sourceContactSheetPath}${query}`,
        importedContactSheetUrl: `http://127.0.0.1:${boundPort}${importedContactSheetPath}${query}`,
        report,
      };
      options.onHtmlDraft?.(preview);
      if (sharedAgent && agentSessionParam) {
        sharedAgent.setScratchpad(deckDirOf(deckParam), agentSessionParam, {
          draftId: preview.draftId,
          slideCount: preview.slideCount,
          sourceUrl: preview.sourceUrl,
          importedUrl: preview.importedUrl,
          comparisonUrl: preview.comparisonUrl,
          sourceContactSheetUrl: preview.sourceContactSheetUrl,
          importedContactSheetUrl: preview.importedContactSheetUrl,
        });
      }
      return { draft, preview, body: {
        workflow,
        blockingIssues: workflow.blockingIssues,
        nextAction: workflow.nextAction,
        draftId: id,
        revision: draft.revision,
        slideCount: draft.slides.length,
        sourceUrl: sourcePath,
        importedUrl: importedPath,
        comparisonUrl: comparisonPath,
        sourceContactSheetUrl: sourceContactSheetPath,
        importedContactSheetUrl: importedContactSheetPath,
        diffUrl: null,
        report,
        target,
      } };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    const deckParam = url.searchParams.get('deck');
    const agentSessionParam = normalizeSharedParticipantId(url.searchParams.get('agentSession'));

    // With access control on, every request needs a tailnet identity before it
    // gets a single byte — including the client bundle. One check here covers
    // every ?deck=-scoped route; the asset route and the WebSocket upgrade
    // carry the deck id elsewhere and repeat the deck check themselves.
    const identity = accessControl ? resolveIdentity(request, accessControl) : null;
    if (accessControl && !identity) {
      return respondJson(response, 403, {
        error: 'unidentified connection — this server is reachable only through tailscale serve',
      });
    }
    if (identity && userDirectory) void userDirectory.note(identity);
    if (deckParam && !(await deckAllowed(identity, deckParam))) {
      return respondJson(response, 403, { error: 'you do not have access to this deck' });
    }
    // A participant's own agent working over plain HTTP (the copied brief,
    // no bridge) announces itself by the id on its requests; that is enough
    // to light the panel and route its previews and activity there. A bridge
    // says so in a header: its own mirror traffic is not a second agent, and
    // its WebSocket is what the panel should report.
    if (localAgents && deckParam && agentSessionParam && path.startsWith('/api/')
      && !path.startsWith('/api/shared-agent/')
      && request.headers[BRIDGE_HEADER] === undefined) {
      try {
        localAgents.touchHttp(deckDirOf(deckParam), agentSessionParam);
      } catch {
        // An invalid deck id fails in its route with a proper message.
      }
    }

    // Agent sessions are observation-only in the browser. All authoring,
    // comments, assets, and apply operations go through the HTTP API. Keep the
    // old manual workspace only as an explicit human debugging surface.
    if ((path === '/' || path === '/index.html')
      && url.searchParams.get('agent') === '1'
      && url.searchParams.get('debug') !== '1') {
      const viewer = new URL('/present.html', 'http://localhost');
      for (const [key, value] of url.searchParams) viewer.searchParams.set(key, value);
      if (!viewer.searchParams.has('slide')) viewer.searchParams.set('slide', '1');
      response.writeHead(302, { location: `${viewer.pathname}${viewer.search}` });
      response.end();
      return;
    }

    // Deck-scoped asset streaming: /decks/<id>/assets/<relpath>
    const assetMatch = /^\/decks\/([^/]+)\/(assets\/.+)$/.exec(path);
    if (assetMatch) {
      if (!(await deckAllowed(identity, assetMatch[1]))) {
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end('forbidden');
        return;
      }
      let absolute: string;
      try {
        const deckDir = deckDirOf(assetMatch[1]);
        absolute = resolveAsset(deckDir, assetMatch[2]);
        // Stricter than resolveAsset's deck-folder guard: over HTTP, only the
        // assets/ subtree is servable — never deck.json or edit/ files.
        if (!absolute.startsWith(join(deckDir, 'assets') + '/')) throw new Error('outside assets');
      } catch {
        response.writeHead(403, { 'content-type': 'text/plain' });
        response.end('forbidden');
        return;
      }
      await serveFileWithRanges(request, response, absolute);
      return;
    }

    // The feature cookbook: every editor capability with a minimal, valid
    // example element. The antidote to agents hand-building what already
    // exists (literal "•" bullets instead of <ul>, equations out of positioned
    // text, re-encoded videos instead of sourceBox crops).
    if (path === '/api/capabilities' && request.method === 'GET') {
      const only = (url.searchParams.get('only') ?? '').split(',').filter(Boolean);
      const all = capabilities();
      const picked = only.length > 0 ? all.filter((c) => only.includes(c.id)) : all;
      respondJson(response, 200, {
        howToUse: [
          'Copy an element from `elements` and change the ids, geometry and text.',
          'Element ids must be unique across the whole deck.',
          'Sizes and colours belong in theme.css via the class, not in inline style.',
          'Filter with ?only=<id>,<id> once you know what you need.',
        ],
        capabilities: picked,
      });
      return;
    }

    if (path === '/api/brief' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      response.end(AGENT_BRIEF);
      return;
    }

    if (path === '/api/config' && request.method === 'GET') {
      respondJson(response, 200, {
        hosted: Boolean(hostedDeckId),
        deckId: hostedDeckId ?? null,
        agentMode: Boolean(options.agentMode),
        access: accessControl && identity ? {
          user: identity.login,
          name: identity.name,
          admin: identity.login === accessControl.admin,
        } : null,
        sharedAgent: canUseSharedAgent(request) ? {
          enabled: true,
          name: sharedAgent?.name ?? 'Agent',
          canManageAccount: isHostRequest(request),
          ...(sharedAgentAccess === 'loopback' ? { personal: true } : {}),
          ...(localAgents ? { mode: 'local' } : {}),
        } : null,
        urls: boundPort === null ? [] : reachableUrls(host, boundPort),
      });
      return;
    }

    if (path === '/api/shared-agent/events' && request.method === 'GET') {
      if (!sharedAgent || !canUseSharedAgent(request)) {
        return respondJson(response, 404, { error: 'agent is not available to this client' });
      }
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const participantId = sharedParticipantId(url);
      if (!participantId) return respondJson(response, 400, { error: 'missing or invalid participant' });
      await getRoom(deckParam);
      const stream = {
        deckId: deckParam,
        participantId,
        canManageAccount: isHostRequest(request),
        response,
      };
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      response.write(': shared agent state\n\n');
      sharedAgentStreams.add(stream);
      request.on('close', () => sharedAgentStreams.delete(stream));
      const state = await sharedAgent.getState(deckDirOf(deckParam), participantId);
      response.write(`data: ${JSON.stringify(publicAgentState(
        state,
        deckParam,
        stream.canManageAccount,
      ))}\n\n`);
      return;
    }

    if (path === '/api/shared-agent/state' && request.method === 'GET') {
      if (!sharedAgent || !canUseSharedAgent(request)) {
        return respondJson(response, 404, { error: 'agent is not available to this client' });
      }
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const participantId = sharedParticipantId(url);
      if (!participantId) return respondJson(response, 400, { error: 'missing or invalid participant' });
      await getRoom(deckParam);
      const state = await sharedAgent.getState(deckDirOf(deckParam), participantId);
      respondJson(response, 200, publicAgentState(state, deckParam, isHostRequest(request)));
      return;
    }

    if (path.startsWith('/api/shared-agent/') && request.method === 'POST') {
      if (!sharedAgent || !canUseSharedAgent(request)) {
        return respondJson(response, 404, { error: 'agent is not available to this client' });
      }
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const participantId = sharedParticipantId(url);
      if (!participantId) return respondJson(response, 400, { error: 'missing or invalid participant' });
      await getRoom(deckParam);
      const deckDir = deckDirOf(deckParam);
      const payload = JSON.parse((await readBody(request)).toString('utf8') || '{}') as Record<string, unknown>;
      const canManageAccount = isHostRequest(request);

      if (path === '/api/shared-agent/login' || path === '/api/shared-agent/switch-account') {
        if (!canManageAccount) {
          return respondJson(response, 403, { error: 'only the server owner on loopback can manage the shared account' });
        }
        const result = path.endsWith('/login')
          ? await sharedAgent.login(deckDir, participantId)
          : await sharedAgent.switchAccount(deckDir, participantId);
        respondJson(response, 200, {
          state: publicAgentState(result.state, deckParam, true),
          authUrl: result.authUrl,
        });
        return;
      }

      let state: AgentChatState;
      if (path === '/api/shared-agent/send') {
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) return respondJson(response, 400, { error: 'missing text' });
        const author = typeof payload.author === 'string'
          ? payload.author.trim().replace(/\s+/g, ' ').slice(0, 80)
          : '';
        const attributed = author ? `[Request from ${author}]\n${text}` : text;
        state = await sharedAgent.send(deckDir, participantId, { text: attributed }, async () => {
          if (boundPort === null) throw new Error('collaboration server is not listening');
          const sessionUrl = `http://127.0.0.1:${boundPort}/?deck=${encodeURIComponent(deckParam)}&agent=1&agentSession=${encodeURIComponent(participantId)}`;
          return `${agentClipboardPrompt(sessionUrl, deckParam)}\n\n`
            + `${sharedAgentAccess === 'loopback' ? 'Desktop host identity' : 'Shared demo identity'}: `
            + `append \`agentSession=${participantId}\` to every /api request `
            + 'so edits are attributed to this participant\'s Agent chat.';
        });
      } else if (path === '/api/shared-agent/interrupt') {
        state = await sharedAgent.interrupt(deckDir, participantId);
      } else if (path === '/api/shared-agent/reset') {
        state = await sharedAgent.reset(deckDir, participantId);
      } else if (path === '/api/shared-agent/select') {
        const chatId = typeof payload.chatId === 'string' ? payload.chatId : '';
        if (!chatId) return respondJson(response, 400, { error: 'missing chatId' });
        state = await sharedAgent.select(deckDir, participantId, chatId);
      } else if (path === '/api/shared-agent/model') {
        const model = typeof payload.model === 'string' ? payload.model : '';
        if (!model) return respondJson(response, 400, { error: 'missing model' });
        state = await sharedAgent.setModel(deckDir, participantId, { model });
      } else if (path === '/api/shared-agent/reasoning-effort') {
        const effort = typeof payload.effort === 'string' ? payload.effort : '';
        if (!effort) return respondJson(response, 400, { error: 'missing effort' });
        state = await sharedAgent.setReasoningEffort(deckDir, participantId, { effort });
      } else if (path === '/api/shared-agent/fast-mode') {
        if (typeof payload.enabled !== 'boolean') {
          return respondJson(response, 400, { error: 'missing enabled flag' });
        }
        state = await sharedAgent.setFastMode(deckDir, participantId, { enabled: payload.enabled });
      } else {
        return respondJson(response, 404, { error: 'unknown shared agent action' });
      }
      respondJson(response, 200, publicAgentState(state, deckParam, canManageAccount));
      return;
    }

    if (path === '/api/decks' && request.method === 'GET') {
      respondJson(response, 200, await listDecks(identity));
      return;
    }

    // The people directory: everyone this server has identified before, so
    // sharing can autocomplete logins and show names. Names come from the
    // tailnet identity — being listed grants nothing by itself.
    if (path === '/api/users' && request.method === 'GET' && userDirectory) {
      respondJson(response, 200, await userDirectory.all());
      return;
    }

    // Per-deck permissions. Reading requires deck access (enforced above);
    // changing them is for the owner or the admin. Not routed at all without
    // the --access flag, matching the rest of the sidecar machinery.
    if (path === '/api/access' && accessControl && identity) {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      let deckDir: string;
      try {
        deckDir = deckDirOf(deckParam);
      } catch {
        return respondJson(response, 400, { error: 'invalid deck id' });
      }
      if (!existsSync(join(deckDir, 'deck.json'))) {
        return respondJson(response, 404, { error: 'no such deck' });
      }
      const access = await readDeckAccess(deckDir, accessControl);
      const canManage = canManageDeck(identity.login, access, accessControl);
      if (request.method === 'GET') {
        respondJson(response, 200, { ...access, canManage });
        return;
      }
      if (request.method === 'PUT' || request.method === 'POST') {
        if (!canManage) {
          return respondJson(response, 403, { error: 'only the deck owner or the admin can change access' });
        }
        let payload: { visibility?: unknown; sharedWith?: unknown; owner?: unknown };
        try {
          payload = JSON.parse((await readBody(request)).toString('utf8') || '{}') as typeof payload;
        } catch {
          return respondJson(response, 400, { error: 'body must be JSON' });
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return respondJson(response, 400, { error: 'body must be a JSON object' });
        }
        const next: DeckAccess = { ...access };
        if (payload.visibility !== undefined) {
          if (payload.visibility !== 'public' && payload.visibility !== 'private') {
            return respondJson(response, 400, { error: 'visibility must be "public" or "private"' });
          }
          next.visibility = payload.visibility;
        }
        if (payload.sharedWith !== undefined) {
          if (!Array.isArray(payload.sharedWith)
            || payload.sharedWith.some((entry) => typeof entry !== 'string')
            || payload.sharedWith.length > 500) {
            return respondJson(response, 400, { error: 'sharedWith must be an array of logins' });
          }
          next.sharedWith = [...new Set((payload.sharedWith as string[])
            .map(normalizeLogin)
            .filter((login) => login !== ''))];
        }
        if (payload.owner !== undefined) {
          // Transferring ownership is an admin act: an owner "giving a deck
          // away" by typo would silently lock themselves out.
          if (identity.login !== accessControl.admin) {
            return respondJson(response, 403, { error: 'only the admin can transfer ownership' });
          }
          if (typeof payload.owner !== 'string' || !normalizeLogin(payload.owner)) {
            return respondJson(response, 400, { error: 'owner must be a login' });
          }
          next.owner = normalizeLogin(payload.owner);
        }
        await writeDeckAccess(deckDir, next);
        // A socket was admitted under the old sidecar; the new one has to
        // apply to it too, or un-sharing would only stop the *next* visit.
        for (const peer of rooms.get(deckParam)?.peers.values() ?? []) {
          if (peer.identity && !canAccessDeck(peer.identity.login, next, accessControl)) {
            peer.socket.close(4003, 'your access to this deck was revoked');
          }
        }
        respondJson(response, 200, {
          ...next,
          canManage: canManageDeck(identity.login, next, accessControl),
        });
        return;
      }
      return respondJson(response, 405, { error: 'method not allowed' });
    }

    if (hostedDeckId && (path === '/api/decks' || path === '/api/import-keynote' || path === '/api/import-pptx') && request.method === 'POST') {
      respondJson(response, 403, { error: 'this session hosts a single shared presentation' });
      return;
    }

    if (path === '/api/decks' && request.method === 'POST') {
      const name = sanitizeDeckId(url.searchParams.get('name') ?? '');
      if (!name) return respondJson(response, 400, { error: 'missing or invalid name' });
      const dir = deckDirOf(name);
      if (existsSync(dir)) return respondJson(response, 409, { error: `deck "${name}" already exists` });
      await createDeck(dir, name);
      // New decks start private to their creator: accidental exposure should
      // take an explicit act, not the absence of one.
      if (accessControl && identity) {
        await writeDeckAccess(dir, { owner: identity.login, visibility: 'private', sharedWith: [] });
      }
      respondJson(response, 200, { id: name });
      return;
    }

    const importRoute = path === '/api/import-keynote'
      ? { extension: '.key', run: options.keynoteImporter ?? runKeynoteImport }
      : path === '/api/import-pptx'
        ? { extension: '.pptx', run: options.pptxImporter ?? runPowerPointImport }
        : null;
    if (importRoute && request.method === 'POST') {
      const name = sanitizeDeckId(url.searchParams.get('name') ?? '');
      if (!name) return respondJson(response, 400, { error: 'missing or invalid name' });
      const dir = deckDirOf(name);
      if (existsSync(dir)) return respondJson(response, 409, { error: `deck "${name}" already exists` });
      const body = await readBody(request);
      const tmp = await mkdtemp(join(tmpdir(), 'collab-import-'));
      try {
        const sourceFile = join(tmp, `${name}${importRoute.extension}`);
        await writeFile(sourceFile, body);
        const report = await importRoute.run(sourceFile, dir);
        if (accessControl && identity) {
          await writeDeckAccess(dir, { owner: identity.login, visibility: 'private', sharedWith: [] });
        }
        respondJson(response, 200, { id: name, report });
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      return;
    }

    if (path === '/api/upload' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const name = url.searchParams.get('name') ?? 'upload';
      const body = await readBody(request);
      const dir = await mkdtemp(join(tmpdir(), 'collab-upload-'));
      const tmpFile = join(dir, sanitizeFilename(name));
      try {
        await writeFile(tmpFile, body);
        const imported = await importAsset(deckDirOf(deckParam), tmpFile);
        respondJson(response, 200, imported);
      } catch (error) {
        respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }

    if (path === '/api/import-url' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const payload = JSON.parse((await readBody(request)).toString('utf8')) as { url?: string; name?: string };
      if (!payload.url) return respondJson(response, 400, { error: 'missing url' });
      const dir = await mkdtemp(join(tmpdir(), 'collab-url-import-'));
      try {
        const downloaded = await downloadPublicAsset(payload.url);
        const requestedName = payload.name?.trim() || basename(downloaded.url.pathname) || 'download';
        const tmpFile = join(dir, sanitizeFilename(requestedName));
        await writeFile(tmpFile, downloaded.bytes);
        const imported = await importAsset(deckDirOf(deckParam), tmpFile);
        respondJson(response, 200, imported);
      } catch (error) {
        respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      return;
    }

    if (path === '/api/probe') {
      const src = url.searchParams.get('src');
      if (!src || !deckParam) return respondJson(response, 400, { error: 'missing deck or src' });
      try {
        respondJson(response, 200, await probeMedia(resolveAsset(deckDirOf(deckParam), src)));
      } catch (error) {
        respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      }
      return;
    }

    // Download the whole deck folder as a zip. Flushing the live session first
    // means the archive holds exactly what everyone currently sees.
    if (path === '/api/download' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      let deckDir: string;
      try {
        deckDir = deckDirOf(deckParam);
      } catch {
        return respondJson(response, 403, { error: 'forbidden' });
      }
      if (!existsSync(join(deckDir, 'deck.json'))) {
        return respondJson(response, 404, { error: 'no such deck' });
      }
      await rooms.get(deckParam)?.session.flush();
      const files = await collectDeckFiles(deckDir);
      response.writeHead(200, {
        'content-type': 'application/zip',
        'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${sanitizeFilename(deckParam)}.zip"`,
      });
      await writeZip(response, files);
      response.end();
      return;
    }

    // The deck as a self-contained web page, zipped. Same exporter the desktop
    // app runs, so the bundle presents identically whether it came from the
    // app or from a browser on the other side of the network; the live session
    // is flushed first, so it holds exactly what everyone currently sees.
    if (path === '/api/export/web' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      let deckDir: string;
      try {
        deckDir = deckDirOf(deckParam);
      } catch {
        return respondJson(response, 403, { error: 'forbidden' });
      }
      if (!existsSync(join(deckDir, 'deck.json'))) {
        return respondJson(response, 404, { error: 'no such deck' });
      }
      // A browser download cannot show an error once the bytes start, so the
      // client asks first and the answer decides whether it starts one at all.
      const unavailable = webExportUnavailableReason();
      if (url.searchParams.get('probe') === '1') {
        return unavailable
          ? respondJson(response, 501, { error: unavailable })
          : respondJson(response, 200, { ok: true });
      }
      if (unavailable) return respondJson(response, 501, { error: unavailable });
      const room = await getRoom(deckParam);
      await room.session.flush();
      const staging = await mkdtemp(join(tmpdir(), 'deckwerk-web-'));
      const outDir = join(staging, sanitizeFilename(deckParam));
      try {
        await exportDeck(deckDir, room.session.deck, outDir);
        // Collected from the staging root, so the archive unpacks into a
        // folder named after the deck rather than scattering player.js and
        // index.html into wherever the recipient double-clicked it.
        const files = await collectDeckFiles(staging);
        response.writeHead(200, {
          'content-type': 'application/zip',
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${sanitizeFilename(deckParam)}-web.zip"`,
        });
        await writeZip(response, files);
        response.end();
      } catch (error) {
        // The export player bundle is a build artefact; a server started
        // without it must say so rather than serve a broken archive.
        respondJson(response, 500, {
          error: String(error instanceof Error ? error.message : error),
        });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      return;
    }

    // Host-only, hosted-session-only: end the collaboration. The desktop app's
    // own window is the sole loopback client, so loopback is the auth check.
    if (path === '/api/end' && request.method === 'POST') {
      const remote = request.socket.remoteAddress ?? '';
      const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!hostedDeckId || !loopback) {
        return respondJson(response, 403, { error: 'only the host can end the session' });
      }
      for (const room of rooms.values()) broadcast(room, { kind: 'ended' });
      respondJson(response, 200, { ok: true });
      options.onSessionEnd?.();
      return;
    }

    // The live deck as JSON — for agents that talk HTTP rather than driving
    // the client page. Served from the room's session, so it is exactly what
    // every connected client currently sees.
    if (path === '/api/deck' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      respondJson(response, 200, room.session.deck);
      return;
    }

    // The deck folder for a local agent bridge to mirror. deck.json, the
    // theme and notes.md travel live over the WebSocket; this lists and
    // serves everything else — assets, fonts, whatever the author keeps in
    // the folder — and accepts new assets back. Never edit/ (each bridge has
    // its own) and never dotfiles or the server's sidecars.
    if (path === '/api/agent-mirror/files' && request.method === 'GET') {
      if (!localAgents) return respondJson(response, 404, { error: 'local agents are not enabled' });
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      await room.session.flush();
      const files = await collectMirrorFiles(room.session.dir, room.session.deck.theme);
      respondJson(response, 200, { deckId: deckParam, files });
      return;
    }

    // The agent CLI's authoring verbs, over HTTP, for a mirror that has no CLI
    // installed: an editable export of named slides, a blank page that can
    // only add, and the structural check. Slides are named by id or 1-based
    // number, exactly as `slide-agent` takes them.
    if (path === '/api/agent-mirror/export.html' && request.method === 'GET') {
      if (!localAgents) return respondJson(response, 404, { error: 'local agents are not enabled' });
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      const chosen = slidesByRef(room.session.deck, url.searchParams.get('slide'));
      if ('error' in chosen) return respondJson(response, 404, { error: chosen.error });
      if (chosen.slides.length === 0) return respondJson(response, 400, { error: 'name at least one slide' });
      const html = slidesToHtml(chosen.slides, room.session.deck.canvas, {
        typeCss: PLAYER_TYPE_CSS, base: '../', theme: room.session.deck.theme,
      });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }

    if (path === '/api/agent-mirror/new.html' && request.method === 'GET') {
      if (!localAgents) return respondJson(response, 404, { error: 'local agents are not enabled' });
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      const count = Number(url.searchParams.get('count') ?? '1');
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        return respondJson(response, 400, { error: 'count takes a whole number of slides from 1 to 50' });
      }
      const html = slidesToHtml([], room.session.deck.canvas, { typeCss: PLAYER_TYPE_CSS, base: '../', blank: count });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }

    if (path === '/api/agent-mirror/validate' && request.method === 'GET') {
      if (!localAgents) return respondJson(response, 404, { error: 'local agents are not enabled' });
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      const deck = room.session.deck;
      const errors = validateDeckIntegrity(deck, (src) => existsSync(join(room.session.dir, src)));
      const scope = url.searchParams.get('slide');
      const chosen = scope ? slidesByRef(deck, scope) : { slides: deck.slides };
      if ('error' in chosen) return respondJson(response, 404, { error: chosen.error });
      const wanted = new Set(chosen.slides.map((slide) => slide.id));
      const round2 = (value: number) => Math.round(value * 100) / 100;
      const overflows = deck.slides.filter((slide) => wanted.has(slide.id)).flatMap((slide) =>
        slide.elements.flatMap((element) => {
          const beyond: Record<string, number> = {};
          if (element.x < 0) beyond.left = round2(-element.x);
          if (element.y < 0) beyond.top = round2(-element.y);
          if (element.x + element.w > deck.canvas.w) beyond.right = round2(element.x + element.w - deck.canvas.w);
          if (element.y + element.h > deck.canvas.h) beyond.bottom = round2(element.y + element.h - deck.canvas.h);
          return Object.keys(beyond).length > 0
            ? [{ slideId: slide.id, elementId: element.id, type: element.type, beyond }]
            : [];
        }));
      const importGaps = deck.slides.flatMap((slide) => slide.elements
        .filter((element) => element.type === 'unsupported')
        .map((element) => ({
          slideId: slide.id, elementId: element.id,
          originalType: (element as { originalType?: string }).originalType,
          note: (element as { note?: string }).note,
        })));
      respondJson(response, 200, {
        valid: errors.length === 0, errors, overflows, importGaps, revision: deckRevision(deck),
        ...(scope ? { scope: [...wanted] } : {}),
      });
      return;
    }

    // A saved authoring page from a mirror, synced with the desktop watcher's
    // semantics: sections replace, add, delete and reorder exactly the range
    // the file governs, as one attributed transaction, and the same compile
    // feeds the participant's scratchpad. Deliberate bleeds are reported, not
    // refused — this is the editor's save path, not the guarded preview one.
    if (path === '/api/agent-mirror/sync-html' && request.method === 'POST') {
      if (!localAgents) return respondJson(response, 404, { error: 'local agents are not enabled' });
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const startedAt = Date.now();
      const html = (await readBody(request)).toString('utf8');
      if (!html.trim()) return respondJson(response, 400, { error: 'missing html' });
      const room = await getRoom(deckParam);
      const deck = room.session.deck;
      const scope = htmlSlideScope(html);
      const afterRef = url.searchParams.get('after');
      let after: string | null = deck.slides.at(-1)?.id ?? null;
      if (afterRef) {
        const anchor = slidesByRef(deck, afterRef);
        if ('error' in anchor) return respondJson(response, 404, { error: anchor.error });
        after = anchor.slides[0]?.id ?? after;
      }
      const target: HttpHtmlDraft['target'] = scope
        ? { mode: 'replace', slideIds: scope }
        : { mode: 'insert', afterSlideId: after };
      const compiledDraft = await compileHtmlDraft(deckParam, room, html, target, agentSessionParam, startedAt);
      if ('error' in compiledDraft) return respondJson(response, 400, { error: compiledDraft.error });
      if (deckRevision(room.session.deck) !== compiledDraft.draft.revision) {
        return respondJson(response, 409, { error: 'the deck changed during the compile; save again' });
      }
      let operations: AgentOperation[];
      try {
        operations = htmlSyncOperations(room.session.deck, compiledDraft.draft.slides, scope, after);
      } catch (error) {
        return respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      }
      // A compiled page knows nothing of review state: comments people left
      // on the slide or its objects, and whether the slide is skipped, live
      // only in the deck. Carry them over so an HTML save never loses a task.
      for (const op of operations) {
        if (op.op !== 'replaceSlide') continue;
        const previous = room.session.deck.slides.find((slide) => slide.id === op.slideId);
        if (!previous) continue;
        const slide = structuredClone(op.slide);
        if (previous.comments?.length) slide.comments = previous.comments;
        if (previous.skipped) slide.skipped = previous.skipped;
        if (!slide.notes && previous.notes) slide.notes = previous.notes;
        const previousElements = new Map(previous.elements.map((element) => [element.id, element]));
        slide.elements = slide.elements.map((element) => {
          const before = previousElements.get(element.id);
          return before?.comments?.length && !element.comments?.length
            ? { ...element, comments: before.comments }
            : element;
        });
        op.slide = slide;
      }
      // Re-saving an export unchanged (or exporting into edit/ in the first
      // place) compiles to the slides the deck already holds. Replacing a
      // slide with itself would still be a transaction in everyone's History,
      // so identical replacements are dropped before anything is applied.
      const current = new Map(room.session.deck.slides.map((slide) => [slide.id, JSON.stringify(SlideSchema.parse(slide))]));
      operations = operations.filter((op) => !(op.op === 'replaceSlide'
        && current.get(op.slideId) === JSON.stringify(SlideSchema.parse(op.slide))));
      const label = url.searchParams.get('label')?.trim().slice(0, 200) || 'Update slides from an authoring page';
      const changes = htmlSyncSummary(operations);
      let revision = compiledDraft.draft.revision;
      if (operations.length > 0) {
        // Strict validation first, as the editor does before its lenient replay.
        try {
          applyAgentTransaction(room.session.deck, { version: 1, expectedRevision: revision, label, operations });
        } catch (error) {
          return respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
        }
        const applied = room.session.applyOps(operations);
        revision = deckRevision(applied.deck);
        const bridge = agentSessionParam ? localAgents.linked(room.session.dir, agentSessionParam) : null;
        broadcast(room, {
          kind: 'txn', seq: applied.seq, txnId: `agent-sync-${randomUUID()}`,
          byClientId: bridge && bridge.clientId !== 'http' ? bridge.clientId : 'agent-http',
          label, ops: operations,
          agentChatId: agentChatId(deckParam, agentSessionParam) ?? undefined,
        });
      }
      respondJson(response, 200, {
        status: 'applied',
        applied: operations.length > 0,
        revision,
        changes,
        slides: compiledDraft.draft.slides.map((slide) => ({
          id: slide.id,
          elements: slide.elements.map((element) => ({
            id: element.id, type: element.type,
            box: { x: element.x, y: element.y, w: element.w, h: element.h },
          })),
        })),
        overflows: compiledDraft.draft.report.overflows ?? [],
        ...(Array.isArray(compiledDraft.draft.report.warnings) && (compiledDraft.draft.report.warnings as unknown[]).length > 0
          ? { warnings: compiledDraft.draft.report.warnings }
          : {}),
        draftId: compiledDraft.draft.id,
      });
      return;
    }

    if (path === '/api/agent-mirror/file' && (request.method === 'GET' || request.method === 'PUT')) {
      if (!localAgents) return respondJson(response, 404, { error: 'local agents are not enabled' });
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      const relative = mirrorPath(url.searchParams.get('path'));
      if (!relative) return respondJson(response, 400, { error: 'invalid path' });
      const absolute = join(room.session.dir, relative);
      if (request.method === 'GET') {
        if (!existsSync(absolute) || !(await stat(absolute)).isFile()) {
          return respondJson(response, 404, { error: `no such file: ${relative}` });
        }
        await serveFileWithRanges(request, response, absolute);
        return;
      }
      // Uploads land only in assets/, under the exact name the bridge's own
      // import gave the file, so the deck the agent authored against and the
      // deck everyone else sees reference the same `assets/…` path.
      if (!relative.startsWith('assets/') || relative.slice('assets/'.length).includes('/')) {
        return respondJson(response, 400, { error: 'only files directly under assets/ can be uploaded' });
      }
      const body = await readBody(request);
      if (existsSync(absolute)) {
        const current = await readFile(absolute);
        if (current.equals(body)) return respondJson(response, 200, { path: relative, status: 'unchanged' });
        return respondJson(response, 409, { error: `${relative} already exists with different content` });
      }
      await mkdir(dirname(absolute), { recursive: true });
      const temporary = `${absolute}.${randomUUID()}.tmp`;
      await writeFile(temporary, body);
      await rename(temporary, absolute);
      respondJson(response, 200, { path: relative, status: 'written' });
      return;
    }

    // Every comment in the deck, with 1-based slide numbers. This is the
    // "see comments" entry point for agents: humans leave instructions as
    // comments, an agent starts by reading this list.
    if (path === '/api/comments' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      const rows: unknown[] = [];
      room.session.deck.slides.forEach((slide, index) => {
        const base = { slide: index + 1, slideId: slide.id, slideName: slide.name };
        for (const comment of slide.comments ?? []) rows.push({ ...base, ...comment });
        for (const element of slide.elements) {
          for (const comment of element.comments ?? []) {
            rows.push({ ...base, elementId: element.id, elementType: element.type, ...comment });
          }
        }
      });
      respondJson(response, 200, { commentCount: rows.length, comments: rows });
      return;
    }

    if (path === '/api/context' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      respondJson(response, 200, {
        deckId: deckParam,
        revision: deckRevision(room.session.deck),
        canvas: room.session.deck.canvas,
        outline: room.session.deck.slides.map((slide, index) => ({
          index: index + 1,
          id: slide.id,
          title: slide.name,
          hidden: Boolean(slide.skipped),
          openComments: [...(slide.comments ?? []), ...slide.elements.flatMap((element) => element.comments ?? [])]
            .filter((comment) => !comment.resolved).length,
        })),
      });
      return;
    }

    // Compact reading-order transcript for building deck-wide narrative
    // context without exposing deck.json or forcing one inspect request per
    // slide. Agents should read this before deciding what a local visual means.
    if (path === '/api/text' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      respondJson(response, 200, {
        deckId: deckParam,
        title: room.session.deck.title,
        revision: deckRevision(room.session.deck),
        slides: room.session.deck.slides.map((slide, index) => ({
          index: index + 1,
          id: slide.id,
          name: slide.name,
          hidden: Boolean(slide.skipped),
          previousSlideId: room.session.deck.slides[index - 1]?.id ?? null,
          nextSlideId: room.session.deck.slides[index + 1]?.id ?? null,
          notes: slide.notes,
          text: slide.elements
            .map((element, elementIndex) => ({ element, elementIndex }))
            .sort((a, b) => a.element.y - b.element.y
              || a.element.x - b.element.x
              || a.element.z - b.element.z
              || a.elementIndex - b.elementIndex)
            .flatMap(({ element }) => {
              const text = element.type === 'text' || element.type === 'html'
                ? plainText(element.html)
                : element.type === 'image' ? element.alt.trim() : '';
              return text ? [{ elementId: element.id, elementType: element.type, text }] : [];
            }),
        })),
      });
      return;
    }

    if (path === '/api/edit-schema' && request.method === 'GET') {
      respondJson(response, 200, nativeEditContract());
      return;
    }

    if (path === '/api/inspect' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      const slideIds = new Set((url.searchParams.get('slideIds') ?? '').split(',').map((id) => id.trim()).filter(Boolean));
      const elementIds = new Set((url.searchParams.get('elementIds') ?? '').split(',').map((id) => id.trim()).filter(Boolean));
      const all = url.searchParams.get('all') === '1';
      if (!all && slideIds.size === 0 && elementIds.size === 0) {
        return respondJson(response, 400, { error: 'provide slideIds, elementIds, or all=1' });
      }
      const selected = room.session.deck.slides.filter((slide) =>
        all || slideIds.has(slide.id) || slide.elements.some((element) => elementIds.has(element.id)));
      const missingSlides = [...slideIds].filter((id) => !room.session.deck.slides.some((slide) => slide.id === id));
      const allElementIds = new Set(room.session.deck.slides.flatMap((slide) => slide.elements.map((element) => element.id)));
      const missingElements = [...elementIds].filter((id) => !allElementIds.has(id));
      if (missingSlides.length > 0 || missingElements.length > 0) {
        return respondJson(response, 404, { error: 'some requested objects do not exist', missingSlides, missingElements });
      }
      respondJson(response, 200, {
        revision: deckRevision(room.session.deck),
        deck: {
          title: room.session.deck.title,
          canvas: room.session.deck.canvas,
          theme: room.session.deck.theme,
          themePreset: room.session.deck.themePreset,
          themeStyle: room.session.deck.themeStyle,
          morphEasing: room.session.deck.morphEasing,
        },
        slides: selected.map((slide) => inspectNativeSlide(room.session.deck, slide)),
      });
      return;
    }

    if (path === '/api/preview-edits' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const raw = JSON.parse((await readBody(request)).toString('utf8')) as unknown;
      const parsed = NativeEditRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return respondJson(response, 400, {
          error: 'invalid native edit request',
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        });
      }
      const room = await getRoom(deckParam);
      const revision = deckRevision(room.session.deck);
      if (parsed.data.expectedRevision && parsed.data.expectedRevision !== revision) {
        return respondJson(response, 409, { error: 'revision conflict', expected: parsed.data.expectedRevision, current: revision });
      }
      let edited: ReturnType<typeof applyNativeEdits>;
      try {
        edited = applyNativeEdits(room.session.deck, parsed.data.edits);
        validateNativeEditSafety(room.session.deck, edited.deck, room.session.dir);
      } catch (error) {
        return respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      const beforeSlides = edited.affectedSlideIds
        .map((id) => room.session.deck.slides.find((slide) => slide.id === id))
        .filter((slide): slide is Slide => Boolean(slide));
      const afterSlides = edited.affectedSlideIds
        .map((id) => edited.deck.slides.find((slide) => slide.id === id))
        .filter((slide): slide is Slide => Boolean(slide));
      const [beforeOverflows, afterOverflows] = await Promise.all([
        measureBuiltTextOverflows(room.session.dir, room.session.deck, beforeSlides),
        measureBuiltTextOverflows(room.session.dir, edited.deck, afterSlides),
      ]);
      const report = {
        beforeOverflows,
        afterOverflows,
        newOrWorsenedOverflows: newOrWorsenedOverflows(beforeOverflows, afterOverflows),
      };
      const id = randomUUID();
      const draft: HttpNativeDraft = {
        id,
        deckId: deckParam,
        revision,
        before: structuredClone(room.session.deck),
        after: edited.deck,
        operations: edited.operations,
        affectedSlideIds: edited.affectedSlideIds,
        affectedElementIds: edited.affectedElementIds,
        report,
        createdAt: Date.now(),
      };
      nativeDrafts.set(id, draft);
      const draftViewUrl = (side: 'before' | 'after', slideId?: string): string => {
        const params = new URLSearchParams({ deck: deckParam });
        if (slideId) params.set('slideId', slideId);
        return `/api/edit-drafts/${id}/${side}?${params.toString()}`;
      };
      const comparisonUrl = `/api/edit-drafts/${id}/compare?deck=${encodeURIComponent(deckParam)}`;
      const nativePreview: NativeDraftPreview = {
        draftId: id,
        deckId: deckParam,
        slideCount: draft.affectedSlideIds.length,
        beforeUrl: `http://127.0.0.1:${boundPort}${draftViewUrl('before')}`,
        afterUrl: `http://127.0.0.1:${boundPort}${draftViewUrl('after')}`,
        comparisonUrl: `http://127.0.0.1:${boundPort}${comparisonUrl}`,
      };
      options.onNativeDraft?.(nativePreview);
      if (sharedAgent && agentSessionParam) {
        sharedAgent.setScratchpad(deckDirOf(deckParam), agentSessionParam, {
          draftId: nativePreview.draftId,
          slideCount: nativePreview.slideCount,
          sourceUrl: nativePreview.beforeUrl,
          importedUrl: nativePreview.afterUrl,
          comparisonUrl: nativePreview.comparisonUrl,
          sourceContactSheetUrl: nativePreview.beforeUrl,
          importedContactSheetUrl: nativePreview.afterUrl,
          sourceLabel: 'Before',
          importedLabel: 'After',
        });
      }
      respondJson(response, 200, {
        draftId: id,
        revision,
        affectedSlideIds: draft.affectedSlideIds,
        affectedElementIds: draft.affectedElementIds,
        operations: draft.operations,
        comparisonUrl,
        beforeUrl: draftViewUrl('before'),
        afterUrl: draftViewUrl('after'),
        slides: draft.affectedSlideIds.map((slideId) => ({
          slideId,
          beforeUrl: draftViewUrl('before', slideId),
          afterUrl: draftViewUrl('after', slideId),
        })),
        report,
      });
      return;
    }

    const nativeDraftView = /^\/api\/edit-drafts\/([^/]+)\/(before|after)$/.exec(path);
    if (nativeDraftView && request.method === 'GET') {
      const draft = nativeDrafts.get(nativeDraftView[1]);
      if (!draft || draft.deckId !== deckParam) return respondJson(response, 404, { error: 'draft not found' });
      const deck = nativeDraftView[2] === 'before' ? draft.before : draft.after;
      const requestedSlide = url.searchParams.get('slideId');
      const ids = requestedSlide ? [requestedSlide] : draft.affectedSlideIds;
      const slides = ids.map((id) => deck.slides.find((slide) => slide.id === id)).filter((slide): slide is Slide => Boolean(slide));
      if (requestedSlide && slides.length === 0) return respondJson(response, 404, { error: `no affected slide ${requestedSlide}` });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      const html = slidesToHtml(slides, deck.canvas, {
        typeCss: PLAYER_TYPE_CSS,
        base: `/decks/${encodeURIComponent(deckParam)}/`,
        theme: `/api/theme?deck=${encodeURIComponent(deckParam)}`,
      });
      const scratchpad = url.searchParams.get('scratchpad');
      response.end(scratchpad === 'slides' || scratchpad === 'contact'
        ? scratchpadDocument(html, scratchpad)
        : html);
      return;
    }

    const nativeDraftComparison = /^\/api\/edit-drafts\/([^/]+)\/compare$/.exec(path);
    if (nativeDraftComparison && request.method === 'GET') {
      const draft = nativeDrafts.get(nativeDraftComparison[1]);
      if (!draft || draft.deckId !== deckParam) return respondJson(response, 404, { error: 'draft not found' });
      const mode = draft.affectedSlideIds.length > 1 ? 'contact' : 'slides';
      const deck = encodeURIComponent(draft.deckId);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(sideBySideComparisonDocument({
        title: 'Before / After comparison',
        left: { label: 'Before', url: `/api/edit-drafts/${draft.id}/before?deck=${deck}&scratchpad=${mode}` },
        right: { label: 'After', url: `/api/edit-drafts/${draft.id}/after?deck=${deck}&scratchpad=${mode}` },
      }));
      return;
    }

    if (path === '/api/apply-edits' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const payload = JSON.parse((await readBody(request)).toString('utf8')) as {
        draftId?: string; expectedRevision?: string; idempotencyKey?: string; label?: string;
      };
      if (!payload.idempotencyKey) return respondJson(response, 400, { error: 'missing idempotencyKey' });
      const key = `${deckParam}:${payload.idempotencyKey}`;
      const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      const prior = nativeIdempotency.get(key);
      if (prior) {
        if (prior.digest !== digest) return respondJson(response, 409, { error: 'idempotency key reused for a different request' });
        return respondJson(response, 200, { ...prior, idempotent: true, digest: undefined });
      }
      const draft = payload.draftId ? nativeDrafts.get(payload.draftId) : null;
      if (!draft || draft.deckId !== deckParam) return respondJson(response, 404, { error: 'draft not found' });
      if (draft.report.newOrWorsenedOverflows.length > 0) {
        return respondJson(response, 422, {
          error: 'native edit introduces or worsens text overflow; revise the patch before applying',
          report: draft.report,
        });
      }
      const room = await getRoom(deckParam);
      const current = deckRevision(room.session.deck);
      const expected = payload.expectedRevision ?? draft.revision;
      if (current !== expected || draft.revision !== expected) {
        return respondJson(response, 409, { error: 'revision conflict', expected, current });
      }
      // Validate against the strict transaction engine before the collaboration
      // layer applies its intentionally lenient replay semantics.
      const strict = applyAgentTransaction(room.session.deck, {
        version: 1,
        expectedRevision: current,
        label: payload.label?.trim().slice(0, 200) || 'Agent: edit presentation properties',
        operations: draft.operations,
      });
      if (JSON.stringify(strict) !== JSON.stringify(draft.after)) {
        return respondJson(response, 409, { error: 'draft no longer reproduces the previewed deck', current });
      }
      const label = payload.label?.trim().slice(0, 200) || 'Agent: edit presentation properties';
      const applied = room.session.applyOps(draft.operations);
      if (applied.skipped.length > 0) {
        return respondJson(response, 409, { error: 'native edit could not apply atomically', skipped: applied.skipped });
      }
      broadcast(room, {
        kind: 'txn', seq: applied.seq, txnId: `agent-http-${randomUUID()}`,
        byClientId: 'agent-http', label, ops: draft.operations,
        agentChatId: agentChatId(deckParam, agentSessionParam) ?? undefined,
      });
      const result = {
        digest,
        revision: deckRevision(applied.deck),
        slideIds: draft.affectedSlideIds,
        elementIds: draft.affectedElementIds,
        label,
        playerUrls: draft.affectedSlideIds.map((slideId) => ({
          slideId,
          url: `/present.html?deck=${encodeURIComponent(deckParam)}&slide=${applied.deck.slides.findIndex((slide) => slide.id === slideId) + 1}&agent=1`,
        })),
        stopCondition: 'The apply succeeds and one returned real-player URL shows the requested edit correctly. Stop unless that check reveals a task-relevant defect.',
      };
      nativeIdempotency.set(key, result);
      if (localAgents && agentSessionParam) {
        localAgents.event(room.session.dir, agentSessionParam, { text: `applied edits: ${label}` });
      }
      respondJson(response, 200, { ...result, idempotent: false, digest: undefined });
      return;
    }

    if (path === '/api/comments' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const body = JSON.parse((await readBody(request)).toString('utf8')) as {
        slideId?: string; elementId?: string; parentId?: string; author?: string; text?: string;
      };
      if (!body.text?.trim()) return respondJson(response, 400, { error: 'missing text' });
      const room = await getRoom(deckParam);
      const slide = body.slideId
        ? room.session.deck.slides.find((candidate) => candidate.id === body.slideId)
        : room.session.deck.slides.find((candidate) => candidate.elements.some((element) => element.id === body.elementId));
      if (!slide) return respondJson(response, 404, { error: 'no such slide or element' });
      const owner = body.elementId ? slide.elements.find((element) => element.id === body.elementId) : slide;
      if (!owner) return respondJson(response, 404, { error: 'no such element' });
      const comment = {
        id: `comment-${randomUUID()}`,
        author: body.author?.trim() || 'Agent',
        text: body.text.trim(),
        ts: new Date().toISOString(),
        resolved: false,
        ...(body.parentId ? { parentId: body.parentId } : {}),
      };
      const next = structuredClone(owner);
      (next.comments ??= []).push(comment);
      const operation: AgentOperation = 'elements' in owner
        ? { op: 'replaceSlide', slideId: slide.id, slide: next as typeof slide }
        : { op: 'replaceElement', slideId: slide.id, elementId: owner.id, element: next as typeof owner };
      const applied = room.session.applyOps([operation]);
      broadcast(room, {
        kind: 'deck', seq: applied.seq, deck: applied.deck, reason: 'agent-edit',
        label: `The Agent added a comment${body.slideId ? ` to slide ${body.slideId}` : ''}: ${body.text.trim().slice(0, 160)}`,
        agentChatId: agentChatId(deckParam, agentSessionParam) ?? undefined,
      });
      if (localAgents && agentSessionParam) {
        const number = room.session.deck.slides.findIndex((candidate) => candidate.id === slide.id) + 1;
        localAgents.event(room.session.dir, agentSessionParam, { text: `added a comment on slide ${number}` });
      }
      respondJson(response, 200, comment);
      return;
    }

    if (path === '/api/comments/resolve' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const body = JSON.parse((await readBody(request)).toString('utf8')) as { commentId?: string; resolved?: boolean };
      if (!body.commentId) return respondJson(response, 400, { error: 'missing commentId' });
      const room = await getRoom(deckParam);
      let operation: AgentOperation | null = null;
      for (const slide of room.session.deck.slides) {
        const slideComment = slide.comments?.find((comment) => comment.id === body.commentId);
        if (slideComment) {
          const next = structuredClone(slide);
          next.comments!.find((comment) => comment.id === body.commentId)!.resolved = body.resolved ?? true;
          operation = { op: 'replaceSlide', slideId: slide.id, slide: next };
          break;
        }
        for (const element of slide.elements) {
          if (!element.comments?.some((comment) => comment.id === body.commentId)) continue;
          const next = structuredClone(element);
          next.comments!.find((comment) => comment.id === body.commentId)!.resolved = body.resolved ?? true;
          operation = { op: 'replaceElement', slideId: slide.id, elementId: element.id, element: next };
          break;
        }
        if (operation) break;
      }
      if (!operation) return respondJson(response, 404, { error: 'no such comment' });
      const applied = room.session.applyOps([operation]);
      broadcast(room, {
        kind: 'deck', seq: applied.seq, deck: applied.deck, reason: 'agent-edit',
        label: `The Agent marked comment ${body.commentId} ${body.resolved ?? true ? 'resolved' : 'unresolved'}.`,
        agentChatId: agentChatId(deckParam, agentSessionParam) ?? undefined,
      });
      respondJson(response, 200, { ok: true, resolved: body.resolved ?? true });
      return;
    }

    if (path === '/api/preview-html' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const previewStartedAt = Date.now();
      const raw = (await readBody(request)).toString('utf8');
      const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
      let payload: { html?: string; target?: HttpHtmlDraft['target'] };
      if (contentType.startsWith('text/html')) {
        const mode = url.searchParams.get('mode');
        const slideIds = (url.searchParams.get('slideIds') ?? '')
          .split(',').map((id) => id.trim()).filter(Boolean);
        if (mode === 'replace' && slideIds.length === 0) {
          return respondJson(response, 400, { error: 'raw HTML replacement requires slideIds' });
        }
        payload = {
          html: raw,
          ...(mode === 'replace'
            ? { target: { mode, slideIds } }
            : mode === 'insert'
              ? { target: { mode, afterSlideId: url.searchParams.get('afterSlideId') || null } }
              : {}),
        };
      } else {
        payload = JSON.parse(raw) as {
          html?: string;
          target?: HttpHtmlDraft['target'];
        };
      }
      if (!payload.html?.trim()) return respondJson(response, 400, { error: 'missing html' });
      const room = await getRoom(deckParam);
      const compiledDraft = await compileHtmlDraft(deckParam, room, payload.html, payload.target, agentSessionParam, previewStartedAt);
      if ('error' in compiledDraft) return respondJson(response, 400, { error: compiledDraft.error });
      respondJson(response, 200, compiledDraft.body);
      return;
    }

    if (path === '/api/html-drafts/latest' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const id = latestHtmlDrafts.get(deckParam);
      const draft = id ? htmlDrafts.get(id) : null;
      if (!draft) return respondJson(response, 404, { error: 'draft not found' });
      const query = `?deck=${encodeURIComponent(deckParam)}`;
      respondJson(response, 200, {
        workflow: draft.workflow,
        blockingIssues: draft.workflow.blockingIssues,
        nextAction: draft.workflow.nextAction,
        draftId: draft.id,
        revision: draft.revision,
        slideCount: draft.slides.length,
        sourceUrl: `/api/html-drafts/${draft.id}/source${query}`,
        importedUrl: `/api/html-drafts/${draft.id}/imported${query}`,
        comparisonUrl: `/api/html-drafts/${draft.id}/compare${query}`,
        sourceContactSheetUrl: `/api/html-drafts/${draft.id}/source/contact-sheet.png${query}`,
        importedContactSheetUrl: `/api/html-drafts/${draft.id}/imported/contact-sheet.png${query}`,
        report: draft.report,
        target: draft.target,
      });
      return;
    }

    const draftView = /^\/api\/html-drafts\/([^/]+)\/(source|imported)$/.exec(path);
    if (draftView && request.method === 'GET') {
      const draft = htmlDrafts.get(draftView[1]);
      if (!draft || draft.deckId !== deckParam) return respondJson(response, 404, { error: 'draft not found' });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      const html = draftView[2] === 'source' ? draft.sourceHtml : draft.importedHtml;
      const scratchpad = url.searchParams.get('scratchpad');
      response.end(scratchpad === 'slides' || scratchpad === 'contact'
        ? scratchpadDocument(html, scratchpad)
        : html);
      return;
    }

    const draftComparison = /^\/api\/html-drafts\/([^/]+)\/compare$/.exec(path);
    if (draftComparison && request.method === 'GET') {
      const draft = htmlDrafts.get(draftComparison[1]);
      if (!draft || draft.deckId !== deckParam) return respondJson(response, 404, { error: 'draft not found' });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(htmlDraftComparisonDocument(draft));
      return;
    }

    const draftRender = /^\/api\/html-drafts\/([^/]+)\/(source|imported)\/(contact-sheet|slide-(\d+))\.png$/.exec(path);
    if (draftRender && request.method === 'GET') {
      const draft = htmlDrafts.get(draftRender[1]);
      if (!draft || draft.deckId !== deckParam) return respondJson(response, 404, { error: 'draft not found' });
      const room = await getRoom(draft.deckId);
      const slideNumber = draftRender[4] ? Number(draftRender[4]) : null;
      const themeHref = `/api/theme?deck=${encodeURIComponent(draft.deckId)}`;
      const cacheKey = `${draftRender[2]}:${slideNumber ?? 'contact'}`;
      let pending = draft.renderCache.get(cacheKey);
      const cacheHit = Boolean(pending);
      const renderStartedAt = Date.now();
      if (!pending) {
        pending = renderHtmlDraftPng(
          draftRender[2] === 'source' ? draft.sourceHtml : draft.importedHtml,
          room.session.deck.canvas,
          slideNumber === null ? null : slideNumber - 1,
          {
            base: pathToFileURL(`${room.session.dir}/`).href,
            stylesheets: [{ href: themeHref, css: await loadTheme(room.session.dir, room.session.deck.theme) }],
          },
        );
        draft.renderCache.set(cacheKey, pending);
      }
      let png: Buffer;
      try { png = await pending; }
      catch (error) { draft.renderCache.delete(cacheKey); throw error; }
      response.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': String(png.length),
        'server-timing': `draft-render;dur=${Date.now() - renderStartedAt}`,
        'x-deckwerk-render-cache': cacheHit ? 'hit' : 'miss',
      });
      response.end(png);
      return;
    }

    if (path === '/api/apply-html' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const payload = JSON.parse((await readBody(request)).toString('utf8')) as {
        draftId?: string; expectedRevision?: string; idempotencyKey?: string; label?: string; target?: HttpHtmlDraft['target'];
      };
      if (!payload.idempotencyKey) return respondJson(response, 400, { error: 'missing idempotencyKey' });
      const prior = htmlIdempotency.get(payload.idempotencyKey);
      if (prior) return respondJson(response, 200, { ...prior, idempotent: true });
      const draft = payload.draftId ? htmlDrafts.get(payload.draftId) : null;
      if (!draft || draft.deckId !== deckParam) return respondJson(response, 404, { error: 'draft not found' });
      const blockingDiagnostics = ['overflows', 'missingAssets', 'blockedResources']
        .filter((key) => Array.isArray(draft.report[key]) && (draft.report[key] as unknown[]).length > 0);
      if (blockingDiagnostics.length > 0) {
        return respondJson(response, 422, {
          error: 'draft has blocking import diagnostics; preview and revise before applying',
          workflow: draft.workflow,
          blockingIssues: draft.workflow.blockingIssues,
          nextAction: draft.workflow.nextAction,
          blockingDiagnostics,
          report: draft.report,
        });
      }
      const room = await getRoom(deckParam);
      const current = deckRevision(room.session.deck);
      const expected = payload.expectedRevision ?? draft.revision;
      if (current !== expected || draft.revision !== expected) {
        return respondJson(response, 409, { error: 'revision conflict', expected, current });
      }
      const target = payload.target ?? draft.target;
      const operations: AgentOperation[] = [];
      const appliedIds: string[] = [];
      if (target.mode === 'insert') {
        operations.push({ op: 'insertSlides', afterSlideId: target.afterSlideId ?? null, slides: draft.slides });
        appliedIds.push(...draft.slides.map((slide) => slide.id));
      } else {
        const ids = target.slideIds ?? [];
        if (ids.length === 0) return respondJson(response, 400, { error: 'replacement requires at least one target slide' });
        if (new Set(ids).size !== ids.length) return respondJson(response, 400, { error: 'replacement target contains duplicate slide ids' });
        const missing = ids.find((id) => !room.session.deck.slides.some((slide) => slide.id === id));
        if (missing) return respondJson(response, 404, { error: `no slide ${missing}` });
        const plan = planHtmlReplacement(room.session.deck, ids, draft.slides);
        operations.push(...plan.operations);
        appliedIds.push(...plan.appliedSlideIds);
      }
      const label = payload.label?.trim().slice(0, 200) || 'Agent: apply HTML slides';
      const applied = room.session.applyOps(operations);
      // This is a collaboration transaction, not an anonymous external deck
      // replacement. Broadcasting the actual operations and label lets every
      // editor record a distinct, restorable History revision.
      broadcast(room, {
        kind: 'txn',
        seq: applied.seq,
        txnId: `agent-http-${randomUUID()}`,
        byClientId: 'agent-http',
        label,
        ops: operations,
        agentChatId: agentChatId(deckParam, agentSessionParam) ?? undefined,
      });
      const playerUrls = appliedIds.map((slideId) => {
        const index = applied.deck.slides.findIndex((slide) => slide.id === slideId);
        return {
          slideId,
          url: `/present.html?deck=${encodeURIComponent(deckParam)}&slide=${index + 1}&agent=1`,
          pngUrl: `/api/render-slide.png?deck=${encodeURIComponent(deckParam)}&slideId=${encodeURIComponent(slideId)}`,
        };
      });
      const result = {
        revision: deckRevision(applied.deck), slideIds: appliedIds, label, playerUrls,
        stopCondition: draft.workflow.verificationPolicy.stopWhen,
      };
      htmlIdempotency.set(payload.idempotencyKey, result);
      if (localAgents && agentSessionParam) {
        localAgents.event(room.session.dir, agentSessionParam, {
          text: `applied HTML: ${appliedIds.length} slide${appliedIds.length === 1 ? '' : 's'} (${label})`,
        });
      }
      respondJson(response, 200, { ...result, idempotent: false });
      return;
    }

    if (path === '/api/render-slide.png' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const slideId = url.searchParams.get('slideId');
      if (!slideId) return respondJson(response, 400, { error: 'missing slideId' });
      const room = await getRoom(deckParam);
      const slide = room.session.deck.slides.find((candidate) => candidate.id === slideId);
      if (!slide) return respondJson(response, 404, { error: `no slide ${slideId}` });
      publishAgentPresence(room, slideId);
      const html = slidesToHtml([slide], room.session.deck.canvas, {
        typeCss: PLAYER_TYPE_CSS,
        base: `/decks/${encodeURIComponent(deckParam)}/`,
        theme: `/api/theme?deck=${encodeURIComponent(deckParam)}`,
      });
      const png = await renderHtmlDraftPng(html, room.session.deck.canvas, 0, {
        base: pathToFileURL(`${room.session.dir}/`).href,
        stylesheets: [{
          href: `/api/theme?deck=${encodeURIComponent(deckParam)}`,
          css: await loadTheme(room.session.dir, room.session.deck.theme),
        }],
      });
      response.writeHead(200, {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'content-length': String(png.length),
      });
      response.end(png);
      return;
    }

    if (path === '/api/render-slide' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const slideId = url.searchParams.get('slideId');
      if (!slideId) return respondJson(response, 400, { error: 'missing slideId' });
      const room = await getRoom(deckParam);
      const index = room.session.deck.slides.findIndex((slide) => slide.id === slideId);
      if (index < 0) return respondJson(response, 404, { error: `no slide ${slideId}` });
      // The real-player URL is the point at which the agent declares what it
      // is visually inspecting. Surface that slide in every connected editor.
      publishAgentPresence(room, slideId);
      respondJson(response, 200, {
        slideId,
        slide: index + 1,
        url: `/present.html?deck=${encodeURIComponent(deckParam)}&slide=${index + 1}&agent=1`,
        pngUrl: `/api/render-slide.png?deck=${encodeURIComponent(deckParam)}&slideId=${encodeURIComponent(slideId)}`,
      });
      return;
    }

    if (path === '/api/theme') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
      response.end(room.session.themeCss);
      return;
    }

    // Static client bundle.
    if (!clientDir) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('no client bundle configured (dev mode: use the vite dev server)');
      return;
    }
    const relative = normalize(path).replace(/^([/\\]|\.\.)+/, '');
    const file = join(clientDir, relative === '' || relative === '.' ? 'index.html' : relative);
    // Served like assets: vite's hashed output is immutable, the HTML shells
    // revalidate with an ETag. `no-store` here made every click on Present
    // re-download the whole bundle — over a slow link, behind the deck's own
    // video fetches, that was seconds of black screen every single time.
    await serveFileWithRanges(request, response, file, [CONTENT_HASHED_NAME, VITE_HASHED_NAME]);
  }

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const deckId = url.searchParams.get('deck');
    if (!deckId) {
      socket.close(4000, 'missing deck parameter');
      return;
    }

    // Opening the room reads files; pause the socket so a hello frame sent
    // immediately after the handshake isn't emitted before a listener exists.
    socket.pause();
    void (async () => {
      // The upgrade request carries the same loopback socket and tailscale
      // serve headers as any HTTP request, so the identity rules match.
      let identity: Identity | null = null;
      if (accessControl) {
        identity = resolveIdentity(request, accessControl);
        if (!identity || !(await deckAllowed(identity, deckId))) {
          // Resume first: the close handshake needs to read the client's
          // close frame, which a paused socket never would.
          socket.resume();
          socket.close(4003, 'you do not have access to this deck');
          return;
        }
        if (userDirectory) void userDirectory.note(identity);
      }
      let room: Room;
      try {
        room = await getRoom(deckId);
      } catch (error) {
        socket.close(4004, String(error instanceof Error ? error.message : error).slice(0, 120));
        return;
      }
      bindPeer(room, socket, identity);
      socket.resume();
    })();
  });

  function bindPeer(room: Room, socket: WebSocket, identity: Identity | null): void {
    const clientId = randomUUID();
    const peer: Peer = {
      socket,
      greeted: false,
      identity,
      agentFor: null,
      state: {
        clientId,
        name: '',
        color: '',
        activeSlideId: null,
        selectedSlideIds: [],
        selectedElementIds: [],
        editingElementId: null,
        cursor: null,
      },
    };
    room.peers.set(clientId, peer);

    socket.on('message', (raw) => {
      let message;
      try {
        message = ClientMessageSchema.parse(renameRetiredFields(JSON.parse(String(raw))));
      } catch {
        return; // Trusted network; a malformed frame is a bug, not an attack. Drop it.
      }

      if (message.kind === 'hello') {
        if (message.agentFor && localAgents) {
          // A bridge speaks for exactly one browser participant. With access
          // control on, that participant must already be — or become — the
          // same tailnet login; anybody else's agent is refused.
          const owner = room.participantLogins.get(message.agentFor);
          if (identity && owner && owner !== identity.login) {
            socket.close(4003, 'that participant belongs to someone else');
            return;
          }
          if (identity) room.participantLogins.set(message.agentFor, identity.login);
          peer.agentFor = message.agentFor;
          peer.state.agent = true;
        } else if (message.participant) {
          peer.state.participant = message.participant;
          if (identity) {
            const owner = room.participantLogins.get(message.participant);
            if (owner && owner !== identity.login) {
              socket.close(4003, 'that participant id belongs to someone else');
              return;
            }
            room.participantLogins.set(message.participant, identity.login);
          }
        }
        room.guestCounter += 1;
        // With access control on, presence carries the authenticated identity —
        // a client-supplied name is only trusted on the flagless server.
        const person = identity?.name || message.name?.trim() || `Guest ${room.guestCounter}`;
        peer.state.name = peer.agentFor && identity ? `${identity.name} · agent` : person;
        peer.state.color = pickColor(room.peers);
        peer.greeted = true;
        if (peer.agentFor && localAgents) {
          localAgents.attach(room.session.dir, peer.agentFor, {
            clientId, name: peer.state.name, connectedAt: new Date().toISOString(),
          });
        }
        send(peer, {
          kind: 'welcome',
          version: COLLAB_PROTOCOL_VERSION,
          clientId,
          self: { name: peer.state.name, color: peer.state.color },
          seq: room.session.seq,
          deck: room.session.deck,
          themeCss: room.session.themeCss,
          peers: [
            ...[...room.peers.values()]
              .filter((p) => p !== peer && p.greeted)
              .map((p) => p.state),
            ...(room.agentPresence ? [room.agentPresence] : []),
          ],
        });
        broadcast(room, { kind: 'presence', state: peer.state }, clientId);
        return;
      }
      if (!peer.greeted) return;

      switch (message.kind) {
        case 'txn': {
          try {
            const applied = room.session.applyOps(message.ops);
            broadcast(room, {
              kind: 'txn',
              seq: applied.seq,
              txnId: message.txnId,
              byClientId: clientId,
              label: message.label,
              ops: message.ops,
            });
          } catch (error) {
            console.error(`txn rejected: ${String(error)}`);
            send(peer, { kind: 'deck', seq: room.session.seq, deck: room.session.deck, reason: 'resync' });
          }
          return;
        }
        case 'presence':
          peer.state = {
            ...peer.state,
            activeSlideId: message.activeSlideId,
            selectedSlideIds: message.selectedSlideIds,
            selectedElementIds: message.selectedElementIds,
            editingElementId: message.editingElementId,
          };
          broadcast(room, { kind: 'presence', state: peer.state }, clientId);
          return;
        case 'cursor':
          peer.state.cursor = message.cursor;
          broadcast(room, { kind: 'cursor', clientId, cursor: message.cursor }, clientId);
          return;
        case 'theme':
          room.session.saveThemeCss(message.css);
          broadcast(room, { kind: 'theme', css: message.css, byClientId: clientId }, clientId);
          return;
        case 'agentEvent':
          if (peer.agentFor && localAgents) {
            localAgents.event(room.session.dir, peer.agentFor, {
              text: message.text, busy: message.busy, error: message.error,
            });
          }
          return;
      }
    });

    socket.on('close', () => {
      room.peers.delete(clientId);
      if (peer.greeted) broadcast(room, { kind: 'peerLeft', clientId });
      if (peer.agentFor && localAgents) localAgents.detach(room.session.dir, peer.agentFor, clientId);
    });
  }

  const port = await new Promise<number>((resolvePromise, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 5800, host, () => {
      const address = httpServer.address();
      resolvePromise(typeof address === 'object' && address ? address.port : options.port ?? 5800);
    });
  });
  boundPort = port;
  unsubscribeSharedAgent = sharedAgent?.subscribe(emitSharedAgentState);

  return {
    port,
    urls: reachableUrls(host, port),
    flush: async () => {
      await Promise.all([...rooms.values()].map((room) => room.session.flush()));
    },
    notifyEnded: () => {
      for (const room of rooms.values()) broadcast(room, { kind: 'ended' });
    },
    close: async () => {
      wss.close();
      unsubscribeSharedAgent?.();
      for (const stream of sharedAgentStreams) stream.response.end();
      sharedAgentStreams.clear();
      for (const room of rooms.values()) {
        // Shutdown cannot wait for a renderer that is paused, presenting, or
        // already tearing down to complete the WebSocket close handshake.
        // Upgraded sockets are not covered by closeAllConnections(), so end
        // them synchronously before awaiting the HTTP server's close callback.
        for (const peer of room.peers.values()) peer.socket.terminate();
      }
      // `close()` alone only stops new connections: it waits for every open
      // one to go idle first. A browser leaves plenty that never will — a
      // <video> that buffered enough and stopped reading its range response
      // keeps that response open indefinitely — so the await never returned
      // and "End collaboration" hung with the shell still on screen. Ending
      // the session means disconnecting everyone, so tear the sockets down.
      await new Promise<void>((resolvePromise) => {
        httpServer.close(() => resolvePromise());
        httpServer.closeAllConnections();
      });
      for (const room of rooms.values()) await room.session.close();
      sharedAgent?.close();
    },
  };
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const remote = request.socket.remoteAddress ?? '';
  return remote === '127.0.0.1'
    || remote === '::1'
    || remote === '::ffff:127.0.0.1';
}

function sharedParticipantId(url: URL): string | null {
  return normalizeSharedParticipantId(url.searchParams.get('participant'));
}

function normalizeSharedParticipantId(value: string | null): string | null {
  if (!value || !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) return null;
  return value;
}

function pickColor(peers: Map<string, Peer>): string {
  const used = new Map<string, number>();
  for (const peer of peers.values()) {
    if (peer.state.color) used.set(peer.state.color, (used.get(peer.state.color) ?? 0) + 1);
  }
  let best = PALETTE[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const color of PALETTE) {
    const count = used.get(color) ?? 0;
    if (count < bestCount) {
      best = color;
      bestCount = count;
    }
  }
  return best;
}

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolvePromise(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sanitizeFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return base || 'upload';
}

async function downloadPublicAsset(raw: string): Promise<{ bytes: Buffer; url: URL }> {
  let current = new URL(raw);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await assertPublicHttpUrl(current);
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('asset redirect has no location');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`asset download failed (${response.status})`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > 100 * 1024 * 1024) throw new Error('asset is larger than 100 MB');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('asset is larger than 100 MB');
    return { bytes, url: current };
  }
  throw new Error('asset has too many redirects');
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('asset URL must use HTTP or HTTPS');
  if (url.username || url.password) throw new Error('asset URL must not contain credentials');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('asset URL must be public');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('asset URL must be public');
  }
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value === '::1' || value === '::' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(value)?.[1];
  const ipv4 = mapped ?? (isIP(value) === 4 ? value : '');
  if (!ipv4) return false;
  const [a, b] = ipv4.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function inspectNativeSlide(deck: Deck, slide: Slide): Record<string, unknown> {
  const index = deck.slides.findIndex((candidate) => candidate.id === slide.id);
  const texts = slide.elements.filter((element): element is Extract<SlideElement, { type: 'text' }> => element.type === 'text');
  const inferredTitle = texts
    .filter((element) => plainText(element.html).length > 0 && element.y < deck.canvas.h * 0.48)
    .sort((a, b) => titleScore(b) - titleScore(a))[0]?.id ?? null;
  const { elements: _elements, comments: _comments, ...properties } = structuredClone(slide);
  return {
    index: index + 1,
    id: slide.id,
    properties,
    elements: slide.elements.map((element) => {
      const explicit = element.class.find((name) => /^role-(title|heading|body|caption)$/.test(name));
      const role = explicit?.slice('role-'.length)
        ?? (element.type === 'text' && element.id === inferredTitle ? 'title' : element.type === 'text' ? 'body' : null);
      const roleStyle = role && deck.themeStyle
        ? deck.themeStyle.fonts[role as keyof typeof deck.themeStyle.fonts] ?? deck.themeStyle.fonts.base
        : deck.themeStyle?.fonts.base;
      return {
        ...structuredClone(element),
        ...(element.type === 'text' ? {
          plainText: plainText(element.html),
          semanticRole: role,
          roleSource: explicit ? 'class' : element.id === inferredTitle ? 'inferred' : 'default',
          effectiveTypography: {
            family: element.style['font-family'] ?? roleStyle?.family ?? null,
            size: Number.parseFloat(element.style['font-size'] ?? '') || roleStyle?.size || null,
            weight: Number.parseFloat(element.style['font-weight'] ?? '') || roleStyle?.weight || null,
            lineHeight: element.style['line-height'] ?? roleStyle?.lineHeight ?? null,
            letterSpacing: element.style['letter-spacing'] ?? roleStyle?.letterSpacing ?? null,
            color: element.style.color ?? roleStyle?.color ?? deck.themeStyle?.colors.text ?? null,
          },
        } : {}),
      };
    }),
  };
}

function titleScore(element: Extract<SlideElement, { type: 'text' }>): number {
  const size = Number.parseFloat(element.style['font-size'] ?? '') || 0;
  return size * 20 + element.w - element.y * 0.5;
}

function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function newOrWorsenedOverflows(before: TextOverflow[], after: TextOverflow[]): TextOverflow[] {
  const prior = new Map(before.map((overflow) => [`${overflow.slideId ?? ''}:${overflow.elementId ?? ''}`, overflow]));
  return after.filter((overflow) => {
    const previous = prior.get(`${overflow.slideId ?? ''}:${overflow.elementId ?? ''}`);
    if (!previous) return true;
    if (overflow.overflowX && !previous.overflowX) return true;
    if (overflow.overflowY && !previous.overflowY) return true;
    return overflow.beyond.x > previous.beyond.x + 1 || overflow.beyond.y > previous.beyond.y + 1;
  });
}

function validateNativeEditSafety(before: Deck, after: Deck, deckDir: string): void {
  const beforeSlides = new Map(before.slides.map((slide) => [slide.id, slide]));
  for (const slide of after.slides) {
    const previousSlide = beforeSlides.get(slide.id);
    if (previousSlide && slide.background.image !== previousSlide.background.image) {
      validateEditedAsset(slide.background.image, deckDir, `slide ${slide.id} background.image`);
    }
    const beforeElements = new Map(previousSlide?.elements.map((element) => [element.id, element]) ?? []);
    for (const element of slide.elements) {
      const previous = beforeElements.get(element.id);
      if (!previous || JSON.stringify(previous) === JSON.stringify(element)) continue;
      for (const [property, value] of Object.entries(element.style)) {
        if (/(?:javascript\s*:|@import\b|https?:|data:)/i.test(value)) {
          throw new Error(`element ${element.id} style.${property} contains a blocked external or executable resource`);
        }
      }
      if (element.type === 'text') {
        for (const [property, value] of Object.entries(element.contentStyle ?? {})) {
          if (/(?:javascript\s*:|@import\b|https?:|data:)/i.test(value)) {
            throw new Error(`element ${element.id} contentStyle.${property} contains a blocked external or executable resource`);
          }
        }
      }
      if (element.type === 'text' || element.type === 'html') {
        if (unsafePatchedMarkup(element.html)) {
          throw new Error(`element ${element.id} HTML contains scripts, event handlers, embedded documents, or external runtime resources`);
        }
      }
      if (element.type === 'html' && element.css
        && /(?:javascript\s*:|@import\b|https?:|data:)/i.test(element.css)) {
        throw new Error(`element ${element.id} CSS contains a blocked external or executable resource`);
      }
      if (element.type === 'image' || element.type === 'video') {
        const old = previous && (previous.type === 'image' || previous.type === 'video') ? previous : null;
        if (element.src !== old?.src) validateEditedAsset(element.src, deckDir, `element ${element.id} src`);
        if (element.type === 'video' && element.poster !== (old?.type === 'video' ? old.poster : null)) {
          validateEditedAsset(element.poster, deckDir, `element ${element.id} poster`);
        }
      }
    }
  }
}

function unsafePatchedMarkup(html: string): boolean {
  return /<\s*(?:script|style|link|base|meta|iframe|object|embed)\b/i.test(html)
    || /\son[a-z]+\s*=/i.test(html)
    || /(?:src|poster)\s*=\s*['"]\s*(?:https?:|data:|javascript:)/i.test(html);
}

function validateEditedAsset(src: string | null | undefined, deckDir: string, label: string): void {
  if (src === null || src === undefined || src === '') return;
  const normalized = src.replaceAll('\\', '/');
  if (!normalized.startsWith('assets/')) throw new Error(`${label} must use a deck-relative assets/ path`);
  let absolute: string;
  try {
    absolute = resolveAsset(deckDir, normalized);
  } catch {
    throw new Error(`${label} is outside the deck asset folder`);
  }
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${normalized}`);
}

/** Conservative Node-side sanitizer for the HTTP HTML import path. */
async function sanitizeServerHtml(
  source: string,
  deckDir: string,
): Promise<{ html: string; blocked: string[]; missing: string[]; assets: string[] }> {
  const blocked: string[] = [];
  const assets: string[] = [];
  let html = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(?:iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed)\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:src|href|poster)\s*=\s*(["'])javascript:[\s\S]*?\1/gi, '');

  html = html.replace(/(src|poster|href)\s*=\s*(["'])(https?:[^"']+)\2/gi, (match, attr: string, _quote: string, url: string) => {
    if (attr.toLowerCase() === 'href' && /^<a\b/i.test(match)) return match;
    blocked.push(url);
    return '';
  });
  html = html.replace(/@import\s+(?:url\()?\s*['"]?https?:[^;]+;/gi, (match) => {
    blocked.push(match);
    return '/* external import removed */';
  });

  const dataUrls = [...new Set(html.match(/data:[^'"\s)>]+/g) ?? [])];
  for (let index = 0; index < dataUrls.length; index += 1) {
    const url = dataUrls[index];
    const parsed = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!parsed) continue;
    const mime = parsed[1] ?? 'application/octet-stream';
    const bytes = parsed[2] ? Buffer.from(parsed[3], 'base64') : Buffer.from(decodeURIComponent(parsed[3]));
    const temp = await mkdtemp(join(tmpdir(), 'slide-data-url-'));
    try {
      const file = join(temp, `inline-${index + 1}.${extensionForMime(mime)}`);
      await writeFile(file, bytes);
      const imported = await importAsset(deckDir, file);
      html = html.replaceAll(url, imported.src);
      assets.push(imported.src);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  return { html, blocked, missing: missingDeckAssets(html, deckDir), assets };
}

function missingDeckAssets(html: string, deckDir: string): string[] {
  const references = [
    ...[...html.matchAll(/(?:src|poster)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]),
    ...[...html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)].map((match) => match[1]),
  ];
  const missing = new Set<string>();
  for (const reference of references) {
    const normalized = reference.split(/[?#]/, 1)[0].replaceAll('\\', '/');
    if (!normalized.startsWith('assets/')) continue;
    try {
      if (!existsSync(resolveAsset(deckDir, normalized))) missing.add(normalized);
    } catch {
      missing.add(normalized);
    }
  }
  return [...missing];
}

function extensionForMime(mime: string): string {
  if (mime.includes('svg')) return 'svg';
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  return 'png';
}

/**
 * Add DeckWerk-owned controls to a sanitized HTML draft. Slide mode fits one
 * authored 1920×1080 section to the viewport; contact mode lays every slide
 * out as a zoomable grid. The underlying draft remains unchanged.
 */
export function htmlDraftComparisonDocument(
  draft: Pick<HttpHtmlDraft, 'id' | 'deckId' | 'slides'>,
): string {
  const deck = encodeURIComponent(draft.deckId);
  const mode = draft.slides.length > 1 ? 'contact' : 'slides';
  const source = `/api/html-drafts/${draft.id}/source?deck=${deck}&scratchpad=${mode}`;
  const imported = `/api/html-drafts/${draft.id}/imported?deck=${deck}&scratchpad=${mode}`;
  return sideBySideComparisonDocument({
    title: 'Source / Imported comparison',
    left: { label: 'Source', url: source },
    right: { label: 'Imported', url: imported },
  });
}

function sideBySideComparisonDocument(input: {
  title: string;
  left: { label: string; url: string };
  right: { label: string; url: string };
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${input.title}</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #0b0d12; color: #f4f6fb; font: 600 13px/1.2 system-ui, sans-serif; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; width: 100%; height: 100%; padding: 8px; }
  section { display: grid; grid-template-rows: 28px 1fr; min-width: 0; min-height: 0; }
  h1 { margin: 0; padding: 5px 8px; font: inherit; letter-spacing: .08em; text-transform: uppercase; }
  iframe { width: 100%; height: 100%; border: 1px solid #363a44; background: #111318; }
</style></head><body><main>
<section><h1>${input.left.label}</h1><iframe title="${input.left.label} slide preview" src="${input.left.url}"></iframe></section>
<section><h1>${input.right.label}</h1><iframe title="${input.right.label} slide preview" src="${input.right.url}"></iframe></section>
</main></body></html>`;
}

export function scratchpadDocument(html: string, mode: 'slides' | 'contact'): string {
  const common = String.raw`<style data-agent-scratchpad>
    html, body { margin: 0 !important; width: 100vw !important; min-width: 0 !important; min-height: 100vh !important; box-sizing: border-box !important; background: #111318 !important; }
    .agent-scratchpad-controls {
      position: fixed; z-index: 2147483647; left: 50%; bottom: 12px;
      display: flex; align-items: center; gap: 8px; padding: 6px 8px;
      border: 1px solid rgb(255 255 255 / 18%); border-radius: 9px;
      background: rgb(20 22 27 / 88%); color: #f5f5f5;
      box-shadow: 0 8px 30px rgb(0 0 0 / 45%);
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, sans-serif;
      transform: translateX(-50%); backdrop-filter: blur(12px);
    }
    .agent-scratchpad-controls button {
      min-width: 30px; height: 28px; padding: 0 8px; border: 0; border-radius: 6px;
      background: rgb(255 255 255 / 10%); color: inherit; font: inherit; cursor: pointer;
    }
    .agent-scratchpad-controls button:hover { background: rgb(255 255 255 / 18%); }
    .agent-scratchpad-controls button:disabled { opacity: .35; cursor: default; }
  </style>`;
  const slides = String.raw`<style data-agent-scratchpad-mode>
    html, body { overflow: hidden !important; }
    .agent-scratchpad-stage {
      position: fixed; left: 0; top: 0; width: 100vw; height: 100vh;
      overflow: hidden;
    }
    .agent-scratchpad-stage > .agent-scratchpad-frame {
      display: none; position: absolute; left: 50%; top: 50%;
      transform: translate(-50%, -50%) scale(var(--agent-scratchpad-scale, 1));
      transform-origin: center center;
    }
    .agent-scratchpad-stage > .agent-scratchpad-frame.agent-scratchpad-active { display: block; }
  </style><script data-agent-scratchpad-script>
    (() => {
      const start = () => {
        const deck = [...document.querySelectorAll('body > section.slide, body > .slide')];
        if (!deck.length) return;
        document.body.classList.add('agent-scratchpad-slides');
        const stage = document.createElement('main');
        stage.className = 'agent-scratchpad-stage';
        const frames = deck.map((slide) => {
          const width = slide.offsetWidth || 1920;
          const height = slide.offsetHeight || 1080;
          const frame = document.createElement('div');
          frame.className = 'agent-scratchpad-frame';
          frame.style.width = String(width) + 'px';
          frame.style.height = String(height) + 'px';
          frame.append(slide);
          stage.append(frame);
          return { frame, width, height };
        });
        document.body.prepend(stage);
        let index = Math.max(0, Math.min(deck.length - 1, Number(new URL(location.href).searchParams.get('slide') || 1) - 1));
        const controls = document.createElement('nav');
        controls.className = 'agent-scratchpad-controls';
        controls.setAttribute('aria-label', 'Scratchpad slide navigation');
        const previous = document.createElement('button');
        previous.type = 'button'; previous.textContent = '←'; previous.title = 'Previous slide';
        const counter = document.createElement('span');
        const next = document.createElement('button');
        next.type = 'button'; next.textContent = '→'; next.title = 'Next slide';
        controls.append(previous, counter, next);
        document.body.append(controls);
        const fit = () => {
          const { width, height } = frames[index];
          const scale = Math.min((innerWidth - 24) / width, (innerHeight - 24) / height);
          document.documentElement.style.setProperty('--agent-scratchpad-scale', String(Math.max(.05, scale)));
        };
        const show = (nextIndex) => {
          index = Math.max(0, Math.min(deck.length - 1, nextIndex));
          frames.forEach(({ frame }, slideIndex) => frame.classList.toggle('agent-scratchpad-active', slideIndex === index));
          counter.textContent = String(index + 1) + ' / ' + String(deck.length);
          previous.disabled = index === 0; next.disabled = index === deck.length - 1;
          const url = new URL(location.href); url.searchParams.set('slide', String(index + 1));
          history.replaceState(null, '', url);
          fit();
        };
        previous.addEventListener('click', () => show(index - 1));
        next.addEventListener('click', () => show(index + 1));
        addEventListener('resize', fit);
        addEventListener('keydown', (event) => {
          if (event.metaKey || event.ctrlKey || event.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
          if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(event.key)) { event.preventDefault(); show(index + 1); }
          else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); show(index - 1); }
          else if (event.key === 'Home') { event.preventDefault(); show(0); }
          else if (event.key === 'End') { event.preventDefault(); show(deck.length - 1); }
        });
        document.fonts?.ready.then(fit);
        show(index);
      };
      if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true }); else start();
    })();
  </script>`;
  const contact = String.raw`<style data-agent-scratchpad-mode>
    html, body { overflow: auto !important; }
    body.agent-scratchpad-contact { padding: 54px 14px 18px !important; }
    .agent-scratchpad-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--agent-scratchpad-thumb, 340px), 1fr));
      align-items: start; gap: 18px; width: 100%;
    }
    .agent-scratchpad-cell { position: relative; min-width: 0; overflow: hidden; background: #090a0d; box-shadow: 0 3px 18px rgb(0 0 0 / 38%); }
    .agent-scratchpad-cell > .agent-scratchpad-frame {
      position: absolute; left: 0; top: 0;
      transform: scale(var(--agent-cell-scale, 1)); transform-origin: left top;
    }
    .agent-scratchpad-number {
      position: absolute; z-index: 3; right: 6px; bottom: 6px; padding: 3px 6px;
      border-radius: 5px; background: rgb(0 0 0 / 72%); color: #fff;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, sans-serif;
    }
    body.agent-scratchpad-contact .agent-scratchpad-controls { top: 10px; bottom: auto; }
  </style><script data-agent-scratchpad-script>
    (() => {
      const start = () => {
        const deck = [...document.querySelectorAll('body > section.slide, body > .slide')];
        if (!deck.length) return;
        document.body.classList.add('agent-scratchpad-contact');
        const grid = document.createElement('main'); grid.className = 'agent-scratchpad-grid';
        const cells = deck.map((slide, index) => {
          const cell = document.createElement('div'); cell.className = 'agent-scratchpad-cell';
          const width = slide.offsetWidth || 1920; const height = slide.offsetHeight || 1080;
          const frame = document.createElement('div'); frame.className = 'agent-scratchpad-frame';
          frame.style.width = String(width) + 'px'; frame.style.height = String(height) + 'px';
          const number = document.createElement('span'); number.className = 'agent-scratchpad-number'; number.textContent = String(index + 1);
          frame.append(slide); cell.append(frame, number); grid.append(cell); return { cell, width, height };
        });
        document.body.prepend(grid);
        const controls = document.createElement('nav'); controls.className = 'agent-scratchpad-controls';
        controls.setAttribute('aria-label', 'Contact sheet zoom');
        const smaller = document.createElement('button'); smaller.type = 'button'; smaller.textContent = '−'; smaller.title = 'Zoom out';
        const label = document.createElement('span');
        const larger = document.createElement('button'); larger.type = 'button'; larger.textContent = '+'; larger.title = 'Zoom in';
        controls.append(smaller, label, larger); document.body.append(controls);
        let zoom = 1;
        const fit = () => cells.forEach(({ cell, width, height }) => {
          const scale = cell.clientWidth / width;
          cell.style.height = String(Math.round(height * scale)) + 'px';
          cell.style.setProperty('--agent-cell-scale', String(scale));
        });
        const setZoom = (value) => {
          zoom = Math.max(.45, Math.min(2.5, value));
          document.documentElement.style.setProperty('--agent-scratchpad-thumb', String(Math.round(340 * zoom)) + 'px');
          label.textContent = String(Math.round(zoom * 100)) + '%';
          requestAnimationFrame(fit);
        };
        smaller.addEventListener('click', () => setZoom(zoom / 1.2));
        larger.addEventListener('click', () => setZoom(zoom * 1.2));
        addEventListener('wheel', (event) => {
          if (!event.ctrlKey) return;
          event.preventDefault(); setZoom(zoom * Math.exp(-event.deltaY * .004));
        }, { passive: false });
        new ResizeObserver(fit).observe(grid);
        document.fonts?.ready.then(fit);
        setZoom(1);
      };
      if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true }); else start();
    })();
  </script>`;
  const injection = common + (mode === 'slides' ? slides : contact);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${injection}</body>`);
  return `${html}${injection}`;
}

/** A new deck's folder name: human-typed, so normalise instead of rejecting. */
function sanitizeDeckId(name: string): string {
  return basename(name)
    .replace(/\.(key|pptx)$/i, '')
    .replace(/[^a-zA-Z0-9._ -]+/g, '-')
    .replace(/^[.\s-]+|[\s-]+$/g, '')
    .slice(0, 80);
}

/**
 * Run an importer sidecar without Electron: the frozen binary when built
 * (build/importers), otherwise the project venv's Python and the source
 * script — the same fallbacks the desktop app uses.
 */
async function runImporter(
  importer: { binary: string; script: string; label: string },
  sourceFile: string,
  outDir: string,
): Promise<unknown> {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const binaryName = process.platform === 'win32' ? `${importer.binary}.exe` : importer.binary;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const binaries = [
    ...(resourcesPath ? [join(resourcesPath, 'importers', binaryName)] : []),
    join(repoRoot, 'build/importers', binaryName),
  ];
  const binary = binaries.find((candidate) => existsSync(candidate));
  const script = join(repoRoot, importer.script);
  const venv = join(repoRoot, '.venv-import/bin/python');

  let command: string;
  let args: string[];
  if (binary) {
    command = binary;
    args = [sourceFile, '--out', outDir];
  } else if (existsSync(script)) {
    command = existsSync(venv) ? venv : 'python3';
    args = [script, sourceFile, '--out', outDir];
  } else {
    throw new Error(`${importer.label} importer not found (run npm run build:importer)`);
  }
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolvePromise(out) : reject(new Error(`importer failed: ${err || `exit ${code}`}`)),
    );
  });
  const payload = JSON.parse(stdout) as { report?: unknown };
  return payload.report ?? null;
}

function runKeynoteImport(keyFile: string, outDir: string): Promise<unknown> {
  return runImporter(
    { binary: 'keynote-import', script: 'importers/keynote/import_keynote.py', label: 'Keynote' },
    keyFile,
    outDir,
  );
}

function runPowerPointImport(pptxFile: string, outDir: string): Promise<unknown> {
  return runImporter(
    { binary: 'pptx-import', script: 'importers/pptx/import_pptx.py', label: 'PowerPoint' },
    pptxFile,
    outDir,
  );
}

/**
 * Every regular file under the deck folder, as lazy zip entries so only one
 * file's bytes are in memory at a time. Dotfiles (.DS_Store & co) are noise
 * in a download; skip them.
 */
/**
 * What a local agent bridge mirrors from a deck folder, with content hashes
 * so a reconnect fetches only what changed. Hashes are cached by size and
 * mtime: a lecture's videos must not be re-read on every connect.
 */
const mirrorHashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

export interface MirrorFileEntry { path: string; size: number; sha256: string }

async function collectMirrorFiles(deckDir: string, themeFile: string): Promise<MirrorFileEntry[]> {
  // The mirror generates its own brief and helper; the deck's desktop-facing
  // AGENTS.md would send an agent looking for a CLI it does not have.
  const skip = new Set([
    'deck.json', 'notes.md', 'agent-chats.json', 'access.json', 'edit', themeFile,
    'AGENTS.md', 'CLAUDE.md', 'deck',
  ]);
  const files: MirrorFileEntry[] = [];
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(deckDir, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const relPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (skip.has(relPath)) continue;
      if (entry.isDirectory()) await walk(relPath);
      else if (entry.isFile()) {
        const absolute = join(deckDir, relPath);
        const info = await stat(absolute);
        const cached = mirrorHashes.get(absolute);
        let sha256 = cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs
          ? cached.sha256
          : null;
        if (!sha256) {
          sha256 = await new Promise<string>((resolvePromise, reject) => {
            const hash = createHash('sha256');
            createReadStream(absolute)
              .on('data', (chunk) => hash.update(chunk))
              .on('error', reject)
              .on('end', () => resolvePromise(hash.digest('hex')));
          });
          mirrorHashes.set(absolute, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
        }
        files.push({ path: relPath, size: info.size, sha256 });
      }
    }
  }
  await walk('');
  return files;
}

/**
 * Slides named the way `slide-agent --slide` names them: ids or 1-based
 * numbers, comma-separated, or `all`. An unknown reference is an error, not
 * an empty result — the caller is holding a stale id.
 */
function slidesByRef(deck: Deck, raw: string | null): { slides: Slide[] } | { error: string } {
  if (!raw || raw === 'all') return { slides: deck.slides };
  const slides: Slide[] = [];
  for (const ref of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
    const byId = deck.slides.find((slide) => slide.id === ref);
    const slide = byId ?? (/^\d+$/.test(ref) ? deck.slides[Number(ref) - 1] : undefined);
    if (!slide) return { error: `no slide ${ref}` };
    if (!slides.includes(slide)) slides.push(slide);
  }
  return { slides };
}

/** A mirror path as the client spelt it, or null if it points anywhere unsafe. */
function mirrorPath(raw: string | null): string | null {
  if (!raw) return null;
  const segments = raw.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    return null;
  }
  if (segments.includes('edit') || raw.includes('\\')) return null;
  return segments.join('/');
}

async function collectDeckFiles(deckDir: string): Promise<ZipFile[]> {
  const files: ZipFile[] = [];
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(deckDir, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const relPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relPath);
      else if (entry.isFile()) {
        files.push({ name: relPath, load: () => readFile(join(deckDir, relPath)) });
      }
    }
  }
  await walk('');
  return files;
}

/** Filenames written by importAsset: `<stem>.<8-hex content hash>.<ext>`. */
// Two spellings of "the name contains a content hash": imported deck assets
// (`stem.8hexdigits.ext`, possibly with a transcode infix) and vite bundle
// output (`entry-B64charsx8.ext`).
const CONTENT_HASHED_NAME = /\.[0-9a-f]{8}\.(?:[a-z0-9]+\.)?[a-z0-9]+$/i;
const VITE_HASHED_NAME = /-[a-z0-9_-]{8}\.[a-z0-9]+$/i;

/** Stream a file honouring HTTP Range requests, so <video> can seek. */
async function serveFileWithRanges(
  request: IncomingMessage,
  response: ServerResponse,
  absolute: string,
  // The vite hash spelling is only trusted for the built client bundle; a
  // user-named deck asset can end in "-something8.ext" without being hashed.
  hashedNames: RegExp[] = [CONTENT_HASHED_NAME],
): Promise<void> {
  let info;
  try {
    info = await stat(absolute);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }

  const type = MIME[extname(absolute).toLowerCase()] ?? 'application/octet-stream';
  const range = request.headers.range;
  // Assets must be cacheable. `no-store` here once made every <video> element
  // refetch its whole file on every mount: a deck reusing one 27 MB clip
  // across N elements issued N full downloads at open, which saturated the
  // browser's six connections per origin and starved the present view's HTML,
  // bundle and WebSocket behind them — seconds of blank screen. Imported
  // assets carry a content hash in the filename, so those are immutable; for
  // anything else the validator makes revalidation a 304, not a re-download.
  const etag = `"${info.size}-${Math.round(info.mtimeMs)}"`;
  const name = basename(absolute);
  const cacheControl = hashedNames.some((pattern) => pattern.test(name))
    ? 'public, max-age=31536000, immutable'
    : 'public, no-cache';
  if (request.headers['if-none-match'] === etag) {
    response.writeHead(304, { etag, 'cache-control': cacheControl });
    response.end();
    return;
  }
  const common = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': cacheControl,
    etag,
  };

  if (!range) {
    response.writeHead(200, { ...common, 'content-length': info.size });
    createReadStream(absolute).pipe(response);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
  if (!match || Number.isNaN(start) || start > end || start >= info.size) {
    response.writeHead(416, { 'content-range': `bytes */${info.size}` });
    response.end();
    return;
  }

  response.writeHead(206, {
    ...common,
    'content-range': `bytes ${start}-${end}/${info.size}`,
    'content-length': end - start + 1,
  });
  createReadStream(absolute, { start, end }).pipe(response);
}

function reachableUrls(host: string, port: number): string[] {
  if (host !== '0.0.0.0' && host !== '::') return [`http://${host}:${port}/`];
  const urls = [`http://127.0.0.1:${port}/`];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) urls.push(`http://${iface.address}:${port}/`);
    }
  }
  return urls;
}

export function defaultClientDir(repoRoot: string): string | undefined {
  // app.getAppPath() is out/main when Electron is launched as
  // `electron out/main/index.js`, so walk up looking for dist/collab.
  let base = repoRoot;
  for (let i = 0; i < 4; i++) {
    const dir = join(base, 'dist', 'collab');
    if (existsSync(join(dir, 'index.html'))) return dir;
    const parent = dirname(base);
    if (parent === base) break;
    base = parent;
  }
  return undefined;
}
