/**
 * NEGOTIATION_PLAN §4.2, §4.5, §4.6 — the counter-offer document and its
 * frozen digest, the not-awarded notice, and requirement lines.
 */

import { commerceRecordDigest } from '../src/digests';
import {
  readCounterOffer,
  validateCounterOffer,
  validateQuoteOutcomeNotice,
  type CounterOffer,
} from '../src/negotiation';
import { validateQuoteRequest, type QuoteRequestLine } from '../src/quote';

import { BUYER_DID, SUPPLIER_DID, hash, makeQuoteRequest } from './helpers/fixtures';

function counter(overrides: Record<string, unknown> = {}): CounterOffer {
  const record = {
    protocol_version: '1.1',
    counter_id: 'ctr-1',
    quote_id: 'q-1',
    quote_digest: 'a'.repeat(64),
    buyer_did: BUYER_DID,
    supplier_did: SUPPLIER_DID,
    round: '1',
    target_total: { currency: 'INR', minor_units: '20000' },
    issued_at: '2026-09-25T10:00:00.000Z',
    respond_by: '2026-09-25T10:01:30.000Z',
    ...overrides,
  };
  return {
    ...record,
    counter_digest: commerceRecordDigest('counter', record, hash),
  } as unknown as CounterOffer;
}

describe('CounterOffer', () => {
  it('a sealed counter validates, and its digest is frozen (conformance vector)', () => {
    const doc = counter();
    expect(validateCounterOffer(doc, hash)).toBeNull();
    expect(readCounterOffer(doc, hash)).toEqual({ ok: true, counter: doc });
    // The preimage is "dina:commerce:v1:counter\n" + canonicalJson(record
    // minus counter_digest). A second implementation must reproduce this.
    // Cross-checked against an independent Python recomputation.
    expect(doc.counter_digest).toBe(
      'b867a4a57962104ae1d4a1965c34b164f44b77e0e112578d4f4fe4a88d83342d',
    );
  });

  it('refuses a tampered record, a zero target, a bad round, the same party twice and a respond_by in the past', () => {
    expect(validateCounterOffer({ ...counter(), round: '2' }, hash)).toMatch(/counter_digest/);
    expect(
      validateCounterOffer(counter({ target_total: { currency: 'INR', minor_units: '0' } }), hash),
    ).toMatch(/above zero/);
    for (const round of ['0', '01', '-1', '1.5', '']) {
      expect(validateCounterOffer(counter({ round }), hash)).toMatch(/counter\.round/);
    }
    expect(validateCounterOffer(counter({ supplier_did: BUYER_DID }), hash)).toMatch(/must differ/);
    expect(validateCounterOffer(counter({ respond_by: '2026-09-25T09:00:00.000Z' }), hash)).toMatch(
      /respond_by/,
    );
    expect(validateCounterOffer(counter({ quote_digest: 'short' }), hash)).toMatch(/quote_digest/);
    expect(validateCounterOffer('nope', hash)).toMatch(/object/);
  });

  it('a counter digest never equals a quote-domain digest of the same bytes', () => {
    const doc = counter();
    const { counter_digest: _d, ...rest } = doc;
    expect(commerceRecordDigest('quote', rest as Record<string, unknown>, hash)).not.toBe(
      doc.counter_digest,
    );
  });
});

describe('QuoteOutcomeNotice', () => {
  it('says not_awarded and nothing else — no price, no winner', () => {
    expect(
      validateQuoteOutcomeNotice({ request_id: 'r-1', quote_id: 'q-1', outcome: 'not_awarded' }),
    ).toBeNull();
    expect(
      validateQuoteOutcomeNotice({ request_id: 'r-1', quote_id: 'q-1', outcome: 'awarded' }),
    ).toMatch(/outcome/);
    expect(
      validateQuoteOutcomeNotice({
        request_id: 'r-1',
        quote_id: 'q-1',
        outcome: 'not_awarded',
        winning_total: '1',
      }),
    ).toMatch(/carries no terms/);
    expect(validateQuoteOutcomeNotice({ quote_id: 'q-1', outcome: 'not_awarded' })).toMatch(
      /request_id/,
    );
  });
});

describe('requirement lines (minor 1.2)', () => {
  const placeholder = { scheme: 'custom' as const, value: 'req:l1', issuer_did: BUYER_DID };
  const needLine = (over: Partial<QuoteRequestLine> = {}): QuoteRequestLine => ({
    line_id: 'l1',
    product: placeholder,
    requested_quantity: { value: '1', unit_code: 'each' },
    acceptable_substitutions: 'supplier_may_propose',
    requirement: { text: 'Floral celebration cake, 20 servings', category_id: 'food.bakery' },
    ...over,
  });

  it('a 1.2 request with a buyer-issued placeholder and substitution authority validates', () => {
    expect(
      validateQuoteRequest(
        makeQuoteRequest({ protocol_version: '1.2', lines: [needLine()] }),
        hash,
      ),
    ).toBeNull();
  });

  it('is refused below 1.2, without supplier_may_propose, on a real product, or with bad text', () => {
    expect(
      validateQuoteRequest(
        makeQuoteRequest({ protocol_version: '1.1', lines: [needLine()] }),
        hash,
      ),
    ).toMatch(/minor >= 1.2/);
    expect(
      validateQuoteRequest(
        makeQuoteRequest({
          protocol_version: '1.2',
          lines: [needLine({ acceptable_substitutions: 'equivalent' })],
        }),
        hash,
      ),
    ).toMatch(/supplier_may_propose/);
    expect(
      validateQuoteRequest(
        makeQuoteRequest({
          protocol_version: '1.2',
          lines: [needLine({ product: { scheme: 'gtin', value: '09506000134352' } })],
        }),
        hash,
      ),
    ).toMatch(/placeholder issued by the buyer/);
    expect(
      validateQuoteRequest(
        makeQuoteRequest({
          protocol_version: '1.2',
          lines: [needLine({ product: { ...placeholder, issuer_did: SUPPLIER_DID } })],
        }),
        hash,
      ),
    ).toMatch(/placeholder issued by the buyer/);
    for (const text of ['', '   ', 'x'.repeat(201), 'cake‮reversed', 'line\nbreak']) {
      expect(
        validateQuoteRequest(
          makeQuoteRequest({
            protocol_version: '1.2',
            lines: [needLine({ requirement: { text } })],
          }),
          hash,
        ),
      ).toMatch(/requirement\.text/);
    }
    expect(
      validateQuoteRequest(
        makeQuoteRequest({
          protocol_version: '1.2',
          lines: [needLine({ requirement: { text: 'cake', price: '1' } as never })],
        }),
        hash,
      ),
    ).toMatch(/unexpected field/);
  });
});

describe('a requirement line answered with its own placeholder', () => {
  it('is refused by the buyer-side line check (the placeholder is not goods)', () => {
    const { verifyQuoteLinesAnswerRequest } = jest.requireActual(
      '../src/quote',
    ) as typeof import('../src/quote');
    const placeholder = { scheme: 'custom' as const, value: 'req:l1', issuer_did: BUYER_DID };
    const request = makeQuoteRequest({
      protocol_version: '1.2',
      lines: [
        {
          line_id: 'l1',
          product: placeholder,
          requested_quantity: { value: '1', unit_code: 'each' },
          acceptable_substitutions: 'supplier_may_propose',
          requirement: { text: 'Floral cake' },
        },
      ],
    });
    const line = {
      line_id: 'l1',
      requested_product: placeholder,
      offered_product: placeholder,
      quantity: { value: '1', unit_code: 'each' },
      price_basis: { value: '1', unit_code: 'each' },
      unit_price: { currency: 'INR', minor_units: '100' },
      line_subtotal: { currency: 'INR', minor_units: '100' },
      stock_status: 'available' as const,
    };
    expect(verifyQuoteLinesAnswerRequest({ lines: [line] } as never, request)).toMatch(
      /placeholder, not a product/,
    );
    const real = {
      ...line,
      offered_product: { scheme: 'gtin' as const, value: '09506000134352' },
      substitution_evidence: ['matched'],
    };
    expect(verifyQuoteLinesAnswerRequest({ lines: [real] } as never, request)).toBeNull();
  });
});
