/**
 * Frozen Core-side delivery evaluation order (INTERACTIVE_SERVICES_ARCHITECTURE.md
 * §9.1). Pure. Tiers are the silence-classifier tiers: 1=Fiduciary (interrupt),
 * 2=Solicited (notify), 3=Engagement (briefing) — a LARGER number is QUIETER.
 *
 * The order is fixed so an untrusted Brain is bounded to *informational* routing
 * and can never touch an action banner:
 *   1. Base tier — an ACTION gets a Core Tier-2 base (Brain not consulted); an
 *      INFORMATIONAL message gets Brain's candidate (or the ceiling on timeout).
 *   2. Owner ceiling — clamp to the quieter-of (numeric max over 1..3). Never raises.
 *   3. Owner quiet settings (mute/DND/quiet-hours) — suppress the *banner* only;
 *      the inbox entry is retained. That step is a delivery-surface concern
 *      (notification bridge / mobile), NOT this Core tier computation.
 */

import type { PriorityCeiling } from './domain';
import type { MessageKind, TierSource } from './message';

export type PriorityTier = 1 | 2 | 3;

/** Numeric rank of an owner ceiling (larger = quieter). */
export function ceilingRank(ceiling: PriorityCeiling): PriorityTier {
  switch (ceiling) {
    case 'fiduciary':
      return 1;
    case 'solicited':
      return 2;
    case 'engagement':
      return 3;
  }
}

/** Clamp a base tier to a value in 1..3. */
function clampTier(n: number): PriorityTier {
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

export interface ComputeTierInput {
  kind: MessageKind;
  /** Brain's candidate for an INFORMATIONAL message; ignored for actions. */
  brainCandidate: number | null;
  priorityCeiling: PriorityCeiling;
  /** True when the classify window elapsed with no candidate (§9.1 fallback). */
  timedOut: boolean;
}

export interface ComputeTierResult {
  tier: PriorityTier;
  tier_source: TierSource;
}

/**
 * Compute a message's final delivery tier (steps 1–2 of §9.1). Returns null for
 * an informational message that is neither classified (no candidate) nor timed
 * out — it is not yet finalizable.
 */
export function computeFinalTier(input: ComputeTierInput): ComputeTierResult | null {
  let base: number;
  let source: TierSource;

  if (input.kind === 'action') {
    // Action: Core Tier-2 base. Brain is never consulted for action loudness.
    base = 2;
    source = 'action_base';
  } else if (input.brainCandidate !== null) {
    base = input.brainCandidate;
    source = 'brain_candidate';
  } else if (input.timedOut) {
    base = ceilingRank(input.priorityCeiling);
    source = 'classify_timeout_ceiling';
  } else {
    return null; // informational, not yet classified — cannot finalize
  }

  // Owner ceiling: quieter-of (numeric max). Never raises loudness.
  const tier = clampTier(Math.max(clampTier(base), ceilingRank(input.priorityCeiling)));
  return { tier, tier_source: source };
}
