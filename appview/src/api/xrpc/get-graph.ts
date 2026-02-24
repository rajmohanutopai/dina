import { z } from 'zod'
import type { DrizzleDB } from '@/db/connection.js'
import { getGraphAroundDid } from '@/db/queries/graph.js'
import type { GetGraphResponse } from '@/shared/types/api-types.js'

export const GetGraphParams = z.object({
  did: z.string(),
  maxDepth: z.coerce.number().min(1).max(2).default(2),
  domain: z.string().optional(),
})

export type GetGraphParamsType = z.infer<typeof GetGraphParams>

export async function getGraph(
  db: DrizzleDB,
  params: GetGraphParamsType,
): Promise<GetGraphResponse> {
  return getGraphAroundDid(db, params.did, params.maxDepth, params.domain)
}
