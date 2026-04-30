import { z } from 'zod'
import { inArray, desc } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { attestations, ingestRejections } from '@/db/schema/index.js'

/**
 * `com.dina.trust.attestationStatus` (TN-API-005 / Plan §3.5.1 + §6).
 *
 * Mobile outbox-watcher polling endpoint. The mobile client maintains
 * an "expected pending" set of AT-URIs it published to its local PDS;
 * if a URI doesn't appear in AppView within 60s, the watcher polls
 * this endpoint to find out whether it was rejected (surface failure
 * UX) or merely delayed (keep waiting).
 *
 * **Rate limit**: 600/IP/min (Plan §6) — outbox watcher polls every 5s
 * = 12/min idle, multiple pending records multiply that. The 600
 * ceiling gives 50× headroom for legitimate polling traffic. Tier
 * pinned in `api/middleware/rate-limit.ts` (TN-API-007).
 *
 * **Status taxonomy** for each requested URI:
 *   - `indexed`  — URI exists in `attestations` table (success)
 *   - `rejected` — URI exists in `ingest_rejections` (failure)
 *   - `pending`  — neither table has the URI (still in flight, or
 *                  client made a typo, or the record was deleted
 *                  before the firehose carried it; the watcher
 *                  treats `pending` as "wait")
 *
 * **`indexed` wins over `rejected`** when both exist. Why: a record
 * may be rejected once (e.g. transient signature_invalid during a
 * key rotation race) and then succeed on the retry. The latest state
 * is "indexed" and the watcher should report that. The DB query
 * checks `attestations` first; only URIs absent there are scanned in
 * `ingest_rejections`.
 *
 * **Why scoped to attestations** (not all 19 trust collections):
 * the endpoint is named `attestationStatus`. Plan §3.5.1 describes
 * the watcher pattern in terms of attestations; if other record
 * types (vouches, endorsements) need the same surface in V2, they
 * get their own status endpoints rather than overloading this one
 * with a `collection` parameter (which would push parsing the URI's
 * collection segment back to the client). One endpoint = one table;
 * cleaner to extend.
 *
 * **Batch input cap = 100 URIs**: matches the watcher's expected
 * pending-set size in production (mobile clients typically publish
 * a few records per session, not hundreds). Higher caps would let
 * a malicious client run a single 600-req/min attack as a 60k-URI/
 * min lookup → expensive `IN (...)` scans. 100 keeps each request
 * bounded to two index-keyed lookups against the `uri` PK.
 */

const URI_REGEX = /^at:\/\/[^\s]+$/

export const AttestationStatusParams = z.object({
  /**
   * AT-URIs to check. Comma-separated when serialized as a query
   * string (Zod's `transform` splits + dedupes); the dispatcher
   * passes it through `URLSearchParams.entries()` so this arrives
   * as a string the schema must split. Cap at 100 entries to
   * bound the per-request DB load.
   */
  uris: z
    .string()
    .min(1)
    .max(20_000)
    .transform((s) => {
      const parts = s.split(',').map((p) => p.trim()).filter(Boolean)
      return Array.from(new Set(parts))
    })
    .pipe(
      z.array(z.string().regex(URI_REGEX, 'invalid AT-URI'))
        .min(1, 'at least one URI required')
        .max(100, 'at most 100 URIs per request'),
    ),
})

export type AttestationStatusParamsType = z.infer<typeof AttestationStatusParams>

export type AttestationStatusEntry =
  | { uri: string; status: 'indexed' }
  | { uri: string; status: 'rejected'; reason: string; detail?: unknown; rejectedAt: string }
  | { uri: string; status: 'pending' }

export interface AttestationStatusResponse {
  statuses: AttestationStatusEntry[]
}

export async function attestationStatus(
  db: DrizzleDB,
  params: AttestationStatusParamsType,
): Promise<AttestationStatusResponse> {
  const { uris } = params

  // Phase 1 — find indexed URIs. PK lookup (`attestations.uri` is the
  // primary key), so this is `O(N)` index hits at worst.
  const indexedRows = await db
    .select({ uri: attestations.uri })
    .from(attestations)
    .where(inArray(attestations.uri, uris))
  const indexedSet = new Set(indexedRows.map((r) => r.uri))

  // Phase 2 — for URIs not yet indexed, find rejection rows. The same
  // URI may have multiple rejection rows (a record rejected on first
  // attempt, then retry-rejected differently); we surface the most
  // recent for that URI. A URI absent from both tables is `pending`.
  const unindexed = uris.filter((u) => !indexedSet.has(u))
  const rejectionByUri = new Map<
    string,
    { reason: string; detail: unknown; rejectedAt: Date }
  >()
  if (unindexed.length > 0) {
    const rejRows = await db
      .select({
        atUri: ingestRejections.atUri,
        reason: ingestRejections.reason,
        detail: ingestRejections.detail,
        rejectedAt: ingestRejections.rejectedAt,
      })
      .from(ingestRejections)
      .where(inArray(ingestRejections.atUri, unindexed))
      .orderBy(desc(ingestRejections.rejectedAt))
    for (const row of rejRows) {
      // First row per URI wins → since we ORDER BY rejected_at DESC,
      // that's the most recent rejection per URI.
      if (!rejectionByUri.has(row.atUri)) {
        rejectionByUri.set(row.atUri, {
          reason: row.reason,
          detail: row.detail,
          rejectedAt: row.rejectedAt,
        })
      }
    }
  }

  // Compose per-input response — preserves caller's URI order so
  // mobile can match its `expected pending` set positionally.
  const statuses: AttestationStatusEntry[] = uris.map((uri) => {
    if (indexedSet.has(uri)) return { uri, status: 'indexed' as const }
    const rej = rejectionByUri.get(uri)
    if (rej) {
      // Spread `detail` only when present — null/undefined detail
      // would JSON-serialise to a `"detail": null` key the client
      // shouldn't have to ignore. Cleaner wire shape.
      return {
        uri,
        status: 'rejected' as const,
        reason: rej.reason,
        rejectedAt: rej.rejectedAt.toISOString(),
        ...(rej.detail !== null && rej.detail !== undefined
          ? { detail: rej.detail }
          : {}),
      }
    }
    return { uri, status: 'pending' as const }
  })

  return { statuses }
}
