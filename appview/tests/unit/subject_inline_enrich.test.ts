/**
 * Unit tests for the inline enrichment behaviour of
 * `appview/src/db/queries/subjects.ts:resolveOrCreateSubject`
 * (TN-ING-007 / Plan §3.6).
 *
 * Contract:
 *   - INSERT carries enrichment columns (category, metadata,
 *     language, enriched_at) so new subjects are immediately
 *     searchable
 *   - ON CONFLICT branch does NOT overwrite enrichment columns
 *     (preserves first-write semantics → idempotent + operator-
 *     override-safe)
 *   - enrichSubject() result is the source of truth for category
 *     + metadata
 *   - detectLanguage() result is the source of truth for language
 *
 * Strategy: capture the SQL passed to `db.execute(...)` and
 * inspect Drizzle's `sql` template structure for enrichment
 * markers. Drizzle exposes `query.queryChunks`; we walk those for
 * the parameter values our handler interpolated.
 */

import { describe, expect, it, vi } from 'vitest'

const enrichmentCalls: Array<unknown> = []
const languageCalls: Array<string | null | undefined> = []

vi.mock('@/util/subject_enrichment.js', () => ({
  enrichSubject: (ref: unknown) => {
    enrichmentCalls.push(ref)
    return {
      category: 'product:furniture',
      metadata: { brand: 'IKEA' },
    }
  },
}))

vi.mock('@/ingester/language-detect.js', () => ({
  detectLanguage: (text: string | null | undefined) => {
    languageCalls.push(text)
    return 'en'
  },
}))

import { resolveOrCreateSubject } from '@/db/queries/subjects'
import type { DrizzleDB } from '@/db/connection'

interface CapturedExecute {
  /** Last query passed to db.execute. */
  query: unknown
}

/**
 * Stub db.execute that captures the query + returns a row matching
 * the RETURNING shape (`id`, `canonical_subject_id`).
 */
function stubDb(): { db: DrizzleDB; captured: CapturedExecute } {
  const captured: CapturedExecute = { query: null }
  const db = {
    execute: async (q: unknown) => {
      captured.query = q
      return {
        rows: [{ id: 'sub_returning_id', canonical_subject_id: null }],
      }
    },
  } as unknown as DrizzleDB
  return { db, captured }
}

/**
 * Walk Drizzle's `sql` template structure. Each chunk is either:
 *   - a `StringChunk` wrapping literal SQL text in `.value: string[]`
 *   - a primitive (string / number / null / etc.) for `${value}`
 *     interpolations
 *
 * `extractParamValues` returns the primitives (the param positions),
 * `extractSqlText` joins the StringChunk literals so we can grep
 * the structural SQL.
 */
function isStringChunk(c: unknown): c is { value: string[] } {
  return (
    c !== null &&
    typeof c === 'object' &&
    Array.isArray((c as { value?: unknown }).value)
  )
}

function extractParamValues(query: unknown): unknown[] {
  const params: unknown[] = []
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? []
  for (const chunk of chunks) {
    if (!isStringChunk(chunk)) {
      params.push(chunk)
    }
  }
  return params
}

function extractSqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? []
  const parts: string[] = []
  for (const chunk of chunks) {
    if (isStringChunk(chunk)) parts.push(chunk.value.join(''))
  }
  return parts.join(' ')
}

describe('resolveOrCreateSubject inline enrichment — TN-ING-007', () => {
  it('calls enrichSubject(ref) and detectLanguage(name)', async () => {
    enrichmentCalls.length = 0
    languageCalls.length = 0
    const { db } = stubDb()

    await resolveOrCreateSubject(
      db,
      { type: 'product', name: 'Office Chair', identifier: 'ASIN:B07X' },
      'did:plc:alice',
    )

    // enrichSubject was passed the SubjectRef verbatim
    expect(enrichmentCalls).toHaveLength(1)
    expect(enrichmentCalls[0]).toMatchObject({
      type: 'product',
      name: 'Office Chair',
      identifier: 'ASIN:B07X',
    })
    // detectLanguage was passed the resolved subject name (NOT
    // the raw ref.name — the resolver picks name || uri || did ||
    // 'Unknown Subject'. For this ref, name is set so it equals
    // ref.name.)
    expect(languageCalls).toEqual(['Office Chair'])
  })

  it('passes the resolved name (not raw ref.name) to detectLanguage', async () => {
    languageCalls.length = 0
    const { db } = stubDb()

    // ref with no name → falls through to ref.uri
    await resolveOrCreateSubject(
      db,
      { type: 'content', uri: 'https://example.com/article' },
      'did:plc:alice',
    )

    expect(languageCalls).toEqual(['https://example.com/article'])
  })

  it('SQL carries enriched category + metadata + language', async () => {
    const { db, captured } = stubDb()

    await resolveOrCreateSubject(
      db,
      { type: 'product', name: 'Office Chair' },
      'did:plc:alice',
    )

    const params = extractParamValues(captured.query)
    // Parameters interpolated by `resolveOrCreateSubject` (in order):
    //   id, name, ref.type, did?, identifiers_json,
    //   category, metadata, language,
    //   author_scoped_did
    // The stub's enrichSubject returns category='product:furniture',
    // metadata={brand:'IKEA'}; detectLanguage returns 'en'. We assert
    // those values appear in the parameter set.
    expect(params).toContain('product:furniture')
    expect(params).toContain('en')
    expect(params).toContain(JSON.stringify({ brand: 'IKEA' }))
  })

  it('passes enrichment ref BEFORE the SQL execute (no race)', async () => {
    // The composer is called inline before db.execute; if a future
    // refactor moved enrichment AFTER the execute (e.g., on the
    // RETURNING row), the SQL would carry undefined values. Pinning
    // this ordering guards against that regression.
    enrichmentCalls.length = 0
    let executeCalledAt = 0
    let enrichCalledAt = 0
    const db = {
      execute: async () => {
        executeCalledAt = enrichmentCalls.length // snapshot
        return { rows: [{ id: 'sub_x', canonical_subject_id: null }] }
      },
    } as unknown as DrizzleDB

    await resolveOrCreateSubject(
      db,
      { type: 'product', name: 'X' },
      'did:plc:alice',
    )
    enrichCalledAt = enrichmentCalls.length

    // enrichmentCalls grew BEFORE execute snapshot was taken.
    expect(executeCalledAt).toBe(1) // enrichSubject ran first
    expect(enrichCalledAt).toBe(1) // and only once
  })

  it('SQL execute target is the subjects table (smoke check)', async () => {
    const { db, captured } = stubDb()
    await resolveOrCreateSubject(
      db,
      { type: 'product', name: 'X' },
      'did:plc:alice',
    )
    // The SQL string parts of a Drizzle template live on queryChunks
    // as plain strings interleaved with Param objects. Stringify the
    // chunks for substring search.
    const sqlText = extractSqlText(captured.query)
    expect(sqlText).toContain('INSERT INTO subjects')
    expect(sqlText.toLowerCase()).toContain('on conflict')
  })

  it('ON CONFLICT clause must NOT overwrite enrichment columns', async () => {
    // The whole point of inline-on-create: re-ingestion of the same
    // subject (because two attestations reference it) must NOT bump
    // enriched_at, otherwise the weekly batch (TN-ENRICH-006) would
    // never see it as stale + the operator's curated category would
    // be silently overwritten on every re-reference.
    const { db, captured } = stubDb()
    await resolveOrCreateSubject(
      db,
      { type: 'product', name: 'X' },
      'did:plc:alice',
    )
    const sqlText = extractSqlText(captured.query)

    // The DO UPDATE SET clause must list updated_at +
    // identifiers_json only — NOT category, metadata, language, or
    // enriched_at. Substring-style assertion: those column names
    // must NOT appear after the `DO UPDATE SET`.
    const doUpdateIdx = sqlText.toUpperCase().indexOf('DO UPDATE SET')
    expect(doUpdateIdx).toBeGreaterThan(-1)
    const updateClause = sqlText.slice(doUpdateIdx)
    expect(updateClause).not.toContain('category')
    expect(updateClause).not.toContain('metadata')
    expect(updateClause).not.toContain('language')
    expect(updateClause).not.toContain('enriched_at')
  })
})
