/**
 * Demo BusDriver loopback responder — wraps `sendD2D` so outbound
 * `service.query` envelopes addressed to `did:plc:bus42demo` complete
 * the matching workflow task with a synthesized `eta_query` result.
 *
 * The wrapper relies on Core's module-global workflow service to find
 * the open task, so each test installs a `WorkflowService` over an
 * `InMemoryWorkflowRepository`, seeds a task that mirrors what
 * `/v1/service/query` would have created, then asserts the task
 * transitions to `completed` with the synthesized body.
 */

import {
  setWorkflowService,
  WorkflowService,
} from '@dina/core/src/workflow/service';
import {
  setWorkflowRepository,
  InMemoryWorkflowRepository,
} from '@dina/core/src/workflow/repository';
import {
  createDemoBusDriverResponder,
  DEMO_BUS_DRIVER_DID,
} from '../../src/services/demo_bus_driver_responder';

function setupWorkflow(): {
  repo: InMemoryWorkflowRepository;
  teardown: () => void;
} {
  const repo = new InMemoryWorkflowRepository();
  setWorkflowRepository(repo);
  const service = new WorkflowService({ repository: repo });
  setWorkflowService(service);
  return {
    repo,
    teardown: () => {
      setWorkflowService(null);
      setWorkflowRepository(null);
    },
  };
}

function seedServiceQueryTask(
  repo: InMemoryWorkflowRepository,
  args: { taskId: string; queryId: string; peerDID: string; capability: string },
): void {
  const nowMs = Date.now();
  repo.create({
    id: args.taskId,
    kind: 'service_query',
    status: 'running',
    correlation_id: args.queryId,
    priority: 'normal',
    description: `service.query ${args.capability} → ${args.peerDID}`,
    payload: JSON.stringify({
      to_did: args.peerDID,
      capability: args.capability,
      service_name: 'Bus 42',
    }),
    result_summary: '',
    policy: '{}',
    created_at: nowMs,
    updated_at: nowMs,
    expires_at: Math.floor(nowMs / 1000) + 60,
  });
}

describe('demo BusDriver loopback responder', () => {
  it('completes the service_query workflow task with a synthesized response', async () => {
    jest.useFakeTimers();
    const { repo, teardown } = setupWorkflow();
    try {
      const realSends: Array<{ to: string; type: string }> = [];
      const realSendD2D = async (to: string, type: string) => {
        realSends.push({ to, type });
      };
      const wrappedSendD2D = createDemoBusDriverResponder().wrap(realSendD2D);

      const taskId = 'sq-q-test-1-deadbeef';
      seedServiceQueryTask(repo, {
        taskId,
        queryId: 'q-test-1',
        peerDID: DEMO_BUS_DRIVER_DID,
        capability: 'eta_query',
      });

      await wrappedSendD2D(DEMO_BUS_DRIVER_DID, 'service.query', {
        query_id: 'q-test-1',
        capability: 'eta_query',
        params: { route_id: '42', location: { lat: 37.762, lng: -122.435 } },
        ttl_seconds: 60,
      });

      jest.advanceTimersByTime(100);
      await Promise.resolve();

      expect(realSends).toHaveLength(0);

      const completed = repo.getById(taskId);
      expect(completed?.status).toBe('completed');
      const body = JSON.parse(completed?.result ?? '{}') as {
        capability: string;
        status: string;
        result: { eta_minutes: number; map_url: string; route_name: string; status: string };
      };
      expect(body.capability).toBe('eta_query');
      expect(body.status).toBe('success');
      expect(body.result.eta_minutes).toBe(12);
      expect(body.result.route_name).toBe('Route 42');
      expect(body.result.status).toBe('on_route');
      expect(body.result.map_url).toMatch(/google\.com\/maps\/dir/);
      expect(body.result.map_url).toContain('destination=37.762,-122.435');
    } finally {
      jest.useRealTimers();
      teardown();
    }
  });

  it('passes through unrelated DIDs and other message types to the real sender', async () => {
    jest.useFakeTimers();
    const { teardown } = setupWorkflow();
    try {
      const realSends: Array<{ to: string; type: string }> = [];
      const realSendD2D = async (to: string, type: string) => {
        realSends.push({ to, type });
      };
      const wrappedSendD2D = createDemoBusDriverResponder().wrap(realSendD2D);

      await wrappedSendD2D('did:plc:somebody-else', 'service.query', {
        query_id: 'q-test-2',
        capability: 'eta_query',
        params: { route_id: '5', location: { lat: 0, lng: 0 } },
        ttl_seconds: 60,
      });
      await wrappedSendD2D(DEMO_BUS_DRIVER_DID, 'service.response', {
        query_id: 'q-test-3',
      });

      jest.advanceTimersByTime(100);
      expect(realSends).toEqual([
        { to: 'did:plc:somebody-else', type: 'service.query' },
        { to: DEMO_BUS_DRIVER_DID, type: 'service.response' },
      ]);
    } finally {
      jest.useRealTimers();
      teardown();
    }
  });

  it('logs and no-ops when no matching workflow task exists', async () => {
    jest.useFakeTimers();
    const { teardown } = setupWorkflow();
    try {
      const log: Array<Record<string, unknown>> = [];
      const realSendD2D = async () => {};
      const wrapped = createDemoBusDriverResponder({ log: (e) => log.push(e) }).wrap(realSendD2D);

      await wrapped(DEMO_BUS_DRIVER_DID, 'service.query', {
        query_id: 'q-orphan',
        capability: 'eta_query',
        params: { route_id: '42', location: { lat: 37.762, lng: -122.435 } },
        ttl_seconds: 60,
      });

      jest.advanceTimersByTime(100);
      expect(log.some((e) => e.event === 'demo.bus_driver.no_matching_task')).toBe(true);
    } finally {
      jest.useRealTimers();
      teardown();
    }
  });
});
