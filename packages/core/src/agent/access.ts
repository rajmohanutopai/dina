/**
 * Deterministic agent persona-access gate (issues.txt §2).
 *
 * `requireAgentPersonaAccess` is the single, non-LLM check every
 * agent-facing vault read/write path must call before touching the
 * vault. It answers exactly one question: may THIS agent DID access
 * THIS persona in THIS mode right now?
 *
 *   - An active durable grant (`agent_persona_grants`) → allow.
 *   - Otherwise, a free tier (default/standard) → allow.
 *   - Otherwise (sensitive/locked, no grant) → create a durable
 *     approval workflow task (idempotent) and return `approval_required`
 *     WITHOUT reading the vault. The approval card carries only the
 *     agent DID + persona + mode + the agent's requested scope — never
 *     vault contents.
 *
 * On approval, `grantAgentPersonaAccessFromApproval` writes the durable
 * grant, so the agent's retry (possibly after an app restart) passes the
 * gate. Deny / expire / restart-before-approval all keep data sealed:
 * no grant row ⇒ no data.
 *
 * GRANT GRANULARITY — deliberate design (issues.txt §2): a grant is bound to
 * `(agent_did, persona, mode)` and is PERSONA-WIDE for its TTL. The user
 * approves an agent's access to a PERSONA, not to one specific query — the
 * approval card shows the triggering query as context, but approving "read
 * health" authorises any health read until the grant expires. Per-query
 * approval was rejected as approval-fatigue (the agent's query is just its
 * current question, not a durable boundary). The stored `scope` is therefore
 * informational/audit only — it is NOT consulted by `findActiveGrant`.
 * Cross-PERSONA isolation IS enforced (a health grant never unlocks finance);
 * that's the boundary the §2 "bound to persona/scope" requirement protects.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  getAgentGrantRepository,
  type AgentPersonaGrant,
  type GrantMode,
} from './grant_repository';
import { getWorkflowService } from '../workflow/service';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { getPersonaTier } from '../persona/service';
import { requiresApproval, requiresPassphrase } from '../vault/lifecycle';
import { appendAudit } from '../audit/service';

/** Approval-task payload discriminator for an agent persona-access request. */
export const AGENT_PERSONA_ACCESS_APPROVAL_TYPE = 'agent_persona_access';

export interface AgentPersonaAccessApprovalPayload {
  type: typeof AGENT_PERSONA_ACCESS_APPROVAL_TYPE;
  agent_did: string;
  persona: string;
  mode: GrantMode;
  /**
   * The agent's requesting query, shown on the approval card for context.
   * Informational/audit ONLY — the resulting grant is persona-wide (see the
   * GRANT GRANULARITY note in the module header); this is never used as an
   * access boundary.
   */
  scope: string;
}

/** Granted access lasts this long once approved (1 h). */
export const DEFAULT_GRANT_TTL_MS = 60 * 60 * 1000;
/** A pending approval card expires if not actioned within 15 min. */
export const DEFAULT_APPROVAL_TTL_SEC = 15 * 60;

/**
 * App-supplied hook to OPEN a persona (derive its DEK into RAM) when an
 * agent-access approval is granted. A locked/sensitive persona's DEK may
 * not be resident, so a grant alone wouldn't let the agent's retry decrypt
 * — approving the card must also unlock (issues.txt §2). Deriving the DEK
 * needs the master seed, which lives at the app/boot layer, so Core fires
 * this hook rather than unlocking directly. Best-effort, fire-and-forget.
 */
let personaUnlockHook: ((persona: string) => void | Promise<void>) | null = null;
export function setAgentPersonaUnlockHook(
  fn: ((persona: string) => void | Promise<void>) | null,
): void {
  personaUnlockHook = fn;
}

export type AgentAccessDecision =
  | { kind: 'allow'; grantId?: string }
  | { kind: 'approval_required'; taskId: string }
  | { kind: 'denied'; reason: string };

export interface RequireAgentPersonaAccessParams {
  agentDID: string;
  persona: string;
  mode: GrantMode;
  /** Requested scope/query text — surfaced on the approval card, never results. */
  scope: string;
  /** Optional named-session tag for the eventual grant. */
  sessionId?: string | null;
  /** Test clock override. */
  now?: number;
}

function idemKeyFor(agentDID: string, persona: string, mode: GrantMode): string {
  return `${AGENT_PERSONA_ACCESS_APPROVAL_TYPE}:${agentDID}:${persona}:${mode}`;
}

function shortDID(did: string): string {
  return did.length > 24 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did;
}

/**
 * The gate. Deterministic, side-effect-limited to (idempotent) approval-
 * task creation. NEVER reads the vault.
 */
export function requireAgentPersonaAccess(
  params: RequireAgentPersonaAccessParams,
): AgentAccessDecision {
  const now = params.now ?? Date.now();

  // 1. Existing durable grant bound to this exact agent + persona + mode?
  const grantRepo = getAgentGrantRepository();
  if (grantRepo !== null) {
    const grant = grantRepo.findActiveGrant(params.agentDID, params.persona, params.mode, now);
    if (grant !== null) {
      appendAudit(
        params.agentDID,
        'agent_access_granted',
        params.persona,
        `mode=${params.mode} grant=${grant.id}`,
      );
      return { kind: 'allow', grantId: grant.id };
    }
  }

  // 2. Free tiers (default/standard) need no grant for agents.
  const tier = getPersonaTier(params.persona);
  const needsApproval = requiresApproval(tier) || requiresPassphrase(tier);
  if (!needsApproval) return { kind: 'allow' };

  // 3. Sensitive/locked + no grant → require approval. Fail CLOSED if we
  //    can't durably record an approval request.
  const service = getWorkflowService();
  if (service === null) {
    return { kind: 'denied', reason: 'approval subsystem unavailable' };
  }

  const idemKey = idemKeyFor(params.agentDID, params.persona, params.mode);
  const existing = service.store().getActiveByIdempotencyKey(idemKey);
  if (existing !== null) return { kind: 'approval_required', taskId: existing.id };

  const id = `agent-access-${bytesToHex(randomBytes(8))}`;
  const payload: AgentPersonaAccessApprovalPayload = {
    type: AGENT_PERSONA_ACCESS_APPROVAL_TYPE,
    agent_did: params.agentDID,
    persona: params.persona,
    mode: params.mode,
    scope: params.scope,
  };
  service.create({
    id,
    kind: WorkflowTaskKind.Approval,
    // Description names the actor/persona/mode only — NO vault contents.
    description: `Agent ${shortDID(params.agentDID)} requests ${params.mode} access to "${params.persona}"`,
    payload: JSON.stringify(payload),
    expiresAtSec: Math.floor(now / 1000) + DEFAULT_APPROVAL_TTL_SEC,
    idempotencyKey: idemKey,
    origin: 'agent',
    ...(params.sessionId ? { sessionName: params.sessionId } : {}),
    initialState: WorkflowTaskState.PendingApproval,
  });
  appendAudit(
    params.agentDID,
    'agent_access_request',
    params.persona,
    `mode=${params.mode} task=${id} tier=${tier}`,
  );
  return { kind: 'approval_required', taskId: id };
}

/** True if a workflow task is an agent persona-access approval. */
export function isAgentPersonaAccessApproval(task: WorkflowTask | null): boolean {
  if (task === null || task.kind !== WorkflowTaskKind.Approval) return false;
  try {
    const payload = JSON.parse(task.payload) as Record<string, unknown>;
    return payload.type === AGENT_PERSONA_ACCESS_APPROVAL_TYPE;
  } catch {
    return false;
  }
}

/**
 * Write the durable grant when an agent persona-access approval is
 * approved. Returns the grant, or `null` when the task isn't an agent
 * persona-access approval / no grant repo is installed (fail-closed:
 * the agent simply stays blocked).
 */
export async function grantAgentPersonaAccessFromApproval(
  task: WorkflowTask,
  now?: number,
): Promise<AgentPersonaGrant | null> {
  if (!isAgentPersonaAccessApproval(task)) return null;
  const grantRepo = getAgentGrantRepository();
  if (grantRepo === null) return null;

  let payload: AgentPersonaAccessApprovalPayload;
  try {
    payload = JSON.parse(task.payload) as AgentPersonaAccessApprovalPayload;
  } catch {
    return null;
  }

  const t = now ?? Date.now();
  const g = grantRepo.insert({
    id: `grant-${bytesToHex(randomBytes(8))}`,
    sessionId: task.session_name && task.session_name !== '' ? task.session_name : null,
    agentDID: payload.agent_did,
    persona: payload.persona,
    mode: payload.mode,
    // Persist the requested scope only — never the vault result.
    scopeJson: JSON.stringify({ scope: payload.scope }),
    approvalTaskId: task.id,
    expiresAt: t + DEFAULT_GRANT_TTL_MS,
    createdAt: t,
  });
  appendAudit(
    payload.agent_did,
    'agent_access_approved',
    payload.persona,
    `mode=${payload.mode} grant=${g.id} task=${task.id}`,
  );

  // Approving also UNLOCKS the persona (issues.txt §2): a locked/sensitive
  // persona's DEK may not be resident, so without this the agent's retry
  // would pass the gate but fail to decrypt. AWAITED (not fire-and-forget)
  // so the DEK is resident before this resolves — and the approve route
  // awaits us — closing the race where the agent retries mid-unlock.
  // Best-effort: an unlock failure doesn't undo the grant (the owner can
  // open the persona manually), it just isn't guaranteed-resident yet.
  if (personaUnlockHook !== null) {
    try {
      await personaUnlockHook(payload.persona);
    } catch {
      /* best-effort unlock — grant still stands */
    }
  }

  return g;
}
