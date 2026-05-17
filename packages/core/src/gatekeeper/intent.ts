/**
 * Gatekeeper intent evaluation — maps actions to risk levels.
 *
 * Risk levels:
 *   SAFE      → auto-approve (search, list, query, remember, store)
 *   MODERATE  → require user approval (send >3, delete >3, modify settings)
 *   HIGH      → require user approval with clear explanation (financial, bulk ops)
 *   BLOCKED   → deny always (credential export, key access)
 *
 * Brain-denied actions — hardcoded, not configurable:
 *   did_sign, did_rotate, vault_backup, persona_unlock, seed_export,
 *   vault_raw_read, vault_raw_write, vault_export
 *   These can NEVER be performed by automated reasoning (Brain/agents).
 *
 * Audit flag: each decision carries an `audit` flag indicating whether
 * the decision should be logged to the audit trail. All non-SAFE decisions
 * are audited. Matching Go's silent-pass vs audited-pass distinction.
 *
 * Source: core/internal/adapter/gatekeeper/gatekeeper.go
 */

export type RiskLevel = 'SAFE' | 'MODERATE' | 'HIGH' | 'BLOCKED';

export interface IntentDecision {
  allowed: boolean;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  /** Whether this decision should be recorded in the audit trail. */
  audit: boolean;
  reason: string;
}

// ---------------------------------------------------------------
// Policy table — matches server gatekeeper.go exactly
// ---------------------------------------------------------------

/**
 * Canonical action → risk-level policy table. Mirrors
 * `@dina/test-harness` `DEFAULT_ACTION_POLICIES` (the cross-package
 * fixture) byte-for-byte so contract tests in core, brain, and the
 * stories suite can all assert against the same source. Any update
 * here MUST also land in `packages/test-harness/src/fixtures/constants.ts`
 * — `__tests__/gatekeeper/intent.test.ts` will fail loud if they
 * drift again.
 */
export const DEFAULT_POLICY: Record<string, RiskLevel> = {
  // SAFE — auto-approved, no prompt. Read-only + tiny user-initiated
  // actions ("search", "remember") that the Four Laws explicitly
  // permit without an interrupt.
  search: 'SAFE',
  list: 'SAFE',
  query: 'SAFE',
  remember: 'SAFE',
  store: 'SAFE',
  send_small: 'SAFE',
  delete_small: 'SAFE',
  // MODERATE — requires approval once per session. Bulk-ish
  // operations where one slip is recoverable but the user should
  // see them happen.
  send_large: 'MODERATE',
  delete_large: 'MODERATE',
  modify_settings: 'MODERATE',
  // HIGH — requires approval every invocation. Cart Handover
  // principle (README.md Four Laws): Dina advises on purchases but
  // never touches money, so any agent-initiated purchase/payment
  // surfaces to the user every time. `MONEY_ACTIONS` below adds the
  // trust-ring gate (untrusted agents are BLOCKED outright).
  purchase: 'HIGH',
  payment: 'HIGH',
  transfer_money: 'HIGH',
  bulk_operation: 'HIGH',
  // BLOCKED — always denied. The user goes through the UI for these,
  // not an agent.
  credential_export: 'BLOCKED',
  key_access: 'BLOCKED',
  read_vault: 'BLOCKED',
};

/**
 * Actions that Brain/agents can NEVER perform — user-only via UI.
 *
 * Includes the 3 vault actions missing from mobile (A27 #3):
 * vault_raw_read, vault_raw_write, vault_export
 */
export const BRAIN_DENIED = new Set([
  'did_sign',
  'did_rotate',
  'vault_backup',
  'persona_unlock',
  'seed_export',
  'vault_raw_read',
  'vault_raw_write',
  'vault_export',
]);

const RISK_REASONS: Record<RiskLevel, string> = {
  SAFE: 'Action is safe — auto-approved',
  MODERATE: 'Action requires user approval',
  HIGH: 'High-risk action — requires explicit user approval with explanation',
  BLOCKED: 'Action is blocked by security policy',
};

/**
 * Money actions — require Ring 2+ trust (verified/self).
 * Untrusted agents attempting these are BLOCKED outright.
 * Matching Go's trust-ring enforcement for financial operations.
 */
const MONEY_ACTIONS = new Set(['purchase', 'payment']);

// ---------------------------------------------------------------
// Public API
// ---------------------------------------------------------------

/**
 * Evaluate an action's risk level based on the default policy table.
 *
 * Returns an IntentDecision with an `audit` flag:
 *   SAFE → audit: false (silent-pass)
 *   MODERATE/HIGH/BLOCKED → audit: true (logged)
 *
 * @param action - The action being attempted (e.g., "search", "purchase")
 * @param agentDID - The agent requesting the action (optional)
 * @param trustLevel - The agent's trust level (optional: "verified", "unknown")
 */
export function evaluateIntent(
  action: string,
  agentDID?: string,
  trustLevel?: string,
): IntentDecision {
  // Brain-denied check first — these are always BLOCKED for automated callers
  if (isBrainDenied(action)) {
    return {
      allowed: false,
      riskLevel: 'BLOCKED',
      requiresApproval: false,
      audit: true,
      reason: `Action "${action}" is brain-denied — requires direct user interaction`,
    };
  }

  let riskLevel = getDefaultRiskLevel(action) ?? 'MODERATE';

  // Trust-ring enforcement for money actions: untrusted agents are BLOCKED.
  // Ring 2+ (verified/self) required for financial operations.
  // Matching Go's trust-ring check for purchase/payment.
  const RING2_LEVELS = ['verified', 'self'];
  if (
    isMoneyAction(action) &&
    trustLevel !== undefined &&
    !RING2_LEVELS.includes(trustLevel) &&
    trustLevel !== ''
  ) {
    return {
      allowed: false,
      riskLevel: 'BLOCKED',
      requiresApproval: false,
      audit: true,
      reason: `Action "${action}" requires Ring 2+ trust (verified/self) — "${trustLevel}" is insufficient`,
    };
  }

  // Trust-based adjustment: any non-trusted agent escalates SAFE → MODERATE
  // Trusted levels: 'verified', 'self', undefined/empty (user-initiated)
  const TRUSTED_LEVELS = ['verified', 'self', '', undefined];
  if (trustLevel !== undefined && !TRUSTED_LEVELS.includes(trustLevel) && riskLevel === 'SAFE') {
    riskLevel = 'MODERATE';
  }

  const allowed = riskLevel !== 'BLOCKED';
  const requiresApproval = riskLevel === 'MODERATE' || riskLevel === 'HIGH';

  // Audit flag: SAFE decisions are silent-pass; all others are audited
  const audit = riskLevel !== 'SAFE';

  return {
    allowed,
    riskLevel,
    requiresApproval,
    audit,
    reason: RISK_REASONS[riskLevel],
  };
}

/**
 * Evaluate an action with persona-lock pre-check.
 *
 * Before evaluating the action's risk level, checks if the target
 * persona is open. If the persona is locked, the intent is denied
 * without further evaluation — matching Go's ensureOpen check.
 *
 * @param action - The action being attempted
 * @param personaOpen - Whether the target persona vault is currently open
 * @param agentDID - The agent requesting the action (optional)
 * @param trustLevel - The agent's trust level (optional)
 */
export function evaluateIntentWithPersona(
  action: string,
  personaOpen: boolean,
  agentDID?: string,
  trustLevel?: string,
): IntentDecision {
  // Persona-lock pre-check: deny if persona is not open
  if (!personaOpen) {
    return {
      allowed: false,
      riskLevel: 'BLOCKED',
      requiresApproval: false,
      audit: true,
      reason: `Persona is locked — unlock before performing "${action}"`,
    };
  }

  return evaluateIntent(action, agentDID, trustLevel);
}

/**
 * Check if an action is brain-denied (hardcoded deny, not configurable).
 *
 * Brain-denied actions can NEVER be performed by automated reasoning:
 * did_sign, did_rotate, vault_backup, persona_unlock, seed_export,
 * vault_raw_read, vault_raw_write, vault_export
 */
export function isBrainDenied(action: string): boolean {
  return BRAIN_DENIED.has(action);
}

/**
 * Check if an action is a money/financial action requiring Ring 2+ trust.
 */
export function isMoneyAction(action: string): boolean {
  return MONEY_ACTIONS.has(action);
}

/**
 * Get the risk level for an action from the default policy table.
 * Returns undefined for unknown actions (treated as MODERATE by evaluateIntent).
 */
export function getDefaultRiskLevel(action: string): RiskLevel | undefined {
  return DEFAULT_POLICY[action];
}
