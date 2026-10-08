import { renameRetiredFields } from '@shared/fieldAliases.js';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { networkInterfaces, tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createDeck, importAsset, importWebPage, loadDeck, loadTheme, resolveAsset, saveDeck,
} from '../main/deckStore.js';
import { exportDeck, webExportUnavailableReason } from '../main/exportDeck.js';
import { capabilities } from '../shared/capabilities.js';
import { getFfmpegPath, getFfprobePath, probeMedia } from '../main/ffmpeg.js';
import { DeckWire } from './deckWire.js';
import {
  RenditionStore,
  isVideoAsset,
  pruneRenditions,
  type RenditionOptions,
} from './streamingRenditions.js';
import {
  ClientMessageSchema,
  COLLAB_CLOSE,
  COLLAB_PROTOCOL_VERSION,
  type PresenceState,
  type ServerMessage,
} from '../shared/collab.js';
import {
  AGENT_MENTION,
  CHAT_FILE,
  CHAT_ID_PATTERN,
  CHAT_TEXT_MAX,
  ChatRefSchema,
  mentionsAgent,
  parseMentions,
  type ChatMessage,
  type ChatRef,
} from '../shared/chat.js';
import { CollabSession } from './collabSession.js';
import { HISTORY_FILES, type EditAuthor } from '../shared/editHistory.js';
import { readZip, writeZip, type ZipEntry, type ZipFile } from './zip.js';
import {
  compileHtmlToSlides,
  headlessBrowserProblem,
  measureBuiltTextOverflows,
  renderHtmlDraftPng,
} from '../cli/compileHtml.js';
import {
  HtmlAuthoringError,
  htmlChangeLabel,
  htmlSlideScope,
  htmlSyncHistoryLabel,
  htmlSyncOperations,
  htmlSyncSummary,
  insertionAnchor,
  pageBases,
  pageStampOf,
  slidesFromMeasured,
  slidesToHtml,
} from '../shared/htmlSlides.js';
import { PLAYER_TYPE_CSS } from '../shared/playerTypeCss.js';
import { authoringPageHtml, type TextOverflow } from '../shared/htmlMeasure.js';
import { deckRevision } from '../main/agentRuntime.js';
import { applyAgentTransaction, validateDeckIntegrity, type AgentOperation } from '../shared/agent.js';
import { NativeEditRequestSchema, applyNativeEdits, nativeEditContract } from '../shared/nativeEdits.js';
import { type Deck, type Slide, type SlideElement } from '../shared/deck.js';
import { classifyMediaName } from '../shared/media.js';
import { deckOutline } from '../shared/deckDigest.js';
import type { AgentPanelState } from '../shared/ipc.js';
import type { LocalAgentLink, LocalAgentRegistry } from './localAgents.js';
import { planHtmlReplacement } from './htmlReplacement.js';
import { MirrorThemeRequestSchema, mirrorThemeAction, type MirrorThemeRequest } from './mirrorTheme.js';
import { htmlDraftWorkflow, type HtmlDraftWorkflow } from './htmlDraftWorkflow.js';
import { injectWebBridgeRuntime } from '../shared/webBridge.js';
import { checkWebPage } from '../cli/renderSlides.js';
import {
  canAccessDeck,
  canEditDeck,
  canManageDeck,
  deckRoleFor,
  folderVisibleTo,
  normalizeLogin,
  normalizeShares,
  readDeckAccess,
  readFolderOwner,
  resolveIdentity,
  roleMayComment,
  UserDirectory,
  writeDeckAccess,
  writeFolderOwner,
  ACCESS_FILE,
  FOLDER_FILE,
  type AccessControlConfig,
  type DeckAccess,
  type DeckRole,
  type Identity,
} from './accessControl.js';

/** How long shutdown lets peers finish the WebSocket close handshake. */
const SOCKET_CLOSE_GRACE_MS = 500;

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
  '.jfif': 'image/jpeg',
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
  /**
   * Whether this peer may change the deck, decided when the socket was
   * admitted. A view-only peer is a spectator: it still gets the live deck,
   * presence and everyone else's edits, and nothing it sends is applied.
   */
  canEdit: boolean;
  /**
   * Whether this peer may post to the deck chat. Decided like `canEdit`, and
   * by the same rule as commenting (`roleMayComment`).
   */
  canComment: boolean;
  /** Set when this peer is a local agent bridge: whose agent it is. */
  agentFor: string | null;
}

/** The edit log's author for a transaction a WebSocket peer sent. */
function peerAuthor(peer: Peer, clientId: string): EditAuthor {
  return {
    name: peer.state.name,
    ...(peer.identity ? { login: peer.identity.login } : {}),
    clientId,
    agent: Boolean(peer.agentFor || peer.state.agent),
    via: 'socket',
    ...(peer.agentFor ? { agentFor: peer.agentFor } : {}),
  };
}

type AgentAuthorship = Pick<EditAuthor, 'name' | 'clientId' | 'agentFor'>;

/** The edit log's author for a change an HTTP route made: an agent's, or a person's. */
function httpAuthor(identity: Identity | null, agent: AgentAuthorship | null): EditAuthor {
  return {
    name: agent?.name ?? identity?.name ?? 'unknown',
    ...(identity ? { login: identity.login } : {}),
    ...(agent?.clientId ? { clientId: agent.clientId } : {}),
    agent: Boolean(agent),
    via: 'http',
    ...(agent?.agentFor ? { agentFor: agent.agentFor } : {}),
  };
}

/**
 * Files the server keeps beside a deck for itself: who may see it, its
 * chats, its edit log. Never mirrored to an agent's folder, never served
 * through the mirror routes, never taken from an uploaded archive.
 */
const SERVER_SIDECARS: ReadonlySet<string> = new Set(['agent-chats.json', 'access.json', CHAT_FILE, ...HISTORY_FILES]);

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
  /**
   * Set once a live rename has begun. From then on nothing a peer sends is
   * applied: the session is being flushed and closed, and its folder is about
   * to stop existing under this id.
   */
  relocating: boolean;
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
  /** Publish the newest HTML compile to the filesystem agent scratchpad. */
  onHtmlDraft?: (draft: HtmlDraftPreview) => void;
  /** Publish the newest native Before/After work-in-progress to the scratchpad. */
  onNativeDraft?: (draft: NativeDraftPreview) => void;
  /**
   * Let every participant connect their own local agent (`slide-agent
   * connect`). The browser panel shows the handoff command and bridges pair
   * with participants over the WebSocket.
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
  /**
   * Serve web-sized renditions of oversized video (streamingRenditions.ts).
   * On by default; `false` turns it off for tests that assert on the exact
   * bytes of a fixture asset, and for anyone who would rather spend bandwidth
   * than CPU. An object configures the store (a test's own cache directory).
   */
  mediaRenditions?: boolean | RenditionOptions;
  /**
   * Keep every Keynote and PowerPoint upload, successful or not, for this
   * many days under `<rootDir>/.uploads/`, so a bad import can be debugged
   * against the file that produced it. Off (0) unless set: the hosted server
   * turns it on, a desktop app sharing one deck has no imports to keep.
   */
  keepUploadsDays?: number;
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
  const localAgents = options.localAgents;
  /**
   * The wire copy of oversized video. Deck assets are whatever the author
   * had — 26 Mbit/s screen recordings, 100 MB exports — and no amount of
   * preloading makes those arrive in time over a remote link.
   */
  const renditions = options.mediaRenditions === false ? null : new RenditionStore({
    ...(typeof options.mediaRenditions === 'object' ? options.mediaRenditions : {}),
    onProgress: (event) => {
      const name = basename(event.source);
      if (event.status === 'started') console.log(`  preparing ${name} for streaming…`);
      else if (event.status === 'done') {
        console.log(`  prepared ${name} (${Math.round((event.savedBytes ?? 0) / 1048576)} MB smaller)`);
        // Tell every deck showing this clip that its rendition now exists, so
        // the next <video> each client builds for it asks for the small copy.
        for (const room of rooms.values()) {
          if (!deckVideoAssets(room.session.dir, room.session.deck).includes(event.source)) continue;
          broadcast(room, { kind: 'media', variants: deckMediaVariants(room.session.dir, room.session.deck) });
        }
      } else if (event.status === 'failed') {
        console.warn(`  could not prepare ${name}: ${event.detail ?? ''}`);
      }
      if (typeof options.mediaRenditions === 'object') options.mediaRenditions.onProgress?.(event);
    },
  });
  /** The variant each oversized clip in a deck is served as right now (see RenditionStore.variant). */
  function deckMediaVariants(deckDir: string, deck: Deck): Record<string, string> {
    const variants: Record<string, string> = {};
    if (!renditions) return variants;
    for (const slide of deck.slides) {
      for (const element of slide.elements) {
        if (element.type !== 'video' || element.src in variants) continue;
        try {
          const absolute = resolveAsset(deckDir, element.src);
          const info = statSync(absolute);
          const variant = renditions.variant(absolute, info.size, info.mtimeMs);
          if (variant) variants[element.src] = variant;
        } catch {
          // A pending or missing src has no variant to pin.
        }
      }
    }
    return variants;
  }
  // Renditions of assets that have since been edited or deleted are dead
  // weight on a server that hosts years of talks.
  if (renditions) {
    void pruneRenditions(
      typeof options.mediaRenditions === 'object' ? options.mediaRenditions.cacheDir : undefined,
    ).catch(() => 0);
  }
  // Kept as a local alias while the private panel transport is renamed. This
  // is only connection/activity state; DeckWerk never owns or invokes an agent.
  const sharedAgent = localAgents;
  const accessControl = options.accessControl
    ? { admin: normalizeLogin(options.accessControl.admin) }
    : null;
  // Everyone the server has ever identified, for share-dialog autocomplete.
  const userDirectory = accessControl ? new UserDirectory(join(resolve(options.rootDir), 'users.json')) : null;
  const rooms = new Map<string, Room>();
  const roomsOpening = new Map<string, Promise<Room>>();
  /**
   * Renames in progress, by the id being renamed away from. Anything that
   * would open that id — a socket joining, an HTTP route reaching for the
   * room — waits for the rename to land first, so it never opens a session
   * on a folder that is about to move out from under it.
   */
  const relocations = new Map<string, Promise<void>>();
  /**
   * Where renamed decks went, by their old id. A client that was offline
   * while its deck was renamed reconnects to the old id; it is sent on to the
   * new one rather than told the deck is gone. Only consulted while nothing
   * exists at the old id, and forgotten with the process.
   */
  const movedDecks = new Map<string, { id: string; title: string }>();
  const htmlDrafts = new Map<string, HttpHtmlDraft>();
  const latestHtmlDrafts = new Map<string, string>();
  const htmlIdempotency = new Map<string, { revision: string; slideIds: string[]; label: string }>();
  const nativeDrafts = new Map<string, HttpNativeDraft>();
  const nativeIdempotency = new Map<string, {
    digest: string; revision: string; slideIds: string[]; elementIds: string[]; label: string;
  }>();
  /** Known once listen() succeeds; /api/config reports the invite URLs. */
  let boundPort: number | null = null;

  /**
   * Drop every per-deck scrap keyed by a deck id that is about to stop
   * meaning what it meant (a move). Drafts and idempotency records describe a
   * deck at a path; carrying them to the new path, or leaving them behind for
   * whatever takes the old one, are both wrong.
   */
  function forgetDeckState(deckId: string): void {
    htmlDrafts.delete(deckId);
    latestHtmlDrafts.delete(deckId);
    nativeDrafts.delete(deckId);
    for (const key of [...nativeIdempotency.keys()]) {
      if (key.startsWith(`${deckId}:`)) nativeIdempotency.delete(key);
    }
    for (const stream of [...sharedAgentStreams]) {
      if (stream.deckId !== deckId) continue;
      stream.response.end();
      sharedAgentStreams.delete(stream);
    }
  }
  const sharedAgentStreams = new Set<{
    deckId: string;
    participantId: string;
    canManageAccount: boolean;
    response: ServerResponse;
  }>();

  /**
   * Deck ids are folder paths under the root — "talk", or "clients/acme/talk"
   * once someone files it away. Every segment is validated and the resolved
   * path has to land exactly where the segments say, so no id can climb out
   * of the root; ids are otherwise opaque strings everywhere else.
   */
  function deckDirOf(deckId: string): string {
    const segments = splitDeckPath(deckId);
    if (!segments) throw new Error(`invalid deck id: ${deckId}`);
    if (hostedDeckId && deckId !== hostedDeckId) {
      throw new Error(`this session only hosts "${hostedDeckId}"`);
    }
    const dir = resolve(rootDir, ...segments);
    if (dir !== join(rootDir, ...segments)) throw new Error(`invalid deck id: ${deckId}`);
    return dir;
  }

  /** The same path rules for a folder, which has no hosted-deck restriction. */
  function folderDirOf(folderPath: string): string {
    if (folderPath === '') return rootDir;
    const segments = splitDeckPath(folderPath);
    if (!segments) throw new Error(`invalid folder: ${folderPath}`);
    const dir = resolve(rootDir, ...segments);
    if (dir !== join(rootDir, ...segments)) throw new Error(`invalid folder: ${folderPath}`);
    return dir;
  }

  const isDeckDir = (dir: string): boolean => existsSync(join(dir, 'deck.json'));
  /** Whether a deck is at this id; an invalid id holds none. */
  const deckFolderExists = (deckId: string): boolean => {
    try {
      return isDeckDir(deckDirOf(deckId));
    } catch {
      return false;
    }
  };

  interface DeckListEntry {
    id: string;
    title: string;
    slides: number;
    /** When deck.json was last saved, which only an edit does; ISO time. */
    editedAt: string | null;
    /** When the deck folder was created (its birth time); ISO time. */
    createdAt: string | null;
    /** People (not agents, not spectators) connected to it right now. */
    editors: number;
    /** Containing folder, "" at the root. Always present. */
    folder: string;
    /** Present only with access control on. */
    owner?: string;
    visibility?: 'public' | 'private';
    canManage?: boolean;
    sharedWithMe?: boolean;
    role?: DeckRole;
  }

  interface FolderListEntry {
    path: string;
    name: string;
    parent: string;
    /** Decks this person can open directly inside it. */
    decks: number;
    owner?: string;
    canManage?: boolean;
  }

  /** Folders nest, but not without limit: a cycle-free tree still needs a floor. */
  const MAX_FOLDER_DEPTH = 8;

  /**
   * How many people are editing a room. A person with the deck open in two
   * tabs is one editor; agent bridges and view-only spectators are none.
   */
  function editorsIn(room: Room | undefined): number {
    const people = new Set<string>();
    for (const [clientId, peer] of room?.peers ?? []) {
      if (!peer.canEdit || peer.agentFor || peer.state.agent) continue;
      people.add(peer.identity?.login ?? peer.state.participant ?? clientId);
    }
    return people.size;
  }

  /**
   * A deck's title and slide count for the listing. Every listing used to
   * parse every deck.json in full, and one 20 MB deck made each visit to the
   * deck picker hold the event loop ~20 ms for everyone editing. An open deck
   * answers from memory; any other is parsed once per change of its file.
   */
  const summaries = new Map<string, { size: number; mtimeMs: number; title?: string; slides: number }>();
  async function deckSummary(
    id: string,
    dir: string,
    saved: { size: number; mtimeMs: number } | null,
  ): Promise<{ title?: string; slides: number }> {
    const open = rooms.get(id);
    if (open) return { title: open.session.deck.title, slides: open.session.deck.slides.length };
    const known = summaries.get(dir);
    if (known && saved && known.size === saved.size && known.mtimeMs === saved.mtimeMs) return known;
    const raw = JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')) as { title?: string; slides?: unknown[] };
    const summary = { title: raw.title, slides: Array.isArray(raw.slides) ? raw.slides.length : 0 };
    if (saved) summaries.set(dir, { ...summary, size: saved.size, mtimeMs: saved.mtimeMs });
    return summary;
  }

  async function deckListEntry(
    id: string,
    dir: string,
    identity: Identity | null,
  ): Promise<DeckListEntry | null> {
    let listed: DeckListEntry;
    try {
      const saved = await stat(join(dir, 'deck.json')).catch(() => null);
      const raw = await deckSummary(id, dir, saved);
      // deck.json is replaced on every save, so its own birth time is the last
      // save; the folder's is when the deck was made. Without birth times,
      // the earliest time we have is the best guess.
      const folder = await stat(dir).catch(() => null);
      const createdMs = folder?.birthtimeMs
        ? folder.birthtimeMs
        : Math.min(folder?.mtimeMs ?? Infinity, saved?.mtimeMs ?? Infinity);
      const name = id.slice(id.lastIndexOf('/') + 1);
      listed = {
        id,
        title: raw.title ?? name,
        slides: raw.slides,
        editedAt: saved ? saved.mtime.toISOString() : null,
        createdAt: Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : null,
        editors: editorsIn(rooms.get(id)),
        folder: id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '',
      };
    } catch {
      // Half-written or invalid deck.json; skip rather than fail the listing.
      return null;
    }
    if (accessControl && identity) {
      const access = await readDeckAccess(dir, accessControl);
      const role = deckRoleFor(identity.login, access, accessControl);
      if (!role) return null;
      listed.owner = access.owner;
      listed.visibility = access.visibility;
      listed.canManage = canManageDeck(identity.login, access, accessControl);
      listed.sharedWithMe = access.sharedWith.some((share) => share.login === identity.login);
      listed.role = role;
    }
    return listed;
  }

  interface Listing {
    decks: DeckListEntry[];
    folders: FolderListEntry[];
  }

  /**
   * Walk one folder, collecting everything below it this person may see.
   *
   * Folders are containers, so their visibility is derived rather than
   * granted (see folderVisibleTo): a folder with nothing accessible inside is
   * dropped along with its whole subtree, which by construction holds nothing
   * this person could have seen anyway. The one structural exception is a
   * folder that contains a folder they *can* see — usually their own — which
   * has to stay so the visible one still has a path.
   */
  async function collectListing(
    relative: string,
    depth: number,
    identity: Identity | null,
  ): Promise<Listing & { accessibleDecks: number }> {
    const out: Listing = { decks: [], folders: [] };
    let accessibleDecks = 0;
    let entries;
    try {
      entries = await readdir(relative ? join(rootDir, relative) : rootDir, { withFileTypes: true });
    } catch {
      return { ...out, accessibleDecks };
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const childId = relative ? `${relative}/${entry.name}` : entry.name;
      const childDir = join(rootDir, childId);
      if (isDeckDir(childDir)) {
        if (hostedDeckId && childId !== hostedDeckId) continue;
        const listed = await deckListEntry(childId, childDir, identity);
        // A deck's own subdirectories (assets/, edit/) are part of the deck,
        // never folders: stop here either way.
        if (listed) {
          out.decks.push(listed);
          accessibleDecks += 1;
        }
        continue;
      }
      if (hostedDeckId) continue; // a single-deck session has no folder tree
      if (depth + 1 > MAX_FOLDER_DEPTH) continue;
      if (!splitDeckPath(childId)) continue;
      const inside = await collectListing(childId, depth + 1, identity);
      const owner = accessControl ? await readFolderOwner(childDir, accessControl) : '';
      const visible = !accessControl || !identity
        || folderVisibleTo(identity.login, { owner, accessibleDecks: inside.accessibleDecks }, accessControl)
        || inside.folders.length > 0;
      if (!visible) continue;
      const folder: FolderListEntry = {
        path: childId,
        name: entry.name,
        parent: relative,
        decks: inside.decks.filter((deck) => deck.folder === childId).length,
      };
      if (accessControl && identity) {
        folder.owner = owner;
        folder.canManage = identity.login === accessControl.admin || owner === identity.login;
      }
      out.folders.push(folder, ...inside.folders);
      out.decks.push(...inside.decks);
      accessibleDecks += inside.accessibleDecks;
    }
    return { ...out, accessibleDecks };
  }

  async function listDecks(identity: Identity | null): Promise<DeckListEntry[]> {
    const { decks } = await collectListing('', 0, identity);
    return decks.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function listFolders(identity: Identity | null): Promise<FolderListEntry[]> {
    const { folders } = await collectListing('', 0, identity);
    return folders.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Put a deck's folder at another id, or hold still and say why not.
   *
   * The deck id is the room key and the session's directory, so moving and
   * renaming are the same act on disk. A move waits for the room to be empty:
   * it is filed away from the picker, by someone who does not have it open.
   * A rename is done from inside the deck (the toolbar's name field), so with
   * `live` it goes ahead with people in the room:
   *
   *   1. the room stops applying anything peers send (`relocating`);
   *   2. the session is closed, which writes every edit it accepted;
   *   3. the folder is renamed and, for a rename, the title rewritten;
   *   4. every peer is told where the deck went (`deckMoved`) and its socket
   *      closed — clients rejoin under the new id from there.
   *
   * Edits a peer sent after step 1 are dropped; its client counts them when
   * the `deckMoved` arrives. `toId === fromId` still drains the room — the
   * caller is rewriting deck.json.
   */
  async function relocateDeck(
    fromId: string,
    toId: string,
    verb: 'moving' | 'renaming',
    options: { title?: string; live?: boolean } = {},
  ): Promise<{ status: number; error: string } | null> {
    if (relocations.has(fromId)) {
      return { status: 409, error: `this presentation is already being ${verb === 'moving' ? 'moved' : 'renamed'}` };
    }
    const occupied = (): boolean => (rooms.get(fromId)?.peers.size ?? 0) > 0;
    const refusal = {
      status: 409,
      error: `somebody has this presentation open — close it everywhere before ${verb} it`,
    };
    if (!options.live && occupied()) return refusal;
    // Registered before the first await, so a socket or route arriving from
    // here on waits for the folder to land instead of opening the old one.
    let settle!: () => void;
    relocations.set(fromId, new Promise<void>((resolvePromise) => { settle = resolvePromise; }));
    try {
      await roomsOpening.get(fromId)?.catch(() => undefined);
      if (!options.live && occupied()) return refusal;
      const room = rooms.get(fromId);
      if (room) {
        room.relocating = true;
        await room.session.close();
        rooms.delete(fromId);
      }
      forgetDeckState(fromId);
      // Whatever an earlier deck at the new id left behind is not this one's.
      if (toId !== fromId) forgetDeckState(toId);
      const fromDir = deckDirOf(fromId);
      const toDir = deckDirOf(toId);
      // The caller checked nothing is at the new id. A room still cached
      // under it is a deck whose folder was removed outside the server; its
      // in-memory copy must not be what this deck opens as.
      const stale = toId !== fromId ? rooms.get(toId) : undefined;
      if (stale) {
        stale.relocating = true;
        stale.session.discard();
        rooms.delete(toId);
        for (const peer of stale.peers.values()) peer.socket.close(COLLAB_CLOSE.noSuchDeck, 'This presentation no longer exists here.');
      }
      let title: string;
      try {
        if (toId !== fromId) await rename(fromDir, toDir);
        const deck = await loadDeck(toDir);
        title = options.title ?? deck.title;
        if (options.title !== undefined) await saveDeck(toDir, { ...deck, title: options.title });
      } catch (error) {
        // The session is already closed. Send its peers through an ordinary
        // reconnect, which opens whatever the disk now holds.
        for (const peer of room?.peers.values() ?? []) peer.socket.close(1011, `${verb} failed`);
        throw error;
      }
      if (toId !== fromId) {
        localAgents?.relocate(fromDir, toDir, `The presentation was renamed to “${title}”.`);
        // Forwarding addresses stay one hop: whatever pointed at the old id
        // now points at the new one.
        for (const [oldId, target] of movedDecks) {
          if (target.id === fromId) movedDecks.set(oldId, { id: toId, title });
        }
        movedDecks.set(fromId, { id: toId, title });
        movedDecks.delete(toId);
      }
      for (const peer of room?.peers.values() ?? []) {
        // Greeted or not: one still mid-hello must not reconnect to the old id.
        send(peer, { kind: 'deckMoved', deckId: toId, title });
        peer.socket.close(COLLAB_CLOSE.moved, 'presentation renamed');
      }
      return null;
    } finally {
      relocations.delete(fromId);
      settle();
    }
  }

  /** Whether `folderPath` exists and this person is allowed to see it. */
  async function folderVisible(identity: Identity | null, folderPath: string): Promise<boolean> {
    if (folderPath === '') return true;
    if (!accessControl || !identity) return existsSync(folderDirOf(folderPath));
    return (await listFolders(identity)).some((folder) => folder.path === folderPath);
  }

  /** This identity's role on the deck, or null when it may not open it. */
  async function deckRoleOf(identity: Identity | null, deckId: string): Promise<DeckRole | null> {
    if (!accessControl) return 'owner';
    if (!identity) return null;
    let deckDir: string;
    try {
      deckDir = deckDirOf(deckId);
    } catch {
      // Invalid ids fall through to the route's own error handling.
      return 'owner';
    }
    // Only a real deck folder is a deck. Without this, "private-deck/assets"
    // would resolve to a directory with no sidecar of its own — which reads
    // as public — and hand out the private deck's insides.
    if (!isDeckDir(deckDir) && existsSync(deckDir)) return null;
    return deckRoleFor(identity.login, await readDeckAccess(deckDir, accessControl), accessControl);
  }

  /** Whether this identity may touch the deck at all; access control off = yes. */
  async function deckAllowed(identity: Identity | null, deckId: string): Promise<boolean> {
    return (await deckRoleOf(identity, deckId)) !== null;
  }

  /** Whether this identity may change the deck. View-only participants cannot. */
  async function deckWritable(identity: Identity | null, deckId: string): Promise<boolean> {
    const role = await deckRoleOf(identity, deckId);
    return role === 'owner' || role === 'edit';
  }

  /**
   * The trash. Deleting from the picker never removes anything: the deck or
   * folder is renamed into `<root>/.trash/<entry>/item`, with a `trash.json`
   * beside it saying where it came from, when, and who moved it. The item's
   * own sidecars (access.json, folder.json, and those of everything inside)
   * travel with it, so who may see a trashed item is computed from exactly
   * the rules that applied before it was trashed. `.trash` is a dot-name, so
   * splitDeckPath refuses it: no listing walks into it and no route opens it.
   */
  /**
   * Uploaded Keynote and PowerPoint files, kept for options.keepUploadsDays.
   * One folder per upload: the file under the name it was imported as, and
   * upload.json saying which deck it became, who sent it and whether the
   * import worked. A dot-name like .trash, so no listing or route reaches it.
   */
  const UPLOADS_DIR = join(rootDir, '.uploads');
  const keepUploadsDays = Math.max(0, options.keepUploadsDays ?? 0);

  async function keepUpload(file: string, meta: Record<string, unknown>): Promise<void> {
    if (keepUploadsDays <= 0) return;
    try {
      const at = new Date();
      const slug = String(meta.deck).replace(/[^0-9A-Za-z._-]+/g, '-').slice(0, 80);
      const entry = join(UPLOADS_DIR, `${at.toISOString().replace(/[:.]/g, '-')}-${slug}`);
      await mkdir(entry, { recursive: true });
      await copyFile(file, join(entry, basename(file)));
      await writeFile(join(entry, 'upload.json'), `${JSON.stringify({ ...meta, at: at.toISOString() }, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`could not keep upload ${basename(file)}: ${String(error)}\n`);
    }
    await pruneUploads();
  }

  async function pruneUploads(): Promise<void> {
    if (keepUploadsDays <= 0) return;
    const cutoff = Date.now() - keepUploadsDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await readdir(UPLOADS_DIR);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(UPLOADS_DIR, entry);
      try {
        if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
      } catch {
        // Gone already, or unreadable: the next prune tries again.
      }
    }
  }
  void pruneUploads();

  const TRASH_DIR = join(rootDir, '.trash');
  const TRASH_ENTRY_ID = /^[0-9A-Za-z-]{8,80}$/;

  interface TrashMeta {
    originalPath: string;
    kind: 'deck' | 'folder';
    name: string;
    title?: string;
    deletedAt: string;
    deletedBy: string;
  }

  /**
   * Whether this person could see a deck or folder at `dir` (live or trashed),
   * and whether they could edit every deck in it. Same rules as the listing:
   * a deck by its sidecar, a folder when it is theirs or holds something they
   * could see.
   */
  async function treeAccess(
    dir: string,
    identity: Identity | null,
    depth = 0,
  ): Promise<{ visible: boolean; editable: boolean }> {
    if (!accessControl || !identity) return { visible: true, editable: true };
    if (isDeckDir(dir)) {
      const role = deckRoleFor(identity.login, await readDeckAccess(dir, accessControl), accessControl);
      return { visible: role !== null, editable: role === 'owner' || role === 'edit' };
    }
    const owner = await readFolderOwner(dir, accessControl);
    const isAdmin = identity.login === accessControl.admin;
    let visible = isAdmin || owner === identity.login;
    let editable = isAdmin || owner === identity.login;
    if (depth >= MAX_FOLDER_DEPTH) return { visible, editable };
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return { visible, editable };
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const inside = await treeAccess(join(dir, entry.name), identity, depth + 1);
      if (inside.visible) visible = true;
      if (!inside.editable) editable = false;
    }
    return { visible, editable };
  }

  async function readTrashMeta(entryDir: string): Promise<TrashMeta | null> {
    try {
      const raw = JSON.parse(await readFile(join(entryDir, 'trash.json'), 'utf8')) as Partial<TrashMeta>;
      if (typeof raw.originalPath !== 'string' || (raw.kind !== 'deck' && raw.kind !== 'folder')) return null;
      return {
        originalPath: raw.originalPath,
        kind: raw.kind,
        name: typeof raw.name === 'string' ? raw.name : raw.originalPath,
        title: typeof raw.title === 'string' ? raw.title : undefined,
        deletedAt: typeof raw.deletedAt === 'string' ? raw.deletedAt : '',
        deletedBy: typeof raw.deletedBy === 'string' ? raw.deletedBy : '',
      };
    } catch {
      return null;
    }
  }

  /** Close every room at or under `target` so its session writes and lets go. */
  async function drainRooms(target: string): Promise<boolean> {
    const inside = [...rooms.keys()].filter((id) => id === target || id.startsWith(`${target}/`));
    if (inside.some((id) => (rooms.get(id)?.peers.size ?? 0) > 0 || relocations.has(id))) return false;
    for (const id of inside) {
      const room = rooms.get(id);
      if (room) {
        room.relocating = true;
        await room.session.flush();
        await room.session.close();
        rooms.delete(id);
      }
      forgetDeckState(id);
    }
    return true;
  }

  async function getRoom(deckId: string): Promise<Room> {
    // Mid-rename, the old id's folder is about to move: opening a session on
    // it now would leave one writing into a path that no longer holds the deck.
    const relocating = relocations.get(deckId);
    if (relocating) await relocating;
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
      session,
      peers: new Map(),
      guestCounter: 0,
      agentPresence: null,
      participantLogins: new Map(),
      relocating: false,
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
            }
          : {}),
      }),
      onExternalTheme: (css) => broadcast(room, { kind: 'theme', css, byClientId: '' }),
    });
    rooms.set(deckId, room);
    // Opening a deck is the earliest honest signal that someone intends to
    // present it, and preparing a talk's clips takes minutes of CPU. Queued in
    // slide order so the front of the deck is ready first, one at a time so a
    // presenting machine keeps its cores.
    if (renditions) renditions.warm(deckVideoAssets(session.dir, session.deck));
    return room;
  }

  /** Messages carrying a whole deck are spliced from a cache (deckWire.ts). */
  const wire = new DeckWire();
  const send = (peer: Peer, message: ServerMessage) => {
    if (peer.socket.readyState === peer.socket.OPEN) peer.socket.send(wire.encode(message), { binary: false });
  };
  /**
   * One message to every greeted peer. Serialised and encoded once, however
   * many peers there are: a whole-deck message for a large deck is megabytes
   * of JSON, and stringifying it (or encoding the string) per peer held the
   * event loop for each of them. (permessage-deflate still compresses per
   * socket — each connection has its own compression context, which ws
   * offers no way to share — but that runs on zlib's thread pool.)
   */
  const broadcast = (room: Room, message: ServerMessage, except?: string) => {
    let data: Buffer | null = null;
    for (const [id, peer] of room.peers) {
      if (id === except || !peer.greeted || peer.socket.readyState !== peer.socket.OPEN) continue;
      if (!data) {
        const encoded = wire.encode(message);
        data = typeof encoded === 'string' ? Buffer.from(encoded, 'utf8') : encoded;
      }
      peer.socket.send(data, { binary: false });
    }
  };
  /** An agent behind an HTTP route, for the edit log: a linked bridge, or the server's agent. */
  const agentAuthor = (bridge: LocalAgentLink | null, participant: string | null): AgentAuthorship => ({
    name: bridge?.name ?? sharedAgent?.name ?? 'Agent',
    ...(bridge && bridge.clientId !== 'http' ? { clientId: bridge.clientId } : {}),
    ...(participant ? { agentFor: participant } : {}),
  });
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
   * Accept one chat message into the room: persist it, broadcast it to every
   * peer (its sender confirms its pending copy by id), and — when a person
   * calls for `@agent` — tell each local agent attached to the deck, in its
   * participant's Agent panel. Returns null for a resend of an id already
   * accepted, or a room that is closing.
   */
  const postChat = (room: Room, input: {
    id?: string;
    author: string;
    login?: string;
    agent: boolean;
    text: string;
    ref?: ChatRef;
  }): ChatMessage | null => {
    if (room.relocating) return null;
    const text = input.text.trim().slice(0, CHAT_TEXT_MAX);
    if (!text) return null;
    const message: ChatMessage = {
      id: input.id && CHAT_ID_PATTERN.test(input.id) ? input.id : `chat-${randomUUID()}`,
      author: input.author.slice(0, 120) || 'Guest',
      ...(input.login ? { login: input.login } : {}),
      agent: input.agent,
      ts: new Date().toISOString(),
      text,
      mentions: parseMentions(text),
      ...(input.ref ? { ref: input.ref } : {}),
    };
    if (!room.session.chat.append(message)) return null;
    broadcast(room, { kind: 'chat', message });
    if (localAgents && !message.agent && mentionsAgent(message)) {
      const told = new Set<string>();
      for (const peer of room.peers.values()) {
        if (!peer.greeted || !peer.agentFor || told.has(peer.agentFor)) continue;
        told.add(peer.agentFor);
        localAgents.event(room.session.dir, peer.agentFor, {
          text: `${message.author} asked @${AGENT_MENTION} in chat: ${text.slice(0, 300)}`,
        });
      }
    }
    return message;
  };

  /** A chat ref that names something this deck holds, or null. */
  const resolveChatRef = (deck: Deck, ref: ChatRef | undefined): ChatRef | null | undefined => {
    if (!ref) return undefined;
    if ('commentId' in ref) {
      const exists = deck.slides.some((slide) => slide.comments?.some((comment) => comment.id === ref.commentId)
        || slide.elements.some((element) => element.comments?.some((comment) => comment.id === ref.commentId)));
      return exists ? ref : null;
    }
    const slide = deck.slides.find((candidate) => candidate.id === ref.slideId);
    if (!slide) return null;
    if (ref.elementId && !slide.elements.some((element) => element.id === ref.elementId)) return null;
    return ref;
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
  const canUseSharedAgent = (_request: IncomingMessage): boolean => Boolean(sharedAgent);

  const agentChatId = (deckId: string, participantId: string | null): string | null => {
    if (sharedAgent && participantId) return sharedAgent.chatId(deckDirOf(deckId), participantId);
    return null;
  };

  const publicAgentState = (
    state: AgentPanelState,
    deckId: string,
    _canManageAccount: boolean,
  ): AgentPanelState => ({
    ...state,
    // Never expose the server's absolute deck path or the demo owner's email
    // to remote participants. The loopback owner retains normal account UI.
    // A participant's own local agent is theirs to see by name.
    deckPath: deckId,
    agentName: state.agentName,
  });

  const emitSharedAgentState = (state: AgentPanelState, participantId: string): void => {
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
      const text = `server error: ${error instanceof Error ? error.message : String(error)}`;
      // Every API client reads `{ error }`; a plain-text body was dropped by
      // the bridge's JSON parse, so an agent saw only "sync failed (500)".
      if (request.url?.startsWith('/api/') && !response.headersSent) {
        respondJson(response, 500, { error: text });
        return;
      }
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(text);
    });
  });

  /**
   * Whether this server's headless browser starts, probed once and kept. An
   * environment that cannot start it stays that way until someone changes it
   * and restarts the server, so only a failure is ever probed again, and not
   * more than once a minute.
   */
  let browserProbe: { at: number; problem: Promise<string | null>; failed: boolean } | null = null;
  const browserProblem = (): Promise<string | null> => {
    if (!browserProbe || (browserProbe.failed && Date.now() - browserProbe.at > 60_000)) {
      const probe = { at: Date.now(), problem: headlessBrowserProblem(), failed: false };
      void probe.problem.then((problem) => { probe.failed = problem !== null; });
      browserProbe = probe;
    }
    return browserProbe.problem;
  };

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
  ): Promise<{
    draft: HttpHtmlDraft;
    preview: HtmlDraftPreview;
    body: Record<string, unknown>;
    compiled: Awaited<ReturnType<typeof compileHtmlToSlides>>;
  } | { error: string }> {
    const sanitized = await sanitizeServerHtml(html, room.session.dir);
    const sanitizedAt = Date.now();
    const temp = await mkdtemp(join(tmpdir(), 'slide-http-preview-'));
    const htmlPath = join(temp, 'slides.html');
    try {
      await writeFile(htmlPath, sanitized.html, 'utf8');
      let compiled: Awaited<ReturnType<typeof compileHtmlToSlides>>;
      try {
        compiled = await compileHtmlToSlides({ deckDir: room.session.dir, deck: room.session.deck, htmlPath });
      } catch (error) {
        if (error instanceof HtmlAuthoringError) return { error: error.message };
        throw error;
      }
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
      return { draft, preview, compiled, body: {
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

    if (path.startsWith('/api/agent-mirror/') && request.headers[BRIDGE_HEADER] !== '1') {
      return respondJson(response, 404, { error: 'not found' });
    }

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

    /**
     * The access sidecar for a freshly imported deck.
     *
     * Imported decks land private to whoever uploaded them, exactly like decks
     * created here: accidental exposure should take an explicit act, not the
     * absence of one. Publishing one is that explicit act, and it belongs in
     * the Share… dialog — the single place that answers "who can open this",
     * for every deck, however it arrived.
     */
    async function writeImportedDeckAccess(dir: string): Promise<void> {
      if (!accessControl || !identity) return;
      await writeDeckAccess(dir, {
        owner: identity.login, visibility: 'private', sharedWith: [], publicRole: 'view',
      });
    }
    // A malformed deck id is answered once, here, rather than becoming a 500
    // in whichever route happened to open it.
    if (deckParam && !splitDeckPath(deckParam)) {
      return respondJson(response, 400, { error: 'invalid deck id' });
    }
    if (deckParam && !(await deckAllowed(identity, deckParam))) {
      return respondJson(response, 403, { error: 'you do not have access to this deck' });
    }
    // View-only is enforced here, once, for every deck-scoped route: anything
    // that is not a plain read of the deck needs edit rights. Routes that
    // create a deck carry ?name= rather than ?deck= and are not covered —
    // creating is not editing something that already exists.
    if (deckParam && request.method !== 'GET' && request.method !== 'HEAD'
      && !(await deckWritable(identity, deckParam))) {
      return respondJson(response, 403, { error: 'you have view-only access to this presentation' });
    }
    // Agent invite URLs open the deck as a viewer. Authoring happens only in
    // the filesystem mirror created by slide-agent connect.
    if ((path === '/' || path === '/index.html')
      && url.searchParams.get('agent') === '1'
    ) {
      return redirectToViewer(response, url);
    }

    // A view-only participant never gets the editor shell. It would let them
    // move things on screen that the server then refuses, so they get the
    // presentation page instead — read-only by construction, and live.
    if ((path === '/' || path === '/index.html') && deckParam
      && (await deckRoleOf(identity, deckParam)) === 'view') {
      return redirectToViewer(response, url);
    }

    // Deck-scoped asset streaming: /decks/<id>/assets/<relpath>
    // The deck id is a path, so it may itself contain slashes; the assets/
    // marker is what separates it from the file being served.
    const assetMatch = /^\/decks\/(.+)\/(assets\/.+)$/.exec(path);
    if (assetMatch) {
      // A view still open on a renamed deck (a Speaker View window, a tab
      // that has not followed yet) asks for media under the old id. Send it
      // on, so a clip that loads late in a talk still plays.
      const forward = movedDecks.get(assetMatch[1]);
      if (forward && !deckFolderExists(assetMatch[1]) && await deckAllowed(identity, forward.id)) {
        const encoded = (value: string): string => value.split('/').map(encodeURIComponent).join('/');
        response.writeHead(307, { location: `/decks/${encoded(forward.id)}/${encoded(assetMatch[2])}${url.search}` });
        response.end();
        return;
      }
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
      // An oversized clip is served as its rendition once one exists, and as
      // itself until then — a slide that waits for a transcode is worse than
      // one that streams the original. The request is also what triggers the
      // transcode for a deck nobody has warmed.
      let served = absolute;
      let revalidate = false;
      let pinned = false;
      if (renditions && isVideoAsset(absolute)) {
        try {
          const info = await stat(absolute);
          const ready = renditions.ready(absolute, info.size, info.mtimeMs);
          // A pinned URL (`?v=`) always answers with the variant it names, so a
          // playing <video> never sees its bytes swapped mid-stream. The pin
          // carries the source's size and mtime, so its answer is immutable.
          const pin = url.searchParams.get('v');
          const pinnedFile = pin ? renditions.pinned(absolute, info.size, info.mtimeMs, pin) : null;
          if (pinnedFile) {
            served = pinnedFile;
            // A bare `o` names no particular revision of the file, so it stays
            // revalidated; a keyed pin names exact bytes.
            pinned = pin !== 'o';
            revalidate = pin === 'o';
            if (pinnedFile === absolute && !ready) void renditions.ensure(absolute).catch(() => null);
          } else if (ready) {
            served = ready;
            revalidate = true;
          } else if (renditions.pending(absolute, info.size, info.mtimeMs)) {
            // The browser must not cache the original for a year: its
            // replacement may land at any moment, and an immutable copy would
            // never be asked about again.
            revalidate = true;
            void renditions.ensure(absolute).catch(() => null);
          }
        } catch {
          // Unreadable here means unreadable below; let the normal path 404.
        }
      }
      await serveFileWithRanges(request, response, served, undefined, {
        revalidate,
        immutable: pinned,
        etagSalt: served === absolute ? '' : 'rendition',
      });
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

    if (path === '/api/config' && request.method === 'GET') {
      respondJson(response, 200, {
        hosted: Boolean(hostedDeckId),
        deckId: hostedDeckId ?? null,
        agentMode: Boolean(options.agentMode),
        access: accessControl && identity ? {
          user: identity.login,
          name: identity.name,
          admin: identity.login === accessControl.admin,
          // Present only when the request names a deck: what this person may
          // do with that one. The client uses it to label its chrome.
          ...(deckParam ? { deckRole: await deckRoleOf(identity, deckParam) } : {}),
        } : null,
        agentPanel: canUseSharedAgent(request) ? {
          enabled: true,
          name: sharedAgent?.name ?? 'Agent',
          canManageAccount: isHostRequest(request),
          mode: 'local',
        } : null,
        urls: boundPort === null ? [] : reachableUrls(host, boundPort),
      });
      return;
    }

    // Removed authoring surface. Agents use slide-agent against a local deck
    // folder (or the folder mirrored by slide-agent connect); the server API
    // is private transport for that bridge, not a second authoring contract.
    if (['/api/brief', '/api/edit-schema', '/api/preview-edits', '/api/apply-edits',
      '/api/preview-html', '/api/apply-html'].includes(path)) {
      return respondJson(response, 410, {
        error: 'The direct Agent HTTP API was removed. Click Agent… and use slide-agent connect.',
      });
    }

    if (path === '/api/agent-panel/events' && request.method === 'GET') {
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

    if (path === '/api/agent-panel/state' && request.method === 'GET') {
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
        respondJson(response, 200, {
          ...access,
          canManage,
          role: deckRoleFor(identity.login, access, accessControl),
        });
        return;
      }
      if (request.method === 'PUT' || request.method === 'POST') {
        if (!canManage) {
          return respondJson(response, 403, { error: 'only the deck owner or the admin can change access' });
        }
        let payload: {
          visibility?: unknown; sharedWith?: unknown; owner?: unknown; publicRole?: unknown;
        };
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
        if (payload.publicRole !== undefined) {
          if (payload.publicRole !== 'edit' && payload.publicRole !== 'view') {
            return respondJson(response, 400, { error: 'publicRole must be "edit" or "view"' });
          }
          next.publicRole = payload.publicRole;
        }
        if (payload.sharedWith !== undefined) {
          // Entries are `{ login, role }`; a bare login still means edit, so
          // an older client PUTting back what it read stays correct.
          const rows = payload.sharedWith;
          const wellFormed = Array.isArray(rows) && rows.length <= 500 && rows.every((entry) =>
            typeof entry === 'string'
            || (Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
              && typeof (entry as { login?: unknown }).login === 'string'
              && ['edit', 'view', undefined].includes((entry as { role?: unknown }).role as string)));
          if (!wellFormed) {
            return respondJson(response, 400, {
              error: 'sharedWith must be an array of logins or { login, role } entries',
            });
          }
          next.sharedWith = normalizeShares(rows);
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
        // Demotion to view-only counts: that peer is sitting in an editor
        // whose every transaction the server would now refuse, so it is sent
        // back to reload into the read-only page.
        for (const peer of rooms.get(deckParam)?.peers.values() ?? []) {
          if (!peer.identity) continue;
          if (!canAccessDeck(peer.identity.login, next, accessControl)) {
            peer.socket.close(4003, 'your access to this deck was revoked');
          } else if (peer.canEdit && !canEditDeck(peer.identity.login, next, accessControl)) {
            peer.socket.close(4003, 'your access to this deck is now view-only — reload to keep watching');
          }
        }
        respondJson(response, 200, {
          ...next,
          canManage: canManageDeck(identity.login, next, accessControl),
          role: deckRoleFor(identity.login, next, accessControl),
        });
        return;
      }
      return respondJson(response, 405, { error: 'method not allowed' });
    }

    // The folder tree, already filtered: a folder nobody has shared anything
    // with you inside is not listed, so you never learn it is there.
    if (path === '/api/folders' && request.method === 'GET') {
      respondJson(response, 200, await listFolders(identity));
      return;
    }

    if (hostedDeckId && (path === '/api/decks' || path === '/api/folders'
      || path === '/api/decks/move' || path === '/api/decks/rename'
      || path === '/api/folders/rename'
      || path === '/api/import-keynote' || path === '/api/import-pptx')
      && request.method !== 'GET') {
      respondJson(response, 403, { error: 'this session hosts a single shared presentation' });
      return;
    }

    if (path === '/api/folders' && request.method === 'POST') {
      const target = sanitizeFolderPath(url.searchParams.get('path') ?? '');
      if (!target) return respondJson(response, 400, { error: 'missing or invalid folder path' });
      const segments = splitDeckPath(target);
      if (!segments) return respondJson(response, 400, { error: 'missing or invalid folder path' });
      if (existsSync(folderDirOf(target))) {
        return respondJson(response, 409, { error: `"${target}" already exists` });
      }
      // Walk the ancestors: a deck is not a folder and cannot contain one,
      // and a folder you cannot see is not one you may file work inside.
      for (let depth = 1; depth < segments.length; depth++) {
        const ancestor = segments.slice(0, depth).join('/');
        const ancestorDir = folderDirOf(ancestor);
        if (!existsSync(ancestorDir)) break;
        if (isDeckDir(ancestorDir)) {
          return respondJson(response, 400, { error: `"${ancestor}" is a presentation, not a folder` });
        }
        if (!(await folderVisible(identity, ancestor))) {
          return respondJson(response, 403, { error: 'you do not have access to that folder' });
        }
      }
      const created: string[] = [];
      for (let depth = 1; depth <= segments.length; depth++) {
        const step = segments.slice(0, depth).join('/');
        if (!existsSync(folderDirOf(step))) created.push(step);
      }
      await mkdir(folderDirOf(target), { recursive: true });
      // Every folder this call brought into being belongs to its creator —
      // which is also what keeps a brand new, still-empty folder visible to
      // them while they put the first presentation in it.
      if (accessControl && identity) {
        for (const step of created) await writeFolderOwner(folderDirOf(step), identity.login);
      }
      respondJson(response, 200, { path: target, created });
      return;
    }

    // Rename a folder. Every deck inside it is filed under its path, so all
    // of their ids change at once — which is why none of them may be open.
    if (hostedDeckId && (path === '/api/trash' || path === '/api/trash/restore')) {
      return respondJson(response, 403, { error: 'this session hosts a single shared presentation' });
    }

    // The trash: what this person could see before it was trashed, newest first.
    if (path === '/api/trash' && request.method === 'GET') {
      let entries: string[] = [];
      try {
        entries = (await readdir(TRASH_DIR, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && TRASH_ENTRY_ID.test(entry.name))
          .map((entry) => entry.name);
      } catch {
        // No trash yet.
      }
      const listed = [];
      for (const id of entries) {
        const entryDir = join(TRASH_DIR, id);
        const meta = await readTrashMeta(entryDir);
        if (!meta || !existsSync(join(entryDir, 'item'))) continue;
        const access = await treeAccess(join(entryDir, 'item'), identity);
        if (!access.visible) continue;
        listed.push({ id, ...meta, canRestore: access.editable });
      }
      listed.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
      respondJson(response, 200, listed);
      return;
    }

    // Move a deck or folder into the trash. Needs write access to all of it.
    if (path === '/api/trash' && request.method === 'POST') {
      const target = url.searchParams.get('path') ?? '';
      if (!splitDeckPath(target)) return respondJson(response, 400, { error: 'missing or invalid path' });
      let dir: string;
      try {
        dir = folderDirOf(target);
      } catch {
        return respondJson(response, 400, { error: 'missing or invalid path' });
      }
      if (!existsSync(dir)) return respondJson(response, 404, { error: 'no such presentation or folder' });
      const kind = isDeckDir(dir) ? 'deck' : 'folder';
      // A deck's own subdirectories (assets/, edit/) are not things to trash.
      const segments = target.split('/');
      for (let depth = 1; depth < segments.length; depth++) {
        if (isDeckDir(folderDirOf(segments.slice(0, depth).join('/')))) {
          return respondJson(response, 404, { error: 'no such presentation or folder' });
        }
      }
      const access = await treeAccess(dir, identity);
      if (!access.visible) return respondJson(response, 404, { error: 'no such presentation or folder' });
      if (!access.editable) {
        return respondJson(response, 403, {
          error: kind === 'deck'
            ? 'you can only view this presentation, so you cannot delete it'
            : 'you need to own this folder and be able to edit everything in it to delete it',
        });
      }
      if (!(await drainRooms(target))) {
        return respondJson(response, 409, { error: 'somebody has this open — close it everywhere before deleting it' });
      }
      let title: string | undefined;
      if (kind === 'deck') {
        try {
          title = (JSON.parse(await readFile(join(dir, 'deck.json'), 'utf8')) as { title?: string }).title;
        } catch {
          // The folder name will do.
        }
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const id = `${stamp}-${randomUUID().slice(0, 8)}`;
      const entryDir = join(TRASH_DIR, id);
      await mkdir(entryDir, { recursive: true });
      const meta: TrashMeta = {
        originalPath: target,
        kind,
        name: segments[segments.length - 1],
        ...(title ? { title } : {}),
        deletedAt: new Date().toISOString(),
        deletedBy: identity?.login ?? 'local',
      };
      await writeFile(join(entryDir, 'trash.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
      await rename(dir, join(entryDir, 'item'));
      respondJson(response, 200, { id, ...meta });
      return;
    }

    // Put a trashed item back where it was. Same permission as deleting it.
    if (path === '/api/trash/restore' && request.method === 'POST') {
      const id = url.searchParams.get('id') ?? '';
      if (!TRASH_ENTRY_ID.test(id)) return respondJson(response, 400, { error: 'invalid trash id' });
      const entryDir = join(TRASH_DIR, id);
      const meta = await readTrashMeta(entryDir);
      const item = join(entryDir, 'item');
      if (!meta || !existsSync(item)) return respondJson(response, 404, { error: 'no such item in the trash' });
      const access = await treeAccess(item, identity);
      if (!access.visible) return respondJson(response, 404, { error: 'no such item in the trash' });
      if (!access.editable) return respondJson(response, 403, { error: 'you cannot restore this item' });
      const segments = splitDeckPath(meta.originalPath);
      if (!segments) return respondJson(response, 400, { error: 'the original path is invalid' });
      const to = folderDirOf(meta.originalPath);
      if (existsSync(to)) {
        return respondJson(response, 409, { error: `"${meta.originalPath}" exists again — rename or move that first` });
      }
      const created: string[] = [];
      for (let depth = 1; depth < segments.length; depth++) {
        const step = segments.slice(0, depth).join('/');
        const stepDir = folderDirOf(step);
        if (!existsSync(stepDir)) created.push(step);
        else if (isDeckDir(stepDir)) {
          return respondJson(response, 409, { error: `"${step}" is now a presentation, not a folder` });
        }
      }
      if (created.length > 0) await mkdir(dirname(to), { recursive: true });
      if (accessControl && identity) {
        for (const step of created) await writeFolderOwner(folderDirOf(step), identity.login);
      }
      await rename(item, to);
      // Only the now-empty entry and its note go; the item itself is back.
      await rm(join(entryDir, 'trash.json'), { force: true });
      await rmdir(entryDir).catch(() => undefined);
      respondJson(response, 200, { path: meta.originalPath, kind: meta.kind });
      return;
    }

    if (path === '/api/folders/rename' && request.method === 'POST') {
      const target = sanitizeFolderPath(url.searchParams.get('path') ?? '');
      if (!target) return respondJson(response, 400, { error: 'missing or invalid folder path' });
      const name = sanitizeDeckId(url.searchParams.get('name') ?? '');
      if (!name) return respondJson(response, 400, { error: 'missing or invalid name' });
      const dir = folderDirOf(target);
      if (!existsSync(dir) || isDeckDir(dir) || !(await folderVisible(identity, target))) {
        return respondJson(response, 404, { error: 'no such folder' });
      }
      if (accessControl && identity) {
        const owner = await readFolderOwner(dir, accessControl);
        if (identity.login !== accessControl.admin && owner !== identity.login) {
          return respondJson(response, 403, { error: 'only the folder owner or the admin can rename it' });
        }
      }
      const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
      const renamed = parent ? `${parent}/${name}` : name;
      if (renamed === target) return respondJson(response, 200, { path: target });
      let to: string;
      try {
        to = folderDirOf(renamed);
      } catch {
        return respondJson(response, 400, { error: 'missing or invalid name' });
      }
      if (existsSync(to)) return respondJson(response, 409, { error: `"${renamed}" already exists` });
      const inside = [...rooms.keys()].filter((id) => id.startsWith(`${target}/`));
      if (inside.some((id) => (rooms.get(id)?.peers.size ?? 0) > 0)) {
        return respondJson(response, 409, {
          error: 'somebody has a presentation in this folder open — close it everywhere before renaming it',
        });
      }
      for (const id of inside) {
        const room = rooms.get(id);
        if (room) {
          await room.session.flush();
          await room.session.close();
          rooms.delete(id);
        }
        forgetDeckState(id);
      }
      await rename(dir, to);
      respondJson(response, 200, { path: renamed });
      return;
    }

    if (path === '/api/folders' && request.method === 'DELETE') {
      const target = sanitizeFolderPath(url.searchParams.get('path') ?? '');
      if (!target) return respondJson(response, 400, { error: 'missing or invalid folder path' });
      const dir = folderDirOf(target);
      if (!existsSync(dir) || isDeckDir(dir) || !(await folderVisible(identity, target))) {
        return respondJson(response, 404, { error: 'no such folder' });
      }
      if (accessControl && identity) {
        const owner = await readFolderOwner(dir, accessControl);
        if (identity.login !== accessControl.admin && owner !== identity.login) {
          return respondJson(response, 403, { error: 'only the folder owner or the admin can delete it' });
        }
      }
      // Only ever an empty folder: deleting presentations is not something a
      // folder operation gets to do as a side effect.
      const remaining = (await readdir(dir)).filter((entry) => entry !== FOLDER_FILE);
      if (remaining.length > 0) {
        return respondJson(response, 409, { error: 'the folder is not empty' });
      }
      await rm(dir, { recursive: true, force: true });
      respondJson(response, 200, { path: target, deleted: true });
      return;
    }

    if (path === '/api/decks/move' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const folder = sanitizeFolderPath(url.searchParams.get('folder') ?? '');
      if (folder === null) return respondJson(response, 400, { error: 'invalid folder' });
      let from: string;
      try {
        from = deckDirOf(deckParam);
      } catch {
        return respondJson(response, 400, { error: 'invalid deck id' });
      }
      if (!isDeckDir(from)) return respondJson(response, 404, { error: 'no such deck' });
      if (accessControl && identity) {
        const access = await readDeckAccess(from, accessControl);
        if (!canManageDeck(identity.login, access, accessControl)) {
          return respondJson(response, 403, { error: 'only the deck owner or the admin can move it' });
        }
      }
      if (folder !== '' && (!existsSync(folderDirOf(folder)) || isDeckDir(folderDirOf(folder)))) {
        return respondJson(response, 404, { error: 'no such folder' });
      }
      if (!(await folderVisible(identity, folder))) {
        return respondJson(response, 403, { error: 'you do not have access to that folder' });
      }
      const name = deckParam.slice(deckParam.lastIndexOf('/') + 1);
      const id = folder ? `${folder}/${name}` : name;
      if (id === deckParam) return respondJson(response, 200, { id });
      let to: string;
      try {
        to = deckDirOf(id);
      } catch {
        return respondJson(response, 400, { error: 'the deck would not fit that deep' });
      }
      if (existsSync(to)) {
        return respondJson(response, 409, { error: `"${id}" already exists` });
      }
      const busy = await relocateDeck(deckParam, id, 'moving');
      if (busy) return respondJson(response, busy.status, { error: busy.error });
      respondJson(response, 200, { id });
      return;
    }

    // Rename a presentation: its folder on disk and the title the picker
    // shows are the same name, so both change together — a deck called one
    // thing and filed under another is exactly the confusion this avoids.
    if (path === '/api/decks/rename' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const name = sanitizeDeckId(url.searchParams.get('name') ?? '');
      if (!name) return respondJson(response, 400, { error: 'missing or invalid name' });
      let from: string;
      try {
        from = deckDirOf(deckParam);
      } catch {
        return respondJson(response, 400, { error: 'invalid deck id' });
      }
      if (!isDeckDir(from)) return respondJson(response, 404, { error: 'no such deck' });
      if (accessControl && identity) {
        const access = await readDeckAccess(from, accessControl);
        if (!canManageDeck(identity.login, access, accessControl)) {
          return respondJson(response, 403, { error: 'only the deck owner or the admin can rename it' });
        }
      }
      const folder = deckParam.includes('/') ? deckParam.slice(0, deckParam.lastIndexOf('/')) : '';
      const id = folder ? `${folder}/${name}` : name;
      let to: string;
      try {
        to = deckDirOf(id);
      } catch {
        return respondJson(response, 400, { error: 'missing or invalid name' });
      }
      if (id !== deckParam && existsSync(to)) {
        return respondJson(response, 409, { error: `"${id}" already exists` });
      }
      // The folder keeps its name, so only the title can change (an imported
      // deck can carry one its folder does not). With the deck open that is
      // an ordinary edit, broadcast like any other, not a reason to send
      // everybody away.
      const live = rooms.get(deckParam);
      if (id === deckParam && live && live.peers.size > 0 && !live.relocating) {
        if (live.session.deck.title !== name) {
          const ops: AgentOperation[] = [{ op: 'updateDeck', title: name }];
          const txnId = `rename-${randomUUID()}`;
          const label = `Rename to “${name}”`;
          const applied = live.session.applyOps(ops, { label, txnId, author: httpAuthor(identity, null) });
          broadcast(live, {
            kind: 'txn', seq: applied.seq, txnId,
            byClientId: '', label, ops,
          });
        }
        respondJson(response, 200, { id, title: name });
        return;
      }
      // Renaming the folder is renaming the room: done live, peers follow.
      const busy = await relocateDeck(deckParam, id, 'renaming', { title: name, live: true });
      if (busy) return respondJson(response, busy.status, { error: busy.error });
      respondJson(response, 200, { id, title: name });
      return;
    }

    if (path === '/api/decks' && request.method === 'POST') {
      const name = sanitizeDeckId(url.searchParams.get('name') ?? '');
      if (!name) return respondJson(response, 400, { error: 'missing or invalid name' });
      const folder = sanitizeFolderPath(url.searchParams.get('folder') ?? '');
      if (folder === null) return respondJson(response, 400, { error: 'invalid folder' });
      if (folder !== '' && !(await folderVisible(identity, folder))) {
        return respondJson(response, 404, { error: 'no such folder' });
      }
      const id = folder ? `${folder}/${name}` : name;
      let dir: string;
      try {
        dir = deckDirOf(id);
      } catch {
        return respondJson(response, 400, { error: 'missing or invalid name' });
      }
      if (existsSync(dir)) return respondJson(response, 409, { error: `deck "${id}" already exists` });
      await createDeck(dir, name);
      // New decks start private to their creator: accidental exposure should
      // take an explicit act, not the absence of one.
      if (accessControl && identity) {
        await writeDeckAccess(dir, {
          owner: identity.login, visibility: 'private', sharedWith: [], publicRole: 'edit',
        });
      }
      respondJson(response, 200, { id });
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
      const folder = sanitizeFolderPath(url.searchParams.get('folder') ?? '');
      if (folder === null) return respondJson(response, 400, { error: 'invalid folder' });
      if (folder !== '' && !(await folderVisible(identity, folder))) {
        return respondJson(response, 404, { error: 'no such folder' });
      }
      const id = folder ? `${folder}/${name}` : name;
      let dir: string;
      try {
        dir = deckDirOf(id);
      } catch {
        return respondJson(response, 400, { error: 'missing or invalid name' });
      }
      if (existsSync(dir)) return respondJson(response, 409, { error: `deck "${id}" already exists` });
      const body = await readBody(request);
      const tmp = await mkdtemp(join(tmpdir(), 'collab-import-'));
      const sourceFile = join(tmp, `${name}${importRoute.extension}`);
      const upload = { deck: id, file: basename(sourceFile), bytes: body.length, by: identity?.login ?? null };
      try {
        await writeFile(sourceFile, body);
        const report = await importRoute.run(sourceFile, dir);
        await writeImportedDeckAccess(dir);
        await keepUpload(sourceFile, { ...upload, ok: true });
        respondJson(response, 200, { id, report });
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        const message = String(error instanceof Error ? error.message : error);
        // The person only sees this in their browser; keep it in the journal
        // (and the file in .uploads/, when kept) so the failure can be debugged.
        process.stderr.write(`import of "${id}"${importRoute.extension} (${body.length} bytes) failed: ${message}\n`);
        await keepUpload(sourceFile, { ...upload, ok: false, error: message });
        respondJson(response, 400, { error: message });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      return;
    }

    // Import a deck archive — the zip that Save As → Deck archive produces,
    // or any folder holding a deck.json zipped up. Unlike the Keynote and
    // PowerPoint routes there is no importer sidecar to run: the archive is
    // already a deck folder, so this unpacks it and checks that what came out
    // is one.
    if (path === '/api/import-deck' && request.method === 'POST') {
      const name = sanitizeDeckId(url.searchParams.get('name') ?? '');
      if (!name) return respondJson(response, 400, { error: 'missing or invalid name' });
      const folder = sanitizeFolderPath(url.searchParams.get('folder') ?? '');
      if (folder === null) return respondJson(response, 400, { error: 'invalid folder' });
      if (folder !== '' && !(await folderVisible(identity, folder))) {
        return respondJson(response, 404, { error: 'no such folder' });
      }
      const id = folder ? `${folder}/${name}` : name;
      let dir: string;
      try {
        dir = deckDirOf(id);
      } catch {
        return respondJson(response, 400, { error: 'missing or invalid name' });
      }
      if (existsSync(dir)) return respondJson(response, 409, { error: `deck "${id}" already exists` });
      try {
        const files = deckArchiveEntries(readZip(await readBody(request)));
        await mkdir(dir, { recursive: true });
        for (const file of files) {
          const target = join(dir, ...file.name.split('/'));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.data);
        }
        await writeImportedDeckAccess(dir);
        respondJson(response, 200, { id, report: { files: files.length } });
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      }
      return;
    }

    if (path === '/api/upload' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const name = url.searchParams.get('name') ?? 'upload';
      const dir = await mkdtemp(join(tmpdir(), 'collab-upload-'));
      const tmpFile = join(dir, sanitizeFilename(name));
      try {
        // Streamed to disk, never buffered: a screen recording is routinely a
        // gigabyte, and holding it (twice, through Buffer.concat) in the
        // server's heap is what pushed it into the GC storms it died in.
        await pipeline(request, createWriteStream(tmpFile));
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
      const payload = JSON.parse((await readBody(request)).toString('utf8')) as {
        url?: string; name?: string; deckAsset?: boolean;
      };
      if (!payload.url) return respondJson(response, 400, { error: 'missing url' });
      // An image dragged out of another DeckWerk tab is one of this server's own
      // deck assets. Fetching it back over the network is refused (a tailnet
      // address is not public) and left an "Upload failed" frame; it is a file
      // on this disk, so copy it — as long as this user may see that deck.
      const local = payload.deckAsset
        ? /^\/decks\/(.+)\/(assets\/.+)$/.exec(decodeURIComponent(new URL(payload.url).pathname))
        : null;
      if (local) {
        if (!(await deckAllowed(identity, local[1]))) return respondJson(response, 403, { error: 'forbidden' });
        try {
          const sourceDir = deckDirOf(local[1]);
          const absolute = resolveAsset(sourceDir, local[2]);
          if (!absolute.startsWith(join(sourceDir, 'assets') + '/')) throw new Error('outside assets');
          respondJson(response, 200, await importAsset(deckDirOf(deckParam), absolute));
        } catch (error) {
          respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
        }
        return;
      }
      const dir = await mkdtemp(join(tmpdir(), 'collab-url-import-'));
      try {
        const downloaded = await downloadPublicAsset(payload.url);
        // Image CDNs (Unsplash, Google's thumbnails, most of them) serve from
        // paths with no extension; the importer decides by extension, so name
        // the bytes by what the server said they are.
        const requestedName = withMediaExtension(
          payload.name?.trim() || basename(downloaded.url.pathname) || 'download',
          downloaded.contentType,
          downloaded.bytes,
        );
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
      // The edit log stays on the server: it names everyone who edited the
      // deck and keeps what they deleted, and an import drops it anyway.
      const files = (await collectDeckFiles(deckDir)).filter((file) => !HISTORY_FILES.includes(file.name));
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

    // Whether this server can compile, render and check pages at all. The
    // bridge asks as it connects, so an agent and the person's Agent panel
    // learn that the server is broken before the first save, not from it.
    if (path === '/api/agent-mirror/health' && request.method === 'GET') {
      if (!localAgents) return respondJson(response, 404, { error: 'local agents are not enabled' });
      const problem = await browserProblem();
      respondJson(response, 200, { browser: problem ? { ok: false, error: problem } : { ok: true } });
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

    // `./deck theme …` for a mirror: the gallery, and choosing or applying a
    // built-in theme, against the room's deck and stylesheet (mirrorTheme.ts).
    if (path === '/api/agent-mirror/theme' && request.method === 'POST') {
      if (!localAgents) return respondJson(response, 404, { error: 'local agents are not enabled' });
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      let parsed: MirrorThemeRequest;
      try {
        parsed = MirrorThemeRequestSchema.parse(JSON.parse((await readBody(request)).toString('utf8') || '{}'));
      } catch (error) {
        return respondJson(response, 400, { error: `bad theme request: ${String(error instanceof Error ? error.message : error)}` });
      }
      const room = await getRoom(deckParam);
      const deck = room.session.deck;
      if (parsed.slideIds?.length) {
        const chosen = slidesByRef(deck, parsed.slideIds.join(','));
        if ('error' in chosen) return respondJson(response, 404, { error: chosen.error });
        parsed = { ...parsed, slideIds: chosen.slides.map((slide) => slide.id) };
      }
      const result = mirrorThemeAction(deck, room.session.themeCss, parsed);
      if ('error' in result) return respondJson(response, result.status, { error: result.error });
      let revision = deckRevision(deck);
      if (result.operations.length > 0) {
        const label = result.label ?? 'Theme';
        try {
          applyAgentTransaction(deck, { version: 1, expectedRevision: revision, label, operations: result.operations });
        } catch (error) {
          return respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
        }
        const bridge = agentSessionParam ? localAgents.linked(room.session.dir, agentSessionParam) : null;
        const txnId = `agent-theme-${randomUUID()}`;
        const applied = room.session.applyOps(result.operations, {
          label, txnId, author: httpAuthor(identity, agentAuthor(bridge, agentSessionParam)),
        });
        revision = deckRevision(applied.deck);
        broadcast(room, {
          kind: 'txn', seq: applied.seq, txnId,
          byClientId: bridge && bridge.clientId !== 'http' ? bridge.clientId : 'agent-http',
          label, ops: result.operations,
          agentChatId: agentChatId(deckParam, agentSessionParam) ?? undefined,
        });
      }
      if (result.css !== null && result.css !== room.session.themeCss) {
        room.session.saveThemeCss(result.css);
        broadcast(room, { kind: 'theme', css: result.css, byClientId: '' });
      }
      respondJson(response, 200, {
        status: 'applied',
        applied: result.operations.length > 0 || result.css !== null,
        revision,
        ...(result.css !== null ? { stylesheet: deck.theme } : {}),
        ...result.body,
      });
      return;
    }

    // Interactive-page tooling for the zero-install mirror CLI. The server
    // already owns the browser-backed HTML compiler, so it also performs the
    // web-element check and poster capture; the participant's machine needs
    // only Node, just like every other ./deck command.
    if ((path === '/api/agent-mirror/web/check' || path === '/api/agent-mirror/web/add')
      && request.method === 'POST') {
      if (!localAgents) return respondJson(response, 404, { error: 'local agents are not enabled' });
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const size = /^(\d+)x(\d+)$/.exec(url.searchParams.get('size') ?? '1920x1080');
      if (!size) return respondJson(response, 400, { error: 'size takes WIDTHxHEIGHT' });
      const width = Number(size[1]);
      const height = Number(size[2]);
      if (width < 1 || height < 1 || width > 8192 || height > 8192) {
        return respondJson(response, 400, { error: 'size must be between 1x1 and 8192x8192' });
      }
      const body = (await readBody(request)).toString('utf8');
      if (!body.trim()) return respondJson(response, 400, { error: 'missing html' });
      const requestedName = sanitizeFilename(url.searchParams.get('name') ?? 'page.html');
      const pageName = /\.x?html?$/i.test(requestedName) ? requestedName : `${requestedName}.html`;
      const temp = await mkdtemp(join(tmpdir(), 'deckwerk-mirror-web-'));
      try {
        const sourcePath = join(temp, pageName);
        await writeFile(sourcePath, body, 'utf8');
        if (path.endsWith('/check')) {
          const stagedPath = join(temp, `staged-${pageName}`);
          await writeFile(stagedPath, injectWebBridgeRuntime(body), 'utf8');
          const checked = await checkWebPage({ pagePath: stagedPath, width, height });
          respondJson(response, 200, { ...checked, checked: pageName });
          return;
        }

        const room = await getRoom(deckParam);
        const page = await importWebPage(room.session.dir, sourcePath, injectWebBridgeRuntime);
        const poster = page.src.replace(/\.html?$/i, '.poster.png');
        let checked: Awaited<ReturnType<typeof checkWebPage>> | null = null;
        try {
          checked = await checkWebPage({
            pagePath: join(room.session.dir, page.src),
            width,
            height,
            screenshot: join(room.session.dir, poster),
          });
        } catch {
          // The live page remains useful without a poster. Match the local CLI:
          // capture failure is reported but does not discard the staged page.
        }
        const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(body);
        const title = (url.searchParams.get('title') ?? titleMatch?.[1] ?? basename(pageName, extname(pageName)))
          .replace(/\s+/g, ' ').trim();
        const escapedTitle = title.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        const actualPoster = checked ? poster : null;
        respondJson(response, 200, {
          src: page.src,
          poster: actualPoster,
          title,
          size: { w: width, h: height },
          bytes: page.bytes,
          ...(checked ? {
            ok: checked.ok,
            problems: checked.problems,
            console: checked.console,
            remoteRequests: checked.remoteRequests,
            cacheHit: checked.cacheHit,
            durationMs: checked.durationMs,
          } : { ok: null, problems: ['poster and browser check were unavailable on the server'] }),
          assets: [page.src, ...(actualPoster ? [actualPoster] : [])],
          markup: `<div data-element="web" data-src="${page.src}"${actualPoster ? ` data-poster="${actualPoster}"` : ''} data-title="${escapedTitle}" style="width:${width}px;height:${height}px"></div>`,
          hint: 'Put that div in an authoring page beside a real <h1> and caption; its CSS box is its geometry.',
        });
      } catch (error) {
        respondJson(response, 500, { error: String(error instanceof Error ? error.message : error) });
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
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
      // New slides go last unless `--after` names a slide (id or 1-based
      // number); `--after 0` puts them first.
      const afterRef = url.searchParams.get('after')?.trim();
      let after: string | null = deck.slides.at(-1)?.id ?? null;
      if (afterRef) {
        const anchor = insertionAnchor(deck, afterRef);
        if (anchor === undefined) return respondJson(response, 404, { error: `no slide ${afterRef}` });
        after = anchor;
      }
      const target: HttpHtmlDraft['target'] = scope
        ? { mode: 'replace', slideIds: scope }
        : { mode: 'insert', afterSlideId: after };
      const compiledDraft = await compileHtmlDraft(deckParam, room, html, target, agentSessionParam, startedAt);
      if ('error' in compiledDraft) return respondJson(response, 400, { error: compiledDraft.error });
      // People keep editing while a page compiles, and that is fine: the
      // browser's layout depends only on the page, the theme and the canvas.
      // What does depend on the rest of the deck — the ids new slides and
      // objects are minted, the layout masters — is worked out again below
      // against the deck as it is now, with nothing awaited between that and
      // the apply. Answering 409 instead (and only for edits that happened to
      // land after the compile) made a busy session drop an agent's saves.
      const themeNow = await loadTheme(room.session.dir, room.session.deck.theme);
      const live = room.session.deck;
      if (themeNow !== compiledDraft.compiled.theme
        || live.canvas.w !== deck.canvas.w || live.canvas.h !== deck.canvas.h) {
        return respondJson(response, 409, {
          error: 'the theme or the canvas changed while this page compiled, so its layout is stale; save it again',
        });
      }
      if (afterRef) {
        const anchor = insertionAnchor(live, afterRef);
        if (anchor === undefined) return respondJson(response, 404, { error: `no slide ${afterRef}` });
        after = anchor;
      } else {
        after = live.slides.at(-1)?.id ?? null;
      }
      // Review state the page cannot carry (notes, skip, comments, non-appear
      // builds) and dropping replacements that change nothing are both
      // htmlSyncOperations' job, shared with the desktop editor and the CLI.
      let operations: AgentOperation[];
      try {
        compiledDraft.draft.slides = slidesFromMeasured(live, compiledDraft.compiled.measured);
        compiledDraft.draft.revision = deckRevision(live);
        operations = htmlSyncOperations(live, compiledDraft.draft.slides, scope, after,
          pageBases(compiledDraft.compiled.measured));
      } catch (error) {
        return respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      }
      const label = url.searchParams.get('label')?.trim().slice(0, 200)
        || htmlChangeLabel(html)
        || htmlSyncHistoryLabel(operations);
      const changes = htmlSyncSummary(operations);
      let revision = compiledDraft.draft.revision;
      if (operations.length > 0) {
        // Strict validation first, as the editor does before its lenient replay.
        try {
          applyAgentTransaction(room.session.deck, { version: 1, expectedRevision: revision, label, operations });
        } catch (error) {
          return respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
        }
        const bridge = agentSessionParam ? localAgents.linked(room.session.dir, agentSessionParam) : null;
        const txnId = `agent-sync-${randomUUID()}`;
        const applied = room.session.applyOps(operations, {
          label, txnId, author: httpAuthor(identity, agentAuthor(bridge, agentSessionParam)),
        });
        revision = deckRevision(applied.deck);
        broadcast(room, {
          kind: 'txn', seq: applied.seq, txnId,
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
        // What the page now says its slides are, for the bridge to stamp into
        // it: the next save of the same page is compared with this.
        stamp: pageStampOf(compiledDraft.draft.slides),
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
      let absolute: string;
      try {
        absolute = resolveAsset(room.session.dir, relative);
      } catch (error) {
        return respondJson(response, 400, { error: String(error instanceof Error ? error.message : error) });
      }
      if (request.method === 'GET') {
        if (!existsSync(absolute) || !(await stat(absolute)).isFile()) {
          return respondJson(response, 404, { error: `no such file: ${relative}` });
        }
        await serveFileWithRanges(request, response, absolute);
        return;
      }
      // Uploads land only in assets/, under the exact relative path the agent
      // authored against. Nested directories matter for interactive pages
      // (`assets/web/...`) and remain confined by mirrorPath above.
      if (!relative.startsWith('assets/')) {
        return respondJson(response, 400, { error: 'only files under assets/ can be uploaded' });
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

    // The deck chat (shared/chat.ts): never in deck.json, never a transaction.
    // `?since=<id>` returns what came after that message. `?wait=1` is a long
    // poll for `slide-agent chat --wait`: it answers with the first message
    // a *person* posts mentioning `@<mention>` (default @agent) after `since`
    // — or, without `since`, after the request arrived — or with nothing
    // once `timeout` ms (at most 60 s) pass.
    if (path === '/api/chat' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      const since = url.searchParams.get('since');
      if (url.searchParams.get('wait') === '1') {
        const mention = (url.searchParams.get('mention') ?? AGENT_MENTION).replace(/^@/, '').toLowerCase();
        const timeout = Math.min(Math.max(Number(url.searchParams.get('timeout')) || 25_000, 100), 60_000);
        const waiting = room.session.chat.wait(
          since,
          (message) => !message.agent && message.mentions.includes(mention),
          timeout,
        );
        response.on('close', waiting.cancel);
        const messages = await waiting.result;
        if (response.destroyed) return;
        respondJson(response, 200, {
          chatCount: messages.length, messages, last: messages.at(-1)?.id ?? since ?? null, timedOut: messages.length === 0,
        });
        return;
      }
      const messages = room.session.chat.since(since);
      respondJson(response, 200, {
        chatCount: messages.length, messages, last: room.session.chat.recent(1)[0]?.id ?? null,
      });
      return;
    }

    if (path === '/api/chat' && request.method === 'POST') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      let body: { text?: unknown; author?: unknown; ref?: unknown; slide?: unknown; id?: unknown };
      try {
        body = JSON.parse((await readBody(request)).toString('utf8')) as typeof body;
      } catch {
        return respondJson(response, 400, { error: 'body must be JSON' });
      }
      if (typeof body.text !== 'string' || !body.text.trim()) return respondJson(response, 400, { error: 'missing text' });
      const room = await getRoom(deckParam);
      const deck = room.session.deck;
      let ref: ChatRef | undefined;
      if (body.slide !== undefined && body.slide !== null && body.slide !== '') {
        // The id or the 1-based number, like every other --slide.
        const wanted = String(body.slide);
        const slide = deck.slides.find((candidate) => candidate.id === wanted)
          ?? (/^\d+$/.test(wanted) ? deck.slides[Number(wanted) - 1] : undefined);
        if (!slide) return respondJson(response, 404, { error: `no slide ${wanted}; this deck has ${deck.slides.length}` });
        ref = { slideId: slide.id };
      } else if (body.ref !== undefined) {
        const parsed = ChatRefSchema.safeParse(body.ref);
        if (!parsed.success) return respondJson(response, 400, { error: 'ref must be {slideId, elementId?} or {commentId}' });
        const resolved = resolveChatRef(deck, parsed.data);
        if (!resolved) return respondJson(response, 404, { error: 'ref names nothing in this deck' });
        ref = resolved;
      }
      const bridge = agentSessionParam && localAgents ? localAgents.linked(room.session.dir, agentSessionParam) : null;
      const author = typeof body.author === 'string' && body.author.trim()
        ? body.author.trim()
        : bridge?.name ?? (identity ? `${identity.name} · agent` : 'Agent');
      const message = postChat(room, {
        id: typeof body.id === 'string' ? body.id : undefined,
        author,
        login: identity?.login,
        agent: true,
        text: body.text,
        ref,
      });
      if (!message) {
        if (typeof body.id === 'string' && room.session.chat.has(body.id)) {
          return respondJson(response, 200, room.session.chat.all().find((entry) => entry.id === body.id));
        }
        return respondJson(response, 409, { error: 'this presentation is closing; try again' });
      }
      if (localAgents && agentSessionParam) {
        localAgents.event(room.session.dir, agentSessionParam, { text: `said in chat: ${message.text.slice(0, 160)}` });
      }
      respondJson(response, 200, message);
      return;
    }

    if (path === '/api/context' && request.method === 'GET') {
      if (!deckParam) return respondJson(response, 400, { error: 'missing deck' });
      const room = await getRoom(deckParam);
      respondJson(response, 200, {
        deckId: deckParam,
        revision: deckRevision(room.session.deck),
        canvas: room.session.deck.canvas,
        outline: deckOutline(room.session.deck).map((entry) => ({
          index: entry.index + 1,
          id: entry.id,
          title: entry.name || entry.title,
          hidden: entry.skipped,
          openComments: [
            ...(room.session.deck.slides[entry.index].comments ?? []),
            ...room.session.deck.slides[entry.index].elements.flatMap((element) => element.comments ?? []),
          ]
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
      const txnId = `agent-http-${randomUUID()}`;
      const applied = room.session.applyOps(draft.operations, {
        label, txnId, author: httpAuthor(identity, agentAuthor(null, agentSessionParam)),
      });
      if (applied.skipped.length > 0) {
        return respondJson(response, 409, { error: 'native edit could not apply atomically', skipped: applied.skipped });
      }
      broadcast(room, {
        kind: 'txn', seq: applied.seq, txnId,
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
      const commentLabel = `The Agent added a comment${body.slideId ? ` to slide ${body.slideId}` : ''}: ${body.text.trim().slice(0, 160)}`;
      const applied = room.session.applyOps([operation], {
        label: commentLabel,
        author: httpAuthor(identity, agentAuthor(agentSessionParam ? localAgents?.linked(room.session.dir, agentSessionParam) ?? null : null, agentSessionParam)),
      });
      broadcast(room, {
        kind: 'deck', seq: applied.seq, deck: applied.deck, reason: 'agent-edit',
        label: commentLabel,
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
      const resolveLabel = `The Agent marked comment ${body.commentId} ${body.resolved ?? true ? 'resolved' : 'unresolved'}.`;
      const applied = room.session.applyOps([operation], {
        label: resolveLabel,
        author: httpAuthor(identity, agentAuthor(agentSessionParam ? localAgents?.linked(room.session.dir, agentSessionParam) ?? null : null, agentSessionParam)),
      });
      broadcast(room, {
        kind: 'deck', seq: applied.seq, deck: applied.deck, reason: 'agent-edit',
        label: resolveLabel,
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
      const txnId = `agent-http-${randomUUID()}`;
      const applied = room.session.applyOps(operations, {
        label, txnId, author: httpAuthor(identity, agentAuthor(null, agentSessionParam)),
      });
      // This is a collaboration transaction, not an anonymous external deck
      // replacement. Broadcasting the actual operations and label lets every
      // editor record a distinct, restorable History revision.
      broadcast(room, {
        kind: 'txn',
        seq: applied.seq,
        txnId,
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

  // permessage-deflate: a welcome carries the whole deck, and a talk's deck
  // is a megabyte or more of JSON. Uncompressed, that one frame was most of
  // the wait before a presentation could paint its first slide.
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024 } });
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
      let canEdit = true;
      let canComment = true;
      if (accessControl) {
        identity = resolveIdentity(request, accessControl);
        const role = identity ? await deckRoleOf(identity, deckId) : null;
        if (!identity || !role) {
          // Resume first: the close handshake needs to read the client's
          // close frame, which a paused socket never would.
          socket.resume();
          socket.close(4003, 'you do not have access to this deck');
          return;
        }
        canEdit = role !== 'view';
        canComment = roleMayComment(role);
        if (userDirectory) void userDirectory.note(identity);
      }
      // A rename of this very deck may be landing right now; let it, then
      // look at what is on disk. A missing deck is answered here rather than
      // by getRoom's failure: a client that knew the old id is sent on to
      // where the deck went, or told plainly that there is nothing there.
      await relocations.get(deckId);
      let deckDir: string | null = null;
      try {
        deckDir = deckDirOf(deckId);
      } catch {
        // An invalid id; getRoom below refuses it with the reason.
      }
      if (deckDir && !isDeckDir(deckDir)) {
        socket.resume();
        const moved = movedDecks.get(deckId);
        if (moved && deckFolderExists(moved.id) && await deckAllowed(identity, moved.id)) {
          socket.send(JSON.stringify({ kind: 'deckMoved', deckId: moved.id, title: moved.title } satisfies ServerMessage));
          socket.close(COLLAB_CLOSE.moved, 'presentation renamed');
        } else {
          socket.close(COLLAB_CLOSE.noSuchDeck, 'This presentation no longer exists here. It may have been renamed or moved.');
        }
        return;
      }
      let room: Room;
      try {
        room = await getRoom(deckId);
      } catch (error) {
        socket.close(4004, String(error instanceof Error ? error.message : error).slice(0, 120));
        return;
      }
      bindPeer(room, socket, identity, canEdit, canComment);
      socket.resume();
    })();
  });

  function bindPeer(
    room: Room,
    socket: WebSocket,
    identity: Identity | null,
    canEdit: boolean,
    canComment: boolean,
  ): void {
    const clientId = randomUUID();
    const peer: Peer = {
      socket,
      greeted: false,
      identity,
      canEdit,
      canComment,
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

      // Mid-rename: the session is closing and its folder moving. Anything
      // applied now would be written nowhere; the peer is about to be told
      // where the deck went.
      if (room.relocating) return;

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
          mediaVariants: deckMediaVariants(room.session.dir, room.session.deck),
          peers: [
            ...[...room.peers.values()]
              .filter((p) => p !== peer && p.greeted)
              .map((p) => p.state),
            ...(room.agentPresence ? [room.agentPresence] : []),
          ],
          chat: room.session.chat.recent(),
        });
        broadcast(room, { kind: 'presence', state: peer.state }, clientId);
        return;
      }
      if (!peer.greeted) return;

      // A view-only peer is served, not trusted: it sees everything and
      // changes nothing. Answering a refused transaction with the current
      // deck puts its client back on the authoritative state rather than
      // leaving a phantom local edit on screen.
      if (!peer.canEdit && (message.kind === 'txn' || message.kind === 'theme')) {
        send(peer, { kind: 'deck', seq: room.session.seq, deck: room.session.deck, reason: 'resync' });
        return;
      }

      switch (message.kind) {
        case 'txn': {
          try {
            const applied = room.session.applyOps(message.ops, {
              label: message.label, txnId: message.txnId, author: peerAuthor(peer, clientId),
            });
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
        case 'chat-post': {
          if (!peer.canComment) return;
          const ref = resolveChatRef(room.session.deck, message.ref) ?? undefined;
          postChat(room, {
            id: message.id,
            author: peer.state.name,
            login: identity?.login,
            agent: Boolean(peer.agentFor || peer.state.agent),
            text: message.text,
            ref,
          });
          return;
        }
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
      // A graceful close sends what is queued first -- above all the `ended`
      // that notifyEnded() broadcast a moment ago. Terminating straight away
      // destroyed the socket with that frame unsent, so a peer saw a dropped
      // connection and kept "reconnecting…" instead of learning the host had
      // ended the session. Shutdown still cannot wait on a renderer that is
      // paused, presenting or tearing down, so whatever has not closed after
      // a short grace is terminated. Upgraded sockets are not covered by
      // closeAllConnections(), so they are ended here, before awaiting it.
      const sockets = [...rooms.values()].flatMap((room) => [...room.peers.values()].map((peer) => peer.socket));
      await Promise.race([
        Promise.all(sockets.map((socket) => new Promise<void>((resolveClosed) => {
          if (socket.readyState === socket.CLOSED) return resolveClosed();
          socket.once('close', () => resolveClosed());
          try {
            socket.close(1001, 'session ended');
          } catch {
            resolveClosed();
          }
        }))),
        new Promise<void>((resolveGrace) => setTimeout(resolveGrace, SOCKET_CLOSE_GRACE_MS)),
      ]);
      for (const socket of sockets) {
        if (socket.readyState !== socket.CLOSED) socket.terminate();
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
      await userDirectory?.flush();
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

async function downloadPublicAsset(raw: string): Promise<{ bytes: Buffer; url: URL; contentType: string }> {
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
    return { bytes, url: current, contentType: response.headers.get('content-type') ?? '' };
  }
  throw new Error('asset has too many redirects');
}

/** Extensions for the media types a URL import may name only by MIME type. */
const MEDIA_EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/heic': '.heic', 'image/heif': '.heif',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
};

/**
 * `name`, given the extension its bytes call for when it has no media
 * extension of its own. The Content-Type decides; bytes are sniffed only when
 * the server sent something generic (octet-stream is common on CDNs).
 */
export function withMediaExtension(name: string, contentType: string, bytes: Uint8Array): string {
  if (classifyMediaName(name)) return name;
  const type = contentType.split(';')[0].trim().toLowerCase();
  const ext = MEDIA_EXTENSION_BY_TYPE[type] ?? sniffMediaExtension(bytes);
  return ext ? `${name}${ext}` : name;
}

function sniffMediaExtension(bytes: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (ascii(1, 4) === 'PNG') return '.png';
  if (ascii(0, 4) === 'GIF8') return '.gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif') return '.avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1') return '.heic';
    if (brand === 'qt  ') return '.mov';
    return '.mp4';
  }
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(ascii(0, Math.min(bytes.length, 256)))) return '.svg';
  return null;
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
/** Send this request to the read-only presentation page, params intact. */
function redirectToViewer(response: ServerResponse, url: URL): void {
  const viewer = new URL('/present.html', 'http://localhost');
  for (const [key, value] of url.searchParams) viewer.searchParams.set(key, value);
  if (!viewer.searchParams.has('slide')) viewer.searchParams.set('slide', '1');
  response.writeHead(302, { location: `${viewer.pathname}${viewer.search}` });
  response.end();
}

function sanitizeDeckId(name: string): string {
  return basename(name)
    .replace(/\.(key|pptx|zip)$/i, '')
    .replace(/[^a-zA-Z0-9._ -]+/g, '-')
    .replace(/^[.\s-]+|[\s-]+$/g, '')
    .slice(0, 80);
}

/** Deck ids and folder paths may nest, but only so far. */
const MAX_PATH_SEGMENTS = 8;

/**
 * Split a deck id or folder path into its directory segments, or null if it
 * is not one. This is the single gate every path-shaped parameter passes
 * through: no empty, relative, whitespace-padded or backslash segments, and
 * no unbounded nesting.
 */
function splitDeckPath(value: string): string[] | null {
  if (!value || value.includes('\\') || value.includes('\0') || value.length > 400) return null;
  const segments = value.split('/');
  if (segments.length > MAX_PATH_SEGMENTS) return null;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') return null;
    // Dot-names are never decks or folders: `.trash/` lives at the root and
    // must not be listed, opened, or addressed by any path-taking route.
    if (segment.startsWith('.')) return null;
    if (segment !== segment.trim()) return null;
  }
  return segments;
}

/**
 * Sanitize a typed folder path segment by segment; '' means the root.
 *
 * Characters a folder name cannot hold are cleaned up the way a deck name is,
 * but a relative or empty segment is refused outright rather than tidied
 * away: "a/../b" must not quietly become "a/b" and land somewhere the person
 * who typed it did not mean.
 */
function sanitizeFolderPath(value: string): string | null {
  const raw = value.trim().replace(/^\/+|\/+$/g, '');
  if (raw === '') return '';
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    const trimmed = segment.trim();
    if (trimmed === '' || trimmed === '.' || trimmed === '..') return null;
    const clean = sanitizeDeckId(trimmed);
    if (!clean) return null;
    segments.push(clean);
  }
  const path = segments.join('/');
  return splitDeckPath(path) ? path : null;
}

type ImporterSpec = { binary: string; script: string; label: string };
const KEYNOTE_IMPORTER: ImporterSpec = { binary: 'keynote-import', script: 'importers/keynote/import_keynote.py', label: 'Keynote' };
const POWERPOINT_IMPORTER: ImporterSpec = { binary: 'pptx-import', script: 'importers/pptx/import_pptx.py', label: 'PowerPoint' };

/**
 * How to run an importer sidecar without Electron: the frozen binary when
 * built (build/importers), otherwise the project venv's Python and the source
 * script — the same fallbacks the desktop app uses.
 */
function importerCommand(importer: ImporterSpec): { command: string; args: string[] } {
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
  if (binary) return { command: binary, args: [] };
  if (existsSync(script)) return { command: existsSync(venv) ? venv : 'python3', args: [script] };
  throw new Error(`${importer.label} importer not found (run npm run build:importer)`);
}

function runSidecar(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
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
}

async function runImporter(
  importer: ImporterSpec,
  sourceFile: string,
  outDir: string,
): Promise<unknown> {
  const { command, args } = importerCommand(importer);
  const stdout = await runSidecar(command, [...args, sourceFile, '--out', outDir]);
  const payload = JSON.parse(stdout) as { report?: unknown };
  return payload.report ?? null;
}

/**
 * Whether this machine can import decks, checked the way an upload does it:
 * each importer's `--self-check` (every Python module it can reach, including
 * the lazily imported ones whose absence would only quietly degrade an
 * import), then a real import of a small deck in each format through the same
 * runImporter the upload route calls. Returns one line per problem.
 *
 * scripts/collab-server.mts refuses to start unless this and
 * mediaToolProblems are empty, so a server that cannot import decks fails its
 * deploy health check instead of failing somebody's upload.
 */
export async function importerProblems(): Promise<string[]> {
  const repoRoot = resolve(import.meta.dirname, '../..');
  const samples: Array<[ImporterSpec, string]> = [
    [KEYNOTE_IMPORTER, join(repoRoot, 'example-keynote-decks/empty_deck.key')],
    [POWERPOINT_IMPORTER, join(repoRoot, 'test/fixtures/pptx/reference.pptx')],
  ];
  const problems: string[] = [];
  const work = await mkdtemp(join(tmpdir(), 'deckwerk-import-check-'));
  try {
    for (const [importer, sample] of samples) {
      try {
        const { command, args } = importerCommand(importer);
        await runSidecar(command, [...args, '--self-check']);
        await runImporter(importer, sample, join(work, importer.binary));
      } catch (error) {
        problems.push(`${importer.label} import: ${error instanceof Error ? error.message.trim() : String(error)}`);
      }
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return problems;
}

/**
 * The ffmpeg and ffprobe imports and media probing shell out to: the
 * importers transcode with whatever is on PATH, media probing uses the
 * bundled ffmpeg-static/ffprobe-static and falls back to PATH.
 */
export async function mediaToolProblems(): Promise<string[]> {
  const tools: Array<[string, string]> = [
    ['ffmpeg', 'ffmpeg'], ['ffprobe', 'ffprobe'],
    ['bundled ffmpeg', getFfmpegPath()], ['bundled ffprobe', getFfprobePath()],
  ];
  const problems: string[] = [];
  for (const [name, command] of tools) {
    try {
      await runSidecar(command, ['-version']);
    } catch (error) {
      problems.push(`${name} (${command}) does not run: ${error instanceof Error ? error.message.trim() : String(error)}`);
    }
  }
  return problems;
}

function runKeynoteImport(keyFile: string, outDir: string): Promise<unknown> {
  return runImporter(
    KEYNOTE_IMPORTER,
    keyFile,
    outDir,
  );
}

function runPowerPointImport(pptxFile: string, outDir: string): Promise<unknown> {
  return runImporter(
    POWERPOINT_IMPORTER,
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
    'deck.json', 'notes.md', ...SERVER_SIDECARS, 'edit', themeFile,
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
  if (segments.length === 1 && SERVER_SIDECARS.has(segments[0])) return null;
  return segments.join('/');
}

/**
 * The deck files inside an uploaded archive, ready to write out.
 *
 * `Save As → Deck archive` zips the deck folder's contents, but an archive
 * that has been unzipped and re-zipped (or produced by Finder's "Compress")
 * wraps everything in one deck-named directory, so a single common prefix is
 * stripped. Paths are checked rather than trusted: a zip is attacker-supplied
 * input, and an entry called `../../.ssh/authorized_keys` must not escape the
 * deck directory. The permission sidecars are dropped — access.json travels in
 * the download, and honouring an uploaded one would let anybody hand
 * themselves ownership of a deck by editing a file in a zip.
 */
function deckArchiveEntries(entries: ZipEntry[]): ZipEntry[] {
  if (entries.length === 0) throw new Error('the archive is empty');
  const prefix = commonArchivePrefix(entries);
  const files = entries.map((entry) => ({ ...entry, name: entry.name.slice(prefix.length) }));

  // Every path is checked before anything is filtered: a traversal attempt is
  // an error, never something quietly dropped on the way past.
  for (const file of files) {
    const segments = file.name.split('/');
    if (file.name === '' || file.name.includes('\\') || segments.some((part) => part === '..' || part === '')) {
      throw new Error(`the archive holds an unsafe path: "${file.name}"`);
    }
    if (segments.length > MAX_PATH_SEGMENTS) throw new Error(`the archive nests too deeply: "${file.name}"`);
  }

  const deckFiles = files.filter((file) => {
    const segments = file.name.split('/');
    // Dotfiles and the resource forks macOS packs beside them are noise the
    // download never contains; the permission sidecars are refused outright,
    // since honouring an uploaded access.json would let anybody hand
    // themselves ownership of a deck by editing a file in a zip.
    if (segments.some((part) => part.startsWith('.'))) return false;
    if (segments[0] === '__MACOSX') return false;
    // Nor is an edit log somebody else's server kept: it would claim edits
    // this server never saw.
    return file.name !== ACCESS_FILE && file.name !== FOLDER_FILE && !HISTORY_FILES.includes(file.name);
  });
  if (!deckFiles.some((file) => file.name === 'deck.json')) {
    throw new Error('the archive holds no deck.json — is it a DeckWerk deck archive?');
  }
  return deckFiles;
}

/** The single top-level directory every entry shares, or '' if there is none. */
function commonArchivePrefix(entries: ZipEntry[]): string {
  const first = entries[0].name;
  if (!first.includes('/')) return '';
  const candidate = `${first.slice(0, first.indexOf('/'))}/`;
  return entries.every((entry) => entry.name.startsWith(candidate)) ? candidate : '';
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
/** Every video file a deck's slides reference, in the order a talk reaches them. */
function deckVideoAssets(deckDir: string, deck: Deck): string[] {
  const seen = new Set<string>();
  for (const slide of deck.slides) {
    for (const element of slide.elements) {
      if (element.type !== 'video') continue;
      try {
        const absolute = resolveAsset(deckDir, element.src);
        if (isVideoAsset(absolute) && existsSync(absolute)) seen.add(absolute);
      } catch {
        // A pending or malformed src is not an asset to prepare.
      }
    }
  }
  return [...seen];
}

interface ServeVariant {
  /** Force revalidation: what this URL answers with may change. */
  revalidate?: boolean;
  /** Distinguishes the ETag of one variant of a URL from another's. */
  etagSalt?: string;
  /** The URL names these exact bytes (a pinned variant), so cache them for good. */
  immutable?: boolean;
}

/** Text the client bundle and decks are made of; media is already compressed. */
const COMPRESSIBLE_TYPES = /^(?:text\/|application\/json|image\/svg\+xml)/;
const GZIP_CACHE_LIMIT = 64 * 1024 * 1024;
const gzipCache = new Map<string, Buffer>();
let gzipCacheBytes = 0;

/**
 * The gzip of a static text file, compressed once per revision. The bundle a
 * presentation needs before it can paint is ~0.5 MB of JavaScript and CSS,
 * which gzip takes to a third; over a tailnet link that was a visible part
 * of the wait for the first slide.
 */
async function gzippedFile(absolute: string, size: number, mtimeMs: number): Promise<Buffer | null> {
  if (size < 1024 || size > 16 * 1024 * 1024) return null;
  const key = `${absolute}\0${size}\0${Math.round(mtimeMs)}`;
  const cached = gzipCache.get(key);
  if (cached) return cached;
  const gzipped = gzipSync(await readFile(absolute));
  while (gzipCacheBytes + gzipped.length > GZIP_CACHE_LIMIT && gzipCache.size > 0) {
    const [oldest, bytes] = gzipCache.entries().next().value!;
    gzipCache.delete(oldest);
    gzipCacheBytes -= bytes.length;
  }
  gzipCache.set(key, gzipped);
  gzipCacheBytes += gzipped.length;
  return gzipped;
}

async function serveFileWithRanges(
  request: IncomingMessage,
  response: ServerResponse,
  absolute: string,
  // The vite hash spelling is only trusted for the built client bundle; a
  // user-named deck asset can end in "-something8.ext" without being hashed.
  hashedNames: RegExp[] = [CONTENT_HASHED_NAME],
  variant: ServeVariant = {},
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
  const etag = `"${variant.etagSalt ? `${variant.etagSalt}-` : ''}${info.size}-${Math.round(info.mtimeMs)}"`;
  const name = basename(absolute);
  const cacheControl = variant.immutable
    || (!variant.revalidate && hashedNames.some((pattern) => pattern.test(name)))
    ? 'public, max-age=31536000, immutable'
    : 'public, no-cache';
  const held = request.headers['if-none-match'];
  if (held === etag || held === `${etag.slice(0, -1)}-gz"`) {
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
    const gzipped = COMPRESSIBLE_TYPES.test(type) && /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? ''))
      ? await gzippedFile(absolute, info.size, info.mtimeMs)
      : null;
    if (gzipped) {
      response.writeHead(200, {
        ...common,
        // A different body is a different entity: its validator must differ.
        etag: `${etag.slice(0, -1)}-gz"`,
        'content-encoding': 'gzip',
        vary: 'accept-encoding',
        'content-length': gzipped.length,
      });
      response.end(gzipped);
      return;
    }
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
