/**
 * Deterministic agent persona-access gate (issues.txt §2).
 *
 * The safety contract: a sensitive/locked persona with no grant yields
 * `approval_required` (a durable workflow task) and the caller must NOT
 * read the vault; approval writes a durable grant; the grant is bound to
 * the exact agent DID + persona + mode + expiry; deny/expire keep data
 * sealed. The approval card never carries vault content.
 */

import {
  AGENT_PERSONA_ACCESS_APPROVAL_TYPE,
  DEFAULT_GRANT_TTL_MS,
  grantAgentPersonaAccessFromApproval,
  isAgentPersonaAccessApproval,
  requireAgentPersonaAccess,
  setAgentPersonaUnlockHook,
} from '../../src/agent/access';
import {
  InMemoryAgentGrantRepository,
  setAgentGrantRepository,
} from '../../src/agent/grant_repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowTaskState } from '../../src/workflow/domain';
import { createPersona, resetPersonaState } from '../../src/persona/service';
import { queryAudit, resetAuditState } from '../../src/audit/service';

const AGENT_A = 'did:key:agentA';
const AGENT_B = 'did:key:agentB';

let workflowRepo: InMemoryWorkflowRepository;
let grantRepo: InMemoryAgentGrantRepository;

beforeEach(() => {
  resetPersonaState();
  resetAuditState();
  createPersona('general', 'default');
  createPersona('health', 'sensitive');
  createPersona('finance', 'locked');
  workflowRepo = new InMemoryWorkflowRepository();
  setWorkflowService(new WorkflowService({ repository: workflowRepo }));
  grantRepo = new InMemoryAgentGrantRepository();
  setAgentGrantRepository(grantRepo);
});

afterEach(() => {
  setWorkflowService(null);
  setAgentGrantRepository(null);
  setAgentPersonaUnlockHook(null);
  resetPersonaState();
});

describe('requireAgentPersonaAccess', () => {
  it('allows a free tier (default) without any grant', () => {
    const d = requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'general', mode: 'read', scope: 'hi' });
    expect(d.kind).toBe('allow');
  });

  it('requires approval for a sensitive persona with no grant — and never reads the vault', () => {
    const d = requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'health', mode: 'read', scope: 'meds' });
    expect(d.kind).toBe('approval_required');
    if (d.kind !== 'approval_required') throw new Error('unreachable');
    const task = workflowRepo.getById(d.taskId);
    expect(task?.status).toBe(WorkflowTaskState.PendingApproval);
    expect(isAgentPersonaAccessApproval(task)).toBe(true);
  });

  it('requires approval for a locked persona too', () => {
    const d = requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'finance', mode: 'read', scope: 'balance' });
    expect(d.kind).toBe('approval_required');
  });

  it('is idempotent — a repeated request returns the same pending task, no duplicate card', () => {
    const d1 = requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'health', mode: 'read', scope: 'meds' });
    const d2 = requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'health', mode: 'read', scope: 'meds again' });
    expect(d1).toEqual(d2);
    const pending = workflowRepo.listByKindAndState('approval', WorkflowTaskState.PendingApproval, 100);
    expect(pending.length).toBe(1);
  });

  it('the approval card carries the request scope but NO vault content', () => {
    const secretQuery = 'what is my HIV medication dosage';
    const d = requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'health', mode: 'read', scope: secretQuery });
    if (d.kind !== 'approval_required') throw new Error('expected approval');
    const task = workflowRepo.getById(d.taskId)!;
    // Description names actor/persona/mode only — never the query/result.
    expect(task.description).not.toContain(secretQuery);
    expect(task.description).toContain('health');
    const payload = JSON.parse(task.payload);
    expect(payload.type).toBe(AGENT_PERSONA_ACCESS_APPROVAL_TYPE);
    expect(payload.agent_did).toBe(AGENT_A);
    expect(payload.persona).toBe('health');
    // The scope (the agent's *request*) may be stored; vault *results* never are.
    expect(payload.scope).toBe(secretQuery);
    expect(payload).not.toHaveProperty('result');
    expect(payload).not.toHaveProperty('items');
  });

  it('fails CLOSED (denied) when no workflow service can record the approval', () => {
    setWorkflowService(null);
    const d = requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'health', mode: 'read', scope: 'x' });
    expect(d.kind).toBe('denied');
  });

  it('audits the request', () => {
    requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'health', mode: 'read', scope: 'meds' });
    const reqs = queryAudit({ action: 'agent_access_request' });
    expect(reqs.length).toBe(1);
    expect(reqs[0].actor).toBe(AGENT_A);
  });
});

describe('approve → durable grant → resume', () => {
  function pendingTaskFor(agent: string, persona: string): string {
    const d = requireAgentPersonaAccess({ agentDID: agent, persona, mode: 'read', scope: 'q' });
    if (d.kind !== 'approval_required') throw new Error('expected approval');
    return d.taskId;
  }

  it('grant persists on approval, and the agent then passes the gate (resume)', async () => {
    const taskId = pendingTaskFor(AGENT_A, 'health');
    // Before approval: still gated.
    expect(requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'health', mode: 'read', scope: 'q' }).kind).toBe(
      'approval_required',
    );
    // Approve → write durable grant (mirrors the workflow approve handler).
    const task = workflowRepo.getById(taskId)!;
    const grant = await grantAgentPersonaAccessFromApproval(task, 1_000);
    expect(grant).not.toBeNull();
    expect(grantRepo.findActiveGrant(AGENT_A, 'health', 'read', 2_000)?.id).toBe(grant!.id);
    // Now the agent's retry is allowed.
    const after = requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'health', mode: 'read', scope: 'q', now: 2_000 });
    expect(after.kind).toBe('allow');
    // Audit trail: request + approved + (granted on the allow read).
    expect(queryAudit({ action: 'agent_access_approved' }).length).toBe(1);
    expect(queryAudit({ action: 'agent_access_granted' }).length).toBe(1);
  });

  it('the grant is bound to the approving agent — another agent stays gated', async () => {
    const taskId = pendingTaskFor(AGENT_A, 'health');
    await grantAgentPersonaAccessFromApproval(workflowRepo.getById(taskId)!, 1_000);
    const other = requireAgentPersonaAccess({ agentDID: AGENT_B, persona: 'health', mode: 'read', scope: 'q', now: 2_000 });
    expect(other.kind).toBe('approval_required'); // B never got a grant
  });

  it('the grant is bound to its persona — it does not unlock a different sensitive persona', async () => {
    const taskId = pendingTaskFor(AGENT_A, 'health');
    await grantAgentPersonaAccessFromApproval(workflowRepo.getById(taskId)!, 1_000);
    const finance = requireAgentPersonaAccess({ agentDID: AGENT_A, persona: 'finance', mode: 'read', scope: 'q', now: 2_000 });
    expect(finance.kind).toBe('approval_required'); // health grant ≠ finance access
  });

  it('an expired grant re-gates the agent', async () => {
    const taskId = pendingTaskFor(AGENT_A, 'health');
    await grantAgentPersonaAccessFromApproval(workflowRepo.getById(taskId)!, 1_000);
    const afterExpiry = requireAgentPersonaAccess({
      agentDID: AGENT_A,
      persona: 'health',
      mode: 'read',
      scope: 'q',
      now: 1_000 + DEFAULT_GRANT_TTL_MS + 1,
    });
    expect(afterExpiry.kind).toBe('approval_required');
  });

  it('denial (no approval) leaves no grant — data stays sealed', () => {
    pendingTaskFor(AGENT_A, 'health');
    // Never approve. No grant should exist.
    expect(grantRepo.findActiveGrant(AGENT_A, 'health', 'read', 2_000)).toBeNull();
  });

  it('approving AWAITS the persona-unlock hook so the DEK is resident before resume (issues.txt §2)', async () => {
    // Async hook with a real microtask delay — proves the grant call AWAITS
    // it (a fire-and-forget would let the assertion run before unlock).
    const unlocked: string[] = [];
    setAgentPersonaUnlockHook(async (p) => {
      await new Promise((r) => setTimeout(r, 5));
      unlocked.push(p);
    });
    const taskId = pendingTaskFor(AGENT_A, 'finance'); // locked tier
    await grantAgentPersonaAccessFromApproval(workflowRepo.getById(taskId)!, 1_000);
    // If the unlock weren't awaited, `unlocked` would still be empty here.
    expect(unlocked).toEqual(['finance']);
  });
});
