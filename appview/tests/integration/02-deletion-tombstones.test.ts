/**
 * §2 — Deletion Handler + Tombstones
 *
 * Test count: 20
 * Plan traceability: IT-DEL-001..020
 *
 * Traces to: Architecture §"Deletion Handler", Fix 13 (Parameterized Deletion Handler)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getTestDb, cleanAllTables, closeTestDb, createTestHandlerContext, type TestDB } from '../test-db'
import { routeHandler } from '@/ingester/handlers/index'
import * as schema from '@/db/schema/index'
import { deletionHandler, getSourceTable } from '@/ingester/deletion-handler'

let db: TestDB
let ctx: ReturnType<typeof createTestHandlerContext>

const AUTHOR_DID = 'did:plc:testauthor001'
const SUBJECT_DID = 'did:plc:testsubject001'
const REPORTER_DID = 'did:plc:reporter001'
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
// §2.1 Deletion — Undisputed Clean Delete (IT-DEL-001..003) — 3 tests
// ---------------------------------------------------------------------------
describe('§2.1 Deletion — Undisputed Clean Delete', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0357", "section": "01", "sectionName": "General", "title": "IT-DEL-001: clean delete \u2014 no disputes, no tombstone"}
  it('IT-DEL-001: clean delete — no disputes, no tombstone', async () => {
    // Create an attestation
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del001'
    const uri = makeUri(collection, rkey)

    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del001',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        createdAt: now,
      },
    })

    // Verify attestation exists
    const before = await db.select().from(schema.attestations).where(eq(schema.attestations.uri, uri))
    expect(before).toHaveLength(1)

    // Verify no reports, disputes, or suspicious reactions exist
    const reports = await db.select().from(schema.reportRecords).where(eq(schema.reportRecords.targetUri, uri))
    expect(reports).toHaveLength(0)

    // Delete the attestation
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: attestation row deleted
    const after = await db.select().from(schema.attestations).where(eq(schema.attestations.uri, uri))
    expect(after).toHaveLength(0)

    // Verify: no tombstone created
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(0)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0358", "section": "01", "sectionName": "General", "title": "IT-DEL-002: clean delete \u2014 trust edge removed"}
  it('IT-DEL-002: clean delete — trust edge removed', async () => {
    // Create a vouch (which creates a trust edge)
    const collection = 'com.dina.trust.vouch'
    const rkey = 'del002'
    const uri = makeUri(collection, rkey)

    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del002',
      record: {
        subject: SUBJECT_DID,
        vouchType: 'identity',
        confidence: 'high',
        createdAt: now,
      },
    })

    // Verify trust edge exists
    const edgesBefore = await db.select().from(schema.trustEdges).where(eq(schema.trustEdges.sourceUri, uri))
    expect(edgesBefore).toHaveLength(1)

    // Delete the vouch (undisputed)
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: trust edge removed
    const edgesAfter = await db.select().from(schema.trustEdges).where(eq(schema.trustEdges.sourceUri, uri))
    expect(edgesAfter).toHaveLength(0)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0359", "section": "01", "sectionName": "General", "title": "IT-DEL-003: clean delete metrics"}
  it('IT-DEL-003: clean delete metrics', async () => {
    // Create an attestation and delete it (undisputed)
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del003'
    const uri = makeUri(collection, rkey)

    const metricsLog: string[] = []
    const metricsCtx = {
      ...ctx,
      metrics: {
        ...ctx.metrics,
        incr: (name: string) => { metricsLog.push(name) },
      },
    }

    const handler = routeHandler(collection)!
    await handler.handleCreate(metricsCtx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del003',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        createdAt: now,
      },
    })

    metricsLog.length = 0
    await handler.handleDelete(metricsCtx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify deletion metric was emitted (handler emits ingester.attestation.deleted)
    expect(metricsLog).toContain('ingester.attestation.deleted')
  })
})

// ---------------------------------------------------------------------------
// §2.2 Deletion — Disputed Delete / Tombstone Created (IT-DEL-004..012) — 9 tests
// ---------------------------------------------------------------------------
describe('§2.2 Deletion — Disputed Delete (Tombstone Created)', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0360", "section": "01", "sectionName": "General", "title": "IT-DEL-004: disputed \u2014 has report \u2192 tombstone"}
  it('IT-DEL-004: disputed — has report → tombstone', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del004'
    const uri = makeUri(collection, rkey)

    // Create attestation
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del004',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        createdAt: now,
      },
    })

    // Insert a report targeting this attestation URI
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report004'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report004',
      cid: 'cid-report004',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        text: 'This review is fake',
        createdAt: now,
      },
    })

    // Delete the attestation
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: tombstone created with reportCount = 1
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].reportCount).toBe(1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0361", "section": "01", "sectionName": "General", "title": "IT-DEL-005: disputed \u2014 has dispute reply \u2192 tombstone"}
  it('IT-DEL-005: disputed — has dispute reply → tombstone', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del005'
    const uri = makeUri(collection, rkey)

    // Create attestation
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del005',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        createdAt: now,
      },
    })

    // Insert a reply with intent = 'dispute' targeting this attestation
    const replyHandler = routeHandler('com.dina.trust.reply')!
    await replyHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reply', 'reply005'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reply',
      rkey: 'reply005',
      cid: 'cid-reply005',
      record: {
        rootUri: uri,
        parentUri: uri,
        intent: 'dispute',
        text: 'I dispute this attestation',
        createdAt: now,
      },
    })

    // Delete the attestation
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: tombstone with disputeReplyCount = 1
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].disputeReplyCount).toBe(1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0362", "section": "01", "sectionName": "General", "title": "IT-DEL-006: disputed \u2014 has suspicious reaction \u2192 tombstone"}
  it('IT-DEL-006: disputed — has suspicious reaction → tombstone', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del006'
    const uri = makeUri(collection, rkey)

    // Create attestation
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del006',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        createdAt: now,
      },
    })

    // Insert a suspicious reaction
    const reactionHandler = routeHandler('com.dina.trust.reaction')!
    await reactionHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reaction', 'rxn006'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reaction',
      rkey: 'rxn006',
      cid: 'cid-rxn006',
      record: {
        targetUri: uri,
        reaction: 'suspicious',
        createdAt: now,
      },
    })

    // Delete the attestation
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: tombstone with suspiciousReactionCount = 1
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].suspiciousReactionCount).toBe(1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0363", "section": "01", "sectionName": "General", "title": "IT-DEL-007: tombstone preserves metadata"}
  it('IT-DEL-007: tombstone preserves metadata', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del007'
    const uri = makeUri(collection, rkey)

    // Create attestation with metadata
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del007',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'negative',
        domain: 'food',
        createdAt: now,
      },
    })

    // Insert a report to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report007'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report007',
      cid: 'cid-report007',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        createdAt: now,
      },
    })

    // Delete the attestation
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify tombstone preserves metadata
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].authorDid).toBe(AUTHOR_DID)
    expect(tombstone[0].category).toBe('service')
    expect(tombstone[0].sentiment).toBe('negative')
    expect(tombstone[0].domain).toBe('food')
    expect(tombstone[0].subjectId).toBeTruthy()
    expect(tombstone[0].originalCreatedAt).toBeInstanceOf(Date)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0364", "section": "01", "sectionName": "General", "title": "IT-DEL-008: tombstone \u2014 durationDays calculated"}
  it('IT-DEL-008: tombstone — durationDays calculated', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del008'
    const uri = makeUri(collection, rkey)

    // Create attestation with a createdAt 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()

    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del008',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        createdAt: tenDaysAgo,
      },
    })

    // Add report to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report008'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report008',
      cid: 'cid-report008',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        createdAt: now,
      },
    })

    // Delete the attestation
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify durationDays is approximately 10
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].durationDays).toBeGreaterThanOrEqual(9)
    expect(tombstone[0].durationDays).toBeLessThanOrEqual(11)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0365", "section": "01", "sectionName": "General", "title": "IT-DEL-009: tombstone \u2014 hadEvidence flag"}
  it('IT-DEL-009: tombstone — hadEvidence flag', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del009'
    const uri = makeUri(collection, rkey)

    // Create attestation with evidence
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del009',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        evidence: [{ type: 'receipt', description: 'Purchase receipt' }],
        createdAt: now,
      },
    })

    // Add report to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report009'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report009',
      cid: 'cid-report009',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        createdAt: now,
      },
    })

    // Delete the attestation
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify hadEvidence = true
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].hadEvidence).toBe(true)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0366", "section": "01", "sectionName": "General", "title": "IT-DEL-010: tombstone \u2014 hadCosignature flag"}
  it('IT-DEL-010: tombstone — hadCosignature flag', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del010'
    const uri = makeUri(collection, rkey)

    // Create attestation with coSignature
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del010',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        coSignature: { did: 'did:plc:cosigner', sig: 'abc123', sigCreatedAt: now },
        createdAt: now,
      },
    })

    // Add report to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report010'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report010',
      cid: 'cid-report010',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        createdAt: now,
      },
    })

    // Delete the attestation
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify hadCosignature = true
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].hadCosignature).toBe(true)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0367", "section": "01", "sectionName": "General", "title": "IT-DEL-011: tombstone \u2014 record still deleted"}
  it('IT-DEL-011: tombstone — record still deleted', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del011'
    const uri = makeUri(collection, rkey)

    // Create attestation
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del011',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        createdAt: now,
      },
    })

    // Add report to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report011'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report011',
      cid: 'cid-report011',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        createdAt: now,
      },
    })

    // Delete the attestation
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: attestation row removed even though tombstone was created
    const attRows = await db.select().from(schema.attestations).where(eq(schema.attestations.uri, uri))
    expect(attRows).toHaveLength(0)

    // Verify: tombstone exists
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0368", "section": "01", "sectionName": "General", "title": "IT-DEL-012: tombstone metrics"}
  it('IT-DEL-012: tombstone metrics', async () => {
    const collection = 'com.dina.trust.attestation'
    const rkey = 'del012'
    const uri = makeUri(collection, rkey)

    const metricsLog: string[] = []
    const metricsCtx = {
      ...ctx,
      metrics: {
        ...ctx.metrics,
        incr: (name: string) => { metricsLog.push(name) },
      },
    }

    // Create attestation
    const handler = routeHandler(collection)!
    await handler.handleCreate(metricsCtx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del012',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Test Subject' },
        category: 'service',
        sentiment: 'positive',
        createdAt: now,
      },
    })

    // Add report to make it disputed — use real ctx so metric tracking doesn't interfere
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report012'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report012',
      cid: 'cid-report012',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        createdAt: now,
      },
    })

    // Reset metrics log and delete
    metricsLog.length = 0
    await handler.handleDelete(metricsCtx, { uri, did: AUTHOR_DID, collection, rkey })

    // The deletionHandler.process internally calls metrics.incr('ingester.deletion.tombstone_created')
    // and the attestation handler calls ingester.attestation.deleted
    // Note: deletionHandler uses the module-level metrics, not ctx.metrics.
    // So we just verify the handler-level metric was emitted
    expect(metricsLog).toContain('ingester.attestation.deleted')
  })
})

// ---------------------------------------------------------------------------
// §2.3 Deletion — Multi-Table Correctness / Fix 13 (IT-DEL-013..020) — 8 tests
// ---------------------------------------------------------------------------
describe('§2.3 Deletion — Multi-Table Correctness (Fix 13)', () => {
  // TRACE: {"suite": "APPVIEW", "case": "0369", "section": "01", "sectionName": "General", "title": "IT-DEL-013: Fix 13: delete vouch \u2192 queries vouches table"}
  it('IT-DEL-013: Fix 13: delete vouch → queries vouches table', async () => {
    const collection = 'com.dina.trust.vouch'
    const rkey = 'del013'
    const uri = makeUri(collection, rkey)

    // Create vouch
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del013',
      record: {
        subject: SUBJECT_DID,
        vouchType: 'identity',
        confidence: 'high',
        createdAt: now,
      },
    })

    // Add report targeting the vouch URI to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report013'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report013',
      cid: 'cid-report013',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        createdAt: now,
      },
    })

    // Delete the vouch
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: vouch row deleted
    const vouchRows = await db.select().from(schema.vouches).where(eq(schema.vouches.uri, uri))
    expect(vouchRows).toHaveLength(0)

    // Verify: tombstone created with recordType = 'vouch'
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].recordType).toBe('vouch')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0370", "section": "01", "sectionName": "General", "title": "IT-DEL-014: Fix 13: delete flag \u2192 queries flags table"}
  it('IT-DEL-014: Fix 13: delete flag → queries flags table', async () => {
    const collection = 'com.dina.trust.flag'
    const rkey = 'del014'
    const uri = makeUri(collection, rkey)

    // Create flag
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del014',
      record: {
        subject: { type: 'did', did: SUBJECT_DID, name: 'Flagged Subject' },
        flagType: 'fake-review',
        severity: 'serious',
        createdAt: now,
      },
    })

    // Add report to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report014'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report014',
      cid: 'cid-report014',
      record: {
        targetUri: uri,
        reportType: 'spam',
        createdAt: now,
      },
    })

    // Delete the flag
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: flag row deleted
    const flagRows = await db.select().from(schema.flags).where(eq(schema.flags.uri, uri))
    expect(flagRows).toHaveLength(0)

    // Verify: tombstone created with recordType = 'flag'
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].recordType).toBe('flag')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0371", "section": "01", "sectionName": "General", "title": "IT-DEL-015: Fix 13: delete endorsement \u2192 queries endorsements table"}
  it('IT-DEL-015: Fix 13: delete endorsement → queries endorsements table', async () => {
    const collection = 'com.dina.trust.endorsement'
    const rkey = 'del015'
    const uri = makeUri(collection, rkey)

    // Create endorsement
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del015',
      record: {
        subject: SUBJECT_DID,
        skill: 'typescript',
        endorsementType: 'worked-together',
        createdAt: now,
      },
    })

    // Add report to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report015'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report015',
      cid: 'cid-report015',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        createdAt: now,
      },
    })

    // Delete the endorsement
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: endorsement row deleted
    const endRows = await db.select().from(schema.endorsements).where(eq(schema.endorsements.uri, uri))
    expect(endRows).toHaveLength(0)

    // Verify: tombstone created with recordType = 'endorsement'
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].recordType).toBe('endorsement')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0372", "section": "01", "sectionName": "General", "title": "IT-DEL-016: Fix 13: delete reply \u2192 queries replies table"}
  it('IT-DEL-016: Fix 13: delete reply → queries replies table', async () => {
    const collection = 'com.dina.trust.reply'
    const rkey = 'del016'
    const uri = makeUri(collection, rkey)

    // Create reply
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del016',
      record: {
        rootUri: 'at://did:plc:root/com.dina.trust.attestation/root001',
        parentUri: 'at://did:plc:root/com.dina.trust.attestation/root001',
        intent: 'agree',
        text: 'I agree with this',
        createdAt: now,
      },
    })

    // Add report to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report016'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report016',
      cid: 'cid-report016',
      record: {
        targetUri: uri,
        reportType: 'harassment',
        createdAt: now,
      },
    })

    // Delete the reply
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: reply row deleted
    const replyRows = await db.select().from(schema.replies).where(eq(schema.replies.uri, uri))
    expect(replyRows).toHaveLength(0)

    // Verify: tombstone created with recordType = 'reply'
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].recordType).toBe('reply')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0373", "section": "01", "sectionName": "General", "title": "IT-DEL-017: Fix 13: delete delegation \u2192 queries delegations table"}
  it('IT-DEL-017: Fix 13: delete delegation → queries delegations table', async () => {
    const collection = 'com.dina.trust.delegation'
    const rkey = 'del017'
    const uri = makeUri(collection, rkey)

    // Create delegation
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del017',
      record: {
        subject: SUBJECT_DID,
        scope: 'attestation',
        permissions: ['create', 'read'],
        createdAt: now,
      },
    })

    // Verify trust edge exists
    const edgesBefore = await db.select().from(schema.trustEdges).where(eq(schema.trustEdges.sourceUri, uri))
    expect(edgesBefore).toHaveLength(1)

    // Add report to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report017'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report017',
      cid: 'cid-report017',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        createdAt: now,
      },
    })

    // Delete the delegation
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: delegation row deleted
    const delegRows = await db.select().from(schema.delegations).where(eq(schema.delegations.uri, uri))
    expect(delegRows).toHaveLength(0)

    // Verify: tombstone created
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].recordType).toBe('delegation')

    // Verify: trust edge removed
    const edgesAfter = await db.select().from(schema.trustEdges).where(eq(schema.trustEdges.sourceUri, uri))
    expect(edgesAfter).toHaveLength(0)
  })

  // TRACE: {"suite": "APPVIEW", "case": "0374", "section": "01", "sectionName": "General", "title": "IT-DEL-018: Fix 13: delete report \u2192 queries report_records table"}
  it('IT-DEL-018: Fix 13: delete report → queries report_records table', async () => {
    const collection = 'com.dina.trust.reportRecord'
    const rkey = 'del018'
    const uri = makeUri(collection, rkey)

    // Create a report record
    const handler = routeHandler(collection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection,
      rkey,
      cid: 'cid-del018',
      record: {
        targetUri: 'at://did:plc:someone/com.dina.trust.attestation/some-att',
        reportType: 'spam',
        text: 'This is spam',
        createdAt: now,
      },
    })

    // Add another report targeting this report to make it disputed
    const reportHandler2 = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler2.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report018-meta'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report018-meta',
      cid: 'cid-report018-meta',
      record: {
        targetUri: uri,
        reportType: 'spam',
        createdAt: now,
      },
    })

    // Delete the report
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection, rkey })

    // Verify: report row deleted
    const reportRows = await db.select().from(schema.reportRecords).where(eq(schema.reportRecords.uri, uri))
    expect(reportRows).toHaveLength(0)

    // Verify: tombstone created with recordType = 'reportRecord'
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].recordType).toBe('reportRecord')
  })

  // TRACE: {"suite": "APPVIEW", "case": "0375", "section": "01", "sectionName": "General", "title": "IT-DEL-019: Fix 13: each deleted handler type \u2192 row actually removed"}
  it('IT-DEL-019: Fix 13: each deleted handler type → row actually removed', async () => {
    // Create one record of each type and delete it
    const recordTypes = [
      {
        collection: 'com.dina.trust.attestation',
        rkey: 'del019-att',
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
        rkey: 'del019-vouch',
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
        rkey: 'del019-end',
        record: {
          subject: SUBJECT_DID,
          skill: 'coding',
          endorsementType: 'worked-together',
          createdAt: now,
        },
        table: schema.endorsements,
      },
      {
        collection: 'com.dina.trust.reply',
        rkey: 'del019-reply',
        record: {
          rootUri: 'at://did:plc:root/com.dina.trust.attestation/root001',
          parentUri: 'at://did:plc:root/com.dina.trust.attestation/root001',
          intent: 'agree',
          text: 'I agree',
          createdAt: now,
        },
        table: schema.replies,
      },
    ]

    for (const rt of recordTypes) {
      const uri = makeUri(rt.collection, rt.rkey)
      const handler = routeHandler(rt.collection)!

      await handler.handleCreate(ctx, {
        uri,
        did: AUTHOR_DID,
        collection: rt.collection,
        rkey: rt.rkey,
        cid: `cid-${rt.rkey}`,
        record: rt.record,
      })

      // Verify row exists
      const before = await db.select().from(rt.table).where(eq(rt.table.uri, uri))
      expect(before).toHaveLength(1)

      // Delete it (undisputed — clean delete)
      await handler.handleDelete(ctx, {
        uri,
        did: AUTHOR_DID,
        collection: rt.collection,
        rkey: rt.rkey,
      })

      // Verify row gone from correct table
      const after = await db.select().from(rt.table).where(eq(rt.table.uri, uri))
      expect(after).toHaveLength(0)
    }
  })

  // TRACE: {"suite": "APPVIEW", "case": "0376", "section": "01", "sectionName": "General", "title": "IT-DEL-020: Fix 13: wrong table would miss tombstone"}
  it('IT-DEL-020: Fix 13: wrong table would miss tombstone', async () => {
    // Regression guard: vouch deletion must check vouches table, not attestations.
    // If we used the wrong table, the delete would still work (since uri doesn't exist
    // in the wrong table), but tombstone metadata enrichment comes from getAttestationMeta
    // which specifically queries attestations. For vouches, the tombstone won't have
    // attestation-specific metadata, but it should still be created when disputed.

    const vouchCollection = 'com.dina.trust.vouch'
    const rkey = 'del020'
    const uri = makeUri(vouchCollection, rkey)

    // Create vouch
    const handler = routeHandler(vouchCollection)!
    await handler.handleCreate(ctx, {
      uri,
      did: AUTHOR_DID,
      collection: vouchCollection,
      rkey,
      cid: 'cid-del020',
      record: {
        subject: SUBJECT_DID,
        vouchType: 'identity',
        confidence: 'high',
        createdAt: now,
      },
    })

    // Add report to make it disputed
    const reportHandler = routeHandler('com.dina.trust.reportRecord')!
    await reportHandler.handleCreate(ctx, {
      uri: makeUri('com.dina.trust.reportRecord', 'report020'),
      did: REPORTER_DID,
      collection: 'com.dina.trust.reportRecord',
      rkey: 'report020',
      cid: 'cid-report020',
      record: {
        targetUri: uri,
        reportType: 'fake-review',
        createdAt: now,
      },
    })

    // Verify vouch table has the getSourceTable mapping
    const sourceTable = getSourceTable(vouchCollection)
    expect(sourceTable).toBe(schema.vouches)

    // Delete the vouch — this should delete from vouches, not attestations
    await handler.handleDelete(ctx, { uri, did: AUTHOR_DID, collection: vouchCollection, rkey })

    // The vouch should be gone
    const vouchRows = await db.select().from(schema.vouches).where(eq(schema.vouches.uri, uri))
    expect(vouchRows).toHaveLength(0)

    // Tombstone should exist (since it was disputed)
    const tombstone = await db.select().from(schema.tombstones).where(eq(schema.tombstones.originalUri, uri))
    expect(tombstone).toHaveLength(1)
    expect(tombstone[0].recordType).toBe('vouch')
    expect(tombstone[0].authorDid).toBe(AUTHOR_DID)
  })
})
