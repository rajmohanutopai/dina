/**
 * SHELF_SPACE_NEGOTIATION §6.1 — term listings against REAL POSTGRES.
 *
 * The unit suite (`tests/unit/commerce_term_listing.test.ts`) drives the
 * handler against a call-recording stub and checks the SQL the search builds;
 * neither proves the SQL runs. This suite runs the real handler and the real
 * queries against the real tables (migration 0030), and reads every answer
 * back from the database.
 *
 *   DATABASE_URL=postgresql://dina:dina@localhost:5432/dina_trust \
 *     npx vitest run tests/integration/commerce_term_listing_ingest.test.ts
 */

import { createHash } from 'node:crypto'

import { sealTermRecord, TERM_LISTING_COLLECTION, validateTermListing } from '@dina/commerce-protocol'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { getTermListing, searchTermListings, SearchTermListingsParams } from '@/api/xrpc/commerce-term-listings.js'
import { commerceTermListingHandler } from '@/ingester/handlers/commerce-term-listing.js'

import { cleanTables, closeTestDb, createTestHandlerContext, getTestDb, type TestDB } from '../test-db'

import type { RecordOp } from '@/ingester/handlers/index.js'

const sha256 = (data: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(data).digest())
const STORE = 'did:plc:cornerstore000000000000000'
const OTHER_STORE = 'did:plc:otherstore00000000000000000'

let db: TestDB
let ctx: ReturnType<typeof createTestHandlerContext>

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

/** A listing as the firehose delivers it: in its seller's repo, `$type` stamped. */
function op(record: Record<string, unknown> | undefined, repoRev: string, did = String(record?.seller_did ?? STORE)): RecordOp {
  const id = String(record?.listing_id ?? 'slot-3')
  return {
    uri: `at://${did}/${TERM_LISTING_COLLECTION}/${id}`,
    did,
    collection: TERM_LISTING_COLLECTION,
    rkey: id,
    cid: `bafy-${id}-${repoRev}`,
    ...(record !== undefined ? { record: { $type: TERM_LISTING_COLLECTION, ...record } } : {}),
    repoRev,
  }
}

async function search(params: Record<string, unknown>): Promise<string[]> {
  const result = await searchTermListings(db as never, SearchTermListingsParams.parse(params))
  return result.listings.map((l) => l.uri)
}

beforeAll(() => {
  db = getTestDb()
  ctx = createTestHandlerContext(db)
})

afterAll(async () => {
  await closeTestDb()
})

beforeEach(async () => {
  await cleanTables(db, 'term_listings')
})

describe('term listings in Postgres', () => {
  it('a listing is indexed, read back whole, and its record still passes the protocol validator', async () => {
    const record = listing()
    await commerceTermListingHandler.handleCreate(ctx as never, op(record, '3l2a'))
    const uri = `at://${STORE}/${TERM_LISTING_COLLECTION}/slot-3`
    const got = await getTermListing(db as never, { uri })
    expect(got.listing).toMatchObject({ uri, seller_did: STORE, cid: 'bafy-slot-3-3l2a' })
    // The brand's node binds its request to these exact bytes by digest.
    const stored = got.listing?.listing as Record<string, unknown>
    const { $type: _type, ...bare } = stored
    expect(validateTermListing(bare, sha256)).toBeNull()
    expect(bare.listing_digest).toBe(record.listing_digest)
  })

  it('the table holds no column a price could live in', async () => {
    const rows = await db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'term_listings'`,
    )
    const columns = (rows.rows as { column_name: string }[]).map((r) => r.column_name)
    expect(columns.length).toBeGreaterThan(5)
    expect(columns.filter((c) => /fee|share|price|rent|floor|asking|minor|amount/.test(c))).toEqual([])
  })

  it('a newer revision replaces the row; an older one replayed later does not', async () => {
    await commerceTermListingHandler.handleCreate(ctx as never, op(listing(), '3l2a'))
    const moved = listing({ available: { from: '2027-03-01T00:00:00Z', to: '2027-12-31T00:00:00Z' } })
    // The consumer delivers an update to handleCreate, which upserts.
    await commerceTermListingHandler.handleCreate(ctx as never, op(moved, '3l2b'))
    await commerceTermListingHandler.handleCreate(ctx as never, op(listing(), '3l2a'))
    const got = await getTermListing(db as never, { uri: `at://${STORE}/${TERM_LISTING_COLLECTION}/slot-3` })
    expect(got.listing?.cid).toBe('bafy-slot-3-3l2b')
    expect((got.listing?.listing as { available: { from: string } }).available.from).toBe('2027-03-01T00:00:00Z')
  })

  it('a deletion removes it from search and from lookup', async () => {
    await commerceTermListingHandler.handleCreate(ctx as never, op(listing(), '3l2a'))
    await commerceTermListingHandler.handleDelete(ctx as never, op(undefined, '3l2b', STORE))
    expect(await search({})).toEqual([])
    expect((await getTermListing(db as never, { uri: `at://${STORE}/${TERM_LISTING_COLLECTION}/slot-3` })).listing).toBeNull()
  })

  it('refused records write nothing: a listing in another repo, an edited one, one with free text in its region', async () => {
    await commerceTermListingHandler.handleCreate(ctx as never, op(listing(), '3l2a', OTHER_STORE))
    await commerceTermListingHandler.handleCreate(ctx as never, op({ ...listing(), kind: 'end_cap' }, '3l2a'))
    await commerceTermListingHandler.handleCreate(
      ctx as never,
      op(listing({ listing_id: 'slot-9', resource_ref: 'slot-9', region: { scheme: 'postal_area', value: 'RENT 1500 ONLY' } }), '3l2a'),
    )
    const count = await db.execute(sql`SELECT count(*)::int AS n FROM term_listings`)
    expect((count.rows[0] as { n: number }).n).toBe(0)
  })

  it('search filters on tag, kind, region, a covered window and seller — in SQL that runs', async () => {
    await commerceTermListingHandler.handleCreate(ctx as never, op(listing(), '1'))
    await commerceTermListingHandler.handleCreate(
      ctx as never,
      op(listing({ listing_id: 'chiller-1', resource_ref: 'chiller-1', kind: 'chiller', tags: ['dairy'] }), '1'),
    )
    await commerceTermListingHandler.handleCreate(
      ctx as never,
      op(
        listing({
          seller_did: OTHER_STORE,
          region: { scheme: 'postal_area', value: 'IN-110001' },
          available: { from: '2027-06-01T00:00:00Z', to: '2027-09-30T00:00:00Z' },
        }),
        '1',
      ),
    )
    const slot3 = `at://${STORE}/${TERM_LISTING_COLLECTION}/slot-3`
    const chiller = `at://${STORE}/${TERM_LISTING_COLLECTION}/chiller-1`
    const other = `at://${OTHER_STORE}/${TERM_LISTING_COLLECTION}/slot-3`

    expect((await search({})).sort()).toEqual([chiller, other, slot3].sort())
    // A tag the listing wants (the GIN-indexed array).
    expect((await search({ tag: 'beverages.juice' })).sort()).toEqual([other, slot3].sort())
    expect(await search({ tag: 'dairy' })).toEqual([chiller])
    expect(await search({ kind: 'chiller' })).toEqual([chiller])
    expect(await search({ region_scheme: 'postal_area', region_value: 'IN-110001' })).toEqual([other])
    // A window the listing must cover entirely: February is not in June–September.
    expect((await search({ available_from: '2027-02-01T00:00:00Z', available_to: '2027-03-01T00:00:00Z' })).sort()).toEqual(
      [chiller, slot3].sort(),
    )
    expect(await search({ seller: OTHER_STORE })).toEqual([other])
    expect(await search({ pack_id: 'com.dinakernel.other' })).toEqual([])
    // The order is deterministic: the same query, the same order.
    expect(await search({})).toEqual(await search({}))
    // A custom region cannot be asked for: no listing can carry one.
    expect(SearchTermListingsParams.safeParse({ region_scheme: 'custom', region_value: 'zone' }).success).toBe(false)
  })
})
