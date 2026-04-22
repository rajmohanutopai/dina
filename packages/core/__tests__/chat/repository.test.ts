/**
 * Chat-message repository contract.
 *
 * Review #14: the chat thread used to be process-memory only, so
 * conversation history vanished on every restart. This suite pins
 * the InMemory repository's contract — the SQLite implementation
 * follows it 1:1 with the same method semantics, and is covered by
 * integration tests that go through `initializePersistence`.
 */

import {
  InMemoryChatMessageRepository,
  type ChatMessageRepository,
  type StoredChatMessage,
} from '../../src/chat/repository';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';

function mkMsg(overrides: Partial<StoredChatMessage> = {}): StoredChatMessage {
  return {
    id: overrides.id ?? `cm-${Math.random().toString(36).slice(2, 8)}`,
    threadId: overrides.threadId ?? 'main',
    type: overrides.type ?? 'user',
    content: overrides.content ?? 'hello',
    metadata: overrides.metadata ?? {},
    sources: overrides.sources ?? [],
    timestamp: overrides.timestamp ?? Date.now(),
  };
}

describe('InMemoryChatMessageRepository', () => {
  let repo: ChatMessageRepository;
  beforeEach(() => {
    repo = new InMemoryChatMessageRepository();
  });

  it('append + listByThread round-trip preserves content, metadata and sources', async () => {
    const when = 1_700_000_000_000;
    await repo.append(
      mkMsg({
        id: 'a',
        threadId: 'main',
        type: 'user',
        content: 'hi',
        timestamp: when,
      }),
    );
    await repo.append(
      mkMsg({
        id: 'b',
        threadId: 'main',
        type: 'dina',
        content: 'reply',
        sources: ['task-1', 'eta_query'],
        metadata: { persona: 'general' },
        timestamp: when + 1,
      }),
    );
    await repo.append(
      mkMsg({
        id: 'c',
        threadId: 'other',
        type: 'user',
        content: 'elsewhere',
        timestamp: when,
      }),
    );

    const main = await repo.listByThread('main');
    expect(main.map((m) => m.id)).toEqual(['a', 'b']);
    expect(main[1].sources).toEqual(['task-1', 'eta_query']);
    expect(main[1].metadata).toEqual({ persona: 'general' });
  });

  it('returns a chronological list regardless of insertion order', async () => {
    await repo.append(mkMsg({ id: '3', threadId: 'main', timestamp: 3 }));
    await repo.append(mkMsg({ id: '1', threadId: 'main', timestamp: 1 }));
    await repo.append(mkMsg({ id: '2', threadId: 'main', timestamp: 2 }));
    expect((await repo.listByThread('main')).map((m) => m.id)).toEqual(['1', '2', '3']);
  });

  it('append upserts on id so a replay does not duplicate the row', async () => {
    await repo.append(mkMsg({ id: 'a', threadId: 'main', content: 'v1', timestamp: 1 }));
    await repo.append(mkMsg({ id: 'a', threadId: 'main', content: 'v2', timestamp: 1 }));
    const rows = await repo.listByThread('main');
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('v2');
  });

  it('limit clamps results but preserves chronological order', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.append(mkMsg({ id: String(i), threadId: 'main', timestamp: i }));
    }
    expect((await repo.listByThread('main', 2)).map((m) => m.id)).toEqual(['0', '1']);
  });

  it('listThreadIds returns every distinct thread', async () => {
    await repo.append(mkMsg({ id: '1', threadId: 'a' }));
    await repo.append(mkMsg({ id: '2', threadId: 'a' }));
    await repo.append(mkMsg({ id: '3', threadId: 'b' }));
    expect((await repo.listThreadIds()).sort()).toEqual(['a', 'b']);
  });

  it('deleteThread removes only the target thread', async () => {
    await repo.append(mkMsg({ id: '1', threadId: 'a' }));
    await repo.append(mkMsg({ id: '2', threadId: 'b' }));
    expect(await repo.deleteThread('a')).toBe(true);
    expect(await repo.listByThread('a')).toHaveLength(0);
    expect(await repo.listByThread('b')).toHaveLength(1);
    expect(await repo.deleteThread('a')).toBe(false);
  });

  it('reset clears every thread', async () => {
    await repo.append(mkMsg({ id: '1', threadId: 'a' }));
    await repo.append(mkMsg({ id: '2', threadId: 'b' }));
    await repo.reset();
    expect(await repo.listThreadIds()).toEqual([]);
  });

  it('returned objects are clones — caller mutations do not poison the store', async () => {
    await repo.append(mkMsg({ id: '1', threadId: 'a', sources: ['x'], metadata: { k: 'v' } }));
    const a = (await repo.listByThread('a'))[0];
    a.sources.push('leaked');
    (a.metadata as Record<string, string>).leaked = 'yes';
    const b = (await repo.listByThread('a'))[0];
    expect(b.sources).toEqual(['x']);
    expect(b.metadata).toEqual({ k: 'v' });
  });
});

// The SQLite implementation is thin and reuses the same contract —
// if the schema table is there, the queries behind each method map
// directly to standard SQL. Confirm the schema migration includes
// the table + index so the wire-up actually works at boot time.
describe('IDENTITY_MIGRATIONS — chat_messages schema', () => {
  it('creates chat_messages table in one of the identity migrations', async () => {
    const joined = IDENTITY_MIGRATIONS.map((m) => m.sql).join('\n');
    expect(joined).toContain('CREATE TABLE IF NOT EXISTS chat_messages');
    expect(joined).toContain('idx_chat_messages_thread_ts');
  });
});
