/**
 * Unit tests for `appview/src/ingester/rejection-writer.ts` (TN-ING-005).
 *
 * The writer's contract:
 *   - INSERT one row to `ingest_rejections` (best-effort)
 *   - Emit a structured `warn`-level log line with the same fields
 *   - Increment `ingester.rejections{reason=<reason>}` metric
 *   - NEVER throw — INSERT failures are swallowed (logged) so the
 *     ingester pipeline doesn't OOM-loop on a degraded DB.
 */

import { describe, it, expect, vi } from 'vitest'
import { recordRejection, type RejectionContext } from '@/ingester/rejection-writer'

interface CapturedInsert {
  atUri: string
  did: string
  reason: string
  detail: Record<string, unknown> | null
}

/**
 * Stub DrizzleDB matching the chain `db.insert(table).values(row)`.
 * Captures the inserted row for assertions; throws if `shouldFail` is true.
 */
function stubDb(shouldFail = false): { db: RejectionContext['db']; captures: CapturedInsert[] } {
  const captures: CapturedInsert[] = []
  const db = {
    insert: () => ({
      values: async (row: CapturedInsert) => {
        if (shouldFail) throw new Error('simulated DB failure')
        captures.push(row)
      },
    }),
  } as unknown as RejectionContext['db']
  return { db, captures }
}

function stubCtx(shouldFail = false) {
  const { db, captures } = stubDb(shouldFail)
  const logWarn = vi.fn()
  const metricsIncr = vi.fn()
  const ctx: RejectionContext = {
    db,
    logger: { warn: logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as RejectionContext['logger'],
    metrics: { incr: metricsIncr, observe: vi.fn(), gauge: vi.fn() } as unknown as RejectionContext['metrics'],
  }
  return { ctx, captures, logWarn, metricsIncr }
}

describe('recordRejection — TN-ING-005', () => {
  it('inserts row with at_uri, did, reason, and detail', async () => {
    const { ctx, captures } = stubCtx()
    await recordRejection(ctx, {
      atUri: 'at://did:plc:test/com.dina.trust.attestation/abc',
      did: 'did:plc:test',
      reason: 'rate_limit',
      detail: { limit_remaining: 0 },
    })
    expect(captures).toHaveLength(1)
    expect(captures[0]).toEqual({
      atUri: 'at://did:plc:test/com.dina.trust.attestation/abc',
      did: 'did:plc:test',
      reason: 'rate_limit',
      detail: { limit_remaining: 0 },
    })
  })

  it('inserts row with detail = null when omitted', async () => {
    // Optional `detail` becomes NULL on the wire — keeps INSERT signature uniform.
    const { ctx, captures } = stubCtx()
    await recordRejection(ctx, {
      atUri: 'at://did:plc:test/x/y',
      did: 'did:plc:test',
      reason: 'feature_off',
    })
    expect(captures[0].detail).toBeNull()
  })

  it('emits warn-level log line with mirror fields and spread detail', async () => {
    // Log fields mirror the row columns so log search by at_uri finds the same
    // rejection that the outbox watcher will pick up via DB poll. `detail` is
    // spread at the top level for ergonomic log queries.
    const { ctx, logWarn } = stubCtx()
    await recordRejection(ctx, {
      atUri: 'at://did:plc:test/x/y',
      did: 'did:plc:test',
      reason: 'schema_invalid',
      detail: { phase: 'cid_missing' },
    })
    expect(logWarn).toHaveBeenCalledTimes(1)
    const [logFields, message] = logWarn.mock.calls[0]
    expect(logFields).toMatchObject({
      at_uri: 'at://did:plc:test/x/y',
      did: 'did:plc:test',
      reason: 'schema_invalid',
      phase: 'cid_missing',
    })
    expect(message).toBe('Record rejected by ingester')
  })

  it("increments `ingester.rejections{reason=<reason>}` metric", async () => {
    const { ctx, metricsIncr } = stubCtx()
    await recordRejection(ctx, {
      atUri: 'at://did:plc:test/x/y',
      did: 'did:plc:test',
      reason: 'namespace_disabled',
    })
    expect(metricsIncr).toHaveBeenCalledWith('ingester.rejections', { reason: 'namespace_disabled' })
  })

  it('does NOT throw when INSERT fails — log + metric still emit', async () => {
    // Most important contract: a failed rejection write must NOT take down the
    // ingester pipeline. A single bad record can't become a pipeline-wide outage.
    const { ctx, logWarn, metricsIncr } = stubCtx(/* shouldFail */ true)
    await expect(
      recordRejection(ctx, {
        atUri: 'at://did:plc:test/x/y',
        did: 'did:plc:test',
        reason: 'rate_limit',
      }),
    ).resolves.toBeUndefined()
    // First warn = INSERT failure log; second = the structured rejection log.
    expect(logWarn).toHaveBeenCalledTimes(2)
    // Metric still bumped — observability survives degraded DB.
    expect(metricsIncr).toHaveBeenCalledWith('ingester.rejections', { reason: 'rate_limit' })
  })

  it('accepts every reason in the closed taxonomy (TN-DB-005)', async () => {
    // Type-level guard against drift between RejectionReason and the DB column's
    // documented enum. If a future PR adds a reason here, the typeof check fails
    // until the type is also updated.
    const reasons: Array<import('@/ingester/rejection-writer').RejectionReason> = [
      'rate_limit',
      'signature_invalid',
      'schema_invalid',
      'namespace_disabled',
      'feature_off',
      'pds_suspended',
    ]
    const { ctx, captures } = stubCtx()
    for (const reason of reasons) {
      await recordRejection(ctx, { atUri: 'at://x/y/z', did: 'did:plc:x', reason })
    }
    expect(captures.map((c) => c.reason)).toEqual(reasons)
  })
})
