/**
 * Persona access gate — pure decision primitive (CLAUDE.md §Persona Access Tiers).
 *
 * Dina's Core treats every persona under a 4-tier access policy:
 *
 *   - `default`   — auto-open. All callers free.
 *   - `standard`  — auto-open. User + Brain free. Agents need session grant.
 *   - `sensitive` — closed by default. User needs confirm. Brain + agent
 *                   need approval per call.
 *   - `locked`    — fully locked. Passphrase required before ANY access.
 *
 * The Go Core owns the authoritative gatekeeper; this primitive is the
 * Brain-side mirror used to short-circuit callers that obviously can't
 * pass + to produce a structured explanation a UI can render ("requires
 * passphrase to unlock /health").
 *
 * **Pure** — no IO, no clock, no state. Two inputs go in, one tagged
 * outcome comes out. Deterministic, testable, no injection needed.
 *
 * **Caller roles**:
 *   - `user`   — the human, via CLI or mobile (owns device key).
 *   - `brain`  — Brain-internal callers (e.g. guardian loop).
 *   - `agent`  — 3rd-party agent speaking Dina protocol.
 *   - `admin`  — admin UI with CLIENT_TOKEN auth.
 *
 * **Operations** (granularity matters for routing):
 *   - `read`   — query vault items.
 *   - `write`  — store vault items.
 *   - `share`  — surface to 3rd parties (nudge to another dina,
 *                service.query, etc).
 *   - `export` — bulk export / migration.
 *
 * **Decision tree** (first match wins):
 *
 *   1. Locked persona → passphrase required regardless of caller.
 *   2. Sensitive persona:
 *        user: always allow (own data).
 *        brain + agent + admin: require `approval` unless persona is open
 *                               AND a session grant covers this op.
 *        export: admin-only.
 *   3. Standard persona:
 *        user + brain: allow if open.
 *        agent: allow if open AND session grant covers op.
 *        export: admin-only OR user.
 *   4. Default persona: allow all callers (public-by-design).
 *
 * **Not in scope**: the session grant layer itself (where the caller
 * stores per-agent scopes). This primitive accepts a `sessionGrant?`
 * that the caller has already resolved.
 */

export type PersonaGateTier = 'default' | 'standard' | 'sensitive' | 'locked';
export type PersonaGateCaller = 'user' | 'brain' | 'agent' | 'admin';
export type PersonaGateOp = 'read' | 'write' | 'share' | 'export';

export interface PersonaGateSessionGrant {
  /** Ops this grant covers. */
  ops: ReadonlyArray<PersonaGateOp>;
  /** Unix seconds — grant expires at/after this time. */
  expiresAtSec: number;
}

export interface PersonaGateInput {
  persona: {
    name: string;
    tier: PersonaGateTier;
    /**
     * Whether the persona's DEK is currently loaded in Core's RAM.
     * A closed persona means writes/reads go through the unlock path.
     */
    open: boolean;
  };
  caller: {
    role: PersonaGateCaller;
    /** Caller DID — useful in audit logs but not used for decisions. */
    did?: string;
  };
  op: PersonaGateOp;
  /** Caller's active session grant, if any. */
  sessionGrant?: PersonaGateSessionGrant;
  /** Unix seconds — compared against sessionGrant.expiresAtSec. */
  nowSec?: number;
}

export type PersonaGateReason =
  | 'allowed_default_tier'
  | 'allowed_owner'
  | 'allowed_open_persona'
  | 'allowed_session_grant'
  | 'allowed_admin_export'
  | 'denied_locked_passphrase_required'
  | 'denied_sensitive_approval_required'
  | 'denied_persona_closed'
  | 'denied_agent_no_grant'
  | 'denied_agent_grant_expired'
  | 'denied_agent_op_outside_grant'
  | 'denied_export_non_admin'
  | 'denied_unknown_role_or_op'
  | 'denied_invalid_input';

export type PersonaGateRequired =
  | 'passphrase'
  | 'approval'
  | 'session_grant'
  | 'admin_auth'
  | 'unlock_session';

export type PersonaGateOutcome =
  | { allow: true; reason: PersonaGateReason }
  | { allow: false; reason: PersonaGateReason; required?: PersonaGateRequired };

/**
 * Decide whether `caller` may perform `op` on `persona`. Returns a
 * tagged outcome with a machine-readable reason + (on deny) the
 * required next step the caller should guide the user through.
 */
export function checkPersonaGate(input: PersonaGateInput): PersonaGateOutcome {
  const validation = validate(input);
  if (validation !== null) {
    return { allow: false, reason: 'denied_invalid_input' };
  }

  const { persona, caller, op } = input;

  // 1. Locked persona — passphrase required regardless of role.
  if (persona.tier === 'locked') {
    return {
      allow: false,
      reason: 'denied_locked_passphrase_required',
      required: 'passphrase',
    };
  }

  // 2. Export ops require admin (or user on non-sensitive tiers).
  if (op === 'export') {
    if (caller.role === 'admin') {
      return { allow: true, reason: 'allowed_admin_export' };
    }
    if (caller.role === 'user' && persona.tier !== 'sensitive') {
      return { allow: true, reason: 'allowed_owner' };
    }
    return {
      allow: false,
      reason: 'denied_export_non_admin',
      required: 'admin_auth',
    };
  }

  // 3. Sensitive persona — user owns it, others need approval unless
  //    they have a session grant that covers this op on an open persona.
  if (persona.tier === 'sensitive') {
    if (caller.role === 'user') {
      return { allow: true, reason: 'allowed_owner' };
    }
    if (!persona.open) {
      return {
        allow: false,
        reason: 'denied_persona_closed',
        required: 'unlock_session',
      };
    }
    // Open + non-user caller — approval required per call (no grant bypass).
    return {
      allow: false,
      reason: 'denied_sensitive_approval_required',
      required: 'approval',
    };
  }

  // 4. Standard tier.
  if (persona.tier === 'standard') {
    if (caller.role === 'user' || caller.role === 'admin' || caller.role === 'brain') {
      if (!persona.open) {
        return {
          allow: false,
          reason: 'denied_persona_closed',
          required: 'unlock_session',
        };
      }
      return { allow: true, reason: 'allowed_open_persona' };
    }
    if (caller.role === 'agent') {
      return evaluateAgentGrant(input);
    }
  }

  // 5. Default tier — free for everyone (agents still need a grant to
  //    avoid anonymous full-surface access, but the grant bar is lower).
  if (persona.tier === 'default') {
    if (caller.role === 'agent') {
      return evaluateAgentGrant(input);
    }
    return { allow: true, reason: 'allowed_default_tier' };
  }

  return { allow: false, reason: 'denied_unknown_role_or_op' };
}

// ── Internals ──────────────────────────────────────────────────────────

function validate(input: PersonaGateInput): string | null {
  if (!input || typeof input !== 'object') return 'input required';
  if (!input.persona || typeof input.persona !== 'object') return 'persona required';
  if (typeof input.persona.name !== 'string' || input.persona.name === '') return 'persona.name required';
  if (!isValidTier(input.persona.tier)) return 'invalid tier';
  if (typeof input.persona.open !== 'boolean') return 'persona.open must be boolean';
  if (!input.caller || !isValidCaller(input.caller.role)) return 'invalid caller role';
  if (!isValidOp(input.op)) return 'invalid op';
  if (input.sessionGrant !== undefined) {
    if (!Array.isArray(input.sessionGrant.ops)) return 'sessionGrant.ops must be array';
    if (!Number.isFinite(input.sessionGrant.expiresAtSec)) return 'sessionGrant.expiresAtSec must be finite';
  }
  if (input.nowSec !== undefined && !Number.isFinite(input.nowSec)) {
    return 'nowSec must be finite';
  }
  return null;
}

function evaluateAgentGrant(input: PersonaGateInput): PersonaGateOutcome {
  if (!input.sessionGrant) {
    return {
      allow: false,
      reason: 'denied_agent_no_grant',
      required: 'session_grant',
    };
  }
  if (input.nowSec !== undefined && input.sessionGrant.expiresAtSec <= input.nowSec) {
    return {
      allow: false,
      reason: 'denied_agent_grant_expired',
      required: 'session_grant',
    };
  }
  if (!input.sessionGrant.ops.includes(input.op)) {
    return {
      allow: false,
      reason: 'denied_agent_op_outside_grant',
      required: 'session_grant',
    };
  }
  if (!input.persona.open) {
    return {
      allow: false,
      reason: 'denied_persona_closed',
      required: 'unlock_session',
    };
  }
  return { allow: true, reason: 'allowed_session_grant' };
}

function isValidTier(t: unknown): t is PersonaGateTier {
  return t === 'default' || t === 'standard' || t === 'sensitive' || t === 'locked';
}

function isValidCaller(r: unknown): r is PersonaGateCaller {
  return r === 'user' || r === 'brain' || r === 'agent' || r === 'admin';
}

function isValidOp(o: unknown): o is PersonaGateOp {
  return o === 'read' || o === 'write' || o === 'share' || o === 'export';
}
