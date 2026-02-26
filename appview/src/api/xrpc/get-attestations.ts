import { z } from 'zod'
import { eq, and, desc, lt, or } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { attestations } from '@/db/schema/index.js'

export const GetAttestationsParams = z.object({
  subjectId: z.string().optional(),
  authorDid: z.string().optional(),
  limit: z.coerce.number().min(1).max(100).default(25),
  cursor: z.string().optional(),
})

export type GetAttestationsParamsType = z.infer<typeof GetAttestationsParams>

export async function getAttestations(
  db: DrizzleDB,
  params: GetAttestationsParamsType,
) {
  const conditions: any[] = [eq(attestations.isRevoked, false)]

  if (params.subjectId) conditions.push(eq(attestations.subjectId, params.subjectId))
  if (params.authorDid) conditions.push(eq(attestations.authorDid, params.authorDid))

  // MEDIUM-04: Apply cursor filtering (composite timestamp::uri)
  if (params.cursor) {
    const sepIdx = params.cursor.indexOf('::')
    if (sepIdx > 0) {
      const cursorTs = new Date(params.cursor.slice(0, sepIdx))
      const cursorUri = params.cursor.slice(sepIdx + 2)
      conditions.push(or(
        lt(attestations.recordCreatedAt, cursorTs),
        and(eq(attestations.recordCreatedAt, cursorTs), lt(attestations.uri, cursorUri)),
      ))
    } else {
      // Legacy cursor: timestamp-only
      conditions.push(lt(attestations.recordCreatedAt, new Date(params.cursor)))
    }
  }

  const results = await db.select()
    .from(attestations)
    .where(and(...conditions))
    .orderBy(desc(attestations.recordCreatedAt), desc(attestations.uri))
    .limit(params.limit + 1)

  const hasMore = results.length > params.limit
  const page = hasMore ? results.slice(0, params.limit) : results
  const lastRow = page[page.length - 1]

  return {
    attestations: page,
    cursor: hasMore && lastRow
      ? `${lastRow.recordCreatedAt.toISOString()}::${lastRow.uri}`
      : undefined,
  }
}
