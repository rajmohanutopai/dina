/**
 * Bus Driver — provider-side end-to-end (cross-node round-trip, second
 * half).
 *
 * `mobile_bus_driver_e2e.test.ts` covers the **requester** half: the
 * agentic flow on Alonso's node — geocode → AppView search →
 * orchestrator builds the wire payload — but stops at the dispatched
 * `service.query` body. The orchestrator is stubbed; nothing actually
 * processes the query.
 *
 * This test takes that captured wire payload and runs it through the
 * **provider** half end-to-end: BusDriver's `ServiceHandler` →
 * delegation task → `LocalDelegationRunner` (acting as the
 * out-of-process dina-agent / OpenClaw) → `WorkflowService.complete`
 * → `bridgeServiceQueryCompletion` → outbound `service.response` body.
 *
 * Combined, the two tests prove the full cross-node round-trip with
 * real production code on each side:
 *
 *   Alonso side (mobile_bus_driver_e2e):
 *     vault_search → geocode → search_provider_services
 *       → orchestrator.issueQueryToDID → outbound service.query body  ──┐
 *                                                                       │
 *   ─── opaque bytes on the wire (in prod: D2D MsgBox; here: in-memory) │
 *                                                                       │
 *   BusDriver side (this test):                                         │
 *     ServiceHandler.handleQuery(body)  ◀──────────────────────────────┘
 *       → workflow task (kind=delegation, payload.type=service_query_execution)
 *       → LocalDelegationRunner claims + runs `eta_query` capability
 *       → WorkflowService.complete (fires response bridge)
 *       → outbound service.response body
 *
 * What this test catches that the requester-side test doesn't:
 *   - Schema-hash check on inbound query (provider rejects stale schemas)
 *   - JSON-Schema params validation on the provider side
 *   - Delegation-task creation shape (kind, origin, payload.type)
 *   - LocalDelegationRunner only claims `service_query_execution`
 *   - Runner result → bridge → service.response correlation by query_id
 *   - Response result-schema validation (catches drifted runner output)
 *   - Bridge fires error envelope when runner throws (no silent TTL wait)
 *
 * What still needs the simulator
 *   - Actual D2D wire transport (MsgBox WebSocket relay)
 *   - Real OpenClaw / dina-agent lifecycle (lease heartbeat, claim
 *     polling, MCP tool subprocess); LocalDelegationRunner is the
 *     in-process equivalent and runs the same `WorkflowService` paths.
 *   - Two truly separate Core instances on the wire (this test runs
 *     one provider router; the requester half runs in the sibling test
 *     against its own router instance — module-globals make true
 *     in-process two-node setups infeasible without process forks).
 */

import { ServiceHandler } from '../../src/service/service_handler';
import type { ServiceHandlerCoreClient } from '../../src/service/service_handler';
import { validateAgainstSchema } from '../../src/service/capabilities/schema_validator';

import type { ServiceQueryBody, ServiceResponseBody } from '../../../core/src/d2d/service_bodies';
import type { ServiceConfig } from '@dina/protocol';
import type { WorkflowTask, WorkflowTaskState } from '../../../core/src/workflow/domain';

import {
  WorkflowService,
  setWorkflowService,
} from '../../../core/src/workflow/service';
import {
  InMemoryWorkflowRepository,
  setWorkflowRepository,
} from '../../../core/src/workflow/repository';
import { LocalDelegationRunner } from '../../../core/src/workflow/local_delegation_runner';
import {
  setServiceConfig,
  getServiceConfig,
  resetServiceConfigState,
} from '../../../core/src/service/service_config';
import { makeServiceResponseBridgeSender } from '../../../core/src/workflow/response_bridge_sender';

const ALONSO_DID = 'did:plc:alonso-test';
const BUSDRIVER_DID = 'did:plc:busdriver-test';
const RUNNER_AGENT_DID = 'did:plc:busdriver-openclaw-test';

const ETA_PARAMS_SCHEMA = {
  type: 'object',
  required: ['route_id', 'location'],
  properties: {
    route_id: { type: 'string' },
    location: {
      type: 'object',
      required: ['lat', 'lng'],
      properties: {
        lat: { type: 'number' },
        lng: { type: 'number' },
      },
    },
  },
} as const;

const ETA_RESULT_SCHEMA = {
  type: 'object',
  required: ['eta_minutes', 'stop_name'],
  properties: {
    eta_minutes: { type: 'integer' },
    stop_name: { type: 'string' },
    map_url: { type: 'string' },
    status: {
      type: 'string',
      enum: ['on_route', 'not_on_route', 'out_of_service'],
    },
  },
} as const;

const SCHEMA_HASH = 'sha256:busdriver-eta-v1';

// No service-config repo wired here. `setServiceConfig` writes through
// the in-memory module-global first (the SQLite repo is for restart
// persistence, not in-process correctness). `getServiceConfig` reads
// from that same in-memory state — `service_config.ts` says reads come
// from the `current` cache, which `setServiceConfig` always populates.
// Skipping the repo keeps the test free of DB plumbing without losing
// any read/write fidelity.

describe('Bus Driver — provider-side cross-node E2E', () => {
  let workflowRepo: InMemoryWorkflowRepository;
  let workflowService: WorkflowService;
  let runner: LocalDelegationRunner;
  let capturedResponses: Array<{ to: string; body: ServiceResponseBody }>;

  /**
   * Stub `dina-agent` capability runner. Acts as the OpenClaw side —
   * receives a structured service_query_execution payload and returns
   * a structured result that conforms to ETA_RESULT_SCHEMA.
   */
  function transitRunner(
    capability: string,
    params: unknown,
  ): Promise<unknown> {
    if (capability !== 'eta_query') {
      return Promise.reject(new Error(`unsupported capability: ${capability}`));
    }
    // Cast at the boundary — ServiceHandler validated against the
    // schema before the task was created, so by the time the runner
    // sees `params` it already conforms.
    const p = params as { route_id: string; location: { lat: number; lng: number } };
    // Deterministic schedule-based ETA: 12 min for route 42 to Castro.
    return Promise.resolve({
      eta_minutes: 12,
      stop_name: 'Castro Station',
      map_url: `https://www.google.com/maps/dir/?api=1&origin=37.767,-122.429&destination=${p.location.lat},${p.location.lng}&travelmode=transit`,
      status: 'on_route',
    });
  }

  beforeEach(() => {
    capturedResponses = [];

    // Wire BusDriver's module-global state. Each `beforeEach` resets
    // these because every test in this file plays the BusDriver role
    // — there's no Alonso state to preserve here.
    workflowRepo = new InMemoryWorkflowRepository();
    setWorkflowRepository(workflowRepo);

    // Reset config state; no repo wired — see header note.
    resetServiceConfigState();
    const busDriverConfig: ServiceConfig = {
      isDiscoverable: true,
      name: 'SF Transit Authority',
      description: 'Real-time SF Muni bus arrival ETAs',
      capabilities: {
        eta_query: {
          mcpServer: 'transit',
          mcpTool: 'get_eta',
          responsePolicy: 'auto',
          schemaHash: SCHEMA_HASH,
        },
      },
      capabilitySchemas: {
        eta_query: {
          params: ETA_PARAMS_SCHEMA as unknown as Record<string, unknown>,
          result: ETA_RESULT_SCHEMA as unknown as Record<string, unknown>,
          schemaHash: SCHEMA_HASH,
          description: 'ETA to next stop on a given bus route',
          defaultTtlSeconds: 120,
        },
      },
    };
    setServiceConfig(busDriverConfig);

    // WorkflowService with the response-bridge sender wired —
    // `bridgeServiceQueryCompletion` calls this when a service_query
    // delegation completes, producing the outbound service.response
    // wire payload that this test captures (instead of sending over
    // D2D).
    workflowService = new WorkflowService({
      repository: workflowRepo,
      responseBridgeSender: makeServiceResponseBridgeSender({
        sendResponse: async (recipientDID, body) => {
          capturedResponses.push({ to: recipientDID, body });
        },
        validateResult: (value, schema) => validateAgainstSchema(value, schema),
      }),
    });
    setWorkflowService(workflowService);
  });

  afterEach(() => {
    runner?.stop();
    setWorkflowService(null);
    setWorkflowRepository(null);
    resetServiceConfigState();
  });

  /**
   * Build the `ServiceHandlerCoreClient` slice (`createWorkflowTask` +
   * `cancelWorkflowTask`) — routes to `WorkflowService` so the
   * bridge fires on completion. Same adapter shape used by
   * `approve_event_to_delegation.test.ts`; matches what mobile
   * bootstrap wires production-side via `InProcessTransport`.
   */
  function buildHandlerCoreClient(): ServiceHandlerCoreClient {
    return {
      async createWorkflowTask(input) {
        const task = workflowService.create({
          id: input.id,
          kind: input.kind as WorkflowTask['kind'],
          payload: input.payload,
          description: input.description ?? '',
          policy: input.policy,
          correlationId: input.correlationId,
          origin: input.origin,
          initialState: input.initialState as WorkflowTaskState | undefined,
          expiresAtSec: input.expiresAtSec,
          priority: input.priority as WorkflowTask['priority'] | undefined,
        });
        return { task, deduped: false };
      },
      async cancelWorkflowTask(id, reason) {
        return workflowService.cancel(id, reason ?? '');
      },
    };
  }

  it('full provider round-trip: handle service.query → delegation → runner → service.response', async () => {
    const handler = new ServiceHandler({
      coreClient: buildHandlerCoreClient(),
      readConfig: () => getServiceConfig(),
    });

    // Wire bytes Alonso would have sent. Shape matches what the
    // requester-side `mobile_bus_driver_e2e.test.ts` proves the
    // orchestrator emits.
    const inboundQuery: ServiceQueryBody = {
      query_id: 'q-xyz-001',
      capability: 'eta_query',
      schema_hash: SCHEMA_HASH,
      params: {
        route_id: '42',
        location: { lat: 37.762, lng: -122.435 },
      },
      ttl_seconds: 60,
    };

    // ── Step 1: BusDriver's ServiceHandler validates + creates task ──
    await handler.handleQuery(ALONSO_DID, inboundQuery);

    // Workflow repo now holds exactly one delegation task with the
    // shape the runner is allowed to claim (kind=delegation,
    // status='queued', origin='d2d', payload.type='service_query_execution').
    const queuedTasks = workflowRepo.listByKindAndState('delegation', 'queued', 100);
    expect(queuedTasks).toHaveLength(1);

    const task = queuedTasks[0]!;
    expect(task.origin).toBe('d2d');
    expect(task.correlation_id).toBe(inboundQuery.query_id);
    const taskPayload = JSON.parse(task.payload) as Record<string, unknown>;
    expect(taskPayload.type).toBe('service_query_execution');
    expect(taskPayload.from_did).toBe(ALONSO_DID);
    expect(taskPayload.capability).toBe('eta_query');
    expect(taskPayload.params).toEqual(inboundQuery.params);

    // ── Step 2: LocalDelegationRunner claims + executes ──────────────
    runner = new LocalDelegationRunner({
      repository: workflowRepo,
      workflowService,
      agentDID: RUNNER_AGENT_DID,
      runner: transitRunner,
      pollIntervalMs: 10_000,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });
    await runner.runTick();

    // Task should now be `completed` and the response bridge should
    // have been invoked — `capturedResponses` carries the outbound
    // service.response body.
    const after = workflowRepo.getById(task.id);
    expect(after?.status).toBe('completed');

    // ── Step 3: response-bridge captured the outbound wire payload ──
    expect(capturedResponses).toHaveLength(1);
    const out = capturedResponses[0]!;
    expect(out.to).toBe(ALONSO_DID); // bridge routed back to requester
    expect(out.body.query_id).toBe(inboundQuery.query_id);
    expect(out.body.capability).toBe('eta_query');
    expect(out.body.status).toBe('success');
    expect(out.body.result).toMatchObject({
      eta_minutes: 12,
      stop_name: 'Castro Station',
      status: 'on_route',
    });
    // Map URL pinned partially — provider includes the requester's
    // location verbatim so the rendered map points at the right stop.
    expect((out.body.result as { map_url: string }).map_url).toContain('travelmode=transit');
    expect((out.body.result as { map_url: string }).map_url).toContain('37.762');
  });

  it('schema-hash mismatch on inbound query → error response, no task created', async () => {
    const handlerCalls: Array<{ to: string; body: unknown }> = [];
    const handler = new ServiceHandler({
      coreClient: buildHandlerCoreClient(),
      readConfig: () => getServiceConfig(),
      rejectResponder: async (recipientDID, body) => {
        handlerCalls.push({ to: recipientDID, body });
      },
    });

    const staleQuery: ServiceQueryBody = {
      query_id: 'q-stale-001',
      capability: 'eta_query',
      schema_hash: 'sha256:OLD-VERSION-DEADBEEF',
      params: {
        route_id: '42',
        location: { lat: 37.762, lng: -122.435 },
      },
      ttl_seconds: 60,
    };

    await handler.handleQuery(ALONSO_DID, staleQuery);

    // No task should have been created — schema check rejects FIRST
    // (handler short-circuits before createWorkflowTask).
    expect(workflowRepo.listByKindAndState('delegation', 'queued', 100)).toHaveLength(0);
    expect(workflowRepo.listByKindAndState('approval', 'pending_approval', 100)).toHaveLength(0);

    // Requester gets an immediate error envelope, not a TTL wait.
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0]!.to).toBe(ALONSO_DID);
    const body = handlerCalls[0]!.body as {
      query_id: string;
      capability: string;
      status: string;
      error: string;
    };
    expect(body.query_id).toBe(staleQuery.query_id);
    expect(body.status).toBe('error');
    expect(body.error).toMatch(/schema_hash_mismatch|schema/i);
  });

  it('invalid params (route_id missing) → error response, no task created', async () => {
    const handlerCalls: Array<{ to: string; body: unknown }> = [];
    const handler = new ServiceHandler({
      coreClient: buildHandlerCoreClient(),
      readConfig: () => getServiceConfig(),
      rejectResponder: async (recipientDID, body) => {
        handlerCalls.push({ to: recipientDID, body });
      },
    });

    const badQuery: ServiceQueryBody = {
      query_id: 'q-bad-params-001',
      capability: 'eta_query',
      schema_hash: SCHEMA_HASH,
      params: {
        // route_id missing — required by ETA_PARAMS_SCHEMA
        location: { lat: 37.762, lng: -122.435 },
      },
      ttl_seconds: 60,
    };

    await handler.handleQuery(ALONSO_DID, badQuery);

    // Schema-hash mismatch rejected before any task creation —
    // confirm by checking every state bucket is empty.
    expect(workflowRepo.listByKindAndState('delegation', 'queued', 100)).toHaveLength(0);
    expect(workflowRepo.listByKindAndState('approval', 'pending_approval', 100)).toHaveLength(0);
    expect(handlerCalls).toHaveLength(1);
    expect((handlerCalls[0]!.body as { status: string }).status).toBe('error');
  });

  it('runner throws → bridge fires error envelope (not silent TTL)', async () => {
    const handler = new ServiceHandler({
      coreClient: buildHandlerCoreClient(),
      readConfig: () => getServiceConfig(),
    });

    const throwingRunner = (): Promise<unknown> => {
      throw new Error('transit MCP server crashed');
    };

    runner = new LocalDelegationRunner({
      repository: workflowRepo,
      workflowService,
      agentDID: RUNNER_AGENT_DID,
      runner: throwingRunner,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });

    const query: ServiceQueryBody = {
      query_id: 'q-runner-err-001',
      capability: 'eta_query',
      schema_hash: SCHEMA_HASH,
      params: {
        route_id: '42',
        location: { lat: 37.762, lng: -122.435 },
      },
      ttl_seconds: 60,
    };

    await handler.handleQuery(ALONSO_DID, query);
    await runner.runTick();

    // The original task transitioned to `failed` (runner threw).
    const failed = workflowRepo.listByKindAndState('delegation', 'failed', 100);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.correlation_id).toBe(query.query_id);

    // Critical contract: the runner threw, the task is failed, AND
    // the response bridge STILL fired a proper error envelope so the
    // requester knows the call won't return. Without this, Alonso
    // would just hang until ttl_seconds elapsed.
    expect(capturedResponses).toHaveLength(1);
    expect(capturedResponses[0]!.to).toBe(ALONSO_DID);
    expect(capturedResponses[0]!.body.query_id).toBe(query.query_id);
    expect(capturedResponses[0]!.body.status).toBe('error');
    expect((capturedResponses[0]!.body as { error: string }).error).toMatch(
      /transit MCP|crashed/i,
    );
  });

  it('runner returns drifted result (missing required field) → bridge sends error, not bad data', async () => {
    const handler = new ServiceHandler({
      coreClient: buildHandlerCoreClient(),
      readConfig: () => getServiceConfig(),
    });

    // Drifted runner — returns a payload missing `stop_name` (which
    // ETA_RESULT_SCHEMA marks required). The schema validator wired
    // into `makeServiceResponseBridgeSender` should catch this and
    // convert the success response to an error response so the
    // requester doesn't get a contract-violating payload.
    const driftedRunner = (): Promise<unknown> =>
      Promise.resolve({
        eta_minutes: 12,
        // stop_name OMITTED — schema violation
        status: 'on_route',
      });

    runner = new LocalDelegationRunner({
      repository: workflowRepo,
      workflowService,
      agentDID: RUNNER_AGENT_DID,
      runner: driftedRunner,
      setInterval: () => 1,
      clearInterval: () => {
        /* noop */
      },
    });

    const query: ServiceQueryBody = {
      query_id: 'q-drift-001',
      capability: 'eta_query',
      schema_hash: SCHEMA_HASH,
      params: {
        route_id: '42',
        location: { lat: 37.762, lng: -122.435 },
      },
      ttl_seconds: 60,
    };

    await handler.handleQuery(ALONSO_DID, query);
    await runner.runTick();

    expect(capturedResponses).toHaveLength(1);
    expect(capturedResponses[0]!.body.status).toBe('error');
    // The validator's error message should reference the missing
    // field — this is what makes the failure debuggable on Alonso's
    // side instead of "got back nonsense".
    expect((capturedResponses[0]!.body as { error: string }).error).toMatch(
      /stop_name|required/i,
    );
  });
});
