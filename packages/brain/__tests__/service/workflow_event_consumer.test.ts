/**
 * BRAIN-P2-W03 — WorkflowEventConsumer tests.
 */

import {
  WorkflowEventConsumer,
  type WorkflowEventConsumerCoreClient,
  type WorkflowEventDeliverer,
} from '../../src/service/workflow_event_consumer';
import type { WorkflowEvent, WorkflowTask } from '../../../core/src/workflow/domain';

function fakeScheduler() {
  let nextHandle = 1;
  const timers = new Map<number, { everyMs: number; fn: () => void; nextMs: number }>();
  let nowMs = 1_700_000_000_000;
  return {
    nowMs: () => nowMs,
    setInterval: (fn: () => void, ms: number) => {
      const h = nextHandle++;
      timers.set(h, { everyMs: ms, fn, nextMs: nowMs + ms });
      return h as unknown;
    },
    clearInterval: (h: unknown) => {
      timers.delete(h as number);
    },
    advance(ms: number) {
      nowMs += ms;
      let fired = true;
      while (fired) {
        fired = false;
        for (const [id, t] of timers) {
          if (t.nextMs <= nowMs) {
            t.fn();
            t.nextMs += t.everyMs;
            fired = true;
          }
          void id;
        }
      }
    },
  };
}

interface StubState {
  listCalls: Array<{ since?: number; limit?: number; needsDeliveryOnly?: boolean }>;
  ackCalls: number[];
  getCalls: string[];
  listResult: WorkflowEvent[];
  listError: Error | null;
  ackError: Error | null;
  getError: Error | null;
  tasks: Map<string, WorkflowTask | null>;
}

function stubCore(init?: Partial<StubState>): {
  client: WorkflowEventConsumerCoreClient;
  state: StubState;
} {
  const state: StubState = {
    listCalls: [],
    ackCalls: [],
    getCalls: [],
    listResult: [],
    listError: null,
    ackError: null,
    getError: null,
    tasks: new Map(),
    ...init,
  };
  const client: WorkflowEventConsumerCoreClient = {
    async listWorkflowEvents(params) {
      state.listCalls.push(params ?? {});
      if (state.listError !== null) throw state.listError;
      return state.listResult;
    },
    async acknowledgeWorkflowEvent(id: number) {
      state.ackCalls.push(id);
      if (state.ackError !== null) throw state.ackError;
      return true;
    },
    async getWorkflowTask(id: string) {
      state.getCalls.push(id);
      if (state.getError !== null) throw state.getError;
      return state.tasks.get(id) ?? null;
    },
    async failWorkflowEventDelivery(_eventId: number) {
      // Test fixture no-op: the consumer calls this on delivery
      // failure; individual tests that need to assert on it can
      // override via the `init` block.
      return true;
    },
  };
  return { client, state };
}

function svcQueryTask(id: string, overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id,
    kind: 'service_query',
    status: 'completed',
    priority: 'normal',
    description: '',
    payload: JSON.stringify({
      type: 'service_query',
      to_did: 'did:plc:provider',
      capability: 'eta_query',
      params: {},
      ttl_seconds: 60,
      service_name: 'Bus 42',
      query_id: 'q-1',
    }),
    // task.result carries the full ServiceResponseBody as JSON.
    result: JSON.stringify({
      query_id: 'q-1',
      capability: 'eta_query',
      status: 'success',
      result: { eta_minutes: 45, vehicle_type: 'Bus', route_name: '42' },
      ttl_seconds: 60,
    }),
    result_summary: 'received',
    policy: '{}',
    correlation_id: 'q-1',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_500,
    ...overrides,
  };
}

function completedEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    event_id: 1,
    task_id: 'svc-q-1',
    at: 1_700_000_000_500,
    event_kind: 'completed',
    needs_delivery: true,
    delivery_attempts: 0,
    delivery_failed: false,
    details: JSON.stringify({
      response_status: 'success',
      capability: 'eta_query',
      service_name: 'Bus 42',
    }),
    ...overrides,
  };
}

const noopDeliver: WorkflowEventDeliverer = () => {
  /* no-op */
};

// --- construction -----------------------------------------------------------

describe('WorkflowEventConsumer — construction', () => {
  it('rejects missing coreClient', () => {
    expect(
      () =>
        new WorkflowEventConsumer({
          coreClient: undefined as unknown as WorkflowEventConsumerCoreClient,
          deliver: noopDeliver,
        }),
    ).toThrow(/coreClient/);
  });

  it('rejects missing deliver', () => {
    const { client } = stubCore();
    expect(
      () =>
        new WorkflowEventConsumer({
          coreClient: client,
          deliver: undefined as unknown as WorkflowEventDeliverer,
        }),
    ).toThrow(/deliver/);
  });

  it('rejects non-positive intervalMs / batchSize', () => {
    const { client } = stubCore();
    expect(
      () => new WorkflowEventConsumer({ coreClient: client, deliver: noopDeliver, intervalMs: 0 }),
    ).toThrow(/intervalMs/);
    expect(
      () => new WorkflowEventConsumer({ coreClient: client, deliver: noopDeliver, batchSize: -1 }),
    ).toThrow(/batchSize/);
  });
});

// --- runTick ----------------------------------------------------------------

describe('WorkflowEventConsumer.runTick', () => {
  it('lists needs_delivery=true with batchSize limit', async () => {
    const { client, state } = stubCore();
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      batchSize: 10,
    });
    await c.runTick();
    expect(state.listCalls).toEqual([{ needsDeliveryOnly: true, limit: 10 }]);
  });

  it('renders service_query completion via formatServiceQueryResult and delivers + acks', async () => {
    const task = svcQueryTask('svc-q-1');
    const { client, state } = stubCore({
      listResult: [completedEvent()],
      tasks: new Map([['svc-q-1', task]]),
    });
    const delivered: Array<{ text: string; taskId: string }> = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: ({ text, task: t }) => {
        delivered.push({ text, taskId: t.id });
      },
    });
    const result = await c.runTick();
    expect(result.discovered).toBe(1);
    expect(result.delivered).toBe(1);
    expect(delivered).toHaveLength(1);
    // formatEta output for Bus 42 + 45 min
    expect(delivered[0].text).toContain('Bus 42');
    expect(delivered[0].text).toContain('45 minutes away');
    expect(state.ackCalls).toEqual([1]);
  });

  it('merges task.result into details when the event.details omits `result`', async () => {
    const task = svcQueryTask('svc-q-1', {
      result: JSON.stringify({
        query_id: 'q-1',
        capability: 'eta_query',
        status: 'success',
        result: { eta_minutes: 12, vehicle_type: 'Bus', route_name: '7' },
        ttl_seconds: 60,
      }),
    });
    const { client } = stubCore({
      listResult: [completedEvent()], // details has NO `result` field
      tasks: new Map([['svc-q-1', task]]),
    });
    let captured: string | null = null;
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: ({ text }) => {
        captured = text;
      },
    });
    await c.runTick();
    expect(captured).not.toBeNull();
    expect(captured!).toContain('Bus 7');
    expect(captured!).toContain('12 minutes away');
  });

  it('overrides empty response_status from task.result.status', async () => {
    const task = svcQueryTask('svc-q-2', {
      result: JSON.stringify({
        query_id: 'q',
        capability: 'eta_query',
        status: 'unavailable',
        ttl_seconds: 60,
      }),
    });
    const { client } = stubCore({
      listResult: [
        completedEvent({
          event_id: 2,
          task_id: 'svc-q-2',
          details: JSON.stringify({
            // status intentionally absent
            capability: 'eta_query',
            service_name: 'Night Owl',
          }),
        }),
      ],
      tasks: new Map([['svc-q-2', task]]),
    });
    let captured: string | null = null;
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: ({ text }) => {
        captured = text;
      },
    });
    await c.runTick();
    expect(captured).toBe('Night Owl — service unavailable.');
  });

  it('delivers failed events on service_query tasks + skips approved (no onApproved installed)', async () => {
    // Issue #11: failed events (TTL expiry, provider reject) now route
    // through the formatter so the user actually sees the outcome.
    // Approved events still skip when no onApproved dispatcher is wired.
    const task = svcQueryTask('svc-q-1');
    const { client, state } = stubCore({
      listResult: [
        completedEvent({ event_id: 10, event_kind: 'failed', task_id: 'svc-q-1' }),
        completedEvent({ event_id: 11, event_kind: 'approved' }),
      ],
      tasks: new Map([['svc-q-1', task]]),
    });
    const delivered: string[] = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: ({ text }) => {
        delivered.push(text);
      },
    });
    const result = await c.runTick();
    expect(result.delivered).toBe(1);
    expect(result.skipped).toBe(1);
    expect(delivered).toHaveLength(1);
    // Both events still acked (delivered event 10, skipped event 11).
    expect(state.ackCalls.sort()).toEqual([10, 11]);
    // The failed event fetched the task; the skipped approved did not.
    expect(state.getCalls).toEqual(['svc-q-1']);
  });

  it('skips and acks completed events on non-service_query tasks (approval / delegation)', async () => {
    const approvalTask = svcQueryTask('appr-1', { kind: 'approval' });
    const delegTask = svcQueryTask('deleg-1', { kind: 'delegation' });
    const { client, state } = stubCore({
      listResult: [
        completedEvent({ event_id: 20, task_id: 'appr-1' }),
        completedEvent({ event_id: 21, task_id: 'deleg-1' }),
      ],
      tasks: new Map([
        ['appr-1', approvalTask],
        ['deleg-1', delegTask],
      ]),
    });
    const delivered: string[] = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: ({ text }) => {
        delivered.push(text);
      },
    });
    const result = await c.runTick();
    expect(result.skipped).toBe(2);
    expect(result.delivered).toBe(0);
    expect(delivered).toHaveLength(0);
    expect(state.ackCalls).toEqual([20, 21]);
  });

  it('skips and acks completed events whose task is missing (archived)', async () => {
    const { client, state } = stubCore({
      listResult: [completedEvent({ event_id: 30 })],
      tasks: new Map([['svc-q-1', null]]), // explicit null
    });
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
    });
    const result = await c.runTick();
    expect(result.skipped).toBe(1);
    expect(state.ackCalls).toEqual([30]);
  });

  it('does NOT ack when deliver throws; error recorded', async () => {
    const task = svcQueryTask('svc-q-1');
    const { client, state } = stubCore({
      listResult: [completedEvent()],
      tasks: new Map([['svc-q-1', task]]),
    });
    const errors: unknown[] = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: () => {
        throw new Error('chat thread offline');
      },
      onError: (e) => errors.push(e),
    });
    const result = await c.runTick();
    expect(result.failed).toBe(1);
    expect(result.delivered).toBe(0);
    // Crucially, ack was NOT called — so Core can redeliver.
    expect(state.ackCalls).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('chat thread offline');
  });

  it('records onError when listWorkflowEvents throws', async () => {
    const { client, state } = stubCore({
      listError: new Error('core down'),
    });
    const errors: unknown[] = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      onError: (e) => errors.push(e),
    });
    const result = await c.runTick();
    expect(result.discovered).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(state.ackCalls).toHaveLength(0);
  });

  it('records onError when getWorkflowTask throws; counts event as failed, does NOT ack', async () => {
    const { client, state } = stubCore({
      listResult: [completedEvent()],
      getError: new Error('task fetch 500'),
    });
    const errors: unknown[] = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      onError: (e) => errors.push(e),
    });
    const result = await c.runTick();
    expect(result.failed).toBe(1);
    expect(state.ackCalls).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('records onError when acknowledgeWorkflowEvent throws; does NOT increment delivered', async () => {
    const task = svcQueryTask('svc-q-1');
    const { client } = stubCore({
      listResult: [completedEvent()],
      tasks: new Map([['svc-q-1', task]]),
      ackError: new Error('ack 503'),
    });
    const errors: unknown[] = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      onError: (e) => errors.push(e),
    });
    const result = await c.runTick();
    expect(result.errors).toHaveLength(1);
    expect(result.delivered).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('isolates per-event failures; one bad event does not stop the tick', async () => {
    const goodTask = svcQueryTask('svc-q-1');
    const badTask = svcQueryTask('svc-q-bad');
    const { client, state } = stubCore({
      listResult: [
        completedEvent({ event_id: 1, task_id: 'svc-q-1' }),
        completedEvent({ event_id: 2, task_id: 'svc-q-bad' }),
        completedEvent({ event_id: 3, task_id: 'svc-q-1' }),
      ],
      tasks: new Map([
        ['svc-q-1', goodTask],
        ['svc-q-bad', badTask],
      ]),
    });
    let n = 0;
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: () => {
        n++;
        if (n === 2) throw new Error('middle delivery boom');
      },
    });
    const result = await c.runTick();
    expect(result.discovered).toBe(3);
    expect(result.delivered).toBe(2);
    expect(result.failed).toBe(1);
    // bad event (id=2) NOT acked — first + third are.
    expect(state.ackCalls).toEqual([1, 3]);
  });

  it('fires onTaskOutcome per event (delivered / skipped)', async () => {
    // After issue #11: `failed` events on service_query tasks now
    // deliver instead of skipping. Use a non-service_query failed event
    // (kind='delegation') to exercise the skip path.
    const qTask = svcQueryTask('svc-q-1');
    const delegTask = svcQueryTask('deleg-1', { kind: 'delegation' });
    const { client } = stubCore({
      listResult: [
        completedEvent({ event_id: 1, event_kind: 'failed', task_id: 'deleg-1' }), // skipped
        completedEvent({ event_id: 2, task_id: 'svc-q-1' }), // delivered
      ],
      tasks: new Map([
        ['svc-q-1', qTask],
        ['deleg-1', delegTask],
      ]),
    });
    const events: Array<{ id: number; outcome: string }> = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      onTaskOutcome: (ev, outcome) => events.push({ id: ev.event_id, outcome }),
    });
    await c.runTick();
    expect(events).toEqual([
      { id: 1, outcome: 'skipped' },
      { id: 2, outcome: 'delivered' },
    ]);
  });
});

// --- onApproved dispatch ----------------------------------------------------

describe('WorkflowEventConsumer.onApproved', () => {
  function approvalTask(id: string, overrides: Partial<WorkflowTask> = {}): WorkflowTask {
    return {
      id,
      kind: 'approval',
      status: 'queued',
      priority: 'normal',
      description: 'Approve Bus 42 ETA',
      payload: JSON.stringify({
        type: 'service_query_execution',
        from_did: 'did:plc:requester',
        query_id: 'q-approve',
        capability: 'eta_query',
        params: { stop_id: 'S1' },
        ttl_seconds: 60,
        service_name: 'Bus 42',
        schema_hash: 'sha256:abc',
      }),
      result_summary: '',
      policy: '{}',
      correlation_id: 'q-approve',
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_500,
      ...overrides,
    };
  }

  function approvedEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
    return {
      event_id: 100,
      task_id: 'appr-1',
      at: 1_700_000_000_500,
      event_kind: 'approved',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify({ kind: 'approval', task_payload: '{}' }),
      ...overrides,
    };
  }

  it('dispatches payload to onApproved then acks the event', async () => {
    const task = approvalTask('appr-1');
    const { client, state } = stubCore({
      listResult: [approvedEvent()],
      tasks: new Map([['appr-1', task]]),
    });
    const seen: Array<{ taskId: string; from: string; capability: string }> = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      onApproved: ({ task: t, payload }) => {
        seen.push({ taskId: t.id, from: payload.from_did, capability: payload.capability });
      },
    });
    const result = await c.runTick();
    expect(result.delivered).toBe(1);
    expect(seen).toEqual([
      { taskId: 'appr-1', from: 'did:plc:requester', capability: 'eta_query' },
    ]);
    expect(state.ackCalls).toEqual([100]);
  });

  it('preserves optional payload fields (ttl_seconds / schema_hash / service_name)', async () => {
    const task = approvalTask('appr-1');
    const { client } = stubCore({
      listResult: [approvedEvent()],
      tasks: new Map([['appr-1', task]]),
    });
    let captured: unknown = null;
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      onApproved: ({ payload }) => {
        captured = payload;
      },
    });
    await c.runTick();
    expect(captured).toEqual({
      from_did: 'did:plc:requester',
      query_id: 'q-approve',
      capability: 'eta_query',
      params: { stop_id: 'S1' },
      ttl_seconds: 60,
      schema_hash: 'sha256:abc',
      service_name: 'Bus 42',
    });
  });

  it('does NOT ack when onApproved throws; records failure for redrive', async () => {
    const task = approvalTask('appr-1');
    const { client, state } = stubCore({
      listResult: [approvedEvent()],
      tasks: new Map([['appr-1', task]]),
    });
    const errs: unknown[] = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      onApproved: () => {
        throw new Error('executeAndRespond 503');
      },
      onError: (e) => errs.push(e),
    });
    const result = await c.runTick();
    expect(result.failed).toBe(1);
    expect(state.ackCalls).toEqual([]);
    expect(errs).toHaveLength(1);
    expect((errs[0] as Error).message).toBe('executeAndRespond 503');
  });

  it('records a failure (no-ack, onError fires) when the approval payload is malformed', async () => {
    // "Malformed" = missing required fields. The event is NOT acked so
    // operator dashboards keep surfacing it; fixing the payload requires
    // an operator action outside this module's concern. (Poison-pill
    // mitigation is a separate, future concern via delivery_attempts
    // ceilings on Core.)
    const task = approvalTask('appr-1', {
      payload: JSON.stringify({ type: 'service_query_execution' /* no from_did */ }),
    });
    const { client, state } = stubCore({
      listResult: [approvedEvent()],
      tasks: new Map([['appr-1', task]]),
    });
    const invoked: string[] = [];
    const errs: unknown[] = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      onApproved: ({ task: t }) => {
        invoked.push(t.id);
      },
      onError: (e) => errs.push(e),
    });
    const result = await c.runTick();
    expect(invoked).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(state.ackCalls).toEqual([]);
    expect(errs).toHaveLength(1);
  });

  it('skips and acks approved events when no onApproved handler is installed', async () => {
    const task = approvalTask('appr-1');
    const { client, state } = stubCore({
      listResult: [approvedEvent()],
      tasks: new Map([['appr-1', task]]),
    });
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      // no onApproved
    });
    const result = await c.runTick();
    expect(result.skipped).toBe(1);
    expect(state.ackCalls).toEqual([100]);
    // Task fetch is skipped in this branch — we short-circuit before it.
    expect(state.getCalls).toHaveLength(0);
  });

  it('skips approved events whose task has kind!=approval', async () => {
    const task = approvalTask('appr-1', { kind: 'delegation' });
    const { client, state } = stubCore({
      listResult: [approvedEvent()],
      tasks: new Map([['appr-1', task]]),
    });
    const invoked: string[] = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      onApproved: ({ task: t }) => {
        invoked.push(t.id);
      },
    });
    const result = await c.runTick();
    expect(invoked).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(state.ackCalls).toEqual([100]);
  });

  it('skips approved events whose payload.type is not service_query_execution (e.g. intent_validation)', async () => {
    // `POST /v1/intent/validate` raises an approval task whose payload
    // is `{type:'intent_validation', action, target, ...}`. The
    // bus-driver consumer must ack-and-skip those — there's no
    // service.query waiting on a D2D response.
    const task = approvalTask('appr-intent-1', {
      payload: JSON.stringify({
        type: 'intent_validation',
        action: 'send_email',
        target: 'draft resignation letter to HR',
        risk_level: 'MODERATE',
      }),
    });
    const { client, state } = stubCore({
      listResult: [approvedEvent({ task_id: 'appr-intent-1' })],
      tasks: new Map([['appr-intent-1', task]]),
    });
    const invoked: string[] = [];
    const errs: Error[] = [];
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      onApproved: ({ task: t }) => {
        invoked.push(t.id);
      },
      onError: (e) => errs.push(e instanceof Error ? e : new Error(String(e))),
    });
    const result = await c.runTick();
    expect(invoked).toHaveLength(0);
    expect(errs).toHaveLength(0); // not treated as malformed
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(state.ackCalls).toEqual([100]);
  });
});

// --- start / stop -----------------------------------------------------------

describe('WorkflowEventConsumer.start / stop', () => {
  it('fires an immediate tick on start', async () => {
    const sched = fakeScheduler();
    const { client, state } = stubCore();
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    c.start();
    await c.flush();
    expect(state.listCalls).toHaveLength(1);
    c.stop();
  });

  it('fires subsequent ticks at intervalMs', async () => {
    const sched = fakeScheduler();
    const { client, state } = stubCore();
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      intervalMs: 1_000,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    c.start();
    await c.flush();
    sched.advance(1_000);
    await c.flush();
    sched.advance(1_000);
    await c.flush();
    expect(state.listCalls).toHaveLength(3);
    c.stop();
  });

  it('start is idempotent', async () => {
    const sched = fakeScheduler();
    const { client, state } = stubCore();
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      intervalMs: 1_000,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    c.start();
    c.start();
    await c.flush();
    sched.advance(1_000);
    await c.flush();
    expect(state.listCalls).toHaveLength(2);
    c.stop();
  });

  it('stop prevents future ticks', async () => {
    const sched = fakeScheduler();
    const { client, state } = stubCore();
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      intervalMs: 1_000,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    c.start();
    await c.flush();
    c.stop();
    sched.advance(1_000);
    await c.flush();
    expect(state.listCalls).toHaveLength(1);
  });

  it('stop is idempotent', () => {
    const sched = fakeScheduler();
    const { client } = stubCore();
    const c = new WorkflowEventConsumer({
      coreClient: client,
      deliver: noopDeliver,
      setInterval: sched.setInterval,
      clearInterval: sched.clearInterval,
    });
    c.start();
    c.stop();
    expect(() => c.stop()).not.toThrow();
  });
});
