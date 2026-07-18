/**
 * Push silence reconciliation + the §8 delivery decision
 * (PUSH_SERVICES_ARCHITECTURE.md §5/§8/§9). Pure. "The provider proposes; Dina
 * disposes": `claimed_priority` is untrusted input; Dina re-derives the tier,
 * caps it at the subscriber's ceiling, inverts repetition to DOWNGRADE (never
 * escalate), and reaches Fiduciary only with TWO independent yeses (a
 * subscriber-declared harm topic AND Dina's own harm concurrence).
 *
 * Tiers are the silence-classifier tiers (1=Fiduciary, 2=Solicited,
 * 3=Engagement; a LARGER number is QUIETER).
 */

export type PushTier = 1 | 2 | 3;
export type ClaimedPriority = 'engagement' | 'solicited' | 'fiduciary';

export function priorityToTier(p: ClaimedPriority): PushTier {
  switch (p) {
    case 'fiduciary':
      return 1;
    case 'solicited':
      return 2;
    case 'engagement':
      return 3;
  }
}

export interface ClassifyPushInput {
  /** the provider's claimed urgency — a request, not a grant. */
  claimed_priority: ClaimedPriority;
  /** the subscriber's ceiling (caps how loud the provider may ever be). */
  priority_ceiling: ClaimedPriority;
  /** subscriber declared this topic a harm topic (yes #1 for Fiduciary). */
  harm_topic: boolean;
  /** Dina's own deterministic harm assessment concurs (yes #2 for Fiduciary). */
  harm_concurs: boolean;
  /** cry-wolf effective-ceiling downgrade (§12): a floor that is never louder
   *  than the authorization ceiling. */
  cry_wolf_floor?: PushTier;
}

/**
 * Derive the delivered tier (§9). Order: cap the provider claim at the ceiling
 * (quieter-of, numeric max); Fiduciary requires the two independent yeses (the
 * provider is never one of them); apply any cry-wolf downgrade (never louder).
 */
export function classifyPushTier(i: ClassifyPushInput): PushTier {
  const claimTier = priorityToTier(i.claimed_priority);
  const ceilingTier = priorityToTier(i.priority_ceiling);

  // Provider claim capped at the ceiling (quieter-of). A provider can never
  // self-elevate above the subscriber's ceiling.
  let tier: PushTier = clampTier(Math.max(claimTier, ceilingTier));

  // Fiduciary (Tier 1) is reachable ONLY with two independent yeses; otherwise
  // the floor is Solicited (2) even if ceiling+claim would allow 1.
  if (tier === 1 && !(i.harm_topic && i.harm_concurs)) {
    tier = 2;
  }

  // Cry-wolf downgrade: never make it louder than the current tier.
  if (i.cry_wolf_floor !== undefined) {
    tier = clampTier(Math.max(tier, i.cry_wolf_floor));
  }
  return tier;
}

function clampTier(n: number): PushTier {
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

export type PushEventKind = 'informational' | 'action';

/** Over-`rate_budget` disposition, by kind (§8 step 7 / §7). An informational
 *  overage is DEMOTED to the briefing (never dropped-for-frequency by default);
 *  an action overage is a RETRYABLE reject (never demoted below its Tier-2 base,
 *  no `rate_held` state). */
export type OverBudgetDisposition =
  | { disposition: 'demote_to_briefing'; tier: 3 }
  | { disposition: 'retryable_reject' };

export function overBudgetDisposition(kind: PushEventKind): OverBudgetDisposition {
  return kind === 'informational'
    ? { disposition: 'demote_to_briefing', tier: 3 }
    : { disposition: 'retryable_reject' };
}

/**
 * Cry-wolf effective-ceiling downgrade (§12). A provider that claims
 * Solicited/Fiduciary and is immediately dismissed/muted N times (a small
 * published threshold) has its effective ceiling lowered Solicited → Engagement,
 * so it can no longer interrupt. Returns the tier floor to apply, or undefined.
 */
export function cryWolfFloor(dismissCount: number, threshold: number): PushTier | undefined {
  return dismissCount >= threshold ? 3 : undefined;
}

// ---------------------------------------------------------------------------
// The §8 pipeline decision (composed from the gates' verified inputs).
// ---------------------------------------------------------------------------

export interface PushPipelineInput {
  /** an active push grant matched (§8 step 4). false ⇒ drop/quarantine. */
  authorized: boolean;
  /** the event's condition_ref matches the authorized condition (§8 step 5). */
  condition_matches: boolean;
  /** the transport-authenticated sender is blocked (§8 step 3). */
  sender_blocked: boolean;
  /** past the event's expires_at (§8 step 6). */
  stale: boolean;
  /** a duplicate of an already-claimed logical event (§8 step 6). */
  duplicate: boolean;
  /** a rate-budget token was available for this logical event (§8 step 7). */
  budget_available: boolean;
  kind: PushEventKind;
  tier: PushTier; // the classified tier (§9), already ceiling-capped
  /** the topic's persona is currently locked (§8 step 9). */
  persona_locked: boolean;
}

export type PushDeliveryDecision =
  | { action: 'drop'; reason: 'unauthorized' | 'condition_mismatch' | 'blocked' | 'stale' }
  | { action: 'collapse'; reason: 'duplicate' }
  | { action: 'reject'; reason: 'over_budget_action' }
  | { action: 'hold'; reason: 'persona_locked'; tier: PushTier }
  | { action: 'deliver'; tier: PushTier; demoted: boolean };

/**
 * The §8 delivery pipeline as a pure decision (order matters; each gate fails
 * closed). Composes: block → authorization → condition → staleness/dedup →
 * budget (by kind) → persona-lock → deliver.
 */
export function decidePushDelivery(i: PushPipelineInput): PushDeliveryDecision {
  if (i.sender_blocked) return { action: 'drop', reason: 'blocked' };
  if (!i.authorized) return { action: 'drop', reason: 'unauthorized' };
  if (!i.condition_matches) return { action: 'drop', reason: 'condition_mismatch' };
  if (i.stale) return { action: 'drop', reason: 'stale' };
  if (i.duplicate) return { action: 'collapse', reason: 'duplicate' };

  let deliverTier = i.tier;
  let demoted = false;
  if (!i.budget_available) {
    const disp = overBudgetDisposition(i.kind);
    if (disp.disposition === 'retryable_reject') return { action: 'reject', reason: 'over_budget_action' };
    // informational overage → demote to briefing (never dropped by default)
    deliverTier = disp.tier;
    demoted = true;
  }

  if (i.persona_locked) return { action: 'hold', reason: 'persona_locked', tier: deliverTier };
  return { action: 'deliver', tier: deliverTier, demoted };
}
