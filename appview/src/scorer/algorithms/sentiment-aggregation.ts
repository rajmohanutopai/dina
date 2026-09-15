import { CONSTANTS } from '@/config/constants.js'
import { clamp, daysSince } from './peerlens-score.js'
import { halflifeForCategory } from './category_halflife.js'
import { resolveCanonicalDimension } from '@/shared/dimension-registry.js'

export interface AttestationForAggregation {
  sentiment: string
  recordCreatedAt: Date
  evidenceJson: unknown[] | null
  hasCosignature: boolean
  isVerified: boolean
  authorTrustScore: number | null
  authorHasInboundVouch: boolean
  dimensionsJson?: unknown[]
  domain?: string | null
  /**
   * Attestation's own `category` field — drives per-category
   * recency-decay tuning (TN-V2-RANK-006). Symmetric with
   * `TrustScoreInput.attestationsAbout.category` so the two scorer
   * paths use the same half-life lookup.
   */
  category?: string | null
  /**
   * D4 — the feed this review was imported from, or null/absent for
   * testimony. A non-null value changes three things and only three: the
   * weight is the fixed `IMPORTED_REVIEW_WEIGHT` rather than the author's
   * trust, the verified/bilateral multipliers do not apply (a feed neither
   * cosigns nor gets verified), and the review does not count toward
   * confidence. See `config/review-feeds.ts` for why a rating may move and a
   * trust ring may not.
   */
  sourceFeed?: string | null
}

export interface SentimentAggregation {
  total: number
  positive: number
  neutral: number
  negative: number
  weightedScore: number
  confidence: number
  dimensionSummary: Record<string, { exceeded: number; met: number; below: number; failed: number }>
  authenticityConsensus: string | null
  authenticityConfidence: number | null
  wouldRecommendRate: number | null
  verifiedCount: number
  lastAttestationAt: Date | null
  velocity: number
  /** D4 — testimony: someone the owner could reach wrote this. */
  peerCount: number
  /** D4 — imported from a registered per-market feed. */
  importedCount: number
  /**
   * Count of dimension entries DROPPED because they didn't resolve to a
   * canonical dimension in their category's vocabulary (Part 2, P1e). The
   * caller emits this as `peerlens.dimension.dropped_unknown` so vocabulary
   * drift stays visible (and recurring unknowns can be promoted into the
   * registry). The pure function returns the count rather than emitting the
   * metric itself.
   */
  droppedUnknownDimensions: number
}

export function aggregateSubjectSentiment(attestations: AttestationForAggregation[]): SentimentAggregation {
  if (attestations.length === 0) {
    return {
      total: 0, positive: 0, neutral: 0, negative: 0,
      weightedScore: 0, confidence: 0,
      dimensionSummary: {},
      droppedUnknownDimensions: 0,
      authenticityConsensus: null, authenticityConfidence: null,
      wouldRecommendRate: null, verifiedCount: 0,
      lastAttestationAt: null, velocity: 0,
      peerCount: 0, importedCount: 0,
    }
  }

  let positive = 0, neutral = 0, negative = 0
  let weightedPositive = 0, weightedTotal = 0
  let verifiedCount = 0
  let importedCount = 0
  // D4 — imports accumulate SEPARATELY so their combined mass can be capped
  // before it joins the rating. Capping per-row would not bound anything: a
  // feed that publishes ten thousand reviews of one supplier would still
  // swamp everyone who actually dealt with them.
  let importedWeightedPositive = 0, importedWeightedTotal = 0
  const dimensionSummary: Record<string, { exceeded: number; met: number; below: number; failed: number }> = {}
  let droppedUnknownDimensions = 0

  let lastDate: Date | null = null

  for (const a of attestations) {
    if (a.sentiment === 'positive') positive++
    else if (a.sentiment === 'neutral') neutral++
    else if (a.sentiment === 'negative') negative++

    // A verification confirms testimony; an import has none to confirm, so
    // it never counts here whatever its row says.
    if (a.isVerified && a.sourceFeed == null) verifiedCount++

    // Weighted score — TS1 fix: include verified + bilateral multipliers
    // to match the formula in peerlens-score.ts (was missing 2.1x for
    // verified bilateral attestations).
    const ageDays = Math.max(0, daysSince(a.recordCreatedAt))
    // TN-V2-RANK-006 — per-category recency-decay (symmetric with
    // computeSentiment in peerlens-score.ts). When `category` is null
    // the lookup falls back to the V1 baseline; explicit per-category
    // half-lives apply when present.
    const recency = Math.exp(-ageDays / halflifeForCategory(a.category))
    const evidence = a.evidenceJson?.length ? CONSTANTS.EVIDENCE_MULTIPLIER : 1.0
    // D4 — an IMPORT is not testimony, so none of the multipliers that
    // measure testimony apply to it. It cannot be cosigned (a feed has no
    // counterparty to cosign with) and cannot be verified (nobody can
    // confirm somebody else's star rating), so those stay at 1.0 even if a
    // row somehow carried the flags. Its weight is the fixed
    // IMPORTED_REVIEW_WEIGHT and never the publisher's trust score: a feed
    // that got itself vouched must not thereby speak as a peer.
    const imported = a.sourceFeed != null && a.sourceFeed !== ''
    if (imported) importedCount++
    const verified = !imported && a.isVerified ? CONSTANTS.VERIFIED_MULTIPLIER : 1.0
    const bilateral = !imported && a.hasCosignature ? CONSTANTS.BILATERAL_MULTIPLIER : 1.0
    let authorWeight: number
    if (imported) {
      authorWeight = CONSTANTS.IMPORTED_REVIEW_WEIGHT
    } else {
      authorWeight = a.authorTrustScore ?? 0.0
      if (!a.authorHasInboundVouch) authorWeight = 0.0
    }

    const weight = recency * evidence * verified * bilateral * authorWeight
    let contributionPositive = 0
    if (a.sentiment === 'positive') contributionPositive = weight
    else if (a.sentiment === 'neutral') contributionPositive = weight * 0.5
    if (imported) {
      importedWeightedPositive += contributionPositive
      importedWeightedTotal += weight
    } else {
      weightedPositive += contributionPositive
      weightedTotal += weight
    }

    // Dimensions — Part 2, Layer 3 (read-side safety net). Canonicalize
    // each dimension WITHIN this attestation's category BEFORE grouping,
    // so a record that slipped in with an alias (a non-Dina client, an
    // import, an old record) still merges into the canonical pile instead
    // of silently splitting the consensus. A dimension that resolves to
    // `null` (not in the category's vocabulary) is DROPPED — never
    // aggregated under its raw string (P1e) — and counted so drift is
    // visible.
    if (Array.isArray(a.dimensionsJson)) {
      for (const dim of a.dimensionsJson as { dimension: string; value: string }[]) {
        if (!dim?.dimension) continue
        const canonical = resolveCanonicalDimension(a.category ?? '', dim.dimension)
        if (canonical === null) {
          droppedUnknownDimensions++
          continue
        }
        if (!dimensionSummary[canonical]) {
          dimensionSummary[canonical] = { exceeded: 0, met: 0, below: 0, failed: 0 }
        }
        const bucket = dim.value as keyof typeof dimensionSummary[string]
        if (bucket in dimensionSummary[canonical]) {
          dimensionSummary[canonical][bucket]++
        }
      }
    }

    if (!lastDate || a.recordCreatedAt > lastDate) {
      lastDate = a.recordCreatedAt
    }
  }

  const total = attestations.length
  const peerCount = total - importedCount

  // D4 — fold the imports in under their ceiling. SCALED rather than
  // truncated: the imports keep their own balance of positive and negative,
  // and the answer does not depend on which order the rows came back in,
  // which dropping "everything past the twentieth" would.
  const importedScale =
    importedWeightedTotal > CONSTANTS.MAX_IMPORTED_WEIGHT
      ? CONSTANTS.MAX_IMPORTED_WEIGHT / importedWeightedTotal
      : 1
  weightedPositive += importedWeightedPositive * importedScale
  weightedTotal += importedWeightedTotal * importedScale

  const weightedScore = weightedTotal > 0 ? weightedPositive / weightedTotal : 0.5

  // Confidence based on volume — of TESTIMONY (D4). A hundred imported
  // reviews and nobody the owner can reach is not a confident answer, it is
  // a cold start with a rating on it, and a confidence number that could not
  // tell the two apart would be the single most misleading figure on the
  // card.
  let confidence = 0
  if (peerCount >= 100) confidence = 0.95
  else if (peerCount >= 30) confidence = 0.8
  else if (peerCount >= 10) confidence = 0.6
  else if (peerCount >= 3) confidence = 0.4
  else confidence = 0.2

  // Velocity: attestations per day over last 30 days
  const recentAtts = attestations.filter(a => daysSince(a.recordCreatedAt) <= 30)
  const velocity = recentAtts.length / 30

  const wouldRecommendRate = total > 0 ? positive / total : null

  return {
    total, positive, neutral, negative,
    weightedScore: clamp(weightedScore, 0, 1),
    confidence,
    dimensionSummary,
    droppedUnknownDimensions,
    authenticityConsensus: null,
    authenticityConfidence: null,
    wouldRecommendRate,
    verifiedCount,
    lastAttestationAt: lastDate,
    velocity,
    peerCount,
    importedCount,
  }
}
