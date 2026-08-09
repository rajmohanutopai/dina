/**
 * Rehydration through the ingress validator (WS-0.7 / ARCH-3).
 *
 * Before this, a record read back from the receipt store was
 * `JSON.parse(…) as PurchaseOrderProposal` — a promise to the compiler and a
 * check of nothing. These tests are about the difference: a corrupt receipt
 * must be REFUSED at the point of reading rather than flowing into decision
 * logic that assumes ingress already vetted it.
 */

import { rehydratePurchaseOrder, rehydrateSignedQuote } from '../../src/commerce/rehydrate';

import { hash, makeOrder, makeQuoteRequest, makeSignedQuote } from './helpers';

const request = makeQuoteRequest();
const quote = makeSignedQuote(request, { quote_id: 'q-rehydrate' });
const order = makeOrder(quote, request.delivery.projection);

describe('purchase order rehydration', () => {
  it('accepts a receipt this engine wrote', () => {
    const result = rehydratePurchaseOrder(JSON.stringify(order), hash);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.purchase_order_id).toBe(order.purchase_order_id);
  });

  it('refuses a receipt that is not JSON', () => {
    const result = rehydratePurchaseOrder('{ truncated', hash);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('not JSON');
  });

  it('refuses a structurally broken record', () => {
    const { accepted_lines: _dropped, ...missingLines } = order as unknown as Record<
      string,
      unknown
    >;
    const result = rehydratePurchaseOrder(JSON.stringify(missingLines), hash);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('failed validation');
  });

  it('refuses a record whose CONTENT was edited after it was written', () => {
    // The corruption a shape check alone would miss: every field is present
    // and well-typed, but the stored digest no longer describes the content.
    // `validatePurchaseOrderProposal` re-derives it, so this is caught.
    const tampered = { ...order, purchase_order_id: 'po-someone-elses' };
    const result = rehydratePurchaseOrder(JSON.stringify(tampered), hash);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('failed validation');
  });

  it('refuses a JSON value that is not an object at all', () => {
    for (const junk of ['null', '42', '"an order"', '[]']) {
      expect(rehydratePurchaseOrder(junk, hash).ok).toBe(false);
    }
  });
});

describe('signed quote rehydration', () => {
  it('accepts a quote this engine retained', () => {
    const result = rehydrateSignedQuote(JSON.stringify(quote), hash);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.quote_id).toBe('q-rehydrate');
  });

  it('refuses a quote edited after retention', () => {
    const tampered = { ...quote, quote_id: 'q-substituted' };
    expect(rehydrateSignedQuote(JSON.stringify(tampered), hash).ok).toBe(false);
  });

  it('refuses unreadable JSON', () => {
    expect(rehydrateSignedQuote('not json', hash).ok).toBe(false);
  });
});

describe('the digest re-derivation is what makes this more than a shape check', () => {
  it('would accept the tampered order if only its shape were checked', () => {
    // Stated as a test so the value of the extra work is explicit: the
    // tampered record IS structurally a purchase order. Only recomputing the
    // digest distinguishes it from the real one.
    const tampered = { ...order, purchase_order_id: 'po-someone-elses' };
    expect(typeof tampered.purchase_order_id).toBe('string');
    expect(Array.isArray(tampered.accepted_lines)).toBe(true);
    expect(tampered.order_digest).toBe(order.order_digest);
    // Same digest field, different content — refused.
    expect(rehydratePurchaseOrder(JSON.stringify(tampered), hash).ok).toBe(false);
  });
});
