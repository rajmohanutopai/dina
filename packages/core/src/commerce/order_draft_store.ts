/**
 * The BUYER lane's aggregate (PHOTO_COMMERCE_LANES_DESIGN §5.1) — its own
 * store and state machine beside (not inside) the catalog draft's.
 * Revision 1 said "one draft machine" and the review showed why that was
 * wrong with the code open: an order line is not a `CatalogItem`, and
 * forcing one through those readers erases it. The two aggregates share
 * the safety kernel — the provenance vocabulary, the receipt discipline,
 * the fail-closed readers — and nothing else.
 *
 * ONE ROW IS ONE PHOTOGRAPHED PAGE, however many suppliers its lines
 * resolve across. Top-level state is DERIVED from line and conversation
 * states, never stored beside them where the two could disagree.
 */

import { validateCatalogPointer, validateCatalogSnapshot, validateCatalogSnapshotPage, validateProductRef } from '@dina/commerce-protocol';

import type { DatabaseAdapter } from '../storage/db_adapter';
import type { FieldProvenance } from './catalog_draft_store';
import type {
  CatalogEvidenceRecord,
  ConversationSnapshot,
  ExtractionManifestPage,
  ProductRef,
} from '@dina/commerce-protocol';

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

/** How a line stands against the catalogs the buyer can see (§5.2). */
export type LineResolution =
  | { kind: 'unresolved' }
  | {
      kind: 'ambiguous';
      candidates: { product: ProductRef; supplierDid: string; flaggedNewSupplier: boolean }[];
    }
  | {
      kind: 'resolved';
      product: ProductRef;
      supplierDid: string;
      /** The owner's decision: an unknown supplier appears FLAGGED and is
       *  never auto-selected. */
      flaggedNewSupplier: boolean;
    };

/**
 * A line's vouch entry — from the ceremony that vouched it. Never
 * partially void: it either matches the line's current generation or the
 * line is unvouched (§5.1).
 */
export interface LineVouchEntry {
  generation: number;
  receiptDigest: string;
  ceremony: number;
}

export interface OrderDraftLine {
  lineId: string;
  /** The raw extracted line — review context, never transmitted raw. */
  text: string;
  pageIndex: number;
  /** Parsed hints: quantity, product hint — each with provenance below. */
  fields: Record<string, string>;
  /** Per FIELD: `quantity` starts `proposed`, exactly as the seller side. */
  provenance: Record<string, FieldProvenance>;
  resolution: LineResolution;
  /** Bumps on repair/re-resolve; the vouch entry voids when it moves. */
  generation: number;
  /**
   * §5.4 3a — binds the line to at most one supplier conversation at a
   * time. Re-routing retires the old assignment by bumping this.
   */
  assignmentGeneration: number;
  vouch: LineVouchEntry | null;
  /** An ambiguous line the buyer DEFERRED — excluded from confirm rather
   *  than blocking it (§5.1's defer row). */
  deferred: boolean;
  /** §5.1 — the per-resolved-line retention, hydrated fail-closed. */
  evidence: CatalogEvidenceRecord | null;
  /** The conversation id of a SUBMITTED order containing this line, or
   *  null. A submitted line cannot be repaired (§5.1 matrix row 1). */
  submittedIn: string | null;
}

/** The §5.1 two-kinds rule: the wire carries one kind and not the other. */
export type RequirementKind = 'transmitted' | 'draft_local';

export interface OrderRequirement {
  key: string;
  kind: RequirementKind;
  /** Null when omitted — "value | omitted" is one pair, not two fields. */
  value: string | null;
  omitted: boolean;
  provenance: FieldProvenance;
  generation: number;
  vouch: LineVouchEntry | null;
}

export type ConversationState =
  | 'draft'
  | 'sent'
  | 'quoted'
  | 'approved'
  | 'submitting'
  | 'submitted_unconfirmed'
  | 'submitted'
  | 'timed_out'
  | 'rejected'
  | 'superseded'
  | 'quote_expired'
  | 'dispatch_refused'
  | 'closed';

const CONVERSATION_STATES: readonly ConversationState[] = [
  'draft',
  'sent',
  'quoted',
  'approved',
  'submitting',
  'submitted_unconfirmed',
  'submitted',
  'timed_out',
  'rejected',
  'superseded',
  'quote_expired',
  'dispatch_refused',
  'closed',
];

/** Terminal conversations are retained history under their own ids (§5.0). */
export const TERMINAL_CONVERSATION_STATES: ReadonlySet<ConversationState> = new Set([
  'submitted',
  'timed_out',
  'rejected',
  'superseded',
  'quote_expired',
  'dispatch_refused',
  'closed',
]);

export interface OrderConversation {
  /** Minted by Core, random, unique within the draft (§5.0). */
  conversationId: string;
  supplierDid: string;
  state: ConversationState;
  /** The lines this conversation carries. */
  lineIds: string[];
  /**
   * Frozen at SEND (§5.1): the generations and vouch entries the request
   * went out under. Immutable from there — later repairs create new
   * generations rather than rewriting what this request meant.
   */
  snapshot: ConversationSnapshot | null;
  snapshotDigest: string | null;
  requestDigest: string | null;
  /** Core-minted; written to request_id AND idempotency_key (§5.4 stage 1). */
  requestId: string | null;
  /** The exact accepted quote. */
  quoteDigest: string | null;
  /** The supplier's quote id, kept beside the digest so the approve step
   *  can find the revision in the verified store without the surface
   *  carrying supplier identifiers back and forth. */
  quoteId: string | null;
  quoteValidUntil: string | null;
  approvalId: string | null;
  /**
   * The order this conversation DISPATCHED, kept after the intent clears:
   * §5.5's lifecycle projection (rejected / accepted arriving through
   * §12.7) finds its buyer-order record by this, and a
   * `submitted_unconfirmed` conversation that forgot its order id would be
   * unresolvable for ever.
   */
  purchaseOrderId: string | null;
  /**
   * The §5.1 submission protocol's durable intent. It carries the
   * purchase-order id so crash replay can resolve itself RECORD-FIRST —
   * against the buyer-order store — even when the approval row is gone,
   * which is exactly the poisoned case (§5.1: consumed at the send
   * boundary, crash before the outcome was recorded).
   */
  dispatchIntent: { intentId: string; purchaseOrderId: string; createdAtMs: number } | null;
  outcome: string | null;
}

export interface OrderDraft {
  draftId: string;
  manifest: readonly ExtractionManifestPage[];
  extraction: { model: string; schemaVersion: string } | null;
  extractionDigest: string;
  lines: OrderDraftLine[];
  requirements: OrderRequirement[];
  conversations: OrderConversation[];
  /** Bumped ONLY by confirm ceremonies (§5.1) — pinned at birth. */
  ceremonyCounter: number;
  abandoned: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * Top-level state, DERIVED — never stored beside the parts. `closed` means
 * every line is in a submitted order, explicitly abandoned, or
 * expired-and-acknowledged (§5.1).
 */
export function deriveOrderDraftState(
  draft: OrderDraft,
): 'open' | 'awaiting_answers' | 'closed' {
  if (draft.abandoned) return 'closed';
  const everyLineSettled =
    draft.lines.length > 0 && draft.lines.every((line) => line.submittedIn !== null);
  if (everyLineSettled) return 'closed';
  const anyWaiting = draft.conversations.some(
    (c) => c.state === 'sent' || c.state === 'submitted_unconfirmed' || c.state === 'submitting',
  );
  return anyWaiting ? 'awaiting_answers' : 'open';
}

/** At most one LIVE conversation per supplier per draft (§5.0). */
export function liveConversationFor(
  draft: OrderDraft,
  supplierDid: string,
): OrderConversation | null {
  return (
    draft.conversations.find(
      (c) => c.supplierDid === supplierDid && !TERMINAL_CONVERSATION_STATES.has(c.state),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface OrderDraftRepository {
  get(draftId: string): OrderDraft | null;
  list(): OrderDraft[];
  put(draft: OrderDraft): void;
  delete(draftId: string): void;
}

// ---------------------------------------------------------------------------
// Fail-closed readers — the discipline both aggregates share
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const FIELD_PROVENANCE: readonly FieldProvenance[] = [
  'proposed',
  'accepted',
  'edited',
  'not_model_derived',
];

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readProvenanceMap(value: unknown): Record<string, FieldProvenance> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, FieldProvenance> = {};
  for (const [field, state] of Object.entries(value as Record<string, unknown>)) {
    // An unrecognised state fails CLOSED to `proposed` — the one direction
    // this lane must never fail in is "corrupt byte reads as vouched".
    out[field] = FIELD_PROVENANCE.includes(state as FieldProvenance)
      ? (state as FieldProvenance)
      : 'proposed';
  }
  return out;
}

function readVouch(value: unknown): LineVouchEntry | null {
  if (value === null) return null;
  if (typeof value !== 'object') return null;
  const v = value as Partial<LineVouchEntry>;
  if (
    typeof v.generation !== 'number' ||
    typeof v.ceremony !== 'number' ||
    typeof v.receiptDigest !== 'string' ||
    !HEX64.test(v.receiptDigest)
  ) {
    return null;
  }
  return { generation: v.generation, ceremony: v.ceremony, receiptDigest: v.receiptDigest };
}

function readResolution(value: unknown): LineResolution | null {
  if (value === null || typeof value !== 'object') return null;
  const r = value as { kind?: string } & Record<string, unknown>;
  if (r.kind === 'unresolved') return { kind: 'unresolved' };
  if (r.kind === 'ambiguous') {
    if (!Array.isArray(r.candidates)) return null;
    const candidates: { product: ProductRef; supplierDid: string; flaggedNewSupplier: boolean }[] =
      [];
    for (const entry of r.candidates) {
      const c = entry as Record<string, unknown>;
      if (validateProductRef(c.product) !== null) return null;
      if (typeof c.supplierDid !== 'string' || c.supplierDid === '') return null;
      candidates.push({
        product: c.product as ProductRef,
        supplierDid: c.supplierDid,
        flaggedNewSupplier: c.flaggedNewSupplier === true,
      });
    }
    return { kind: 'ambiguous', candidates };
  }
  if (r.kind === 'resolved') {
    if (validateProductRef(r.product) !== null) return null;
    if (typeof r.supplierDid !== 'string' || r.supplierDid === '') return null;
    return {
      kind: 'resolved',
      product: r.product as ProductRef,
      supplierDid: r.supplierDid,
      flaggedNewSupplier: r.flaggedNewSupplier === true,
    };
  }
  return null;
}

function readEvidence(value: unknown): CatalogEvidenceRecord | null {
  if (value === null) return null;
  if (typeof value !== 'object') return null;
  const record = value as Partial<CatalogEvidenceRecord>;
  // SHAPE here; the AUTHORITY-first verification is hydration's caller
  // (resolution, §5.2) — but a record that cannot even hold the chain is
  // refused at the store boundary.
  if (typeof record.repo_did !== 'string' || record.repo_did === '') return null;
  if (typeof record.collection !== 'string' || typeof record.rkey !== 'string') return null;
  if (typeof record.pointer_cid !== 'string') return null;
  if (validateCatalogPointer(record.pointer) !== null) return null;
  if (validateCatalogSnapshot(record.snapshot) !== null) return null;
  if (validateCatalogSnapshotPage(record.page) !== null) return null;
  return record as CatalogEvidenceRecord;
}

/** A line that does not answer the type is not half-believed: the whole
 *  set reads as EMPTY, and an empty line set makes the draft unusable
 *  rather than partially trusted. */
function readLines(raw: unknown): OrderDraftLine[] | null {
  const parsed = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return null;
  const lines: OrderDraftLine[] = [];
  for (const candidate of parsed) {
    if (candidate === null || typeof candidate !== 'object') return null;
    const line = candidate as Record<string, unknown>;
    if (typeof line.lineId !== 'string' || line.lineId === '') return null;
    if (typeof line.text !== 'string') return null;
    if (typeof line.pageIndex !== 'number') return null;
    const fields = line.fields;
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return null;
    for (const value of Object.values(fields as Record<string, unknown>)) {
      if (typeof value !== 'string') return null;
    }
    const provenance = readProvenanceMap(line.provenance);
    if (provenance === null) return null;
    const resolution = readResolution(line.resolution);
    if (resolution === null) return null;
    if (typeof line.generation !== 'number' || typeof line.assignmentGeneration !== 'number') {
      return null;
    }
    const vouch = readVouch(line.vouch ?? null);
    if (line.vouch != null && vouch === null) return null;
    const evidence = readEvidence(line.evidence ?? null);
    if (line.evidence != null && evidence === null) return null;
    lines.push({
      lineId: line.lineId,
      text: line.text,
      pageIndex: line.pageIndex,
      fields: { ...(fields as Record<string, string>) },
      provenance,
      resolution,
      generation: line.generation,
      assignmentGeneration: line.assignmentGeneration,
      vouch,
      deferred: line.deferred === true,
      evidence,
      submittedIn: typeof line.submittedIn === 'string' ? line.submittedIn : null,
    });
  }
  return lines;
}

function readRequirements(raw: unknown): OrderRequirement[] | null {
  const parsed = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return null;
  const requirements: OrderRequirement[] = [];
  for (const candidate of parsed) {
    if (candidate === null || typeof candidate !== 'object') return null;
    const req = candidate as Record<string, unknown>;
    if (typeof req.key !== 'string' || req.key === '') return null;
    if (req.kind !== 'transmitted' && req.kind !== 'draft_local') return null;
    if (req.value !== null && typeof req.value !== 'string') return null;
    if (typeof req.omitted !== 'boolean') return null;
    if (req.omitted && req.value !== null) return null;
    const provenance = FIELD_PROVENANCE.includes(req.provenance as FieldProvenance)
      ? (req.provenance as FieldProvenance)
      : 'proposed';
    if (typeof req.generation !== 'number') return null;
    const vouch = readVouch(req.vouch ?? null);
    if (req.vouch != null && vouch === null) return null;
    requirements.push({
      key: req.key,
      kind: req.kind,
      value: req.value as string | null,
      omitted: req.omitted,
      provenance,
      generation: req.generation,
      vouch,
    });
  }
  return requirements;
}

function readConversations(raw: unknown): OrderConversation[] | null {
  const parsed = parseJson<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return null;
  const conversations: OrderConversation[] = [];
  const liveBySupplier = new Set<string>();
  for (const candidate of parsed) {
    if (candidate === null || typeof candidate !== 'object') return null;
    const c = candidate as Record<string, unknown>;
    if (typeof c.conversationId !== 'string' || c.conversationId === '') return null;
    if (typeof c.supplierDid !== 'string' || c.supplierDid === '') return null;
    if (!CONVERSATION_STATES.includes(c.state as ConversationState)) return null;
    const state = c.state as ConversationState;
    // The ONE-LIVE rule is a stored invariant, checked on the way out: two
    // live conversations for one supplier is a row this build must not
    // act on, because both would claim the same lines.
    if (!TERMINAL_CONVERSATION_STATES.has(state)) {
      if (liveBySupplier.has(c.supplierDid)) return null;
      liveBySupplier.add(c.supplierDid);
    }
    if (!Array.isArray(c.lineIds) || c.lineIds.some((id) => typeof id !== 'string')) return null;
    const optionalHex = (value: unknown): string | null =>
      typeof value === 'string' && HEX64.test(value) ? value : null;
    conversations.push({
      conversationId: c.conversationId,
      supplierDid: c.supplierDid,
      state,
      lineIds: [...(c.lineIds as string[])],
      snapshot: (c.snapshot ?? null) as ConversationSnapshot | null,
      snapshotDigest: optionalHex(c.snapshotDigest),
      requestDigest: optionalHex(c.requestDigest),
      requestId: typeof c.requestId === 'string' ? c.requestId : null,
      quoteDigest: optionalHex(c.quoteDigest),
      quoteId: typeof c.quoteId === 'string' ? c.quoteId : null,
      quoteValidUntil: typeof c.quoteValidUntil === 'string' ? c.quoteValidUntil : null,
      approvalId: typeof c.approvalId === 'string' ? c.approvalId : null,
      purchaseOrderId: typeof c.purchaseOrderId === 'string' ? c.purchaseOrderId : null,
      dispatchIntent:
        c.dispatchIntent !== null &&
        typeof c.dispatchIntent === 'object' &&
        typeof (c.dispatchIntent as { intentId?: unknown }).intentId === 'string' &&
        typeof (c.dispatchIntent as { purchaseOrderId?: unknown }).purchaseOrderId === 'string'
          ? {
              intentId: (c.dispatchIntent as { intentId: string }).intentId,
              purchaseOrderId: (c.dispatchIntent as { purchaseOrderId: string }).purchaseOrderId,
              createdAtMs: Number((c.dispatchIntent as { createdAtMs?: unknown }).createdAtMs ?? 0),
            }
          : null,
      outcome: typeof c.outcome === 'string' ? c.outcome : null,
    });
  }
  return conversations;
}

interface OrderDraftRow {
  [column: string]: string | number | Uint8Array | null;
  draft_id: string;
  manifest_json: string;
  extraction_model: string;
  extraction_schema_version: string;
  extraction_digest: string;
  lines_json: string;
  requirements_json: string;
  conversations_json: string;
  ceremony_counter: number;
  abandoned: number;
  created_at_ms: number;
  updated_at_ms: number;
}

function toDraft(row: OrderDraftRow): OrderDraft | null {
  const manifest = parseJson<unknown[]>(row.manifest_json, []);
  if (!Array.isArray(manifest)) return null;
  const pages: ExtractionManifestPage[] = [];
  for (const [i, entry] of manifest.entries()) {
    const page = entry as Partial<ExtractionManifestPage>;
    if (typeof page.artifact_id !== 'string' || page.artifact_id === '') return null;
    if (typeof page.content_hash !== 'string' || !HEX64.test(page.content_hash)) return null;
    if (page.page_index !== i) return null;
    pages.push({ artifact_id: page.artifact_id, content_hash: page.content_hash, page_index: i });
  }
  const lines = readLines(row.lines_json);
  if (lines === null) return null;
  const requirements = readRequirements(row.requirements_json);
  if (requirements === null) return null;
  const conversations = readConversations(row.conversations_json);
  if (conversations === null) return null;
  const model = String(row.extraction_model ?? '');
  const schemaVersion = String(row.extraction_schema_version ?? '');
  const extractionDigest = String(row.extraction_digest ?? '');
  if (extractionDigest !== '' && !HEX64.test(extractionDigest)) return null;
  return {
    draftId: String(row.draft_id),
    manifest: pages,
    extraction: model === '' || schemaVersion === '' ? null : { model, schemaVersion },
    extractionDigest,
    lines,
    requirements,
    conversations,
    ceremonyCounter: Number(row.ceremony_counter ?? 0),
    abandoned: Number(row.abandoned) === 1,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export class SQLiteOrderDraftRepository implements OrderDraftRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  get(draftId: string): OrderDraft | null {
    const rows = this.db.query<OrderDraftRow>(
      `SELECT * FROM commerce_order_drafts WHERE draft_id = ?`,
      [draftId],
    );
    return rows[0] === undefined ? null : toDraft(rows[0]);
  }

  list(): OrderDraft[] {
    const rows = this.db.query<OrderDraftRow>(
      `SELECT * FROM commerce_order_drafts ORDER BY updated_at_ms DESC, draft_id ASC`,
    );
    return rows.map(toDraft).filter((d): d is OrderDraft => d !== null);
  }

  put(draft: OrderDraft): void {
    this.db.run(
      `INSERT INTO commerce_order_drafts
         (draft_id, manifest_json, extraction_model, extraction_schema_version,
          extraction_digest, lines_json, requirements_json, conversations_json,
          ceremony_counter, abandoned, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(draft_id) DO UPDATE SET
         manifest_json = excluded.manifest_json,
         extraction_model = excluded.extraction_model,
         extraction_schema_version = excluded.extraction_schema_version,
         extraction_digest = excluded.extraction_digest,
         lines_json = excluded.lines_json,
         requirements_json = excluded.requirements_json,
         conversations_json = excluded.conversations_json,
         ceremony_counter = excluded.ceremony_counter,
         abandoned = excluded.abandoned,
         updated_at_ms = excluded.updated_at_ms`,
      [
        draft.draftId,
        JSON.stringify(draft.manifest),
        draft.extraction?.model ?? '',
        draft.extraction?.schemaVersion ?? '',
        draft.extractionDigest,
        JSON.stringify(draft.lines),
        JSON.stringify(draft.requirements),
        JSON.stringify(draft.conversations),
        draft.ceremonyCounter,
        draft.abandoned ? 1 : 0,
        draft.createdAtMs,
        draft.updatedAtMs,
      ],
    );
  }

  delete(draftId: string): void {
    this.db.run(`DELETE FROM commerce_order_drafts WHERE draft_id = ?`, [draftId]);
  }
}

export class InMemoryOrderDraftRepository implements OrderDraftRepository {
  private readonly rows = new Map<string, OrderDraft>();

  get(draftId: string): OrderDraft | null {
    const row = this.rows.get(draftId);
    return row === undefined ? null : (JSON.parse(JSON.stringify(row)) as OrderDraft);
  }

  list(): OrderDraft[] {
    return [...this.rows.values()]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.draftId.localeCompare(b.draftId))
      .map((d) => JSON.parse(JSON.stringify(d)) as OrderDraft);
  }

  put(draft: OrderDraft): void {
    this.rows.set(draft.draftId, JSON.parse(JSON.stringify(draft)) as OrderDraft);
  }

  delete(draftId: string): void {
    this.rows.delete(draftId);
  }
}
