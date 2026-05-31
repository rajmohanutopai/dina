/**
 * Unit tests for `appview/src/api/xrpc/get-attestations.ts`.
 *
 * Coverage:
 *   - Param validation (limit bound, cursor max-length)
 *   - Opaque cursor decode (round-trip + reject plaintext `${ISO}::${uri}`)
 *   - did_redactions GDPR-shaped exclusion (column reference pin)
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { getAttestations, GetAttestationsParams } from '@/api/xrpc/get-attestations'
import type { DrizzleDB } from '@/db/connection'

interface AttRow {
  uri: string
  authorDid: string
  recordCreatedAt: Date
  isRevoked: boolean
}

let _capturedWhereFilter: unknown = undefined

beforeEach(() => {
  _capturedWhereFilter = undefined
})

/**
 * Stub DB matching the `select.from.leftJoin.leftJoin.where.orderBy.limit`
 * chain the handler issues. Chainable leftJoin so additional joins
 * land without re-stubbing.
 */
function stubDb(rows: AttRow[]): DrizzleDB {
  const chainAfterJoin = (): unknown => ({
    leftJoin: () => chainAfterJoin(),
    where: (filter: unknown) => {
      _capturedWhereFilter = filter
      return {
        orderBy: () => ({
          limit: async () => rows.map((r) => ({
            attestation: r,
            handle: null,
          })),
        }),
      }
    },
  })
  return {
    select: () => ({ from: () => chainAfterJoin() }),
  } as unknown as DrizzleDB
}

// ── Param schema ──────────────────────────────────────────────

describe('GetAttestationsParams', () => {
  it('accepts an empty request (no required fields)', () => {
    const r = GetAttestationsParams.safeParse({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.limit).toBe(25)
  })

  it('rejects a non-DID authorDid', () => {
    const r = GetAttestationsParams.safeParse({ authorDid: 'not-a-did' })
    expect(r.success).toBe(false)
  })

  it('caps limit at 100', () => {
    const r = GetAttestationsParams.safeParse({ limit: 200 })
    expect(r.success).toBe(false)
  })

  it('coerces a string limit (URL params arrive as strings)', () => {
    const r = GetAttestationsParams.safeParse({ limit: '50' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.limit).toBe(50)
  })

  it('bounds cursor at 500 chars (param-layer only — shape is handler-layer)', () => {
    const r = GetAttestationsParams.safeParse({ cursor: 'a'.repeat(501) })
    expect(r.success).toBe(false)
  })
})

// ── Opaque cursor handling ────────────────────────────────────

describe('getAttestations — opaque cursor', () => {
  it('rejects a plaintext `${ISO}::${uri}` cursor (not an opaque envelope)', async () => {
    // A naive ISO-prefixed string is the most plausible-looking
    // non-opaque input. Confirm the envelope discipline rejects it.
    const db = stubDb([])
    await expect(
      getAttestations(db, {
        limit: 25,
        cursor: '2026-05-23T00:00:00.000Z::at://did:plc:x/y/abc',
      } as never),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('rejects garbage cursors as ZodError → 400', async () => {
    const db = stubDb([])
    await expect(
      getAttestations(db, { limit: 25, cursor: 'not-a-cursor' } as never),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('accepts a well-formed opaque cursor', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        v: 1,
        ts: '2026-05-23T00:00:00.000Z',
        uri: 'at://did:plc:x/y/abc',
      }),
      'utf8',
    ).toString('base64url')
    const db = stubDb([])
    await expect(
      getAttestations(db, { limit: 25, cursor } as never),
    ).resolves.toMatchObject({ attestations: [] })
  })

  it('emits an opaque base64url envelope when hasMore', async () => {
    // Handler queries `limit + 1` rows; with limit=2 and 3 rows, the
    // handler slices to 2 and emits a cursor pointing at the LAST
    // row of the page (i.e. row B at index 1, not row C at index 2).
    const rows: AttRow[] = [
      {
        uri: 'at://did:plc:r/com.dinakernel.peerlens.attestation/A',
        authorDid: 'did:plc:r',
        recordCreatedAt: new Date('2026-05-23T10:00:00Z'),
        isRevoked: false,
      },
      {
        uri: 'at://did:plc:r/com.dinakernel.peerlens.attestation/B',
        authorDid: 'did:plc:r',
        recordCreatedAt: new Date('2026-05-23T09:00:00Z'),
        isRevoked: false,
      },
      {
        uri: 'at://did:plc:r/com.dinakernel.peerlens.attestation/C',
        authorDid: 'did:plc:r',
        recordCreatedAt: new Date('2026-05-23T08:00:00Z'),
        isRevoked: false,
      },
    ]
    const db = stubDb(rows)
    const r = (await getAttestations(db, { limit: 2 } as never)) as {
      attestations: unknown[]
      cursor?: string
    }
    expect(r.attestations).toHaveLength(2)
    expect(typeof r.cursor).toBe('string')
    const decoded = JSON.parse(
      Buffer.from(r.cursor!, 'base64url').toString('utf8'),
    )
    expect(decoded).toMatchObject({
      v: 1,
      ts: '2026-05-23T09:00:00.000Z',
      uri: 'at://did:plc:r/com.dinakernel.peerlens.attestation/B',
    })
  })
})

// ── did_redactions GDPR-shaped exclusion ──────────────────────

describe('getAttestations — did_redactions filter', () => {
  it('WHERE references did_redactions.did (GDPR-shaped author exclusion)', async () => {
    // LEFT JOIN against did_redactions + IS NULL check in the WHERE
    // means a redacted author's attestations drop out of the result
    // set entirely. Pin the column reference so a refactor that
    // drops the join surfaces in tests, not on the wire. Mirror of
    // the service-search.ts stance.
    const db = stubDb([])
    await getAttestations(db, { limit: 25 } as never)
    expect(_capturedWhereFilter).toBeDefined()

    const serialized = JSON.stringify(_capturedWhereFilter, (_k, v) => {
      if (
        v !== null &&
        typeof v === 'object' &&
        'name' in (v as Record<string, unknown>) &&
        typeof (v as { name: unknown }).name === 'string'
      ) {
        return `col:${(v as { name: string }).name}`
      }
      return v
    })
    // `did_redactions.did` → `col:did`. Other DID-bearing columns
    // (`attestations.author_did`) serialize as `col:author_did` and
    // are excluded by the `(?!_)` negative lookahead.
    const didRefs = serialized.match(/col:did(?!_)/g) ?? []
    expect(didRefs.length).toBeGreaterThanOrEqual(1)
  })

  it('WHERE references is_takedown_by_moderator (moderator takedown excluded)', async () => {
    // A moderator-taken-down attestation must not surface in the raw
    // attestation list. Mirror of subject-get's filter.
    const db = stubDb([])
    await getAttestations(db, { limit: 25 } as never)
    const serialized = JSON.stringify(_capturedWhereFilter, (_k, v) => {
      if (
        v !== null &&
        typeof v === 'object' &&
        'name' in (v as Record<string, unknown>) &&
        typeof (v as { name: unknown }).name === 'string'
      ) {
        return `col:${(v as { name: string }).name}`
      }
      return v
    })
    expect(serialized).toContain('col:is_takedown_by_moderator')
  })
})
