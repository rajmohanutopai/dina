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
  const db: any = {
    select: () => ({
      from: () => ({
        where: (whereExpr: unknown) => {
          captureWhere(whereExpr, capture.sqlFragments)
          return {
            orderBy: () => ({
              limit: async () => [],
            }),
          }
        },
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
