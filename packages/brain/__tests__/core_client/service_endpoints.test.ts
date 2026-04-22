/**
 * BRAIN-P2-AA — service-endpoint tests for `BrainCoreClient`.
 */

import { BrainCoreClient, WorkflowConflictError } from '../../src/core_client/http';
import type { WorkflowTask } from '../../../core/src/workflow/domain';
import { TEST_ED25519_SEED } from '@dina/test-harness';

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

function mockFetch(responses: Array<{ status: number; body?: unknown } | Error>): {
  fetch: jest.Mock;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  let i = 0;
  const fetch = jest.fn(async (input: string, init: RequestInit) => {
    const url = input;
    const method = init?.method ?? 'GET';
    const bodyRaw = typeof init?.body === 'string' ? init.body : '';
    const body = bodyRaw ? JSON.parse(bodyRaw) : undefined;
    calls.push({ url, method, body });
    const entry = responses[i] ?? responses[responses.length - 1];
    i = Math.min(i + 1, responses.length - 1);
    if (entry instanceof Error) throw entry;
    return {
      status: entry.status,
      text: async () => (entry.body === undefined ? '' : JSON.stringify(entry.body)),
    } as Response;
  });
  return { fetch, calls };
}

const baseConfig = {
  coreURL: 'http://localhost:8100',
  privateKey: TEST_ED25519_SEED,
  did: 'did:key:z6MkBrainService',
};

function makeClient(responses: Array<{ status: number; body?: unknown } | Error>) {
  const { fetch, calls } = mockFetch(responses);
  return {
    client: new BrainCoreClient({ ...baseConfig, fetch, maxRetries: 0 }),
    calls,
  };
}

const SAMPLE_TASK: WorkflowTask = {
  id: 'task-1',
  kind: 'service_query',
  status: 'created',
  priority: 'normal',
  description: '',
  payload: '{}',
  result_summary: '',
  policy: '{}',
  created_at: 1,
  updated_at: 1,
};

describe('BrainCoreClient service endpoints', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  describe('sendServiceQuery', () => {
    it('POSTs /v1/service/query with the canonical body shape', async () => {
      const { client, calls } = makeClient([
        { status: 200, body: { task_id: 'sq-1', query_id: 'q-1' } },
      ]);
      const res = await client.sendServiceQuery({
        toDID: 'did:plc:bus',
        capability: 'eta_query',
        params: { lat: 1, lng: 2 },
        queryId: 'q-1',
        ttlSeconds: 60,
        serviceName: 'Bus 42',
        schemaHash: 'abc',
      });
      expect(res.taskId).toBe('sq-1');
      expect(res.queryId).toBe('q-1');
      expect(res.deduped).toBe(false);

      expect(calls[0].url).toContain('/v1/service/query');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].body).toEqual({
        to_did: 'did:plc:bus',
        capability: 'eta_query',
        params: { lat: 1, lng: 2 },
        query_id: 'q-1',
        ttl_seconds: 60,
        service_name: 'Bus 42',
        schema_hash: 'abc',
      });
    });

    it('surfaces deduped flag on 200 + deduped:true', async () => {
      const { client } = makeClient([
        { status: 200, body: { task_id: 'sq-1', query_id: 'q-1', deduped: true } },
      ]);
      const res = await client.sendServiceQuery({
        toDID: 'did:plc:bus',
        capability: 'eta_query',
        params: {},
        queryId: 'q-1',
        ttlSeconds: 60,
      });
      expect(res.deduped).toBe(true);
    });

    it('throws on non-200', async () => {
      const { client } = makeClient([{ status: 400, body: { error: 'bad ttl' } }]);
      await expect(
        client.sendServiceQuery({
          toDID: 'did:plc:x',
          capability: 'c',
          params: {},
          queryId: 'q',
          ttlSeconds: 60,
        }),
      ).rejects.toThrow(/HTTP 400.*bad ttl/);
    });
  });

  describe('sendServiceRespond', () => {
    it('POSTs /v1/service/respond with task_id and response_body', async () => {
      const { client, calls } = makeClient([
        { status: 200, body: { status: 'sent', task_id: 't-1' } },
      ]);
      const res = await client.sendServiceRespond('t-1', {
        status: 'success',
        result: { eta: 45 },
      });
      expect(res.status).toBe('sent');
      expect(res.alreadyProcessed).toBe(false);
      expect(calls[0].body).toEqual({
        task_id: 't-1',
        response_body: { status: 'success', result: { eta: 45 } },
      });
    });

    it('reports alreadyProcessed on 200 + already_processed:true', async () => {
      const { client } = makeClient([
        { status: 200, body: { already_processed: true, status: 'completed' } },
      ]);
      const res = await client.sendServiceRespond('t-1', { status: 'success' });
      expect(res.alreadyProcessed).toBe(true);
      expect(res.status).toBe('completed');
    });
  });

  describe('createWorkflowTask', () => {
    it('POSTs /v1/workflow/tasks and returns the task + deduped=false', async () => {
      const { client, calls } = makeClient([{ status: 201, body: { task: SAMPLE_TASK } }]);
      const res = await client.createWorkflowTask({
        id: 'task-1',
        kind: 'service_query',
        description: 'hi',
        payload: '{}',
        idempotencyKey: 'k-1',
        expiresAtSec: 9_999,
      });
      expect(res.task.id).toBe('task-1');
      expect(res.deduped).toBe(false);
      expect(calls[0].body).toEqual({
        id: 'task-1',
        kind: 'service_query',
        description: 'hi',
        payload: '{}',
        expires_at: 9_999,
        idempotency_key: 'k-1',
      });
    });

    it('reports deduped=true on 200 + deduped:true retry', async () => {
      const { client } = makeClient([{ status: 200, body: { task: SAMPLE_TASK, deduped: true } }]);
      const res = await client.createWorkflowTask({
        id: 'x',
        kind: 'service_query',
        description: '',
        payload: '{}',
      });
      expect(res.deduped).toBe(true);
    });

    it('throws WorkflowConflictError on 409', async () => {
      const { client } = makeClient([
        { status: 409, body: { error: 'dup', code: 'duplicate_idempotency' } },
      ]);
      const err = await client
        .createWorkflowTask({
          id: 'x',
          kind: 'service_query',
          description: '',
          payload: '{}',
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(WorkflowConflictError);
      expect((err as WorkflowConflictError).code).toBe('duplicate_idempotency');
    });
  });

  describe('approve / cancel / complete / fail', () => {
    it('approveWorkflowTask posts the correct URL', async () => {
      const { client, calls } = makeClient([{ status: 200, body: { task: SAMPLE_TASK } }]);
      await client.approveWorkflowTask('task-1');
      expect(calls[0].url).toContain('/v1/workflow/tasks/task-1/approve');
    });

    it('cancelWorkflowTask passes {reason} when provided', async () => {
      const { client, calls } = makeClient([{ status: 200, body: { task: SAMPLE_TASK } }]);
      await client.cancelWorkflowTask('t-1', 'user_abort');
      expect(calls[0].url).toContain('/v1/workflow/tasks/t-1/cancel');
      expect(calls[0].body).toEqual({ reason: 'user_abort' });
    });

    it('cancelWorkflowTask without reason posts empty body', async () => {
      const { client, calls } = makeClient([{ status: 200, body: { task: SAMPLE_TASK } }]);
      await client.cancelWorkflowTask('t-1');
      expect(calls[0].body).toEqual({});
    });

    it('completeWorkflowTask requires result + summary', async () => {
      const { client, calls } = makeClient([{ status: 200, body: { task: SAMPLE_TASK } }]);
      await client.completeWorkflowTask('t-1', '{"ok":true}', 'done', 'did:plc:a');
      expect(calls[0].body).toEqual({
        result: '{"ok":true}',
        result_summary: 'done',
        agent_did: 'did:plc:a',
      });
    });

    it('failWorkflowTask sends the error message', async () => {
      const { client, calls } = makeClient([{ status: 200, body: { task: SAMPLE_TASK } }]);
      await client.failWorkflowTask('t-1', 'boom');
      expect(calls[0].body).toEqual({ error: 'boom' });
    });

    it('workflow actions throw with status detail on failure', async () => {
      const { client } = makeClient([
        { status: 409, body: { error: 'wrong state', from: 'running', to: 'queued' } },
      ]);
      await expect(client.approveWorkflowTask('t')).rejects.toThrow(/HTTP 409.*wrong state/);
    });

    it('throws when server omits the task field', async () => {
      const { client } = makeClient([{ status: 200, body: {} }]);
      await expect(client.approveWorkflowTask('t')).rejects.toThrow(/missing task/);
    });
  });

  describe('listWorkflowTasks', () => {
    it('GETs with kind/state/limit query params', async () => {
      const { client, calls } = makeClient([
        { status: 200, body: { tasks: [SAMPLE_TASK], count: 1 } },
      ]);
      const tasks = await client.listWorkflowTasks({
        kind: 'approval',
        state: 'pending_approval',
        limit: 50,
      });
      expect(tasks).toHaveLength(1);
      expect(calls[0].url).toContain('kind=approval');
      expect(calls[0].url).toContain('state=pending_approval');
      expect(calls[0].url).toContain('limit=50');
    });

    it('returns [] when server returns no tasks', async () => {
      const { client } = makeClient([{ status: 200, body: { tasks: [] } }]);
      expect(await client.listWorkflowTasks({ kind: 'approval', state: 'queued' })).toEqual([]);
    });
  });

  describe('getWorkflowTask', () => {
    it('returns the task on 200', async () => {
      const { client } = makeClient([{ status: 200, body: { task: SAMPLE_TASK } }]);
      const t = await client.getWorkflowTask('task-1');
      expect(t?.id).toBe('task-1');
    });

    it('returns null on 404', async () => {
      const { client } = makeClient([{ status: 404, body: { error: 'not found' } }]);
      const t = await client.getWorkflowTask('ghost');
      expect(t).toBeNull();
    });

    it('URL-encodes the id', async () => {
      const { client, calls } = makeClient([{ status: 200, body: { task: SAMPLE_TASK } }]);
      await client.getWorkflowTask('task/with/slashes');
      expect(calls[0].url).toContain('/v1/workflow/tasks/task%2Fwith%2Fslashes');
    });
  });
});
