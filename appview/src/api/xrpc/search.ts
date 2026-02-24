import { z } from 'zod'
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { attestations } from '@/db/schema/index.js'
import type { SearchResponse } from '@/shared/types/api-types.js'

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
  sort: z.enum(['recent', 'relevant', 'most-attested']).default('relevant'),
  limit: z.coerce.number().min(1).max(100).default(25),
  cursor: z.string().optional(),
})

export type SearchParamsType = z.infer<typeof SearchParams>

export async function search(
  db: DrizzleDB,
  params: SearchParamsType,
): Promise<SearchResponse> {
  const { q, category, domain, sentiment, tags, authorDid, since, until, sort, limit, cursor } = params

  const conditions: any[] = [eq(attestations.isRevoked, false)]

  if (category) conditions.push(eq(attestations.category, category))
  if (domain) conditions.push(eq(attestations.domain, domain))
  if (sentiment) conditions.push(eq(attestations.sentiment, sentiment))
  if (authorDid) conditions.push(eq(attestations.authorDid, authorDid))

  if (tags) {
    const tagList = tags.split(',').map(t => t.trim())
    const tagArray = `{${tagList.map(t => `"${t}"`).join(',')}}`
    conditions.push(sql`${attestations.tags} @> ${tagArray}::text[]`)
  }

  if (since) conditions.push(gte(attestations.recordCreatedAt, new Date(since)))
  if (until) conditions.push(lte(attestations.recordCreatedAt, new Date(until)))
  if (cursor) conditions.push(lte(attestations.recordCreatedAt, new Date(cursor)))

  let orderClause: any
  if (q && sort === 'relevant') {
    const tsQuery = sql`plainto_tsquery('english', ${q})`
    conditions.push(sql`search_vector @@ ${tsQuery}`)
    orderClause = sql`ts_rank(search_vector, ${tsQuery}) DESC`
  } else {
    orderClause = desc(attestations.recordCreatedAt)
  }

  const results = await db.select()
    .from(attestations)
    .where(and(...conditions))
    .orderBy(orderClause)
    .limit(limit + 1)

  const hasMore = results.length > limit
  const page = hasMore ? results.slice(0, limit) : results
  const nextCursor = hasMore
    ? page[page.length - 1].recordCreatedAt.toISOString()
    : undefined

  return {
    results: page,
    cursor: nextCursor,
    totalEstimate: null,
  }
}
