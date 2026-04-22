/**
 * Tier classifier (GAP.md row #26 closure — M2 blocker).
 *
 * Maps content → PII sensitivity tier. The tier feeds:
 *   - `CoreClient.scrubPii({sensitivity})` (5.10) — picks the right
 *     Presidio tier on Core's side.
 *   - Persona-tier enforcement on storage — sensitive content forces
 *     writes into a sensitive persona vault.
 *   - Notify routing — elevated/sensitive content changes the default
 *     priority envelope on outbound messages.
 *
 * **Tiers** (ordered coarse → strictest):
 *
 *   - `general`    — low-risk text. Default.
 *   - `elevated`   — non-critical personal data (weak location, mild
 *                    health keywords, generic finance vocabulary).
 *                    Brain may still share with standard personas but
 *                    flags for scrub.
 *   - `sensitive`  — high-risk categories (diagnoses, account numbers,
 *                    legal privilege, content about minors). Writes
 *                    MUST land in a sensitive-tier persona.
 *   - `local_only` — credentials, PEM keys, API tokens. Never leave
 *                    the home node. No cloud LLM. Scrub to
 *                    obliteration before any outbound call.
 *
 * **Derivation** — pure function of the signal set:
 *
 *   - Any `credential` signal ≥ 0.85 → `local_only`.
 *   - Any `minor` / `legal` signal ≥ 0.8 → `sensitive`.
 *   - Any `health` / `financial` signal ≥ 0.85 → `sensitive`.
 *   - Any signal ≥ 0.6 → `elevated`.
 *   - Otherwise → `general`.
 *
 * Rule set is public data, not hardcoded logic — tests can exercise
 * edge cases by constructing signal lists directly + calling
 * `tierFromSignals`. Full text path (`classifyTier`) wraps the
 * detector + the rule set.
 *
 * **Non-monotonic composition**: classifying "doctor's office has my
 * SSN" should pin at `sensitive` even though the health signal alone
 * would stay `elevated` — the financial signal promotes the tier.
 * The rules use highest-precedence signal wins.
 *
 * **Rationale field** — the outcome includes a short string naming
 * which rule fired. Ops dashboards + audit logs render it so a human
 * can see "why did this item get classified local_only".
 *
 * Source: GAP.md (task 5.46 follow-up) — M2 milestone gate.
 */

import {
  detectSensitiveSignals,
  summariseSignals,
  type DetectSensitiveSignalsOptions,
  type SensitiveSignal,
  type SensitiveSignalType,
} from './sensitive_signals';

export type Tier = 'general' | 'elevated' | 'sensitive' | 'local_only';

const TIER_ORDER: Record<Tier, number> = {
  general: 0,
  elevated: 1,
  sensitive: 2,
  local_only: 3,
};

export interface TierClassification {
  tier: Tier;
  /** Human-readable reason naming the rule that fired. */
  rationale: string;
  /** The signals the classifier saw. */
  signals: SensitiveSignal[];
}

export interface TierRule {
  /** Emitted when the rule fires. */
  tier: Tier;
  /** Human-readable name — shows up in the rationale. */
  name: string;
  /** Returns true when this rule should fire for the given signal set. */
  match(signals: ReadonlyArray<SensitiveSignal>): boolean;
}

/**
 * The default rule set. Exported so callers can inspect or extend it.
 * Rules are evaluated in order; first match wins — but the OUTPUT
 * tier is the HIGHEST tier of any matching rule. That way a
 * credential rule doesn't get pre-empted by a lower rule listed
 * earlier.
 */
export const DEFAULT_TIER_RULES: ReadonlyArray<TierRule> = [
  {
    tier: 'local_only',
    name: 'credential',
    match: (signals) =>
      signals.some((s) => s.type === 'credential' && s.confidence >= 0.85),
  },
  {
    tier: 'sensitive',
    name: 'high-confidence-protected-category',
    match: (signals) =>
      signals.some(
        (s) =>
          (s.type === 'health' || s.type === 'financial') && s.confidence >= 0.85,
      ),
  },
  {
    tier: 'sensitive',
    name: 'minor-or-legal',
    match: (signals) =>
      signals.some(
        (s) => (s.type === 'minor' || s.type === 'legal') && s.confidence >= 0.8,
      ),
  },
  {
    tier: 'elevated',
    name: 'moderate-signal',
    match: (signals) => signals.some((s) => s.confidence >= 0.6),
  },
];

export interface ClassifyTierOptions extends DetectSensitiveSignalsOptions {
  /** Alternative rule set. Overrides the defaults entirely. */
  rules?: ReadonlyArray<TierRule>;
}

/**
 * Pure signal→tier classifier. The dominant path into this module
 * when the caller already has signals (e.g. from a prior pass).
 */
export function tierFromSignals(
  signals: ReadonlyArray<SensitiveSignal>,
  rules: ReadonlyArray<TierRule> = DEFAULT_TIER_RULES,
): TierClassification {
  let best: { tier: Tier; rationale: string } = {
    tier: 'general',
    rationale: 'no-signals-above-threshold',
  };
  for (const rule of rules) {
    if (!rule.match(signals)) continue;
    if (TIER_ORDER[rule.tier] > TIER_ORDER[best.tier]) {
      best = { tier: rule.tier, rationale: rule.name };
    }
  }
  return { tier: best.tier, rationale: best.rationale, signals: [...signals] };
}

/**
 * Full text → tier pipeline: detect signals then classify.
 * Accepts the same detector options as `detectSensitiveSignals` so
 * callers can disable detectors or raise `minConfidence`.
 */
export function classifyTier(
  text: string,
  opts: ClassifyTierOptions = {},
): TierClassification {
  const { rules, ...detectOpts } = opts;
  const signals = detectSensitiveSignals(text, detectOpts);
  return tierFromSignals(signals, rules ?? DEFAULT_TIER_RULES);
}

/**
 * Given two tiers, return the stricter one. Useful when composing
 * tiers from multiple sources (e.g. metadata-derived + text-derived).
 */
export function strictestTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

/**
 * True when `tier` is at least as strict as `atLeast`. Lets callers
 * gate behaviour with a single predicate rather than switch statements.
 */
export function tierAtLeast(tier: Tier, atLeast: Tier): boolean {
  return TIER_ORDER[tier] >= TIER_ORDER[atLeast];
}

/**
 * Convenience: the signal-type → dominant-tier map the notify router
 * + scrubber consult when they want a one-shot lookup without running
 * the full pipeline. Pure function of DEFAULT_TIER_RULES.
 */
export function dominantTierForSignalType(type: SensitiveSignalType): Tier {
  // Build a synthetic signal that would match each rule — find the
  // strictest that this type participates in.
  const probes: Array<{ tier: Tier; confidence: number }> = [
    { tier: 'general', confidence: 0 },
  ];
  for (const rule of DEFAULT_TIER_RULES) {
    const synth: SensitiveSignal = { type, confidence: 1 };
    if (rule.match([synth])) probes.push({ tier: rule.tier, confidence: 1 });
  }
  probes.sort((a, b) => TIER_ORDER[b.tier] - TIER_ORDER[a.tier]);
  return probes[0]!.tier;
}

/**
 * Re-export the signal summary for callers that want the audit view
 * alongside the tier decision.
 */
export { summariseSignals };
