import { createHash } from 'node:crypto'

import {
  MAX_CATALOG_ID_LENGTH,
  MAX_CATALOG_PAGE_ITEMS,
  MAX_CATALOG_PAGES,
  canonicalJson,
  catalogPageDigest as protocolCatalogPageDigest,
  catalogPayloadRoot as protocolCatalogPayloadRoot,
  catalogSnapshotDigest as protocolCatalogSnapshotDigest,
  verifyCatalogPage as protocolVerifyCatalogPage,
  verifyCatalogPointerAdvance as protocolVerifyCatalogPointerAdvance,
  verifyCatalogSnapshot as protocolVerifyCatalogSnapshot,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
  type Sha256Fn,
} from '@dina/commerce-protocol'

/**
 * The §10.2 catalog trust chain, as AppView applies it (FR-A1, FR-A2).
 *
 *     supplier repo proof
 *       -> current snapshot pointer
 *       -> immutable snapshot metadata
 *       -> canonical payload digest/root
 *       -> bounded catalog pages
 *
 * Every hop is recomputable, so the feed host is transport and never authority:
 * a modified page fails its digest, a swapped payload fails the root, a forged
 * pointer fails the chain.
 *
 * THIS WAS A SECOND IMPLEMENTATION AND IS NOW AN ADAPTER — the same correction
 * `wire_shape.ts` already carries, applied to the file that was missed. The old
 * header here justified a duplicate with "AppView cannot depend on
 * `@dina/commerce-protocol` … commerce-protocol uses extensionless relative
 * imports and AppView runs Node ESM". That is true of the package's SOURCE and
 * false of its BUILD, which is CommonJS and imports cleanly. AppView now
 * depends on the package, resolves its `compiled` export condition in tests and
 * in production alike, and this module keeps no digest or chain rules of its
 * own.
 *
 * IT HAD ALREADY DRIFTED, which is the argument. The protocol's
 * `verifyCatalogPointerAdvance`, `verifyCatalogSnapshot` and `verifyCatalogPage`
 * each begin by validating the record's SHAPE; the copies here did not. So the
 * two answered differently for any caller that did not happen to run
 * `checkCatalogPointer` first — and a divergence in chain rules means AppView
 * indexing a publication no other implementation accepts. Deleting the second
 * copy of the wire rules and leaving its sibling standing fixed the instance
 * and not the class.
 *
 * WHAT LEGITIMATELY REMAINS HERE: the SHA-256 injection (the protocol takes a
 * `Sha256Fn` so it can stay dependency-free; Node has one) and three AppView
 * compositions — `verifyPointerNamesSnapshot`, `verifyPageIndexCoverage` and
 * `verifyCatalogPublication` — which sequence the protocol's primitives in the
 * order this indexer needs. Those are policy about how AppView spends its fetch
 * budget, not wire law.
 */

/**
 * Node's hash, injected once. The protocol carries no crypto dependency, so it
 * takes a `Sha256Fn` — BYTES IN, BYTES OUT. The protocol does its own UTF-8
 * encoding and hex formatting around this call; a string-in/hex-out adapter
 * would be hashing a different thing.
 */
const sha256: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest())

export {
  MAX_CATALOG_ID_LENGTH,
  MAX_CATALOG_PAGE_ITEMS,
  MAX_CATALOG_PAGES,
  canonicalJson,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
}

/** Digest of one page, excluding its own digest field. */
export function catalogPageDigest(page: CatalogSnapshotPage): string {
  return protocolCatalogPageDigest(page, sha256)
}

/** An ordered commitment over the page digests — flat, not a Merkle tree. */
export function catalogPayloadRoot(pageDigests: readonly string[]): string {
  return protocolCatalogPayloadRoot(pageDigests, sha256)
}

/** Digest of a snapshot record, excluding its own digest field. */
export function catalogSnapshotDigest(snapshot: CatalogSnapshot): string {
  return protocolCatalogSnapshotDigest(snapshot, sha256)
}

/**
 * Verify that `next` legally advances the chain from `previous`.
 *
 * §10.2: snapshots apply in sequence order, and a GAP or a ROLLBACK is a
 * publication fault rather than something to index quietly. A repeat of the
 * same sequence is a fork attempt and is refused for the same reason: two
 * different snapshots may not share a position in the chain.
 *
 * The refusal STRINGS are frozen in the conformance vectors, and now come from
 * the protocol rather than from a paraphrase of it.
 */
export function verifyCatalogPointerAdvance(
  previous: CatalogPointer | null,
  next: CatalogPointer,
): string | null {
  return protocolVerifyCatalogPointerAdvance(previous, next)
}

/** Verify a snapshot against its own commitments, and against the §10.2 caps. */
export function verifyCatalogSnapshot(snapshot: CatalogSnapshot): string | null {
  return protocolVerifyCatalogSnapshot(snapshot, sha256)
}

/**
 * Verify that a fetched page belongs to this snapshot, at this position.
 *
 * `page_index` is inside the page digest, so a page declares its own slot and
 * cannot be served from one it does not claim.
 */
export function verifyCatalogPage(
  page: CatalogSnapshotPage,
  snapshot: CatalogSnapshot,
): string | null {
  return protocolVerifyCatalogPage(page, snapshot, sha256)
}

/**
 * Verify a pointer against the snapshot it names.
 *
 * A pointer and a snapshot can each be internally valid and still not belong
 * together, which is why the pointer carries the digest: without this check a
 * supplier could advance the chain while serving last week's catalog, and every
 * individual record would still verify.
 */
export function verifyPointerNamesSnapshot(
  pointer: CatalogPointer,
  snapshot: CatalogSnapshot,
): string | null {
  if (pointer.withdrawn === true) {
    // A tombstone names no snapshot, so there is nothing to bind. Pairing one
    // with a snapshot is itself the fault.
    return 'pointer: a withdrawal names no snapshot'
  }
  if (pointer.snapshot_digest !== snapshot.snapshot_digest) {
    return 'pointer: does not name this snapshot'
  }
  if (pointer.supplier_did !== snapshot.supplier_did) {
    return 'pointer: supplier_did disagrees with the snapshot'
  }
  if (pointer.catalog_id !== snapshot.catalog_id) {
    return 'pointer: catalog_id disagrees with the snapshot'
  }
  if (pointer.snapshot_sequence !== snapshot.snapshot_sequence) {
    return 'pointer: snapshot_sequence disagrees with the snapshot'
  }
  return null
}

/**
 * Every committed page present EXACTLY ONCE.
 *
 * Per-page verification asks "does this page belong to this snapshot, at the
 * slot it claims?" — a question each page answers about itself. Nothing asked
 * whether the pages TOGETHER cover the snapshot, so serving page 0 twice
 * passed: the count matched, both pages verified at index 0, and when the
 * duplicated page happened to carry the same number of items as the one it
 * displaced, the total matched too. A committed page was simply never
 * presented, and the catalog projected was not the catalog published.
 *
 * The set check is what makes the per-page check add up to a whole.
 */
export function verifyPageIndexCoverage(
  pages: readonly CatalogSnapshotPage[],
  snapshot: CatalogSnapshot,
): string | null {
  const seen = new Set<number>()
  for (const page of pages) {
    if (seen.has(page.page_index)) return 'pages: the same page index appears twice'
    seen.add(page.page_index)
  }
  for (let i = 0; i < snapshot.page_digests.length; i += 1) {
    if (!seen.has(i)) return 'pages: a committed page index was never presented'
  }
  return null
}

/**
 * The whole chain in one call: pointer advance, snapshot commitments, the
 * binding between them, and every page.
 *
 * Composed here rather than left to each caller, because the ORDER is part of
 * the guarantee — checking pages before confirming the pointer names this
 * snapshot would spend the fetch budget on a catalog the supplier is not
 * currently publishing — and because a caller that forgot one hop would still
 * look like it verified.
 */
export function verifyCatalogPublication(args: {
  previous: CatalogPointer | null
  pointer: CatalogPointer
  snapshot: CatalogSnapshot
  pages: readonly CatalogSnapshotPage[]
}): string | null {
  const advance = verifyCatalogPointerAdvance(args.previous, args.pointer)
  if (advance !== null) return advance

  const bound = verifyPointerNamesSnapshot(args.pointer, args.snapshot)
  if (bound !== null) return bound

  const commitments = verifyCatalogSnapshot(args.snapshot)
  if (commitments !== null) return commitments

  if (args.pages.length !== args.snapshot.page_digests.length) {
    // Not merely "some pages are missing": a full-state snapshot with pages
    // absent projects a catalog that silently omits products, and buyers see
    // a supplier who does not stock the thing rather than an error.
    return 'pages: count does not match the snapshot'
  }
  for (const page of args.pages) {
    const bad = verifyCatalogPage(page, args.snapshot)
    if (bad !== null) return bad
  }
  const coverage = verifyPageIndexCoverage(args.pages, args.snapshot)
  if (coverage !== null) return coverage

  const items = args.pages.reduce((sum, page) => sum + page.items.length, 0)
  if (items !== args.snapshot.item_count) {
    return 'pages: item count does not match the snapshot'
  }
  return null
}
