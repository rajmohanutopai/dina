/**
 * Item 4 — the catch-all coding gate route (`POST /v1/agent/gate`).
 *
 * A coding-agent hook (Claude Code / Codex) forwards EVERY tool call here as the
 * raw `(tool_name, tool_input)`; Core classifies it (DPD-001, §12.1) and returns
 * a decision. Core, not the untrusted forwarder, owns the classification.
 *
 * The classifier itself is fs-dependent (it canonicalises real paths, §12.1), so
 * it cannot live in the pure `@dina/core`. This route therefore takes an
 * INJECTED `CodingGateFn` — `@dina/core` owns the route, auth, and wire shape;
 * the Node Core process (`apps/home-node-lite/core-server`) injects the concrete
 * fs-backed gate. On a node with no coding gate (e.g. mobile) the route reports
 * 501, never a silent allow.
 *
 * The authenticated caller DID (X-DID / `callerDID`) is the agent identity — a
 * body-supplied `agent_did` is never trusted (mirrors `intent.ts` / Go
 * `agent.go`).
 */

import {
  createCodingGateApproval,
  redeemApprovedCodingGateApproval,
} from '../../agent/coding_permit';
import {
  makeUnknownAuthorityOrigin,
  resolveConfiguredGatingProfile,
  resolveEffectiveGatingProfile,
  type AgentGatingProfile,
  type AuthorityOrigin,
} from '../../agent/gating_policy';
import { appendAudit } from '../../audit/service';
import { getNodeDID } from '../../pairing/ceremony';
import { getSessionRegistry } from '../../session/registry';

import type { RiskLevel } from '../../gatekeeper/intent';
import type { CoreRouter } from '../router';

/** Result the injected gate returns; serialised to snake_case on the wire. */
export interface CodingGateResult {
  action: string;
  risk: string;
  outcome: 'allow' | 'approval_required' | 'deny';
  /** true in enforce mode (Core acted); false in classification-only mode. */
  enforced: boolean;
  /** Permit id minted for an allowed enforce-mode call, else undefined. */
  permitId?: string;
  /**
   * SHA-256 of the exact `(tool, input)` payload. Present for an enforce-mode
   * decision; the route binds the approval card + the permit it will mint to
   * this hash, so the owner's approval authorises THIS call and no other.
   */
  payloadHash?: string;
  reason: string;
  /** Optional on legacy injected gates; the route stamps server-owned values. */
  profile?: AgentGatingProfile;
  authorityOriginKind?: AuthorityOrigin['kind'];
  policyVersion?: number;
  auditLevel?: 'none' | 'kernel' | 'boundary' | 'full';
}

export interface CodingGateInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Authenticated agent DID (never client-supplied). */
  agentDid: string;
  /** Opaque, live Core session id resolved by this route. */
  sessionId: string;
  /** Agent working dir for relative-path resolution; undefined ⇒ Core cwd. */
  cwd?: string;
  /** Effective server-owned profile, after applying the origin safety floor. */
  profile?: AgentGatingProfile;
  /** Core-owned provenance; never copied from the request body. */
  authorityOrigin?: AuthorityOrigin;
  policyVersion?: number;
  /** Internal compatibility marker. Production routes always pass enforce. */
  mode: 'enforce' | 'classify_only';
}

/** The fs-backed classifier+permit gate, injected by the Node Core process. */
export type CodingGateFn = (input: CodingGateInput) => CodingGateResult | Promise<CodingGateResult>;

/** Hard cap on inbound body size (matches the validate route: 64 KB). */
const MAX_GATE_BODY_BYTES = 64 * 1024;

export function registerCodingGateRoutes(router: CoreRouter, gate?: CodingGateFn): void {
  router.post('/v1/agent/gate', async (req) => {
    if (req.rawBody.length > MAX_GATE_BODY_BYTES) {
      return { status: 413, body: { error: 'request body too large' } };
    }

    // Caller identity binding: the authenticated DID is authority; body
    // `agent_did` is never trusted (parity with intent.ts / agent.go).
    const xDID = req.headers['x-did'];
    const agentDid = req.callerDID ?? (typeof xDID === 'string' && xDID !== '' ? xDID : '');
    if (agentDid === '') {
      return { status: 401, body: { error: 'unauthenticated: no caller DID' } };
    }

    const body = (req.body as Record<string, unknown> | undefined) ?? {};
    const toolName = typeof body.tool_name === 'string' ? body.tool_name.trim() : '';
    if (toolName === '') {
      return { status: 400, body: { error: 'missing required field: tool_name' } };
    }
    const toolInput =
      body.tool_input && typeof body.tool_input === 'object' && !Array.isArray(body.tool_input)
        ? (body.tool_input as Record<string, unknown>)
        : {};
    const modeRaw = typeof body.mode === 'string' ? body.mode : 'enforce';
    if (modeRaw !== 'enforce' && modeRaw !== 'classify_only') {
      return { status: 400, body: { error: `invalid mode: ${modeRaw}` } };
    }
    // Wire compatibility only: old adapters still send `mode=enforce`. The
    // caller can no longer select advisory/classification-only behavior.
    if (modeRaw === 'classify_only') {
      return {
        status: 403,
        body: { error: 'client_mode_not_authoritative', reason: 'Core owns gate enforcement' },
      };
    }
    if (body.profile !== undefined || body.authority_origin !== undefined) {
      return {
        status: 400,
        body: {
          error: 'server_owned_gate_context',
          reason: 'profile and authority_origin are resolved by Core',
        },
      };
    }
    const approvalSurface =
      typeof body.approval_surface === 'string' ? body.approval_surface : 'host';
    if (approvalSurface !== 'host' && approvalSurface !== 'owner') {
      return { status: 400, body: { error: `invalid approval_surface: ${approvalSurface}` } };
    }
    const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : undefined;

    if (!gate) {
      return { status: 501, body: { error: 'coding gate not available on this node' } };
    }

    const sessionIdRaw = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    const hostSessionId =
      typeof body.host_session_id === 'string' ? body.host_session_id.trim() : '';
    if (sessionIdRaw !== '' && hostSessionId !== '') {
      return {
        status: 400,
        body: { error: 'supply either session_id or host_session_id, not both' },
      };
    }
    if (sessionIdRaw === '' && hostSessionId === '') {
      return { status: 401, body: { error: 'invalid_session' } };
    }
    if (hostSessionId.length > 256) {
      return { status: 400, body: { error: 'host_session_id is too long' } };
    }

    // Gate calls must always be attached to a live, DID-bound Core session.
    // A host hook can provide its stable host_session_id in the same signed
    // request; start() atomically resolves/reuses it and renews the lease. Other
    // adapters can provide an opaque Core session_id, which is renewed here.
    const sessionId =
      hostSessionId !== ''
        ? getSessionRegistry().start({ agentDid, hostSessionId }).sessionId
        : sessionIdRaw;
    const sessionValidation =
      hostSessionId === ''
        ? getSessionRegistry().renew(sessionId, agentDid)
        : getSessionRegistry().validate(sessionId, agentDid);
    if (!sessionValidation.ok) {
      return { status: 401, body: { error: 'invalid_session' } };
    }

    const configured = resolveConfiguredGatingProfile(agentDid);
    const currentOwnerDid = getNodeDID();
    const ownerBindingValid =
      configured.policy !== null &&
      currentOwnerDid !== null &&
      configured.policy.selectedByOwnerDid === currentOwnerDid;
    const principalHasNonOwnerAuthority = getSessionRegistry().hasActiveNonOwnerAuthority(agentDid);
    const authorityOrigin: AuthorityOrigin =
      sessionValidation.session.authorityOrigin ??
      (principalHasNonOwnerAuthority
        ? makeUnknownAuthorityOrigin({
            ownerDid: currentOwnerDid ?? 'did:unknown',
            correlationId: sessionId,
            authenticatedAtMs: sessionValidation.session.createdAtMs,
            ingress: 'coding_host',
          })
        : ownerBindingValid
          ? {
              kind: 'owner_interactive',
              ownerDid: currentOwnerDid,
              requesterDid: currentOwnerDid,
              ingress: 'coding_host',
              correlationId: sessionId,
              authenticatedAtMs: sessionValidation.session.createdAtMs,
            }
          : makeUnknownAuthorityOrigin({
              ownerDid: currentOwnerDid ?? 'did:unknown',
              correlationId: sessionId,
              authenticatedAtMs: sessionValidation.session.createdAtMs,
              ingress: 'coding_host',
            }));
    const effectiveProfile = resolveEffectiveGatingProfile(
      ownerBindingValid ? configured.profile : 'full_supervision',
      authorityOrigin,
    );

    const rawResult = await gate({
      toolName,
      toolInput,
      agentDid,
      sessionId,
      cwd,
      profile: effectiveProfile,
      authorityOrigin,
      policyVersion: ownerBindingValid ? configured.policyVersion : 0,
      mode: 'enforce',
    });
    let result: Required<
      Pick<CodingGateResult, 'profile' | 'authorityOriginKind' | 'policyVersion' | 'auditLevel'>
    > &
      CodingGateResult = {
      ...rawResult,
      profile: effectiveProfile,
      authorityOriginKind: authorityOrigin.kind,
      policyVersion: ownerBindingValid ? configured.policyVersion : 0,
      auditLevel:
        rawResult.auditLevel ??
        (effectiveProfile === 'full_supervision'
          ? 'full'
          : rawResult.risk === 'BLOCKED'
            ? 'kernel'
            : 'boundary'),
    };

    // Item B — an enforce-mode call that the gate could NOT redeem against an
    // already-approved permit needs either the host's native confirmation UI or
    // the owner's Dina. Claude Code can ask locally for MODERATE calls; Codex
    // currently cannot, so its adapter explicitly selects the owner surface.
    // HIGH always uses the owner surface. Create the card idempotently, bound to
    // the payload hash (never the raw input), so an approved retry can redeem it.
    // Fail CLOSED: if approval is unavailable we return approval_required with
    // no task rather than silently allow.
    let approvalTaskId: string | undefined;
    if (
      result.enforced &&
      (result.risk === 'HIGH' || (result.risk === 'MODERATE' && approvalSurface === 'owner')) &&
      typeof result.payloadHash === 'string' &&
      result.payloadHash !== ''
    ) {
      const payloadHash = result.payloadHash;
      const redemption = redeemApprovedCodingGateApproval({
        agentDid,
        sessionId,
        effectiveProfile,
        policyVersion: result.policyVersion,
        authorityOrigin: authorityOrigin.kind,
        payloadHash,
        tool: toolName,
        action: result.action,
        risk: result.risk as RiskLevel,
      });
      if (redemption.kind === 'redeemed') {
        result = {
          ...result,
          outcome: 'allow',
          enforced: true,
          permitId: result.permitId ?? `workflow:${redemption.taskId}`,
          reason: `${result.reason} (redeemed durable owner approval)`,
        };
      } else {
        // A transient in-memory permit is never sufficient on its own. The
        // matching durable task must win its single-use CAS, otherwise two
        // concurrent retries (or a cancelled task) could both appear allowed.
        if (result.outcome === 'allow') {
          result = {
            ...result,
            outcome: 'approval_required',
            permitId: undefined,
            reason: 'owner approval could not be durably redeemed',
          };
        }
        if (result.outcome === 'approval_required') {
          const created = createCodingGateApproval({
            agentDid,
            sessionId,
            effectiveProfile,
            policyVersion: result.policyVersion,
            authorityOrigin: authorityOrigin.kind,
            payloadHash,
            tool: toolName,
            action: result.action,
            risk: result.risk as RiskLevel,
          });
          if (created.kind === 'approval_required') approvalTaskId = created.taskId;
        }
      }
    }

    // Item 8 — durably record every non-SAFE decision, METADATA ONLY. Never the
    // tool_input (a Bash command / file path can carry a secret literal, §20);
    // only action / risk / outcome / reason / mode. Best-effort — an audit
    // failure must never change the gate decision.
    if (result.auditLevel !== 'none') {
      try {
        appendAudit(
          agentDid,
          `coding_gate:${result.action}`,
          toolName,
          JSON.stringify({
            risk: result.risk,
            outcome: result.outcome,
            reason: result.reason,
            profile: result.profile,
            policy_version: result.policyVersion,
            authority_origin: result.authorityOriginKind,
            enforced: result.enforced,
            ...(result.permitId ? { permit_id: result.permitId } : {}),
            ...(approvalTaskId ? { task_id: approvalTaskId } : {}),
            ...(sessionId ? { session_id: sessionId } : {}),
          }),
        );
      } catch {
        /* audit is best-effort; the decision still stands */
      }
    }

    return {
      status: 200,
      body: {
        action: result.action,
        risk: result.risk,
        outcome: result.outcome,
        enforced: result.enforced,
        permit_id: result.permitId ?? null,
        task_id: approvalTaskId ?? null,
        reason: result.reason,
        profile: result.profile,
        policy_version: result.policyVersion,
        authority_origin: result.authorityOriginKind,
      },
    };
  });
}
