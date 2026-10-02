/**
 * A buyer reading one item out of a supplier's PUBLISHED catalogue — the
 * pointer and snapshot records the supplier wrote to its own repo (§10.2).
 *
 * Used to show an offered item the way the catalogue shows it (photo,
 * description, pack) beside a quote. Presentation only: the price and terms
 * a buyer acts on are the signed quote's, never these.
 *
 * Pure. The caller fetches the two records (by the supplier's DID, from the
 * supplier's PDS) and hands them in as parsed JSON; this checks that they are
 * the supplier's, that the snapshot is the one the pointer names, and that
 * every page is committed to by the snapshot's own digests — the same
 * `verifyCatalogSnapshot` / `verifyCatalogPage` AppView runs on ingest — and
 * only then looks for the product. It does not verify the repo commit
 * signature: the pages are what the supplier's PDS serves for that DID, and a
 * record that fails its own digests is refused, not repaired.
 */

import {
  catalogImagesAllowed,
  validateCatalogItemForIngest,
  validateCatalogPointer,
  verifyCatalogPage,
  verifyCatalogSnapshot,
  type CatalogItem,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
  type ProductRef,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { findPublishedItem } from './published_catalog';

export type PublishedItemRead =
  | { ok: true; item: CatalogItem | null }
  | { ok: false; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The item a supplier's published catalogue lists for `product`, after the
 * records prove themselves. `{ok: true, item: null}` is a verified catalogue
 * that does not list it; `{ok: false}` names why the records were refused.
 */
export function readPublishedItem(args: {
  supplierDid: string;
  /** The `com.dinakernel.commerce.catalog` record's value. */
  pointer: unknown;
  /** The `com.dinakernel.commerce.catalogSnapshot` record the pointer names. */
  snapshotRecord: unknown;
  product: ProductRef;
  sha256: Sha256Fn;
}): PublishedItemRead {
  const pointerError = validateCatalogPointer(args.pointer);
  if (pointerError !== null) return { ok: false, reason: pointerError };
  const pointer = args.pointer as CatalogPointer;
  if (pointer.supplier_did !== args.supplierDid) {
    return { ok: false, reason: 'pointer: published by a different supplier' };
  }
  if (pointer.withdrawn === true) return { ok: true, item: null };

  if (!isObject(args.snapshotRecord) || !Array.isArray(args.snapshotRecord.pages)) {
    return { ok: false, reason: 'snapshot record: needs a snapshot and its pages' };
  }
  const snapshot = args.snapshotRecord.snapshot as CatalogSnapshot;
  const snapshotError = verifyCatalogSnapshot(snapshot, args.sha256);
  if (snapshotError !== null) return { ok: false, reason: snapshotError };
  if (snapshot.supplier_did !== args.supplierDid || snapshot.catalog_id !== pointer.catalog_id) {
    return { ok: false, reason: 'snapshot: not the catalogue the pointer names' };
  }
  if (
    snapshot.snapshot_digest !== pointer.snapshot_digest ||
    snapshot.snapshot_sequence !== pointer.snapshot_sequence
  ) {
    return { ok: false, reason: 'snapshot: not the one the pointer names' };
  }

  const pages = args.snapshotRecord.pages as CatalogSnapshotPage[];
  if (pages.length !== snapshot.page_digests.length) {
    return { ok: false, reason: 'snapshot record: page count disagrees with the snapshot' };
  }
  const items: CatalogItem[] = [];
  for (const page of pages) {
    const pageError = verifyCatalogPage(page, snapshot, args.sha256);
    if (pageError !== null) return { ok: false, reason: pageError };
    const imagesAllowed = catalogImagesAllowed(snapshot.protocol_version);
    for (const item of page.items) {
      // `images` exists from minor 1.1: on an older snapshot it is ignored,
      // as if absent — so it is removed BEFORE validation, and an ignored
      // field that would not validate (an empty list, a bad URL) cannot cost
      // the item. (A catalog published with photos before the gate keeps its
      // items and shows no photo until it is republished at 1.1.) The page
      // digest above was checked over the item as published.
      const candidate =
        !imagesAllowed && item !== null && typeof item === 'object' && 'images' in item
          ? (({ images: _ignored, ...rest }) => rest)(item as CatalogItem)
          : item;
      // The reader rule: a later minor's extra field is tolerated, a
      // malformed or forbidden one drops just that item from consideration.
      if (validateCatalogItemForIngest(candidate) !== null) continue;
      const typed = candidate as CatalogItem;
      if (typed.supplier_did !== args.supplierDid) continue;
      items.push(typed);
    }
  }
  return { ok: true, item: findPublishedItem(items, args.product) };
}
