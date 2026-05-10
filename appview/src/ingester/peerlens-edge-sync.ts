import { eq } from 'drizzle-orm'
import type { HandlerContext } from './handlers/index.js'
import { peerlensEdges } from '@/db/schema/index.js'

/**
 * Trust edge maintenance.
 *
 * Trust edges form the backbone of PeerLens. They are created
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
 * Uses ON CONFLICT DO UPDATE so record updates propagate to trust edges.
 */
export async function addTrustEdge(
  ctx: HandlerContext,
  params: TrustEdgeParams,
): Promise<void> {
  // HIGH-10: Use onConflictDoUpdate so record updates propagate to trust edges
  await ctx.db.insert(peerlensEdges).values({
    fromDid: params.fromDid,
    toDid: params.toDid,
    edgeType: params.edgeType,
    domain: params.domain,
    weight: params.weight,
    sourceUri: params.sourceUri,
    createdAt: params.createdAt,
  }).onConflictDoUpdate({
    target: peerlensEdges.sourceUri,
    set: {
      toDid: params.toDid,
      edgeType: params.edgeType,
      domain: params.domain,
      weight: params.weight,
    },
  })
}

/**
 * Remove a trust edge by its source URI.
 * Called when the source record (vouch, endorsement, etc.) is deleted.
 */
export async function removeTrustEdge(
  ctx: HandlerContext,
  sourceUri: string,
): Promise<void> {
  await ctx.db.delete(peerlensEdges).where(eq(peerlensEdges.sourceUri, sourceUri))
}
