/**
 * Supplier-side catalog publication (§10.2, WS-5 producer half).
 *
 * `@dina/commerce-protocol` says what a valid publication LOOKS like and how a
 * consumer verifies it. This builds one: paginate the items, commit to each
 * page, commit to the ordered pages, and mint the pointer that advances the
 * chain.
 *
 * WHY THE BUILDER OWNS PAGINATION. The page boundary is part of the
 * commitment — change where pages split and every digest below changes. A
 * caller that paginated itself and handed us pages could produce a snapshot
 * that verifies but that no other publisher would reproduce from the same
 * catalog. One splitter, deterministic, so the same items always yield the
 * same publication.
 *
 * WHY THE PREVIOUS POINTER IS AN ARGUMENT, NOT A LOOKUP. §10.2 makes
 * publication a compare-and-swap on the previous sequence. The caller holds
 * what it last published and passes it; we refuse anything that does not
 * legally advance from it, using the SAME validator a consumer runs. A
 * publisher that raced itself gets a refusal here rather than a forked chain
 * on the network.
 */

import {
  MAX_CATALOG_PAGES,
  MAX_CATALOG_PAGE_ITEMS,
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  verifyCatalogPointerAdvance,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
  type Sha256Fn,
} from '@dina/commerce-protocol';

import { gateCatalogForPublication, type LeakageVerdict } from './catalog_leakage';

export type CatalogPublicationRefusal =
  | 'too_many_items'
  | 'invalid_page_size'
  | 'chain_refused'
  | 'withdraw_without_predecessor'
  /**
   * §12.1 — an item carried a field outside the public vocabulary, or a value
   * shaped like a credential. Refused BEFORE any digest is computed, because a
   * snapshot is content-addressed and published: it does not un-publish.
   */
  | 'leakage_refused';

export type CatalogPublication =
  | {
      ok: true;
      pointer: CatalogPointer;
      /** Absent on a withdrawal — a tombstone publishes no snapshot. */
      snapshot?: CatalogSnapshot;
      pages?: CatalogSnapshotPage[];
    }
  | {
      ok: false;
      refusal: CatalogPublicationRefusal;
      error: string;
      /** Present on `leakage_refused`: which fields, never their values. */
      leakage?: LeakageVerdict;
    };

export interface BuildCatalogSnapshotArgs {
  supplierDid: string;
  catalogId: string;
  protocolVersion: string;
  publishedAt: string;
  items: readonly unknown[];
  /** What this supplier last published, or null for the first publication. */
  previous: { pointer: CatalogPointer; snapshotDigest: string } | null;
  /** Items per page. Defaults to the v1 maximum. */
  pageSize?: number;
  /**
   * Which SERVICE LISTING serves this catalog (§10.5, DR-5).
   *
   * Omitted means "not stated", and a consumer then falls back to the `self`
   * convention for a node's primary listing. Stating it is what a supplier
   * with SEVERAL listings must do: without it every buyer is told to send the
   * quote request to `self`, which is the primary listing whether or not it is
   * the one that stocks this catalog.
   */
  serviceRkey?: string;
  sha256: Sha256Fn;
}

/**
 * Split items into bounded pages, deterministically.
 *
 * An empty catalog still produces ZERO pages rather than one empty page: a
 * snapshot with no pages is the honest representation of "this supplier
 * currently offers nothing", and inventing an empty page would make the
 * payload root depend on whether the splitter felt like emitting one.
 */
function paginate(
  items: readonly unknown[],
  pageSize: number,
  catalogId: string,
  sequence: number,
  sha256: Sha256Fn,
): CatalogSnapshotPage[] {
  const pages: CatalogSnapshotPage[] = [];
  for (let index = 0; index * pageSize < items.length; index += 1) {
    const draft: CatalogSnapshotPage = {
      catalog_id: catalogId,
      snapshot_sequence: sequence,
      page_index: index,
      items: items.slice(index * pageSize, (index + 1) * pageSize),
      page_digest: '',
    };
    pages.push({ ...draft, page_digest: catalogPageDigest(draft, sha256) });
  }
  return pages;
}

/**
 * Build the next full-state snapshot and the pointer that publishes it.
 *
 * v1 snapshots replace their predecessor entirely (§10.2), so the caller hands
 * over the WHOLE catalog every time. "Incremental refresh" in the spec means
 * republishing bounded full snapshots on change, not shipping deltas.
 */
export function buildCatalogSnapshot(args: BuildCatalogSnapshotArgs): CatalogPublication {
  const pageSize = args.pageSize ?? MAX_CATALOG_PAGE_ITEMS;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_CATALOG_PAGE_ITEMS) {
    return {
      ok: false,
      refusal: 'invalid_page_size',
      error: `catalog: pageSize must be between 1 and ${String(MAX_CATALOG_PAGE_ITEMS)}`,
    };
  }
  if (args.items.length > pageSize * MAX_CATALOG_PAGES) {
    // Refuse rather than truncate. A silently shortened catalog would publish
    // as a valid full-state snapshot that simply omits products, and the
    // supplier would have no way to tell from the record that it happened.
    return {
      ok: false,
      refusal: 'too_many_items',
      error: 'catalog: item count exceeds the v1 page bound',
    };
  }

  // §12.1 LEAKAGE GATE — inside the publisher, not beside it.
  //
  // A gate a caller must remember to run is a gate that will be missed by
  // whichever caller is written next, and this is the one place in the pack
  // where being missed is unrecoverable: a published snapshot is
  // content-addressed and indexed, so a credential that reaches one is
  // disclosed permanently to everyone. Running it HERE means every path that
  // can produce a snapshot has already run it, including paths nobody has
  // written yet.
  //
  // Before pagination and before any digest, so a refused catalog leaves no
  // computed artefact that a later caller could mistake for a publishable one.
  const leakage = gateCatalogForPublication(args.items);
  if (!leakage.clean) {
    return {
      ok: false,
      refusal: 'leakage_refused',
      error: `catalog: ${String(leakage.findings.length + leakage.truncated)} item field(s) may not be published (§12.1)`,
      leakage,
    };
  }

  const sequence = args.previous === null ? 1 : args.previous.pointer.snapshot_sequence + 1;
  const pages = paginate(args.items, pageSize, args.catalogId, sequence, args.sha256);
  const pageDigests = pages.map((page) => page.page_digest);

  const snapshotDraft: CatalogSnapshot = {
    supplier_did: args.supplierDid,
    catalog_id: args.catalogId,
    snapshot_sequence: sequence,
    protocol_version: args.protocolVersion,
    published_at: args.publishedAt,
    page_digests: pageDigests,
    item_count: args.items.length,
    payload_root: catalogPayloadRoot(pageDigests, args.sha256),
    snapshot_digest: '',
  };
  const snapshot: CatalogSnapshot = {
    ...snapshotDraft,
    snapshot_digest: catalogSnapshotDigest(snapshotDraft, args.sha256),
  };

  const pointer: CatalogPointer = {
    supplier_did: args.supplierDid,
    catalog_id: args.catalogId,
    snapshot_sequence: sequence,
    protocol_version: args.protocolVersion,
    published_at: args.publishedAt,
    snapshot_rkey: snapshot.snapshot_digest,
    snapshot_digest: snapshot.snapshot_digest,
    ...(args.serviceRkey === undefined ? {} : { service_rkey: args.serviceRkey }),
    ...(args.previous === null ? {} : { previous_snapshot_digest: args.previous.snapshotDigest }),
  };

  // Run the CONSUMER's validator on our own output. If a publisher would not
  // accept this advance, it must not go on the wire — one rule, checked by the
  // same code on both sides, so the producer cannot drift from the verifier.
  const advance = verifyCatalogPointerAdvance(args.previous?.pointer ?? null, pointer);
  if (advance !== null) {
    return { ok: false, refusal: 'chain_refused', error: advance };
  }

  return { ok: true, pointer, snapshot, pages };
}

/**
 * Publish a withdrawal tombstone (§10.2).
 *
 * Requires a predecessor: withdrawing a catalog that was never published would
 * announce the end of something no consumer ever saw, and the chain has no
 * position to advance from.
 */
export function buildCatalogWithdrawal(args: {
  /** Carried onto the tombstone so the record stays self-describing. */
  serviceRkey?: string;
  supplierDid: string;
  catalogId: string;
  protocolVersion: string;
  publishedAt: string;
  previous: { pointer: CatalogPointer; snapshotDigest: string };
}): CatalogPublication {
  const pointer: CatalogPointer = {
    supplier_did: args.supplierDid,
    catalog_id: args.catalogId,
    snapshot_sequence: args.previous.pointer.snapshot_sequence + 1,
    protocol_version: args.protocolVersion,
    published_at: args.publishedAt,
    ...(args.serviceRkey === undefined ? {} : { service_rkey: args.serviceRkey }),
    previous_snapshot_digest: args.previous.snapshotDigest,
    withdrawn: true,
  };
  const advance = verifyCatalogPointerAdvance(args.previous.pointer, pointer);
  if (advance !== null) {
    return { ok: false, refusal: 'chain_refused', error: advance };
  }
  return { ok: true, pointer };
}
