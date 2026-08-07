/**
 * Frozen-vector verification (§25.1, Phase 0 exit).
 *
 * The JSON under conformance/vectors/ is the compatibility law: every
 * value here is recomputed through the PUBLIC API and compared to the
 * frozen bytes. A red test here means the implementation drifted from
 * the frozen wire contract — fix the code, never the vectors (a
 * deliberate protocol change regenerates them WITH a major bump).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256 } from '@noble/hashes/sha2.js';

import { computeLineSubtotal, computeTotal, type Charge } from '../src/arithmetic';
import {
  COMMERCE_DIGEST_DOMAINS,
  commerceDigest,
  commerceRecordDigest,
  verifyCommerceRecordDigest,
  type CommerceDigestDomain,
} from '../src/digests';
import { validateMoney, type Money } from '../src/money';
import { validateQuantity, type Quantity } from '../src/quantity';
import { termsDigestInput, validateSignedQuote, type SignedQuote } from '../src/quote';
import { validateOrderReconcileRequest } from '../src/reconcile';
import { validateCommerceOrderStatus } from '../src/status';


import {
  makeAcceptedAck,
  makeSignedQuote,
  makeStatus,
  makeOrder,
  makeQuoteRequest,
} from './helpers/fixtures';

const hash = (data: Uint8Array) => sha256(data);

function loadVector<T>(name: string): T {
  return JSON.parse(
    readFileSync(join(__dirname, '..', 'conformance', 'vectors', name), 'utf8'),
  ) as T;
}

/** Set a dotted path on a structured clone of the object. */
function withMutation<T>(value: T, path: string, replacement: unknown): T {
  const clone = JSON.parse(JSON.stringify(value)) as T;
  const parts = path.split('.');
  let cursor: Record<string, unknown> = clone as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = replacement;
  return clone;
}

interface ArithmeticVector {
  bounds: {
    money: { max_minor_unit_digits: number; accepted: Money; rejected: Money };
    quantity: { max_integer_digits: number; accepted: Quantity; rejected: Quantity };
  };
  line_subtotals: {
    name: string;
    unit_price: Money;
    quantity: Quantity;
    price_basis: Quantity;
    expected_minor_units: string;
  }[];
  totals: {
    name: string;
    note?: string;
    currency: string;
    line_subtotals: string[];
    charges: Charge[];
    /** Exactly one of these is present per case. */
    expected_minor_units?: string;
    expected_error_contains?: string;
  }[];
}

describe('frozen arithmetic vectors', () => {
  const vector = loadVector<ArithmeticVector>('arithmetic.json');

  it.each(vector.line_subtotals)('line_subtotal: $name', (c) => {
    const { value, error } = computeLineSubtotal(c.unit_price, c.quantity, c.price_basis);
    expect(error).toBeNull();
    expect(value?.minor_units).toBe(c.expected_minor_units);
  });

  it('pins BOTH sides of every magnitude bound (workflow-pass finding 2)', () => {
    expect(validateMoney(vector.bounds.money.accepted)).toBeNull();
    expect(validateMoney(vector.bounds.money.rejected)).toMatch(/magnitude bound/);
    expect(validateQuantity(vector.bounds.quantity.accepted)).toBeNull();
    expect(validateQuantity(vector.bounds.quantity.rejected)).toMatch(/magnitude bound/);
  });

  it.each(vector.totals)('total: $name', (c) => {
    const { value, error } = computeTotal(
      c.currency,
      c.line_subtotals.map((minor_units) => ({ currency: c.currency, minor_units })),
      c.charges,
    );
    // A frozen vector pins REJECTIONS as tightly as results: an
    // implementation that accepts what this one refuses is not conformant
    // either, and the permutation pair below is meaningless without it.
    if (c.expected_error_contains !== undefined) {
      expect(value).toBeNull();
      expect(error).toContain(c.expected_error_contains);
      return;
    }
    expect(error).toBeNull();
    expect(value?.minor_units).toBe(c.expected_minor_units);
  });
});

interface DigestsVector {
  domain_separation: { payload: unknown; expected_by_domain: Record<string, string> };
  records: {
    domain: CommerceDigestDomain;
    digest_field: string;
    record: Record<string, unknown>;
  }[];
  terms_digest: { input: Record<string, unknown>; expected: string };
}

describe('frozen digest vectors', () => {
  const vector = loadVector<DigestsVector>('digests.json');

  it('pins every domain digest of the shared payload', () => {
    for (const domain of COMMERCE_DIGEST_DOMAINS) {
      expect(commerceDigest(domain, vector.domain_separation.payload, hash)).toBe(
        vector.domain_separation.expected_by_domain[domain],
      );
    }
  });

  it.each(vector.records.map((r, i) => ({ ...r, i })))(
    'record digest verifies and recomputes: $domain [$i]',
    ({ domain, digest_field, record }) => {
      expect(verifyCommerceRecordDigest(domain, record, hash)).toBeNull();
      expect(commerceRecordDigest(domain, record, hash)).toBe(record[digest_field]);
    },
  );

  it('pins the frozen terms_digest input field set', () => {
    const quote = vector.records.find((r) => r.domain === 'quote')
      ?.record as unknown as SignedQuote;
    expect(termsDigestInput(quote)).toEqual(vector.terms_digest.input);
    expect(commerceRecordDigest('terms', vector.terms_digest.input, hash)).toBe(
      vector.terms_digest.expected,
    );
  });

  it('every frozen quote passes full validation — including the optional-field-rich one', () => {
    const quotes = vector.records.filter((r) => r.domain === 'quote');
    expect(quotes.length).toBeGreaterThanOrEqual(2);
    for (const q of quotes) {
      expect(validateSignedQuote(q.record, hash)).toBeNull();
    }
    // The rich quote pins reservations/max_uses/payment_terms into the digest.
    const rich = quotes.find((q) => (q.record as { reservations?: unknown }).reservations);
    expect(rich).toBeDefined();
    expect((rich?.record as { max_uses?: string }).max_uses).toBe('3');
  });

  it('the frozen status chain links end-to-end (workflow-pass finding 3)', () => {
    const statuses = vector.records
      .filter((r) => r.domain === 'status')
      .map(
        (r) =>
          r.record as { sequence: string; status_digest: string; previous_status_digest?: string },
      );
    expect(statuses.length).toBeGreaterThanOrEqual(3);
    const bySequence = new Map(statuses.map((s) => [s.sequence, s]));
    for (const status of statuses) {
      if (status.sequence === '0') {
        expect(status.previous_status_digest).toBeUndefined();
        continue;
      }
      const predecessor = bySequence.get((BigInt(status.sequence) - 1n).toString(10));
      expect(predecessor).toBeDefined();
      expect(status.previous_status_digest).toBe(predecessor?.status_digest);
    }
  });
});

interface MalformedVector {
  held_evidence: {
    name: string;
    signature?: string;
    evidence_omits_signature?: boolean;
    error_includes: string;
  }[];
  money: { name: string; input: unknown; error_includes: string }[];
  quantity: { name: string; input: unknown; error_includes: string }[];
  line_subtotal: {
    name: string;
    unit_price: Money;
    quantity: Quantity;
    price_basis: Quantity;
    error_includes: string;
  }[];
  quote: { name: string; mutate: { path: string; value: unknown }; error_includes: string }[];
  status: { name: string; mutate: { path: string; value: unknown }; error_includes: string }[];
}

describe('frozen malformed-case battery', () => {
  const vector = loadVector<MalformedVector>('malformed.json');

  it.each(vector.money)('money rejects: $name', (c) => {
    expect(validateMoney(c.input)).toEqual(expect.stringContaining(c.error_includes));
  });

  it.each(vector.quantity)('quantity rejects: $name', (c) => {
    expect(validateQuantity(c.input)).toEqual(expect.stringContaining(c.error_includes));
  });

  it.each(vector.line_subtotal)('line_subtotal rejects: $name', (c) => {
    const { value, error } = computeLineSubtotal(c.unit_price, c.quantity, c.price_basis);
    expect(value).toBeNull();
    expect(error).toEqual(expect.stringContaining(c.error_includes));
  });

  // Quote/status mutations are applied to freshly built valid fixtures
  // so a mutation is the ONLY defect. Digest fields other than the
  // mutated one stay valid because the mutation happens post-build —
  // validators must fail on the pinned error, not merely "a" failure.
  it.each(vector.quote)('quote rejects: $name', (c) => {
    const quote = makeSignedQuote();
    const mutated = withMutation(quote, c.mutate.path, c.mutate.value);
    expect(validateSignedQuote(mutated, hash)).toEqual(expect.stringContaining(c.error_includes));
  });

  // §12.7/§16.2: the held-evidence WIRE SHAPE is frozen. A conforming
  // implementation must refuse evidence with no usable signature —
  // otherwise its re-adoption path can be driven by forged records.
  it.each(vector.held_evidence)('held evidence rejects: $name', (c) => {
    const request = makeQuoteRequest();
    const quote = makeSignedQuote({ request });
    const order = makeOrder(quote, request.delivery.projection);
    const ack = makeAcceptedAck(order);
    const evidence = c.evidence_omits_signature
      ? { record: ack }
      : { record: ack, signature: c.signature };
    const reconcileRequest = {
      protocol_version: '1.0',
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      idempotency_key: order.idempotency_key,
      held_acknowledgement: evidence,
    };
    expect(validateOrderReconcileRequest(reconcileRequest, hash)).toEqual(
      expect.stringContaining(c.error_includes),
    );
  });

  it.each(vector.status)('status rejects: $name', (c) => {
    const request = makeQuoteRequest();
    const quote = makeSignedQuote({ request });
    const order = makeOrder(quote, request.delivery.projection);
    const status = makeStatus(order, { sequence: '0', state: 'accepted' });
    const mutated = withMutation(status, c.mutate.path, c.mutate.value);
    expect(validateCommerceOrderStatus(mutated, hash)).toEqual(
      expect.stringContaining(c.error_includes),
    );
  });
});
