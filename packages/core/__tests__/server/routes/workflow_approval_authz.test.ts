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
import { SessionRegistry, setSessionRegistry } from '../../../src/session/registry';
import {
  InMemoryVaultRepository,
  setVaultRepository,
  resetVaultRepositories,
} from '../../../src/vault/repository';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import {
  WorkflowService,
  getWorkflowService,
  setWorkflowService,
} from '../../../src/workflow/service';

const AGENT_DID = 'did:key:agentX';
let sessionId: string;

function build(): CoreRouter {
  const router = new CoreRouter();
  registerVaultRoutes(router);
  registerWorkflowRoutes(router);
  return router;
}

function agentQueryHealth(session: string = sessionId): CoreRequest {
  return {
    method: 'POST',
    path: '/v1/vault/query',
    query: { persona: 'health' },
    headers: {},
    body: { text: 'private health question', mode: 'fts5', session_id: session },
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
    const sessions = new SessionRegistry();
    sessionId = sessions.start({ agentDid: AGENT_DID, hostSessionId: 'workflow-authz-test' }).sessionId;
    setSessionRegistry(sessions);
    setAgentPersonaUnlockHook(null); // grant row alone gates the in-memory vault
  });
  afterEach(() => {
    resetVaultRepositories();
    resetPersonaState();
    setWorkflowService(null);
    setAgentGrantRepository(null);
    setSessionRegistry(null);
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
      getAgentGrantRepository()?.findActiveGrant(
        AGENT_DID,
        'health',
        'read',
        sessionId,
        Date.now(),
      ),
    ).toBe(null);
    const retry = await router.handle(agentQueryHealth());
    expect(retry.status).toBe(403);
  });

  it('round-15 #1/#2: a stale (already-queued) re-approve with scope=session returns 409', async () => {
    const router = build();
    const taskId = await newPendingApprovalTaskId(router);
    // First owner approve commits pending_approval → queued.
    expect((await router.handle(approveReq(taskId))).status).toBe(200);
    // A second owner approve with scope='session' is now STALE (task is queued,
    // not pending_approval) → 409. The session grant / staging drain are written
    // ONLY after a successful approve, so this stale path leaks nothing.
    const stale = await router.handle({ ...approveReq(taskId), body: { scope: 'session' } });
    expect(stale.status).toBe(409);
  });

  it('round-16 #1: with NO grant repo, an owner approve fails closed — no false success, task stays pending', async () => {
    const router = build();
    const taskId = await newPendingApprovalTaskId(router);
    setAgentGrantRepository(null); // simulate a missing durable grant store
    const approve = await router.handle(approveReq(taskId)); // owner (no callerType)
    // A 200 here would be a FALSE success: the task would be queued with no
    // authority and could never be re-approved. The grant is written BEFORE the
    // transition, so a missing repo blocks the approve and leaves it pending.
    expect(approve.status).not.toBe(200);
    expect(getWorkflowService()?.store().getById(taskId)?.status).toBe('pending_approval');
  });

  it('PLG-27 #1: a failed approve AFTER the grant is written compensates (revokes) the grant', async () => {
    const router = build();
    const taskId = await newPendingApprovalTaskId(router);
    // Force the transition to fail AFTER grantAgentPersonaAccessFromApproval has
    // written the durable grant. Without the compensating revoke this would leave
    // an ACTIVE grant for a task that was never approved (a denial that still
    // grants access). The handler must revoke the just-created grant on failure.
    const svc = getWorkflowService()!;
    const spy = jest.spyOn(svc, 'approve').mockImplementation(() => {
      throw new Error('transition failed');
    });
    try {
      const approve = await router.handle(approveReq(taskId)); // owner
      expect(approve.status).not.toBe(200);
      // The compensating revoke ran — no active grant survives the failed approve.
      expect(
        getAgentGrantRepository()?.findActiveGrant(
          AGENT_DID,
          'health',
          'read',
          sessionId,
          Date.now(),
        ),
      ).toBe(null);
      // The agent stays blocked on retry.
      expect((await router.handle(agentQueryHealth())).status).toBe(403);
    } finally {
      spy.mockRestore();
    }
  });

  it('PLG-32 #4: activate() THROWING after approval cancels the task + revokes the grant', async () => {
    const router = build();
    const taskId = await newPendingApprovalTaskId(router);
    // activate() THROWS (SQLITE_BUSY / I/O), not just returns false — the throw
    // used to escape AFTER the committed approval with no compensation, stranding
    // the task in queued (deduped onto forever). The handler must revoke + cancel.
    const grantRepo = getAgentGrantRepository()!;
    const spy = jest.spyOn(grantRepo, 'activate').mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    try {
      const approve = await router.handle(approveReq(taskId)); // owner
      expect(approve.status).not.toBe(200);
      // Terminal (cancelled), NOT a stranded 'queued' zombie the agent re-dedupes.
      expect(getWorkflowService()?.store().getById(taskId)?.status).toBe('cancelled');
      // No active grant survived the throw.
      expect(
        grantRepo.findActiveGrant(AGENT_DID, 'health', 'read', sessionId, Date.now()),
      ).toBe(null);
    } finally {
      spy.mockRestore();
    }
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
      getAgentGrantRepository()?.findActiveGrant(
        AGENT_DID,
        'health',
        'read',
        sessionId,
        Date.now(),
      ),
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

  it('agent persona-access approval tasks preserve the signed session id', async () => {
    const router = build();
    const gate = await router.handle(agentQueryHealth());
    expect(gate.status).toBe(403);
    const taskId = (gate.body as { task_id?: string }).task_id;
    expect(taskId).toBeTruthy();

    const task = getWorkflowService()
      ?.store()
      .getById(taskId as string);
    expect(task?.session_name).toBe(sessionId);
  });
});
