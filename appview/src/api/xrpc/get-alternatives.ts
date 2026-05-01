import { z } from 'zod'
import { and, desc, eq, ne, sql, isNotNull } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { subjects, subjectScores } from '@/db/schema/index.js'

/**
 * `com.dina.trust.getAlternatives` (TN-V2-RANK-009 / Plan §6.X).
 *
 * Returns top-N trusted alternatives for a given subject, drawn from
 * the same category. Powers the "3 trusted alternatives" strip on
 * the subject detail screen — a discovery surface that gives the
 * reader a starting point when they decide the subject they're
 * looking at isn't right for them.
 *
 * **Same-category constraint.** The exclusive use case is "show me
 * other things like this one." Cross-category alternatives are not a
 * v1 feature — a chair shouldn't suggest a dataset.
 *
 * **Self-exclusion.** The subject itself is removed from the result
 * set. Subjects with no `category` are skipped entirely (we can't
 * find peers without knowing the bucket).
 *
 * **Trust ordering.** Sorted by `subject_scores.weighted_score DESC
 * NULLS LAST`, with subjectId as a deterministic tiebreaker. Subjects
 * without a score row sort last (the scorer hasn't computed them
 * yet); they still appear so a brand-new category can return
 * meaningful alternatives.
 *
 * **viewerCtx is reserved.** The mobile detail page passes the
 * viewer's DID for future viewer-aware ranking (e.g. "alternatives
 * your contacts also reviewed"). v1 doesn't use it — kept on the
 * schema so clients can serialise it without a breaking change later.
 */

const DEFAULT_COUNT = 3
const MAX_COUNT = 25

export const GetAlternativesParams = z.object({
  subjectId: z.string().min(1).max(256),
  count: z.coerce.number().int().min(1).max(MAX_COUNT).default(DEFAULT_COUNT),
  // Forward-compat for viewer-aware ranking. v1 ignores the value
  // but accepts it so mobile clients can plumb it through now.
  viewerDid: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^did:[a-z]+:/, 'must be a DID')
    .optional(),
})

export type GetAlternativesParamsType = z.infer<typeof GetAlternativesParams>

export interface AlternativeEntry {
  subjectId: string
  name: string
  subjectType: string
  category: string
  /** Trust score in `[0, 1]` or `null` when the scorer hasn't run yet. */
  trustScore: number | null
}

export interface GetAlternativesResponse {
  /**
   * Empty when the input subjectId doesn't resolve, has no category,
   * or has no other subjects in the same category. The caller can
   * render an empty state without distinguishing the three cases —
   * "no alternatives to surface" is the unified UX.
   */
  alternatives: AlternativeEntry[]
}

export async function getAlternatives(
  db: DrizzleDB,
  params: GetAlternativesParamsType,
): Promise<GetAlternativesResponse> {
  const { subjectId, count } = params

  // Phase 1 — resolve the subject's category. PK lookup, single row.
  const [subjectRow] = await db
    .select({ category: subjects.category })
    .from(subjects)
    .where(eq(subjects.id, subjectId))
    .limit(1)

  if (!subjectRow || !subjectRow.category) {
    // Unknown subject OR pre-enrichment subject (no category yet).
    // Either way we can't find peers. Return empty rather than 404 —
    // the mobile UI suppresses the alternatives strip when empty.
    return { alternatives: [] }
  }

  // Phase 2 — join subjects ⨝ subject_scores in the same category,
  // exclude self, order by trust score desc with NULLs last and
  // subjectId as a deterministic tiebreaker. Limit at fetch time so
  // we don't pull more rows than the caller asked for.
  //
  // The LEFT JOIN keeps subjects without a score row in the result
  // (their `weightedScore` is NULL). Filtering them out would
  // suppress alternatives in fresh categories where the scorer
  // hasn't ticked yet — better to show them at the bottom than to
  // show nothing.
  const rows = await db
    .select({
      id: subjects.id,
      name: subjects.name,
      subjectType: subjects.subjectType,
      category: subjects.category,
      weightedScore: subjectScores.weightedScore,
    })
    .from(subjects)
    .leftJoin(subjectScores, eq(subjects.id, subjectScores.subjectId))
    .where(
      and(
        eq(subjects.category, subjectRow.category),
        ne(subjects.id, subjectId),
        isNotNull(subjects.category),
      ),
    )
    // Drizzle's `desc()` on a nullable column places NULLs first by
    // default in Postgres (DESC NULLS FIRST). We want NULLs last so
    // scored subjects rank above unscored. Explicit SQL fragment to
    // avoid relying on driver defaults that can shift between
    // versions.
    .orderBy(
      sql`${subjectScores.weightedScore} DESC NULLS LAST`,
      desc(subjects.id),
    )
    .limit(count)

  return {
    alternatives: rows.map((r) => ({
      subjectId: r.id,
      name: r.name,
      subjectType: r.subjectType,
      category: r.category!,
      trustScore: r.weightedScore ?? null,
    })),
  }
}
