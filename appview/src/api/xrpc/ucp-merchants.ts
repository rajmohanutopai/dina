/**
 * The UCP merchant index's two xRPC methods (docs/UCP_IMPLEMENTATION_PLAN.md
 * §3.15, U5): `com.dinakernel.ucp.searchMerchants` and
 * `com.dinakernel.ucp.getMerchant`.
 *
 * The index relays; it never vouches. Every result is a candidate: a Dina
 * reads the merchant's live profile itself before any call, and its owner
 * decides which shops Dina may use.
 *
 * Ranking: relevance filters, trust orders (as the A2A directory). A
 * capability or text match decides whether a merchant is a candidate;
 * candidates order by (a usable profile first, then one not read yet, then
 * one that cannot be used; PeerLens's `avoid` last within each; PeerLens
 * trust; text relevance; origin). Trust is PeerLens's score for the
 * merchant as an organization subject, 0 when it has none, as the A2A
 * directory orders an unscored DID; the answer says which merchants have no
 * PeerLens record (unverified). Text is PeerLens's name for the merchant
 * and the categories it was reviewed under, never the merchant's own words
 * (Verified Truth).
 */

import { z } from 'zod'
import { sql, type SQL } from 'drizzle-orm'

import { merchantOrigin } from '@dina/ucp'

import type { DrizzleDB } from '@/db/connection.js'
import { decodeCursor, encodeCursor } from '@/util/cursor.js'
import { XrpcError } from '@/web/xrpc-dispatch.js'

/** The ordering's version: a cursor from another ordering is refused. */
export const UCP_MERCHANT_RANKING_VERSION = 'ucp-v1'
export const UCP_MERCHANT_PAGE_MAX = 50
export const UCP_MERCHANT_QUERY_MAX_LENGTH = 200
/** A UCP capability name Dina negotiates (`dev.ucp.shopping.*`). */
const CAPABILITY_RE = /^dev\.ucp\.shopping(?:\.[a-z][a-z0-9_]*)+$/
/** No control characters (Postgres refuses NUL in text; nothing else needs them). */
const PRINTABLE = /^[^\u0000-\u001f\u007f]*$/

export const SearchMerchantsParams = z.object({
  capability: z.string().max(128).regex(CAPABILITY_RE).optional(),
  q: z.string().min(1).max(UCP_MERCHANT_QUERY_MAX_LENGTH).regex(PRINTABLE).optional(),
  limit: z.coerce.number().int().min(1).max(UCP_MERCHANT_PAGE_MAX).default(20),
  cursor: z.string().max(500).optional(),
})
export type SearchMerchantsParamsType = z.infer<typeof SearchMerchantsParams>

export const GetMerchantParams = z.object({
  origin: z.string().min(1).max(300).regex(PRINTABLE),
})
export type GetMerchantParamsType = z.infer<typeof GetMerchantParams>

const SearchCursor = z.object({
  rv: z.literal(UCP_MERCHANT_RANKING_VERSION),
  s: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  a: z.union([z.literal(0), z.literal(1)]),
  t: z.number().finite(),
  r: z.number().finite(),
  o: z.string().max(300).regex(PRINTABLE),
})

export interface UcpMerchantView {
  origin: string
  /** PeerLens's name for the merchant, when it has one. */
  name: string | null
  /** `usable`: its profile can be used now; `pending`: not read yet; `unusable`: see `reason`. */
  state: 'usable' | 'pending' | 'unusable'
  reason: string | null
  version: string | null
  transport: 'mcp' | 'rest' | null
  capabilities: string[]
  /** PeerLens's score, 0–1; null when PeerLens has scored it no review (unrated). */
  trustScore: number | null
  recommendation: string | null
  reviewCount: number
  /** False when PeerLens has no review of the merchant at all. */
  verified: boolean
  checkedAt: string | null
}

interface Row {
  origin: string
  name: string | null
  state: string
  reason: string | null
  version: string | null
  transport: string | null
  capabilities: string[]
  trust_score: number | null
  recommendation: string | null
  review_count: number
  checked_at: Date | null
  state_rank: number
  avoid_rank: number
  trust: number
  relevance: number
}

const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows

const STATE_RANK = sql`(CASE m.state WHEN 'usable' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END)`
const AVOID_RANK = sql`(CASE WHEN m.recommendation = 'avoid' THEN 1 ELSE 0 END)`
const TRUST = sql`COALESCE(m.trust_score, 0)::double precision`
const COLUMNS = sql`m.origin, m.name, m.state, m.reason, m.version, m.transport, m.capabilities, m.trust_score,
  m.recommendation, m.review_count, m.checked_at, ${STATE_RANK} AS state_rank, ${AVOID_RANK} AS avoid_rank,
  ${TRUST} AS trust`

function view(row: Row): UcpMerchantView {
  return {
    origin: row.origin,
    name: row.name,
    state: row.state === 'usable' || row.state === 'unusable' ? row.state : 'pending',
    reason: row.reason,
    version: row.version,
    transport: row.transport === 'mcp' || row.transport === 'rest' ? row.transport : null,
    capabilities: row.capabilities,
    trustScore: row.trust_score === null ? null : Number(row.trust_score),
    recommendation: row.recommendation,
    reviewCount: Number(row.review_count),
    verified: Number(row.review_count) > 0,
    checkedAt: row.checked_at === null ? null : new Date(row.checked_at).toISOString(),
  }
}

export async function searchMerchants(
  db: DrizzleDB,
  params: SearchMerchantsParamsType,
): Promise<{ merchants: UcpMerchantView[]; cursor: string | null; rankingVersion: string }> {
  const filters: SQL[] = [sql`TRUE`]
  if (params.capability !== undefined) filters.push(sql`m.capabilities @> ARRAY[${params.capability}]::text[]`)
  const relevance =
    params.q !== undefined
      ? sql`ts_rank(to_tsvector('simple', coalesce(m.search_text, '')), plainto_tsquery('simple', ${params.q}))`
      : sql`0::real`
  if (params.q !== undefined)
    filters.push(sql`to_tsvector('simple', coalesce(m.search_text, '')) @@ plainto_tsquery('simple', ${params.q})`)
  const rank = sql`(${relevance})::double precision`

  if (params.cursor !== undefined) {
    let at: z.infer<typeof SearchCursor>
    try {
      at = decodeCursor(params.cursor, SearchCursor)
    } catch {
      throw new XrpcError(400, 'InvalidRequest', 'cursor: not one this ordering issued')
    }
    filters.push(sql`(
      ${STATE_RANK} > ${at.s}
      OR (${STATE_RANK} = ${at.s} AND (
        ${AVOID_RANK} > ${at.a}
        OR (${AVOID_RANK} = ${at.a} AND (
          ${TRUST} < ${at.t}
          OR (${TRUST} = ${at.t} AND (
            ${rank} < ${at.r}
            OR (${rank} = ${at.r} AND m.origin > ${at.o}))))))))`)
  }

  const rows = rowsOf<Row>(
    await db.execute(sql`
      SELECT ${COLUMNS}, ${rank} AS relevance
        FROM ucp_merchants m
       WHERE ${sql.join(filters, sql` AND `)}
       ORDER BY ${STATE_RANK} ASC, ${AVOID_RANK} ASC, ${TRUST} DESC, ${rank} DESC, m.origin ASC
       LIMIT ${params.limit + 1}`),
  )
  const page = rows.slice(0, params.limit)
  const last = page[page.length - 1]
  const cursor =
    rows.length > params.limit && last !== undefined
      ? encodeCursor({
          rv: UCP_MERCHANT_RANKING_VERSION,
          s: Number(last.state_rank) as 0 | 1 | 2,
          a: Number(last.avoid_rank) as 0 | 1,
          t: Number(last.trust),
          r: Number(last.relevance),
          o: last.origin,
        })
      : null
  return { merchants: page.map(view), cursor, rankingVersion: UCP_MERCHANT_RANKING_VERSION }
}

export async function getMerchant(db: DrizzleDB, params: GetMerchantParamsType): Promise<{ merchant: UcpMerchantView }> {
  const origin = merchantOrigin(params.origin)
  if (origin === null) throw new XrpcError(400, 'InvalidRequest', 'origin: not an https origin')
  const [row] = rowsOf<Row>(
    await db.execute(sql`SELECT ${COLUMNS}, 0::double precision AS relevance FROM ucp_merchants m WHERE m.origin = ${origin}`),
  )
  if (row === undefined) throw new XrpcError(404, 'NotFound', 'no merchant at that origin')
  return { merchant: view(row) }
}
