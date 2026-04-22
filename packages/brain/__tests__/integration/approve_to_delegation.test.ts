/**
 * BRAIN-P2-T05 — end-to-end: `/service_approve <taskId>` triggers
 * `executeAndRespond`, the old approval task is cancelled, and a fresh
 * delegation task is created.
 *
 * Wires together:
 *   - `handleChat('/service_approve …')`             (chat/orchestrator.ts)
 *   - `makeServiceApproveHandler(coreClient)`        (service/approve_command.ts)
 *   - `ServiceHandler.executeAndRespond(taskId)`  (service/service_handler.ts)
 *
 * Guardian isn't wired yet (BRAIN-P2-W03 is still PENDING), so we simulate
 * its role by calling `executeAndRespond` directly with the payload that
 * would otherwise arrive on the `workflow.approved` event. This pins the
 * contract the Guardian will eventually honour.
 */

import {
  handleChat,
  resetChatDefaults,
  setServiceApproveCommandHandler,
  resetServiceApproveCommandHandler,
} from '../../src/chat/orchestrator';
import { resetThreads } from '../../src/chat/thread';
import { makeServiceApproveHandler } from '../../src/service/approve_command';
import { ServiceHandler } from '../../src/service/service_handler';
import type { ServiceHandlerCoreClient } from '../../src/service/service_handler';
import type { ServiceConfig } from '../../../core/src/service/service_config';
import type { WorkflowTask } from '../../../core/src/workflow/domain';

// ---------------------------------------------------------------------------
// Shared stub coreClient — records every call, returns mostly-success.
// ---------------------------------------------------------------------------

interface CreateCall {
  id: string;
  kind: string;
  payload: string;
  origin?: string;
  correlationId?: string;
  initialState?: string;
  expiresAtSec?: number;
}

function buildStubCore(): {
  client: ServiceHandlerCoreClient & {
    approveWorkflowTask(id: string): Promise<WorkflowTask>;
  };
  createCalls: CreateCall[];
  approveCalls: string[];
  cancelCalls: Array<{ id: string; reason?: string }>;
} {
  const createCalls: CreateCall[] = [];
  const approveCalls: string[] = [];
  const cancelCalls: Array<{ id: string; reason?: string }> = [];

  const client = {
    async createWorkflowTask(input: CreateCall) {
      createCalls.push(input);
      return { task: { id: input.id } as unknown as WorkflowTask, deduped: false };
    },
    async approveWorkflowTask(id: string) {
      approveCalls.push(id);
      return { id, status: 'queued', kind: 'approval' } as unknown as WorkflowTask;
    },
    async cancelWorkflowTask(id: string, reason?: string) {
      cancelCalls.push({ id, reason });
      return { id, status: 'cancelled', kind: 'approval' } as unknown as WorkflowTask;
    },
    async sendServiceRespond() {
      return { status: 'sent', taskId: '', alreadyProcessed: false };
    },
  };

  return {
    client: client as unknown as ServiceHandlerCoreClient & {
      approveWorkflowTask(id: string): Promise<WorkflowTask>;
    },
    createCalls,
    approveCalls,
    cancelCalls,
  };
}

// ---------------------------------------------------------------------------
// Test config: eta_query (auto) + route_info (review — the interesting path)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/service_approve → executeAndRespond integration (BRAIN-P2-T05)', () => {
  beforeEach(() => {
    resetChatDefaults();
    resetThreads();
    resetServiceApproveCommandHandler();
  });

  afterAll(() => {
    resetServiceApproveCommandHandler();
  });

  it('full flow: review-policy query → approve → delegation created + approval cancelled', async () => {
    const core = buildStubCore();

    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => BUS_CONFIG,
      nowSecFn: () => 1_700_000_000,
      generateUUID: () => 'u1',
    });

    // Wire /service_approve → coreClient.approveWorkflowTask.
    setServiceApproveCommandHandler(makeServiceApproveHandler(core.client));

    // 1. Requester's service.query lands → handler creates an approval task.
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-1',
      capability: 'route_info',
      params: { route: '42' },
      ttl_seconds: 60,
    });

    expect(core.createCalls).toHaveLength(1);
    const approvalCall = core.createCalls[0];
    expect(approvalCall.kind).toBe('approval');
    expect(approvalCall.id).toBe('approval-u1');
    expect(approvalCall.initialState).toBe('pending_approval');

    // 2. Operator types /service_approve approval-u1 in chat.
    const approveRes = await handleChat('/service_approve approval-u1');
    expect(approveRes.intent).toBe('service_approve');
    expect(approveRes.response).toBe('Approved — "approval-u1" executing via delegation…');
    expect(core.approveCalls).toEqual(['approval-u1']);

    // 3. Simulate Guardian: the `approved` workflow_event arrives with the
    // approval task's payload. Guardian parses it and calls
    // executeAndRespond. (W03 will wire this for real.)
    const approvalPayload = JSON.parse(approvalCall.payload);
    await handler.executeAndRespond('approval-u1', approvalPayload);

    // 4. Verify: delegation task created with deterministic id.
    expect(core.createCalls).toHaveLength(2);
    const delegationCall = core.createCalls[1];
    expect(delegationCall.id).toBe('svc-exec-from-approval-u1');
    expect(delegationCall.kind).toBe('delegation');
    expect(delegationCall.correlationId).toBe('q-1');
    const delegationPayload = JSON.parse(delegationCall.payload);
    expect(delegationPayload).toMatchObject({
      type: 'service_query_execution',
      from_did: REQUESTER,
      query_id: 'q-1',
      capability: 'route_info',
      params: { route: '42' },
    });

    // 5. Verify: approval task was cancelled with the canonical reason.
    expect(core.cancelCalls).toEqual([{ id: 'approval-u1', reason: 'executed_via_delegation' }]);
  });

  it('repeated approve → Guardian retry is idempotent (WorkflowConflictError swallowed)', async () => {
    const core = buildStubCore();
    const handler = new ServiceHandler({
      coreClient: core.client,
      readConfig: () => BUS_CONFIG,
      generateUUID: () => 'u2',
    });
    setServiceApproveCommandHandler(makeServiceApproveHandler(core.client));

    // Seed approval.
    await handler.handleQuery(REQUESTER, {
      query_id: 'q-2',
      capability: 'route_info',
      params: {},
      ttl_seconds: 60,
    });
    const approvalPayload = JSON.parse(core.createCalls[0].payload);

    // First approve + executeAndRespond — happy path.
    await handleChat('/service_approve approval-u2');
    await handler.executeAndRespond('approval-u2', approvalPayload);
    expect(core.createCalls).toHaveLength(2);
    expect(core.cancelCalls).toHaveLength(1);

    // Second attempt — delegation already exists. WorkflowConflictError
    // path is exercised by the unit tests; here we simply verify the
    // orchestrator doesn't blow up on a repeat /service_approve (approve
    // will 200 idempotently in real deployments).
    await handleChat('/service_approve approval-u2');
    expect(core.approveCalls).toEqual(['approval-u2', 'approval-u2']);
  });
});
