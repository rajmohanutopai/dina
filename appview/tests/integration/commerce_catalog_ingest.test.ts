/**
 * §10.2 catalog ingest, against REAL POSTGRES (WS-5.4, FR-A1/A2/A6).
 *
 * WHY THIS EXISTS. `tests/unit/commerce_catalog_handler.test.ts` drives the
 * same two handlers against a call-recording stub, and says so in its own
 * header: it proves the ORDER of operations, not that the SQL is valid. Those
 * are different claims and only one of them can be made without a database.
 * A `delete` the stub records as `delete:products` might be missing a WHERE
 * clause, might name a column the schema does not have, might violate a
 * constraint on the way back in — and every one of those passes a stub and
 * fails in production, where the symptom is a supplier's catalog either
 * vanishing or refusing to update.
 *
 * So this suite runs the real handlers, in real transactions, against the real
 * tables, and then READS THE ROWS BACK. Nothing is asserted from a recorded
 * call; every assertion is a query.
 *
 * Run against `dina_commerce_test`:
 *   DATABASE_URL=postgresql://dina:dina@localhost:5432/dina_commerce_test \
 *     npx vitest run tests/integration/commerce_catalog_ingest.test.ts
 */

import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  commerceCatalogPointerHandler,
  commerceCatalogSnapshotHandler,
} from '@/ingester/handlers/commerce-catalog.js'
import {
  commerceCatalogPointers,
  commerceCatalogProducts,
  commerceCatalogSnapshots,
} from '@/db/schema/index.js'
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

const SUPPLIER = 'did:plc:chairmaker99'
const CATALOG = 'chairmaker-main'
const POINTER_COLLECTION = 'com.dinakernel.commerce.catalog'
const SNAPSHOT_COLLECTION = 'com.dinakernel.commerce.catalogSnapshot'

let db: TestDB
let ctx: ReturnType<typeof createTestHandlerContext>

function catalogItem(sku: string) {
  return {
    product: { scheme: 'manufacturer_sku', value: sku, issuer_did: SUPPLIER },
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    item_revision: '1',
    name: `Chair ${sku}`,
    category_ids: ['furniture.seating'],
    fulfilment_regions: [{ scheme: 'admin_area', value: 'IN-KA' }],
    freshness: { generated_at: '2026-08-08T09:00:00.000Z' },
  }
}

/**
 * A real publication, built by the REAL digest functions.
 *
 * A hand-rolled digest would test the guess rather than the contract — every
 * validator on both sides re-derives these, so a fixture that invents them is
 * refused before it proves anything.
 */
function publication(sequence: number, skus: string[], previousDigest?: string) {
  const draftPage: CatalogSnapshotPage = {
    catalog_id: CATALOG,
    snapshot_sequence: sequence,
    page_index: 0,
    items: skus.map(catalogItem),
    page_digest: '',
  }
  const page = { ...draftPage, page_digest: catalogPageDigest(draftPage) }
  const draft: CatalogSnapshot = {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    snapshot_sequence: sequence,
    protocol_version: '1.0',
    published_at: '2026-08-08T09:00:00.000Z',
    page_digests: [page.page_digest],
    item_count: skus.length,
    payload_root: catalogPayloadRoot([page.page_digest]),
    snapshot_digest: '',
  }
  const snapshot: CatalogSnapshot = { ...draft, snapshot_digest: catalogSnapshotDigest(draft) }
  const pointer: CatalogPointer = {
    supplier_did: SUPPLIER,
    catalog_id: CATALOG,
    snapshot_sequence: sequence,
    protocol_version: '1.0',
    published_at: '2026-08-08T09:00:00.000Z',
    snapshot_rkey: snapshot.snapshot_digest,
    snapshot_digest: snapshot.snapshot_digest,
    ...(previousDigest === undefined ? {} : { previous_snapshot_digest: previousDigest }),
  }
  return { pointer, snapshot, page }
}

function pointerOp(pointer: CatalogPointer): RecordOp {
  return {
    uri: `at://${SUPPLIER}/${POINTER_COLLECTION}/self`,
    did: SUPPLIER,
    collection: POINTER_COLLECTION,
    rkey: 'self',
    record: pointer as unknown as Record<string, unknown>,
  }
}

function snapshotOp(snapshot: CatalogSnapshot, page: CatalogSnapshotPage): RecordOp {
  return {
    uri: `at://${SUPPLIER}/${SNAPSHOT_COLLECTION}/${snapshot.snapshot_digest}`,
    did: SUPPLIER,
    collection: SNAPSHOT_COLLECTION,
    rkey: snapshot.snapshot_digest,
    // The record NESTS the snapshot; it does not spread it. A fixture that
    // spread it is refused before anything is stored, which is what the first
    // run of this suite looked like.
    record: { snapshot, pages: [page] } as unknown as Record<string, unknown>,
  }
}

/** Every indexed product for this catalog, read back from the table. */
async function indexedSkus(): Promise<string[]> {
  const rows = await db
    .select()
    .from(commerceCatalogProducts)
    .where(
      and(
        eq(commerceCatalogProducts.supplierDid, SUPPLIER),
        eq(commerceCatalogProducts.catalogId, CATALOG),
      ),
    )
  return rows.map((r) => String(r.name)).sort()
}

async function pointerRow() {
  const rows = await db
    .select()
    .from(commerceCatalogPointers)
    .where(
      and(
        eq(commerceCatalogPointers.supplierDid, SUPPLIER),
        eq(commerceCatalogPointers.catalogId, CATALOG),
      ),
    )
    .limit(1)
  return rows[0]
}

async function snapshotRows() {
  return db.select().from(commerceCatalogSnapshots)
}

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

describe('both Jetstream delivery orders reach the same index', () => {
  it('snapshot first, then pointer', async () => {
    const { pointer, snapshot, page } = publication(1, ['CHAIR-1', 'CHAIR-2'])

    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(snapshot, page))
    // Evidence only. A snapshot no pointer names must NOT be searchable —
    // indexing it is how a withdrawn catalog comes back to life.
    expect(await indexedSkus()).toEqual([])
    expect((await snapshotRows()).length).toBe(1)

    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(pointer))
    expect(await indexedSkus()).toEqual(['Chair CHAIR-1', 'Chair CHAIR-2'])

    const row = await pointerRow()
    expect(row?.snapshotDigest).toBe(snapshot.snapshot_digest)
    expect(row?.awaitingSnapshot).toBe(false)
    expect(row?.withdrawn).toBe(false)
  })

  it('pointer first, then snapshot — the pointer waits rather than indexing nothing', async () => {
    const { pointer, snapshot, page } = publication(1, ['CHAIR-1', 'CHAIR-2'])

    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(pointer))
    // Held. A pointer whose snapshot has not arrived names a catalog this
    // index cannot serve, and serving an empty one would read as "this
    // supplier stocks nothing".
    expect(await indexedSkus()).toEqual([])
    expect((await pointerRow())?.awaitingSnapshot).toBe(true)

    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(snapshot, page))
    expect(await indexedSkus()).toEqual(['Chair CHAIR-1', 'Chair CHAIR-2'])
    expect((await pointerRow())?.awaitingSnapshot).toBe(false)
  })
})

describe('§10.2 full-state replacement', () => {
  it('a later snapshot REPLACES the catalog rather than adding to it', async () => {
    const first = publication(1, ['CHAIR-1', 'CHAIR-2'])
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(first.snapshot, first.page))
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(first.pointer))
    expect(await indexedSkus()).toEqual(['Chair CHAIR-1', 'Chair CHAIR-2'])

    // CHAIR-2 is discontinued and CHAIR-3 is new. A snapshot is full state, so
    // the absent one must disappear — an ingest that only upserted would leave
    // a discontinued product searchable for ever.
    const second = publication(2, ['CHAIR-1', 'CHAIR-3'], first.snapshot.snapshot_digest)
    await commerceCatalogSnapshotHandler.handleCreate?.(
      ctx,
      snapshotOp(second.snapshot, second.page),
    )
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(second.pointer))

    expect(await indexedSkus()).toEqual(['Chair CHAIR-1', 'Chair CHAIR-3'])
    expect((await pointerRow())?.snapshotDigest).toBe(second.snapshot.snapshot_digest)
  })

  it('refuses a replayed OLDER pointer and leaves the live catalog alone', async () => {
    const first = publication(1, ['CHAIR-1'])
    const second = publication(2, ['CHAIR-9'], first.snapshot.snapshot_digest)
    for (const p of [first, second]) {
      await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(p.snapshot, p.page))
      await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(p.pointer))
    }
    expect(await indexedSkus()).toEqual(['Chair CHAIR-9'])

    // Sequence 1 arrives again — a replay, or a stale relay. Accepting it
    // would roll a supplier's catalog backwards to a state they have retired.
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(first.pointer))
    expect(await indexedSkus()).toEqual(['Chair CHAIR-9'])
    expect((await pointerRow())?.snapshotDigest).toBe(second.snapshot.snapshot_digest)
  })
})

describe('withdrawal (FR-A6)', () => {
  it('deletes every product and KEEPS the pointer row as a tombstone', async () => {
    const { pointer, snapshot, page } = publication(1, ['CHAIR-1', 'CHAIR-2'])
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(snapshot, page))
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(pointer))
    expect(await indexedSkus()).toHaveLength(2)

    await commerceCatalogPointerHandler.handleDelete?.(ctx, pointerOp(pointer))

    expect(await indexedSkus()).toEqual([])
    const row = await pointerRow()
    // THE ROW STAYS. It is what refuses a silent relaunch under the same
    // catalog_id — deleting it would let a withdrawn catalog reappear as a
    // first sighting, which is the one thing a buyer must be able to notice.
    expect(row).toBeDefined()
    expect(row?.withdrawn).toBe(true)
    expect(row?.snapshotDigest).toBeNull()
  })

  it('a withdrawn catalog does not come back when its old snapshot is re-delivered', async () => {
    const { pointer, snapshot, page } = publication(1, ['CHAIR-1'])
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(snapshot, page))
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(pointer))
    await commerceCatalogPointerHandler.handleDelete?.(ctx, pointerOp(pointer))
    expect(await indexedSkus()).toEqual([])

    // The relay re-delivers the snapshot record. No pointer names it now, so
    // it is evidence and nothing more.
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(snapshot, page))
    expect(await indexedSkus()).toEqual([])
    expect((await pointerRow())?.withdrawn).toBe(true)
  })
})

describe('the SQL itself', () => {
  it('a re-delivered snapshot record does not duplicate the evidence row', async () => {
    // Content-addressed by digest, so the second delivery is the same row.
    // A missing conflict clause would raise a unique violation here and pass
    // against a stub that only records the call.
    const { snapshot, page } = publication(1, ['CHAIR-1'])
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(snapshot, page))
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(snapshot, page))
    expect((await snapshotRows()).length).toBe(1)
  })

  it('a re-delivered pointer record does not duplicate the authority row', async () => {
    const { pointer, snapshot, page } = publication(1, ['CHAIR-1'])
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(snapshot, page))
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(pointer))
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(pointer))

    const rows = await db
      .select()
      .from(commerceCatalogPointers)
      .where(eq(commerceCatalogPointers.supplierDid, SUPPLIER))
    expect(rows.length).toBe(1)
    // And the products were not duplicated by the second application either.
    expect(await indexedSkus()).toEqual(['Chair CHAIR-1'])
  })
})
