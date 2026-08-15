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
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
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
    // REQUIRED by §9.5. Omitting it made every item here one no conformant
    // supplier could publish, so the handler refused the lot and this suite
    // asserted against an empty index. It passed nothing; it had never run.
    pack: { sell_unit: { unit_code: 'each', value: '1' } },
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

  /**
   * THE READ-DECIDE-WRITE IS SERIALIZED PER CATALOG, and this proves the lock
   * is really taken rather than that the code reads as if it were.
   *
   * The decision reads the current pointer and the held snapshot; `apply` then
   * writes. Those were separate transactions while the ingestion queue runs up
   * to `DATABASE_POOL_MAX` events concurrently, so a pointer could observe no
   * snapshot at the same moment the snapshot observed no pending pointer — and
   * both commit, leaving the pointer waiting for a snapshot that had already
   * arrived. The catalog then stays invisible until the supplier republishes.
   *
   * A CONCURRENCY TEST WITHOUT A RACE. Interleaving two handlers reliably is
   * not something a test can promise; holding the lock they must wait on is.
   * This takes the catalog's advisory lock on a separate connection, gives the
   * handler a short `statement_timeout`, and asserts it CANNOT proceed —
   * then releases and asserts it can. Without the lock in the handler the
   * first half passes anyway, which is exactly what makes it a real check.
   */
  it('waits for the catalog lock rather than reading around it', async () => {
    const { pointer, snapshot, page } = publication(1, ['CHAIR-1'])
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(snapshot, page))

    const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    try {
      await blocker.query('BEGIN')
      // The SAME key the handler locks: `supplier/catalog`.
      await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${SUPPLIER}/${CATALOG}`])

      // The handler must now be unable to start its work. A short timeout
      // turns "waits for ever" into a fast, deterministic failure.
      const timed = new pg.Pool({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        statement_timeout: 1500,
      })
      const timedCtx = createTestHandlerContext(drizzle(timed))
      let blocked = false
      try {
        await commerceCatalogPointerHandler.handleCreate?.(timedCtx, pointerOp(pointer))
      } catch {
        blocked = true
      }
      await timed.end()
      expect(blocked).toBe(true)

      // Nothing was written while it waited.
      expect(await indexedSkus()).toEqual([])
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }

    // Lock released: the same event now completes and indexes the catalog.
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(pointer))
    expect(await indexedSkus()).toEqual(['Chair CHAIR-1'])
  })

  /**
   * A STRANGER CANNOT PARK ON A DIGEST THIS SUPPLIER IS ABOUT TO PUBLISH.
   *
   * A pointer carrying `snapshot_digest` is public on the firehose before its
   * snapshot record lands, and any repo may publish a pointer naming any
   * digest — the ingest gate only requires the pointer's `supplier_did` to be
   * the publishing repo. Pending rows from every repo share one table, so a
   * lookup keyed on the DIGEST ALONE, `LIMIT 1`, no ordering, could return the
   * bystander's row. Promotion then ran the genuine snapshot against the
   * stranger's pointer, refused it on the repo check, and left the real
   * supplier's own pending pointer unpromoted: their catalog stayed unindexed
   * until they republished under a new digest (§20.1, from a stranger).
   */
  it('promotes THIS supplier\'s pending pointer when another repo parked on the digest', async () => {
    const { pointer, snapshot, page } = publication(1, ['CHAIR-1'])

    // The bystander announces first, naming a digest it merely read.
    const intruderDid = 'did:plc:bystander404'
    const intruderPointer = { ...pointer, supplier_did: intruderDid }
    await commerceCatalogPointerHandler.handleCreate?.(ctx, {
      uri: `at://${intruderDid}/${POINTER_COLLECTION}/self`,
      did: intruderDid,
      collection: POINTER_COLLECTION,
      rkey: 'self',
      record: intruderPointer as unknown as Record<string, unknown>,
    })

    // Then the genuine supplier announces and publishes.
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(pointer))
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(snapshot, page))

    // The real catalog is live and the real pointer was promoted.
    expect(await indexedSkus()).toEqual(['Chair CHAIR-1'])
    expect((await pointerRow())?.awaitingSnapshot).toBe(false)
  })
})

  /**
   * POINTER-FIRST AT SEQUENCE 2, which is where it stopped working.
   *
   * The pending pointer was written over the ACCEPTED one — both keyed on
   * `supplier/catalog` — so announcing sequence 2 destroyed the record of
   * sequence 1. `loadCurrentPointer` then returned null for the pending row it
   * found, and when the snapshot arrived the advance was checked against
   * nothing: `verifyCatalogPointerAdvance(null, 2)` refused it as a genesis
   * that must start at 1. Permanently — every redelivery hit the same wall —
   * while the sequence-1 catalog stayed live under a pending pointer.
   *
   * The existing pointer-first case covered sequence 1 only, where "no
   * predecessor" is the correct answer, so the defect had nowhere to show.
   */
  it('pointer-first works at sequence 2, not only at genesis', async () => {
    // Sequence 1, the ordinary way round.
    const first = publication(1, ['CHAIR-1'])
    await commerceCatalogSnapshotHandler.handleCreate?.(ctx, snapshotOp(first.snapshot, first.page))
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(first.pointer))
    expect(await indexedSkus()).toEqual(['Chair CHAIR-1'])

    // Sequence 2 ANNOUNCED first. The live catalog must not change yet.
    const second = publication(2, ['CHAIR-2'], first.snapshot.snapshot_digest)
    await commerceCatalogPointerHandler.handleCreate?.(ctx, pointerOp(second.pointer))
    expect(await indexedSkus()).toEqual(['Chair CHAIR-1'])

    // And when the snapshot lands, the advance is checked against sequence 1
    // — which still exists — and the catalog is replaced.
    await commerceCatalogSnapshotHandler.handleCreate?.(
      ctx,
      snapshotOp(second.snapshot, second.page),
    )
    expect(await indexedSkus()).toEqual(['Chair CHAIR-2'])

    const row = await pointerRow()
    expect(row?.snapshotSequence).toBe(2)
    expect(row?.awaitingSnapshot).toBe(false)
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
