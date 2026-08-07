/**
 * Purchase-order proposal (§9.9).
 *
 * V1 orders are ALL-OR-NONE against the referenced quote: the
 * accepted lines must equal the quote's full line set with the quoted
 * quantities — ordering a subset or a changed quantity is a new quote
 * request, not an order. The order's delivery projection must EXTEND
 * the priced projection (§9.0/§9.9): priced fields byte-identical,
 * only quote-stage-absent fields added. Expiry is checked at
 * ADMISSION (supplier clock), never re-checked on replay (§9.9
 * precedence) — hence the separate `isQuoteExpiredAt`.
 */

import {
  isRecord,
  isoUtcMillis,
  validateDid,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';
import { verifyCommerceRecordDigest, type Sha256Fn } from './digests';
import { validateMoney, type Money } from './money';
import { productRefsEqual, validateProductRef, type ProductRef } from './product';
import { validateQuantity, type Quantity } from './quantity';
import { MAX_QUOTE_LINES, type SignedQuote } from './quote';
import { projectionExtends, validateDeliveryProjection, type DeliveryProjection } from './region';

export interface PurchaseOrderLine {
  line_id: string;
  product: ProductRef;
  quantity: Quantity;
}

export interface PurchaseOrderProposal {
  protocol_version: string;
  purchase_order_id: string;
  buyer_did: string;
  supplier_did: string;
  quote_id: string;
  quote_digest: string;
  accepted_lines: PurchaseOrderLine[];
  delivery: DeliveryProjection;
  approved_total: Money;
  accepted_terms_digest: string;
  buyer_reference?: string;
  idempotency_key: string;
  submitted_at: string;
  order_digest: string;
}

export const MAX_BUYER_REFERENCE_LENGTH = 200;

/** Structural validation of a proposal, including `order_digest`. */
export function validatePurchaseOrderProposal(order: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(order)) return 'order: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(order.protocol_version, 'order.protocol_version'),
    validateId(order.purchase_order_id, 'order.purchase_order_id'),
    validateDid(order.buyer_did, 'order.buyer_did'),
    validateDid(order.supplier_did, 'order.supplier_did'),
    validateId(order.quote_id, 'order.quote_id'),
    validateHex64(order.quote_digest, 'order.quote_digest'),
    validateHex64(order.accepted_terms_digest, 'order.accepted_terms_digest'),
    validateId(order.idempotency_key, 'order.idempotency_key'),
    validateIsoUtc(order.submitted_at, 'order.submitted_at'),
    validateMoney(order.approved_total),
  ];
  for (const err of checks) if (err) return err;

  if (!Array.isArray(order.accepted_lines) || order.accepted_lines.length === 0) {
    return 'order.accepted_lines: must be a non-empty array';
  }
  if (order.accepted_lines.length > MAX_QUOTE_LINES) {
    return `order.accepted_lines: exceeds ${MAX_QUOTE_LINES} lines`;
  }
  const seen = new Set<string>();
  for (const line of order.accepted_lines) {
    if (!isRecord(line)) return 'order.accepted_lines[]: must be objects';
    const err =
      validateId(line.line_id, 'order.accepted_lines[].line_id') ??
      validateProductRef(line.product) ??
      validateQuantity(line.quantity, { require_positive: true });
    if (err) return err;
    if (seen.has(line.line_id as string)) {
      return `order.accepted_lines: duplicate line_id "${String(line.line_id)}"`;
    }
    seen.add(line.line_id as string);
  }

  if (order.buyer_reference !== undefined) {
    if (
      typeof order.buyer_reference !== 'string' ||
      order.buyer_reference.length === 0 ||
      order.buyer_reference.length > MAX_BUYER_REFERENCE_LENGTH
    ) {
      return `order.buyer_reference: must be a non-empty string of at most ${MAX_BUYER_REFERENCE_LENGTH} characters`;
    }
  }

  const projectionError = validateDeliveryProjection(order.delivery, sha256);
  if (projectionError) return `order.delivery: ${projectionError}`;

  return verifyCommerceRecordDigest('order', order, sha256);
}

/**
 * §9.9 quote binding — the checks both sides run against the exact
 * referenced quote (the buyer before approval, the supplier at
 * admission AFTER replay lookup):
 *
 * - identity, quote_id, and quote_digest bindings;
 * - all-or-none lines (full quoted line set, quoted quantities, the
 *   OFFERED products);
 * - approved_total equals the quote total; accepted_terms_digest equals
 *   the quote terms_digest;
 * - the order projection EXTENDS the priced projection.
 *
 * `priced_projection` is the retained quote-stage projection whose
 * digest the quote priced. Expiry is deliberately NOT here — it is an
 * admission-time check (`isQuoteExpiredAt`) so a decided replay never
 * re-runs it.
 */
export function verifyOrderAgainstQuote(
  order: PurchaseOrderProposal,
  quote: SignedQuote,
  priced_projection: Record<string, unknown>,
): string | null {
  if (order.quote_id !== quote.quote_id) return 'order: quote_id does not reference this quote';
  if (order.quote_digest !== quote.quote_digest) {
    return 'order: quote_digest does not reference this exact quote revision';
  }
  if (order.buyer_did !== quote.buyer_did || order.supplier_did !== quote.supplier_did) {
    return 'order: buyer/supplier identity does not match the quote';
  }

  // All-or-none (§9.9): exactly the quote's line set, quoted
  // quantities, offered products.
  if (order.accepted_lines.length !== quote.lines.length) {
    return 'order: all-or-none — accepted lines must equal the quote line set';
  }
  const byLineId = new Map(quote.lines.map((l) => [l.line_id, l]));
  for (const line of order.accepted_lines) {
    const quoted = byLineId.get(line.line_id);
    if (!quoted) return `order: line "${line.line_id}" is not a quote line (all-or-none)`;
    if (!productRefsEqual(line.product, quoted.offered_product)) {
      return `order: line "${line.line_id}" product does not match the offered product`;
    }
    if (
      line.quantity.value !== quoted.quantity.value ||
      line.quantity.unit_code !== quoted.quantity.unit_code
    ) {
      return `order: line "${line.line_id}" quantity differs from the quoted quantity (all-or-none)`;
    }
  }

  if (
    order.approved_total.currency !== quote.total.currency ||
    order.approved_total.minor_units !== quote.total.minor_units
  ) {
    return 'order: approved_total does not equal the quote total';
  }
  if (order.accepted_terms_digest !== quote.terms_digest) {
    return 'order: accepted_terms_digest does not equal the quote terms_digest';
  }

  const extendsError = projectionExtends(
    priced_projection,
    order.delivery as unknown as Record<string, unknown>,
  );
  if (extendsError) return `order: ${extendsError} (projection_mismatch)`;
  return null;
}

/** Admission-time expiry check (§9.8/§9.9): supplier clock vs valid_until. */
export function isQuoteExpiredAt(quote: Pick<SignedQuote, 'valid_until'>, at_iso: string): boolean {
  return isoUtcMillis(at_iso) > isoUtcMillis(quote.valid_until);
}
