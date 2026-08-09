import { and, eq } from 'drizzle-orm'

import {
  commerceCatalogPointers,
  commerceCatalogProducts,
  commerceCatalogSnapshots,
} from '@/db/schema/index.js'
import {
  decideCatalogPointer,
  decideCatalogSnapshot,
  type CatalogIngestAction,
} from '@/shared/commerce/catalog-ingest-decision.js'
import {
  MAX_CATALOG_PAGES,
  MAX_CATALOG_PAGE_ITEMS,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '@/shared/commerce/catalog-verify.js'

import type { HandlerContext, RecordHandler, RecordOp } from './index.js'

/**
 * Jetstream handlers for the two catalog records (§10.2).
 *
 *   com.dinakernel.commerce.catalog          — the mutable pointer
 *   com.dinakernel.commerce.catalogSnapshot  — the immutable snapshot
 *
 * DELIBERATELY THIN. Every rule worth arguing about lives in
 * `catalog-ingest-decision`, which is pure; this file opens transactions and
 * writes rows. The split is not ceremony — the interesting cases are the two
 * Jetstream delivery orders and the ways a record can look legal while
 * belonging to somebody else, and those are exactly the cases nobody writes a
 * database test for.
 *
 * `op.did` IS the supplier. It is the repo the record was published in, and
 * the decision refuses any record naming a different `supplier_did` — without
 * that, any account could publish a catalog under a rival's name, which is the
 * cheapest possible attack on a discovery index.
 */

/** §10.3 v1: pages travel inline. An HTTPS feed is refused, not half-read. */
function readPages(record: Record<string, unknown>): CatalogSnapshotPage[] | null {
  const pages = record.pages
  if (!Array.isArray(pages)) return null
  if (pages.length > MAX_CATALOG_PAGES) return null
  for (const page of pages) {
    const items = (page as { items?: unknown }).items
    if (!Array.isArray(items) || items.length > MAX_CATALOG_PAGE_ITEMS) return null
  }
  return pages as CatalogSnapshotPage[]
}

function pointerId(supplierDid: string, catalogId: string): string {
  return `${supplierDid}/${catalogId}`
}

async function loadCurrentPointer(
  ctx: HandlerContext,
  supplierDid: string,
  catalogId: string,
): Promise<CatalogPointer | null> {
  const rows = await ctx.db
    .select()
    .from(commerceCatalogPointers)
    .where(eq(commerceCatalogPointers.id, pointerId(supplierDid, catalogId)))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  // A PENDING pointer is not the current one. It named a snapshot that never
  // arrived, so nothing was indexed for it; treating it as the predecessor
  // would make the chain refuse the supplier's next publication for a gap
  // they did not create.
  if (row.awaitingSnapshot) return null
  return {
    supplier_did: row.supplierDid,
    catalog_id: row.catalogId,
    snapshot_sequence: row.snapshotSequence,
    protocol_version: row.protocolVersion,
    published_at: row.publishedAt,
    ...(row.snapshotDigest === null
      ? {}
      : { snapshot_rkey: row.snapshotDigest, snapshot_digest: row.snapshotDigest }),
    ...(row.previousSnapshotDigest === null
      ? {}
      : { previous_snapshot_digest: row.previousSnapshotDigest }),
    ...(row.withdrawn ? { withdrawn: true } : {}),
  }
}

async function loadSnapshot(
  ctx: HandlerContext,
  snapshotDigest: string,
): Promise<{ snapshot: CatalogSnapshot; pages: CatalogSnapshotPage[] } | null> {
  const rows = await ctx.db
    .select()
    .from(commerceCatalogSnapshots)
    .where(eq(commerceCatalogSnapshots.snapshotDigest, snapshotDigest))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return null
  return {
    snapshot: row.snapshotJson as CatalogSnapshot,
    pages: row.pagesJson as CatalogSnapshotPage[],
  }
}

/**
 * Apply a decision.
 *
 * ONE transaction per decision, and the product replacement is delete-then-
 * insert inside it: a snapshot is full state, so a reader must never see the
 * new catalog half-applied over the old one.
 */
async function apply(
  ctx: HandlerContext,
  action: CatalogIngestAction,
  op: RecordOp,
): Promise<void> {
  switch (action.kind) {
    case 'refuse':
      // The previously indexed catalog stays. An empty index reads to a buyer
      // as "this supplier stocks nothing", which is a worse lie than a page
      // that is one revision behind.
      ctx.logger.warn(
        { uri: op.uri, did: op.did, reason: action.reason, findings: action.findings },
        '[CommerceCatalog] refused',
      )
      ctx.metrics.incr('ingester.commerce_catalog.refused')
      return

    case 'store_snapshot':
      ctx.metrics.incr('ingester.commerce_catalog.snapshot_stored')
      return

    case 'await_snapshot':
      await ctx.db
        .insert(commerceCatalogPointers)
        .values({
          id: pointerId(action.pointer.supplier_did, action.pointer.catalog_id),
          supplierDid: action.pointer.supplier_did,
          catalogId: action.pointer.catalog_id,
          snapshotSequence: action.pointer.snapshot_sequence,
          protocolVersion: action.pointer.protocol_version,
          publishedAt: action.pointer.published_at,
          snapshotDigest: action.pointer.snapshot_digest ?? null,
          previousSnapshotDigest: action.pointer.previous_snapshot_digest ?? null,
          withdrawn: false,
          awaitingSnapshot: true,
          uri: op.uri,
        })
        .onConflictDoUpdate({
          target: commerceCatalogPointers.id,
          set: {
            snapshotSequence: action.pointer.snapshot_sequence,
            publishedAt: action.pointer.published_at,
            snapshotDigest: action.pointer.snapshot_digest ?? null,
            previousSnapshotDigest: action.pointer.previous_snapshot_digest ?? null,
            awaitingSnapshot: true,
            uri: op.uri,
            indexedAt: new Date(),
          },
        })
      ctx.metrics.incr('ingester.commerce_catalog.awaiting_snapshot')
      return

    case 'withdraw':
      await ctx.db.transaction(async (tx) => {
        await tx
          .delete(commerceCatalogProducts)
          .where(
            and(
              eq(commerceCatalogProducts.supplierDid, action.pointer.supplier_did),
              eq(commerceCatalogProducts.catalogId, action.pointer.catalog_id),
            ),
          )
        await tx
          .insert(commerceCatalogPointers)
          .values({
            id: pointerId(action.pointer.supplier_did, action.pointer.catalog_id),
            supplierDid: action.pointer.supplier_did,
            catalogId: action.pointer.catalog_id,
            snapshotSequence: action.pointer.snapshot_sequence,
            protocolVersion: action.pointer.protocol_version,
            publishedAt: action.pointer.published_at,
            snapshotDigest: null,
            previousSnapshotDigest: action.pointer.previous_snapshot_digest ?? null,
            withdrawn: true,
            awaitingSnapshot: false,
            uri: op.uri,
          })
          .onConflictDoUpdate({
            target: commerceCatalogPointers.id,
            set: {
              snapshotSequence: action.pointer.snapshot_sequence,
              publishedAt: action.pointer.published_at,
              snapshotDigest: null,
              previousSnapshotDigest: action.pointer.previous_snapshot_digest ?? null,
              withdrawn: true,
              awaitingSnapshot: false,
              uri: op.uri,
              indexedAt: new Date(),
            },
          })
      })
      ctx.metrics.incr('ingester.commerce_catalog.withdrawn')
      return

    case 'index':
      await ctx.db.transaction(async (tx) => {
        await tx
          .delete(commerceCatalogProducts)
          .where(
            and(
              eq(commerceCatalogProducts.supplierDid, action.pointer.supplier_did),
              eq(commerceCatalogProducts.catalogId, action.pointer.catalog_id),
            ),
          )
        if (action.rows.length > 0) {
          await tx.insert(commerceCatalogProducts).values(
            action.rows.map((row) => ({
              rowKey: row.rowKey,
              productKey: row.productKey,
              supplierDid: row.supplierDid,
              catalogId: row.catalogId,
              snapshotSequence: row.snapshotSequence,
              snapshotDigest: row.snapshotDigest,
              itemRevision: row.itemRevision,
              name: row.name,
              brand: row.brand,
              description: row.description,
              categoryIds: row.categoryIds,
              identifierKeys: row.identifierKeys,
              fulfilmentRegions: row.fulfilmentRegions,
              indicativePrice: row.indicativePrice,
              generatedAt: row.generatedAt,
              validUntil: row.validUntil,
            })),
          )
        }
        await tx
          .insert(commerceCatalogPointers)
          .values({
            id: pointerId(action.pointer.supplier_did, action.pointer.catalog_id),
            supplierDid: action.pointer.supplier_did,
            catalogId: action.pointer.catalog_id,
            snapshotSequence: action.pointer.snapshot_sequence,
            protocolVersion: action.pointer.protocol_version,
            publishedAt: action.pointer.published_at,
            snapshotDigest: action.pointer.snapshot_digest ?? null,
            previousSnapshotDigest: action.pointer.previous_snapshot_digest ?? null,
            withdrawn: false,
            awaitingSnapshot: false,
            uri: op.uri,
          })
          .onConflictDoUpdate({
            target: commerceCatalogPointers.id,
            set: {
              snapshotSequence: action.pointer.snapshot_sequence,
              publishedAt: action.pointer.published_at,
              snapshotDigest: action.pointer.snapshot_digest ?? null,
              previousSnapshotDigest: action.pointer.previous_snapshot_digest ?? null,
              withdrawn: false,
              awaitingSnapshot: false,
              uri: op.uri,
              indexedAt: new Date(),
            },
          })
      })
      ctx.metrics.incr('ingester.commerce_catalog.indexed')
      return
  }
}

export const commerceCatalogPointerHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record ?? {}
    const pointer = { ...record, supplier_did: record.supplier_did } as CatalogPointer
    const previous = await loadCurrentPointer(ctx, op.did, pointer.catalog_id)
    const snapshot =
      pointer.snapshot_digest === undefined
        ? null
        : await loadSnapshot(ctx, pointer.snapshot_digest)
    await apply(
      ctx,
      decideCatalogPointer({ previous, pointer, repoDid: op.did, snapshot }),
      op,
    )
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    // Deleting the POINTER record retires the catalog: nothing names a current
    // snapshot any more, so nothing should stay searchable. The row itself is
    // kept as a tombstone for the same reason a withdrawal is — it is what
    // refuses a silent relaunch under the same catalog_id.
    await ctx.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(commerceCatalogPointers)
        .where(eq(commerceCatalogPointers.uri, op.uri))
        .limit(1)
      const row = rows[0]
      if (row === undefined) return
      await tx
        .delete(commerceCatalogProducts)
        .where(
          and(
            eq(commerceCatalogProducts.supplierDid, row.supplierDid),
            eq(commerceCatalogProducts.catalogId, row.catalogId),
          ),
        )
      await tx
        .update(commerceCatalogPointers)
        .set({ withdrawn: true, snapshotDigest: null, awaitingSnapshot: false })
        .where(eq(commerceCatalogPointers.id, row.id))
    })
    ctx.metrics.incr('ingester.commerce_catalog.pointer_deleted')
  },
}

export const commerceCatalogSnapshotHandler: RecordHandler = {
  async handleCreate(ctx: HandlerContext, op: RecordOp) {
    const record = op.record ?? {}
    const pages = readPages(record)
    if (pages === null) {
      // Refused, not truncated. A snapshot is full state, so half a catalog
      // published as if it were the whole one omits products silently.
      ctx.logger.warn(
        { uri: op.uri, did: op.did },
        '[CommerceCatalog] snapshot pages missing or over the §10.2 caps',
      )
      ctx.metrics.incr('ingester.commerce_catalog.refused')
      return
    }
    const snapshot = record.snapshot as CatalogSnapshot | undefined
    if (snapshot === undefined) {
      ctx.metrics.incr('ingester.commerce_catalog.refused')
      return
    }

    // Store first: the decision may index off this row, and a pending pointer
    // found below must see it.
    await ctx.db
      .insert(commerceCatalogSnapshots)
      .values({
        snapshotDigest: snapshot.snapshot_digest,
        supplierDid: op.did,
        catalogId: snapshot.catalog_id,
        snapshotSequence: snapshot.snapshot_sequence,
        snapshotJson: snapshot,
        pagesJson: pages,
      })
      // Content-addressed, so a repeat is the same bytes. Nothing to update.
      .onConflictDoNothing()

    const pending = await ctx.db
      .select()
      .from(commerceCatalogPointers)
      .where(
        and(
          eq(commerceCatalogPointers.snapshotDigest, snapshot.snapshot_digest),
          eq(commerceCatalogPointers.awaitingSnapshot, true),
        ),
      )
      .limit(1)
    const held = pending[0]

    const pendingPointer: CatalogPointer | null =
      held === undefined
        ? null
        : {
            supplier_did: held.supplierDid,
            catalog_id: held.catalogId,
            snapshot_sequence: held.snapshotSequence,
            protocol_version: held.protocolVersion,
            published_at: held.publishedAt,
            snapshot_rkey: held.snapshotDigest ?? '',
            snapshot_digest: held.snapshotDigest ?? '',
            ...(held.previousSnapshotDigest === null
              ? {}
              : { previous_snapshot_digest: held.previousSnapshotDigest }),
          }

    // The predecessor is whatever is CURRENT for that catalog, which is not
    // the held pointer itself.
    const previous =
      pendingPointer === null
        ? null
        : await loadCurrentPointer(ctx, op.did, pendingPointer.catalog_id)

    await apply(
      ctx,
      decideCatalogSnapshot({ repoDid: op.did, snapshot, pages, pendingPointer, previous }),
      held === undefined ? op : { ...op, uri: held.uri },
    )
  },

  async handleDelete(ctx: HandlerContext, op: RecordOp) {
    // A snapshot is evidence, not authority. Deleting it does NOT unindex the
    // products: the pointer still names it, and a buyer following that pointer
    // is entitled to what the supplier published. Removing the row only means
    // AppView can no longer re-verify from storage.
    ctx.logger.debug({ uri: op.uri }, '[CommerceCatalog] snapshot record deleted')
    ctx.metrics.incr('ingester.commerce_catalog.snapshot_deleted')
  },
}
