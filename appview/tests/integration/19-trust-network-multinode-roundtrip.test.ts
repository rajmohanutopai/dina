/**
 * TN-TEST-040 — Two-node publish → ingest → score → search round-trip.
 *
 * The trust-network V1 promise: any two Dina home nodes that publish
 * to the same shared AppView see each other's contributions converge
 * deterministically. Subject scores reflect every publisher's input;
 * search returns both authors' attestations on the same subject;
 * cross-publisher trust (vouches) ripples through the scorer.
 *
 * "Two nodes" in V1 is two distinct publisher DIDs writing into the
 * SAME AppView (centralised AppView per Plan §11 / threat-model §3).
 * The ingester handler path is the convergence point — it doesn't
 * matter which Jetstream relay the records arrive over, the handler
 * is identical. So this test simulates two publishers via the
 * `routeHandler` path (same shape as `17-end-to-end-flows.test.ts`),
 * differing only in their `authorDid` and the shape of the records
 * they create.
 *
 * Why this test exists alongside the existing IT-E2E-001..011 suite:
 * the existing tests fan one publisher's attestations into the
 * pipeline. The 2-node round-trip pins the *cross-publisher
 * convergence* invariant — that two independently-publishing nodes
 * produce a coherent view at AppView, not a per-publisher silo.
 *
 *   IT-E2E-001       ─── one publisher → score → query
 *   TN-TEST-040 ─── two publishers → score → both queryable
 *
 * Scenarios pinned (each maps to a specific failure mode the trust
 * network's value proposition collapses without):
 *
 *   1. **Convergent attestations on a shared subject**.
 *      Failure mode: subject scoring silently weighs only the latest
 *      publisher, ignoring earlier ones. Pin via aggregate count +
 *      both URIs returned.
 *
 *   2. **Cross-publisher search**.
 *      Failure mode: search returns only one publisher's authorship
 *      (a subject_id resolution bug or a filter that's accidentally
 *      author-scoped). Pin via category-filter search returning rows
 *      from both authors.
 *
 *   3. **Cross-node vouching → reviewer-trust propagation**.
 *      Failure mode: a vouch from node A for node B doesn't influence
 *      node B's reviewer profile (didProfiles row stays cold despite
 *      the inbound vouch edge). Pin via vouchCount on B's profile.
 *
 *   4. **Independent deletion**.
 *      Failure mode: when one publisher retracts, the other
 *      publisher's attestation accidentally goes with it (subject_id
 *      orphan-GC over-collects, or a cascade tombstone fires too
 *      wide). Pin via getAttestations after the delete: B's URI
 *      remains, A's is gone.
 *
 *   5. **Cross-author network-feed visibility**.
 *      Failure mode: the network-feed query includes the viewer's
 *      own DID (regressing on Plan §6.4 "excludes viewer's own").
 *      Pin via Alonso's feed showing Sancho's review but NOT
 *      Alonso's own.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'

import { cleanAllTables, closeTestDb, createTestHandlerContext, getTestDb } from '../test-db'
import { routeHandler } from '@/ingester/handlers/index'
import { refreshProfiles } from '@/scorer/jobs/refresh-profiles'
import { refreshSubjectScores } from '@/scorer/jobs/refresh-subject-scores'
import { resolve } from '@/api/xrpc/resolve'
import { search } from '@/api/xrpc/search'
import { getAttestations } from '@/api/xrpc/get-attestations'
import { networkFeed } from '@/api/xrpc/network-feed'
import { getProfile } from '@/api/xrpc/get-profile'
import { clearCache } from '@/api/middleware/swr-cache'

const db = getTestDb()
const ctx = createTestHandlerContext(db)

// Two-publisher fixtures named after the canonical Dina demo personas
// (Don Alonso + Sancho per CLAUDE.md "demo persona naming uses UTOPAI
// canon"). Subject is ChairMaker (the third-party reviewed by both).
const NODE_ALONSO = 'did:plc:alonso040roundtrip'
const NODE_SANCHO = 'did:plc:sancho040roundtrip'
const SUBJECT_CHAIRMAKER = 'did:plc:chairmaker040roundtrip'

beforeEach(async () => {
  await cleanAllTables(db)
  clearCache()
})

afterAll(async () => {
  await closeTestDb()
})

/**
 * Insert an attestation via the ingester handler. Same path Jetstream
 * exercises in production — pure data-shape simulation, no network
 * relay.
 */
async function publishAttestation(opts: {
  authorDid: string
  rkey: string
  subjectDid: string
  subjectName: string
  text: string
  sentiment?: 'positive' | 'neutral' | 'negative'
  category?: string
  domain?: string
  createdAtMs?: number
}) {
  const handler = routeHandler('com.dina.trust.attestation')!
  await handler.handleCreate(ctx, {
    uri: `at://${opts.authorDid}/com.dina.trust.attestation/${opts.rkey}`,
    did: opts.authorDid,
    collection: 'com.dina.trust.attestation',
    rkey: opts.rkey,
    cid: `cid-${opts.authorDid.slice(-8)}-${opts.rkey}`,
    record: {
      subject: { type: 'did', did: opts.subjectDid, name: opts.subjectName },
      category: opts.category ?? 'service',
      sentiment: opts.sentiment ?? 'positive',
      text: opts.text,
      domain: opts.domain,
      createdAt: new Date(opts.createdAtMs ?? Date.now()).toISOString(),
    },
  })
}

async function publishVouch(opts: {
  authorDid: string
  subjectDid: string
  rkey: string
  confidence?: 'low' | 'medium' | 'high'
}) {
  const handler = routeHandler('com.dina.trust.vouch')!
  await handler.handleCreate(ctx, {
    uri: `at://${opts.authorDid}/com.dina.trust.vouch/${opts.rkey}`,
    did: opts.authorDid,
    collection: 'com.dina.trust.vouch',
    rkey: opts.rkey,
    cid: `cid-vouch-${opts.authorDid.slice(-8)}-${opts.rkey}`,
    record: {
      subject: opts.subjectDid,
      vouchType: 'personal',
      confidence: opts.confidence ?? 'high',
      createdAt: new Date().toISOString(),
    },
  })
}

async function deleteAttestation(authorDid: string, rkey: string) {
  const handler = routeHandler('com.dina.trust.attestation')!
  await handler.handleDelete(ctx, {
    uri: `at://${authorDid}/com.dina.trust.attestation/${rkey}`,
    did: authorDid,
    collection: 'com.dina.trust.attestation',
    rkey,
  })
}

// ---------------------------------------------------------------------------
// Scenario 1 — Convergent attestations on a shared subject.
// ---------------------------------------------------------------------------
describe('TN-TEST-040 §1: convergent attestations on a shared subject', () => {
  it('two publishers → AppView aggregates → resolve sees both', async () => {
    // Publisher 1 — Don Alonso publishes a positive attestation.
    await publishAttestation({
      authorDid: NODE_ALONSO,
      rkey: 'alonso-att-1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Sturdy build, fast shipping',
      sentiment: 'positive',
    })

    // Publisher 2 — Sancho independently publishes on the same subject.
    await publishAttestation({
      authorDid: NODE_SANCHO,
      rkey: 'sancho-att-1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Honest seller, recommend',
      sentiment: 'positive',
    })

    // Sancho also files a neutral note (cross-publisher: same subject,
    // different sentiment — the aggregate must reflect every input).
    await publishAttestation({
      authorDid: NODE_SANCHO,
      rkey: 'sancho-att-2',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Communication was slower than usual',
      sentiment: 'neutral',
    })

    // Run the score pipeline — same jobs the production scorer cron
    // fires.
    await refreshSubjectScores(db)
    await refreshProfiles(db)

    // Resolve as either node would — the response is publisher-
    // independent (AppView is the convergence point).
    const subjectJson = JSON.stringify({ type: 'did', did: SUBJECT_CHAIRMAKER })
    const response = await resolve(db, { subject: subjectJson })

    expect(response).toBeDefined()
    expect(response.attestationSummary).toBeDefined()
    // Three attestations from two distinct publishers — the aggregate
    // must reflect every input. A regression that silos by publisher
    // would surface here as `total: 1` or `total: 2`.
    expect(response.attestationSummary?.total).toBe(3)
    expect(response.attestationSummary?.positive).toBe(2)
    expect(response.attestationSummary?.neutral).toBe(1)
  })

  it('getAttestations on the shared subject returns both publishers authorship', async () => {
    await publishAttestation({
      authorDid: NODE_ALONSO,
      rkey: 'alonso-att-1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Sturdy',
    })
    await publishAttestation({
      authorDid: NODE_SANCHO,
      rkey: 'sancho-att-1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Honest',
    })

    // Look up the canonical subject_id (the ingester resolves both
    // attestations to the same subject because they share `did`).
    const subjectRow = await db.execute(sql`
      SELECT id FROM subjects WHERE did = ${SUBJECT_CHAIRMAKER}
    `)
    const subjectId = (subjectRow as any).rows[0]?.id
    expect(subjectId).toBeDefined()

    const result = await getAttestations(db, { subjectId, limit: 25 })
    expect(result.attestations.length).toBe(2)

    const authorDids = new Set(result.attestations.map((a: any) => a.authorDid))
    expect(authorDids.has(NODE_ALONSO)).toBe(true)
    expect(authorDids.has(NODE_SANCHO)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Scenario 2 — Cross-publisher search.
// ---------------------------------------------------------------------------
describe('TN-TEST-040 §2: cross-publisher search', () => {
  it('category-filter search returns rows from both publishers', async () => {
    // Mixed corpus across two publishers + two subjects, but with
    // matching `category` so the search filter has to deliver every
    // matching row regardless of who authored it.
    await publishAttestation({
      authorDid: NODE_ALONSO,
      rkey: 'a1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Alonso review of ChairMaker',
      category: 'service',
      domain: 'furniture',
    })
    await publishAttestation({
      authorDid: NODE_SANCHO,
      rkey: 's1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Sancho review of ChairMaker',
      category: 'service',
      domain: 'furniture',
    })
    await publishAttestation({
      authorDid: NODE_SANCHO,
      rkey: 's2',
      subjectDid: 'did:plc:potter040',
      subjectName: 'Potter',
      text: 'Sancho review of Potter',
      category: 'service',
      domain: 'crafts',
    })

    const results = await search(db, {
      category: 'service',
      sort: 'recent',
      limit: 25,
    })
    expect(results.results.length).toBe(3)

    const authorDids = new Set(results.results.map((r: any) => r.authorDid))
    // Every author who published a `service` attestation must appear
    // in the result. A search regression that filters by viewer or
    // author-scopes the corpus would shrink this set.
    expect(authorDids.has(NODE_ALONSO)).toBe(true)
    expect(authorDids.has(NODE_SANCHO)).toBe(true)
  })

  it('domain filter narrows across publishers without dropping authors', async () => {
    await publishAttestation({
      authorDid: NODE_ALONSO,
      rkey: 'a1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Alonso furniture',
      domain: 'furniture',
    })
    await publishAttestation({
      authorDid: NODE_SANCHO,
      rkey: 's1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Sancho furniture',
      domain: 'furniture',
    })
    // Off-domain noise — must NOT appear in the furniture search.
    await publishAttestation({
      authorDid: NODE_ALONSO,
      rkey: 'a2',
      subjectDid: 'did:plc:somewhere040',
      subjectName: 'Off-domain',
      text: 'Alonso non-furniture',
      domain: 'food',
    })

    const results = await search(db, {
      domain: 'furniture',
      sort: 'recent',
      limit: 25,
    })
    expect(results.results.length).toBe(2)
    const authorDids = new Set(results.results.map((r: any) => r.authorDid))
    expect(authorDids.has(NODE_ALONSO)).toBe(true)
    expect(authorDids.has(NODE_SANCHO)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Scenario 3 — Cross-node vouching → reviewer-trust propagation.
// ---------------------------------------------------------------------------
describe('TN-TEST-040 §3: cross-node vouching → reviewer-trust propagation', () => {
  it('vouch from Alonso for Sancho lands in trust_edges + Sancho profile vouchCount', async () => {
    // Both nodes publish — establishes profile rows.
    await publishAttestation({
      authorDid: NODE_ALONSO,
      rkey: 'a1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Alonso review',
    })
    await publishAttestation({
      authorDid: NODE_SANCHO,
      rkey: 's1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Sancho review',
    })

    // Cross-node vouch — node A vouches for node B.
    await publishVouch({
      authorDid: NODE_ALONSO,
      subjectDid: NODE_SANCHO,
      rkey: 'alonso-vouches-sancho',
      confidence: 'high',
    })

    // Verify the trust edge landed (handler-side write).
    const edgeResult = await db.execute(sql`
      SELECT from_did, to_did, edge_type, weight
      FROM trust_edges
      WHERE from_did = ${NODE_ALONSO} AND to_did = ${NODE_SANCHO}
    `)
    const edges = (edgeResult as any).rows
    expect(edges.length).toBeGreaterThanOrEqual(1)
    expect(edges[0].edge_type).toBe('vouch')

    // Run profile refresh — Sancho's profile must now reflect the
    // inbound vouch (the per-author scorer reads trust_edges).
    await refreshProfiles(db)

    const sanchoProfile = await getProfile(db, { did: NODE_SANCHO })
    expect(sanchoProfile).not.toBeNull()
    expect(sanchoProfile?.vouchCount).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Scenario 4 — Independent deletion.
// ---------------------------------------------------------------------------
describe('TN-TEST-040 §4: independent deletion', () => {
  it('one publisher retracts; the other publisher attestation remains queryable', async () => {
    await publishAttestation({
      authorDid: NODE_ALONSO,
      rkey: 'alonso-att',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Alonso wrote this',
    })
    await publishAttestation({
      authorDid: NODE_SANCHO,
      rkey: 'sancho-att',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Sancho wrote this',
    })

    // Pre-delete sanity — both attestations queryable.
    const subjectRow = await db.execute(sql`
      SELECT id FROM subjects WHERE did = ${SUBJECT_CHAIRMAKER}
    `)
    const subjectId = (subjectRow as any).rows[0]?.id
    const beforeDelete = await getAttestations(db, { subjectId, limit: 25 })
    expect(beforeDelete.attestations.length).toBe(2)

    // Alonso retracts.
    await deleteAttestation(NODE_ALONSO, 'alonso-att')

    // Post-delete: only Sancho's attestation remains. A
    // cascade-orphan-GC bug or an over-broad delete would shrink to
    // zero (eating Sancho's data despite Sancho not authorising it).
    const afterDelete = await getAttestations(db, { subjectId, limit: 25 })
    expect(afterDelete.attestations.length).toBe(1)
    expect(afterDelete.attestations[0]?.authorDid).toBe(NODE_SANCHO)
    expect(afterDelete.attestations[0]?.uri).toBe(
      `at://${NODE_SANCHO}/com.dina.trust.attestation/sancho-att`,
    )
  })
})

// ---------------------------------------------------------------------------
// Scenario 5 — Cross-author network-feed visibility.
// ---------------------------------------------------------------------------
describe('TN-TEST-040 §5: cross-author network-feed visibility', () => {
  it('Alonso vouches for Sancho → Alonso feed surfaces Sancho reviews and excludes Alonso own', async () => {
    // Alonso vouches for Sancho — establishes the 1-hop graph edge
    // the network-feed query walks.
    await publishVouch({
      authorDid: NODE_ALONSO,
      subjectDid: NODE_SANCHO,
      rkey: 'a-v-s',
      confidence: 'high',
    })

    // Sancho publishes — Alonso's feed should surface this.
    await publishAttestation({
      authorDid: NODE_SANCHO,
      rkey: 's1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Sancho on ChairMaker',
    })

    // Alonso also publishes — Plan §6.4 says the network feed
    // EXCLUDES the viewer's own attestations. This is the regression
    // guard.
    await publishAttestation({
      authorDid: NODE_ALONSO,
      rkey: 'a1',
      subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker',
      text: 'Alonso on ChairMaker',
    })

    const feed = await networkFeed(db, { viewerDid: NODE_ALONSO, limit: 25 })

    // Sancho's review surfaces.
    const feedAuthorDids = new Set(feed.attestations.map((a: any) => a.authorDid))
    expect(feedAuthorDids.has(NODE_SANCHO)).toBe(true)
    // Alonso's own attestation is excluded.
    expect(feedAuthorDids.has(NODE_ALONSO)).toBe(false)
  })
})
