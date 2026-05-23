/**
 * Tombstoned subjects must not leak into discovery / trust-decision
 * surfaces. subject-get already renders a "removed" state; these tests
 * pin the parallel guards on the OTHER read paths:
 *   - getAlternatives: a tombstoned subject is never a suggested
 *     alternative (WHERE references subjects.tombstoned_at).
 *   - resolve: a tombstoned subject short-circuits to a hard `avoid`
 *     with all trust-bearing fields zeroed — it must never green-light
 *     a transaction.
 */

import { describe, it, expect, vi } from 'vitest'

// resolve() calls resolveSubject() to mint/resolve the canonical id.
// Mock it so the test drives the tombstone branch deterministically.
const resolveSubjectMock = vi.fn()
vi.mock('@/db/queries/subjects.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/queries/subjects.js')>()
  return { ...actual, resolveSubject: (...a: unknown[]) => resolveSubjectMock(...a) }
})

import { getAlternatives } from '@/api/xrpc/get-alternatives'
import { resolve } from '@/api/xrpc/resolve'
import type { DrizzleDB } from '@/db/connection'

// ─── getAlternatives ───────────────────────────────────────────────

describe('getAlternatives — tombstone exclusion', () => {
  let capturedWhere: unknown

  function stubDb(): DrizzleDB {
    capturedWhere = undefined
    // First query: subject category lookup (from→where→limit).
    // Second query: peers (from→leftJoin→where→orderBy→limit).
    let call = 0
    return {
      select: () => ({
        from: () => {
          call += 1
          if (call === 1) {
            return {
              where: () => ({ limit: async () => [{ category: 'commerce/product:chair' }] }),
            }
          }
          return {
            leftJoin: () => ({
              where: (w: unknown) => {
                capturedWhere = w
                return { orderBy: () => ({ limit: async () => [] }) }
              },
            }),
          }
        },
      }),
    } as unknown as DrizzleDB
  }

  it('WHERE references subjects.tombstoned_at', async () => {
    const db = stubDb()
    await getAlternatives(db, { subjectId: 'sub_x', count: 3 } as never)
    const serialized = JSON.stringify(capturedWhere, (_k, v) => {
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
    expect(serialized).toContain('col:tombstoned_at')
  })
})

// ─── resolve ───────────────────────────────────────────────────────

describe('resolve — tombstoned subject short-circuits to avoid', () => {
  function stubDb(opts: { tombstonedAt: Date | null }): DrizzleDB {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ tombstonedAt: opts.tombstonedAt }],
          }),
        }),
      }),
    } as unknown as DrizzleDB
  }

  it('returns recommendation=avoid + zeroed trust fields when tombstoned', async () => {
    resolveSubjectMock.mockResolvedValueOnce('sub_removed')
    const db = stubDb({ tombstonedAt: new Date('2026-05-23T00:00:00Z') })
    const r = await resolve(db, {
      subject: JSON.stringify({ type: 'product', name: 'Removed Chair' }),
    } as never)
    expect(r.subjectId).toBe('sub_removed')
    expect(r.recommendation).toBe('avoid')
    expect(r.trustLevel).toBe('none')
    expect(r.reviewCount).toBe(0)
    expect(r.confidence).toBe(0)
    expect(r.reasoning).toMatch(/removed by a moderator/i)
  })
})
