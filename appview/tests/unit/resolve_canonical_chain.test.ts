/**
 * Unit tests for `resolveCanonicalChain` — the merge-chain walk that
 * maps a (possibly fragmented / merged-away) subject_id to its
 * canonical root.
 *
 * Focus: the dangling-pointer case. `canonical_subject_id` has no FK
 * constraint, so a merge target can be deleted while a row still
 * points at it. The walk must return the last EXISTING id, not the
 * phantom target — otherwise subjectGet 404s a subject that exists.
 */

import { describe, it, expect, vi } from 'vitest'
import { resolveCanonicalChain } from '@/db/queries/subjects'
import type { DrizzleDB } from '@/db/connection'

/**
 * Stub `db.execute` with a queue of row-sets returned in call order.
 * The walk queries `WHERE id = <currentId>` once per hop, so the
 * queue maps 1:1 to the chain steps. `[]` models a missing row.
 */
function stubDb(rowSets: Array<Array<{ canonical_subject_id: string | null }>>): DrizzleDB {
  let call = 0
  return {
    execute: vi.fn(async () => {
      const rows = rowSets[call] ?? []
      call += 1
      return { rows } as unknown
    }),
  } as unknown as DrizzleDB
}

describe('resolveCanonicalChain', () => {
  it('returns startId when the subject is terminal (no canonical pointer)', async () => {
    const db = stubDb([[{ canonical_subject_id: null }]])
    expect(await resolveCanonicalChain(db, 'sub_a')).toBe('sub_a')
  })

  it('follows a multi-hop chain to the terminal root', async () => {
    // sub_a → sub_b → sub_c (terminal)
    const db = stubDb([
      [{ canonical_subject_id: 'sub_b' }],
      [{ canonical_subject_id: 'sub_c' }],
      [{ canonical_subject_id: null }],
    ])
    expect(await resolveCanonicalChain(db, 'sub_a')).toBe('sub_c')
  })

  it('returns the LAST EXISTING id when a pointer dangles to a missing row', async () => {
    // sub_a → sub_b, but sub_b's row was deleted (orphan-GC). The walk
    // must resolve to sub_a (which exists), not sub_b (the phantom).
    const db = stubDb([
      [{ canonical_subject_id: 'sub_b' }], // sub_a exists, points at sub_b
      [], // sub_b missing
    ])
    expect(await resolveCanonicalChain(db, 'sub_a')).toBe('sub_a')
  })

  it('returns startId when startId itself is missing (genuine not-found)', async () => {
    // No row for the start id at all → caller's "not found" path fires.
    const db = stubDb([[]])
    expect(await resolveCanonicalChain(db, 'sub_missing')).toBe('sub_missing')
  })

  it('resolves the deepest existing id when a long chain dangles at the end', async () => {
    // sub_a → sub_b → sub_c(missing): resolve to sub_b, not sub_c.
    const db = stubDb([
      [{ canonical_subject_id: 'sub_b' }],
      [{ canonical_subject_id: 'sub_c' }],
      [], // sub_c missing
    ])
    expect(await resolveCanonicalChain(db, 'sub_a')).toBe('sub_b')
  })

  it('breaks a self-referential cycle without infinite-looping', async () => {
    // sub_a → sub_a (degenerate self-cycle). The visited-set guard
    // returns the current id rather than spinning.
    const db = stubDb([[{ canonical_subject_id: 'sub_a' }]])
    expect(await resolveCanonicalChain(db, 'sub_a')).toBe('sub_a')
  })
})
