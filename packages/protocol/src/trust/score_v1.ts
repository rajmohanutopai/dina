/**
 * Trust Network V1 score formula — reference implementation
 * (TN-PROTO-004 / TN-PROTO-005).
 *
 * This is the canonical, zero-dep, deterministic port of the AppView
 * scorer in `appview/src/scorer/algorithms/trust-score.ts`. Every Dina
 * implementation that publishes a `subject_scores` row must produce
 * the same number for the same input — that's the invariant pinned by
 * `conformance/vectors/trust_score_v1.json`.
 *
 * Differences vs AppView (intentional, drift-free):
 *   - `nowMs: number` is an explicit parameter, not `Date.now()`. AppView's
 *     scorer reads wall-clock at compute time; for a frozen vector to
 *     stay frozen we need the recency calculation to be deterministic.
 *     The AppView scorer's behaviour is recovered exactly by passing
 *     `Date.now()` at the call site — same answer, same wire shape.
 *   - Sentiment recency reads `recordCreatedAtMs` (epoch ms number) so
 *     vectors can be expressed as plain JSON. AppView passes Date
 *     instances; the math is identical (`(now - then) / 86_400_000`).
 *
 * Naming nit (preserved for AppView parity):
 *   `SENTIMENT_HALFLIFE_DAYS = 180` is the *time-constant*, not a strict
 *   half-life. The decay is `e^(-ageDays / 180)`, so after 180 days the
 *   weight is `e^-1 ≈ 0.368`, not 0.5. Renaming would diverge from the
 *   AppView contract; the formula is the canonical one — only the
 *   variable name reads loose.
 *
 * Constants are inlined here as `SCORE_V1_CONSTANTS`. They mirror
 * `appview/src/config/constants.ts`. Both copies must move in lockstep
 * for the same score to come out either side; the conformance vector
 * + a parallel test inside AppView are how that lockstep is enforced.
 *
 * Zero runtime deps — pure arithmetic + Math.{exp,log2,min,max}.
 */

/** Frozen scoring constants for `trust_score_v1`. */
export const SCORE_V1_CONSTANTS = Object.freeze({
  // Component weights — must sum to 1.0.
  SENTIMENT_WEIGHT: 0.4,
  VOUCH_WEIGHT: 0.25,
  REVIEWER_WEIGHT: 0.2,
  NETWORK_WEIGHT: 0.15,

  // Sentiment.
  SENTIMENT_HALFLIFE_DAYS: 180,
  EVIDENCE_MULTIPLIER: 1.3,
  VERIFIED_MULTIPLIER: 1.5,
  BILATERAL_MULTIPLIER: 1.4,

  // Vouch.
  VOUCH_LOG_BASE_PLUS_ONE: 11, // log2(11) is the saturation point for vouchCount
  HIGH_CONF_BONUS_PER: 0.05,
  HIGH_CONF_BONUS_CAP: 0.2,
  VOUCH_FLOOR_NO_VOUCH: 0.1,

  // Reviewer.
  REVIEWER_BASE: 0.3,
  REVIEWER_HELPFUL_WEIGHT: 0.35,
  REVIEWER_EVIDENCE_WEIGHT: 0.25,
  REVIEWER_DELETION_PENALTY: 2.0,
  REVIEWER_HELPFUL_DEFAULT: 0.5,

  // Network.
  NETWORK_LOG_BASE_PLUS_ONE: 51, // log2(51) is the saturation point for inbound edges
  DELEGATION_BONUS_PER: 0.04,
  DELEGATION_BONUS_CAP: 0.2,

  // Penalties.
  FLAG_CRITICAL_FACTOR: 0.3,
  FLAG_SERIOUS_FACTOR: 0.6,
  FLAG_WARNING_FACTOR: 0.85,
  COORDINATION_TOMBSTONE_THRESHOLD: 3,
  COORDINATION_TOMBSTONE_FACTOR: 0.4,

  // Damping.
  DAMPING_FACTOR: 0.85,
  BASE_SCORE: 0.1,

  // Empty-input defaults.
  SENTIMENT_NO_ATT: 0.5,
  REVIEWER_NO_ATT: 0.0,

  // Confidence tiers (signal counts → confidence).
  CONF_T1: 3,
  CONF_T2: 10,
  CONF_T3: 30,
  CONF_T4: 100,
  CONF_NONE: 0.0,
  CONF_LOW: 0.2,
  CONF_FAIR: 0.4,
  CONF_OK: 0.6,
  CONF_HIGH: 0.8,
  CONF_VERY_HIGH: 0.95,
} as const);

export type ScoreV1Sentiment = 'positive' | 'neutral' | 'negative';

export type ScoreV1FlagSeverity = 'critical' | 'serious' | 'warning' | 'info';

/** One attestation about the subject — recency + author-trust weighted. */
export interface ScoreV1AttestationAbout {
  sentiment: ScoreV1Sentiment;
  /** Wire-friendly epoch ms — caller does Date conversion if needed. */
  recordCreatedAtMs: number;
  /** Number of evidence items; 0 → no evidence multiplier, >0 → multiplier applied. */
  evidenceCount: number;
  hasCosignature: boolean;
  isVerified: boolean;
  /** Author's own trust score in `[0, 1]`, or null if unscored. */
  authorTrustScore: number | null;
  /** Whether the author has at least one inbound vouch. */
  authorHasInboundVouch: boolean;
}

export interface ScoreV1Input {
  attestationsAbout: ScoreV1AttestationAbout[];
  vouchCount: number;
  highConfidenceVouches: number;
  endorsementCount: number;
  activeFlagCount: number;
  flagSeverities: ScoreV1FlagSeverity[];
  totalAttestationsBy: number;
  revocationCount: number;
  tombstoneCount: number;
  helpfulReactions: number;
  unhelpfulReactions: number;
  withEvidenceCount: number;
  inboundEdgeCount: number;
  delegationInboundCount: number;
}

export interface ScoreV1Components {
  sentiment: number;
  vouch: number;
  reviewer: number;
  network: number;
}

export interface ScoreV1Output {
  overallScore: number;
  components: ScoreV1Components;
  confidence: number;
}

/**
 * Compute the V1 trust score for a subject, given a snapshot of the
 * inputs and an explicit `nowMs` timestamp.
 *
 * `nowMs` controls only the recency-decay term in the sentiment
 * component. Callers that want the AppView scorer's wall-clock
 * behaviour pass `Date.now()`. The conformance suite passes a frozen
 * value so vectors stay byte-stable.
 */
export function computeScoreV1(input: ScoreV1Input, nowMs: number): ScoreV1Output {
  const C = SCORE_V1_CONSTANTS;

  const sentiment = computeSentimentV1(input, nowMs);
  const vouch = computeVouchV1(input);
  const reviewer = computeReviewerV1(input);
  const network = computeNetworkV1(input);

  let raw =
    sentiment * C.SENTIMENT_WEIGHT +
    vouch * C.VOUCH_WEIGHT +
    reviewer * C.REVIEWER_WEIGHT +
    network * C.NETWORK_WEIGHT;

  for (const sev of input.flagSeverities) {
    if (sev === 'critical') raw *= C.FLAG_CRITICAL_FACTOR;
    else if (sev === 'serious') raw *= C.FLAG_SERIOUS_FACTOR;
    else if (sev === 'warning') raw *= C.FLAG_WARNING_FACTOR;
    // 'info' (and any unknown future severity) leaves `raw` alone — same as AppView.
  }

  if (input.tombstoneCount >= C.COORDINATION_TOMBSTONE_THRESHOLD) {
    raw *= C.COORDINATION_TOMBSTONE_FACTOR;
  }

  const overall = C.DAMPING_FACTOR * raw + (1 - C.DAMPING_FACTOR) * C.BASE_SCORE;
  const safeOverall = Number.isFinite(overall) ? overall : C.BASE_SCORE;

  return {
    overallScore: clampUnit(safeOverall),
    components: { sentiment, vouch, reviewer, network },
    confidence: computeConfidenceV1(input),
  };
}

export function computeSentimentV1(input: ScoreV1Input, nowMs: number): number {
  const C = SCORE_V1_CONSTANTS;
  const atts = input.attestationsAbout;
  if (atts.length === 0) return C.SENTIMENT_NO_ATT;

  let weightedPositive = 0;
  let weightedTotal = 0;

  for (const a of atts) {
    const ageDays = Math.max(0, (nowMs - a.recordCreatedAtMs) / 86_400_000);
    const recency = Math.exp(-ageDays / C.SENTIMENT_HALFLIFE_DAYS);
    const evidence = a.evidenceCount > 0 ? C.EVIDENCE_MULTIPLIER : 1.0;
    const verified = a.isVerified ? C.VERIFIED_MULTIPLIER : 1.0;
    const bilateral = a.hasCosignature ? C.BILATERAL_MULTIPLIER : 1.0;

    // AppView contract: an unvouched author contributes zero weight,
    // even if they have a non-null trust score. Catches cold-start
    // self-promotion attempts.
    const authorWeight = a.authorHasInboundVouch ? a.authorTrustScore ?? 0.0 : 0.0;

    const weight = recency * evidence * verified * bilateral * authorWeight;

    if (a.sentiment === 'positive') weightedPositive += weight;
    else if (a.sentiment === 'neutral') weightedPositive += weight * 0.5;
    // negative: contributes to denominator only.

    weightedTotal += weight;
  }

  return weightedTotal > 0 ? weightedPositive / weightedTotal : C.SENTIMENT_NO_ATT;
}

export function computeVouchV1(input: ScoreV1Input): number {
  const C = SCORE_V1_CONSTANTS;
  if (input.vouchCount === 0) return C.VOUCH_FLOOR_NO_VOUCH;

  const vouchSignal = Math.min(
    1.0,
    Math.log2(input.vouchCount + 1) / Math.log2(C.VOUCH_LOG_BASE_PLUS_ONE),
  );
  const highConfidenceBonus = Math.min(
    C.HIGH_CONF_BONUS_CAP,
    input.highConfidenceVouches * C.HIGH_CONF_BONUS_PER,
  );

  return clampUnit(vouchSignal + highConfidenceBonus);
}

export function computeReviewerV1(input: ScoreV1Input): number {
  const C = SCORE_V1_CONSTANTS;
  if (input.totalAttestationsBy === 0) return C.REVIEWER_NO_ATT;

  const total = input.totalAttestationsBy;
  const deletionRate = input.tombstoneCount / total;
  const evidenceRate = input.withEvidenceCount / total;
  const helpfulTotal = input.helpfulReactions + input.unhelpfulReactions;
  const helpfulRatio =
    helpfulTotal > 0
      ? input.helpfulReactions / helpfulTotal
      : C.REVIEWER_HELPFUL_DEFAULT;

  let score = C.REVIEWER_BASE;
  score += helpfulRatio * C.REVIEWER_HELPFUL_WEIGHT;
  score += evidenceRate * C.REVIEWER_EVIDENCE_WEIGHT;
  score -= deletionRate * C.REVIEWER_DELETION_PENALTY;

  return clampUnit(score);
}

export function computeNetworkV1(input: ScoreV1Input): number {
  const C = SCORE_V1_CONSTANTS;
  const edgeSignal = Math.min(
    1.0,
    Math.log2(input.inboundEdgeCount + 1) / Math.log2(C.NETWORK_LOG_BASE_PLUS_ONE),
  );
  const delegationBonus = Math.min(
    C.DELEGATION_BONUS_CAP,
    input.delegationInboundCount * C.DELEGATION_BONUS_PER,
  );
  return clampUnit(edgeSignal + delegationBonus);
}

export function computeConfidenceV1(input: ScoreV1Input): number {
  const C = SCORE_V1_CONSTANTS;
  const total =
    input.attestationsAbout.length +
    input.vouchCount +
    input.endorsementCount +
    input.totalAttestationsBy;

  if (total === 0) return C.CONF_NONE;
  if (total < C.CONF_T1) return C.CONF_LOW;
  if (total < C.CONF_T2) return C.CONF_FAIR;
  if (total < C.CONF_T3) return C.CONF_OK;
  if (total < C.CONF_T4) return C.CONF_HIGH;
  return C.CONF_VERY_HIGH;
}

function clampUnit(v: number): number {
  return Math.max(0, Math.min(1, v));
}
