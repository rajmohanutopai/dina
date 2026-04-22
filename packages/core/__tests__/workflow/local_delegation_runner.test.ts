/**
 * LocalDelegationRunner — in-process demo executor for delegation tasks.
 * Issue #5 / #6.
 */

import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { LocalDelegationRunner } from '../../src/workflow/local_delegation_runner';
import { WorkflowService } from '../../src/workflow/service';
import type { WorkflowTask } from '../../src/workflow/domain';

const NOW_MS = 1_700_000_000_000;
const AGENT = 'did:plc:agent-local';

function seedDelegation(
  repo: InMemoryWorkflowRepository,
  id: string,
  payload: Record<string, unknown>,
): void {
  const task: WorkflowTask = {
    id,
    kind: 'delegation',
    status: 'queued',
    priority: 'normal',
    description: '',
    // Default payload shape is service_query_execution — runner filters
    // to that type per issue #14.
    payload: JSON.stringify({ type: 'service_query_execution', ...payload }),
    result_summary: '',
    policy: '{}',
    created_at: NOW_MS,
    updated_at: NOW_MS,
  };
  repo.create(task);
}

function makeFixture(): {
  repo: InMemoryWorkflowRepository;
  service: WorkflowService;
} {
  const repo = new InMemoryWorkflowRepository();
  const service = new WorkflowService({ repository: repo, nowMsFn: () => NOW_MS });
  return { repo, service };
}

describe('LocalDelegationRunner', () => {
  it('rejects missing required inputs', () => {
    const { repo, service } = makeFixture();
    expect(
      () =>
        new LocalDelegationRunner({
          repository: repo,
          workflowService: service,
          agentDID: '',
          runner: async () => null,
        }),
    ).toThrow(/agentDID/);
    expect(
      () =>
        new LocalDelegationRunner({
          repository: repo,
          workflowService: service,
          agentDID: AGENT,
          runner: undefined as never,
        }),
    ).toThrow(/runner/);
    expect(
      () =>
        new LocalDelegationRunner({
          repository: repo,
          workflowService: undefined as never,
          agentDID: AGENT,
          runner: async () => null,
        }),
    ).toThrow(/workflowService/);
  });

  it('claims + executes and completes via WorkflowService (issue #6: bridge fires)', async () => {
    const { repo, service } = makeFixture();
    // Spy the Response Bridge — production wires this to sendD2D.
    const bridgeCalls: Array<{ queryId: string; resultJSON: string }> = [];
    (service as unknown as { responseBridgeSender: unknown }).responseBridgeSender = (ctx: {
      queryId: string;
      resultJSON: string;
    }) => {
      bridgeCalls.push({ queryId: ctx.queryId, resultJSON: ctx.resultJSON });
    };

    seedDelegation(repo, 'd-1', {
      capability: 'eta_query',
      params: { route_id: '42' },
      service_name: 'Bus 42',
      from_did: 'did:plc:alice',
      query_id: 'q-1',
      ttl_seconds: 60,
    });
    const calls: Array<{ cap: string; params: unknown }> = [];
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: AGENT,
      nowMsFn: () => NOW_MS,
      runner: async (cap, params) => {
        calls.push({ cap, params });
        return { eta_minutes: 45 };
      },
    });
    await runner.runTick();
    expect(calls).toEqual([{ cap: 'eta_query', params: { route_id: '42' } }]);
    const t = repo.getById('d-1');
    expect(t?.status).toBe('completed');
    expect(JSON.parse(t!.result!)).toEqual({ eta_minutes: 45 });
    // Response Bridge fired — this is the whole point of the refactor.
    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].queryId).toBe('q-1');
  });

  it('failure fires the bridge with an error envelope (issue #7)', async () => {
    const { repo, service } = makeFixture();
    const bridgeCalls: Array<{ queryId: string; resultJSON: string }> = [];
    (service as unknown as { responseBridgeSender: unknown }).responseBridgeSender = (ctx: {
      queryId: string;
      resultJSON: string;
    }) => {
      bridgeCalls.push({ queryId: ctx.queryId, resultJSON: ctx.resultJSON });
    };
    seedDelegation(repo, 'd-2', {
      capability: 'eta_query',
      params: {},
      from_did: 'did:plc:alice',
      query_id: 'q-2',
      ttl_seconds: 60,
    });
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: AGENT,
      nowMsFn: () => NOW_MS,
      runner: async () => {
        throw new Error('transit_offline');
      },
    });
    await runner.runTick();
    const t = repo.getById('d-2');
    expect(t?.status).toBe('failed');
    expect(t?.error).toBe('transit_offline');
    // Bridge fired with the error envelope — requester gets a signal,
    // not a TTL wait.
    expect(bridgeCalls).toHaveLength(1);
    const body = JSON.parse(bridgeCalls[0].resultJSON) as {
      status: string;
      error: string;
    };
    expect(body.status).toBe('error');
    expect(body.error).toBe('transit_offline');
  });

  it('fails the task when payload is malformed (no capability)', async () => {
    const { repo, service } = makeFixture();
    const task: WorkflowTask = {
      id: 'd-3',
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: '',
      payload: '{"not_a_capability": true}',
      result_summary: '',
      policy: '{}',
      created_at: NOW_MS,
      updated_at: NOW_MS,
    };
    repo.create(task);
    const runs: unknown[] = [];
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: AGENT,
      nowMsFn: () => NOW_MS,
      runner: async (cap, params) => {
        runs.push({ cap, params });
        return null;
      },
    });
    await runner.runTick();
    expect(runs).toHaveLength(0); // capability dispatcher never called
    expect(repo.getById('d-3')?.status).toBe('failed');
  });

  it('fails (does not execute) payloads whose type is not service_query_execution (issue #14)', async () => {
    const { repo, service } = makeFixture();
    const task: WorkflowTask = {
      id: 'd-timer',
      kind: 'delegation',
      status: 'queued',
      priority: 'normal',
      description: '',
      // Some future non-service_query delegation kind.
      payload: JSON.stringify({
        type: 'timer_callback',
        capability: 'schedule',
        params: {},
      }),
      result_summary: '',
      policy: '{}',
      created_at: NOW_MS,
      updated_at: NOW_MS,
    };
    repo.create(task);
    const runs: unknown[] = [];
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: AGENT,
      nowMsFn: () => NOW_MS,
      runner: async (cap, params) => {
        runs.push({ cap, params });
        return null;
      },
    });
    await runner.runTick();
    expect(runs).toHaveLength(0);
    const t = repo.getById('d-timer');
    expect(t?.status).toBe('failed');
    expect(t?.error).toMatch(/service_query_execution/);
  });

  it('fails the task when the result is not JSON-serializable (issue #15)', async () => {
    const { repo, service } = makeFixture();
    seedDelegation(repo, 'd-cyclic', { capability: 'eta_query', params: {} });
    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: AGENT,
      nowMsFn: () => NOW_MS,
      runner: async () => cyclic,
    });
    await runner.runTick();
    // Serialization failure must still transition the task — otherwise
    // the task sits running until the sweeper forces expiry.
    expect(repo.getById('d-cyclic')?.status).toBe('failed');
  });

  it('does nothing when no queued delegation exists', async () => {
    const { repo, service } = makeFixture();
    let ran = 0;
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: AGENT,
      nowMsFn: () => NOW_MS,
      runner: async () => {
        ran++;
        return null;
      },
    });
    await runner.runTick();
    expect(ran).toBe(0);
  });

  it('fires observability hooks', async () => {
    const { repo, service } = makeFixture();
    seedDelegation(repo, 'd-4', { capability: 'eta_query', params: {} });
    const claimed: string[] = [];
    const completed: Array<{ id: string; result: unknown }> = [];
    const runner = new LocalDelegationRunner({
      repository: repo,
      workflowService: service,
      agentDID: AGENT,
      nowMsFn: () => NOW_MS,
      runner: async () => ({ ok: true }),
      onClaimed: (t) => claimed.push(t.id),
      onCompleted: (t, r) => completed.push({ id: t.id, result: r }),
    });
    await runner.runTick();
    expect(claimed).toEqual(['d-4']);
    expect(completed).toEqual([{ id: 'd-4', result: { ok: true } }]);
  });
});
