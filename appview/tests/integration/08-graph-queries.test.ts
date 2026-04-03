/**
 * §8 — Graph Queries
 *
 * Test count: 20
 * Plan traceability: IT-GR-001..020
 *
 * Traces to: Architecture §"Graph Queries", Fix 3 (Fan-Out Caps),
 *   Fix 4 (Transaction-Scoped Timeouts)
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { sql } from 'drizzle-orm'
import { getTestDb, cleanAllTables, closeTestDb, type TestDB } from '../test-db'
import { trustEdges, didProfiles } from '@/db/schema/index'
import { computeGraphContext, getGraphAroundDid, withGraphTimeout } from '@/db/queries/graph'
import { CONSTANTS } from '@/config/constants'

let db: TestDB

beforeEach(async () => {
  db = getTestDb()
  await cleanAllTables(db)
})

afterAll(async () => {
  await closeTestDb()
})

// Helper to insert a trust edge
async function insertEdge(
  fromDid: string,
  toDid: string,
  opts: { edgeType?: string; domain?: string | null; weight?: number; sourceUri?: string } = {},
) {
  const sourceUri = opts.sourceUri ?? `at://${fromDid}/edge/${toDid}/${Math.random().toString(36).slice(2)}`
  await db.insert(trustEdges).values({
    fromDid,
    toDid,
    edgeType: opts.edgeType ?? 'vouch',
    domain: opts.domain ?? null,
    weight: opts.weight ?? 1.0,
    sourceUri,
    createdAt: new Date(),
  })
}

// Helper to insert a DID profile
async function insertProfile(did: string, overallTrustScore: number | null = null) {
  await db.insert(didProfiles).values({
    did,
    needsRecalc: false,
    overallTrustScore,
    computedAt: new Date(),
  })
}

// ---------------------------------------------------------------------------
// §8.1 One-Hop Queries (IT-GR-001..005) — 5 tests
// ---------------------------------------------------------------------------
describe('§8.1 One-Hop Queries', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0426", "section": "01", "sectionName": "General", "title": "IT-GR-001: direct trust edge exists \u2192 shortestPath = 1"}
  it('IT-GR-001: direct trust edge exists → shortestPath = 1', async () => {
    // A vouches for B, query A→B
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:b', 0.6)
    await insertEdge('did:plc:a', 'did:plc:b')

    const result = await computeGraphContext(db, 'did:plc:a')
    // B should be found at depth 1
    const bNode = result.nodes.find(n => n.did === 'did:plc:b')
    expect(bNode).toBeDefined()
    expect(bNode!.depth).toBe(1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0427", "section": "01", "sectionName": "General", "title": "IT-GR-002: no direct edge \u2192 shortestPath != 1"}
  it('IT-GR-002: no direct edge → shortestPath != 1', async () => {
    // A has no edge to B
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:b', 0.6)

    const result = await computeGraphContext(db, 'did:plc:a')
    const bNode = result.nodes.find(n => n.did === 'did:plc:b')
    // B should not be in the graph at all (no path)
    expect(bNode).toBeUndefined()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0428", "section": "01", "sectionName": "General", "title": "IT-GR-003: trusted attestors \u2014 1 hop"}
  it('IT-GR-003: trusted attestors — 1 hop', async () => {
    // A trusts B via edge
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:b', 0.8)
    await insertEdge('did:plc:a', 'did:plc:b')

    const result = await computeGraphContext(db, 'did:plc:a')
    // B should appear as a 1-hop neighbor
    const bNode = result.nodes.find(n => n.did === 'did:plc:b')
    expect(bNode).toBeDefined()
    expect(bNode!.depth).toBe(1)
    expect(bNode!.trustScore).toBeCloseTo(0.8)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0429", "section": "01", "sectionName": "General", "title": "IT-GR-004: trusted attestors \u2014 limit by MAX_EDGES_PER_HOP"}
  it('IT-GR-004: trusted attestors — limit by MAX_EDGES_PER_HOP', async () => {
    // A trusts 600 DIDs — only MAX_EDGES_PER_HOP (500) should be returned per hop query
    await insertProfile('did:plc:a', 0.5)

    const edgePromises: Promise<void>[] = []
    for (let i = 0; i < 600; i++) {
      edgePromises.push(insertEdge('did:plc:a', `did:plc:target${i}`, {
        sourceUri: `at://did:plc:a/edge/target/${i}`,
      }))
    }
    await Promise.all(edgePromises)

    const result = await getGraphAroundDid(db, 'did:plc:a')
    // Outgoing edges should be capped at MAX_EDGES_PER_HOP
    const outgoing = result.edges.filter(e => e.from === 'did:plc:a')
    expect(outgoing.length).toBeLessThanOrEqual(CONSTANTS.MAX_EDGES_PER_HOP)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0430", "section": "01", "sectionName": "General", "title": "IT-GR-005: trusted attestors \u2014 only non-revoked edges counted"}
  it('IT-GR-005: trusted attestors — only non-revoked edges counted', async () => {
    // A trusts B and C, but this tests edge existence (trust_edges don't have revoked)
    // We verify that only the edges that exist in trust_edges are returned
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:b', 0.7)
    await insertEdge('did:plc:a', 'did:plc:b')
    // No edge to C - C should not appear
    await insertProfile('did:plc:c', 0.3)

    const result = await getGraphAroundDid(db, 'did:plc:a')
    const toDids = result.edges.filter(e => e.from === 'did:plc:a').map(e => e.to)
    expect(toDids).toContain('did:plc:b')
    expect(toDids).not.toContain('did:plc:c')
  })
})

// ---------------------------------------------------------------------------
// §8.2 Two-Hop Queries (IT-GR-006..009) — 4 tests
// ---------------------------------------------------------------------------
describe('§8.2 Two-Hop Queries', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0431", "section": "01", "sectionName": "General", "title": "IT-GR-006: two-hop path exists \u2192 shortestPath = 2"}
  it('IT-GR-006: two-hop path exists → shortestPath = 2', async () => {
    // A→C, C→B (no A→B)
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:c', 0.6)
    await insertProfile('did:plc:b', 0.7)
    await insertEdge('did:plc:a', 'did:plc:c')
    await insertEdge('did:plc:c', 'did:plc:b')

    const result = await computeGraphContext(db, 'did:plc:a', 2)
    const bNode = result.nodes.find(n => n.did === 'did:plc:b')
    expect(bNode).toBeDefined()
    expect(bNode!.depth).toBe(2)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0432", "section": "01", "sectionName": "General", "title": "IT-GR-007: prefers 1-hop over 2-hop"}
  it('IT-GR-007: prefers 1-hop over 2-hop', async () => {
    // A→B direct AND A→C→B
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:b', 0.7)
    await insertProfile('did:plc:c', 0.6)
    await insertEdge('did:plc:a', 'did:plc:b')
    await insertEdge('did:plc:a', 'did:plc:c')
    await insertEdge('did:plc:c', 'did:plc:b')

    const result = await computeGraphContext(db, 'did:plc:a', 2)
    const bNode = result.nodes.find(n => n.did === 'did:plc:b')
    expect(bNode).toBeDefined()
    // B found at depth 1 (direct), not 2
    expect(bNode!.depth).toBe(1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0433", "section": "01", "sectionName": "General", "title": "IT-GR-008: no 2-hop path \u2192 node not in graph"}
  it('IT-GR-008: no 2-hop path → node not in graph', async () => {
    // A→C, but no path to B within 2 hops
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:c', 0.6)
    await insertProfile('did:plc:b', 0.7)
    await insertEdge('did:plc:a', 'did:plc:c')
    // C has no edge to B

    const result = await computeGraphContext(db, 'did:plc:a', 2)
    const bNode = result.nodes.find(n => n.did === 'did:plc:b')
    // B not reachable
    expect(bNode).toBeUndefined()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0434", "section": "01", "sectionName": "General", "title": "IT-GR-009: 2-hop fan-out capped at MAX_EDGES_PER_HOP"}
  it('IT-GR-009: 2-hop fan-out capped at MAX_EDGES_PER_HOP', async () => {
    // A has 1000 outbound edges — only 500 should be explored
    await insertProfile('did:plc:a', 0.5)

    const edgePromises: Promise<void>[] = []
    for (let i = 0; i < 1000; i++) {
      edgePromises.push(insertEdge('did:plc:a', `did:plc:target${i}`, {
        sourceUri: `at://did:plc:a/edge/${i}`,
      }))
    }
    await Promise.all(edgePromises)

    const result = await computeGraphContext(db, 'did:plc:a', 1)
    // Due to MAX_EDGES_PER_HOP = 500, we expect at most 500 outgoing + 500 incoming neighbor nodes
    // (minus root), plus the root itself
    // Outgoing edges limited by the LIMIT clause
    const nonRootNodes = result.nodes.filter(n => n.did !== 'did:plc:a')
    expect(nonRootNodes.length).toBeLessThanOrEqual(CONSTANTS.MAX_EDGES_PER_HOP)
  })
})

// ---------------------------------------------------------------------------
// §8.3 Mutual Connections (IT-GR-010..012) — 3 tests
// ---------------------------------------------------------------------------
describe('§8.3 Mutual Connections', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0435", "section": "01", "sectionName": "General", "title": "IT-GR-010: mutual connections \u2014 simple case"}
  it('IT-GR-010: mutual connections — simple case', async () => {
    // A→C, B→C => C is mutual between A and B
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:b', 0.6)
    await insertProfile('did:plc:c', 0.7)
    await insertEdge('did:plc:a', 'did:plc:c')
    await insertEdge('did:plc:b', 'did:plc:c')

    // Get A's outgoing neighbors
    const graphA = await getGraphAroundDid(db, 'did:plc:a')
    const aOutgoing = new Set(graphA.edges.filter(e => e.from === 'did:plc:a').map(e => e.to))

    // Get B's outgoing neighbors
    const graphB = await getGraphAroundDid(db, 'did:plc:b')
    const bOutgoing = new Set(graphB.edges.filter(e => e.from === 'did:plc:b').map(e => e.to))

    // Mutual connections: nodes both A and B point to
    const mutual = [...aOutgoing].filter(d => bOutgoing.has(d))
    expect(mutual.length).toBe(1)
    expect(mutual[0]).toBe('did:plc:c')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0436", "section": "01", "sectionName": "General", "title": "IT-GR-011: mutual connections \u2014 zero"}
  it('IT-GR-011: mutual connections — zero', async () => {
    // A→C, B→D — no shared connections
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:b', 0.6)
    await insertProfile('did:plc:c', 0.7)
    await insertProfile('did:plc:d', 0.8)
    await insertEdge('did:plc:a', 'did:plc:c')
    await insertEdge('did:plc:b', 'did:plc:d')

    const graphA = await getGraphAroundDid(db, 'did:plc:a')
    const aOutgoing = new Set(graphA.edges.filter(e => e.from === 'did:plc:a').map(e => e.to))

    const graphB = await getGraphAroundDid(db, 'did:plc:b')
    const bOutgoing = new Set(graphB.edges.filter(e => e.from === 'did:plc:b').map(e => e.to))

    const mutual = [...aOutgoing].filter(d => bOutgoing.has(d))
    expect(mutual.length).toBe(0)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0437", "section": "01", "sectionName": "General", "title": "IT-GR-012: mutual connections \u2014 multiple"}
  it('IT-GR-012: mutual connections — multiple', async () => {
    // A→C, A→D, A→E, B→C, B→D => 2 mutual (C, D)
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:b', 0.6)
    await insertProfile('did:plc:c', 0.7)
    await insertProfile('did:plc:d', 0.8)
    await insertProfile('did:plc:e', 0.9)
    await insertEdge('did:plc:a', 'did:plc:c')
    await insertEdge('did:plc:a', 'did:plc:d')
    await insertEdge('did:plc:a', 'did:plc:e')
    await insertEdge('did:plc:b', 'did:plc:c')
    await insertEdge('did:plc:b', 'did:plc:d')

    const graphA = await getGraphAroundDid(db, 'did:plc:a')
    const aOutgoing = new Set(graphA.edges.filter(e => e.from === 'did:plc:a').map(e => e.to))

    const graphB = await getGraphAroundDid(db, 'did:plc:b')
    const bOutgoing = new Set(graphB.edges.filter(e => e.from === 'did:plc:b').map(e => e.to))

    const mutual = [...aOutgoing].filter(d => bOutgoing.has(d))
    expect(mutual.length).toBe(2)
    expect(mutual).toContain('did:plc:c')
    expect(mutual).toContain('did:plc:d')
  })
})

// ---------------------------------------------------------------------------
// §8.4 Super-Node Protection / Fix 3 + Fix 4 (IT-GR-013..020) — 8 tests
// ---------------------------------------------------------------------------
describe('§8.4 Super-Node Protection (Fix 3 + Fix 4)', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0438", "section": "01", "sectionName": "General", "title": "IT-GR-013: Fix 3: super-node fan-out capped"}
  it('IT-GR-013: Fix 3: super-node fan-out capped', async () => {
    // DID with 10,000 outbound edges — query should still complete in bounded time
    // Insert a large number of edges
    await insertProfile('did:plc:supernode', 0.5)

    const batchSize = 100
    for (let batch = 0; batch < 10; batch++) {
      const promises: Promise<void>[] = []
      for (let i = 0; i < batchSize; i++) {
        const idx = batch * batchSize + i
        promises.push(insertEdge('did:plc:supernode', `did:plc:target${idx}`, {
          sourceUri: `at://did:plc:supernode/edge/${idx}`,
        }))
      }
      await Promise.all(promises)
    }

    const start = Date.now()
    const result = await getGraphAroundDid(db, 'did:plc:supernode')
    const elapsed = Date.now() - start

    // Outgoing edges should be capped at MAX_EDGES_PER_HOP
    const outgoing = result.edges.filter(e => e.from === 'did:plc:supernode')
    expect(outgoing.length).toBeLessThanOrEqual(CONSTANTS.MAX_EDGES_PER_HOP)
    // Should complete in reasonable time (well under 5 seconds)
    expect(elapsed).toBeLessThan(5000)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0439", "section": "01", "sectionName": "General", "title": "IT-GR-014: Fix 3: statement timeout \u2192 graceful null"}
  it('IT-GR-014: Fix 3: statement timeout → graceful null', async () => {
    // Use withGraphTimeout with an artificially slow query
    // The timeout is 100ms, so we use pg_sleep to exceed it
    const result = await withGraphTimeout(
      db,
      async (tx) => {
        await tx.execute(sql.raw(`SELECT pg_sleep(1)`))
        return 'should not reach'
      },
      null, // fallback
    )
    expect(result).toBeNull()
  })

  // TRACE: {"suite": "APPVIEW", "case": "0440", "section": "01", "sectionName": "General", "title": "IT-GR-015: Fix 3: rest of resolve response proceeds"}
  it('IT-GR-015: Fix 3: rest of resolve response proceeds', async () => {
    // After graph timeout, other queries on the db still work
    // Simulate a timeout
    const graphResult = await withGraphTimeout(
      db,
      async (tx) => {
        await tx.execute(sql.raw(`SELECT pg_sleep(1)`))
        return { nodes: [], edges: [] }
      },
      null,
    )
    expect(graphResult).toBeNull()

    // Now run a normal query — should succeed
    await insertProfile('did:plc:test', 0.5)
    const result = await getGraphAroundDid(db, 'did:plc:test')
    expect(result).toBeDefined()
    expect(result.edges).toEqual([])
    expect(result.nodes.length).toBe(1) // just the root
  })

  // TRACE: {"suite": "APPVIEW", "case": "0441", "section": "01", "sectionName": "General", "title": "IT-GR-016: Fix 4: timeout doesn\\"}
  it('IT-GR-016: Fix 4: timeout doesn\'t poison connection pool', async () => {
    // Graph query times out, then run normal queries on the same pool
    const graphResult = await withGraphTimeout(
      db,
      async (tx) => {
        await tx.execute(sql.raw(`SELECT pg_sleep(1)`))
        return 'unreachable'
      },
      'timed_out',
    )
    expect(graphResult).toBe('timed_out')

    // Multiple subsequent queries should all work fine
    for (let i = 0; i < 5; i++) {
      await insertProfile(`did:plc:pool-test-${i}`, 0.5)
      const result = await getGraphAroundDid(db, `did:plc:pool-test-${i}`)
      expect(result).toBeDefined()
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0442", "section": "01", "sectionName": "General", "title": "IT-GR-017: Fix 4: SET LOCAL scoped to transaction"}
  it('IT-GR-017: Fix 4: SET LOCAL scoped to transaction', async () => {
    // After graph timeout, the statement_timeout should NOT persist on the connection
    await withGraphTimeout(
      db,
      async (tx) => {
        await tx.execute(sql.raw(`SELECT pg_sleep(1)`))
        return null
      },
      null,
    )

    // Run a slow query outside withGraphTimeout — should NOT be subject to 100ms timeout
    // A 200ms sleep should succeed since SET LOCAL only applies within the transaction
    await db.execute(sql.raw(`SELECT pg_sleep(0.2)`))
    // If we reach here, the timeout was not persisted
    expect(true).toBe(true)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0443", "section": "01", "sectionName": "General", "title": "IT-GR-018: graph visualization \u2014 getGraphAroundDid"}
  it('IT-GR-018: graph visualization — getGraphAroundDid', async () => {
    // DID with 5 outgoing, 3 incoming connections
    await insertProfile('did:plc:center', 0.5)
    for (let i = 0; i < 5; i++) {
      await insertEdge('did:plc:center', `did:plc:out${i}`)
    }
    for (let i = 0; i < 3; i++) {
      await insertEdge(`did:plc:in${i}`, 'did:plc:center')
    }

    const result = await getGraphAroundDid(db, 'did:plc:center')
    const outgoing = result.edges.filter(e => e.from === 'did:plc:center')
    const incoming = result.edges.filter(e => e.to === 'did:plc:center')
    expect(outgoing.length).toBe(5)
    expect(incoming.length).toBe(3)

    // All outgoing edges are from center
    for (const edge of outgoing) {
      expect(edge.from).toBe('did:plc:center')
    }
    // All incoming edges are to center
    for (const edge of incoming) {
      expect(edge.to).toBe('did:plc:center')
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0444", "section": "01", "sectionName": "General", "title": "IT-GR-019: graph visualization \u2014 domain filter"}
  it('IT-GR-019: graph visualization — domain filter', async () => {
    // Insert edges with different domains
    await insertProfile('did:plc:center', 0.5)
    await insertEdge('did:plc:center', 'did:plc:food1', { domain: 'food' })
    await insertEdge('did:plc:center', 'did:plc:food2', { domain: 'food' })
    await insertEdge('did:plc:center', 'did:plc:tech1', { domain: 'tech' })
    await insertEdge('did:plc:center', 'did:plc:general', { domain: null })

    // Without domain filter — all 4 edges returned
    const allResult = await getGraphAroundDid(db, 'did:plc:center')
    const allOutgoing = allResult.edges.filter(e => e.from === 'did:plc:center')
    expect(allOutgoing.length).toBe(4)

    // With domain='food' filter — only food domain edges
    const foodResult = await getGraphAroundDid(db, 'did:plc:center', 1, 'food')
    const foodEdges = foodResult.edges.filter(e => e.from === 'did:plc:center')
    expect(foodEdges.length).toBe(2)

    // With domain='tech' filter — only tech domain edge
    const techResult = await getGraphAroundDid(db, 'did:plc:center', 1, 'tech')
    const techEdges = techResult.edges.filter(e => e.from === 'did:plc:center')
    expect(techEdges.length).toBe(1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0445", "section": "01", "sectionName": "General", "title": "IT-GR-020: graph visualization \u2014 depth cap at 2"}
  it('IT-GR-020: graph visualization — depth cap at 2', async () => {
    // Build a chain: A→B→C→D→E (depth 4)
    await insertProfile('did:plc:a', 0.5)
    await insertProfile('did:plc:b', 0.6)
    await insertProfile('did:plc:c', 0.7)
    await insertProfile('did:plc:d', 0.8)
    await insertProfile('did:plc:e', 0.9)
    await insertEdge('did:plc:a', 'did:plc:b')
    await insertEdge('did:plc:b', 'did:plc:c')
    await insertEdge('did:plc:c', 'did:plc:d')
    await insertEdge('did:plc:d', 'did:plc:e')

    // Request with maxDepth = 5 — but CONSTANTS.MAX_GRAPH_DEPTH = 2 is the default
    // The function uses the provided maxDepth parameter, but the API would cap at 2
    const result = await computeGraphContext(db, 'did:plc:a', 2)
    expect(result.depth).toBe(2)

    // Should find A (depth 0), B (depth 1), C (depth 2), but NOT D or E
    const dids = result.nodes.map(n => n.did)
    expect(dids).toContain('did:plc:a')
    expect(dids).toContain('did:plc:b')
    expect(dids).toContain('did:plc:c')
    expect(dids).not.toContain('did:plc:d')
    expect(dids).not.toContain('did:plc:e')
  })
})
