/**
 * §25.3 / §10.5 — a retailer finds a manufacturer it was never told about.
 *
 * WHAT THIS CLOSES, and it is the gap WBS 11.3 states in its own words: every
 * other commerce journey "starts from a supplier the buyer already names".
 * Discovery is the one step no in-process journey can reach, because it needs
 * a manufacturer's records to arrive at an index the buyer queries.
 *
 * AND WHAT IT FIXES ABOUT THE EXISTING DISCOVERY SUITE. That suite builds its
 * catalog records with AppView's OWN `catalogPageDigest` and
 * `catalogSnapshotDigest`, then asserts AppView accepts them — both sides of
 * the check are AppView's. If those functions drifted from Core's, discovery
 * would stay green while no real supplier's catalog could be indexed. Here the
 * records come from CORE's publisher, byte for byte, via a fixture Core's own
 * test regenerates and compares. AppView takes no `@dina/*` dependency (it
 * deploys independently, which is exactly why it keeps its own copy of
 * `CatalogPointer`), so the two halves are joined by the bytes — which is what
 * the contract is.
 *
 * IT ALREADY EARNED ITS PLACE. Its first run refused ChairMaker's catalog at
 * Core's own §12.1 publication gate: the leakage vocabulary had been written
 * from the spec's prose (`category`, `regions`, `list_price`) while the wire
 * type says `category_ids`, `fulfilment_regions`, `indicative_price`. Two
 * self-consistent vocabularies that had never met, so a supplier publishing a
 * REAL `CatalogItem` could not publish at all. Neither side's tests could see
 * it — Core's used a flat CSV shape, AppView's hand-built items and skipped
 * Core.
 *
 * NOT A PDS, and the boundary is stated rather than blurred. A PDS is the
 * transport that carries these records between two nodes; what it delivers is
 * these bytes, and those are what both sides are checked against here. The
 * "two real Dinas over a live PDS" step stays open.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { searchCommerceCatalog } from '@/api/xrpc/commerce-catalog-search.js'
import {
  commerceCatalogPointerHandler,
  commerceCatalogSnapshotHandler,
} from '@/ingester/handlers/commerce-catalog.js'
import {
  verifyCatalogPublication,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '@/shared/commerce/catalog-verify.js'

import { cleanAllTables, createTestHandlerContext, getTestDb, type TestDB } from '../test-db.js'

import type { RecordOp } from '@/ingester/handlers/index.js'

/**
 * Core's publication, as Core emitted it.
 *
 * Read by PATH and not imported: an import would create the dependency edge
 * AppView deliberately does not have. This is the same relationship a
 * conformance vector has to the implementations it pins.
 */
const PUBLICATION = JSON.parse(
  readFileSync(
    path.join(
      __dirname,
      '..',
      '..',
      '..',
      'packages',
      'commerce-protocol',
      'conformance',
      'interop',
      'catalog_publication.json',
    ),
    'utf8',
  ),
) as { pointer: CatalogPointer; snapshot: CatalogSnapshot; pages: CatalogSnapshotPage[] }

const MANUFACTURER = 'did:plc:chairmaker99'
const NOW = '2026-08-08T12:00:00.000Z'

let db: TestDB
let ctx: ReturnType<typeof createTestHandlerContext>

/** Deliver Core's records the way Jetstream would. */
async function deliver(pointerFirst = false): Promise<void> {
  const snapshotOp: RecordOp = {
    uri: `at://${MANUFACTURER}/com.dinakernel.commerce.catalogSnapshot/${PUBLICATION.snapshot.snapshot_digest}`,
    did: MANUFACTURER,
    collection: 'com.dinakernel.commerce.catalogSnapshot',
    rkey: PUBLICATION.snapshot.snapshot_digest,
    record: { snapshot: PUBLICATION.snapshot, pages: PUBLICATION.pages } as unknown as Record<
      string,
      unknown
    >,
  }
  const pointerOp: RecordOp = {
    uri: `at://${MANUFACTURER}/com.dinakernel.commerce.catalog/${PUBLICATION.pointer.catalog_id}`,
    did: MANUFACTURER,
    collection: 'com.dinakernel.commerce.catalog',
    rkey: PUBLICATION.pointer.catalog_id,
    record: PUBLICATION.pointer as unknown as Record<string, unknown>,
  }
  if (pointerFirst) {
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp)
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp)
    return
  }
  await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp)
  await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp)
}

const search = (params: Parameters<typeof searchCommerceCatalog>[1]) =>
  searchCommerceCatalog(db, params, NOW)

beforeAll(() => {
  db = getTestDb()
  ctx = createTestHandlerContext(db)
})

beforeEach(async () => {
  await cleanAllTables(db)
})

describe("AppView's verifier accepts Core's digests", () => {
  it('verifies the publication Core produced, with no record built here', () => {
    // THE JOIN, asserted before anything downstream depends on it. Both digest
    // implementations are independent code in independently deployed packages;
    // this is the one place they meet.
    expect(
      verifyCatalogPublication({
        previous: null,
        pointer: PUBLICATION.pointer,
        snapshot: PUBLICATION.snapshot,
        pages: PUBLICATION.pages,
      }),
    ).toBeNull()
  })

  it('carries the listing Core published, so §10.5 has a producer', () => {
    expect(PUBLICATION.pointer.service_rkey).toBe('seating')
  })
})

describe('Sancho finds ChairMaker without being told about them', () => {
  it('by category — the retailer names a need, not a supplier', async () => {
    await deliver()

    const out = await search({ category: ['furniture.seating'], limit: 10 })
    const suppliers = new Set(out.candidates.map((c) => c.supplier_did))

    expect(suppliers.has(MANUFACTURER)).toBe(true)
    expect(out.candidates.length).toBeGreaterThanOrEqual(2)
  })

  it('by free text', async () => {
    await deliver()

    const out = await search({ q: 'oak dining chair', limit: 10 })

    expect(out.candidates[0]?.supplier_did).toBe(MANUFACTURER)
    expect(out.candidates[0]?.product.value).toBe('5901234123457')
  })

  it('by a GTIN the retailer read off a physical product', async () => {
    // The strongest discovery case: a shop has the item in hand and nothing
    // else. An identifier match is what turns that into a supplier.
    await deliver()

    const out = await search({ identifier: ['gtin:712345678904'], limit: 10 })

    expect(out.candidates).toHaveLength(1)
    expect(out.candidates[0]?.supplier_did).toBe(MANUFACTURER)
    expect(out.candidates[0]?.matched_fields).toContain('identifier')
  })

  it('by a SECONDARY identifier the manufacturer also publishes', async () => {
    // `CHAIR2024B` is the manufacturer's own SKU, and it is also the shape the
    // §12.1 scan reads as an Indian tax ID — it publishes only because that
    // collision was measured and excluded. A discovery test that used a tamer
    // SKU would not notice the day that exclusion is reverted.
    await deliver()

    // WITH THE ISSUER, and that is the rule rather than a fixture detail: a
    // `manufacturer_sku` is ambiguous without one, because two manufacturers
    // may both call something CHAIR2024B. `parseIdentifierParam` refuses a
    // scoped scheme with no issuer, and the projection refuses to index one —
    // the same `unattributed_identifier` rule on both sides. My first version
    // of this passed the bare `scheme:value` and silently found nothing.
    const out = await search({
      identifier: [`manufacturer_sku:CHAIR2024B:${MANUFACTURER}`],
      limit: 10,
    })

    expect(out.candidates[0]?.supplier_did).toBe(MANUFACTURER)
    expect(out.candidates[0]?.matched_fields).toContain('identifier')
  })

  it('finds nothing for a scoped identifier given WITHOUT its issuer', async () => {
    // Behaviour, not a trap for the next reader. Answering a bare
    // `manufacturer_sku` would mean answering about a product this
    // manufacturer may not be the issuer of — which is the ambiguity the
    // `unattributed_identifier` rule exists for. A refusal that returns
    // nothing is right; a refusal nobody asserted is how the rule gets
    // loosened later by someone who thinks the search is simply broken.
    await deliver()

    const bare = await search({ identifier: ['manufacturer_sku:CHAIR2024B'], limit: 10 })
    expect(bare.candidates).toEqual([])

    const scoped = await search({
      identifier: [`manufacturer_sku:CHAIR2024B:${MANUFACTURER}`],
      limit: 10,
    })
    expect(scoped.candidates).toHaveLength(1)
  })

  it('says which candidates deliver to the retailer, and does not pretend the rest do', async () => {
    // §10.5 is RECALL, not the buyer's ranking: the narrowing is an OR across
    // the signals supplied and the matcher scores what survives, so a region
    // the manufacturer does not serve does not remove a category match — it
    // removes the region SIGNAL from it. My first version asserted an empty
    // result and was wrong about the contract, not about the data.
    await deliver()

    const unserved = await search({ category: ['furniture.seating'], region: 'admin_area:IN-KL', limit: 10 })
    expect(unserved.candidates.every((c) => !c.matched_fields.includes('region'))).toBe(true)

    const served = await search({ category: ['furniture.seating'], region: 'admin_area:IN-KA', limit: 10 })
    expect(served.candidates.some((c) => c.matched_fields.includes('region'))).toBe(true)
  })

  it('ranks a manufacturer who delivers there ABOVE one who does not', async () => {
    // The stool ships to IN-KA and IN-TN, the chair only to IN-KA. A retailer
    // in Tamil Nadu should see the stool first, and that ordering is the whole
    // value of region being a signal rather than a filter.
    await deliver()

    const out = await search({ category: ['furniture.seating'], region: 'admin_area:IN-TN', limit: 10 })

    expect(out.candidates[0]?.product.value).toBe('712345678904')
  })
})

describe('what the retailer learns is enough to go and ask', () => {
  it('names the listing to send the quote request to, from the pointer Core signed', async () => {
    // The whole §10.5 chain in one assertion: Core's publisher set it, the
    // ingest carried it, the projection stored it, discovery answers it. Every
    // link was broken at some point in this review and each break was
    // invisible from the link on either side of it.
    await deliver()

    const out = await search({ q: 'oak dining chair', limit: 5 })
    const found = out.candidates[0]

    expect(found?.service_rkey).toBe('seating')
    expect(found?.service_uri).toBe(
      `at://${MANUFACTURER}/com.dinakernel.service.profile/seating`,
    )
  })

  it('gives the same answer whichever order the two records arrive in', async () => {
    await deliver(true)

    const out = await search({ q: 'oak dining chair', limit: 5 })

    expect(out.candidates[0]?.service_rkey).toBe('seating')
    expect(out.candidates[0]?.supplier_did).toBe(MANUFACTURER)
  })

  it('carries the snapshot the answer came from, so the retailer can verify live', async () => {
    // §10.6: a candidate has to say where it came from. This one says it came
    // from the exact snapshot Core signed.
    await deliver()

    const out = await search({ q: 'teak bar stool', limit: 5 })

    expect(out.candidates[0]?.catalog_snapshot_ref).toBe(PUBLICATION.snapshot.snapshot_digest)
  })

  it('offers an indicative price and never presents it as a term', async () => {
    // §10.4. The chair has one and the stool does not; both are legitimate
    // states and a buyer must be able to tell them apart.
    await deliver()

    const out = await search({ category: ['furniture.seating'], limit: 10 })
    const chair = out.candidates.find((c) => c.product.value === '5901234123457')
    const stool = out.candidates.find((c) => c.product.value === '712345678904')

    expect(chair?.indicative_price).toEqual({ currency: 'INR', minor_units: '450000' })
    expect(stool?.indicative_price).toBeUndefined()
  })
})
