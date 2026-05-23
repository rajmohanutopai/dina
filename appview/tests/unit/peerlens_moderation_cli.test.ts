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

import {
  HELP_SENTINEL,
  parseArgs,
  dispatch,
  tombstoneSubject,
  untombstoneSubject,
  takedownAttestation,
  restoreAttestation,
  bigintReplacer,
  helpText,
} from '@/admin/peerlens-moderation-cli'
import { subjects } from '@/db/schema/subjects'
import { attestations } from '@/db/schema/attestations'
import { adminAuditLog } from '@/db/schema/admin-audit-log'
import type { DrizzleDB } from '@/db/connection'

beforeEach(() => {
  recordAdminActionMock.mockReset()
  recordAdminActionMock.mockResolvedValue(123n)
})

// ─────────────────────────────────────────────────────────────────────────
// DB stub. Routes by table identity + supports `db.transaction()` +
// `update().set().where().returning()`. Tracks a shared event timeline
// so tests can assert happens-before on (audit, mutation).
// ─────────────────────────────────────────────────────────────────────────

interface StubOpts {
  subjectRow?: { tombstonedAt: Date | null; tombstoneReason: string | null }
  attestationRow?: { isTakedown: boolean; reason: string | null }
  /** Override the row returned by `.update().returning()` for assertions. */
  updateReturning?: Record<string, unknown>
}

interface Captured {
  /** Ordered timeline. Each entry is an event tag. */
  events: string[]
  /** Most recent `.update().set(values)` payload per table. */
  lastUpdateValues: Record<string, Record<string, unknown> | null>
  /** True if `db.transaction()` was opened at least once. */
  txOpened: boolean
}

function stubDb(opts: StubOpts = {}): { db: DrizzleDB; captured: Captured } {
  const captured: Captured = {
    events: [],
    lastUpdateValues: {},
    txOpened: false,
  }

  const tableName = (t: unknown): string => {
    if (t === subjects) return 'subjects'
    if (t === attestations) return 'attestations'
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
          return {
            where: () => ({
              limit: async () => {
                if (name === 'subjects' && opts.subjectRow !== undefined) {
                  return [opts.subjectRow]
                }
                if (name === 'attestations' && opts.attestationRow !== undefined) {
                  return [opts.attestationRow]
                }
                return []
              },
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
                  return [opts.updateReturning ?? values]
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
      'at://did:plc:author/com.dina.peerlens.attestation/xyz',
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
      uri: 'at://did:plc:author/com.dina.peerlens.attestation/x',
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
        uri: 'at://did:plc:x/com.dina.peerlens.attestation/missing',
        actorDid: 'did:plc:op',
        reason: 'x',
      }),
    ).rejects.toThrow(/not found/i)
    expect(recordAdminActionMock).not.toHaveBeenCalled()
  })
})

describe('restoreAttestation', () => {
  it('requires a reason (parity with takedown)', async () => {
    const { db } = stubDb({
      attestationRow: { isTakedown: true, reason: 'spam' },
    })
    await restoreAttestation(db, {
      uri: 'at://did:plc:author/com.dina.peerlens.attestation/x',
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
      uri: 'at://did:plc:author/com.dina.peerlens.attestation/x',
      actorDid: 'did:plc:op',
      reason: 'mistaken',
    })
    expect(captured.lastUpdateValues.attestations).toEqual({
      isTakedownByModerator: false,
      takedownReason: null,
      takedownAt: null,
    })
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
        positional: ['at://did:plc:x/com.dina.peerlens.attestation/y'],
        flags: { actor: 'did:plc:op' },
      }),
    ).rejects.toThrow(/reason/)
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
