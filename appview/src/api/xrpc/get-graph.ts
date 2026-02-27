import { z } from 'zod'
import type { DrizzleDB } from '@/db/connection.js'
import { getGraphAroundDid } from '@/db/queries/graph.js'
import type { GetGraphResponse } from '@/shared/types/api-types.js'

export const GetGraphParams = z.object({
  did: z.string().min(8).max(2048).regex(/^did:[a-z]+:/),
  maxDepth: z.coerce.number().min(1).max(2).default(2),
  domain: z.string().max(253).optional(),
})

export type GetGraphParamsType = z.infer<typeof GetGraphParams>

export async function getGraph(
  db: DrizzleDB,
  params: GetGraphParamsType,
): Promise<GetGraphResponse> {
  return getGraphAroundDid(db, params.did, params.maxDepth, params.domain)
}
