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
import { computeLineSubtotal, computeTotal } from '../src/arithmetic';
import { COMMERCE_DIGEST_DOMAINS, commerceDigest } from '../src/digests';
import { termsDigestInput } from '../src/quote';

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
    { name: 'negative', input: { currency: 'INR', minor_units: '-1' }, error_includes: 'canonical' },
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
    { name: 'missing_unit', input: { value: '100', unit_code: '' }, error_includes: 'unknown unit' },
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
      error_includes: 'total',
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
};

write('arithmetic.json', arithmeticVector);
write('digests.json', digestsVector);
write('malformed.json', malformedVector);
console.log('done');
