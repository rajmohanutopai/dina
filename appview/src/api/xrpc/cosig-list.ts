import { z } from 'zod'
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { cosigRequests } from '@/db/schema/index.js'

/**
 * `com.dina.trust.cosigList` (TN-API-006 / Plan §6 + §10).
 *
 * List cosig requests addressed to a recipient DID. The mobile
 * cosig-inbox screen calls this to render the "asks awaiting your
 * response" surface — pending requests are most useful (default
 * filter), but operators / power users may want history (accepted /
 * rejected / expired) for audit.
 *
 * **Public read with mandatory `recipientDid` filter**. Anyone can
 * see anyone else's pending cosig backlog — the cosig record itself
 * is published to the AT Protocol firehose, so privacy is not a
 * property of the read API; the data is intrinsically public. The
 * filter is "mandatory" not because it's a privacy gate, but because
 * an unfiltered query would do a full table scan. Plan §6 rate limit
 * is 60/IP/min (TN-API-007) — sufficient for inbox refreshes; not
 * sufficient for unfiltered scraping.
 *
 * **Pagination via `(created_at, id)` cursor**. `id` is `bigserial`
 * so two rows can share the same `created_at` only if they were
 * inserted in the same microsecond — `(created_at DESC, id DESC)`
 * gives a stable total order. The cursor encodes both so we don't
 * miss / duplicate rows across page boundaries when many cosig
 * requests land at once (e.g. a bulk-cosig flow). Format:
 * `${createdAt.toISOString()}::${id}` — same shape as
 * `get-attestations.ts` for consistency.
 *
 * **Index usage**: `cosig_requests_recipient_status_idx` covers
 * `(recipient_did, status)` — the partial-index path is the hot one,
 * and ORDER BY uses created_at + id (PK), so the planner naturally
 * sorts via the PK-index after filtering.
 *
 * **Bigint `id` serialised to string**. Postgres `bigserial` becomes
 * a JS `bigint`; `JSON.stringify` rejects bigints with TypeError. We
 * convert to string at the boundary — clients can treat IDs as
 * opaque tokens for cursor pagination.
 */

const STATUS_VALUES = ['pending', 'accepted', 'rejected', 'expired'] as const

export const CosigListParams = z.object({
  recipientDid: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^did:[a-z]+:/, 'must be a DID'),
  status: z.enum(STATUS_VALUES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
})

export type CosigListParamsType = z.infer<typeof CosigListParams>

export interface CosigListEntry {
  id: string
  requesterDid: string
  recipientDid: string
  attestationUri: string
  status: string
  endorsementUri: string | null
  rejectReason: string | null
  expiresAt: string
  createdAt: string
  updatedAt: string
}

export interface CosigListResponse {
  requests: CosigListEntry[]
  cursor?: string
}

/**
 * Parse a `${ISO}::${bigintId}` cursor. Returns null when malformed —
 * the dispatcher then surfaces a 400 via the Zod-aware error path.
 */
function parseCursor(
  raw: string,
): { createdAt: Date; id: bigint } | null {
  const sepIdx = raw.indexOf('::')
  if (sepIdx <= 0 || sepIdx >= raw.length - 2) return null
  const ts = new Date(raw.slice(0, sepIdx))
  if (Number.isNaN(ts.getTime())) return null
  let id: bigint
  try {
    id = BigInt(raw.slice(sepIdx + 2))
  } catch {
    return null
  }
  return { createdAt: ts, id }
}

export async function cosigList(
  db: DrizzleDB,
  params: CosigListParamsType,
): Promise<CosigListResponse> {
  const conditions: SQL[] = [eq(cosigRequests.recipientDid, params.recipientDid)]
  if (params.status) {
    conditions.push(eq(cosigRequests.status, params.status))
  }
  if (params.cursor) {
    const parsed = parseCursor(params.cursor)
    if (parsed === null) {
      // Surface as Zod-shaped error so the dispatcher returns 400
      // (matches the get-attestations.ts pattern exactly).
      throw Object.assign(new Error('Invalid cursor format'), {
        name: 'ZodError',
        message: 'Invalid cursor format',
      })
    }
    conditions.push(
      or(
        lt(cosigRequests.createdAt, parsed.createdAt),
        and(
          eq(cosigRequests.createdAt, parsed.createdAt),
          lt(cosigRequests.id, parsed.id),
        ),
      )!,
    )
  }

  const rows = await db
    .select()
    .from(cosigRequests)
    .where(and(...conditions))
    .orderBy(desc(cosigRequests.createdAt), desc(cosigRequests.id))
    .limit(params.limit + 1)

  const hasMore = rows.length > params.limit
  const page = hasMore ? rows.slice(0, params.limit) : rows
  const last = page[page.length - 1]

  const requests: CosigListEntry[] = page.map((r) => ({
    id: r.id.toString(),
    requesterDid: r.requesterDid,
    recipientDid: r.recipientDid,
    attestationUri: r.attestationUri,
    status: r.status,
    endorsementUri: r.endorsementUri,
    rejectReason: r.rejectReason,
    expiresAt: r.expiresAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))

  return {
    requests,
    cursor:
      hasMore && last
        ? `${last.createdAt.toISOString()}::${last.id.toString()}`
        : undefined,
  }
}
