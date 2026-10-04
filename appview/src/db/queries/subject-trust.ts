/**
 * What PeerLens knows about a subject, read the way `resolve` reads it, and
 * the recommendation `resolve` makes from it. Shared with the A2A directory
 * (design §8.3: its score and band "reuse com.dinakernel.peerlens.resolve
 * semantics"), so a DID's band in the directory is the band `resolve` gives.
 */

import { and, eq } from 'drizzle-orm'

import type { DrizzleDB } from '@/db/connection.js'
import { resolveSubject } from '@/db/queries/subjects.js'
import { didProfiles, flags, subjects, subjectScores } from '@/db/schema/index.js'
import { computeRecommendation, type RecommendationOutput } from '@/scorer/algorithms/recommendation.js'
import type { GraphContext } from '@/shared/types/api-types.js'
import type { SubjectRef } from '@/shared/types/lexicon-types.js'

export interface SubjectTrustFacts {
  /** The canonical subject id, or null when the subject is not indexed. */
  subjectId: string | null
  /** A moderator removed the subject: it must never green-light anything. */
  tombstoned: boolean
  scores: typeof subjectScores.$inferSelect | null
  /** The DID's profile, for a DID subject. */
  didProfile: typeof didProfiles.$inferSelect | null
  activeFlags: { flagType: string; severity: string }[]
}

export async function loadSubjectTrustFacts(db: DrizzleDB, ref: SubjectRef): Promise<SubjectTrustFacts> {
  const subjectId = await resolveSubject(db, ref)
  let tombstoned = false
  if (subjectId) {
    const [row] = await db
      .select({ tombstonedAt: subjects.tombstonedAt })
      .from(subjects)
      .where(eq(subjects.id, subjectId))
      .limit(1)
    tombstoned = row?.tombstonedAt != null
  }
  const scores = subjectId
    ? await db
        .select()
        .from(subjectScores)
        .where(eq(subjectScores.subjectId, subjectId))
        .limit(1)
        .then((r) => r[0] ?? null)
    : null
  const didProfile =
    ref.type === 'did' && ref.did
      ? await db
          .select()
          .from(didProfiles)
          .where(eq(didProfiles.did, ref.did))
          .limit(1)
          .then((r) => r[0] ?? null)
      : null
  const activeFlags = subjectId
    ? (
        await db
          .select({ flagType: flags.flagType, severity: flags.severity })
          .from(flags)
          .where(and(eq(flags.subjectId, subjectId), eq(flags.isActive, true)))
          .limit(10)
      ).map((f) => ({ flagType: f.flagType, severity: f.severity }))
    : []
  return { subjectId, tombstoned, scores, didProfile, activeFlags }
}

/** The authenticity consensus `resolve` reports and weighs, when the scorer has one. */
export function authenticityOf(facts: SubjectTrustFacts): { predominantAssessment: string; confidence: number | null } | null {
  return facts.scores?.authenticityConsensus
    ? { predominantAssessment: facts.scores.authenticityConsensus, confidence: facts.scores.authenticityConfidence }
    : null
}

/** A recommendation, with `resolve`'s `none` trust level for a moderator-removed subject. */
export type SubjectRecommendation = Omit<RecommendationOutput, 'trustLevel'> & {
  trustLevel: RecommendationOutput['trustLevel'] | 'none'
}

/**
 * `resolve`'s recommendation from the facts. A moderator-removed subject is
 * always `avoid` at trust level `none`, whatever its scores.
 */
export function recommendFromFacts(
  facts: SubjectTrustFacts,
  extras: { graphContext?: GraphContext | null; context?: string; domain?: string } = {},
): SubjectRecommendation {
  if (facts.tombstoned) {
    return { trustLevel: 'none', confidence: 0, action: 'avoid', reasoning: 'Subject was removed by a moderator' }
  }
  return computeRecommendation({
    scores: facts.scores,
    didProfile: facts.didProfile,
    flags: facts.activeFlags,
    graphContext: extras.graphContext ?? null,
    authenticity: authenticityOf(facts),
    context: extras.context,
    domain: extras.domain,
  })
}
