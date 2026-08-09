import { InMemoryWorkflowRepository, WorkflowService, setWorkflowService } from '@dina/core';

import { buildHomeNodeServiceRuntime, toServiceResponseBody } from '../service-runtime';

import type { CoreClient } from '@dina/core';
import type { ServiceConfig } from '@dina/protocol';

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

const INSTRUCTION_CONFIG: ServiceConfig = {
  isDiscoverable: true,
  name: 'Alonso Salon',
  vaultPersona: 'salon',
  capabilities: {
    appointment_availability: {
      responsePolicy: 'auto',
      category: 'appointments',
      instruction: 'Use the salon schedule notes to answer availability.',
    },
  },
};

describe('@dina/home-node/service-runtime', () => {
  it('builds shared service primitives and routes service.query through the dispatcher', async () => {
    const core = stubCore();
    const runtime = buildHomeNodeServiceRuntime({
      core: core.client,
      appView: stubAppView(),
      readConfig: () => SERVICE_CONFIG,
      directResponder: jest.fn(),
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

  /**
   * WS-4.6 — one builder, because there were two hand-built copies and they
   * had already drifted. A field added to one but not the other drops an
   * answer silently: the responder's TYPE is still satisfied, nothing
   * complains, and the buyer waits out its TTL for a reply already computed.
   */
  describe('toServiceResponseBody', () => {
    it('carries the result of an answer compiled Core produced', () => {
      expect(
        toServiceResponseBody({
          query_id: 'q-1',
          capability: 'order_reconcile',
          status: 'success',
          result: { outcome: 'never_received' },
          ttl_seconds: 60,
        }),
      ).toEqual({
        query_id: 'q-1',
        capability: 'order_reconcile',
        status: 'success',
        result: { outcome: 'never_received' },
        ttl_seconds: 60,
      });
    });

    it('omits absent optional fields rather than sending them as null', () => {
      // A `result: undefined` on the wire reads as "answered with nothing",
      // which is a different claim from "this is a refusal".
      const body = toServiceResponseBody({
        query_id: 'q-2',
        capability: 'order_status',
        status: 'unavailable',
        error: 'capability_not_configured',
        ttl_seconds: 60,
      });
      expect('result' in body).toBe(false);
      expect(body.error).toBe('capability_not_configured');
    });

    it('carries a FALSY result, which is still an answer', () => {
      // The bug an `if (body.result)` guard would introduce. `false`, `0`,
      // and `''` are answers a capability may legitimately return.
      expect(
        toServiceResponseBody({
          query_id: 'q-3',
          capability: 'availability',
          status: 'success',
          result: false,
          ttl_seconds: 60,
        }).result,
      ).toBe(false);
    });
  });

  it('sends task-less rejection responses for pre-workflow service.query failures', async () => {
    const core = stubCore();
    const directResponder = jest.fn(async () => undefined);
    const runtime = buildHomeNodeServiceRuntime({
      core: core.client,
      appView: stubAppView(),
      readConfig: () => SERVICE_CONFIG,
      directResponder,
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
    expect(directResponder).toHaveBeenCalledWith(REQUESTER, {
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
      directResponder: jest.fn(),
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

  it('fires inboundNotifier on accepted queries (mobile parity — service provider flow)', async () => {
    const core = stubCore();
    const inboundNotifier = jest.fn();
    const runtime = buildHomeNodeServiceRuntime({
      core: core.client,
      appView: stubAppView(),
      readConfig: () => SERVICE_CONFIG,
      directResponder: jest.fn(),
      deliver: jest.fn(),
      inboundNotifier,
      nowSecFn: () => 2_000,
      generateUUID: () => 'uuid-bus',
    });

    await runtime.dispatcher.dispatch(
      REQUESTER,
      { type: 'service.query', from: REQUESTER, to: 'did:plc:demoprovider' } as never,
      VALID_QUERY,
    );

    // Auto-policy capability → execution task path. Inbound notifier
    // fires once with the operator-facing notice (kind, fromDID,
    // capability, serviceName) so mobile can post a system line into
    // the chat thread.
    expect(inboundNotifier).toHaveBeenCalledTimes(1);
    expect(inboundNotifier).toHaveBeenCalledWith({
      kind: 'execution',
      taskId: 'svc-exec-uuid-bus',
      fromDID: REQUESTER,
      capability: 'eta_query',
      serviceName: 'Bus 42',
    });
  });

  it('forwards the optional reasoning strategy through the shared runtime', async () => {
    const core = stubCore();
    const reasoningSubmitter = jest.fn(async () => ({
      taskId: 'reason-service-1',
      backendId: 'connected-brain',
      deduplicated: false,
    }));
    const runtime = buildHomeNodeServiceRuntime({
      core: core.client,
      appView: stubAppView(),
      readConfig: () => INSTRUCTION_CONFIG,
      directResponder: jest.fn(),
      deliver: jest.fn(),
      reasoningSubmitter,
    });

    await runtime.dispatcher.dispatch(
      REQUESTER,
      { type: 'service.query', from: REQUESTER, to: 'did:plc:server' } as never,
      {
        query_id: 'q-reasoning',
        capability: 'appointment_availability',
        params: { date: 'tomorrow' },
        ttl_seconds: 300,
      },
    );

    expect(reasoningSubmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterDid: REQUESTER,
        queryId: 'q-reasoning',
        capabilityId: 'appointment_availability',
        serviceName: 'Alonso Salon',
        vaultPersona: 'salon',
        ttlSeconds: 300,
      }),
    );
    expect(core.createWorkflowTask).not.toHaveBeenCalled();
  });

  it('fails fast when required runtime dependencies are omitted', () => {
    const base = {
      core: stubCore().client,
      appView: stubAppView(),
      readConfig: () => SERVICE_CONFIG,
      directResponder: jest.fn(),
      deliver: jest.fn(),
    };

    expect(() =>
      buildHomeNodeServiceRuntime({ ...base, directResponder: undefined as never }),
    ).toThrow(/directResponder is required/);
    expect(() => buildHomeNodeServiceRuntime({ ...base, deliver: undefined as never })).toThrow(
      /deliver is required/,
    );
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

/**
 * §11.2a — the plugin plane is defaulted HERE, not at each boot.
 *
 * The alternative was an option every composition root had to remember to
 * pass. That is how the ingress bridge came to exist with no caller at all:
 * a plane can validate, save, publish and advertise itself, and still answer
 * `unavailable` on the one node where somebody forgot the line. Defaulting
 * from the wired `WorkflowService` makes "does this node run plugins?" a
 * property of the node rather than a decision each boot makes differently.
 */
describe('@dina/home-node/service-runtime — plugin plane default (§11.2a)', () => {
  const PLUGIN_CONFIG: ServiceConfig = {
    isDiscoverable: true,
    name: 'ChairMaker',
    capabilities: {
      order_status: {
        pluginInstallId: 'inst-1',
        pluginManifestCid: 'bafycid',
        pluginCapabilityId: 'com.dinakernel.commerce.order_status',
        responsePolicy: 'auto',
      },
    },
  };

  const PLUGIN_QUERY = {
    query_id: 'q-plugin-1',
    capability: 'order_status',
    params: { purchase_order_id: 'po-1' },
    ttl_seconds: 60,
  };

  async function dispatchPluginQuery(
    overrides: Partial<Parameters<typeof buildHomeNodeServiceRuntime>[0]> = {},
  ) {
    const core = stubCore();
    const rejections: { status: string; error: string }[] = [];
    const runtime = buildHomeNodeServiceRuntime({
      core: core.client,
      appView: stubAppView(),
      readConfig: () => PLUGIN_CONFIG,
      directResponder: async (_did, body) => {
        rejections.push(body as unknown as { status: string; error: string });
      },
      deliver: jest.fn(),
      nowSecFn: () => 1_000,
      generateUUID: () => 'uuid-1',
      ...overrides,
    });
    await runtime.dispatcher.dispatch(
      REQUESTER,
      { type: 'service.query', from: REQUESTER, to: 'did:plc:server' } as never,
      PLUGIN_QUERY,
    );
    return { core, rejections };
  }

  it('hands a plugin-bound capability to the submitter, not the delegation lane', async () => {
    const calls: unknown[] = [];
    const { core } = await dispatchPluginQuery({
      providerIngressSubmitter: (args) => {
        calls.push(args);
        return { ok: true, taskId: 'plg-1' };
      },
    });

    expect(calls).toHaveLength(1);
    // No generic delegation task: the install answers, or nothing does.
    expect(core.createWorkflowTask).not.toHaveBeenCalled();
  });

  it('refuses when no workflow service is wired, rather than silently queuing', async () => {
    // No `WorkflowService` registered in this test process, so the default
    // resolves to null. A node that cannot run plugins must SAY so — silence
    // leaves the requester waiting out its TTL.
    setWorkflowService(null);
    const { core, rejections } = await dispatchPluginQuery();

    expect(core.createWorkflowTask).not.toHaveBeenCalled();
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      status: 'unavailable',
      error: 'plugin_lane_unavailable',
    });
  });

  it('DEFAULTS the submitter from the wired workflow service', async () => {
    // Passing an explicit submitter proves the option is forwarded; it says
    // nothing about the default, which is the part both boots depend on and
    // neither passes. Registering a workflow service and watching the refusal
    // code CHANGE — from "this node runs no plugins" to a real ingress
    // verdict — is what shows the default resolved.
    const workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
    setWorkflowService(workflow);
    try {
      const { core, rejections } = await dispatchPluginQuery();

      expect(core.createWorkflowTask).not.toHaveBeenCalled();
      expect(rejections).toHaveLength(1);
      expect(rejections[0]?.error).not.toBe('plugin_lane_unavailable');
      // The bridge ran and refused on its own terms. The code is
      // `order_subject_denied` rather than `install_unavailable` because
      // `order_status` is order-scoped: §11.2 subject authorization runs
      // BEFORE binding resolution, so an unauthorized sender cannot probe
      // install state through the typed unavailable codes either.
      expect(rejections[0]?.error).toBe('order_subject_denied');
    } finally {
      setWorkflowService(null);
    }
  });
});
