import { eq } from 'drizzle-orm'
import type { HandlerContext } from './handlers/index.js'
import { trustEdges } from '@/db/schema/index.js'

/**
 * Trust edge maintenance.
 *
 * Trust edges form the backbone of the reputation graph. They are created
 * when vouches, endorsements, delegations, co-signatures, or positive
 * attestations are indexed, and removed when the source record is deleted.
 */

export interface TrustEdgeParams {
  fromDid: string
  toDid: string
  edgeType: string
  domain: string | null
  weight: number
  sourceUri: string
  createdAt: Date
}

/**
 * Add a trust edge to the graph.
 * Uses ON CONFLICT DO NOTHING since the source_uri is unique —
 * re-processing the same record is idempotent.
 */
export async function addTrustEdge(
  ctx: HandlerContext,
  params: TrustEdgeParams,
): Promise<void> {
  await ctx.db.insert(trustEdges).values({
    fromDid: params.fromDid,
    toDid: params.toDid,
    edgeType: params.edgeType,
    domain: params.domain,
    weight: params.weight,
    sourceUri: params.sourceUri,
    createdAt: params.createdAt,
  }).onConflictDoNothing()
}

/**
 * Remove a trust edge by its source URI.
 * Called when the source record (vouch, endorsement, etc.) is deleted.
 */
export async function removeTrustEdge(
  ctx: HandlerContext,
  sourceUri: string,
): Promise<void> {
  await ctx.db.delete(trustEdges).where(eq(trustEdges.sourceUri, sourceUri))
}
