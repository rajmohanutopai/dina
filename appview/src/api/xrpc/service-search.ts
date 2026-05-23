import { z } from 'zod'
import { eq, and, sql, lt, or, isNull, type SQL } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { services } from '@/db/schema/index.js'
import { didProfiles, didRedactions } from '@/db/schema/index.js'
import { encodeCursor, decodeCursor } from '@/util/cursor.js'

/**
 * Ranking-formula version. Stamped into the response so clients can
 * detect formula drift across deploys. Bump when the composite-score
 * weights change or when a new component is added.
 *
 * Versioning stance: a `RANKING_VERSION` bump should also bump the
 * shared cursor `v` in `util/cursor.ts`. Cursors encode a pagination
 * state tied to the row ordering — if the ordering changes, an
 * in-flight cursor's "next page" claim is wrong. See the cursor
 * helper docstring for the full rationale.
 */
export const RANKING_VERSION = 'v1'

/** Payload shape for the service-search cursor (bucket-binned composite score). */
const ServiceSearchCursor = z.object({
  bucket: z.number(),
  uri: z.string(),
})

/**
 * xRPC endpoint: com.dina.service.search
 *
 * Ranked service discovery. Combines distance, text relevance, and trust
 * score into a composite ranking.
 *
 * Ranking formula (RANKING_VERSION = 'v1'):
 *   composite = distance_score * 0.4 + text_score * 0.3 + trust_score * 0.3   (when lat/lng provided)
 *   composite = text_score * 0.5 + trust_score * 0.5                          (otherwise)
 *
 *   - distance_score: clamp(1.0 - haversine_km / radiusKm, 0, 1)
 *   - text_score: 1.0 if `q` matches `services.searchContent` via ILIKE (with
 *     pattern metacharacters in `q` escaped), else 0.0. Phase 2 will swap in
 *     tsvector/tsquery for graded relevance.
 *   - trust_score: COALESCE(didProfiles.overallTrustScore, 0.0). Stored as a
 *     [0, 1] value across the AppView (same scale as PeerLens bands); used
 *     here without further normalization.
 *
 * Cursor: composite (score_bucket::uri) where score_bucket = floor(composite * 1000)
 */

export const ServiceSearchParams = z.object({
  capability: z.string().min(1).max(200),
  // lat/lng are optional: non-geospatial capabilities still need discovery.
  // When omitted, distance scoring is skipped and ranking falls back to
  // text + trust only.
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().min(0.1).max(500).default(5),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().min(1).max(50).default(10),
  cursor: z.string().max(500).optional(),
})

export type ServiceSearchParamsType = z.infer<typeof ServiceSearchParams>

export interface ServiceSearchResult {
  uri: string
  operatorDid: string
  name: string
  description: string | null
  capabilities: unknown
  capabilitySchemas: unknown  // WS2: per-capability JSON schemas (each carries its own schema_hash)
  serviceArea: { lat: number; lng: number; radiusKm: number } | null
  hours: unknown
  responsePolicy: unknown
  trustScore: number | null
  score: number
  /**
   * Operator-moderator takedown marker. Always `false` in the search
   * response (tombstoned services are excluded from results); the
   * field is reserved so a future caller passing
   * `includeTombstoned=true` can surface them with a flag instead of
   * a wire-shape bump.
   */
  tombstoned: boolean
  /**
   * Convenience flat fields for callers that searched by capability:
   * the matched capability + its schema entry pulled out so consumers
   * don't have to walk the `capabilities` array + `capabilitySchemas`
   * record themselves. Always populated since the search endpoint
   * requires a `capability` query parameter.
   */
  matchedCapability: string
  matchedSchema: unknown
  matchedSchemaHash: string | null
  /**
   * Haversine distance in km from the requested (lat, lng) to the
   * service area centroid. `null` when no location was supplied
   * (search ran in text+trust-only mode).
   */
  distanceKm: number | null
}

export interface ServiceSearchResponse {
  services: ServiceSearchResult[]
  cursor: string | null
  /**
   * Version of the ranking formula that produced the `score` field.
   * Lets clients detect formula drift across deploys.
   */
  rankingVersion: string
}

export async function serviceSearch(
  db: DrizzleDB,
  params: ServiceSearchParamsType,
): Promise<ServiceSearchResponse> {
  const { capability, lat, lng, radiusKm, q, limit, cursor } = params
  const hasLocation = lat !== undefined && lng !== undefined

  // Haversine distance — only meaningful when the caller provided a
  // reference location. Non-geospatial searches drop the distance term
  // entirely and rank on text + trust.
  const distanceExpr = hasLocation
    ? sql`(
    6371 * acos(
      LEAST(1.0, GREATEST(-1.0,
        cos(radians(${lat})) * cos(radians(CAST(${services.lat} AS double precision)))
        * cos(radians(CAST(${services.lng} AS double precision)) - radians(${lng}))
        + sin(radians(${lat})) * sin(radians(CAST(${services.lat} AS double precision)))
      ))
    )
  )`
    : sql<number>`0`

  const distanceScoreExpr = hasLocation
    ? sql<number>`GREATEST(0, LEAST(1.0, 1.0 - ${distanceExpr} / ${radiusKm}))`
    : sql<number>`0.0`

  // ILIKE treats `%` and `_` (and `\` as the default escape) specially.
  // The caller's `q` is a plain text query — wrap it so those characters
  // match literally. Without this, a `q` containing `%` would expand into
  // a "match-anything" pattern and dominate the text-score branch.
  const escapedQ = q ? q.replace(/[\\%_]/g, '\\$&') : null
  const textScoreExpr = escapedQ
    ? sql<number>`CASE WHEN ${services.searchContent} ILIKE ${'%' + escapedQ + '%'} THEN 1.0 ELSE 0.0 END`
    : sql<number>`0.0`

  const trustScoreExpr = sql<number>`COALESCE(${didProfiles.overallTrustScore}, 0.0)`

  // Composite score: distance * 0.4 + text * 0.3 + trust * 0.3 when
  // geolocation is present, otherwise text * 0.5 + trust * 0.5.
  const compositeScoreExpr = hasLocation
    ? sql<number>`(
    ${distanceScoreExpr} * 0.4
    + ${textScoreExpr} * 0.3
    + ${trustScoreExpr} * 0.3
  )`
    : sql<number>`(${textScoreExpr} * 0.5 + ${trustScoreExpr} * 0.5)`

  const scoreBucketExpr = sql<number>`floor((${compositeScoreExpr}) * 1000)`

  // Capability strings are normalized at the index layer (handler
  // lowercases + trims before storing), so the lookup must do the
  // same to stay consistent. Without this, "Plumbing" published by
  // operator A and "plumbing" searched by user B would miss each
  // other.
  const normalizedCapability = capability.trim().toLowerCase()

  const conditions: SQL[] = [
    // Operator-side discoverability flag.
    eq(services.isDiscoverable, true),
    // Operator-side moderator takedown gate. Tombstoned services
    // remain in the table (URL stability + audit) but never surface
    // in search.
    isNull(services.tombstonedAt),
    // Capability match against the GIN-indexed array column.
    sql`${services.capabilitiesJson}::jsonb @> ${JSON.stringify([normalizedCapability])}::jsonb`,
  ]
  if (hasLocation) {
    conditions.push(sql`${services.lat} IS NOT NULL AND ${services.lng} IS NOT NULL`)
    conditions.push(sql`${distanceExpr} <= ${radiusKm}`)
  }

  // Keyset pagination on (score_bucket DESC, uri DESC). The cursor is
  // an opaque base64url-wrapped JSON envelope `{v, bucket, uri}` so a
  // future strategy change (e.g. true keyset on score+uri without the
  // integer bucket binning) doesn't break clients holding cursors.
  // Malformed / unknown-version cursors are rejected loud rather than
  // silently producing an unconstrained page.
  if (cursor !== undefined) {
    // Throws InvalidCursorError (→ 400 InvalidRequest) on malformed
    // input. Loud rejection beats silently producing an unconstrained
    // page when a client sends a cursor from a prior CURSOR_VERSION.
    const decoded = decodeCursor(cursor, ServiceSearchCursor)
    // `or(...)` is variadic and may return undefined when given zero
    // args; both branches below are concrete SQL fragments, so the
    // result is non-null at runtime. The `!` aligns the type checker
    // with that invariant.
    conditions.push(or(
      lt(scoreBucketExpr, sql`${decoded.bucket}`),
      and(sql`${scoreBucketExpr} = ${decoded.bucket}`, lt(services.uri, decoded.uri)),
    )!)
  }

  const results = await db
    .select({
      uri: services.uri,
      operatorDid: services.operatorDid,
      name: services.name,
      description: services.description,
      capabilities: services.capabilitiesJson,
      lat: services.lat,
      lng: services.lng,
      radiusKm: services.radiusKm,
      hours: services.hoursJson,
      responsePolicy: services.responsePolicyJson,
      capabilitySchemas: services.capabilitySchemasJson,
      trustScore: didProfiles.overallTrustScore,
      score: compositeScoreExpr,
      scoreBucket: scoreBucketExpr,
      // Server-side distance projection so the response carries an
      // already-computed value (consumers don't redo haversine
      // themselves). `null` when no caller location was supplied.
      distanceKm: hasLocation
        ? sql<number>`${distanceExpr}`.as('distance_km_calc')
        : sql<number | null>`NULL::double precision`.as('distance_km_calc'),
    })
    .from(services)
    .leftJoin(didProfiles, eq(services.operatorDid, didProfiles.did))
    // GDPR-shaped: if the operator's DID has a `did_redactions` row,
    // exclude their entire service profile from the result set (the
    // row stays in the `services` table for audit + reversibility,
    // but never surfaces to readers). The LEFT JOIN keeps non-
    // redacted operators eligible; the IS NULL check in the WHERE
    // filter excludes the redacted ones.
    .leftJoin(didRedactions, eq(services.operatorDid, didRedactions.did))
    .where(and(isNull(didRedactions.did), ...conditions))
    .orderBy(sql`${scoreBucketExpr} DESC`, sql`${services.uri} DESC`)
    .limit(limit + 1)

  const hasMore = results.length > limit
  const page = hasMore ? results.slice(0, limit) : results
  const lastRow = page[page.length - 1]
  const nextCursor = hasMore && lastRow
    ? encodeCursor({ bucket: lastRow.scoreBucket, uri: lastRow.uri })
    : null

  return {
    services: page.map(r => {
      // The matched capability is what the caller asked for (already
      // normalized into `normalizedCapability` above). The matching
      // schema is whichever entry in `capabilitySchemas` keys off
      // the matched capability — or `null` if the operator didn't
      // publish a schema for it.
      const schemasObj = (r.capabilitySchemas ?? {}) as Record<string, {
        description?: string
        params?: Record<string, unknown>
        result?: Record<string, unknown>
        schema_hash?: string
      }>
      const matchedSchemaEntry = schemasObj[normalizedCapability] ?? null
      return {
        uri: r.uri,
        operatorDid: r.operatorDid,
        name: r.name,
        description: r.description,
        capabilities: r.capabilities,
        serviceArea: r.lat != null && r.lng != null && r.radiusKm != null
          ? { lat: parseFloat(r.lat), lng: parseFloat(r.lng), radiusKm: parseFloat(r.radiusKm) }
          : null,
        hours: r.hours,
        responsePolicy: r.responsePolicy,
        capabilitySchemas: r.capabilitySchemas ?? null,
        trustScore: r.trustScore,
        score: r.score,
        // Tombstoned rows are excluded from the result set (see the
        // WHERE clause). Always emit `false` here so the wire shape
        // stays stable for a future `includeTombstoned` variant.
        tombstoned: false,
        // Flat convenience fields for capability-keyed consumers.
        matchedCapability: normalizedCapability,
        matchedSchema: matchedSchemaEntry,
        matchedSchemaHash: matchedSchemaEntry?.schema_hash ?? null,
        distanceKm: typeof r.distanceKm === 'number' ? r.distanceKm : null,
      }
    }),
    cursor: nextCursor,
    rankingVersion: RANKING_VERSION,
  }
}
