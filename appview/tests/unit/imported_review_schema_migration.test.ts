/**
 * The schema/migration drift guard, for D4's columns.
 *
 * This repo has no `drizzle-kit generate` step and nothing compares the
 * Drizzle schema in TypeScript against the hand-written migrations. A column
 * declared in one and missing from the other is invisible: every unit test
 * passes against a mocked `db`, and production 500s on the first query that
 * names it. That has happened here before.
 *
 * So the columns D4 adds are pinned in both directions — declared in the
 * schema, and present in a migration file — by reading the files themselves.
 * The guard is narrow on purpose: it covers the columns this change
 * introduced rather than pretending to diff the whole schema, which would be
 * a second schema to keep in step.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect } from 'vitest'

const ROOT = join(__dirname, '..', '..')

function schemaSource(file: string): string {
  return readFileSync(join(ROOT, 'src', 'db', 'schema', file), 'utf8')
}

/** Every migration's SQL, concatenated — a column may land in any of them. */
function allMigrations(): string {
  const dir = join(ROOT, 'drizzle')
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

describe('D4 columns exist in the schema AND in a migration', () => {
  const migrations = allMigrations()

  it('attestations carries the imported-review provenance', () => {
    const schema = schemaSource('attestations.ts')
    expect(schema).toContain("text('source_feed')")
    expect(schema).toContain("jsonb('source_json')")
    expect(migrations).toMatch(/ALTER TABLE attestations ADD COLUMN IF NOT EXISTS source_feed text/i)
    expect(migrations).toMatch(/ALTER TABLE attestations ADD COLUMN IF NOT EXISTS source_json jsonb/i)
  })

  it('the partial index the score paths lean on is migrated too', () => {
    // Every query that uses `source_feed` asks either "is it NULL" (the two
    // score paths) or "which feed" (the read path), so the index only needs
    // the non-NULL rows — but it needs to exist, or the score refresh scans.
    expect(migrations).toMatch(/CREATE INDEX IF NOT EXISTS attestations_source_feed_idx/i)
    expect(migrations).toMatch(/WHERE source_feed IS NOT NULL/i)
  })

  it('subject_scores carries the peer / imported split', () => {
    const schema = schemaSource('subject-scores.ts')
    expect(schema).toContain("integer('peer_review_count')")
    expect(schema).toContain("integer('imported_review_count')")
    expect(migrations).toMatch(
      /ALTER TABLE subject_scores ADD COLUMN IF NOT EXISTS peer_review_count integer/i,
    )
    expect(migrations).toMatch(
      /ALTER TABLE subject_scores ADD COLUMN IF NOT EXISTS imported_review_count integer/i,
    )
  })

  it('every D4 column is added idempotently, so a re-run is not an outage', () => {
    // `IF NOT EXISTS` on every one: migrations here are applied by hand often
    // enough that a second run must be a no-op rather than an error that
    // aborts the rest of the file.
    const d4 = migrations
      .split('\n')
      .filter((line) => /source_feed|source_json|peer_review_count|imported_review_count/.test(line))
      .filter((line) => /^\s*ALTER TABLE/i.test(line))
    expect(d4.length).toBeGreaterThanOrEqual(4)
    for (const line of d4) expect(line).toMatch(/IF NOT EXISTS/i)
  })
})
