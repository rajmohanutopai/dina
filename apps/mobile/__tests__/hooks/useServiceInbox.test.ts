/**
 * useServiceInbox — MOBILE-008 tests.
 */

import {
  InboxNotConfiguredError,
  approvePending,
  denyPending,
  listPendingApprovals,
  resetInboxCoreClient,
  setInboxCoreClient,
  type InboxCoreClient,
} from '../../src/hooks/useServiceInbox';
import type { WorkflowTask } from '../../../brain/src/core_client/http';

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

describe('useServiceInbox', () => {
  beforeEach(() => resetInboxCoreClient());

  it('throws InboxNotConfiguredError before setInboxCoreClient is called', async () => {
    await expect(listPendingApprovals()).rejects.toBeInstanceOf(InboxNotConfiguredError);
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
  });

  it('approvePending forwards to coreClient.approveWorkflowTask', async () => {
    const { client, calls } = stubClient({});
    setInboxCoreClient(client);
    const t = await approvePending('svc-q-1');
    expect(calls.approved).toEqual(['svc-q-1']);
    expect(t.status).toBe('queued');
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
  });

  it('propagates underlying client errors verbatim', async () => {
    const { client } = stubClient({ listError: new Error('401 unauthorized') });
    setInboxCoreClient(client);
    await expect(listPendingApprovals()).rejects.toThrow('401 unauthorized');
  });
});
