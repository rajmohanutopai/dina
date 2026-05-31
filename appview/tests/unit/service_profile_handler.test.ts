/**
 * Unit tests for `appview/src/ingester/handlers/service-profile.ts`.
 *
 * Focus: pin the invariants the handler guarantees:
 *   1. select(uri) → delete(other uris) → upsert(uri) inside a single
 *      transaction so concurrent readers never see a momentary "no
 *      profiles for this operator" state.
 *   2. The write is an idempotent UPSERT on `uri` — concurrency-safe
 *      against the ingester's parallel queue + spool replay (the old
 *      delete-then-plain-insert raced → services_pkey duplicate_key).
 *   3. At most one indexed profile per operator: deleting the operator's
 *      OTHER uris means re-publishing under a new rkey replaces the prior.
 *   4. createdAt preserved across re-publishes of the same uri.
 */

import { describe, it, expect, vi } from 'vitest'
import { serviceProfileHandler } from '@/ingester/handlers/service-profile'
import { services } from '@/db/schema/services'

interface Captured {
  events: string[]
  insertValues: Record<string, unknown> | null
  /** The `set` payload passed to onConflictDoUpdate. */
  conflictSet: Record<string, unknown> | null
  txOpened: boolean
}

function stubCtx(captured: Captured, opts: { priorCreatedAt?: Date | null } = {}) {
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
          values: (v: Record<string, unknown>) => {
            captured.insertValues = v
            return {
              // The handler now uses an idempotent upsert; the stub models
              // the `.values().onConflictDoUpdate()` chain and treats the
              // terminal call as the awaited write.
              onConflictDoUpdate: async (cfg: { set: Record<string, unknown> }) => {
                captured.conflictSet = cfg.set
                captured.events.push(
                  `${prefix}upsert:${table === services ? 'services' : 'unknown'}`,
                )
              },
            }
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

function freshCaptured(): Captured {
  return { events: [], insertValues: null, conflictSet: null, txOpened: false }
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
  it('runs select + upsert inside a single transaction (NO cross-uri delete)', async () => {
    const captured = freshCaptured()
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(ctx, op(validProfile()))
    expect(captured.txOpened).toBe(true)
    // SELECT first (to preserve createdAt for this uri), then UPSERT the
    // current uri. The handler does NOT delete the operator's other uris —
    // each published profile is its own listing (multi-listing per DID).
    expect(captured.events).toEqual([
      'tx:begin',
      'tx:select:services',
      'tx:upsert:services',
      'tx:commit',
    ])
  })

  it('does NOT delete the operator other listings (marketplace multi-listing)', async () => {
    // Regression for the one-profile-per-DID limitation: a provider with
    // many products lists many profiles, each under its own rkey/uri. The
    // ingester must NOT wipe an operator's other rows when one is published.
    const captured = freshCaptured()
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(ctx, op(validProfile()))
    expect(captured.events).not.toContain('tx:delete:services')
  })

  it('upsert carries the canonical column set with three timestamps', async () => {
    const captured = freshCaptured()
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

  it('is an idempotent UPSERT (onConflictDoUpdate) — concurrency-safe on `uri`', async () => {
    // Regression: the old path was delete + plain insert with NO ON
    // CONFLICT, relying on "the DELETE guarantees no row at this uri".
    // Under the ingester's parallel queue + spool replay, two same-uri
    // events interleaved → services_pkey duplicate_key → requeue storm →
    // the row never landed (price_check never became discoverable). The
    // write MUST be an upsert so concurrent same-uri writes converge.
    const captured = freshCaptured()
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(ctx, op(validProfile()))
    expect(captured.events).toContain('tx:upsert:services')
    expect(captured.conflictSet).not.toBeNull()
    // The conflict update overwrites content but NOT createdAt.
    expect(captured.conflictSet).toMatchObject({
      cid: 'bafytest123',
      name: 'SF Transit',
      isDiscoverable: true,
    })
    expect(captured.conflictSet).not.toHaveProperty('createdAt')
  })

  it('preserves prior createdAt on re-publish of the same uri (insert path)', async () => {
    const original = new Date('2026-01-01T00:00:00.000Z')
    const captured = freshCaptured()
    const ctx = stubCtx(captured, { priorCreatedAt: original })
    await serviceProfileHandler.handleCreate(ctx, op(validProfile()))
    expect(captured.insertValues?.createdAt).toEqual(original)
    const u = captured.insertValues?.updatedAt as Date
    const i = captured.insertValues?.indexedAt as Date
    expect(u.getTime()).toBeGreaterThan(original.getTime())
    expect(i.getTime()).toBeGreaterThan(original.getTime())
  })

  it('updatedAt mirrors the operator-stamped record.updatedAt (not the ingest time)', async () => {
    const operatorStamp = new Date('2026-03-15T12:34:56.000Z')
    const captured = freshCaptured()
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(
      ctx,
      op({ ...validProfile(), updatedAt: operatorStamp.toISOString() }),
    )
    expect(captured.insertValues?.updatedAt).toEqual(operatorStamp)
    const i = captured.insertValues?.indexedAt as Date
    expect(i.getTime()).not.toBe(operatorStamp.getTime())
  })

  it('fresh operator (no prior row) gets createdAt = now', async () => {
    const captured = freshCaptured()
    const ctx = stubCtx(captured, { priorCreatedAt: null })
    await serviceProfileHandler.handleCreate(ctx, op(validProfile()))
    const c = captured.insertValues?.createdAt as Date
    expect(c).toBeInstanceOf(Date)
    expect(Math.abs(c.getTime() - Date.now())).toBeLessThan(5000)
  })

  it('skips records with isDiscoverable=false (no transaction opened)', async () => {
    const captured = freshCaptured()
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(ctx, op({ ...validProfile(), isDiscoverable: false }))
    expect(captured.txOpened).toBe(false)
    expect(captured.events).toEqual([])
  })

  it('skips records whose responsePolicy values are outside the supported set', async () => {
    const captured = freshCaptured()
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(
      ctx,
      op({ ...validProfile(), responsePolicy: { eta_query: 'manual' } }),
    )
    expect(captured.txOpened).toBe(false)
  })

  it('canonicalizes capabilities (alias→canonical, case, dedupe) before indexing', async () => {
    const captured = freshCaptured()
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(
      ctx,
      op({
        ...validProfile(),
        capabilities: ['  BUS_ETA  ', 'bus_eta', 'ETA_QUERY', 'eta_query'],
        responsePolicy: { bus_eta: 'auto', eta_query: 'auto' },
      }),
    )
    expect(captured.insertValues?.capabilitiesJson).toEqual(['eta_query'])
  })

  it('drops UNKNOWN capabilities from the public index + meters them (P2)', async () => {
    const captured = freshCaptured()
    const ctx = stubCtx(captured)
    const metricCalls: Array<{ name: string; tags?: Record<string, string> }> = []
    ctx.metrics.incr = (name: string, tags?: Record<string, string>) => {
      metricCalls.push({ name, tags })
    }
    await serviceProfileHandler.handleCreate(
      ctx,
      op({
        ...validProfile(),
        capabilities: ['plumbing', 'eta_query'],
        responsePolicy: { plumbing: 'auto', eta_query: 'auto' },
      }),
    )
    expect(captured.insertValues?.capabilitiesJson).toEqual(['eta_query'])
    expect(captured.insertValues?.isDiscoverable).toBe(true)
    expect(
      metricCalls.some(
        (m) => m.name === 'service.capability.unknown' && m.tags?.cap === 'plumbing',
      ),
    ).toBe(true)
  })

  it('re-keys capabilitySchemas + responsePolicy to the canonical name (P1b)', async () => {
    const captured = freshCaptured()
    const ctx = stubCtx(captured)
    await serviceProfileHandler.handleCreate(
      ctx,
      op({
        ...validProfile(),
        capabilities: ['bus_eta'],
        responsePolicy: { bus_eta: 'auto' },
        capabilitySchemas: { bus_eta: { params: { type: 'object' }, schema_hash: 'abc' } },
      }),
    )
    expect(captured.insertValues?.capabilitiesJson).toEqual(['eta_query'])
    expect(captured.insertValues?.responsePolicyJson).toEqual({ eta_query: 'auto' })
    expect(captured.insertValues?.capabilitySchemasJson).toEqual({
      eta_query: { params: { type: 'object' }, schema_hash: 'abc' },
    })
    // The re-keyed maps also flow into the conflict-update set.
    expect(captured.conflictSet?.responsePolicyJson).toEqual({ eta_query: 'auto' })
  })

  it('drops empty-string capabilities after trim', async () => {
    const captured = freshCaptured()
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
