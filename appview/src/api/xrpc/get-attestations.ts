import { z } from 'zod'
import { eq, and, desc, lt, or } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { attestations, didProfiles } from '@/db/schema/index.js'
import { normalizeHandle } from '@/util/handle_normalize.js'

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
  const conditions: any[] = [eq(attestations.isRevoked, false)]

  if (params.subjectId) conditions.push(eq(attestations.subjectId, params.subjectId))
  if (params.authorDid) conditions.push(eq(attestations.authorDid, params.authorDid))

  // MED-04: Apply cursor filtering with date validation
  if (params.cursor) {
    const sepIdx = params.cursor.indexOf('::')
    if (sepIdx > 0) {
      const cursorTs = new Date(params.cursor.slice(0, sepIdx))
      if (isNaN(cursorTs.getTime())) throw Object.assign(new Error('Invalid cursor format'), { name: 'ZodError', message: 'Invalid cursor date' })
      const cursorUri = params.cursor.slice(sepIdx + 2)
      conditions.push(or(
        lt(attestations.recordCreatedAt, cursorTs),
        and(eq(attestations.recordCreatedAt, cursorTs), lt(attestations.uri, cursorUri)),
      ))
    } else {
      const cursorDate = new Date(params.cursor)
      if (isNaN(cursorDate.getTime())) throw Object.assign(new Error('Invalid cursor format'), { name: 'ZodError', message: 'Invalid cursor date' })
      conditions.push(lt(attestations.recordCreatedAt, cursorDate))
    }
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
      ? `${lastRow.recordCreatedAt.toISOString()}::${lastRow.uri}`
      : undefined,
  }
}
