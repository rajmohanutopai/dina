/**
 * §4.5 (TRADE_FIRST_STRATEGY) — `due_basis` and derived due dates.
 *
 * The split-delivery case is the pinned centre: `from_delivery` runs one
 * clock per receipted portion, `from_acceptance` one clock for the whole
 * order, and both sides compute identical dues from the same documents.
 * The terms-digest growth is vector-pinned so the preimage cannot move
 * silently.
 */

import { createHash } from 'node:crypto';

import {
  commerceRecordDigest,
  deriveDues,
  termsDigestInput,
  validateSignedQuote,
  type Sha256Fn,
} from '../src/index';

import { makeSignedQuote } from './helpers/fixtures';

const hash: Sha256Fn = (data) => new Uint8Array(createHash('sha256').update(data).digest());

describe('deriveDues (§4.5)', () => {
  it('from_delivery: each receipt starts its own clock for its own value', () => {
    const derived = deriveDues({
      currency: 'INR',
      credit_days: 30,
      due_basis: 'from_delivery',
      receipted: [
        { received_at: '2026-08-01T10:00:00.000Z', value_minor: '27500' },
        { received_at: '2026-08-10T10:00:00.000Z', value_minor: '12500' },
      ],
    });
    expect(derived.error).toBeNull();
    expect(derived.value).toEqual([
      {
        due_at: '2026-08-31T10:00:00.000Z',
        amount: { currency: 'INR', minor_units: '27500' },
        basis: 'from_delivery',
      },
      {
        due_at: '2026-09-09T10:00:00.000Z',
        amount: { currency: 'INR', minor_units: '12500' },
        basis: 'from_delivery',
      },
    ]);
  });

  it('from_acceptance: ONE clock from accepted_at for the whole order', () => {
    const derived = deriveDues({
      currency: 'INR',
      credit_days: 15,
      due_basis: 'from_acceptance',
      accepted_at: '2026-08-01T09:30:00.000Z',
      order_total_minor: '517500',
    });
    expect(derived.value).toEqual([
      {
        due_at: '2026-08-16T09:30:00.000Z',
        amount: { currency: 'INR', minor_units: '517500' },
        basis: 'from_acceptance',
      },
    ]);
  });

  it('credit_days 0 matures at the clock start; a zero-value receipt starts no clock', () => {
    const derived = deriveDues({
      currency: 'INR',
      credit_days: 0,
      due_basis: 'from_delivery',
      receipted: [
        { received_at: '2026-08-01T10:00:00.000Z', value_minor: '100' },
        { received_at: '2026-08-02T10:00:00.000Z', value_minor: '0' },
      ],
    });
    expect(derived.value).toEqual([
      {
        due_at: '2026-08-01T10:00:00.000Z',
        amount: { currency: 'INR', minor_units: '100' },
        basis: 'from_delivery',
      },
    ]);
  });

  it('refuses rather than guesses: bad dates, bad money, missing acceptance inputs', () => {
    expect(
      deriveDues({
        currency: 'INR',
        credit_days: 30,
        due_basis: 'from_acceptance',
      }).error,
    ).toContain('from_acceptance needs');
    expect(
      deriveDues({
        currency: 'INR',
        credit_days: 30,
        due_basis: 'from_delivery',
        receipted: [{ received_at: 'yesterday', value_minor: '1' }],
      }).error,
    ).not.toBeNull();
    expect(
      deriveDues({
        currency: 'INR',
        credit_days: 30,
        due_basis: 'from_delivery',
        receipted: [{ received_at: '2026-08-01T10:00:00.000Z', value_minor: '-5' }],
      }).error,
    ).not.toBeNull();
    expect(
      deriveDues({
        currency: 'INR',
        credit_days: 30.5,
        due_basis: 'from_delivery',
        receipted: [],
      }).error,
    ).toContain('credit_days');
  });
});

describe('due_basis on the quote (§4.5 minor gate + grown preimage)', () => {
  it('the vocabulary is pinned; a 1.0 conversation refuses the field; 1.1 carries it', () => {
    const bad = makeSignedQuote({
      overrides: { payment_terms: { credit_days: 30, due_basis: 'whenever' as never } },
    });
    expect(validateSignedQuote(bad, hash)).toContain('due_basis');

    const tooOld = makeSignedQuote({
      overrides: { payment_terms: { credit_days: 30, due_basis: 'from_delivery' } },
    });
    expect(validateSignedQuote(tooOld, hash)).toContain('protocol minor');

    const modern = makeSignedQuote({
      overrides: {
        protocol_version: '1.1',
        payment_terms: { credit_days: 30, due_basis: 'from_delivery' },
      },
    });
    expect(validateSignedQuote(modern, hash)).toBeNull();
  });

  it('the grown terms preimage is vector-pinned; the v1 preimage is unchanged', () => {
    const v1Terms = termsDigestInput({
      charges: [],
      payment_terms: { credit_days: 30 },
      valid_until: '2026-09-01T00:00:00.000Z',
    });
    const grownTerms = termsDigestInput({
      charges: [],
      payment_terms: { credit_days: 30, due_basis: 'from_delivery' },
      valid_until: '2026-09-01T00:00:00.000Z',
    });
    const v1 = commerceRecordDigest('terms', v1Terms, hash);
    const grown = commerceRecordDigest('terms', grownTerms, hash);
    expect(v1).toBe('a632cf64f04ee9e2399cb274a073d5148e2799d3c55f067cc9a0ecf1f00ab8db');
    expect(grown).toBe('0fe9cc4447ba48b628c5792e5d8f3cbe21a17eddfabe18387b478bc05d5286d4');
    expect(grown).not.toBe(v1);
  });
});
