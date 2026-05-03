/**
 * TN-TEST-041 — Cosig flow round-trip: A→B→accept→endorsement→A sees footer.
 *
 * The cosignature ceremony is the V1 trust-network's two-party
 * publish primitive (Plan §10): A asks B to vouch for the substance
 * of A's review. When B accepts, AppView ends up with three things
 * that the requester's UI ("the footer") collectively reads:
 *
 *   1. A `cosig_requests` row in `accepted` state with `endorsement_uri`
 *      pointing at B's published endorsement record.
 *   2. The endorsement record itself (`com.dina.trust.endorsement`),
 *      which is the load-bearing AT-protocol artifact — durable,
 *      independently auditable, and the source of B's trust-edge
 *      contribution to A's reviewer profile.
 *   3. A's attestation, re-published with `coSignature` populated so
 *      `hasCosignature=true` and `cosignerDid=B` surface through
 *      `getAttestations`. The mobile cosig-footer module reads this
 *      to render "Co-signed by <handle>".
 *
 * **Why this lives in `appview/tests/integration/` rather than the
 * backlog's aspirational `tests/e2e/trust-network/` path**: same
 * reasoning as TN-TEST-040 + TN-TEST-080 — AppView is the centralised
 * convergence point in V1 (Plan §11 / threat-model §3), and the
 * cosig state machine + endorsement linkage live in TS at AppView's
 * read surface. `tests/e2e/` is Python-pytest territory with no TS
 * test runner, and the relevant cross-publisher convergence semantic
 * is what AppView surfaces — not what any single node holds.
 *
 * **Honest scope-narrowing — the wire-side INSERT into `cosig_requests`
 * is seeded directly via `db.insert(cosigRequests)`**. The row is NOT
 * populated from the firehose: the cosignature lifecycle is exchanged
 * via D2D messages (`trust.cosig.request` / `trust.cosig.accept` /
 * `trust.cosig.reject`, see `packages/protocol/src/d2d/cosig.ts`)
 * and the DB write lives on the home-node Core side, not in any
 * `appview/src/ingester/handlers/*` path. AppView's role is the
 * READ surface (`com.dina.trust.cosigList`) plus the hourly
 * expiry sweep (`cosigExpirySweep`). This test pins exactly that
 * surface — the same shape that production fires when Core pushes
 * a row in via the operator's admin path. No fake handler is
 * conjured; the seeding mirrors what the Core-side D2D handler
 * does today.
 *
 * Scenarios pinned (each maps to a specific failure mode the cosig
 * flow's value proposition collapses without):
 *
 *   §1 Recipient inbox sees pending request.
 *      Failure mode: cosig-list xRPC silently drops rows for the
 *      recipient (e.g. recipient_did filter regression). Pin via
 *      cosigList(B, status=pending) returning the seeded row.
 *
 *   §2 Recipient acceptance → endorsement publish → cosig accepted.
 *      Failure mode: the accepted state isn't navigable end-to-end
 *      (status flips but endorsement_uri stays null, or the URI
 *      points at a record AppView never indexed). Pin both halves:
 *      the cosig_requests row carries the URI, AND the endorsement
 *      row at that URI is independently queryable.
 *
 *   §3 Endorsement creates a trust_edge.
 *      Failure mode: B's endorsement publishes but doesn't
 *      contribute to A's reviewer profile (the `endorsementHandler`
 *      regresses on the trust-edge add). Pin via direct trust_edges
 *      row check: edge_type='endorsement', from=B, to=A,
 *      domain=skill, sourceUri=endorsement.uri.
 *
 *   §4 Footer signal — `hasCosignature` + `cosignerDid` flip
 *      via attestation re-publish onConflictDoUpdate.
 *      Failure mode: the upsert path doesn't update cosignature
 *      columns (e.g. a partial set list omits them), so the
 *      mobile footer never lights up. Pin via getAttestations
 *      before-and-after the v2 republish.
 *
 *   §5 Sweep job flips abandoned pending → expired.
 *      Failure mode: requests live past their expiry without being
 *      swept, leaving recipients staring at stale "asks". Pin via
 *      direct cosigExpirySweep call + cosigList(status=expired)
 *      returning the row with reject_reason='expired'.
 *
 *   §6 Recipient decline path closes without endorsement.
 *      Failure mode: a regression that conflates rejected/expired
 *      with accepted (e.g. surfacing endorsement_uri on rejected
 *      rows). Pin via direct status transition + cosigList(status=
 *      rejected) returning row with endorsement_uri null and
 *      reject_reason='declined'.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, and } from 'drizzle-orm'

import { cleanAllTables, closeTestDb, createTestHandlerContext, getTestDb } from '../test-db'
import { routeHandler } from '@/ingester/handlers/index'
import { attestations, cosigRequests, trustEdges } from '@/db/schema/index'
import { cosigList } from '@/api/xrpc/cosig-list'
import { cosigExpirySweep } from '@/scorer/jobs/cosig-expiry-sweep'
import { clearCache } from '@/api/middleware/swr-cache'
import { clearGraphContextCache } from '@/api/middleware/graph-context-cache'

const db = getTestDb()
const ctx = createTestHandlerContext(db)

// Two-party fixtures named after the canonical Dina demo personas
// (Don Alonso = A = requester / original reviewer; Sancho = B =
// recipient / cosigner). Subject is ChairMaker per UTOPAI canon.
const NODE_ALONSO = 'did:plc:alonso041cosig'
const NODE_SANCHO = 'did:plc:sancho041cosig'
const SUBJECT_CHAIR_DID = 'did:plc:chairmaker041cosig'

const ATT_RKEY = 'alonso-att-cosig-1'
const ATT_URI = `at://${NODE_ALONSO}/com.dina.trust.attestation/${ATT_RKEY}`

const ENDORSE_RKEY = 'sancho-endorse-cosig-1'
const ENDORSE_URI = `at://${NODE_SANCHO}/com.dina.trust.endorsement/${ENDORSE_RKEY}`

const CATEGORY = 'office_furniture'

beforeEach(async () => {
  await cleanAllTables(db)
  clearCache()
  clearGraphContextCache()
})

afterAll(async () => {
  await closeTestDb()
})

/**
 * Publish the original attestation. `coSignature` is OPTIONAL — left
 * undefined for v1 (pre-cosig) and populated for v2 (post-accept).
 * Mirrors the production flow: the attestation is published before
 * the cosig request goes out; the requester re-publishes (onConflict
 * upsert) once the recipient accepts.
 */
async function publishAttestation(opts: {
  authorDid: string
  rkey: string
  cosignerDid?: string
  cosignerSig?: string
  cosignerSigCreatedAtMs?: number
  createdAtMs?: number
}) {
  const handler = routeHandler('com.dina.trust.attestation')!
  const record: Record<string, unknown> = {
    subject: { type: 'did', did: SUBJECT_CHAIR_DID, name: 'ChairMaker' },
    category: CATEGORY,
    sentiment: 'positive',
    text: 'Sturdy build, fast shipping',
    createdAt: new Date(opts.createdAtMs ?? Date.now()).toISOString(),
  }
  if (opts.cosignerDid) {
    record.coSignature = {
      did: opts.cosignerDid,
      sig: opts.cosignerSig ?? 'cosig-sig-bytes-placeholder',
      sigCreatedAt: new Date(opts.cosignerSigCreatedAtMs ?? Date.now()).toISOString(),
    }
  }
  await handler.handleCreate(ctx, {
    uri: `at://${opts.authorDid}/com.dina.trust.attestation/${opts.rkey}`,
    did: opts.authorDid,
    collection: 'com.dina.trust.attestation',
    rkey: opts.rkey,
    cid: `cid-att-${opts.rkey}-${(opts.cosignerDid ?? 'none').slice(-6)}`,
    record,
  })
}

/**
 * Publish the recipient's endorsement (the wire artifact the cosig
 * acceptance produces). `endorsementType: 'cosignature'` is the
 * literal that mobile's `cosig_accept.ts` emits — pinned via the
 * exported `COSIG_ENDORSEMENT_TYPE` constant on the writer side.
 */
async function publishEndorsement(opts: {
  authorDid: string
  rkey: string
  subjectDid: string
  skill: string
  endorsementType?: string
  createdAtMs?: number
}) {
  const handler = routeHandler('com.dina.trust.endorsement')!
  await handler.handleCreate(ctx, {
    uri: `at://${opts.authorDid}/com.dina.trust.endorsement/${opts.rkey}`,
    did: opts.authorDid,
    collection: 'com.dina.trust.endorsement',
    rkey: opts.rkey,
    cid: `cid-endorse-${opts.rkey}`,
    record: {
      subject: opts.subjectDid,
      skill: opts.skill,
      endorsementType: opts.endorsementType ?? 'cosignature',
      createdAt: new Date(opts.createdAtMs ?? Date.now()).toISOString(),
    },
  })
}

/**
 * Seed a `cosig_requests` row in the given status. The wire-side
 * INSERT happens on the home-node Core side via D2D message receipt,
 * NOT through the AppView firehose ingester — see file header for
 * the full reasoning. Direct DB seeding mirrors the same row Core
 * would write, byte for byte.
 */
async function seedCosigRequest(opts: {
  requesterDid: string
  recipientDid: string
  attestationUri: string
  status?: 'pending' | 'accepted' | 'rejected' | 'expired'
  endorsementUri?: string
  rejectReason?: string
  expiresAtMs?: number
  createdAtMs?: number
}) {
  const status = opts.status ?? 'pending'
  const expiresAt = new Date(opts.expiresAtMs ?? Date.now() + 86_400_000) // +1d default
  const createdAt = new Date(opts.createdAtMs ?? Date.now())
  await db.insert(cosigRequests).values({
    requesterDid: opts.requesterDid,
    recipientDid: opts.recipientDid,
    attestationUri: opts.attestationUri,
    status,
    endorsementUri: opts.endorsementUri ?? null,
    rejectReason: opts.rejectReason ?? null,
    expiresAt,
    createdAt,
    updatedAt: createdAt,
  })
}

// ---------------------------------------------------------------------------
// §1 — Recipient inbox sees pending request.
// ---------------------------------------------------------------------------
describe('TN-TEST-041 §1: recipient inbox sees pending cosig request', () => {
  it('cosigList(recipient=B, status=pending) returns the seeded row', async () => {
    await publishAttestation({ authorDid: NODE_ALONSO, rkey: ATT_RKEY })

    await seedCosigRequest({
      requesterDid: NODE_ALONSO,
      recipientDid: NODE_SANCHO,
      attestationUri: ATT_URI,
    })

    const inbox = await cosigList(db, { recipientDid: NODE_SANCHO, status: 'pending', limit: 25 })

    expect(inbox.requests).toHaveLength(1)
    const [row] = inbox.requests
    expect(row.requesterDid).toBe(NODE_ALONSO)
    expect(row.recipientDid).toBe(NODE_SANCHO)
    expect(row.attestationUri).toBe(ATT_URI)
    expect(row.status).toBe('pending')
    expect(row.endorsementUri).toBeNull()
    expect(row.rejectReason).toBeNull()
  })

  it('cosigList does NOT leak the request to other recipients', async () => {
    await publishAttestation({ authorDid: NODE_ALONSO, rkey: ATT_RKEY })
    await seedCosigRequest({
      requesterDid: NODE_ALONSO,
      recipientDid: NODE_SANCHO,
      attestationUri: ATT_URI,
    })

    const stranger = 'did:plc:stranger041cosig'
    const inbox = await cosigList(db, { recipientDid: stranger, status: 'pending', limit: 25 })
    expect(inbox.requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// §2 — Recipient acceptance: endorsement published, cosig_requests
//      transitions to accepted with endorsement_uri.
// ---------------------------------------------------------------------------
describe('TN-TEST-041 §2: acceptance closes request with endorsement_uri', () => {
  it('accepted row carries endorsement_uri navigable to the published endorsement', async () => {
    // Setup — A publishes the original attestation (no cosig yet).
    await publishAttestation({ authorDid: NODE_ALONSO, rkey: ATT_RKEY })
    await seedCosigRequest({
      requesterDid: NODE_ALONSO,
      recipientDid: NODE_SANCHO,
      attestationUri: ATT_URI,
    })

    // B accepts: publishes their endorsement (the wire artifact).
    await publishEndorsement({
      authorDid: NODE_SANCHO,
      rkey: ENDORSE_RKEY,
      subjectDid: NODE_ALONSO,
      skill: CATEGORY,
    })

    // Core (the home-node-side state machine) flips the cosig row to
    // accepted on receipt of B's `trust.cosig.accept` D2D message.
    // Direct UPDATE here mirrors that exact write.
    await db
      .update(cosigRequests)
      .set({
        status: 'accepted',
        endorsementUri: ENDORSE_URI,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(cosigRequests.requesterDid, NODE_ALONSO),
          eq(cosigRequests.recipientDid, NODE_SANCHO),
          eq(cosigRequests.attestationUri, ATT_URI),
        ),
      )

    // Verify A's recipient-side query (filtered to accepted) returns
    // the row with the URI populated.
    const accepted = await cosigList(db, {
      recipientDid: NODE_SANCHO,
      status: 'accepted',
      limit: 25,
    })
    expect(accepted.requests).toHaveLength(1)
    expect(accepted.requests[0].endorsementUri).toBe(ENDORSE_URI)
    expect(accepted.requests[0].rejectReason).toBeNull()

    // The endorsement record at that URI is independently indexed
    // and visible — the URI is real, not just a stored string.
    // (Endorsements live on the author's profile, not the subject's
    // attestation list, so we query trust_edges by sourceUri to
    // confirm the row landed.)
    const edge = await db
      .select()
      .from(trustEdges)
      .where(eq(trustEdges.sourceUri, ENDORSE_URI))
    expect(edge).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// §3 — Endorsement creates a trust_edge with the right shape.
// ---------------------------------------------------------------------------
describe('TN-TEST-041 §3: endorsement → trust_edge', () => {
  it('B→A endorsement adds trust_edge with edge_type=endorsement, domain=skill', async () => {
    await publishEndorsement({
      authorDid: NODE_SANCHO,
      rkey: ENDORSE_RKEY,
      subjectDid: NODE_ALONSO,
      skill: CATEGORY,
    })

    const edges = await db
      .select()
      .from(trustEdges)
      .where(eq(trustEdges.sourceUri, ENDORSE_URI))

    expect(edges).toHaveLength(1)
    const [e] = edges
    expect(e.fromDid).toBe(NODE_SANCHO)
    expect(e.toDid).toBe(NODE_ALONSO)
    expect(e.edgeType).toBe('endorsement')
    expect(e.domain).toBe(CATEGORY)
    // Default cosignature endorsementType weight (0.4 — distinct from
    // 'worked-together' which weights at 0.8). Pinning the wire-side
    // weight here so a regression in `endorsementTypeToWeight` for
    // the default case fails this test loudly.
    expect(Number(e.weight)).toBeCloseTo(0.4, 5)
  })
})

// ---------------------------------------------------------------------------
// §4 — Footer signal: hasCosignature + cosignerDid flip via republish.
// ---------------------------------------------------------------------------
describe('TN-TEST-041 §4: attestation cosignature columns flip on republish', () => {
  it('v1 (no coSig) → hasCosignature=false → v2 (with coSig) → hasCosignature=true', async () => {
    // v1 — no cosig.
    await publishAttestation({ authorDid: NODE_ALONSO, rkey: ATT_RKEY })

    const [rowV1] = await db
      .select()
      .from(attestations)
      .where(eq(attestations.uri, ATT_URI))
    expect(rowV1).toBeDefined()
    expect(rowV1.hasCosignature).toBe(false)
    expect(rowV1.cosignerDid).toBeNull()

    // v2 — A re-publishes the SAME uri with coSignature populated.
    // Mirrors the production flow: A has received B's D2D
    // `trust.cosig.accept`, knows B's sig + the published
    // endorsement, and amends the attestation record.
    await publishAttestation({
      authorDid: NODE_ALONSO,
      rkey: ATT_RKEY,
      cosignerDid: NODE_SANCHO,
    })

    const [rowV2] = await db
      .select()
      .from(attestations)
      .where(eq(attestations.uri, ATT_URI))
    expect(rowV2.hasCosignature).toBe(true)
    expect(rowV2.cosignerDid).toBe(NODE_SANCHO)
  })
})

// ---------------------------------------------------------------------------
// §5 — Sweep job flips abandoned pending → expired.
// ---------------------------------------------------------------------------
describe('TN-TEST-041 §5: cosigExpirySweep handles abandoned requests', () => {
  it('past-due pending request flips to expired with reject_reason=expired', async () => {
    await publishAttestation({ authorDid: NODE_ALONSO, rkey: ATT_RKEY })
    await seedCosigRequest({
      requesterDid: NODE_ALONSO,
      recipientDid: NODE_SANCHO,
      attestationUri: ATT_URI,
      // Expired 1 hour ago.
      expiresAtMs: Date.now() - 3_600_000,
    })

    await cosigExpirySweep(db)

    const expired = await cosigList(db, {
      recipientDid: NODE_SANCHO,
      status: 'expired',
      limit: 25,
    })
    expect(expired.requests).toHaveLength(1)
    expect(expired.requests[0].rejectReason).toBe('expired')
    expect(expired.requests[0].endorsementUri).toBeNull()
  })

  it('not-yet-expired pending request is NOT touched by the sweep', async () => {
    await publishAttestation({ authorDid: NODE_ALONSO, rkey: ATT_RKEY })
    await seedCosigRequest({
      requesterDid: NODE_ALONSO,
      recipientDid: NODE_SANCHO,
      attestationUri: ATT_URI,
      // Expires +1d in the future.
      expiresAtMs: Date.now() + 86_400_000,
    })

    await cosigExpirySweep(db)

    const stillPending = await cosigList(db, {
      recipientDid: NODE_SANCHO,
      status: 'pending',
      limit: 25,
    })
    expect(stillPending.requests).toHaveLength(1)
    expect(stillPending.requests[0].rejectReason).toBeNull()
  })

  it('past-due ACCEPTED row is NOT touched by the sweep (terminal-state guard)', async () => {
    // Regression guard: a refactor that drops the `status='pending'`
    // predicate from the sweep's WHERE clause would silently flip
    // ALREADY-ACCEPTED rows past their expires_at to 'expired',
    // corrupting the state machine — `endorsement_uri` would become
    // semantically inconsistent with `status='expired'`. Pin against
    // that class of bug here. The schema CHECK is closed-enum but
    // doesn't enforce transitions; this test is the runtime guard.
    await publishAttestation({ authorDid: NODE_ALONSO, rkey: ATT_RKEY })
    await seedCosigRequest({
      requesterDid: NODE_ALONSO,
      recipientDid: NODE_SANCHO,
      attestationUri: ATT_URI,
      status: 'accepted',
      endorsementUri: ENDORSE_URI,
      expiresAtMs: Date.now() - 3_600_000, // expired 1h ago
    })

    await cosigExpirySweep(db)

    const accepted = await cosigList(db, {
      recipientDid: NODE_SANCHO,
      status: 'accepted',
      limit: 25,
    })
    expect(accepted.requests).toHaveLength(1)
    expect(accepted.requests[0].endorsementUri).toBe(ENDORSE_URI)
    expect(accepted.requests[0].rejectReason).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// §6 — Decline path closes without endorsement.
// ---------------------------------------------------------------------------
describe('TN-TEST-041 §6: recipient decline closes request without endorsement_uri', () => {
  it('rejected row carries reject_reason and null endorsement_uri', async () => {
    await publishAttestation({ authorDid: NODE_ALONSO, rkey: ATT_RKEY })
    await seedCosigRequest({
      requesterDid: NODE_ALONSO,
      recipientDid: NODE_SANCHO,
      attestationUri: ATT_URI,
    })

    // B declines. Core flips the row on D2D `trust.cosig.reject`
    // receipt; direct UPDATE mirrors that path.
    await db
      .update(cosigRequests)
      .set({
        status: 'rejected',
        rejectReason: 'declined',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(cosigRequests.requesterDid, NODE_ALONSO),
          eq(cosigRequests.recipientDid, NODE_SANCHO),
          eq(cosigRequests.attestationUri, ATT_URI),
        ),
      )

    const rejected = await cosigList(db, {
      recipientDid: NODE_SANCHO,
      status: 'rejected',
      limit: 25,
    })
    expect(rejected.requests).toHaveLength(1)
    expect(rejected.requests[0].rejectReason).toBe('declined')
    expect(rejected.requests[0].endorsementUri).toBeNull()

    // And: NO endorsement record exists (the wire artifact never
    // published) — pinned via trust_edges absence at the would-be URI.
    const edges = await db
      .select()
      .from(trustEdges)
      .where(eq(trustEdges.sourceUri, ENDORSE_URI))
    expect(edges).toHaveLength(0)
  })
})
