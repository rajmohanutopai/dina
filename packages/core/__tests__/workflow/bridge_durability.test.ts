/**
 * Response Bridge durability (main-dina 4848a934).
 *
 * On delegation completion the bridge stashes `bridge_pending:<ctx>`
 * in the task's `internal_stash` BEFORE calling the sender. On send
 * success the stash is cleared. A send failure leaves the stash in
 * place so `BridgePendingSweeper` / `retryPendingBridges()` can retry
 * on the next tick — the requester never sits waiting on a transient
 * D2D hiccup.
 */

import {
  WorkflowService,
  type ResponseBridgeSender,
  type ServiceQueryBridgeContext,
} from '../../src/workflow/service';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import {
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
} from '../../src/workflow/domain';
import { BridgePendingSweeper } from '../../src/workflow/bridge_pending_sweeper';

const SERVICE_QUERY_PAYLOAD = JSON.stringify({
  type: 'service_query_execution',
  from_did: 'did:plc:requester',
  query_id: 'q-1',
  capability: 'eta_query',
  ttl_seconds: 60,
  service_name: 'Bus 42',
  params: { route: '42' },
});

function makeExecTask(): { repo: InMemoryWorkflowRepository; taskId: string } {
  const repo = new InMemoryWorkflowRepository();
  const taskId = 'svc-exec-q-1';
  const now = 1_700_000_000_000;
  repo.create({
    id: taskId,
    kind: WorkflowTaskKind.Delegation,
    status: WorkflowTaskState.Created,
    priority: WorkflowTaskPriority.Normal,
    description: 'exec',
    payload: SERVICE_QUERY_PAYLOAD,
    result_summary: '',
    policy: '',
    origin: 'api',
    created_at: now,
    updated_at: now,
  });
  // Move to running so complete() can transition it.
  repo.transition(taskId, WorkflowTaskState.Created, WorkflowTaskState.Running, now + 1);
  return { repo, taskId };
}

// A mutable bridge sender whose behaviour tests can flip between
// "throw" and "deliver" to exercise the retry path.
function mutableSender(): {
  sender: ResponseBridgeSender;
  calls: ServiceQueryBridgeContext[];
  setBehaviour: (b: 'throw' | 'deliver') => void;
} {
  const calls: ServiceQueryBridgeContext[] = [];
  let behaviour: 'throw' | 'deliver' = 'throw';
  const sender: ResponseBridgeSender = async (ctx) => {
    calls.push({ ...ctx });
    if (behaviour === 'throw') {
      throw new Error('send failed (test)');
    }
  };
  return {
    sender,
    calls,
    setBehaviour: (b) => {
      behaviour = b;
    },
  };
}

describe('WorkflowService — bridge durability', () => {
  it('stashes bridge_pending before sending and clears it on success', async () => {
    const { repo, taskId } = makeExecTask();
    const calls: ServiceQueryBridgeContext[] = [];
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: async (ctx) => {
        calls.push({ ...ctx });
      },
    });

    // complete(id, resultJSON, resultSummary, agentDID)
    service.complete(taskId, JSON.stringify({ eta_min: 4 }), 'ok', 'svc:agent');

    // Let the detached bridge promise settle.
    await new Promise<void>((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    // Stash cleared on success.
    expect(repo.getById(taskId)?.internal_stash).toBeUndefined();
  });

  it('leaves bridge_pending stash when the sender throws', async () => {
    const { repo, taskId } = makeExecTask();
    const { sender, calls } = mutableSender();
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: sender,
    });

    // complete(id, resultJSON, resultSummary, agentDID)
    service.complete(taskId, JSON.stringify({ eta_min: 4 }), 'ok', 'svc:agent');
    await new Promise<void>((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    const stash = repo.getById(taskId)?.internal_stash;
    expect(typeof stash).toBe('string');
    expect(stash!.startsWith('bridge_pending:')).toBe(true);
    // The ctx inside the stash round-trips the query_id + fromDID.
    expect(stash).toContain('"queryId":"q-1"');
    expect(stash).toContain('"fromDID":"did:plc:requester"');
  });

  it('retryPendingBridges resends and clears on success', async () => {
    const { repo, taskId } = makeExecTask();
    const { sender, calls, setBehaviour } = mutableSender();
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: sender,
    });

    // complete(id, resultJSON, resultSummary, agentDID)
    service.complete(taskId, JSON.stringify({ eta_min: 4 }), 'ok', 'svc:agent');
    await new Promise<void>((r) => setImmediate(r));

    // First send failed — stash present.
    expect(repo.getById(taskId)?.internal_stash).toMatch(/^bridge_pending:/);

    // Flip to deliver, run retry.
    setBehaviour('deliver');
    const cleared = await service.retryPendingBridges();
    expect(cleared).toBe(1);
    expect(calls).toHaveLength(2); // initial + retry
    expect(repo.getById(taskId)?.internal_stash).toBeUndefined();
  });

  it('retryPendingBridges leaves the stash when retry still fails', async () => {
    const { repo, taskId } = makeExecTask();
    const { sender } = mutableSender();
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: sender,
    });

    // complete(id, resultJSON, resultSummary, agentDID)
    service.complete(taskId, JSON.stringify({ eta_min: 4 }), 'ok', 'svc:agent');
    await new Promise<void>((r) => setImmediate(r));

    const cleared = await service.retryPendingBridges();
    expect(cleared).toBe(0);
    expect(repo.getById(taskId)?.internal_stash).toMatch(/^bridge_pending:/);
  });

  it('never double-sends: sweeper tick during a slow initial send skips the in-flight task (#1)', async () => {
    const { repo, taskId } = makeExecTask();
    // Sender that hangs until we let it resolve. Simulates a slow
    // first-attempt D2D round-trip.
    const calls: ServiceQueryBridgeContext[] = [];
    let resolveFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let callCount = 0;
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: async (ctx) => {
        calls.push({ ...ctx });
        callCount++;
        if (callCount === 1) await firstDone; // hang the initial send
      },
    });

    service.complete(taskId, JSON.stringify({ eta_min: 4 }), 'ok', 'svc:agent');
    // Yield once so the detached initial send is actually started.
    await new Promise<void>((r) => setImmediate(r));

    // Sweeper ticks WHILE the first send is still in flight. With the
    // in-flight claim, this must NOT kick off a second send.
    const swept = await service.retryPendingBridges();
    expect(swept).toBe(0);
    expect(callCount).toBe(1);

    // Now let the first send complete.
    resolveFirst();
    await new Promise<void>((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    // Stash cleared on success.
    expect(repo.getById(taskId)?.internal_stash).toBeUndefined();
  });

  it('coalesces overlapping retryPendingBridges calls (#1)', async () => {
    const { repo, taskId } = makeExecTask();
    const { sender, setBehaviour } = mutableSender();
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: sender,
    });
    service.complete(taskId, JSON.stringify({ eta_min: 4 }), 'ok', 'svc:agent');
    await new Promise<void>((r) => setImmediate(r));
    setBehaviour('deliver');
    // Two overlapping sweeper ticks. Both must resolve to the same
    // cleared count — the in-flight tracker keeps them from fighting
    // over the same stashes.
    const a = service.retryPendingBridges();
    const b = service.retryPendingBridges();
    const [cleared1, cleared2] = await Promise.all([a, b]);
    expect(cleared1).toBe(1);
    expect(cleared2).toBe(1);
  });

  it('clears a corrupt bridge_pending stash instead of retrying forever', async () => {
    const { repo, taskId } = makeExecTask();
    // Hand-install a malformed stash that can't be deserialised.
    repo.setInternalStash(taskId, 'bridge_pending:not-json-at-all', 1_700_000_000_002);
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: async () => {
        /* never called — corrupt clears first */
      },
    });
    const cleared = await service.retryPendingBridges();
    expect(cleared).toBe(0);
    // Corrupt stash is wiped so the sweeper doesn't spin on it.
    expect(repo.getById(taskId)?.internal_stash).toBeUndefined();
  });
});

describe('WorkflowService — bridge reliability hardening', () => {
  it('times out a hung send so the in-flight claim is released for the sweeper (#1)', async () => {
    const { repo, taskId } = makeExecTask();
    // Sender that NEVER resolves — simulates a frozen transport.
    const sender: ResponseBridgeSender = () =>
      new Promise<void>(() => {
        /* never settles */
      });
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: sender,
    });

    // Shrink the send timeout BEFORE complete() kicks off the detached
    // send — the withTimeout() timer is created at send-time with
    // whatever global setTimeout points at, so overriding afterwards
    // doesn't shorten the wait that's already scheduled.
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, _ms: number) =>
      originalSetTimeout(fn, 5)) as typeof globalThis.setTimeout;
    try {
      service.complete(taskId, JSON.stringify({ ok: true }), 'ok', 'svc:agent');
      await service.flushBridgeInFlight();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // Stash still present (send did NOT succeed). The claim has been
    // released so a subsequent sweeper tick can retry.
    expect(repo.getById(taskId)?.internal_stash).toMatch(/^bridge_pending:/);

    // Swap in a deliverable sender and verify the retry succeeds.
    const delivered: ServiceQueryBridgeContext[] = [];
    const service2 = new WorkflowService({
      repository: repo,
      responseBridgeSender: async (ctx) => {
        delivered.push({ ...ctx });
      },
    });
    const cleared = await service2.retryPendingBridges();
    expect(cleared).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(repo.getById(taskId)?.internal_stash).toBeUndefined();
  });

  it('delivered-awaiting-clear: a successful send whose stash clear fails is NOT resent (#3)', async () => {
    const { repo, taskId } = makeExecTask();
    const delivered: ServiceQueryBridgeContext[] = [];
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: async (ctx) => {
        delivered.push({ ...ctx });
      },
    });

    // Gate setInternalStash: the first call is the initial
    // pre-send stash write (must succeed); every subsequent call
    // is the post-send CLEAR (must fail until we flip the flag
    // at the end of the test).
    const realSetStash = repo.setInternalStash.bind(repo);
    let clearShouldFail = true;
    let firstCallDone = false;
    repo.setInternalStash = (id, stash, ms) => {
      if (!firstCallDone) {
        firstCallDone = true;
        return realSetStash(id, stash, ms);
      }
      if (clearShouldFail) throw new Error('clear failed');
      return realSetStash(id, stash, ms);
    };

    // Shrink retry backoff so the 3 stash-clear retries don't make
    // this test slow.
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, _ms: number) =>
      originalSetTimeout(fn, 1)) as typeof globalThis.setTimeout;
    try {
      service.complete(taskId, JSON.stringify({ ok: true }), 'ok', 'svc:agent');
      await service.flushBridgeInFlight();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    // Send landed. Clear retried 3 times and failed each time →
    // stash still present.
    expect(delivered).toHaveLength(1);
    expect(repo.getById(taskId)?.internal_stash).toMatch(/^bridge_pending:/);

    // Retry sweep must NOT re-send — the service knows this task
    // already delivered, only the clear hasn't landed.
    const cleared = await service.retryPendingBridges();
    expect(cleared).toBe(0);
    expect(delivered).toHaveLength(1);

    // Flip the gate so the clear succeeds; next retry tick cleans up.
    clearShouldFail = false;
    await service.retryPendingBridges();
    expect(repo.getById(taskId)?.internal_stash).toBeUndefined();
  });

  it('in-memory fallback: initial stash failure still lets retry deliver (#4)', async () => {
    const { repo, taskId } = makeExecTask();
    // Fail the INITIAL stash write. The bridge must still be able to
    // record the send in-memory so a later retry can deliver.
    const realSetStash = repo.setInternalStash.bind(repo);
    repo.setInternalStash = () => {
      throw new Error('stash write failed');
    };
    // First send fails too so nothing delivers on the detached try.
    let behaviour: 'throw' | 'deliver' = 'throw';
    const delivered: ServiceQueryBridgeContext[] = [];
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: async (ctx) => {
        if (behaviour === 'throw') throw new Error('first-send-failed');
        delivered.push({ ...ctx });
      },
    });

    service.complete(taskId, JSON.stringify({ ok: true }), 'ok', 'svc:agent');
    await service.flushBridgeInFlight();
    // No stash on the task (write failed). No delivery yet either.
    expect(repo.getById(taskId)?.internal_stash).toBeUndefined();
    expect(delivered).toHaveLength(0);

    // Restore the repo and flip to "deliver." The sweeper must walk
    // the in-memory fallback and deliver the stashed ctx.
    repo.setInternalStash = realSetStash;
    behaviour = 'deliver';
    const cleared = await service.retryPendingBridges();
    expect(cleared).toBe(1);
    expect(delivered).toHaveLength(1);
  });
});

describe('BridgePendingSweeper', () => {
  it('runTick returns the cleared count from retryPendingBridges', async () => {
    const { repo, taskId } = makeExecTask();
    const { sender, setBehaviour } = mutableSender();
    const service = new WorkflowService({
      repository: repo,
      responseBridgeSender: sender,
    });
    service.complete(taskId, JSON.stringify({ ok: true }), 'ok', 'svc:agent');
    await new Promise<void>((r) => setImmediate(r));

    const sweeper = new BridgePendingSweeper({
      service,
      setInterval: () => 0 as unknown,
      clearInterval: () => {
        /* no-op */
      },
    });
    setBehaviour('deliver');
    const tick = await sweeper.runTick();
    expect(tick.cleared).toBe(1);
    expect(tick.errors).toEqual([]);
  });

  it('onTick observer is called with the result', async () => {
    const { repo } = makeExecTask();
    const service = new WorkflowService({ repository: repo });
    const seen: Array<{ cleared: number; errors: unknown[] }> = [];
    const sweeper = new BridgePendingSweeper({
      service,
      onTick: (r) => seen.push(r),
      setInterval: () => 0 as unknown,
      clearInterval: () => {
        /* no-op */
      },
    });
    await sweeper.runTick();
    expect(seen).toHaveLength(1);
    expect(seen[0].cleared).toBe(0);
  });
});
