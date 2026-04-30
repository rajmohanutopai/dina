/**
 * Unit tests for `markDirty` hot-subject bound (TN-SCORE-008 / Plan
 * §13.7).
 *
 * Contract under test:
 *   - When `hotSubjectThreshold` is omitted → no gate; subject's
 *     dirty bit lands as before (backward compat with pre-TN-SCORE-008
 *     callers).
 *   - When supplied → the UPSERT's `setWhere` clause filters to
 *     `total_attestations IS NULL OR total_attestations <= threshold`
 *     so the UPDATE branch only runs for cold subjects.
 *   - DID-side dirty flagging is unaffected by the threshold (Plan
 *     §13.7: the hot-reviewer bound is satisfied by cascade fan-out
 *     cap from TN-SCORE-004, not by this gate).
 *
 * Strategy: drive `markDirty` with a stub DB that captures the SQL
 * chain — values, target, set, setWhere — so we can assert on the
 * setWhere predicate without spinning up Postgres. Drizzle's
 * `setWhere` is an `SQL` object; we introspect via `queryChunks`.
 */

import { describe, expect, it, vi } from 'vitest'

import { markDirty } from '@/db/queries/dirty-flags'
import { subjectScores, didProfiles } from '@/db/schema/index'
import type { DrizzleDB } from '@/db/connection'

interface CapturedInsert {
  table: unknown
  values: unknown
  conflict?: {
    target: unknown
    set: Record<string, unknown>
    setWhere?: unknown
  }
}

function makeStubDb(): { db: DrizzleDB; captures: CapturedInsert[] } {
  const captures: CapturedInsert[] = []
  const db = {
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        const cap: CapturedInsert = { table, values }
        captures.push(cap)
        return {
          onConflictDoUpdate: async (cfg: {
            target: unknown
            set: Record<string, unknown>
            setWhere?: unknown
          }) => {
            cap.conflict = {
              target: cfg.target,
              set: cfg.set,
              setWhere: cfg.setWhere,
            }
          },
        }
      },
    }),
  } as unknown as DrizzleDB
  return { db, captures }
}

/**
 * Drizzle's `sql` template returns an SQL object whose `queryChunks`
 * array contains a mix of StringChunk (literal SQL fragments) +
 * Param (bound values) + nested SQL. Reduce to a single SQL string
 * with $N placeholders for params + collect the param values.
 *
 * Same pattern as `subject_inline_enrich.test.ts` — extracted here
 * locally because the introspection cost is small + duplicating the
 * helper avoids cross-test coupling.
 */
function flattenSql(s: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = []
  const visit = (node: unknown): string => {
    if (node === null || node === undefined) return ''
    if (typeof node !== 'object') {
      // Primitive bound directly (number/string/boolean) — emit
      // placeholder + record. Drizzle sometimes nests these as
      // queryChunks elements.
      params.push(node)
      return `$${params.length}`
    }
    const n = node as Record<string, unknown>
    if (Array.isArray(n.queryChunks)) {
      return (n.queryChunks as unknown[]).map(visit).join('')
    }
    if (Array.isArray(n.value)) {
      // StringChunk: value is string[]
      return (n.value as string[]).join('')
    }
    if (typeof n.value === 'string') {
      return n.value
    }
    if ('value' in n) {
      // Param node — record value, emit placeholder
      params.push(n.value)
      return `$${params.length}`
    }
    return ''
  }
  const text = visit(s)
  return { text, params }
}

describe('markDirty hot-subject bound — TN-SCORE-008', () => {
  it('omitted threshold: subject upsert has no setWhere gate (backward compat)', async () => {
    const { db, captures } = makeStubDb()
    await markDirty(db, {
      subjectId: 'sub_a',
      authorDid: 'did:plc:author',
    })
    const subjectInsert = captures.find((c) => c.table === subjectScores)
    expect(subjectInsert).toBeDefined()
    expect(subjectInsert!.conflict?.setWhere).toBeUndefined()
  })

  it('threshold supplied: setWhere clause includes IS NULL OR <= threshold predicate', async () => {
    const { db, captures } = makeStubDb()
    await markDirty(db, {
      subjectId: 'sub_a',
      authorDid: 'did:plc:author',
      hotSubjectThreshold: 10000,
    })
    const subjectInsert = captures.find((c) => c.table === subjectScores)
    expect(subjectInsert).toBeDefined()
    // setWhere should be present; introspect its SQL.
    const setWhere = subjectInsert!.conflict!.setWhere
    expect(setWhere).toBeDefined()
    const { text, params } = flattenSql(setWhere)
    // Drizzle interpolates column references as opaque objects we
    // can't easily inline-render here, so match on the static SQL
    // fragments + bound param value. The literal column reference
    // is enforced by tsc (the source uses `${subjectScores.total
    // Attestations}` directly — a typo would fail to compile).
    expect(text).toMatch(/IS NULL/i)
    expect(text).toMatch(/<=/)
    // Threshold must be a bound param, not inlined into the SQL
    // (defends against accidental SQL injection if a future caller
    // passes a tainted threshold value).
    expect(params).toContain(10000)
  })

  it('threshold supplied: NULL total_attestations falls through (cold-subject default)', async () => {
    // Pinned by setWhere shape: `IS NULL OR total_attestations <= threshold`.
    // A subject with NULL counter (never refreshed) must be treated
    // as cold so its dirty bit lands. Otherwise the very first dirty
    // flag for a new subject would be lost.
    const { db, captures } = makeStubDb()
    await markDirty(db, {
      subjectId: 'fresh_subject',
      authorDid: 'did:plc:author',
      hotSubjectThreshold: 10000,
    })
    const subjectInsert = captures.find((c) => c.table === subjectScores)
    const { text } = flattenSql(subjectInsert!.conflict!.setWhere)
    // `IS NULL` clause must appear — NULL is the explicit
    // "first-time row" signal.
    expect(text).toMatch(/IS NULL/i)
  })

  it('DID-side dirty flagging is NOT gated by hotSubjectThreshold', async () => {
    // Plan §13.7 explicitly: hot-reviewer bound is satisfied by the
    // cascade fan-out cap (TN-SCORE-004), NOT by this gate. Pinned
    // here so a future refactor that "extends the gate to DIDs for
    // symmetry" doesn't quietly suppress reviewer-score updates for
    // popular reviewers.
    const { db, captures } = makeStubDb()
    await markDirty(db, {
      subjectId: 'sub_a',
      authorDid: 'did:plc:author',
      hotSubjectThreshold: 10000,
    })
    const didInsert = captures.find((c) => c.table === didProfiles)
    expect(didInsert).toBeDefined()
    expect(didInsert!.conflict?.setWhere).toBeUndefined()
  })

  it('no subject id: still flags DIDs, no subject INSERT issued', async () => {
    // Some handlers (e.g. revocation, reaction-on-vouch) call
    // markDirty with `subjectId: null` to flag only DIDs. The
    // hot-subject gate must not block these calls.
    const { db, captures } = makeStubDb()
    await markDirty(db, {
      subjectId: null,
      authorDid: 'did:plc:author',
      hotSubjectThreshold: 10000,
    })
    expect(captures.find((c) => c.table === subjectScores)).toBeUndefined()
    expect(captures.find((c) => c.table === didProfiles)).toBeDefined()
  })

  it('threshold = 0: every existing subject is hot (extreme operator kill-switch)', async () => {
    // Operator can effectively disable incremental subject scoring
    // by setting HOT_SUBJECT_THRESHOLD=0 in trust_v1_params. The
    // setWhere predicate becomes `IS NULL OR total_attestations <= 0`,
    // so the very first attestation lands and after that, no further
    // dirty bits flip until the nightly batch refreshes the row.
    // Useful as an emergency lever during a thundering-herd incident.
    const { db, captures } = makeStubDb()
    await markDirty(db, {
      subjectId: 'sub_a',
      authorDid: 'did:plc:author',
      hotSubjectThreshold: 0,
    })
    const subjectInsert = captures.find((c) => c.table === subjectScores)
    const { params } = flattenSql(subjectInsert!.conflict!.setWhere)
    expect(params).toContain(0)
  })

  it('subject UPSERT SET clause is unchanged: only flips needsRecalc', async () => {
    // Regression guard: setWhere shouldn't accidentally bring extra
    // columns into the SET clause. The dirty mark is single-column
    // (needsRecalc=true) — bumping computedAt or scoreVersion here
    // would corrupt the per-tick refresh ordering.
    const { db, captures } = makeStubDb()
    await markDirty(db, {
      subjectId: 'sub_a',
      authorDid: 'did:plc:author',
      hotSubjectThreshold: 10000,
    })
    const subjectInsert = captures.find((c) => c.table === subjectScores)
    expect(subjectInsert!.conflict!.set).toEqual({ needsRecalc: true })
  })
})
