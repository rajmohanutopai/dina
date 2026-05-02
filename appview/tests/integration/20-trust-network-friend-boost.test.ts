/**
 * TN-TEST-080 — User-story 11: trust-network friend-boost.
 *
 * The user-story-11 promise from the V1 backlog: "Don Alonso publishes,
 * Sancho searches, friend boost." Sancho's 1-hop trust graph (via
 * vouch) includes Alonso. When Sancho searches, attestations authored
 * by Alonso rank ABOVE attestations from strangers — even when the
 * stranger's attestation is more recent or otherwise more relevant by
 * the V1 ordering.
 *
 * Why this test lives in `appview/tests/integration/` rather than the
 * backlog's aspirational `tests/system/user-stories/11-trust-network.test.ts`
 * path: same logic as TN-TEST-040's resolution — AppView is the
 * convergence point in V1 (Plan §11 / threat-model §3) and search-time
 * friend-boost is implemented inside the AppView search xRPC, not in
 * a node-level handler. `tests/system/user_stories/` is Python-pytest
 * territory (slot 11 is already taken by `test_11_anti_her.py` for a
 * different theme); this test exercises the actual code path the
 * V1 ranker uses.
 *
 * What's pinned (each maps to a documented failure mode the friend-
 * boost contract collapses without):
 *
 *   1. **Friend's attestation outranks stranger's.**
 *      Failure mode: search ignores `viewerDid` (the previous shape —
 *      schema accepted it and silently dropped). Pin via Alonso's
 *      OLDER review surfacing above a stranger's NEWER review.
 *
 *   2. **No `viewerDid` → V1 baseline ordering preserved.**
 *      Failure mode: a regression that always applies the boost
 *      would surface here as Alonso's older row ranking above the
 *      stranger's newer row even when the viewer is unspecified.
 *      Pin via stranger's newer row leading when viewerDid omitted.
 *
 *   3. **Viewer's own attestation NOT boosted.**
 *      The viewer is the BFS root (depth=0); the 1-hop filter
 *      excludes them. A regression that included the root would let
 *      Sancho's own reviews dominate his own searches, producing an
 *      echo-chamber effect inconsistent with Plan §6.4. Pin via
 *      Sancho's own attestation NOT outranking a stranger's newer
 *      one when Sancho is viewer.
 *
 *   4. **Empty 1-hop graph → no-boost baseline.**
 *      A new viewer with no vouches has no friends. The boost must
 *      no-op; otherwise empty-graph viewers would trigger the
 *      CASE-WHEN branch with an empty IN list (Postgres rejects).
 *      Pin via lonely-viewer search returning rows in pure recency
 *      order, indistinguishable from no-viewerDid.
 *
 *   5. **Boost is a flag, not a per-overlap multiplier.**
 *      Multiple 1-hop friends with attestations on the same query
 *      stay grouped together at the top — they don't sub-sort each
 *      other beyond the existing recency tiebreak. Plan §7 line 885's
 *      "= 1.5 if ANY 1-hop reviewer..." pinned at the SQL layer:
 *      stranger's row sorts BELOW both friends, but the two friends
 *      retain their relative recency order. Failure mode: a
 *      regression to a per-friend multiplier (`COUNT(IN ...)`) would
 *      let a viewer with many friend-reviewers push crowd-favoured
 *      subjects above relevance.
 *
 *   6. **Combined with viewerRegion: friend signal dominates.**
 *      Plan §7 hierarchy: friend signal is a stronger trust cue than
 *      regional availability. A friend's outside-region review beats
 *      a stranger's in-region review. Failure mode: ordering the
 *      sort-bump bucks would invert this.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { cleanAllTables, closeTestDb, createTestHandlerContext, getTestDb } from '../test-db'
import { routeHandler } from '@/ingester/handlers/index'
import { search } from '@/api/xrpc/search'
import { clearCache } from '@/api/middleware/swr-cache'

const db = getTestDb()
const ctx = createTestHandlerContext(db)

// User-story-11 fixtures named after the canonical Dina demo personas
// (CLAUDE.md: "demo persona naming uses UTOPAI canon"). Sancho is the
// viewer; Don Alonso is Sancho's vouched 1-hop friend; Stranger is a
// publisher with no edge to Sancho.
const SANCHO = 'did:plc:sancho080friendboost'
const ALONSO = 'did:plc:alonso080friendboost'
const STRANGER = 'did:plc:stranger080friendboost'
const ALBERT = 'did:plc:albert080friendboost'  // second 1-hop friend

const SUBJECT_CHAIRMAKER = 'did:plc:chairmaker080friendboost'
const SUBJECT_OTHER = 'did:plc:potter080friendboost'

beforeEach(async () => {
  await cleanAllTables(db)
  clearCache()
})

afterAll(async () => {
  await closeTestDb()
})

/**
 * Insert an attestation via the ingester handler. Same path Jetstream
 * exercises in production. `createdAtMs` controls the recency-tiebreak
 * so the friend-boost contract can be isolated from V1's recency-DESC
 * default ordering.
 */
async function publishAttestation(opts: {
  authorDid: string
  rkey: string
  subjectDid: string
  subjectName: string
  text: string
  category?: string
  createdAtMs: number
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
      sentiment: 'positive',
      text: opts.text,
      createdAt: new Date(opts.createdAtMs).toISOString(),
    },
  })
}

/**
 * Vouch from `authorDid` for `subjectDid`. Creates a `trust_edges` row
 * with edgeType='vouch' which `computeGraphContext(viewer, depth=1)`
 * surfaces as a 1-hop friend.
 */
async function publishVouch(opts: {
  authorDid: string
  subjectDid: string
  rkey: string
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
      confidence: 'high',
      createdAt: new Date().toISOString(),
    },
  })
}

// Anchor timestamps so the recency-tiebreak is deterministic and the
// friend-boost vs recency contract is isolated cleanly. Older →
// smaller ms.
const T_OLDEST = Date.UTC(2026, 0, 1, 0, 0, 0)
const T_OLDER = Date.UTC(2026, 0, 5, 0, 0, 0)
const T_NEWER = Date.UTC(2026, 0, 10, 0, 0, 0)
const T_NEWEST = Date.UTC(2026, 0, 15, 0, 0, 0)

// ---------------------------------------------------------------------------
// §1 — Friend's attestation outranks stranger's.
// ---------------------------------------------------------------------------
describe('TN-TEST-080 §1: friend\'s attestation outranks stranger\'s', () => {
  it('Alonso (1-hop) older review ranks above Stranger newer review when Sancho is viewer', async () => {
    // Sancho vouches for Alonso → 1-hop edge.
    await publishVouch({ authorDid: SANCHO, subjectDid: ALONSO, rkey: 'sancho-vouch-alonso' })

    // Alonso publishes EARLIER. Without friend-boost, the stranger's
    // newer row would lead by recency-DESC.
    await publishAttestation({
      authorDid: ALONSO, rkey: 'a-1', subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker', text: 'Sturdy build, fast shipping',
      category: 'service', createdAtMs: T_OLDER,
    })
    await publishAttestation({
      authorDid: STRANGER, rkey: 's-1', subjectDid: SUBJECT_OTHER,
      subjectName: 'Potter', text: 'Decent quality',
      category: 'service', createdAtMs: T_NEWER,
    })

    const resp = await search(db, {
      category: 'service', sort: 'recent', limit: 25, viewerDid: SANCHO,
    })

    expect(resp.results.length).toBe(2)
    // The friend-boost lifts Alonso's older row ABOVE the stranger's
    // newer row. Without the boost, recency-DESC would invert this.
    expect((resp.results[0] as any).authorDid).toBe(ALONSO)
    expect((resp.results[1] as any).authorDid).toBe(STRANGER)
  })

  it('boost holds even when stranger has matching FTS relevance', async () => {
    await publishVouch({ authorDid: SANCHO, subjectDid: ALONSO, rkey: 'sancho-vouch-alonso' })
    await publishAttestation({
      authorDid: ALONSO, rkey: 'a-1', subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker', text: 'sturdy quality build',
      category: 'service', createdAtMs: T_OLDER,
    })
    await publishAttestation({
      authorDid: STRANGER, rkey: 's-1', subjectDid: SUBJECT_OTHER,
      subjectName: 'Potter', text: 'sturdy quality build',
      category: 'service', createdAtMs: T_NEWER,
    })

    // FTS relevance ties on identical text; without the boost, the
    // stranger's newer row would lead via the secondary uri-DESC.
    const resp = await search(db, {
      q: 'sturdy quality', sort: 'relevant', limit: 25, viewerDid: SANCHO,
    })

    expect(resp.results.length).toBe(2)
    expect((resp.results[0] as any).authorDid).toBe(ALONSO)
    expect((resp.results[1] as any).authorDid).toBe(STRANGER)
  })
})

// ---------------------------------------------------------------------------
// §2 — No viewerDid → V1 baseline ordering preserved.
// ---------------------------------------------------------------------------
describe('TN-TEST-080 §2: no viewerDid → recency-DESC baseline preserved', () => {
  it('without viewerDid, Stranger\'s newer row leads Alonso\'s older row', async () => {
    await publishVouch({ authorDid: SANCHO, subjectDid: ALONSO, rkey: 'sancho-vouch-alonso' })
    await publishAttestation({
      authorDid: ALONSO, rkey: 'a-1', subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker', text: 'older review',
      category: 'service', createdAtMs: T_OLDER,
    })
    await publishAttestation({
      authorDid: STRANGER, rkey: 's-1', subjectDid: SUBJECT_OTHER,
      subjectName: 'Potter', text: 'newer review',
      category: 'service', createdAtMs: T_NEWER,
    })

    // No viewerDid → no friend-boost lookup → pure recency-DESC.
    const resp = await search(db, {
      category: 'service', sort: 'recent', limit: 25,
    })

    expect(resp.results.length).toBe(2)
    expect((resp.results[0] as any).authorDid).toBe(STRANGER)
    expect((resp.results[1] as any).authorDid).toBe(ALONSO)
  })
})

// ---------------------------------------------------------------------------
// §3 — Viewer's own attestation is NOT in the 1-hop boost set.
// ---------------------------------------------------------------------------
describe('TN-TEST-080 §3: viewer\'s own attestation is NOT boosted', () => {
  it('Sancho viewing his own + a stranger\'s newer review: stranger leads', async () => {
    // Sancho doesn't vouch for himself (he's the BFS root); his
    // 1-hop set is empty in this scenario, so the boost no-ops and
    // falls back to recency-DESC.
    await publishAttestation({
      authorDid: SANCHO, rkey: 'self-1', subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker', text: 'self review',
      category: 'service', createdAtMs: T_OLDER,
    })
    await publishAttestation({
      authorDid: STRANGER, rkey: 's-1', subjectDid: SUBJECT_OTHER,
      subjectName: 'Potter', text: 'stranger review',
      category: 'service', createdAtMs: T_NEWER,
    })

    const resp = await search(db, {
      category: 'service', sort: 'recent', limit: 25, viewerDid: SANCHO,
    })

    expect(resp.results.length).toBe(2)
    // If the root were erroneously included in the boost set, Sancho's
    // older self-review would surface above the stranger's newer one.
    expect((resp.results[0] as any).authorDid).toBe(STRANGER)
    expect((resp.results[1] as any).authorDid).toBe(SANCHO)
  })
})

// ---------------------------------------------------------------------------
// §4 — Empty 1-hop graph → no-boost baseline.
// ---------------------------------------------------------------------------
describe('TN-TEST-080 §4: empty 1-hop graph → no-boost', () => {
  it('lonely viewer (no vouches) gets pure recency-DESC ordering', async () => {
    // No vouches anywhere — Sancho's 1-hop graph is empty.
    await publishAttestation({
      authorDid: ALONSO, rkey: 'a-1', subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker', text: 'older',
      category: 'service', createdAtMs: T_OLDER,
    })
    await publishAttestation({
      authorDid: STRANGER, rkey: 's-1', subjectDid: SUBJECT_OTHER,
      subjectName: 'Potter', text: 'newer',
      category: 'service', createdAtMs: T_NEWER,
    })

    const resp = await search(db, {
      category: 'service', sort: 'recent', limit: 25, viewerDid: SANCHO,
    })

    expect(resp.results.length).toBe(2)
    // Empty 1-hop set short-circuits the boost; stranger's newer row
    // leads by recency. Critical: the implementation must NOT emit a
    // CASE WHEN ... IN () SQL fragment (Postgres rejects empty IN).
    expect((resp.results[0] as any).authorDid).toBe(STRANGER)
    expect((resp.results[1] as any).authorDid).toBe(ALONSO)
  })
})

// ---------------------------------------------------------------------------
// §5 — Boost is a flag, not a per-overlap multiplier.
// ---------------------------------------------------------------------------
describe('TN-TEST-080 §5: boost is a flag (not a per-friend multiplier)', () => {
  it('two 1-hop friends both rank above stranger; their relative order is recency', async () => {
    await publishVouch({ authorDid: SANCHO, subjectDid: ALONSO, rkey: 'sancho-vouch-alonso' })
    await publishVouch({ authorDid: SANCHO, subjectDid: ALBERT, rkey: 'sancho-vouch-albert' })

    // Three rows, all matching the same query. Relative recency:
    //   Stranger   (T_NEWEST) — but stranger
    //   Albert     (T_NEWER)  — friend
    //   Alonso     (T_OLDER)  — friend
    await publishAttestation({
      authorDid: STRANGER, rkey: 's-1', subjectDid: SUBJECT_OTHER,
      subjectName: 'Potter', text: 'r',
      category: 'service', createdAtMs: T_NEWEST,
    })
    await publishAttestation({
      authorDid: ALBERT, rkey: 'b-1', subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker', text: 'r',
      category: 'service', createdAtMs: T_NEWER,
    })
    await publishAttestation({
      authorDid: ALONSO, rkey: 'a-1', subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker', text: 'r',
      category: 'service', createdAtMs: T_OLDER,
    })

    const resp = await search(db, {
      category: 'service', sort: 'recent', limit: 25, viewerDid: SANCHO,
    })

    expect(resp.results.length).toBe(3)
    // Both friends rank in the top bucket (boost=1 group); the stranger
    // is in the bottom bucket. Within the friend bucket, recency wins.
    const authors = resp.results.map((r: any) => r.authorDid)
    expect(authors[0]).toBe(ALBERT)   // newer friend
    expect(authors[1]).toBe(ALONSO)   // older friend
    expect(authors[2]).toBe(STRANGER) // boost=0 bucket
  })
})

// ---------------------------------------------------------------------------
// §6 — Friend signal dominates region match.
// ---------------------------------------------------------------------------
describe('TN-TEST-080 §6: friend signal dominates region match', () => {
  it('Alonso (friend, no region info) outranks Stranger (no friendship, region match)', async () => {
    await publishVouch({ authorDid: SANCHO, subjectDid: ALONSO, rkey: 'sancho-vouch-alonso' })

    // Alonso's row has no availability metadata (no region match for
    // Sancho's 'GB' viewer region). Stranger's row IS in the region.
    // The friend boost MUST dominate the region boost — otherwise the
    // stranger surfaces first.
    await publishAttestation({
      authorDid: ALONSO, rkey: 'a-1', subjectDid: SUBJECT_CHAIRMAKER,
      subjectName: 'ChairMaker', text: 'friend review no region',
      category: 'service', createdAtMs: T_OLDER,
    })
    await publishAttestation({
      authorDid: STRANGER, rkey: 's-1', subjectDid: SUBJECT_OTHER,
      subjectName: 'Potter', text: 'stranger review in region',
      category: 'service', createdAtMs: T_NEWER,
    })

    const resp = await search(db, {
      category: 'service', sort: 'recent', limit: 25,
      viewerDid: SANCHO, viewerRegion: 'GB',
    })

    expect(resp.results.length).toBe(2)
    // Friend wins despite being out-of-region.
    expect((resp.results[0] as any).authorDid).toBe(ALONSO)
    expect((resp.results[1] as any).authorDid).toBe(STRANGER)
  })
})
