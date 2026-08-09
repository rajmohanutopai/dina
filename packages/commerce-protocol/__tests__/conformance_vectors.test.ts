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
import { canonicalJson } from '../src/canonical';
import { validateProductRelationshipClaim } from '../src/catalog';
import {
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  verifyCatalogPage,
  verifyCatalogPointerAdvance,
  verifyCatalogSnapshot,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '../src/catalog_publication';
import { checkProtocolVersion, validateProtocolVersionShape } from '../src/common';
import {
  COMMERCE_DIGEST_DOMAINS,
  commerceDigest,
  commerceRecordDigest,
  verifyCommerceRecordDigest,
  type CommerceDigestDomain,
} from '../src/digests';
import { validateMoney, type Money } from '../src/money';
import { productRefsEqual, validateProductRef, type ProductRef } from '../src/product';
import { compareQuantities, validateQuantity, type Quantity } from '../src/quantity';
import { termsDigestInput, validateSignedQuote, type SignedQuote } from '../src/quote';
import { validateOrderReconcileRequest } from '../src/reconcile';
import { validateCommerceOrderStatus } from '../src/status';
import {
  UNIT_VOCABULARY_V1,
  UNIT_VOCABULARY_VERSION,
  unitDef,
  unitsComparable,
} from '../src/units';

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

describe('frozen unit-vocabulary vectors (§9.2)', () => {
  interface UnitsVector {
    vocabulary_version: string;
    units: { code: string; dimension: string; scale: number; base_factor: string | null }[];
    rejected_codes: string[];
    comparability: { a: string; b: string; expect: boolean }[];
  }
  const vector = loadVector<UnitsVector>('units.json');

  it('pins the CLOSED vocabulary exactly, membership included', () => {
    // The list being closed is the rule (owner decision, §27 Q4). A port that
    // quietly accepted one more unit would price orders this one refuses, so
    // the vector fixes membership, not just the shape of a member.
    expect(UNIT_VOCABULARY_VERSION).toBe(vector.vocabulary_version);
    expect(UNIT_VOCABULARY_V1.map((u) => u.code)).toEqual(vector.units.map((u) => u.code));
    for (const expected of vector.units) {
      const actual = unitDef(expected.code);
      if (actual === undefined) throw new Error(`vocabulary lost the unit ${expected.code}`);
      expect(actual.dimension).toBe(expected.dimension);
      expect(actual.scale).toBe(expected.scale);
      expect(actual.baseFactor === null ? null : actual.baseFactor.toString()).toBe(
        expected.base_factor,
      );
    }
  });

  it.each(loadVector<UnitsVector>('units.json').rejected_codes)(
    'refuses the out-of-vocabulary code %p',
    (code) => {
      expect(unitDef(code)).toBeUndefined();
    },
  );

  it.each(loadVector<UnitsVector>('units.json').comparability)(
    'comparability $a vs $b -> $expect',
    ({ a, b, expect: expected }) => {
      const left = unitDef(a);
      const right = unitDef(b);
      if (left === undefined || right === undefined)
        throw new Error('vector names a unit that is gone');
      expect(unitsComparable(left, right)).toBe(expected);
    },
  );
});

describe('frozen product-identity vectors (§9.3/§9.4)', () => {
  interface ProductVector {
    equality: { name: string; a: ProductRef; b: ProductRef; equal: boolean }[];
    rejected: { name: string; product: unknown; error: string | null }[];
    scoped: { name: string; product: unknown; error: string | null }[];
    variant: { name: string; a: ProductRef; b: ProductRef; equal: boolean }[];
    variant_rejected: { name: string; product: unknown; error: string | null }[];
  }
  const vector = loadVector<ProductVector>('product.json');

  it.each(vector.equality)('equality: $name -> $equal', ({ a, b, equal }) => {
    // Equality decides whether an order line matches the quote line it claims,
    // so a port that normalised differently would accept substitutions this
    // one refuses — a commercial difference, not a cosmetic one.
    expect(productRefsEqual(a, b)).toBe(equal);
  });

  it.each(vector.rejected)('rejects: $name', ({ product, error }) => {
    expect(validateProductRef(product)).toBe(error);
    expect(error).not.toBeNull();
  });

  /**
   * §9.3 NORMALIZATION, which is where equality alone stops being enough.
   *
   * An identifier is a signed assertion BY ITS ISSUER. `OAK-CHAIR-1` means
   * nothing until you know who says so, and two manufacturers using the same
   * internal SKU is ordinary rather than exotic. A port that accepted a scoped
   * scheme without an issuer would let one supplier's catalog answer for
   * another's part number.
   *
   * Accepted cases are pinned alongside the refusals on purpose: a port that
   * refused EVERYTHING would pass a refusal-only vector.
   */
  it.each(vector.scoped)('scoping: $name', ({ product, error }) => {
    expect(validateProductRef(product)).toBe(error);
  });

  /**
   * §9.4 EXACT-VARIANT AUTHORITY — the substitution rule.
   *
   * The same identifier at a different variant is a DIFFERENT line item. This
   * is the vector that stops a port shipping a 12-pack against a quote for a
   * 6-pack because the GTIN matched, and it pins the asymmetric case too:
   * a variant present on one side and absent on the other is NOT a match,
   * because "unspecified" is not a wildcard.
   */
  it.each(vector.variant)('variant: $name -> $equal', ({ a, b, equal }) => {
    expect(productRefsEqual(a, b)).toBe(equal);
  });

  it.each(vector.variant_rejected)('variant rejects: $name', ({ product, error }) => {
    expect(validateProductRef(product)).toBe(error);
    expect(error).not.toBeNull();
  });
});

/**
 * §9.13 SCHEMA EVOLUTION — the two halves of forward compatibility.
 *
 * VERSION ADMISSION decides whether this build may parse a document at all:
 * same MAJOR yes (MINOR is strictly additive), anything else a TYPED refusal
 * naming what is supported. A port that compared the whole version string
 * would refuse every minor release; one that compared nothing would parse a
 * major it cannot understand and act on fields that changed meaning.
 *
 * UNKNOWN FIELDS are the other half, and the law is easy to get backwards.
 * Canonicalization walks whatever it is given, so an unknown field CHANGES the
 * digest — which means a receiver may not strip fields it does not recognise
 * and still expect the signature to verify. Validation, in the other
 * direction, TOLERATES them: a record from a newer minor is not invalid merely
 * because it says more than this build reads. Accept and preserve; never
 * accept and rewrite.
 */
describe('frozen schema-evolution vectors (§9.13)', () => {
  interface EvolutionVector {
    version_admission: {
      name: string;
      version: string;
      error: { code: string; requested_version: string; supported_versions: string[] } | null;
    }[];
    version_shape: { name: string; value: unknown; error: string | null }[];
    unknown_fields: {
      name: string;
      known: Record<string, unknown>;
      with_unknown: Record<string, unknown>;
      known_canonical: string;
      with_unknown_canonical: string;
      same_bytes: boolean;
    }[];
    unknown_field_tolerance: { name: string; product: unknown; error: string | null }[];
  }
  const vector = loadVector<EvolutionVector>('schema_evolution.json');

  it.each(vector.version_admission)('admission: $name', ({ version, error }) => {
    expect(checkProtocolVersion(version)).toEqual(error);
  });

  it.each(vector.version_shape)('shape: $name', ({ value, error }) => {
    expect(validateProtocolVersionShape(value, 'protocol_version')).toBe(error);
  });

  it.each(vector.unknown_fields)(
    'unknown fields: $name',
    ({ known, with_unknown, known_canonical, with_unknown_canonical, same_bytes }) => {
      // The BYTES are pinned, not merely their equality: a port that
      // canonicalized both sides the same wrong way would satisfy an
      // equality-only assertion.
      expect(canonicalJson(known)).toBe(known_canonical);
      expect(canonicalJson(with_unknown)).toBe(with_unknown_canonical);
      expect(canonicalJson(known) === canonicalJson(with_unknown)).toBe(same_bytes);
    },
  );

  it.each(vector.unknown_field_tolerance)('tolerance: $name', ({ product, error }) => {
    expect(validateProductRef(product)).toBe(error);
  });
});

/**
 * §25.1 (WS-1.9) — unit and PACK conversion.
 *
 * A port that converts differently prices an order differently. The pack
 * cases are the ones that matter most: `case` and `pallet` carry no base
 * factor, so converting them needs evidence this layer does not hold, and the
 * rule is to REFUSE. An implementation that guessed "a case is twelve" would
 * quietly agree to a pallet order at a twelfth of its size.
 */
describe('frozen quantity-comparison vectors (§9.1/§9.2)', () => {
  interface QuantityVector {
    comparisons: { name: string; a: Quantity; b: Quantity; compare?: number; error?: string }[];
    rejected: { name: string; quantity: unknown; error: string | null }[];
  }
  const vector = loadVector<QuantityVector>('quantity.json');

  it.each(vector.comparisons)('comparison: $name', (kase) => {
    const result = compareQuantities(kase.a, kase.b);
    if (kase.error !== undefined) {
      // The refusal STRING is frozen, not merely the fact of refusal. Two
      // implementations rejecting the same pair for differently-worded
      // reasons diverge the first time an operator reads a log.
      expect(result).toBe(kase.error);
    } else {
      expect(result).toBe(kase.compare);
    }
  });

  it('has a pack case AND a cross-dimension case, so neither rule rides on the other', () => {
    // They refuse for different reasons — missing evidence versus a category
    // error — and a vector set carrying only one would let a port collapse
    // them into a single check that happens to pass.
    const errors = vector.comparisons
      .filter((c) => c.error !== undefined)
      .map((c) => c.error ?? '');
    expect(errors.some((e) => e.includes('pack evidence'))).toBe(true);
    expect(errors.some((e) => e.includes('"kg" and "l"'))).toBe(true);
  });

  it.each(vector.rejected)('rejects: $name', ({ quantity, error }) => {
    expect(validateQuantity(quantity)).toBe(error);
    expect(error).not.toBeNull();
  });
});

/**
 * §25.1 (WS-1.9) — relationship canonicalization and temporal validity.
 *
 * These edges compose manufacturer standing, so a port that accepted an edge
 * this one refuses would inherit reputation along a claim that means nothing.
 */
describe('frozen relationship-claim vectors (§10.2)', () => {
  interface RelationshipVector {
    claims: { name: string; claim: unknown; error: string | null }[];
  }
  const vector = loadVector<RelationshipVector>('relationship.json');

  it.each(vector.claims)('claim: $name', ({ claim, error }) => {
    expect(validateProductRelationshipClaim(claim)).toBe(error);
  });

  it('pins the discriminant in BOTH directions', () => {
    // A DID relationship with a product object, and a product relationship
    // with a DID object. Checking one direction leaves the other open, and
    // "manufactured by another product" is the edge that corrupts standing.
    const names = vector.claims.filter((c) => c.error !== null).map((c) => c.name);
    expect(names).toContain('did_relationship_with_product_object');
    expect(names).toContain('product_relationship_with_did_object');
  });

  it('refuses a temporal window that closes before, or when, it opens', () => {
    const byName = new Map(vector.claims.map((c) => [c.name, c]));
    expect(byName.get('temporal_window_inverted')?.error).not.toBeNull();
    // Zero-length too: a window that never contains an instant is not a
    // window, and `<=` rather than `<` is the whole difference.
    expect(byName.get('temporal_window_zero_length')?.error).not.toBeNull();
    expect(byName.get('temporal_window_ordered')?.error).toBeNull();
  });

  it('requires UTC timestamps, not merely parseable ones', () => {
    // An offset timestamp parses fine and canonicalizes differently, so two
    // implementations would digest the same claim to different bytes.
    const byName = new Map(vector.claims.map((c) => [c.name, c]));
    expect(byName.get('non_utc_timestamp')?.error).not.toBeNull();
  });
});

describe('frozen catalog vectors (§10.2)', () => {
  interface CatalogVector {
    pages: CatalogSnapshotPage[];
    snapshot: CatalogSnapshot;
    genesis_pointer: CatalogPointer;
    chain_cases: {
      name: string;
      previous: CatalogPointer | null;
      next: CatalogPointer;
      expect: string | null;
    }[];
  }
  const vector = loadVector<CatalogVector>('catalog.json');

  it('recomputes every commitment from the frozen records', () => {
    // Byte-agreement is the whole point of a vector: a port that computes a
    // different page digest, root, or record digest from these exact bytes is
    // not interoperable, however sensible its own scheme looks.
    for (const page of vector.pages) {
      expect(catalogPageDigest(page, hash)).toBe(page.page_digest);
    }
    expect(catalogPayloadRoot(vector.snapshot.page_digests, hash)).toBe(
      vector.snapshot.payload_root,
    );
    expect(catalogSnapshotDigest(vector.snapshot, hash)).toBe(vector.snapshot.snapshot_digest);
  });

  it('verifies the frozen publication end to end', () => {
    expect(verifyCatalogSnapshot(vector.snapshot, hash)).toBeNull();
    for (const page of vector.pages) {
      expect(verifyCatalogPage(page, vector.snapshot, hash)).toBeNull();
    }
  });

  it.each(loadVector<CatalogVector>('catalog.json').chain_cases.map((c) => [c.name, c] as const))(
    'chain case: %s',
    (_name, testCase) => {
      // The refusal STRING is pinned, not just the fact of refusal — two
      // implementations that both reject a rollback for different stated
      // reasons will diverge the first time an operator reads a log.
      expect(verifyCatalogPointerAdvance(testCase.previous, testCase.next)).toBe(testCase.expect);
    },
  );
});

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
