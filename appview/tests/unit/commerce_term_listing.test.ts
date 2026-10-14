/**
 * SHELF_SPACE_NEGOTIATION §6.1 — term listings in AppView: the gate is the
 * protocol's own validator (closed vocabulary, no money field, digest), the
 * handler indexes only a listing in its SELLER's repo under its own id, and
 * search filters on the projected fields — there is no price to filter on.
 */

import { createHash } from 'node:crypto'

import { sealTermRecord, TERM_LISTING_COLLECTION } from '@dina/commerce-protocol'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { getTermListing, GetTermListingParams, searchTermListings, SearchTermListingsParams } from '@/api/xrpc/commerce-term-listings.js'
import { termListings } from '@/db/schema/index.js'
import { commerceTermListingHandler, readTermListingOp } from '@/ingester/handlers/commerce-term-listing.js'
import { HANDLED_COLLECTIONS } from '@/ingester/handlers/index.js'
import { validateRecord } from '@/ingester/record-validator.js'
import { TRUST_COLLECTIONS } from '@/config/lexicons.js'
import { XRPC_ROUTES } from '@/web/xrpc-routes.js'

import type { HandlerContext, RecordOp } from '@/ingester/handlers/index.js'

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest())
const STORE = 'did:plc:cornerstore000000000000000'

function listing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return sealTermRecord(
    'term_listing',
    {
      protocol_version: '1.0',
      listing_id: 'slot-3',
      seller_did: STORE,
      pack: { plugin_id: 'com.dinakernel.slot', schema_major: 1 },
      resource_ref: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      available: { from: '2027-01-01T00:00:00Z', to: '2027-12-31T00:00:00Z' },
      tags: ['beverages.juice', 'snacks'],
      published_at: '2026-12-01T09:00:00Z',
      ...overrides,
    },
    sha256,
  )
}

function op(record: Record<string, unknown> | undefined, overrides: Partial<RecordOp> = {}): RecordOp {
  return {
    uri: `at://${STORE}/${TERM_LISTING_COLLECTION}/slot-3`,
    did: STORE,
    collection: TERM_LISTING_COLLECTION,
    rkey: 'slot-3',
    cid: 'bafy-listing',
    ...(record !== undefined ? { record } : {}),
    repoRev: '3l2abc',
    ...overrides,
  }
}

describe('the gate and the subscription', () => {
  it('the collection is subscribed and handled', () => {
    expect(TRUST_COLLECTIONS).toContain(TERM_LISTING_COLLECTION)
    expect(HANDLED_COLLECTIONS).toContain(TERM_LISTING_COLLECTION)
  })

  it('admits a listing as the PDS stores it ($type stamped) and returns its own bytes', () => {
    const record = { $type: TERM_LISTING_COLLECTION, ...listing() }
    const result = validateRecord(TERM_LISTING_COLLECTION, record)
    expect(result.success).toBe(true)
    expect(result.data).toBe(record)
  })

  it.each([
    ['a price', { asking_price: { currency: 'INR', minor_units: '150000' } }],
    ['free text', { note: 'cheap rent' }],
  ])('refuses a listing that carries %s — and reports where, never the value', (_label, extra) => {
    const result = validateRecord(TERM_LISTING_COLLECTION, { ...listing(), ...extra })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.errors)).not.toMatch(/150000|cheap/)
  })

  it('refuses a listing edited after its digest was taken', () => {
    expect(validateRecord(TERM_LISTING_COLLECTION, { ...listing(), kind: 'end_cap' }).success).toBe(false)
  })
})

describe('the handler', () => {
  it('indexes only a listing in its seller’s own repo, under its own id', () => {
    expect(readTermListingOp(op(listing()))).toEqual(expect.objectContaining({ ok: true }))
    expect(readTermListingOp(op(listing(), { did: 'did:plc:someoneelse0000000000000' }))).toEqual({
      ok: false,
      reason: 'not_the_sellers_repo',
    })
    expect(readTermListingOp(op(listing(), { rkey: 'slot-9' }))).toEqual({ ok: false, reason: 'rkey_mismatch' })
    expect(readTermListingOp(op(undefined))).toEqual({ ok: false, reason: 'unreadable' })
  })

  function recordingCtx(): { ctx: HandlerContext; writes: { kind: string; values?: unknown; set?: unknown }[]; warned: unknown[] } {
    const writes: { kind: string; values?: unknown; set?: unknown }[] = []
    const warned: unknown[] = []
    const ctx = {
      db: {
        insert: () => ({
          values: (values: unknown) => ({
            onConflictDoUpdate: async (args: { set: unknown }) => {
              writes.push({ kind: 'upsert', values, set: args.set })
            },
          }),
        }),
        delete: () => ({
          where: async () => {
            writes.push({ kind: 'delete' })
          },
        }),
      },
      logger: { warn: (fields: unknown) => warned.push(fields), info: () => undefined, debug: () => undefined, error: () => undefined },
      metrics: { incr: () => undefined },
    } as unknown as HandlerContext
    return { ctx, writes, warned }
  }

  it('a valid listing is upserted with its projection; nothing in the row is money', async () => {
    const { ctx, writes } = recordingCtx()
    await commerceTermListingHandler.handleCreate(ctx, op({ $type: TERM_LISTING_COLLECTION, ...listing() }))
    expect(writes).toHaveLength(1)
    const values = writes[0]!.values as Record<string, unknown>
    expect(values).toEqual(
      expect.objectContaining({
        sellerDid: STORE,
        listingId: 'slot-3',
        packId: 'com.dinakernel.slot',
        schemaMajor: 1,
        kind: 'shelf',
        regionValue: 'IN-560034',
        tags: ['beverages.juice', 'snacks'],
        repoRev: '3l2abc',
      }),
    )
    expect(JSON.stringify(values.recordJson)).not.toContain('$type')
  })

  it('a refused listing writes nothing and logs the reason, never the record', async () => {
    const { ctx, writes, warned } = recordingCtx()
    await commerceTermListingHandler.handleCreate(ctx, op(listing(), { did: 'did:plc:someoneelse0000000000000' }))
    expect(writes).toEqual([])
    expect(JSON.stringify(warned)).not.toContain('IN-560034')
  })

  it('a deletion removes the listing', async () => {
    const { ctx, writes } = recordingCtx()
    await commerceTermListingHandler.handleDelete(ctx, op(undefined))
    expect(writes).toEqual([{ kind: 'delete' }])
  })
})

describe('search', () => {
  // A drizzle instance over a pool that never connects: `.toSQL()` builds the query only.
  const db = drizzle(new pg.Pool({ connectionString: 'postgresql://nobody@127.0.0.1:1/none' }))

  it('params: a region needs both parts; the limit is bounded', () => {
    expect(SearchTermListingsParams.safeParse({ region_scheme: 'country' }).success).toBe(false)
    expect(SearchTermListingsParams.safeParse({ limit: '500' }).success).toBe(false)
    expect(SearchTermListingsParams.parse({ tag: 'beverages.juice' }).limit).toBe(20)
    expect(GetTermListingParams.safeParse({ uri: `at://${STORE}/com.dinakernel.commerce.catalog/x` }).success).toBe(false)
  })

  it('filters on tag, kind, region, a covered window, pack and seller — and orders deterministically', async () => {
    let seen = { sql: '', params: [] as unknown[] }
    const spyDb = {
      select: (fields: unknown) => ({
        from: () => ({
          where: (where: never) => ({
            orderBy: (...order: never[]) => ({
              limit: async (n: number) => {
                const built = db.select(fields as never).from(termListings).where(where).orderBy(...order).limit(n).toSQL()
                seen = { sql: built.sql, params: built.params }
                return [{ uri: 'u', cid: 'c', sellerDid: STORE, recordJson: listing() }]
              },
            }),
          }),
        }),
      }),
    }
    const result = await searchTermListings(spyDb as never, {
      tag: 'beverages.juice',
      kind: 'shelf',
      region_scheme: 'postal_area',
      region_value: 'IN-560034',
      available_from: '2027-02-01T00:00:00Z',
      available_to: '2027-08-01T00:00:00Z',
      pack_id: 'com.dinakernel.slot',
      seller: STORE,
      limit: 10,
    })
    expect(seen.sql).toMatch(/"tags" @> /)
    expect(seen.sql).toMatch(/"available_from" <= /)
    expect(seen.sql).toMatch(/"available_to" >= /)
    expect(seen.sql).toMatch(/order by "term_listings"."indexed_at" desc, "term_listings"."uri"/)
    expect(seen.params).toEqual(
      expect.arrayContaining(['shelf', 'postal_area', 'IN-560034', 'com.dinakernel.slot', STORE, 10]),
    )
    expect(result.listings[0]).toEqual(expect.objectContaining({ uri: 'u', seller_did: STORE }))
  })

  it('both endpoints are routed', () => {
    expect(XRPC_ROUTES['com.dinakernel.commerce.searchTermListings']).toBeDefined()
    expect(XRPC_ROUTES['com.dinakernel.commerce.getTermListing']).toBeDefined()
    expect(typeof getTermListing).toBe('function')
  })
})
