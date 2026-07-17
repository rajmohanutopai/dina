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
import { resolvePersonaName } from '../persona/names';
import { getPersonaTier } from '../persona/service';
import { agentCanAccess } from '../vault/lifecycle';
import {
  WorkflowTaskKind,
  WorkflowTaskState,
  isTerminal,
  type WorkflowTask,
} from '../workflow/domain';
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
  // PLG-32 #12: CANONICALIZE the persona ONCE at the gate entry (trim + lowercase
  // + alias) and use that everywhere below. Previously only the tier lookup
  // normalized (via getPersona), while the raw string flowed into the idempotency
  // key, the approval payload, and the grant row — so ' health ' minted a task
  // whose payload later FAILS strict parse (approve-but-never-grant loop), and
  // 'Health' vs 'health' split into two grants/cards for one logical persona.
  const persona = resolvePersonaName(params.persona.trim());
  const tier = getPersonaTier(persona);

  // An active durable grant bound to this exact agent + persona + mode is the
  // only thing that unlocks a gated tier (a write grant satisfies read).
  const grantRepo = getAgentGrantRepository();
  const grant =
    grantRepo?.findActiveGrant(
      params.agentDID,
      persona,
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
        persona,
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

  const idemKey = idemKeyFor(params.agentDID, persona, params.mode, params.sessionId ?? null);
  const existing = service.store().getActiveByIdempotencyKey(idemKey);
  if (existing !== null) return { kind: 'approval_required', taskId: existing.id };

  const id = `agent-access-${bytesToHex(randomBytes(8))}`;
  const payload: AgentPersonaAccessApprovalPayload = {
    type: AGENT_PERSONA_ACCESS_APPROVAL_TYPE,
    agent_did: params.agentDID,
    persona,
    mode: params.mode,
    scope: params.scope,
  };
  service.create({
    id,
    kind: WorkflowTaskKind.Approval,
    // Description names the actor/persona/mode only — NO vault contents.
    description: `Agent ${shortDID(params.agentDID)} requests ${params.mode} access to "${persona}"`,
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
    persona,
    `mode=${params.mode} task=${id} tier=${tier}`,
  );
  return { kind: 'approval_required', taskId: id };
}

/**
 * PLG-30 #9: control / bidi / zero-width / BOM chars — the spoofing set that has
 * no place in a DID, persona name, or scope string that renders in the trusted
 * approval card or becomes a grant key. Codepoint checks keep the SOURCE ASCII.
 */
function hasControlOrBidi(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true; // C0 / DEL+C1 controls
    if (c >= 0x200b && c <= 0x200f) return true; // zero-width + bidi marks
    if (c >= 0x202a && c <= 0x202e) return true; // bidi embeddings/overrides
    if (c >= 0x2066 && c <= 0x2069) return true; // bidi isolates
    if (c === 0xfeff) return true; // BOM / zero-width no-break space
  }
  return false;
}

/**
 * PLG-29 #2: FULLY validate an agent persona-access payload before it is
 * displayed or granted. Previously the recognizer checked only `payload.type` and
 * the grant path cast + persisted agent_did/persona/mode/scope unvalidated — so a
 * brain/admin-created workflow task (the generic `/v1/workflow/tasks` route is
 * open to those tenants) could carry a malformed payload. The SQLite grant schema
 * rejects a bad `mode` with an ungraceful 500; the InMemory grant store had NO
 * such guard (a store parity gap). One validator closes both. Returns the typed
 * payload, or null when it isn't a well-formed agent persona-access payload.
 */
export function parseAgentPersonaAccessPayload(
  raw: string,
): AgentPersonaAccessApprovalPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // PLG-30 #8: `JSON.parse('null')` returns null (no throw), and a bare number /
  // string / array is not an object — reading `.type` on any of them was either a
  // crash (null) or an accidental pass. Guard the shape before dereferencing so a
  // malformed generic workflow payload can't throw inside approval processing.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p.type !== AGENT_PERSONA_ACCESS_APPROVAL_TYPE) return null;
  // PLG-30 #9: these fields become grant keys AND render verbatim in the trusted
  // approval card, so they must be CANONICAL — a real did:method:id shape, no
  // surrounding whitespace (` health ` must not be a distinct key from `health`),
  // and no control/bidi/zero-width chars (which permit visually deceptive consent
  // text). Reject rather than silently trim: a legitimate requester sends clean
  // values, and trimming could collapse a hostile string onto a real persona.
  if (
    typeof p.agent_did !== 'string' ||
    p.agent_did.length > 256 ||
    !/^did:[^:\s]+:\S+$/.test(p.agent_did) ||
    hasControlOrBidi(p.agent_did)
  ) {
    return null;
  }
  if (
    typeof p.persona !== 'string' ||
    p.persona.trim() === '' ||
    p.persona !== p.persona.trim() ||
    p.persona.length > 128 ||
    hasControlOrBidi(p.persona)
  ) {
    return null;
  }
  if (p.mode !== 'read' && p.mode !== 'write') return null;
  const scope = typeof p.scope === 'string' ? p.scope : '';
  if (scope.length > 4096 || hasControlOrBidi(scope)) return null;
  return {
    type: AGENT_PERSONA_ACCESS_APPROVAL_TYPE,
    agent_did: p.agent_did,
    persona: p.persona,
    mode: p.mode,
    scope,
  };
}

/** True if a workflow task is a well-formed agent persona-access approval. */
export function isAgentPersonaAccessApproval(task: WorkflowTask | null): boolean {
  if (task === null || task.kind !== WorkflowTaskKind.Approval) return false;
  return parseAgentPersonaAccessPayload(task.payload) !== null;
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
  // PLG-29 #2: validate the WHOLE payload (agent_did / persona / mode / scope),
  // not just the type — a malformed payload persists nothing.
  const payload = parseAgentPersonaAccessPayload(task.payload);
  if (payload === null) return null;
  const grantRepo = getAgentGrantRepository();
  if (grantRepo === null) return null;

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
  // PLG-29 #6: audit the RESERVE (not "approved") here — the approval CAS hasn't
  // run yet, so a lost CAS + compensating revoke must not leave an append-only
  // record permanently claiming access was approved. The `agent_access_approved`
  // audit is emitted in activateAgentPersonaGrant, AFTER the CAS commits.
  appendAudit(
    payload.agent_did,
    'agent_access_reserved',
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
): Promise<boolean> {
  if (personaUnlockHook !== null) {
    try {
      await personaUnlockHook(grant.persona);
    } catch {
      /* best-effort unlock — grant still activates */
    }
  }
  // PLG-29 #5: RETURN the activate() result so the caller can detect a failure
  // (e.g. the reserved grant was revoked concurrently) instead of silently
  // leaving an approved task with a permanently-inactive grant. PLG-29 #6: emit
  // the `agent_access_approved` audit ONLY once the grant is actually active —
  // after the CAS committed — so the log never claims an approval that didn't
  // take effect.
  const activated = getAgentGrantRepository()?.activate(grant.id) ?? false;
  if (activated) {
    appendAudit(
      grant.agentDID,
      'agent_access_approved',
      grant.persona,
      `mode=${grant.mode} grant=${grant.id} task=${grant.approvalTaskId}`,
    );
  }
  return activated;
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
  // PLG-32 #2: refuse a TERMINAL task (cancelled / failed / completed / recorded
  // / outcome_unknown). This exported convenience helper used to reserve+activate
  // from a raw task with NO state check, so passing a cancelled/failed/fabricated-
  // terminal task could mint ACTIVE vault access. Production never calls this (the
  // workflow approve route drives reserve→approve→activate directly and gates on
  // PendingApproval); the guard closes the footgun while preserving the
  // non-terminal (approvable) contract the convenience callers rely on.
  if (isTerminal(task.status as WorkflowTaskState)) return null;
  const grant = reserveAgentPersonaGrant(task, now);
  if (grant === null) return null;
  // PLG-32 #7: HONOR activate()'s result. Returning the reserved grant when
  // activation FAILED tells the caller access is live when it is not — revoke the
  // reservation and return null so a non-null result always means active access.
  const activated = await activateAgentPersonaGrant(grant, now);
  if (!activated) {
    getAgentGrantRepository()?.revoke(grant.id, now ?? Date.now());
    return null;
  }
  return grant;
}
