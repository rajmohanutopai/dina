/**
 * Catalog publication wire contract (§10.2, §10.3 — WS-1.8).
 *
 * Two records, mirroring the plugin identity/release split:
 *
 *   - a MUTABLE pointer naming the current snapshot;
 *   - an IMMUTABLE snapshot binding metadata to a payload commitment.
 *
 * The trust chain the spec states is the whole design:
 *
 *     supplier repo proof
 *       -> current snapshot pointer
 *       -> immutable snapshot metadata
 *       -> canonical payload digest/root
 *       -> bounded catalog pages
 *
 * Every hop is recomputable, so the feed host is transport and never
 * authority: a modified page fails its digest, a swapped payload fails the
 * root, a forged pointer fails the chain.
 *
 * WHY THESE COMMITMENTS ARE NOT §9.12 DIGEST DOMAINS. §9.12 fixes ten record
 * digests and the conformance vectors pin them; that list is a closed
 * vocabulary for negotiation and lifecycle RECORDS. A page digest and a
 * payload root are content commitments over published bytes, which is a
 * different thing with a different lifetime. They get their own domain prefix
 * so neither set can silently widen the other.
 */

import { bytesToHex, canonicalJson, utf8Bytes } from './canonical';
import {
  validateDid,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';

import type { Sha256Fn } from './digests';

/** Domain separation for §10 content commitments. Distinct from §9.12. */
const CATALOG_PREFIX = 'dina:commerce:catalog:v1:';

/**
 * The package's ONE hash contract (§9.12's `Sha256Fn`). An earlier draft of
 * this module invented a second shape taking and returning strings, which
 * meant a caller holding the package's own hash could not use it — two
 * contracts for one thing, in a package whose entire job is agreement.
 */
export type Sha256Hex = Sha256Fn;

/** v1 bounds. Pages are bounded so a fetcher can cap work before trusting. */
export const MAX_CATALOG_PAGE_ITEMS = 500;
export const MAX_CATALOG_PAGES = 1000;
export const MAX_CATALOG_ID_LENGTH = 128;

/**
 * One bounded page of a snapshot payload.
 *
 * `page_digest` is excluded from its own preimage, the same rule every
 * commerce record follows, so a verifier recomputes rather than trusts.
 *
 * THE SHAPES IN THIS FILE ARE TYPE ALIASES, NOT INTERFACES, and the difference
 * is load-bearing. TypeScript gives a type alias an implicit index signature
 * and an interface none, so only an alias is assignable to the
 * `Record<string, unknown>` an ATProto `putRecord` takes. As interfaces these
 * records could not be handed to the repo client without a cast — and a cast at
 * that boundary is precisely where a wrong record shape stops being a compile
 * error, which is the failure this file exists to prevent.
 *
 * `consistent-type-definitions` therefore has to be off for these four. The
 * rule states a house style; the alias here states a semantic requirement, and
 * satisfying the rule would put back the cast ARCH-3 removed.
 */
/* eslint-disable @typescript-eslint/consistent-type-definitions --
   see above: only a type alias is assignable to `Record<string, unknown>`,
   and these records are handed straight to `putRecord`. */
export type CatalogSnapshotPage = {
  catalog_id: string;
  snapshot_sequence: number;
  /** 0-based position; the payload root commits to the ORDER. */
  page_index: number;
  items: readonly unknown[];
  page_digest: string;
};

/**
 * Immutable snapshot metadata. v1 snapshots are FULL-STATE: a snapshot
 * completely replaces its predecessor's current view (§10.2). Deltas are a
 * later additive extension, and "incremental refresh" means republishing
 * bounded full snapshots, not shipping diffs.
 */
export type CatalogSnapshot = {
  supplier_did: string;
  catalog_id: string;
  snapshot_sequence: number;
  protocol_version: string;
  published_at: string;
  /** Ordered page digests. Their order IS the payload order. */
  page_digests: readonly string[];
  item_count: number;
  /** Commitment over `page_digests`, recomputable by any verifier. */
  payload_root: string;
  snapshot_digest: string;
};

/**
 * The mutable pointer. Publication is compare-and-swap on the previous
 * sequence (§10.2): a publisher racing itself cannot fork the chain.
 *
 * A WITHDRAWAL is a pointer carrying the next sequence with `withdrawn: true`
 * — an explicit tombstone rather than a deletion, so a consumer learns the
 * catalog is gone instead of merely stopping to hear about it.
 */
export type CatalogPointer = {
  supplier_did: string;
  catalog_id: string;
  snapshot_sequence: number;
  protocol_version: string;
  published_at: string;
  /** Absent on the genesis pointer and on nothing else. */
  previous_snapshot_digest?: string;
  /**
   * Which SERVICE LISTING serves this catalog (§10.5, DR-5).
   *
   * §10.2 identifies a catalog by `catalog_id` and says nothing about the
   * listing a buyer should send a quote request to, so AppView had nowhere to
   * learn it and answered `self` for every candidate. On a supplier with one
   * listing that is right by accident; on a supplier with several — the
   * rkey-keyed model §10 assumes — it points every buyer at the wrong one.
   *
   * OPTIONAL, because `self` is the platform's documented convention for a
   * node's primary listing and requiring it would invalidate every catalog
   * published so far. Present, it is the supplier's own statement and beats
   * the convention.
   */
  service_rkey?: string;
  /** Absent when `withdrawn` is true: a tombstone names no snapshot. */
  snapshot_rkey?: string;
  snapshot_digest?: string;
  withdrawn?: boolean;
};

// ---------------------------------------------------------------------------
// Repo collections and record envelopes
// ---------------------------------------------------------------------------

/**
 * The §10.2 collection names, and the record shapes that go in them.
 *
 * THESE LIVE HERE BECAUSE BOTH SIDES ARE HERE. The publisher (`@dina/core`)
 * and the indexer (`@dina/appview`) each depend on this package and on nothing
 * of each other's, so a name spelled independently on both sides is a name
 * that can disagree — and did. The writer published the pointer to
 * `com.dinakernel.commerce.catalogPointer` while AppView's handler map, its
 * record validator and its ingest allowlist all keyed on
 * `com.dinakernel.commerce.catalog`, so every pointer this implementation ever
 * published was routed to no handler at all. Nothing caught it: the writer's
 * tests asserted against the writer's own constant, and AppView's tests fed
 * its handler hand-built fixtures that used AppView's. Both halves passed
 * while the seam between them was open.
 *
 * A shared constant is the only fix that closes the CLASS. Agreeing the two
 * literals would have closed this instance and left the next rename free to
 * reopen it.
 */
export const CATALOG_POINTER_NSID = 'com.dinakernel.commerce.catalog';
export const CATALOG_SNAPSHOT_NSID = 'com.dinakernel.commerce.catalogSnapshot';

/**
 * A snapshot record: metadata AND its pages, in one record.
 *
 * §10.3 v1 keeps pages INLINE, so the record is an envelope of two fields
 * rather than the snapshot's own fields spread flat. The writer used to spread
 * `CatalogSnapshot` directly, which put `snapshot_digest` at the top level
 * where a reader looking for `record.snapshot` found nothing — and dropped the
 * pages entirely, because a flat spread has nowhere to put them. The pages
 * were built, paginated and digested, the snapshot committed to them through
 * `payload_root`, and then they were never written down: a commitment to
 * bytes no consumer could obtain.
 */
export type CatalogSnapshotRecord = {
  snapshot: CatalogSnapshot;
  pages: readonly CatalogSnapshotPage[];
  $type: typeof CATALOG_SNAPSHOT_NSID;
};

export function catalogSnapshotRecord(
  snapshot: CatalogSnapshot,
  pages: readonly CatalogSnapshotPage[],
): CatalogSnapshotRecord {
  return { snapshot, pages, $type: CATALOG_SNAPSHOT_NSID };
}

/**
 * A pointer record: the pointer's own fields, flat, plus `$type`.
 *
 * Flat is correct here and nested is correct for the snapshot, which is
 * exactly why writing either by hand at the call site went wrong.
 */
export type CatalogPointerRecord = CatalogPointer & { $type: typeof CATALOG_POINTER_NSID };

export function catalogPointerRecord(pointer: CatalogPointer): CatalogPointerRecord {
  return { ...pointer, $type: CATALOG_POINTER_NSID };
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

function commit(kind: string, value: unknown, sha256: Sha256Fn): string {
  return bytesToHex(sha256(utf8Bytes(`${CATALOG_PREFIX}${kind}\n${canonicalJson(value)}`)));
}

/** Digest of one page, excluding its own digest field. */
export function catalogPageDigest(page: CatalogSnapshotPage, sha256: Sha256Fn): string {
  const { page_digest: _excluded, ...rest } = page;
  return commit('page', rest, sha256);
}

/**
 * The payload root: an ordered commitment over the page digests.
 *
 * Deliberately a flat ordered commitment rather than a Merkle tree. A tree
 * would let a verifier check one page against the root without the others —
 * a real benefit, but only if we also ship inclusion proofs, and §10.2 bounds
 * catalogs precisely so a consumer can fetch every page. Publishing a tree we
 * cannot prove against would advertise a guarantee the wire format does not
 * carry. A tree remains an additive change if paging ever outgrows the bound.
 */
export function catalogPayloadRoot(pageDigests: readonly string[], sha256: Sha256Fn): string {
  return commit('root', pageDigests, sha256);
}

/**
 * The CONTENT RECEIPT commitment: what a person confirmed, before publication.
 *
 * A commitment over the assembled items, their per-field provenance, and the
 * content revision they were confirmed at. Core mints it, Core keeps it, and
 * no caller ever presents one — so this is not an authenticator, it is a
 * yardstick Core measures its own stored draft against before it signs.
 *
 * IT IS IN THE CATALOG FAMILY, NOT §9.12. The ten §9.12 domains are a closed
 * vocabulary for negotiation and lifecycle RECORDS, pinned by frozen vectors.
 * This is a commitment over bytes a supplier confirmed and has a different
 * lifetime, so it takes the catalog prefix for the same reason page digests
 * and the payload root do: neither set may silently widen the other.
 *
 * WHY THE REVISION IS INSIDE THE PREIMAGE. Without it a receipt taken at
 * revision 3 and one taken at revision 5 over identical items would be the
 * same bytes, so an edit that reverted the items would leave a stale receipt
 * looking current — which is exactly the edit-during-the-pause hole the
 * revision exists to close.
 */
export function catalogContentReceiptDigest(
  args: {
    items: readonly unknown[];
    provenance: Record<string, Record<string, string>>;
    contentRevision: number;
    /**
     * Which model produced the values and against which schema (§5), or null
     * where nothing was inferred. Committed to, so the answer to "who read
     * this off the page" cannot change after a person vouched for it.
     */
    extraction?: { model: string; schemaVersion: string } | null;
    /**
     * §6.4 (TRADE_FIRST_STRATEGY) — WHO vouched: the owner DID or the staff
     * device DID, with the explicit version discriminator. Absent/null = the
     * v1 shape, whose digest bytes are frozen; present = v2 under its own
     * `content_receipt_v2` domain, dual-read at the publish check.
     */
    attribution?: { version: 2; vouched_by: string } | null;
  },
  sha256: Sha256Fn,
): string {
  const { attribution, ...v1 } = args;
  if (attribution === undefined || attribution === null) {
    return commit('content_receipt', v1, sha256);
  }
  return commit('content_receipt_v2', { ...v1, attribution }, sha256);
}

/** Digest of a snapshot record, excluding its own digest field. */
export function catalogSnapshotDigest(snapshot: CatalogSnapshot, sha256: Sha256Fn): string {
  const { snapshot_digest: _excluded, ...rest } = snapshot;
  return commit('snapshot', rest, sha256);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** A sequence is a positive, safe, whole number. Zero is not a sequence. */
function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export function validateCatalogSnapshotPage(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'page: must be an object';
  const page = value as Partial<CatalogSnapshotPage>;
  if (!isNonEmptyString(page.catalog_id)) return 'page: catalog_id is required';
  if (page.catalog_id.length > MAX_CATALOG_ID_LENGTH) return 'page: catalog_id is too long';
  if (!isSequence(page.snapshot_sequence)) return 'page: snapshot_sequence must be >= 1';
  if (
    typeof page.page_index !== 'number' ||
    !Number.isSafeInteger(page.page_index) ||
    page.page_index < 0
  ) {
    return 'page: page_index must be a non-negative integer';
  }
  if (page.page_index >= MAX_CATALOG_PAGES) return 'page: page_index exceeds the v1 page bound';
  if (!Array.isArray(page.items)) return 'page: items must be an array';
  if (page.items.length > MAX_CATALOG_PAGE_ITEMS) return 'page: too many items for one page';
  if (!isNonEmptyString(page.page_digest)) return 'page: page_digest is required';
  return null;
}

/**
 * THE SHARED PRIMITIVES, not "is it a non-empty string".
 *
 * Every other record in this package validates DIDs through `validateDid`,
 * timestamps through `validateIsoUtc`, digests through `validateHex64` and
 * versions through `validateProtocolVersionShape`. The catalog records were
 * checked only for emptiness, so this producer could publish — and
 * `rehydrateCatalogPointer` could adopt as its own head — records a stricter
 * consumer rejects. Producer/consumer divergence on a PUBLIC record is the
 * expensive kind: the supplier believes they published and the buyer sees
 * nothing.
 */
export function validateCatalogSnapshot(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'snapshot: must be an object';
  const snapshot = value as Partial<CatalogSnapshot>;
  const did = validateDid(snapshot.supplier_did, 'snapshot.supplier_did');
  if (did !== null) return did;
  const id = validateId(snapshot.catalog_id, 'snapshot.catalog_id');
  if (id !== null) return id;
  if ((snapshot.catalog_id ?? '').length > MAX_CATALOG_ID_LENGTH) {
    return 'snapshot: catalog_id is too long';
  }
  if (!isSequence(snapshot.snapshot_sequence)) return 'snapshot: snapshot_sequence must be >= 1';
  const version = validateProtocolVersionShape(
    snapshot.protocol_version,
    'snapshot.protocol_version',
  );
  if (version !== null) return version;
  const published = validateIsoUtc(snapshot.published_at, 'snapshot.published_at');
  if (published !== null) return published;
  if (!Array.isArray(snapshot.page_digests)) return 'snapshot: page_digests must be an array';
  if (snapshot.page_digests.length > MAX_CATALOG_PAGES) return 'snapshot: too many pages';
  for (const [i, digest] of snapshot.page_digests.entries()) {
    const hex = validateHex64(digest, `snapshot.page_digests[${String(i)}]`);
    if (hex !== null) return hex;
  }
  if (
    typeof snapshot.item_count !== 'number' ||
    !Number.isSafeInteger(snapshot.item_count) ||
    snapshot.item_count < 0
  ) {
    return 'snapshot: item_count must be a non-negative integer';
  }
  const root = validateHex64(snapshot.payload_root, 'snapshot.payload_root');
  if (root !== null) return root;
  const digest = validateHex64(snapshot.snapshot_digest, 'snapshot.snapshot_digest');
  if (digest !== null) return digest;
  return null;
}

export function validateCatalogPointer(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'pointer: must be an object';
  const pointer = value as Partial<CatalogPointer>;
  const did = validateDid(pointer.supplier_did, 'pointer.supplier_did');
  if (did !== null) return did;
  const id = validateId(pointer.catalog_id, 'pointer.catalog_id');
  if (id !== null) return id;
  if ((pointer.catalog_id ?? '').length > MAX_CATALOG_ID_LENGTH) {
    return 'pointer: catalog_id is too long';
  }
  if (!isSequence(pointer.snapshot_sequence)) return 'pointer: snapshot_sequence must be >= 1';
  const version = validateProtocolVersionShape(
    pointer.protocol_version,
    'pointer.protocol_version',
  );
  if (version !== null) return version;
  const published = validateIsoUtc(pointer.published_at, 'pointer.published_at');
  if (published !== null) return published;
  if (pointer.withdrawn !== undefined && typeof pointer.withdrawn !== 'boolean') {
    return 'pointer: withdrawn must be a boolean when present';
  }
  // §10.2 GENESIS COHERENCE. Sequence 1 has no predecessor to link to, and a
  // successor must name one — so a pointer whose link disagrees with its own
  // position is refused here rather than at the chain check, which only ever
  // sees PAIRS. A record fetched alone, adopted as a head, or re-read from a
  // cache never reaches that check.
  // ONE DIRECTION ONLY, and the omission is deliberate. A pointer at sequence
  // 1 has nothing to link to, so a predecessor digest on it is incoherent on
  // the record's own terms and is refused here.
  //
  // The MIRROR case — a successor that names no predecessor — belongs to
  // `verifyCatalogPointerAdvance`, which sees the PAIR and can say which link
  // is missing. Duplicating it here would also change the refusal STRING for a
  // frozen conformance vector (`genesis_must_start_at_one`), and those strings
  // are pinned precisely so two implementations do not describe the same fault
  // differently in an operator's log.
  if (pointer.snapshot_sequence === 1 && pointer.previous_snapshot_digest !== undefined) {
    // THE CHAIN VERIFIER'S OWN STRING, verbatim. The same fault caught at two
    // layers must read identically in an operator's log — a second wording
    // would make one incident look like two, and the refusal strings are
    // frozen in the conformance vectors precisely so implementations do not
    // describe a fault differently.
    return 'pointer chain: a genesis pointer has no predecessor to name';
  }
  if (pointer.previous_snapshot_digest !== undefined) {
    const prev = validateHex64(
      pointer.previous_snapshot_digest,
      'pointer.previous_snapshot_digest',
    );
    if (prev !== null) return prev;
  }
  if (pointer.service_rkey !== undefined) {
    // An RKEY like any other. Validated even on a tombstone: a withdrawal
    // that names a malformed listing is still a malformed record.
    const listing = validateId(pointer.service_rkey, 'pointer.service_rkey');
    if (listing !== null) return listing;
  }
  if (pointer.withdrawn === true) {
    // A tombstone names no snapshot — carrying one would leave consumers
    // unsure whether the catalog is live at that record.
    if (pointer.snapshot_rkey !== undefined || pointer.snapshot_digest !== undefined) {
      return 'pointer: a withdrawal must not name a snapshot';
    }
    return null;
  }
  // An RKEY, not a digest. This producer happens to use the snapshot digest
  // as the key — the record is content-addressed — but that is a PRODUCER
  // choice, and pinning it here would put one implementation's convention
  // into the wire contract that other implementations have to satisfy.
  const rkey = validateId(pointer.snapshot_rkey, 'pointer.snapshot_rkey');
  if (rkey !== null) return rkey;
  const digest = validateHex64(pointer.snapshot_digest, 'pointer.snapshot_digest');
  if (digest !== null) return digest;
  return null;
}

// ---------------------------------------------------------------------------
// Chain + payload verification
// ---------------------------------------------------------------------------

/**
 * Verify that `next` legally advances the chain from `previous`.
 *
 * `previous` is null for the genesis pointer. §10.2: AppView applies snapshots
 * in sequence order and treats a GAP or a ROLLBACK as a publication fault
 * rather than silently indexing it — so both are errors here, not warnings.
 * A repeat of the same sequence is a fork attempt and is refused for the same
 * reason: two different snapshots may not share a position in the chain.
 */
export function verifyCatalogPointerAdvance(
  previous: CatalogPointer | null,
  next: CatalogPointer,
): string | null {
  const shape = validateCatalogPointer(next);
  if (shape !== null) return shape;

  if (previous === null) {
    if (next.snapshot_sequence !== 1) {
      return 'pointer chain: a genesis pointer must start at sequence 1';
    }
    if (next.previous_snapshot_digest !== undefined) {
      return 'pointer chain: a genesis pointer has no predecessor to name';
    }
    return null;
  }

  if (next.supplier_did !== previous.supplier_did) {
    return 'pointer chain: supplier_did changed mid-chain';
  }
  if (next.catalog_id !== previous.catalog_id) {
    return 'pointer chain: catalog_id changed mid-chain';
  }
  if (previous.withdrawn === true) {
    // A withdrawal ENDS this catalog_id's chain. It names no snapshot, so
    // there is nothing for a successor to link to, and a consumer that saw
    // the tombstone has already stopped following. Relaunching means a new
    // catalog_id — which is also the honest signal, since the old identity
    // was publicly retired.
    return 'pointer chain: this catalog was withdrawn; publish under a new catalog_id';
  }
  if (next.snapshot_sequence <= previous.snapshot_sequence) {
    return 'pointer chain: sequence must advance (rollback or fork refused)';
  }
  if (next.snapshot_sequence !== previous.snapshot_sequence + 1) {
    return 'pointer chain: sequence gap — a missing snapshot is a publication fault';
  }
  // The link is to the PREVIOUS snapshot's digest. A withdrawal carries the
  // next sequence and still names what it withdrew, which is what lets a
  // consumer confirm it tombstoned the catalog it was following.
  if (next.previous_snapshot_digest !== previous.snapshot_digest) {
    return 'pointer chain: previous_snapshot_digest does not match the prior pointer';
  }
  return null;
}

/**
 * Verify a snapshot against its own commitments: the payload root must be
 * recomputable from the page digests, and the record digest from the record.
 */
export function verifyCatalogSnapshot(snapshot: CatalogSnapshot, sha256: Sha256Fn): string | null {
  const shape = validateCatalogSnapshot(snapshot);
  if (shape !== null) return shape;
  if (catalogPayloadRoot(snapshot.page_digests, sha256) !== snapshot.payload_root) {
    return 'snapshot: payload_root does not commit to these page digests';
  }
  if (catalogSnapshotDigest(snapshot, sha256) !== snapshot.snapshot_digest) {
    return 'snapshot: snapshot_digest does not match the record';
  }
  return null;
}

/**
 * The bounded-page proof: a fetched page belongs to this snapshot, at this
 * position.
 *
 * `page_index` is inside the page digest, so a page declares its own slot and
 * the commitment covers it. To be precise about what that buys: it is a
 * CORRECTNESS binding, not an attack mitigation. Pages with different content
 * already have different digests, so a reorder of those is caught by content
 * alone; pages with identical content are interchangeable by definition, so
 * swapping them changes nothing a consumer could observe. What the binding
 * gives is that a page record cannot be served from a slot it does not claim,
 * which keeps the record self-describing rather than context-dependent.
 */
export function verifyCatalogPage(
  page: CatalogSnapshotPage,
  snapshot: CatalogSnapshot,
  sha256: Sha256Fn,
): string | null {
  const shape = validateCatalogSnapshotPage(page);
  if (shape !== null) return shape;
  if (page.catalog_id !== snapshot.catalog_id) {
    return 'page: belongs to a different catalog';
  }
  if (page.snapshot_sequence !== snapshot.snapshot_sequence) {
    return 'page: belongs to a different snapshot sequence';
  }
  const expected = snapshot.page_digests[page.page_index];
  if (expected === undefined) {
    return 'page: page_index is outside this snapshot';
  }
  if (catalogPageDigest(page, sha256) !== expected) {
    return 'page: content does not match the digest this snapshot commits to';
  }
  if (page.page_digest !== expected) {
    return 'page: page_digest field disagrees with the snapshot';
  }
  return null;
}
