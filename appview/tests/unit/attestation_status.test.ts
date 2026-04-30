/**
 * Unit tests for `appview/src/api/xrpc/attestation-status.ts`
 * (TN-API-005 / Plan §3.5.1 + §6).
 *
 * Contract:
 *   - Param schema: comma-split + dedupe + max 100 + AT-URI regex
 *   - Status precedence: indexed wins over rejected when both exist
 *   - Rejection rows ordered DESC by rejected_at; latest reason wins
 *   - URI absent from both tables → `pending`
 *   - Response array preserves the caller's input order
 */

import { describe, expect, it } from 'vitest'
import {
  attestationStatus,
  AttestationStatusParams,
} from '@/api/xrpc/attestation-status'
import { attestations, ingestRejections } from '@/db/schema/index'
import type { DrizzleDB } from '@/db/connection'

interface IndexedRow {
  uri: string
}
interface RejectionRow {
  atUri: string
  reason: string
  detail: unknown
  rejectedAt: Date
}

/**
 * Stub for the two queries the handler issues:
 *   db.select(...).from(attestations).where(inArray(uri, [...]))
 *   db.select(...).from(ingestRejections).where(inArray(atUri, [...])).orderBy(...)
 *
 * Routes by object identity against the actual schema imports — the
 * exact references the handler uses, so the assertion is exact.
 */
function stubDb(opts: {
  attestations?: IndexedRow[]
  rejections?: RejectionRow[]
}): DrizzleDB {
  const indexed = opts.attestations ?? []
  const rejections = opts.rejections ?? []
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === ingestRejections) {
          // The rejection branch ends at .orderBy(...); the .where()
          // is intermediate. Drizzle's awaitable shape lives on the
          // last call.
          return {
            where: () => ({
              orderBy: async () => rejections,
            }),
          }
        }
        if (table === attestations) {
          // The attestations branch ends at .where(...) — Drizzle
          // returns a thenable so `await db.select().from(...).where(...)`
          // resolves directly.
          return {
            where: () => Promise.resolve(indexed),
          }
        }
        throw new Error('stubDb: unexpected table reference')
      },
    }),
  } as unknown as DrizzleDB
}

describe('AttestationStatusParams — TN-API-005 schema', () => {
  it('parses a single URI', () => {
    const r = AttestationStatusParams.safeParse({
      uris: 'at://did:plc:alice/com.dina.trust.attestation/3kfx',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.uris).toEqual([
        'at://did:plc:alice/com.dina.trust.attestation/3kfx',
      ])
    }
  })

  it('comma-splits + trims + dedupes', () => {
    const r = AttestationStatusParams.safeParse({
      uris: 'at://x/y/1, at://x/y/2 ,at://x/y/1',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      // Order preserved (Set iteration is insertion-order in JS),
      // duplicates collapsed.
      expect(r.data.uris).toEqual(['at://x/y/1', 'at://x/y/2'])
    }
  })

  it('rejects empty strings as no-URI', () => {
    const r = AttestationStatusParams.safeParse({ uris: '' })
    expect(r.success).toBe(false)
  })

  it('rejects trailing commas / whitespace-only entries', () => {
    // After split + trim + filter(Boolean), `,` becomes [] which fails
    // the post-transform `.min(1)` constraint.
    const r = AttestationStatusParams.safeParse({ uris: ',,,' })
    expect(r.success).toBe(false)
  })

  it('caps input at 100 URIs', () => {
    const uris = Array.from({ length: 101 }, (_, i) => `at://x/y/${i}`).join(',')
    const r = AttestationStatusParams.safeParse({ uris })
    expect(r.success).toBe(false)
  })

  it('allows exactly 100 URIs', () => {
    const uris = Array.from({ length: 100 }, (_, i) => `at://x/y/${i}`).join(',')
    const r = AttestationStatusParams.safeParse({ uris })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.uris).toHaveLength(100)
  })

  it('rejects non-AT-URI strings', () => {
    const r = AttestationStatusParams.safeParse({
      uris: 'http://example.com/foo',
    })
    expect(r.success).toBe(false)
  })
})

describe('attestationStatus handler — TN-API-005', () => {
  it('returns indexed for URIs found in attestations', async () => {
    const db = stubDb({
      attestations: [{ uri: 'at://x/y/1' }, { uri: 'at://x/y/2' }],
    })
    const result = await attestationStatus(db, {
      uris: ['at://x/y/1', 'at://x/y/2'],
    })
    expect(result.statuses).toEqual([
      { uri: 'at://x/y/1', status: 'indexed' },
      { uri: 'at://x/y/2', status: 'indexed' },
    ])
  })

  it('returns rejected for URIs found only in ingest_rejections', async () => {
    const rejectedAt = new Date('2026-04-29T10:00:00Z')
    const db = stubDb({
      attestations: [],
      rejections: [
        {
          atUri: 'at://x/y/1',
          reason: 'rate_limit',
          detail: { remaining: 0 },
          rejectedAt,
        },
      ],
    })
    const result = await attestationStatus(db, { uris: ['at://x/y/1'] })
    expect(result.statuses).toEqual([
      {
        uri: 'at://x/y/1',
        status: 'rejected',
        reason: 'rate_limit',
        detail: { remaining: 0 },
        rejectedAt: '2026-04-29T10:00:00.000Z',
      },
    ])
  })

  it('returns pending for URIs in neither table', async () => {
    const db = stubDb({})
    const result = await attestationStatus(db, { uris: ['at://x/y/1'] })
    expect(result.statuses).toEqual([{ uri: 'at://x/y/1', status: 'pending' }])
  })

  it('indexed wins over rejected (key contract — retry succeeded)', async () => {
    // A record may be rejected once (transient signature_invalid)
    // and then retry-succeed. The mobile watcher must see "indexed"
    // for that URI, not "rejected" — otherwise the user sees a
    // false-failure surface for a record that actually landed.
    const db = stubDb({
      attestations: [{ uri: 'at://x/y/1' }],
      rejections: [
        {
          atUri: 'at://x/y/1',
          reason: 'signature_invalid',
          detail: null,
          rejectedAt: new Date('2026-04-29T09:00:00Z'),
        },
      ],
    })
    const result = await attestationStatus(db, { uris: ['at://x/y/1'] })
    expect(result.statuses).toEqual([
      { uri: 'at://x/y/1', status: 'indexed' },
    ])
  })

  it('latest rejection reason wins per URI (most recent rejected_at)', async () => {
    const db = stubDb({
      attestations: [],
      rejections: [
        {
          atUri: 'at://x/y/1',
          reason: 'rate_limit',
          detail: null,
          // ORDER BY DESC means this row arrives FIRST in the stub:
          rejectedAt: new Date('2026-04-29T10:00:00Z'),
        },
        {
          atUri: 'at://x/y/1',
          reason: 'signature_invalid',
          detail: null,
          rejectedAt: new Date('2026-04-29T09:00:00Z'),
        },
      ],
    })
    const result = await attestationStatus(db, { uris: ['at://x/y/1'] })
    expect(result.statuses[0]).toMatchObject({
      uri: 'at://x/y/1',
      status: 'rejected',
      reason: 'rate_limit', // not 'signature_invalid'
    })
  })

  it('preserves caller URI order in the response array', async () => {
    // Mobile watcher may pair statuses positionally with its
    // expected-pending list — output order MUST match input.
    const db = stubDb({
      attestations: [{ uri: 'at://x/y/B' }],
      rejections: [
        {
          atUri: 'at://x/y/A',
          reason: 'feature_off',
          detail: null,
          rejectedAt: new Date(),
        },
      ],
    })
    const result = await attestationStatus(db, {
      uris: ['at://x/y/C', 'at://x/y/A', 'at://x/y/B'],
    })
    expect(result.statuses.map((s) => s.uri)).toEqual([
      'at://x/y/C',
      'at://x/y/A',
      'at://x/y/B',
    ])
  })

  it('omits detail key when rejection.detail is null (cleaner JSON)', async () => {
    const db = stubDb({
      rejections: [
        {
          atUri: 'at://x/y/1',
          reason: 'feature_off',
          detail: null,
          rejectedAt: new Date('2026-04-29T10:00:00Z'),
        },
      ],
    })
    const result = await attestationStatus(db, { uris: ['at://x/y/1'] })
    const entry = result.statuses[0] as { detail?: unknown }
    expect('detail' in entry).toBe(false)
  })

  it('mixed indexed/rejected/pending in one batch', async () => {
    const db = stubDb({
      attestations: [{ uri: 'at://x/y/I' }],
      rejections: [
        {
          atUri: 'at://x/y/R',
          reason: 'schema_invalid',
          detail: { field: 'subject' },
          rejectedAt: new Date('2026-04-29T10:00:00Z'),
        },
      ],
    })
    const result = await attestationStatus(db, {
      uris: ['at://x/y/I', 'at://x/y/R', 'at://x/y/P'],
    })
    expect(result.statuses[0]).toEqual({ uri: 'at://x/y/I', status: 'indexed' })
    expect(result.statuses[1]).toMatchObject({
      uri: 'at://x/y/R',
      status: 'rejected',
      reason: 'schema_invalid',
    })
    expect(result.statuses[2]).toEqual({ uri: 'at://x/y/P', status: 'pending' })
  })
})
