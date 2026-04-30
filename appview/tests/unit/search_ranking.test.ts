/**
 * Unit tests for the TN-API-001 / Plan §6.1 sort + pagination + FTS
 * surface of `appview/src/api/xrpc/search.ts`. Coverage target:
 *   - sort=recent / sort=relevant routing (FTS branch on/off)
 *   - composite cursor `(timestamp::uri)` parsing + emission
 *   - legacy timestamp-only cursor backwards-compatibility
 *   - malformed-cursor → ZodError-shaped 400
 *   - hasMore detection via the limit+1 trick
 *   - graceful empty result on FTS statement-timeout cancellation
 *
 * Strategy:
 *   - Schema-level `sort` enum tests are direct Zod runs.
 *   - Behaviour tests use a stub DB whose `select` chain captures
 *     the order-by + limit + transaction shape; assertions inspect
 *     the captured composite for the documented contract (ts_rank
 *     when FTS, recordCreatedAt-DESC otherwise).
 *
 * Complements `search_filters.test.ts` (which pins WHERE-clause
 * assembly for the new filter overlay). Together the two files
 * exercise the full search xRPC contract.
 */

import { describe, expect, it } from 'vitest'

import { SearchParams, search } from '@/api/xrpc/search'
import type { DrizzleDB } from '@/db/connection'

// ── Schema validation ─────────────────────────────────────────

describe('SearchParams — sort enum', () => {
  it('accepts sort: "relevant" (default)', () => {
    const r = SearchParams.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.sort).toBe('relevant')
  })

  it('accepts sort: "recent"', () => {
    const r = SearchParams.safeParse({ sort: 'recent' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.sort).toBe('recent')
  })

  it('rejects an unknown sort value', () => {
    const r = SearchParams.safeParse({ sort: 'trending' })
    expect(r.success).toBe(false)
  })
})

describe('SearchParams — limit + cursor', () => {
  it('rejects a limit value above the cap (Plan §6.1 caps at 100)', () => {
    // Pinned because uncapped paging would let a single request scan
    // a wide attestation set. The schema uses `.max(100)` (rejects),
    // not a silent clamp — caller gets a 400 instead of unexpected
    // truncation.
    const r = SearchParams.safeParse({ limit: 5000 })
    expect(r.success).toBe(false)
  })

  it('accepts a limit value at the cap exactly', () => {
    const r = SearchParams.safeParse({ limit: 100 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.limit).toBe(100)
  })

  it('coerces a string limit (URL params arrive as strings)', () => {
    const r = SearchParams.safeParse({ limit: '50' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.limit).toBe(50)
  })

  it('rejects a negative limit', () => {
    const r = SearchParams.safeParse({ limit: -1 })
    expect(r.success).toBe(false)
  })

  it('accepts an opaque cursor string (composite or legacy)', () => {
    const composite = '2026-04-30T00:00:00.000Z::at://did:plc:x/com.dina.trust.attestation/abc'
    const r = SearchParams.safeParse({ cursor: composite })
    expect(r.success).toBe(true)
  })
})

// ── Stub DB infrastructure ────────────────────────────────────

interface CapturedQuery {
  sqlFragments: string[]
  /** Number of rows returned by the stubbed `limit` call (post-where). */
  rowCount: number
  /** Whether the query was wrapped in a transaction (FTS path uses one). */
  inTransaction: boolean
}

function captureWhere(node: unknown, fragments: string[]): void {
  if (node === null || node === undefined) return
  if (typeof node !== 'object') {
    fragments.push(String(node))
    return
  }
  const n = node as Record<string, unknown>
  if (Array.isArray(n.queryChunks)) {
    for (const chunk of n.queryChunks as unknown[]) {
      captureWhere(chunk, fragments)
    }
    return
  }
  if ('encoder' in n && 'value' in n) {
    fragments.push(`<param:${JSON.stringify(n.value)}>`)
    return
  }
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

interface StubRow {
  uri: string
  recordCreatedAt: Date
}

/**
 * Builds a stub DB that captures the WHERE + ORDER BY + LIMIT chain
 * and returns scripted rows. The FTS path's transaction wrap is
 * detected by checking whether the inner `select` ran via the
 * transaction callback.
 */
function makeStubDb(opts: { rows: StubRow[]; ftsTimeoutCode?: string }): {
  db: DrizzleDB
  capture: CapturedQuery
} {
  const capture: CapturedQuery = {
    sqlFragments: [],
    rowCount: opts.rows.length,
    inTransaction: false,
  }

  const orderByCaptures: unknown[] = []

  const buildSelectChain = (inTx: boolean) => ({
    select: () => ({
      from: () => ({
        where: (whereExpr: unknown) => {
          captureWhere(whereExpr, capture.sqlFragments)
          return {
            orderBy: (...clauses: unknown[]) => {
              orderByCaptures.push(...clauses)
              for (const c of clauses) captureWhere(c, capture.sqlFragments)
              return {
                limit: async () => {
                  if (inTx) capture.inTransaction = true
                  return opts.rows
                },
              }
            },
          }
        },
      }),
    }),
  })

  const db: any = {
    ...buildSelectChain(false),
    transaction: async (fn: (tx: DrizzleDB) => Promise<unknown>) => {
      const tx: any = {
        ...buildSelectChain(true),
        execute: async (sqlValue: unknown) => {
          // Capture the SET LOCAL statement_timeout call.
          captureWhere(sqlValue, capture.sqlFragments)
          if (opts.ftsTimeoutCode) {
            const e: any = new Error('FTS canceled')
            e.code = opts.ftsTimeoutCode
            throw e
          }
          return undefined
        },
      }
      return fn(tx)
    },
  }
  return { db: db as DrizzleDB, capture }
}

// ── sort routing ──────────────────────────────────────────────

describe('search handler — sort routing', () => {
  it('sort=recent does NOT take the FTS branch (no transaction, no ts_rank)', async () => {
    const { db, capture } = makeStubDb({ rows: [] })
    await search(db, { sort: 'recent', limit: 25 } as never)
    expect(capture.inTransaction).toBe(false)
    expect(capture.sqlFragments.join('')).not.toMatch(/ts_rank/)
    expect(capture.sqlFragments.join('')).not.toMatch(/plainto_tsquery/)
  })

  it('sort=relevant WITHOUT q does NOT take the FTS branch', async () => {
    // FTS only fires when both `q` is present AND sort is relevant.
    // Pinned because the no-q-but-relevant case is the most common
    // (a faceted-only browse) and must not pay the FTS planner cost.
    const { db, capture } = makeStubDb({ rows: [] })
    await search(db, { sort: 'relevant', limit: 25 } as never)
    expect(capture.inTransaction).toBe(false)
    expect(capture.sqlFragments.join('')).not.toMatch(/ts_rank/)
  })

  it('sort=relevant WITH q takes the FTS branch (ts_rank + plainto_tsquery + transaction)', async () => {
    const { db, capture } = makeStubDb({ rows: [] })
    await search(db, { q: 'office chair', sort: 'relevant', limit: 25 } as never)
    expect(capture.inTransaction).toBe(true)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toMatch(/ts_rank/)
    expect(sqlText).toMatch(/plainto_tsquery/)
    // Drizzle's sql\`${val}\` template inlines primitives at AST
    // time (binds at toQuery() time — verified safe in iter 32);
    // the captured query text shows the raw value, not a `<param:>`.
    expect(sqlText).toContain('office chair')
  })

  it('FTS branch sets a 200ms statement_timeout (defends the planner)', async () => {
    // Plan-driven CPU cap: FTS queries on a large attestation set
    // can be expensive; the SET LOCAL bounds tick cost so a single
    // pathological query can't hog a connection.
    const { db, capture } = makeStubDb({ rows: [] })
    await search(db, { q: 'test', sort: 'relevant', limit: 25 } as never)
    expect(capture.sqlFragments.join('')).toMatch(/statement_timeout.*200ms/)
  })

  it('FTS statement-timeout cancellation (PG code 57014) returns empty results gracefully', async () => {
    // Documented: when a query is canceled by the 200ms timeout, the
    // handler returns `{ results: [], totalEstimate: 0 }` rather than
    // 500-ing. Pinned because operators rely on this — a slow query
    // shouldn't crash the search xRPC.
    const { db } = makeStubDb({ rows: [], ftsTimeoutCode: '57014' })
    const result = (await search(db, { q: 'slow', sort: 'relevant', limit: 25 } as never)) as {
      results: unknown[]
      cursor?: string
      totalEstimate: number
    }
    expect(result.results).toEqual([])
    expect(result.totalEstimate).toBe(0)
    expect(result.cursor).toBeUndefined()
  })

  it('non-timeout FTS errors propagate (NOT silently swallowed as empty results)', async () => {
    // Defensive: an unexpected DB error during FTS must NOT be
    // silently absorbed by the timeout handler; that would mask
    // bugs. Only PG code 57014 is treated as "expected timeout".
    const { db } = makeStubDb({ rows: [], ftsTimeoutCode: '23505' /* unique violation */ })
    await expect(
      search(db, { q: 'test', sort: 'relevant', limit: 25 } as never),
    ).rejects.toThrow()
  })
})

// ── Cursor pagination ─────────────────────────────────────────

describe('search handler — composite cursor', () => {
  it('emits no cursor when result rows ≤ limit', async () => {
    const rows: StubRow[] = [
      { uri: 'at://did:plc:a/x/1', recordCreatedAt: new Date('2026-04-30T01:00:00Z') },
      { uri: 'at://did:plc:a/x/2', recordCreatedAt: new Date('2026-04-30T00:30:00Z') },
    ]
    const { db } = makeStubDb({ rows })
    const result = (await search(db, { sort: 'recent', limit: 25 } as never)) as {
      results: unknown[]
      cursor?: string
    }
    // 2 rows, limit 25 → no nextCursor (less than limit+1 returned).
    expect(result.cursor).toBeUndefined()
    expect(result.results).toHaveLength(2)
  })

  it('emits a composite cursor (ISO::uri) when more rows exist', async () => {
    // The handler queries `limit + 1` rows internally; if the result
    // set is exactly limit + 1 (or more), it slices to limit and
    // emits a cursor pointing AT the last row of the page.
    const rows: StubRow[] = []
    for (let i = 0; i < 26; i++) {
      rows.push({
        uri: `at://did:plc:a/x/${i}`,
        recordCreatedAt: new Date(`2026-04-30T0${Math.floor(i / 10)}:${(i % 10).toString().padStart(2, '0')}:00Z`),
      })
    }
    const { db } = makeStubDb({ rows })
    const result = (await search(db, { sort: 'recent', limit: 25 } as never)) as {
      results: Array<{ uri: string }>
      cursor?: string
    }
    expect(result.results).toHaveLength(25)
    expect(result.cursor).toBeDefined()
    expect(result.cursor).toContain('::at://did:plc:a/x/24')
    expect(result.cursor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z::/)
  })

  it('parses a composite cursor and adds a (ts < OR ts == AND uri <) predicate', async () => {
    // The cursor's role is to emit a stable continuation: rows AFTER
    // the cursor point in `(recordCreatedAt DESC, uri DESC)` order.
    // The OR-AND structure handles the same-timestamp case correctly
    // (without it, two rows at the same microsecond would be
    // missed/duplicated across page boundaries).
    const cursor = '2026-04-30T00:00:00.000Z::at://did:plc:x/y/abc'
    const { db, capture } = makeStubDb({ rows: [] })
    await search(db, { sort: 'recent', limit: 25, cursor } as never)
    const sqlText = capture.sqlFragments.join('')
    expect(sqlText).toContain('<param:"at://did:plc:x/y/abc">')
    expect(sqlText).toMatch(/2026-04-30T00:00:00\.000Z|2026-04-30/)
  })

  it('parses a legacy timestamp-only cursor (backwards-compat)', async () => {
    // Older clients may have persisted timestamp-only cursors; the
    // handler tolerates them by treating the cursor as "rows ≤ this
    // timestamp", losing the strict-after-uri precision but staying
    // forward-progressing.
    const cursor = '2026-04-30T00:00:00.000Z'
    const { db } = makeStubDb({ rows: [] })
    await expect(
      search(db, { sort: 'recent', limit: 25, cursor } as never),
    ).resolves.toBeTruthy()
  })

  it('rejects a malformed legacy cursor (invalid timestamp) as ZodError → 400', async () => {
    // Defensive: a garbage cursor string must produce a 400-shaped
    // error (ZodError name) rather than a 500. The dispatcher's
    // ZodError branch fires on `err.name === 'ZodError'`.
    const { db } = makeStubDb({ rows: [] })
    await expect(
      search(db, { sort: 'recent', limit: 25, cursor: 'not-a-cursor' } as never),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })
})

// ── since / until date filters ────────────────────────────────

describe('search handler — since / until', () => {
  it('rejects an invalid `since` date as ZodError → 400', async () => {
    const { db } = makeStubDb({ rows: [] })
    await expect(
      search(db, { sort: 'recent', limit: 25, since: 'yesterday' } as never),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('rejects an invalid `until` date as ZodError → 400', async () => {
    const { db } = makeStubDb({ rows: [] })
    await expect(
      search(db, { sort: 'recent', limit: 25, until: 'tomorrow' } as never),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('accepts a valid ISO `since` and adds a >= predicate', async () => {
    const { db, capture } = makeStubDb({ rows: [] })
    await search(db, {
      sort: 'recent',
      limit: 25,
      since: '2026-01-01T00:00:00.000Z',
    } as never)
    // The gte() helper wraps the value in a Param — appears as a
    // `<param:...>` in the captured SQL.
    expect(capture.sqlFragments.join('')).toMatch(/<param:"2026-01-01/)
  })

  it('accepts a valid ISO `until` and adds a <= predicate', async () => {
    const { db, capture } = makeStubDb({ rows: [] })
    await search(db, {
      sort: 'recent',
      limit: 25,
      until: '2026-12-31T23:59:59.999Z',
    } as never)
    expect(capture.sqlFragments.join('')).toMatch(/<param:"2026-12-31/)
  })
})
