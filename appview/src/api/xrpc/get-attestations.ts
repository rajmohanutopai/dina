import { z } from 'zod'
import { eq, and, desc, isNull, lt, or } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { attestations, didProfiles, didRedactions } from '@/db/schema/index.js'
import { normalizeHandle } from '@/util/handle_normalize.js'
import { encodeCursor, decodeCursor } from '@/util/cursor.js'

/** Payload shape for this endpoint's cursor (recordCreatedAt DESC, uri DESC). */
const GetAttestationsCursor = z.object({
  ts: z.string().datetime(),
  uri: z.string(),
})

export const GetAttestationsParams = z.object({
  subjectId: z.string().max(256).optional(),
  authorDid: z.string().max(2048).regex(/^did:[a-z]+:/).optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  cursor: z.string().max(500).optional(),
})

export type GetAttestationsParamsType = z.infer<typeof GetAttestationsParams>

export async function getAttestations(
  db: DrizzleDB,
  params: GetAttestationsParamsType,
) {
  // The `isNull(didRedactions.did)` filter pairs with the LEFT JOIN
  // below: any attestation whose author has a `did_redactions` row
  // drops out of the result set entirely (mirrors service-search's
  // GDPR-shaped operator exclusion).
  const conditions: any[] = [
    eq(attestations.isRevoked, false),
    isNull(didRedactions.did),
  ]

  if (params.subjectId) conditions.push(eq(attestations.subjectId, params.subjectId))
  if (params.authorDid) conditions.push(eq(attestations.authorDid, params.authorDid))

  // Opaque base64url cursor `{v, ts, uri}`. decodeCursor throws
  // InvalidCursorError (→ 400) on any input that isn't a current-
  // version envelope wrapping a valid payload.
  if (params.cursor) {
    const { ts, uri: cursorUri } = decodeCursor(params.cursor, GetAttestationsCursor)
    const cursorTs = new Date(ts)
    conditions.push(or(
      lt(attestations.recordCreatedAt, cursorTs),
      and(eq(attestations.recordCreatedAt, cursorTs), lt(attestations.uri, cursorUri)),
    ))
  }

  // Left-join `did_profiles` so each attestation row carries the
  // author's display handle. Same shape as networkFeed/search for
  // consistency. Left join (not inner) so authors without a
  // profile row still appear; their handle just lands as null.
  const results = await db.select({
      attestation: attestations,
      handle: didProfiles.handle,
    })
    .from(attestations)
    .leftJoin(didProfiles, eq(attestations.authorDid, didProfiles.did))
    // GDPR-shaped author exclusion — see `conditions` above.
    .leftJoin(didRedactions, eq(attestations.authorDid, didRedactions.did))
    .where(and(...conditions))
    .orderBy(desc(attestations.recordCreatedAt), desc(attestations.uri))
    .limit(params.limit + 1)

  const hasMore = results.length > params.limit
  const page = hasMore ? results.slice(0, params.limit) : results
  // Flatten join shape; same convention as networkFeed/search.
  const flat = page.map((r) => ({
    ...r.attestation,
    authorHandle: normalizeHandle(r.handle),
  }))
  const lastRow = page[page.length - 1]?.attestation

  return {
    attestations: flat,
    cursor: hasMore && lastRow
      ? encodeCursor({ ts: lastRow.recordCreatedAt.toISOString(), uri: lastRow.uri })
      : undefined,
  }
}
