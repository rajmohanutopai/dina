/**
 * Agent gateway — safety layer for agent-initiated actions (README §Agent Safety Layer).
 *
 * From CLAUDE.md:
 *
 *   "Dina also solves a critical safety gap: autonomous agents today
 *    operate without oversight... Any agent supporting the Dina
 *    protocol submits its intent to Dina before acting. Dina checks:
 *    does this violate your privacy rules? Is this vendor trusted?
 *    Are you in the right state to make this decision? Safe tasks
 *    pass through silently. Risky actions (sending email, moving
 *    money, sharing data) are flagged for your review."
 *
 * This primitive is the **decision point**: given an agent's proposed
 * action + context, it returns one of three outcomes:
 *
 *   - `allow`   — safe action; proceed silently.
 *   - `review`  — risky; surface to the user for confirmation.
 *   - `block`   — forbidden by policy; never proceeds.
 *
 * **Composes** existing primitives:
 *
 *   - `checkPersonaGate` — per-persona access control.
 *   - `RateLimiter`      — per-agent action throttling.
 *
 * **Risk categories** (agent-declared; the decider maps to severity):
 *
 *   - `read`      — query data. Generally safe.
 *   - `send`      — email/message/notification. Usually review.
 *   - `pay`       — money movement. ALWAYS review (cart handover rule).
 *   - `share`     — 3rd-party data share. Usually review.
 *   - `delete`    — destructive. ALWAYS review.
 *   - `execute`   — run code. ALWAYS review.
 *
 * **Rule order** (first match wins):
 *
 *   1. Invalid input → block(`invalid_input`).
 *   2. Persona gate denies → block(`persona_denied`) with the gate's `required`.
 *   3. Rate limiter denies → block(`rate_limited`).
 *   4. Risk category is always-review → review(`risk_<category>`).
 *   5. Declared risk exceeds the agent's grant → review(`risk_over_grant`).
 *   6. Otherwise → allow.
 *
 * **Pure + injected**: the limiter + gate are passed in. Tests exercise
 * allow/review/block paths without spinning up the real subsystem.
 */

import {
  type PersonaGateInput,
  type PersonaGateOp,
  type PersonaGateRequired,
  checkPersonaGate,
} from './persona_gate';
import type { RateLimiter } from './rate_limiter';

export type AgentRisk = 'read' | 'send' | 'pay' | 'share' | 'delete' | 'execute';

export interface AgentIntent {
  /** Agent DID — identifies the caller + feeds the rate limiter key. */
  agentDid: string;
  /** The agent's declared action category. */
  risk: AgentRisk;
  /** Target persona of the action. */
  persona: { name: string; tier: PersonaGateInput['persona']['tier']; open: boolean };
  /** Op against the persona — matches persona_gate ops. */
  op: PersonaGateOp;
  /** Session grant covering this action (optional). */
  sessionGrant?: PersonaGateInput['sessionGrant'];
  /** Unix seconds — feeds persona_gate expiry check. */
  nowSec?: number;
  /** Free-form human label surfaced in the review prompt. */
  label?: string;
}

export interface AgentGatewayOptions {
  rateLimiter: RateLimiter;
  /**
   * Risk categories that ALWAYS route to review regardless of other
   * signals. Defaults to `['pay', 'delete', 'execute']`.
   */
  alwaysReviewRisks?: ReadonlyArray<AgentRisk>;
  /**
   * Max risks the agent's grant covers without escalation. Default is
   * `['read']` — anything beyond read forces review for non-pre-approved
   * agents.
   */
  grantedRisks?: ReadonlyArray<AgentRisk>;
}

export type AgentGatewayOutcome =
  | { action: 'allow'; reason: 'gated_and_rate_limited_ok' }
  | {
      action: 'review';
      reason: AgentReviewReason;
      risk: AgentRisk;
      label?: string;
    }
  | {
      action: 'block';
      reason: AgentBlockReason;
      detail?: string;
      /** Next step the CLI / admin UI should prompt the user for. */
      required?: PersonaGateRequired;
      /** On rate-limit: ms until the agent can retry. */
      retryAfterMs?: number;
    };

export type AgentReviewReason =
  | 'risk_always_review'
  | 'risk_over_grant';

export type AgentBlockReason =
  | 'invalid_input'
  | 'persona_denied'
  | 'rate_limited';

export const DEFAULT_ALWAYS_REVIEW_RISKS: ReadonlyArray<AgentRisk> = [
  'pay',
  'delete',
  'execute',
];
export const DEFAULT_GRANTED_RISKS: ReadonlyArray<AgentRisk> = ['read'];

/**
 * Build the gateway. Returns a function that scores one intent at a
 * time. Stateful only via the injected `RateLimiter` (per-agent buckets).
 */
export function createAgentGateway(
  opts: AgentGatewayOptions,
): (intent: AgentIntent) => AgentGatewayOutcome {
  if (!opts?.rateLimiter) {
    throw new TypeError('createAgentGateway: rateLimiter required');
  }
  const rateLimiter = opts.rateLimiter;
  const alwaysReview = new Set<AgentRisk>(
    opts.alwaysReviewRisks ?? DEFAULT_ALWAYS_REVIEW_RISKS,
  );
  const granted = new Set<AgentRisk>(
    opts.grantedRisks ?? DEFAULT_GRANTED_RISKS,
  );

  return function decide(intent: AgentIntent): AgentGatewayOutcome {
    // 1. Input validation.
    const err = validate(intent);
    if (err !== null) {
      return { action: 'block', reason: 'invalid_input', detail: err };
    }

    // 2. Persona gate.
    const gateInput: PersonaGateInput = {
      persona: intent.persona,
      caller: { role: 'agent', did: intent.agentDid },
      op: intent.op,
    };
    if (intent.sessionGrant !== undefined) gateInput.sessionGrant = intent.sessionGrant;
    if (intent.nowSec !== undefined) gateInput.nowSec = intent.nowSec;
    const gate = checkPersonaGate(gateInput);
    if (!gate.allow) {
      return gate.required !== undefined
        ? {
            action: 'block',
            reason: 'persona_denied',
            detail: gate.reason,
            required: gate.required,
          }
        : {
            action: 'block',
            reason: 'persona_denied',
            detail: gate.reason,
          };
    }

    // 3. Rate limit.
    const rl = rateLimiter.consume(intent.agentDid);
    if (!rl.allowed) {
      return {
        action: 'block',
        reason: 'rate_limited',
        retryAfterMs: rl.retryAfterMs,
      };
    }

    // 4. Always-review categories.
    if (alwaysReview.has(intent.risk)) {
      const review: Extract<AgentGatewayOutcome, { action: 'review' }> = {
        action: 'review',
        reason: 'risk_always_review',
        risk: intent.risk,
      };
      if (intent.label !== undefined) review.label = intent.label;
      return review;
    }

    // 5. Risk exceeds grant.
    if (!granted.has(intent.risk)) {
      const review: Extract<AgentGatewayOutcome, { action: 'review' }> = {
        action: 'review',
        reason: 'risk_over_grant',
        risk: intent.risk,
      };
      if (intent.label !== undefined) review.label = intent.label;
      return review;
    }

    // 6. Allow.
    return { action: 'allow', reason: 'gated_and_rate_limited_ok' };
  };
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(intent: AgentIntent): string | null {
  if (!intent || typeof intent !== 'object') return 'intent required';
  if (typeof intent.agentDid !== 'string' || !intent.agentDid.startsWith('did:')) {
    return 'agentDid must be a DID';
  }
  if (
    intent.risk !== 'read' &&
    intent.risk !== 'send' &&
    intent.risk !== 'pay' &&
    intent.risk !== 'share' &&
    intent.risk !== 'delete' &&
    intent.risk !== 'execute'
  ) {
    return 'invalid risk';
  }
  if (!intent.persona || typeof intent.persona.name !== 'string' || intent.persona.name === '') {
    return 'persona.name required';
  }
  return null;
}
