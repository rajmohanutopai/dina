/**
 * §5 — Idempotency (Fix 1)
 *
 * Test count: 7
 * Plan traceability: IT-IDP-001..007
 *
 * Traces to: Fix 1 (Crash-Replay Survival)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getTestDb, cleanAllTables, closeTestDb, createTestHandlerContext, type TestDB } from '../test-db'
import { routeHandler } from '@/ingester/handlers/index'
import * as schema from '@/db/schema/index'

let db: TestDB
let ctx: ReturnType<typeof createTestHandlerContext>

const AUTHOR_DID = 'did:plc:idempauthor001'
const SUBJECT_DID = 'did:plc:idempsubject001'
const now = new Date().toISOString()

function makeUri(collection: string, rkey: string) {
  return `at://${AUTHOR_DID}/${collection}/${rkey}`
}

beforeAll(() => {
  db = getTestDb()
  ctx = createTestHandlerContext(db)
})

afterAll(async () => {
  await closeTestDb()
})

beforeEach(async () => {
  await cleanAllTables(db)
})

// ---------------------------------------------------------------------------
// §5 Idempotency (IT-IDP-001..007) — 7 tests
// ---------------------------------------------------------------------------
describe('§5 Idempotency (Fix 1)', () => {
  it('IT-IDP-001: Fix 1: replay attestation 10 times → 1 row', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'idp001'
    const uri = makeUri(collection, rkey)

    const handler = routeHandler(collection)!
    const op = {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-idp001',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        createdAt: now,
      },
    }

    // Replay 10 times
    for (let i = 0; i < 10; i++) {
      await handler.handleCreate(ctx, op)
    }

    // Verify: exactly 1 row
    const rows = await db.select().from(schema.attestations).where(eq(schema.attestations.uri, uri))
    expect(rows).toHaveLength(1)
  })

  it('IT-IDP-002: Fix 1: replay vouch 10 times → 1 row', async () => {
    const collection = 'com.dina.trust.vouch'
    const rkey = 'idp002'
    const uri = makeUri(collection, rkey)

    const handler = routeHandler(collection)!
    const op = {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-idp002',
      record: {
        subject: SUBJECT_DID,
        vouchType: 'identity',
        confidence: 'high',
        createdAt: now,
      },
    }

    // Replay 10 times
    for (let i = 0; i < 10; i++) {
      await handler.handleCreate(ctx, op)
    }

    // Verify: exactly 1 row in vouches
    const rows = await db.select().from(schema.vouches).where(eq(schema.vouches.uri, uri))
    expect(rows).toHaveLength(1)

    // Also verify trust edges: should be exactly 1
    const edges = await db.select().from(schema.trustEdges).where(eq(schema.trustEdges.sourceUri, uri))
    expect(edges).toHaveLength(1)
  })

  it('IT-IDP-003: Fix 1: replay reaction → onConflictDoNothing', async () => {
    const collection = 'com.dina.trust.reaction'
    const rkey = 'idp003'
    const uri = makeUri(collection, rkey)

    const handler = routeHandler(collection)!
    const op = {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-idp003',
      record: {
        targetUri: 'at://did:plc:someone/com.dina.trust.attestation/target001',
        reaction: 'helpful',
        createdAt: now,
      },
    }

    // Create once
    await handler.handleCreate(ctx, op)

    // Replay — should be a no-op (onConflictDoNothing)
    await handler.handleCreate(ctx, op)

    // Verify: 1 row, immutable (reaction value unchanged)
    const rows = await db.select().from(schema.reactions).where(eq(schema.reactions.uri, uri))
    expect(rows).toHaveLength(1)
    expect(rows[0].reaction).toBe('helpful')
  })

  it('IT-IDP-004: Fix 1: replay with changed data → updated', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'idp004'
    const uri = makeUri(collection, rkey)

    const handler = routeHandler(collection)!

    // First insert with sentiment = 'positive'
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-idp004-v1',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        createdAt: now,
      },
    })

    // Verify initial sentiment
    const before = await db.select().from(schema.attestations).where(eq(schema.attestations.uri, uri))
    expect(before[0].sentiment).toBe('positive')

    // Replay with changed sentiment
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-idp004-v2',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'negative',
        createdAt: now,
      },
    })

    // Verify: sentiment updated to new value (onConflictDoUpdate)
    const after = await db.select().from(schema.attestations).where(eq(schema.attestations.uri, uri))
    expect(after).toHaveLength(1)
    expect(after[0].sentiment).toBe('negative')
  })

  it('IT-IDP-005: Fix 1: all 19 handler types — replay safe', async () => {
    // One record per handler type, each replayed twice
    const handlerConfigs = [
      {
        collection: 'com.dina.trust.attestation',
        rkey: 'idp005-att',
        record: {
          subject: { type: 'did', did: SUBJECT_DID, name: 'Test' },
          category: 'service',
          sentiment: 'positive',
          createdAt: now,
        },
        table: schema.attestations,
      },
      {
        collection: 'com.dina.trust.vouch',
        rkey: 'idp005-vouch',
        record: {
          subject: SUBJECT_DID,
          vouchType: 'identity',
          confidence: 'high',
          createdAt: now,
        },
        table: schema.vouches,
      },
      {
        collection: 'com.dina.trust.endorsement',
        rkey: 'idp005-end',
        record: {
          subject: SUBJECT_DID,
          skill: 'coding',
          endorsementType: 'worked-together',
          createdAt: now,
        },
        table: schema.endorsements,
      },
      {
        collection: 'com.dina.trust.flag',
        rkey: 'idp005-flag',
        record: {
          subject: { type: 'did', did: SUBJECT_DID, name: 'Flagged' },
          flagType: 'fake-review',
          severity: 'serious',
          createdAt: now,
        },
        table: schema.flags,
      },
      {
        collection: 'com.dina.trust.reply',
        rkey: 'idp005-reply',
        record: {
          rootUri: 'at://did:plc:root/com.dina.trust.attestation/root001',
          parentUri: 'at://did:plc:root/com.dina.trust.attestation/root001',
          intent: 'agree',
          text: 'Agreed',
          createdAt: now,
        },
        table: schema.replies,
      },
      {
        collection: 'com.dina.trust.reaction',
        rkey: 'idp005-rxn',
        record: {
          targetUri: 'at://did:plc:root/com.dina.trust.attestation/root001',
          reaction: 'helpful',
          createdAt: now,
        },
        table: schema.reactions,
      },
      {
        collection: 'com.dina.trust.reportRecord',
        rkey: 'idp005-rpt',
        record: {
          targetUri: 'at://did:plc:root/com.dina.trust.attestation/root001',
          reportType: 'spam',
          createdAt: now,
        },
        table: schema.reportRecords,
      },
      {
        collection: 'com.dina.trust.revocation',
        rkey: 'idp005-rev',
        record: {
          targetUri: 'at://did:plc:root/com.dina.trust.attestation/nonexistent',
          reason: 'Changed my mind',
          createdAt: now,
        },
        table: schema.revocations,
      },
      {
        collection: 'com.dina.trust.delegation',
        rkey: 'idp005-del',
        record: {
          subject: SUBJECT_DID,
          scope: 'attestation',
          permissions: ['create'],
          createdAt: now,
        },
        table: schema.delegations,
      },
      {
        collection: 'com.dina.trust.collection',
        rkey: 'idp005-col',
        record: {
          name: 'My Collection',
          items: ['at://did:plc:item/com.dina.trust.attestation/item1'],
          isPublic: true,
          createdAt: now,
        },
        table: schema.collections,
      },
      {
        collection: 'com.dina.trust.media',
        rkey: 'idp005-med',
        record: {
          parentUri: 'at://did:plc:root/com.dina.trust.attestation/root001',
          mediaType: 'image',
          url: 'https://example.com/photo.jpg',
          createdAt: now,
        },
        table: schema.media,
      },
      {
        collection: 'com.dina.trust.amendment',
        rkey: 'idp005-amd',
        record: {
          targetUri: 'at://did:plc:root/com.dina.trust.attestation/nonexistent',
          amendmentType: 'correction',
          text: 'Correction here',
          createdAt: now,
        },
        table: schema.amendments,
      },
      {
        collection: 'com.dina.trust.verification',
        rkey: 'idp005-ver',
        record: {
          targetUri: 'at://did:plc:root/com.dina.trust.attestation/nonexistent',
          verificationType: 'purchase',
          result: 'inconclusive',
          createdAt: now,
        },
        table: schema.verifications,
      },
      {
        collection: 'com.dina.trust.reviewRequest',
        rkey: 'idp005-rr',
        record: {
          subject: { type: 'did', did: SUBJECT_DID, name: 'Review Request Subject' },
          requestType: 'initial',
          createdAt: now,
        },
        table: schema.reviewRequests,
      },
      {
        collection: 'com.dina.trust.comparison',
        rkey: 'idp005-cmp',
        record: {
          subjects: [
            { type: 'did', did: SUBJECT_DID, name: 'Subject 1' },
            { type: 'did', did: 'did:plc:sub2', name: 'Subject 2' },
          ],
          category: 'service',
          createdAt: now,
        },
        table: schema.comparisons,
      },
      {
        collection: 'com.dina.trust.subjectClaim',
        rkey: 'idp005-sc',
        record: {
          sourceSubjectId: 'sub_source001',
          targetSubjectId: 'sub_target001',
          claimType: 'same-entity',
          createdAt: now,
        },
        table: schema.subjectClaims,
      },
      {
        collection: 'com.dina.trust.trustPolicy',
        rkey: 'idp005-tp',
        record: {
          maxGraphDepth: 3,
          requireVouch: true,
          createdAt: now,
        },
        table: schema.trustPolicies,
      },
      {
        collection: 'com.dina.trust.notificationPrefs',
        rkey: 'idp005-np',
        record: {
          enableMentions: true,
          enableReactions: true,
          enableReplies: false,
          enableFlags: true,
          createdAt: now,
        },
        table: schema.notificationPrefs,
      },
    ]

    for (const hc of handlerConfigs) {
      const uri = makeUri(hc.collection, hc.rkey)
      const handler = routeHandler(hc.collection)
      expect(handler).not.toBeNull()

      const op = {
        uri,
        did: AUTHOR_DID,
        collection: hc.collection,
        rkey: hc.rkey,
        cid: `cid-${hc.rkey}`,
        record: hc.record,
      }

      // Create once
      await handler!.handleCreate(ctx, op)

      // Replay — should not throw
      await expect(handler!.handleCreate(ctx, op)).resolves.not.toThrow()

      // Verify: exactly 1 row for this URI
      const rows = await db.select().from(hc.table).where(eq(hc.table.uri, uri))
      expect(rows).toHaveLength(1)
    }
  })

  it('IT-IDP-006: Fix 1: crash simulation — cursor replay', async () => {
    const collection = 'com.dina.trust.attestation'
    const handler = routeHandler(collection)!

    // Insert 100 unique events
    for (let i = 0; i < 100; i++) {
      const rkey = `idp006-${i.toString().padStart(3, '0')}`
      const uri = makeUri(collection, rkey)
      await handler.handleCreate(ctx, {
        uri,
        did: AUTHOR_DID,
        collection,
        rkey,
        cid: `cid-${rkey}`,
        record: {
          subject: { type: 'did', did: SUBJECT_DID, name: `Event ${i}` },
          category: 'service',
          sentiment: 'positive',
          createdAt: now,
        },
      })
    }

    // Verify 100 rows exist
    const countBefore = await db.select({ count: sql<number>`count(*)::int` }).from(schema.attestations)
    expect(countBefore[0].count).toBe(100)

    // Simulate crash: replay the last 50 events
    for (let i = 50; i < 100; i++) {
      const rkey = `idp006-${i.toString().padStart(3, '0')}`
      const uri = makeUri(collection, rkey)
      await handler.handleCreate(ctx, {
        uri,
        did: AUTHOR_DID,
        collection,
        rkey,
        cid: `cid-${rkey}`,
        record: {
          subject: { type: 'did', did: SUBJECT_DID, name: `Event ${i}` },
          category: 'service',
          sentiment: 'positive',
          createdAt: now,
        },
      })
    }

    // Verify: still 100 unique rows total, no duplicates
    const countAfter = await db.select({ count: sql<number>`count(*)::int` }).from(schema.attestations)
    expect(countAfter[0].count).toBe(100)
  })

  it('IT-IDP-007: Fix 1: concurrent replay — same event from two workers', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'idp007'
    const uri = makeUri(collection, rkey)

    const handler = routeHandler(collection)!
    const op = {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-idp007',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Concurrent Test' },
        category: 'service',
        sentiment: 'positive',
        createdAt: now,
      },
    }

    // Two concurrent creates of the same event
    const results = await Promise.allSettled([
      handler.handleCreate(ctx, op),
      handler.handleCreate(ctx, op),
    ])

    // Both should succeed (no constraint violation)
    const rejected = results.filter(r => r.status === 'rejected')
    expect(rejected).toHaveLength(0)

    // Verify: exactly 1 row
    const rows = await db.select().from(schema.attestations).where(eq(schema.attestations.uri, uri))
    expect(rows).toHaveLength(1)
  })
})
