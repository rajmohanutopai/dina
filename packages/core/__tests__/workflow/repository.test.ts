/**
 * CORE-P2-E17 → E24 — WorkflowStore core CRUD (in-memory + SQLite parity).
 *
 * Covers:
 *   - Create + ID / idempotency-key / correlation lookups
 *   - Non-terminal idempotency dedup (the `getActiveByIdempotencyKey` path)
 *   - Transition / setRunId / setInternalStash
 *   - appendEvent + listEventsForTask
 *   - listByKindAndState (sweeper surface)
 */

import { InMemoryDatabaseAdapter } from '../../src/storage/db_adapter';
import { applyMigrations } from '../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../src/storage/schemas';
import {
  InMemoryWorkflowRepository,
  SQLiteWorkflowRepository,
  WorkflowConflictError,
  rowToEvent,
  rowToTask,
} from '../../src/workflow/repository';
import {
  WorkflowTaskKind,
  WorkflowTaskPriority,
  WorkflowTaskState,
  type WorkflowTask,
  type WorkflowEvent,
} from '../../src/workflow/domain';

function baseTask(overrides: Partial<WorkflowTask> = {}): WorkflowTask {
  return {
    id: 'task-1',
    kind: WorkflowTaskKind.ServiceQuery,
    status: WorkflowTaskState.Created,
    priority: WorkflowTaskPriority.Normal,
    description: 'test',
    payload: '{}',
    result_summary: '',
    policy: '{}',
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    ...overrides,
  };
}

// NB: `SQLiteWorkflowRepository` isn't exercised end-to-end by these tests.
// The existing `InMemoryDatabaseAdapter` is a thin shell (tracks CREATE
// TABLE + INSERT but doesn't run SELECT), so real SQL behaviour is validated
// via the `InMemoryWorkflowRepository` which re-implements the same contract
// against a Map-based store. The SQLite wiring is construction-smoke-tested
// (see "SQLiteWorkflowRepository construction" at the bottom).

const buildRepo = (): InMemoryWorkflowRepository => new InMemoryWorkflowRepository();

describe('Migration v3 (workflow_tasks + workflow_events)', () => {
  it('creates the workflow_tasks and workflow_events tables', () => {
    const db = new InMemoryDatabaseAdapter();
    applyMigrations(db, IDENTITY_MIGRATIONS);
    expect(db.hasTable('workflow_tasks')).toBe(true);
    expect(db.hasTable('workflow_events')).toBe(true);
  });

  it('v3 migration is at index 2 (after v1 and v2)', () => {
    const v3 = IDENTITY_MIGRATIONS.find((m) => m.version === 3);
    expect(v3).toBeDefined();
    expect(v3?.name).toBe('workflow_tasks');
  });
});

describe('WorkflowRepository (in-memory) — create', () => {
  it('creates and returns the task by id', () => {
    const r = buildRepo();
    const t = baseTask();
    r.create(t);
    const got = r.getById('task-1');
    expect(got?.id).toBe('task-1');
    expect(got?.kind).toBe('service_query');
  });

  it('duplicate id throws WorkflowConflictError with code=duplicate_id', () => {
    const r = buildRepo();
    r.create(baseTask());
    const err = (() => {
      try {
        r.create(baseTask());
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(WorkflowConflictError);
    expect((err as WorkflowConflictError).code).toBe('duplicate_id');
  });

  it('duplicate idempotency_key on live tasks throws with code=duplicate_idempotency', () => {
    const r = buildRepo();
    r.create(baseTask({ id: 'a', idempotency_key: 'shared' }));
    const err = (() => {
      try {
        r.create(baseTask({ id: 'b', idempotency_key: 'shared' }));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(WorkflowConflictError);
    // The `code` distinguishes idempotency-conflict (which the HTTP handler
    // turns into `200 deduped`) from id-conflict (which stays 409). Without
    // this assertion, a regression that returned `duplicate_id` here would
    // silently break the dedupe path.
    expect((err as WorkflowConflictError).code).toBe('duplicate_idempotency');
  });

  it('duplicate idempotency_key allowed when prior task is terminal', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'a',
        idempotency_key: 'shared',
        status: WorkflowTaskState.Completed, // terminal
      }),
    );
    expect(() => r.create(baseTask({ id: 'b', idempotency_key: 'shared' }))).not.toThrow();
  });

  it('empty idempotency_key is treated as unset', () => {
    const r = buildRepo();
    r.create(baseTask({ id: 'a', idempotency_key: '' }));
    r.create(baseTask({ id: 'b', idempotency_key: '' })); // both unset — no conflict
    expect(r.size()).toBe(2);
  });

  it('getById returns a defensive copy (mutation does not corrupt storage)', () => {
    const r = buildRepo();
    r.create(baseTask());
    const copy = r.getById('task-1')!;
    copy.description = 'mutated';
    expect(r.getById('task-1')?.description).toBe('test');
  });
});

describe('WorkflowRepository — idempotency + correlation lookups', () => {
  it('getActiveByIdempotencyKey excludes terminal tasks', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'a',
        idempotency_key: 'k',
        status: WorkflowTaskState.Completed,
      }),
    );
    expect(r.getActiveByIdempotencyKey('k')).toBeNull();
  });

  it('getActiveByIdempotencyKey excludes ALL terminal states (failed, cancelled, recorded)', () => {
    // Guard against a partial `isTerminal` regression that only catches
    // Completed. Each terminal stem has a distinct audit-relevant meaning
    // — losing any one would let a replayed request collide with a dead
    // task and incorrectly return `deduped` from POST /v1/workflow/tasks.
    for (const terminal of [
      WorkflowTaskState.Failed,
      WorkflowTaskState.Cancelled,
      WorkflowTaskState.Recorded,
    ]) {
      const r = buildRepo();
      r.create(
        baseTask({
          id: 'a',
          idempotency_key: 'k',
          status: terminal,
        }),
      );
      expect(r.getActiveByIdempotencyKey('k')).toBeNull();
    }
  });

  it('getActiveByIdempotencyKey returns the live task', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'a',
        idempotency_key: 'k',
        status: WorkflowTaskState.Running,
      }),
    );
    const got = r.getActiveByIdempotencyKey('k');
    expect(got?.id).toBe('a');
  });

  it('getByIdempotencyKey returns terminal tasks', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'a',
        idempotency_key: 'k',
        status: WorkflowTaskState.Completed,
      }),
    );
    expect(r.getByIdempotencyKey('k')?.id).toBe('a');
  });

  it('getByCorrelationId sorts by created_at ascending', () => {
    const r = buildRepo();
    r.create(baseTask({ id: 'a', correlation_id: 'q-1', created_at: 200 }));
    r.create(baseTask({ id: 'b', correlation_id: 'q-1', created_at: 100 }));
    r.create(baseTask({ id: 'c', correlation_id: 'q-1', created_at: 300 }));
    r.create(baseTask({ id: 'd', correlation_id: 'other', created_at: 50 }));

    const tasks = r.getByCorrelationId('q-1');
    expect(tasks.map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('getByProposalId returns nil for empty string', () => {
    const r = buildRepo();
    expect(r.getByProposalId('')).toBeNull();
  });

  it('getByProposalId returns nil for missing proposal', () => {
    const r = buildRepo();
    expect(r.getByProposalId('missing')).toBeNull();
  });

  it('getByProposalId finds the matching task', () => {
    const r = buildRepo();
    r.create(baseTask({ id: 'a', proposal_id: 'p-1' }));
    expect(r.getByProposalId('p-1')?.id).toBe('a');
  });
});

describe('WorkflowRepository — state mutations', () => {
  it('transition succeeds when from matches current state', () => {
    const r = buildRepo();
    r.create(baseTask({ status: WorkflowTaskState.Created }));
    const ok = r.transition('task-1', 'created', 'running', 1_700_000_100);
    expect(ok).toBe(true);
    const t = r.getById('task-1');
    expect(t?.status).toBe('running');
    expect(t?.updated_at).toBe(1_700_000_100);
  });

  it('transition fails when from does not match current state', () => {
    const r = buildRepo();
    r.create(baseTask({ status: WorkflowTaskState.Created }));
    const ok = r.transition('task-1', 'running', 'completed', 1_700_000_100);
    expect(ok).toBe(false);
    expect(r.getById('task-1')?.status).toBe('created');
  });

  it('transition fails on missing task', () => {
    const r = buildRepo();
    expect(r.transition('ghost', 'created', 'running', 0)).toBe(false);
  });

  it('setRunId persists the marker', () => {
    const r = buildRepo();
    r.create(baseTask());
    expect(r.setRunId('task-1', 'run-abc', 1_700_000_100)).toBe(true);
    expect(r.getById('task-1')?.run_id).toBe('run-abc');
  });

  it('setRunId returns false for missing task', () => {
    const r = buildRepo();
    expect(r.setRunId('ghost', 'x', 0)).toBe(false);
  });

  it('setInternalStash with null clears the stash', () => {
    const r = buildRepo();
    r.create(baseTask());
    r.setInternalStash('task-1', '{"v":1}', 100);
    r.setInternalStash('task-1', null, 200);
    expect(r.getById('task-1')?.internal_stash).toBeUndefined();
  });
});

describe('WorkflowRepository — events', () => {
  it('appendEvent returns increasing event_ids', () => {
    const r = buildRepo();
    r.create(baseTask());
    const baseEvent: Omit<WorkflowEvent, 'event_id'> = {
      task_id: 'task-1',
      at: 1,
      event_kind: 'transition',
      needs_delivery: false,
      delivery_attempts: 0,
      delivery_failed: false,
      details: '{}',
    };
    const id1 = r.appendEvent(baseEvent);
    const id2 = r.appendEvent({ ...baseEvent, at: 2 });
    expect(id2).toBeGreaterThan(id1);
  });

  it('listEventsForTask filters by task and sorts by at', () => {
    const r = buildRepo();
    r.create(baseTask({ id: 'a' }));
    r.create(baseTask({ id: 'b', idempotency_key: 'k2' }));

    const base: Omit<WorkflowEvent, 'event_id'> = {
      task_id: 'a',
      at: 0,
      event_kind: 'transition',
      needs_delivery: false,
      delivery_attempts: 0,
      delivery_failed: false,
      details: '{}',
    };
    r.appendEvent({ ...base, task_id: 'a', at: 200 });
    r.appendEvent({ ...base, task_id: 'b', at: 150 });
    r.appendEvent({ ...base, task_id: 'a', at: 100 });

    const aEvents = r.listEventsForTask('a');
    expect(aEvents).toHaveLength(2);
    expect(aEvents.map((e) => e.at)).toEqual([100, 200]);

    const bEvents = r.listEventsForTask('b');
    expect(bEvents).toHaveLength(1);
  });
});

describe('WorkflowRepository — listByKindAndState (sweeper surface)', () => {
  it('returns tasks with matching kind + state, limited', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'a',
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.PendingApproval,
        created_at: 200,
      }),
    );
    r.create(
      baseTask({
        id: 'b',
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.PendingApproval,
        created_at: 100,
      }),
    );
    r.create(
      baseTask({
        id: 'c',
        kind: WorkflowTaskKind.Approval,
        status: WorkflowTaskState.Completed,
      }),
    );
    r.create(
      baseTask({
        id: 'd',
        kind: WorkflowTaskKind.Delegation,
        status: WorkflowTaskState.PendingApproval,
      }),
    );

    const list = r.listByKindAndState('approval', 'pending_approval', 10);
    expect(list.map((t) => t.id)).toEqual(['b', 'a']); // oldest first
  });

  it('respects the limit argument', () => {
    const r = buildRepo();
    for (let i = 0; i < 5; i++) {
      r.create(
        baseTask({
          id: `t-${i}`,
          kind: WorkflowTaskKind.Approval,
          status: WorkflowTaskState.PendingApproval,
          created_at: i,
        }),
      );
    }
    const list = r.listByKindAndState('approval', 'pending_approval', 3);
    expect(list).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Agent-pull claim / heartbeat / progress / lease-expiry — the dina-agent
// control surface used by external runners polling Core via MsgBox RPC.
// ---------------------------------------------------------------------------

describe('WorkflowRepository — claimDelegationTask (agent pull)', () => {
  function queuedDelegation(id: string, overrides: Partial<WorkflowTask> = {}): WorkflowTask {
    return baseTask({
      id,
      kind: 'delegation',
      status: 'queued',
      description: 'run capability',
      payload: JSON.stringify({
        type: 'service_query_execution',
        capability: 'eta_query',
        params: {},
      }),
      ...overrides,
    });
  }

  const AGENT_DID = 'did:plc:agent-1';
  const NOW_MS = 1_700_000_000_000;
  const LEASE_MS = 30_000;

  it('rejects zero or negative leaseMs', () => {
    const r = buildRepo();
    expect(() => r.claimDelegationTask(AGENT_DID, NOW_MS, 0)).toThrow(/leaseMs/);
    expect(() => r.claimDelegationTask(AGENT_DID, NOW_MS, -1)).toThrow(/leaseMs/);
  });

  it('returns null when no queued delegation exists', () => {
    const r = buildRepo();
    expect(r.claimDelegationTask(AGENT_DID, NOW_MS, LEASE_MS)).toBeNull();
  });

  it('claims the oldest queued delegation and transitions to running', () => {
    const r = buildRepo();
    r.create(queuedDelegation('d-old', { created_at: 1000 }));
    r.create(queuedDelegation('d-mid', { created_at: 2000 }));
    r.create(queuedDelegation('d-new', { created_at: 3000 }));

    const claimed = r.claimDelegationTask(AGENT_DID, NOW_MS, LEASE_MS);
    expect(claimed?.id).toBe('d-old');
    expect(claimed?.status).toBe('running');
    expect(claimed?.agent_did).toBe(AGENT_DID);
    expect(claimed?.lease_expires_at).toBe(NOW_MS + LEASE_MS);

    const stored = r.getById('d-old');
    expect(stored?.status).toBe('running');
    expect(stored?.agent_did).toBe(AGENT_DID);
  });

  it('skips non-delegation tasks', () => {
    const r = buildRepo();
    r.create(baseTask({ id: 'sq-1', kind: 'service_query', status: 'queued' }));
    r.create(baseTask({ id: 'appr-1', kind: 'approval', status: 'queued' }));
    expect(r.claimDelegationTask(AGENT_DID, NOW_MS, LEASE_MS)).toBeNull();
  });

  it('skips delegation tasks whose state is not queued', () => {
    const r = buildRepo();
    r.create(queuedDelegation('d-created', { status: 'created' }));
    r.create(queuedDelegation('d-running', { status: 'running' }));
    r.create(queuedDelegation('d-completed', { status: 'completed' }));
    expect(r.claimDelegationTask(AGENT_DID, NOW_MS, LEASE_MS)).toBeNull();
  });

  it('skips delegation tasks whose expires_at is past', () => {
    const r = buildRepo();
    const nowSec = Math.floor(NOW_MS / 1000);
    r.create(queuedDelegation('d-expired', { expires_at: nowSec - 1 }));
    r.create(queuedDelegation('d-live', { expires_at: nowSec + 60, created_at: 5000 }));
    const claimed = r.claimDelegationTask(AGENT_DID, NOW_MS, LEASE_MS);
    expect(claimed?.id).toBe('d-live');
  });

  it('concurrent claims: only one caller wins per task', () => {
    // Serial back-to-back claims with the same state: first wins, second
    // returns null. Emulates two agents polling the same instant.
    const r = buildRepo();
    r.create(queuedDelegation('d-1'));
    const first = r.claimDelegationTask('did:plc:agent-a', NOW_MS, LEASE_MS);
    const second = r.claimDelegationTask('did:plc:agent-b', NOW_MS, LEASE_MS);
    expect(first?.id).toBe('d-1');
    expect(second).toBeNull();
  });

  it('appends a `claimed` audit event (needs_delivery=false)', () => {
    const r = buildRepo();
    r.create(queuedDelegation('d-1'));
    r.claimDelegationTask(AGENT_DID, NOW_MS, LEASE_MS);
    const events = r.listEventsForTask('d-1');
    const claimed = events.find((e) => e.event_kind === 'claimed');
    expect(claimed).toBeDefined();
    expect(claimed?.needs_delivery).toBe(false);
    const details = JSON.parse(claimed!.details);
    expect(details.agent_did).toBe(AGENT_DID);
    expect(details.lease_expires_at).toBe(NOW_MS + LEASE_MS);
  });
});

describe('WorkflowRepository — heartbeatTask', () => {
  function running(id: string, agentDID: string): WorkflowTask {
    return baseTask({
      id,
      kind: 'delegation',
      status: 'running',
      agent_did: agentDID,
      lease_expires_at: 1_700_000_000_000 + 30_000,
    });
  }

  const AGENT = 'did:plc:agent';
  const NOW = 1_700_000_030_000;

  it('rejects zero / negative leaseMs', () => {
    const r = buildRepo();
    expect(() => r.heartbeatTask('x', AGENT, NOW, 0)).toThrow(/leaseMs/);
  });

  it('extends lease when the caller holds the claim', () => {
    const r = buildRepo();
    r.create(running('d-1', AGENT));
    const ok = r.heartbeatTask('d-1', AGENT, NOW, 60_000);
    expect(ok).toBe(true);
    expect(r.getById('d-1')?.lease_expires_at).toBe(NOW + 60_000);
  });

  it('rejects heartbeat from a different agent', () => {
    const r = buildRepo();
    r.create(running('d-1', AGENT));
    const ok = r.heartbeatTask('d-1', 'did:plc:other-agent', NOW, 60_000);
    expect(ok).toBe(false);
    expect(r.getById('d-1')?.agent_did).toBe(AGENT);
  });

  it('rejects heartbeat on non-running tasks', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'd-1',
        kind: 'delegation',
        status: 'queued',
      }),
    );
    expect(r.heartbeatTask('d-1', AGENT, NOW, 60_000)).toBe(false);
  });

  it('rejects heartbeat on missing tasks', () => {
    const r = buildRepo();
    expect(r.heartbeatTask('nope', AGENT, NOW, 60_000)).toBe(false);
  });
});

describe('WorkflowRepository — updateTaskProgress', () => {
  function running(id: string, agentDID: string): WorkflowTask {
    return baseTask({
      id,
      kind: 'delegation',
      status: 'running',
      agent_did: agentDID,
    });
  }

  it('updates progress_note when the caller holds the claim', () => {
    const r = buildRepo();
    r.create(running('d-1', 'a'));
    const ok = r.updateTaskProgress('d-1', 'a', 'step 2/5', 100);
    expect(ok).toBe(true);
    expect(r.getById('d-1')?.progress_note).toBe('step 2/5');
  });

  it('rejects progress update from a different agent', () => {
    const r = buildRepo();
    r.create(running('d-1', 'a'));
    expect(r.updateTaskProgress('d-1', 'b', 'nope', 100)).toBe(false);
    expect(r.getById('d-1')?.progress_note).toBeUndefined();
  });

  it('rejects progress on non-running tasks', () => {
    const r = buildRepo();
    r.create(baseTask({ id: 'd-1', status: 'completed' }));
    expect(r.updateTaskProgress('d-1', 'a', 'step', 100)).toBe(false);
  });
});

describe('WorkflowRepository — expireLeasedTasks', () => {
  it('reverts running tasks past lease to queued and clears agent_did/lease', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'd-1',
        kind: 'delegation',
        status: 'running',
        agent_did: 'did:plc:dead-agent',
        lease_expires_at: 100,
      }),
    );
    const reverted = r.expireLeasedTasks(200);
    expect(reverted).toHaveLength(1);
    expect(reverted[0].id).toBe('d-1');
    const stored = r.getById('d-1');
    expect(stored?.status).toBe('queued');
    expect(stored?.agent_did).toBeUndefined();
    expect(stored?.lease_expires_at).toBeUndefined();
  });

  it('leaves running tasks whose lease is still live alone', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'd-live',
        kind: 'delegation',
        status: 'running',
        agent_did: 'did:plc:agent',
        lease_expires_at: 1_000,
      }),
    );
    const reverted = r.expireLeasedTasks(500);
    expect(reverted).toHaveLength(0);
    expect(r.getById('d-live')?.status).toBe('running');
  });

  it('leaves tasks without a lease (legacy) alone', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'd-no-lease',
        kind: 'delegation',
        status: 'running',
        agent_did: 'a',
        // lease_expires_at omitted
      }),
    );
    const reverted = r.expireLeasedTasks(10_000);
    expect(reverted).toHaveLength(0);
  });

  it('appends a lease_expired audit event per reverted task', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'd-1',
        kind: 'delegation',
        status: 'running',
        agent_did: 'did:plc:dead',
        lease_expires_at: 100,
      }),
    );
    r.expireLeasedTasks(200);
    const events = r.listEventsForTask('d-1');
    const expired = events.find((e) => e.event_kind === 'lease_expired');
    expect(expired).toBeDefined();
    const details = JSON.parse(expired!.details);
    expect(details.previous_agent_did).toBe('did:plc:dead');
  });

  it('reclaim after lease-expiry: same task can be claimed by a fresh agent', () => {
    const r = buildRepo();
    r.create(
      baseTask({
        id: 'd-1',
        kind: 'delegation',
        status: 'running',
        agent_did: 'did:plc:dead',
        lease_expires_at: 100,
      }),
    );
    r.expireLeasedTasks(200);
    const fresh = r.claimDelegationTask('did:plc:fresh', 300, 30_000);
    expect(fresh?.id).toBe('d-1');
    expect(fresh?.agent_did).toBe('did:plc:fresh');
  });
});

describe('Row mappers', () => {
  it('rowToTask normalises null columns to undefined', () => {
    const t = rowToTask({
      id: 't-1',
      kind: 'service_query',
      state: 'created',
      correlation_id: null,
      parent_id: null,
      proposal_id: null,
      priority: 'normal',
      description: '',
      payload: '{}',
      result: null,
      result_summary: '',
      policy: '{}',
      error: null,
      requested_runner: null,
      assigned_runner: null,
      agent_did: null,
      run_id: null,
      progress_note: null,
      lease_expires_at: null,
      origin: null,
      session_name: null,
      idempotency_key: null,
      expires_at: null,
      next_run_at: null,
      recurrence: null,
      internal_stash: null,
      created_at: 100,
      updated_at: 100,
    });
    expect(t.correlation_id).toBeUndefined();
    expect(t.internal_stash).toBeUndefined();
    expect(t.idempotency_key).toBeUndefined();
    expect(t.status).toBe('created'); // `state` column → `status` field
  });

  it('rowToEvent converts integer flags to booleans', () => {
    const e = rowToEvent({
      event_id: 42,
      task_id: 't-1',
      at: 100,
      event_kind: 'transition',
      needs_delivery: 1,
      delivery_attempts: 3,
      next_delivery_at: 200,
      delivering_until: null,
      delivered_at: null,
      acknowledged_at: null,
      delivery_failed: 0,
      details: '{}',
    });
    expect(e.needs_delivery).toBe(true);
    expect(e.delivery_failed).toBe(false);
    expect(e.delivery_attempts).toBe(3);
    expect(e.next_delivery_at).toBe(200);
    expect(e.delivering_until).toBeUndefined();
  });
});

describe('SQLiteWorkflowRepository construction', () => {
  it('constructs against an adapter without throwing', () => {
    const db = new InMemoryDatabaseAdapter();
    expect(() => new SQLiteWorkflowRepository(db)).not.toThrow();
  });
});
