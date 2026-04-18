import { z } from 'zod'
import { eq, and, sql, lt, or } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { services } from '@/db/schema/index.js'
import { didProfiles } from '@/db/schema/index.js'

/**
 * xRPC endpoint: com.dina.service.search
 *
 * Ranked service discovery. Combines distance, text relevance, and trust
 * score into a composite ranking.
 *
 * Ranking formula: distance_score * 0.4 + text_score * 0.3 + trust_score * 0.3
 *   - distance_score: clamp(1.0 - distance/radius, 0, 1)
 *   - text_score: basic ILIKE matching for Phase 1 (full tsvector in Phase 2)
 *   - trust_score: LEFT JOIN didProfiles on operatorDid, COALESCE overall_trust_score / 100
 *
 * Cursor: composite (score_bucket::uri) where score_bucket = floor(score * 1000)
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
}

export interface ServiceSearchResponse {
  services: ServiceSearchResult[]
  cursor?: string
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

  const textScoreExpr = q
    ? sql<number>`CASE WHEN ${services.searchContent} ILIKE ${'%' + q + '%'} THEN 1.0 ELSE 0.0 END`
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

  const conditions: any[] = [
    eq(services.isDiscoverable, true),
    sql`${services.capabilitiesJson}::jsonb @> ${JSON.stringify([capability])}::jsonb`,
  ]
  if (hasLocation) {
    conditions.push(sql`${services.lat} IS NOT NULL AND ${services.lng} IS NOT NULL`)
    conditions.push(sql`${distanceExpr} <= ${radiusKm}`)
  }

  // Cursor-based pagination: composite (score_bucket::uri)
  if (cursor) {
    const sepIdx = cursor.indexOf('::')
    if (sepIdx > 0) {
      const cursorBucket = parseInt(cursor.slice(0, sepIdx), 10)
      const cursorUri = cursor.slice(sepIdx + 2)
      if (!isNaN(cursorBucket)) {
        conditions.push(or(
          lt(scoreBucketExpr, sql`${cursorBucket}`),
          and(sql`${scoreBucketExpr} = ${cursorBucket}`, lt(services.uri, cursorUri)),
        ))
      }
    }
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
    })
    .from(services)
    .leftJoin(didProfiles, eq(services.operatorDid, didProfiles.did))
    .where(and(...conditions))
    .orderBy(sql`${scoreBucketExpr} DESC`, sql`${services.uri} DESC`)
    .limit(limit + 1)

  const hasMore = results.length > limit
  const page = hasMore ? results.slice(0, limit) : results
  const lastRow = page[page.length - 1]
  const nextCursor = hasMore && lastRow
    ? `${lastRow.scoreBucket}::${lastRow.uri}`
    : undefined

  return {
    services: page.map(r => ({
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
    })),
    cursor: nextCursor,
  }
}
