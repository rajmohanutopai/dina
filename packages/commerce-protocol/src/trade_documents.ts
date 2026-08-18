/**
 * Trade documents (TRADE_FIRST_STRATEGY §3.4, §4.2, §4.3) — the khata
 * chain and the tender decline. Five documents that extend the shipped
 * order conversation past `accepted`, where this trade's relationship
 * actually starts: delivery, shortage, credit, payment.
 *
 * Construction discipline, identical to every shipped commerce record:
 *
 * - Records carry content digests and NO signature fields. A document's
 *   authenticity is the retained signed D2D envelope it arrived in —
 *   `reconcile.ts` documents why a bare `{record, signature}` pair is
 *   unverifiable by construction.
 * - Every digest excludes its own field from its preimage and is
 *   domain-separated. These five use their OWN prefix family,
 *   `dina:commerce:trade:v1:<domain>`, following the catalog-family
 *   precedent — the ten §9.12 domains are a closed vocabulary pinned by
 *   frozen vectors and are not reopened here.
 * - Validators refuse rather than default. Cross-document rules
 *   (a receipt against its note, an acknowledgement against its payment
 *   note) are pairwise verifiers beside the shape validators, and each
 *   applies the §9.13 conversation-version rule: an answer document
 *   must carry its predecessor's protocol_version.
 *
 * What deliberately does NOT live here: the cumulative over-delivery
 * check (Σ delivered across a purchase order's retained notes must not
 * exceed the order quantity per line) needs the stored note set, so it
 * is an ingest-time rule at the store boundary, the §9.11 pattern. A
 * stateless per-note validator cannot enforce it and does not pretend
 * to.
 */

import { bytesToHex, canonicalJson, utf8Bytes } from './canonical';
import {
  verifyConversationVersion,
  isRecord,
  validateDid,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';
import { validateMoney, moneyMinorUnits, type Money } from './money';
import { compareQuantities, validateQuantity, type Quantity } from './quantity';
import { MAX_QUOTE_LINES, type QuoteRequest } from './quote';

import type { Sha256Fn } from './digests';

// ---------------------------------------------------------------------------
// Digest family
// ---------------------------------------------------------------------------

/** Domain separation for trade documents. Distinct from §9.12's closed set. */
const TRADE_PREFIX = 'dina:commerce:trade:v1:';

export const TRADE_DIGEST_DOMAINS = [
  'quote_decline',
  'delivery_note',
  'delivery_receipt',
  'payment_note',
  'payment_ack',
] as const;

export type TradeDigestDomain = (typeof TRADE_DIGEST_DOMAINS)[number];

/** The digest field each domain excludes from its own input. */
export const TRADE_DIGEST_FIELD_BY_DOMAIN: Readonly<Record<TradeDigestDomain, string>> = {
  quote_decline: 'decline_digest',
  delivery_note: 'note_digest',
  delivery_receipt: 'receipt_digest',
  payment_note: 'note_digest',
  payment_ack: 'ack_digest',
};

/** Digest a record under a trade domain, excluding its own digest field. */
export function tradeRecordDigest(
  domain: TradeDigestDomain,
  record: Record<string, unknown>,
  sha256: Sha256Fn,
): string {
  const digestField = TRADE_DIGEST_FIELD_BY_DOMAIN[domain];
  const { [digestField]: _excluded, ...rest } = record;
  const preimage = `${TRADE_PREFIX}${domain}\n${canonicalJson(rest)}`;
  return bytesToHex(sha256(utf8Bytes(preimage)));
}

/** Verify a trade record's digest field against a recomputation. */
export function verifyTradeRecordDigest(
  domain: TradeDigestDomain,
  record: Record<string, unknown>,
  sha256: Sha256Fn,
): string | null {
  const digestField = TRADE_DIGEST_FIELD_BY_DOMAIN[domain];
  const claimed = record[digestField];
  if (typeof claimed !== 'string' || !/^[0-9a-f]{64}$/.test(claimed)) {
    return `digest: ${digestField} must be a 64-char lowercase hex string`;
  }
  const recomputed = tradeRecordDigest(domain, record, sha256);
  if (claimed !== recomputed) {
    return `digest: ${digestField} does not match the canonical ${domain} recomputation`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bounds and vocabularies
// ---------------------------------------------------------------------------

/** One line-count bound for every lined trade document — the §9.7 bound. */
export const MAX_TRADE_LINES = MAX_QUOTE_LINES;
export const MAX_TRADE_REASON_CODE_LENGTH = 64;
export const MAX_EXTERNAL_REF_LENGTH = 200;
export const MAX_PAYMENT_ORDER_REFS = 50;

/**
 * Protocol-defined decline reasons (§3.4). The set is open for
 * supplier-policy codes; these carry pinned semantics.
 * `unknown_buyer` joins in phase 3, when strangers can ask at all.
 */
export const KNOWN_QUOTE_DECLINE_REASONS = ['out_of_region', 'capacity', 'policy'] as const;

/**
 * Protocol-defined receipt reasons (§4.2). BUYER-extensible — the buyer
 * authors the field; supplier-policy codes have no place in a
 * buyer-signed document.
 */
export const KNOWN_DELIVERY_RECEIPT_REASONS = ['damaged', 'short', 'wrong_item', 'refused'] as const;

export const PAYMENT_METHODS = ['cash', 'upi', 'cheque', 'transfer', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

function validateReasonCode(value: unknown, field: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TRADE_REASON_CODE_LENGTH) {
    return `${field}: must be a non-empty string of at most ${MAX_TRADE_REASON_CODE_LENGTH} characters`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// QuoteDecline (§3.4)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/consistent-type-definitions --
   the catalog_publication.ts rule: only a type alias carries the implicit
   index signature that makes these records assignable to the
   `Record<string, unknown>` the digest functions take. As interfaces,
   every digest call site needs an `as unknown as` double-cast — the cast
   family a prior wire bug shipped through. */
export type QuoteDecline = {
  protocol_version: string;
  decline_id: string;
  request_id: string;
  request_digest: string;
  buyer_did: string;
  supplier_did: string;
  reason_code: string;
  issued_at: string;
  decline_digest: string;
}

export type ReadQuoteDecline = { ok: true; decline: QuoteDecline } | { ok: false; error: string };

export function validateQuoteDecline(decline: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(decline)) return 'decline: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(decline.protocol_version, 'decline.protocol_version'),
    validateId(decline.decline_id, 'decline.decline_id'),
    validateId(decline.request_id, 'decline.request_id'),
    validateHex64(decline.request_digest, 'decline.request_digest'),
    validateDid(decline.buyer_did, 'decline.buyer_did'),
    validateDid(decline.supplier_did, 'decline.supplier_did'),
    validateReasonCode(decline.reason_code, 'decline.reason_code'),
    validateIsoUtc(decline.issued_at, 'decline.issued_at'),
  ];
  for (const err of checks) if (err) return err;
  return verifyTradeRecordDigest('quote_decline', decline, sha256);
}

export function readQuoteDecline(decline: unknown, sha256: Sha256Fn): ReadQuoteDecline {
  const error = validateQuoteDecline(decline, sha256);
  return error === null ? { ok: true, decline: decline as QuoteDecline } : { ok: false, error };
}

/**
 * A decline against the RETAINED request it claims to answer: identity,
 * digest, parties and the §9.13 version all must line up — a decline for
 * some other request must not close this conversation.
 */
export function verifyQuoteDeclineAgainstRequest(
  decline: QuoteDecline,
  request: QuoteRequest,
): string | null {
  if (decline.request_id !== request.request_id) {
    return 'decline: request_id does not match the retained request';
  }
  if (decline.request_digest !== request.request_digest) {
    return 'decline: request_digest does not match the retained request';
  }
  if (decline.buyer_did !== request.buyer_did || decline.supplier_did !== request.supplier_did) {
    return 'decline: parties do not match the retained request';
  }
  return verifyConversationVersion(request.protocol_version, decline.protocol_version, 'decline');
}

// ---------------------------------------------------------------------------
// DeliveryNote (§4.2) — supplier-issued, per order, per dispatch
// ---------------------------------------------------------------------------

export interface DeliveryNoteLine {
  line_id: string;
  delivered_quantity: Quantity;
}

export type DeliveryNote = {
  protocol_version: string;
  delivery_note_id: string;
  purchase_order_id: string;
  order_digest: string;
  supplier_order_id: string;
  lines: DeliveryNoteLine[];
  dispatched_at: string;
  expected_by?: string;
  note_digest: string;
}

export type ReadDeliveryNote = { ok: true; note: DeliveryNote } | { ok: false; error: string };

function validateLineList(
  lines: unknown,
  path: string,
  validateLine: (line: Record<string, unknown>) => string | null,
): string | null {
  if (!Array.isArray(lines) || lines.length === 0) {
    return `${path}: must be a non-empty array`;
  }
  if (lines.length > MAX_TRADE_LINES) {
    return `${path}: exceeds ${MAX_TRADE_LINES} lines`;
  }
  const seen = new Set<string>();
  for (const line of lines) {
    if (!isRecord(line)) return `${path}[]: must be objects`;
    const idError = validateId(line.line_id, `${path}[].line_id`);
    if (idError) return idError;
    const lineError = validateLine(line);
    if (lineError) return lineError;
    if (seen.has(line.line_id as string)) {
      return `${path}: duplicate line_id "${String(line.line_id)}"`;
    }
    seen.add(line.line_id as string);
  }
  return null;
}

export function validateDeliveryNote(note: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(note)) return 'deliveryNote: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(note.protocol_version, 'deliveryNote.protocol_version'),
    validateId(note.delivery_note_id, 'deliveryNote.delivery_note_id'),
    validateId(note.purchase_order_id, 'deliveryNote.purchase_order_id'),
    validateHex64(note.order_digest, 'deliveryNote.order_digest'),
    validateId(note.supplier_order_id, 'deliveryNote.supplier_order_id'),
    validateIsoUtc(note.dispatched_at, 'deliveryNote.dispatched_at'),
  ];
  for (const err of checks) if (err) return err;
  if (note.expected_by !== undefined) {
    const err = validateIsoUtc(note.expected_by, 'deliveryNote.expected_by');
    if (err) return err;
  }
  // A note line asserts a dispatch, so zero is not a dispatch — the
  // zero-acceptance case lives on the RECEIPT, where refusal is a value.
  const linesError = validateLineList(note.lines, 'deliveryNote.lines', (line) =>
    validateQuantity(line.delivered_quantity, { require_positive: true }),
  );
  if (linesError) return linesError;
  return verifyTradeRecordDigest('delivery_note', note, sha256);
}

export function readDeliveryNote(note: unknown, sha256: Sha256Fn): ReadDeliveryNote {
  const error = validateDeliveryNote(note, sha256);
  return error === null ? { ok: true, note: note as DeliveryNote } : { ok: false, error };
}

// ---------------------------------------------------------------------------
// DeliveryReceipt (§4.2) — buyer-issued, per note
// ---------------------------------------------------------------------------

export interface DeliveryReceiptLine {
  line_id: string;
  accepted_quantity: Quantity;
  reason_code?: string;
}

export type DeliveryReceipt = {
  protocol_version: string;
  delivery_receipt_id: string;
  delivery_note_digest: string;
  lines: DeliveryReceiptLine[];
  received_at: string;
  receipt_digest: string;
}

export type ReadDeliveryReceipt =
  | { ok: true; receipt: DeliveryReceipt }
  | { ok: false; error: string };

export function validateDeliveryReceipt(receipt: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(receipt)) return 'deliveryReceipt: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(receipt.protocol_version, 'deliveryReceipt.protocol_version'),
    validateId(receipt.delivery_receipt_id, 'deliveryReceipt.delivery_receipt_id'),
    validateHex64(receipt.delivery_note_digest, 'deliveryReceipt.delivery_note_digest'),
    validateIsoUtc(receipt.received_at, 'deliveryReceipt.received_at'),
  ];
  for (const err of checks) if (err) return err;
  // Zero acceptance IS legal — a fully refused shipment is a receipt
  // whose every accepted_quantity is 0 (§4.4 accrues nothing for it).
  const linesError = validateLineList(receipt.lines, 'deliveryReceipt.lines', (line) => {
    const quantityError = validateQuantity(line.accepted_quantity);
    if (quantityError) return quantityError;
    if (line.reason_code !== undefined) {
      return validateReasonCode(line.reason_code, 'deliveryReceipt.lines[].reason_code');
    }
    return null;
  });
  if (linesError) return linesError;
  return verifyTradeRecordDigest('delivery_receipt', receipt, sha256);
}

export function readDeliveryReceipt(receipt: unknown, sha256: Sha256Fn): ReadDeliveryReceipt {
  const error = validateDeliveryReceipt(receipt, sha256);
  return error === null ? { ok: true, receipt: receipt as DeliveryReceipt } : { ok: false, error };
}

/**
 * A receipt against the note it pins (§4.2): digest match, the §9.13
 * version rule, every receipt line present ON the note with the SAME
 * unit, and `accepted_quantity ≤ delivered_quantity` per line. A
 * receipt may omit note lines — an omitted line is simply not yet
 * receipted and keeps sweeping — but may not invent one.
 */
export function verifyDeliveryReceiptAgainstNote(
  receipt: DeliveryReceipt,
  note: DeliveryNote,
  sha256: Sha256Fn,
): string | null {
  const noteDigest = tradeRecordDigest('delivery_note', note, sha256);
  if (receipt.delivery_note_digest !== noteDigest) {
    return 'deliveryReceipt: delivery_note_digest does not match the retained note';
  }
  const versionError = verifyConversationVersion(
    note.protocol_version,
    receipt.protocol_version,
    'deliveryReceipt',
  );
  if (versionError) return versionError;

  const noteLines = new Map(note.lines.map((line) => [line.line_id, line]));
  for (const line of receipt.lines) {
    const noteLine = noteLines.get(line.line_id);
    if (noteLine === undefined) {
      return `deliveryReceipt: line "${line.line_id}" is not on the note`;
    }
    const compared = compareQuantities(line.accepted_quantity, noteLine.delivered_quantity);
    if (typeof compared === 'string') {
      return `deliveryReceipt: line "${line.line_id}": ${compared}`;
    }
    if (compared > 0) {
      return `deliveryReceipt: line "${line.line_id}" accepts more than the note delivered`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// PaymentNote (§4.2) — buyer-issued, relationship-scoped
// ---------------------------------------------------------------------------

export type PaymentNote = {
  protocol_version: string;
  payment_note_id: string;
  buyer_did: string;
  supplier_did: string;
  amount: Money;
  method: PaymentMethod;
  external_ref?: string;
  paid_at: string;
  /** Advisory display data ONLY — allocation is never a wire fact (§4.4). */
  order_refs?: string[];
  note_digest: string;
}

export type ReadPaymentNote = { ok: true; note: PaymentNote } | { ok: false; error: string };

export function validatePaymentNote(note: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(note)) return 'paymentNote: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(note.protocol_version, 'paymentNote.protocol_version'),
    validateId(note.payment_note_id, 'paymentNote.payment_note_id'),
    validateDid(note.buyer_did, 'paymentNote.buyer_did'),
    validateDid(note.supplier_did, 'paymentNote.supplier_did'),
    validateMoney(note.amount),
    validateIsoUtc(note.paid_at, 'paymentNote.paid_at'),
  ];
  for (const err of checks) if (err) return err;
  if (!(PAYMENT_METHODS as readonly string[]).includes(note.method as string)) {
    return `paymentNote.method: must be one of ${PAYMENT_METHODS.join(' | ')}`;
  }
  // A zero payment is not a payment; refusing it here keeps the fold's
  // payment side free of no-op documents.
  if (moneyMinorUnits(note.amount as Money) === 0n) {
    return 'paymentNote.amount: must be positive';
  }
  if (note.external_ref !== undefined) {
    if (
      typeof note.external_ref !== 'string' ||
      note.external_ref.length === 0 ||
      note.external_ref.length > MAX_EXTERNAL_REF_LENGTH
    ) {
      return `paymentNote.external_ref: must be a non-empty string of at most ${MAX_EXTERNAL_REF_LENGTH} characters`;
    }
  }
  if (note.order_refs !== undefined) {
    if (!Array.isArray(note.order_refs) || note.order_refs.length === 0) {
      return 'paymentNote.order_refs: when present, must be a non-empty array';
    }
    if (note.order_refs.length > MAX_PAYMENT_ORDER_REFS) {
      return `paymentNote.order_refs: exceeds ${MAX_PAYMENT_ORDER_REFS} references`;
    }
    const seen = new Set<string>();
    for (const ref of note.order_refs) {
      const err = validateId(ref, 'paymentNote.order_refs[]');
      if (err) return err;
      if (seen.has(ref as string)) {
        return `paymentNote.order_refs: duplicate "${String(ref)}"`;
      }
      seen.add(ref as string);
    }
  }
  return verifyTradeRecordDigest('payment_note', note, sha256);
}

export function readPaymentNote(note: unknown, sha256: Sha256Fn): ReadPaymentNote {
  const error = validatePaymentNote(note, sha256);
  return error === null ? { ok: true, note: note as PaymentNote } : { ok: false, error };
}

// ---------------------------------------------------------------------------
// PaymentAcknowledgement (§4.2) — supplier-issued, per payment note
// ---------------------------------------------------------------------------

export type PaymentAcknowledgement = {
  protocol_version: string;
  payment_ack_id: string;
  payment_note_digest: string;
  acknowledged_at: string;
  ack_digest: string;
} & (
  | {
      kind: 'received';
      /** The CREDITED amount — mandatory, may be less than asserted. */
      amount_received: Money;
    }
  | { kind: 'disputed' }
);

export type ReadPaymentAcknowledgement =
  | { ok: true; ack: PaymentAcknowledgement }
  | { ok: false; error: string };

export function validatePaymentAcknowledgement(ack: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(ack)) return 'paymentAck: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(ack.protocol_version, 'paymentAck.protocol_version'),
    validateId(ack.payment_ack_id, 'paymentAck.payment_ack_id'),
    validateHex64(ack.payment_note_digest, 'paymentAck.payment_note_digest'),
    validateIsoUtc(ack.acknowledged_at, 'paymentAck.acknowledged_at'),
  ];
  for (const err of checks) if (err) return err;

  // Kind-narrowed, exactly (§4.2): `received` REQUIRES the credited
  // amount; `disputed` FORBIDS one (it credits zero — an amount on a
  // dispute would be a number nobody agreed to fold).
  switch (ack.kind) {
    case 'received': {
      const err = validateMoney(ack.amount_received);
      if (err) return `paymentAck.amount_received: ${err}`;
      break;
    }
    case 'disputed': {
      if (ack.amount_received !== undefined) {
        return 'paymentAck.amount_received: forbidden when kind is disputed';
      }
      break;
    }
    default:
      return 'paymentAck.kind: must be received | disputed';
  }
  return verifyTradeRecordDigest('payment_ack', ack, sha256);
}

export function readPaymentAcknowledgement(
  ack: unknown,
  sha256: Sha256Fn,
): ReadPaymentAcknowledgement {
  const error = validatePaymentAcknowledgement(ack, sha256);
  return error === null
    ? { ok: true, ack: ack as PaymentAcknowledgement }
    : { ok: false, error };
}

/**
 * An acknowledgement against the payment note it pins (§4.2/§4.4):
 * digest match, the §9.13 version rule, and for `received` the credited
 * amount bound to the note — same currency, and never MORE money than
 * was asserted paid. Non-negativity is inherent (Money minor units are
 * canonical non-negative integers).
 */
export function verifyPaymentAckAgainstNote(
  ack: PaymentAcknowledgement,
  note: PaymentNote,
  sha256: Sha256Fn,
): string | null {
  const noteDigest = tradeRecordDigest('payment_note', note, sha256);
  if (ack.payment_note_digest !== noteDigest) {
    return 'paymentAck: payment_note_digest does not match the retained note';
  }
  const versionError = verifyConversationVersion(
    note.protocol_version,
    ack.protocol_version,
    'paymentAck',
  );
  if (versionError) return versionError;
  if (ack.kind === 'received') {
    if (ack.amount_received.currency !== note.amount.currency) {
      return 'paymentAck: amount_received currency does not match the note';
    }
    if (moneyMinorUnits(ack.amount_received) > moneyMinorUnits(note.amount)) {
      return 'paymentAck: amount_received exceeds the note amount';
    }
  }
  return null;
}
