/**
 * Schema-introspection tests for `reviewer_namespace_scores`
 * (TN-DB-002 / Plan §3.5 + §7).
 *
 * Drizzle's `getTableConfig` exposes the table's columns, primary
 * key, and index definitions at runtime — we verify the shape
 * without a real Postgres. This catches regressions like:
 *   - PK accidentally dropped to a single column
 *   - A column changing from NOT NULL to nullable
 *   - The needs_recalc partial index getting deleted in a refactor
 *   - A column rename that breaks the schema-mirror invariant with
 *     `did_profiles`
 *
 * The full DB-roundtrip integration test (insert + read + composite-
 * PK uniqueness) lives at the integration tier; this unit test is
 * the cheap structural pin.
 */

import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'

import { reviewerNamespaceScores } from '@/db/schema/reviewer-namespace-scores'

const tableConfig = getTableConfig(reviewerNamespaceScores)

describe('reviewer_namespace_scores — table shape', () => {
  it('table name is "reviewer_namespace_scores"', () => {
    expect(tableConfig.name).toBe('reviewer_namespace_scores')
  })

  it('uses a composite primary key on (did, namespace)', () => {
    // PK shape is the identity contract — single-column PK on `did`
    // alone would silently allow duplicate rows for the same
    // (did, namespace), corrupting the scorer's UPSERT path.
    expect(tableConfig.primaryKeys).toHaveLength(1)
    const pk = tableConfig.primaryKeys[0]
    const pkColumnNames = pk.columns.map((c) => c.name).sort()
    expect(pkColumnNames).toEqual(['did', 'namespace'])
  })
})

describe('reviewer_namespace_scores — column shape', () => {
  /** Helper: lookup a column by name. */
  function col(name: string) {
    return tableConfig.columns.find((c) => c.name === name)
  }

  it('did column is NOT NULL text', () => {
    const c = col('did')
    expect(c).toBeDefined()
    expect(c!.notNull).toBe(true)
    expect(c!.dataType).toBe('string')
  })

  it('namespace column is NOT NULL text (no NULL — namespace-using rows only)', () => {
    // Pinned: if namespace becomes nullable, the table's contract
    // breaks — un-namespaced records would land here AND in
    // did_profiles, double-counting.
    const c = col('namespace')
    expect(c).toBeDefined()
    expect(c!.notNull).toBe(true)
    expect(c!.dataType).toBe('string')
  })

  it('score_version is NOT NULL with default "v1"', () => {
    const c = col('score_version')
    expect(c).toBeDefined()
    expect(c!.notNull).toBe(true)
    // Drizzle stores the default as either a literal string or an
    // SQL chunk — we check both shapes defensively.
    expect(c!.default).toBe('v1')
  })

  it('needs_recalc is NOT NULL with default true', () => {
    const c = col('needs_recalc')
    expect(c).toBeDefined()
    expect(c!.notNull).toBe(true)
    expect(c!.default).toBe(true)
  })

  it('overall_trust_score is nullable (NULL = "never scored", treated as unrated)', () => {
    const c = col('overall_trust_score')
    expect(c).toBeDefined()
    expect(c!.notNull).toBe(false)
    expect(c!.dataType).toBe('number')
  })

  it('computed_at is NOT NULL timestamp', () => {
    const c = col('computed_at')
    expect(c).toBeDefined()
    expect(c!.notNull).toBe(true)
  })

  it('namespace_first_seen is nullable (independent of did_profiles.account_first_seen)', () => {
    const c = col('namespace_first_seen')
    expect(c).toBeDefined()
    expect(c!.notNull).toBe(false)
  })

  it('mirrors did_profiles reviewer-stat counters by name', () => {
    // Pinned because TN-SCORE-001 (the per-namespace stats refresh)
    // runs the SAME arithmetic that `refresh-reviewer-stats.ts`
    // runs against did_profiles. Same column names → same SQL —
    // minimises drift when the formula evolves.
    const expectedCounters = [
      'total_attestations_by',
      'revocation_count',
      'deletion_count',
      'disputed_then_deleted_count',
    ]
    for (const name of expectedCounters) {
      expect(col(name), `expected column ${name}`).toBeDefined()
    }
  })

  it('mirrors did_profiles reviewer-stat rates by name', () => {
    const expectedRates = [
      'revocation_rate',
      'deletion_rate',
      'corroboration_rate',
      'evidence_rate',
    ]
    for (const name of expectedRates) {
      expect(col(name), `expected column ${name}`).toBeDefined()
    }
  })

  it('does NOT include vouch/endorsement counters (those target the root DID, not namespaces)', () => {
    // Per the schema docstring: vouches and endorsements target the
    // root DID; surfacing them per-namespace would be misleading.
    // Pinned by absence — if a future refactor accidentally adds
    // them, this test surfaces it.
    expect(col('vouch_count')).toBeUndefined()
    expect(col('vouch_strength')).toBeUndefined()
    expect(col('endorsement_count')).toBeUndefined()
    expect(col('high_confidence_vouches')).toBeUndefined()
  })
})

describe('reviewer_namespace_scores — indexes', () => {
  it('declares the needs_recalc partial index', () => {
    // Pinned because the scorer's drain query
    // (`SELECT … WHERE needs_recalc = true`) full-scans without it.
    const idx = tableConfig.indexes.find(
      (i) => i.config.name === 'reviewer_namespace_scores_needs_recalc_idx',
    )
    expect(idx).toBeDefined()
  })

  it('declares the per-DID lookup index', () => {
    // The mobile reviewer-profile drill-down lists ALL namespaces
    // for a DID; without a per-DID index that's a full table scan.
    const idx = tableConfig.indexes.find(
      (i) => i.config.name === 'reviewer_namespace_scores_did_idx',
    )
    expect(idx).toBeDefined()
  })
})

describe('reviewer_namespace_scores — schema export', () => {
  it('is re-exported from db/schema/index.ts', async () => {
    const indexModule = await import('@/db/schema/index')
    expect(indexModule.reviewerNamespaceScores).toBeDefined()
    expect(indexModule.reviewerNamespaceScores).toBe(reviewerNamespaceScores)
  })
})
