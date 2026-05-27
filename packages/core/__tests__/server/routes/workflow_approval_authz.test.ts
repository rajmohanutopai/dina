/**
 * SEC — an out-of-process `agent` caller must never approve or deny a workflow
 * task. Approving an `agent_persona_access` request writes a durable grant AND
 * unlocks the persona, and approving an `intent_validation` proposal clears the
 * Agent-Gateway review — so a self-approve would defeat both the persona gate
 * and the Agent Gateway. `ownerDecisionGuard` (server/routes/workflow.ts) blocks
 * `agent` on /approve + /cancel while leaving brain/device/admin (the
 * /service_approve chat command + the app approval UI) working.
 *
 * Drives the full exploit chain through the REAL vault + workflow routers.
 */

import { setAgentPersonaUnlockHook } from '../../../src/agent/access';
import {
  InMemoryAgentGrantRepository,
  setAgentGrantRepository,
  getAgentGrantRepository,
} from '../../../src/agent/grant_repository';
import { resetAuditState } from '../../../src/audit/service';
import { createPersona, resetPersonaState } from '../../../src/persona/service';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerVaultRoutes } from '../../../src/server/routes/vault';
import { registerWorkflowRoutes } from '../../../src/server/routes/workflow';
import {
  InMemoryVaultRepository,
  setVaultRepository,
  resetVaultRepositories,
} from '../../../src/vault/repository';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../../src/workflow/service';

const AGENT_DID = 'did:key:agentX';

function build(): CoreRouter {
  const router = new CoreRouter();
  registerVaultRoutes(router);
  registerWorkflowRoutes(router);
  return router;
}

function agentQueryHealth(): CoreRequest {
  return {
    method: 'POST',
    path: '/v1/vault/query',
    query: { persona: 'health' },
    headers: {},
    body: { text: 'private health question', mode: 'fts5' },
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'agent',
    callerDID: AGENT_DID,
  };
}

function approveReq(taskId: string, callerType?: string): CoreRequest {
  return {
    method: 'POST',
    path: `/v1/workflow/tasks/${taskId}/approve`,
    query: {},
    headers: {},
    body: {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:owner' } : {}),
  };
}

function cancelReq(taskId: string, callerType: string): CoreRequest {
  return { ...approveReq(taskId, callerType), path: `/v1/workflow/tasks/${taskId}/cancel` };
}

async function newPendingApprovalTaskId(router: CoreRouter): Promise<string> {
  const gate = await router.handle(agentQueryHealth());
  expect(gate.status).toBe(403);
  const taskId = (gate.body as { task_id?: string }).task_id;
  expect(taskId).toBeTruthy();
  return taskId as string;
}

describe('workflow approve/deny — agent callers are refused (no self-approval)', () => {
  beforeEach(() => {
    resetVaultRepositories();
    setVaultRepository('health', new InMemoryVaultRepository());
    resetPersonaState();
    resetAuditState();
    createPersona('health', 'sensitive');
    setWorkflowService(new WorkflowService({ repository: new InMemoryWorkflowRepository() }));
    setAgentGrantRepository(new InMemoryAgentGrantRepository());
    setAgentPersonaUnlockHook(null); // grant row alone gates the in-memory vault
  });
  afterEach(() => {
    resetVaultRepositories();
    resetPersonaState();
    setWorkflowService(null);
    setAgentGrantRepository(null);
    setAgentPersonaUnlockHook(null);
  });

  it('an AGENT cannot approve its OWN persona-access task → 403, no grant written', async () => {
    const router = build();
    const taskId = await newPendingApprovalTaskId(router);

    const approve = await router.handle(approveReq(taskId, 'agent'));
    expect(approve.status).toBe(403);
    expect((approve.body as { error?: string }).error).toBe('access_denied');
    expect((approve.body as { reason?: string }).reason).toMatch(/cannot approve or deny/);

    // The grant was NOT written — the agent stays blocked on retry.
    expect(
      getAgentGrantRepository()?.findActiveGrant(AGENT_DID, 'health', 'read', Date.now()),
    ).toBe(null);
    const retry = await router.handle(agentQueryHealth());
    expect(retry.status).toBe(403);
  });

  it('an AGENT cannot cancel/deny a task either → 403', async () => {
    const router = build();
    const taskId = await newPendingApprovalTaskId(router);
    const cancel = await router.handle(cancelReq(taskId, 'agent'));
    expect(cancel.status).toBe(403);
    expect((cancel.body as { error?: string }).error).toBe('access_denied');
  });

  it('the OWNER (in-process app, no callerType) CAN approve → grant written, agent then reads', async () => {
    const router = build();
    const taskId = await newPendingApprovalTaskId(router);

    const approve = await router.handle(approveReq(taskId)); // no callerType → owner
    expect(approve.status).toBe(200);

    expect(
      getAgentGrantRepository()?.findActiveGrant(AGENT_DID, 'health', 'read', Date.now()),
    ).not.toBe(null);
    const retry = await router.handle(agentQueryHealth());
    expect(retry.status).toBe(200);
  });

  it('a paired DEVICE caller (app approval UI) may approve', async () => {
    const router = build();
    const taskId = await newPendingApprovalTaskId(router);
    const approve = await router.handle(approveReq(taskId, 'device'));
    expect(approve.status).toBe(200);
  });
});
