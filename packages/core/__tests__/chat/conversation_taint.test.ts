/**
 * The durable record of what Brain read in a conversation (UCP plan §3.16):
 * written with each release, kept past the release log's day, gone with the
 * conversation's messages; and coverage, so a missing record never reads as
 * clean. Real SQLite, real vault reads.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';
import { makeVaultItem, resetFactoryCounters } from '@dina/test-harness';

import { A2AReleaseLog, installA2AReleaseLog, RELEASE_LOG_TTL_MS } from '../../src/a2a';
import { SQLiteChatMessageRepository } from '../../src/chat/repository';
import { readConversationTaint } from '../../src/chat/taint';
import { createPersona, deletePersona, resetPersonaState } from '../../src/persona/service';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import { clearVaults, queryVault, storeItem } from '../../src/vault/crud';
import { releaseSessionId, type ReleaseContext } from '../../src/vault/release';

const NOW = 1_800_000_000_000;
const CHAT: ReleaseContext = { sessionId: 'chat:main', audience: 'brain' };
const ASK: ReleaseContext = { sessionId: 'ask:a1', audience: 'brain' };

let dir: string;
let db: NodeSQLiteAdapter;
let log: A2AReleaseLog;
let clock: number;
let chat: SQLiteChatMessageRepository;

beforeEach(() => {
  resetFactoryCounters();
  clearVaults();
  resetPersonaState();
  createPersona('general', 'default');
  createPersona('health', 'sensitive');
  dir = mkdtempSync(path.join(tmpdir(), 'ucp-taint-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: 'ab'.repeat(32),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  clock = NOW;
  log = new A2AReleaseLog(db, () => clock);
  installA2AReleaseLog(log);
  chat = new SQLiteChatMessageRepository(db);
  storeItem('general', makeVaultItem({ summary: 'Dentist', body: 'Dr. Rao on Tuesday.' }));
  storeItem('health', makeVaultItem({ summary: 'Blood test', body: 'Cholesterol 190.' }));
});

afterEach(() => {
  installA2AReleaseLog(null);
  resetPersonaState();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const say = (thread: string, id: string, at = clock) =>
  chat.append({
    id,
    threadId: thread,
    type: 'user',
    content: 'hi',
    metadata: {},
    sources: [],
    timestamp: at,
  });

describe('the durable record', () => {
  it('a restricted read in a chat taints the conversation past the release log’s day', async () => {
    await say('main', 'm1');
    queryVault('health', { mode: 'fts5', text: 'cholesterol', limit: 5 }, CHAT);
    expect(readConversationTaint(db, log, CHAT.sessionId)).toEqual({
      covered: true,
      restrictedPersonas: ['health'],
    });
    clock = NOW + RELEASE_LOG_TTL_MS + 60 * 60_000; // 25 hours later
    log.purgeExpired();
    expect(log.readSet(CHAT.sessionId)).toEqual([]);
    expect(readConversationTaint(db, log, CHAT.sessionId).restrictedPersonas).toEqual(['health']);
  });

  it('a default persona read does not taint, unless that persona is no longer known (it then counts as private)', async () => {
    await say('main', 'm1');
    queryVault('general', { mode: 'fts5', text: 'dentist', limit: 5 }, CHAT);
    expect(readConversationTaint(db, log, CHAT.sessionId).restrictedPersonas).toEqual([]);
    clock = NOW + RELEASE_LOG_TTL_MS + 1;
    log.purgeExpired();
    deletePersona('general');
    expect(readConversationTaint(db, log, CHAT.sessionId).restrictedPersonas).toEqual(['general']);
  });

  it('a read that returned nothing records nothing; an ask is not recorded durably (its day covers it)', async () => {
    await say('main', 'm1');
    queryVault('health', { mode: 'fts5', text: 'nothing-matches-this', limit: 5 }, CHAT);
    expect(db.query('SELECT * FROM conversation_taint')).toEqual([]);
    queryVault('health', { mode: 'fts5', text: 'cholesterol', limit: 5 }, ASK);
    expect(db.query('SELECT * FROM conversation_taint')).toEqual([]);
    // The read is in the release log; the ask is covered only once the log holds the ask itself.
    expect(readConversationTaint(db, log, ASK.sessionId)).toEqual({
      covered: false,
      restrictedPersonas: ['health'],
    });
    log.recordUtterance(ASK.sessionId, 't1', 'what did my blood test say');
    expect(readConversationTaint(db, log, ASK.sessionId)).toEqual({
      covered: true,
      restrictedPersonas: ['health'],
    });
  });

  it('a topic list released from a restricted persona taints too', async () => {
    await say('main', 'm1');
    log.recordTopics(CHAT, 'health', ['cholesterol']);
    expect(db.query('SELECT persona, persona_tier FROM conversation_taint')).toEqual([
      { persona: 'health', persona_tier: 'sensitive' },
    ]);
  });
});

describe('coverage', () => {
  it('a thread is covered from its first message written here; a thread with older messages and no mark is not', async () => {
    await say('main', 'm1', NOW);
    await say('main', 'm2', NOW + 5);
    expect(
      db.query('SELECT covered_since FROM conversation_coverage WHERE session_id = ?', [
        'chat:main',
      ]),
    ).toEqual([{ covered_since: NOW }]);
    // A thread whose messages arrived without a mark (begun before this build, or restored from an old archive).
    db.run(
      `INSERT INTO chat_messages (id, thread_id, type, content, metadata, sources, timestamp, data_scope)
       VALUES ('old1', 'legacy', 'user', 'hi', '{}', '[]', 1, 'user')`,
    );
    await say('legacy', 'new1');
    expect(readConversationTaint(db, log, 'chat:legacy').covered).toBe(false);
  });

  it('uses Brain’s session id for any thread name, digested ones included', async () => {
    const thread = 'Trip to Rao’s clinic & more';
    await say(thread, 'm1');
    const session = releaseSessionId('chat', thread);
    expect(session.startsWith('chat:h-')).toBe(true);
    expect(readConversationTaint(db, log, session).covered).toBe(true);
  });

  it('deleting a thread, or resetting chat, removes its taint and coverage', async () => {
    await say('main', 'm1');
    await say('other', 'o1');
    queryVault('health', { mode: 'fts5', text: 'cholesterol', limit: 5 }, CHAT);
    await chat.deleteThread('main');
    expect(db.query(`SELECT * FROM conversation_taint WHERE session_id = 'chat:main'`)).toEqual([]);
    expect(db.query(`SELECT * FROM conversation_coverage WHERE session_id = 'chat:main'`)).toEqual(
      [],
    );
    expect(
      db.query(`SELECT * FROM conversation_coverage WHERE session_id = 'chat:other'`),
    ).toHaveLength(1);
    await chat.reset();
    expect(db.query('SELECT * FROM conversation_coverage')).toEqual([]);
  });
});
