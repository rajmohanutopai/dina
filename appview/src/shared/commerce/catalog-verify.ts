import { createHash } from 'node:crypto'

/**
 * The §10.2 catalog trust chain, verified AppView-side (FR-A1, FR-A2).
 *
 *     supplier repo proof
 *       -> current snapshot pointer
 *       -> immutable snapshot metadata
 *       -> canonical payload digest/root
 *       -> bounded catalog pages
 *
 * Every hop is recomputable here, so the feed host is transport and never
 * authority: a modified page fails its digest, a swapped payload fails the
 * root, a forged pointer fails the chain.
 *
 * WHY A SECOND IMPLEMENTATION, AND WHY THAT IS NOT DUPLICATION-BY-ACCIDENT.
 * `@dina/commerce-protocol` owns this contract, and AppView cannot depend on
 * it: AppView is deployed standalone with its own lockfile and Dockerfile, and
 * the same boundary is why the capability registry is physically duplicated.
 * Copying the module verbatim is not available either — commerce-protocol uses
 * extensionless relative imports and AppView runs Node ESM, where those fail
 * at runtime while passing under vitest's bundler resolution. That combination
 * (green tests, broken production) is worse than either alternative.
 *
 * So this is an independent implementation, and the thing that keeps it honest
 * is the FROZEN CONFORMANCE VECTORS. `catalog.json` pins the page digests, the
 * payload root, the snapshot digest, and every chain refusal STRING; the unit
 * test runs this code against that file. Those vectors exist precisely so a
 * port can be checked rather than trusted, and this is the first real port —
 * if the vectors are not enough to keep two implementations agreeing, that is
 * a finding about the vectors, and better learnt here than in a Rust client.
 *
 * WHAT IS DELIBERATELY NOT HERE. Record SHAPE validation lives in AppView's
 * own zod validator alongside every other collection. Divergence there is
 * fail-closed and harmless — AppView refusing a record the protocol would
 * accept means it is not indexed — whereas divergence in the digest math or
 * the chain rules would mean AppView indexing something no other implementation
 * considers valid. Only the second kind is pinned here.
 */

/** Domain separation for §10 content commitments. Distinct from §9.12. */
const CATALOG_PREFIX = 'dina:commerce:catalog:v1:'

/** §10.2 bounds, so a fetcher caps its work before trusting anything. */
export const MAX_CATALOG_PAGE_ITEMS = 500
export const MAX_CATALOG_PAGES = 1000
export const MAX_CATALOG_ID_LENGTH = 128

export interface CatalogSnapshotPage {
  catalog_id: string
  snapshot_sequence: number
  page_index: number
  items: unknown[]
  page_digest: string
}

export interface CatalogSnapshot {
  supplier_did: string
  catalog_id: string
  snapshot_sequence: number
  protocol_version: string
  published_at: string
  page_digests: string[]
  item_count: number
  payload_root: string
  snapshot_digest: string
}

export interface CatalogPointer {
  supplier_did: string
  catalog_id: string
  snapshot_sequence: number
  protocol_version: string
  published_at: string
  /**
   * Which service listing serves this catalog (§10.5, DR-5). Mirrors
   * `@dina/commerce-protocol`'s `CatalogPointer`, which AppView keeps a copy
   * of rather than importing — so this field has to be added in both places
   * or discovery silently keeps answering `self`.
   */
  service_rkey?: string
  snapshot_rkey?: string
  snapshot_digest?: string
  previous_snapshot_digest?: string
  withdrawn?: boolean
}

/**
 * JCS-style canonical JSON: keys sorted by code unit, no insignificant
 * whitespace, `undefined` properties dropped so an absent optional field and
 * a missing key canonicalize identically. Non-finite numbers throw rather than
 * coerce — a digest input that needed coercion is a bug upstream.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number')
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

function commit(kind: string, value: unknown): string {
  return createHash('sha256')
    .update(`${CATALOG_PREFIX}${kind}\n${canonicalJson(value)}`, 'utf8')
    .digest('hex')
}

/** Digest of one page, excluding its own digest field. */
export function catalogPageDigest(page: CatalogSnapshotPage): string {
  const { page_digest: _excluded, ...rest } = page
  return commit('page', rest)
}

/** An ordered commitment over the page digests — flat, not a Merkle tree. */
export function catalogPayloadRoot(pageDigests: readonly string[]): string {
  return commit('root', pageDigests)
}

/** Digest of a snapshot record, excluding its own digest field. */
export function catalogSnapshotDigest(snapshot: CatalogSnapshot): string {
  const { snapshot_digest: _excluded, ...rest } = snapshot
  return commit('snapshot', rest)
}

/**
 * Verify that `next` legally advances the chain from `previous`.
 *
 * `previous` is null for the genesis pointer. §10.2: AppView applies snapshots
 * in sequence order and treats a GAP or a ROLLBACK as a publication fault
 * rather than silently indexing it — so both are errors here, not warnings. A
 * repeat of the same sequence is a fork attempt and is refused for the same
 * reason: two different snapshots may not share a position in the chain.
 *
 * The refusal STRINGS are frozen in the conformance vectors. Two
 * implementations rejecting a rollback for differently-worded reasons diverge
 * the first time an operator reads a log across both.
 */
export function verifyCatalogPointerAdvance(
  previous: CatalogPointer | null,
  next: CatalogPointer,
): string | null {
  if (previous === null) {
    if (next.snapshot_sequence !== 1) {
      return 'pointer chain: a genesis pointer must start at sequence 1'
    }
    if (next.previous_snapshot_digest !== undefined) {
      return 'pointer chain: a genesis pointer has no predecessor to name'
    }
    return null
  }

  if (next.supplier_did !== previous.supplier_did) {
    return 'pointer chain: supplier_did changed mid-chain'
  }
  if (next.catalog_id !== previous.catalog_id) {
    return 'pointer chain: catalog_id changed mid-chain'
  }
  if (previous.withdrawn === true) {
    // A withdrawal ENDS this catalog_id's chain. It names no snapshot, so
    // there is nothing for a successor to link to, and a consumer that saw
    // the tombstone has already stopped following.
    return 'pointer chain: this catalog was withdrawn; publish under a new catalog_id'
  }
  if (next.snapshot_sequence <= previous.snapshot_sequence) {
    return 'pointer chain: sequence must advance (rollback or fork refused)'
  }
  if (next.snapshot_sequence !== previous.snapshot_sequence + 1) {
    return 'pointer chain: sequence gap — a missing snapshot is a publication fault'
  }
  if (next.previous_snapshot_digest !== previous.snapshot_digest) {
    return 'pointer chain: previous_snapshot_digest does not match the prior pointer'
  }
  return null
}

/**
 * Verify a snapshot against its own commitments, and against the caps.
 *
 * The caps are checked HERE rather than only at fetch time (FR-A2): a snapshot
 * naming ten thousand pages is a publication fault whatever transport carried
 * it, and refusing it before the fetcher starts is the difference between
 * bounded work and a bill.
 */
export function verifyCatalogSnapshot(snapshot: CatalogSnapshot): string | null {
  if (snapshot.page_digests.length > MAX_CATALOG_PAGES) {
    return 'snapshot: exceeds the maximum page count'
  }
  if (snapshot.catalog_id.length > MAX_CATALOG_ID_LENGTH) {
    return 'snapshot: catalog_id is too long'
  }
  if (catalogPayloadRoot(snapshot.page_digests) !== snapshot.payload_root) {
    return 'snapshot: payload_root does not commit to these page digests'
  }
  if (catalogSnapshotDigest(snapshot) !== snapshot.snapshot_digest) {
    return 'snapshot: snapshot_digest does not match the record'
  }
  return null
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
  if (page.items.length > MAX_CATALOG_PAGE_ITEMS) {
    return 'page: exceeds the maximum item count'
  }
  if (page.catalog_id !== snapshot.catalog_id) {
    return 'page: belongs to a different catalog'
  }
  if (page.snapshot_sequence !== snapshot.snapshot_sequence) {
    return 'page: belongs to a different snapshot sequence'
  }
  const expected = snapshot.page_digests[page.page_index]
  if (expected === undefined) {
    return 'page: page_index is outside this snapshot'
  }
  if (catalogPageDigest(page) !== expected) {
    return 'page: content does not match the digest this snapshot commits to'
  }
  if (page.page_digest !== expected) {
    return 'page: page_digest field disagrees with the snapshot'
  }
  return null
}

/**
 * Verify a pointer against the snapshot it names.
 *
 * A pointer and a snapshot can each be internally valid and still not belong
 * together, which is the whole reason the pointer carries the digest: without
 * this check a supplier could advance the chain while serving last week's
 * catalog, and every individual record would verify.
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
 * The whole chain in one call: pointer advance, snapshot commitments, the
 * binding between them, and every page.
 *
 * Composed here rather than left to each caller, because the ORDER is part of
 * the guarantee — checking pages before confirming the pointer names this
 * snapshot would spend the fetch budget on a catalog the supplier is not
 * currently publishing — and because a caller that forgot one hop would still
 * look like it verified.
 */
/**
 * Every committed page present EXACTLY ONCE.
 *
 * Per-page verification asks "does this page belong to this snapshot, at the
 * slot it claims?" — a question each page answers about itself. Nothing asked
 * whether the pages TOGETHER cover the snapshot, so serving page 0 twice passed:
 * the count matched, both pages verified at index 0, and when the duplicated
 * page happened to carry the same number of items as the one it displaced, the
 * total matched too. A committed page was simply never presented, and the
 * catalog projected was not the catalog published.
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
