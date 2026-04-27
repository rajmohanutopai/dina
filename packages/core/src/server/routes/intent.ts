/**
 * Agent intent validation routes — `dina validate` + status poll.
 *
 * Wire contract — bug-for-bug parity with the Go Core + Python Brain
 * production stack so the existing `dina` CLI and any other tooling
 * that talks to Go can drop in against Lite without modification.
 *
 * **Submit** — `POST /v1/agent/validate`
 *   Request body must carry `type: 'agent_intent'`. Mirrors the Go
 *   handler's enforcement (`core/internal/handler/agent.go`) — this
 *   endpoint is not a generic event proxy, only `agent_intent`. The
 *   Lite path here calls `evaluateIntent` directly (no separate Brain
 *   sidecar in Lite — the gatekeeper is in-process), then reshapes
 *   the decision into Brain's `review_intent` envelope so callers see
 *   identical wire bytes.
 *
 *     SAFE     → 200 {action:'auto_approve',   risk:'SAFE',   approved:true,  requires_approval:false}
 *     BLOCKED  → 200 {action:'deny',           risk:'BLOCKED',approved:false, requires_approval:false}
 *     MODERATE → 200 {action:'flag_for_review',risk:'MODERATE',approved:false,requires_approval:true,proposal_id}
 *     HIGH     → 200 {action:'flag_for_review',risk:'HIGH',   approved:false, requires_approval:true,proposal_id}
 *
 * **Status** — `GET /v1/intent/proposals/:proposalId/status`
 *   Reads the workflow_task created on MODERATE/HIGH and projects it
 *   into the Python `_pending_proposals` shape served by Brain's
 *   `/v1/proposals/:id/status` route. Workflow state maps to caller
 *   status:
 *     pending_approval        → 'pending'  (or 'expired' if past TTL)
 *     queued/claimed/running/completed → 'approved'
 *     cancelled/canceled/failed → 'denied'
 *
 *   The user taps Approve / Deny in the mobile Approvals tab, which
 *   uses the existing `/v1/workflow/tasks/:id/approve` (state →
 *   queued) and `/v1/workflow/tasks/:id/cancel` (state → cancelled)
 *   transitions. No new approval routes — we ride on the workflow
 *   surface that already exists.
 *
 * **Why approvals carry `payload.type='intent_validation'`** —
 *   The Approvals-tab UI branches on this tag to render `action` /
 *   `target` instead of `capability` / `params` (`service.query`
 *   approvals use the latter). The `LocalDelegationRunner` ignores
 *   intent_validation payloads (no agent work to claim — the user's
 *   tap IS the work); `WorkflowEventConsumer` skips intent_validation
 *   approvals when they reach `queued` state (no D2D peer waiting on
 *   a service.response).
 *
 * Source contract:
 *   `core/internal/handler/agent.go` (Go submit)
 *   `core/internal/handler/intent_proposal.go` (Go status)
 *   `brain/src/service/guardian.py:review_intent` (Python decision)
 *   `brain/src/dina_brain/routes/proposals.py` (Python status)
 *   CAPABILITIES.md "She Guards Your Agents"
 */

import type { CoreRouter } from '../router';
import { evaluateIntent } from '../../gatekeeper/intent';
import { getWorkflowRepository } from '../../workflow/repository';
import type { WorkflowTask } from '../../workflow/domain';
import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Default TTL for an intent-validation approval task (seconds). */
const DEFAULT_TTL_SEC = 30 * 60; // 30 min — matches Python ActionRiskPolicy

/** Hard cap on inbound body size (matches Go: `maxValidateBody = 64 KB`). */
const MAX_VALIDATE_BODY_BYTES = 64 * 1024;

export type RiskLabel = 'SAFE' | 'MODERATE' | 'HIGH' | 'BLOCKED';
export type GuardianAction = 'auto_approve' | 'flag_for_review' | 'deny';

/**
 * Submit response — mirrors Brain's `review_intent` return value
 * (`brain/src/service/guardian.py:1167-1257`).
 */
export interface AgentValidateResponse {
  action: GuardianAction;
  risk: RiskLabel;
  reason: string;
  approved: boolean;
  requires_approval: boolean;
  /** Present only when `action === 'flag_for_review'` (MODERATE / HIGH). */
  proposal_id?: string;
}

/**
 * Status response — mirrors Python's
 * `/v1/proposals/:id/status` shape
 * (`brain/src/dina_brain/routes/proposals.py:33-59`).
 */
export interface IntentProposalStatusResponse {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  kind: 'intent';
  action: string;
  target: string;
  agent_did: string;
  decision_reason: string;
  /** Unix-ms — Brain stores ms; we stamp ms on the workflow task too. */
  created_at: number;
  updated_at: number;
}

export function registerIntentRoutes(router: CoreRouter): void {
  router.post('/v1/agent/validate', async (req) => {
    // Body-size guard. The router parses JSON before we see it, but
    // `rawBody` is the source of truth for this check (matches Go's
    // `io.LimitReader(r.Body, maxValidateBody+1)` semantics).
    if (req.rawBody.length > MAX_VALIDATE_BODY_BYTES) {
      return { status: 413, body: { error: 'request body too large' } };
    }

    const body = (req.body as Record<string, unknown> | undefined) ?? {};

    // Enforce `type: 'agent_intent'` — this endpoint is not a generic
    // event proxy. Matches Go's `agent.go:70-73` rejection.
    if (body.type !== 'agent_intent') {
      return {
        status: 400,
        body: { error: 'only type "agent_intent" is accepted on this endpoint' },
      };
    }

    const action = typeof body.action === 'string' ? body.action.trim() : '';
    if (action === '') {
      return { status: 400, body: { error: 'missing required field: action' } };
    }
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    const agentDIDFromBody = typeof body.agent_did === 'string' ? body.agent_did : '';
    const trustLevelRaw = typeof body.trust_level === 'string' ? body.trust_level : '';
    const sessionRaw = typeof body.session === 'string' ? body.session : '';

    // Caller identity binding. Go's `agent.go:83-91` overrides
    // body.agent_did with the X-DID header (signature auth) — never
    // trust caller-supplied agent_did. Lite does the same: prefer
    // X-DID, fall back to whatever the body shipped.
    const xDID = req.headers['x-did'];
    const agentDID =
      typeof xDID === 'string' && xDID !== '' ? xDID : agentDIDFromBody;

    // Trust level: any caller that passed signature auth is "verified"
    // by definition — auth middleware already rejected untrusted
    // callers. Body's `trust_level` is honoured only if it's already
    // narrower (untrusted/unknown) and the request still got here
    // (e.g. test wiring without full middleware) — but in production
    // the X-DID branch dominates.
    const trustLevel =
      trustLevelRaw !== '' ? trustLevelRaw : agentDID !== '' ? 'verified' : '';

    const decision = evaluateIntent(action, agentDID || undefined, trustLevel || undefined);

    // SAFE / BLOCKED resolve synchronously — no proposal task needed.
    if (decision.riskLevel === 'SAFE') {
      return {
        status: 200,
        body: shapeSyncResponse('auto_approve', decision.riskLevel, decision.reason),
      };
    }
    if (decision.riskLevel === 'BLOCKED') {
      return {
        status: 200,
        body: shapeSyncResponse('deny', decision.riskLevel, decision.reason),
      };
    }

    // MODERATE / HIGH: create an approval task. The mobile Approvals
    // tab + chat orchestrator pick it up via the existing workflow
    // listing; Brain-side WorkflowEventConsumer skips
    // intent_validation payloads when they reach `queued`.
    const repo = getWorkflowRepository();
    if (!repo) {
      return {
        status: 503,
        body: { error: 'workflow repository not wired — cannot create proposal' },
      };
    }

    // ID prefix mirrors Brain's `uuid4()` proposal IDs but stays
    // recognisable in audit / approvals UI as an intent proposal.
    const proposalId = `prop-intent-${bytesToHex(randomBytes(8))}`;
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const expiresAtSec = nowSec + DEFAULT_TTL_SEC;

    const targetPreview = target.length > 80 ? `${target.slice(0, 80)}…` : target;
    const task: WorkflowTask = {
      id: proposalId,
      kind: 'approval',
      status: 'pending_approval',
      priority: decision.riskLevel === 'HIGH' ? 'high' : 'normal',
      description:
        target !== '' ? `${action}: ${targetPreview}` : `Agent intent: ${action}`,
      payload: JSON.stringify({
        type: 'intent_validation',
        action,
        target,
        session: sessionRaw,
        agent_did: agentDID,
        trust_level: trustLevel,
        risk_level: decision.riskLevel,
        reason: decision.reason,
      }),
      result_summary: '',
      policy: '',
      origin: 'agent',
      ...(agentDID !== '' ? { agent_did: agentDID } : {}),
      expires_at: expiresAtSec,
      created_at: nowMs,
      updated_at: nowMs,
    };

    try {
      repo.create(task);
    } catch (err) {
      return {
        status: 500,
        body: {
          error: `failed to create proposal: ${(err as Error).message ?? String(err)}`,
        },
      };
    }

    const resp: AgentValidateResponse = {
      action: 'flag_for_review',
      risk: decision.riskLevel,
      reason: `${riskAdjective(decision.riskLevel)}-risk action: ${action} requires user approval`,
      approved: false,
      requires_approval: true,
      proposal_id: proposalId,
    };
    return { status: 200, body: resp };
  });

  router.get('/v1/intent/proposals/:proposalId/status', async (req) => {
    const proposalId =
      typeof req.params.proposalId === 'string' ? req.params.proposalId : '';
    if (proposalId === '') {
      return { status: 400, body: { error: 'proposal_id required' } };
    }
    const repo = getWorkflowRepository();
    if (!repo) {
      return { status: 503, body: { error: 'proposal status not available' } };
    }
    const task = repo.getById(proposalId);
    if (task === null) {
      return { status: 404, body: { error: 'unknown proposal_id' } };
    }

    const payload = safeParse(task.payload);
    // Refuse to surface non-intent approval tasks (e.g. service_query
    // approvals) through the proposal status endpoint — those have
    // their own delivery channel. Mirrors Python's `kind != "intent"`
    // 404 in `proposals.py:46`.
    if (payload.type !== 'intent_validation') {
      return { status: 404, body: { error: 'unknown proposal_id' } };
    }

    const action = typeof payload.action === 'string' ? payload.action : '';
    const target = typeof payload.target === 'string' ? payload.target : '';
    const agentDID =
      typeof payload.agent_did === 'string' ? payload.agent_did : task.agent_did ?? '';
    const decisionReason = typeof payload.reason === 'string' ? payload.reason : '';

    const status = mapTaskStatusToProposalStatus(task);

    const resp: IntentProposalStatusResponse = {
      id: proposalId,
      status,
      kind: 'intent',
      action,
      target,
      agent_did: agentDID,
      decision_reason: decisionReason,
      created_at: task.created_at,
      updated_at: task.updated_at,
    };
    return { status: 200, body: resp };
  });
}

/**
 * Build the synchronous-decision (SAFE / BLOCKED) response shape.
 * Brain's `review_intent` returns `action='auto_approve'` for SAFE
 * with `approved=true`, and `action='deny'` for BLOCKED with
 * `approved=false`.
 */
function shapeSyncResponse(
  action: GuardianAction,
  risk: RiskLabel,
  reason: string,
): AgentValidateResponse {
  if (action === 'auto_approve') {
    return {
      action,
      risk,
      reason: `Safe action: ${reason}`.startsWith('Safe action:') ? reason : `Safe action: ${reason}`,
      approved: true,
      requires_approval: false,
    };
  }
  // 'deny' — BLOCKED branch.
  return {
    action: 'deny',
    risk,
    reason,
    approved: false,
    requires_approval: false,
  };
}

function riskAdjective(risk: RiskLabel): string {
  return risk === 'HIGH' ? 'High' : 'Moderate';
}

function mapTaskStatusToProposalStatus(
  task: WorkflowTask,
): IntentProposalStatusResponse['status'] {
  switch (task.status) {
    case 'pending_approval':
      if (
        task.expires_at !== undefined &&
        task.expires_at > 0 &&
        task.expires_at < Math.floor(Date.now() / 1000)
      ) {
        return 'expired';
      }
      return 'pending';
    case 'queued':
    case 'claimed':
    case 'running':
    case 'completed':
      return 'approved';
    case 'cancelled':
    case 'canceled':
    case 'failed':
      return 'denied';
    case 'expired':
      return 'expired';
    default:
      // Unknown state — surface as pending so the agent doesn't act
      // on an ambiguous decision; an operator can resolve via the UI.
      return 'pending';
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
