import { CONSTANTS } from '@/config/constants.js'
import { clamp, daysSince } from './trust-score.js'

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
}

export function aggregateSubjectSentiment(attestations: AttestationForAggregation[]): SentimentAggregation {
  if (attestations.length === 0) {
    return {
      total: 0, positive: 0, neutral: 0, negative: 0,
      weightedScore: 0, confidence: 0,
      dimensionSummary: {},
      authenticityConsensus: null, authenticityConfidence: null,
      wouldRecommendRate: null, verifiedCount: 0,
      lastAttestationAt: null, velocity: 0,
    }
  }

  let positive = 0, neutral = 0, negative = 0
  let weightedPositive = 0, weightedTotal = 0
  let verifiedCount = 0
  const dimensionSummary: Record<string, { exceeded: number; met: number; below: number; failed: number }> = {}

  let lastDate: Date | null = null

  for (const a of attestations) {
    if (a.sentiment === 'positive') positive++
    else if (a.sentiment === 'neutral') neutral++
    else if (a.sentiment === 'negative') negative++

    if (a.isVerified) verifiedCount++

    // Weighted score
    const ageDays = Math.max(0, daysSince(a.recordCreatedAt))
    const recency = Math.exp(-ageDays / CONSTANTS.SENTIMENT_HALFLIFE_DAYS)
    const evidence = a.evidenceJson?.length ? CONSTANTS.EVIDENCE_MULTIPLIER : 1.0
    let authorWeight = a.authorTrustScore ?? 0.0
    if (!a.authorHasInboundVouch) authorWeight = 0.0

    const weight = recency * evidence * authorWeight
    if (a.sentiment === 'positive') weightedPositive += weight
    else if (a.sentiment === 'neutral') weightedPositive += weight * 0.5
    weightedTotal += weight

    // Dimensions
    if (Array.isArray(a.dimensionsJson)) {
      for (const dim of a.dimensionsJson as { dimension: string; value: string }[]) {
        if (!dimensionSummary[dim.dimension]) {
          dimensionSummary[dim.dimension] = { exceeded: 0, met: 0, below: 0, failed: 0 }
        }
        const bucket = dim.value as keyof typeof dimensionSummary[string]
        if (bucket in dimensionSummary[dim.dimension]) {
          dimensionSummary[dim.dimension][bucket]++
        }
      }
    }

    if (!lastDate || a.recordCreatedAt > lastDate) {
      lastDate = a.recordCreatedAt
    }
  }

  const total = attestations.length
  const weightedScore = weightedTotal > 0 ? weightedPositive / weightedTotal : 0.5

  // Confidence based on volume
  let confidence = 0
  if (total >= 100) confidence = 0.95
  else if (total >= 30) confidence = 0.8
  else if (total >= 10) confidence = 0.6
  else if (total >= 3) confidence = 0.4
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
    authenticityConsensus: null,
    authenticityConfidence: null,
    wouldRecommendRate,
    verifiedCount,
    lastAttestationAt: lastDate,
    velocity,
  }
}
