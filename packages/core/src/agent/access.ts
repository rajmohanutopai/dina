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
 * GRANT GRANULARITY (dina_details.md §3.6): a grant is bound to the exact
 * tuple `(agent_did, session, persona, mode)` and is PERSONA-WIDE within that
 * session for its TTL. The user approves an agent's access to a PERSONA for
 * the CURRENT SESSION — the approval card shows the triggering query as
 * context, but approving "read health" authorises any health read by that
 * agent IN THAT SESSION until the grant expires. Per-query approval was
 * rejected as approval-fatigue (the agent's query is its current question, not
 * a durable boundary). Two boundaries ARE enforced by `findActiveGrant`:
 * cross-PERSONA (a health grant never unlocks finance) AND cross-SESSION (a
 * fresh `dina session start` mints a new session id → no matching grant →
 * re-prompt; a prior session's approval does NOT carry over). The stored
 * `scope` (query text) remains informational/audit only.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { appendAudit } from '../audit/service';
import { getPersonaTier } from '../persona/service';
import { agentCanAccess } from '../vault/lifecycle';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

import {
  getAgentGrantRepository,
  type AgentPersonaGrant,
  type GrantMode,
} from './grant_repository';

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

function idemKeyFor(
  agentDID: string,
  persona: string,
  mode: GrantMode,
  sessionId: string | null,
): string {
  // Session-scoped: two gated asks from the SAME agent/persona/mode but
  // DIFFERENT sessions must raise SEPARATE approval cards (each session is its
  // own decision), so the session is part of the idempotency key.
  return `${AGENT_PERSONA_ACCESS_APPROVAL_TYPE}:${agentDID}:${persona}:${mode}:${sessionId ?? ''}`;
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
  const tier = getPersonaTier(params.persona);

  // An active durable grant bound to this exact agent + persona + mode is the
  // only thing that unlocks a gated tier (a write grant satisfies read).
  const grantRepo = getAgentGrantRepository();
  const grant =
    grantRepo?.findActiveGrant(
      params.agentDID,
      params.persona,
      params.mode,
      params.sessionId ?? null,
      now,
    ) ?? null;

  // SINGLE source of truth for the tier policy: the same pure predicate the
  // persona-wall/lifecycle tests pin (`vault/lifecycle.ts::agentCanAccess`),
  // so the runtime gate and the documented V1 contract cannot drift. It is
  // exactly `hasGrant || isFreeTier(tier)`.
  if (agentCanAccess(tier, grant !== null)) {
    if (grant !== null) {
      appendAudit(
        params.agentDID,
        'agent_access_granted',
        params.persona,
        `mode=${params.mode} grant=${grant.id}`,
      );
      return { kind: 'allow', grantId: grant.id };
    }
    return { kind: 'allow' };
  }

  // Gated tier (sensitive/locked) + no grant → require approval. Fail CLOSED
  // if we can't durably record an approval request.
  const service = getWorkflowService();
  if (service === null) {
    return { kind: 'denied', reason: 'approval subsystem unavailable' };
  }

  const idemKey = idemKeyFor(
    params.agentDID,
    params.persona,
    params.mode,
    params.sessionId ?? null,
  );
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
 * PLG-28 #1 — phase 1 of 2: RESERVE the durable grant for an approved agent
 * persona-access task. The grant is inserted `active: false`, so it is durably
 * persisted (its absence would mean a missing/failing repo → return null → the
 * approve route refuses to commit, preserving PLG-26 #1) but NOT yet visible to
 * `findActiveGrant`. Crucially there is NO awaited unlock here, so the reserve →
 * approve span carries no event-loop yield an agent retry could exploit.
 *
 * Returns the reserved grant, or `null` when the task isn't an agent
 * persona-access approval / no grant repo is installed (fail-closed).
 */
export function reserveAgentPersonaGrant(
  task: WorkflowTask,
  now?: number,
): AgentPersonaGrant | null {
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
    active: false, // reserved — invisible to the gate until activated
  });
  appendAudit(
    payload.agent_did,
    'agent_access_approved',
    payload.persona,
    `mode=${payload.mode} grant=${g.id} task=${task.id}`,
  );
  return g;
}

/**
 * PLG-28 #1 — phase 2 of 2: AWAIT the persona unlock (issues.txt §2: the DEK may
 * not be resident for a locked/sensitive persona), then flip the reserved grant
 * ACTIVE so `findActiveGrant` sees it. Called AFTER the approval CAS commits, so
 * the grant only becomes gate-visible once the task is truly approved. Unlock is
 * best-effort (a failure doesn't block activation — the owner can open the
 * persona manually); activation runs regardless.
 */
export async function activateAgentPersonaGrant(
  grant: AgentPersonaGrant,
  _now?: number,
): Promise<void> {
  if (personaUnlockHook !== null) {
    try {
      await personaUnlockHook(grant.persona);
    } catch {
      /* best-effort unlock — grant still activates */
    }
  }
  getAgentGrantRepository()?.activate(grant.id);
}

/**
 * Convenience: reserve → activate (+ unlock) in one call. Used by tests and any
 * caller that does NOT interleave an approval CAS between the phases. The
 * workflow approve route uses the two phases DIRECTLY (reserve → approve →
 * activate) so a reserved grant is never gate-visible for an unapproved task.
 */
export async function grantAgentPersonaAccessFromApproval(
  task: WorkflowTask,
  now?: number,
): Promise<AgentPersonaGrant | null> {
  const grant = reserveAgentPersonaGrant(task, now);
  if (grant === null) return null;
  await activateAgentPersonaGrant(grant, now);
  return grant;
}
