/**
 * BRAIN-P2-T05 — end-to-end: `/service_approve <taskId>` approves the card,
 * Core executes the approved query (`ServiceQueryIngress.executeApproved`),
 * the card is closed, and a fresh delegation task exists.
 *
 * Wires together:
 *   - `handleChat('/service_approve …')`             (chat/orchestrator.ts)
 *   - `makeServiceApproveHandler(coreClient)`        (service/approve_command.ts)
 *   - Core's `ServiceQueryIngress`                    (core/src/service/query_ingress.ts)
 *
 * The workflow-event consumer's part (it hears the `approved` event and asks
 * Core to execute) is played here by calling `executeApproved` directly;
 * `approve_event_to_delegation.test.ts` runs the consumer itself.
 */

import {
  InMemoryWorkflowRepository,
  ServiceQueryIngress,
  WorkflowService,
  type CreateWorkflowTaskInput,
  type ServiceConfig,
  type WorkflowTask,
} from '@dina/core';

import {
  handleChat,
  resetChatDefaults,
  setServiceApproveCommandHandler,
  resetServiceApproveCommandHandler,
} from '../../src/chat/orchestrator';
import { resetThreads } from '../../src/chat/thread';
import { makeServiceApproveHandler } from '../../src/service/approve_command';

/** A real workflow service, with every create/approve/cancel recorded. */
function buildCore(): {
  workflow: WorkflowService;
  client: { approveWorkflowTask(id: string): Promise<WorkflowTask> };
  createCalls: CreateWorkflowTaskInput[];
  approveCalls: string[];
  cancelCalls: { id: string; reason?: string }[];
} {
  const workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
  const createCalls: CreateWorkflowTaskInput[] = [];
  const approveCalls: string[] = [];
  const cancelCalls: { id: string; reason?: string }[] = [];
  const realCreate = workflow.create.bind(workflow);
  const realCancel = workflow.cancel.bind(workflow);
  workflow.create = (input) => {
    const task = realCreate(input);
    createCalls.push(input);
    return task;
  };
  workflow.cancel = (id, reason) => {
    const task = realCancel(id, reason);
    cancelCalls.push({ id, reason });
    return task;
  };
  return {
    workflow,
    client: {
      async approveWorkflowTask(id: string) {
        approveCalls.push(id);
        return workflow.approve(id);
      },
    },
    createCalls,
    approveCalls,
    cancelCalls,
  };
}

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

const REQUESTER = 'did:plc:requester';

describe('/service_approve → Core executes the approved query (BRAIN-P2-T05)', () => {
  beforeEach(() => {
    resetChatDefaults();
    resetThreads();
    resetServiceApproveCommandHandler();
  });

  afterAll(() => {
    resetServiceApproveCommandHandler();
  });

  it('full flow: review-policy query → approve → delegation created + approval cancelled', async () => {
    const core = buildCore();
    const ingress = new ServiceQueryIngress({
      workflow: core.workflow,
      readConfig: () => BUS_CONFIG,
      nowSecFn: () => 1_700_000_000,
      generateUUID: () => 'u1',
    });
    setServiceApproveCommandHandler(makeServiceApproveHandler(core.client));

    // 1. The requester's service.query lands → Core creates an approval card.
    await ingress.admitQuery(REQUESTER, {
      query_id: 'q-1',
      capability: 'route_info',
      params: { route: '42' },
      ttl_seconds: 60,
    });

    expect(core.createCalls).toHaveLength(1);
    const approvalCall = core.createCalls[0]!;
    expect(approvalCall.kind).toBe('approval');
    expect(approvalCall.id).toBe('approval-u1');
    expect(approvalCall.initialState).toBe('pending_approval');

    // 2. The owner types /service_approve approval-u1 in chat.
    const approveRes = await handleChat('/service_approve approval-u1');
    expect(approveRes.intent).toBe('service_approve');
    expect(approveRes.response).toBe('Approved — "approval-u1" executing via delegation…');
    expect(core.approveCalls).toEqual(['approval-u1']);

    // 3. The `approved` event reaches Core's ingress.
    await ingress.executeApproved('approval-u1');

    // 4. A delegation task with the deterministic id.
    expect(core.createCalls).toHaveLength(2);
    const delegationCall = core.createCalls[1]!;
    expect(delegationCall.id).toBe('svc-exec-from-approval-u1');
    expect(delegationCall.kind).toBe('delegation');
    expect(delegationCall.correlationId).toBe('q-1');
    expect(JSON.parse(delegationCall.payload)).toMatchObject({
      type: 'service_query_execution',
      from_did: REQUESTER,
      query_id: 'q-1',
      capability: 'route_info',
      params: { route: '42' },
    });

    // 5. The card closed with the canonical reason.
    expect(core.cancelCalls).toEqual([{ id: 'approval-u1', reason: 'executed_via_delegation' }]);
  });

  it('a repeated approve and a redriven event change nothing', async () => {
    const core = buildCore();
    const ingress = new ServiceQueryIngress({
      workflow: core.workflow,
      readConfig: () => BUS_CONFIG,
      generateUUID: () => 'u2',
    });
    setServiceApproveCommandHandler(makeServiceApproveHandler(core.client));

    await ingress.admitQuery(REQUESTER, {
      query_id: 'q-2',
      capability: 'route_info',
      params: {},
      ttl_seconds: 60,
    });

    await handleChat('/service_approve approval-u2');
    await ingress.executeApproved('approval-u2');
    expect(core.createCalls).toHaveLength(2);
    expect(core.cancelCalls).toHaveLength(1);

    // The card is settled: a second approve is refused by Core (the chat
    // shows the error), and a redriven `approved` event starts nothing.
    await handleChat('/service_approve approval-u2');
    expect(core.approveCalls).toEqual(['approval-u2', 'approval-u2']);
    await ingress.executeApproved('approval-u2');
    expect(core.createCalls).toHaveLength(2);
    expect(core.cancelCalls).toHaveLength(1);
  });
});
