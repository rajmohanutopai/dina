/**
 * Unit tests for `appview/src/api/xrpc/cosig-list.ts`
 * (TN-API-006 / Plan §6 + §10).
 *
 * Contract:
 *   - recipientDid mandatory; status optional enum
 *   - bigint id serialised to string in response
 *   - timestamps serialised to ISO strings
 *   - cursor format: ${ISO}::${id}; malformed cursor → 400
 *   - hasMore detection via limit+1 fetch pattern
 *   - status enum closed: pending/accepted/rejected/expired
 */

import { describe, expect, it } from 'vitest'
import { cosigList, CosigListParams } from '@/api/xrpc/cosig-list'
import type { DrizzleDB } from '@/db/connection'

interface CosigRow {
  id: bigint
  requesterDid: string
  recipientDid: string
  attestationUri: string
  status: string
  endorsementUri: string | null
  rejectReason: string | null
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

/**
 * Stub for `db.select().from(cosig_requests).where(...).orderBy(...).limit(...)`.
 * Returns the seeded rows verbatim — the test asserts at the
 * boundary (response shape, cursor encoding) without faking the
 * SQL planner.
 */
function stubDb(rows: CosigRow[]): DrizzleDB {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    }),
  } as unknown as DrizzleDB
}

function row(overrides: Partial<CosigRow> = {}): CosigRow {
  return {
    id: 1n,
    requesterDid: 'did:plc:requester',
    recipientDid: 'did:plc:recipient',
    attestationUri: 'at://did:plc:requester/com.dina.trust.attestation/3kfx',
    status: 'pending',
    endorsementUri: null,
    rejectReason: null,
    expiresAt: new Date('2026-05-29T12:00:00Z'),
    createdAt: new Date('2026-04-29T10:00:00Z'),
    updatedAt: new Date('2026-04-29T10:00:00Z'),
    ...overrides,
  }
}

describe('CosigListParams — TN-API-006 schema', () => {
  it('accepts a recipientDid alone', () => {
    const r = CosigListParams.safeParse({ recipientDid: 'did:plc:abc' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.limit).toBe(25) // default
  })

  it('rejects missing recipientDid', () => {
    const r = CosigListParams.safeParse({})
    expect(r.success).toBe(false)
  })

  it('rejects non-DID recipient (regex guard)', () => {
    const r = CosigListParams.safeParse({ recipientDid: 'plc:abc' })
    expect(r.success).toBe(false)
  })

  it('accepts the four canonical status values', () => {
    for (const status of ['pending', 'accepted', 'rejected', 'expired']) {
      const r = CosigListParams.safeParse({ recipientDid: 'did:plc:x', status })
      expect(r.success).toBe(true)
    }
  })

  it('rejects unknown status values (closed enum)', () => {
    const r = CosigListParams.safeParse({
      recipientDid: 'did:plc:x',
      status: 'archived',
    })
    expect(r.success).toBe(false)
  })

  it('coerces numeric query-string limit (URL parsing emits strings)', () => {
    const r = CosigListParams.safeParse({
      recipientDid: 'did:plc:x',
      limit: '50',
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.limit).toBe(50)
  })

  it('caps limit at 100', () => {
    const r = CosigListParams.safeParse({
      recipientDid: 'did:plc:x',
      limit: 200,
    })
    expect(r.success).toBe(false)
  })
})

describe('cosigList handler — TN-API-006', () => {
  it('serialises bigint id to string + Dates to ISO strings', async () => {
    // Pinning this contract is the whole point — JSON.stringify rejects
    // bigint with TypeError, so we MUST convert at the boundary.
    const db = stubDb([
      row({
        id: 42n,
        createdAt: new Date('2026-04-29T10:00:00Z'),
        expiresAt: new Date('2026-05-29T12:00:00Z'),
      }),
    ])
    const result = await cosigList(db, {
      recipientDid: 'did:plc:recipient',
      limit: 25,
    })
    expect(result.requests).toHaveLength(1)
    const r = result.requests[0]
    expect(r.id).toBe('42') // string, not bigint
    expect(r.createdAt).toBe('2026-04-29T10:00:00.000Z')
    expect(r.expiresAt).toBe('2026-05-29T12:00:00.000Z')
  })

  it('returns no cursor when fewer rows than limit+1', async () => {
    // Stub returns 3 rows, limit was 25, so handler fetched 26 and
    // got back 3 → no more pages.
    const db = stubDb([row({ id: 1n }), row({ id: 2n }), row({ id: 3n })])
    const result = await cosigList(db, {
      recipientDid: 'did:plc:recipient',
      limit: 25,
    })
    expect(result.requests).toHaveLength(3)
    expect(result.cursor).toBeUndefined()
  })

  it('returns cursor when limit+1 rows came back (more pages)', async () => {
    // limit=2 means handler fetched 3; got back 3 → has more.
    const last = row({
      id: 2n,
      createdAt: new Date('2026-04-29T08:00:00Z'),
    })
    const db = stubDb([
      row({ id: 3n, createdAt: new Date('2026-04-29T10:00:00Z') }),
      last,
      row({ id: 1n, createdAt: new Date('2026-04-29T07:00:00Z') }),
    ])
    const result = await cosigList(db, {
      recipientDid: 'did:plc:recipient',
      limit: 2,
    })
    expect(result.requests).toHaveLength(2)
    // Cursor = createdAt + id of the LAST returned row (page[page.length-1])
    expect(result.cursor).toBe('2026-04-29T08:00:00.000Z::2')
  })

  it('JSON.stringify(result) succeeds (bigint serialisation contract)', async () => {
    // End-to-end check: the dispatcher will JSON.stringify the response.
    // If anything in the response is a bigint, this throws TypeError.
    const db = stubDb([row({ id: 42n })])
    const result = await cosigList(db, {
      recipientDid: 'did:plc:recipient',
      limit: 25,
    })
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  it('throws ZodError-shaped error on malformed cursor (→ 400)', async () => {
    // Dispatcher pattern: `err?.name === 'ZodError'` triggers 400.
    // Any other error → 500. The handler converts cursor parse
    // failures to ZodError so callers see 400 not 500.
    const db = stubDb([])
    await expect(
      cosigList(db, {
        recipientDid: 'did:plc:recipient',
        limit: 25,
        cursor: 'not-a-cursor',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('rejects cursor with malformed bigint id', async () => {
    const db = stubDb([])
    await expect(
      cosigList(db, {
        recipientDid: 'did:plc:recipient',
        limit: 25,
        cursor: '2026-04-29T10:00:00.000Z::not-a-bigint',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('rejects cursor with malformed timestamp', async () => {
    const db = stubDb([])
    await expect(
      cosigList(db, {
        recipientDid: 'did:plc:recipient',
        limit: 25,
        cursor: 'not-a-date::42',
      }),
    ).rejects.toMatchObject({ name: 'ZodError' })
  })

  it('passes a well-formed cursor through to the planner (no throw)', async () => {
    const db = stubDb([])
    await expect(
      cosigList(db, {
        recipientDid: 'did:plc:recipient',
        limit: 25,
        cursor: '2026-04-29T10:00:00.000Z::42',
      }),
    ).resolves.toMatchObject({ requests: [], cursor: undefined })
  })

  it('preserves null endorsementUri and rejectReason in response', async () => {
    // Pending requests have both as null. The response shape must
    // reflect that — clients differentiate "pending" (both null)
    // from "accepted" (endorsementUri set) without needing to look
    // at status separately.
    const db = stubDb([row({ status: 'pending' })])
    const result = await cosigList(db, {
      recipientDid: 'did:plc:recipient',
      limit: 25,
    })
    expect(result.requests[0].endorsementUri).toBeNull()
    expect(result.requests[0].rejectReason).toBeNull()
  })
})
