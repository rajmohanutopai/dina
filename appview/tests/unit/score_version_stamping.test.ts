/**
 * Unit tests for `score_version='v1'` stamping (TN-SCORE-002 /
 * Plan §13.7).
 *
 * Contract:
 *   - subject_scores table has scoreVersion column with default 'v1'
 *   - did_profiles table has scoreVersion column with default 'v1'
 *   - dirty-flags upserts stamp 'v1' explicitly on insert
 *   - refresh-subject-scores update sets scoreVersion='v1'
 *   - refresh-profiles update sets scoreVersion='v1'
 *   - refresh-reviewer-stats update sets scoreVersion='v1'
 *   - decay-scores update sets scoreVersion='v1'
 *   - process-tombstones update sets scoreVersion='v1'
 *
 * The schema-level test ensures the column exists with the expected
 * default. The behavioural tests use a stub DB that captures the
 * SET payload passed to `db.update(...).set(...)` and asserts
 * scoreVersion is in there.
 */

import { describe, expect, it, vi } from 'vitest'
import { didProfiles, reviewerNamespaceScores, subjectScores } from '@/db/schema/index'
import type { DrizzleDB } from '@/db/connection'

describe('schema — TN-SCORE-002 column shape', () => {
  // Drizzle exposes column metadata directly on the table object,
  // keyed by the JS property name (camelCase). Presence of the
  // property is the contract; the runtime guarantees default 'v1'
  // (set in the schema declaration).

  it('subjectScores has scoreVersion column', () => {
    expect((subjectScores as unknown as Record<string, unknown>).scoreVersion).toBeDefined()
  })

  it('didProfiles has scoreVersion column', () => {
    expect((didProfiles as unknown as Record<string, unknown>).scoreVersion).toBeDefined()
  })
})

/**
 * Stub `db.update(table).set(value).where(...)` chain that captures
 * the SET payload for assertions. Multiple updates are appended.
 */
interface UpdateCapture {
  setPayloads: Array<{ table: 'subjectScores' | 'didProfiles' | 'reviewerNamespaceScores' | 'unknown'; value: Record<string, unknown> }>
}

function tableLabel(t: unknown): UpdateCapture['setPayloads'][number]['table'] {
  if (t === subjectScores) return 'subjectScores'
  if (t === didProfiles) return 'didProfiles'
  if (t === reviewerNamespaceScores) return 'reviewerNamespaceScores'
  return 'unknown'
}

function stubUpdateCapturingDb(capture: UpdateCapture): DrizzleDB {
  return {
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => {
        capture.setPayloads.push({ table: tableLabel(table), value })
        return {
          where: async () => undefined,
        }
      },
    }),
  } as unknown as DrizzleDB
}

/**
 * Stub `db.insert(table).values(value).onConflictDoUpdate(...)` chain
 * for dirty-flags' upsert pattern.
 */
interface InsertCapture {
  inserts: Array<{
    table: ReturnType<typeof tableLabel>
    values: Record<string, unknown> | Record<string, unknown>[]
  }>
}

function stubInsertCapturingDb(capture: InsertCapture): DrizzleDB {
  return {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        capture.inserts.push({ table: tableLabel(table), values })
        return {
          onConflictDoUpdate: async () => undefined,
        }
      },
    }),
  } as unknown as DrizzleDB
}

describe('dirty-flags — TN-SCORE-002 explicit V1 stamping on insert', () => {
  it('subjectScores upsert carries scoreVersion: v1', async () => {
    const capture: InsertCapture = { inserts: [] }
    const db = stubInsertCapturingDb(capture)
    const { markDirty } = await import('@/db/queries/dirty-flags')
    await markDirty(db, {
      subjectId: 'sub_x',
      authorDid: 'did:plc:author',
    })
    const subjectInsert = capture.inserts.find((i) => i.table === 'subjectScores')
    expect(subjectInsert).toBeDefined()
    expect(subjectInsert!.values).toMatchObject({
      subjectId: 'sub_x',
      scoreVersion: 'v1',
      needsRecalc: true,
    })
  })

  it('didProfiles batch upsert carries scoreVersion: v1 on every row', async () => {
    const capture: InsertCapture = { inserts: [] }
    const db = stubInsertCapturingDb(capture)
    const { markDirty } = await import('@/db/queries/dirty-flags')
    await markDirty(db, {
      subjectId: null,
      authorDid: 'did:plc:author',
      mentionedDids: [{ did: 'did:plc:m1' }, { did: 'did:plc:m2' }],
    })
    const profileInsert = capture.inserts.find((i) => i.table === 'didProfiles')
    expect(profileInsert).toBeDefined()
    expect(Array.isArray(profileInsert!.values)).toBe(true)
    const rows = profileInsert!.values as Record<string, unknown>[]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.scoreVersion).toBe('v1')
    }
  })

  it('subjectId=null skips subjectScores insert (defensive)', async () => {
    const capture: InsertCapture = { inserts: [] }
    const db = stubInsertCapturingDb(capture)
    const { markDirty } = await import('@/db/queries/dirty-flags')
    await markDirty(db, {
      subjectId: null,
      authorDid: 'did:plc:author',
    })
    const subjectInsert = capture.inserts.find((i) => i.table === 'subjectScores')
    expect(subjectInsert).toBeUndefined()
  })
})

describe('dirty-flags — TN-SCORE-001 namespace propagation', () => {
  // The TN-SCORE-001 extension adds the WRITE PATH for the
  // `reviewer_namespace_scores` table. When a record carries
  // `authorNamespace`, an extra upsert lands in addition to the
  // root-identity didProfiles upsert. Without this, the
  // `refresh-reviewer-namespace-stats` job would never see anything
  // to drain.

  it('authorNamespace=null/undefined: NO insert into reviewer_namespace_scores (V1 majority path)', async () => {
    const capture: InsertCapture = { inserts: [] }
    const db = stubInsertCapturingDb(capture)
    const { markDirty } = await import('@/db/queries/dirty-flags')
    await markDirty(db, {
      subjectId: 'sub_x',
      authorDid: 'did:plc:author',
      // authorNamespace omitted
    })
    const namespaceInsert = capture.inserts.find(
      (i) => i.table === 'reviewerNamespaceScores',
    )
    expect(namespaceInsert).toBeUndefined()
  })

  it('authorNamespace="namespace_3": INSERT into reviewer_namespace_scores with V1 stamp', async () => {
    const capture: InsertCapture = { inserts: [] }
    const db = stubInsertCapturingDb(capture)
    const { markDirty } = await import('@/db/queries/dirty-flags')
    await markDirty(db, {
      subjectId: 'sub_x',
      authorDid: 'did:plc:author',
      authorNamespace: 'namespace_3',
    })
    const namespaceInsert = capture.inserts.find(
      (i) => i.table === 'reviewerNamespaceScores',
    )
    expect(namespaceInsert).toBeDefined()
    expect(namespaceInsert!.values).toMatchObject({
      did: 'did:plc:author',
      namespace: 'namespace_3',
      scoreVersion: 'v1',
      needsRecalc: true,
    })
  })

  it('authorNamespace=empty string: NO insert (treated as no-namespace path)', async () => {
    // Empty string is falsy + not a valid namespace per the
    // record-validator's `min(1)` bound. Treating it as "no namespace"
    // matches the protocol contract.
    const capture: InsertCapture = { inserts: [] }
    const db = stubInsertCapturingDb(capture)
    const { markDirty } = await import('@/db/queries/dirty-flags')
    await markDirty(db, {
      subjectId: 'sub_x',
      authorDid: 'did:plc:author',
      authorNamespace: '',
    })
    const namespaceInsert = capture.inserts.find(
      (i) => i.table === 'reviewerNamespaceScores',
    )
    expect(namespaceInsert).toBeUndefined()
  })

  it('namespace insert is INDEPENDENT of subjectId (works even with null subject)', async () => {
    // A record without a subject (e.g. an endorsement with the
    // recipient as the only target) still flags its namespace.
    const capture: InsertCapture = { inserts: [] }
    const db = stubInsertCapturingDb(capture)
    const { markDirty } = await import('@/db/queries/dirty-flags')
    await markDirty(db, {
      subjectId: null,
      authorDid: 'did:plc:author',
      authorNamespace: 'namespace_0',
    })
    const namespaceInsert = capture.inserts.find(
      (i) => i.table === 'reviewerNamespaceScores',
    )
    expect(namespaceInsert).toBeDefined()
    expect(namespaceInsert!.values).toMatchObject({
      did: 'did:plc:author',
      namespace: 'namespace_0',
      scoreVersion: 'v1',
    })
  })

  it('schema: reviewerNamespaceScores has scoreVersion column', () => {
    expect((reviewerNamespaceScores as unknown as Record<string, unknown>).scoreVersion).toBeDefined()
  })
})

describe('decay-scores — TN-SCORE-002 explicit V1 stamping on update', () => {
  it('didProfiles + subjectScores updates both carry scoreVersion: v1', async () => {
    const capture: UpdateCapture = { setPayloads: [] }
    const db = stubUpdateCapturingDb(capture)
    const { decayScores } = await import('@/scorer/jobs/decay-scores')
    await decayScores(db)
    const profilePayload = capture.setPayloads.find((p) => p.table === 'didProfiles')
    const subjectPayload = capture.setPayloads.find((p) => p.table === 'subjectScores')
    expect(profilePayload?.value.scoreVersion).toBe('v1')
    expect(subjectPayload?.value.scoreVersion).toBe('v1')
  })
})

/**
 * Source-text guard for the four scorer-job UPDATE call sites
 * (refresh-subject-scores, refresh-profiles, refresh-reviewer-stats,
 * process-tombstones). Each is a multi-DB-call job whose full flow
 * is hard to stub at unit scope without re-writing the planner.
 * Integration tests exercise the real writes (`tests/integration/
 * 09-scorer-jobs.test.ts`); here we settle for a literal-source
 * check that the SET payload mentions scoreVersion: 'v1'.
 *
 * This guards against an accidental drop on rebase/refactor — a
 * future contributor removing the line without realizing it's the
 * V1-stamp contract would trip this test before the integration
 * suite even runs.
 */
import { readFileSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'

describe('scorer jobs — TN-SCORE-002 source-text guard for V1 stamp', () => {
  const srcRoot = pathResolve(__dirname, '../../src/scorer/jobs')

  for (const file of [
    'refresh-subject-scores.ts',
    'refresh-profiles.ts',
    'refresh-reviewer-stats.ts',
    'process-tombstones.ts',
  ]) {
    it(`${file} contains scoreVersion: 'v1' in a SET clause`, () => {
      const text = readFileSync(`${srcRoot}/${file}`, 'utf8')
      // Defensive contract: the literal must appear inside an UPDATE
      // chain. Looser than a full AST check; tighter than nothing.
      expect(text).toContain(".set({")
      expect(text).toMatch(/scoreVersion:\s*'v1'/)
    })
  }
})
