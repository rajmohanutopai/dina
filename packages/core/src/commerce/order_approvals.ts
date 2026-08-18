/**
 * §15.2 — the approval material CORE holds between the card and the send.
 *
 * WHY THIS EXISTS. `verifyApprovalBinding` compares what is about to execute
 * against what was approved, and the comparison is only worth having if the
 * two sides come from different places. They did not. `POST
 * /v1/commerce/orders/submit` took the order, the context AND the approved
 * payload from one request body, rebuilt the payload from that same body's
 * order, and compared the result to that same body's payload. Every attack the
 * binding names — a re-planned order, a mutated store row, a swapped install
 * between the tap and the send — arrives as a caller that simply rebuilds both
 * halves, and the check passes. The docstring described a defence the code
 * could not perform.
 *
 * So the card is a Core-side act. `prepareOrderApproval` builds the payload
 * from the order the owner is being shown and retains it here; the submit
 * names it by id and never supplies approval material of its own. The rebuild
 * inside `submitApprovedOrder` stays, and becomes what it always claimed to
 * be: a check against something the caller does not control.
 *
 * WHAT IS STORED, AND WHAT IS NOT. The order and the context are kept. The
 * PAYLOAD is not — it is a pure function of those two, so storing it as well
 * would be a second copy free to disagree with the first. Only its digest is
 * kept, and every read rebuilds the payload and compares. A row edited in the
 * store therefore reads as ABSENT rather than as a differently-approved order,
 * the same discipline `buyer_requests.ts` applies to a retained request.
 *
 * SINGLE USE, AND SHORT LIVED. An approval is a standing instruction to spend
 * money, so it is consumed by a CAS on first successful send and expires on
 * its own. Neither is redundant with the §19 quote check: an expired quote is
 * refused at submit, but an approval can also outlive the moment the owner
 * remembers giving it while the quote it names is still perfectly valid.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';

import { validateApprovalSourceBinding } from '@dina/commerce-protocol';

import {
  approvalDigest,
  buildBuyerApprovalPayload,
  type BuyerApprovalContext,
  type BuyerApprovalPayload,
} from './approval_payload';
import { rehydrateApprovalContext, rehydratePurchaseOrder, type Sha256Fn } from './rehydrate';
import { resolveServiceBinding } from './service_binding';

import type { DatabaseAdapter } from '../storage/db_adapter';
import type { PurchaseOrderProposal } from '@dina/commerce-protocol';

const hash: Sha256Fn = (data) => sha256(data);

/**
 * How long a card stays answerable.
 *
 * A JUDGEMENT, recorded as one. The spec fixes no number here; it fixes quote
 * expiry (§19), which is checked separately at submit. This bounds a different
 * thing — how long a decision keeps its meaning — and thirty minutes is long
 * enough to read a large order and short enough that a card found open the
 * next morning is a fresh decision rather than an old one.
 */
export const ORDER_APPROVAL_TTL_MS = 30 * 60 * 1000;

/** What Core retained when it showed the card. */
export interface RetainedOrderApproval {
  approvalId: string;
  order: PurchaseOrderProposal;
  context: BuyerApprovalContext;
  /** Rebuilt on read from `order` + `context`, never read from the row. */
  payload: BuyerApprovalPayload;
  serviceRkey: string;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
}

export interface OrderApprovalRepository {
  /**
   * Retain a card Core is about to show. False when the id is already held —
   * first-writer-wins, so a replayed prepare cannot redefine what a pending
   * approval means.
   */
  put(record: Omit<RetainedOrderApproval, 'payload' | 'consumedAt'>): boolean;
  /** The retained approval, or null when absent or no longer believable. */
  get(approvalId: string): RetainedOrderApproval | null;
  /**
   * Spend it. True only for the call that moved it from unconsumed to
   * consumed, so two taps on one card cannot both send.
   */
  consume(approvalId: string, nowMs: number): boolean;
  /**
   * Every retained approval digest, for the §6.4 boundary crossing's
   * grandfather walk. The stored digest column, raw — the walk must
   * reach rows whose JSON no longer hydrates, because a mutated row is
   * still a digest the pre-staff node minted.
   */
  listApprovalDigests(): string[];
}

/** A fresh, unguessable card id. */
export function newApprovalId(): string {
  return `oap_${bytesToHex(randomBytes(16))}`;
}

interface ApprovalRow {
  [column: string]: string | number | Uint8Array | null;
  approval_id: string;
  approval_digest: string;
  order_json: string;
  context_json: string;
  service_rkey: string;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export class SQLiteOrderApprovalRepository implements OrderApprovalRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(record: Omit<RetainedOrderApproval, 'payload' | 'consumedAt'>): boolean {
    const built = buildBuyerApprovalPayload(record.order, record.context);
    if (!built.ok) return false;
    // READ-THEN-INSERT in one transaction, not `run`'s return value: the base
    // adapter returns a constant 1 regardless of what happened, so deciding
    // "was this new" from it is right on one platform and wrong on the other.
    let inserted = false;
    this.db.transaction(() => {
      const existing = this.db.query<{ approval_id: string }>(
        `SELECT approval_id FROM commerce_order_approvals WHERE approval_id = ?`,
        [record.approvalId],
      );
      if (existing[0]) return;
      this.db.run(
        `INSERT INTO commerce_order_approvals
           (approval_id, supplier_did, purchase_order_id, approval_digest,
            order_json, context_json, service_rkey, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          record.approvalId,
          record.order.supplier_did,
          record.order.purchase_order_id,
          approvalDigest(built.payload),
          JSON.stringify(record.order),
          JSON.stringify(record.context),
          record.serviceRkey,
          record.createdAt,
          record.expiresAt,
        ],
      );
      inserted = true;
    });
    return inserted;
  }

  get(approvalId: string): RetainedOrderApproval | null {
    const rows = this.db.query<ApprovalRow>(
      `SELECT approval_id, approval_digest, order_json, context_json, service_rkey,
              created_at, expires_at, consumed_at
         FROM commerce_order_approvals WHERE approval_id = ?`,
      [approvalId],
    );
    const row = rows[0];
    return row === undefined ? null : hydrate(row);
  }

  listApprovalDigests(): string[] {
    return this.db
      .query<{ approval_digest: string }>(
        `SELECT approval_digest FROM commerce_order_approvals`,
      )
      .map((row) => String(row.approval_digest));
  }

  consume(approvalId: string, nowMs: number): boolean {
    // The CAS is the whole point, so it is one statement with the predicate in
    // the WHERE clause — and it is read back rather than counted, for the same
    // reason `put` reads back.
    let spent = false;
    this.db.transaction(() => {
      const before = this.db.query<{ consumed_at: number | null }>(
        `SELECT consumed_at FROM commerce_order_approvals WHERE approval_id = ?`,
        [approvalId],
      );
      if (before[0] === undefined || before[0].consumed_at !== null) return;
      this.db.run(
        `UPDATE commerce_order_approvals SET consumed_at = ?
          WHERE approval_id = ? AND consumed_at IS NULL`,
        [nowMs, approvalId],
      );
      spent = true;
    });
    return spent;
  }
}

export class InMemoryOrderApprovalRepository implements OrderApprovalRepository {
  private readonly held = new Map<string, ApprovalRow>();

  put(record: Omit<RetainedOrderApproval, 'payload' | 'consumedAt'>): boolean {
    const built = buildBuyerApprovalPayload(record.order, record.context);
    if (!built.ok) return false;
    if (this.held.has(record.approvalId)) return false;
    this.held.set(record.approvalId, {
      approval_id: record.approvalId,
      approval_digest: approvalDigest(built.payload),
      order_json: JSON.stringify(record.order),
      context_json: JSON.stringify(record.context),
      service_rkey: record.serviceRkey,
      created_at: record.createdAt,
      expires_at: record.expiresAt,
      consumed_at: null,
    });
    return true;
  }

  get(approvalId: string): RetainedOrderApproval | null {
    const row = this.held.get(approvalId);
    return row === undefined ? null : hydrate(row);
  }

  consume(approvalId: string, nowMs: number): boolean {
    const row = this.held.get(approvalId);
    if (row === undefined || row.consumed_at !== null) return false;
    this.held.set(approvalId, { ...row, consumed_at: nowMs });
    return true;
  }

  listApprovalDigests(): string[] {
    return [...this.held.values()].map((row) => String(row.approval_digest));
  }
}

/**
 * A retained row, RE-DERIVED, or null when it cannot be believed.
 *
 * The order is re-validated against its own `order_digest` and the payload is
 * rebuilt from the stored order and context and compared to the stored digest.
 * A row edited after writing therefore reads as absent, and the send it would
 * have authorised is refused rather than performed against an approval this
 * node cannot reconstruct. A tampered pair — body and digest changed together
 * — is caught because both digests are recomputed from the bodies rather than
 * compared to a neighbouring column.
 */
function hydrate(row: ApprovalRow): RetainedOrderApproval | null {
  // Through the rehydration module, so the order is re-validated against its
  // own `order_digest` on the way out and arrives TYPED rather than cast.
  const order = rehydratePurchaseOrder(String(row.order_json), hash);
  if (!order.ok) return null;
  const context = rehydrateApprovalContext(String(row.context_json));
  if (!context.ok) return null;

  const built = buildBuyerApprovalPayload(order.value, context.value);
  if (!built.ok) return null;
  if (approvalDigest(built.payload) !== String(row.approval_digest)) return null;

  // §2.1 — the origin discriminator, FAIL CLOSED. "Absent = legacy" failed
  // open: a photo approval whose source fields were lost to corruption or a
  // partial migration would hydrate as a legitimate legacy approval and
  // take the unrestricted path. A payload CARRYING a source must carry a
  // COMPLETE one; anything else reads as absent — the approval, not the
  // binding — so the downgrade never happens.
  if (built.payload.source !== undefined) {
    if (validateApprovalSourceBinding(built.payload.source) !== null) return null;
  }

  // NEW-7 — RE-DERIVED, not read back. The digest above covers `order` and
  // `context`; it does not cover this column, so a row whose `service_rkey`
  // was edited after writing would pass every integrity check this module
  // makes and then reach the acting-for chain and the outbound query. DR-3
  // made the listing derivable from one source precisely so there would not be
  // a second one, and reading the column reintroduced it for the one field
  // DR-3 was about. A stored value that disagrees reads as ABSENT, which is
  // the behaviour the rest of this module already has.
  const listing = resolveServiceBinding({
    serviceUri: context.value.serviceUri,
    supplierDid: order.value.supplier_did,
  });
  if (!listing.ok) return null;
  if (listing.serviceRkey !== String(row.service_rkey)) return null;

  return {
    approvalId: String(row.approval_id),
    order: order.value,
    context: context.value,
    payload: built.payload,
    serviceRkey: listing.serviceRkey,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
  };
}
