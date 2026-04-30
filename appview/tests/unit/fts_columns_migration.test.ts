/**
 * Tests for `db/fts_columns.ts` (TN-DB-009).
 *
 * The FTS columns + GIN indexes are NOT in the Drizzle schema —
 * Drizzle's column builders can't express `GENERATED ALWAYS AS (...)
 * STORED`. The `ensureFtsColumns(db)` helper owns the DDL and runs at
 * startup from BOTH `web/server.ts` and `ingester/main.ts`. Two
 * call-sites + one source of truth → these tests pin the contract:
 *
 *   - The constant statement list covers BOTH FTS surfaces
 *     (attestations.search_vector + subjects.search_tsv) plus their
 *     GIN indexes — no surface forgotten.
 *   - Statements use `IF NOT EXISTS` (idempotent).
 *   - Statements are ordered: column-create-then-index. Postgres
 *     rejects an index-create against a non-existent column, so a
 *     reorder is a real bug, not a style choice.
 *   - The helper executes every statement against the DB.
 *   - On `42P01` (undefined_table — cold-boot before the table
 *     exists) the helper returns gracefully so the caller can retry
 *     on the next startup. Other errors propagate so syntax /
 *     permissions bugs surface immediately.
 *
 * Pure unit tests against a captured-statement stub — no Postgres
 * required.
 */

import { describe, expect, it } from 'vitest'
import { type SQL } from 'drizzle-orm'

import {
  ensureFtsColumns,
  FTS_DDL_STATEMENTS,
  type FtsCapableDb,
} from '@/db/fts_columns'

/**
 * Capture the SQL chunks each `db.execute(sql.raw(...))` call passes
 * in. Drizzle's `sql.raw()` produces a SQL fragment whose `queryChunks`
 * contains the literal raw string we passed.
 */
function captureExecutedSql(): { db: FtsCapableDb; calls: string[] } {
  const calls: string[] = []
  const db: FtsCapableDb = {
    async execute(query: SQL) {
      // `sql.raw('foo')` produces `{ queryChunks: [StringChunk{ value: ['foo'] }] }`.
      // Walk the chunks and concatenate any string fragments — keeps
      // the test independent of Drizzle's internal AST exact shape.
      const chunks = (query as unknown as { queryChunks?: unknown[] }).queryChunks ?? []
      const flat: string[] = []
      for (const chunk of chunks) {
        if (typeof chunk === 'string') flat.push(chunk)
        else if (chunk && typeof chunk === 'object' && 'value' in chunk) {
          const v = (chunk as { value: unknown }).value
          if (typeof v === 'string') flat.push(v)
          else if (Array.isArray(v)) flat.push(...v.filter((x) => typeof x === 'string'))
        }
      }
      calls.push(flat.join(''))
      return { rows: [] } as unknown
    },
  }
  return { db, calls }
}

describe('FTS_DDL_STATEMENTS — contract', () => {
  it('lists exactly 4 statements: 2 column-creates + 2 indexes', () => {
    // Pinning the count defends against accidental dropping of either
    // the subjects FTS surface or one of the GIN indexes during a
    // refactor.
    expect(FTS_DDL_STATEMENTS).toHaveLength(4)
  })

  it('every statement uses IF NOT EXISTS (idempotent)', () => {
    for (const stmt of FTS_DDL_STATEMENTS) {
      expect(stmt).toContain('IF NOT EXISTS')
    }
  })

  it('attestations: ALTER comes before CREATE INDEX (FK-style ordering)', () => {
    // Postgres rejects an index against a column that doesn't exist
    // yet — order matters. We pin the relative position by index, not
    // by string match, because either statement could mention both
    // table names in its DDL text.
    const alterIdx = FTS_DDL_STATEMENTS.findIndex(
      (s) => s.includes('ALTER TABLE attestations') && s.includes('search_vector'),
    )
    const indexIdx = FTS_DDL_STATEMENTS.findIndex(
      (s) => s.includes('CREATE INDEX') && s.includes('idx_attestations_search'),
    )
    expect(alterIdx).toBeGreaterThanOrEqual(0)
    expect(indexIdx).toBeGreaterThan(alterIdx)
  })

  it('subjects: ALTER comes before CREATE INDEX', () => {
    const alterIdx = FTS_DDL_STATEMENTS.findIndex(
      (s) => s.includes('ALTER TABLE subjects') && s.includes('search_tsv'),
    )
    const indexIdx = FTS_DDL_STATEMENTS.findIndex(
      (s) => s.includes('CREATE INDEX') && s.includes('idx_subjects_search'),
    )
    expect(alterIdx).toBeGreaterThanOrEqual(0)
    expect(indexIdx).toBeGreaterThan(alterIdx)
  })

  it('both ALTER statements use GENERATED ALWAYS AS ... STORED', () => {
    // STORED is required for the GIN index; VIRTUAL columns can't be
    // indexed. A refactor that drops STORED would silently make the
    // index useless → catch that here.
    const alters = FTS_DDL_STATEMENTS.filter((s) => s.includes('ALTER TABLE'))
    expect(alters).toHaveLength(2)
    for (const stmt of alters) {
      expect(stmt).toMatch(/GENERATED\s+ALWAYS\s+AS/)
      expect(stmt).toContain('STORED')
    }
  })

  it('both ALTER statements use to_tsvector(\'english\', coalesce(...))', () => {
    // NULL-safety guard: `to_tsvector('english', NULL)` returns NULL,
    // which the GIN index treats as missing. Wrapping in coalesce
    // keeps every row indexable. Drift here would silently regress
    // FTS coverage on null-source rows.
    const alters = FTS_DDL_STATEMENTS.filter((s) => s.includes('ALTER TABLE'))
    for (const stmt of alters) {
      expect(stmt).toMatch(/to_tsvector\(\s*'english'\s*,\s*coalesce\(/)
    }
  })

  it('both indexes use GIN (the only operator class for tsvector @@ queries)', () => {
    const indexes = FTS_DDL_STATEMENTS.filter((s) => s.includes('CREATE INDEX'))
    expect(indexes).toHaveLength(2)
    for (const stmt of indexes) {
      expect(stmt).toMatch(/USING\s+GIN/)
    }
  })

  it('FTS_DDL_STATEMENTS is frozen at runtime', () => {
    // Defends against accidental mutation by an importing module.
    expect(Object.isFrozen(FTS_DDL_STATEMENTS)).toBe(true)
  })
})

describe('ensureFtsColumns — execution', () => {
  it('executes every statement in declared order against the DB', async () => {
    const { db, calls } = captureExecutedSql()
    await ensureFtsColumns(db)
    expect(calls).toHaveLength(FTS_DDL_STATEMENTS.length)
    for (let i = 0; i < FTS_DDL_STATEMENTS.length; i++) {
      expect(calls[i]).toBe(FTS_DDL_STATEMENTS[i])
    }
  })

  it('idempotent: a second call re-executes the same statements (no caching)', async () => {
    // The constants are `IF NOT EXISTS`, so re-execution is safe — but
    // the helper itself must not silently skip on a second call (e.g.
    // via memoisation), or a partially-applied schema (column exists
    // but index doesn't, after a crash mid-startup) would never
    // self-heal on the next boot.
    const { db, calls } = captureExecutedSql()
    await ensureFtsColumns(db)
    await ensureFtsColumns(db)
    expect(calls).toHaveLength(FTS_DDL_STATEMENTS.length * 2)
  })

  it('returns gracefully when ALL statements 42P01 (full cold-boot)', async () => {
    // Both tables missing — every statement raises 42P01. Helper
    // returns without throwing; next startup will retry.
    let calls = 0
    const db: FtsCapableDb = {
      async execute() {
        calls++
        const err = new Error('relation does not exist') as Error & { code?: string }
        err.code = '42P01'
        throw err
      },
    }
    await expect(ensureFtsColumns(db)).resolves.toBeUndefined()
    // Each statement is tried independently — total executions equal
    // the statement count (no early-exit on first 42P01).
    expect(calls).toBe(FTS_DDL_STATEMENTS.length)
  })

  it('per-statement 42P01: missing attestations does NOT skip subjects DDL', async () => {
    // Real-world cold-boot ordering: web server starts, sees subjects
    // table from ingester's first push, but attestations DDL hasn't
    // landed yet. The subjects FTS DDL must still run — otherwise
    // the helper's behaviour-on-startup is "all-or-nothing" and one
    // missing table delays FTS for ALL tables.
    const calls: string[] = []
    const db: FtsCapableDb = {
      async execute(query) {
        const text = (query as unknown as { queryChunks: unknown[] }).queryChunks
          .map((c) => {
            if (typeof c === 'string') return c
            const v = (c as { value?: unknown }).value
            return typeof v === 'string'
              ? v
              : Array.isArray(v)
                ? v.filter((x) => typeof x === 'string').join('')
                : ''
          })
          .join('')
        calls.push(text)
        if (text.includes('attestations')) {
          const err = new Error('relation "attestations" does not exist') as Error & {
            code?: string
          }
          err.code = '42P01'
          throw err
        }
        return undefined
      },
    }
    await ensureFtsColumns(db)
    // All 4 statements attempted; the 2 that hit `attestations` failed
    // (and were skipped); the 2 that hit `subjects` succeeded. The
    // helper does not give up after the first failure.
    expect(calls).toHaveLength(FTS_DDL_STATEMENTS.length)
    const attestationsCalls = calls.filter((s) => s.includes('attestations'))
    const subjectsCalls = calls.filter((s) => s.includes('subjects'))
    expect(attestationsCalls).toHaveLength(2)
    expect(subjectsCalls).toHaveLength(2)
  })

  it('propagates non-42P01 errors (syntax / permissions surface immediately)', async () => {
    // Silent swallow of, say, `42501` (insufficient_privilege) would
    // mean the FTS column quietly fails to create and the search xRPC
    // sequential-scans forever. Loud failure is the right call —
    // operators see it on startup, not at the first user query.
    const db: FtsCapableDb = {
      async execute() {
        const err = new Error('permission denied for table attestations') as Error & {
          code?: string
        }
        err.code = '42501'
        throw err
      },
    }
    await expect(ensureFtsColumns(db)).rejects.toThrow(/permission denied/)
  })

  it('non-Postgres errors (no .code) propagate', async () => {
    // E.g. a connection error. The helper only knows how to
    // categorise pg error codes; everything else is "unknown — fail
    // loud".
    const db: FtsCapableDb = {
      async execute() {
        throw new Error('ECONNREFUSED')
      },
    }
    await expect(ensureFtsColumns(db)).rejects.toThrow(/ECONNREFUSED/)
  })

  it('passes valid Drizzle SQL fragments to db.execute (not raw strings)', async () => {
    // The helper builds with `sql.raw(stmt)`, which is type-correct.
    // A regression that switched to `db.execute(stmt)` (raw string)
    // would compile but explode at runtime against postgres-js — pin
    // it here.
    const seen: unknown[] = []
    const db: FtsCapableDb = {
      async execute(q) {
        seen.push(q)
        return undefined
      },
    }
    await ensureFtsColumns(db)
    for (const q of seen) {
      // Drizzle SQL has a `queryChunks` array; raw strings don't.
      expect(q).toBeTypeOf('object')
      expect(q).toHaveProperty('queryChunks')
    }
  })
})

