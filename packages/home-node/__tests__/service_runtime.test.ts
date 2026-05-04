import type { CoreClient } from '@dina/core';
import type { ServiceConfig } from '@dina/protocol';

import { buildHomeNodeServiceRuntime } from '../service-runtime';

const REQUESTER = 'did:plc:requester';

const SERVICE_CONFIG: ServiceConfig = {
  isDiscoverable: true,
  name: 'Bus 42',
  capabilities: {
    eta_query: {
      mcpServer: 'transit',
      mcpTool: 'get_eta',
      responsePolicy: 'auto',
      schemaHash: 'hash-v1',
    },
  },
  capabilitySchemas: {
    eta_query: {
      params: {
        type: 'object',
        required: ['location'],
        properties: {
          location: {
            type: 'object',
            required: ['lat', 'lng'],
            properties: {
              lat: { type: 'number', minimum: -90, maximum: 90 },
              lng: { type: 'number', minimum: -180, maximum: 180 },
            },
          },
        },
      },
      result: { type: 'object' },
      schemaHash: 'hash-v1',
    },
  },
};

const VALID_QUERY = {
  query_id: 'q-1',
  capability: 'eta_query',
  params: { location: { lat: 37.77, lng: -122.41 } },
  ttl_seconds: 60,
  schema_hash: 'hash-v1',
};

describe('@dina/home-node/service-runtime', () => {
  it('builds shared service primitives and routes service.query through the dispatcher', async () => {
    const core = stubCore();
    const runtime = buildHomeNodeServiceRuntime({
      core: core.client,
      appView: stubAppView(),
      readConfig: () => SERVICE_CONFIG,
      rejectResponder: jest.fn(),
      deliver: jest.fn(),
      nowSecFn: () => 1_000,
      generateUUID: () => 'uuid-1',
    });

    expect(runtime.dispatcher.registeredTypes()).toEqual(['service.query']);

    const result = await runtime.dispatcher.dispatch(
      REQUESTER,
      { type: 'service.query', from: REQUESTER, to: 'did:plc:server' } as never,
      VALID_QUERY,
    );

    expect(result).toMatchObject({ routed: true, dropped: false, handlerError: null });
    expect(core.createWorkflowTask).toHaveBeenCalledTimes(1);
    const call = core.createWorkflowTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      id: 'svc-exec-uuid-1',
      kind: 'delegation',
      origin: 'd2d',
      correlationId: 'q-1',
      expiresAtSec: 1_060,
      initialState: 'queued',
    });
    expect(JSON.parse(call.payload as string)).toMatchObject({
      type: 'service_query_execution',
      from_did: REQUESTER,
      query_id: 'q-1',
      capability: 'eta_query',
      service_name: 'Bus 42',
      schema_hash: 'hash-v1',
      mcp_tool: 'get_eta',
    });
  });

  it('sends task-less rejection responses for pre-workflow service.query failures', async () => {
    const core = stubCore();
    const rejectResponder = jest.fn(async () => undefined);
    const runtime = buildHomeNodeServiceRuntime({
      core: core.client,
      appView: stubAppView(),
      readConfig: () => SERVICE_CONFIG,
      rejectResponder,
      deliver: jest.fn(),
    });

    await runtime.dispatcher.dispatch(
      REQUESTER,
      { type: 'service.query', from: REQUESTER, to: 'did:plc:server' } as never,
      {
        ...VALID_QUERY,
        capability: 'unknown_capability',
        schema_hash: undefined,
      },
    );

    expect(core.createWorkflowTask).not.toHaveBeenCalled();
    expect(rejectResponder).toHaveBeenCalledWith(REQUESTER, {
      query_id: 'q-1',
      capability: 'unknown_capability',
      status: 'unavailable',
      error: 'capability_not_configured',
      ttl_seconds: 60,
    });
  });

  it('owns workflow event and approval scheduler lifecycle explicitly', async () => {
    const core = stubCore();
    const handles = [{ id: 'events' }, { id: 'approvals' }];
    const setIntervalFn = jest.fn((_fn: () => void, _ms: number) => handles.shift()!);
    const clearIntervalFn = jest.fn();
    const runtime = buildHomeNodeServiceRuntime({
      core: core.client,
      appView: stubAppView(),
      readConfig: () => SERVICE_CONFIG,
      rejectResponder: jest.fn(),
      deliver: jest.fn(),
      workflowEventIntervalMs: 25,
      approvalReconcileIntervalMs: 50,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });

    runtime.start();
    await runtime.flush();

    expect(setIntervalFn).toHaveBeenNthCalledWith(1, expect.any(Function), 25);
    expect(setIntervalFn).toHaveBeenNthCalledWith(2, expect.any(Function), 50);
    expect(core.listWorkflowEvents).toHaveBeenCalledWith({
      needsDeliveryOnly: true,
      limit: 50,
    });
    expect(core.listWorkflowTasks).toHaveBeenCalledWith({
      kind: 'approval',
      state: 'pending_approval',
      limit: 50,
    });
    expect(core.listWorkflowTasks).toHaveBeenCalledWith({
      kind: 'approval',
      state: 'queued',
      limit: 50,
    });

    runtime.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  it('fails fast when required runtime dependencies are omitted', () => {
    const base = {
      core: stubCore().client,
      appView: stubAppView(),
      readConfig: () => SERVICE_CONFIG,
      rejectResponder: jest.fn(),
      deliver: jest.fn(),
    };

    expect(() =>
      buildHomeNodeServiceRuntime({ ...base, rejectResponder: undefined as never }),
    ).toThrow(/rejectResponder is required/);
    expect(() => buildHomeNodeServiceRuntime({ ...base, deliver: undefined as never }))
      .toThrow(/deliver is required/);
  });
});

function stubAppView() {
  return {
    searchServices: jest.fn(async () => []),
  };
}

function stubCore() {
  const core = {
    createWorkflowTask: jest.fn(async (input: Record<string, unknown>) => ({
      task: { id: input.id },
      deduped: false,
    })),
    cancelWorkflowTask: jest.fn(async () => ({})),
    sendServiceQuery: jest.fn(async () => ({
      taskId: 'task-1',
      queryId: 'q-1',
      deduped: false,
    })),
    listWorkflowEvents: jest.fn(async () => []),
    acknowledgeWorkflowEvent: jest.fn(async () => true),
    getWorkflowTask: jest.fn(async () => null),
    failWorkflowEventDelivery: jest.fn(async () => true),
    listWorkflowTasks: jest.fn(async () => []),
    sendServiceRespond: jest.fn(async () => ({
      status: 'sent',
      taskId: 'task-1',
      alreadyProcessed: false,
    })),
    failWorkflowTask: jest.fn(async () => ({})),
  };
  return { client: core as unknown as CoreClient, ...core };
}
