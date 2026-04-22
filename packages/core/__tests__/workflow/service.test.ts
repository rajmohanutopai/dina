/**
 * CORE-P2-F01-F06 — WorkflowService tests.
 */

import { InMemoryWorkflowRepository, WorkflowConflictError } from '../../src/workflow/repository';
import {
  WorkflowService,
  WorkflowTransitionError,
  WorkflowValidationError,
} from '../../src/workflow/service';
import {
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
} from '../../src/workflow/domain';

function setup(nowMs = 1_700_000_000_000) {
  const repo = new InMemoryWorkflowRepository();
  const service = new WorkflowService({
    repository: repo,
    nowMsFn: () => nowMs,
  });
  return { repo, service, nowMs };
}

describe('WorkflowService.create', () => {
  it('creates a task with defaults + emits a `created` event', () => {
    const { service, repo } = setup();
    const task = service.create({
      id: 't-1',
      kind: WorkflowTaskKind.ServiceQuery,
      description: 'test',
      payload: '{}',
    });

    expect(task.id).toBe('t-1');
    expect(task.status).toBe('created');
    expect(task.priority).toBe('normal');
    expect(task.origin).toBe('');
    expect(task.policy).toBe('{}');

    const events = repo.listEventsForTask('t-1');
    expect(events).toHaveLength(1);
    expect(events[0].event_kind).toBe('created');
    expect(events[0].needs_delivery).toBe(true);
    const details = JSON.parse(events[0].details);
    expect(details.kind).toBe('service_query');
  });

  it('accepts a non-default initial state', () => {
    const { service } = setup();
    const task = service.create({
      id: 't-2',
      kind: WorkflowTaskKind.Approval,
      description: 'approval',
      payload: '{}',
      initialState: WorkflowTaskState.PendingApproval,
    });
    expect(task.status).toBe('pending_approval');
  });

  it('rejects empty id', () => {
    const { service } = setup();
    expect(() =>
      service.create({ id: '', kind: 'service_query', description: '', payload: '{}' }),
    ).toThrow(/id/);
  });

  it('rejects empty payload', () => {
    const { service } = setup();
    expect(() =>
      service.create({
        id: 't',
        kind: 'service_query',
        description: '',
        payload: '',
      }),
    ).toThrow(/payload/);
  });

  it('rejects unknown kind', () => {
    const { service } = setup();
    expect(() =>
      service.create({
        id: 't',
        kind: 'banana',
        description: '',
        payload: '{}',
      }),
    ).toThrow(/kind/);
  });

  it('rejects unknown priority', () => {
    const { service } = setup();
    const err = (() => {
      try {
        service.create({
          id: 't',
          kind: WorkflowTaskKind.ServiceQuery,
          description: '',
          payload: '{}',
          priority: 'panic',
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(WorkflowValidationError);
    expect((err as WorkflowValidationError).field).toBe('priority');
  });

  it('rejects unknown origin', () => {
    const { service } = setup();
    expect(() =>
      service.create({
        id: 't',
        kind: WorkflowTaskKind.ServiceQuery,
        description: '',
        payload: '{}',
        origin: 'webhook',
      }),
    ).toThrow(/origin/);
  });

  it('rejects terminal initialState', () => {
    const { service } = setup();
    expect(() =>
      service.create({
        id: 't',
        kind: WorkflowTaskKind.ServiceQuery,
        description: '',
        payload: '{}',
        initialState: WorkflowTaskState.Completed,
      }),
    ).toThrow(/initialState/);
  });

  it('rejects negative / non-finite expiresAtSec', () => {
    const { service } = setup();
    expect(() =>
      service.create({
        id: 't',
        kind: WorkflowTaskKind.ServiceQuery,
        description: '',
        payload: '{}',
        expiresAtSec: -1,
      }),
    ).toThrow(/expiresAtSec/);
    expect(() =>
      service.create({
        id: 't',
        kind: WorkflowTaskKind.ServiceQuery,
        description: '',
        payload: '{}',
        expiresAtSec: Number.NaN,
      }),
    ).toThrow(/expiresAtSec/);
  });

  it('propagates WorkflowConflictError on duplicate id', () => {
    const { service } = setup();
    service.create({ id: 't', kind: 'service_query', description: '', payload: '{}' });
    expect(() =>
      service.create({ id: 't', kind: 'service_query', description: '', payload: '{}' }),
    ).toThrow(WorkflowConflictError);
  });
});

describe('WorkflowService.approve', () => {
  it('moves pending_approval → queued + emits approved event with payload', () => {
    const { service, repo } = setup();
    service.create({
      id: 'a',
      kind: WorkflowTaskKind.Approval,
      description: 'review',
      payload: '{"op":"x"}',
      initialState: WorkflowTaskState.PendingApproval,
    });
    const updated = service.approve('a');
    expect(updated.status).toBe('queued');

    const approvedEvent = repo.listEventsForTask('a').find((e) => e.event_kind === 'approved');
    expect(approvedEvent).toBeDefined();
    const details = JSON.parse(approvedEvent!.details);
    expect(details.task_payload).toBe('{"op":"x"}');
    expect(details.kind).toBe('approval');
  });

  it('throws WorkflowValidationError when task does not exist', () => {
    const { service } = setup();
    expect(() => service.approve('ghost')).toThrow(WorkflowValidationError);
  });

  it('throws WorkflowTransitionError when task is not in pending_approval', () => {
    const { service } = setup();
    service.create({
      id: 'a',
      kind: WorkflowTaskKind.Approval,
      description: '',
      payload: '{}',
      // leaves task in `created`, which cannot approve → queued directly.
      // Actually created → queued IS allowed by ValidTransitions. Use a
      // state whose transition to queued is not allowed to exercise the
      // guard: running → queued.
    });
    // Move to running to exercise a blocked approval.
    const repo = service.store() as InMemoryWorkflowRepository;
    repo.transition('a', 'created', 'running', Date.now());

    expect(() => service.approve('a')).toThrow(WorkflowTransitionError);
  });
});

describe('WorkflowService.complete / fail / cancel', () => {
  function seedRunning() {
    const ctx = setup();
    ctx.service.create({
      id: 't',
      kind: WorkflowTaskKind.ServiceQuery,
      description: '',
      payload: '{}',
    });
    (ctx.service.store() as InMemoryWorkflowRepository).transition(
      't',
      'created',
      'running',
      Date.now(),
    );
    return ctx;
  }

  it('complete transitions running → completed + records event', () => {
    const { service, repo } = seedRunning();
    const updated = service.complete('t', '{"ok":true}', 'done', 'did:plc:agent');
    expect(updated.status).toBe('completed');
    expect(updated.result).toBe('{"ok":true}');
    expect(updated.result_summary).toBe('done');
    expect(updated.agent_did).toBe('did:plc:agent');

    const event = repo.listEventsForTask('t').find((e) => e.event_kind === 'completed');
    expect(event).toBeDefined();
  });

  it('fail transitions running → failed + records error', () => {
    const { service, repo } = seedRunning();
    const updated = service.fail('t', 'upstream_timeout');
    expect(updated.status).toBe('failed');
    expect(updated.error).toBe('upstream_timeout');

    const event = repo.listEventsForTask('t').find((e) => e.event_kind === 'failed');
    expect(event).toBeDefined();
    expect(JSON.parse(event!.details).error).toBe('upstream_timeout');
  });

  it('cancel transitions active → cancelled + records reason', () => {
    const { service, repo } = seedRunning();
    const updated = service.cancel('t', 'user_abort');
    expect(updated.status).toBe('cancelled');

    const event = repo.listEventsForTask('t').find((e) => e.event_kind === 'cancelled');
    expect(JSON.parse(event!.details).reason).toBe('user_abort');
  });

  it('complete on missing task → WorkflowValidationError', () => {
    const { service } = setup();
    expect(() => service.complete('ghost', '{}', '', '')).toThrow(WorkflowValidationError);
  });

  it('complete on terminal task → WorkflowTransitionError', () => {
    const { service } = seedRunning();
    service.complete('t', '{}', 'first', '');
    expect(() => service.complete('t', '{}', 'second', '')).toThrow(WorkflowTransitionError);
  });

  it('fail on terminal task → WorkflowTransitionError', () => {
    const { service } = seedRunning();
    service.complete('t', '{}', 'done', '');
    expect(() => service.fail('t', 'late')).toThrow(WorkflowTransitionError);
  });

  it('cancel on terminal task → WorkflowTransitionError (CORE-P4-T04 terminal case)', () => {
    const { service } = seedRunning();
    service.complete('t', '{}', 'done', '');
    const err = (() => {
      try {
        service.cancel('t', 'late');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(WorkflowTransitionError);
    // Pin the from/to semantic — CORE-P4-T04 spec wanted a `code='terminal'`
    // marker; dina-mobile models this as a typed transition error with
    // `from: 'completed'` + `to: 'cancelled'`, which is strictly more
    // information than a generic code tag.
    expect((err as WorkflowTransitionError).from).toBe('completed');
    expect((err as WorkflowTransitionError).to).toBe('cancelled');
  });
});

describe('WorkflowService.deliverEventsForTask', () => {
  it('returns events ordered by time', () => {
    const { service, repo, nowMs } = setup();
    service.create({
      id: 't',
      kind: WorkflowTaskKind.ServiceQuery,
      description: '',
      payload: '{}',
    });
    // appendEvent directly with an `at` LATER than the injected now, so
    // sort order is [created-event(nowMs), custom-event(nowMs+200)].
    repo.appendEvent({
      task_id: 't',
      at: nowMs + 200,
      event_kind: 'custom',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: '{}',
    });
    const events = service.deliverEventsForTask('t');
    expect(events.map((e) => e.at)).toEqual([nowMs, nowMs + 200]);
    expect(events.map((e) => e.event_kind)).toEqual(['created', 'custom']);
  });

  it('filters by eventKind', () => {
    const { service, repo } = setup();
    service.create({
      id: 't',
      kind: WorkflowTaskKind.ServiceQuery,
      description: '',
      payload: '{}',
    });
    repo.appendEvent({
      task_id: 't',
      at: 200,
      event_kind: 'custom',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: '{}',
    });
    const custom = service.deliverEventsForTask('t', { eventKind: 'custom' });
    expect(custom).toHaveLength(1);
  });

  it('filters by needsDelivery=false', () => {
    const { service, repo } = setup();
    service.create({
      id: 't',
      kind: WorkflowTaskKind.ServiceQuery,
      description: '',
      payload: '{}',
    });
    repo.markEventDelivered(1, 999_999);
    const delivered = service.deliverEventsForTask('t', { needsDelivery: false });
    expect(delivered).toHaveLength(1);
  });
});

describe('WorkflowService defaults', () => {
  it('defaults priority to normal, origin to empty, policy to {}', () => {
    const { service } = setup();
    const t = service.create({
      id: 't',
      kind: WorkflowTaskKind.ServiceQuery,
      description: '',
      payload: '{}',
    });
    expect(t.priority).toBe('normal');
    expect(t.origin).toBe('');
    expect(t.policy).toBe('{}');
  });

  it('uses nowMsFn for created_at / updated_at', () => {
    const { service } = setup(1_700_000_123_456);
    const t = service.create({
      id: 't',
      kind: WorkflowTaskKind.ServiceQuery,
      description: '',
      payload: '{}',
    });
    expect(t.created_at).toBe(1_700_000_123_456);
    expect(t.updated_at).toBe(1_700_000_123_456);
  });
});

describe('WorkflowService construction', () => {
  it('throws on missing repository', () => {
    expect(
      () =>
        new WorkflowService({
          repository: undefined as unknown as InMemoryWorkflowRepository,
        }),
    ).toThrow(/repository/);
  });

  it('defaults nowMsFn to Date.now', () => {
    const repo = new InMemoryWorkflowRepository();
    const svc = new WorkflowService({ repository: repo });
    const t = svc.create({
      id: 't',
      kind: WorkflowTaskKind.ServiceQuery,
      description: '',
      payload: '{}',
    });
    expect(Math.abs(t.created_at - Date.now())).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// CORE-P3-I01 / I02 / T01 — Response Bridge
// ---------------------------------------------------------------------------

describe('WorkflowService — Response Bridge (CORE-P3-I01/I02/T01)', () => {
  function setupBridge() {
    const repo = new InMemoryWorkflowRepository();
    const calls: Array<Record<string, unknown>> = [];
    const service = new WorkflowService({
      repository: repo,
      nowMsFn: () => 1_700_000_000_000,
      responseBridgeSender: async (ctx) => {
        calls.push({ ...ctx });
      },
    });
    return { repo, service, calls };
  }

  const SERVICE_QUERY_PAYLOAD = JSON.stringify({
    type: 'service_query_execution',
    from_did: 'did:plc:requester',
    query_id: 'q-1',
    capability: 'eta_query',
    ttl_seconds: 60,
    service_name: 'Bus 42',
    params: { location: { lat: 37.77, lng: -122.41 } },
  });

  it('invokes the bridge on delegation completion with service_query_execution payload', () => {
    const { service, calls } = setupBridge();
    service.create({
      id: 'svc-exec-1',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      payload: SERVICE_QUERY_PAYLOAD,
    });
    service.complete('svc-exec-1', '{"eta_minutes":45}', 'responded');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      taskId: 'svc-exec-1',
      fromDID: 'did:plc:requester',
      queryId: 'q-1',
      capability: 'eta_query',
      ttlSeconds: 60,
      resultJSON: '{"eta_minutes":45}',
      serviceName: 'Bus 42',
    });
  });

  it('CORE-P4-T01: preserves non-default ttl_seconds through the bridge (not hardcoded 60)', () => {
    // Spec requirement: TTL flows from task payload unchanged into the
    // bridge context (and thence into provider-window + wire). A
    // regression that hardcoded 60 (or clamped to a min/max) would fail
    // this assertion. The 60-default only fires for MALFORMED payloads
    // (defensive), not for valid non-60 values.
    const { service, calls } = setupBridge();
    service.create({
      id: 'svc-exec-ttl',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      payload: JSON.stringify({
        type: 'service_query_execution',
        from_did: 'did:plc:requester',
        query_id: 'q-2',
        capability: 'eta_query',
        ttl_seconds: 120, // non-default
        service_name: 'Bus 42',
        params: {},
      }),
    });
    service.complete('svc-exec-ttl', '{"eta_minutes":3}', 'responded');
    expect(calls).toHaveLength(1);
    expect(calls[0].ttlSeconds).toBe(120);
  });

  it('skips non-delegation kinds', () => {
    const { service, calls } = setupBridge();
    service.create({
      id: 'sq-1',
      kind: WorkflowTaskKind.ServiceQuery,
      description: '',
      payload: SERVICE_QUERY_PAYLOAD,
    });
    service.complete('sq-1', '{}', 'done');
    expect(calls).toHaveLength(0);
  });

  it('skips delegation tasks whose payload.type is not service_query_execution', () => {
    const { service, calls } = setupBridge();
    service.create({
      id: 'gen-1',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      payload: JSON.stringify({ type: 'generic_job', ref: 42 }),
    });
    service.complete('gen-1', '{"ok":true}', 'done');
    expect(calls).toHaveLength(0);
  });

  it('skips silently when payload is malformed JSON', () => {
    const { service, calls } = setupBridge();
    service.create({
      id: 'bad-1',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      payload: '{not json',
    });
    service.complete('bad-1', '{}', 'done');
    expect(calls).toHaveLength(0);
  });

  it('skips when required payload fields are missing', () => {
    const { service, calls } = setupBridge();
    service.create({
      id: 'incomplete-1',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      payload: JSON.stringify({
        type: 'service_query_execution',
        // from_did omitted
        query_id: 'q-1',
        capability: 'eta_query',
      }),
    });
    service.complete('incomplete-1', '{}', 'done');
    expect(calls).toHaveLength(0);
  });

  it('defaults ttl_seconds to 60 when missing from payload', () => {
    const { service, calls } = setupBridge();
    service.create({
      id: 'no-ttl',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      payload: JSON.stringify({
        type: 'service_query_execution',
        from_did: 'did:plc:requester',
        query_id: 'q-1',
        capability: 'eta_query',
        // ttl_seconds omitted
      }),
    });
    service.complete('no-ttl', '{}', 'done');
    expect(calls[0].ttlSeconds).toBe(60);
  });

  it('isolates bridge-sender errors (completion still succeeds)', () => {
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({
      repository: repo,
      nowMsFn: () => 1_700_000_000_000,
      responseBridgeSender: () => {
        throw new Error('sender exploded');
      },
    });
    service.create({
      id: 'svc-exec-err',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      payload: SERVICE_QUERY_PAYLOAD,
    });
    expect(() => service.complete('svc-exec-err', '{}', 'done')).not.toThrow();
    const t = repo.getById('svc-exec-err');
    expect(t?.status).toBe('completed');
  });

  it('is a no-op when the bridge sender is not wired', () => {
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({
      repository: repo,
      nowMsFn: () => 1_700_000_000_000,
      // responseBridgeSender omitted
    });
    service.create({
      id: 'unwired',
      kind: WorkflowTaskKind.Delegation,
      description: '',
      payload: SERVICE_QUERY_PAYLOAD,
    });
    expect(() => service.complete('unwired', '{}', 'done')).not.toThrow();
    const t = repo.getById('unwired');
    expect(t?.status).toBe('completed');
  });
});
