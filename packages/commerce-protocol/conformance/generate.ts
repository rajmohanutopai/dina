/**
 * One-shot vector generator. Run manually when the protocol major
 * changes:
 *
 *     npx tsx packages/commerce-protocol/conformance/generate.ts
 *
 * The emitted JSON under conformance/vectors/ is a FROZEN artifact:
 * CI verifies it by recomputation through the public API, so any
 * drift in canonicalization, digest domains, or arithmetic turns
 * into a test failure. Never regenerate to "fix" a red vector test —
 * that is the drift the vectors exist to catch.
 *
 * Imports the deterministic test fixture builders (no Date.now, no
 * randomness) — generation-time only; the CI test reads the JSON.
 */

import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BUYER_DID,
  SUPPLIER_DID,
  hash,
  inr,
  makeAcceptedAck,
  makeCancellationRequest,
  makeCancellationResult,
  makeEpochRecord,
  makeOrder,
  makeProjection,
  makeQuoteRequest,
  makeRejectedAck,
  makeSignedQuote,
  makeStatus,
  makeSuccessor,
} from '../__tests__/helpers/fixtures';
import { computeLineSubtotal, computeTotal, type Charge } from '../src/arithmetic';
import { canonicalJson } from '../src/canonical';
import { validateProductRelationshipClaim } from '../src/catalog';
import {
  catalogPageDigest,
  catalogPayloadRoot,
  catalogSnapshotDigest,
  verifyCatalogPointerAdvance,
  type CatalogPointer,
  type CatalogSnapshot,
  type CatalogSnapshotPage,
} from '../src/catalog_publication';
import { checkProtocolVersion, validateProtocolVersionShape } from '../src/common';
import { COMMERCE_DIGEST_DOMAINS, commerceDigest, commerceRecordDigest } from '../src/digests';
import { productRefsEqual, validateProductRef, type ProductRef } from '../src/product';
import { compareQuantities, validateQuantity, type Quantity } from '../src/quantity';
import { termsDigestInput } from '../src/quote';
import {
  UNIT_VOCABULARY_V1,
  UNIT_VOCABULARY_VERSION,
  unitDef,
  unitsComparable,
} from '../src/units';

const VECTOR_DIR = join(__dirname, 'vectors');
mkdirSync(VECTOR_DIR, { recursive: true });

function write(name: string, value: unknown): void {
  writeFileSync(join(VECTOR_DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  console.log(`wrote ${name}`);
}

// ---------------------------------------------------------------------------
// arithmetic.json — §9.1 golden vectors
// ---------------------------------------------------------------------------

const subtotalCases = [
  {
    name: 'per_unit_pricing_exact',
    unit_price: inr('500'),
    quantity: { value: '100', unit_code: 'each' },
    price_basis: { value: '1', unit_code: 'each' },
  },
  {
    name: 'half_even_tie_rounds_to_even_up',
    unit_price: inr('15'),
    quantity: { value: '1', unit_code: 'each' },
    price_basis: { value: '2', unit_code: 'each' },
  },
  {
    name: 'half_even_tie_rounds_to_even_down',
    unit_price: inr('17'),
    quantity: { value: '1', unit_code: 'each' },
    price_basis: { value: '2', unit_code: 'each' },
  },
  {
    name: 'kg_gram_conversion_exact',
    unit_price: inr('50000'),
    quantity: { value: '1500', unit_code: 'g' },
    price_basis: { value: '1', unit_code: 'kg' },
  },
  {
    name: 'fractional_vocabulary_scale',
    unit_price: inr('50000'),
    quantity: { value: '1.5', unit_code: 'kg' },
    price_basis: { value: '1', unit_code: 'kg' },
  },
  {
    name: 'litre_ml_conversion_exact',
    unit_price: inr('9000'),
    quantity: { value: '250', unit_code: 'ml' },
    price_basis: { value: '1', unit_code: 'l' },
  },
  {
    name: 'per_case_pricing_same_code',
    unit_price: inr('120000'),
    quantity: { value: '12', unit_code: 'case' },
    price_basis: { value: '1', unit_code: 'case' },
  },
] as const;

const arithmeticVector = {
  description:
    '§9.1 v1 arithmetic contract: exact rational subtotal, ONE round-half-even, plain integer totals.',
  // Workflow-pass finding 2: BOTH sides of every magnitude bound are
  // frozen — an independent implementation must accept AT the bound
  // and reject one digit past it (§9.1: bounds are part of the schema).
  bounds: {
    money: {
      max_minor_unit_digits: 15,
      accepted: { currency: 'INR', minor_units: '9'.repeat(15) },
      rejected: { currency: 'INR', minor_units: '1'.repeat(16) },
    },
    quantity: {
      max_integer_digits: 12,
      accepted: { value: '9'.repeat(12), unit_code: 'each' },
      rejected: { value: '1'.repeat(13), unit_code: 'each' },
    },
  },
  line_subtotals: subtotalCases.map((c) => {
    const { value, error } = computeLineSubtotal(c.unit_price, c.quantity, c.price_basis);
    if (error || !value) throw new Error(`generator: ${c.name}: ${String(error)}`);
    return { ...c, expected_minor_units: value.minor_units };
  }),
  totals: [
    (() => {
      const result = computeTotal(
        'INR',
        [inr('50000'), inr('2250')],
        [
          {
            kind: 'delivery' as const,
            label: 'delivery',
            amount: inr('1500'),
            operation: 'add' as const,
          },
          {
            kind: 'discount' as const,
            label: 'first order',
            amount: inr('750'),
            operation: 'subtract' as const,
          },
        ],
      );
      if (result.error || !result.value) throw new Error(String(result.error));
      return {
        name: 'lines_plus_charges_integer_sum',
        currency: 'INR',
        line_subtotals: ['50000', '2250'],
        charges: [
          {
            kind: 'delivery',
            label: 'delivery',
            amount: { currency: 'INR', minor_units: '1500' },
            operation: 'add',
          },
          {
            kind: 'discount',
            label: 'first order',
            amount: { currency: 'INR', minor_units: '750' },
            operation: 'subtract',
          },
        ],
        expected_minor_units: result.value.minor_units,
      };
    })(),
    /**
     * §9.1 charge-order permutations. These were in the frozen JSON but NOT
     * in this generator, so running the documented regenerate command deleted
     * them — the drift the vectors exist to catch, pointing the other way.
     * Computed here, never hard-coded, so the emitted value is whatever the
     * implementation actually produces.
     */
    ...(() => {
      const discount = {
        kind: 'discount' as const,
        label: 'big',
        amount: inr('200'),
        operation: 'subtract' as const,
      };
      const surcharge = {
        kind: 'delivery' as const,
        label: 'later add',
        amount: inr('500'),
        operation: 'add' as const,
      };
      const wire = (c: typeof discount | typeof surcharge) => ({
        kind: c.kind,
        label: c.label,
        amount: { currency: 'INR', minor_units: c.amount.minor_units },
        operation: c.operation,
      });
      const permute = (charges: (typeof discount | typeof surcharge)[]) => {
        const result = computeTotal('INR', [inr('100')], charges as Charge[]);
        if (result.error || !result.value) throw new Error(String(result.error));
        return {
          currency: 'INR',
          line_subtotals: ['100'],
          charges: charges.map(wire),
          expected_minor_units: result.value.minor_units,
        };
      };
      // Non-negativity is a property of the RESULT, not of the running value,
      // so the discount-first case must succeed and this one must not.
      const negative = computeTotal('INR', [inr('100')], [discount] as Charge[]);
      if (!negative.error) throw new Error('a total below zero must be rejected');
      return [
        {
          name: 'charge_order_discount_first',
          note: '§9.1 is a plain integer sum, so a discount preceding a surcharge must give the same total as the reverse. An implementation that rejects intermediate negatives disagrees here.',
          ...permute([discount, surcharge]),
        },
        {
          name: 'charge_order_surcharge_first',
          note: 'Permutation of the case above. Both MUST produce 400.',
          ...permute([surcharge, discount]),
        },
        {
          name: 'final_total_negative_is_invalid',
          note: 'Non-negativity is a property of the RESULT, not of the running value.',
          currency: 'INR',
          line_subtotals: ['100'],
          // A distinct label from the permutation cases: this discount is
          // the one that drives the total below zero.
          charges: [wire({ ...discount, label: 'too big' })],
          expected_error_contains: 'negative',
        },
      ];
    })(),
  ],
};

// ---------------------------------------------------------------------------
// digests.json — §9.12 domain separation + record digests
// ---------------------------------------------------------------------------

const request = makeQuoteRequest();
const quote = makeSignedQuote({ request });
// Workflow-pass finding 1: a quote carrying EVERY optional commercial
// field (reservations, max_uses, payment_terms, estimated dates), so an
// independent implementation cannot pass the suite while dropping any
// of them from the digest input (§9.8: reservations are digest-bound).
const richQuote = makeSignedQuote({
  request,
  overrides: {
    quote_id: 'q-rich',
    max_uses: '3',
    estimated_dispatch_at: '2026-08-08T06:00:00.000Z',
    estimated_delivery_at: '2026-08-09T06:00:00.000Z',
    payment_terms: { credit_days: 30, text: 'Net 30' },
    reservations: [
      {
        line_id: 'l1',
        quantity_reserved: { value: '100', unit_code: 'each' },
        expires_at: '2026-08-08T08:00:00.000Z',
      },
    ],
  },
});
const pricedProjection = request.delivery.projection;
const order = makeOrder(quote, pricedProjection);
const acceptedAck = makeAcceptedAck(order);
const supersededAck = makeRejectedAck(order, {
  reason_code: 'quote_superseded',
  current_quote_digest: quote.quote_digest,
});
const genesisStatus = makeStatus(order, { sequence: '0', state: 'accepted' });
const preparingStatus = makeSuccessor(order, genesisStatus, { state: 'preparing' });
const partialStatus = makeSuccessor(order, preparingStatus, {
  state: 'partially_fulfilled',
  lines: [{ line_id: 'l1', fulfilled_quantity: { value: '40', unit_code: 'each' } }],
});
const cancellationRequest = makeCancellationRequest(order);
const cancelledResult = makeCancellationResult(order, {
  result: 'cancelled',
  status_digest_at_resolution: partialStatus.status_digest,
});
const epochGenesis = makeEpochRecord('1');
const epochRestore = makeEpochRecord('2', epochGenesis);
const orderStageProjection = order.delivery;

const domainSamplePayload = { alpha: '1', beta: ['x', 'y'] };

const digestsVector = {
  description:
    '§9.12 digest domains: preimage "dina:commerce:v1:<domain>\\n" + canonicalJson(record minus own digest field), SHA-256, lowercase hex.',
  buyer_did: BUYER_DID,
  supplier_did: SUPPLIER_DID,
  domain_separation: {
    payload: domainSamplePayload,
    expected_by_domain: Object.fromEntries(
      COMMERCE_DIGEST_DOMAINS.map((d) => [d, commerceDigest(d, domainSamplePayload, hash)]),
    ),
  },
  records: [
    { domain: 'projection', digest_field: 'projection_digest', record: makeProjection() },
    { domain: 'projection', digest_field: 'projection_digest', record: orderStageProjection },
    { domain: 'request', digest_field: 'request_digest', record: request },
    { domain: 'quote', digest_field: 'quote_digest', record: quote },
    { domain: 'quote', digest_field: 'quote_digest', record: richQuote },
    { domain: 'order', digest_field: 'order_digest', record: order },
    { domain: 'acknowledgement', digest_field: 'acknowledgement_digest', record: acceptedAck },
    { domain: 'acknowledgement', digest_field: 'acknowledgement_digest', record: supersededAck },
    { domain: 'status', digest_field: 'status_digest', record: genesisStatus },
    { domain: 'status', digest_field: 'status_digest', record: preparingStatus },
    { domain: 'status', digest_field: 'status_digest', record: partialStatus },
    { domain: 'cancellation', digest_field: 'cancellation_digest', record: cancellationRequest },
    { domain: 'result', digest_field: 'result_digest', record: cancelledResult },
    { domain: 'epoch', digest_field: 'epoch_digest', record: epochGenesis },
    { domain: 'epoch', digest_field: 'epoch_digest', record: epochRestore },
  ],
  terms_digest: {
    description: 'The frozen terms_digest input field set (implementation note).',
    quote_ref: 'records[3]',
    input: termsDigestInput(quote),
    expected: quote.terms_digest,
  },
};

// ---------------------------------------------------------------------------
// malformed.json — reject-the-same-malformed-cases battery
// ---------------------------------------------------------------------------

const malformedVector = {
  description:
    'Phase 0 exit: independent implementations must REJECT these, with the pinned error substring.',
  money: [
    {
      name: 'leading_zero',
      input: { currency: 'INR', minor_units: '01' },
      error_includes: 'canonical',
    },
    {
      name: 'negative',
      input: { currency: 'INR', minor_units: '-1' },
      error_includes: 'canonical',
    },
    { name: 'float', input: { currency: 'INR', minor_units: '1.5' }, error_includes: 'canonical' },
    {
      name: 'lowercase_currency',
      input: { currency: 'inr', minor_units: '1' },
      error_includes: 'ISO 4217',
    },
    {
      name: 'overflow',
      input: { currency: 'INR', minor_units: '1'.repeat(16) },
      error_includes: 'magnitude bound',
    },
  ],
  quantity: [
    {
      name: 'trailing_zero_fraction',
      input: { value: '1.50', unit_code: 'kg' },
      error_includes: 'canonical',
    },
    {
      name: 'scale_overflow',
      input: { value: '1.2345', unit_code: 'kg' },
      error_includes: 'declared scale',
    },
    {
      name: 'missing_unit',
      input: { value: '100', unit_code: '' },
      error_includes: 'unknown unit',
    },
    {
      name: 'custom_unit_v1',
      input: { value: '1', unit_code: 'custom:did:plc:x#sack' },
      error_includes: 'custom units are not valid in v1',
    },
    {
      name: 'fraction_on_count_unit',
      input: { value: '1.5', unit_code: 'each' },
      error_includes: 'declared scale',
    },
  ],
  line_subtotal: [
    {
      name: 'pack_evidence_conversion',
      unit_price: { currency: 'INR', minor_units: '100' },
      quantity: { value: '24', unit_code: 'each' },
      price_basis: { value: '1', unit_code: 'case' },
      error_includes: 'no exact declared conversion',
    },
    {
      name: 'cross_dimension',
      unit_price: { currency: 'INR', minor_units: '100' },
      quantity: { value: '1', unit_code: 'kg' },
      price_basis: { value: '1', unit_code: 'l' },
      error_includes: 'no exact declared conversion',
    },
  ],
  quote: [
    {
      name: 'tampered_line_subtotal',
      mutate: { path: 'lines.0.line_subtotal.minor_units', value: '49999' },
      error_includes: 'does not equal the §9.1 recomputation',
    },
    {
      name: 'tampered_total',
      mutate: { path: 'total.minor_units', value: '1' },
      // `quote.total:` and not `total`. The bare word is a SUBSTRING of
      // `line_subtotal`, so a port that refused this for the line-level reason
      // — or for any reason mentioning a subtotal — passed a case about the
      // ORDER total. The vector pins which rule fired; a needle that cannot
      // distinguish two rules pins nothing.
      error_includes: 'quote.total:',
    },
    {
      name: 'tampered_terms_digest',
      mutate: { path: 'terms_digest', value: 'c'.repeat(64) },
      error_includes: 'terms_digest',
    },
    {
      name: 'rev1_with_previous',
      mutate: { path: 'previous_quote_digest', value: 'a'.repeat(64) },
      error_includes: 'absent on revision "1"',
    },
    {
      name: 'epoch_zero',
      mutate: { path: 'supplier_epoch', value: '0' },
      error_includes: 'supplier_epoch',
    },
    { name: 'max_uses_zero', mutate: { path: 'max_uses', value: '0' }, error_includes: 'max_uses' },
  ],
  /**
   * §12.7/§16.2 held evidence. The wire REQUIRES a supplier signature
   * alongside the record: a record plus its content digest proves
   * nothing, because the digest is a hash of the record and anyone
   * holding or inventing it can compute one. An implementation that
   * accepts bare records cannot implement the fail-closed re-adoption
   * rule at all, so these rejections are part of conformance.
   */
  held_evidence: [
    {
      name: 'bare_record_without_signature',
      evidence_omits_signature: true,
      error_includes: 'signature',
    },
    {
      name: 'empty_signature',
      signature: '',
      error_includes: 'signature',
    },
    {
      name: 'non_hex_signature',
      signature: 'not-hex-at-all',
      error_includes: 'lowercase hex',
    },
    {
      name: 'odd_length_hex_signature',
      signature: 'abc',
      error_includes: 'lowercase hex',
    },
    {
      name: 'uppercase_hex_signature',
      signature: 'AB'.repeat(32),
      error_includes: 'lowercase hex',
    },
  ],
  status: [
    {
      name: 'supplier_signed_submitted',
      mutate: { path: 'state', value: 'submitted' },
      error_includes: 'buyer-local',
    },
    {
      name: 'lines_on_accepted',
      mutate: {
        path: 'lines',
        value: [{ line_id: 'l1', fulfilled_quantity: { value: '1', unit_code: 'each' } }],
      },
      error_includes: 'forbidden for state',
    },
  ],
  /**
   * THE RECORDS THE MUTATION CASES ARE APPLIED TO.
   *
   * Without these the `quote`, `status` and `held_evidence` families are not
   * executable by anyone but us: they say "set `total.minor_units` to 1 and
   * expect a refusal", and a port in Go or Rust has nothing to set it ON. Our
   * own suite built them from `makeSignedQuote()` and friends, which is to say
   * the vector was only half frozen — the half a second implementation cannot
   * reach was the half that decides whether a tampered quote is caught.
   *
   * Each is VALID as it stands, so a mutation is the only defect: a port that
   * refuses one of these unmutated has failed the positive case, and a port
   * that accepts a mutated one has failed the negative. Digest fields are real,
   * so the recomputation checks have something to disagree with.
   *
   * `held_record` is separate from `reconcile_request` because the
   * held_evidence cases vary the SIGNATURE beside the record: a port pairs
   * this record with each bad signature and checks the refusal.
   */
  base: {
    quote,
    status: genesisStatus,
    reconcile_request: {
      protocol_version: '1.0',
      purchase_order_id: order.purchase_order_id,
      order_digest: order.order_digest,
      idempotency_key: order.idempotency_key,
    },
    held_record: acceptedAck,
    /**
     * A well-formed signature, so the family can prove it ACCEPTS as well as
     * refuses.
     *
     * Without an accept case, an implementation whose `validateReconcileRequest`
     * refuses ALL held evidence — including a valid record — emits a message
     * containing "signature" or "lowercase hex" and passes all five refusal
     * cases. That is the §12.7/§16.2 family, the one whose failure makes a
     * recovery path drivable by forged evidence, certified by a port that
     * accepts nothing.
     *
     * Shape only, not a real Ed25519 signature over these bytes: the validator
     * pins the WIRE SHAPE (§12.7 requires a signature alongside the record,
     * because a record plus its content digest proves nothing), and verifying
     * the signature itself needs the supplier's key, which is a different
     * check in a different layer.
     */
    held_signature: 'ab'.repeat(32),
    /**
     * The retained D2D envelope, WITHOUT WHICH NO VALID EVIDENCE EXISTS.
     *
     * §12.7's reasoning: the only supplier signature a buyer can hold is the
     * envelope's, and an envelope signature is checkable only against the
     * envelope's own bytes — so `{record, signature}` with no envelope is
     * unverifiable by construction and the validator refuses it.
     *
     * Emitting it is what makes the accept case CONSTRUCTIBLE by a port. The
     * gap was invisible until an accept case was written: five refusal cases
     * ran happily against a base from which no valid evidence could be built,
     * which is the same shape of hole as the missing `base` itself.
     */
    held_envelope: {
      id: 'msg-1',
      type: 'service.response',
      from: order.supplier_did,
      to: [order.buyer_did],
      created_time: 1_770_000_000,
      body: '{}',
    },
  },
};

/**
 * §10.2 catalog publication. Frozen so a port can check it agrees on the
 * three commitments AND on which pointer advances the chain — the digests
 * alone would let an implementation compute identical bytes and still index
 * a rolled-back catalog.
 */
const catalogPage = (index: number, items: unknown[]): CatalogSnapshotPage => {
  const draft: CatalogSnapshotPage = {
    catalog_id: 'chairmaker-main',
    snapshot_sequence: 1,
    page_index: index,
    items,
    page_digest: '',
  };
  return { ...draft, page_digest: catalogPageDigest(draft, hash) };
};

const catalogPages = [
  catalogPage(0, [{ sku: 'CHAIR-1', name: 'Oak dining chair' }]),
  catalogPage(1, [{ sku: 'CHAIR-2', name: 'Beech stool' }]),
];
const catalogPageDigests = catalogPages.map((p) => p.page_digest);
const catalogSnapshotDraft: CatalogSnapshot = {
  supplier_did: SUPPLIER_DID,
  catalog_id: 'chairmaker-main',
  snapshot_sequence: 1,
  protocol_version: '1.0',
  published_at: '2026-01-01T00:00:00.000Z',
  page_digests: catalogPageDigests,
  item_count: 2,
  payload_root: catalogPayloadRoot(catalogPageDigests, hash),
  snapshot_digest: '',
};
const catalogSnapshot: CatalogSnapshot = {
  ...catalogSnapshotDraft,
  snapshot_digest: catalogSnapshotDigest(catalogSnapshotDraft, hash),
};
const genesisPointer: CatalogPointer = {
  supplier_did: SUPPLIER_DID,
  catalog_id: 'chairmaker-main',
  snapshot_sequence: 1,
  protocol_version: '1.0',
  published_at: '2026-01-01T00:00:00.000Z',
  snapshot_rkey: catalogSnapshot.snapshot_digest,
  snapshot_digest: catalogSnapshot.snapshot_digest,
};

const catalogVector = {
  pages: catalogPages,
  snapshot: catalogSnapshot,
  genesis_pointer: genesisPointer,
  /** Each case states the pointer and the exact refusal (null = accepted). */
  chain_cases: [
    { name: 'genesis_at_one', previous: null, next: genesisPointer, expect: null },
    {
      name: 'genesis_must_start_at_one',
      previous: null,
      next: { ...genesisPointer, snapshot_sequence: 2 },
      expect: verifyCatalogPointerAdvance(null, { ...genesisPointer, snapshot_sequence: 2 }),
    },
    {
      name: 'gap_is_a_publication_fault',
      previous: genesisPointer,
      next: {
        ...genesisPointer,
        snapshot_sequence: 3,
        previous_snapshot_digest: catalogSnapshot.snapshot_digest,
      },
      expect: verifyCatalogPointerAdvance(genesisPointer, {
        ...genesisPointer,
        snapshot_sequence: 3,
        previous_snapshot_digest: catalogSnapshot.snapshot_digest,
      }),
    },
    {
      name: 'rollback_refused',
      previous: { ...genesisPointer, snapshot_sequence: 4 },
      next: genesisPointer,
      expect: verifyCatalogPointerAdvance(
        { ...genesisPointer, snapshot_sequence: 4 },
        genesisPointer,
      ),
    },
    {
      name: 'nothing_follows_a_withdrawal',
      previous: {
        supplier_did: SUPPLIER_DID,
        catalog_id: 'chairmaker-main',
        snapshot_sequence: 2,
        protocol_version: '1.0',
        published_at: '2026-01-02T00:00:00.000Z',
        previous_snapshot_digest: catalogSnapshot.snapshot_digest,
        withdrawn: true,
      } as CatalogPointer,
      next: {
        ...genesisPointer,
        snapshot_sequence: 3,
        previous_snapshot_digest: catalogSnapshot.snapshot_digest,
      },
      expect: verifyCatalogPointerAdvance(
        {
          supplier_did: SUPPLIER_DID,
          catalog_id: 'chairmaker-main',
          snapshot_sequence: 2,
          protocol_version: '1.0',
          published_at: '2026-01-02T00:00:00.000Z',
          previous_snapshot_digest: catalogSnapshot.snapshot_digest,
          withdrawn: true,
        } as CatalogPointer,
        {
          ...genesisPointer,
          snapshot_sequence: 3,
          previous_snapshot_digest: catalogSnapshot.snapshot_digest,
        },
      ),
    },
  ],
};

/**
 * §9.2 unit vocabulary. A CLOSED list (owner decision, §27 Q4): a port that
 * silently accepted `oz` would price orders this one refuses, so the exact
 * membership, dimensions and base factors are frozen — not just the shape.
 */
/** Look a unit up or fail loudly — the generator must not silently emit a
 *  vector describing a unit the vocabulary no longer has. */
function requireUnit(code: string): NonNullable<ReturnType<typeof unitDef>> {
  const def = unitDef(code);
  if (def === undefined) throw new Error(`generator names a missing unit: ${code}`);
  return def;
}

const unitsVector = {
  vocabulary_version: UNIT_VOCABULARY_VERSION,
  units: UNIT_VOCABULARY_V1.map((u) => ({
    code: u.code,
    dimension: u.dimension,
    scale: u.scale,
    // BigInt is not JSON; the string is what a port compares against.
    base_factor: u.baseFactor === null ? null : u.baseFactor.toString(),
  })),
  /** Outside the vocabulary — every one of these MUST be unknown. */
  rejected_codes: ['oz', 'lb', 'dozen', 'EACH', 'kilogram', '', 'each '],
  comparability: [
    { a: 'g', b: 'kg', expect: unitsComparable(requireUnit('g'), requireUnit('kg')) },
    { a: 'ml', b: 'l', expect: unitsComparable(requireUnit('ml'), requireUnit('l')) },
    // Different dimensions never compare, however sensible a conversion looks.
    { a: 'g', b: 'ml', expect: unitsComparable(requireUnit('g'), requireUnit('ml')) },
    { a: 'each', b: 'g', expect: unitsComparable(requireUnit('each'), requireUnit('g')) },
    // `case`/`pallet` carry no base factor: their size is per-product, so two
    // cases are NOT comparable without the pack context.
    { a: 'case', b: 'each', expect: unitsComparable(requireUnit('case'), requireUnit('each')) },
  ],
};

/**
 * §9.3/§9.4 product identity. Equality decides whether an order line matches
 * the quote line it claims, so a port that normalised differently would accept
 * substitutions this one refuses.
 */
const productCases: { name: string; a: ProductRef; b: ProductRef }[] = [
  {
    name: 'identical_gtin',
    a: { scheme: 'gtin', value: '05012345678900' },
    b: { scheme: 'gtin', value: '05012345678900' },
  },
  {
    name: 'different_value',
    a: { scheme: 'gtin', value: '05012345678900' },
    b: { scheme: 'gtin', value: '05012345678917' },
  },
  {
    name: 'different_scheme_same_value',
    a: { scheme: 'gtin', value: '05012345678900' },
    b: { scheme: 'supplier_sku', value: '05012345678900' } as unknown as ProductRef,
  },
  // §9.3 — an identifier is a signed assertion BY ITS ISSUER. Two
  // manufacturers using the same internal SKU is ordinary, so the issuer is
  // part of identity and not decoration.
  {
    name: 'same_sku_different_issuer_is_a_different_product',
    a: { scheme: 'manufacturer_sku', value: 'OAK-CHAIR-1', issuer_did: 'did:plc:chairmaker99' },
    b: { scheme: 'manufacturer_sku', value: 'OAK-CHAIR-1', issuer_did: 'did:plc:someoneelse' },
  },
  {
    name: 'same_sku_same_issuer_is_the_same_product',
    a: { scheme: 'manufacturer_sku', value: 'OAK-CHAIR-1', issuer_did: 'did:plc:chairmaker99' },
    b: { scheme: 'manufacturer_sku', value: 'OAK-CHAIR-1', issuer_did: 'did:plc:chairmaker99' },
  },
  {
    name: 'issuer_present_versus_absent_is_not_equal',
    a: { scheme: 'dina_subject', value: 'subject-1', issuer_did: 'did:plc:chairmaker99' },
    b: { scheme: 'dina_subject', value: 'subject-1' },
  },
];

/**
 * §9.4 EXACT-VARIANT AUTHORITY. The same identifier at a different variant is
 * a different line item — this is what stops a 12-pack shipping against a
 * quote for a 6-pack because the GTIN matched. The asymmetric case is pinned
 * too: "unspecified" is not a wildcard.
 */
const VARIANT_A = 'a'.repeat(64);
const VARIANT_B = 'b'.repeat(64);
const variantCases: { name: string; a: ProductRef; b: ProductRef }[] = [
  {
    name: 'same_identifier_different_variant_is_NOT_a_substitute',
    a: { scheme: 'gtin', value: '05012345678900', variant_digest: VARIANT_A },
    b: { scheme: 'gtin', value: '05012345678900', variant_digest: VARIANT_B },
  },
  {
    name: 'variant_present_versus_absent_is_NOT_equal',
    a: { scheme: 'gtin', value: '05012345678900', variant_digest: VARIANT_A },
    b: { scheme: 'gtin', value: '05012345678900' },
  },
  {
    name: 'identical_variant_is_the_same_line_item',
    a: { scheme: 'gtin', value: '05012345678900', variant_digest: VARIANT_A },
    b: { scheme: 'gtin', value: '05012345678900', variant_digest: VARIANT_A },
  },
  {
    name: 'both_absent_is_the_same_line_item',
    a: { scheme: 'gtin', value: '05012345678900' },
    b: { scheme: 'gtin', value: '05012345678900' },
  },
];

/**
 * §9.13 SCHEMA EVOLUTION — the two halves of forward compatibility.
 *
 * VERSION ADMISSION decides whether this build may parse a document at all.
 * UNKNOWN FIELDS is the half that is easy to get backwards, so both directions
 * are generated together: canonicalization INCLUDES an unknown field (a
 * receiver may not strip what it does not recognise and still expect the
 * signature to verify), while validation TOLERATES it (a record from a newer
 * minor is not invalid merely because it says more than this build reads).
 */
const schemaEvolutionVector = {
  _note:
    '§9.13 version admission and the forward-compatibility law for unknown fields. Regenerated only with a MAJOR bump.',
  version_admission: [
    'same_major_same_minor_is_parseable:1.0',
    'same_major_higher_minor_is_parseable_because_minor_is_additive:1.7',
    'same_major_large_minor_is_parseable:1.999',
    'higher_major_is_refused:2.0',
    'lower_major_is_refused:0.9',
  ].map((spec) => {
    const at = spec.lastIndexOf(':');
    const version = spec.slice(at + 1);
    return { name: spec.slice(0, at), version, error: checkProtocolVersion(version) };
  }),
  version_shape: [
    { name: 'canonical_major_minor', value: '1.0' },
    { name: 'three_parts_is_not_a_protocol_version', value: '1.0.0' },
    { name: 'leading_zero_is_not_canonical', value: '01.0' },
    { name: 'minor_leading_zero_is_not_canonical', value: '1.01' },
    { name: 'major_alone_is_not_a_protocol_version', value: '1' },
    { name: 'not_a_string', value: 1 },
  ].map((c) => ({ ...c, error: validateProtocolVersionShape(c.value, 'protocol_version') })),
  unknown_fields: [
    {
      name: 'an_unknown_field_CHANGES_the_canonical_bytes',
      known: { a: '1', protocol_version: '1.0' },
      with_unknown: { a: '1', protocol_version: '1.0', future_field: 'x' },
    },
    {
      name: 'key_order_does_NOT_change_the_canonical_bytes',
      known: { protocol_version: '1.0', a: '1' },
      with_unknown: { a: '1', protocol_version: '1.0' },
    },
    {
      // An explicitly-undefined property is DROPPED — it canonicalizes as if
      // the key were never there. Distinct from `null`, which is a value and
      // survives; the pair below pins both, because a port that conflated them
      // would compute a different digest for the same record.
      name: 'an_explicitly_undefined_field_is_dropped_entirely',
      known: { a: '1' },
      with_unknown: { a: '1', future_field: undefined },
    },
    {
      name: 'an_explicit_null_is_a_VALUE_and_survives',
      known: { a: '1' },
      with_unknown: { a: '1', future_field: null },
    },
  ].map((c) => ({
    ...c,
    known_canonical: canonicalJson(c.known),
    with_unknown_canonical: canonicalJson(c.with_unknown),
    same_bytes: canonicalJson(c.known) === canonicalJson(c.with_unknown),
  })),
  unknown_field_tolerance: [
    {
      name: 'a_product_carrying_an_unknown_field_still_validates',
      product: { scheme: 'gtin', value: '05012345678900', future_field: 'x' },
    },
    {
      name: 'an_unknown_field_cannot_rescue_an_invalid_one',
      product: { scheme: 'gtin', value: '', future_field: 'x' },
    },
  ].map((c) => ({ ...c, error: validateProductRef(c.product) })),
};

const productVector = {
  equality: productCases.map((c) => ({
    name: c.name,
    a: c.a,
    b: c.b,
    equal: productRefsEqual(c.a, c.b),
  })),
  rejected: [
    { name: 'empty_value', product: { scheme: 'gtin', value: '' } },
    { name: 'unknown_scheme', product: { scheme: 'made_up', value: 'x' } },
    { name: 'missing_scheme', product: { value: 'x' } },
    { name: 'not_an_object', product: 'gtin:05012345678900' },
  ].map((c) => ({ ...c, error: validateProductRef(c.product) })),
  // NORMALIZATION, including the ACCEPTED cases: a port that refused
  // everything would pass a refusal-only vector.
  scoped: [
    {
      name: 'manufacturer_sku_without_issuer_is_refused',
      product: { scheme: 'manufacturer_sku', value: 'OAK-CHAIR-1' },
    },
    {
      name: 'custom_without_issuer_is_refused',
      product: { scheme: 'custom', value: 'internal-42' },
    },
    {
      name: 'manufacturer_sku_with_issuer_is_accepted',
      product: {
        scheme: 'manufacturer_sku',
        value: 'OAK-CHAIR-1',
        issuer_did: 'did:plc:chairmaker99',
      },
    },
    { name: 'gtin_needs_no_issuer', product: { scheme: 'gtin', value: '05012345678900' } },
    {
      name: 'gtin_value_must_be_8_to_14_digits',
      product: { scheme: 'gtin', value: '5012345' },
    },
    {
      name: 'gtin_value_must_be_digits_only',
      product: { scheme: 'gtin', value: '0501234567890X' },
    },
    {
      name: 'value_longer_than_128_is_refused',
      product: { scheme: 'dina_subject', value: 'x'.repeat(129) },
    },
  ].map((c) => ({ ...c, error: validateProductRef(c.product) })),
  variant: variantCases.map((c) => ({
    name: c.name,
    a: c.a,
    b: c.b,
    equal: productRefsEqual(c.a, c.b),
  })),
  variant_rejected: [
    {
      name: 'variant_digest_must_be_64_hex',
      product: { scheme: 'gtin', value: '05012345678900', variant_digest: 'not-hex' },
    },
    {
      name: 'variant_digest_must_be_lowercase',
      product: { scheme: 'gtin', value: '05012345678900', variant_digest: 'A'.repeat(64) },
    },
  ].map((c) => ({ ...c, error: validateProductRef(c.product) })),
};

/**
 * §25.1 (WS-1.9) — the five categories the vector set was missing.
 *
 * Each pins a rule whose DISAGREEMENT between implementations is commercial,
 * not cosmetic: a port that converts packs differently prices an order
 * differently, and one that projects a variant differently ships the wrong
 * thing. Refusal STRINGS are frozen, not merely the fact of refusal — two
 * implementations rejecting the same input for differently-worded reasons
 * diverge the first time an operator reads a log.
 */
const quantityCases: { name: string; a: Quantity; b: Quantity }[] = [
  // Same dimension, different scale: the conversion that must be exact.
  {
    name: 'kg_vs_g_equal',
    a: { unit_code: 'kg', value: '1' },
    b: { unit_code: 'g', value: '1000' },
  },
  {
    name: 'kg_vs_g_greater',
    a: { unit_code: 'kg', value: '1.001' },
    b: { unit_code: 'g', value: '1000' },
  },
  {
    name: 'l_vs_ml_equal',
    a: { unit_code: 'l', value: '0.25' },
    b: { unit_code: 'ml', value: '250' },
  },
  {
    name: 'each_vs_each',
    a: { unit_code: 'each', value: '3' },
    b: { unit_code: 'each', value: '4' },
  },
  // PACK EVIDENCE. `case` and `pallet` have no base factor, so converting
  // them needs evidence this layer does not carry. Refusing is the rule; a
  // port that guessed "a case is 12" would price a pallet order wrongly.
  {
    name: 'case_vs_each_needs_pack',
    a: { unit_code: 'case', value: '1' },
    b: { unit_code: 'each', value: '12' },
  },
  {
    name: 'pallet_vs_case_needs_pack',
    a: { unit_code: 'pallet', value: '1' },
    b: { unit_code: 'case', value: '40' },
  },
  {
    name: 'case_vs_case_comparable',
    a: { unit_code: 'case', value: '2' },
    b: { unit_code: 'case', value: '3' },
  },
  // Cross-dimension: never comparable, whatever the numbers say.
  {
    name: 'kg_vs_l_cross_dimension',
    a: { unit_code: 'kg', value: '1' },
    b: { unit_code: 'l', value: '1' },
  },
  {
    name: 'each_vs_g_cross_dimension',
    a: { unit_code: 'each', value: '1' },
    b: { unit_code: 'g', value: '1' },
  },
];

const quantityVector = {
  comparisons: quantityCases.map((c) => {
    const result = compareQuantities(c.a, c.b);
    return {
      name: c.name,
      a: c.a,
      b: c.b,
      // A number is an ordering; a string is a refusal, and its exact text is
      // what a port must reproduce.
      ...(typeof result === 'number' ? { compare: result } : { error: result }),
    };
  }),
  rejected: [
    { name: 'unknown_unit', quantity: { unit_code: 'furlong', value: '1' } },
    { name: 'scale_exceeded', quantity: { unit_code: 'each', value: '1.5' } },
    { name: 'negative', quantity: { unit_code: 'kg', value: '-1' } },
    { name: 'leading_zero', quantity: { unit_code: 'kg', value: '01' } },
    { name: 'not_a_number', quantity: { unit_code: 'kg', value: 'one' } },
  ].map((c) => ({ ...c, error: validateQuantity(c.quantity) })),
};

const RELATIONSHIP_SUBJECT: ProductRef = { scheme: 'gtin', value: '05012345678900' };
const RELATIONSHIP_OBJECT: ProductRef = { scheme: 'gtin', value: '05012345678917' };

const relationshipCases: { name: string; claim: unknown }[] = [
  {
    name: 'variant_of_product_object',
    claim: {
      claim_id: 'rc-1',
      subject: RELATIONSHIP_SUBJECT,
      relationship: 'variant_of',
      object: RELATIONSHIP_OBJECT,
      issuer_did: 'did:plc:chairmaker',
    },
  },
  {
    name: 'manufactured_by_did_object',
    claim: {
      claim_id: 'rc-2',
      subject: RELATIONSHIP_SUBJECT,
      relationship: 'manufactured_by',
      object: { did: 'did:plc:chairmaker' },
      issuer_did: 'did:plc:chairmaker',
    },
  },
  {
    name: 'temporal_window_ordered',
    claim: {
      claim_id: 'rc-3',
      subject: RELATIONSHIP_SUBJECT,
      relationship: 'replaces',
      object: RELATIONSHIP_OBJECT,
      issuer_did: 'did:plc:chairmaker',
      effective_from: '2026-01-01T00:00:00.000Z',
      effective_until: '2027-01-01T00:00:00.000Z',
    },
  },
  // The discriminant, in BOTH directions. A product "manufactured by" another
  // PRODUCT is an edge that means nothing, and it would compose manufacturer
  // standing along it.
  {
    name: 'did_relationship_with_product_object',
    claim: {
      claim_id: 'rc-4',
      subject: RELATIONSHIP_SUBJECT,
      relationship: 'manufactured_by',
      object: RELATIONSHIP_OBJECT,
      issuer_did: 'did:plc:chairmaker',
    },
  },
  {
    name: 'product_relationship_with_did_object',
    claim: {
      claim_id: 'rc-5',
      subject: RELATIONSHIP_SUBJECT,
      relationship: 'variant_of',
      object: { did: 'did:plc:chairmaker' },
      issuer_did: 'did:plc:chairmaker',
    },
  },
  {
    name: 'unknown_relationship',
    claim: {
      claim_id: 'rc-6',
      subject: RELATIONSHIP_SUBJECT,
      relationship: 'vaguely_related_to',
      object: RELATIONSHIP_OBJECT,
      issuer_did: 'did:plc:chairmaker',
    },
  },
  // Temporal validity: a window that closes before it opens is not a window.
  {
    name: 'temporal_window_inverted',
    claim: {
      claim_id: 'rc-7',
      subject: RELATIONSHIP_SUBJECT,
      relationship: 'replaces',
      object: RELATIONSHIP_OBJECT,
      issuer_did: 'did:plc:chairmaker',
      effective_from: '2027-01-01T00:00:00.000Z',
      effective_until: '2026-01-01T00:00:00.000Z',
    },
  },
  {
    name: 'temporal_window_zero_length',
    claim: {
      claim_id: 'rc-8',
      subject: RELATIONSHIP_SUBJECT,
      relationship: 'replaces',
      object: RELATIONSHIP_OBJECT,
      issuer_did: 'did:plc:chairmaker',
      effective_from: '2026-01-01T00:00:00.000Z',
      effective_until: '2026-01-01T00:00:00.000Z',
    },
  },
  {
    name: 'non_utc_timestamp',
    claim: {
      claim_id: 'rc-9',
      subject: RELATIONSHIP_SUBJECT,
      relationship: 'replaces',
      object: RELATIONSHIP_OBJECT,
      issuer_did: 'did:plc:chairmaker',
      effective_from: '2026-01-01T00:00:00+05:30',
    },
  },
];

const relationshipVector = {
  claims: relationshipCases.map((c) => ({
    name: c.name,
    claim: c.claim,
    // null = accepted. A string is the exact refusal a port must reproduce.
    error: validateProductRelationshipClaim(c.claim),
  })),
};

write('quantity.json', quantityVector);
write('relationship.json', relationshipVector);

write('units.json', unitsVector);
write('product.json', productVector);
write('schema_evolution.json', schemaEvolutionVector);
write('catalog.json', catalogVector);
write('arithmetic.json', arithmeticVector);
write('digests.json', digestsVector);
write('malformed.json', malformedVector);
// NINE FILES, TEN REQUIRED FAMILIES. `search_candidate.json` is HAND-AUTHORED
// and deliberately not emitted here: it is the one vector written for a
// CONSUMER rather than a publisher, so its `expect` strings are what a buyer's
// node must refuse an index for, not what this package happens to produce.
// Deriving it from our own validator would make both sides ours — the exact
// criticism levelled at the old discovery suite. It is pinned instead by
// `__tests__/search_candidate.test.ts` (the validator accepts the candidate and
// refuses each invalid case) and by AppView's projection test (the index
// PRODUCES that candidate). Said out loud because a third party running this
// generator gets nine of ten families and would otherwise see `ok: false` with
// no explanation.
// ---------------------------------------------------------------------------
// held_signed.json — §12.7/§16.2 GENUINELY SIGNED held evidence
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS. The `malformed.held_evidence` family tested STRUCTURE
// only: its cases pin "signature" or "lowercase hex", and its own valid base
// carried a 64-character signature — half an Ed25519 signature — with an
// envelope body of `"{}"` that bound no record at all. So the family certifying
// the rule that stops a recovery path being driven by forged evidence could be
// passed by an implementation that never verifies a signature and never checks
// that the envelope names the record it is offered with.
//
// These vectors carry a REAL Ed25519 signature over the canonical envelope, and
// the envelope commits to the record's digest. Verifying them needs actual
// crypto, which is exactly the point: a port cannot satisfy this family by
// pattern-matching hex.
//
// The keypair is derived from a FIXED seed so the vectors are frozen bytes
// rather than a fresh signature per run — a vector that changes every
// generation cannot be a conformance vector.
const heldSeed = Buffer.alloc(32, 7);
const heldPrivate = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), heldSeed]),
  format: 'der',
  type: 'pkcs8',
});
const heldPublic = createPublicKey(heldPrivate);
const heldPublicHex = heldPublic
  .export({ format: 'der', type: 'spki' })
  .subarray(-32)
  .toString('hex');

/**
 * A FULLY VALID `OrderAcknowledgement`, built by the codebase's OWN factory.
 *
 * The first version of this vector carried an ad-hoc record that
 * `validateOrderAcknowledgement` refuses outright — no `acknowledgement_id`,
 * no `issued_at`, no `kind`, none of the discriminant-specific fields. So the
 * family signed arbitrary JSON and called it held evidence: a verifier that
 * correctly composes SCHEMA VALIDATION with signature checking would reject the
 * case the vector calls valid, and the implementation that passed was the one
 * doing LESS work. A conformance vector only a lenient implementation can
 * satisfy inverts the whole point of having one.
 *
 * Hand-writing a replacement was the second mistake available here — the
 * digest has a canonical derivation, and restating it invites a third
 * divergence. `makeAcceptedAck` is the same builder every order test uses.
 */
const heldRecord = makeAcceptedAck(order, {
  acknowledgement_id: 'ack-held-1',
}) as unknown as Record<string, unknown>;

/** The envelope BINDS the record by naming its digest. */
const heldEnvelope = {
  envelope_id: 'env-held-1',
  from_did: 'did:plc:supplier1',
  to_did: 'did:plc:buyer1',
  sent_at: '2026-06-01T00:00:01Z',
  record_digest: heldRecord.acknowledgement_digest,
};

const signEnvelope = (envelope: unknown): string =>
  sign(null, Buffer.from(canonicalJson(envelope), 'utf8'), heldPrivate).toString('hex');

const heldSignature = signEnvelope(heldEnvelope);

/** Flip one hex digit — a signature that is well-formed and simply wrong. */
const flipHex = (hex: string): string =>
  `${hex.slice(0, -1)}${hex.slice(-1) === '0' ? '1' : '0'}`;

write('held_signed.json', {
  description:
    'Genuinely signed §12.7/§16.2 held evidence. The signature is Ed25519 over canonicalJson(envelope); the envelope commits to the record via record_digest. An implementation passes only by verifying BOTH the signature and the record binding.',
  signer: { did: 'did:plc:supplier1', public_key_hex: heldPublicHex },
  cases: [
    {
      name: 'valid/signature verifies and envelope binds the record',
      accepted: true,
      evidence: { record: heldRecord, envelope: heldEnvelope, signature: heldSignature },
    },
    {
      name: 'signature/one hex digit flipped',
      accepted: false,
      evidence: {
        record: heldRecord,
        envelope: heldEnvelope,
        signature: flipHex(heldSignature),
      },
    },
    {
      name: 'signature/64 hex characters is half an Ed25519 signature',
      // The exact defect the old "valid" base carried.
      accepted: false,
      evidence: {
        record: heldRecord,
        envelope: heldEnvelope,
        signature: heldSignature.slice(0, 64),
      },
    },
    {
      name: 'envelope/body altered after signing',
      accepted: false,
      evidence: {
        record: heldRecord,
        envelope: { ...heldEnvelope, to_did: 'did:plc:attacker1' },
        signature: heldSignature,
      },
    },
    {
      name: 'record/a DIFFERENT valid acknowledgement, not the one bound',
      // THE CASE THAT ISOLATES THE BINDING, and it took two attempts to get
      // right. Mutating a field made the record fail its OWN digest, so a
      // verifier checking only the schema refused it and the binding check was
      // never exercised — the case passed for the wrong reason.
      //
      // This record is a fully valid acknowledgement with a correct digest of
      // its own, and the signature over the envelope still verifies. Schema
      // passes, cryptography passes, and the ONLY thing wrong is that the
      // envelope commits to a different record. Nothing but a binding check
      // can refuse it.
      accepted: false,
      evidence: {
        record: makeAcceptedAck(order, {
          acknowledgement_id: 'ack-held-2',
          supplier_order_id: 'so-held-2',
        }),
        envelope: heldEnvelope,
        signature: heldSignature,
      },
    },
    {
      name: 'envelope/signed by a different key',
      accepted: false,
      evidence: {
        record: heldRecord,
        envelope: heldEnvelope,
        signature: sign(
          null,
          Buffer.from(canonicalJson(heldEnvelope), 'utf8'),
          createPrivateKey({
            key: Buffer.concat([
              Buffer.from('302e020100300506032b657004220420', 'hex'),
              Buffer.alloc(32, 9),
            ]),
            format: 'der',
            type: 'pkcs8',
          }),
        ).toString('hex'),
      },
    },
  ],
});

// ---------------------------------------------------------------------------
// nested_unknown.json — §9.13 stripping at EVERY digest-bound depth
// ---------------------------------------------------------------------------
//
// WHY A SECOND FILE. `schema_evolution.unknown_fields` carries FLAT generic
// objects, so the family built on it could only ever catch a parser that strips
// at the top level. A schema that preserves top-level unknowns and drops them
// inside a page, an item, a product reference or a relationship object passes
// it — and that is the shape of the defect AppView actually shipped, where
// `z.object()` stripped at every depth while the top level was `.passthrough()`.
//
// These cases are REAL records of a named kind, each carrying an unknown field
// at a different depth, with the canonical bytes that must survive. The kind
// travels with the case so a port can route it to the parser it really uses for
// that collection rather than to a generic one.
const nestedUnknownCases = [
  {
    kind: 'catalog_pointer',
    name: 'top level',
    record: { ...genesisPointer, future_field: 'x' },
  },
  {
    kind: 'catalog_snapshot',
    name: 'top level',
    record: { ...catalogSnapshot, future_field: 'x' },
  },
  {
    kind: 'catalog_page',
    name: 'inside the page',
    record: { ...catalogPages[0], future_field: 'x' },
  },
  {
    kind: 'catalog_page',
    name: 'inside an ITEM of the page',
    record: {
      ...catalogPages[0],
      items: (catalogPages[0].items as Record<string, unknown>[]).map((item, i) =>
        i === 0 ? { ...item, future_field: 'x' } : item,
      ),
    },
  },
  {
    kind: 'catalog_page',
    name: 'inside an item PRODUCT REF, two levels down',
    record: {
      ...catalogPages[0],
      items: (catalogPages[0].items as Record<string, unknown>[]).map((item, i) =>
        i === 0
          ? {
              ...item,
              product: {
                ...(item.product as Record<string, unknown>),
                future_qualifier: 'x',
              },
            }
          : item,
      ),
    },
  },
  {
    kind: 'relationship_claim',
    name: 'inside the claim SUBJECT',
    record: {
      claim_id: 'rc-nested-1',
      subject: { scheme: 'gtin', value: '0012345678905', future_qualifier: 'x' },
      relationship: 'variant_of',
      object: { scheme: 'gtin', value: '0012345678912' },
      issuer_did: 'did:plc:issuer1',
    },
  },
].map((c) => ({ ...c, canonical: canonicalJson(c.record) }));

write('nested_unknown.json', {
  description:
    'A §9.13 additive field at EVERY digest-bound depth, on real records of a named kind. A parser that preserves top-level unknowns and strips nested ones fails here while the flat unknown-field family passes.',
  cases: nestedUnknownCases,
});

console.log('done');
