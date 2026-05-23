/**
 * Unit tests for `appview/src/db/queries/admin-audit-log.ts`.
 *
 * The module is the typed chokepoint for inserts into the
 * `admin_audit_log` table. These tests pin two contracts:
 *   1. The closed action vocabulary (typo prevention).
 *   2. The insert shape (NULL-coalescing for optional fields).
 *
 * Plus a meta-test that scans the rest of the codebase for direct
 * `insert(adminAuditLog)` calls — if any future code path bypasses
 * the wrapper, this test fails.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import {
  ADMIN_ACTIONS,
  recordAdminAction,
  queryAuditLog,
  type AdminAction,
} from '@/db/queries/admin-audit-log'
import { adminAuditLog } from '@/db/schema/admin-audit-log'
import type { DrizzleDB } from '@/db/connection'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const APPVIEW_SRC = join(__dirname, '..', '..', 'src')

/** Capture the values handed to `insert(...).values(...)`. */
interface Captured {
  table: unknown
  values: Record<string, unknown> | null
}

function stubDb(returnId = 42n): { db: DrizzleDB; captured: Captured } {
  const captured: Captured = { table: null, values: null }
  const db = {
    insert: (table: unknown) => {
      captured.table = table
      return {
        values: (v: Record<string, unknown>) => {
          captured.values = v
          return {
            returning: async () => [{ id: returnId }],
          }
        },
      }
    },
  } as unknown as DrizzleDB
  return { db, captured }
}

describe('admin-audit-log wrapper', () => {
  describe('closed action vocabulary', () => {
    it('exports ADMIN_ACTIONS as a non-empty readonly tuple', () => {
      expect(ADMIN_ACTIONS.length).toBeGreaterThan(0)
      // Every entry is a snake_case identifier — no spaces, no
      // PascalCase, no punctuation. Matches the documented style.
      for (const action of ADMIN_ACTIONS) {
        expect(action).toMatch(/^[a-z][a-z0-9_]+$/)
      }
    })

    it('AdminAction union covers exactly ADMIN_ACTIONS', () => {
      // Compile-time guarantee via the const assertion. This runtime
      // test is a defense-in-depth signal: the array length matches
      // the documented vocabulary count. If a future commit removes a
      // verb from the array without bumping the test count, the
      // failure is loud.
      const expectedCount = 10
      expect(ADMIN_ACTIONS.length).toBe(expectedCount)
    })
  })

  describe('recordAdminAction insert shape', () => {
    it('writes a fully-specified row + returns the BigInt id', async () => {
      const { db, captured } = stubDb(99n)
      const id = await recordAdminAction(db, {
        actorDid: 'did:plc:operator',
        action: 'tombstone_subject',
        targetId: 'sub_abc123',
        reason: 'ToS violation',
        context: { detected_by: 'flag-threshold' },
      })
      expect(id).toBe(99n)
      expect(captured.table).toBe(adminAuditLog)
      expect(captured.values).toEqual({
        actorDid: 'did:plc:operator',
        action: 'tombstone_subject',
        targetId: 'sub_abc123',
        reason: 'ToS violation',
        contextJson: { detected_by: 'flag-threshold' },
      })
    })

    it('coalesces missing reason + context to null', async () => {
      // The schema has both columns nullable. The wrapper substitutes
      // `null` explicitly rather than letting `undefined` reach
      // Drizzle (which would NOT include the column in the INSERT,
      // leaving the DB to apply its default — none for these).
      const { db, captured } = stubDb()
      await recordAdminAction(db, {
        actorDid: 'did:plc:operator',
        action: 'recompute_subject_score',
        targetId: 'sub_xyz',
      })
      expect(captured.values?.reason).toBeNull()
      expect(captured.values?.contextJson).toBeNull()
    })

    it('does NOT accept timestamps from the caller', async () => {
      // performed_at is server-stamped via the schema's DEFAULT NOW().
      // The wrapper deliberately omits any field that would let the
      // caller backdate / forge an entry. Callers passing extra
      // fields are caught by TypeScript at compile time.
      const { db, captured } = stubDb()
      await recordAdminAction(db, {
        actorDid: 'did:plc:operator',
        action: 'merge_subjects',
        targetId: 'sub_canonical',
      })
      // `performed_at` must not appear in the INSERT values — Drizzle
      // (and the DB DEFAULT) will fill it.
      expect(captured.values).not.toHaveProperty('performedAt')
      expect(captured.values).not.toHaveProperty('performed_at')
    })

    it('targets the adminAuditLog table by identity', async () => {
      const { db, captured } = stubDb()
      await recordAdminAction(db, {
        actorDid: 'did:plc:operator',
        action: 'redact_did',
        targetId: 'did:plc:redacted',
      })
      // Identity check, not name check — catches a future refactor
      // that accidentally inserts into a sibling table.
      expect(captured.table).toBe(adminAuditLog)
    })
  })

  describe('chokepoint enforcement (no direct inserts elsewhere)', () => {
    it('no source file outside the wrapper inserts into adminAuditLog', () => {
      // Walk the src tree, find any file that calls
      // `.insert(adminAuditLog)`. Only `db/queries/admin-audit-log.ts`
      // is allowed. Anything else is a contract violation — it
      // bypasses the typed chokepoint.
      const offenders: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
          const full = join(dir, entry)
          const st = statSync(full)
          if (st.isDirectory()) {
            walk(full)
          } else if (entry.endsWith('.ts')) {
            const text = readFileSync(full, 'utf8')
            // Look for `.insert(adminAuditLog)` literal. Catches the
            // direct Drizzle insert pattern. Wrapper-internal call
            // is exempt.
            if (
              text.includes('insert(adminAuditLog)') &&
              !full.endsWith('admin-audit-log.ts')
            ) {
              offenders.push(full)
            }
          }
        }
      }
      walk(APPVIEW_SRC)
      expect(offenders, `unauthorized inserts to adminAuditLog`).toEqual([])
    })
  })

  describe('type narrowing', () => {
    it('AdminAction type extracts a string-literal union', () => {
      // This is a compile-time guarantee — if you pass an unknown
      // string, TypeScript rejects it. The runtime check below
      // exercises the const-assertion narrowing.
      const verb: AdminAction = 'tombstone_subject'
      expect(typeof verb).toBe('string')
    })
  })

  // ─────────────────────────────────────────────────────────────────
  // queryAuditLog — read-side surface moved here from the CLI so
  // the wrapper is the single chokepoint for both reads + writes.
  // ─────────────────────────────────────────────────────────────────

  describe('queryAuditLog', () => {
    /**
     * Read-side stub: captures the `where()` filter + `limit()`
     * arguments without modeling the full Drizzle types.
     */
    interface ReadCaptured {
      whereCalled: boolean
      limit: number | null
    }
    function readStub(
      rows: Array<Record<string, unknown>>,
    ): { db: DrizzleDB; captured: ReadCaptured } {
      const captured: ReadCaptured = { whereCalled: false, limit: null }
      const db = {
        select: () => ({
          from: () => ({
            where: (_filter: unknown) => {
              captured.whereCalled = true
              return {
                orderBy: () => ({
                  limit: async (n: number) => {
                    captured.limit = n
                    return rows
                  },
                }),
              }
            },
          }),
        }),
      } as unknown as DrizzleDB
      return { db, captured }
    }

    it('applies default limit of 50 when none provided', async () => {
      const { db, captured } = readStub([])
      await queryAuditLog(db, {})
      expect(captured.limit).toBe(50)
    })

    it('honors caller-supplied limit', async () => {
      const { db, captured } = readStub([])
      await queryAuditLog(db, { limit: 17 })
      expect(captured.limit).toBe(17)
    })

    it('rejects non-positive, fractional, and overlarge limits', async () => {
      const { db } = readStub([])
      await expect(queryAuditLog(db, { limit: 0 })).rejects.toThrow()
      await expect(queryAuditLog(db, { limit: -1 })).rejects.toThrow()
      await expect(queryAuditLog(db, { limit: 1001 })).rejects.toThrow()
      await expect(queryAuditLog(db, { limit: 1.5 })).rejects.toThrow()
    })

    it('returns rows verbatim from the underlying query', async () => {
      const rows = [
        {
          id: 1n,
          performedAt: new Date(),
          actorDid: 'did:plc:a',
          action: 'tombstone_subject',
          targetId: 'sub_x',
          reason: 'r',
          contextJson: {},
        },
      ]
      const { db } = readStub(rows)
      const out = await queryAuditLog(db, {})
      expect(out).toEqual(rows)
    })
  })
})
