/**
 * Test fixtures: fully valid, digest-correct commerce documents.
 * Overrides are applied BEFORE digest computation, so a test gets a
 * self-consistent document with its field changed; tamper AFTER the
 * builder returns to test digest verification.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import { computeLineSubtotal, computeTotal, type Charge } from '../../src/arithmetic';
import { commerceRecordDigest } from '../../src/digests';
import {
  termsDigestInput,
  type QuoteRequest,
  type SignedQuote,
  type SignedQuoteLine,
} from '../../src/quote';
import {
  computeProjectionDigest,
  type DeliveryProjection,
  DeliveryProjection as Projection,
} from '../../src/region';

export const hash = (data: Uint8Array): Uint8Array => sha256(data);

export const BUYER_DID = 'did:plc:buyer1234';
export const SUPPLIER_DID = 'did:plc:supplier5678';

export const inr = (minor_units: string): Money => ({ currency: 'INR', minor_units });

export const productRef = (value = '09506000134352'): ProductRef => ({ scheme: 'gtin', value });

export function makeProjection(
  fields: Partial<Omit<DeliveryProjection, 'projection_digest'>> = {},
): DeliveryProjection {
  const base: Omit<DeliveryProjection, 'projection_digest'> = {
    region: { scheme: 'postal_area', value: '682001' },
    ...fields,
  };
  return { ...base, projection_digest: computeProjectionDigest(base, hash) };
}

export function makeQuoteRequest(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  const base: Omit<QuoteRequest, 'request_digest'> = {
    protocol_version: '1.0',
    request_id: 'req-1',
    buyer_did: BUYER_DID,
    supplier_did: SUPPLIER_DID,
    lines: [
      {
        line_id: 'l1',
        product: productRef(),
        requested_quantity: { value: '100', unit_code: 'each' },
      },
    ],
    delivery: { projection: makeProjection() },
    issued_at: '2026-08-07T10:00:00Z',
    expires_at: '2026-08-08T10:00:00Z',
    idempotency_key: 'idem-req-1',
    ...overrides,
  };
  const { request_digest: _drop, ...withoutDigest } = { ...base, request_digest: '' };
  return {
    ...withoutDigest,
    request_digest: commerceRecordDigest('request', withoutDigest as Record<string, unknown>, hash),
  } as QuoteRequest;
}

export interface QuoteFixtureOptions {
  overrides?: Partial<SignedQuote>;
  charges?: Charge[];
  request?: QuoteRequest;
}

/** Build a valid SignedQuote: subtotals/total recomputed under §9.1,
 *  terms_digest and quote_digest computed last. */
export function makeSignedQuote(options: QuoteFixtureOptions = {}): SignedQuote {
  const request = options.request ?? makeQuoteRequest();
  const charges = options.charges ?? [];

  const lineBase: Omit<SignedQuoteLine, 'line_subtotal'> = {
    line_id: 'l1',
    requested_product: productRef(),
    offered_product: productRef(),
    quantity: { value: '100', unit_code: 'each' },
    price_basis: { value: '1', unit_code: 'each' },
    unit_price: inr('500'),
    stock_status: 'available',
  };
  const subtotal = computeLineSubtotal(lineBase.unit_price, lineBase.quantity, lineBase.price_basis);
  if (subtotal.error || !subtotal.value) throw new Error(`fixture: ${String(subtotal.error)}`);
  const line: SignedQuoteLine = { ...lineBase, line_subtotal: subtotal.value };

  const draft: Omit<SignedQuote, 'terms_digest' | 'quote_digest'> = {
    protocol_version: '1.0',
    quote_id: 'q-1',
    request_id: request.request_id,
    request_digest: request.request_digest,
    buyer_did: request.buyer_did,
    supplier_did: request.supplier_did,
    quote_revision: '1',
    priced_delivery_projection_digest: request.delivery.projection.projection_digest,
    lines: [line],
    charges,
    total: subtotal.value,
    issued_at: '2026-08-07T11:00:00Z',
    valid_until: '2026-08-08T09:00:00Z',
    supplier_epoch: '1',
    ...options.overrides,
  };

  // Recompute the total for the (possibly overridden) lines/charges so
  // overridden fixtures stay §9.1-consistent unless a test tampers after.
  const currency = draft.total.currency;
  const total = computeTotal(
    currency,
    draft.lines.map((l) => l.line_subtotal),
    draft.charges,
  );
  if (total.error || !total.value) throw new Error(`fixture: ${String(total.error)}`);
  const withTotal = { ...draft, total: options.overrides?.total ?? total.value };

  const terms_digest = commerceRecordDigest('terms', termsDigestInput(withTotal), hash);
  const withTerms = { ...withTotal, terms_digest };
  return {
    ...withTerms,
    quote_digest: commerceRecordDigest('quote', withTerms as Record<string, unknown>, hash),
  } as SignedQuote;
}

// ---------------------------------------------------------------------------
// Order lifecycle fixtures (CMP-5)
// ---------------------------------------------------------------------------

import type { OrderAcknowledgement } from '../../src/acknowledgement';
import type { CancellationRequest, CancellationResult } from '../../src/cancellation';
import type { CommerceEpochRecord } from '../../src/epoch';
import type { Money } from '../../src/money';
import type { PurchaseOrderProposal } from '../../src/order';
import type { ProductRef } from '../../src/product';
import type { CommerceOrderStatus } from '../../src/status';

/** Order-stage projection extending the quote-stage one. */
export function makeOrderProjection(priced: Projection): Projection {
  const { projection_digest: _d, ...pricedFields } = priced;
  const base = { ...pricedFields, recipient_name: 'Stores Desk' };
  return { ...base, projection_digest: computeProjectionDigest(base, hash) } as Projection;
}

export function makeOrder(
  quote: SignedQuote,
  priced_projection: Projection,
  overrides: Partial<PurchaseOrderProposal> = {},
): PurchaseOrderProposal {
  const draft: Omit<PurchaseOrderProposal, 'order_digest'> = {
    protocol_version: '1.0',
    purchase_order_id: 'po-1',
    buyer_did: quote.buyer_did,
    supplier_did: quote.supplier_did,
    quote_id: quote.quote_id,
    quote_digest: quote.quote_digest,
    accepted_lines: quote.lines.map((l) => ({
      line_id: l.line_id,
      product: l.offered_product,
      quantity: l.quantity,
    })),
    delivery: makeOrderProjection(priced_projection),
    approved_total: quote.total,
    accepted_terms_digest: quote.terms_digest,
    idempotency_key: 'idem-po-1',
    submitted_at: '2026-08-07T12:00:00Z',
    ...overrides,
  };
  return {
    ...draft,
    order_digest: commerceRecordDigest('order', draft as Record<string, unknown>, hash),
  } as PurchaseOrderProposal;
}

export function makeAcceptedAck(
  order: PurchaseOrderProposal,
  overrides: Partial<OrderAcknowledgement> = {},
): OrderAcknowledgement {
  const draft = {
    protocol_version: '1.0',
    acknowledgement_id: 'ack-1',
    purchase_order_id: order.purchase_order_id,
    order_digest: order.order_digest,
    buyer_did: order.buyer_did,
    supplier_did: order.supplier_did,
    issued_at: '2026-08-07T12:05:00Z',
    kind: 'accepted' as const,
    supplier_order_id: 'so-77',
    accepted_quote_digest: order.quote_digest,
    accepted_at: '2026-08-07T12:05:00Z',
    ...overrides,
  };
  return {
    ...draft,
    acknowledgement_digest: commerceRecordDigest(
      'acknowledgement',
      draft as Record<string, unknown>,
      hash,
    ),
  } as OrderAcknowledgement;
}

export function makeRejectedAck(
  order: PurchaseOrderProposal,
  overrides: Record<string, unknown> = {},
): OrderAcknowledgement {
  const draft = {
    protocol_version: '1.0',
    acknowledgement_id: 'ack-2',
    purchase_order_id: order.purchase_order_id,
    order_digest: order.order_digest,
    buyer_did: order.buyer_did,
    supplier_did: order.supplier_did,
    issued_at: '2026-08-07T12:05:00Z',
    kind: 'rejected' as const,
    ...overrides,
  };
  return {
    ...draft,
    acknowledgement_digest: commerceRecordDigest(
      'acknowledgement',
      draft as Record<string, unknown>,
      hash,
    ),
  } as OrderAcknowledgement;
}

export function makeStatus(
  order: PurchaseOrderProposal,
  fields: Partial<CommerceOrderStatus>,
): CommerceOrderStatus {
  const draft = {
    protocol_version: '1.0',
    purchase_order_id: order.purchase_order_id,
    buyer_did: order.buyer_did,
    supplier_did: order.supplier_did,
    sequence: '0',
    state: 'accepted' as const,
    supplier_epoch: '1',
    updated_at: '2026-08-07T12:06:00Z',
    ...fields,
  };
  return {
    ...draft,
    status_digest: commerceRecordDigest('status', draft as Record<string, unknown>, hash),
  } as CommerceOrderStatus;
}

export function makeSuccessor(
  order: PurchaseOrderProposal,
  held: CommerceOrderStatus,
  fields: Partial<CommerceOrderStatus>,
): CommerceOrderStatus {
  return makeStatus(order, {
    sequence: (BigInt(held.sequence) + 1n).toString(10),
    previous_status_digest: held.status_digest,
    supplier_epoch: held.supplier_epoch,
    ...fields,
  });
}

export function makeCancellationRequest(
  order: PurchaseOrderProposal,
  overrides: Partial<CancellationRequest> = {},
): CancellationRequest {
  const draft = {
    protocol_version: '1.0',
    cancellation_id: 'cx-1',
    purchase_order_id: order.purchase_order_id,
    order_digest: order.order_digest,
    idempotency_key: 'idem-cx-1',
    issued_at: '2026-08-07T12:10:00Z',
    ...overrides,
  };
  return {
    ...draft,
    cancellation_digest: commerceRecordDigest(
      'cancellation',
      draft as Record<string, unknown>,
      hash,
    ),
  } as CancellationRequest;
}

export function makeCancellationResult(
  order: PurchaseOrderProposal,
  overrides: Partial<CancellationResult> = {},
): CancellationResult {
  const draft = {
    protocol_version: '1.0',
    cancellation_id: 'cx-1',
    purchase_order_id: order.purchase_order_id,
    result: 'pending_review' as const,
    resolved_at: '2026-08-07T12:15:00Z',
    ...overrides,
  };
  return {
    ...draft,
    result_digest: commerceRecordDigest('result', draft as Record<string, unknown>, hash),
  } as CancellationResult;
}

export function makeEpochRecord(
  epoch: string,
  previous?: CommerceEpochRecord,
  overrides: Partial<CommerceEpochRecord> = {},
): CommerceEpochRecord {
  const draft = {
    protocol_version: '1.0',
    business_did: SUPPLIER_DID,
    epoch,
    reason: (epoch === '1' ? 'initial' : 'restore') as 'initial' | 'restore',
    activated_at: '2026-08-07T00:00:00Z',
    ...(previous ? { previous_epoch_digest: previous.epoch_digest } : {}),
    ...overrides,
  };
  return {
    ...draft,
    epoch_digest: commerceRecordDigest('epoch', draft as Record<string, unknown>, hash),
  } as CommerceEpochRecord;
}

/** A valid revision N+1 extending `held` (same family, new digest). */
export function makeRevision(held: SignedQuote, overrides: Partial<SignedQuote> = {}): SignedQuote {
  const { quote_digest: _q, terms_digest: _t, ...rest } = held;
  const draft = {
    ...rest,
    quote_revision: (BigInt(held.quote_revision) + 1n).toString(10),
    previous_quote_digest: held.quote_digest,
    ...overrides,
  };
  const terms_digest = commerceRecordDigest('terms', termsDigestInput(draft), hash);
  const withTerms = { ...draft, terms_digest };
  return {
    ...withTerms,
    quote_digest: commerceRecordDigest('quote', withTerms as Record<string, unknown>, hash),
  } as SignedQuote;
}
