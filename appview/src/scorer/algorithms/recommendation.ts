import { CONSTANTS } from '@/config/constants.js'
import { clamp } from './trust-score.js'
import type { GraphContext } from '@/shared/types/api-types.js'

export interface RecommendationInput {
  scores: {
    weightedScore: number | null
    confidence: number | null
    totalAttestations: number | null
    positive: number | null
    negative: number | null
    verifiedAttestationCount: number | null
  } | null
  didProfile: {
    overallTrustScore: number | null
    vouchCount: number | null
    activeFlagCount: number | null
    tombstoneCount?: number | null
  } | null
  flags: { flagType: string; severity: string }[]
  graphContext: GraphContext | null
  authenticity: { predominantAssessment: string; confidence: number | null } | null
  context?: string | null
  domain?: string | null
}

export type TrustLevel = 'high' | 'moderate' | 'low' | 'very-low' | 'unknown'
export type RecommendedAction = 'proceed' | 'caution' | 'verify' | 'avoid'

export interface RecommendationOutput {
  trustLevel: TrustLevel
  confidence: number
  action: RecommendedAction
  reasoning: string
}

export function computeRecommendation(input: RecommendationInput): RecommendationOutput {
  const { scores, didProfile, flags, graphContext, authenticity, context } = input

  // No data at all
  if (!scores && !didProfile) {
    return {
      trustLevel: 'unknown',
      confidence: 0,
      action: 'verify',
      reasoning: 'No trust data available for this subject.',
    }
  }

  const reasons: string[] = []
  let score = 0.5
  let confidence = 0

  // Factor 1: Subject scores
  if (scores) {
    score = scores.weightedScore ?? 0.5
    confidence = scores.confidence ?? 0
    if (scores.totalAttestations && scores.totalAttestations > 0) {
      reasons.push(`${scores.totalAttestations} attestations (${scores.positive} positive, ${scores.negative} negative)`)
    }
  }

  // Factor 2: DID profile
  if (didProfile) {
    if (didProfile.overallTrustScore !== null && didProfile.overallTrustScore !== undefined) {
      score = (score + didProfile.overallTrustScore) / 2
    }
    if (didProfile.vouchCount && didProfile.vouchCount > 0) {
      reasons.push(`${didProfile.vouchCount} vouches`)
    }
  }

  // Factor 3: Flags (penalties)
  if (flags.length > 0) {
    for (const f of flags) {
      if (f.severity === 'critical') { score *= 0.3; reasons.push(`Critical flag: ${f.flagType}`) }
      else if (f.severity === 'serious') { score *= 0.6; reasons.push(`Serious flag: ${f.flagType}`) }
      else if (f.severity === 'warning') { score *= 0.85; reasons.push(`Warning: ${f.flagType}`) }
    }
  }

  // Factor 4: Graph context (trust proximity)
  if (graphContext) {
    if (graphContext.shortestPath === 1) {
      score = Math.min(1, score * 1.15)
      reasons.push('Direct trust connection')
    } else if (graphContext.shortestPath === 2) {
      score = Math.min(1, score * 1.05)
      reasons.push('2-hop trust connection')
    }
    if (graphContext.trustedAttestors.length > 0) {
      reasons.push(`${graphContext.trustedAttestors.length} trusted attestors`)
    }
  }

  // Factor 5: Context adjustment
  if (context === 'before-transaction') {
    // Higher bar for transactions
    score *= 0.9
  }

  score = clamp(score, 0, 1)

  // Determine trust level
  let trustLevel: TrustLevel
  if (score >= 0.8) trustLevel = 'high'
  else if (score >= 0.5) trustLevel = 'moderate'
  else if (score >= 0.3) trustLevel = 'low'
  else trustLevel = 'very-low'

  // Determine action
  let action: RecommendedAction
  if (score >= 0.7 && confidence >= 0.4) action = 'proceed'
  else if (score >= 0.4) action = 'caution'
  else if (score >= 0.2) action = 'verify'
  else action = 'avoid'

  return {
    trustLevel,
    confidence,
    action,
    reasoning: reasons.length > 0 ? reasons.join('. ') + '.' : 'Insufficient data for detailed reasoning.',
  }
}
