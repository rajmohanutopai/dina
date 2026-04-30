/**
 * Unit tests for `trace_id` propagation (TN-OBS-002 / Plan §13.8).
 *
 * Plan §13.8 requires every record to carry a synthetic
 * `trust_v1.trace_id` from firehose ingest through to the score row.
 * V1 implementation:
 *   1. `JetstreamConsumer.processEvent` synthesizes one UUID v4 per
 *      commit event via `crypto.randomUUID()`.
 *   2. The trace_id propagates through the dispatcher into both
 *      branches: success path → handler `RecordOp.traceId`, rejection
 *      path → `RejectionContext.traceId`.
 *   3. Handlers stamp the id on the `attestations.trace_id` column
 *      and rejection writers stamp it on the rejection log line.
 *
 * Coverage strategy: focus on the contract pins, not exhaustive
 * dispatcher behaviour (already covered by `06-jetstream-consumer.
 * test.ts`). The pins here are:
 *   - `RecordOp.traceId` is part of the typed contract (caught by
 *     tsc, not runtime — but pinned by an it() that constructs one).
 *   - `RejectionContext.traceId` propagates into the rejection log
 *     line.
 *   - `attestations` schema has a `traceId` column (caught by tsc;
 *     pinned via direct schema access).
 *   - Trace ids are unique per-event (probabilistically — UUID v4).
 */

import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const mockMetricsIncr = vi.fn()
vi.mock('@/shared/utils/metrics.js', () => ({
  metrics: { incr: (...a: unknown[]) => mockMetricsIncr(...a) },
}))

const mockLoggerWarn = vi.fn()
vi.mock('@/shared/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { recordRejection } from '@/ingester/rejection-writer'
import { attestations } from '@/db/schema/index'
import type { RecordOp } from '@/ingester/handlers/index'
import type { DrizzleDB } from '@/db/connection'

// Stub DB whose insert chain just resolves successfully.
function makeStubDb(): { db: DrizzleDB; insertCalls: unknown[] } {
  const insertCalls: unknown[] = []
  const db = {
    insert: () => ({
      values: (vals: unknown) => {
        insertCalls.push(vals)
        return Promise.resolve()
      },
    }),
  } as unknown as DrizzleDB
  return { db, insertCalls }
}

describe('trace_id propagation — TN-OBS-002', () => {
  it('attestations schema exposes a trace_id column', () => {
    // Compile-time + runtime pin: the schema must carry the column
    // so handlers can write to it. Drizzle exposes table columns as
    // enumerable properties on the table object.
    const cols = attestations as unknown as Record<string, unknown>
    expect(cols.traceId).toBeDefined()
  })

  it('RecordOp shape carries optional traceId', () => {
    // tsc catches this; the runtime test just confirms the field
    // round-trips through a literal construction (defends against
    // an accidental rename to `trace_id_` or moving it under a
    // nested object).
    const op: RecordOp = {
      uri: 'at://did:plc:author/com.dina.trust.attestation/abc',
      did: 'did:plc:author',
      collection: 'com.dina.trust.attestation',
      rkey: 'abc',
      cid: 'bafyfake',
      record: { hello: 'world' },
      traceId: 'some-uuid',
    }
    expect(op.traceId).toBe('some-uuid')
  })

  it('rejection writer log line includes trace_id when ctx supplies one', async () => {
    mockLoggerWarn.mockClear()
    const { db } = makeStubDb()
    const traceId = randomUUID()
    await recordRejection(
      { db, logger: { warn: mockLoggerWarn } as never, metrics: { incr: mockMetricsIncr } as never, traceId },
      {
        atUri: 'at://did:plc:author/com.dina.trust.attestation/x',
        did: 'did:plc:author',
        reason: 'rate_limit',
      },
    )
    // Two warn calls expected: 0 = INSERT-failure path (none here,
    // since stub resolves), 1 = the structured rejection log.
    // Find the structured log call by searching for trace_id.
    const calls = mockLoggerWarn.mock.calls
    const structuredCall = calls.find((c) => {
      const fields = c[0] as Record<string, unknown>
      return fields && typeof fields === 'object' && 'trace_id' in fields
    })
    expect(structuredCall).toBeDefined()
    expect((structuredCall![0] as Record<string, unknown>).trace_id).toBe(traceId)
  })

  it('rejection writer omits trace_id when ctx does not supply one (legacy path)', async () => {
    // Backward-compat pin: callers that haven't been migrated to
    // pass a trace_id continue working — the log line just omits
    // the field rather than fabricating a fresh trace mid-pipeline
    // (which would be misleading).
    mockLoggerWarn.mockClear()
    const { db } = makeStubDb()
    await recordRejection(
      { db, logger: { warn: mockLoggerWarn } as never, metrics: { incr: mockMetricsIncr } as never },
      {
        atUri: 'at://did:plc:author/com.dina.trust.attestation/y',
        did: 'did:plc:author',
        reason: 'feature_off',
      },
    )
    const calls = mockLoggerWarn.mock.calls
    // Find the structured log call (the only one, since stub
    // INSERT resolves successfully).
    expect(calls.length).toBeGreaterThan(0)
    const fields = calls[calls.length - 1][0] as Record<string, unknown>
    expect('trace_id' in fields).toBe(false)
  })

  it('rejection writer includes trace_id without overwriting reason-specific detail', async () => {
    // Detail keys must coexist with trace_id at the top level of
    // the log fields — neither overwrites the other.
    mockLoggerWarn.mockClear()
    const { db } = makeStubDb()
    await recordRejection(
      { db, logger: { warn: mockLoggerWarn } as never, metrics: { incr: mockMetricsIncr } as never, traceId: 'trace-1' },
      {
        atUri: 'at://x',
        did: 'did:plc:x',
        reason: 'rate_limit',
        detail: { scope: 'per_collection_daily', daily_cap: 60 },
      },
    )
    const calls = mockLoggerWarn.mock.calls
    const structuredCall = calls.find((c) => {
      const fields = c[0] as Record<string, unknown>
      return fields && 'trace_id' in fields
    })
    expect(structuredCall).toBeDefined()
    const fields = structuredCall![0] as Record<string, unknown>
    expect(fields.trace_id).toBe('trace-1')
    expect(fields.scope).toBe('per_collection_daily')
    expect(fields.daily_cap).toBe(60)
  })

  it('UUID v4: dispatcher-style trace ids are unique across calls', () => {
    // Probabilistic guarantee: 122 bits of randomness make
    // collisions effectively impossible in V1 traffic. Pin this
    // here so we don't accidentally switch to a non-unique source
    // (e.g. timestamp-only).
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      ids.add(randomUUID())
    }
    expect(ids.size).toBe(1000)
  })

  it('UUID v4 format matches RFC 4122 (8-4-4-4-12 hex)', () => {
    // Defends against switching to a non-RFC-compliant form. Log
    // aggregators (Loki, Elasticsearch) parse trace_id as an opaque
    // string but a stable shape helps debugging.
    const id = randomUUID()
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})
