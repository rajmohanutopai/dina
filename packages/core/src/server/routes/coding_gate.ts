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

import { appendAudit } from '../../audit/service';

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
  reason: string;
}

export interface CodingGateInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Authenticated agent DID (never client-supplied). */
  agentDid: string;
  /** Agent session id (from `dina_session_start`); '' if none. */
  sessionId: string;
  /** Agent working dir for relative-path resolution; undefined ⇒ Core cwd. */
  cwd?: string;
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
    const agentDid =
      req.callerDID ?? (typeof xDID === 'string' && xDID !== '' ? xDID : '');
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
    const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
    const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : undefined;

    if (!gate) {
      return { status: 501, body: { error: 'coding gate not available on this node' } };
    }

    const result = await gate({
      toolName,
      toolInput,
      agentDid,
      sessionId,
      cwd,
      mode: modeRaw,
    });

    // Item 8 — durably record every non-SAFE decision, METADATA ONLY. Never the
    // tool_input (a Bash command / file path can carry a secret literal, §20);
    // only action / risk / outcome / reason / mode. Best-effort — an audit
    // failure must never change the gate decision.
    if (result.risk !== 'SAFE') {
      try {
        appendAudit(
          agentDid,
          `coding_gate:${result.action}`,
          toolName,
          JSON.stringify({
            risk: result.risk,
            outcome: result.outcome,
            reason: result.reason,
            mode: modeRaw,
            enforced: result.enforced,
            ...(result.permitId ? { permit_id: result.permitId } : {}),
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
        reason: result.reason,
      },
    };
  });
}
