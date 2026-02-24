import { CONSTANTS } from '@/config/constants.js'
import { clamp } from './trust-score.js'

export interface ReviewerQualityInput {
  totalAttestationsBy: number
  withEvidenceCount: number
  helpfulReactions: number
  unhelpfulReactions: number
  revocationCount: number
  tombstoneCount: number
  corroboratedCount: number
  agentGeneratedCount: number
}

export interface ReviewerQualityOutput {
  corroborationRate: number
  evidenceRate: number
  helpfulRatio: number
  deletionRate: number
  revocationRate: number
  overallQuality: number
}

export function computeReviewerQuality(input: ReviewerQualityInput): ReviewerQualityOutput {
  const total = input.totalAttestationsBy
  if (total === 0) {
    return {
      corroborationRate: 0,
      evidenceRate: 0,
      helpfulRatio: 0,
      deletionRate: 0,
      revocationRate: 0,
      overallQuality: 0,
    }
  }

  const corroborationRate = input.corroboratedCount / total
  const evidenceRate = input.withEvidenceCount / total
  const helpfulTotal = input.helpfulReactions + input.unhelpfulReactions
  const helpfulRatio = helpfulTotal > 0 ? input.helpfulReactions / helpfulTotal : 0.5
  const deletionRate = input.tombstoneCount / total
  const revocationRate = input.revocationCount / total

  let quality = 0.3
  quality += corroborationRate * 0.25
  quality += evidenceRate * 0.25
  quality += helpfulRatio * 0.3
  quality -= deletionRate * 2.0
  quality -= revocationRate * 1.5

  return {
    corroborationRate,
    evidenceRate,
    helpfulRatio,
    deletionRate,
    revocationRate,
    overallQuality: clamp(quality, 0, 1),
  }
}
