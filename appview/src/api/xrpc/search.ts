import { z } from 'zod'
import { eq, and, desc, gte, lte, lt, or, sql, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { attestations, subjects } from '@/db/schema/index.js'
import type { SearchResponse } from '@/shared/types/api-types.js'

const CONFIDENCE_ORDER = ['speculative', 'moderate', 'high', 'certain'] as const

export const SearchParams = z.object({
  q: z.string().max(500).optional(),
  category: z.string().max(200).optional(),
  domain: z.string().max(253).optional(),
  subjectType: z.enum(['did', 'content', 'product', 'dataset', 'organization', 'claim']).optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  tags: z.string().max(1000).optional(),
  authorDid: z.string().max(2048).regex(/^did:[a-z]+:/).optional(),
  minConfidence: z.enum(['speculative', 'moderate', 'high', 'certain']).optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  sort: z.enum(['recent', 'relevant']).default('relevant'),
  limit: z.coerce.number().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
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

  // MED-15: Use parameterized array construction instead of raw string building
  if (tags) {
    const tagList = tags.split(',').map(t => t.trim()).filter(Boolean)
    if (tagList.some(t => t.length > 100)) {
      throw Object.assign(new Error('Tag exceeds maximum length'), { name: 'ZodError', message: 'Tag exceeds maximum length (100)' })
    }
    conditions.push(sql`${attestations.tags} @> ARRAY[${sql.join(tagList.map(t => sql`${t}`), sql`, `)}]::text[]`)
  }

  // MED-04: Validate dates — reject invalid formats as 400 instead of 500
  if (since) {
    const d = new Date(since)
    if (isNaN(d.getTime())) throw Object.assign(new Error('Invalid "since" date format'), { name: 'ZodError', message: 'Invalid "since" date format' })
    conditions.push(gte(attestations.recordCreatedAt, d))
  }
  if (until) {
    const d = new Date(until)
    if (isNaN(d.getTime())) throw Object.assign(new Error('Invalid "until" date format'), { name: 'ZodError', message: 'Invalid "until" date format' })
    conditions.push(lte(attestations.recordCreatedAt, d))
  }

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
      // Legacy cursor: timestamp-only — validate before use (MED-04 fix)
      const legacyDate = new Date(cursor)
      if (isNaN(legacyDate.getTime())) {
        throw Object.assign(new Error('Invalid cursor format'), { name: 'ZodError', message: 'Invalid cursor format' })
      }
      conditions.push(lte(attestations.recordCreatedAt, legacyDate))
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
