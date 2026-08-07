/**
 * Commerce document fixtures for Core engine tests — built through
 * the @dina/commerce-protocol PUBLIC API (digest-correct by
 * construction, §9.1-consistent arithmetic).
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  commerceRecordDigest,
  computeLineSubtotal,
  computeProjectionDigest,
  termsDigestInput,
  type DeliveryProjection,
  type PurchaseOrderProposal,
  type QuoteRequest,
  type Sha256Fn,
  type SignedQuote,
  type SignedQuoteLine,
} from '@dina/commerce-protocol';

import { QuoteFamilyStore, type CommerceQuoteLedgerRepository } from '../../src/commerce';

export const hash: Sha256Fn = (data) => sha256(data);

/**
 * Quote state as the production code sees it: an aggregate store, never
 * the raw ledger. Tests that reach past this are testing a surface the
 * engines no longer have.
 */
export function makeFamilies(
  ledger: CommerceQuoteLedgerRepository,
  clock: { now: number },
  currentEpoch: () => string = () => '1',
  supplierDid: string = SUPPLIER_DID,
): QuoteFamilyStore {
  return new QuoteFamilyStore({ ledger, currentEpoch, supplierDid, now: () => clock.now });
}

export const BUYER_DID = 'did:plc:buyer1234';
export const SUPPLIER_DID = 'did:plc:supplier5678';

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
  const draft = {
    protocol_version: '1.0',
    request_id: 'req-1',
    buyer_did: BUYER_DID,
    supplier_did: SUPPLIER_DID,
    lines: [
      {
        line_id: 'l1',
        product: { scheme: 'gtin' as const, value: '09506000134352' },
        requested_quantity: { value: '100', unit_code: 'each' },
      },
    ],
    delivery: { projection: makeProjection() },
    issued_at: '2026-08-07T10:00:00.000Z',
    expires_at: '2026-08-08T10:00:00.000Z',
    idempotency_key: 'idem-req-1',
    ...overrides,
  };
  return {
    ...draft,
    request_digest: commerceRecordDigest('request', draft as Record<string, unknown>, hash),
  } as QuoteRequest;
}

export function makeSignedQuote(
  request: QuoteRequest,
  overrides: Partial<SignedQuote> = {},
): SignedQuote {
  const lineBase = {
    line_id: 'l1',
    requested_product: { scheme: 'gtin' as const, value: '09506000134352' },
    offered_product: { scheme: 'gtin' as const, value: '09506000134352' },
    quantity: { value: '100', unit_code: 'each' },
    price_basis: { value: '1', unit_code: 'each' },
    unit_price: { currency: 'INR', minor_units: '500' },
    stock_status: 'available' as const,
  };
  const subtotal = computeLineSubtotal(lineBase.unit_price, lineBase.quantity, lineBase.price_basis);
  if (subtotal.error || !subtotal.value) throw new Error(String(subtotal.error));
  const line: SignedQuoteLine = { ...lineBase, line_subtotal: subtotal.value };
  const draft = {
    protocol_version: '1.0',
    quote_id: 'q-1',
    request_id: request.request_id,
    request_digest: request.request_digest,
    buyer_did: request.buyer_did,
    supplier_did: request.supplier_did,
    quote_revision: '1',
    priced_delivery_projection_digest: request.delivery.projection.projection_digest,
    lines: [line],
    charges: [],
    total: subtotal.value,
    issued_at: '2026-08-07T11:00:00.000Z',
    valid_until: '2026-08-08T09:00:00.000Z',
    supplier_epoch: '1',
    ...overrides,
  };
  const terms_digest = commerceRecordDigest('terms', termsDigestInput(draft as never), hash);
  const withTerms = { ...draft, terms_digest };
  return {
    ...withTerms,
    quote_digest: commerceRecordDigest('quote', withTerms as Record<string, unknown>, hash),
  } as SignedQuote;
}

/** Revision N+1 extending `held` (same family). */
export function makeRevision(held: SignedQuote, overrides: Partial<SignedQuote> = {}): SignedQuote {
  const { quote_digest: _q, terms_digest: _t, ...rest } = held;
  const draft = {
    ...rest,
    quote_revision: (BigInt(held.quote_revision) + 1n).toString(10),
    previous_quote_digest: held.quote_digest,
    ...overrides,
  };
  const terms_digest = commerceRecordDigest('terms', termsDigestInput(draft as never), hash);
  const withTerms = { ...draft, terms_digest };
  return {
    ...withTerms,
    quote_digest: commerceRecordDigest('quote', withTerms as Record<string, unknown>, hash),
  } as SignedQuote;
}

export function makeOrder(
  quote: SignedQuote,
  priced_projection: DeliveryProjection,
  overrides: Partial<PurchaseOrderProposal> = {},
): PurchaseOrderProposal {
  const { projection_digest: _d, ...pricedFields } = priced_projection;
  const deliveryBase = { ...pricedFields, recipient_name: 'Stores Desk' };
  const draft = {
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
    delivery: { ...deliveryBase, projection_digest: computeProjectionDigest(deliveryBase, hash) },
    approved_total: quote.total,
    accepted_terms_digest: quote.terms_digest,
    idempotency_key: 'idem-po-1',
    submitted_at: '2026-08-07T12:00:00.000Z',
    ...overrides,
  };
  return {
    ...draft,
    order_digest: commerceRecordDigest('order', draft as Record<string, unknown>, hash),
  } as PurchaseOrderProposal;
}
