/**
 * BRAIN-P2-V — ApprovalReconciler tests.
 */

import { ApprovalReconciler } from '../../src/service/approval_reconciliation';
import type { BrainCoreClient, WorkflowTask } from '../../src/core_client/http';

/** Deterministic interval scheduler. Tests advance time explicitly. */
function fakeScheduler() {
  let nextHandle = 1;
  const timers = new Map<number, { everyMs: number; fn: () => void; nextFireMs: number }>();
  let nowMs = 1_700_000_000_000;

  return {
    nowMs: () => nowMs,
    setInterval: (fn: () => void, ms: number) => {
      const handle = nextHandle++;
      timers.set(handle, { everyMs: ms, fn, nextFireMs: nowMs + ms });
      return handle as unknown;
    },
    clearInterval: (h: unknown) => {
      timers.delete(h as number);
    },
    advance(ms: number) {
      nowMs += ms;
      // Fire any timers whose next time has passed.
      let anyFired = true;
      while (anyFired) {
        anyFired = false;
        for (const [id, t] of timers) {
          if (t.nextFireMs <= nowMs) {
            t.fn();
            t.nextFireMs += t.everyMs;
            anyFired = true;
          }
          void id;
        }
      }
    },
  };
}

interface StubClient {
  listCalls: Array<{ kind: string; state: string; limit?: number }>;
  respondCalls: Array<{ taskId: string; body: unknown }>;
  failCalls: Array<{ id: string; error: string }>;
  listResult: WorkflowTask[];
  listError: Error | null;
  respondError: Error | null;
  failError: Error | null;
}

function stubClient(init?: Partial<StubClient>): { client: BrainCoreClient; state: StubClient } {
  const state: StubClient = {
    listCalls: [],
    respondCalls: [],
    failCalls: [],
    listResult: [],
    listError: null,
    respondError: null,
    failError: null,
    ...init,
  };
  const client = {
    async listWorkflowTasks(params: { kind: string; state: string; limit?: number }) {
      state.listCalls.push(params);
      if (state.listError !== null) throw state.listError;
      // Reconciler now queries BOTH pending_approval AND queued (issue
      // #12). Only return the seeded tasks on the first state — keeps
      // existing tests' count expectations correct.
      return params.state === 'pending_approval' ? state.listResult : [];
    },
    async sendServiceRespond(taskId: string, body: unknown) {
      state.respondCalls.push({ taskId, body });
      if (state.respondError !== null) throw state.respondError;
      return { status: 'sent', taskId, alreadyProcessed: false };
    },
    async failWorkflowTask(id: string, errorMsg: string) {
      state.failCalls.push({ id, error: errorMsg });
      if (state.failError !== null) throw state.failError;
      return {} as WorkflowTask;
    },
  } as unknown as BrainCoreClient;
  return { client, state };
}

function task(
  id: string,
  expiresAtSec: number,
  overrides: Partial<WorkflowTask> = {},
): WorkflowTask {
  return {
    id,
    kind: 'approval',
    status: 'pending_approval',
    priority: 'normal',
    description: '',
    payload: '{}',
    result_summary: '',
    policy: '{}',
    expires_at: expiresAtSec,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe('ApprovalReconciler — construction', () => {
  it('rejects missing coreClient', () => {
    expect(
      () => new ApprovalReconciler({ coreClient: undefined as unknown as BrainCoreClient }),
    ).toThrow(/coreClient/);
  });

  it('rejects non-positive intervalMs / batchSize', () => {
    const { client } = stubClient();
    expect(() => new ApprovalReconciler({ coreClient: client, intervalMs: 0 })).toThrow(
      /intervalMs/,
    );
    expect(() => new ApprovalReconciler({ coreClient: client, batchSize: 0 })).toThrow(/batchSize/);
  });
});

describe('ApprovalReconciler.runTick', () => {
  it('skips tasks that are not yet expired', async () => {
    const sched = fakeScheduler();
    const nowSec = Math.floor(sched.nowMs() / 1000);
    const { client, state } = stubClient({
      listResult: [task('a', nowSec + 100)], // future expiry
    });
    const r = new ApprovalReconciler({ coreClient: client, nowMsFn: sched.nowMs });

    const result = await r.runTick();
    expect(result.discovered).toBe(0);
    expect(state.respondCalls).toHaveLength(0);
    expect(state.failCalls).toHaveLength(0);
  });

  it('expires past-deadline tasks oldest-first', async () => {
    const sched = fakeScheduler();
    const nowSec = Math.floor(sched.nowMs() / 1000);
    const { client, state } = stubClient({
      listResult: [
        task('b', nowSec - 30),
        task('a', nowSec - 100),
        task('c', nowSec - 5),
        task('future', nowSec + 60), // not expired
      ],
    });
    const r = new ApprovalReconciler({ coreClient: client, nowMsFn: sched.nowMs });

    const result = await r.runTick();
    expect(result.discovered).toBe(3);
    expect(result.sent).toBe(3);
    expect(state.respondCalls.map((c) => c.taskId)).toEqual(['a', 'b', 'c']);
    // Issue #13: on successful send, /v1/service/respond already
    // completed the task, so the reconciler must NOT call
    // failWorkflowTask (it'd 409 on terminal state).
    expect(state.failCalls).toEqual([]);
  });

  it('sends `unavailable` with `approval_expired` error', async () => {
    const sched = fakeScheduler();
    const nowSec = Math.floor(sched.nowMs() / 1000);
    const { client, state } = stubClient({
      listResult: [task('a', nowSec - 1)],
    });
    const r = new ApprovalReconciler({ coreClient: client, nowMsFn: sched.nowMs });

    await r.runTick();
    expect(state.respondCalls[0].body).toEqual({
      status: 'unavailable',
      error: 'approval_expired',
    });
  });

  it('still fails the task even when sendServiceRespond throws', async () => {
    const sched = fakeScheduler();
    const nowSec = Math.floor(sched.nowMs() / 1000);
    const { client, state } = stubClient({
      listResult: [task('a', nowSec - 1)],
      respondError: new Error('network down'),
    });
    const r = new ApprovalReconciler({ coreClient: client, nowMsFn: sched.nowMs });

    const result = await r.runTick();
    expect(result.sent).toBe(0);
    expect(result.sendFailed).toBe(1);
    expect(state.failCalls).toHaveLength(1);
  });

  it('onExpired reports per-task outcome', async () => {
    const sched = fakeScheduler();
    const nowSec = Math.floor(sched.nowMs() / 1000);
    const { client } = stubClient({
      listResult: [task('a', nowSec - 1), task('b', nowSec - 1)],
    });
    const events: Array<{ id: string; outcome: string }> = [];
    const r = new ApprovalReconciler({
      coreClient: client,
      nowMsFn: sched.nowMs,
      onExpired: (t, outcome) => events.push({ id: t.id, outcome }),
    });

    await r.runTick();
    expect(events).toEqual([
      { id: 'a', outcome: 'sent' },
      { id: 'b', outcome: 'sent' },
    ]);
  });

  it('lists empty on error and emits onError', async () => {
    const sched = fakeScheduler();
    const { client } = stubClient({
      listError: new Error('core unreachable'),
    });
    const errors: unknown[] = [];
    const r = new ApprovalReconciler({
      coreClient: client,
      nowMsFn: sched.nowMs,
      onError: (e) => errors.push(e),
    });

    const result = await r.runTick();
    expect(result.discovered).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('passes batchSize to listWorkflowTasks as limit', async () => {
    const sched = fakeScheduler();
    const { client, state } = stubClient();
    const r = new ApprovalReconciler({
      coreClient: client,
      nowMsFn: sched.nowMs,
      batchSize: 7,
    });

    await r.runTick();
    // Issue #20: batchSize is split across pending_approval + queued
    // so one tick processes AT MOST batchSize total items. With
    // batchSize=7, half=3, remaining=4.
    expect(state.listCalls).toHaveLength(2);
    expect(state.listCalls[0].state).toBe('pending_approval');
    expect(state.listCalls[0].limit).toBe(3);
    expect(state.listCalls[1].state).toBe('queued');
    expect(state.listCalls[1].limit).toBe(4);
  });
});

describe('ApprovalReconciler.start / stop', () => {
  it('fires an immediate tick on start', async () => {
    const sched = fakeScheduler();
    const { client, state } = stubClient();
    const r = new ApprovalReconciler({
      coreClient: client,
      nowMsFn: sched.nowMs,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    r.start();
    await r.flush();
    // Each tick fires TWO list calls (pending_approval + queued).
    // Issue #12 — single-state scan missed operator-approved-but-stalled tasks.
    expect(state.listCalls).toHaveLength(2);
    r.stop();
  });

  it('fires subsequent ticks at intervalMs', async () => {
    const sched = fakeScheduler();
    const { client, state } = stubClient();
    const r = new ApprovalReconciler({
      coreClient: client,
      nowMsFn: sched.nowMs,
      intervalMs: 60_000,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    r.start();
    await r.flush();
    // 2 list calls per tick (pending_approval + queued).
    expect(state.listCalls).toHaveLength(2);

    sched.advance(60_000);
    await r.flush();
    expect(state.listCalls).toHaveLength(4);

    sched.advance(60_000);
    await r.flush();
    expect(state.listCalls).toHaveLength(6);
    r.stop();
  });

  it('start is idempotent — second call does not spawn another interval', async () => {
    const sched = fakeScheduler();
    const { client, state } = stubClient();
    const r = new ApprovalReconciler({
      coreClient: client,
      nowMsFn: sched.nowMs,
      intervalMs: 60_000,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    r.start();
    r.start();
    await r.flush();
    sched.advance(60_000);
    await r.flush();
    // 2 ticks × 2 list calls per tick (pending + queued) = 4. A stray
    // second interval would produce ≥ 6.
    expect(state.listCalls).toHaveLength(4);
    r.stop();
  });

  it('stop prevents future ticks', async () => {
    const sched = fakeScheduler();
    const { client, state } = stubClient();
    const r = new ApprovalReconciler({
      coreClient: client,
      nowMsFn: sched.nowMs,
      intervalMs: 60_000,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    r.start();
    await r.flush();
    r.stop();
    sched.advance(60_000);
    await r.flush();
    expect(state.listCalls).toHaveLength(2); // only the immediate tick × 2 states
  });

  it('stop is idempotent', () => {
    const sched = fakeScheduler();
    const { client } = stubClient();
    const r = new ApprovalReconciler({
      coreClient: client,
      nowMsFn: sched.nowMs,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    r.start();
    r.stop();
    expect(() => r.stop()).not.toThrow();
  });
});
