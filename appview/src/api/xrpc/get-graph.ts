import { z } from 'zod'
import type { DrizzleDB } from '@/db/connection.js'
import { getGraphAroundDid } from '@/db/queries/graph.js'
import { withSWR, CACHE_TTLS } from '../middleware/swr-cache.js'
import type { GetGraphResponse } from '@/shared/types/api-types.js'

export const GetGraphParams = z.object({
  did: z.string().min(8).max(2048).regex(/^did:[a-z]+:/),
  maxDepth: z.coerce.number().min(1).max(2).default(2),
  domain: z.string().max(253).regex(/^[a-z0-9.-]+$/i).optional(),
})

export type GetGraphParamsType = z.infer<typeof GetGraphParams>

// XR2: Wrapped in SWR cache (30s TTL). Graph BFS is the most expensive
// query — up to 500 nodes, 100 DB queries per request. Without caching,
// an attacker at 60 RPM can force 6,000 DB queries/minute.
export async function getGraph(
  db: DrizzleDB,
  params: GetGraphParamsType,
): Promise<GetGraphResponse> {
  const cacheKey = `graph:${params.did}:${params.maxDepth}:${params.domain ?? ''}`

  return withSWR(cacheKey, CACHE_TTLS.GET_GRAPH, async () => {
    return getGraphAroundDid(db, params.did, params.maxDepth, params.domain)
  })
}
