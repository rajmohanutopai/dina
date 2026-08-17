/**
 * The photo-catalog lane's durable state (§6, §10 item 8).
 *
 * ONE ROW IS ONE PUBLICATION ATTEMPT, from extracted rows to a published
 * pointer. It exists because the lane suspends twice on a human — at confirm
 * and again at the snapshot review — and anything held in memory across those
 * pauses is lost to an app restart. Losing the built snapshot is not a delay:
 * a rebuild re-mints `published_at`, which changes `snapshot_digest`, which
 * means the bytes published are not the bytes the owner approved. That is the
 * exact failure the approval exists to prevent, so the state has to be durable
 * or the approval is theatre.
 *
 * WHAT `contentRevision` COUNTS, precisely, because the whole
 * edit-during-the-pause defence rests on it: the draft's CONTENT — rows,
 * findings, per-field provenance, assembled items. Core's own bookkeeping
 * writes do not bump it. Storing the receipt, the held snapshot, the CAS value
 * or the approval leaves it alone, because a revision that its own writer
 * bumped would invalidate every publication the moment `prepare` returned.
 *
 * The receipt, the held bytes and the approval each record the revision they
 * were taken at, and publication requires all of them to EQUAL the draft's
 * current one. Not "not earlier than" — that permits a receipt from a LATER
 * revision, which is precisely the hole: a seller edits during the pause,
 * re-confirms, and the fresh receipt sits beside pre-edit held bytes.
 */

import { validateCatalogExtractionBinding, validateCatalogItem } from '@dina/commerce-protocol';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';
import type {
  CatalogExtractionBinding,
  CatalogItem,
  CatalogPointer,
  CatalogSnapshot,
  CatalogSnapshotPage,
  ExtractionManifestPage,
} from '@dina/commerce-protocol';

/** Where a draft is in §6's state machine. The order is the whole rule. */
export type DraftState = 'created' | 'confirmed' | 'prepared' | 'approved' | 'published';

export const DRAFT_STATE_ORDER: readonly DraftState[] = [
  'created',
  'confirmed',
  'prepared',
  'approved',
  'published',
];

/**
 * Where a draft's values came from — assigned by Core from the entry point
 * used, never stated by the caller.
 *
 * `model_derived` is the default in the schema so a class that could not be
 * established demands a receipt rather than skipping one.
 */
export type ProvenanceClass = 'owner_authored' | 'source_parsed' | 'model_derived';

/** Per-field provenance. `not_model_derived` is what exempts a field. */
export type FieldProvenance = 'proposed' | 'accepted' | 'edited' | 'not_model_derived';

/**
 * One extracted row, as it is STORED.
 *
 * NOT `CatalogRowSource['rows']`, which is `{ row, get(name) }` — the cells
 * live in a closure there, and a closure does not survive `JSON.stringify`.
 * Storing that shape wrote `{"row":2}` and lost every value the model read,
 * while the column looked populated and the array length looked right. §10
 * item 8 puts the extracted rows first in the draft's durable contents, and
 * §5's repair surface is built from them, so the cells have to be data.
 */
export interface DraftRow {
  /** What the seller sees: a CSV header is row 1, data starts at 2. */
  row: number;
  cells: Record<string, string>;
  /**
   * §4.2: the immutable product identity this row's identifier is claimed
   * under. Minted once when the row first becomes a product, carried on
   * the ROW ENTRY so reordering leaves assignments untouched, and never
   * derived from anything the seller can edit. Absent until the mint
   * policy first runs (non-photo drafts may never carry one).
   */
  assignmentId?: string;
}

export interface CatalogDraft {
  draftId: string;
  catalogId: string;
  state: DraftState;
  provenanceClass: ProvenanceClass;
  /** The identifier scheme the rows were imported under (§4). */
  defaultScheme: 'gtin' | 'sku';
  /**
   * Which model read these values, and against which schema (§5).
   *
   * Null on `owner_authored` and `source_parsed`, where nothing was inferred.
   * Per DRAFT, not per field: one draft is one extraction, so a copy on every
   * field would be the same string twenty times rather than more provenance.
   * It is inside the content receipt, so a draft cannot claim after the fact
   * to have come from a different model than the one a person vouched for.
   */
  extraction: { model: string; schemaVersion: string } | null;
  /**
   * The photo lane's §2.1 chain material: the ordered manifest capture
   * produced, the extraction commitment digest, and the versioned binding
   * record that ties the digest to THIS draft at a content revision.
   *
   * ALL THREE OR NONE. A group whose binding names a different draft, a
   * different digest, or does not validate reads as ABSENT — and the photo
   * lane's confirm/prepare/publish checks refuse a photo-derived draft
   * whose group is absent, so a corrupted chain refuses rather than
   * publishing unchained. Null on drafts that never came from a photograph.
   */
  photoExtraction: {
    manifest: readonly ExtractionManifestPage[];
    extractionDigest: string;
    binding: CatalogExtractionBinding;
  } | null;
  /**
   * When a publication claimed this draft, or null when unclaimed.
   *
   * Publication is two awaited network writes, and every owner operation stays
   * callable across them. Detecting the collision afterwards is not the same
   * as preventing it: by then the records are public. The claim is taken
   * BEFORE the first write, and `recordEdit` refuses against it.
   */
  publishClaim: { token: string; atMs: number } | null;
  contentRevision: number;
  rows: readonly DraftRow[];
  findings: readonly unknown[];
  /** `itemIndex -> field -> provenance`. */
  provenance: Record<string, Record<string, FieldProvenance>>;
  items: readonly CatalogItem[];
  /** Minted once at assembly; empty until then. */
  generatedAtIso: string;
  itemRevision: string;
  receipt: { digest: string; revision: number } | null;
  held: {
    snapshot: CatalogSnapshot;
    pages: readonly CatalogSnapshotPage[];
    /**
     * THE POINTER THE BUILDER MADE, held rather than rebuilt.
     *
     * Two fields live only here: `previous_snapshot_digest`, which links this
     * publication to the one before it, and `service_rkey`, which says which
     * listing serves the catalog. A publish that reconstructs a pointer from
     * the snapshot's fields loses both — the repo accepts the write, and
     * AppView then refuses the pointer for a broken chain while Core reports
     * success. Holding it is also what "publish rebuilds nothing" has to mean.
     */
    pointer: CatalogPointer;
    expectedPointerCid: string;
    revision: number;
  } | null;
  approval: { digest: string; revision: number } | null;
  publication: { pointer: CatalogPointer; pointerCid: string; snapshotCid: string } | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * Is a publication holding this draft right now?
 *
 * ONE DEFINITION, because the two repositories express it in different
 * languages — the double in TypeScript, SQLite in a WHERE clause — and a
 * lease whose two implementations disagree about "abandoned" is worse than no
 * lease. `forEachRepo` runs both against the same body so a divergence fails
 * rather than hides.
 *
 * A claim stamped in the FUTURE (a clock moved backwards, or a corrupt row) is
 * abandoned rather than live: read as live it would hold for the whole size of
 * the skew, which is the one sequence a TTL cannot break.
 *
 * A HALF-WRITTEN claim is no claim, which is the reading `toDraft` already
 * gives a row carrying one of the two columns and not the other. Acquisition
 * has to agree with the reader or a draft would read as free and then refuse
 * the claim — and the parity suite caught the two disagreeing here, which is
 * what it is for.
 */
export function claimIsLive(
  claim: { token: string; atMs: number } | null,
  nowMs: number,
  ttlMs: number,
): boolean {
  if (claim === null || claim.token === '' || claim.atMs <= 0) return false;
  const age = nowMs - claim.atMs;
  return age >= 0 && age < ttlMs;
}

export interface CatalogDraftRepository {
  get(draftId: string): CatalogDraft | null;
  /**
   * Take the publication claim, or report that someone else holds it.
   *
   * A CONDITIONAL WRITE, not a read followed by a write. Acquisition used to
   * be `get` → test → `put`, three statements over a repository whose only
   * write is an unconditional upsert: within one VM they run without
   * interruption and the guard holds, but two processes over one database file
   * both read "no claim", both write their own token, and both publish. The
   * mechanism claimed an exclusion it did not have.
   *
   * Ownership is now PROVEN by winning this write rather than inferred from a
   * clock. The clock decides one thing only — when a claim left by a process
   * that is gone may be taken over — and a process that is still running holds
   * its claim across its whole operation and releases it in a `finally`, so an
   * abandoned claim means an absent claimant.
   *
   * Returns true when the claim is now ours.
   */
  claimForPublish(draftId: string, token: string, nowMs: number, ttlMs: number): boolean;
  /**
   * Give the claim back, but only if it is still ours.
   *
   * Also conditional, and for the same reason as the acquisition: a
   * publication that overran the TTL and lost its claim to a successor must
   * not clear the successor's on its way out.
   */
  releaseClaim(draftId: string, token: string): void;
  /** Every draft for a catalog, most recently touched first. */
  listByCatalog(catalogId: string): CatalogDraft[];
  put(draft: CatalogDraft): void;
  delete(draftId: string): void;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A row this build cannot read is a row it must not act on. Falling back to
    // the empty value keeps the draft READABLE while making it unusable — the
    // state machine refuses to publish a draft whose items are empty, so a
    // corrupt row fails closed rather than publishing a truncated catalog.
    return fallback;
  }
}

function isDraftState(value: string): value is DraftState {
  return (DRAFT_STATE_ORDER as readonly string[]).includes(value);
}

const PROVENANCE_CLASSES: readonly string[] = ['owner_authored', 'source_parsed', 'model_derived'];

/**
 * Read the stored class, and FAIL CLOSED on anything unrecognised.
 *
 * This field decides whether a draft needs a content receipt, which makes it
 * worth forging and makes an unvalidated read a way in. It was
 * `String(row.provenance_class) as ProvenanceClass` — a cast that tells the
 * compiler to accept whatever the column holds, so a row with a mistyped or
 * hostile value would have been read as a legitimate class and could have
 * exempted the draft from confirmation entirely. Same defect as ARCH-3: the
 * cast was standing where a check belonged.
 *
 * `model_derived` is the safe answer because it is the STRICTEST — it demands
 * a receipt. Guessing the permissive way would let an unreadable row publish
 * unconfirmed values under the seller's key.
 */
function readProvenanceClass(raw: unknown): ProvenanceClass {
  const value = String(raw);
  return PROVENANCE_CLASSES.includes(value) ? (value as ProvenanceClass) : 'model_derived';
}

/**
 * Stored items, RE-DERIVED through the same validator the write path ran.
 *
 * These are the bytes that get signed, so a row edited after writing must not
 * come back as publishable. Any item that fails makes the whole set read as
 * EMPTY rather than partly believed — the same discipline `credential_store`
 * applies to its operations list: an unreadable set authorizes nothing instead
 * of authorizing something nobody checked. The state machine refuses to
 * publish a draft with no items, so this fails closed.
 *
 * Emptying the set rather than refusing the whole draft is deliberate: the
 * owner can still open it, see there is nothing to publish, and re-assemble.
 * A draft that vanished on a bad byte would look like data loss.
 */
function readItems(raw: unknown): CatalogItem[] {
  const parsed = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const items: CatalogItem[] = [];
  for (const candidate of parsed) {
    if (validateCatalogItem(candidate) !== null) return [];
    items.push(candidate as CatalogItem);
  }
  return items;
}

/**
 * Read stored rows back, refusing a shape this build cannot use.
 *
 * Same discipline as `readItems`: a row that does not answer the type is not
 * half-believed. An empty set makes the draft unusable rather than letting a
 * repair screen render cells that are not there.
 */
function readRows(raw: unknown): DraftRow[] {
  const parsed = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const rows: DraftRow[] = [];
  for (const candidate of parsed) {
    if (candidate === null || typeof candidate !== 'object') return [];
    const record = candidate as Record<string, unknown>;
    const line = record.row;
    const cells = record.cells;
    if (typeof line !== 'number' || cells === null || typeof cells !== 'object') return [];
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(cells as Record<string, unknown>)) {
      if (typeof value !== 'string') return [];
      out[key] = value;
    }
    // A CORRUPT assignment id is refused, not dropped: dropping it would
    // read as "this row never became a product", and the mint would then
    // invent a FRESH identity for a product that already has one — the
    // §9.4 fork the id exists to prevent. Absent stays absent.
    const assignment = record.assignmentId;
    if (assignment !== undefined && (typeof assignment !== 'string' || assignment === '')) {
      return [];
    }
    rows.push(
      assignment === undefined
        ? { row: line, cells: out }
        : { row: line, cells: out, assignmentId: assignment },
    );
  }
  return rows;
}

const FIELD_PROVENANCE: readonly FieldProvenance[] = [
  'proposed',
  'accepted',
  'edited',
  'not_model_derived',
];

/**
 * Read per-field provenance back, failing CLOSED on anything unrecognised.
 *
 * THE COLUMN WAS CAST, NOT VALIDATED, and `unconfirmedFields` blocks only the
 * exact string `proposed` — so one corrupted byte turning `proposed` into
 * `proposd` read as a field somebody had vouched for, and it published. The
 * enforcement point treated "I do not recognise this" as "confirmed", which is
 * the one direction this lane must never fail in.
 *
 * An unreadable state becomes `proposed`, the same answer a missing one gets.
 */
function readProvenance(raw: unknown): Record<string, Record<string, FieldProvenance>> {
  const parsed = parseJson<Record<string, unknown>>(raw, {});
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, Record<string, FieldProvenance>> = {};
  for (const [index, byField] of Object.entries(parsed)) {
    if (byField === null || typeof byField !== 'object' || Array.isArray(byField)) continue;
    const fields: Record<string, FieldProvenance> = {};
    for (const [field, state] of Object.entries(byField as Record<string, unknown>)) {
      fields[field] = FIELD_PROVENANCE.includes(state as FieldProvenance)
        ? (state as FieldProvenance)
        : 'proposed';
    }
    out[index] = fields;
  }
  return out;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The photo-extraction group, ALL THREE COLUMNS OR NONE.
 *
 * Fail-closed like every reader here: a binding that names a different
 * draft or a different digest is not half-believed, it is absent — and an
 * absent group makes a photo-derived draft unconfirmable rather than
 * publishable without its chain.
 */
function readPhotoExtraction(
  manifestRaw: unknown,
  digestRaw: unknown,
  bindingRaw: unknown,
  draftId: string,
): CatalogDraft['photoExtraction'] {
  const digest = String(digestRaw ?? '');
  const manifestJson = String(manifestRaw ?? '');
  const bindingJson = String(bindingRaw ?? '');
  if (digest === '' && manifestJson === '' && bindingJson === '') return null;
  if (!HEX64.test(digest)) return null;

  const manifest = parseJson<unknown[]>(manifestJson, []);
  if (!Array.isArray(manifest) || manifest.length === 0) return null;
  const pages: ExtractionManifestPage[] = [];
  for (const [i, entry] of manifest.entries()) {
    if (entry === null || typeof entry !== 'object') return null;
    const page = entry as Record<string, unknown>;
    if (typeof page.artifact_id !== 'string' || page.artifact_id === '') return null;
    if (typeof page.content_hash !== 'string' || !HEX64.test(page.content_hash)) return null;
    // The manifest is ordered and the order is the commitment.
    if (page.page_index !== i) return null;
    pages.push({ artifact_id: page.artifact_id, content_hash: page.content_hash, page_index: i });
  }

  const binding = parseJson<unknown>(bindingJson, null);
  if (validateCatalogExtractionBinding(binding) !== null) return null;
  const typed = binding as CatalogExtractionBinding;
  // The binding is the chain link, so a link naming another draft or
  // another digest chains nothing here.
  if (typed.draft_id !== draftId) return null;
  if (typed.extraction_digest !== digest) return null;

  return { manifest: pages, extractionDigest: digest, binding: typed };
}

/** An attribution is present only when both of its halves are. */
function readExtraction(
  model: unknown,
  schemaVersion: unknown,
): { model: string; schemaVersion: string } | null {
  const m = String(model ?? '');
  const v = String(schemaVersion ?? '');
  return m === '' || v === '' ? null : { model: m, schemaVersion: v };
}

function toDraft(row: DBRow): CatalogDraft | null {
  const state = String(row.state);
  // AN UNKNOWN STATE IS NOT A DRAFT. Reading it as `created` would silently
  // rewind a published draft and authorize a second publication of it.
  if (!isDraftState(state)) return null;

  // Parsed to `CatalogSnapshot | null` rather than cast through `unknown`. A
  // held snapshot that will not parse is not a held snapshot, and saying so in
  // the type is what stops the null reaching a caller that trusts it.
  const heldSnapshot = parseJson<CatalogSnapshot | null>(row.held_snapshot_json, null);
  // THE POINTER IS PART OF THE HELD BYTES, so a row holding one without the
  // other is not something to publish from. Reading it as "held" would put
  // publish back on the reconstruction path this field exists to remove.
  const heldPointer = parseJson<CatalogPointer | null>(row.held_pointer_json, null);
  const held =
    heldSnapshot === null || heldPointer === null
      ? null
      : {
          snapshot: heldSnapshot,
          pages: parseJson<CatalogSnapshotPage[]>(row.held_pages_json, []),
          pointer: heldPointer,
          expectedPointerCid: String(row.held_pointer_cid ?? ''),
          revision: Number(row.held_revision ?? -1),
        };

  const receiptDigest = String(row.receipt_digest ?? '');
  const approvedDigest = String(row.approved_digest ?? '');
  const publicationRaw = String(row.publication_json ?? '');

  return {
    draftId: String(row.draft_id),
    catalogId: String(row.catalog_id),
    state,
    provenanceClass: readProvenanceClass(row.provenance_class),
    // `sku` is the fail-closed reading: a GTIN is a global identifier and a
    // supplier SKU is scoped to its issuer, so misreading a SKU as a GTIN
    // claims a global identifier the supplier does not own.
    defaultScheme: String(row.default_scheme) === 'gtin' ? 'gtin' : 'sku',
    // BOTH HALVES OR NEITHER, for the same reason the extraction reads that
    // way: half a claim cannot be compared against, and a claim nobody can
    // prove they own is not ownership.
    publishClaim:
      String(row.publish_claim_token ?? '') === '' || Number(row.publish_claimed_at_ms ?? 0) <= 0
        ? null
        : { token: String(row.publish_claim_token), atMs: Number(row.publish_claimed_at_ms) },
    // BOTH HALVES OR NEITHER. A model with no schema version is not an
    // attribution, it is half of one, and `confirm` would have hashed it into
    // a receipt that then claims to say which model read the values while
    // being unable to say against what. Half-present reads as absent, and
    // `confirm` refuses an absent attribution on a model-derived draft.
    extraction: readExtraction(row.extraction_model, row.extraction_schema_version),
    photoExtraction: readPhotoExtraction(
      row.extraction_manifest_json,
      row.extraction_digest,
      row.extraction_binding_json,
      String(row.draft_id),
    ),
    contentRevision: Number(row.content_revision ?? 0),
    rows: readRows(row.rows_json),
    findings: parseJson<unknown[]>(row.findings_json, []),
    provenance: readProvenance(row.provenance_json),
    items: readItems(row.items_json),
    generatedAtIso: String(row.generated_at_iso ?? ''),
    itemRevision: String(row.item_revision ?? ''),
    receipt:
      receiptDigest === ''
        ? null
        : { digest: receiptDigest, revision: Number(row.receipt_revision ?? -1) },
    held,
    approval:
      approvedDigest === ''
        ? null
        : { digest: approvedDigest, revision: Number(row.approved_revision ?? -1) },
    publication:
      publicationRaw === ''
        ? null
        : parseJson<CatalogDraft['publication']>(publicationRaw, null),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class SQLiteCatalogDraftRepository implements CatalogDraftRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  get(draftId: string): CatalogDraft | null {
    const rows = this.db.query(`SELECT * FROM commerce_catalog_drafts WHERE draft_id = ?`, [
      draftId,
    ]);
    return rows[0] === undefined ? null : toDraft(rows[0]);
  }

  listByCatalog(catalogId: string): CatalogDraft[] {
    const rows = this.db.query(
      // Then by id, so two drafts touched in the same millisecond do not
      // shuffle between reads.
      `SELECT * FROM commerce_catalog_drafts WHERE catalog_id = ?
         ORDER BY updated_at_ms DESC, draft_id ASC`,
      [catalogId],
    );
    return rows.map(toDraft).filter((d): d is CatalogDraft => d !== null);
  }

  put(draft: CatalogDraft): void {
    this.db.run(
      `INSERT INTO commerce_catalog_drafts
         (draft_id, catalog_id, state, provenance_class, content_revision,
          default_scheme, publish_claimed_at_ms, publish_claim_token,
          extraction_model, extraction_schema_version,
          extraction_manifest_json, extraction_digest, extraction_binding_json,
          rows_json, findings_json, provenance_json, items_json,
          generated_at_iso, item_revision,
          receipt_digest, receipt_revision,
          held_snapshot_json, held_pages_json, held_pointer_json, held_pointer_cid, held_revision,
          approved_digest, approved_revision, publication_json,
          created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(draft_id) DO UPDATE SET
         catalog_id = excluded.catalog_id,
         state = excluded.state,
         provenance_class = excluded.provenance_class,
         default_scheme = excluded.default_scheme,
         publish_claimed_at_ms = excluded.publish_claimed_at_ms,
         publish_claim_token = excluded.publish_claim_token,
         extraction_model = excluded.extraction_model,
         extraction_schema_version = excluded.extraction_schema_version,
         extraction_manifest_json = excluded.extraction_manifest_json,
         extraction_digest = excluded.extraction_digest,
         extraction_binding_json = excluded.extraction_binding_json,
         content_revision = excluded.content_revision,
         rows_json = excluded.rows_json,
         findings_json = excluded.findings_json,
         provenance_json = excluded.provenance_json,
         items_json = excluded.items_json,
         generated_at_iso = excluded.generated_at_iso,
         item_revision = excluded.item_revision,
         receipt_digest = excluded.receipt_digest,
         receipt_revision = excluded.receipt_revision,
         held_snapshot_json = excluded.held_snapshot_json,
         held_pages_json = excluded.held_pages_json,
         held_pointer_json = excluded.held_pointer_json,
         held_pointer_cid = excluded.held_pointer_cid,
         held_revision = excluded.held_revision,
         approved_digest = excluded.approved_digest,
         approved_revision = excluded.approved_revision,
         publication_json = excluded.publication_json,
         updated_at_ms = excluded.updated_at_ms`,
      [
        draft.draftId,
        draft.catalogId,
        draft.state,
        draft.provenanceClass,
        draft.contentRevision,
        draft.defaultScheme,
        draft.publishClaim?.atMs ?? 0,
        draft.publishClaim?.token ?? '',
        draft.extraction?.model ?? '',
        draft.extraction?.schemaVersion ?? '',
        draft.photoExtraction === null ? '' : JSON.stringify(draft.photoExtraction.manifest),
        draft.photoExtraction?.extractionDigest ?? '',
        draft.photoExtraction === null ? '' : JSON.stringify(draft.photoExtraction.binding),
        JSON.stringify(draft.rows),
        JSON.stringify(draft.findings),
        JSON.stringify(draft.provenance),
        JSON.stringify(draft.items),
        draft.generatedAtIso,
        draft.itemRevision,
        draft.receipt?.digest ?? '',
        draft.receipt?.revision ?? -1,
        draft.held === null ? '' : JSON.stringify(draft.held.snapshot),
        draft.held === null ? '' : JSON.stringify(draft.held.pages),
        draft.held === null ? '' : JSON.stringify(draft.held.pointer),
        draft.held?.expectedPointerCid ?? '',
        draft.held?.revision ?? -1,
        draft.approval?.digest ?? '',
        draft.approval?.revision ?? -1,
        draft.publication === null ? '' : JSON.stringify(draft.publication),
        draft.createdAtMs,
        draft.updatedAtMs,
      ],
    );
  }

  claimForPublish(draftId: string, token: string, nowMs: number, ttlMs: number): boolean {
    // The WHERE clause is `claimIsLive` negated, in SQL. Read it beside that
    // function: no token or no timestamp is a half-written row and counts as
    // no claim (the same fail-closed reading `toDraft` gives it); a timestamp
    // AHEAD of now is a clock that moved backwards; and a timestamp older than
    // the TTL is a claimant that is gone.
    //
    // One statement, so the test and the write cannot be separated by another
    // process's write between them — which is the whole difference between an
    // exclusion and a hope.
    const affected = this.db.run(
      `UPDATE commerce_catalog_drafts
          SET publish_claim_token = ?, publish_claimed_at_ms = ?, updated_at_ms = ?
        WHERE draft_id = ?
          AND (publish_claim_token = ''
               OR publish_claimed_at_ms <= 0
               OR publish_claimed_at_ms > ?
               OR ? - publish_claimed_at_ms >= ?)`,
      [token, nowMs, nowMs, draftId, nowMs, nowMs, ttlMs],
    );
    return affected === 1;
  }

  releaseClaim(draftId: string, token: string): void {
    this.db.run(
      `UPDATE commerce_catalog_drafts
          SET publish_claim_token = '', publish_claimed_at_ms = 0
        WHERE draft_id = ? AND publish_claim_token = ?`,
      [draftId, token],
    );
  }

  delete(draftId: string): void {
    this.db.run(`DELETE FROM commerce_catalog_drafts WHERE draft_id = ?`, [draftId]);
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryCatalogDraftRepository implements CatalogDraftRepository {
  private readonly rows = new Map<string, CatalogDraft>();

  get(draftId: string): CatalogDraft | null {
    const row = this.rows.get(draftId);
    // A DEEP copy, because the in-memory double must not let a caller mutate
    // stored state through a returned reference — SQLite would not, so a
    // double that does would make the two behave differently under exactly
    // the aliasing bug this store's revision rules exist to catch.
    return row === undefined ? null : (JSON.parse(JSON.stringify(row)) as CatalogDraft);
  }

  listByCatalog(catalogId: string): CatalogDraft[] {
    return [...this.rows.values()]
      .filter((d) => d.catalogId === catalogId)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.draftId.localeCompare(b.draftId))
      .map((d) => JSON.parse(JSON.stringify(d)) as CatalogDraft);
  }

  put(draft: CatalogDraft): void {
    this.rows.set(draft.draftId, JSON.parse(JSON.stringify(draft)) as CatalogDraft);
  }

  claimForPublish(draftId: string, token: string, nowMs: number, ttlMs: number): boolean {
    const row = this.rows.get(draftId);
    if (row === undefined) return false;
    if (claimIsLive(row.publishClaim, nowMs, ttlMs)) return false;
    row.publishClaim = { token, atMs: nowMs };
    row.updatedAtMs = nowMs;
    return true;
  }

  releaseClaim(draftId: string, token: string): void {
    const row = this.rows.get(draftId);
    if (row === undefined || row.publishClaim?.token !== token) return;
    row.publishClaim = null;
  }

  delete(draftId: string): void {
    this.rows.delete(draftId);
  }
}
