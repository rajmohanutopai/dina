/**
 * Section 12 -- Dirty Flags Integration
 * Total tests: 9
 * Plan traceability: IT-DF-001 .. IT-DF-009
 *
 * Traces to: Architecture "Incremental Dirty-Flag Scoring", Fix 9
 *
 * Source: INTEGRATION_TEST_PLAN.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { markDirty } from '@/db/queries/dirty-flags'
import { didProfiles, subjectScores, subjects } from '@/db/schema/index'
import { getTestDb, cleanTables, closeTestDb, type TestDB } from '../test-db'
import { refreshProfiles } from '@/scorer/jobs/refresh-profiles'

let db: TestDB

beforeAll(async () => {
  db = getTestDb()
  // Clean tables once before all tests in this file
  await cleanTables(db, 'subject_scores', 'did_profiles', 'subjects')
})

afterAll(async () => {
  await closeTestDb()
})

describe('12 Dirty Flags Integration', () => {
  it('IT-DF-001: markDirty -- creates subject_scores row if not exists', async () => {
    // Description: New subject
    // Expected: subject_scores row with needs_recalc = true

    // Create the subject first (FK constraint)
    await db.insert(subjects).values({
      id: 'sub-df-001',
      name: 'Test Subject',
      subjectType: 'product',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await markDirty(db as any, {
      subjectId: 'sub-df-001',
      authorDid: 'did:plc:df001-author',
    })

    const rows = await db.select().from(subjectScores).where(eq(subjectScores.subjectId, 'sub-df-001'))
    expect(rows.length).toBe(1)
    expect(rows[0].needsRecalc).toBe(true)
  })

  it('IT-DF-002: markDirty -- creates did_profiles row if not exists', async () => {
    // Description: New DID
    // Expected: did_profiles row with needs_recalc = true
    await markDirty(db as any, {
      subjectId: null,
      authorDid: 'did:plc:df002-newauthor',
    })

    const rows = await db.select().from(didProfiles).where(eq(didProfiles.did, 'did:plc:df002-newauthor'))
    expect(rows.length).toBe(1)
    expect(rows[0].needsRecalc).toBe(true)
  })

  it('IT-DF-003: markDirty -- sets existing row dirty', async () => {
    // Description: Profile with needs_recalc = false
    // Expected: Flipped to true
    const testDid = 'did:plc:df003-existing'

    // Pre-create a profile with needs_recalc = false
    await db.insert(didProfiles).values({
      did: testDid,
      needsRecalc: false,
      computedAt: new Date(),
    })

    // Verify it starts as false
    const before = await db.select().from(didProfiles).where(eq(didProfiles.did, testDid))
    expect(before[0].needsRecalc).toBe(false)

    // Mark dirty
    await markDirty(db as any, {
      subjectId: null,
      authorDid: testDid,
    })

    // Verify it flipped to true
    const after = await db.select().from(didProfiles).where(eq(didProfiles.did, testDid))
    expect(after[0].needsRecalc).toBe(true)
  })

  it('IT-DF-004: markDirty -- author always marked', async () => {
    // Description: Any attestation
    // Expected: Author's profile dirty
    const testDid = 'did:plc:df004-author-always'

    await markDirty(db as any, {
      subjectId: null,
      authorDid: testDid,
    })

    const rows = await db.select().from(didProfiles).where(eq(didProfiles.did, testDid))
    expect(rows.length).toBe(1)
    expect(rows[0].needsRecalc).toBe(true)
  })

  it('IT-DF-005: markDirty -- subject DID marked (when DID type)', async () => {
    // Description: Attestation about did:plc:xyz
    // Expected: did_profiles for xyz dirty
    const authorDid = 'did:plc:df005-author'
    const subjectDid = 'did:plc:df005-subject'

    await markDirty(db as any, {
      subjectId: null,
      authorDid,
      subjectDid,
    })

    const subjectProfile = await db.select().from(didProfiles).where(eq(didProfiles.did, subjectDid))
    expect(subjectProfile.length).toBe(1)
    expect(subjectProfile[0].needsRecalc).toBe(true)

    // Author should also be marked
    const authorProfile = await db.select().from(didProfiles).where(eq(didProfiles.did, authorDid))
    expect(authorProfile.length).toBe(1)
    expect(authorProfile[0].needsRecalc).toBe(true)
  })

  it('IT-DF-006: markDirty -- cosigner marked', async () => {
    // Description: Attestation with coSignature.did
    // Expected: Cosigner's profile dirty
    const authorDid = 'did:plc:df006-author'
    const cosignerDid = 'did:plc:df006-cosigner'

    await markDirty(db as any, {
      subjectId: null,
      authorDid,
      cosignerDid,
    })

    const cosignerProfile = await db.select().from(didProfiles).where(eq(didProfiles.did, cosignerDid))
    expect(cosignerProfile.length).toBe(1)
    expect(cosignerProfile[0].needsRecalc).toBe(true)
  })

  it('IT-DF-007: markDirty -- mentioned DIDs marked', async () => {
    // Description: Attestation with 3 mentions
    // Expected: All 3 mentioned DID profiles dirty
    const authorDid = 'did:plc:df007-author'
    const mentions = [
      'did:plc:df007-mention1',
      'did:plc:df007-mention2',
      'did:plc:df007-mention3',
    ]

    await markDirty(db as any, {
      subjectId: null,
      authorDid,
      mentionedDids: mentions.map(did => ({ did })),
    })

    for (const mentionDid of mentions) {
      const rows = await db.select().from(didProfiles).where(eq(didProfiles.did, mentionDid))
      expect(rows.length).toBe(1)
      expect(rows[0].needsRecalc).toBe(true)
    }
  })

  it('IT-DF-008: markDirty -- subject_scores marked', async () => {
    // Description: Attestation for subject S
    // Expected: subject_scores for S dirty
    const subId = 'sub-df-008'

    // Create the subject first
    await db.insert(subjects).values({
      id: subId,
      name: 'Subject Eight',
      subjectType: 'service',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    // Pre-create subject_scores with needs_recalc = false
    await db.insert(subjectScores).values({
      subjectId: subId,
      needsRecalc: false,
      computedAt: new Date(),
    })

    const before = await db.select().from(subjectScores).where(eq(subjectScores.subjectId, subId))
    expect(before[0].needsRecalc).toBe(false)

    await markDirty(db as any, {
      subjectId: subId,
      authorDid: 'did:plc:df008-author',
    })

    const after = await db.select().from(subjectScores).where(eq(subjectScores.subjectId, subId))
    expect(after[0].needsRecalc).toBe(true)
  })

  it('IT-DF-009: cascade: attestation -> dirty -> scorer refresh -> clean', async () => {
    // Description: Full cycle
    // Expected: Profile starts dirty, ends clean after scorer run
    const testDid = 'did:plc:df009-cascade'

    // Mark a DID dirty
    await markDirty(db as any, {
      subjectId: null,
      authorDid: testDid,
    })

    // Verify dirty
    const dirtyRows = await db.select().from(didProfiles).where(eq(didProfiles.did, testDid))
    expect(dirtyRows.length).toBe(1)
    expect(dirtyRows[0].needsRecalc).toBe(true)

    // Run the scorer refresh
    await refreshProfiles(db as any)

    // Verify clean after scorer run
    const cleanRows = await db.select().from(didProfiles).where(eq(didProfiles.did, testDid))
    expect(cleanRows.length).toBe(1)
    expect(cleanRows[0].needsRecalc).toBe(false)
  })
})
