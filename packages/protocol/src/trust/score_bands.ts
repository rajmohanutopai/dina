/**
 * Trust-score bands — canonical thresholds for the public `[0, 1]`
 * trust score (TN-MOB-002 + TN-LITE-006 contract).
 *
 * The thresholds slice the score range into four labelled bands plus
 * an "unrated" sentinel for the `null` (no profile yet) case. UI
 * layers across the workspace — mobile compose flows, the home-node
 * trust decision engine, the admin Trust dashboard — render the
 * same band for the same score so users get consistent signals.
 *
 * Numbers match `apps/home-node-lite/core-server/src/appview/
 * trust_decision.ts` (LEVEL_HIGH/MODERATE/LOW). Don't edit them in
 * one place without updating the other; the consolidation here
 * exists *because* the duplication was a smell.
 *
 * Zero runtime deps — pure constants + functions.
 */

export const BAND_HIGH = 0.8;
export const BAND_MODERATE = 0.5;
export const BAND_LOW = 0.3;

/**
 * Five-way trust band, including the `unrated` sentinel for scores
 * that AppView returns as `null` (DID is known but unscored).
 */
export type TrustBand = 'high' | 'moderate' | 'low' | 'very-low' | 'unrated';

/**
 * Map a `[0, 1]` score (or `null`) onto its trust band.
 *
 * Boundary semantics: `>=` at each step. `0.8 → high`, `0.5 → moderate`,
 * `0.3 → low`, anything below → very-low. `null → unrated`.
 */
export function trustBandFor(score: number | null | undefined): TrustBand {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'unrated';
  if (score >= BAND_HIGH) return 'high';
  if (score >= BAND_MODERATE) return 'moderate';
  if (score >= BAND_LOW) return 'low';
  return 'very-low';
}

/**
 * Convert a `[0, 1]` real score to a `[0, 100]` integer for display.
 *
 * Returns `null` for unrated profiles so callers can render an
 * em-dash or "—" rather than a fake 0. NaN / Infinity collapses to
 * `null` for the same reason.
 *
 * Rounding is half-away-from-zero (Math.round) so 0.785 → 79.
 * Clamps to `[0, 100]` defensively — wire format already guarantees
 * `[0, 1]` but a spec violation shouldn't render as `103`.
 */
export function trustScoreDisplay(score: number | null | undefined): number | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  const clamped = Math.max(0, Math.min(1, score));
  return Math.round(clamped * 100);
}

/**
 * Format the score as a string for direct UI insertion.
 * `null` → an em-dash so `<Text>{trustScoreLabel(...)}</Text>` always
 * has visible content even when the profile is unrated.
 */
export function trustScoreLabel(score: number | null | undefined): string {
  const n = trustScoreDisplay(score);
  return n === null ? '—' : String(n);
}
