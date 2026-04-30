import { z } from 'zod'
import { eq, and, desc, gte, lte, lt, or, sql, inArray } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { attestations, subjects, subjectScores } from '@/db/schema/index.js'
import type { SearchResponse } from '@/shared/types/api-types.js'

const CONFIDENCE_ORDER = ['speculative', 'moderate', 'high', 'certain'] as const

/**
 * Whitelist of `metadata.*` keys the search xRPC accepts in
 * `metadataFilters` (TN-API-001 / Plan §6.1 line 717). A whitelist
 * — not arbitrary keys — because:
 *   1. Each key has a known, indexed shape (string or number) under
 *      `subjects.metadata`. Arbitrary keys would bypass the GIN
 *      index plan and let attackers force seq scans.
 *   2. The frontend's facet bar (Plan §6.6) is the canonical UX for
 *      these — the API surface mirrors it. New facets land via a
 *      curator deploy, same as `host_category.ts` / `category_keywords.ts`.
 *   3. JSON-contains semantics (`metadata @> {...}`) means typo'd
 *      keys silently match nothing — a closed list surfaces the bug
 *      at validation time as a 400.
 */
const METADATA_FILTER_KEYS = [
  'brand',
  'place_type',
  'cuisine',
  'host',
  'media_type',
  'org_type',
  'identifier_kind',
  'domain',
] as const

type MetadataFilterKey = (typeof METADATA_FILTER_KEYS)[number]

const metadataFilterValue = z.union([
  z.string().max(200),
  z.number(),
  z.boolean(),
])

const metadataFiltersSchema = z
  .record(z.string(), metadataFilterValue)
  .refine(
    (obj) => Object.keys(obj).every((k) => (METADATA_FILTER_KEYS as readonly string[]).includes(k)),
    {
      message: `metadataFilters keys must be one of: ${METADATA_FILTER_KEYS.join(', ')}`,
    },
  )
  .optional()

/**
 * `location` filter (Plan §6.1 lines 710-714): radius query against
 * `subjects.metadata.{lat,lng}` for `place` subjects. Capped at
 * 200 km because beyond that the bounding-box approximation
 * (lat ±R/111 deg, lng ±R/(111·cos(lat)) deg) loses meaningful
 * precision near the poles — operators wanting global searches use
 * `subjectType=place` without a location filter.
 */
const locationSchema = z
  .object({
    lat: z.number().gte(-90).lte(90),
    lng: z.number().gte(-180).lte(180),
    radiusKm: z.number().positive().max(200),
  })
  .optional()

/**
 * `language` filter (Plan §6.1 line 709): BCP-47 tag(s); OR-match
 * when an array. Single string for the simple case ("only English"),
 * array for "English OR Spanish OR Portuguese" multi-locale searches.
 */
const languageFilterSchema = z
  .union([z.string().max(20), z.array(z.string().max(20)).max(10)])
  .optional()

export const SearchParams = z
  .object({
    // XR4: Reduced from 500 to 200 to limit FTS query complexity.
    q: z.string().max(200).optional(),
    category: z.string().max(200).optional(),
    // TN-API-001 / Plan §6.1 line 708: prefix match — `'product'`
    // matches both `'product:chair'` AND `'product:phone'`. Mutually
    // exclusive with `category` (the strict-equal sibling).
    categoryPrefix: z.string().max(200).optional(),
    domain: z.string().max(253).regex(/^[a-z0-9.-]+$/i).optional(),
    subjectType: z.enum(['did', 'content', 'product', 'dataset', 'organization', 'claim', 'place']).optional(),
    sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
    tags: z.string().max(1000).optional(),
    authorDid: z.string().max(2048).regex(/^did:[a-z]+:/).optional(),
    minConfidence: z.enum(['speculative', 'moderate', 'high', 'certain']).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    sort: z.enum(['recent', 'relevant']).default('relevant'),
    limit: z.coerce.number().min(1).max(100).default(25),
    cursor: z.string().max(500).optional(),
    // TN-API-001 / Plan §6.1 — additive filter set.
    language: languageFilterSchema,
    location: locationSchema,
    metadataFilters: metadataFiltersSchema,
    minReviewCount: z.coerce.number().int().nonnegative().max(1_000_000).optional(),
    // `reviewersInNetwork` is parsed for forward compatibility but
    // NOT yet enforced — implementing it requires viewer-side
    // graph queries that aren't in the search xRPC's scope today.
    // Tracked as a follow-up; the schema accepts it so mobile clients
    // can already serialise the param without breaking.
    reviewersInNetwork: z.enum(['any', 'one_plus', 'majority']).optional(),
    viewerDid: z.string().max(2048).regex(/^did:[a-z]+:/).optional(),
  })
  // TN-API-001 / Plan §6.1 line 728: `category` and `categoryPrefix`
  // are mutually exclusive. The 400 is more informative than a
  // silent "we ANDed two contradictory predicates and returned
  // nothing".
  .refine((p) => !(p.category && p.categoryPrefix), {
    message: 'category and categoryPrefix are mutually exclusive',
    path: ['categoryPrefix'],
  })

export type SearchParamsType = z.infer<typeof SearchParams>

export async function search(
  db: DrizzleDB,
  params: SearchParamsType,
): Promise<SearchResponse> {
  const {
    q, category, categoryPrefix, domain, subjectType, sentiment, tags, authorDid,
    minConfidence, since, until, sort, limit, cursor,
    language, location, metadataFilters, minReviewCount,
  } = params

  const conditions: any[] = [eq(attestations.isRevoked, false)]

  if (category) conditions.push(eq(attestations.category, category))
  // TN-API-001: prefix match on attestations.category. Drizzle's
  // `like(col, 'value%')` parameterises the value so user input is
  // bound (no SQL injection). The pattern is anchored at the start
  // — `'product'` matches `'product:chair'`, `'product:furniture'`,
  // and bare `'product'`, but NOT `'place:product'` or other
  // substrings.
  if (categoryPrefix) {
    conditions.push(sql`${attestations.category} LIKE ${categoryPrefix + '%'}`)
  }
  if (domain) conditions.push(eq(attestations.domain, domain))
  if (sentiment) conditions.push(eq(attestations.sentiment, sentiment))
  if (authorDid) conditions.push(eq(attestations.authorDid, authorDid))

  // TN-API-001: language filter — single string OR array (OR-match).
  // BCP-47 tags are case-insensitive per RFC 5646, but our ingester
  // normalises to lowercase 2-letter or hyphenated `pt-BR` style;
  // we match exact-case here, deferring caller-side normalisation.
  if (language) {
    if (Array.isArray(language)) {
      if (language.length > 0) {
        conditions.push(inArray(attestations.language, language))
      }
    } else {
      conditions.push(eq(attestations.language, language))
    }
  }

  // MEDIUM-03: Apply subjectType filter via subjects table subquery
  if (subjectType) {
    const matchingSubjects = db.select({ id: subjects.id }).from(subjects).where(eq(subjects.subjectType, subjectType))
    conditions.push(inArray(attestations.subjectId, matchingSubjects))
  }

  // TN-API-001: location radius filter — bounding-box approximation
  // over `subjects.metadata.{lat,lng}` keyed by the partial
  // `subjects_geo_idx` (see schema docstring). The bbox is generous
  // (~28% larger than a true circle in the corner regions); precise
  // haversine refinement is future work + not required by Plan §6.1
  // for V1. Bbox formula:
  //   lat range: ±radiusKm / 111
  //   lng range: ±radiusKm / (111 · cos(lat_rad))
  // The cos(lat) shrinks the lng range near the poles so the bbox
  // stays roughly square in km terms.
  if (location) {
    const latDelta = location.radiusKm / 111
    const lngDelta = location.radiusKm / (111 * Math.cos((location.lat * Math.PI) / 180))
    const minLat = location.lat - latDelta
    const maxLat = location.lat + latDelta
    const minLng = location.lng - lngDelta
    const maxLng = location.lng + lngDelta
    const matchingSubjects = db
      .select({ id: subjects.id })
      .from(subjects)
      .where(
        sql`(${subjects.metadata}->>'lat')::float BETWEEN ${minLat} AND ${maxLat}
            AND (${subjects.metadata}->>'lng')::float BETWEEN ${minLng} AND ${maxLng}`,
      )
    conditions.push(inArray(attestations.subjectId, matchingSubjects))
  }

  // TN-API-001: metadataFilters — JSON-contains predicate against
  // `subjects.metadata` keyed by the GIN `subjects_metadata_idx`
  // (jsonb_path_ops opclass). `@>` semantics: a row matches when its
  // metadata object contains every key/value in the filter. Single
  // SQL predicate per filter (we AND multiple keys via the
  // containment operator's atomicity — `metadata @> '{"a":"x","b":"y"}'`
  // matches only rows where BOTH keys are present with the given
  // values). Whitelisted keys at the schema level prevent arbitrary
  // jsonb scans.
  if (metadataFilters && Object.keys(metadataFilters).length > 0) {
    const matchingSubjects = db
      .select({ id: subjects.id })
      .from(subjects)
      .where(
        sql`${subjects.metadata} @> ${JSON.stringify(metadataFilters)}::jsonb`,
      )
    conditions.push(inArray(attestations.subjectId, matchingSubjects))
  }

  // TN-API-001: minReviewCount — filter to subjects whose
  // `subject_scores.total_attestations >= N`. Useful for "established
  // only" filtering — drops single-review subjects that haven't
  // accumulated enough signal for a stable score band. JOIN-via-
  // subquery rather than a full JOIN to keep the query plan flat.
  if (minReviewCount !== undefined && minReviewCount > 0) {
    const matchingSubjects = db
      .select({ id: subjectScores.subjectId })
      .from(subjectScores)
      .where(gte(subjectScores.totalAttestations, minReviewCount))
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
  const useFTS = !!(q && sort === 'relevant')
  if (useFTS) {
    const tsQuery = sql`plainto_tsquery('english', ${q})`
    conditions.push(sql`search_vector @@ ${tsQuery}`)
    orderClause = [sql`ts_rank(search_vector, ${tsQuery}) DESC`, desc(attestations.uri)]
  } else {
    orderClause = [desc(attestations.recordCreatedAt), desc(attestations.uri)]
  }

  // XR4: Wrap in statement_timeout when FTS is used to prevent
  // CPU-intensive queries from blocking the database.
  const runQuery = async (queryDb: DrizzleDB) => {
    return queryDb.select()
      .from(attestations)
      .where(and(...conditions))
      .orderBy(...orderClause)
      .limit(limit + 1)
  }

  let results: Awaited<ReturnType<typeof runQuery>>
  if (useFTS) {
    try {
      results = await db.transaction(async (tx) => {
        await tx.execute(sql.raw(`SET LOCAL statement_timeout = '200ms'`))
        return runQuery(tx as unknown as DrizzleDB)
      })
    } catch (err: any) {
      if (err?.code === '57014') {
        // Query canceled by statement_timeout — return empty results.
        return { results: [], cursor: undefined, totalEstimate: 0 }
      }
      throw err
    }
  } else {
    results = await runQuery(db)
  }

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
