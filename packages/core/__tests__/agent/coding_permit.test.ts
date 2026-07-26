/**
 * Item B (Codex review — permit execution-seam redemption), Core side.
 *
 * Covers the pure `coding_permit` module (payload validation, idempotent card
 * creation, mint fail-closed) AND the end-to-end Core loop: the `/v1/agent/gate`
 * route creates an owner-approval card for a HIGH call, and approving
 * that card through the workflow route mints the permit via the injected
 * authority. The Node-side redemption half is proven in the core-server
 * `coding_gate_impl` test; here the injected authority is a recording double.
 */

import {
  CODING_GATE_APPROVAL_TYPE,
  createCodingGateApproval,
  isCodingGateApproval,
  mintApprovedCodingPermit,
  parseCodingGateApprovalPayload,
  redeemApprovedCodingGateApproval,
  setCodingPermitAuthority,
  type CodingPermitClaim,
} from '../../src/agent/coding_permit';
import { resetAuditState } from '../../src/audit/service';
import { CoreRouter, type CoreRequest } from '../../src/server/router';
import { registerCodingGateRoutes, type CodingGateFn } from '../../src/server/routes/coding_gate';
import { registerWorkflowRoutes } from '../../src/server/routes/workflow';
import { SessionRegistry, setSessionRegistry } from '../../src/session/registry';
import { InMemoryWorkflowRepository } from '../../src/workflow/repository';
import { WorkflowService, setWorkflowService } from '../../src/workflow/service';

// A recording permit-authority double: real minting is proven Node-side.
function recorder() {
  const claims: CodingPermitClaim[] = [];
  return {
    claims,
    authority: { mintApproved: (c: CodingPermitClaim) => void claims.push(c) },
  };
}

describe('parseCodingGateApprovalPayload', () => {
  const good = JSON.stringify({
    type: CODING_GATE_APPROVAL_TYPE,
    agent_did: 'did:key:z6MkAgent',
    session: 's1',
    effective_profile: 'sensitive_boundaries',
    policy_version: 3,
    authority_origin: 'owner_interactive',
    action: 'vcs_push',
    risk: 'MODERATE',
    payload_hash: 'a'.repeat(64),
    tool: 'Bash',
  });

  it('accepts a well-formed payload', () => {
    const p = parseCodingGateApprovalPayload(good);
    expect(p).not.toBeNull();
    expect(p?.action).toBe('vcs_push');
    expect(p?.risk).toBe('MODERATE');
  });

  it('rejects a bad discriminator, risk, or hash', () => {
    expect(
      parseCodingGateApprovalPayload(JSON.stringify({ ...JSON.parse(good), type: 'x' })),
    ).toBeNull();
    expect(
      parseCodingGateApprovalPayload(JSON.stringify({ ...JSON.parse(good), risk: 'NOPE' })),
    ).toBeNull();
    expect(
      parseCodingGateApprovalPayload(
        JSON.stringify({ ...JSON.parse(good), payload_hash: 'short' }),
      ),
    ).toBeNull();
    expect(
      parseCodingGateApprovalPayload(
        JSON.stringify({ ...JSON.parse(good), payload_hash: 'A'.repeat(64) }),
      ),
    ).toBeNull(); // upper-case hex
    expect(
      parseCodingGateApprovalPayload(JSON.stringify({ ...JSON.parse(good), agent_did: '' })),
    ).toBeNull();
    expect(parseCodingGateApprovalPayload('not json')).toBeNull();
    expect(parseCodingGateApprovalPayload(null)).toBeNull();
  });

  it('rejects control / bidi chars in rendered fields', () => {
    expect(
      parseCodingGateApprovalPayload(JSON.stringify({ ...JSON.parse(good), tool: 'Ba\u202esh' })),
    ).toBeNull();
    expect(
      parseCodingGateApprovalPayload(
        JSON.stringify({ ...JSON.parse(good), agent_did: 'did:\u0000evil' }),
      ),
    ).toBeNull();
  });
});

describe('createCodingGateApproval + mintApprovedCodingPermit (unit)', () => {
  let repo: InMemoryWorkflowRepository;
  beforeEach(() => {
    repo = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: repo }));
    resetAuditState();
    setCodingPermitAuthority(null);
  });
  afterEach(() => {
    setWorkflowService(null);
    setCodingPermitAuthority(null);
  });

  const params = {
    agentDid: 'did:key:z6MkAgent',
    sessionId: 's1',
    effectiveProfile: 'sensitive_boundaries' as const,
    policyVersion: 3,
    authorityOrigin: 'owner_interactive' as const,
    payloadHash: 'b'.repeat(64),
    tool: 'Bash',
    action: 'vcs_push',
    risk: 'MODERATE' as const,
  };

  it('creates a pending_approval task; identical params are idempotent', () => {
    const a = createCodingGateApproval(params);
    expect(a.kind).toBe('approval_required');
    const b = createCodingGateApproval(params);
    expect(b).toEqual(a); // same card, not a duplicate
    const task = repo.getById((a as { taskId: string }).taskId);
    expect(task).not.toBeNull();
    expect(isCodingGateApproval(task)).toBe(true);
    expect(task?.origin).toBe('agent'); // COLD-1: only the owner may decide it
  });

  it('fails closed when no workflow service is wired', () => {
    setWorkflowService(null);
    expect(createCodingGateApproval(params).kind).toBe('unavailable');
  });

  it('mintApprovedCodingPermit forwards the exact claim to the authority', () => {
    const rec = recorder();
    setCodingPermitAuthority(rec.authority);
    const a = createCodingGateApproval(params) as { taskId: string };
    const task = repo.getById(a.taskId)!;
    expect(mintApprovedCodingPermit(task)).toBe(true);
    expect(rec.claims).toHaveLength(1);
    expect(rec.claims[0]).toEqual({
      agentDid: params.agentDid,
      sessionId: params.sessionId,
      effectiveProfile: params.effectiveProfile,
      policyVersion: params.policyVersion,
      authorityOrigin: params.authorityOrigin,
      payloadHash: params.payloadHash,
      action: params.action,
      risk: params.risk,
    });
  });

  it('mintApprovedCodingPermit is false when no authority is wired', () => {
    const a = createCodingGateApproval(params) as { taskId: string };
    expect(mintApprovedCodingPermit(repo.getById(a.taskId)!)).toBe(false);
  });

  it('redeems an approved task once using its durable payload binding', () => {
    const a = createCodingGateApproval(params) as { taskId: string };
    new WorkflowService({ repository: repo }).approve(a.taskId);

    expect(redeemApprovedCodingGateApproval(params)).toEqual({
      kind: 'redeemed',
      taskId: a.taskId,
    });
    expect(repo.getById(a.taskId)?.status).toBe('completed');
    expect(redeemApprovedCodingGateApproval(params)).toEqual({ kind: 'not_ready' });
  });
});

// The full Core loop: gate route → card → workflow approve → permit minted.
describe('coding-gate approval loop (route + workflow approve)', () => {
  let repo: InMemoryWorkflowRepository;
  let router: CoreRouter;
  let rec: ReturnType<typeof recorder>;

  // A stub gate: any tool named "Risky" is HIGH/approval_required with a
  // fixed payload hash; the fs-backed classifier is proven separately.
  const stubGate: CodingGateFn = (input) => {
    if (input.toolName === 'Risky') {
      return {
        action: 'vcs_push',
        risk: 'HIGH',
        outcome: 'approval_required',
        enforced: true,
        payloadHash: 'c'.repeat(64),
        reason: 'risky',
      };
    }
    if (input.toolName === 'Moderate') {
      return {
        action: 'vcs_push',
        risk: 'MODERATE',
        outcome: 'approval_required',
        enforced: true,
        payloadHash: 'd'.repeat(64),
        reason: 'confirm locally',
      };
    }
    return {
      action: 'code_read',
      risk: 'SAFE',
      outcome: 'allow',
      enforced: true,
      permitId: 'p',
      reason: 'ok',
    };
  };

  beforeEach(() => {
    repo = new InMemoryWorkflowRepository();
    setWorkflowService(new WorkflowService({ repository: repo }));
    resetAuditState();
    rec = recorder();
    setCodingPermitAuthority(rec.authority);
    setSessionRegistry(new SessionRegistry());
    router = new CoreRouter();
    registerCodingGateRoutes(router, stubGate);
    registerWorkflowRoutes(router);
  });
  afterEach(() => {
    setWorkflowService(null);
    setCodingPermitAuthority(null);
    setSessionRegistry(null);
  });

  function gateReq(toolName = 'Risky', approvalSurface: 'host' | 'owner' = 'host'): CoreRequest {
    const body = {
      tool_name: toolName,
      tool_input: { x: 'y' },
      mode: 'enforce',
      approval_surface: approvalSurface,
      host_session_id: 'coding-permit-test',
    };
    return {
      method: 'POST',
      path: '/v1/agent/gate',
      headers: {},
      query: {},
      body,
      rawBody: new TextEncoder().encode(JSON.stringify(body)),
      params: {},
      trustedInProcess: true,
      callerType: 'agent',
      callerDID: 'did:key:z6MkAgent',
    } as unknown as CoreRequest;
  }
  function ownerApprove(taskId: string): CoreRequest {
    return {
      method: 'POST',
      path: `/v1/workflow/tasks/${taskId}/approve`,
      headers: {},
      query: {},
      body: {},
      rawBody: new Uint8Array(),
      params: { id: taskId },
      trustedInProcess: true, // owner (no callerType) — COLD-1 lets the owner decide
    } as unknown as CoreRequest;
  }

  it('HIGH → approval card; approval survives restart and redeems exactly once', async () => {
    const g1 = await router.handle(gateReq());
    expect(g1.status).toBe(200);
    const b1 = g1.body as { outcome: string; task_id: string | null };
    expect(b1.outcome).toBe('approval_required');
    expect(b1.task_id).toBeTruthy();

    // Idempotent: a retry before approval reuses the same card.
    const g2 = await router.handle(gateReq());
    expect((g2.body as { task_id: string }).task_id).toBe(b1.task_id);

    // Owner approves → the injected authority mints the payload-bound permit.
    const ap = await router.handle(ownerApprove(b1.task_id as string));
    expect(ap.status).not.toBe(403);
    expect(ap.status).toBeLessThan(300);
    expect(rec.claims).toHaveLength(1);
    expect(rec.claims[0]).toMatchObject({
      agentDid: 'did:key:z6MkAgent',
      payloadHash: 'c'.repeat(64),
      action: 'vcs_push',
      risk: 'HIGH',
    });

    // Simulate a Core restart: the transient permit authority/store is gone,
    // but the durable queued workflow receipt remains. The next identical call
    // still wins exactly once.
    setCodingPermitAuthority(null);
    const afterRestart = new CoreRouter();
    registerCodingGateRoutes(afterRestart, stubGate);
    registerWorkflowRoutes(afterRestart);

    const redeemed = await afterRestart.handle(gateReq());
    expect(redeemed.status).toBe(200);
    expect(redeemed.body).toMatchObject({
      outcome: 'allow',
      risk: 'HIGH',
      permit_id: `workflow:${b1.task_id}`,
      task_id: null,
    });
    expect(repo.getById(b1.task_id as string)?.status).toBe('completed');

    // The receipt is terminal. A second identical call creates a fresh card
    // rather than replaying the prior approval.
    const spent = await afterRestart.handle(gateReq());
    expect(spent.body).toMatchObject({
      outcome: 'approval_required',
      risk: 'HIGH',
    });
    expect((spent.body as { task_id: string }).task_id).not.toBe(b1.task_id);
  });

  it('MODERATE → host confirmation only; no durable Dina task', async () => {
    const result = await router.handle(gateReq('Moderate'));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: 'approval_required',
      risk: 'MODERATE',
      task_id: null,
    });
  });

  it('MODERATE → durable Dina task when the host cannot ask locally', async () => {
    const result = await router.handle(gateReq('Moderate', 'owner'));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: 'approval_required',
      risk: 'MODERATE',
    });
    const taskId = (result.body as { task_id: string | null }).task_id;
    expect(taskId).toBeTruthy();
    expect(repo.getById(taskId as string)?.status).toBe('pending_approval');
  });

  it('fails closed: approving a coding card with NO authority wired does not commit', async () => {
    const g1 = await router.handle(gateReq());
    const taskId = (g1.body as { task_id: string }).task_id;

    setCodingPermitAuthority(null); // authority went away
    const ap = await router.handle(ownerApprove(taskId));
    expect(ap.status).toBeGreaterThanOrEqual(400);
    // The task must remain pending (never approved) so the owner can re-decide.
    expect(repo.getById(taskId)?.status).toBe('pending_approval');
    expect(rec.claims).toHaveLength(0);
  });
});
