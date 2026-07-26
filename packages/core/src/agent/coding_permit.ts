/**
 * Item B (Codex review — permit execution-seam redemption).
 *
 * The coding gate (`POST /v1/agent/gate`) classifies every forwarded tool call.
 * A SAFE call is auto-allowed; a MODERATE/HIGH one needs the OWNER's approval.
 * Until now the approval half was a dead end: the gate returned
 * `approval_required` but created no owner-facing object, and nothing ever
 * minted the payload-bound permit that would let the agent's retry proceed — so
 * an approved coding action could never actually run (it re-classified to
 * `approval_required` forever). This module closes that loop, mirroring the
 * agent persona-access gate (`access.ts`):
 *
 *   classify MODERATE/HIGH → create an idempotent approval workflow task
 *     (`createCodingGateApproval`, this module) bound to the payload HASH —
 *     never the raw tool input (§20: a Bash command / file path can carry a
 *     secret literal);
 *   owner approves the task → `mintApprovedCodingPermit` mints a single-use,
 *     payload-bound, principal-bound APPROVED permit;
 *   agent retries the SAME tool call → the gate redeems (consumes) that permit
 *     exactly once → allow. A second retry finds it consumed → re-gates.
 *
 * The permit STORE is fs/Node-side (it hashes with `node:crypto` and lives with
 * the classifiers), so — exactly as the route injects the concrete
 * `CodingGateFn` — the Node Core process injects a `CodingPermitAuthority` here.
 * `@dina/core` owns the approval-task shape, the idempotency, and the audit; the
 * Node side owns the permit bytes.
 */

import { randomBytes } from '@noble/ciphers/utils.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { appendAudit } from '../audit/service';
import { WorkflowTaskKind, WorkflowTaskState, type WorkflowTask } from '../workflow/domain';
import { getWorkflowService } from '../workflow/service';

import {
  AUTHORITY_ORIGIN_KINDS,
  isAgentGatingProfile,
  type AgentGatingProfile,
  type AuthorityOriginKind,
} from './gating_policy';

import type { RiskLevel } from '../gatekeeper/intent';

/** Approval-task payload discriminator for a coding-gate approval request. */
export const CODING_GATE_APPROVAL_TYPE = 'coding_gate';

/** A pending coding-approval card expires if not actioned within 15 min. */
export const DEFAULT_CODING_APPROVAL_TTL_SEC = 15 * 60;

/**
 * The approval-card payload. Carries only what the owner needs to DECIDE plus
 * the hash that binds the eventual permit — never the raw tool input, which can
 * hold a secret literal (§20). `payload_hash` is the SHA-256 the Node gate
 * computed over the exact `(tool, input)`; the permit minted on approval binds
 * to it, so the agent's retry authorises THAT call and no other.
 */
export interface CodingGateApprovalPayload {
  type: typeof CODING_GATE_APPROVAL_TYPE;
  agent_did: string;
  session: string;
  effective_profile: AgentGatingProfile;
  policy_version: number;
  authority_origin: AuthorityOriginKind;
  action: string;
  risk: RiskLevel;
  payload_hash: string;
  tool: string;
}

/** The single-use permit an owner approval mints. Bound to principal + hash. */
export interface CodingPermitClaim {
  agentDid: string;
  sessionId: string;
  effectiveProfile: AgentGatingProfile;
  policyVersion: number;
  authorityOrigin: AuthorityOriginKind;
  payloadHash: string;
  action: string;
  risk: RiskLevel;
}

/**
 * Injected permit authority — the Node gate's `PermitStore`, seen through the
 * one operation the approval seam needs. Kept minimal (and side-effect-only) so
 * `@dina/core` never depends on the fs/crypto-bound permit implementation.
 */
export interface CodingPermitAuthority {
  /** Mint an APPROVED, single-use permit bound to exactly this claim. */
  mintApproved(claim: CodingPermitClaim): void;
}

let authority: CodingPermitAuthority | null = null;
/** Wire the concrete permit authority (Node boot). Pass null to clear (tests). */
export function setCodingPermitAuthority(a: CodingPermitAuthority | null): void {
  authority = a;
}
export function getCodingPermitAuthority(): CodingPermitAuthority | null {
  return authority;
}

const RISK_VALUES = new Set<RiskLevel>(['SAFE', 'MODERATE', 'HIGH', 'BLOCKED']);
/** Control / bidi / zero-width chars that have no place in a rendered card. */
function hasControlOrBidi(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
    if (c >= 0x200b && c <= 0x200f) return true;
    if (c >= 0x202a && c <= 0x202e) return true;
    if (c >= 0x2066 && c <= 0x2069) return true;
    if (c === 0xfeff) return true;
  }
  return false;
}

/**
 * Strictly validate a coding-gate approval payload before it is displayed or
 * turned into a permit. The generic `/v1/workflow/tasks` route is open to the
 * brain/admin tenants, so a task could carry a malformed payload — a bad one
 * persists/authorises nothing. Returns the typed payload, or null.
 */
export function parseCodingGateApprovalPayload(
  raw: string | null | undefined,
): CodingGateApprovalPayload | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const p = obj as Record<string, unknown>;
  if (p.type !== CODING_GATE_APPROVAL_TYPE) return null;
  const agent_did = p.agent_did;
  const session = p.session;
  const action = p.action;
  const risk = p.risk;
  const payload_hash = p.payload_hash;
  const tool = p.tool;
  const effective_profile = p.effective_profile;
  const policy_version = p.policy_version;
  const authority_origin = p.authority_origin;
  if (typeof agent_did !== 'string' || agent_did === '' || hasControlOrBidi(agent_did)) return null;
  if (typeof session !== 'string' || hasControlOrBidi(session)) return null;
  if (!isAgentGatingProfile(effective_profile)) return null;
  if (
    typeof policy_version !== 'number' ||
    !Number.isSafeInteger(policy_version) ||
    policy_version < 0
  ) {
    return null;
  }
  if (
    typeof authority_origin !== 'string' ||
    !(AUTHORITY_ORIGIN_KINDS as readonly string[]).includes(authority_origin)
  ) {
    return null;
  }
  if (typeof action !== 'string' || action === '' || hasControlOrBidi(action)) return null;
  if (typeof risk !== 'string' || !RISK_VALUES.has(risk as RiskLevel)) return null;
  if (typeof payload_hash !== 'string' || !/^[0-9a-f]{64}$/.test(payload_hash)) return null;
  if (typeof tool !== 'string' || tool === '' || hasControlOrBidi(tool)) return null;
  return {
    type: CODING_GATE_APPROVAL_TYPE,
    agent_did,
    session,
    effective_profile,
    policy_version,
    authority_origin: authority_origin as AuthorityOriginKind,
    action,
    risk: risk as RiskLevel,
    payload_hash,
    tool,
  };
}

/** True if a workflow task is a well-formed coding-gate approval. */
export function isCodingGateApproval(task: WorkflowTask | null): boolean {
  if (task === null || task.kind !== WorkflowTaskKind.Approval) return false;
  return parseCodingGateApprovalPayload(task.payload) !== null;
}

/**
 * Idempotency key for a coding-gate approval. The SAME agent + session + exact
 * payload hash retried before approval must reuse ONE card (no duplicate
 * prompts); a different payload (bait-and-switch) hashes differently → its own
 * card. Once a card is approved (terminal) the key frees, so a fresh identical
 * call after the single-use permit is spent re-prompts — each risky action is
 * approved individually.
 */
export function codingGateIdemKey(
  agentDid: string,
  sessionId: string,
  payloadHash: string,
  effectiveProfile: AgentGatingProfile,
  policyVersion: number,
  authorityOrigin: AuthorityOriginKind,
): string {
  return [
    CODING_GATE_APPROVAL_TYPE,
    agentDid,
    sessionId,
    effectiveProfile,
    String(policyVersion),
    authorityOrigin,
    payloadHash,
  ].join(':');
}

export type RedeemCodingApprovalResult =
  | { kind: 'redeemed'; taskId: string }
  | { kind: 'not_ready'; taskId?: string }
  | { kind: 'invalid'; taskId: string };

/**
 * Atomically consume the durable receipt for an approved coding action.
 *
 * The Node-side PermitStore is deliberately short-lived. The workflow task is
 * therefore the authoritative, crash-safe single-use ledger:
 *
 *   pending_approval -> queued              owner approved
 *   queued -> running -> completed          one exact retry redeemed approval
 *
 * The queued-to-running CAS ensures concurrent identical retries cannot both
 * run. Completing immediately records the receipt as spent. If Core crashes
 * after the CAS but before replying, the action remains blocked (safe failure)
 * and the expiry sweeper eventually terminalizes the stranded task.
 */
export function redeemApprovedCodingGateApproval(params: {
  agentDid: string;
  sessionId: string;
  effectiveProfile: AgentGatingProfile;
  policyVersion: number;
  authorityOrigin: AuthorityOriginKind;
  payloadHash: string;
  tool: string;
  action: string;
  risk: RiskLevel;
  now?: number;
}): RedeemCodingApprovalResult {
  const service = getWorkflowService();
  if (service === null) return { kind: 'not_ready' };

  const idemKey = codingGateIdemKey(
    params.agentDid,
    params.sessionId,
    params.payloadHash,
    params.effectiveProfile,
    params.policyVersion,
    params.authorityOrigin,
  );
  const task = service.store().getActiveByIdempotencyKey(idemKey);
  if (task === null) return { kind: 'not_ready' };

  const payload = parseCodingGateApprovalPayload(task.payload);
  if (
    payload === null ||
    payload.agent_did !== params.agentDid ||
    payload.session !== params.sessionId ||
    payload.effective_profile !== params.effectiveProfile ||
    payload.policy_version !== params.policyVersion ||
    payload.authority_origin !== params.authorityOrigin ||
    payload.payload_hash !== params.payloadHash ||
    payload.tool !== params.tool ||
    payload.action !== params.action ||
    payload.risk !== params.risk
  ) {
    return { kind: 'invalid', taskId: task.id };
  }
  if (task.status !== WorkflowTaskState.Queued) {
    return { kind: 'not_ready', taskId: task.id };
  }

  const now = params.now ?? Date.now();
  const won = service
    .store()
    .transition(task.id, WorkflowTaskState.Queued, WorkflowTaskState.Running, now);
  if (!won) return { kind: 'not_ready', taskId: task.id };

  try {
    service.complete(
      task.id,
      JSON.stringify({ type: CODING_GATE_APPROVAL_TYPE, redeemed: true }),
      'Coding approval redeemed',
      params.agentDid,
    );
  } catch (err) {
    // No allow response has been returned yet. Terminal failure is safe and
    // frees the idempotency key for a fresh owner decision.
    try {
      service.fail(task.id, 'coding approval redemption failed', params.agentDid);
    } catch {
      // The original error is more useful. A concurrent/terminal transition is
      // still fail-closed because this function does not return `redeemed`.
    }
    throw err;
  }

  appendAudit(
    params.agentDid,
    'coding_gate_redeemed',
    params.tool,
    `action=${params.action} risk=${params.risk} task=${task.id}`,
  );
  return { kind: 'redeemed', taskId: task.id };
}

function shortDID(did: string): string {
  return did.length > 24 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did;
}

export type CreateCodingApprovalResult =
  | { kind: 'approval_required'; taskId: string }
  | { kind: 'unavailable' };

/**
 * Create (idempotently) the owner-approval card for a MODERATE/HIGH coding
 * action. Side-effect-limited to durable task creation + audit; never touches
 * the vault. Fails CLOSED (`unavailable`) if the approval subsystem is absent,
 * so the gate refuses rather than silently allowing.
 */
export function createCodingGateApproval(params: {
  agentDid: string;
  sessionId: string;
  effectiveProfile: AgentGatingProfile;
  policyVersion: number;
  authorityOrigin: AuthorityOriginKind;
  payloadHash: string;
  tool: string;
  action: string;
  risk: RiskLevel;
  now?: number;
}): CreateCodingApprovalResult {
  const service = getWorkflowService();
  if (service === null) return { kind: 'unavailable' };
  const now = params.now ?? Date.now();

  const idemKey = codingGateIdemKey(
    params.agentDid,
    params.sessionId,
    params.payloadHash,
    params.effectiveProfile,
    params.policyVersion,
    params.authorityOrigin,
  );
  const existing = service.store().getActiveByIdempotencyKey(idemKey);
  if (existing !== null) return { kind: 'approval_required', taskId: existing.id };

  const id = `coding-gate-${bytesToHex(randomBytes(8))}`;
  const payload: CodingGateApprovalPayload = {
    type: CODING_GATE_APPROVAL_TYPE,
    agent_did: params.agentDid,
    session: params.sessionId,
    effective_profile: params.effectiveProfile,
    policy_version: params.policyVersion,
    authority_origin: params.authorityOrigin,
    action: params.action,
    risk: params.risk,
    payload_hash: params.payloadHash,
    tool: params.tool,
  };
  service.create({
    id,
    kind: WorkflowTaskKind.Approval,
    // Names the actor + the action/tool + risk only — NEVER the raw tool input.
    description: `Agent ${shortDID(params.agentDid)} requests a ${params.risk} coding action (${params.action} via ${params.tool})`,
    payload: JSON.stringify(payload),
    expiresAtSec: Math.floor(now / 1000) + DEFAULT_CODING_APPROVAL_TTL_SEC,
    idempotencyKey: idemKey,
    origin: 'agent',
    ...(params.sessionId !== '' ? { sessionName: params.sessionId } : {}),
    initialState: WorkflowTaskState.PendingApproval,
  });
  appendAudit(
    params.agentDid,
    'coding_gate_request',
    params.tool,
    `action=${params.action} risk=${params.risk} task=${id}`,
  );
  return { kind: 'approval_required', taskId: id };
}

/**
 * Mint the APPROVED permit for a just-approved coding-gate task. Reads the task
 * payload (validated), then asks the injected authority to mint a single-use
 * permit bound to that payload hash + principal. Returns false — fail-closed —
 * when the payload is malformed or no authority is wired, so the approve route
 * can refuse to commit rather than approve a card that grants nothing.
 */
export function mintApprovedCodingPermit(task: WorkflowTask): boolean {
  const payload = parseCodingGateApprovalPayload(task.payload);
  if (payload === null) return false;
  const auth = getCodingPermitAuthority();
  if (auth === null) return false;
  auth.mintApproved({
    agentDid: payload.agent_did,
    sessionId: payload.session,
    effectiveProfile: payload.effective_profile,
    policyVersion: payload.policy_version,
    authorityOrigin: payload.authority_origin,
    payloadHash: payload.payload_hash,
    action: payload.action,
    risk: payload.risk,
  });
  appendAudit(
    payload.agent_did,
    'coding_gate_approved',
    payload.tool,
    `action=${payload.action} risk=${payload.risk} task=${task.id}`,
  );
  return true;
}
