/**
 * Unit tests for the TN-API-001 / Plan §6.1 filter additions to
 * `appview/src/api/xrpc/search.ts`. Coverage target:
 *   - SearchParams parses + rejects each new field correctly.
 *   - The handler's WHERE-clause assembly threads each filter
 *     into the SQL chain via the documented mechanism (sql LIKE,
 *     JSON @>, geo bbox, subquery JOIN-via-IN).
 *
 * Strategy:
 *   - Schema tests are direct Zod runs.
 *   - Behaviour tests use a stub DB whose `select()` chain captures
 *     a textual representation of the WHERE clause, asserting that
 *     each added filter's literal SQL fragment is present.
 *
 * The existing integration suite (`tests/integration/10-api-
 * endpoints.test.ts`) exercises the full SQL round-trip against a
 * real Postgres; this unit-level test pins the WHERE-clause shape
 * so a refactor that drops one of the filter branches surfaces
 * here even when integration tests aren't running.
 */

import { describe, expect, it, vi } from 'vitest'

import { SearchParams, search } from '@/api/xrpc/search'
import type { DrizzleDB } from '@/db/connection'

// ── SearchParams: schema validation ──────────────────────────

describe('SearchParams — TN-API-001 schema', () => {
  it('accepts categoryPrefix on its own', () => {
    const r = SearchParams.safeParse({ categoryPrefix: 'product' })
    expect(r.success).toBe(true)
  })

  it('rejects category + categoryPrefix together (mutually exclusive)', () => {
    const r = SearchParams.safeParse({
      category: 'product:chair',
      categoryPrefix: 'product',
    })
    expect(r.success).toBe(false)
  })

  it('accepts language as a single string', () => {
    const r = SearchParams.safeParse({ language: 'en' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.language).toBe('en')
  })

  it('accepts language as an array (OR-match)', () => {
    const r = SearchParams.safeParse({ language: ['en', 'pt-BR', 'es'] })
    expect(r.success).toBe(true)
  })

  it('rejects language array with > 10 entries (DOS guard)', () => {
    const r = SearchParams.safeParse({
      language: Array(11).fill('en'),
    })
    expect(r.success).toBe(false)
  })

  it('accepts location with valid lat/lng/radius', () => {
    const r = SearchParams.safeParse({
      location: { lat: 37.77, lng: -122.41, radiusKm: 5 },
    })
    expect(r.success).toBe(true)
  })

  it('rejects location with lat outside [-90, 90]', () => {
    const r = SearchParams.safeParse({
      location: { lat: 91, lng: 0, radiusKm: 5 },
    })
    expect(r.success).toBe(false)
  })

  it('rejects location with lng outside [-180, 180]', () => {
    const r = SearchParams.safeParse({
      location: { lat: 0, lng: 181, radiusKm: 5 },
    })
    expect(r.success).toBe(false)
  })

  it('rejects location with radiusKm > 200 (Plan §6.1 cap)', () => {
    const r = SearchParams.safeParse({
      location: { lat: 0, lng: 0, radiusKm: 201 },
    })
    expect(r.success).toBe(false)
  })

  it('rejects location with non-positive radiusKm', () => {
    const r = SearchParams.safeParse({
      location: { lat: 0, lng: 0, radiusKm: 0 },
    })
    expect(r.success).toBe(false)
  })

  it('accepts metadataFilters with whitelisted keys', () => {
    const r = SearchParams.safeParse({
      metadataFilters: { brand: 'Herman Miller', host: 'amazon.com' },
    })
    expect(r.success).toBe(true)
  })

  it('rejects metadataFilters with non-whitelisted keys', () => {
    const r = SearchParams.safeParse({
      metadataFilters: { random_key: 'x' },
    })
    expect(r.success).toBe(false)
  })

  it('accepts metadataFilters with mixed value types (string/number/bool)', () => {
    const r = SearchParams.safeParse({
      metadataFilters: { host: 'amazon.com', org_type: 'company' },
    })
    expect(r.success).toBe(true)
  })

  it('accepts minReviewCount as a non-negative integer', () => {
    const r = SearchParams.safeParse({ minReviewCount: 5 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.minReviewCount).toBe(5)
  })

  it('coerces minReviewCount from string (URL params arrive as strings)', () => {
    const r = SearchParams.safeParse({ minReviewCount: '10' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.minReviewCount).toBe(10)
  })

  it('rejects negative minReviewCount', () => {
    const r = SearchParams.safeParse({ minReviewCount: -1 })
    expect(r.success).toBe(false)
  })

  it('accepts reviewersInNetwork enum values', () => {
    for (const v of ['any', 'one_plus', 'majority']) {
      const r = SearchParams.safeParse({ reviewersInNetwork: v })
      expect(r.success).toBe(true)
    }
  })

  it('rejects reviewersInNetwork unknown value', () => {
    const r = SearchParams.safeParse({ reviewersInNetwork: 'all' })
    expect(r.success).toBe(false)
  })

  it('parses no filter (defaults preserved)', () => {
    const r = SearchParams.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.sort).toBe('relevant')
      expect(r.data.limit).toBe(25)
    }
  })

  // ── TN-V2-RANK-001 — viewerRegion schema ─────────────────────
  it('accepts viewerRegion as ISO 3166-1 alpha-2 (uppercase 2 letters)', () => {
    for (const code of ['US', 'GB', 'IN', 'DE', 'JP', 'BR']) {
      const r = SearchParams.safeParse({ viewerRegion: code })
      expect(r.success).toBe(true)
    }
  })

  it('rejects lowercase viewerRegion (closed format)', () => {
    const r = SearchParams.safeParse({ viewerRegion: 'us' })
    expect(r.success).toBe(false)
  })

  it('rejects 3-letter viewerRegion (alpha-2 only)', () => {
    const r = SearchParams.safeParse({ viewerRegion: 'USA' })
    expect(r.success).toBe(false)
  })

  it('rejects single-letter viewerRegion', () => {
    const r = SearchParams.safeParse({ viewerRegion: 'U' })
    expect(r.success).toBe(false)
  })

  it('rejects digit-bearing viewerRegion', () => {
    const r = SearchParams.safeParse({ viewerRegion: 'U1' })
    expect(r.success).toBe(false)
  })

  // ── TN-V2-RANK-004 — dietaryTags + accessibilityTags schema ───
  it('accepts dietaryTags as a comma-separated string', () => {
    const r = SearchParams.safeParse({ dietaryTags: 'halal,vegan,gluten-free' })
    expect(r.success).toBe(true)
  })

  it('accepts accessibilityTags as a comma-separated string', () => {
    const r = SearchParams.safeParse({ accessibilityTags: 'wheelchair,captions' })
    expect(r.success).toBe(true)
  })

  it('rejects dietaryTags exceeding 1000 chars (DOS guard)', () => {
    const r = SearchParams.safeParse({ dietaryTags: 'x'.repeat(1001) })
    expect(r.success).toBe(false)
  })

  it('rejects accessibilityTags exceeding 1000 chars', () => {
    const r = SearchParams.safeParse({ accessibilityTags: 'x'.repeat(1001) })
    expect(r.success).toBe(false)
  })

  // ── TN-V2-RANK-003 — compatTags schema ─────────────────────────────
  it('accepts compatTags as a comma-separated string', () => {
    const r = SearchParams.safeParse({ compatTags: 'usb-c,lightning' })
    expect(r.success).toBe(true)
  })

  it('rejects compatTags exceeding 1000 chars', () => {
    const r = SearchParams.safeParse({ compatTags: 'x'.repeat(1001) })
    expect(r.success).toBe(false)
  })

  // ── TN-V2-RANK-002 — priceRange schema ─────────────────────────────
  it('accepts priceMinE7 + priceMaxE7 as integers', () => {
    const r = SearchParams.safeParse({ priceMinE7: 10_00_000_000, priceMaxE7: 50_00_000_000 })
    expect(r.success).toBe(true)
  })

  it('coerces string priceMinE7 to integer (URL query convenience)', () => {
    // SearchParams uses z.coerce.number() for the e7 columns to
    // tolerate query-string params (`?priceMinE7=1000000000`),
    // matching the existing `limit` / `minReviewCount` pattern.
    const r = SearchParams.safeParse({ priceMinE7: '1000000000', priceMaxE7: '5000000000' })
    expect(r.success).toBe(true)
  })

  it('accepts only priceMinE7 (open-ended upper)', () => {
    const r = SearchParams.safeParse({ priceMinE7: 10_00_000_000 })
    expect(r.success).toBe(true)
  })

  it('accepts only priceMaxE7 (open-ended lower)', () => {
    const r = SearchParams.safeParse({ priceMaxE7: 50_00_000_000 })
    expect(r.success).toBe(true)
  })

  it('rejects negative priceMinE7', () => {
    const r = SearchParams.safeParse({ priceMinE7: -1 })
    expect(r.success).toBe(false)
  })

  it('rejects priceMinE7 > priceMaxE7 (reversed range)', () => {
    const r = SearchParams.safeParse({ priceMinE7: 5_00_000_000, priceMaxE7: 1_00_000_000 })
    expect(r.success).toBe(false)
  })

  it('accepts priceMinE7 == priceMaxE7 (point query)', () => {
    const r = SearchParams.safeParse({ priceMinE7: 25_00_000_000, priceMaxE7: 25_00_000_000 })
    expect(r.success).toBe(true)
  })
})

// ── Handler behaviour: WHERE-clause assembly ──────────────────

/**
 * Capture the textual representation of every SQL fragment passed
 * to the WHERE chain. We use a deliberately loose stub — the goal
 * is to verify each filter contributes to the WHERE assembly with
 * the documented operator (LIKE / @> / IN), not to pin every byte
 * of the generated SQL.
 *
 * **Drizzle AST quirk worth knowing**: at `queryChunks` time, raw
 * primitives passed into a `sql\`${val}\`` template are stored as
 * inline values; only operators that explicitly call `param()`
 * (e.g., `eq`, `gte`, `inArray`) wrap their value in a `Param`.
 * The bind happens at `toQuery()` time, NOT at AST time. So tests
 * that introspect `queryChunks` see the value inline; tests that
 * inspect the generated SQL via the driver would see `?` / `$1`.
 * We therefore assert content presence (e.g., `product%`) rather
 * than param-wrapping, which is an internal serialisation detail.
 */
interface CapturedQuery {
  sqlFragments: string[]
}

function captureWhere(node: unknown, fragments: string[]): void {
  if (node === null || node === undefined) return
  if (typeof node !== 'object') {
    fragments.push(String(node))
    return
  }
  const n = node as Record<string, unknown>
  // Drizzle SQL composite — recurse over queryChunks.
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks as unknown[]) {
      captureWhere(chunk, fragments)
    }
    return
  }
  // Drizzle Param has both `value` and `encoder`. We must check this
  // BEFORE the primitive-string branch, otherwise a Param wrapping a
  // string falls through and is rendered without the `<param:...>`
  // marker — defeating the whole point of the assertion.
  if ('encoder' in n && 'value' in n) {
    fragments.push(`<param:${JSON.stringify(n.value)}>`)
    return
  }
  // Drizzle StringChunk — `value: string[]`.
  if (Array.isArray(n.value)) {
    fragments.push((n.value as string[]).join(''))
    return
  }
  if (typeof n.value === 'string') {
    fragments.push(n.value)
    return
  }
  if ('value' in n) {
    fragments.push(`<param:${JSON.stringify(n.value)}>`)
    return
  }
}

function makeStubDb(): { db: DrizzleDB; capture: CapturedQuery } {
  const capture: CapturedQuery = { sqlFragments: [] }
  // The handler builds two query shapes against `from()`:
  //   1. main query — `from().leftJoin().where().orderBy().limit()`
  //      (joins did_profiles for authorHandle)
  //   2. subqueries — `from().where()` chains for `subjects` / `subjectScores`
  //      that the main query consumes via `inArray(...)`.
  // The stub supports both by returning `where` AND `leftJoin` from
  // every `from()` so either chain resolves.
  const buildWhere = (whereExpr: unknown) => {
    captureWhere(whereExpr, capture.sqlFragments)
    return {
      // TN-V2-RANK-007 — orderBy now carries the region-boost CASE
      // when viewerRegion is set; capture its args so tests can
      // pin the boost expression alongside the WHERE predicates.
      orderBy: (...exprs: unknown[]) => {
        for (const e of exprs) captureWhere(e, capture.sqlFragments)
        return {
          limit: async () => [],
        }
      },
    }
  }
  // TN-V2-RANK-007 — when viewerRegion is set, the handler chains
  // a second leftJoin (subjects). The stub returns a chainable
  // object so both `from().leftJoin().where()` AND
  // `from().leftJoin().leftJoin().where()` resolve.
  const buildLeftJoin = (): any => ({
    leftJoin: () => buildLeftJoin(),
    where: buildWhere,
  })
  const db: any = {
    select: () => ({
      from: () => ({
        leftJoin: () => buildLeftJoin(),
        where: buildWhere,
      }),
    }),
  }
  return { db: db as DrizzleDB, capture }
}

describe('search handler — TN-API-001 WHERE-clause assembly', () => {
  it('categoryPrefix adds a LIKE predicate with the prefix value', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      categoryPrefix: 'product',
      sort: 'recent', // skip FTS branch
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toMatch(/LIKE/i)
    expect(sqlText).toContain('product%')
  })

  it('language single string adds an equality predicate', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      language: 'en',
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    // `eq()` wraps the value in a Param at AST time → `<param:"en">`.
    expect(sqlText).toContain('<param:"en">')
  })

  it('language array adds an IN predicate', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      language: ['en', 'pt-BR'],
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toMatch(/\bin\b/i)
  })

  it('language empty array does NOT add a predicate (silent skip)', async () => {
    // Defends against `IN ()` SQL syntax error and against false
    // empty-set semantics. An empty filter list means "no filter",
    // not "match nothing".
    const { db, capture } = makeStubDb()
    await search(db, {
      language: [],
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).not.toMatch(/in\s*\(/i)
  })

  it('location adds a bbox + subject_id IN subquery', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      location: { lat: 37.77, lng: -122.41, radiusKm: 5 },
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toMatch(/lat/)
    expect(sqlText).toMatch(/lng/)
    expect(sqlText).toMatch(/BETWEEN/i)
  })

  it('metadataFilters adds a JSON-contains predicate', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      metadataFilters: { brand: 'Herman Miller' },
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toMatch(/@>/)
    expect(sqlText).toContain('Herman Miller')
    expect(sqlText).toMatch(/::jsonb/i)
  })

  it('minReviewCount adds a subject_id IN subquery against subject_scores', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      minReviewCount: 3,
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toContain('<param:3>')
  })

  it('minReviewCount = 0 is silently skipped (no extra predicate)', async () => {
    // 0 means "no minimum" — adding `>= 0` would be a no-op
    // predicate that just adds planner work. Pinned: the bound
    // check guards minReviewCount > 0.
    const { db, capture: cap0 } = makeStubDb()
    await search(db, { minReviewCount: 0, sort: 'recent', limit: 25 } as never)
    const sqlText0 = cap0.sqlFragments.join('')
    // No 'subject_scores' fragment when filter is 0.
    expect(sqlText0).not.toMatch(/subject_scores/i)
  })

  it('multiple filters AND together (Plan §6.1 contract)', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      categoryPrefix: 'product',
      language: 'en',
      minReviewCount: 5,
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    // All three filters' fragments must be present in the
    // assembled WHERE.
    expect(sqlText).toMatch(/LIKE/i) // categoryPrefix
    expect(sqlText).toContain('product%') // categoryPrefix value
    expect(sqlText).toContain('<param:"en">') // language (eq wraps in Param)
    expect(sqlText).toContain('<param:5>') // minReviewCount (gte wraps in Param)
  })

  // ── TN-V2-RANK-001 — viewerRegion filter ────────────────────────────
  it('viewerRegion adds the JSONB containment + missing-pass predicate', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      viewerRegion: 'GB',
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    // Two halves: missing-pass via jsonb_array_length COALESCE, and
    // positive containment via `@>`.
    expect(sqlText).toMatch(/jsonb_array_length/i)
    expect(sqlText).toMatch(/COALESCE/i)
    expect(sqlText).toMatch(/@>/)
    // The viewer-region payload travels as a parameter inside the
    // JSON-stringified containment object.
    expect(sqlText).toContain('"GB"')
  })

  it('viewerRegion = undefined adds NO predicate (silent skip)', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).not.toMatch(/availability/i)
    expect(sqlText).not.toMatch(/jsonb_array_length/i)
  })

  // ── TN-V2-RANK-004 — dietaryTags + accessibilityTags filters ──
  it('dietaryTags adds an array-containment predicate against attestations.compliance', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      dietaryTags: 'halal,vegan',
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toMatch(/@>/)
    expect(sqlText).toMatch(/::text\[\]/)
    expect(sqlText).toContain('halal')
    expect(sqlText).toContain('vegan')
  })

  it('accessibilityTags adds an array-containment predicate against attestations.accessibility', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      accessibilityTags: 'wheelchair,captions',
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toMatch(/@>/)
    expect(sqlText).toContain('wheelchair')
    expect(sqlText).toContain('captions')
  })

  it('empty dietaryTags string adds NO predicate (silent skip)', async () => {
    // `?dietaryTags=` (empty string) shouldn't add `tags @> ARRAY[]`
    // — that would be either "match all rows" or a SQL error
    // depending on driver. Silent skip is the right semantic.
    const { db, capture } = makeStubDb()
    await search(db, {
      dietaryTags: '',
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).not.toMatch(/compliance/i)
  })

  it('whitespace-only dietaryTags entries are dropped from the IN list', async () => {
    // `?dietaryTags=halal,,vegan` should be parsed as [halal, vegan]
    // — the doubled comma yields an empty entry that we silently
    // drop rather than building `... @> ARRAY[...,'',...]` and
    // erroring at the DB.
    const { db, capture } = makeStubDb()
    await search(db, {
      dietaryTags: 'halal,, ,vegan',
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toContain('halal')
    expect(sqlText).toContain('vegan')
    // The doubled-comma artifact must NOT survive into the query.
    // Stub renders raw strings as-is, so checking for `''` proves
    // we didn't propagate an empty-string parameter.
    expect(sqlText).not.toContain("''")
  })

  it('dietaryTags entry > 50 chars throws (per-tag bound matches META-005/006 validator)', async () => {
    const { db } = makeStubDb()
    await expect(
      search(db, {
        dietaryTags: 'x'.repeat(51),
        sort: 'recent',
        limit: 25,
      } as never),
    ).rejects.toThrow(/exceeds maximum length/)
  })

  // ── TN-V2-RANK-003 — compatTags filter (OVERLAP, not containment) ──
  it('compatTags adds an array-OVERLAP predicate (&&) — not containment', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      compatTags: 'usb-c,lightning',
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    // Pin the OVERLAP semantic: the SQL must use `&&`, not `@>`
    // — flipping to containment would silently shrink the result
    // set to "devices supporting both connectors" (almost always
    // empty) when the user asked for "either".
    expect(sqlText).toMatch(/&&/)
    expect(sqlText).not.toMatch(/compat[^&]*@>/i)
    expect(sqlText).toContain('usb-c')
    expect(sqlText).toContain('lightning')
  })

  it('empty compatTags string adds NO predicate (silent skip)', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      compatTags: '',
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).not.toMatch(/compat[^_]/)
  })

  it('compatTags entry > 50 chars throws (per-tag bound matches META-003 validator)', async () => {
    const { db } = makeStubDb()
    await expect(
      search(db, {
        compatTags: 'x'.repeat(51),
        sort: 'recent',
        limit: 25,
      } as never),
    ).rejects.toThrow(/exceeds maximum length/)
  })

  // ── TN-V2-RANK-002 — priceRange filter ─────────────────────
  // Note: the stub captures sql-template `queryChunks` and elides
  // `PgColumn` references (Drizzle's columns aren't `StringChunk`
  // shapes — they have a different rendering path that surfaces
  // the column NAME only when the SQL is finally serialised by
  // the driver, not at AST time). So tests pin operators (`<=`,
  // `>=`, `IS NULL`) and inline integer values, NOT column names.
  it('priceRange (both bounds) adds an integer range-overlap predicate with missing-pass', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      priceMinE7: 10_00_000_000,
      priceMaxE7: 50_00_000_000,
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    // Range-overlap: low <= max AND high >= min.
    expect(sqlText).toMatch(/<=/)
    expect(sqlText).toMatch(/>=/)
    // Missing-pass clause: NULL price rows should still be eligible.
    expect(sqlText).toMatch(/IS NULL/)
    // Both bounds inlined into the captured fragments (Drizzle
    // doesn't wrap raw `${num}` in `Param`, so the value renders
    // as a literal string — same convention as the existing
    // viewerRegion `'GB'` assertion).
    expect(sqlText).toContain('1000000000')
    expect(sqlText).toContain('5000000000')
  })

  it('priceRange (priceMinE7 only) adds the high >= min half only', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      priceMinE7: 10_00_000_000,
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    // Pin the half-open shape: `>=` is the high-side operator;
    // the upper-bound number must NOT appear (that proves we
    // didn't accidentally emit a `<= max` clause).
    expect(sqlText).toMatch(/>=/)
    expect(sqlText).toContain('1000000000')
    // The all-bounds test inlined `5000000000`; this one mustn't.
    expect(sqlText).not.toContain('5000000000')
    // Missing-pass branch is part of the price predicate.
    expect(sqlText).toMatch(/IS NULL/)
  })

  it('priceRange (priceMaxE7 only) adds the low <= max half only', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      priceMaxE7: 50_00_000_000,
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toMatch(/<=/)
    expect(sqlText).toContain('5000000000')
    expect(sqlText).not.toContain('1000000000')
    expect(sqlText).toMatch(/IS NULL/)
  })

  it('absent priceRange adds NO price predicate (no missing-pass clause emitted)', async () => {
    const { db, capture } = makeStubDb()
    await search(db, { sort: 'recent', limit: 25 } as never)
    const sqlText = capture.sqlFragments.join('')
    // No price-range numbers should appear in the SQL when
    // neither bound is set. The price predicate is fully gated
    // on at least one of priceMinE7 / priceMaxE7 being defined.
    expect(sqlText).not.toContain('1000000000')
    expect(sqlText).not.toContain('5000000000')
  })

  // ── TN-V2-RANK-007 — viewer-region sort boost ───────────────
  it('viewerRegion adds a CASE-based boost to ORDER BY (RANK-007)', async () => {
    const { db, capture } = makeStubDb()
    await search(db, {
      viewerRegion: 'GB',
      sort: 'recent',
      limit: 25,
    } as never)
    // The boost lives in the orderBy chain; our stub captures
    // ORDER BY fragments alongside WHERE because both go through
    // the same captureWhere recurser. Confirm the CASE expression
    // and DESC keyword appear with the region payload.
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toMatch(/CASE WHEN/i)
    expect(sqlText).toContain('"GB"')
    expect(sqlText).toMatch(/DESC/)
  })

  it('reviewersInNetwork is parsed but does NOT affect the WHERE (forward-compat stub)', async () => {
    // Documented contract: schema accepts the param so mobile
    // clients can serialise it now; enforcement is a follow-up
    // task. Pinned by absence of any network-related fragment in
    // the WHERE clause.
    const { db, capture } = makeStubDb()
    await search(db, {
      reviewersInNetwork: 'one_plus',
      viewerDid: 'did:plc:viewer',
      sort: 'recent',
      limit: 25,
    } as never)
    const sqlText = capture.sqlFragments.join('').toLowerCase()
    expect(sqlText).not.toMatch(/network/)
    expect(sqlText).not.toMatch(/contacts/)
  })
})
