/**
 * §10.5 DISCOVERY, end to end against real Postgres (WS-5.6, WS-11.4).
 *
 * THE CLAIM NO IN-PROCESS TEST CAN MAKE. `WS-11.3` names one gap and only one:
 * every commerce journey starts from a supplier the buyer already knows. What
 * none of them reach is a buyer FINDING a supplier they were never told about,
 * because that needs a running catalog index — a publication reaching the
 * AppView through Jetstream, being projected, and then being searchable by
 * someone with no prior reference to the publisher.
 *
 * This suite is that path, in one process but through the real parts: the two
 * ingest handlers write to real tables, and `searchCommerceCatalog` reads them
 * back with real SQL. The pure matcher has its own unit suite; what is proved
 * here is that the SQL narrowing and the projection agree with it, which is
 * exactly the join a pure test and a stub test each leave to the other.
 *
 * WHY THE NARROWING MATTERS MORE THAN THE SCORING. The narrowing is an
 * optimisation and the matcher is the contract, so a WHERE clause that drifted
 * would silently drop candidates and nothing would fail — the endpoint would
 * simply return fewer suppliers, which reads exactly like a market with fewer
 * suppliers in it.
 *
 * Run against `dina_commerce_test`:
 *   DATABASE_URL=postgresql://dina:dina@localhost:5432/dina_commerce_test \
 *     npx vitest run tests/integration/commerce_catalog_discovery.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { searchCommerceCatalog } from '@/api/xrpc/commerce-catalog-search.js'
import { commerceProductRelationships } from '@/db/schema/index.js'
import { productKey } from '@/shared/commerce/catalog-projection.js'
import {
  commerceCatalogPointerHandler,
  commerceCatalogSnapshotHandler,
} from '@/ingester/handlers/commerce-catalog.js'
import {
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '@/shared/commerce/catalog-verify.js'

import {
  cleanAllTables,
  closeTestDb,
  createTestHandlerContext,
  getTestDb,
  type TestDB,
} from '../test-db'

import type { RecordOp } from '@/ingester/handlers/index.js'

/** Two manufacturers the buyer has never heard of. */
const CHAIRMAKER = 'did:plc:chairmaker99'
const RIVALWOOD = 'did:plc:rivalwood77'

const NOW = '2026-08-08T09:00:00.000Z'

let db: TestDB
let ctx: ReturnType<typeof createTestHandlerContext>

interface ItemSpec {
  sku: string
  name: string
  gtin?: string
  categories?: string[]
  region?: string
  validUntil?: string
}

function item(supplier: string, catalog: string, spec: ItemSpec) {
  return {
    product: { scheme: 'manufacturer_sku', value: spec.sku, issuer_did: supplier },
    // `identifiers`, which is what the projection reads. A fixture naming it
    // anything else indexes no secondary key and the GTIN lookup finds nothing.
    ...(spec.gtin === undefined ? {} : { identifiers: [{ scheme: 'gtin', value: spec.gtin }] }),
    supplier_did: supplier,
    catalog_id: catalog,
    item_revision: '1',
    name: spec.name,
    category_ids: spec.categories ?? ['furniture.seating'],
    // REQUIRED by §9.5 — see the note in `commerce_catalog_ingest.test.ts`.
    pack: { sell_unit: { unit_code: 'each', value: '1' } },
    fulfilment_regions: [{ scheme: 'admin_area', value: spec.region ?? 'IN-KA' }],
    freshness: {
      generated_at: NOW,
      ...(spec.validUntil === undefined ? {} : { valid_until: spec.validUntil }),
    },
  }
}

/** Publish a catalog the way a supplier does: snapshot record, then pointer. */
async function publish(
  supplier: string,
  catalog: string,
  specs: ItemSpec[],
  /** §10.5 (DR-5): which listing serves this catalog. Omitted = not stated. */
  serviceRkey?: string,
  /** Jetstream delivers in either order; both must behave identically. */
  pointerFirst = false,
): Promise<void> {
  const draftPage: CatalogSnapshotPage = {
    catalog_id: catalog,
    snapshot_sequence: 1,
    page_index: 0,
    items: specs.map((s) => item(supplier, catalog, s)),
    page_digest: '',
  }
  const page = { ...draftPage, page_digest: catalogPageDigest(draftPage) }
  const draft: CatalogSnapshot = {
    supplier_did: supplier,
    catalog_id: catalog,
    snapshot_sequence: 1,
    protocol_version: '1.0',
    published_at: NOW,
    page_digests: [page.page_digest],
    item_count: specs.length,
    payload_root: catalogPayloadRoot([page.page_digest]),
    snapshot_digest: '',
  }
  const snapshot: CatalogSnapshot = { ...draft, snapshot_digest: catalogSnapshotDigest(draft) }
  const pointer: CatalogPointer = {
    supplier_did: supplier,
    catalog_id: catalog,
    snapshot_sequence: 1,
    protocol_version: '1.0',
    published_at: NOW,
    snapshot_rkey: snapshot.snapshot_digest,
    snapshot_digest: snapshot.snapshot_digest,
    ...(serviceRkey === undefined ? {} : { service_rkey: serviceRkey }),
  }

  const snapshotOp: RecordOp = {
    uri: `at://${supplier}/com.dinakernel.commerce.catalogSnapshot/${snapshot.snapshot_digest}`,
    did: supplier,
    collection: 'com.dinakernel.commerce.catalogSnapshot',
    rkey: snapshot.snapshot_digest,
    record: { snapshot, pages: [page] } as unknown as Record<string, unknown>,
  }
  const pointerOp: RecordOp = {
    uri: `at://${supplier}/com.dinakernel.commerce.catalog/${catalog}`,
    did: supplier,
    collection: 'com.dinakernel.commerce.catalog',
    rkey: catalog,
    record: pointer as unknown as Record<string, unknown>,
  }
  if (pointerFirst) {
    // The ordering this file calls the interesting one, and the one the DR-5
    // tests did not cover: the pointer parks as `await_snapshot` and its
    // fields have to survive the wait.
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp)
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp)
    return
  }
  await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp)
  await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp)
}

const search = async (
  params: Parameters<typeof searchCommerceCatalog>[1],
  nowIso = NOW,
): Promise<Awaited<ReturnType<typeof searchCommerceCatalog>>> =>
  searchCommerceCatalog(db, params, nowIso)

beforeAll(() => {
  db = getTestDb()
  ctx = createTestHandlerContext(db)
})

beforeEach(async () => {
  await cleanAllTables(db)
})

afterAll(async () => {
  await closeTestDb()
})

describe('a buyer with no prior supplier reference finds one', () => {
  beforeEach(async () => {
    await publish(CHAIRMAKER, 'chairmaker-main', [
      { sku: 'CHAIR-OAK', name: 'Oak dining chair', gtin: '05012345678900' },
      { sku: 'TABLE-OAK', name: 'Oak dining table', categories: ['furniture.tables'] },
    ])
    await publish(RIVALWOOD, 'rivalwood-main', [
      { sku: 'RW-CHAIR-1', name: 'Ash dining chair', region: 'IN-MH' },
    ])
  })

  it('by category, and finds BOTH manufacturers it never named', async () => {
    const found = await search({ category: ['furniture.seating'], limit: 20 })
    const suppliers = found.candidates.map((c) => c.supplier_did).sort()
    expect(suppliers).toEqual([RIVALWOOD, CHAIRMAKER].sort())
  })

  it('by GTIN, and the identifier match outranks everything else', async () => {
    // A GTIN match IS the product — §10.5 weights it above category, text and
    // region combined, and a discovery result that ranked a text hit above an
    // exact identifier would send a buyer to the wrong manufacturer.
    const found = await search({
      identifier: ['gtin:05012345678900'],
      category: ['furniture.seating'],
      limit: 20,
    })
    expect(found.candidates[0]?.supplier_did).toBe(CHAIRMAKER)
    expect(found.candidates[0]?.matched_fields).toContain('identifier')
  })

  it('by free text', async () => {
    const found = await search({ q: 'dining table', limit: 20 })
    expect(found.candidates.map((c) => c.supplier_did)).toEqual([CHAIRMAKER])
  })

  it('by region, and does not offer a supplier who does not deliver there', async () => {
    // `scheme:value`, which is the documented query form and what BOTH the SQL
    // narrowing and the pure matcher compare against. A bare value matches
    // neither — the first version of this test passed one and got a row that
    // matched only on category.
    const found = await search({
      category: ['furniture.seating'],
      region: 'admin_area:IN-MH',
      limit: 20,
    })
    const top = found.candidates[0]
    expect(top?.supplier_did).toBe(RIVALWOOD)
    expect(top?.matched_fields).toContain('region')
  })

  it('narrows to one supplier when the buyer names one', async () => {
    const found = await search({ supplier: RIVALWOOD, category: ['furniture.seating'], limit: 20 })
    expect(found.candidates.map((c) => c.supplier_did)).toEqual([RIVALWOOD])
  })

  it('EVERY candidate says why it matched', async () => {
    // A result nobody can explain is indistinguishable from a paid placement.
    const found = await search({ category: ['furniture.seating'], q: 'chair', limit: 20 })
    expect(found.candidates.length).toBeGreaterThan(0)
    for (const candidate of found.candidates) {
      expect(candidate.matched_fields.length).toBeGreaterThan(0)
      expect(candidate.retrieval_score_bp).toBeGreaterThan(0)
    }
  })

  it('a query with no signal returns nothing rather than the whole index', async () => {
    // The failure mode is a buyer fanning out to every supplier on the network
    // because a UI sent an empty form.
    const found = await search({ limit: 20 })
    expect(found.candidates).toEqual([])
  })
})

describe('freshness and withdrawal are visible to a searcher', () => {
  it('drops an expired row at search time rather than returning it flagged', async () => {
    // §10.4: a discovery result is what a buyer requests a quote against, so
    // offering a row the supplier has already called stale invites exactly the
    // round trip the freshness rule exists to avoid.
    await publish(CHAIRMAKER, 'chairmaker-main', [
      { sku: 'CHAIR-OAK', name: 'Oak dining chair', validUntil: '2026-08-08T08:00:00.000Z' },
      { sku: 'CHAIR-ASH', name: 'Ash dining chair' },
    ])
    const found = await search({ category: ['furniture.seating'], limit: 20 })
    expect(found.candidates.map((c) => c.product.value)).toEqual(['CHAIR-ASH'])
  })

  it('treats a row read exactly AT its valid_until as no longer fresh', async () => {
    // `isFresh` is `validUntil > now`, so the deadline itself is already past.
    // Recorded rather than argued with: "valid until T" excluding T is a
    // defensible reading and it is the one the code and its DoD both state.
    // The direction is the safe one — a stale row dropped costs a buyer one
    // discovery result, a stale row served costs them a quote round trip
    // against terms the supplier has retired.
    await publish(CHAIRMAKER, 'chairmaker-main', [
      { sku: 'CHAIR-OAK', name: 'Oak dining chair', validUntil: NOW },
    ])
    expect((await search({ category: ['furniture.seating'], limit: 20 }, NOW)).candidates).toEqual(
      [],
    )
  })

  it('keeps a row whose validity is still ahead', async () => {
    await publish(CHAIRMAKER, 'chairmaker-main', [
      { sku: 'CHAIR-OAK', name: 'Oak dining chair', validUntil: '2026-08-08T09:00:00.001Z' },
    ])
    expect(
      (await search({ category: ['furniture.seating'], limit: 20 }, NOW)).candidates,
    ).toHaveLength(1)
  })

  it('a row with no valid_until never expires', async () => {
    // The supplier's own claim about it, not an omission to guess at.
    await publish(CHAIRMAKER, 'chairmaker-main', [{ sku: 'CHAIR-OAK', name: 'Oak dining chair' }])
    expect(
      (await search({ category: ['furniture.seating'], limit: 20 }, '2099-01-01T00:00:00.000Z'))
        .candidates,
    ).toHaveLength(1)
  })

  it('a withdrawn catalog disappears from discovery entirely', async () => {
    await publish(CHAIRMAKER, 'chairmaker-main', [{ sku: 'CHAIR-OAK', name: 'Oak dining chair' }])
    expect((await search({ category: ['furniture.seating'], limit: 20 })).candidates).toHaveLength(
      1,
    )

    await commerceCatalogPointerHandler.handleDelete?.(ctx, {
      uri: `at://${CHAIRMAKER}/com.dinakernel.commerce.catalog/chairmaker-main`,
      did: CHAIRMAKER,
      collection: 'com.dinakernel.commerce.catalog',
      rkey: 'chairmaker-main',
      record: {},
    })

    expect((await search({ category: ['furniture.seating'], limit: 20 })).candidates).toEqual([])
  })
})

describe('the result is bounded', () => {
  it('honours the caller’s limit', async () => {
    await publish(
      CHAIRMAKER,
      'chairmaker-main',
      Array.from({ length: 12 }, (_, i) => ({
        sku: `CHAIR-${String(i)}`,
        name: `Chair ${String(i)}`,
      })),
    )
    const found = await search({ category: ['furniture.seating'], limit: 5 })
    expect(found.candidates).toHaveLength(5)
  })
})

/**
 * §10.5 (DR-5) — WHERE a buyer sends the quote request.
 *
 * `service_uri` and `service_rkey` were hardcoded to `self` on every
 * candidate. On a supplier with one listing that is right by accident. §10's
 * model is rkey-keyed listings, and there was no way for a supplier to say
 * which one serves a catalog — so every buyer was pointed at the primary.
 *
 * These drive the real ingest and the real query, because the defect was a
 * value that never left the projection function: a unit test on `toCandidate`
 * would have asserted whatever the constant was.
 */
describe('the listing a catalog is served from', () => {
  it('answers the listing the supplier named on the pointer', async () => {
    const supplier = 'did:plc:multilisting01'
    await publish(supplier, 'chairs-catalog', [{ sku: 'MC-1', name: 'Teak stool' }], 'chairs')

    const out = await search({ q: 'teak stool', limit: 5 })
    const found = out.candidates.find((c) => c.supplier_did === supplier)

    expect(found?.service_rkey).toBe('chairs')
    expect(found?.service_uri).toBe(`at://${supplier}/com.dinakernel.service.profile/chairs`)
  })

  it('falls back to `self` when the supplier did not say', async () => {
    // The documented convention for a node's PRIMARY listing. Used because
    // nothing better is known, which is different from asserting it.
    const supplier = 'did:plc:singlelisting1'
    await publish(supplier, 'only-catalog', [{ sku: 'SL-1', name: 'Rosewood bench' }])

    const out = await search({ q: 'rosewood bench', limit: 5 })
    const found = out.candidates.find((c) => c.supplier_did === supplier)

    expect(found?.service_rkey).toBe('self')
  })

  it('keeps two catalogs from ONE supplier on their own listings', async () => {
    // The case the hardcoded value could not express at all, and the reason
    // this is a defect rather than a tidy-up.
    const supplier = 'did:plc:twocatalogs01'
    await publish(supplier, 'seating', [{ sku: 'TC-1', name: 'Walnut armchair' }], 'seating')
    await publish(supplier, 'tables', [{ sku: 'TC-2', name: 'Walnut sidetable' }], 'tables')

    const out = await search({ q: 'walnut', limit: 10 })
    const byRkey = new Map(
      out.candidates
        .filter((c) => c.supplier_did === supplier)
        .map((c) => [c.product.value, c.service_rkey]),
    )

    expect(byRkey.get('TC-1')).toBe('seating')
    expect(byRkey.get('TC-2')).toBe('tables')
  })

  it('refuses a pointer whose listing rkey would splice the AT-URI', async () => {
    // The buyer's `parseAtUri` refuses a separator inside a segment, so an
    // unchecked rkey would make the supplier's own products unusable with no
    // explanation. Refusing the publication says why.
    const supplier = 'did:plc:badrkey000001'
    await publish(supplier, 'bad-catalog', [{ sku: 'BR-1', name: 'Ebony cabinet' }], 'a/b')

    const out = await search({ q: 'ebony cabinet', limit: 5 })

    expect(out.candidates.filter((c) => c.supplier_did === supplier)).toEqual([])
  })
})

/**
 * §10.5 (NEW-2) — the listing must survive the wait for a snapshot.
 *
 * The `await_snapshot` write persisted `service_rkey`, and the rebuild of that
 * held pointer when the snapshot later arrived dropped it. So the whole DR-5
 * read path worked on one Jetstream delivery order and silently failed on the
 * other, answering a plausible `self` rather than an error. My DR-5 tests
 * published snapshot-first only, which is why they passed over the hole.
 */
describe('either delivery order gives the same answer', () => {
  it('keeps the listing when the POINTER arrives before its snapshot', async () => {
    const supplier = 'did:plc:pointerfirst01'
    await publish(
      supplier,
      'pf-catalog',
      [{ sku: 'PF-1', name: 'Cedar wardrobe' }],
      'wardrobes',
      true,
    )

    const out = await search({ q: 'cedar wardrobe', limit: 5 })
    const found = out.candidates.find((c) => c.supplier_did === supplier)

    expect(found?.service_rkey).toBe('wardrobes')
    expect(found?.service_uri).toBe(`at://${supplier}/com.dinakernel.service.profile/wardrobes`)
  })

  it('still falls back to `self` pointer-first when the supplier said nothing', async () => {
    const supplier = 'did:plc:pointerfirst02'
    await publish(supplier, 'pf2-catalog', [{ sku: 'PF-2', name: 'Cedar bookcase' }], undefined, true)

    const out = await search({ q: 'cedar bookcase', limit: 5 })
    expect(out.candidates.find((c) => c.supplier_did === supplier)?.service_rkey).toBe('self')
  })
})

describe('the SQL candidate set, not just the matcher', () => {
  /**
   * §10.7 RECALL EXPANSION, through the real endpoint.
   *
   * The related-product lookup ran AFTER the SQL predicate was closed, so a
   * product reachable only along an edge was never fetched and the matcher
   * never saw it. Every pure-matcher test passed, because those hand the
   * matcher the row directly — the row that production never loads.
   */
  it('returns a product reachable ONLY through a relationship edge', async () => {
    const queried = { scheme: 'gtin' as const, value: '05012345678900' }
    // The buyer's GTIN belongs to a product nobody published…
    await publish(CHAIRMAKER, 'chairmaker-main', [
      { sku: 'CHAIR-SUCCESSOR', name: 'Oak dining chair 2026' },
    ])
    const successorKey = productKey({
      scheme: 'manufacturer_sku',
      value: 'CHAIR-SUCCESSOR',
      issuer_did: CHAIRMAKER,
    } as never)

    // …but an edge says the queried GTIN is superseded by the published one.
    await db.insert(commerceProductRelationships).values({
      edgeKey: `${productKey(queried as never)}|variant_of|${successorKey}`,
      subjectKey: productKey(queried as never),
      relationship: 'variant_of',
      objectKey: successorKey,
      confidenceBp: 9000,
      disputed: false,
      evidenceJson: [{ claimId: 'rc-1', issuerDid: CHAIRMAKER, confidenceBp: 9000 }],
    })

    const found = await search({ identifier: ['gtin:05012345678900'], limit: 20 })
    expect(found.candidates.map((c) => c.product.value)).toContain('CHAIR-SUCCESSOR')
  })

  /**
   * The cap used to be applied to an UNORDERED result, so PostgreSQL was free
   * to return any `limit * 4` matching rows — and could drop the one EXACT
   * IDENTIFIER match while keeping lower-value category hits, contradicting
   * the documented SQL-superset guarantee and the 6000bp weight the scorer
   * gives an identifier.
   */
  it('keeps an exact identifier match when far more rows match broadly', async () => {
    const limit = 3
    // 4*limit = 12 rows the broad predicate matches …
    await publish(
      CHAIRMAKER,
      'chairmaker-main',
      Array.from({ length: 20 }, (_, i) => ({
        sku: `BULK-${String(i).padStart(2, '0')}`,
        name: `Oak dining chair ${i}`,
      })),
    )
    // … plus ONE row carrying the identifier the buyer actually holds.
    await publish(RIVALWOOD, 'rivalwood-main', [
      { sku: 'EXACT-1', name: 'Oak dining chair', gtin: '05012345678917' },
    ])

    const found = await search({
      category: ['furniture.seating'],
      identifier: ['gtin:05012345678917'],
      limit,
    })
    expect(found.candidates.map((c) => c.product.value)).toContain('EXACT-1')
  })
})
