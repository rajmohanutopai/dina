import { sha256 } from '@noble/hashes/sha2.js';

import {
  rehydrateAcknowledgement,
  rehydrateEnvelopeEvidence,
  rehydrateOrderLines,
} from './rehydrate';

import type { BuyerOrderRecord, BuyerOrderState } from './buyer_reconciliation';
import type { DatabaseAdapter } from '../storage/db_adapter';
import type { PurchaseOrderLine, Sha256Fn } from '@dina/commerce-protocol';

const hash: Sha256Fn = (data) => sha256(data);

/**
 * Durable buyer-side order state (§12.7, WS-7.7).
 *
 * §12.7 requires the `received_unresolved` loop to be "persisted across buyer
 * restart, never authorizing resubmission no matter how many iterations or how
 * much time passes". A poll counter that lived in memory would reset on
 * relaunch, and a state machine whose durability claim is unbacked is a
 * durability claim that fails exactly when it matters — after the crash that
 * lost the acknowledgement in the first place.
 *
 * SEPARATE FROM `commerce_order_refs`, which is the SUPPLIER's side. The two
 * describe the same trade from opposite ends and disagree on purpose: a
 * supplier's record says what it committed to, a buyer's says what it has been
 * able to learn. One table holding both would have to pick a winner.
 */
export interface BuyerOrderRepository {
  get(supplierDid: string, purchaseOrderId: string): BuyerOrderRecord | null;
  /** Insert if absent; never overwrite an order already being tracked. */
  create(supplierDid: string, record: BuyerOrderRecord): boolean;
  /**
   * Advance the tracked state, ONLY IF the row is still at `record.revision`.
   *
   * Returns false when somebody else moved it first. Every caller loads,
   * awaits I/O, then writes — a send, a supplier poll — so "somebody else"
   * is the ordinary case rather than the exotic one, and last-writer-wins here
   * means the SLOWEST writer wins: a send completing after a re-poll already
   * settled the order would overwrite a terminal acknowledgement with
   * `outcome_unknown`, and two workers would each spend the one resubmission
   * authorization.
   */
  put(supplierDid: string, record: BuyerOrderRecord): boolean;
  /** Orders still waiting on an answer, oldest poll first. */
  listUnsettled(): { supplierDid: string; record: BuyerOrderRecord }[];
}

const COLUMNS =
  'supplier_did, purchase_order_id, order_digest, idempotency_key, protocol_version, service_rkey, revision, quote_digest, quote_id, buyer_did, bound_supplier_did, state, acknowledgement_json, next_poll_at_ms, poll_count, resubmission_authorized, protocol_fault, order_lines_json, ack_evidence_json';

interface Row {
  supplier_did: string;
  purchase_order_id: string;
  order_digest: string | null;
  idempotency_key: string | null;
  protocol_version: string | null;
  service_rkey: string | null;
  revision: number | null;
  quote_digest: string | null;
  quote_id: string | null;
  buyer_did: string | null;
  // `supplier_did` is the ROW KEY; this is the supplier named by the order
  // itself. Kept as a separate column on purpose — comparing the key against
  // itself would prove nothing, and the check is that the order we sent named
  // the party now answering.
  bound_supplier_did: string | null;
  state: string;
  acknowledgement_json: string | null;
  next_poll_at_ms: number | null;
  poll_count: number;
  resubmission_authorized: number;
  protocol_fault: string | null;
  order_lines_json: string | null;
  ack_evidence_json: string | null;
}

/**
 * Read a row back, RE-VALIDATING the stored acknowledgement.
 *
 * Not `JSON.parse` and a cast. The acknowledgement is a supplier's signed
 * commitment and the row is editable by anything with the database open; a
 * cast would make a store-editable blob into the evidence an owner is shown
 * that their order was accepted. `rehydrateAcknowledgement` re-derives the
 * digest, so a tampered or truncated row cannot come back as a commitment.
 *
 * A row that fails is NOT dropped silently: the state stands (it is what the
 * machine recorded) and the fault is surfaced, because an owner told "accepted"
 * with no readable evidence behind it needs to know which of the two is true.
 */
/**
 * The stored line snapshot, or null when it is absent or unreadable.
 *
 * Shape-checked rather than cast, and for the same reason the acknowledgement
 * is re-validated: this list is the yardstick §9.11's cumulative check runs
 * against, so a mangled row must read as "cannot check" and never as "the
 * order has these lines".
 */
function readLines(json: string | null): PurchaseOrderLine[] | null {
  if (json === null) return null;
  const rehydrated = rehydrateOrderLines(json);
  return rehydrated.ok ? rehydrated.value : null;
}

function toRecord(row: Row): BuyerOrderRecord {
  const stored =
    row.acknowledgement_json === null
      ? null
      : rehydrateAcknowledgement(row.acknowledgement_json, hash);
  return {
    purchaseOrderId: row.purchase_order_id,
    // Coalesced rather than asserted: a row written before these columns
    // existed reads as "cannot describe", which the sweep skips. Asserting
    // would put the string "null" in a digest field and ask a supplier about
    // an order that never had that digest.
    orderDigest: row.order_digest ?? '',
    idempotencyKey: row.idempotency_key ?? '',
    protocolVersion: row.protocol_version ?? '',
    serviceRkey: row.service_rkey ?? '',
    revision: row.revision ?? 0,
    quoteDigest: row.quote_digest ?? '',
    quoteId: row.quote_id ?? '',
    buyerDid: row.buyer_did ?? '',
    supplierDid: row.bound_supplier_did ?? '',
    state: row.state as BuyerOrderState,
    acknowledgement: stored !== null && stored.ok ? stored.value : null,
    nextPollAtMs: row.next_poll_at_ms,
    pollCount: row.poll_count,
    // SQLite has no boolean. Compared to 1 rather than coerced, so a stray
    // value can never read as "you may send this order again".
    resubmissionAuthorized: row.resubmission_authorized === 1,
    protocolFault:
      stored !== null && !stored.ok
        ? `stored acknowledgement is unreadable: ${stored.error}`
        : row.protocol_fault,
    // NULL rather than [] on an unreadable or absent snapshot. The two are
    // different claims: "no lines were kept" makes the status ingest refuse,
    // while an empty array would tell verifyStatusLines the order HAS no
    // lines and turn every real fulfilment update into a fork.
    orderLines: readLines(row.order_lines_json),
    ackEvidence: rehydrateEnvelopeEvidence(row.ack_evidence_json),
  };
}

export class SQLiteBuyerOrderRepository implements BuyerOrderRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  get(supplierDid: string, purchaseOrderId: string): BuyerOrderRecord | null {
    const rows = this.db.query(
      `SELECT ${COLUMNS} FROM commerce_buyer_orders WHERE supplier_did = ? AND purchase_order_id = ?`,
      [supplierDid, purchaseOrderId],
    ) as unknown as Row[];
    return rows[0] === undefined ? null : toRecord(rows[0]);
  }

  create(supplierDid: string, record: BuyerOrderRecord): boolean {
    const affected = this.db.run(
      `INSERT INTO commerce_buyer_orders (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      [
        supplierDid,
        record.purchaseOrderId,
        record.orderDigest,
        record.idempotencyKey,
        record.protocolVersion,
        record.serviceRkey,
        record.revision,
        record.quoteDigest,
        record.quoteId,
        record.buyerDid,
        record.supplierDid,
        record.state,
        record.acknowledgement === null ? null : JSON.stringify(record.acknowledgement),
        record.nextPollAtMs,
        record.pollCount,
        record.resubmissionAuthorized ? 1 : 0,
        record.protocolFault,
        record.orderLines === null ? null : JSON.stringify(record.orderLines),
        // LAST, matching COLUMNS. The value list is positional, so a value
        // inserted where it reads naturally rather than where the column sits
        // writes every following field into the wrong column.
        record.ackEvidence === null ? null : JSON.stringify(record.ackEvidence),
      ],
    );
    return affected > 0;
  }

  put(supplierDid: string, record: BuyerOrderRecord): boolean {
    const affected = this.db.run(
      `UPDATE commerce_buyer_orders
         SET state = ?, acknowledgement_json = ?, ack_evidence_json = ?,
             next_poll_at_ms = ?, poll_count = ?,
             resubmission_authorized = ?, protocol_fault = ?, revision = revision + 1
       WHERE supplier_did = ? AND purchase_order_id = ? AND revision = ?`,
      [
        record.state,
        record.acknowledgement === null ? null : JSON.stringify(record.acknowledgement),
        // §12.7 — written on the UPDATE, and this is the write that matters.
        // An acknowledgement arrives long AFTER the order row exists, so
        // evidence recorded only at INSERT would be null for exactly the
        // record that needs it.
        record.ackEvidence === null ? null : JSON.stringify(record.ackEvidence),
        record.nextPollAtMs,
        record.pollCount,
        record.resubmissionAuthorized ? 1 : 0,
        record.protocolFault,
        supplierDid,
        record.purchaseOrderId,
        record.revision,
      ],
    );
    return affected > 0;
  }

  listUnsettled(): { supplierDid: string; record: BuyerOrderRecord }[] {
    // Unsettled means "no answer yet", which is the pair of non-terminal
    // states. Selecting on those rather than on `next_poll_at_ms IS NOT NULL`
    // keeps a freshly submitted order — which has no poll scheduled — visible
    // to an owner who wants to know what is outstanding.
    const rows = this.db.query(
      `SELECT ${COLUMNS} FROM commerce_buyer_orders
        WHERE state IN ('submitted_unconfirmed', 'outcome_unknown')
        ORDER BY COALESCE(next_poll_at_ms, 0) ASC, purchase_order_id ASC`,
      [],
    ) as unknown as Row[];
    return rows.map((row) => ({ supplierDid: row.supplier_did, record: toRecord(row) }));
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryBuyerOrderRepository implements BuyerOrderRepository {
  private readonly rows = new Map<string, { supplierDid: string; record: BuyerOrderRecord }>();

  private key(supplierDid: string, purchaseOrderId: string): string {
    return `${supplierDid} ${purchaseOrderId}`;
  }

  get(supplierDid: string, purchaseOrderId: string): BuyerOrderRecord | null {
    return this.rows.get(this.key(supplierDid, purchaseOrderId))?.record ?? null;
  }

  create(supplierDid: string, record: BuyerOrderRecord): boolean {
    const key = this.key(supplierDid, record.purchaseOrderId);
    if (this.rows.has(key)) return false;
    this.rows.set(key, { supplierDid, record });
    return true;
  }

  put(supplierDid: string, record: BuyerOrderRecord): boolean {
    const key = this.key(supplierDid, record.purchaseOrderId);
    const live = this.rows.get(key);
    // THE SAME CAS AS THE REAL STORE. A double that accepted every write would
    // make the conflict path untestable, and this codebase has been bitten by
    // exactly that before: an in-memory repo that upserts where real SQL
    // updates hid a `create`-versus-`put` mutation.
    if (live === undefined || live.record.revision !== record.revision) return false;
    this.rows.set(key, { supplierDid, record: { ...record, revision: record.revision + 1 } });
    return true;
  }

  listUnsettled(): { supplierDid: string; record: BuyerOrderRecord }[] {
    return [...this.rows.values()]
      .filter(
        (entry) =>
          entry.record.state === 'submitted_unconfirmed' ||
          entry.record.state === 'outcome_unknown',
      )
      .sort(
        (a, b) =>
          (a.record.nextPollAtMs ?? 0) - (b.record.nextPollAtMs ?? 0) ||
          (a.record.purchaseOrderId < b.record.purchaseOrderId ? -1 : 1),
      );
  }
}
