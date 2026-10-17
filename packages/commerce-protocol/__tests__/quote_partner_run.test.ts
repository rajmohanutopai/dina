/**
 * COMMITMENT_KERNEL §6, §11, §15 step 7 — minor 1.4: the buyer's
 * onward-sharing grant, and versions resting on a shipper's firm option.
 *
 *   Q-50  a request may carry the grant from 1.4: the pincode, to shippers,
 *         and nothing else, only with a projection that carries a pincode;
 *   Q-51  a version may rest on a firm option from 1.4: `partner_run` with
 *         `offer_ends_at`, both or neither, the end after issue and no later
 *         than the quote's validity;
 *   Q-52  `option_lapsed` is a known rejection reason.
 *
 * COMMITMENT_KERNEL §15 step 12 — minor 1.5: the exit right.
 *   Q-53  a request may ask for it from 1.5, only with the grant;
 *   Q-54  a partner-run version may carry it from 1.5, only with partner_run;
 *         it is part of the version's terms digest, so dropping it from a
 *         signed version breaks the digest; a digest made without it is
 *         unchanged.
 */

import {
  commerceRecordDigest,
  KNOWN_REJECTION_REASONS,
  termsDigestInput,
  validateQuoteRequest,
  validateSignedQuote,
  type Charge,
  type QuoteAlternative,
  type SignedQuote,
} from '../src/index';

import { hash, inr, makeProjection, makeQuoteRequest, makeSignedQuote } from './helpers/fixtures';

const grant = { fields: ['postal_code'] as ['postal_code'], recipient_role: 'shipper' as const };

const discount = (minor: string): Charge => ({
  kind: 'discount',
  label: 'Delivery by a partner run',
  amount: inr(minor),
  operation: 'subtract',
});

function quoteWithPartnerRun(
  version: string,
  extra: Partial<QuoteAlternative> | ((alt: QuoteAlternative) => Record<string, unknown>),
): SignedQuote {
  const base = makeSignedQuote({ overrides: { protocol_version: version } });
  const charges = [discount('3500')];
  const at = '2026-08-18T09:00:00Z';
  const alt: QuoteAlternative = {
    alternative_id: 'partner_0a1b2c3d',
    charges,
    estimated_delivery_at: at,
    total: inr(String(50_000 - 3_500)),
    terms_digest: commerceRecordDigest(
      'terms',
      termsDigestInput({ ...base, charges, estimated_delivery_at: at }),
      hash,
    ),
  };
  const shaped = typeof extra === 'function' ? extra(alt) : { ...alt, ...extra };
  return makeSignedQuote({
    overrides: { protocol_version: version, alternatives: [shaped as unknown as QuoteAlternative] },
  });
}

describe('minor 1.4: onward sharing and partner runs', () => {
  it('Q-50: the grant', () => {
    expect(
      validateQuoteRequest(
        makeQuoteRequest({ protocol_version: '1.4', onward_sharing: grant }),
        hash,
      ),
    ).toBeNull();
    expect(
      validateQuoteRequest(
        makeQuoteRequest({ protocol_version: '1.3', onward_sharing: grant }),
        hash,
      ),
    ).toMatch(/minor >= 1.4/);
    expect(
      validateQuoteRequest(
        makeQuoteRequest({
          protocol_version: '1.4',
          onward_sharing: { ...grant, fields: ['locality'] } as never,
        }),
        hash,
      ),
    ).toMatch(/fields/);
    expect(
      validateQuoteRequest(
        makeQuoteRequest({
          protocol_version: '1.4',
          onward_sharing: { ...grant, recipient_role: 'anyone' } as never,
        }),
        hash,
      ),
    ).toMatch(/recipient_role/);
    // A country-wide projection carries no pincode to grant.
    const countryWide = makeProjection({ region: { scheme: 'country', value: 'IN' } });
    expect(
      validateQuoteRequest(
        makeQuoteRequest({
          protocol_version: '1.4',
          onward_sharing: grant,
          delivery: { projection: countryWide },
        }),
        hash,
      ),
    ).toMatch(/does not carry/);
  });

  it('Q-51: a version resting on a firm option', () => {
    const ends = { partner_run: true as const, offer_ends_at: '2026-08-08T09:00:00Z' };
    expect(validateSignedQuote(quoteWithPartnerRun('1.4', ends), hash)).toBeNull();
    expect(validateSignedQuote(quoteWithPartnerRun('1.3', ends), hash)).toMatch(/minor >= 1.4/);
    expect(validateSignedQuote(quoteWithPartnerRun('1.4', { partner_run: true }), hash)).toMatch(
      /exactly/,
    );
    expect(
      validateSignedQuote(quoteWithPartnerRun('1.4', { offer_ends_at: ends.offer_ends_at }), hash),
    ).toMatch(/exactly/);
    expect(
      validateSignedQuote(
        quoteWithPartnerRun('1.4', { ...ends, offer_ends_at: '2026-08-08T09:00:01Z' }),
        hash,
      ),
    ).toMatch(/no later than valid_until/);
    expect(
      validateSignedQuote(
        quoteWithPartnerRun('1.4', { ...ends, offer_ends_at: '2026-08-07T11:00:00Z' }),
        hash,
      ),
    ).toMatch(/after the quote is issued/);
    expect(
      validateSignedQuote(
        quoteWithPartnerRun('1.4', (alt) => ({ ...alt, ...ends, partner_run: 'yes' })),
        hash,
      ),
    ).toMatch(/partner_run: true/);
  });

  it('Q-52: option_lapsed is known', () => {
    expect(KNOWN_REJECTION_REASONS).toContain('option_lapsed');
  });
});

describe('minor 1.5: the exit right', () => {
  it('Q-53: the request asks for it only with the grant, from 1.5', () => {
    expect(
      validateQuoteRequest(
        makeQuoteRequest({ protocol_version: '1.5', onward_sharing: grant, exit_if_run_fails: true }),
        hash,
      ),
    ).toBeNull();
    expect(
      validateQuoteRequest(
        makeQuoteRequest({ protocol_version: '1.4', onward_sharing: grant, exit_if_run_fails: true }),
        hash,
      ),
    ).toMatch(/minor >= 1.5/);
    expect(
      validateQuoteRequest(makeQuoteRequest({ protocol_version: '1.5', exit_if_run_fails: true }), hash),
    ).toMatch(/only with onward_sharing/);
    expect(
      validateQuoteRequest(
        makeQuoteRequest({
          protocol_version: '1.5',
          onward_sharing: grant,
          exit_if_run_fails: 'yes' as never,
        }),
        hash,
      ),
    ).toMatch(/exit_if_run_fails: true/);
  });

  it('Q-54: a partner-run version carries it from 1.5, inside its terms digest', () => {
    const ends = { partner_run: true as const, offer_ends_at: '2026-08-08T09:00:00Z' };
    const withExit = (version: string, digestWithExit: boolean) =>
      quoteWithPartnerRun(version, (alt) => ({
        ...alt,
        ...ends,
        exit_if_run_fails: true,
        terms_digest: commerceRecordDigest(
          'terms',
          termsDigestInput({
            ...makeSignedQuote({ overrides: { protocol_version: version } }),
            charges: alt.charges,
            estimated_delivery_at: alt.estimated_delivery_at,
            ...(digestWithExit ? { exit_if_run_fails: true as const } : {}),
          }),
          hash,
        ),
      }));
    expect(validateSignedQuote(withExit('1.5', true), hash)).toBeNull();
    expect(validateSignedQuote(withExit('1.4', true), hash)).toMatch(/minor >= 1.5/);
    // The right is part of what the digest binds.
    expect(validateSignedQuote(withExit('1.5', false), hash)).toMatch(/terms_digest/);
    // Only on a partner-run version.
    expect(
      validateSignedQuote(quoteWithPartnerRun('1.5', { exit_if_run_fails: true } as never), hash),
    ).toMatch(/exactly/);
    // A digest made without it is the digest it always was.
    const plain = makeSignedQuote({});
    expect(termsDigestInput({ ...plain })).not.toHaveProperty('exit_if_run_fails');
  });
});
