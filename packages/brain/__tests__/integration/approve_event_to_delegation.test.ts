/**
 * BRAIN-P4-P01 — end-to-end event-driven approve → delegation flow.
 *
 * Differs from `approve_to_delegation.test.ts` (BRAIN-P2-T05) by
 * replacing the simulated consumer (`ingress.executeApproved(…)` called
 * directly in-test) with the real `WorkflowEventConsumer` wired to the
 * `onApproved` dispatcher. This proves the approve → execute loop is driven
 * by workflow events alone, matching the production composition
 * (`@dina/home-node` service runtime).
 *
 * Wire:
 *   InMemoryWorkflowRepository
 *     └─ adapter → WorkflowEventConsumer.core    (events + getTask)
 *   WorkflowService (real) — single source of truth
 *   Core's ServiceQueryIngress (real) — creates the card, then executes it
 *   WorkflowEventConsumer (real) — onApproved → ingress.executeApproved
 */

import {
  InMemoryWorkflowRepository,
  ServiceQueryIngress,
  WorkflowService,
  WorkflowTaskState,
} from '@dina/core';

import {
  WorkflowEventConsumer,
  type WorkflowEventConsumerCoreClient,
} from '../../src/service/workflow_event_consumer';

import type { ServiceConfig } from '@dina/core';

const REQUESTER = 'did:plc:requester';
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

const BUS_CONFIG: ServiceConfig = {
  isDiscoverable: true,
  name: 'Bus 42',
  capabilities: {
    route_info: {
      mcpServer: 'transit',
      mcpTool: 'get_route',
      responsePolicy: 'review',
    },
  },
};

/** Adapter: WorkflowService → WorkflowEventConsumerCoreClient. */
function consumerAdapter(service: WorkflowService): WorkflowEventConsumerCoreClient {
  return {
    async listWorkflowEvents(params) {
      const events = service
        .store()
        .listUndeliveredEvents(Number.MAX_SAFE_INTEGER, 0, params?.limit ?? 50);
      return events;
    },
    async acknowledgeWorkflowEvent(eventId) {
      const nowMs = Date.now();
      const repo = service.store();
      const ok = repo.markEventAcknowledged(eventId, nowMs);
      if (ok) repo.markEventDelivered(eventId, nowMs);
      return ok;
    },
    async getA2AOperation() {
      return null;
    },
    async getWorkflowTask(id) {
      return service.store().getById(id);
    },
    async failWorkflowEventDelivery(eventId, opts) {
      // The consumer calls this on dispatch failure to push
      // next_delivery_at out. The in-memory store uses the
      // provided nextDeliveryAt or defaults to now+30s, matching
      // the Core route's default.
      const next = opts?.nextDeliveryAt ?? Date.now() + 30_000;
      return service.store().markEventDeliveryFailed(eventId, next, Date.now());
    },
  };
}

describe('WorkflowEventConsumer.onApproved → Core executes the approved query (BRAIN-P4-P01)', () => {
  it('drives the full approve → delegation loop from a single workflow event', async () => {
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({
      repository: repo,
      nowMsFn: () => NOW_MS,
    });

    const ingress = new ServiceQueryIngress({
      workflow: service,
      readConfig: () => BUS_CONFIG,
      nowSecFn: () => NOW_SEC,
      generateUUID: () => 'u1',
    });

    // 1. Inbound service.query → Core persists an approval card in pending_approval.
    await ingress.admitQuery(REQUESTER, {
      query_id: 'q-1',
      capability: 'route_info',
      params: { route: '42' },
      ttl_seconds: 60,
    });
    const approvalId = 'approval-u1';
    const approval = repo.getById(approvalId);
    expect(approval).not.toBeNull();
    expect(approval!.kind).toBe('approval');
    expect(approval!.status).toBe('pending_approval');

    // 2. Operator approves — WorkflowService emits an `approved` event.
    service.approve(approvalId);
    expect(repo.getById(approvalId)!.status).toBe('queued');

    // 3. Consumer polls the event, dispatches to Core's executeApproved.
    const dispatched: string[] = [];
    const consumer = new WorkflowEventConsumer({
      coreClient: consumerAdapter(service),
      deliver: () => {
        /* unused in this flow */
      },
      onApproved: async ({ task }) => {
        dispatched.push(task.id);
        await ingress.executeApproved(task.id);
      },
    });

    const tick = await consumer.runTick();

    // 4. Verify: onApproved fired once with the card; event acked. The card
    // Core minted carries the tool and runner lane (WM-BRAIN-06a, multi-runner
    // routing) for the owner to see; the delegation takes both from the live
    // listing.
    expect(dispatched).toEqual([approvalId]);
    expect(JSON.parse(repo.getById(approvalId)!.payload)).toMatchObject({
      type: 'service_query_execution',
      from_did: REQUESTER,
      query_id: 'q-1',
      capability: 'route_info',
      params: { route: '42' },
      ttl_seconds: 60,
      service_name: 'Bus 42',
      mcp_tool: 'get_route',
      mcp_server: 'transit',
    });
    expect(tick.delivered).toBe(1);
    expect(tick.failed).toBe(0);

    // 5. Verify: delegation task created with the deterministic id; approval cancelled.
    const delegation = repo.getById('svc-exec-from-approval-u1');
    expect(delegation).not.toBeNull();
    expect(delegation!.kind).toBe('delegation');
    expect(delegation!.correlation_id).toBe('q-1');
    const delegationPayload = JSON.parse(delegation!.payload);
    expect(delegationPayload).toMatchObject({
      type: 'service_query_execution',
      from_did: REQUESTER,
      query_id: 'q-1',
      capability: 'route_info',
      params: { route: '42' },
    });

    expect(repo.getById(approvalId)!.status).toBe('cancelled');
  });

  it('does NOT ack when execution throws; event is redriven on the next tick', async () => {
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({
      repository: repo,
      nowMsFn: () => NOW_MS,
    });

    const ingress = new ServiceQueryIngress({
      workflow: service,
      readConfig: () => BUS_CONFIG,
      nowSecFn: () => NOW_SEC,
      generateUUID: () => 'u2',
    });

    await ingress.admitQuery(REQUESTER, {
      query_id: 'q-2',
      capability: 'route_info',
      params: {},
      ttl_seconds: 60,
    });
    service.approve('approval-u2');

    // Before the first tick we locate the approved event id so we can
    // verify it survives after failure.
    const eventsBefore = service.store().listUndeliveredEvents(Number.MAX_SAFE_INTEGER, 0, 50);
    const approvedEv = eventsBefore.find((e) => e.event_kind === 'approved');
    expect(approvedEv).toBeDefined();

    let attempts = 0;
    const consumer = new WorkflowEventConsumer({
      coreClient: consumerAdapter(service),
      deliver: () => {},
      onApproved: async ({ task }) => {
        attempts++;
        if (attempts === 1) throw new Error('execute 503');
        await ingress.executeApproved(task.id);
      },
    });

    // First tick — hook throws, event stays undelivered.
    const first = await consumer.runTick();
    expect(first.failed).toBe(1);
    const stillUndelivered = service.store().listUndeliveredEvents(Number.MAX_SAFE_INTEGER, 0, 50);
    expect(stillUndelivered.some((e) => e.event_id === approvedEv!.event_id)).toBe(true);
    expect(repo.getById('svc-exec-from-approval-u2')).toBeNull();

    // Second tick — hook succeeds, delegation lands, event acked.
    const second = await consumer.runTick();
    expect(second.delivered).toBe(1);
    expect(repo.getById('svc-exec-from-approval-u2')).not.toBeNull();
    const afterAck = service.store().listUndeliveredEvents(Number.MAX_SAFE_INTEGER, 0, 50);
    expect(afterAck.some((e) => e.event_id === approvedEv!.event_id)).toBe(false);
  });

  it('handles the idempotent double-approve case: second attempt sees the delegation already created', async () => {
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({
      repository: repo,
      nowMsFn: () => NOW_MS,
    });
    const ingress = new ServiceQueryIngress({
      workflow: service,
      readConfig: () => BUS_CONFIG,
      nowSecFn: () => NOW_SEC,
      generateUUID: () => 'u3',
    });

    await ingress.admitQuery(REQUESTER, {
      query_id: 'q-3',
      capability: 'route_info',
      params: {},
      ttl_seconds: 60,
    });
    service.approve('approval-u3');

    const consumer = new WorkflowEventConsumer({
      coreClient: consumerAdapter(service),
      deliver: () => {},
      onApproved: async ({ task }) => {
        await ingress.executeApproved(task.id);
      },
    });

    // First tick — delegation created in `queued` so a paired agent can claim it.
    await consumer.runTick();
    expect(repo.getById('svc-exec-from-approval-u3')!.status).toBe('queued');

    // Synthesise a second approved event for the same task (simulates a
    // delayed redelivery) and run again. The card is settled (the first
    // run executed and closed it), so Core's executeApproved starts
    // nothing: one judge, Core, decides whether a card may still run.
    repo.appendEvent({
      task_id: 'approval-u3',
      at: NOW_MS + 1_000,
      event_kind: 'approved',
      needs_delivery: true,
      delivery_attempts: 0,
      delivery_failed: false,
      details: JSON.stringify({ kind: 'approval', task_payload: '{}' }),
    });
    const queuedBefore = repo.listByKindAndState('delegation', WorkflowTaskState.Queued, 100).length;
    const delegation = service.store().getById('svc-exec-from-approval-u3');
    const second = await consumer.runTick();
    expect(second.failed).toBe(0);
    // The redriven event is delivered to Core, which judged the settled
    // card and started nothing: the delegation is the same row, untouched.
    expect(service.store().getById('svc-exec-from-approval-u3')).toEqual(delegation);
    expect(service.store().getById('approval-u3')!.status).toBe('cancelled');
    expect(repo.listByKindAndState('delegation', WorkflowTaskState.Queued, 100)).toHaveLength(queuedBefore);
  });

  // Regression for the live Tier 1 salon-booking failure: the approval
  // payload's multi-listing pin (service_uri) and frozen schema snapshot
  // (GAP-SH-04) were DROPPED by parseApprovedPayload, so the approved
  // delegation resolved the default 'self' listing (capability not
  // configured there) and lost its output contract. Both must round-trip
  // approval -> event -> consumer -> fresh delegation payload.
  it('service_uri + schema_snapshot survive the approval -> delegation handoff', async () => {
    const repo = new InMemoryWorkflowRepository();
    const service = new WorkflowService({ repository: repo, nowMsFn: () => NOW_MS });

    const SALON_URI = 'at://did:plc:salon/com.dinakernel.service.profile/alonso-s-salon';
    const SALON_CONFIG: ServiceConfig = {
      isDiscoverable: true,
      name: "Alonso's Salon",
      capabilities: {
        appointment_book: {
          responsePolicy: 'review',
          instruction: 'If someone wants to book, ask me first.',
        },
      },
      capabilitySchemas: {
        appointment_book: {
          params: { type: 'object', properties: { time: { type: 'string' } } },
          result: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
          schemaHash: 'a'.repeat(64),
        },
      },
    };

    const ingress = new ServiceQueryIngress({
      workflow: service,
      readConfig: () => SALON_CONFIG,
      nowSecFn: () => NOW_SEC,
      generateUUID: () => 'u9',
    });

    await ingress.admitQuery(REQUESTER, {
      query_id: 'q-9',
      capability: 'appointment_book',
      params: { time: '4:30 PM' },
      ttl_seconds: 300,
      schema_hash: 'a'.repeat(64),
      service_uri: SALON_URI,
    });
    expect(repo.getById('approval-u9')).not.toBeNull();

    service.approve('approval-u9');
    const consumer = new WorkflowEventConsumer({
      coreClient: consumerAdapter(service),
      deliver: () => {
        /* unused */
      },
      onApproved: async ({ task }) => {
        await ingress.executeApproved(task.id);
      },
    });
    await consumer.runTick();

    const exec = repo.getById('svc-exec-from-approval-u9');
    expect(exec).not.toBeNull();
    const execPayload = JSON.parse(exec!.payload) as Record<string, unknown>;
    expect(execPayload.service_uri).toBe(SALON_URI);
    expect(execPayload.schema_snapshot).toEqual({
      params: { type: 'object', properties: { time: { type: 'string' } } },
      result: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
      schema_hash: 'a'.repeat(64),
    });
    // The operator's approval rode along for the Tier 1 runtime.
    expect(execPayload.operator_approved).toBe(true);
    // Tier 1 lane: no mcpServer -> reserved local runner.
    expect(exec!.requested_runner).toBe('dina.local');
  });
});
