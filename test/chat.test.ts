/**
 * Deck chat: mention parsing, the append-only chat.jsonl sidecar, and the
 * wire messages that carry it. The server routes are covered in
 * collabChat.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHAT_FILE,
  chatSince,
  mentionHandle,
  parseMentions,
  splitMentions,
  type ChatMessage,
} from '../src/shared/chat.js';
import { ClientMessageSchema, ServerMessageSchema } from '../src/shared/collab.js';
import { ChatLog } from '../src/server/chatLog.js';
import { emptyDeck } from '../src/shared/deck.js';

const message = (id: string, text = 'hello', extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, author: 'Ada', agent: false, ts: new Date(0).toISOString(), text, mentions: parseMentions(text), ...extra,
});

describe('chat mentions', () => {
  it('finds @handles but not e-mail addresses, and drops sentence punctuation', () => {
    expect(parseMentions('@agent please fix slide 3, cc @Ada.Lovelace and bob@example.com.')).toEqual(['agent', 'ada.lovelace']);
    expect(parseMentions('ask @agent.')).toEqual(['agent']);
    expect(parseMentions('@Agent @agent')).toEqual(['agent']);
    expect(parseMentions('no mentions here')).toEqual([]);
  });

  it('splits text into plain and mention runs that rejoin to the original', () => {
    const text = 'hi @Ada, see @agent.';
    const parts = splitMentions(text);
    expect(parts.map((part) => part.text).join('')).toBe(text);
    expect(parts.filter((part) => part.mention).map((part) => part.mention)).toEqual(['ada', 'agent']);
  });

  it('derives a handle from a display name', () => {
    expect(mentionHandle('Ada Lovelace')).toBe('AdaLovelace');
    expect(mentionHandle('Vincent · agent')).toBe('Vincent');
    expect(mentionHandle('alice@tailnet.example')).toBe('alice');
  });

  it('returns what came after an id, and everything for an id it does not hold', () => {
    const list = [message('a'), message('b'), message('c')];
    expect(chatSince(list, 'b').map((m) => m.id)).toEqual(['c']);
    expect(chatSince(list, 'c')).toEqual([]);
    expect(chatSince(list, 'gone').map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(chatSince(list, undefined)).toHaveLength(3);
  });
});

describe('ChatLog', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'deck-chat-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('appends one JSON line per message beside the deck and loads them back', async () => {
    const log = await ChatLog.load(dir);
    expect(log.all()).toEqual([]);
    expect(log.append(message('m1', 'first'))).toBe(true);
    expect(log.append(message('m2', 'second @agent'))).toBe(true);
    // A resend of an accepted id changes nothing.
    expect(log.append(message('m1', 'first again'))).toBe(false);
    await log.flush();
    const lines = (await readFile(join(dir, CHAT_FILE), 'utf8')).trim().split('\n');
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(['m1', 'm2']);
    const reloaded = await ChatLog.load(dir);
    expect(reloaded.all().map((m) => m.text)).toEqual(['first', 'second @agent']);
    expect(reloaded.all()[1].mentions).toEqual(['agent']);
  });

  it('survives a torn last line and junk', async () => {
    await writeFile(join(dir, CHAT_FILE), `${JSON.stringify(message('ok'))}\nnot json\n{"id":"half`, 'utf8');
    const log = await ChatLog.load(dir);
    expect(log.all().map((m) => m.id)).toEqual(['ok']);
  });

  it('keeps only the newest messages for a welcome', async () => {
    const log = await ChatLog.load(dir);
    for (let i = 0; i < 10; i++) log.append(message(`m${i}`));
    expect(log.recent(3).map((m) => m.id)).toEqual(['m7', 'm8', 'm9']);
    await log.flush();
  });

  it('wakes a waiter on the first matching message, and only on a match', async () => {
    const log = await ChatLog.load(dir);
    log.append(message('old', '@agent from before'));
    const wanted = (m: ChatMessage) => m.mentions.includes('agent');
    // Without `since`, history does not count: only what arrives next.
    const waiting = log.wait(null, wanted, 2000);
    log.append(message('plain', 'no mention'));
    log.append(message('hit', 'over to you @agent'));
    expect((await waiting.result).map((m) => m.id)).toEqual(['hit']);
    // With `since`, something already there answers at once.
    expect((await log.wait('old', wanted, 2000).result).map((m) => m.id)).toEqual(['hit']);
    // A timeout answers with nothing.
    expect(await log.wait('hit', wanted, 50).result).toEqual([]);
    await log.flush();
  });

  it('stops accepting and releases waiters when closed', async () => {
    const log = await ChatLog.load(dir);
    const waiting = log.wait(null, () => true, 10_000);
    await log.close();
    expect(await waiting.result).toEqual([]);
    expect(log.append(message('late'))).toBe(false);
  });
});

describe('chat wire messages', () => {
  it('parses a chat-post and rejects malformed ones', () => {
    expect(ClientMessageSchema.parse({ kind: 'chat-post', id: 'chat-abc123', text: 'hi', ref: { slideId: 's1' } }))
      .toMatchObject({ kind: 'chat-post', ref: { slideId: 's1' } });
    expect(() => ClientMessageSchema.parse({ kind: 'chat-post', id: 'x', text: 'hi' })).toThrow();
    expect(() => ClientMessageSchema.parse({ kind: 'chat-post', id: 'chat-abc123', text: '' })).toThrow();
    expect(() => ClientMessageSchema.parse({
      kind: 'chat-post', id: 'chat-abc123', text: 'hi', ref: { slideId: 's1', commentId: 'c' },
    })).toThrow();
  });

  it('parses a chat broadcast and a welcome with or without history', () => {
    expect(ServerMessageSchema.parse({ kind: 'chat', message: message('m1') }).kind).toBe('chat');
    const welcome = {
      kind: 'welcome', version: 1, clientId: 'c', self: { name: 'A', color: '#000' }, seq: 0,
      deck: emptyDeck('T'), themeCss: '', peers: [],
    };
    // An older server sends no chat; a newer one sends its history.
    expect(ServerMessageSchema.safeParse(welcome).success).toBe(true);
    const withChat = ServerMessageSchema.parse({ ...welcome, chat: [message('m1')] });
    expect(withChat.kind === 'welcome' && withChat.chat?.map((m) => m.id)).toEqual(['m1']);
  });
});
