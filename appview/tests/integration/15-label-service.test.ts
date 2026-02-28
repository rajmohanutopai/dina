/**
 * Section 15 -- Label Service
 * Total tests: 6
 * Plan traceability: IT-LBL-001 .. IT-LBL-006
 *
 * Subsection:
 *   15.1 Label Detectors
 *
 * Source: INTEGRATION_TEST_PLAN.md
 *
 * These tests verify that problematic review patterns are detectable
 * via database queries. We insert records using the real handlers, then
 * run SQL queries to detect the patterns (correlated timing, AI-generated,
 * self-promotion, coordinated reviews, conflict of interest, and clean reviews).
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { getTestDb, cleanAllTables, closeTestDb, createTestHandlerContext } from '../test-db'
import { sql } from 'drizzle-orm'
import { routeHandler } from '@/ingester/handlers/index'

const db = getTestDb()
const ctx = createTestHandlerContext(db)

beforeEach(async () => {
  await cleanAllTables(db)
})

afterAll(async () => {
  await closeTestDb()
})

/** Helper: insert an attestation via handler */
async function insertAttestation(opts: {
  uri: string
  did: string
  subjectName: string
  subjectType?: string
  subjectDid?: string
  sentiment?: string
  category?: string
  text?: string
  isAgentGenerated?: boolean
  createdAt?: string
}) {
  const handler = routeHandler('com.dina.trust.attestation')!
  const subjectRef: Record<string, unknown> = {
    type: opts.subjectType ?? 'product',
    name: opts.subjectName,
  }
  if (opts.subjectDid) {
    subjectRef.type = 'did'
    subjectRef.did = opts.subjectDid
  }

  await handler.handleCreate(ctx, {
    uri: opts.uri,
    did: opts.did,
    collection: 'com.dina.trust.attestation',
    rkey: opts.uri.split('/').pop()!,
    cid: `cid-${opts.uri.replace(/[^a-z0-9]/gi, '')}`,
    record: {
      subject: subjectRef,
      category: opts.category ?? 'service',
      sentiment: opts.sentiment ?? 'positive',
      text: opts.text ?? 'A review',
      isAgentGenerated: opts.isAgentGenerated ?? false,
      createdAt: opts.createdAt ?? new Date().toISOString(),
    },
  })
}

/** Helper: insert a delegation via handler */
async function insertDelegation(opts: {
  uri: string
  authorDid: string
  subjectDid: string
}) {
  const handler = routeHandler('com.dina.trust.delegation')!
  await handler.handleCreate(ctx, {
    uri: opts.uri,
    did: opts.authorDid,
    collection: 'com.dina.trust.delegation',
    rkey: opts.uri.split('/').pop()!,
    cid: `cid-${opts.uri.replace(/[^a-z0-9]/gi, '')}`,
    record: {
      subject: opts.subjectDid,
      scope: 'review',
      permissions: ['write'],
      createdAt: new Date().toISOString(),
    },
  })
}

describe('15.1 Label Detectors', () => {
  it('IT-LBL-001: fake-review detector -- correlated timing', async () => {
    // Insert N attestations from different DIDs for same subject within minutes
    // Use subjectDid so all attestations resolve to the same Tier 1 subject
    const baseTime = new Date()
    const subjectDid = 'did:plc:suspiciousRestaurant'

    for (let i = 0; i < 10; i++) {
      const createdAt = new Date(baseTime.getTime() + i * 30_000) // 30 seconds apart
      await insertAttestation({
        uri: `at://did:plc:reviewer${i}/com.dina.trust.attestation/lbl001-${i}`,
        did: `did:plc:reviewer${i}`,
        subjectName: 'Suspicious Restaurant',
        subjectDid,
        sentiment: 'positive',
        createdAt: createdAt.toISOString(),
      })
    }

    // Detect temporal correlation: query for subjects with many attestations
    // from different DIDs within a short time window
    const result = await db.execute(sql`
      SELECT
        subject_id,
        count(DISTINCT author_did) as unique_authors,
        count(*) as total_reviews,
        max(record_created_at) - min(record_created_at) as time_span
      FROM attestations
      GROUP BY subject_id
      HAVING count(*) >= 5
        AND count(DISTINCT author_did) >= 5
        AND (max(record_created_at) - min(record_created_at)) < interval '10 minutes'
    `)

    const rows = (result as any).rows
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(Number(rows[0].unique_authors)).toBe(10)
    expect(Number(rows[0].total_reviews)).toBe(10)
  })

  it('IT-LBL-002: ai-generated detector -- undisclosed', async () => {
    // Insert attestations with isAgentGenerated=true
    for (let i = 0; i < 5; i++) {
      await insertAttestation({
        uri: `at://did:plc:aigenDid/com.dina.trust.attestation/lbl002-${i}`,
        did: 'did:plc:aigenDid',
        subjectName: `Product ${i}`,
        isAgentGenerated: true,
      })
    }

    // Detect AI-generated: query for authors with high AI-generated rate
    const result = await db.execute(sql`
      SELECT
        author_did,
        count(*) FILTER (WHERE is_agent_generated = true) as ai_count,
        count(*) as total_count,
        round(count(*) FILTER (WHERE is_agent_generated = true)::numeric / count(*)::numeric, 2) as ai_rate
      FROM attestations
      GROUP BY author_did
      HAVING count(*) FILTER (WHERE is_agent_generated = true) > 0
    `)

    const rows = (result as any).rows
    expect(rows.length).toBeGreaterThanOrEqual(1)

    const authorRow = rows.find((r: any) => r.author_did === 'did:plc:aigenDid')
    expect(authorRow).toBeDefined()
    expect(Number(authorRow.ai_count)).toBe(5)
    expect(Number(authorRow.ai_rate)).toBe(1.0) // 100% AI-generated
  })

  it('IT-LBL-003: self-promotion detector', async () => {
    // Author reviewing their own DID
    const selfDid = 'did:plc:selfPromoter'
    await insertAttestation({
      uri: `at://${selfDid}/com.dina.trust.attestation/lbl003`,
      did: selfDid,
      subjectName: selfDid,
      subjectDid: selfDid,
      sentiment: 'positive',
      text: 'I am amazing',
    })

    // Detect self-promotion: author_did matches subject DID
    // The attestation handler stores subject as a DID type subject
    // We can detect this by joining attestations with subjects where subjects.did = author_did
    const result = await db.execute(sql`
      SELECT
        a.uri,
        a.author_did,
        s.did as subject_did
      FROM attestations a
      JOIN subjects s ON a.subject_id = s.id
      WHERE s.did IS NOT NULL
        AND a.author_did = s.did
    `)

    const rows = (result as any).rows
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0].author_did).toBe(selfDid)
    expect(rows[0].subject_did).toBe(selfDid)
  })

  it('IT-LBL-004: coordinated detector', async () => {
    // Group of DIDs all reviewing same subject (use subjectDid for Tier 1 resolution)
    const targetSubjectDid = 'did:plc:coordinatedTarget'
    const coordinatedDids = Array.from({ length: 8 }, (_, i) => `did:plc:coord${i}`)

    for (let i = 0; i < coordinatedDids.length; i++) {
      await insertAttestation({
        uri: `at://${coordinatedDids[i]}/com.dina.trust.attestation/lbl004-${i}`,
        did: coordinatedDids[i],
        subjectName: 'Coordinated Target Product',
        subjectDid: targetSubjectDid,
        sentiment: 'positive',
        text: 'Wonderful product, highly recommend!',
      })
    }

    // Detect coordinated: many unique DIDs reviewing same subject with same sentiment
    const result = await db.execute(sql`
      SELECT
        subject_id,
        sentiment,
        count(DISTINCT author_did) as coordinated_count
      FROM attestations
      GROUP BY subject_id, sentiment
      HAVING count(DISTINCT author_did) >= 5
    `)

    const rows = (result as any).rows
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(Number(rows[0].coordinated_count)).toBe(8)
    expect(rows[0].sentiment).toBe('positive')
  })

  it('IT-LBL-005: conflict-of-interest detector', async () => {
    // Author has delegation from subject DID
    const authorDid = 'did:plc:conflictAuthor'
    const subjectDid = 'did:plc:conflictSubject'

    // Create delegation: subjectDid grants delegation to authorDid
    await insertDelegation({
      uri: `at://${subjectDid}/com.dina.trust.delegation/lbl005`,
      authorDid: subjectDid,
      subjectDid: authorDid,
    })

    // Author reviews the subject DID
    await insertAttestation({
      uri: `at://${authorDid}/com.dina.trust.attestation/lbl005`,
      did: authorDid,
      subjectName: subjectDid,
      subjectDid: subjectDid,
      sentiment: 'positive',
      text: 'This person is great',
    })

    // Detect conflict of interest: author has delegation from the subject's DID
    const result = await db.execute(sql`
      SELECT
        a.uri as attestation_uri,
        a.author_did,
        d.author_did as delegator_did,
        d.subject_did as delegate_did
      FROM attestations a
      JOIN subjects s ON a.subject_id = s.id
      JOIN delegations d ON (
        (d.author_did = s.did AND d.subject_did = a.author_did)
        OR
        (d.subject_did = s.did AND d.author_did = a.author_did)
      )
      WHERE s.did IS NOT NULL
    `)

    const rows = (result as any).rows
    expect(rows.length).toBeGreaterThanOrEqual(1)
    // Verify the conflict exists
    const conflictRow = rows[0]
    expect(conflictRow.author_did).toBe(authorDid)
  })

  it('IT-LBL-006: no labels for clean reviews', async () => {
    // Normal, diverse, independent reviews spread over time
    const diverseDids = Array.from({ length: 5 }, (_, i) => `did:plc:clean${i}`)
    const diverseSubjects = Array.from({ length: 5 }, (_, i) => `Clean Product ${i}`)

    for (let i = 0; i < 5; i++) {
      const createdAt = new Date(Date.now() - i * 86400_000) // 1 day apart
      await insertAttestation({
        uri: `at://${diverseDids[i]}/com.dina.trust.attestation/lbl006-${i}`,
        did: diverseDids[i],
        subjectName: diverseSubjects[i], // Different subjects
        sentiment: i % 2 === 0 ? 'positive' : 'neutral', // Mixed sentiment
        isAgentGenerated: false,
        createdAt: createdAt.toISOString(),
      })
    }

    // Check: no temporal correlation (each subject has only 1 review)
    const temporalResult = await db.execute(sql`
      SELECT subject_id, count(*) as cnt
      FROM attestations
      GROUP BY subject_id
      HAVING count(*) >= 5
    `)
    expect((temporalResult as any).rows.length).toBe(0)

    // Check: no self-promotion
    const selfPromoResult = await db.execute(sql`
      SELECT a.uri FROM attestations a
      JOIN subjects s ON a.subject_id = s.id
      WHERE s.did IS NOT NULL AND a.author_did = s.did
        AND a.author_did LIKE 'did:plc:clean%'
    `)
    expect((selfPromoResult as any).rows.length).toBe(0)

    // Check: no AI-generated
    const aiResult = await db.execute(sql`
      SELECT count(*) as cnt FROM attestations
      WHERE is_agent_generated = true
        AND author_did LIKE 'did:plc:clean%'
    `)
    expect(Number((aiResult as any).rows[0].cnt)).toBe(0)

    // Check: no conflict of interest (no delegations)
    const conflictResult = await db.execute(sql`
      SELECT count(*) as cnt FROM delegations
      WHERE author_did LIKE 'did:plc:clean%' OR subject_did LIKE 'did:plc:clean%'
    `)
    expect(Number((conflictResult as any).rows[0].cnt)).toBe(0)
  })
})
