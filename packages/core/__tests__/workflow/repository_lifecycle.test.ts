/**
 * CORE-P2-E23 + E25-E28 (lifecycle) + E31-E32 (sweeper) + E35-E36 (event
 * delivery) tests.
 */

import { InMemoryWorkflowRepository, WorkflowConflictError } from '../../src/workflow/repository';
import {
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
  type WorkflowTask,
} from '../../src/workflow/domain';

function baseTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: 'task-1',
    kind: WorkflowTaskKind.ServiceQuery,
    status: WorkflowTaskState.Running,
    priority: WorkflowTaskPriority.Normal,
    description: '',
    payload: JSON.stringify({ to_did: 'did:plc:bus', capability: 'eta_query' }),
    result_summary: '',
    policy: '{}',
    correlation_id: 'q-1',
    expires_at: 1_700_000_060, // 60s after created_at
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// findServiceQueryTask
// ---------------------------------------------------------------------------

describe('findServiceQueryTask', () => {
  it('matches on (queryId, peerDID, capability) triple', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask());
    const got = r.findServiceQueryTask('q-1', 'did:plc:bus', 'eta_query', 1_700_000_030);
    expect(got?.id).toBe('task-1');
  });

  it('matches a task in `created` state (fast-response race — BRAIN-P2-T08)', () => {
    // A provider can respond BEFORE `POST /v1/service/query` finishes its
    // `created → running` transition. findServiceQueryTask must include
    // `created` in its filter — otherwise the response has nowhere to land
    // and the handler has to crash or drop it. Pin the permissive filter.
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ status: WorkflowTaskState.Created }));
    const got = r.findServiceQueryTask('q-1', 'did:plc:bus', 'eta_query', 1_700_000_030);
    expect(got?.id).toBe('task-1');
    expect(got?.status).toBe('created');
  });

  it('returns null for empty inputs', () => {
    const r = new InMemoryWorkflowRepository();
    expect(r.findServiceQueryTask('', 'did:plc:bus', 'eta_query', 0)).toBeNull();
    expect(r.findServiceQueryTask('q-1', '', 'eta_query', 0)).toBeNull();
    expect(r.findServiceQueryTask('q-1', 'did:plc:bus', '', 0)).toBeNull();
  });

  it('skips non-service_query tasks', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ kind: WorkflowTaskKind.Delegation }));
    expect(r.findServiceQueryTask('q-1', 'did:plc:bus', 'eta_query', 1_700_000_030)).toBeNull();
  });

  it('skips expired tasks', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ expires_at: 1_700_000_010 }));
    expect(r.findServiceQueryTask('q-1', 'did:plc:bus', 'eta_query', 1_700_000_100)).toBeNull();
  });

  it('rejects peer DID mismatch', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask());
    expect(r.findServiceQueryTask('q-1', 'did:plc:other', 'eta_query', 1_700_000_030)).toBeNull();
  });

  it('rejects capability mismatch', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask());
    expect(r.findServiceQueryTask('q-1', 'did:plc:bus', 'other_cap', 1_700_000_030)).toBeNull();
  });

  it('skips tasks with malformed payload JSON', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ payload: '{not json' }));
    expect(r.findServiceQueryTask('q-1', 'did:plc:bus', 'eta_query', 1_700_000_030)).toBeNull();
  });

  it('only considers created / running states', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ status: WorkflowTaskState.Completed }));
    expect(r.findServiceQueryTask('q-1', 'did:plc:bus', 'eta_query', 1_700_000_030)).toBeNull();
  });

  it('throws on duplicate correlation matches (data-integrity violation)', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ id: 'a' }));
    r.create(baseTask({ id: 'b' }));
    const err = (() => {
      try {
        r.findServiceQueryTask('q-1', 'did:plc:bus', 'eta_query', 1_700_000_030);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(WorkflowConflictError);
    expect((err as WorkflowConflictError).code).toBe('duplicate_correlation');
  });
});

// ---------------------------------------------------------------------------
// claimApprovalForExecution
// ---------------------------------------------------------------------------

describe('claimApprovalForExecution', () => {
  it('moves queued approval → running and extends expires_at', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(
      baseTask({
        id: 'a',
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.Queued,
        expires_at: 1_700_000_100,
      }),
    );
    const ok = r.claimApprovalForExecution('a', 60, 1_700_000_050);
    expect(ok).toBe(true);
    const t = r.getById('a');
    expect(t?.status).toBe('running');
    expect(t?.expires_at).toBe(1_700_000_160); // 100 + 60
  });

  it('fails on wrong kind', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(
      baseTask({
        id: 'a',
        kind: WorkflowTaskKind.ServiceQuery,
        status: WorkflowTaskState.Queued,
      }),
    );
    expect(r.claimApprovalForExecution('a', 60, 0)).toBe(false);
  });

  it('fails on wrong state', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(
      baseTask({
        id: 'a',
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.Running,
      }),
    );
    expect(r.claimApprovalForExecution('a', 60, 0)).toBe(false);
  });

  it('fails on missing task', () => {
    const r = new InMemoryWorkflowRepository();
    expect(r.claimApprovalForExecution('ghost', 60, 0)).toBe(false);
  });

  it('allows pending_approval claim (deny / TTL-expiry path — issue #10)', () => {
    // Contract shift: a `pending_approval` approval task CAN be
    // claimed for execution. This is how `/service_deny` and the
    // ApprovalReconciler push an `unavailable` response back to the
    // requester before the task is cancelled/failed. The operator-
    // approved `queued` path remains claimable as well.
    const r = new InMemoryWorkflowRepository();
    r.create(
      baseTask({
        id: 'a',
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.PendingApproval,
      }),
    );
    expect(r.claimApprovalForExecution('a', 60, 0)).toBe(true);
    expect(r.getById('a')?.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// completeWithDetails
// ---------------------------------------------------------------------------

describe('completeWithDetails', () => {
  it('transitions active task to completed + appends event', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask());

    const eventId = r.completeWithDetails(
      'task-1',
      'did:plc:agent',
      'responded',
      '{"eta":45}',
      '{"response_status":"success"}',
      1_700_000_100,
    );
    expect(eventId).toBeGreaterThan(0);

    const t = r.getById('task-1');
    expect(t?.status).toBe('completed');
    expect(t?.result).toBe('{"eta":45}');
    expect(t?.result_summary).toBe('responded');
    expect(t?.agent_did).toBe('did:plc:agent');

    const events = r.listEventsForTask('task-1');
    expect(events).toHaveLength(1);
    expect(events[0].event_kind).toBe('completed');
    expect(events[0].details).toBe('{"response_status":"success"}');
    expect(events[0].needs_delivery).toBe(true);
  });

  it('returns 0 on missing task (no event appended)', () => {
    const r = new InMemoryWorkflowRepository();
    expect(r.completeWithDetails('ghost', '', 's', '{}', '{}', 0)).toBe(0);
  });

  it('returns 0 on already-terminal task', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ status: WorkflowTaskState.Completed }));
    expect(r.completeWithDetails('task-1', '', 's', '{}', '{}', 0)).toBe(0);
    expect(r.listEventsForTask('task-1')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fail / cancel
// ---------------------------------------------------------------------------

describe('fail', () => {
  it('marks task failed + attaches error + appends event', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask());
    const id = r.fail('task-1', 'did:plc:agent', 'send_failed', 1_700_000_100);
    expect(id).toBeGreaterThan(0);
    const t = r.getById('task-1');
    expect(t?.status).toBe('failed');
    expect(t?.error).toBe('send_failed');
    const events = r.listEventsForTask('task-1');
    expect(events[0].event_kind).toBe('failed');
    expect(JSON.parse(events[0].details)).toEqual({ error: 'send_failed' });
  });

  it('returns 0 on already-terminal task', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ status: WorkflowTaskState.Cancelled }));
    expect(r.fail('task-1', '', 'x', 0)).toBe(0);
  });
});

describe('cancel', () => {
  it('marks task cancelled + appends event with reason', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask());
    const id = r.cancel('task-1', 'user_requested', 1_700_000_100);
    expect(id).toBeGreaterThan(0);
    const t = r.getById('task-1');
    expect(t?.status).toBe('cancelled');
    const events = r.listEventsForTask('task-1');
    expect(events[0].event_kind).toBe('cancelled');
    expect(JSON.parse(events[0].details)).toEqual({ reason: 'user_requested' });
  });

  it('returns 0 on already-terminal task', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ status: WorkflowTaskState.Completed }));
    expect(r.cancel('task-1', 'late', 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sweeper surfaces: listExpiringApprovalTasks + expireTasks
// ---------------------------------------------------------------------------

describe('listExpiringApprovalTasks', () => {
  it('returns approvals with expired deadlines, oldest-first', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(
      baseTask({
        id: 'a',
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.PendingApproval,
        expires_at: 200,
      }),
    );
    r.create(
      baseTask({
        id: 'b',
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.Queued,
        expires_at: 100,
      }),
    );
    r.create(
      baseTask({
        id: 'c',
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.PendingApproval,
        expires_at: 500, // future
      }),
    );

    const out = r.listExpiringApprovalTasks(300, 10);
    expect(out.map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('honours the limit argument', () => {
    const r = new InMemoryWorkflowRepository();
    for (let i = 0; i < 5; i++) {
      r.create(
        baseTask({
          id: `t-${i}`,
          kind: WorkflowTaskKind.Approval,
          status: WorkflowTaskState.Queued,
          expires_at: i,
        }),
      );
    }
    expect(r.listExpiringApprovalTasks(100, 3)).toHaveLength(3);
  });

  it('skips non-approval kinds', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ expires_at: 10 })); // service_query, expired
    expect(r.listExpiringApprovalTasks(100, 10)).toEqual([]);
  });

  it('skips tasks in states other than pending_approval / queued', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(
      baseTask({
        id: 'a',
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.Running,
        expires_at: 10,
      }),
    );
    expect(r.listExpiringApprovalTasks(100, 10)).toEqual([]);
  });
});

describe('expireTasks', () => {
  it('fails non-terminal tasks past their expires_at; returns the set', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ id: 'a', expires_at: 10 }));
    r.create(baseTask({ id: 'b', expires_at: 20 }));
    r.create(baseTask({ id: 'c', expires_at: 1000 })); // not expired

    const expired = r.expireTasks(100, 200_000);
    expect(expired.map((t) => t.id).sort()).toEqual(['a', 'b']);

    expect(r.getById('a')?.status).toBe('failed');
    expect(r.getById('a')?.error).toBe('expired');
    expect(r.getById('b')?.status).toBe('failed');
    expect(r.getById('c')?.status).toBe('running');
  });

  it('skips already-terminal tasks', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ id: 'a', status: WorkflowTaskState.Completed, expires_at: 10 }));
    const expired = r.expireTasks(100, 0);
    expect(expired).toEqual([]);
    expect(r.getById('a')?.status).toBe('completed');
  });

  it('returns empty list when nothing has expired', () => {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ expires_at: 10_000 }));
    expect(r.expireTasks(100, 0)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Event delivery: listUndeliveredEvents + markEvent*
// ---------------------------------------------------------------------------

describe('event delivery', () => {
  function setupWithEvents() {
    const r = new InMemoryWorkflowRepository();
    r.create(baseTask({ id: 'a' }));
    const idDelivered = r.appendEvent({
      task_id: 'a',
      at: 10,
      event_kind: 'completed',
      needs_delivery: false,
      delivery_attempts: 0,
      delivery_failed: false,
      details: '{}',
    });
    const idPending = r.appendEvent({
      task_id: 'a',
      at: 20,
      event_kind: 'failed',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: '{}',
    });
    const idDelayed = r.appendEvent({
      task_id: 'a',
      at: 30,
      event_kind: 'cancelled',
      needs_delivery: true,
      delivery_attempts: 1,
      delivery_failed: true,
      next_delivery_at: 1_000,
      details: '{}',
    });
    return { r, idDelivered, idPending, idDelayed };
  }

  it('lists only needs_delivery=true events whose next_delivery_at is due', () => {
    const { r, idPending } = setupWithEvents();
    const pending = r.listUndeliveredEvents(500, 0, 100);
    expect(pending.map((e) => e.event_id)).toEqual([idPending]);
  });

  it('includes events once their next_delivery_at is reached', () => {
    const { r, idPending, idDelayed } = setupWithEvents();
    const pending = r.listUndeliveredEvents(2_000, 0, 100);
    expect(pending.map((e) => e.event_id).sort((a, b) => a - b)).toEqual(
      [idPending, idDelayed].sort((a, b) => a - b),
    );
  });

  it('respects the limit', () => {
    const { r } = setupWithEvents();
    const pending = r.listUndeliveredEvents(10_000, 0, 1);
    expect(pending).toHaveLength(1);
  });

  it('markEventDelivered clears needs_delivery + sets delivered_at', () => {
    const { r, idPending } = setupWithEvents();
    expect(r.markEventDelivered(idPending, 9_999)).toBe(true);
    const still = r.listUndeliveredEvents(10_000, 0, 10);
    expect(still.map((e) => e.event_id)).not.toContain(idPending);
    // delivery_failed cleared too.
    const evt = r.listEventsForTask('a').find((e) => e.event_id === idPending);
    expect(evt?.delivery_failed).toBe(false);
    expect(evt?.delivered_at).toBe(9_999);
  });

  it('markEventDelivered returns false for missing events', () => {
    const { r } = setupWithEvents();
    expect(r.markEventDelivered(99_999, 0)).toBe(false);
  });

  it('markEventAcknowledged sets acknowledged_at but keeps other fields', () => {
    const { r, idPending } = setupWithEvents();
    expect(r.markEventAcknowledged(idPending, 555)).toBe(true);
    const evt = r.listEventsForTask('a').find((e) => e.event_id === idPending);
    expect(evt?.acknowledged_at).toBe(555);
    expect(evt?.needs_delivery).toBe(true);
  });

  it('markEventDeliveryFailed increments attempts + pushes next_delivery_at', () => {
    const { r, idPending } = setupWithEvents();
    expect(r.markEventDeliveryFailed(idPending, 2_000, 1_500)).toBe(true);
    const evt = r.listEventsForTask('a').find((e) => e.event_id === idPending);
    expect(evt?.delivery_failed).toBe(true);
    expect(evt?.delivery_attempts).toBe(1);
    expect(evt?.next_delivery_at).toBe(2_000);
  });

  it('markEventDeliveryFailed returns false for missing events', () => {
    const { r } = setupWithEvents();
    expect(r.markEventDeliveryFailed(99_999, 0, 0)).toBe(false);
  });
});
