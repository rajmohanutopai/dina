import { z } from 'zod'
import { and, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { attestations, didProfiles } from '@/db/schema/index.js'
import { getCachedGraphContext } from '@/api/middleware/graph-context-cache.js'
import { normalizeHandle } from '@/util/handle_normalize.js'

/**
 * `com.dina.trust.networkFeed` (TN-API-004 / Plan §6.4).
 *
 * Returns recent attestations authored by the viewer's 1-hop trust
 * graph — the DIDs the viewer has directly attested to / vouched for
 * / endorsed. The mobile feed surface uses this to render "people I
 * trust just published these reviews", which is the trust-network
 * equivalent of a follow-graph timeline.
 *
 * **1-hop scope, not transitive**. Plan §6.4 limits the feed to depth
 * ≤ 1 — the viewer's direct relationships only, not friends-of-
 * friends. Reasons:
 *   - Latency: 2-hop fan-out can be O(N²) for well-connected viewers
 *   - Signal-to-noise: a 2-hop reviewer is meaningful in *resolve*
 *     queries (where they'd boost a subject score) but is too distant
 *     for a pull-feed surface
 *   - Plan-pinned semantic: the surface is named "networkFeed" but
 *     mobile renders it as "your reviewers' recent reviews"
 *
 * **Excludes the viewer's own attestations**. The feed shows what
 * OTHER reviewers in the network are saying, not the viewer's own
 * activity. The viewer can see their own attestations via the
 * existing `getAttestations(authorDid=...)` endpoint.
 *
 * **Cursor pagination via (recordCreatedAt, uri)**. Same shape as
 * `get-attestations.ts` for consistency. `uri` is unique within
 * a single created-at timestamp, so the composite ordering is
 * total + stable.
 *
 * **Soft-deleted (revoked) attestations excluded**. Attestation
 * lifecycle: a row may be revoked by its author or by an admin;
 * `is_revoked = true` filters those out. The mobile feed should
 * never surface a revoked review (the author retracted it).
 *
 * **Empty network → empty feed**. If the viewer has no 1-hop
 * relationships (new account, no attestations published yet), the
 * 1-hop set is empty and the response is `{ attestations: [] }`.
 * Specifically NOT a 404 — the endpoint always succeeds; the
 * client renders an "empty feed, find people to follow" UX.
 */

export const NetworkFeedParams = z.object({
  viewerDid: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^did:[a-z]+:/, 'must be a DID'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
})

export type NetworkFeedParamsType = z.infer<typeof NetworkFeedParams>

export interface NetworkFeedResponse {
  /** Attestation rows ordered by recordCreatedAt DESC, uri DESC. */
  attestations: unknown[]
  cursor?: string
}

/**
 * Parse a `${ISO}::${uri}` cursor. Returns null when malformed.
 * Same shape as `get-attestations.ts:25-39` for consistency.
 */
function parseCursor(raw: string): { ts: Date; uri: string } | null {
  const sepIdx = raw.indexOf('::')
  if (sepIdx <= 0 || sepIdx >= raw.length - 2) return null
  const ts = new Date(raw.slice(0, sepIdx))
  if (Number.isNaN(ts.getTime())) return null
  return { ts, uri: raw.slice(sepIdx + 2) }
}

export async function networkFeed(
  db: DrizzleDB,
  params: NetworkFeedParamsType,
): Promise<NetworkFeedResponse> {
  // Phase 1 — compute the viewer's 1-hop trust graph. Depth=1 only;
  // we don't need the full graph for the feed surface and a deeper
  // traversal would inflate latency for highly-connected viewers.
  const graph = await getCachedGraphContext(db, params.viewerDid, 1)
  const oneHopDids = graph.nodes
    .filter((n) => n.depth === 1)
    .map((n) => n.did)

  // Empty network: short-circuit BEFORE the attestations query.
  // Otherwise the SQL would be `WHERE author_did IN ()` which pg
  // rejects (and Drizzle's `inArray([])` emits `1=0`, yielding the
  // same empty result but at the cost of a network round-trip).
  if (oneHopDids.length === 0) {
    return { attestations: [] }
  }

  // Phase 2 — query attestations authored by the 1-hop set.
  const conditions: SQL[] = [
    inArray(attestations.authorDid, oneHopDids),
    eq(attestations.isRevoked, false),
  ]

  if (params.cursor) {
    const parsed = parseCursor(params.cursor)
    if (parsed === null) {
      throw Object.assign(new Error('Invalid cursor format'), {
        name: 'ZodError',
        message: 'Invalid cursor format',
      })
    }
    conditions.push(
      or(
        lt(attestations.recordCreatedAt, parsed.ts),
        and(
          eq(attestations.recordCreatedAt, parsed.ts),
          lt(attestations.uri, parsed.uri),
        ),
      )!,
    )
  }

  // Left-join `did_profiles` so the author's display handle rides
  // along on each row — mobile feed cards prefer the resolved handle
  // (e.g. `alice.pds.dinakernel.com`) over the raw DID. Left join
  // (not inner) so authors without a `did_profiles` row yet still
  // appear in the feed; their handle just lands as null.
  const rows = await db
    .select({
      attestation: attestations,
      handle: didProfiles.handle,
    })
    .from(attestations)
    .leftJoin(didProfiles, eq(attestations.authorDid, didProfiles.did))
    .where(and(...conditions))
    .orderBy(desc(attestations.recordCreatedAt), desc(attestations.uri))
    .limit(params.limit + 1)

  const hasMore = rows.length > params.limit
  const page = hasMore ? rows.slice(0, params.limit) : rows
  // Surface `authorHandle` as a flat field on each attestation row so
  // clients consuming the feed don't need to know about the join
  // structure. `'' → null` mapping centralised in `normalizeHandle`.
  const flat = page.map((r) => ({
    ...r.attestation,
    authorHandle: normalizeHandle(r.handle),
  }))
  const last = page[page.length - 1]?.attestation

  return {
    attestations: flat,
    cursor:
      hasMore && last
        ? `${last.recordCreatedAt.toISOString()}::${last.uri}`
        : undefined,
  }
}
