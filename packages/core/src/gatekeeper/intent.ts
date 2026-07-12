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

// ---------------------------------------------------------------
// Plugin intent evaluation (PLUGIN_ARCHITECTURE.md §8)
// ---------------------------------------------------------------

/**
 * Risk floors for runner-mode plugin capabilities, keyed off
 * `action_class` (§8). Self-declared risk is an attack, so risk is
 * computed locally and declarations may only RAISE it.
 *
 *   read → SAFE   quote → SAFE   booking → HIGH
 *   write → HIGH  agentic → HIGH payment → BLOCKED (every ring, forever)
 *
 * SAFE is reserved for CATALOG-CANONICAL capabilities whose semantics
 * Dina knows; custom ids never floor below MODERATE — Dina cannot
 * verify that runner code labeled `read` doesn't book, write, or spend
 * on its own backend.
 */
export const PLUGIN_ACTION_FLOORS: Record<string, RiskLevel> = {
  read: 'SAFE',
  quote: 'SAFE',
  booking: 'HIGH',
  write: 'HIGH',
  agentic: 'HIGH',
  payment: 'BLOCKED',
};

/** First-N rule (§8): HIGH capabilities card the first N invocations
 * even after a standing approval exists. §21 open decision 1. */
export const PLUGIN_FIRST_N = 3;

const RISK_ORDER: Record<RiskLevel, number> = { SAFE: 0, MODERATE: 1, HIGH: 2, BLOCKED: 3 };

function isRiskLevel(v: unknown): v is RiskLevel {
  return typeof v === 'string' && v in RISK_ORDER;
}

/**
 * Returns the higher of two risk levels. Audit D5: an out-of-enum
 * `b` (e.g. a garbage manifest hint) used to slip through because
 * `RISK_ORDER[garbage]` is undefined and `n >= undefined` is always
 * false — so maxRisk returned `b`, LOWERING the floor to an invalid
 * level that could run silent. Both inputs are now rank-safe: an
 * unknown level ranks as BLOCKED (maximal), so it can only ever
 * RAISE, and a caller that reaches here with a bad value fails toward
 * blocked, never toward silent.
 */
function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  const rank = (r: RiskLevel): number => RISK_ORDER[r] ?? RISK_ORDER.BLOCKED;
  return rank(a) >= rank(b) ? a : b;
}

export type PluginPublisherRing = 'unverified' | 'verified' | 'verified_actioned';

export interface PluginIntentInput {
  /** Pinned envelope `action_class` — the task's own frozen authority. */
  actionClass: string;
  /** Capability id (custom reverse-DNS or canonical catalog id). */
  capabilityId: string;
  /** Locally computed (classifyCatalogCapability) — NEVER manifest-claimed. */
  capabilityKind: 'canonical' | 'custom';
  /** Manifest risk hint — may only RAISE the computed floor (§8). */
  declaredRisk?: RiskLevel;
  /**
   * The capability's declared `privacy_class` (Round-6 #2). Consumed as a risk
   * signal that may only RAISE the floor: a non-`public` class means the
   * capability's own declaration says its data is not public, so it must never
   * run silent; `sensitive`/`regulated` force an explicit approval.
   */
  privacyClass?: string;
  publisherRing: PluginPublisherRing;
  /** data_scope intersects a sensitive-tier persona (§8 privacy clamp). */
  touchesSensitivePersona: boolean;
  /** data_scope names a locked persona — NEVER in scope in v1 (§11). */
  touchesLockedPersona: boolean;
  /** Prior invocations of this (install, capability) — first-N counter. */
  priorInvocations: number;
  /** A live standing approval matched (grants.authorizeAndConsume). */
  hasStandingApproval: boolean;
}

export interface PluginIntentDecision extends IntentDecision {
  /** What the dispatch layer does: run silent, raise a card, or refuse. */
  mode: 'silent' | 'card' | 'blocked';
  /** True when the first-N rule forced this card despite an approval. */
  firstNCard: boolean;
}

/**
 * Deterministic, table-driven, no LLM, fail-safe `?? MODERATE` —
 * the plugin twin of `evaluateIntent` (§8). Both modes enter through
 * this same gate; BRAIN_DENIED runs before risk lookup so no plugin
 * capability can name sign/rotate/export/raw-vault operations.
 *
 * NOTE: `mode === 'silent'` is NECESSARY, never sufficient — SAFE runs
 * silent only if the params clear egress (§11 point 5); that gate is
 * the dispatch layer's job and cannot be pre-computed here.
 */
export function evaluatePluginIntent(input: PluginIntentInput): PluginIntentDecision {
  const blocked = (reason: string): PluginIntentDecision => ({
    allowed: false,
    riskLevel: 'BLOCKED',
    requiresApproval: false,
    audit: true,
    reason,
    mode: 'blocked',
    firstNCard: false,
  });

  // 1. BRAIN_DENIED runs BEFORE risk lookup (§8): a capability id whose
  //    terminal segment names a brain-denied operation is refused
  //    outright, whatever the manifest claims.
  const lastSegment = input.capabilityId.split('.').pop() ?? '';
  if (isBrainDenied(lastSegment) || isBrainDenied(input.actionClass)) {
    return blocked(
      `Capability "${input.capabilityId}" names a brain-denied operation — automated callers can never perform it`,
    );
  }

  // 2. Locked personas are NEVER in a plugin's scope (§11): stricter
  //    than agents, because a plugin is ambient automation.
  if (input.touchesLockedPersona) {
    return blocked('Locked personas are never in a plugin data scope (§11)');
  }

  // 3. Floor from action_class — fail-safe MODERATE for anything the
  //    table doesn't know (§8: `?? 'MODERATE'`).
  let risk = PLUGIN_ACTION_FLOORS[input.actionClass] ?? 'MODERATE';

  // 4. payment is BLOCKED at every ring, forever (§8): the floor table
  //    says so, and no amendment below can lower it.
  if (risk === 'BLOCKED') {
    return blocked('payment-class capabilities are BLOCKED at every trust ring, forever (§8)');
  }

  // 5. Custom ids never floor below MODERATE — the declared class is a
  //    consent label, not proof (§8).
  if (input.capabilityKind !== 'canonical') {
    risk = maxRisk(risk, 'MODERATE');
  }

  // 6. Declared risk may only RAISE (§8: self-declared risk is an
  //    attack). A declared BLOCKED blocks. Audit D5: an out-of-enum
  //    declared value (garbage from a malformed manifest) is coerced to
  //    BLOCKED — a risk hint we cannot understand fails toward blocked,
  //    never toward silent, and never becomes the effective level.
  if (input.declaredRisk !== undefined) {
    const declared = isRiskLevel(input.declaredRisk) ? input.declaredRisk : 'BLOCKED';
    risk = maxRisk(risk, declared);
    if (risk === 'BLOCKED') {
      return blocked('manifest declares this capability BLOCKED or an unrecognized risk level');
    }
  }

  // 7. Trust-ring clamp: publisher not Verified → nothing runs silent.
  if (input.publisherRing === 'unverified') {
    risk = maxRisk(risk, 'MODERATE');
  }

  // 8. Privacy clamp: sensitive-persona scope → every invocation carded.
  if (input.touchesSensitivePersona) {
    risk = maxRisk(risk, 'HIGH');
  }

  // 8b. Privacy-CLASS clamp (Round-6 #2): the capability's own declared
  //     privacy_class is a risk signal, may only RAISE. A non-`public` class
  //     means the capability declares its data is not public → never silent;
  //     `sensitive`/`regulated` force an explicit approval (HIGH). Self-declared
  //     risk can only make things stricter, never looser — same rule as §8.
  if (input.privacyClass === 'personal') {
    risk = maxRisk(risk, 'MODERATE');
  } else if (input.privacyClass === 'sensitive' || input.privacyClass === 'regulated') {
    risk = maxRisk(risk, 'HIGH');
  }

  // 9. First-N: HIGH capabilities card the first N invocations even
  //    after a standing approval exists (§8).
  const firstNCard =
    risk === 'HIGH' && input.priorInvocations < PLUGIN_FIRST_N && input.hasStandingApproval;

  // Round-7 #1: a `sensitive`/`regulated` privacy_class must card EVERY
  // invocation, exactly like a sensitive-persona scope — a standing approval
  // never silences it. Raising the risk to HIGH alone was insufficient: after
  // the first N, a HIGH capability with a standing approval would run silent,
  // contradicting the approval-every-time policy for regulated data.
  const sensitivePrivacy = input.privacyClass === 'sensitive' || input.privacyClass === 'regulated';

  // 10. Mode. Sensitive-persona scope (or a sensitive/regulated privacy_class)
  //     cards EVERY invocation — a standing approval never silences it.
  let mode: 'silent' | 'card';
  if (risk === 'SAFE') {
    mode = 'silent';
  } else if (
    input.hasStandingApproval &&
    !firstNCard &&
    !input.touchesSensitivePersona &&
    !sensitivePrivacy
  ) {
    // Standing approval silences MODERATE/HIGH beyond the first N —
    // an explicit human decision, not a manifest claim (§8).
    mode = 'silent';
  } else {
    mode = 'card';
  }

  return {
    allowed: true,
    riskLevel: risk,
    requiresApproval: mode === 'card',
    // Non-SAFE decisions are ALWAYS audited, silent-via-grant included:
    // a grant-silenced HIGH execution still lands in the decision log.
    audit: risk !== 'SAFE',
    reason:
      mode === 'silent'
        ? risk === 'SAFE'
          ? 'SAFE floor — silent if params clear egress (§11.5)'
          : 'standing approval beyond first-N — silent if params clear egress (§11.5)'
        : firstNCard
          ? `first ${PLUGIN_FIRST_N} invocations of a HIGH capability always card (§8)`
          : RISK_REASONS[risk],
    mode,
    firstNCard,
  };
}
