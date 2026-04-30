/**
 * Unit tests for `appview/src/admin/trust-flag-cli.ts` (TN-FLAG-002 /
 * Plan §13.10).
 *
 * Coverage strategy:
 *   - `parseCommand` is a pure function — exhaustive positive +
 *     negative path tests.
 *   - `runTrustFlagCommand` is the testable core: drive it with a
 *     fake DB stub that captures inserts/updates and returns
 *     scripted reads. Asserts before/after observability + the
 *     UPSERT call shape.
 *   - The actual `main()` (process.argv parsing, `db.end()`, exit
 *     codes) is not tested — Node entry-point glue. Pure-function
 *     tests give us the contract; behaviour tests give us the
 *     UPSERT round-trip.
 *
 * Coverage for the `setBoolFlag` UPSERT shape — pinned via Drizzle
 * queryChunks introspection — guards against accidental refactors
 * that drop the `onConflictDoUpdate` clause (which would silently
 * break re-flips, since the second `INSERT` would conflict on the
 * PK and throw).
 */

import { describe, expect, it, vi } from 'vitest'

const mockLoggerError = vi.fn()
const mockLoggerInfo = vi.fn()
vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

import {
  parseCommand,
  runTrustFlagCommand,
  FLAG_KEY,
} from '@/admin/trust-flag-cli'
import { appviewConfig } from '@/db/schema/index'
import type { DrizzleDB } from '@/db/connection'

interface CapturedUpsert {
  values: Record<string, unknown>
  onConflictTarget: unknown
  onConflictSet: Record<string, unknown>
}

/**
 * Build a DB stub that:
 *   - Returns `currentValue` for `select … from appview_config`
 *     (overridden to `afterValue` after first INSERT lands).
 *   - Captures the INSERT chain so the test can introspect the
 *     UPSERT shape.
 */
function makeStubDb(opts: {
  initialValue: boolean | null
}): { db: DrizzleDB; captures: CapturedUpsert[]; readCount: () => number } {
  const captures: CapturedUpsert[] = []
  let current: boolean | null = opts.initialValue
  let readCount = 0

  const db = {
    select: () => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => ({
          limit: async () => {
            readCount++
            return current === null ? [] : [{ boolValue: current }]
          },
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (cfg: {
          target: unknown
          set: Record<string, unknown>
        }) => {
          captures.push({
            values,
            onConflictTarget: cfg.target,
            onConflictSet: cfg.set,
          })
          // Reflect the INSERT on subsequent reads.
          current =
            (values.boolValue as boolean | null | undefined) ?? current
        },
      }),
    }),
  } as unknown as DrizzleDB

  return { db, captures, readCount: () => readCount }
}

// ── parseCommand: pure-function exhaustive coverage ──────────

describe('parseCommand — TN-FLAG-002 CLI', () => {
  it('accepts "enable"', () => {
    expect(parseCommand(['node', 'cli.ts', 'enable'])).toBe('enable')
  })

  it('accepts "disable"', () => {
    expect(parseCommand(['node', 'cli.ts', 'disable'])).toBe('disable')
  })

  it('accepts "status"', () => {
    expect(parseCommand(['node', 'cli.ts', 'status'])).toBe('status')
  })

  it('rejects missing command', () => {
    expect(() => parseCommand(['node', 'cli.ts'])).toThrow(/Missing command/)
  })

  it('rejects unknown command (typo guard)', () => {
    expect(() => parseCommand(['node', 'cli.ts', 'enabled'])).toThrow(
      /Unknown command "enabled"/,
    )
    expect(() => parseCommand(['node', 'cli.ts', 'on'])).toThrow(
      /Unknown command "on"/,
    )
    expect(() => parseCommand(['node', 'cli.ts', ''])).toThrow(
      /Unknown command/,
    )
  })

  it('rejects extra positional args (defends against typo args)', () => {
    expect(() =>
      parseCommand(['node', 'cli.ts', 'enable', 'extra']),
    ).toThrow(/Unexpected extra argument/)
  })

  it('FLAG_KEY is the documented kill-switch key', () => {
    // Regression guard: the CLI must always operate on
    // `trust_v1_enabled` (the master kill-switch). A future flag
    // would get its own sub-command, not silently rebinding this
    // CLI to the wrong key.
    expect(FLAG_KEY).toBe('trust_v1_enabled')
  })
})

// ── runTrustFlagCommand: behaviour against stub DB ───────────

describe('runTrustFlagCommand — TN-FLAG-002 behaviour', () => {
  it('enable: flips a disabled flag and reports before/after', async () => {
    const { db, captures } = makeStubDb({ initialValue: false })
    const result = await runTrustFlagCommand(db, 'enable')
    expect(result).toEqual({
      before: false,
      after: true,
      flag: 'trust_v1_enabled',
    })
    expect(captures).toHaveLength(1)
    expect(captures[0].values).toMatchObject({
      key: 'trust_v1_enabled',
      boolValue: true,
    })
  })

  it('disable: flips an enabled flag and reports before/after', async () => {
    const { db, captures } = makeStubDb({ initialValue: true })
    const result = await runTrustFlagCommand(db, 'disable')
    expect(result).toEqual({
      before: true,
      after: false,
      flag: 'trust_v1_enabled',
    })
    expect(captures[0].values).toMatchObject({ boolValue: false })
  })

  it('enable when already enabled: idempotent (no error, before==after)', async () => {
    // Visible idempotency: calling enable twice doesn't error, the
    // second call updates `updated_at` but leaves the bool the
    // same — operators see "already enabled" via before==after.
    const { db, captures } = makeStubDb({ initialValue: true })
    const result = await runTrustFlagCommand(db, 'enable')
    expect(result.before).toBe(true)
    expect(result.after).toBe(true)
    // UPSERT still runs (advances updated_at) — that's the
    // documented contract; not a no-op.
    expect(captures).toHaveLength(1)
  })

  it('status: pure read, NO UPSERT issued', async () => {
    // Critical: a status query must not write to the DB. An
    // accidental write would advance updated_at on every status
    // check, polluting the change-detection signal for polling
    // readers.
    const { db, captures } = makeStubDb({ initialValue: true })
    const result = await runTrustFlagCommand(db, 'status')
    expect(result).toEqual({
      before: true,
      after: true,
      flag: 'trust_v1_enabled',
    })
    expect(captures).toHaveLength(0)
  })

  it('status when row missing: returns FLAG_DEFAULTS default (true)', async () => {
    // Fresh DB before any seed: readBoolFlag falls back to
    // FLAG_DEFAULTS.trust_v1_enabled = true (Plan §13.10 cutover
    // stance). status shouldn't pretend the flag is unset; the
    // default IS the operative value.
    const { db } = makeStubDb({ initialValue: null })
    const result = await runTrustFlagCommand(db, 'status')
    expect(result).toEqual({
      before: true, // FLAG_DEFAULTS default
      after: true,
      flag: 'trust_v1_enabled',
    })
  })

  it('UPSERT shape: target=key, SET includes both bool_value and updated_at', async () => {
    // Pin the UPSERT clause so a future refactor that drops
    // onConflictDoUpdate (e.g. switching to plain INSERT) would
    // silently break re-flips on the second invocation.
    const { db, captures } = makeStubDb({ initialValue: false })
    await runTrustFlagCommand(db, 'enable')
    const upsert = captures[0]
    expect(upsert.onConflictTarget).toBe(appviewConfig.key)
    expect(Object.keys(upsert.onConflictSet)).toEqual(
      expect.arrayContaining(['boolValue', 'updatedAt']),
    )
    // The UPSERT must NOT overwrite the description on update —
    // operator-curated descriptions survive flag flips.
    expect('description' in upsert.onConflictSet).toBe(false)
  })

  it('INSERT path seeds a description (NOT NULL constraint)', async () => {
    // The first-flip path on a fresh DB hits INSERT, not UPDATE.
    // The schema's `description` is NOT NULL, so the CLI MUST
    // provide a string. Pinned because dropping this would crash
    // the very first `enable` on a fresh deployment.
    const { db, captures } = makeStubDb({ initialValue: null })
    await runTrustFlagCommand(db, 'enable')
    expect(typeof captures[0].values.description).toBe('string')
    expect((captures[0].values.description as string).length).toBeGreaterThan(0)
  })
})
