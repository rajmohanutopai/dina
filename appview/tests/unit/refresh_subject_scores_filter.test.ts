/**
 * Unit coverage for the moderation filter on the subject-score
 * recompute. The scorer must NOT count moderator-taken-down (or
 * author-revoked) attestations when it aggregates a subject's score —
 * otherwise a taken-down review still moves the band even though
 * subject-get reports a reviewCount that excludes it.
 *
 * The full recompute is exercised end-to-end in the integration
 * suite (needs a real DB); this pins the WHERE-clause contract at the
 * unit boundary so a refactor that drops the filter fails loud here.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: { counter: vi.fn() },
}))
vi.mock('@/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { refreshSubjectScores } from '@/scorer/jobs/refresh-subject-scores'
import { attestations, subjectScores, didProfiles, vouches } from '@/db/schema/index'
import type { DrizzleDB } from '@/db/connection'

/**
 * Stub DB for the recompute flow:
 *   1. select(subjectScores).where(needsRecalc).limit()   → one dirty subject
 *   2. select(attestations).where(and(...))               → [] (CAPTURED)
 *   3. select(didProfiles).where(inArray)                 → []
 *   4. select(vouches).where(inArray)                     → []
 *   5. update(subjectScores).set().where()                → ok
 *
 * `.where()` returns a thenable that also carries `.limit()`, since
 * the dirty-subject query chains `.limit()` while the per-subject
 * fetches await `.where()` directly.
 */
function stubDb(): { db: DrizzleDB; getAttestationWhere: () => unknown } {
  let attestationWhere: unknown

  const tableName = (t: unknown): string => {
    if (t === subjectScores) return 'subject_scores'
    if (t === attestations) return 'attestations'
    if (t === didProfiles) return 'did_profiles'
    if (t === vouches) return 'vouches'
    return 'unknown'
  }

  const rowsFor = (name: string): unknown[] =>
    name === 'subject_scores' ? [{ subjectId: 'sub_x' }] : []

  const db = {
    select: () => ({
      from: (table: unknown) => {
        const name = tableName(table)
        const where = (filter: unknown) => {
          if (name === 'attestations') attestationWhere = filter
          const p = Promise.resolve(rowsFor(name)) as Promise<unknown[]> & {
            limit: () => Promise<unknown[]>
          }
          p.limit = () => Promise.resolve(rowsFor(name))
          return p
        }
        return { where }
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  } as unknown as DrizzleDB

  return { db, getAttestationWhere: () => attestationWhere }
}

describe('refreshSubjectScores — moderation filter', () => {
  it('excludes revoked AND moderator-taken-down attestations from scoring', async () => {
    const { db, getAttestationWhere } = stubDb()
    await refreshSubjectScores(db)

    const serialized = JSON.stringify(getAttestationWhere(), (_k, v) => {
      if (
        v !== null &&
        typeof v === 'object' &&
        'name' in (v as Record<string, unknown>) &&
        typeof (v as { name: unknown }).name === 'string'
      ) {
        return `col:${(v as { name: string }).name}`
      }
      return v
    })
    expect(serialized).toContain('col:is_revoked')
    expect(serialized).toContain('col:is_takedown_by_moderator')
  })
})
