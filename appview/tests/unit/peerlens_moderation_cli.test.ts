/**
 * Unit tests for `appview/src/admin/peerlens-moderation-cli.ts`.
 *
 * Pin these contracts:
 *   1. Argument parsing matches the documented usage. `--help` returns
 *      the sentinel rather than calling `process.exit` from inside
 *      the parser.
 *   2. Every state-changing command runs in `db.transaction()`. The
 *      audit-log INSERT happens BEFORE the target-table UPDATE in
 *      the same tx (assertion is a recorded happens-before, not a
 *      "both happened").
 *   3. `--reason` is required on EVERY state-changing command,
 *      including undo verbs (untombstone, restore). Audit trail
 *      uniformly rich.
 *   4. `--actor` is regex-validated as a DID before any DB work.
 *   5. Dispatcher rejects unknown commands / subcommands / verbs.
 *   6. BigInt result fields serialize via the replacer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const recordAdminActionMock = vi.fn()

vi.mock('@/db/queries/admin-audit-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/queries/admin-audit-log')>()
  return {
    ...actual,
    recordAdminAction: (...args: unknown[]) => recordAdminActionMock(...args),
  }
})

// markDirty has its own unit tests; here we only assert the CLI calls
// it (so a takedown/restore triggers score recalc). Mocking it also
// keeps the stub DB free of subject_scores / did_profiles insert wiring.
// Untyped `vi.fn()` (like recordAdminActionMock) so the variadic
// passthrough below type-checks — a concrete `async () => {}` would
// fix the arity at zero and reject the spread.
const markDirtyMock = vi.fn()
vi.mock('@/db/queries/dirty-flags', () => ({
  markDirty: (...args: unknown[]) => markDirtyMock(...args),
}))

import {
  HELP_SENTINEL,
  parseArgs,
  dispatch,
  tombstoneSubject,
  untombstoneSubject,
  takedownAttestation,
  restoreAttestation,
  tombstoneService,
  untombstoneService,
  bigintReplacer,
  helpText,
} from '@/admin/peerlens-moderation-cli'
import { subjects } from '@/db/schema/subjects'
import { attestations } from '@/db/schema/attestations'
import { services } from '@/db/schema/services'
import { adminAuditLog } from '@/db/schema/admin-audit-log'
import type { DrizzleDB } from '@/db/connection'

beforeEach(() => {
  recordAdminActionMock.mockReset()
  recordAdminActionMock.mockResolvedValue(123n)
  markDirtyMock.mockClear()
})

// ─────────────────────────────────────────────────────────────────────────
// DB stub. Routes by table identity + supports `db.transaction()` +
// `update().set().where().returning()`. Tracks a shared event timeline
// so tests can assert happens-before on (audit, mutation).
// ─────────────────────────────────────────────────────────────────────────

interface StubOpts {
  subjectRow?: { tombstonedAt: Date | null; tombstoneReason: string | null }
  // takedown/restore now also SELECT subjectId + authorDid (to mark
  // them dirty); optional so existing fixtures that omit them still
  // route through the `attestations` branch.
  attestationRow?: {
    isTakedown: boolean
    reason: string | null
    subjectId?: string | null
    authorDid?: string
  }
  serviceRow?: { tombstonedAt: Date | null; tombstoneReason: string | null }
  /** Override the row returned by `.update().returning()` for assertions. */
  updateReturning?: Record<string, unknown>
  /**
   * Force `.update().returning()` to yield `[]` — models the row
   * vanishing between the FOR UPDATE select and the UPDATE (or a
   * WHERE that matched nothing). Exercises the assert-RETURNING guard.
   */
  updateReturningEmpty?: boolean
}

interface Captured {
  /** Ordered timeline. Each entry is an event tag. */
  events: string[]
  /** Most recent `.update().set(values)` payload per table. */
  lastUpdateValues: Record<string, Record<string, unknown> | null>
  /** True if `db.transaction()` was opened at least once. */
  txOpened: boolean
  /** True if a `.limit(...).for('update')` row lock was requested. */
  forUpdate: boolean
}

function stubDb(opts: StubOpts = {}): { db: DrizzleDB; captured: Captured } {
  const captured: Captured = {
    events: [],
    lastUpdateValues: {},
    txOpened: false,
    forUpdate: false,
  }

  const tableName = (t: unknown): string => {
    if (t === subjects) return 'subjects'
    if (t === attestations) return 'attestations'
    if (t === services) return 'services'
    if (t === adminAuditLog) return 'admin_audit_log'
    return 'unknown'
  }

  /** Drizzle-shaped executor used both for `db` and the tx callback's `tx`. */
  function makeExecutor(prefix = ''): unknown {
    return {
      select: (_sel?: unknown) => ({
        from: (table: unknown) => {
          const name = tableName(table)
          captured.events.push(`${prefix}select:${name}`)
          const resolveRows = (): unknown[] => {
            if (name === 'subjects' && opts.subjectRow !== undefined) {
              return [opts.subjectRow]
            }
            if (name === 'attestations' && opts.attestationRow !== undefined) {
              return [opts.attestationRow]
            }
            if (name === 'services' && opts.serviceRow !== undefined) {
              return [opts.serviceRow]
            }
            return []
          }
          // `.limit(1)` is awaited directly in some paths and chained
          // with `.for('update')` in the moderation functions. Return
          // a thenable that ALSO carries `.for()` (returning itself)
          // so both shapes resolve to the same rows.
          const limitResult = () => {
            const p = Promise.resolve(resolveRows()) as Promise<unknown[]> & {
              for: () => Promise<unknown[]>
            }
            p.for = () => {
              captured.forUpdate = true
              return p
            }
            return p
          }
          return {
            where: () => ({
              limit: limitResult,
            }),
          }
        },
      }),
      update: (table: unknown) => {
        const name = tableName(table)
        return {
          set: (values: Record<string, unknown>) => {
            captured.lastUpdateValues[name] = values
            return {
              where: () => ({
                returning: async () => {
                  captured.events.push(`${prefix}update:${name}`)
                  return opts.updateReturningEmpty
                    ? []
                    : [opts.updateReturning ?? values]
                },
              }),
            }
          },
        }
      },
    }
  }

  const root = makeExecutor() as Record<string, unknown>
  root.transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
    captured.txOpened = true
    captured.events.push('tx:begin')
    const tx = makeExecutor('tx:')
    const out = await fn(tx)
    captured.events.push('tx:commit')
    return out
  }
  return { db: root as unknown as DrizzleDB, captured }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Argument parser
// ─────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses subject tombstone with flags', () => {
    const a = parseArgs([
      'node', 'cli',
      'subject', 'tombstone', 'sub_abc',
      '--actor', 'did:plc:op',
      '--reason', 'spam',
    ])
    expect(a).toEqual({
      command: 'subject',
      subcommand: 'tombstone',
      positional: ['sub_abc'],
      flags: { actor: 'did:plc:op', reason: 'spam' },
    })
  })

  it('parses attestation takedown with at:// URI positional', () => {
    const a = parseArgs([
      'node', 'cli',
      'attestation', 'takedown',
      'at://did:plc:author/com.dinakernel.peerlens.attestation/xyz',
      '--actor', 'did:plc:op',
      '--reason', 'hate',
    ])
    expect(a.command).toBe('attestation')
    expect(a.subcommand).toBe('takedown')
    expect(a.positional[0]).toMatch(/^at:\/\//)
  })

  it('parses audit-log with only flags (no positional, no subcommand)', () => {
    const a = parseArgs([
      'node', 'cli',
      'audit-log',
      '--action', 'tombstone_subject',
      '--limit', '20',
    ])
    expect(a.command).toBe('audit-log')
    expect(a.subcommand).toBeUndefined()
    expect(a.flags.action).toBe('tombstone_subject')
    expect(a.flags.limit).toBe('20')
  })

  it('rejects flags with missing values', () => {
    expect(() =>
      parseArgs(['node', 'cli', 'subject', 'tombstone', 'sub_abc', '--reason']),
    ).toThrow(/missing value/i)
  })

  it('rejects flags chained without their value', () => {
    expect(() =>
      parseArgs([
        'node', 'cli',
        'subject', 'tombstone', 'sub_abc',
        '--actor', '--reason', 'spam',
      ]),
    ).toThrow(/missing value/i)
  })

  it('rejects empty argv', () => {
    expect(() => parseArgs(['node', 'cli'])).toThrow(/missing command/i)
  })

  it('rejects subject without subcommand', () => {
    expect(() => parseArgs(['node', 'cli', 'subject'])).toThrow(
      /missing subcommand/i,
    )
  })

  it('--help returns the sentinel command (no process.exit)', () => {
    // Critical: the parser does NOT call process.exit — the dispatcher
    // handles the help branch. Lets tests exercise the help path
    // without forking the test runner.
    const a = parseArgs(['node', 'cli', '--help'])
    expect(a.command).toBe(HELP_SENTINEL)
    const b = parseArgs(['node', 'cli', '-h'])
    expect(b.command).toBe(HELP_SENTINEL)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 2. Help text content (pin examples + flag docs so accidental
// deletion fails)
// ─────────────────────────────────────────────────────────────────────────

describe('helpText', () => {
  it('lists all five commands', () => {
    const h = helpText()
    expect(h).toMatch(/subject tombstone/)
    expect(h).toMatch(/subject untombstone/)
    expect(h).toMatch(/attestation takedown/)
    expect(h).toMatch(/attestation restore/)
    expect(h).toMatch(/audit-log/)
  })

  it('documents the env-var fallback for --actor', () => {
    expect(helpText()).toMatch(/DINA_ADMIN_ACTOR_DID/)
  })

  it('flags --reason as required for EVERY state-changing command', () => {
    expect(helpText()).toMatch(/Required for EVERY state-changing command/)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 3. State-changing commands — TRANSACTIONAL + audit BEFORE mutation
// ─────────────────────────────────────────────────────────────────────────

describe('tombstoneSubject', () => {
  it('locks the row FOR UPDATE before mutating', async () => {
    const { db, captured } = stubDb({
      subjectRow: { tombstonedAt: null, tombstoneReason: null },
    })
    await tombstoneSubject(db, { subjectId: 'sub_x', actorDid: 'did:plc:op', reason: 'spam' })
    expect(captured.forUpdate).toBe(true)
  })

  it('throws when the UPDATE matches no row (never commits an audit for a no-op)', async () => {
    // Models the subject vanishing between the FOR UPDATE select and
    // the UPDATE. The function MUST throw so the whole tx (including
    // the already-inserted audit row) rolls back — an audit entry for
    // a mutation that didn't land is the B1 hazard.
    const { db } = stubDb({
      subjectRow: { tombstonedAt: null, tombstoneReason: null },
      updateReturningEmpty: true,
    })
    await expect(
      tombstoneSubject(db, { subjectId: 'sub_x', actorDid: 'did:plc:op', reason: 'spam' }),
    ).rejects.toThrow(/vanished mid-update/i)
  })

  it('opens a transaction and runs audit + mutation inside it', async () => {
    const { db, captured } = stubDb({
      subjectRow: { tombstonedAt: null, tombstoneReason: null },
      updateReturning: {
        tombstonedAt: new Date('2026-05-23T00:00:00Z'),
        tombstoneReason: 'spam',
      },
    })
    await tombstoneSubject(db, {
      subjectId: 'sub_x',
      actorDid: 'did:plc:op',
      reason: 'spam',
    })
    expect(captured.txOpened).toBe(true)
    // All events that mention a table should be the tx-prefixed ones,
    // not root ones — the command must NOT bypass the tx.
    const txEvents = captured.events.filter((e) => e.startsWith('tx:'))
    const rootTableEvents = captured.events.filter(
      (e) => !e.startsWith('tx:') && (e.includes('select:') || e.includes('update:')),
    )
    expect(rootTableEvents).toEqual([])
    expect(txEvents).toContain('tx:begin')
    expect(txEvents).toContain('tx:commit')
  })

  it('writes audit BEFORE the subjects UPDATE (actual ordering)', async () => {
    // Record the absolute call order to assert happens-before.
    // recordAdminActionMock appends 'audit:recorded' to the events
    // timeline so we can position it relative to 'tx:update:subjects'.
    const { db, captured } = stubDb({
      subjectRow: { tombstonedAt: null, tombstoneReason: null },
    })
    recordAdminActionMock.mockImplementation(async () => {
      captured.events.push('audit:recorded')
      return 42n
    })
    await tombstoneSubject(db, {
      subjectId: 'sub_x',
      actorDid: 'did:plc:op',
      reason: 'spam',
    })
    const auditIdx = captured.events.indexOf('audit:recorded')
    const updateIdx = captured.events.indexOf('tx:update:subjects')
    expect(auditIdx).toBeGreaterThanOrEqual(0)
    expect(updateIdx).toBeGreaterThanOrEqual(0)
    expect(auditIdx).toBeLessThan(updateIdx)
  })

  it('passes the tx executor (not the db) to recordAdminAction', async () => {
    // Critical: the audit + mutation must share the SAME transaction.
    // Passing `db` instead of `tx` would split them into two implicit
    // transactions, defeating the rollback guarantee.
    const { db } = stubDb({
      subjectRow: { tombstonedAt: null, tombstoneReason: null },
    })
    await tombstoneSubject(db, {
      subjectId: 'sub_x',
      actorDid: 'did:plc:op',
      reason: 'spam',
    })
    // The first argument to recordAdminAction is the executor.
    // We expect it to be the tx object (which has `.select` but
    // no `.transaction` — only the root db has `.transaction`).
    const callExecutor = recordAdminActionMock.mock.calls[0][0]
    expect(callExecutor).toBeDefined()
    expect(typeof (callExecutor as Record<string, unknown>).select).toBe(
      'function',
    )
    // It should NOT be the root db (which exposes `.transaction`).
    expect(
      typeof (callExecutor as Record<string, unknown>).transaction,
    ).toBe('undefined')
  })

  it('throws when the subject does not exist + does NOT write audit', async () => {
    const { db } = stubDb({}) // no subjectRow
    await expect(
      tombstoneSubject(db, {
        subjectId: 'sub_missing',
        actorDid: 'did:plc:op',
        reason: 'spam',
      }),
    ).rejects.toThrow(/not found/i)
    // Precondition fail: NO audit row written (the tx rolls back).
    expect(recordAdminActionMock).not.toHaveBeenCalled()
  })

  it('uses RETURNING to populate `after` (no separate SELECT-after)', async () => {
    // Earlier impl did SELECT-after-UPDATE which had a race window
    // with concurrent writers. RETURNING is atomic. We assert by
    // counting that `subjects` is read ONCE (the before-state read).
    const { db, captured } = stubDb({
      subjectRow: { tombstonedAt: null, tombstoneReason: null },
    })
    await tombstoneSubject(db, {
      subjectId: 'sub_x',
      actorDid: 'did:plc:op',
      reason: 'spam',
    })
    const subjectsSelects = captured.events.filter(
      (e) => e === 'tx:select:subjects',
    )
    expect(subjectsSelects).toHaveLength(1)
  })
})

describe('untombstoneSubject', () => {
  it('requires a reason (passed through; not optional anymore)', async () => {
    const { db } = stubDb({
      subjectRow: {
        tombstonedAt: new Date('2026-05-01T00:00:00Z'),
        tombstoneReason: 'old',
      },
    })
    await untombstoneSubject(db, {
      subjectId: 'sub_x',
      actorDid: 'did:plc:op',
      reason: 'appeal granted',
    })
    expect(recordAdminActionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'untombstone_subject',
        reason: 'appeal granted',
      }),
    )
  })

  it('clears tombstone columns via the tx', async () => {
    const { db, captured } = stubDb({
      subjectRow: {
        tombstonedAt: new Date('2026-05-01T00:00:00Z'),
        tombstoneReason: 'old',
      },
    })
    await untombstoneSubject(db, {
      subjectId: 'sub_x',
      actorDid: 'did:plc:op',
      reason: 'appeal granted',
    })
    expect(captured.lastUpdateValues.subjects).toEqual({
      tombstonedAt: null,
      tombstoneReason: null,
    })
  })
})

describe('takedownAttestation', () => {
  it('flips isTakedownByModerator + writes audit in tx', async () => {
    const { db, captured } = stubDb({
      attestationRow: { isTakedown: false, reason: null },
    })
    await takedownAttestation(db, {
      uri: 'at://did:plc:author/com.dinakernel.peerlens.attestation/x',
      actorDid: 'did:plc:op',
      reason: 'spam',
    })
    expect(captured.txOpened).toBe(true)
    expect(captured.lastUpdateValues.attestations).toMatchObject({
      isTakedownByModerator: true,
      takedownReason: 'spam',
      takedownAt: expect.any(Date),
    })
  })

  it('throws when URI is unknown + does NOT write audit', async () => {
    const { db } = stubDb({})
    await expect(
      takedownAttestation(db, {
        uri: 'at://did:plc:x/com.dinakernel.peerlens.attestation/missing',
        actorDid: 'did:plc:op',
        reason: 'x',
      }),
    ).rejects.toThrow(/not found/i)
    expect(recordAdminActionMock).not.toHaveBeenCalled()
  })

  it('locks the row FOR UPDATE before mutating', async () => {
    const { db, captured } = stubDb({
      attestationRow: { isTakedown: false, reason: null, subjectId: 'sub_x', authorDid: 'did:plc:author' },
    })
    await takedownAttestation(db, {
      uri: 'at://did:plc:author/com.dinakernel.peerlens.attestation/x',
      actorDid: 'did:plc:op',
      reason: 'spam',
    })
    expect(captured.forUpdate).toBe(true)
  })

  it('marks the subject + author dirty so the score recomputes without the taken-down row', async () => {
    const { db } = stubDb({
      attestationRow: { isTakedown: false, reason: null, subjectId: 'sub_x', authorDid: 'did:plc:author' },
    })
    await takedownAttestation(db, {
      uri: 'at://did:plc:author/com.dinakernel.peerlens.attestation/x',
      actorDid: 'did:plc:op',
      reason: 'spam',
    })
    expect(markDirtyMock).toHaveBeenCalledTimes(1)
    expect(markDirtyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subjectId: 'sub_x', authorDid: 'did:plc:author' }),
    )
  })
})

describe('tombstoneService', () => {
  it('opens a transaction + writes audit then updates services', async () => {
    const { db, captured } = stubDb({
      serviceRow: { tombstonedAt: null, tombstoneReason: null },
    })
    await tombstoneService(db, {
      serviceUri: 'at://did:plc:p/com.dinakernel.service.profile/self',
      actorDid: 'did:plc:op',
      reason: 'ToS - misrepresentation of capability',
    })
    expect(captured.txOpened).toBe(true)
    expect(captured.lastUpdateValues.services).toMatchObject({
      tombstonedAt: expect.any(Date),
      tombstoneReason: 'ToS - misrepresentation of capability',
    })
    expect(recordAdminActionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'tombstone_service',
        targetId: 'at://did:plc:p/com.dinakernel.service.profile/self',
        reason: 'ToS - misrepresentation of capability',
      }),
    )
  })

  it('throws when the service URI is unknown + does NOT write audit', async () => {
    const { db } = stubDb({})
    await expect(
      tombstoneService(db, {
        serviceUri: 'at://did:plc:missing/com.dinakernel.service.profile/self',
        actorDid: 'did:plc:op',
        reason: 'x',
      }),
    ).rejects.toThrow(/not found/i)
    expect(recordAdminActionMock).not.toHaveBeenCalled()
  })
})

describe('untombstoneService', () => {
  it('clears tombstone columns and writes audit with reason', async () => {
    const { db, captured } = stubDb({
      serviceRow: {
        tombstonedAt: new Date('2026-05-22T10:00:00Z'),
        tombstoneReason: 'old',
      },
    })
    await untombstoneService(db, {
      serviceUri: 'at://did:plc:p/com.dinakernel.service.profile/self',
      actorDid: 'did:plc:op',
      reason: 'restored after operator appeal',
    })
    expect(captured.lastUpdateValues.services).toEqual({
      tombstonedAt: null,
      tombstoneReason: null,
    })
    expect(recordAdminActionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'untombstone_service',
        reason: 'restored after operator appeal',
      }),
    )
  })
})

describe('restoreAttestation', () => {
  it('requires a reason (parity with takedown)', async () => {
    const { db } = stubDb({
      attestationRow: { isTakedown: true, reason: 'spam' },
    })
    await restoreAttestation(db, {
      uri: 'at://did:plc:author/com.dinakernel.peerlens.attestation/x',
      actorDid: 'did:plc:op',
      reason: 'mistaken takedown',
    })
    expect(recordAdminActionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'restore_attestation',
        reason: 'mistaken takedown',
      }),
    )
  })

  it('clears takedown columns', async () => {
    const { db, captured } = stubDb({
      attestationRow: { isTakedown: true, reason: 'spam' },
    })
    await restoreAttestation(db, {
      uri: 'at://did:plc:author/com.dinakernel.peerlens.attestation/x',
      actorDid: 'did:plc:op',
      reason: 'mistaken',
    })
    expect(captured.lastUpdateValues.attestations).toEqual({
      isTakedownByModerator: false,
      takedownReason: null,
      takedownAt: null,
    })
  })

  it('locks FOR UPDATE + marks subject/author dirty (re-includes the restored row)', async () => {
    const { db, captured } = stubDb({
      attestationRow: { isTakedown: true, reason: 'spam', subjectId: 'sub_x', authorDid: 'did:plc:author' },
    })
    await restoreAttestation(db, {
      uri: 'at://did:plc:author/com.dinakernel.peerlens.attestation/x',
      actorDid: 'did:plc:op',
      reason: 'mistaken',
    })
    expect(captured.forUpdate).toBe(true)
    expect(markDirtyMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ subjectId: 'sub_x', authorDid: 'did:plc:author' }),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 4. Dispatcher routing + flag validation
// ─────────────────────────────────────────────────────────────────────────

describe('dispatch', () => {
  it('routes subject tombstone with --actor + --reason', async () => {
    const { db } = stubDb({
      subjectRow: { tombstonedAt: null, tombstoneReason: null },
    })
    await dispatch(db, {
      command: 'subject',
      subcommand: 'tombstone',
      positional: ['sub_x'],
      flags: { actor: 'did:plc:op', reason: 'spam' },
    })
    expect(recordAdminActionMock).toHaveBeenCalledOnce()
  })

  it('requires --reason on subject tombstone', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'subject',
        subcommand: 'tombstone',
        positional: ['sub_x'],
        flags: { actor: 'did:plc:op' },
      }),
    ).rejects.toThrow(/reason/)
  })

  it('rejects EXTRA positional args on a state-changing command (no silent drop)', async () => {
    // `subject tombstone A B` must NOT silently tombstone A + ignore
    // B — an irreversible action on the wrong/partial input.
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'subject',
        subcommand: 'tombstone',
        positional: ['sub_a', 'sub_b'],
        flags: { actor: 'did:plc:op', reason: 'spam' },
      }),
    ).rejects.toThrow(/extra positional/i)
  })

  it('rejects positional args on audit-log (flag-only command)', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'audit-log',
        positional: ['oops'],
        flags: {},
      }),
    ).rejects.toThrow(/no positional/i)
  })

  it('rejects a non-integer --limit (strict parse, not parseInt truncation)', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'audit-log',
        positional: [],
        flags: { limit: '10abc' },
      }),
    ).rejects.toThrow(/--limit must be a positive integer/)
  })

  it('requires --reason on subject untombstone (parity)', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'subject',
        subcommand: 'untombstone',
        positional: ['sub_x'],
        flags: { actor: 'did:plc:op' },
      }),
    ).rejects.toThrow(/reason/)
  })

  it('requires --reason on attestation restore (parity)', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'attestation',
        subcommand: 'restore',
        positional: ['at://did:plc:x/com.dinakernel.peerlens.attestation/y'],
        flags: { actor: 'did:plc:op' },
      }),
    ).rejects.toThrow(/reason/)
  })

  it('routes service tombstone via --actor + --reason + at:// URI', async () => {
    const { db } = stubDb({
      serviceRow: { tombstonedAt: null, tombstoneReason: null },
    })
    await dispatch(db, {
      command: 'service',
      subcommand: 'tombstone',
      positional: ['at://did:plc:p/com.dinakernel.service.profile/self'],
      flags: { actor: 'did:plc:op', reason: 'policy' },
    })
    expect(recordAdminActionMock).toHaveBeenCalledOnce()
    expect(recordAdminActionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'tombstone_service' }),
    )
  })

  it('requires --reason on service untombstone', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'service',
        subcommand: 'untombstone',
        positional: ['at://did:plc:p/com.dinakernel.service.profile/self'],
        flags: { actor: 'did:plc:op' },
      }),
    ).rejects.toThrow(/reason/)
  })

  it('rejects service tombstone with non-at:// URI', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'service',
        subcommand: 'tombstone',
        positional: ['not-a-uri'],
        flags: { actor: 'did:plc:op', reason: 'policy' },
      }),
    ).rejects.toThrow(/at:\/\//)
  })

  it('rejects attestation takedown with non-at:// URI', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'attestation',
        subcommand: 'takedown',
        positional: ['https://not-at-uri'],
        flags: { actor: 'did:plc:op', reason: 'x' },
      }),
    ).rejects.toThrow(/at:\/\//)
  })

  it('rejects --action verb not in ADMIN_ACTIONS', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'audit-log',
        positional: [],
        flags: { action: 'fart_around' },
      }),
    ).rejects.toThrow(/unknown.*action/i)
  })

  it('rejects unknown top-level command', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'nuke',
        positional: [],
        flags: {},
      }),
    ).rejects.toThrow(/unknown command/i)
  })

  it('HELP_SENTINEL routes to help text without DB work', async () => {
    const { db, captured } = stubDb({})
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    try {
      const out = await dispatch(db, {
        command: HELP_SENTINEL,
        positional: [],
        flags: {},
      })
      expect(out).toBeNull()
      // No DB calls — help path is read-only on stdout.
      expect(captured.events).toEqual([])
      expect(writeSpy).toHaveBeenCalled()
    } finally {
      writeSpy.mockRestore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 5. --actor DID validation
// ─────────────────────────────────────────────────────────────────────────

describe('--actor DID validation', () => {
  it('rejects malformed DID before any DB work', async () => {
    const { db, captured } = stubDb({
      subjectRow: { tombstonedAt: null, tombstoneReason: null },
    })
    await expect(
      dispatch(db, {
        command: 'subject',
        subcommand: 'tombstone',
        positional: ['sub_x'],
        flags: { actor: 'not-a-did', reason: 'spam' },
      }),
    ).rejects.toThrow(/valid DID/i)
    expect(captured.events).toEqual([])
    expect(recordAdminActionMock).not.toHaveBeenCalled()
  })

  it('rejects trailing-colon DID (typo)', async () => {
    const { db } = stubDb({})
    await expect(
      dispatch(db, {
        command: 'subject',
        subcommand: 'tombstone',
        positional: ['sub_x'],
        flags: { actor: 'did:plc:', reason: 'spam' },
      }),
    ).rejects.toThrow(/valid DID/i)
  })

  it('accepts well-formed did:plc:', async () => {
    const { db } = stubDb({
      subjectRow: { tombstonedAt: null, tombstoneReason: null },
    })
    await expect(
      dispatch(db, {
        command: 'subject',
        subcommand: 'tombstone',
        positional: ['sub_x'],
        flags: { actor: 'did:plc:abc123', reason: 'spam' },
      }),
    ).resolves.toBeDefined()
  })

  it('accepts did:web:, did:key:, any did:<method>:<id> shape', async () => {
    for (const did of ['did:web:example.com', 'did:key:zABC123']) {
      const { db } = stubDb({
        subjectRow: { tombstonedAt: null, tombstoneReason: null },
      })
      await expect(
        dispatch(db, {
          command: 'subject',
          subcommand: 'tombstone',
          positional: ['sub_x'],
          flags: { actor: did, reason: 'spam' },
        }),
      ).resolves.toBeDefined()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 6. Env-var actor fallback
// ─────────────────────────────────────────────────────────────────────────

describe('env-var fallback for --actor', () => {
  it('uses DINA_ADMIN_ACTOR_DID when --actor is absent', async () => {
    const prev = process.env.DINA_ADMIN_ACTOR_DID
    process.env.DINA_ADMIN_ACTOR_DID = 'did:plc:env-op'
    try {
      const { db } = stubDb({
        subjectRow: { tombstonedAt: null, tombstoneReason: null },
      })
      await dispatch(db, {
        command: 'subject',
        subcommand: 'untombstone',
        positional: ['sub_x'],
        flags: { reason: 'env-fallback test' },
      })
      expect(recordAdminActionMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ actorDid: 'did:plc:env-op' }),
      )
    } finally {
      if (prev === undefined) delete process.env.DINA_ADMIN_ACTOR_DID
      else process.env.DINA_ADMIN_ACTOR_DID = prev
    }
  })

  it('env-var fallback ALSO gets DID-validated (typo prevention)', async () => {
    const prev = process.env.DINA_ADMIN_ACTOR_DID
    process.env.DINA_ADMIN_ACTOR_DID = 'not-a-did-from-env'
    try {
      const { db } = stubDb({
        subjectRow: { tombstonedAt: null, tombstoneReason: null },
      })
      await expect(
        dispatch(db, {
          command: 'subject',
          subcommand: 'tombstone',
          positional: ['sub_x'],
          flags: { reason: 'env-fallback test' },
        }),
      ).rejects.toThrow(/valid DID/i)
    } finally {
      if (prev === undefined) delete process.env.DINA_ADMIN_ACTOR_DID
      else process.env.DINA_ADMIN_ACTOR_DID = prev
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// 7. BigInt → string JSON serialization (replacer)
// ─────────────────────────────────────────────────────────────────────────

describe('bigintReplacer', () => {
  it('stringifies BigInt values for JSON output', () => {
    const out = JSON.stringify({ id: 99n, name: 'x' }, bigintReplacer)
    expect(out).toBe('{"id":"99","name":"x"}')
  })

  it('passes non-BigInt values through unchanged', () => {
    const out = JSON.stringify(
      { n: 42, s: 'hi', b: true, nil: null },
      bigintReplacer,
    )
    expect(out).toBe('{"n":42,"s":"hi","b":true,"nil":null}')
  })
})
