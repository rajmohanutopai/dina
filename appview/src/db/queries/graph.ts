import { sql, eq, and } from 'drizzle-orm'
import type { DrizzleDB } from '@/db/connection.js'
import { trustEdges, didProfiles } from '@/db/schema/index.js'
import { CONSTANTS } from '@/config/constants.js'
import { logger } from '@/shared/utils/logger.js'
import type { GetGraphResponse, GraphNode as ApiGraphNode, GraphEdge as ApiGraphEdge } from '@/shared/types/api-types.js'

/**
 * Graph queries with timeout protection (Fix 3, Fix 4).
 *
 * All graph traversals run inside a transaction with SET LOCAL statement_timeout
 * so a single expensive BFS/DFS cannot block the connection pool.
 */

/** A node in the trust graph */
export interface GraphNode {
  did: string
  trustScore: number | null
  depth: number
}

/** An edge in the trust graph */
export interface GraphEdge {
  fromDid: string
  toDid: string
  edgeType: string
  domain: string | null
  weight: number
}

/** Full graph context around a DID */
export interface GraphContext {
  nodes: GraphNode[]
  edges: GraphEdge[]
  rootDid: string
  depth: number
}

/**
 * Wrap a query function in a transaction with a statement timeout.
 * If the query exceeds the timeout, PostgreSQL cancels it (error code 57014)
 * and the fallback value is returned.
 */
export async function withGraphTimeout<T>(
  db: DrizzleDB,
  fn: (tx: DrizzleDB) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = '${CONSTANTS.GRAPH_QUERY_TIMEOUT_MS}ms'`)
      )
      return await fn(tx as unknown as DrizzleDB)
    })
  } catch (err: any) {
    // PostgreSQL error code 57014 = query_canceled (statement timeout)
    if (err?.code === '57014') {
      logger.warn('[Graph] Query timed out, returning fallback')
      return fallback
    }
    throw err
  }
}

/**
 * Compute the trust graph context around a DID using breadth-first traversal.
 * Respects MAX_EDGES_PER_HOP to prevent fan-out explosion (Fix 3).
 */
export async function computeGraphContext(
  db: DrizzleDB,
  rootDid: string,
  maxDepth: number = CONSTANTS.MAX_GRAPH_DEPTH,
): Promise<GraphContext> {
  return withGraphTimeout(
    db,
    async (tx) => {
      const nodes: GraphNode[] = []
      const edges: GraphEdge[] = []
      const visited = new Set<string>()
      let frontier = [rootDid]

      // Add root node
      const rootProfile = await tx
        .select({ trustScore: didProfiles.overallTrustScore })
        .from(didProfiles)
        .where(eq(didProfiles.did, rootDid))
        .limit(1)

      nodes.push({
        did: rootDid,
        trustScore: rootProfile[0]?.trustScore ?? null,
        depth: 0,
      })
      visited.add(rootDid)

      for (let depth = 1; depth <= maxDepth; depth++) {
        if (frontier.length === 0) break

        const nextFrontier: string[] = []

        for (const did of frontier) {
          // Outgoing edges with fan-out limit (Fix 3)
          const outgoing = await tx
            .select({
              fromDid: trustEdges.fromDid,
              toDid: trustEdges.toDid,
              edgeType: trustEdges.edgeType,
              domain: trustEdges.domain,
              weight: trustEdges.weight,
            })
            .from(trustEdges)
            .where(eq(trustEdges.fromDid, did))
            .limit(CONSTANTS.MAX_EDGES_PER_HOP)

          for (const edge of outgoing) {
            edges.push(edge)

            if (!visited.has(edge.toDid)) {
              visited.add(edge.toDid)
              nextFrontier.push(edge.toDid)

              // Fetch trust score for newly discovered node
              const profile = await tx
                .select({ trustScore: didProfiles.overallTrustScore })
                .from(didProfiles)
                .where(eq(didProfiles.did, edge.toDid))
                .limit(1)

              nodes.push({
                did: edge.toDid,
                trustScore: profile[0]?.trustScore ?? null,
                depth,
              })
            }
          }

          // Incoming edges with fan-out limit
          const incoming = await tx
            .select({
              fromDid: trustEdges.fromDid,
              toDid: trustEdges.toDid,
              edgeType: trustEdges.edgeType,
              domain: trustEdges.domain,
              weight: trustEdges.weight,
            })
            .from(trustEdges)
            .where(eq(trustEdges.toDid, did))
            .limit(CONSTANTS.MAX_EDGES_PER_HOP)

          for (const edge of incoming) {
            edges.push(edge)

            if (!visited.has(edge.fromDid)) {
              visited.add(edge.fromDid)
              nextFrontier.push(edge.fromDid)

              const profile = await tx
                .select({ trustScore: didProfiles.overallTrustScore })
                .from(didProfiles)
                .where(eq(didProfiles.did, edge.fromDid))
                .limit(1)

              nodes.push({
                did: edge.fromDid,
                trustScore: profile[0]?.trustScore ?? null,
                depth,
              })
            }
          }
        }

        frontier = nextFrontier

        // Safety cap: stop if we've accumulated too many nodes
        if (nodes.length >= CONSTANTS.MAX_GRAPH_NODES_RESPONSE) {
          logger.warn(`[Graph] Hit node cap (${CONSTANTS.MAX_GRAPH_NODES_RESPONSE}) at depth ${depth}`)
          break
        }
      }

      return { nodes, edges, rootDid, depth: maxDepth }
    },
    // Fallback on timeout: return minimal graph with just the root
    { nodes: [{ did: rootDid, trustScore: null, depth: 0 }], edges: [], rootDid, depth: 0 },
  )
}

/**
 * Get the trust graph around a DID, transformed to the API response format.
 * Delegates to computeGraphContext for BFS traversal, then maps internal
 * types (fromDid/toDid/edgeType) to API types (from/to/type).
 */
export async function getGraphAroundDid(
  db: DrizzleDB,
  did: string,
  maxDepth: number = 1,
  domain?: string,
): Promise<GetGraphResponse> {
  const context = await computeGraphContext(db, did, maxDepth)

  // Filter edges by domain if provided
  const filteredEdges = domain
    ? context.edges.filter(e => e.domain === domain)
    : context.edges

  // Transform internal types to API types
  const nodes: ApiGraphNode[] = context.nodes.map(n => ({
    did: n.did,
    depth: n.depth,
  }))

  const edges: ApiGraphEdge[] = filteredEdges.map(e => ({
    from: e.fromDid,
    to: e.toDid,
    type: e.edgeType,
    weight: e.weight,
  }))

  return { nodes, edges }
}
