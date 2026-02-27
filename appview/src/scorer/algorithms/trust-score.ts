import { CONSTANTS } from '@/config/constants.js'

export interface TrustScoreInput {
  attestationsAbout: {
    sentiment: string
    recordCreatedAt: Date
    evidenceJson: unknown[] | null
    hasCosignature: boolean
    isVerified: boolean
    authorTrustScore: number | null
    authorHasInboundVouch: boolean
  }[]
  vouchCount: number
  highConfidenceVouches: number
  endorsementCount: number
  activeFlagCount: number
  flagSeverities: string[]
  totalAttestationsBy: number
  revocationCount: number
  tombstoneCount: number
  helpfulReactions: number
  unhelpfulReactions: number
  withEvidenceCount: number
  inboundEdgeCount: number
  delegationInboundCount: number
}

export interface TrustScoreOutput {
  overallScore: number
  components: {
    sentiment: number
    vouch: number
    reviewer: number
    network: number
  }
  confidence: number
}

export function computeTrustScore(input: TrustScoreInput): TrustScoreOutput {
  const sentiment = computeSentiment(input)
  const vouch = computeVouch(input)
  const reviewer = computeReviewer(input)
  const network = computeNetwork(input)

  let raw = (
    sentiment * CONSTANTS.SENTIMENT_WEIGHT +
    vouch * CONSTANTS.VOUCH_WEIGHT +
    reviewer * CONSTANTS.REVIEWER_WEIGHT +
    network * CONSTANTS.NETWORK_WEIGHT
  )

  for (const severity of input.flagSeverities) {
    if (severity === 'critical')    raw *= 0.3
    else if (severity === 'serious') raw *= 0.6
    else if (severity === 'warning') raw *= 0.85
  }

  if (input.tombstoneCount >= CONSTANTS.COORDINATION_TOMBSTONE_THRESHOLD) {
    raw *= 0.4
  }

  const overall = CONSTANTS.DAMPING_FACTOR * raw + (1 - CONSTANTS.DAMPING_FACTOR) * CONSTANTS.BASE_SCORE

  const confidence = computeConfidence(input)

  const safeOverall = Number.isFinite(overall) ? overall : CONSTANTS.BASE_SCORE

  return {
    overallScore: clamp(safeOverall, 0, 1),
    components: { sentiment, vouch, reviewer, network },
    confidence,
  }
}

export function computeSentiment(input: TrustScoreInput): number {
  const atts = input.attestationsAbout
  if (atts.length === 0) return 0.5

  let weightedPositive = 0
  let weightedTotal = 0

  for (const a of atts) {
    const ageDays = Math.max(0, daysSince(a.recordCreatedAt))
    const recency = Math.exp(-ageDays / CONSTANTS.SENTIMENT_HALFLIFE_DAYS)
    const evidence = a.evidenceJson?.length ? CONSTANTS.EVIDENCE_MULTIPLIER : 1.0
    const verified = a.isVerified ? CONSTANTS.VERIFIED_MULTIPLIER : 1.0
    const bilateral = a.hasCosignature ? CONSTANTS.BILATERAL_MULTIPLIER : 1.0

    let authorWeight = a.authorTrustScore ?? 0.0
    if (!a.authorHasInboundVouch) {
      authorWeight = 0.0
    }

    const weight = recency * evidence * verified * bilateral * authorWeight

    if (a.sentiment === 'positive')     weightedPositive += weight
    else if (a.sentiment === 'neutral') weightedPositive += weight * 0.5

    weightedTotal += weight
  }

  return weightedTotal > 0 ? weightedPositive / weightedTotal : 0.5
}

export function computeVouch(input: TrustScoreInput): number {
  if (input.vouchCount === 0) return 0.1

  const vouchSignal = Math.min(1.0, Math.log2(input.vouchCount + 1) / Math.log2(11))
  const highConfidenceBonus = Math.min(0.2, input.highConfidenceVouches * 0.05)

  return clamp(vouchSignal + highConfidenceBonus, 0, 1)
}

export function computeReviewer(input: TrustScoreInput): number {
  if (input.totalAttestationsBy === 0) return 0.0

  const total = input.totalAttestationsBy
  const deletionRate = input.tombstoneCount / total
  const evidenceRate = input.withEvidenceCount / total
  const helpfulTotal = input.helpfulReactions + input.unhelpfulReactions
  const helpfulRatio = helpfulTotal > 0 ? input.helpfulReactions / helpfulTotal : 0.5

  let score = 0.3
  score += helpfulRatio * 0.35
  score += evidenceRate * 0.25
  score -= deletionRate * 2.0

  return clamp(score, 0, 1)
}

export function computeNetwork(input: TrustScoreInput): number {
  const edgeSignal = Math.min(1.0, Math.log2(input.inboundEdgeCount + 1) / Math.log2(51))
  const delegationBonus = Math.min(0.2, input.delegationInboundCount * 0.04)

  return clamp(edgeSignal + delegationBonus, 0, 1)
}

export function computeConfidence(input: TrustScoreInput): number {
  const totalSignals =
    input.attestationsAbout.length +
    input.vouchCount +
    input.endorsementCount +
    input.totalAttestationsBy

  if (totalSignals === 0)  return 0.0
  if (totalSignals < 3)    return 0.2
  if (totalSignals < 10)   return 0.4
  if (totalSignals < 30)   return 0.6
  if (totalSignals < 100)  return 0.8
  return 0.95
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export function daysSince(date: Date): number {
  return (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24)
}
