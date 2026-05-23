/**
 * Transaction-wrapper invariants for the peerlens record handlers.
 *
 * Each handler's `handleCreate` (plus `revocation.handleDelete`)
 * runs its multi-write sequence inside `ctx.db.transaction(...)` so
 * a process crash mid-flow can't leave a half-indexed record. These
 * tests pin that wrapper at the unit boundary — assert tx is opened,
 * and that the per-tx writes go through the tx-scoped db (not the
 * outer ctx.db).
 *
 * Mirror of `tests/unit/service_profile_handler.test.ts` for the
 * services side. See `appview/peerlens-lift-notes.html` for the
 * rationale shared with the services-side hardening pass.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Module-level mocks for handler dependencies ───────────────
// All three helpers are mocked so the handlers' write sequence
// is observable purely through the tx-passing surface. The mocks
// record the `db` argument they received so we can assert "this
// helper ran with the tx-scoped db, not the outer ctx.db".
//
// `eventLog` records the ordered sequence of tx events + helper
// calls. The stub db pushes `tx:begin`, `tx:commit`, and per-call
// strings like `tx:insert:attestations`; the mocks push their own
// names. Tests that care about ordering inspect `eventLog`; tests
// that only care about "happened" inspect the per-helper arrays.

const eventLog: string[] = []
const resolveOrCreateSubjectCalls: Array<{ db: unknown; subject: unknown }> = []
const markDirtyCalls: Array<{ db: unknown; params: unknown }> = []
const addTrustEdgeCalls: Array<{ ctxDb: unknown; params: unknown }> = []
const deletionProcessCalls: Array<{ db: unknown; uri: string }> = []

vi.mock('@/db/queries/subjects.js', () => ({
  resolveOrCreateSubject: vi.fn(async (db: unknown, subject: unknown) => {
    eventLog.push('resolveOrCreateSubject')
    resolveOrCreateSubjectCalls.push({ db, subject })
    return 'mock-subject-id'
  }),
}))

vi.mock('@/db/queries/dirty-flags.js', () => ({
  markDirty: vi.fn(async (db: unknown, params: unknown) => {
    eventLog.push('markDirty')
    markDirtyCalls.push({ db, params })
  }),
}))

vi.mock('@/ingester/peerlens-edge-sync.js', () => ({
  addTrustEdge: vi.fn(async (ctx: any, params: unknown) => {
    eventLog.push('addTrustEdge')
    addTrustEdgeCalls.push({ ctxDb: ctx.db, params })
  }),
  removeTrustEdge: vi.fn(async () => {}),
}))

vi.mock('@/ingester/deletion-handler.js', () => ({
  deletionHandler: {
    process: vi.fn(async (db: unknown, uri: string) => {
      eventLog.push('deletionHandler.process')
      deletionProcessCalls.push({ db, uri })
    }),
  },
}))

// ── Handlers under test (must be imported AFTER vi.mock above) ─

import { attestationHandler } from '@/ingester/handlers/attestation'
import { vouchHandler } from '@/ingester/handlers/vouch'
import { endorsementHandler } from '@/ingester/handlers/endorsement'
import { flagHandler } from '@/ingester/handlers/flag'
import { revocationHandler } from '@/ingester/handlers/revocation'

// Schema tables — imported so the stub can attribute `insert(table)`
// calls to a human-readable name in the event log. Comparing by
// object reference avoids depending on Drizzle's internal symbol
// for the SQL name, which is implementation-private.
import {
  attestations,
  subjects,
  mentionEdges,
  peerlensEdges,
  vouches,
  endorsements,
  flags,
  revocations,
} from '@/db/schema/index'

function tableName(table: unknown): string {
  if (table === attestations) return 'attestations'
  if (table === subjects) return 'subjects'
  if (table === mentionEdges) return 'mention_edges'
  if (table === peerlensEdges) return 'peerlens_edges'
  if (table === vouches) return 'vouches'
  if (table === endorsements) return 'endorsements'
  if (table === flags) return 'flags'
  if (table === revocations) return 'revocations'
  return 'unknown'
}

// ── Stub context ──────────────────────────────────────────────

interface CapturedTx {
  txOpened: boolean
}

/** Type-guard the `__role` tag carried by the stub-db sentinel. */
function dbRole(db: unknown): 'tx' | 'outer' | undefined {
  if (db && typeof db === 'object' && '__role' in db) {
    const r = (db as { __role: unknown }).__role
    if (r === 'tx' || r === 'outer') return r
  }
  return undefined
}

function stubCtx(): { ctx: any; captured: CapturedTx } {
  const captured: CapturedTx = { txOpened: false }

  // Both the outer ctx.db and the tx-scoped db expose the same write
  // surface — handlers call insert/update/delete on whichever they
  // hold. Each carries a `__role` tag so call-site assertions can
  // tell which one a helper got handed. (Identity comparison fails
  // here because the db object IS the surface — there's no separate
  // sentinel to point at.)
  // The tx-scoped db also pushes ordered events into `eventLog`
  // so the attestation order-pinning test can assert the exact
  // write sequence. The outer db doesn't push — anything that
  // shows up in the log proves the write went through the tx (any
  // accidental outer-db write would skip the log instead of
  // appearing in the wrong slot).
  const buildDbSurface = (role: 'tx' | 'outer') => {
    const recordsEvents = role === 'tx'
    return {
      __role: role,
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn((table: unknown) => {
        if (recordsEvents) eventLog.push(`tx:insert:${tableName(table)}`)
        return {
          values: vi.fn().mockReturnValue({
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          }),
        }
      }),
      update: vi.fn((table: unknown) => {
        if (recordsEvents) eventLog.push(`tx:update:${tableName(table)}`)
        return {
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }
      }),
      delete: vi.fn((table: unknown) => {
        if (recordsEvents) eventLog.push(`tx:delete:${tableName(table)}`)
        return {
          where: vi.fn().mockResolvedValue(undefined),
        }
      }),
      // resolveOrCreateSubject uses db.execute — never reached in
      // these tests since the helper is mocked, but the surface
      // includes it for completeness.
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 'mock-subject-id', canonical_subject_id: null }] }),
    }
  }

  const txDb = buildDbSurface('tx')
  const outerDb: any = {
    ...buildDbSurface('outer'),
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      captured.txOpened = true
      eventLog.push('tx:begin')
      await fn(txDb)
      eventLog.push('tx:commit')
    },
  }

  return {
    ctx: {
      db: outerDb,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      metrics: { incr: vi.fn(), gauge: vi.fn(), histogram: vi.fn(), counter: vi.fn() },
    },
    captured,
  }
}

beforeEach(() => {
  eventLog.length = 0
  resolveOrCreateSubjectCalls.length = 0
  markDirtyCalls.length = 0
  addTrustEdgeCalls.length = 0
  deletionProcessCalls.length = 0
})

const now = new Date('2026-05-23T00:00:00.000Z').toISOString()

// ── Attestation handler ────────────────────────────────────────

describe('attestationHandler.handleCreate — transaction wrapper', () => {
  it('opens a transaction', async () => {
    const { ctx, captured } = stubCtx()
    await attestationHandler.handleCreate(ctx, {
      uri: 'at://did:plc:a/com.dina.peerlens.attestation/1',
      did: 'did:plc:a',
      collection: 'com.dina.peerlens.attestation',
      rkey: '1',
      cid: 'cid1',
      record: {
        subject: { type: 'did', did: 'did:plc:b' },
        category: 'identity',
        sentiment: 'positive',
        createdAt: now,
      },
    } as never)
    expect(captured.txOpened).toBe(true)
  })

  it('routes resolveOrCreateSubject + markDirty + addTrustEdge through the tx-scoped db', async () => {
    const { ctx } = stubCtx()
    await attestationHandler.handleCreate(ctx, {
      uri: 'at://did:plc:a/com.dina.peerlens.attestation/2',
      did: 'did:plc:a',
      collection: 'com.dina.peerlens.attestation',
      rkey: '2',
      cid: 'cid2',
      record: {
        subject: { type: 'did', did: 'did:plc:b' },
        category: 'identity',
        sentiment: 'positive',
        createdAt: now,
      },
    } as never)
    expect(resolveOrCreateSubjectCalls).toHaveLength(1)
    expect(dbRole(resolveOrCreateSubjectCalls[0]?.db)).toBe('tx')
    expect(addTrustEdgeCalls).toHaveLength(1)
    expect(dbRole(addTrustEdgeCalls[0]?.ctxDb)).toBe('tx')
    expect(markDirtyCalls).toHaveLength(1)
    expect(dbRole(markDirtyCalls[0]?.db)).toBe('tx')
  })

  it('writes the full sequence inside one tx, in the documented order', async () => {
    // Pins the exact write order for `attestation.handleCreate`. A
    // future refactor that moves any single write outside the tx (or
    // re-orders dependent writes) fails this test loudly. Mirror of
    // the `service_profile_handler` event-order assertion.
    //
    // Input is a positive DID-subject attestation with one mention,
    // so every conditional branch (mention edge insert + addTrustEdge
    // for the positive-DID case) fires.
    const { ctx } = stubCtx()
    await attestationHandler.handleCreate(ctx, {
      uri: 'at://did:plc:a/com.dina.peerlens.attestation/3',
      did: 'did:plc:a',
      collection: 'com.dina.peerlens.attestation',
      rkey: '3',
      cid: 'cid3',
      record: {
        subject: { type: 'did', did: 'did:plc:b' },
        category: 'identity',
        sentiment: 'positive',
        mentions: [{ did: 'did:plc:c', role: 'reviewer' }],
        createdAt: now,
      },
    } as never)
    expect(eventLog).toEqual([
      'tx:begin',
      'resolveOrCreateSubject',     // subjects row first (FK target)
      'tx:insert:attestations',     // the attestation itself
      'tx:update:subjects',         // META-011 lastActiveAt bump
      'tx:delete:mention_edges',    // clear stale mentions for this URI
      'tx:insert:mention_edges',    // re-insert the one mention
      'tx:delete:peerlens_edges',   // clear stale trust edges for this URI
      'addTrustEdge',               // positive DID-subject → trust edge re-added
      'markDirty',                  // scorer recalc signal
      'tx:commit',
    ])
  })
})

// ── Vouch handler ─────────────────────────────────────────────

describe('vouchHandler.handleCreate — transaction wrapper', () => {
  it('opens a transaction and routes addTrustEdge + markDirty through it', async () => {
    const { ctx, captured } = stubCtx()
    await vouchHandler.handleCreate(ctx, {
      uri: 'at://did:plc:a/com.dina.peerlens.vouch/1',
      did: 'did:plc:a',
      collection: 'com.dina.peerlens.vouch',
      rkey: '1',
      cid: 'cid1',
      record: {
        subject: 'did:plc:b',
        vouchType: 'personal',
        confidence: 'high',
        createdAt: now,
      },
    } as never)
    expect(captured.txOpened).toBe(true)
    expect(dbRole(addTrustEdgeCalls[0]?.ctxDb)).toBe('tx')
    expect(dbRole(markDirtyCalls[0]?.db)).toBe('tx')
  })
})

// ── Endorsement handler ───────────────────────────────────────

describe('endorsementHandler.handleCreate — transaction wrapper', () => {
  it('opens a transaction and routes addTrustEdge + markDirty through it', async () => {
    const { ctx, captured } = stubCtx()
    await endorsementHandler.handleCreate(ctx, {
      uri: 'at://did:plc:a/com.dina.peerlens.endorsement/1',
      did: 'did:plc:a',
      collection: 'com.dina.peerlens.endorsement',
      rkey: '1',
      cid: 'cid1',
      record: {
        subject: 'did:plc:b',
        skill: 'plumbing',
        endorsementType: 'worked-together',
        createdAt: now,
      },
    } as never)
    expect(captured.txOpened).toBe(true)
    expect(dbRole(addTrustEdgeCalls[0]?.ctxDb)).toBe('tx')
    expect(dbRole(markDirtyCalls[0]?.db)).toBe('tx')
  })
})

// ── Flag handler ──────────────────────────────────────────────

describe('flagHandler.handleCreate — transaction wrapper', () => {
  it('opens a transaction and routes resolveOrCreateSubject + markDirty through it', async () => {
    const { ctx, captured } = stubCtx()
    await flagHandler.handleCreate(ctx, {
      uri: 'at://did:plc:a/com.dina.peerlens.flag/1',
      did: 'did:plc:a',
      collection: 'com.dina.peerlens.flag',
      rkey: '1',
      cid: 'cid1',
      record: {
        subject: { type: 'did', did: 'did:plc:b' },
        flagType: 'abuse',
        severity: 'medium',
        createdAt: now,
      },
    } as never)
    expect(captured.txOpened).toBe(true)
    expect(dbRole(resolveOrCreateSubjectCalls[0]?.db)).toBe('tx')
    expect(dbRole(markDirtyCalls[0]?.db)).toBe('tx')
  })
})

// ── Revocation handler (both create + delete) ─────────────────

describe('revocationHandler — transaction wrapper', () => {
  it('handleCreate opens a transaction and routes markDirty through it', async () => {
    const { ctx, captured } = stubCtx()
    await revocationHandler.handleCreate(ctx, {
      uri: 'at://did:plc:a/com.dina.peerlens.revocation/1',
      did: 'did:plc:a',
      collection: 'com.dina.peerlens.revocation',
      rkey: '1',
      cid: 'cid1',
      record: {
        targetUri: 'at://did:plc:a/com.dina.peerlens.attestation/target',
        reason: 'changed-my-mind',
        createdAt: now,
      },
    } as never)
    expect(captured.txOpened).toBe(true)
    expect(markDirtyCalls.length).toBeGreaterThanOrEqual(1)
    for (const call of markDirtyCalls) {
      expect(dbRole(call.db)).toBe('tx')
    }
  })

  it('handleDelete opens a transaction and routes deletionHandler + markDirty through it', async () => {
    const { ctx, captured } = stubCtx()
    await revocationHandler.handleDelete(ctx, {
      uri: 'at://did:plc:a/com.dina.peerlens.revocation/1',
      did: 'did:plc:a',
      collection: 'com.dina.peerlens.revocation',
      rkey: '1',
      cid: 'cid1',
      record: {},
    } as never)
    expect(captured.txOpened).toBe(true)
    expect(dbRole(deletionProcessCalls[0]?.db)).toBe('tx')
    expect(dbRole(markDirtyCalls[0]?.db)).toBe('tx')
  })
})
