import { z } from 'zod'
import { eq, and, desc, gte, lte, lt, or, sql, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { attestations, subjects } from '@/db/schema/index.js'
import type { SearchResponse } from '@/shared/types/api-types.js'

const CONFIDENCE_ORDER = ['speculative', 'moderate', 'high', 'certain'] as const

export const SearchParams = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  domain: z.string().optional(),
  subjectType: z.enum(['did', 'content', 'product', 'dataset', 'organization', 'claim']).optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  tags: z.string().optional(),
  authorDid: z.string().optional(),
  minConfidence: z.enum(['speculative', 'moderate', 'high', 'certain']).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  sort: z.enum(['recent', 'relevant']).default('relevant'),
  limit: z.coerce.number().min(1).max(100).default(25),
  cursor: z.string().optional(),
})

export type SearchParamsType = z.infer<typeof SearchParams>

export async function search(
  db: DrizzleDB,
  params: SearchParamsType,
): Promise<SearchResponse> {
  const { q, category, domain, subjectType, sentiment, tags, authorDid, minConfidence, since, until, sort, limit, cursor } = params

  const conditions: any[] = [eq(attestations.isRevoked, false)]

  if (category) conditions.push(eq(attestations.category, category))
  if (domain) conditions.push(eq(attestations.domain, domain))
  if (sentiment) conditions.push(eq(attestations.sentiment, sentiment))
  if (authorDid) conditions.push(eq(attestations.authorDid, authorDid))

  // MEDIUM-03: Apply subjectType filter via subjects table subquery
  if (subjectType) {
    const matchingSubjects = db.select({ id: subjects.id }).from(subjects).where(eq(subjects.subjectType, subjectType))
    conditions.push(inArray(attestations.subjectId, matchingSubjects))
  }

  // MEDIUM-03: Apply minConfidence filter (confidence is ordered enum)
  if (minConfidence) {
    const minIdx = CONFIDENCE_ORDER.indexOf(minConfidence)
    const validLevels = CONFIDENCE_ORDER.slice(minIdx) as unknown as string[]
    conditions.push(inArray(attestations.confidence, validLevels))
  }

  if (tags) {
    const tagList = tags.split(',').map(t => t.trim())
    const tagArray = `{${tagList.map(t => `"${t}"`).join(',')}}`
    conditions.push(sql`${attestations.tags} @> ${tagArray}::text[]`)
  }

  if (since) conditions.push(gte(attestations.recordCreatedAt, new Date(since)))
  if (until) conditions.push(lte(attestations.recordCreatedAt, new Date(until)))

  // MEDIUM-04: Composite cursor (timestamp::uri) for stable pagination
  if (cursor) {
    const sepIdx = cursor.indexOf('::')
    if (sepIdx > 0) {
      const cursorTs = new Date(cursor.slice(0, sepIdx))
      const cursorUri = cursor.slice(sepIdx + 2)
      conditions.push(or(
        lt(attestations.recordCreatedAt, cursorTs),
        and(eq(attestations.recordCreatedAt, cursorTs), lt(attestations.uri, cursorUri)),
      ))
    } else {
      // Legacy cursor: timestamp-only
      conditions.push(lte(attestations.recordCreatedAt, new Date(cursor)))
    }
  }

  let orderClause: any[]
  if (q && sort === 'relevant') {
    const tsQuery = sql`plainto_tsquery('english', ${q})`
    conditions.push(sql`search_vector @@ ${tsQuery}`)
    orderClause = [sql`ts_rank(search_vector, ${tsQuery}) DESC`, desc(attestations.uri)]
  } else {
    orderClause = [desc(attestations.recordCreatedAt), desc(attestations.uri)]
  }

  const results = await db.select()
    .from(attestations)
    .where(and(...conditions))
    .orderBy(...orderClause)
    .limit(limit + 1)

  const hasMore = results.length > limit
  const page = hasMore ? results.slice(0, limit) : results
  const lastRow = page[page.length - 1]
  const nextCursor = hasMore && lastRow
    ? `${lastRow.recordCreatedAt.toISOString()}::${lastRow.uri}`
    : undefined

  return {
    results: page,
    cursor: nextCursor,
    totalEstimate: null,
  }
}
