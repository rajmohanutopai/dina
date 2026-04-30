/**
 * Unit tests for the TN-OPS-003 PDS-suspension stack:
 *   - `db/queries/suspended-pds-hosts.ts` reader/writer
 *   - `admin/trust-suspend-pds-cli.ts` CLI parser + runner
 *
 * Strategy:
 *   - The query layer is tested via a stub DB that captures the
 *     Drizzle method-chain calls (same pattern as TN-FLAG-001's
 *     `appview_config_reader.test.ts`).
 *   - The CLI parser is pure — exhaustive positive + negative
 *     argv shapes.
 *   - The CLI runner is driven through `runSuspendPdsCommand` with
 *     a fake DB so the test asserts the operation outcome without
 *     spawning a subprocess.
 *
 * Not tested: `main()` (process.argv glue, exit codes, db.$client.end).
 * The pure-function + runner-function tests give us the contract;
 * the entry-point glue is Node convention.
 */

import { describe, expect, it, vi } from 'vitest'

const mockLoggerError = vi.fn()
const mockLoggerInfo = vi.fn()
const mockLoggerWarn = vi.fn()
vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => mockLoggerInfo(...a),
    error: (...a: unknown[]) => mockLoggerError(...a),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    debug: vi.fn(),
  },
}))

import {
  isPdsSuspended,
  listSuspendedPdsHosts,
  suspendPdsHost,
  unsuspendPdsHost,
} from '@/db/queries/suspended-pds-hosts'
import {
  parseArgs,
  runSuspendPdsCommand,
  type ParsedArgs,
} from '@/admin/trust-suspend-pds-cli'
import type { DrizzleDB } from '@/db/connection'

// ── Stub DB ────────────────────────────────────────────────────

/**
 * Capture-and-script DB stub. Stores rows in a Map keyed by host;
 * `select` reads, `insert/onConflictDoUpdate` upserts, `delete` +
 * `.returning()` removes and surfaces the count.
 */
interface StubRow {
  host: string
  reason: string
  suspendedAt: Date
  suspendedBy: string | null
}

function makeStubDb(initial: StubRow[] = []): {
  db: DrizzleDB
  rows: () => StubRow[]
} {
  const store = new Map<string, StubRow>()
  for (const r of initial) store.set(r.host, r)

  let pendingHostMatch: string | null = null

  const db = {
    select: (_proj?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_w: unknown) => {
          // Capture the host being queried by stashing it in
          // pendingHostMatch via a side channel — we rely on the
          // caller invoking `eq(suspendedPdsHosts.host, host)` and
          // pass the host through. Drizzle's `eq` produces an
          // SQL composite whose right-hand value is the param.
          // We crawl the queryChunks for it.
          const w = _w as Record<string, unknown>
          if (Array.isArray(w?.queryChunks)) {
            for (const chunk of w.queryChunks as unknown[]) {
              const c = chunk as Record<string, unknown>
              if (typeof c?.value === 'string') {
                pendingHostMatch = c.value
              }
            }
          }
          return {
            limit: async () => {
              if (pendingHostMatch === null) return []
              const row = store.get(pendingHostMatch)
              return row ? [{ host: row.host }] : []
            },
          }
        },
        // listSuspendedPdsHosts hits .from().orderBy() (no .where())
        orderBy: async (_o: unknown) => {
          // Order by suspendedAt desc.
          return [...store.values()]
            .sort((a, b) => b.suspendedAt.getTime() - a.suspendedAt.getTime())
            .map((r) => ({
              host: r.host,
              reason: r.reason,
              suspendedAt: r.suspendedAt,
              suspendedBy: r.suspendedBy,
            }))
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (cfg: {
          target: unknown
          set: Record<string, unknown>
        }) => {
          const host = values.host as string
          const existing = store.get(host)
          if (existing) {
            store.set(host, {
              host,
              reason: cfg.set.reason as string,
              suspendedAt: cfg.set.suspendedAt as Date,
              suspendedBy: (cfg.set.suspendedBy as string | null) ?? null,
            })
          } else {
            store.set(host, {
              host,
              reason: values.reason as string,
              suspendedAt: values.suspendedAt as Date,
              suspendedBy: (values.suspendedBy as string | null) ?? null,
            })
          }
        },
      }),
    }),
    delete: (_table: unknown) => ({
      where: (w: unknown) => ({
        returning: async (_proj?: unknown) => {
          // Scan the where clause for the host param like select does.
          let host: string | null = null
          const wrec = w as Record<string, unknown>
          if (Array.isArray(wrec?.queryChunks)) {
            for (const chunk of wrec.queryChunks as unknown[]) {
              const c = chunk as Record<string, unknown>
              if (typeof c?.value === 'string') host = c.value
            }
          }
          if (host !== null && store.delete(host)) {
            return [{ host }]
          }
          return []
        },
      }),
    }),
  }
  return { db: db as unknown as DrizzleDB, rows: () => [...store.values()] }
}

// ── Reader/writer behaviour ────────────────────────────────────

describe('isPdsSuspended', () => {
  it('returns false for a host that is not in the table', async () => {
    const { db } = makeStubDb()
    expect(await isPdsSuspended(db, 'example.com')).toBe(false)
  })

  it('returns true for a host that has been suspended', async () => {
    const { db } = makeStubDb([
      {
        host: 'bad-pds.example.com',
        reason: 'sybil',
        suspendedAt: new Date('2026-04-29T00:00:00Z'),
        suspendedBy: 'alice',
      },
    ])
    expect(await isPdsSuspended(db, 'bad-pds.example.com')).toBe(true)
  })

  it('is case-sensitive (per AT Protocol normalised host strings)', async () => {
    // The AT Protocol DID spec normalises web-host to lowercase
    // before this code sees it. Pinning case-sensitivity here
    // defends against a refactor that adds an unsolicited LOWER()
    // wrapper which would change matching semantics.
    const { db } = makeStubDb([
      {
        host: 'bad-pds.example.com',
        reason: 'sybil',
        suspendedAt: new Date(),
        suspendedBy: null,
      },
    ])
    expect(await isPdsSuspended(db, 'BAD-PDS.example.com')).toBe(false)
  })
})

describe('suspendPdsHost', () => {
  it('inserts a row when the host is not in the table', async () => {
    const { db, rows } = makeStubDb()
    await suspendPdsHost(db, 'bad.example.com', 'sybil-cluster', 'alice')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      host: 'bad.example.com',
      reason: 'sybil-cluster',
      suspendedBy: 'alice',
    })
  })

  it('replaces reason + suspendedBy + suspendedAt when re-suspending (UPSERT)', async () => {
    // Re-suspension policy: the most-recent operator action wins.
    // Pinned because a "no-op on conflict" alternative would lose
    // the curator's updated reason.
    const earlier = new Date('2026-04-29T00:00:00Z')
    const { db, rows } = makeStubDb([
      {
        host: 'bad.example.com',
        reason: 'sybil',
        suspendedAt: earlier,
        suspendedBy: 'alice',
      },
    ])
    await suspendPdsHost(db, 'bad.example.com', 'updated-reason', 'bob')
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      host: 'bad.example.com',
      reason: 'updated-reason',
      suspendedBy: 'bob',
    })
    expect(rows()[0].suspendedAt.getTime()).toBeGreaterThan(earlier.getTime())
  })

  it('treats omitted suspendedBy as null (legacy SQL-path compat)', async () => {
    const { db, rows } = makeStubDb()
    await suspendPdsHost(db, 'bad.example.com', 'sybil')
    expect(rows()[0].suspendedBy).toBeNull()
  })
})

describe('unsuspendPdsHost', () => {
  it('returns {removed: true} when the host was suspended', async () => {
    const { db, rows } = makeStubDb([
      {
        host: 'bad.example.com',
        reason: 'sybil',
        suspendedAt: new Date(),
        suspendedBy: null,
      },
    ])
    const result = await unsuspendPdsHost(db, 'bad.example.com')
    expect(result.removed).toBe(true)
    expect(rows()).toHaveLength(0)
  })

  it('returns {removed: false} when the host was NOT in the table', async () => {
    const { db, rows } = makeStubDb()
    const result = await unsuspendPdsHost(db, 'never-suspended.example.com')
    expect(result.removed).toBe(false)
    expect(rows()).toHaveLength(0)
  })
})

describe('listSuspendedPdsHosts', () => {
  it('returns rows ordered by suspendedAt DESC (most-recent first)', async () => {
    const oldest = new Date('2026-01-01T00:00:00Z')
    const middle = new Date('2026-02-01T00:00:00Z')
    const newest = new Date('2026-03-01T00:00:00Z')
    const { db } = makeStubDb([
      { host: 'a.example.com', reason: 'r1', suspendedAt: oldest, suspendedBy: null },
      { host: 'b.example.com', reason: 'r2', suspendedAt: newest, suspendedBy: 'alice' },
      { host: 'c.example.com', reason: 'r3', suspendedAt: middle, suspendedBy: null },
    ])
    const list = await listSuspendedPdsHosts(db)
    expect(list.map((r) => r.host)).toEqual([
      'b.example.com',
      'c.example.com',
      'a.example.com',
    ])
  })

  it('returns an empty array when the table is empty', async () => {
    const { db } = makeStubDb()
    expect(await listSuspendedPdsHosts(db)).toEqual([])
  })
})

// ── CLI parser ─────────────────────────────────────────────────

describe('parseArgs (CLI)', () => {
  // argv[0] = node, argv[1] = script path, argv[2..] = user args.
  // We construct test argv with placeholder node + script and the
  // user args after.
  const PREFIX = ['node', 'script']

  it('parses `add <host> <reason>`', () => {
    const r = parseArgs([...PREFIX, 'add', 'bad.example.com', 'sybil-cluster'])
    expect(r).toEqual({
      command: 'add',
      host: 'bad.example.com',
      reason: 'sybil-cluster',
    })
  })

  it('parses `remove <host>`', () => {
    const r = parseArgs([...PREFIX, 'remove', 'bad.example.com'])
    expect(r).toEqual({ command: 'remove', host: 'bad.example.com' })
  })

  it('parses `list` with no args', () => {
    expect(parseArgs([...PREFIX, 'list'])).toEqual({ command: 'list' })
  })

  it('rejects missing command', () => {
    expect(() => parseArgs(PREFIX)).toThrow(/Missing command/)
  })

  it('rejects unknown commands', () => {
    expect(() => parseArgs([...PREFIX, 'bogus'])).toThrow(/Unknown command/)
  })

  it('rejects `add` without host', () => {
    expect(() => parseArgs([...PREFIX, 'add'])).toThrow(/Missing host/)
  })

  it('rejects `add` with host but no reason', () => {
    expect(() => parseArgs([...PREFIX, 'add', 'host.example.com'])).toThrow(
      /Missing reason/,
    )
  })

  it('rejects `add` with empty-string host', () => {
    expect(() => parseArgs([...PREFIX, 'add', '', 'reason'])).toThrow(
      /Missing host/,
    )
  })

  it('rejects `add` with empty-string reason', () => {
    expect(() => parseArgs([...PREFIX, 'add', 'host.example.com', ''])).toThrow(
      /Missing reason/,
    )
  })

  it('rejects `remove` without host', () => {
    expect(() => parseArgs([...PREFIX, 'remove'])).toThrow(/Missing host/)
  })

  it('rejects extra args on `add` (defends against silently dropping flags)', () => {
    // A future `--by <id>` flag must NOT be silently dropped by an
    // older CLI; a CI invocation that adds the flag should fail
    // loudly until the CLI is upgraded.
    expect(() =>
      parseArgs([...PREFIX, 'add', 'host', 'reason', '--by', 'alice']),
    ).toThrow(/Unexpected extra argument/)
  })

  it('rejects extra args on `remove`', () => {
    expect(() =>
      parseArgs([...PREFIX, 'remove', 'host', 'unexpected']),
    ).toThrow(/Unexpected extra argument/)
  })

  it('rejects extra args on `list`', () => {
    expect(() => parseArgs([...PREFIX, 'list', 'unexpected'])).toThrow(
      /Unexpected extra argument/,
    )
  })
})

// ── CLI runner ─────────────────────────────────────────────────

describe('runSuspendPdsCommand', () => {
  it('add — fresh suspension reports wasAlreadySuspended: false', async () => {
    const { db, rows } = makeStubDb()
    const r = await runSuspendPdsCommand(
      db,
      { command: 'add', host: 'bad.example.com', reason: 'sybil' },
      'alice',
    )
    expect(r).toMatchObject({
      command: 'add',
      host: 'bad.example.com',
      reason: 'sybil',
      wasAlreadySuspended: false,
    })
    expect(rows()).toHaveLength(1)
  })

  it('add — re-suspension reports wasAlreadySuspended: true and replaces row', async () => {
    const { db, rows } = makeStubDb([
      {
        host: 'bad.example.com',
        reason: 'old-reason',
        suspendedAt: new Date('2026-01-01'),
        suspendedBy: 'old-operator',
      },
    ])
    const r = await runSuspendPdsCommand(
      db,
      { command: 'add', host: 'bad.example.com', reason: 'new-reason' },
      'new-operator',
    )
    expect(r.command).toBe('add')
    if (r.command !== 'add') throw new Error('type narrowing')
    expect(r.wasAlreadySuspended).toBe(true)
    expect(rows()[0]).toMatchObject({
      host: 'bad.example.com',
      reason: 'new-reason',
      suspendedBy: 'new-operator',
    })
  })

  it('remove — host present returns removed: true', async () => {
    const { db } = makeStubDb([
      {
        host: 'bad.example.com',
        reason: 'sybil',
        suspendedAt: new Date(),
        suspendedBy: null,
      },
    ])
    const r = await runSuspendPdsCommand(db, {
      command: 'remove',
      host: 'bad.example.com',
    })
    expect(r).toEqual({
      command: 'remove',
      host: 'bad.example.com',
      removed: true,
    })
  })

  it('remove — host absent returns removed: false (CLI exits 2)', async () => {
    const { db } = makeStubDb()
    const r = await runSuspendPdsCommand(db, {
      command: 'remove',
      host: 'never.example.com',
    })
    expect(r).toEqual({
      command: 'remove',
      host: 'never.example.com',
      removed: false,
    })
  })

  it('list — returns suspendedAt-DESC sorted hosts', async () => {
    const { db } = makeStubDb([
      {
        host: 'a.example.com',
        reason: 'r1',
        suspendedAt: new Date('2026-01-01'),
        suspendedBy: null,
      },
      {
        host: 'b.example.com',
        reason: 'r2',
        suspendedAt: new Date('2026-03-01'),
        suspendedBy: null,
      },
    ])
    const r = await runSuspendPdsCommand(db, { command: 'list' })
    expect(r.command).toBe('list')
    if (r.command !== 'list') throw new Error('type narrowing')
    expect(r.hosts.map((h) => h.host)).toEqual(['b.example.com', 'a.example.com'])
  })

  it('list — empty table returns empty array', async () => {
    const { db } = makeStubDb()
    const r = await runSuspendPdsCommand(db, { command: 'list' })
    expect(r.command).toBe('list')
    if (r.command !== 'list') throw new Error('type narrowing')
    expect(r.hosts).toEqual([])
  })
})

// ── Type-level export contract ─────────────────────────────────

describe('CLI exports', () => {
  it('ParsedArgs union covers all three commands', () => {
    // Type-level test: if the union loses a member, this assignment
    // fails to compile.
    const _adds: ParsedArgs = { command: 'add', host: 'h', reason: 'r' }
    const _removes: ParsedArgs = { command: 'remove', host: 'h' }
    const _lists: ParsedArgs = { command: 'list' }
    expect(_adds.command).toBe('add')
    expect(_removes.command).toBe('remove')
    expect(_lists.command).toBe('list')
  })
})
