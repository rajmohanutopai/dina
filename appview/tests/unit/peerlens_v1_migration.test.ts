/**
 * Tests for the consolidated trust_v1 idempotent migration (TN-DB-010).
 *
 * **Contract**:
 *   - `appview/drizzle/0000_trust_v1.sql` is a single, idempotent
 *     migration that creates the entire trust_v1 schema (34 tables, all
 *     indexes, the 2 cross-table FK constraints, and the FTS DDL from
 *     `db/fts_columns.ts`).
 *   - `appview/drizzle/0000_trust_v1.down.sql` is its reverse — drops
 *     every table in FK-safe order using `DROP TABLE IF EXISTS`.
 *   - Re-running the up migration on a fully-applied DB MUST be a no-op
 *     (Postgres returns NOTICE, not ERROR). Re-running the down on an
 *     empty DB MUST also be a no-op.
 *
 * **Why a parser test, not a Postgres-roundtrip test**: the actual
 * up + down + up cycle is exercised by the migration runner against a
 * real PG instance in the system suite. At unit scope we settle for a
 * literal-source test that pins the structural invariants — every
 * write of a non-idempotent SQL statement (a missing IF NOT EXISTS, a
 * dropped FK constraint guard, a forgotten table in the down list) is
 * caught here BEFORE the system suite even runs.
 *
 * **Trade-off**: a test that parses SQL with regex is brittle to white-
 * space changes. We accept that — drizzle-kit emits stable formatting,
 * and a deliberate refactor of the migration's whitespace is a real
 * code change worth a deliberate test update.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'

const drizzleRoot = pathResolve(__dirname, '../../drizzle')
const upPath = `${drizzleRoot}/0000_trust_v1.sql`
const downPath = `${drizzleRoot}/0000_trust_v1.down.sql`

const upSql = readFileSync(upPath, 'utf8')
const downSql = readFileSync(downPath, 'utf8')

/**
 * The full set of trust_v1 tables. If the schema declares a new table,
 * this list MUST grow — the test fails as a forcing function so the
 * down migration learns to drop the new table too. Pulled from the
 * drizzle-kit-generated up migration as the authoritative source for
 * the V1 set.
 */
const EXPECTED_TABLES: readonly string[] = Object.freeze([
  'amendments',
  'anomaly_events',
  'appview_config',
  'attestations',
  'collections',
  'comparisons',
  'cosig_requests',
  'delegations',
  'did_profiles',
  'domain_scores',
  'endorsements',
  'flags',
  'ingest_rejections',
  'ingester_cursor',
  'media',
  'mention_edges',
  'notification_prefs',
  'reactions',
  'replies',
  'report_records',
  'review_requests',
  'reviewer_namespace_scores',
  'revocations',
  'services',
  'subject_claims',
  'subject_scores',
  'subjects',
  'suspended_pds_hosts',
  'tombstones',
  'trust_edges',
  'trust_policies',
  'trust_v1_params',
  'verifications',
  'vouches',
])

describe('trust_v1 up migration — TN-DB-010 structural invariants', () => {
  it('creates exactly the expected 34 tables', () => {
    const matches = upSql.match(/CREATE TABLE IF NOT EXISTS "([^"]+)"/g) ?? []
    const created = matches
      .map((m) => /CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(m)?.[1])
      .filter((t): t is string => Boolean(t))
      .sort()
    expect(created).toEqual([...EXPECTED_TABLES].sort())
  })

  it('every CREATE TABLE uses IF NOT EXISTS (idempotent)', () => {
    // Find raw `CREATE TABLE "name"` (without IF NOT EXISTS). Should
    // be zero — drizzle-kit's default is non-idempotent and TN-DB-010
    // sed-transforms every emitted CREATE TABLE.
    const nonIdempotent = upSql.match(/^CREATE TABLE "[^"]+"/gm) ?? []
    expect(nonIdempotent).toEqual([])
  })

  it('every CREATE INDEX (incl. UNIQUE) uses IF NOT EXISTS (idempotent)', () => {
    // Two patterns: `CREATE INDEX "name"` and `CREATE UNIQUE INDEX "name"`,
    // both without IF NOT EXISTS. Should be zero.
    const nonIdempotent =
      upSql.match(/^CREATE (?:UNIQUE )?INDEX "[^"]+"/gm) ?? []
    expect(nonIdempotent).toEqual([])
  })

  it('every ALTER TABLE ADD CONSTRAINT is wrapped in a pg_constraint guard', () => {
    // Bare `ALTER TABLE ... ADD CONSTRAINT` would fail on re-run with
    // "already exists". Idempotent shape: each one inside a `DO $$
    // BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    // '<name>') THEN ALTER TABLE ... ; END IF; END $$;` block.
    const bareAdds =
      upSql.match(/^ALTER TABLE "[^"]+" ADD CONSTRAINT/gm) ?? []
    expect(bareAdds).toEqual([])

    const guards =
      upSql.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname/g) ?? []
    expect(guards.length).toBeGreaterThanOrEqual(2)
  })

  it('FTS DDL is appended (search_vector + search_tsv + GIN indexes)', () => {
    // TN-DB-009 lives in `src/db/fts_columns.ts`; the consolidated
    // migration mirrors it. Pin the four statements so a future change
    // to fts_columns.ts MUST also update the consolidated migration.
    expect(upSql).toMatch(
      /ALTER TABLE attestations ADD COLUMN IF NOT EXISTS search_vector tsvector/,
    )
    expect(upSql).toMatch(/idx_attestations_search.*USING GIN \(search_vector\)/s)
    expect(upSql).toMatch(
      /ALTER TABLE subjects ADD COLUMN IF NOT EXISTS search_tsv tsvector/,
    )
    expect(upSql).toMatch(/idx_subjects_search.*USING GIN \(search_tsv\)/s)
  })

  it('FTS columns use English dictionary + coalesce for NULL safety', () => {
    // Two key invariants for the FTS surface (TN-DB-009 contract):
    //   1. dictionary is `'english'` (V1 cohort assumption)
    //   2. expression wraps source column in `coalesce(<col>, '')` so
    //      NULL values yield an empty tsvector (which the GIN index
    //      can still match against an empty `@@` predicate without a
    //      sequential scan).
    expect(upSql).toMatch(
      /to_tsvector\('english', coalesce\(search_content, ''\)\)/,
    )
    expect(upSql).toMatch(/to_tsvector\('english', coalesce\(name, ''\)\)/)
  })

  it('reviewer_namespace_scores is in the migration (TN-DB-002)', () => {
    // Sanity check that TN-DB-002's per-namespace stats table is part
    // of the consolidated baseline. This was the table TN-SCORE-001
    // landed against — without it the scorer job has nothing to drain.
    expect(upSql).toMatch(/CREATE TABLE IF NOT EXISTS "reviewer_namespace_scores"/)
  })
})

describe('trust_v1 down migration — TN-DB-010 reverse-FK safety', () => {
  it('drops every table created by the up migration', () => {
    const matches = downSql.match(/DROP TABLE IF EXISTS "([^"]+)"/g) ?? []
    const dropped = matches
      .map((m) => /DROP TABLE IF EXISTS "([^"]+)"/.exec(m)?.[1])
      .filter((t): t is string => Boolean(t))
      .sort()
    expect(dropped).toEqual([...EXPECTED_TABLES].sort())
  })

  it('every DROP TABLE uses IF EXISTS (idempotent)', () => {
    // Bare `DROP TABLE "name"` (without IF EXISTS) would fail when
    // running the down on a partial install or twice in a row.
    const bareDrops = downSql.match(/^DROP TABLE "[^"]+"/gm) ?? []
    expect(bareDrops).toEqual([])
  })

  it('drops attestations + subject_scores BEFORE subjects (FK order)', () => {
    // FK constraints in the up migration:
    //   attestations.subject_id     → subjects.id
    //   subject_scores.subject_id   → subjects.id
    // Without CASCADE on the DROP TABLE (the up migration uses
    // `ON DELETE no action`), the children must drop first.
    const attIdx = downSql.indexOf('DROP TABLE IF EXISTS "attestations"')
    const ssIdx = downSql.indexOf('DROP TABLE IF EXISTS "subject_scores"')
    const subIdx = downSql.indexOf('DROP TABLE IF EXISTS "subjects"')

    expect(attIdx).toBeGreaterThanOrEqual(0)
    expect(ssIdx).toBeGreaterThanOrEqual(0)
    expect(subIdx).toBeGreaterThanOrEqual(0)
    expect(attIdx).toBeLessThan(subIdx)
    expect(ssIdx).toBeLessThan(subIdx)
  })

  it('drops FTS GIN indexes explicitly (defence in depth)', () => {
    // DROP TABLE cascades to its indexes, so this is belt-and-braces.
    // The explicit drop covers the partial-revert scenario where an
    // operator wants to drop just the FTS surface without touching the
    // tables.
    expect(downSql).toMatch(/DROP INDEX IF EXISTS idx_attestations_search/)
    expect(downSql).toMatch(/DROP INDEX IF EXISTS idx_subjects_search/)
  })
})

describe('trust_v1 migration — table set parity (up ↔ down)', () => {
  it('the up CREATE TABLE set equals the down DROP TABLE set', () => {
    // Direct parity check independent of the EXPECTED_TABLES list
    // above. Catches the case where a new table is added to BOTH the
    // expected list AND the up migration but forgotten in the down —
    // or vice versa.
    const upTables = (upSql.match(/CREATE TABLE IF NOT EXISTS "([^"]+)"/g) ?? [])
      .map((m) => /CREATE TABLE IF NOT EXISTS "([^"]+)"/.exec(m)?.[1])
      .filter((t): t is string => Boolean(t))
      .sort()
    const downTables = (downSql.match(/DROP TABLE IF EXISTS "([^"]+)"/g) ?? [])
      .map((m) => /DROP TABLE IF EXISTS "([^"]+)"/.exec(m)?.[1])
      .filter((t): t is string => Boolean(t))
      .sort()
    expect(downTables).toEqual(upTables)
  })
})
