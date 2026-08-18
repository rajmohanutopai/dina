import { sha256 } from '@noble/hashes/sha2.js';

import { canonicalJson } from '../src/canonical';
import {
  COMMERCE_DIGEST_DOMAINS,
  DIGEST_FIELD_BY_DOMAIN,
  commerceDigest,
  commerceRecordDigest,
  verifyCommerceRecordDigest,
} from '../src/digests';
import { inviteRecordDigest } from '../src/invite_documents';
import { revshareRecordDigest } from '../src/revenue_share';
import { tradeRecordDigest } from '../src/trade_documents';

const hash = (data: Uint8Array) => sha256(data);

describe('canonicalJson', () => {
  it('sorts object keys and strips whitespace', () => {
    expect(canonicalJson({ b: 1, a: 'x' })).toBe('{"a":"x","b":1}');
    expect(canonicalJson({ z: { d: true, c: null } })).toBe('{"z":{"c":null,"d":true}}');
  });

  it('drops undefined properties so absent optional fields canonicalize identically', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('rejects non-finite numbers and unsupported types', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
    expect(() => canonicalJson(Symbol('x'))).toThrow(/unsupported/);
  });

  it('preserves array order (arrays are sequences, not sets)', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });
});

describe('commerce digest domains', () => {
  const payload = { alpha: '1', beta: ['x', 'y'] };

  it('covers exactly the ten §9.12 domains', () => {
    expect([...COMMERCE_DIGEST_DOMAINS].sort()).toEqual(
      [
        'acknowledgement',
        'cancellation',
        'epoch',
        'order',
        'projection',
        'quote',
        'request',
        'result',
        'status',
        'terms',
      ].sort(),
    );
  });

  it('the same payload digests differently under every domain (non-interchangeable)', () => {
    const digests = COMMERCE_DIGEST_DOMAINS.map((d) => commerceDigest(d, payload, hash));
    expect(new Set(digests).size).toBe(COMMERCE_DIGEST_DOMAINS.length);
  });

  it('is deterministic across key order', () => {
    expect(commerceDigest('quote', { a: 1, b: 2 }, hash)).toBe(
      commerceDigest('quote', { b: 2, a: 1 }, hash),
    );
  });
});

describe('commerceRecordDigest', () => {
  it('excludes the record own digest field from its input', () => {
    const record = { quote_id: 'q1', total: { currency: 'INR', minor_units: '100' } };
    const digest = commerceRecordDigest('quote', record, hash);
    const withField = { ...record, quote_digest: digest };
    expect(commerceRecordDigest('quote', withField, hash)).toBe(digest);
  });

  it('keeps OTHER embedded digests in the input', () => {
    const base = { quote_id: 'q1', terms_digest: 'a'.repeat(64) };
    const changedTerms = { quote_id: 'q1', terms_digest: 'b'.repeat(64) };
    expect(commerceRecordDigest('quote', base, hash)).not.toBe(
      commerceRecordDigest('quote', changedTerms, hash),
    );
  });

  it('stage-scoped projection recompute: widening the projection changes the digest', () => {
    const quoteStage = { region: { scheme: 'postal_area', value: '682001' } };
    const orderStage = {
      region: { scheme: 'postal_area', value: '682001' },
      address_lines: ['12 Harbour Rd'],
      recipient_name: 'Stores Desk',
    };
    expect(commerceRecordDigest('projection', quoteStage, hash)).not.toBe(
      commerceRecordDigest('projection', orderStage, hash),
    );
  });
});

describe('verifyCommerceRecordDigest', () => {
  const record = () => {
    const base: Record<string, unknown> = { orderId: 'po-1', total: '100' };
    return { ...base, order_digest: commerceRecordDigest('order', base, hash) };
  };

  it('accepts a correct digest', () => {
    expect(verifyCommerceRecordDigest('order', record(), hash)).toBeNull();
  });

  it('rejects a tampered field', () => {
    const tampered = { ...record(), total: '999' };
    expect(verifyCommerceRecordDigest('order', tampered, hash)).toMatch(/does not match/);
  });

  it('rejects a missing or malformed digest field', () => {
    expect(verifyCommerceRecordDigest('order', { orderId: 'po-1' }, hash)).toMatch(/64-char/);
    expect(
      verifyCommerceRecordDigest('order', { orderId: 'po-1', order_digest: 'ABC' }, hash),
    ).toMatch(/64-char/);
  });

  it('rejects a digest computed under the wrong domain', () => {
    const base: Record<string, unknown> = { orderId: 'po-1' };
    const wrongDomain = { ...base, order_digest: commerceRecordDigest('quote', base, hash) };
    expect(verifyCommerceRecordDigest('order', wrongDomain, hash)).toMatch(/does not match/);
  });
});

describe('DIGEST_FIELD_BY_DOMAIN', () => {
  it('maps every domain to its <domain>_digest field', () => {
    for (const domain of COMMERCE_DIGEST_DOMAINS) {
      expect(DIGEST_FIELD_BY_DOMAIN[domain]).toBe(`${domain}_digest`);
    }
  });
});
describe('cross-FAMILY domain separation', () => {
  it('one payload digests to a different value in every record family', () => {
    // Four families beside the §9.12 set now digest records:
    // dina:commerce:v1:, dina:commerce:trade:v1:, dina:commerce:invite:v1:,
    // dina:commerce:revshare:v1:. If any two shared a preimage, a record
    // admitted by one verifier could be replayed at another.
    const payload = { probe: 'one payload, many families', n: 7 };
    const digests = [
      commerceRecordDigest('order', payload, hash),
      tradeRecordDigest('payment_note', payload, hash),
      inviteRecordDigest('invite_offer', payload, hash),
      revshareRecordDigest('settlement_note', payload, hash),
    ];
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('a kind name reused across families still separates (the family is in the domain)', () => {
    // No kind string is shared today; this pins that even a FUTURE
    // reuse cannot collide, because the family prefix is committed.
    const payload = { probe: 'same kind string, two families' };
    expect(tradeRecordDigest('quote_decline' as never, payload, hash)).not.toBe(
      revshareRecordDigest('quote_decline' as never, payload, hash),
    );
  });
});
