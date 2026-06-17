/**
 * useServiceInbox — MOBILE-008 tests.
 */

// Mock the notifications inbox before importing the hook so the
// `markNotificationRead` re-export inside `useServiceInbox` points at
// our spy. The hook fires it from `approvePending` / `denyPending` to
// clear the tab-bar approval badge when the underlying workflow task
// gets resolved by this surface (the alternative — wait for an
// out-of-band event from the bridge — leaves the badge stuck at "1"
// while the list shows "All caught up"; that bug surfaced live in May
// 2026).
jest.mock('@dina/brain/notifications', () => ({
  markNotificationRead: jest.fn(),
}));
import { markNotificationRead } from '@dina/brain/notifications';

import {
  InboxNotConfiguredError,
  approvePending,
  denyPending,
  listPendingApprovals,
  listResolvedApprovals,
  resetInboxCoreClient,
  setInboxCoreClient,
  type InboxCoreClient,
} from '../../src/hooks/useServiceInbox';
import type { WorkflowTask } from '@dina/core';

function makeTask(overrides: Partial<WorkflowTask> & { id: string }): WorkflowTask {
  return {
    kind: 'approval',
    status: 'pending_approval',
    priority: 'normal',
    description: 'Bus ETA request',
    payload: JSON.stringify({
      capability: 'eta_query',
      service_name: 'Bus 42',
      from_did: 'did:plc:requester',
      params: { stop_id: 'S1', viewer: { lat: 37.77, lng: -122.41 } },
      ttl_seconds: 60,
    }),
    result_summary: '',
    policy: '{}',
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

function stubClient(init: {
  list?: WorkflowTask[];
  listError?: Error;
  approveError?: Error;
  cancelError?: Error;
  respondError?: Error;
}): {
  client: InboxCoreClient;
  calls: {
    list: number;
    approved: string[];
    cancelled: Array<{ id: string; reason: string }>;
    responded: Array<{ id: string; body: unknown }>;
  };
} {
  const calls = {
    list: 0,
    approved: [] as string[],
    cancelled: [] as Array<{ id: string; reason: string }>,
    responded: [] as Array<{ id: string; body: unknown }>,
  };
  const client: InboxCoreClient = {
    async listWorkflowTasks() {
      calls.list++;
      if (init.listError) throw init.listError;
      return init.list ?? [];
    },
    async approveWorkflowTask(id: string) {
      calls.approved.push(id);
      if (init.approveError) throw init.approveError;
      return makeTask({ id, status: 'queued' });
    },
    async cancelWorkflowTask(id: string, reason: string) {
      calls.cancelled.push({ id, reason });
      if (init.cancelError) throw init.cancelError;
      return makeTask({ id, status: 'cancelled' });
    },
    async sendServiceRespond(id: string, body) {
      calls.responded.push({ id, body });
      if (init.respondError) throw init.respondError;
      return { status: 'sent', taskId: id, alreadyProcessed: false };
    },
    async getWorkflowTask(id: string) {
      // Review #1: denyPending reads the task back after a successful
      // respond to surface its terminal status to the UI.
      return makeTask({ id, status: 'completed' });
    },
  };
  return { client, calls };
}

/**
 * State-aware stub for the resolved-approvals fan-out. Unlike `stubClient`
 * (which returns the same list for every query), this returns a different
 * task set per requested `state`, so `listResolvedApprovals`' one-query-
 * per-terminal-state fan-out can be exercised faithfully. `errorStates`
 * makes the named state's query reject, to test the per-state `.catch()`.
 */
function stubResolvedClient(
  byState: Record<string, WorkflowTask[]>,
  opts: { errorStates?: string[] } = {},
): {
  client: InboxCoreClient;
  calls: { filters: Array<{ kind: string; state: string; limit?: number }> };
} {
  const calls = { filters: [] as Array<{ kind: string; state: string; limit?: number }> };
  const client = {
    async listWorkflowTasks(filter: { kind: string; state: string; limit?: number }) {
      calls.filters.push(filter);
      if (opts.errorStates?.includes(filter.state)) {
        throw new Error(`boom: ${filter.state}`);
      }
      return byState[filter.state] ?? [];
    },
    async approveWorkflowTask(id: string) {
      return makeTask({ id, status: 'queued' });
    },
    async cancelWorkflowTask(id: string) {
      return makeTask({ id, status: 'cancelled' });
    },
    async sendServiceRespond(id: string) {
      return { status: 'sent', taskId: id, alreadyProcessed: false };
    },
    async getWorkflowTask(id: string) {
      return makeTask({ id, status: 'completed' });
    },
  } as unknown as InboxCoreClient;
  return { client, calls };
}

describe('useServiceInbox', () => {
  beforeEach(() => {
    resetInboxCoreClient();
    (markNotificationRead as jest.Mock).mockClear();
  });

  it('throws InboxNotConfiguredError before setInboxCoreClient is called', async () => {
    await expect(listPendingApprovals()).rejects.toBeInstanceOf(InboxNotConfiguredError);
    await expect(listResolvedApprovals()).rejects.toBeInstanceOf(InboxNotConfiguredError);
    await expect(approvePending('t1')).rejects.toBeInstanceOf(InboxNotConfiguredError);
    await expect(denyPending('t1')).rejects.toBeInstanceOf(InboxNotConfiguredError);
  });

  it('listPendingApprovals returns entries sorted oldest-first', async () => {
    const { client } = stubClient({
      list: [
        makeTask({ id: 't-new', created_at: 2_000 }),
        makeTask({ id: 't-old', created_at: 1_000 }),
      ],
    });
    setInboxCoreClient(client);
    const entries = await listPendingApprovals();
    expect(entries.map((e) => e.id)).toEqual(['t-old', 't-new']);
    expect(entries[0].capability).toBe('eta_query');
    expect(entries[0].serviceName).toBe('Bus 42');
    expect(entries[0].requesterDID).toBe('did:plc:requester');
    expect(entries[0].paramsPreview).toContain('stop_id');
  });

  it('listPendingApprovals passes kind=approval state=pending_approval', async () => {
    const listSpy = jest.fn().mockResolvedValue([]);
    setInboxCoreClient({
      listWorkflowTasks: listSpy,
      approveWorkflowTask: jest.fn(),
      cancelWorkflowTask: jest.fn(),
      sendServiceRespond: jest.fn(),
    } as unknown as InboxCoreClient);
    await listPendingApprovals(7);
    expect(listSpy).toHaveBeenCalledWith({
      kind: 'approval',
      state: 'pending_approval',
      limit: 7,
    });
  });

  it('truncates long params previews with ellipsis', async () => {
    const bigParams = { note: 'x'.repeat(500) };
    const { client } = stubClient({
      list: [
        makeTask({
          id: 'big',
          payload: JSON.stringify({
            capability: 'eta_query',
            service_name: 'Long',
            params: bigParams,
            ttl_seconds: 60,
            from_did: 'did:plc:x',
          }),
        }),
      ],
    });
    setInboxCoreClient(client);
    const [entry] = await listPendingApprovals();
    expect(entry.paramsPreview.endsWith('…')).toBe(true);
    expect(entry.paramsPreview.length).toBeLessThan(500);
  });

  it('tolerates malformed payload by exposing empty fields', async () => {
    const { client } = stubClient({
      list: [makeTask({ id: 'bad', payload: '{not json' })],
    });
    setInboxCoreClient(client);
    const [entry] = await listPendingApprovals();
    expect(entry.id).toBe('bad');
    expect(entry.capability).toBe('');
    expect(entry.serviceName).toBe('');
    expect(entry.paramsPreview).toBe('');
    // Malformed payloads can't be classified — surface as 'unknown'
    // so the UI's render branch picks the lowest-info template.
    expect(entry.kind).toBe('unknown');
  });

  it('classifies bus-driver service_query payloads with kind=service_query', async () => {
    const { client } = stubClient({ list: [makeTask({ id: 'svc-1' })] });
    setInboxCoreClient(client);
    const [entry] = await listPendingApprovals();
    // Default makeTask payload uses the service_query shape (no
    // explicit `type`, but `capability` is set).
    expect(entry.kind).toBe('service_query');
  });

  it('classifies intent_validation approvals with kind=intent_validation', async () => {
    // POST /v1/intent/validate raises an approval task with this
    // payload shape: type='intent_validation', action, target,
    // risk_level, agent_did. The UI renders action/target instead of
    // capability/params; the deny flow skips sendServiceRespond.
    const { client } = stubClient({
      list: [
        makeTask({
          id: 'prop-intent-1',
          payload: JSON.stringify({
            type: 'intent_validation',
            action: 'send_email',
            target: 'draft resignation letter to HR',
            risk_level: 'MODERATE',
            agent_did: 'did:plc:openclaw',
            session_id: 'ses_abc',
            reason: 'Action requires user approval',
          }),
        }),
      ],
    });
    setInboxCoreClient(client);
    const [entry] = await listPendingApprovals();
    expect(entry.kind).toBe('intent_validation');
    expect(entry.capability).toBe('send_email');
    expect(entry.paramsPreview).toBe('draft resignation letter to HR');
    expect(entry.requesterDID).toBe('did:plc:openclaw');
    expect(entry.riskLevel).toBe('MODERATE');
    expect(entry.serviceName).toBe('');
  });

  it('classifies staging persona approvals with kind=staging_persona_access', async () => {
    const { client } = stubClient({
      list: [
        makeTask({
          id: 'approval-staging-stg-1-health',
          description: 'Remember access for health',
          payload: JSON.stringify({
            type: 'staging_persona_access',
            approval_id: 'approval-staging-stg-1-health',
            staging_id: 'stg-1',
            persona: 'health',
            source: 'chat',
            source_id: 'msg-1',
            producer_id: '',
            preview: 'Allergist is Dr Rao',
          }),
        }),
      ],
    });
    setInboxCoreClient(client);
    const [entry] = await listPendingApprovals();
    expect(entry.kind).toBe('staging_persona_access');
    expect(entry.capability).toBe('health');
    expect(entry.serviceName).toBe('Memory access');
    expect(entry.requesterDID).toBe('chat');
    expect(entry.paramsPreview).toBe('Allergist is Dr Rao');
  });

  it('classifies agent persona-access approvals as vault_read approvals', async () => {
    const { client } = stubClient({
      list: [
        makeTask({
          id: 'agent-access-health-1',
          description: 'Agent did:key:z6MkAgentOpenClaw requests read access to "health"',
          payload: JSON.stringify({
            type: 'agent_persona_access',
            agent_did: 'did:key:z6MkAgentOpenClaw',
            persona: 'health',
            mode: 'read',
            scope: 'private health question',
          }),
        }),
      ],
    });
    setInboxCoreClient(client);
    const [entry] = await listPendingApprovals();
    expect(entry.kind).toBe('vault_read');
    expect(entry.capability).toBe('health');
    expect(entry.serviceName).toBe('Vault access');
    expect(entry.description).toBe('private health question');
    expect(entry.requesterDID).toBe('did:key:z6MkAgentOpenClaw');
    expect(entry.paramsPreview).toBe('private health question');
  });

  it('denyPending(intent_validation) cancels the task without service.respond', async () => {
    // Agents poll /v1/intent/:id/status, not a D2D inbox — there is
    // no requester to notify, so we skip sendServiceRespond entirely
    // and just cancel.
    const { client, calls } = stubClient({});
    setInboxCoreClient(client);
    await denyPending('prop-intent-1', 'denied_by_operator', 'intent_validation');
    expect(calls.responded).toEqual([]);
    expect(calls.cancelled).toEqual([{ id: 'prop-intent-1', reason: 'denied_by_operator' }]);
    // Badge-clear contract: resolving this task on the Approvals tab
    // must clear the matching notification entry so the tab-bar badge
    // doesn't stay stuck at "1" with the list showing "All caught up".
    // The notification is keyed on the task id by the workflow inbox
    // bridge — same id, same key.
    expect(markNotificationRead).toHaveBeenCalledWith('prop-intent-1');
  });

  it('denyPending(staging_persona_access) cancels without service.respond', async () => {
    const { client, calls } = stubClient({});
    setInboxCoreClient(client);
    await denyPending(
      'approval-staging-stg-1-health',
      'denied_by_operator',
      'staging_persona_access',
    );
    expect(calls.responded).toEqual([]);
    expect(calls.cancelled).toEqual([
      { id: 'approval-staging-stg-1-health', reason: 'denied_by_operator' },
    ]);
    expect(markNotificationRead).toHaveBeenCalledWith('approval-staging-stg-1-health');
  });

  it('denyPending(vault_read) cancels without service.respond + clears badge', async () => {
    // vault_read is the §13.4 agent-touches-sensitive-vault gate. Same
    // shape as intent_validation: no D2D requester, just cancel the
    // workflow task — the agent's `ask-status` poll observes the
    // terminal status on its next tick.
    const { client, calls } = stubClient({});
    setInboxCoreClient(client);
    await denyPending('vr-health-1', 'denied_by_operator', 'vault_read');
    expect(calls.responded).toEqual([]);
    expect(calls.cancelled).toEqual([{ id: 'vr-health-1', reason: 'denied_by_operator' }]);
    expect(markNotificationRead).toHaveBeenCalledWith('vr-health-1');
  });

  it('approvePending forwards to coreClient.approveWorkflowTask + clears badge', async () => {
    const { client, calls } = stubClient({});
    setInboxCoreClient(client);
    const t = await approvePending('svc-q-1');
    expect(calls.approved).toEqual(['svc-q-1']);
    expect(t.status).toBe('queued');
    expect(markNotificationRead).toHaveBeenCalledWith('svc-q-1');
  });

  it('denyPending sends unavailable and does NOT double-cancel (review #1)', async () => {
    const { client, calls } = stubClient({});
    setInboxCoreClient(client);
    await denyPending('svc-q-1');
    await denyPending('svc-q-2', 'not_allowed');
    // sendServiceRespond fires for each deny with the matching reason
    // — requester gets a real unavailable envelope instead of a TTL
    // timeout.
    expect(calls.responded).toEqual([
      { id: 'svc-q-1', body: { status: 'unavailable', error: 'denied_by_operator' } },
      { id: 'svc-q-2', body: { status: 'unavailable', error: 'not_allowed' } },
    ]);
    // Review #1: /v1/service/respond ALREADY terminates the approval
    // task. cancelWorkflowTask is only the fallback when respond
    // failed — calling it unconditionally was the double-terminate
    // bug. Happy path has zero cancel calls.
    expect(calls.cancelled).toEqual([]);
    // Both denies clear their notification entries — order doesn't
    // matter, presence does.
    expect(markNotificationRead).toHaveBeenCalledWith('svc-q-1');
    expect(markNotificationRead).toHaveBeenCalledWith('svc-q-2');
  });

  it('denyPending still cancels when the unavailable send throws', async () => {
    // Mirrors the chat /service_deny handler's contract: the send is
    // best-effort, cancel is authoritative.
    const { client, calls } = stubClient({
      respondError: new Error('ECONNRESET'),
    });
    setInboxCoreClient(client);
    await denyPending('svc-q-stuck');
    expect(calls.responded).toHaveLength(1);
    expect(calls.cancelled).toEqual([{ id: 'svc-q-stuck', reason: 'denied_by_operator' }]);
    // Even on the fallback-cancel path, the badge still clears — the
    // resolution happened, the operator's intent was met.
    expect(markNotificationRead).toHaveBeenCalledWith('svc-q-stuck');
  });

  it('propagates underlying client errors verbatim', async () => {
    const { client } = stubClient({ listError: new Error('401 unauthorized') });
    setInboxCoreClient(client);
    await expect(listPendingApprovals()).rejects.toThrow('401 unauthorized');
  });

  describe('listResolvedApprovals (Completed tab)', () => {
    it('fans out across every terminal state and never queries pending', async () => {
      const { client, calls } = stubResolvedClient({
        completed: [makeTask({ id: 'c1', status: 'completed' })],
        queued: [makeTask({ id: 'q1', status: 'queued' })],
        running: [makeTask({ id: 'r1', status: 'running' })],
        recorded: [makeTask({ id: 'rec1', status: 'recorded' })],
        cancelled: [makeTask({ id: 'x1', status: 'cancelled' })],
        failed: [makeTask({ id: 'f1', status: 'failed' })],
      });
      setInboxCoreClient(client);
      const entries = await listResolvedApprovals();
      const states = calls.filters.map((f) => f.state).sort();
      expect(states).toEqual(['cancelled', 'completed', 'failed', 'queued', 'recorded', 'running']);
      // The Completed tab is the inverse of the Pending tab — it must
      // never re-query the pending bucket.
      expect(states).not.toContain('pending_approval');
      // Every fan-out query carries kind=approval.
      expect(calls.filters.every((f) => f.kind === 'approval')).toBe(true);
      expect(entries.map((e) => e.id).sort()).toEqual(['c1', 'f1', 'q1', 'r1', 'rec1', 'x1']);
    });

    it('maps each terminal state to its display outcome', async () => {
      const { client } = stubResolvedClient({
        completed: [makeTask({ id: 'c', status: 'completed' })],
        queued: [makeTask({ id: 'q', status: 'queued' })],
        running: [makeTask({ id: 'r', status: 'running' })],
        recorded: [makeTask({ id: 'rec', status: 'recorded' })],
        cancelled: [makeTask({ id: 'denied', status: 'cancelled' })],
        failed: [makeTask({ id: 'errored', status: 'failed' })],
      });
      setInboxCoreClient(client);
      const entries = await listResolvedApprovals();
      const outcome = Object.fromEntries(entries.map((e) => [e.id, e.outcome]));
      // Approved bucket — the agent's action went through (queued/running
      // both mean "owner said yes, work is in flight").
      expect(outcome.c).toBe('approved');
      expect(outcome.q).toBe('approved');
      expect(outcome.r).toBe('approved');
      expect(outcome.rec).toBe('approved');
      // Operator deny resolves the task as cancelled.
      expect(outcome.denied).toBe('denied');
      // A plain run failure (no error='expired') is also "denied" from the
      // user's perspective — no data came back.
      expect(outcome.errored).toBe('denied');
    });

    it("treats a TTL-lapsed task (failed + error='expired') as expired, not denied", async () => {
      // The expiry sweeper closes a lapsed approval as state='failed' with
      // error='expired' (repository.expireTasks). That error string is the
      // ONLY way to tell a timeout apart from a real failure or an operator
      // deny, so it must win over the state-based mapping.
      const { client } = stubResolvedClient({
        failed: [
          makeTask({ id: 'lapsed', status: 'failed', error: 'expired' }),
          makeTask({ id: 'crashed', status: 'failed', error: 'llm error' }),
        ],
      });
      setInboxCoreClient(client);
      const entries = await listResolvedApprovals();
      const outcome = Object.fromEntries(entries.map((e) => [e.id, e.outcome]));
      expect(outcome.lapsed).toBe('expired');
      expect(outcome.crashed).toBe('denied');
    });

    it('orders resolved entries newest-first by resolvedAt (updated_at)', async () => {
      const { client } = stubResolvedClient({
        completed: [
          makeTask({ id: 'old', status: 'completed', updated_at: 1_000 }),
          makeTask({ id: 'newest', status: 'completed', updated_at: 3_000 }),
        ],
        cancelled: [makeTask({ id: 'mid', status: 'cancelled', updated_at: 2_000 })],
      });
      setInboxCoreClient(client);
      const entries = await listResolvedApprovals();
      expect(entries.map((e) => e.id)).toEqual(['newest', 'mid', 'old']);
      expect(entries.map((e) => e.resolvedAt)).toEqual([3_000, 2_000, 1_000]);
    });

    it('caps the MERGED total at `limit`, keeping the newest', async () => {
      const { client, calls } = stubResolvedClient({
        completed: [
          makeTask({ id: 'a', status: 'completed', updated_at: 5_000 }),
          makeTask({ id: 'b', status: 'completed', updated_at: 1_000 }),
        ],
        cancelled: [makeTask({ id: 'c', status: 'cancelled', updated_at: 9_000 })],
      });
      setInboxCoreClient(client);
      const entries = await listResolvedApprovals(2);
      // 3 resolved tasks across states, capped to the 2 newest post-merge.
      expect(entries.map((e) => e.id)).toEqual(['c', 'a']);
      // The cap is applied AFTER merging — each per-state query still
      // carries the caller's limit.
      expect(calls.filters.every((f) => f.limit === 2)).toBe(true);
    });

    it('survives a per-state query failure — other states still surface', async () => {
      // Each per-state query is independently .catch()ed, so a single 500
      // on one bucket can't blank the whole Completed history.
      const { client } = stubResolvedClient(
        {
          completed: [makeTask({ id: 'ok', status: 'completed' })],
          failed: [makeTask({ id: 'never', status: 'failed' })],
        },
        { errorStates: ['failed'] },
      );
      setInboxCoreClient(client);
      const entries = await listResolvedApprovals();
      expect(entries.map((e) => e.id)).toEqual(['ok']);
    });
  });
});
