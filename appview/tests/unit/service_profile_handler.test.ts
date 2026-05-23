/**
 * Unit tests for `appview/src/ingester/handlers/service-profile.ts`.
 *
 * Focus: pin the two invariants the handler guarantees:
 *   1. Delete-then-insert runs in a single transaction so concurrent
 *      readers never see a momentary "no profiles for this operator"
 *      state.
 *   2. At most one indexed profile per operator. Re-publishing under
 *      a different rkey replaces the prior row.
 */

import { describe, it, expect, vi } from 'vitest'
import { serviceProfileHandler } from '@/ingester/handlers/service-profile'
import { services } from '@/db/schema/services'

interface Captured {
  events: string[]
  insertValues: Record<string, unknown> | null
  txOpened: boolean
}

function stubCtx(
  captured: Captured,
  opts: { priorCreatedAt?: Date | null } = {},
) {
  function makeTx(prefix: string) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              captured.events.push(`${prefix}select:services`)
              if (opts.priorCreatedAt === null || opts.priorCreatedAt === undefined) {
                return []
              }
              return [{ createdAt: opts.priorCreatedAt }]
            },
          }),
        }),
      }),
      delete: (table: unknown) => {
        return {
          where: async () => {
            captured.events.push(`${prefix}delete:${table === services ? 'services' : 'unknown'}`)
          },
        }
      },
      insert: (table: unknown) => {
        return {
          values: async (v: Record<string, unknown>) => {
            captured.insertValues = v
            captured.events.push(`${prefix}insert:${table === services ? 'services' : 'unknown'}`)
          },
        }
      },
    }
  }
  return {
    db: {
      transaction: async (fn: (tx: unknown) => Promise<void>) => {
        captured.txOpened = true
        captured.events.push('tx:begin')
        await fn(makeTx('tx:'))
        captured.events.push('tx:commit')
      },
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { incr: vi.fn(), gauge: vi.fn(), histogram: vi.fn(), counter: vi.fn() },
  } as any
}

function validProfile() {
  return {
    name: 'SF Transit',
    description: 'Bus arrival ETAs for SF Muni',
    capabilities: ['eta_query'],
    responsePolicy: { eta_query: 'auto' },
    isDiscoverable: true,
    updatedAt: new Date().toISOString(),
  }
}

function op(record: Record<string, unknown>) {
  return {
    uri: 'at://did:plc:provider/com.dina.service.profile/self',
    did: 'did:plc:provider',
    collection: 'com.dina.service.profile',
    rkey: 'self',
    cid: 'bafytest123',
    record,
  }
}

describe('serviceProfileHandler.handleCreate', () => {
  it('runs select + delete + insert inside a single transaction', async () => {
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(ctx, op(validProfile()))
    expect(captured.txOpened).toBe(true)
    // SELECT first (to capture prior createdAt), then DELETE the prior
    // row, then INSERT the new one. Read-then-write ordering is what
    // makes the createdAt preservation safe inside the tx.
    expect(captured.events).toEqual([
      'tx:begin',
      'tx:select:services',
      'tx:delete:services',
      'tx:insert:services',
      'tx:commit',
    ])
  })

  it('delete precedes insert (operator-wide cleanup before re-index)', async () => {
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(ctx, op(validProfile()))
    const di = captured.events.indexOf('tx:delete:services')
    const ii = captured.events.indexOf('tx:insert:services')
    expect(di).toBeGreaterThanOrEqual(0)
    expect(ii).toBeGreaterThan(di)
  })

  it('insert carries the canonical column set with three timestamps', async () => {
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(ctx, op(validProfile()))
    expect(captured.insertValues).toMatchObject({
      uri: 'at://did:plc:provider/com.dina.service.profile/self',
      operatorDid: 'did:plc:provider',
      name: 'SF Transit',
      isDiscoverable: true,
    })
    expect(captured.insertValues?.createdAt).toBeInstanceOf(Date)
    expect(captured.insertValues?.updatedAt).toBeInstanceOf(Date)
    expect(captured.insertValues?.indexedAt).toBeInstanceOf(Date)
  })

  it('preserves prior createdAt on re-publish by the same operator', async () => {
    // First publish was 2026-01-01. A re-publish today should keep
    // that original createdAt while bumping updatedAt (operator stamp)
    // and indexedAt (AppView write time). Operators looking at "when
    // did this provider first sign up" rely on createdAt stability.
    const original = new Date('2026-01-01T00:00:00.000Z')
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured, { priorCreatedAt: original })
    await serviceProfileHandler.handleCreate(ctx, op(validProfile()))
    expect(captured.insertValues?.createdAt).toEqual(original)
    // updatedAt + indexedAt must be a different (newer) instant.
    const u = captured.insertValues?.updatedAt as Date
    const i = captured.insertValues?.indexedAt as Date
    expect(u.getTime()).toBeGreaterThan(original.getTime())
    expect(i.getTime()).toBeGreaterThan(original.getTime())
  })

  it('updatedAt mirrors the operator-stamped record.updatedAt (not the ingest time)', async () => {
    // The operator's PDS record carries `updatedAt` — the moment they
    // changed the content. Mirroring it into the index makes
    // operator-facing audit ("when did Alice last touch her profile")
    // accurate. Mirroring `now` would conflate that with re-ingests.
    const operatorStamp = new Date('2026-03-15T12:34:56.000Z')
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(
      ctx,
      op({ ...validProfile(), updatedAt: operatorStamp.toISOString() }),
    )
    expect(captured.insertValues?.updatedAt).toEqual(operatorStamp)
    // indexedAt is distinct — bumped to ingest time.
    const i = captured.insertValues?.indexedAt as Date
    expect(i.getTime()).not.toBe(operatorStamp.getTime())
  })

  it('fresh operator (no prior row) gets createdAt = now', async () => {
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured, { priorCreatedAt: null })
    await serviceProfileHandler.handleCreate(ctx, op(validProfile()))
    const c = captured.insertValues?.createdAt as Date
    expect(c).toBeInstanceOf(Date)
    expect(Math.abs(c.getTime() - Date.now())).toBeLessThan(5000)
  })

  it('skips records with isDiscoverable=false (no transaction opened)', async () => {
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(
      ctx,
      op({ ...validProfile(), isDiscoverable: false }),
    )
    expect(captured.txOpened).toBe(false)
    expect(captured.events).toEqual([])
  })

  it('skips records whose responsePolicy values are outside the supported set', async () => {
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(
      ctx,
      op({ ...validProfile(), responsePolicy: { eta_query: 'manual' } }),
    )
    expect(captured.txOpened).toBe(false)
  })

  it('does NOT use ON CONFLICT on the insert (delete already cleared the row)', async () => {
    // The handler relies on the DELETE for idempotency; an
    // ON CONFLICT clause on the INSERT would be dead code. This
    // test fails if a future refactor adds one back (the stub's
    // insert chain only exposes `.values()`, not `.onConflictDoUpdate`).
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured)
    await expect(
      serviceProfileHandler.handleCreate(ctx, op(validProfile())),
    ).resolves.not.toThrow()
  })

  it('normalizes capabilities (trim + lowercase + dedupe) before indexing', async () => {
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(
      ctx,
      op({
        ...validProfile(),
        capabilities: ['  Plumbing  ', 'plumbing', 'ETA_QUERY', 'eta_query'],
        responsePolicy: { plumbing: 'auto', eta_query: 'auto' },
      }),
    )
    expect(captured.insertValues?.capabilitiesJson).toEqual([
      'plumbing',
      'eta_query',
    ])
  })

  it('drops empty-string capabilities after trim', async () => {
    const captured: Captured = { events: [], insertValues: null, txOpened: false }
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(
      ctx,
      op({
        ...validProfile(),
        capabilities: ['eta_query', '   '],
        responsePolicy: { eta_query: 'auto' },
      }),
    )
    expect(captured.insertValues?.capabilitiesJson).toEqual(['eta_query'])
  })
})
