/**
 * The node's OWN live catalogue, read back from what it published.
 *
 * A supplier's published pages are retained on the draft that produced them
 * (`held.pages`), so the items the world sees are readable here without a
 * network round trip: the published pointer names the snapshot, the draft
 * whose held snapshot carries that digest holds its pages, and every item is
 * re-validated on the way out. A withdrawn catalogue contributes nothing.
 *
 * Two readers use it: the reference supplier runner prices a quote from it
 * (JIFFY_MERCHANT_INTEGRATION_PLAN review, item 5) and the integration
 * export names an ordered product from it (item 1). Both read the same
 * bytes the buyer read, so a price or a name never comes from a draft the
 * owner has not published.
 */

import {
  productRefsEqual,
  validateCatalogItem,
  type CatalogItem,
  type ProductRef,
} from '@dina/commerce-protocol';

import type { CommerceRuntime } from './runtime';

export function publishedCatalogItems(
  runtime: Pick<CommerceRuntime, 'catalogPointers' | 'catalogDrafts'>,
): CatalogItem[] {
  const items: CatalogItem[] = [];
  for (const record of runtime.catalogPointers.list()) {
    if (record.withdrawn || record.snapshotDigest === '') continue;
    const draft = runtime.catalogDrafts
      .listByCatalog(record.catalogId)
      .find(
        (d) =>
          d.state === 'published' &&
          d.held !== null &&
          d.held.snapshot.snapshot_digest === record.snapshotDigest,
      );
    if (draft === undefined || draft.held === null) continue;
    for (const page of draft.held.pages) {
      for (const candidate of page.items) {
        if (validateCatalogItem(candidate) === null) items.push(candidate as CatalogItem);
      }
    }
  }
  return items;
}

/** The published item a product names — by its own identity or a listed identifier. */
export function findPublishedItem(
  items: readonly CatalogItem[],
  product: ProductRef,
): CatalogItem | null {
  const sameValue = (ref: ProductRef): boolean =>
    ref.scheme === product.scheme &&
    ref.value === product.value &&
    // A request that names no issuer matches the supplier's own-issued ref.
    (product.issuer_did === undefined || productRefsEqual(ref, product));
  return (
    items.find((item) => sameValue(item.product)) ??
    items.find((item) => (item.identifiers ?? []).some(sameValue)) ??
    null
  );
}
