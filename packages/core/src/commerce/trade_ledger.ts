/**
 * The trade-document ledger (TRADE_FIRST_STRATEGY §4.2/§4.3) — retained
 * khata documents + tender declines, and the inbound verifiers that
 * decide what may enter it.
 *
 * The store keeps every document THIS node authored and every
 * counterparty document that survived verification — record and envelope
 * evidence together, digest-keyed so replay is a no-op (`put` is
 * first-writer-wins, the commerce_receipts discipline). Rows are
 * re-validated through the trade validators on read: a row edited after
 * writing reads as absent, the same rule every commerce store follows.
 *
 * The inbound verifiers mirror `verifyInboundQuote`'s shape: the
 * TRANSPORT-authenticated sender is the authority, and every party field
 * inside a body a counterparty wrote is CHECKED against it, never
 * trusted. Binding comes before chain reasoning; each verifier applies
 * the pairwise rules from `@dina/commerce-protocol` and then the rules
 * only a store can enforce:
 *
 * - CUMULATIVE OVER-DELIVERY (§4.2): per line, Σ delivered_quantity
 *   across the order's retained notes plus the arriving note must not
 *   exceed the ordered quantity — the §9.11 pattern; a stateless
 *   validator cannot see the other notes.
 * - ONE ANSWER PER DOCUMENT: a note has at most one receipt, a payment
 *   note one acknowledgement, a request one decline. The first verified
 *   answer is final; a byte-identical replay is `duplicate`, a
 *   different second answer is `conflict` and the held one stands —
 *   applying a contradiction would let the contradiction win.
 *
 * Order and request lookups are INJECTED (`readOrder`, `readRequest`):
 * which store retains those records differs by side, and this module
 * has no business knowing.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  compareQuantities,
  quantityToRational,
  readDeliveryNote,
  readDeliveryReceipt,
  readPaymentAcknowledgement,
  readPaymentNote,
  readQuoteDecline,
  tradeRecordDigest,
  verifyDeliveryReceiptAgainstNote,
  verifyPaymentAckAgainstNote,
  verifyQuoteDeclineAgainstRequest,
  verifyConversationVersion,
  type DeliveryNote,
  type DeliveryReceipt,
  type PaymentAcknowledgement,
  type PaymentNote,
  type PurchaseOrderProposal,
  type QuoteDecline,
  type QuoteRequest,
  type Sha256Fn,
  type TradeDigestDomain,
} from '@dina/commerce-protocol';

import {
  rehydrateDeliveryNote,
  rehydrateDeliveryReceipt,
  rehydratePaymentAck,
  rehydratePaymentNote,
  rehydrateQuoteDecline,
} from './rehydrate';

import type { DatabaseAdapter, DBRow } from '../storage/db_adapter';

const hash: Sha256Fn = (data) => sha256(data);

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type TradeDocumentKind = TradeDigestDomain;
export type TradeDocumentDirection = 'inbound' | 'outbound';

export interface TradeDocumentRow {
  recordDigest: string;
  kind: TradeDocumentKind;
  /** The OTHER party — the relationship key. */
  counterpartyDid: string;
  /** Delivery-leg + decline anchor; '' for the payment leg. */
  purchaseOrderId: string;
  /** The digest this document answers ('' for notes/payment notes). */
  answersDigest: string;
  direction: TradeDocumentDirection;
  recordJson: string;
  evidenceJson: string;
  createdAt: number;
}

export interface TradeDocumentRepository {
  /** First-writer-wins on record digest. False when already stored. */
  put(row: TradeDocumentRow): boolean;
  get(recordDigest: string): TradeDocumentRow | null;
  listByOrder(purchaseOrderId: string, kind: TradeDocumentKind): TradeDocumentRow[];
  listByCounterparty(counterpartyDid: string, kind: TradeDocumentKind): TradeDocumentRow[];
  /** Every row of a kind in a direction — the §7 inbox walks these. */
  listByKind(kind: TradeDocumentKind, direction: 'inbound' | 'outbound'): TradeDocumentRow[];
  /** The rows answering a document — the one-answer rule reads this. */
  answersTo(recordDigest: string, kind: TradeDocumentKind): TradeDocumentRow[];
}

/** A stored row that no longer describes itself. Not an ordinary refusal. */
export class TradeLedgerIntegrityError extends Error {}

/**
 * Re-derive a stored document through its validator, via the ONE module
 * that reads stored commerce records (`rehydrate.ts`), plus the row
 * cross-check only the store can make: the record's own digest must be
 * the digest the row is keyed by.
 */
export function rehydrateTradeDocument(
  row: TradeDocumentRow,
):
  | { kind: 'quote_decline'; document: QuoteDecline }
  | { kind: 'delivery_note'; document: DeliveryNote }
  | { kind: 'delivery_receipt'; document: DeliveryReceipt }
  | { kind: 'payment_note'; document: PaymentNote }
  | { kind: 'payment_ack'; document: PaymentAcknowledgement } {
  const fail = (error: string): never => {
    throw new TradeLedgerIntegrityError(`stored ${row.kind} ${row.recordDigest}: ${error}`);
  };
  const bind = <T>(rehydrated: { ok: boolean; value?: T; error?: string }, digest: string): T => {
    if (!rehydrated.ok || rehydrated.value === undefined) fail(rehydrated.error ?? 'unreadable');
    if (digest !== row.recordDigest) fail('digest mismatch with row');
    return rehydrated.value as T;
  };
  switch (row.kind) {
    case 'quote_decline': {
      const read = rehydrateQuoteDecline(row.recordJson, hash);
      const document = bind(read, read.ok ? read.value.decline_digest : '');
      return { kind: row.kind, document };
    }
    case 'delivery_note': {
      const read = rehydrateDeliveryNote(row.recordJson, hash);
      const document = bind(read, read.ok ? read.value.note_digest : '');
      return { kind: row.kind, document };
    }
    case 'delivery_receipt': {
      const read = rehydrateDeliveryReceipt(row.recordJson, hash);
      const document = bind(read, read.ok ? read.value.receipt_digest : '');
      return { kind: row.kind, document };
    }
    case 'payment_note': {
      const read = rehydratePaymentNote(row.recordJson, hash);
      const document = bind(read, read.ok ? read.value.note_digest : '');
      return { kind: row.kind, document };
    }
    case 'payment_ack': {
      const read = rehydratePaymentAck(row.recordJson, hash);
      const document = bind(read, read.ok ? read.value.ack_digest : '');
      return { kind: row.kind, document };
    }
  }
}

function rowFromDb(row: DBRow): TradeDocumentRow {
  return {
    recordDigest: String(row.record_digest),
    kind: String(row.kind) as TradeDocumentKind,
    counterpartyDid: String(row.counterparty_did),
    purchaseOrderId: String(row.purchase_order_id),
    answersDigest: String(row.answers_digest),
    direction: String(row.direction) as TradeDocumentDirection,
    recordJson: String(row.record_json),
    evidenceJson: String(row.evidence_json),
    createdAt: Number(row.created_at),
  };
}

export class SQLiteTradeDocumentRepository implements TradeDocumentRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  put(row: TradeDocumentRow): boolean {
    return (
      this.db.run(
        `INSERT INTO commerce_trade_documents
           (record_digest, kind, counterparty_did, purchase_order_id,
            answers_digest, direction, record_json, evidence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(record_digest) DO NOTHING`,
        [
          row.recordDigest,
          row.kind,
          row.counterpartyDid,
          row.purchaseOrderId,
          row.answersDigest,
          row.direction,
          row.recordJson,
          row.evidenceJson,
          row.createdAt,
        ],
      ) > 0
    );
  }

  get(recordDigest: string): TradeDocumentRow | null {
    const rows = this.db.query(
      `SELECT * FROM commerce_trade_documents WHERE record_digest = ?`,
      [recordDigest],
    );
    return rows[0] === undefined ? null : rowFromDb(rows[0]);
  }

  listByOrder(purchaseOrderId: string, kind: TradeDocumentKind): TradeDocumentRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_trade_documents
          WHERE purchase_order_id = ? AND kind = ? ORDER BY created_at, record_digest`,
        [purchaseOrderId, kind],
      )
      .map(rowFromDb);
  }

  listByCounterparty(counterpartyDid: string, kind: TradeDocumentKind): TradeDocumentRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_trade_documents
          WHERE counterparty_did = ? AND kind = ? ORDER BY created_at, record_digest`,
        [counterpartyDid, kind],
      )
      .map(rowFromDb);
  }

  listByKind(kind: TradeDocumentKind, direction: 'inbound' | 'outbound'): TradeDocumentRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_trade_documents
          WHERE kind = ? AND direction = ? ORDER BY created_at, record_digest`,
        [kind, direction],
      )
      .map(rowFromDb);
  }

  answersTo(recordDigest: string, kind: TradeDocumentKind): TradeDocumentRow[] {
    return this.db
      .query(
        `SELECT * FROM commerce_trade_documents
          WHERE answers_digest = ? AND kind = ? ORDER BY created_at, record_digest`,
        [recordDigest, kind],
      )
      .map(rowFromDb);
  }
}

/** Test double. A production caller would be the bug. */
export class InMemoryTradeDocumentRepository implements TradeDocumentRepository {
  private readonly rows = new Map<string, TradeDocumentRow>();

  put(row: TradeDocumentRow): boolean {
    if (this.rows.has(row.recordDigest)) return false;
    this.rows.set(row.recordDigest, { ...row });
    return true;
  }

  get(recordDigest: string): TradeDocumentRow | null {
    const row = this.rows.get(recordDigest);
    return row === undefined ? null : { ...row };
  }

  private sorted(filter: (row: TradeDocumentRow) => boolean): TradeDocumentRow[] {
    return [...this.rows.values()]
      .filter(filter)
      .sort((a, b) => a.createdAt - b.createdAt || a.recordDigest.localeCompare(b.recordDigest))
      .map((row) => ({ ...row }));
  }

  listByOrder(purchaseOrderId: string, kind: TradeDocumentKind): TradeDocumentRow[] {
    return this.sorted((r) => r.purchaseOrderId === purchaseOrderId && r.kind === kind);
  }

  listByCounterparty(counterpartyDid: string, kind: TradeDocumentKind): TradeDocumentRow[] {
    return this.sorted((r) => r.counterpartyDid === counterpartyDid && r.kind === kind);
  }

  listByKind(kind: TradeDocumentKind, direction: 'inbound' | 'outbound'): TradeDocumentRow[] {
    return this.sorted((r) => r.kind === kind && r.direction === direction);
  }

  answersTo(recordDigest: string, kind: TradeDocumentKind): TradeDocumentRow[] {
    return this.sorted((r) => r.answersDigest === recordDigest && r.kind === kind);
  }
}

// ---------------------------------------------------------------------------
// Inbound verification
// ---------------------------------------------------------------------------

/**
 * What happened to an inbound trade document. Parallel to
 * `BuyerQuoteOutcome`, with `conflict` carrying the one-answer rule:
 * the held answer stands, the second one is evidence, never applied.
 */
export type TradeIngestOutcome =
  | 'applied'
  | 'duplicate'
  | 'unreadable'
  | 'not_ours'
  | 'refused'
  | 'conflict';

export interface TradeIngest {
  outcome: TradeIngestOutcome;
  detail?: string;
  recordDigest?: string;
}

/** Injected: the retained, validated order this side holds. */
export type RetainedOrderReader = (purchaseOrderId: string) => PurchaseOrderProposal | null;
/** Injected: the retained request a decline claims to answer. */
export type RetainedRequestReader = (requestId: string) => QuoteRequest | null;

function applied(digest: string): TradeIngest {
  return { outcome: 'applied', recordDigest: digest };
}

/**
 * The §4.2 cumulative over-delivery rule, in ONE place — the inbound
 * verifier runs it on arrival and the authoring service runs it before
 * issuing, so a node can never author a note its counterparty will
 * refuse. Per line: the line must be ON the order, unit-comparable,
 * and Σ delivered across the retained note set plus this note must not
 * exceed the ordered quantity — exact rationals, no rounding anywhere
 * on quantities (the §9.11 pattern).
 */
export function checkCumulativeDelivery(args: {
  note: DeliveryNote;
  order: PurchaseOrderProposal;
  repository: TradeDocumentRepository;
}): string | null {
  const orderLines = new Map(args.order.accepted_lines.map((line) => [line.line_id, line]));
  const held = args.repository
    .listByOrder(args.note.purchase_order_id, 'delivery_note')
    .map((row) => rehydrateTradeDocument(row))
    .flatMap((doc) => (doc.kind === 'delivery_note' ? [doc.document] : []));
  for (const line of args.note.lines) {
    const orderLine = orderLines.get(line.line_id);
    if (orderLine === undefined) {
      return `deliveryNote: line "${line.line_id}" is not on the order`;
    }
    const comparable = compareQuantities(line.delivered_quantity, orderLine.quantity);
    if (typeof comparable === 'string') {
      return `deliveryNote: ${comparable}`;
    }
    let sumN = 0n;
    let sumD = 1n;
    const add = (value: { numerator: bigint; denominator: bigint }): void => {
      sumN = sumN * value.denominator + value.numerator * sumD;
      sumD = sumD * value.denominator;
    };
    add(quantityToRational(line.delivered_quantity));
    for (const prior of held) {
      const priorLine = prior.lines.find((l) => l.line_id === line.line_id);
      if (priorLine !== undefined) add(quantityToRational(priorLine.delivered_quantity));
    }
    const ordered = quantityToRational(orderLine.quantity);
    if (sumN * ordered.denominator > ordered.numerator * sumD) {
      return `deliveryNote: cumulative delivery for line "${line.line_id}" exceeds the order quantity`;
    }
  }
  return null;
}

/**
 * Inbound DeliveryNote, at the BUYER. Binding: the retained accepted
 * order exists, the sender IS its supplier, this node IS its buyer, the
 * note pins the order digest and version — then the cumulative
 * over-delivery check across the retained note set.
 */
export function verifyInboundDeliveryNote(args: {
  senderDid: string;
  selfDid: string;
  note: unknown;
  repository: TradeDocumentRepository;
  readOrder: RetainedOrderReader;
  evidenceJson: string;
  nowMs: number;
}): TradeIngest {
  const read = readDeliveryNote(args.note, hash);
  if (!read.ok) return { outcome: 'unreadable', detail: read.error };
  const note = read.note;

  // Idempotency FIRST: a byte-identical replay of an applied note must
  // read as duplicate BEFORE the cumulative check, which would otherwise
  // sum the replay against its own stored copy and call it over-delivery.
  const noteDigest = tradeRecordDigest('delivery_note', note, hash);
  if (args.repository.get(noteDigest) !== null) {
    return { outcome: 'duplicate', recordDigest: noteDigest };
  }

  const order = args.readOrder(note.purchase_order_id);
  if (order === null) {
    return { outcome: 'refused', detail: `deliveryNote: no retained order ${note.purchase_order_id}` };
  }
  if (order.supplier_did !== args.senderDid) {
    return { outcome: 'not_ours', detail: 'deliveryNote: sender is not the order supplier' };
  }
  if (order.buyer_did !== args.selfDid) {
    return { outcome: 'not_ours', detail: 'deliveryNote: this node is not the order buyer' };
  }
  if (note.order_digest !== order.order_digest) {
    return { outcome: 'refused', detail: 'deliveryNote: order_digest does not match the retained order' };
  }
  const versionError = verifyConversationVersion(
    order.protocol_version,
    note.protocol_version,
    'deliveryNote',
  );
  if (versionError) return { outcome: 'refused', detail: versionError };

  const cumulativeError = checkCumulativeDelivery({
    note,
    order,
    repository: args.repository,
  });
  if (cumulativeError) return { outcome: 'refused', detail: cumulativeError };

  const stored = args.repository.put({
    recordDigest: noteDigest,
    kind: 'delivery_note',
    counterpartyDid: args.senderDid,
    purchaseOrderId: note.purchase_order_id,
    answersDigest: '',
    direction: 'inbound',
    recordJson: JSON.stringify(note),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return stored ? applied(noteDigest) : { outcome: 'duplicate', recordDigest: noteDigest };
}

/**
 * Inbound DeliveryReceipt, at the SUPPLIER. The pinned note must be one
 * this node authored for this counterparty; the sender must be the
 * order's buyer; the pairwise §4.2 rules apply; ONE receipt per note.
 */
export function verifyInboundDeliveryReceipt(args: {
  senderDid: string;
  selfDid: string;
  receipt: unknown;
  repository: TradeDocumentRepository;
  readOrder: RetainedOrderReader;
  evidenceJson: string;
  nowMs: number;
}): TradeIngest {
  const read = readDeliveryReceipt(args.receipt, hash);
  if (!read.ok) return { outcome: 'unreadable', detail: read.error };
  const receipt = read.receipt;

  const noteRow = args.repository.get(receipt.delivery_note_digest);
  if (noteRow === null || noteRow.kind !== 'delivery_note') {
    return { outcome: 'refused', detail: 'deliveryReceipt: no retained note with that digest' };
  }
  const note = rehydrateTradeDocument(noteRow);
  if (note.kind !== 'delivery_note') {
    return { outcome: 'refused', detail: 'deliveryReceipt: retained row is not a note' };
  }
  const order = args.readOrder(note.document.purchase_order_id);
  if (order === null) {
    return {
      outcome: 'refused',
      detail: `deliveryReceipt: no retained order ${note.document.purchase_order_id}`,
    };
  }
  if (order.buyer_did !== args.senderDid) {
    return { outcome: 'not_ours', detail: 'deliveryReceipt: sender is not the order buyer' };
  }
  if (order.supplier_did !== args.selfDid) {
    return { outcome: 'not_ours', detail: 'deliveryReceipt: this node is not the order supplier' };
  }
  const pairError = verifyDeliveryReceiptAgainstNote(receipt, note.document, hash);
  if (pairError) return { outcome: 'refused', detail: pairError };

  const digest = tradeRecordDigest('delivery_receipt', receipt, hash);
  const existing = args.repository.answersTo(receipt.delivery_note_digest, 'delivery_receipt');
  if (existing.length > 0) {
    return existing.some((row) => row.recordDigest === digest)
      ? { outcome: 'duplicate', recordDigest: digest }
      : {
          outcome: 'conflict',
          detail: 'deliveryReceipt: the note already has a different receipt — the first answer stands',
          recordDigest: existing[0]?.recordDigest ?? '',
        };
  }

  const stored = args.repository.put({
    recordDigest: digest,
    kind: 'delivery_receipt',
    counterpartyDid: args.senderDid,
    purchaseOrderId: note.document.purchase_order_id,
    answersDigest: receipt.delivery_note_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(receipt),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return stored ? applied(digest) : { outcome: 'duplicate', recordDigest: digest };
}

/**
 * Inbound PaymentNote, at the SUPPLIER. Relationship-scoped: the note's
 * buyer must be the authenticated sender and its supplier this node.
 * Idempotent on digest — a replayed note is one note.
 */
export function verifyInboundPaymentNote(args: {
  senderDid: string;
  selfDid: string;
  note: unknown;
  repository: TradeDocumentRepository;
  evidenceJson: string;
  nowMs: number;
}): TradeIngest {
  const read = readPaymentNote(args.note, hash);
  if (!read.ok) return { outcome: 'unreadable', detail: read.error };
  const note = read.note;
  if (note.buyer_did !== args.senderDid) {
    return { outcome: 'not_ours', detail: 'paymentNote: buyer_did is not the authenticated sender' };
  }
  if (note.supplier_did !== args.selfDid) {
    return { outcome: 'not_ours', detail: 'paymentNote: supplier_did is not this node' };
  }
  const digest = tradeRecordDigest('payment_note', note, hash);
  const stored = args.repository.put({
    recordDigest: digest,
    kind: 'payment_note',
    counterpartyDid: args.senderDid,
    purchaseOrderId: '',
    answersDigest: '',
    direction: 'inbound',
    recordJson: JSON.stringify(note),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return stored ? applied(digest) : { outcome: 'duplicate', recordDigest: digest };
}

/**
 * Inbound PaymentAcknowledgement, at the BUYER. The pinned payment note
 * must be one this node AUTHORED (direction outbound); the sender must
 * be its supplier; the pairwise amount/currency/version rules apply;
 * ONE acknowledgement per note, first answer final.
 */
export function verifyInboundPaymentAck(args: {
  senderDid: string;
  selfDid: string;
  ack: unknown;
  repository: TradeDocumentRepository;
  evidenceJson: string;
  nowMs: number;
}): TradeIngest {
  const read = readPaymentAcknowledgement(args.ack, hash);
  if (!read.ok) return { outcome: 'unreadable', detail: read.error };
  const ack = read.ack;

  const noteRow = args.repository.get(ack.payment_note_digest);
  if (noteRow === null || noteRow.kind !== 'payment_note' || noteRow.direction !== 'outbound') {
    return { outcome: 'refused', detail: 'paymentAck: no authored payment note with that digest' };
  }
  const note = rehydrateTradeDocument(noteRow);
  if (note.kind !== 'payment_note') {
    return { outcome: 'refused', detail: 'paymentAck: retained row is not a payment note' };
  }
  if (note.document.supplier_did !== args.senderDid) {
    return { outcome: 'not_ours', detail: 'paymentAck: sender is not the note supplier' };
  }
  if (note.document.buyer_did !== args.selfDid) {
    return { outcome: 'not_ours', detail: 'paymentAck: this node is not the note buyer' };
  }
  const pairError = verifyPaymentAckAgainstNote(ack, note.document, hash);
  if (pairError) return { outcome: 'refused', detail: pairError };

  const digest = tradeRecordDigest('payment_ack', ack, hash);
  const existing = args.repository.answersTo(ack.payment_note_digest, 'payment_ack');
  if (existing.length > 0) {
    return existing.some((row) => row.recordDigest === digest)
      ? { outcome: 'duplicate', recordDigest: digest }
      : {
          outcome: 'conflict',
          detail: 'paymentAck: the note already has a different acknowledgement — the first answer stands',
          recordDigest: existing[0]?.recordDigest ?? '',
        };
  }

  const stored = args.repository.put({
    recordDigest: digest,
    kind: 'payment_ack',
    counterpartyDid: args.senderDid,
    purchaseOrderId: '',
    answersDigest: ack.payment_note_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(ack),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return stored ? applied(digest) : { outcome: 'duplicate', recordDigest: digest };
}

/**
 * Inbound QuoteDecline, at the BUYER. The retained request must exist,
 * the sender must be the supplier it addressed, and the §3.4 binding
 * rules apply. ONE decline per request.
 */
export function verifyInboundQuoteDecline(args: {
  senderDid: string;
  selfDid: string;
  decline: unknown;
  repository: TradeDocumentRepository;
  readRequest: RetainedRequestReader;
  evidenceJson: string;
  nowMs: number;
}): TradeIngest {
  const read = readQuoteDecline(args.decline, hash);
  if (!read.ok) return { outcome: 'unreadable', detail: read.error };
  const decline = read.decline;

  const request = args.readRequest(decline.request_id);
  if (request === null) {
    return { outcome: 'refused', detail: `decline: no retained request ${decline.request_id}` };
  }
  if (request.supplier_did !== args.senderDid) {
    return { outcome: 'not_ours', detail: 'decline: sender is not the request supplier' };
  }
  if (request.buyer_did !== args.selfDid) {
    return { outcome: 'not_ours', detail: 'decline: this node is not the request buyer' };
  }
  const bindError = verifyQuoteDeclineAgainstRequest(decline, request);
  if (bindError) return { outcome: 'refused', detail: bindError };

  const digest = tradeRecordDigest('quote_decline', decline, hash);
  const existing = args.repository.answersTo(decline.request_digest, 'quote_decline');
  if (existing.length > 0) {
    return existing.some((row) => row.recordDigest === digest)
      ? { outcome: 'duplicate', recordDigest: digest }
      : {
          outcome: 'conflict',
          detail: 'decline: the request already has a different decline — the first answer stands',
          recordDigest: existing[0]?.recordDigest ?? '',
        };
  }

  const stored = args.repository.put({
    recordDigest: digest,
    kind: 'quote_decline',
    counterpartyDid: args.senderDid,
    purchaseOrderId: '',
    answersDigest: decline.request_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(decline),
    evidenceJson: args.evidenceJson,
    createdAt: args.nowMs,
  });
  return stored ? applied(digest) : { outcome: 'duplicate', recordDigest: digest };
}
