import {
  verifyCatalogPointerAdvance,
  verifyCatalogPublication,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from './catalog-verify.js'
import {
  projectCatalogSnapshot,
  type CatalogItemShape,
  type CatalogProductRow,
  type ProjectionFinding,
} from './catalog-projection.js'

/**
 * What AppView should DO with an arriving catalog record (§10.2, §10.4, FR-A6).
 *
 * PURE, and separate from the handler for one reason worth stating: the
 * interesting part of catalog ingest is not the SQL, it is the decision — the
 * chain check, the ordering problem, and what happens when a supplier retires
 * a catalog. A handler that made those decisions inline could only be tested
 * with a database, and the ordering cases are exactly the ones nobody writes a
 * database test for.
 *
 * THE ORDERING PROBLEM. Jetstream gives no ordering guarantee between two
 * collections, so the pointer naming a snapshot can arrive before the snapshot
 * itself. Both orders must reach the same index. The rule here is that the
 * POINTER is the authority and the snapshot is evidence: an unmatched snapshot
 * is simply stored, and an unmatched pointer is stored as PENDING and indexed
 * later when its snapshot turns up. What must never happen is indexing a
 * snapshot no current pointer names — that is how a supplier's withdrawn or
 * superseded catalog comes back to life.
 */

export type CatalogIngestAction =
  /**
   * Store the snapshot as evidence. It becomes queryable only when a pointer
   * names it — a snapshot with no pointer is a draft, not a publication.
   */
  | { kind: 'store_snapshot'; snapshotDigest: string }
  /**
   * Record the pointer and index the products it commits to. Replaces every
   * previous row for this catalog, because a snapshot is full state (§10.2).
   */
  | { kind: 'index'; pointer: CatalogPointer; rows: CatalogProductRow[] }
  /**
   * The pointer is legal but its snapshot has not arrived. Hold it; when the
   * snapshot lands, this same decision runs again and indexes.
   */
  | { kind: 'await_snapshot'; pointer: CatalogPointer }
  /**
   * §10.4 / FR-A6: the supplier withdrew the catalog. Remove the products and
   * keep the tombstone, so a later publication under the same catalog_id is
   * still refused by the chain rule rather than silently accepted.
   */
  | { kind: 'withdraw'; pointer: CatalogPointer }
  /**
   * Refuse, leaving whatever is currently indexed in place. That fallback is
   * deliberate: the previously published catalog is at least one the supplier
   * once stood behind, whereas an empty index reads to a buyer as "this
   * supplier stocks nothing".
   */
  | { kind: 'refuse'; reason: string; findings?: ProjectionFinding[] }

/**
 * Decide what an arriving POINTER means.
 *
 * `snapshot` is what AppView already holds for the digest this pointer names,
 * or null when nothing has arrived for it yet.
 */
export function decideCatalogPointer(args: {
  /** The pointer currently indexed for this (supplier, catalog), if any. */
  previous: CatalogPointer | null
  pointer: CatalogPointer
  /** The publishing repo's DID. Authority for who the supplier is. */
  repoDid: string
  snapshot: { snapshot: CatalogSnapshot; pages: CatalogSnapshotPage[] } | null
}): CatalogIngestAction {
  if (args.pointer.supplier_did !== args.repoDid) {
    // The record lives in someone's repo and names someone else as supplier.
    // Believing it would let any account publish a catalog under a rival's
    // name — the cheapest possible attack on a discovery index.
    return { kind: 'refuse', reason: 'pointer: supplier_did is not the publishing repo' }
  }

  const advance = verifyCatalogPointerAdvance(args.previous, args.pointer)
  if (advance !== null) return { kind: 'refuse', reason: advance }

  if (args.pointer.withdrawn === true) return { kind: 'withdraw', pointer: args.pointer }

  if (args.snapshot === null) return { kind: 'await_snapshot', pointer: args.pointer }

  const verdict = verifyCatalogPublication({
    previous: args.previous,
    pointer: args.pointer,
    snapshot: args.snapshot.snapshot,
    pages: args.snapshot.pages,
  })
  if (verdict !== null) return { kind: 'refuse', reason: verdict }

  const items = args.snapshot.pages.flatMap((page) => page.items) as CatalogItemShape[]
  const projection = projectCatalogSnapshot({
    supplierDid: args.repoDid,
    catalogId: args.pointer.catalog_id,
    snapshotSequence: args.pointer.snapshot_sequence,
    snapshotDigest: args.snapshot.snapshot.snapshot_digest,
    items,
  })
  if (!projection.ok) {
    return {
      kind: 'refuse',
      reason: 'projection refused the snapshot',
      findings: projection.findings,
    }
  }

  return { kind: 'index', pointer: args.pointer, rows: projection.rows }
}

/**
 * Decide what an arriving SNAPSHOT means.
 *
 * A snapshot alone is never indexed. If a pending pointer names it, this
 * defers to `decideCatalogPointer` so there is ONE place that decides what
 * gets indexed — two copies of that rule would eventually disagree about
 * which snapshot is current, which is the disagreement the pointer exists to
 * settle.
 */
export function decideCatalogSnapshot(args: {
  repoDid: string
  snapshot: CatalogSnapshot
  pages: CatalogSnapshotPage[]
  /** A pointer AppView is holding that names this snapshot, if any. */
  pendingPointer: CatalogPointer | null
  /** The pointer currently indexed for that catalog, if any. */
  previous: CatalogPointer | null
}): CatalogIngestAction {
  if (args.snapshot.supplier_did !== args.repoDid) {
    return { kind: 'refuse', reason: 'snapshot: supplier_did is not the publishing repo' }
  }
  if (args.pendingPointer === null) {
    return { kind: 'store_snapshot', snapshotDigest: args.snapshot.snapshot_digest }
  }
  return decideCatalogPointer({
    previous: args.previous,
    pointer: args.pendingPointer,
    repoDid: args.repoDid,
    snapshot: { snapshot: args.snapshot, pages: args.pages },
  })
}
