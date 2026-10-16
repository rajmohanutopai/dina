/**
 * COMMITMENT_KERNEL §6, §15 step 6 — alternatives on goods quotes.
 *
 *   Q-40  a quote may carry alternatives: the same lines and prices, another
 *         delivery date for other charges ("₹40 less if delivery is on day Z"),
 *         each with its own total and terms digest; from minor 1.3 only;
 *   Q-41  each alternative's total and terms are recomputed, never trusted;
 *   Q-42  an order takes one version: the quote's own terms, or the
 *         alternative it names — exactly its total and terms digest.
 */

import {
  commerceRecordDigest,
  quoteVersion,
  termsDigestInput,
  validatePurchaseOrderProposal,
  validateSignedQuote,
  verifyOrderAgainstQuote,
  type Charge,
  type QuoteAlternative,
  type SignedQuote,
} from '../src/index';

import { hash, inr, makeOrder, makeQuoteRequest, makeSignedQuote } from './helpers/fixtures';

const delivery = (minor: string): Charge => ({
  kind: 'delivery',
  label: 'Delivery',
  amount: inr(minor),
  operation: 'add',
});

/** A 1.3 quote: ₹100 delivery any day, or ₹60 if it comes on the Tuesday. */
function quoteWithTuesday(tamper?: (alt: QuoteAlternative) => QuoteAlternative): SignedQuote {
  const base = makeSignedQuote({
    charges: [delivery('10000')],
    overrides: { protocol_version: '1.3', estimated_delivery_at: '2026-08-12T10:00:00Z' },
  });
  const charges = [delivery('6000')];
  const tuesday = '2026-08-11T10:00:00Z';
  const alt: QuoteAlternative = {
    alternative_id: 'tue',
    charges,
    estimated_delivery_at: tuesday,
    total: inr(String(50_000 + 6_000)),
    terms_digest: commerceRecordDigest(
      'terms',
      termsDigestInput({ ...base, charges, estimated_delivery_at: tuesday }),
      hash,
    ),
  };
  return makeSignedQuote({
    charges: [delivery('10000')],
    overrides: {
      protocol_version: '1.3',
      estimated_delivery_at: '2026-08-12T10:00:00Z',
      alternatives: [tamper === undefined ? alt : tamper(alt)],
    },
  });
}

describe('alternatives on goods quotes', () => {
  it('Q-40: a well-formed alternative at 1.3; none before 1.3', () => {
    const quote = quoteWithTuesday();
    expect(validateSignedQuote(quote, hash)).toBeNull();
    expect(quoteVersion(quote, 'tue')?.total).toEqual(inr('56000'));
    expect(quoteVersion(quote)?.total).toEqual(inr('60000'));
    const old = makeSignedQuote({
      charges: [delivery('10000')],
      overrides: { alternatives: quote.alternatives ?? [] },
    });
    expect(validateSignedQuote(old, hash)).toMatch(/minor >= 1.3/);
  });

  it('Q-41: totals and terms are recomputed', () => {
    expect(
      validateSignedQuote(
        quoteWithTuesday((a) => ({ ...a, total: inr('40000') })),
        hash,
      ),
    ).toMatch(/recomputation/);
    expect(
      validateSignedQuote(
        quoteWithTuesday((a) => ({ ...a, terms_digest: 'f'.repeat(64) })),
        hash,
      ),
    ).toMatch(/does not match its terms/);
    expect(
      validateSignedQuote(
        quoteWithTuesday((a) => ({ ...a, note: 'x' }) as QuoteAlternative),
        hash,
      ),
    ).toMatch(/exactly alternative_id/);
  });

  it('Q-42: an order takes exactly the version it names', () => {
    const quote = quoteWithTuesday();
    const request = makeQuoteRequest();
    const projection = request.delivery.projection as unknown as Record<string, unknown>;
    const tuesday = makeOrder(quote, request.delivery.projection, {
      protocol_version: '1.3',
      alternative_id: 'tue',
      approved_total: inr('56000'),
      accepted_terms_digest: quoteVersion(quote, 'tue')?.terms_digest ?? '',
    });
    expect(validatePurchaseOrderProposal(tuesday, hash)).toBeNull();
    expect(verifyOrderAgainstQuote(tuesday, quote, projection)).toBeNull();
    // The Tuesday price without naming Tuesday binds nothing.
    const unnamed = makeOrder(quote, request.delivery.projection, {
      protocol_version: '1.3',
      approved_total: inr('56000'),
      accepted_terms_digest: quoteVersion(quote, 'tue')?.terms_digest ?? '',
    });
    expect(verifyOrderAgainstQuote(unnamed, quote, projection)).toMatch(/version taken/);
    const nothing = makeOrder(quote, request.delivery.projection, {
      protocol_version: '1.3',
      alternative_id: 'wed',
    });
    expect(verifyOrderAgainstQuote(nothing, quote, projection)).toMatch(/names no alternative/);
    // The quote's own terms still bind as before.
    const own = makeOrder(quote, request.delivery.projection, { protocol_version: '1.3' });
    expect(verifyOrderAgainstQuote(own, quote, projection)).toBeNull();
  });
});
