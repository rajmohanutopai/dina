import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
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

  const results = await db.select()
    .from(attestations)
    .where(and(...conditions))
    .orderBy(desc(attestations.recordCreatedAt))
    .limit(params.limit + 1)

  const hasMore = results.length > params.limit
  const page = hasMore ? results.slice(0, params.limit) : results

  return {
    attestations: page,
    cursor: hasMore ? page[page.length - 1].recordCreatedAt.toISOString() : undefined,
  }
}
