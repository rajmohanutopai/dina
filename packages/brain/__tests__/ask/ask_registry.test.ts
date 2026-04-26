/**
 * Tasks 5.19 + 5.20 — Ask registry state machine + persistence tests.
 */

import {
  AskRegistry,
  DEFAULT_ASK_TTL_MS,
  InMemoryAskAdapter,
  type AskEnqueueInput,
  type AskEvent,
  type AskRecord,
} from '../../src/ask/ask_registry';

function fixedClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    nowMsFn: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

const REQ_DID = 'did:plc:alice';
const sampleEnqueue: AskEnqueueInput = {
  id: 'ask-1',
  question: 'When does bus 42 arrive at Castro?',
  requesterDid: REQ_DID,
};

describe('InMemoryAskAdapter (task 5.20)', () => {
  it('insert → get round-trips', async () => {
    const adapter = new InMemoryAskAdapter();
    const record: AskRecord = {
      id: 'r',
      question: 'q',
      requesterDid: REQ_DID,
      status: 'in_flight',
      createdAtMs: 1,
      updatedAtMs: 1,
      deadlineMs: 1000,
    };
    await adapter.insert(record);
    const got = await adapter.get('r');
    expect(got).toEqual(record);
    expect(got).not.toBe(record); // defensive copy
  });

  it('duplicate insert throws', async () => {
    const adapter = new InMemoryAskAdapter();
    const record: AskRecord = {
      id: 'r',
      question: 'q',
      requesterDid: REQ_DID,
      status: 'in_flight',
      createdAtMs: 1,
      updatedAtMs: 1,
      deadlineMs: 1000,
    };
    await adapter.insert(record);
    await expect(adapter.insert(record)).rejects.toThrow(/duplicate id/);
  });

  it('update on unknown id throws', async () => {
    const adapter = new InMemoryAskAdapter();
    const record: AskRecord = {
      id: 'ghost',
      question: 'q',
      requesterDid: REQ_DID,
      status: 'in_flight',
      createdAtMs: 1,
      updatedAtMs: 1,
      deadlineMs: 1000,
    };
    await expect(adapter.update(record)).rejects.toThrow(/unknown id/);
  });

  it('loadAll returns defensive copies', async () => {
    const adapter = new InMemoryAskAdapter();
    const record: AskRecord = {
      id: 'r',
      question: 'q',
      requesterDid: REQ_DID,
      status: 'in_flight',
      createdAtMs: 1,
      updatedAtMs: 1,
      deadlineMs: 1000,
    };
    await adapter.insert(record);
    const rows = await adapter.loadAll();
    rows[0]!.status = 'complete';
    const fresh = await adapter.loadAll();
    expect(fresh[0]!.status).toBe('in_flight');
  });
});

describe('AskRegistry (task 5.19)', () => {
  describe('enqueue', () => {
    it('creates an in_flight ask with deadline = now + ttl', async () => {
      const clock = fixedClock();
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: clock.nowMsFn,
      });
      const rec = await reg.enqueue(sampleEnqueue);
      expect(rec).toMatchObject({
        id: 'ask-1',
        status: 'in_flight',
        requesterDid: REQ_DID,
        createdAtMs: clock.nowMsFn(),
        deadlineMs: clock.nowMsFn() + DEFAULT_ASK_TTL_MS,
      });
    });

    it('honours per-request ttlMs', async () => {
      const clock = fixedClock();
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: clock.nowMsFn,
      });
      const rec = await reg.enqueue({ ...sampleEnqueue, ttlMs: 5000 });
      expect(rec.deadlineMs - rec.createdAtMs).toBe(5000);
    });

    it('emits enqueued event', async () => {
      const events: AskEvent[] = [];
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        onEvent: (e) => events.push(e),
      });
      await reg.enqueue(sampleEnqueue);
      expect(events.map((e) => e.kind)).toEqual(['enqueued']);
    });

    it.each([
      ['empty id', { ...sampleEnqueue, id: '' }],
      ['non-string question', { ...sampleEnqueue, question: 42 as unknown as string }],
      ['empty requesterDid', { ...sampleEnqueue, requesterDid: '' }],
      ['non-positive ttl', { ...sampleEnqueue, ttlMs: 0 }],
      ['NaN ttl', { ...sampleEnqueue, ttlMs: NaN }],
    ])('rejects %s', async (_label, input) => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await expect(reg.enqueue(input)).rejects.toThrow();
    });
  });

  describe('state machine — happy transitions', () => {
    it('in_flight → complete with answer', async () => {
      const clock = fixedClock();
      const events: AskEvent[] = [];
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await reg.enqueue(sampleEnqueue);
      clock.advance(500);
      const done = await reg.markComplete('ask-1', JSON.stringify({ answer: 42 }));
      expect(done.status).toBe('complete');
      expect(done.answerJson).toBe('{"answer":42}');
      const completedEv = events.find((e) => e.kind === 'completed') as Extract<
        AskEvent,
        { kind: 'completed' }
      >;
      expect(completedEv.durationMs).toBe(500);
    });

    it('in_flight → failed', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await reg.enqueue(sampleEnqueue);
      const failed = await reg.markFailed('ask-1', JSON.stringify({ reason: 'timeout' }));
      expect(failed.status).toBe('failed');
      expect(failed.errorJson).toBe('{"reason":"timeout"}');
    });

    it('in_flight → pending_approval → in_flight → complete (full approval cycle)', async () => {
      const events: AskEvent[] = [];
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        onEvent: (e) => events.push(e),
      });
      await reg.enqueue(sampleEnqueue);
      const pend = await reg.markPendingApproval('ask-1', 'approval-xyz');
      expect(pend.status).toBe('pending_approval');
      expect(pend.approvalId).toBe('approval-xyz');

      const resumed = await reg.resumeAfterApproval('ask-1');
      expect(resumed.status).toBe('in_flight');
      expect(resumed.approvalId).toBeUndefined();

      const done = await reg.markComplete('ask-1', '{}');
      expect(done.status).toBe('complete');

      expect(events.map((e) => e.kind)).toEqual([
        'enqueued',
        'pending_approval',
        'approval_resumed',
        'completed',
      ]);
    });

    it('pending_approval → failed (operator denied)', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await reg.enqueue(sampleEnqueue);
      await reg.markPendingApproval('ask-1', 'approval-xyz');
      const failed = await reg.markFailed('ask-1', JSON.stringify({ reason: 'operator_denied' }));
      expect(failed.status).toBe('failed');
    });
  });

  describe('state machine — forbidden transitions', () => {
    it('markComplete on pending_approval throws', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await reg.enqueue(sampleEnqueue);
      await reg.markPendingApproval('ask-1', 'a');
      await expect(reg.markComplete('ask-1', '{}')).rejects.toThrow(/need in_flight/);
    });

    it('markComplete after complete throws (no double-commit)', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await reg.enqueue(sampleEnqueue);
      await reg.markComplete('ask-1', '{}');
      await expect(reg.markComplete('ask-1', '{}')).rejects.toThrow(/need in_flight/);
    });

    it('markPendingApproval on non-in_flight throws', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await reg.enqueue(sampleEnqueue);
      await reg.markComplete('ask-1', '{}');
      await expect(reg.markPendingApproval('ask-1', 'a')).rejects.toThrow(/need in_flight/);
    });

    it('resumeAfterApproval on in_flight throws', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await reg.enqueue(sampleEnqueue);
      await expect(reg.resumeAfterApproval('ask-1')).rejects.toThrow(/need pending_approval/);
    });

    it.each([
      ['markComplete', 'markComplete'],
      ['markFailed', 'markFailed'],
      ['markPendingApproval', 'markPendingApproval'],
      ['resumeAfterApproval', 'resumeAfterApproval'],
    ])('%s on unknown throws not-found', async (_label, method) => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      const fn =
        method === 'markComplete'
          ? () => reg.markComplete('ghost', '{}')
          : method === 'markFailed'
            ? () => reg.markFailed('ghost', '{}')
            : method === 'markPendingApproval'
              ? () => reg.markPendingApproval('ghost', 'a')
              : () => reg.resumeAfterApproval('ghost');
      await expect(fn()).rejects.toThrow(/not found/);
    });

    it('markPendingApproval rejects empty approvalId', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await reg.enqueue(sampleEnqueue);
      await expect(reg.markPendingApproval('ask-1', '')).rejects.toThrow(/approvalId is required/);
    });
  });

  describe('TTL reaper (task 5.19)', () => {
    it('sweepExpired transitions in_flight past deadline → expired', async () => {
      const clock = fixedClock();
      const events: AskEvent[] = [];
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        defaultTtlMs: 1000,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      await reg.enqueue(sampleEnqueue);
      expect(await reg.sweepExpired()).toBe(0); // fresh, not expired
      clock.advance(1001);
      expect(await reg.sweepExpired()).toBe(1);
      const rec = await reg.get('ask-1');
      expect(rec?.status).toBe('expired');
      const ev = events.find((e) => e.kind === 'expired') as Extract<AskEvent, { kind: 'expired' }>;
      expect(ev.fromStatus).toBe('in_flight');
    });

    it('sweepExpired also expires pending_approval past deadline', async () => {
      const clock = fixedClock();
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        defaultTtlMs: 1000,
        nowMsFn: clock.nowMsFn,
      });
      await reg.enqueue(sampleEnqueue);
      await reg.markPendingApproval('ask-1', 'a');
      clock.advance(1001);
      expect(await reg.sweepExpired()).toBe(1);
      expect((await reg.get('ask-1'))?.status).toBe('expired');
    });

    it('sweepExpired is idempotent', async () => {
      const clock = fixedClock();
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        defaultTtlMs: 1000,
        nowMsFn: clock.nowMsFn,
      });
      await reg.enqueue(sampleEnqueue);
      clock.advance(1001);
      expect(await reg.sweepExpired()).toBe(1);
      expect(await reg.sweepExpired()).toBe(0);
    });

    it('sweepExpired leaves terminal records alone', async () => {
      const clock = fixedClock();
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        defaultTtlMs: 1000,
        nowMsFn: clock.nowMsFn,
      });
      await reg.enqueue(sampleEnqueue);
      await reg.markComplete('ask-1', '{}');
      clock.advance(999_999);
      expect(await reg.sweepExpired()).toBe(0);
      expect((await reg.get('ask-1'))?.status).toBe('complete');
    });
  });

  describe('restoreOnStartup (task 5.20)', () => {
    it('expires stale in_flight; preserves pending_approval; terminal unchanged', async () => {
      const clock = fixedClock();
      const adapter = new InMemoryAskAdapter();
      // Pre-populate as if from a prior run.
      const createdAt = clock.nowMsFn() - 100_000;
      const stillFreshDeadline = clock.nowMsFn() + 50_000;
      const staleDeadline = clock.nowMsFn() - 10_000;
      await adapter.insert({
        id: 'stale',
        question: 'q',
        requesterDid: REQ_DID,
        status: 'in_flight',
        createdAtMs: createdAt,
        updatedAtMs: createdAt,
        deadlineMs: staleDeadline,
      });
      await adapter.insert({
        id: 'fresh',
        question: 'q',
        requesterDid: REQ_DID,
        status: 'in_flight',
        createdAtMs: clock.nowMsFn(),
        updatedAtMs: clock.nowMsFn(),
        deadlineMs: stillFreshDeadline,
      });
      await adapter.insert({
        id: 'approved-wait',
        question: 'q',
        requesterDid: REQ_DID,
        status: 'pending_approval',
        createdAtMs: createdAt,
        updatedAtMs: createdAt,
        deadlineMs: stillFreshDeadline,
        approvalId: 'a',
      });
      await adapter.insert({
        id: 'done',
        question: 'q',
        requesterDid: REQ_DID,
        status: 'complete',
        createdAtMs: createdAt,
        updatedAtMs: createdAt,
        deadlineMs: stillFreshDeadline,
        answerJson: '{}',
      });

      const events: AskEvent[] = [];
      const reg = new AskRegistry({
        adapter,
        nowMsFn: clock.nowMsFn,
        onEvent: (e) => events.push(e),
      });
      const summary = await reg.restoreOnStartup();
      expect(summary.loaded).toBe(4);
      expect(summary.expiredOnRestore).toBe(1);
      expect(summary.stillInFlight).toBe(1);
      expect(summary.stillPendingApproval).toBe(1);
      expect(summary.terminal).toBe(1);

      expect((await reg.get('stale'))?.status).toBe('expired');
      expect((await reg.get('fresh'))?.status).toBe('in_flight');
      expect((await reg.get('approved-wait'))?.status).toBe('pending_approval');
      expect((await reg.get('done'))?.status).toBe('complete');

      const restoredEv = events.find((e) => e.kind === 'restored_expired');
      expect(restoredEv).toMatchObject({ kind: 'restored_expired', id: 'stale' });
    });

    it('empty adapter → zero counts', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      const summary = await reg.restoreOnStartup();
      expect(summary).toEqual({
        loaded: 0,
        expiredOnRestore: 0,
        stillInFlight: 0,
        stillPendingApproval: 0,
        terminal: 0,
      });
    });

    it('cross-registry persistence: fresh registry sees prior asks', async () => {
      const adapter = new InMemoryAskAdapter();
      const first = new AskRegistry({ adapter });
      await first.enqueue(sampleEnqueue);

      const second = new AskRegistry({ adapter });
      const summary = await second.restoreOnStartup();
      expect(summary.stillInFlight).toBe(1);
      expect((await second.get('ask-1'))?.status).toBe('in_flight');
    });
  });

  describe('listAll + purge', () => {
    it('listAll orders by createdAt', async () => {
      const clock = fixedClock();
      const reg = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        nowMsFn: clock.nowMsFn,
      });
      await reg.enqueue({ ...sampleEnqueue, id: 'a' });
      clock.advance(10);
      await reg.enqueue({ ...sampleEnqueue, id: 'b' });
      clock.advance(10);
      await reg.enqueue({ ...sampleEnqueue, id: 'c' });
      const ids = (await reg.listAll()).map((r) => r.id);
      expect(ids).toEqual(['a', 'b', 'c']);
    });

    it('purge removes terminal records', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await reg.enqueue(sampleEnqueue);
      await reg.markComplete('ask-1', '{}');
      expect(await reg.purge('ask-1')).toBe(true);
      expect(await reg.get('ask-1')).toBeNull();
    });

    it('purge refuses non-terminal records', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await reg.enqueue(sampleEnqueue);
      expect(await reg.purge('ask-1')).toBe(false);
      await reg.markPendingApproval('ask-1', 'a');
      expect(await reg.purge('ask-1')).toBe(false);
    });

    it('purge throws on unknown', async () => {
      const reg = new AskRegistry({ adapter: new InMemoryAskAdapter() });
      await expect(reg.purge('ghost')).rejects.toThrow(/not found/);
    });
  });

  describe('construction validation', () => {
    it('rejects missing adapter', () => {
      expect(
        () => new AskRegistry({ adapter: undefined as unknown as InMemoryAskAdapter }),
      ).toThrow(/adapter is required/);
    });

    it('rejects non-positive defaultTtlMs', () => {
      expect(
        () =>
          new AskRegistry({
            adapter: new InMemoryAskAdapter(),
            defaultTtlMs: 0,
          }),
      ).toThrow(/defaultTtlMs must be > 0/);
      expect(
        () =>
          new AskRegistry({
            adapter: new InMemoryAskAdapter(),
            defaultTtlMs: NaN,
          }),
      ).toThrow(/defaultTtlMs must be > 0/);
    });
  });

  describe('constants', () => {
    it('DEFAULT_ASK_TTL_MS = 60s (covers 3s fast-path + 57s poll window)', () => {
      expect(DEFAULT_ASK_TTL_MS).toBe(60_000);
    });
  });

  describe('pausedStateJson — Pattern A suspend payload', () => {
    async function setup(): Promise<{
      registry: AskRegistry;
      enqueue: () => Promise<string>;
    }> {
      const registry = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        defaultTtlMs: 60_000,
      });
      let counter = 0;
      const enqueue = async (): Promise<string> => {
        const id = `ask-${++counter}`;
        await registry.enqueue({
          id,
          question: 'q',
          requesterDid: 'did:key:tester',
        });
        return id;
      };
      return { registry, enqueue };
    }

    it('markPendingApproval stores pausedStateJson when supplied', async () => {
      const { registry, enqueue } = await setup();
      const id = await enqueue();
      const payload = JSON.stringify({ version: 1, transcript: [{ role: 'user' }] });
      const record = await registry.markPendingApproval(id, 'appr-1', payload);
      expect(record.pausedStateJson).toBe(payload);
      const refetched = await registry.get(id);
      expect(refetched?.pausedStateJson).toBe(payload);
    });

    it('markPendingApproval omits pausedStateJson when not supplied (backward compat)', async () => {
      const { registry, enqueue } = await setup();
      const id = await enqueue();
      const record = await registry.markPendingApproval(id, 'appr-1');
      expect(record.pausedStateJson).toBeUndefined();
    });

    it('resumeAfterApproval preserves pausedStateJson for the resumer to read', async () => {
      const { registry, enqueue } = await setup();
      const id = await enqueue();
      const payload = JSON.stringify({ version: 1, x: 'preserved' });
      await registry.markPendingApproval(id, 'appr-1', payload);
      const resumed = await registry.resumeAfterApproval(id);
      expect(resumed.status).toBe('in_flight');
      expect(resumed.approvalId).toBeUndefined(); // approvalId IS cleared
      expect(resumed.pausedStateJson).toBe(payload); // pausedStateJson is NOT
    });

    it('markComplete clears pausedStateJson (terminal)', async () => {
      const { registry, enqueue } = await setup();
      const id = await enqueue();
      await registry.markPendingApproval(id, 'appr-1', JSON.stringify({ version: 1 }));
      await registry.resumeAfterApproval(id);
      const completed = await registry.markComplete(id, '{"answer":"ok"}');
      expect(completed.pausedStateJson).toBeUndefined();
    });

    it('markFailed clears pausedStateJson (terminal)', async () => {
      const { registry, enqueue } = await setup();
      const id = await enqueue();
      await registry.markPendingApproval(id, 'appr-1', JSON.stringify({ version: 1 }));
      // Failure can transition directly from pending_approval (operator denied).
      const failed = await registry.markFailed(id, '{"reason":"denied"}');
      expect(failed.pausedStateJson).toBeUndefined();
    });

    it('sweepExpired clears pausedStateJson on a stale pending_approval', async () => {
      let now = 1_000_000;
      const registry = new AskRegistry({
        adapter: new InMemoryAskAdapter(),
        defaultTtlMs: 1_000,
        nowMsFn: () => now,
      });
      await registry.enqueue({ id: 'ask-1', question: 'q', requesterDid: 'did:key:t' });
      await registry.markPendingApproval('ask-1', 'appr-1', JSON.stringify({ version: 1 }));
      now += 5_000; // past TTL
      await registry.sweepExpired();
      const expired = await registry.get('ask-1');
      expect(expired?.status).toBe('expired');
      expect(expired?.pausedStateJson).toBeUndefined();
    });

    it('markPendingApproval called twice with different payloads overwrites (re-bail path)', async () => {
      // Resumer scenario: resume re-runs the loop and the agentic loop
      // hits approval_required again with a new pausedState. The
      // resumer calls markPendingApproval again — must overwrite the
      // stale payload, not stack them.
      const { registry, enqueue } = await setup();
      const id = await enqueue();
      const first = JSON.stringify({ version: 1, marker: 'first' });
      await registry.markPendingApproval(id, 'appr-1', first);
      await registry.resumeAfterApproval(id);
      const second = JSON.stringify({ version: 1, marker: 'second' });
      await registry.markPendingApproval(id, 'appr-2', second);
      const after = await registry.get(id);
      expect(after?.pausedStateJson).toBe(second);
    });

    it('markPendingApproval without payload after one-with-payload clears the stale blob', async () => {
      // Defensive: a Pattern B fallback after a Pattern A bail should
      // not leave the stale Pattern A payload on the record.
      const { registry, enqueue } = await setup();
      const id = await enqueue();
      await registry.markPendingApproval(id, 'appr-1', JSON.stringify({ version: 1 }));
      await registry.resumeAfterApproval(id);
      const after = await registry.markPendingApproval(id, 'appr-2'); // no payload
      expect(after.pausedStateJson).toBeUndefined();
    });

    it('cloneAsk preserves pausedStateJson on get/listAll + defensive copy', async () => {
      const { registry, enqueue } = await setup();
      const id = await enqueue();
      const payload = JSON.stringify({ version: 1, marker: 'x' });
      await registry.markPendingApproval(id, 'appr-1', payload);
      const fromGet = await registry.get(id);
      const fromList = (await registry.listAll())[0]!;
      expect(fromGet?.pausedStateJson).toBe(payload);
      expect(fromList.pausedStateJson).toBe(payload);
      // Defensive copy — mutating the returned record must not affect storage.
      (fromGet as AskRecord).pausedStateJson = 'tampered';
      const refetched = await registry.get(id);
      expect(refetched?.pausedStateJson).toBe(payload);
    });
  });
});
