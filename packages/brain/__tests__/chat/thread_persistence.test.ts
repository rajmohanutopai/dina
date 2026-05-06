/**
 * Chat thread persistence — dual-write + hydrate contract.
 *
 * Review #14: the chat thread lives in process memory for subscriber
 * dispatch speed, but every write is mirrored into the installed
 * `ChatMessageRepository` so a restart can restore the conversation.
 * `await hydrateThread(threadId)` pulls the persisted messages back on
 * unlock.
 */

import {
  addMessage,
  addUserMessage,
  addDinaResponse,
  addApprovalMessage,
  addSystemMessage,
  deleteThread,
  hydrateThread,
  resetThreads,
  getThread,
  subscribeToThread,
} from '../../src/chat/thread';
import {
  InMemoryChatMessageRepository,
  setChatMessageRepository,
} from '@dina/core';

describe('thread persistence dual-write (#14)', () => {
  let repo: InMemoryChatMessageRepository;
  beforeEach(() => {
    repo = new InMemoryChatMessageRepository();
    setChatMessageRepository(repo);
    resetThreads();
  });

  afterEach(() => {
    setChatMessageRepository(null);
  });

  it('every addMessage call writes through to the repo', async () => {
    const u = addUserMessage('main', 'what is the weather');
    const d = addDinaResponse('main', 'cloudy with sources', ['task-1']);
    const rows = await repo.listByThread('main');
    expect(rows.map((r) => r.id)).toEqual([u.id, d.id]);
    expect(rows[0].type).toBe('user');
    expect(rows[1].type).toBe('dina');
    expect(rows[1].sources).toEqual(['task-1']);
  });

  it('approval messages keep their type + metadata when persisted', async () => {
    addApprovalMessage('main', 'approve eta_query?', {
      taskId: 't-1',
      capability: 'eta_query',
      fromDID: 'did:plc:alice',
      serviceName: 'Bus 42',
      approveCommand: '/service_approve t-1',
    });
    const row = (await repo.listByThread('main'))[0];
    expect(row.type).toBe('approval');
    expect(row.metadata).toMatchObject({
      // 5.65: discriminator so the chat tab's renderer dispatches
      // service-approval cards to <InlineServiceApprovalCard>, distinct
      // from ask-approval cards (kind: 'ask_approval', 5.21-H-i).
      kind: 'service_approval',
      taskId: 't-1',
      capability: 'eta_query',
      fromDID: 'did:plc:alice',
      serviceName: 'Bus 42',
      approveCommand: '/service_approve t-1',
    });
    // Sources double as a quick reference for the Chat renderer's
    // source-pill component.
    expect(row.sources).toEqual(['t-1', 'eta_query']);
  });

  it('persists across a simulated restart via hydrateThread', async () => {
    const u = addUserMessage('main', 'remember: dentist Thursday');
    const d = addDinaResponse('main', 'got it');
    const s = addSystemMessage('main', 'reminder set');
    // Simulate a process restart: the in-memory cache goes away but
    // the repo (which is SQLite-backed in production) survives.
    // Unset the global repo ref BEFORE resetThreads so the reset
    // doesn't also wipe the persisted rows — then rehook and hydrate.
    setChatMessageRepository(null);
    resetThreads();
    setChatMessageRepository(repo);
    const count = await hydrateThread('main');
    expect(count).toBe(3);
    // Every message round-trips; the sort is by timestamp so sub-ms
    // ties fall back to the secondary id sort. Assert membership +
    // counts-by-type instead of a strict insertion order.
    const rehydratedIds = new Set(getThread('main').map((m) => m.id));
    expect(rehydratedIds).toEqual(new Set([u.id, d.id, s.id]));
    const typeCounts = getThread('main').reduce<Record<string, number>>(
      (acc, m) => ({ ...acc, [m.type]: (acc[m.type] ?? 0) + 1 }),
      {},
    );
    expect(typeCounts).toEqual({ user: 1, dina: 1, system: 1 });
  });

  it('honours an explicit timestamp override for sender-time ordering (MT-19-I2)', () => {
    // Inbound D2D fan-out passes the sender's verified `created_time`
    // through `addMessage(..., { timestamp })`. Without that override
    // the message gets Date.now() at receive-time and a back-to-back
    // MsgBox replay can land out of order. The merge sort in the
    // chat thread store keys on this timestamp, so honouring the
    // override is what makes the chronological-replay guarantee real.
    const senderSentAt = 1_700_000_000_000;
    const m = addMessage('peer-x', 'dina', 'hello', { timestamp: senderSentAt });
    expect(m.timestamp).toBe(senderSentAt);

    // The default path (no override) still uses receive-time so
    // outbound + locally-authored messages don't regress.
    const before = Date.now();
    const local = addMessage('peer-x', 'user', 'reply');
    const after = Date.now();
    expect(local.timestamp).toBeGreaterThanOrEqual(before);
    expect(local.timestamp).toBeLessThanOrEqual(after);
  });

  it('hydrateThread fires subscribers so React-driven UIs re-render (MT-18-I2)', async () => {
    // Without this notification, `useSyncExternalStore`-backed chat
    // hooks see the stale empty snapshot — the in-memory map gets
    // populated but no subscriber wakeup means React never knows to
    // re-render. Live-tested on iOS sim 2026-05-06: post-fix the
    // `/chat/[did]` screen showed all four exchanged messages after
    // an app restart that previously rendered "No messages yet".
    addUserMessage('main', 'persisted before restart');
    setChatMessageRepository(null);
    resetThreads();
    setChatMessageRepository(repo);

    let firedCount = 0;
    subscribeToThread('main', () => {
      firedCount += 1;
    });
    const count = await hydrateThread('main');
    expect(count).toBe(1);
    expect(firedCount).toBe(1);
  });

  it('hydrateThread merges disk into a non-empty in-memory thread without dropping live entries', async () => {
    // The MsgBox replay race (MT-19): an inbound message arrives
    // BEFORE the chat screen mounts. The receive pipeline writes it
    // into the in-memory thread via `addMessage`. Then the screen
    // mounts and hydrates. Without the merge, the disk read would
    // either short-circuit (and miss historical rows) or replace
    // (and drop the just-arrived live message). The merge handles
    // both: union by id, sorted by timestamp.
    //
    // Setup: seed disk with two historical messages, simulate a
    // restart that wipes the in-memory cache, then add ONE live
    // inbound. The hydrate has to land all three in chronological
    // order.
    addUserMessage('main', 'history A');
    addUserMessage('main', 'history B');
    setChatMessageRepository(null);
    resetThreads();
    setChatMessageRepository(repo);
    addUserMessage('main', 'live inbound after restart');

    const added = await hydrateThread('main');
    // Two of the three IDs were already in memory, hydrate added two
    // disk-only ones (history A + B). The live inbound stays.
    expect(added).toBe(2);
    const contents = getThread('main').map((m) => m.content);
    expect(contents).toContain('history A');
    expect(contents).toContain('history B');
    expect(contents).toContain('live inbound after restart');
  });

  it('hydrateThread does NOT fire subscribers when nothing was loaded', async () => {
    // No persisted rows → hydrate returns 0. Firing on an empty
    // hydrate would be a misleading "thread changed" signal that
    // forces a needless re-render across every mounted chat surface.
    let firedCount = 0;
    subscribeToThread('does-not-exist', () => {
      firedCount += 1;
    });
    const count = await hydrateThread('does-not-exist');
    expect(count).toBe(0);
    expect(firedCount).toBe(0);
  });

  it('hydrateThread is a no-op when the thread is already populated', async () => {
    addUserMessage('main', 'already here');
    const before = getThread('main').length;
    const added = await hydrateThread('main');
    expect(added).toBe(0);
    expect(getThread('main').length).toBe(before);
  });

  it('hydrateThread with force: true rehydrates even a populated thread', async () => {
    addUserMessage('main', 'in memory');
    // Persist an additional message directly in the repo that isn't
    // reflected in memory (as if another process wrote it).
    await repo.append({
      id: 'cm-direct',
      threadId: 'main',
      type: 'system',
      content: 'external write',
      metadata: {},
      sources: [],
      timestamp: Date.now() + 1000,
    });
    await hydrateThread('main', { force: true });
    const ids = getThread('main').map((m) => m.id);
    expect(ids).toContain('cm-direct');
  });

  it('deleteThread removes rows from the repo too', async () => {
    addUserMessage('main', 'm1');
    addUserMessage('main', 'm2');
    expect(await repo.listByThread('main')).toHaveLength(2);
    deleteThread('main');
    expect(await repo.listByThread('main')).toHaveLength(0);
  });

  it('addMessage succeeds even when the repo throws on append', async () => {
    const brokenRepo: InMemoryChatMessageRepository = Object.assign(
      new InMemoryChatMessageRepository(),
      {
        append: () => {
          throw new Error('disk full');
        },
      },
    );
    setChatMessageRepository(brokenRepo);
    // Must NOT propagate — chat UI mustn't crash on a persistence hiccup.
    expect(() => addMessage('main', 'user', 'still works')).not.toThrow();
    expect(getThread('main')).toHaveLength(1);
  });
});

describe('thread persistence — no repo installed', () => {
  beforeEach(() => {
    setChatMessageRepository(null);
    resetThreads();
  });

  it('in-memory-only mode: hydrateThread returns 0 and does not throw', async () => {
    addUserMessage('main', 'hello');
    expect(await hydrateThread('main', { force: true })).toBe(0);
    // Original message still in memory.
    expect(getThread('main')[0].content).toBe('hello');
  });
});
