/**
 * Photo-commerce frozen shapes (PHOTO_COMMERCE_LANES_DESIGN §2.1).
 *
 * Five commitments the photo lanes mint, pinned here BEFORE any screen is
 * built, because prose commitments hash nothing:
 *
 *   - the EXTRACTION COMMITMENT, one kind under each lane's domain;
 *   - the CATALOG EXTRACTION BINDING, the chain link the catalog lane needs
 *     because its shipped content-receipt preimage cannot be widened;
 *   - the order lane's BATCH VOUCH RECEIPT;
 *   - the CONVERSATION SNAPSHOT;
 *   - the APPROVAL SOURCE BINDING and the CATALOG EVIDENCE RECORD shapes.
 *
 * WHY THE COMMITMENTS ARE CHAINED, not merely adjacent. Three commitments
 * that each verify alone prove nothing about belonging together: an
 * extraction commitment from draft A recomputes perfectly beside draft B's
 * vouch. So the extraction commitment carries the `draft_id` in its
 * preimage, the vouch receipt commits the extraction digest, and the
 * catalog lane gets the separately versioned binding record — checked at
 * confirm, prepare and publish. "Provably shows which photograph produced
 * the rows" is true BECAUSE of this chain and was false without it.
 *
 * WHY THESE ARE NOT §9.12 DIGEST DOMAINS. The ten frozen domains are a
 * closed vocabulary for negotiation and lifecycle RECORDS that cross the
 * wire between businesses. These are commitments over draft content a
 * person vouched for, local evidence with a different lifetime — the same
 * reasoning that keeps §10.2's page digests and the approval payload out
 * of §9.12. Each lane gets its own prefix so neither set can silently
 * widen the other.
 */

import { bytesToHex, canonicalJson, utf8Bytes } from './canonical';
import { CATALOG_POINTER_NSID, verifyCatalogPage, verifyCatalogSnapshot } from './catalog_publication';
import { validateDid, validateHex64, validateId } from './common';
import { validateProductRef } from './product';
import { validateQuantity } from './quantity';

import type { CatalogPointer, CatalogSnapshot, CatalogSnapshotPage } from './catalog_publication';
import type { Sha256Fn } from './digests';
import type { ProductRef } from './product';
import type { Quantity } from './quantity';

// ---------------------------------------------------------------------------
// Domains and bounds
// ---------------------------------------------------------------------------

/** The catalog lane's content-commitment family — §10.2's own prefix. */
const CATALOG_PREFIX = 'dina:commerce:catalog:v1:';
/** The order-draft lane's family, minted by this design. */
const ORDER_DRAFT_PREFIX = 'dina:commerce:order_draft:v1:';

/** The two extraction schemas the seam speaks (§3). A closed set on purpose. */
export const EXTRACTION_SCHEMA_CATALOG = 'catalog-rows-1';
export const EXTRACTION_SCHEMA_ORDER = 'order-lines-1';
export const EXTRACTION_SCHEMAS = [EXTRACTION_SCHEMA_CATALOG, EXTRACTION_SCHEMA_ORDER] as const;
export type ExtractionSchemaId = (typeof EXTRACTION_SCHEMAS)[number];

/**
 * v1 bounds. Pages are photographs of a price list or an order page, not a
 * scanned archive; rows are bounded by what fits on those pages. The ingest
 * boundary (§6) enforces bytes and decode caps — these bound the SHAPES so
 * a verifier can cap work before trusting, the same reason catalog pages
 * are bounded.
 */
export const MAX_EXTRACTION_PAGES = 16;
export const MAX_EXTRACTED_ROWS = 2000;
export const MAX_VOUCHED_LINES = 500;
export const MAX_DRAFT_REQUIREMENTS = 64;

const LANE_PREFIX = {
  catalog: CATALOG_PREFIX,
  order: ORDER_DRAFT_PREFIX,
} as const;

export type PhotoDraftLane = keyof typeof LANE_PREFIX;

function commitUnder(lane: PhotoDraftLane, kind: string, value: unknown, sha256: Sha256Fn): string {
  return bytesToHex(sha256(utf8Bytes(`${LANE_PREFIX[lane]}${kind}\n${canonicalJson(value)}`)));
}

// ---------------------------------------------------------------------------
// Extraction commitment
// ---------------------------------------------------------------------------

/** One page of the ordered manifest capture produced (§4.1). */
export interface ExtractionManifestPage {
  artifact_id: string;
  /** sha-256 of the stored, EXIF-stripped page bytes. */
  content_hash: string;
  /** 0-based position in the capture order. */
  page_index: number;
}

/**
 * One extracted row with its identity. `row` is numbered CONTINUOUSLY across
 * pages in page order, data from row 2 — the CSV convention the importer
 * already speaks, pinned in §4.1 so `row` means one thing in findings,
 * repairs and receipts whether the source was one page or five.
 */
export interface ExtractedRowCommitment {
  page_index: number;
  row: number;
  /** The raw extracted row, exactly as the seam returned it. */
  content: unknown;
}

/**
 * The extraction commitment: which photograph produced which rows, for
 * WHICH DRAFT. The `draft_id` is in the preimage because without it the
 * commitment floats free of the draft it describes.
 */
export interface ExtractionCommitment {
  draft_id: string;
  /** The ordered manifest, whole — never "the image's" hash. */
  manifest: readonly ExtractionManifestPage[];
  schema_id: string;
  model: string;
  rows: readonly ExtractedRowCommitment[];
}

export function validateExtractionCommitment(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'extraction: must be an object';
  const c = value as Partial<ExtractionCommitment>;
  const draft = validateId(c.draft_id, 'extraction.draft_id');
  if (draft !== null) return draft;
  if (!Array.isArray(c.manifest)) return 'extraction: manifest must be an array';
  if (c.manifest.length === 0) return 'extraction: manifest must name at least one page';
  if (c.manifest.length > MAX_EXTRACTION_PAGES) return 'extraction: too many pages';
  for (const [i, entry] of c.manifest.entries()) {
    const page = entry as Partial<ExtractionManifestPage>;
    const id = validateId(page.artifact_id, `extraction.manifest[${String(i)}].artifact_id`);
    if (id !== null) return id;
    const hash = validateHex64(page.content_hash, `extraction.manifest[${String(i)}].content_hash`);
    if (hash !== null) return hash;
    // The manifest is ORDERED and the order is the commitment: entry i IS
    // page i, so an index that disagrees with its position is a record
    // that contradicts itself.
    if (page.page_index !== i) {
      return `extraction.manifest[${String(i)}]: page_index must equal its position`;
    }
  }
  if (!(EXTRACTION_SCHEMAS as readonly string[]).includes(c.schema_id ?? '')) {
    return 'extraction: schema_id must be a known extraction schema';
  }
  if (typeof c.model !== 'string' || c.model === '') return 'extraction: model is required';
  if (!Array.isArray(c.rows)) return 'extraction: rows must be an array';
  if (c.rows.length > MAX_EXTRACTED_ROWS) return 'extraction: too many rows';
  for (const [i, entry] of c.rows.entries()) {
    const row = entry as Partial<ExtractedRowCommitment>;
    if (
      typeof row.page_index !== 'number' ||
      !Number.isSafeInteger(row.page_index) ||
      row.page_index < 0 ||
      row.page_index >= c.manifest.length
    ) {
      return `extraction.rows[${String(i)}]: page_index must name a manifest page`;
    }
    // Data rows start at 2 (row 1 is the header, §4.1's CSV convention).
    if (typeof row.row !== 'number' || !Number.isSafeInteger(row.row) || row.row < 2) {
      return `extraction.rows[${String(i)}]: row must be an integer >= 2`;
    }
    if (!('content' in row)) return `extraction.rows[${String(i)}]: content is required`;
  }
  return null;
}

/**
 * Digest under the LANE's domain. The same commitment digested for the
 * catalog lane and the order lane yields two different hashes — a
 * cross-lane vector pins this, for the same reason a quote digest can
 * never collide with an order digest.
 */
export function extractionCommitmentDigest(
  lane: PhotoDraftLane,
  commitment: ExtractionCommitment,
  sha256: Sha256Fn,
): string {
  return commitUnder(lane, 'extraction_commitment', commitment, sha256);
}

// ---------------------------------------------------------------------------
// Catalog extraction binding
// ---------------------------------------------------------------------------

/**
 * The catalog lane's chain link. `catalogContentReceiptDigest`'s shipped
 * preimage cannot be widened — a widened preimage breaks every receipt
 * across the change — so the binding is a SEPARATELY VERSIONED record
 * beside it: this draft, at this content revision, was extracted under
 * this commitment. Checked at confirm, prepare and publish.
 */
export interface CatalogExtractionBinding {
  binding_version: 1;
  draft_id: string;
  content_revision: number;
  extraction_digest: string;
}

export function validateCatalogExtractionBinding(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'binding: must be an object';
  const b = value as Partial<CatalogExtractionBinding>;
  if (b.binding_version !== 1) return 'binding: binding_version must be 1';
  const draft = validateId(b.draft_id, 'binding.draft_id');
  if (draft !== null) return draft;
  if (
    typeof b.content_revision !== 'number' ||
    !Number.isSafeInteger(b.content_revision) ||
    b.content_revision < 0
  ) {
    return 'binding: content_revision must be a non-negative integer';
  }
  return validateHex64(b.extraction_digest, 'binding.extraction_digest');
}

export function catalogExtractionBindingDigest(
  binding: CatalogExtractionBinding,
  sha256: Sha256Fn,
): string {
  return commitUnder('catalog', 'extraction_binding', binding, sha256);
}

// ---------------------------------------------------------------------------
// Batch vouch receipt (order lane)
// ---------------------------------------------------------------------------

/** A line as a confirm ceremony vouched it. */
export interface VouchedLine {
  line_id: string;
  generation: number;
  quantity: Quantity;
  resolved_product: ProductRef;
  supplier_did: string;
}

/**
 * A requirement as vouched or explicitly omitted. `omitted: true` carries
 * `value: null` — "value | omitted" is one field pair, not two optional
 * fields free to disagree.
 */
export interface VouchedRequirement {
  key: string;
  omitted: boolean;
  value: unknown;
  generation: number;
}

/**
 * WHO vouched (TRADE_FIRST_STRATEGY §6.4) — the owner DID or the staff
 * device DID. The version discriminator is EXPLICIT and fixed at 2: v1
 * is the shipped unversioned shape (no attribution field at all), and a
 * shape that carries the field must say which version it claims, so a
 * future v3 cannot be smuggled in as "attribution present".
 */
export interface VouchAttribution {
  version: 2;
  vouched_by: string;
}

/**
 * The batch vouch receipt a confirm ceremony mints (§5.1). The ceremony
 * counter is the per-draft monotonic integer bumped ONLY by confirm
 * ceremonies — that definition, not a reinvention. The extraction digest
 * is in the preimage: the chain that makes the vouch provably about THESE
 * photographed rows.
 *
 * `attribution` absent = the v1 shape, whose digest bytes are frozen;
 * present = v2, which commits under its OWN domain (`vouch_receipt_v2`)
 * so the two families can never collide and a stripped attribution
 * changes the digest twice over (§6.4).
 */
export interface VouchReceipt {
  draft_id: string;
  ceremony: number;
  extraction_digest: string;
  lines: readonly VouchedLine[];
  requirements: readonly VouchedRequirement[];
  attribution?: VouchAttribution;
}

/** Shared §6.4 attribution check — vouch receipts and content receipts. */
export function validateVouchAttribution(value: unknown, field: string): string | null {
  if (value === null || typeof value !== 'object') return `${field}: must be an object`;
  const a = value as Partial<VouchAttribution>;
  if (a.version !== 2) return `${field}: version must be exactly 2`;
  return validateDid(a.vouched_by, `${field}.vouched_by`);
}

function validateVouchedRequirement(value: unknown, field: string): string | null {
  if (value === null || typeof value !== 'object') return `${field}: must be an object`;
  const r = value as Partial<VouchedRequirement>;
  if (typeof r.key !== 'string' || r.key === '') return `${field}: key is required`;
  if (typeof r.omitted !== 'boolean') return `${field}: omitted must be a boolean`;
  if (r.omitted && r.value !== null) return `${field}: an omitted requirement carries value null`;
  if (!('value' in r)) return `${field}: value is required (null when omitted)`;
  if (typeof r.generation !== 'number' || !Number.isSafeInteger(r.generation) || r.generation < 0) {
    return `${field}: generation must be a non-negative integer`;
  }
  return null;
}

export function validateVouchReceipt(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'vouch: must be an object';
  const v = value as Partial<VouchReceipt>;
  const draft = validateId(v.draft_id, 'vouch.draft_id');
  if (draft !== null) return draft;
  if (typeof v.ceremony !== 'number' || !Number.isSafeInteger(v.ceremony) || v.ceremony < 1) {
    return 'vouch: ceremony must be a positive integer';
  }
  const extraction = validateHex64(v.extraction_digest, 'vouch.extraction_digest');
  if (extraction !== null) return extraction;
  if (!Array.isArray(v.lines)) return 'vouch: lines must be an array';
  if (v.lines.length === 0) return 'vouch: a ceremony vouches at least one line';
  if (v.lines.length > MAX_VOUCHED_LINES) return 'vouch: too many lines';
  for (const [i, entry] of v.lines.entries()) {
    const line = entry as Partial<VouchedLine>;
    const id = validateId(line.line_id, `vouch.lines[${String(i)}].line_id`);
    if (id !== null) return id;
    if (
      typeof line.generation !== 'number' ||
      !Number.isSafeInteger(line.generation) ||
      line.generation < 0
    ) {
      return `vouch.lines[${String(i)}]: generation must be a non-negative integer`;
    }
    const quantity = validateQuantity(line.quantity);
    if (quantity !== null) return `vouch.lines[${String(i)}].quantity: ${quantity}`;
    const product = validateProductRef(line.resolved_product);
    if (product !== null) return `vouch.lines[${String(i)}].resolved_product: ${product}`;
    const did = validateDid(line.supplier_did, `vouch.lines[${String(i)}].supplier_did`);
    if (did !== null) return did;
  }
  if (!Array.isArray(v.requirements)) return 'vouch: requirements must be an array';
  if (v.requirements.length > MAX_DRAFT_REQUIREMENTS) return 'vouch: too many requirements';
  for (const [i, entry] of v.requirements.entries()) {
    const bad = validateVouchedRequirement(entry, `vouch.requirements[${String(i)}]`);
    if (bad !== null) return bad;
  }
  if ('attribution' in v && v.attribution !== undefined) {
    const bad = validateVouchAttribution(v.attribution, 'vouch.attribution');
    if (bad !== null) return bad;
  }
  return null;
}

/**
 * §6.4 dual-read: an unattributed receipt digests under the shipped v1
 * domain with the shipped bytes — nothing already stored moves — and an
 * attributed one under its own `vouch_receipt_v2` domain. The rest
 * destructure guards the v1 bytes even against a caller that passed
 * `attribution: undefined` explicitly.
 */
export function vouchReceiptDigest(receipt: VouchReceipt, sha256: Sha256Fn): string {
  const { attribution, ...v1 } = receipt;
  if (attribution === undefined) return commitUnder('order', 'vouch_receipt', v1, sha256);
  return commitUnder('order', 'vouch_receipt_v2', receipt, sha256);
}

// ---------------------------------------------------------------------------
// Conversation snapshot
// ---------------------------------------------------------------------------

/** A line as a conversation snapshotted it at send. */
export interface ConversationSnapshotLine {
  line_id: string;
  generation: number;
  vouch_receipt_digest: string;
}

/**
 * The conversation snapshot — what "snapshot digest" MEANS everywhere the
 * design says it, including in the approval source binding. Maps digest in
 * sorted-key order, lists in stated order: `canonicalJson`'s own rules,
 * the same discipline as every §9.12 digest.
 */
export interface ConversationSnapshot {
  draft_id: string;
  conversation_id: string;
  supplier_did: string;
  request_digest: string;
  lines: readonly ConversationSnapshotLine[];
  requirements: readonly VouchedRequirement[];
}

export function validateConversationSnapshot(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'snapshot: must be an object';
  const s = value as Partial<ConversationSnapshot>;
  const draft = validateId(s.draft_id, 'snapshot.draft_id');
  if (draft !== null) return draft;
  const conversation = validateId(s.conversation_id, 'snapshot.conversation_id');
  if (conversation !== null) return conversation;
  const did = validateDid(s.supplier_did, 'snapshot.supplier_did');
  if (did !== null) return did;
  const request = validateHex64(s.request_digest, 'snapshot.request_digest');
  if (request !== null) return request;
  if (!Array.isArray(s.lines)) return 'snapshot: lines must be an array';
  if (s.lines.length === 0) return 'snapshot: a conversation carries at least one line';
  if (s.lines.length > MAX_VOUCHED_LINES) return 'snapshot: too many lines';
  for (const [i, entry] of s.lines.entries()) {
    const line = entry as Partial<ConversationSnapshotLine>;
    const id = validateId(line.line_id, `snapshot.lines[${String(i)}].line_id`);
    if (id !== null) return id;
    if (
      typeof line.generation !== 'number' ||
      !Number.isSafeInteger(line.generation) ||
      line.generation < 0
    ) {
      return `snapshot.lines[${String(i)}]: generation must be a non-negative integer`;
    }
    const vouch = validateHex64(
      line.vouch_receipt_digest,
      `snapshot.lines[${String(i)}].vouch_receipt_digest`,
    );
    if (vouch !== null) return vouch;
  }
  if (!Array.isArray(s.requirements)) return 'snapshot: requirements must be an array';
  if (s.requirements.length > MAX_DRAFT_REQUIREMENTS) return 'snapshot: too many requirements';
  for (const [i, entry] of s.requirements.entries()) {
    const bad = validateVouchedRequirement(entry, `snapshot.requirements[${String(i)}]`);
    if (bad !== null) return bad;
  }
  return null;
}

export function conversationSnapshotDigest(
  snapshot: ConversationSnapshot,
  sha256: Sha256Fn,
): string {
  return commitUnder('order', 'conversation_snapshot', snapshot, sha256);
}

// ---------------------------------------------------------------------------
// Approval source binding
// ---------------------------------------------------------------------------

/** The one origin v1 mints. A closed set: unknown origins fail hydration. */
export const APPROVAL_ORIGIN_PHOTO_ORDER_DRAFT = 'photo_order_draft';

/**
 * The additive source binding a photo-minted approval carries — INSIDE the
 * approval payload, so it lands inside the approval's integrity digest and
 * a stripped or altered binding changes the digest the approval was minted
 * under. "Absent = legacy" failed open (a corrupted photo approval would
 * hydrate as legacy and take the unrestricted path); the discriminator is
 * the versioned `origin` field, and hydration of a photo approval requires
 * EVERY field here present, fail-closed, at hydration and again at submit.
 */
export interface ApprovalSourceBinding {
  origin: typeof APPROVAL_ORIGIN_PHOTO_ORDER_DRAFT;
  binding_version: 1;
  draft_id: string;
  conversation_id: string;
  assignment_generations: readonly { line_id: string; generation: number }[];
  requirement_generations: readonly { key: string; generation: number }[];
  snapshot_digest: string;
}

export function validateApprovalSourceBinding(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'source: must be an object';
  const b = value as Partial<ApprovalSourceBinding>;
  if (b.origin !== APPROVAL_ORIGIN_PHOTO_ORDER_DRAFT) {
    return 'source: origin must be photo_order_draft';
  }
  if (b.binding_version !== 1) return 'source: binding_version must be 1';
  const draft = validateId(b.draft_id, 'source.draft_id');
  if (draft !== null) return draft;
  const conversation = validateId(b.conversation_id, 'source.conversation_id');
  if (conversation !== null) return conversation;
  if (!Array.isArray(b.assignment_generations)) {
    return 'source: assignment_generations must be an array';
  }
  if (b.assignment_generations.length === 0) {
    return 'source: assignment_generations must name at least one line';
  }
  for (const [i, entry] of b.assignment_generations.entries()) {
    const pair = entry as Partial<{ line_id: string; generation: number }>;
    const id = validateId(pair.line_id, `source.assignment_generations[${String(i)}].line_id`);
    if (id !== null) return id;
    if (
      typeof pair.generation !== 'number' ||
      !Number.isSafeInteger(pair.generation) ||
      pair.generation < 0
    ) {
      return `source.assignment_generations[${String(i)}]: generation must be a non-negative integer`;
    }
  }
  if (!Array.isArray(b.requirement_generations)) {
    return 'source: requirement_generations must be an array';
  }
  for (const [i, entry] of b.requirement_generations.entries()) {
    const pair = entry as Partial<{ key: string; generation: number }>;
    if (typeof pair.key !== 'string' || pair.key === '') {
      return `source.requirement_generations[${String(i)}]: key is required`;
    }
    if (
      typeof pair.generation !== 'number' ||
      !Number.isSafeInteger(pair.generation) ||
      pair.generation < 0
    ) {
      return `source.requirement_generations[${String(i)}]: generation must be a non-negative integer`;
    }
  }
  return validateHex64(b.snapshot_digest, 'source.snapshot_digest');
}

// ---------------------------------------------------------------------------
// Catalog evidence record
// ---------------------------------------------------------------------------

/**
 * The per-resolved-line retention (§5.1): enough to recompute page digest →
 * payload root → snapshot digest, PLUS the authenticated pointer with its
 * CID and repo context — because a chain that only recomputes proves
 * self-consistency, not that the named supplier published it. A fabricated
 * pointer→snapshot→page→item chain recomputes perfectly for any
 * `supplier_did` an attacker writes into it.
 */
export interface CatalogEvidenceRecord {
  /** Authority context. Verified FIRST at hydration, before any digest. */
  repo_did: string;
  collection: string;
  rkey: string;
  pointer_cid: string;
  pointer: CatalogPointer;
  /** The digest-chain material. `snapshot.page_digests` is the page list. */
  snapshot: CatalogSnapshot;
  page: CatalogSnapshotPage;
}

/**
 * What Core must be handed to verify AUTHORITY — that the retained pointer
 * really is the record the named supplier's repo published at this
 * collection/rkey with this CID. The protocol package does no I/O, so the
 * verifier is injected; hydration calls it BEFORE the coherence chain and
 * fails closed on false or on a throw.
 */
export type CatalogPointerAuthorityVerifier = (args: {
  repo_did: string;
  collection: string;
  rkey: string;
  pointer_cid: string;
  pointer: CatalogPointer;
}) => Promise<boolean>;

/**
 * The PURE half of evidence verification, ordered as hydration must order
 * it: authority COHERENCE first (the record's own claims agree about who
 * published what, where), then the digest chain. The authenticity of the
 * pointer itself — repo fetch, CID comparison — is the injected verifier's
 * duty and runs before this in Core's hydration.
 */
export function verifyCatalogEvidenceRecord(
  record: CatalogEvidenceRecord,
  sha256: Sha256Fn,
): string | null {
  // Authority coherence. A record whose pointer claims a different supplier
  // than the repo that allegedly holds it is refused before any digest is
  // computed — the forged-supplier shape.
  const repo = validateDid(record.repo_did, 'evidence.repo_did');
  if (repo !== null) return repo;
  if (record.collection !== CATALOG_POINTER_NSID) {
    return 'evidence: collection is not the catalog pointer collection';
  }
  const rkey = validateId(record.rkey, 'evidence.rkey');
  if (rkey !== null) return rkey;
  const cid = validateId(record.pointer_cid, 'evidence.pointer_cid');
  if (cid !== null) return cid;
  if (record.pointer.supplier_did !== record.repo_did) {
    return 'evidence: pointer supplier does not match the publishing repo';
  }
  if (record.pointer.withdrawn === true) {
    return 'evidence: pointer is a withdrawal and names no snapshot';
  }
  if (record.snapshot.supplier_did !== record.pointer.supplier_did) {
    return 'evidence: snapshot supplier does not match the pointer';
  }
  if (record.snapshot.catalog_id !== record.pointer.catalog_id) {
    return 'evidence: snapshot catalog does not match the pointer';
  }
  if (record.pointer.snapshot_digest !== record.snapshot.snapshot_digest) {
    return 'evidence: pointer names a different snapshot';
  }
  // The digest chain: snapshot digest + payload root recompute, then the
  // page proves membership at its index.
  const snapshot = verifyCatalogSnapshot(record.snapshot, sha256);
  if (snapshot !== null) return snapshot;
  return verifyCatalogPage(record.page, record.snapshot, sha256);
}
