/**
 * Quote request and signed quote (§9.7–§9.9, §9.13, §16.2).
 *
 * The invariants enforced here are the ones the dual review fought
 * hardest for:
 *
 * - transmitted subtotals and totals are CHECKED, never trusted —
 *   both sides recompute under the §9.1 contract;
 * - one currency per quote;
 * - `previous_quote_digest` is strictly the intra-`quote_id` chain:
 *   absent on revision "1", required after it. Cross-family lineage
 *   (a counterproposal replacement) is the separate
 *   `replaces_quote_digest`, legal ONLY on a revision "1";
 * - `max_uses` is immutable within a `quote_id` — enforced by the
 *   revision-chain check;
 * - `supplier_epoch` is required and covered by `quote_digest`; buyers
 *   reject a quote whose epoch is below their per-supplier watermark
 *   (restore fence, §16.2);
 * - buyer verification binds the quote to the exact retained request
 *   (`request_digest`) and the exact projection priced
 *   (`priced_delivery_projection_digest`) — a quote failing either
 *   binding answered a different question.
 */

import { computeLineSubtotal, computeTotal, validateCharge, type Charge } from './arithmetic';
import {
  verifyConversationVersion,
  isRecord,
  isoUtcMillis,
  validateDid,
  validateHex64,
  validateId,
  validateIsoUtc,
  validateProtocolVersionShape,
} from './common';
import { commerceRecordDigest, verifyCommerceRecordDigest, type Sha256Fn } from './digests';
import { validateMoney, type Money } from './money';
import { validateCanonicalPositiveInteger } from './numeric';
import { productRefsEqual, validateProductRef, type ProductRef } from './product';
import { validateQuantity, type Quantity } from './quantity';
import { validateDeliveryProjection, type DeliveryProjection } from './region';

export const MAX_QUOTE_LINES = 50;
export const MAX_CHARGES = 20;
export const MAX_RESERVATIONS = MAX_QUOTE_LINES;
export const MAX_EPOCH_DIGITS = 12;
export const MAX_USES_DIGITS = 6;
export const MAX_REVISION_DIGITS = 9;

// ---------------------------------------------------------------------------
// Quote request (§9.7)
// ---------------------------------------------------------------------------

export interface QuoteRequestLine {
  line_id: string;
  product: ProductRef;
  requested_quantity: Quantity;
  acceptable_substitutions?: 'none' | 'equivalent' | 'supplier_may_propose';
}

export interface QuoteRequest {
  protocol_version: string;
  request_id: string;
  buyer_did: string;
  supplier_did: string;
  lines: QuoteRequestLine[];
  delivery: {
    projection: DeliveryProjection;
    required_by?: string;
  };
  requested_terms?: {
    currency?: string;
    credit_days?: number;
  };
  issued_at: string;
  expires_at: string;
  idempotency_key: string;
  request_digest: string;
}

const SUBSTITUTIONS: ReadonlySet<string> = new Set(['none', 'equivalent', 'supplier_may_propose']);

function validateLineIds(lines: readonly { line_id: string }[]): string | null {
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.line_id)) return `lines: duplicate line_id "${line.line_id}"`;
    seen.add(line.line_id);
  }
  return null;
}

export function validateQuoteRequest(request: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(request)) return 'quoteRequest: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(request.protocol_version, 'quoteRequest.protocol_version'),
    validateId(request.request_id, 'quoteRequest.request_id'),
    validateDid(request.buyer_did, 'quoteRequest.buyer_did'),
    validateDid(request.supplier_did, 'quoteRequest.supplier_did'),
    validateIsoUtc(request.issued_at, 'quoteRequest.issued_at'),
    validateIsoUtc(request.expires_at, 'quoteRequest.expires_at'),
    validateId(request.idempotency_key, 'quoteRequest.idempotency_key'),
  ];
  for (const err of checks) if (err) return err;

  if (!Array.isArray(request.lines) || request.lines.length === 0) {
    return 'quoteRequest.lines: must be a non-empty array';
  }
  if (request.lines.length > MAX_QUOTE_LINES) {
    return `quoteRequest.lines: exceeds ${MAX_QUOTE_LINES} lines`;
  }
  for (const line of request.lines) {
    if (!isRecord(line)) return 'quoteRequest.lines[]: must be objects';
    const lineErr =
      validateId(line.line_id, 'quoteRequest.lines[].line_id') ??
      validateProductRef(line.product) ??
      validateQuantity(line.requested_quantity, { require_positive: true });
    if (lineErr) return lineErr;
    if (
      line.acceptable_substitutions !== undefined &&
      (typeof line.acceptable_substitutions !== 'string' ||
        !SUBSTITUTIONS.has(line.acceptable_substitutions))
    ) {
      return 'quoteRequest.lines[].acceptable_substitutions: must be none | equivalent | supplier_may_propose';
    }
  }
  const dupErr = validateLineIds(request.lines as { line_id: string }[]);
  if (dupErr) return `quoteRequest.${dupErr}`;

  if (!isRecord(request.delivery)) return 'quoteRequest.delivery: must be an object';
  const projectionError = validateDeliveryProjection(request.delivery.projection, sha256);
  if (projectionError) return `quoteRequest.delivery: ${projectionError}`;
  if (request.delivery.required_by !== undefined) {
    const err = validateIsoUtc(request.delivery.required_by, 'quoteRequest.delivery.required_by');
    if (err) return err;
  }

  if (request.requested_terms !== undefined) {
    if (!isRecord(request.requested_terms))
      return 'quoteRequest.requested_terms: must be an object';
    const terms = request.requested_terms;
    if (
      terms.currency !== undefined &&
      (typeof terms.currency !== 'string' || !/^[A-Z]{3}$/.test(terms.currency))
    ) {
      return 'quoteRequest.requested_terms.currency: must be a three-letter uppercase code';
    }
    if (
      terms.credit_days !== undefined &&
      (typeof terms.credit_days !== 'number' ||
        !Number.isInteger(terms.credit_days) ||
        terms.credit_days < 0 ||
        terms.credit_days > 3650)
    ) {
      return 'quoteRequest.requested_terms.credit_days: must be an integer in [0, 3650]';
    }
  }

  if (isoUtcMillis(request.expires_at as string) <= isoUtcMillis(request.issued_at as string)) {
    return 'quoteRequest.expires_at: must be after issued_at';
  }

  return verifyCommerceRecordDigest('request', request, sha256);
}

// ---------------------------------------------------------------------------
// Signed quote (§9.8)
// ---------------------------------------------------------------------------

export type StockStatus = 'available' | 'partial' | 'backorder' | 'unavailable';

export interface SignedQuoteLine {
  line_id: string;
  requested_product: ProductRef;
  offered_product: ProductRef;
  quantity: Quantity;
  price_basis: Quantity;
  unit_price: Money;
  line_subtotal: Money;
  stock_status: StockStatus;
  available_quantity?: Quantity;
  substitution_evidence?: string[];
}

export interface QuoteReservation {
  line_id: string;
  quantity_reserved: Quantity;
  expires_at: string; // must not exceed valid_until; advisory in v1
}

export interface SignedQuote {
  protocol_version: string;
  quote_id: string;
  request_id: string;
  request_digest: string;
  buyer_did: string;
  supplier_did: string;
  quote_revision: string;
  previous_quote_digest?: string;
  replaces_quote_digest?: string;
  priced_delivery_projection_digest: string;
  lines: SignedQuoteLine[];
  charges: Charge[];
  total: Money;
  estimated_dispatch_at?: string;
  estimated_delivery_at?: string;
  payment_terms?: PaymentTerms;
  issued_at: string;
  valid_until: string;
  supplier_epoch: string;
  max_uses?: string; // default "1"
  reservations?: QuoteReservation[];
  catalog_snapshot_ref?: string;
  terms_digest: string;
  quote_digest: string;
}

/**
 * §4.5 (TRADE_FIRST_STRATEGY) — when credit matures. `from_delivery`
 * starts one clock PER RECEIPTED PORTION (each DeliveryReceipt's
 * `received_at` + credit days, for the value that receipt accepted);
 * `from_acceptance` runs ONE clock from the acknowledgement's
 * `accepted_at` for the whole order. Sits INSIDE `payment_terms`, so it
 * is under the terms digest the order accepts. Introduced at protocol
 * minor 1.1: emitting it into a 1.0 conversation is refused, readers
 * tolerate its absence.
 */
export const DUE_BASES = ['from_delivery', 'from_acceptance'] as const;
export type DueBasis = (typeof DUE_BASES)[number];

export interface PaymentTerms {
  credit_days?: number;
  text?: string;
  due_basis?: DueBasis;
}

const STOCK_STATUSES: ReadonlySet<string> = new Set([
  'available',
  'partial',
  'backorder',
  'unavailable',
]);

/**
 * The commercial-terms projection `terms_digest` covers. The spec
 * names the field without enumerating it; v1 freezes this set (and
 * the conformance vectors pin it): charges, delivery/dispatch
 * estimates, payment terms, validity end.
 */
export function termsDigestInput(quote: {
  charges: Charge[];
  estimated_dispatch_at?: string;
  estimated_delivery_at?: string;
  payment_terms?: PaymentTerms;
  valid_until: string;
}): Record<string, unknown> {
  return {
    charges: quote.charges,
    estimated_dispatch_at: quote.estimated_dispatch_at,
    estimated_delivery_at: quote.estimated_delivery_at,
    payment_terms: quote.payment_terms,
    valid_until: quote.valid_until,
  };
}

/** Effective use ceiling: absent max_uses means "1" (§9.9). */
export function effectiveMaxUses(quote: Pick<SignedQuote, 'max_uses'>): bigint {
  return BigInt(quote.max_uses ?? '1');
}

/**
 * Structural + arithmetic validation of a signed quote (§9.8, §9.1).
 * Does NOT check audience/request bindings — that is
 * `verifySignedQuoteForBuyer`, which needs buyer-held context.
 */
/** A validated signed quote, or the reason it is not one. See
 *  `readPurchaseOrderProposal` for why the typed read is the primary form. */
export type ReadSignedQuote = { ok: true; quote: SignedQuote } | { ok: false; error: string };

export function readSignedQuote(quote: unknown, sha256: Sha256Fn): ReadSignedQuote {
  const error = validateSignedQuote(quote, sha256);
  return error === null ? { ok: true, quote: quote as SignedQuote } : { ok: false, error };
}

export function validateSignedQuote(quote: unknown, sha256: Sha256Fn): string | null {
  if (!isRecord(quote)) return 'quote: must be an object';
  const checks: (string | null)[] = [
    validateProtocolVersionShape(quote.protocol_version, 'quote.protocol_version'),
    validateId(quote.quote_id, 'quote.quote_id'),
    validateId(quote.request_id, 'quote.request_id'),
    validateHex64(quote.request_digest, 'quote.request_digest'),
    validateDid(quote.buyer_did, 'quote.buyer_did'),
    validateDid(quote.supplier_did, 'quote.supplier_did'),
    validateHex64(
      quote.priced_delivery_projection_digest,
      'quote.priced_delivery_projection_digest',
    ),
    validateIsoUtc(quote.issued_at, 'quote.issued_at'),
    validateIsoUtc(quote.valid_until, 'quote.valid_until'),
  ];
  for (const err of checks) if (err) return err;

  const revisionError = validateCanonicalPositiveInteger(
    quote.quote_revision as string,
    MAX_REVISION_DIGITS,
  );
  if (revisionError) return `quote.quote_revision: ${revisionError}`;
  const epochError = validateCanonicalPositiveInteger(
    quote.supplier_epoch as string,
    MAX_EPOCH_DIGITS,
  );
  if (epochError) return `quote.supplier_epoch: ${epochError}`;

  // Revision-chain field shape (§9.8): previous_quote_digest is the
  // intra-quote_id chain — absent on rev 1, required after; the
  // cross-family replaces_quote_digest may appear ONLY on a rev 1.
  const isFirstRevision = quote.quote_revision === '1';
  if (isFirstRevision && quote.previous_quote_digest !== undefined) {
    return 'quote.previous_quote_digest: must be absent on revision "1" (intra-quote_id chain only)';
  }
  if (!isFirstRevision) {
    const err = validateHex64(quote.previous_quote_digest, 'quote.previous_quote_digest');
    if (err) return err;
  }
  if (quote.replaces_quote_digest !== undefined) {
    if (!isFirstRevision) {
      return 'quote.replaces_quote_digest: cross-family lineage is legal only on a revision "1"';
    }
    const err = validateHex64(quote.replaces_quote_digest, 'quote.replaces_quote_digest');
    if (err) return err;
  }

  if (quote.max_uses !== undefined) {
    const err = validateCanonicalPositiveInteger(quote.max_uses as string, MAX_USES_DIGITS);
    if (err) return `quote.max_uses: ${err}`;
  }

  // Lines + arithmetic (§9.1): recompute, never trust.
  if (!Array.isArray(quote.lines) || quote.lines.length === 0) {
    return 'quote.lines: must be a non-empty array';
  }
  if (quote.lines.length > MAX_QUOTE_LINES) return `quote.lines: exceeds ${MAX_QUOTE_LINES} lines`;

  const totalMoney = quote.total as Money;
  const totalError = validateMoney(quote.total);
  if (totalError) return `quote.total: ${totalError}`;
  const currency = totalMoney.currency;

  const subtotals: Money[] = [];
  for (const line of quote.lines) {
    if (!isRecord(line)) return 'quote.lines[]: must be objects';
    const lineErr =
      validateId(line.line_id, 'quote.lines[].line_id') ??
      validateProductRef(line.requested_product) ??
      validateProductRef(line.offered_product) ??
      validateQuantity(line.quantity, { require_positive: true }) ??
      validateQuantity(line.price_basis, { require_positive: true }) ??
      validateMoney(line.unit_price) ??
      validateMoney(line.line_subtotal);
    if (lineErr) return lineErr;
    if (typeof line.stock_status !== 'string' || !STOCK_STATUSES.has(line.stock_status)) {
      return 'quote.lines[].stock_status: must be available | partial | backorder | unavailable';
    }
    if (line.available_quantity !== undefined) {
      const err = validateQuantity(line.available_quantity);
      if (err) return `quote.lines[].available_quantity: ${err}`;
    }
    const unitPrice = line.unit_price as Money;
    const lineSubtotal = line.line_subtotal as Money;
    if (unitPrice.currency !== currency || lineSubtotal.currency !== currency) {
      return 'quote: mixed currencies are invalid in v1 — one currency per quote';
    }
    const recomputed = computeLineSubtotal(
      unitPrice,
      line.quantity as Quantity,
      line.price_basis as Quantity,
    );
    if (recomputed.error) return `quote.lines[${String(line.line_id)}]: ${recomputed.error}`;
    if (recomputed.value?.minor_units !== lineSubtotal.minor_units) {
      return `quote.lines[${String(line.line_id)}]: transmitted line_subtotal ${lineSubtotal.minor_units} does not equal the §9.1 recomputation ${String(recomputed.value?.minor_units)}`;
    }
    subtotals.push(lineSubtotal);
  }
  const dupErr = validateLineIds(quote.lines as { line_id: string }[]);
  if (dupErr) return `quote.${dupErr}`;

  if (!Array.isArray(quote.charges)) return 'quote.charges: must be an array';
  if (quote.charges.length > MAX_CHARGES) return `quote.charges: exceeds ${MAX_CHARGES}`;
  for (const charge of quote.charges) {
    const err = validateCharge(charge);
    if (err) return `quote.${err}`;
  }
  const recomputedTotal = computeTotal(currency, subtotals, quote.charges as Charge[]);
  if (recomputedTotal.error) return `quote.total: ${recomputedTotal.error}`;
  if (recomputedTotal.value?.minor_units !== totalMoney.minor_units) {
    return `quote.total: transmitted ${totalMoney.minor_units} does not equal the §9.1 recomputation ${String(recomputedTotal.value?.minor_units)}`;
  }

  // Validity window + reservations.
  if (isoUtcMillis(quote.valid_until as string) <= isoUtcMillis(quote.issued_at as string)) {
    return 'quote.valid_until: must be after issued_at';
  }
  if (quote.reservations !== undefined) {
    if (!Array.isArray(quote.reservations)) return 'quote.reservations: must be an array';
    if (quote.reservations.length > MAX_RESERVATIONS) {
      return `quote.reservations: exceeds ${MAX_RESERVATIONS}`;
    }
    const lineIds = new Set((quote.lines as { line_id: string }[]).map((l) => l.line_id));
    for (const reservation of quote.reservations) {
      if (!isRecord(reservation)) return 'quote.reservations[]: must be objects';
      const err =
        validateId(reservation.line_id, 'quote.reservations[].line_id') ??
        validateQuantity(reservation.quantity_reserved, { require_positive: true }) ??
        validateIsoUtc(reservation.expires_at, 'quote.reservations[].expires_at');
      if (err) return err;
      if (!lineIds.has(reservation.line_id as string)) {
        return `quote.reservations[]: line_id "${String(reservation.line_id)}" is not a quote line`;
      }
      if (
        isoUtcMillis(reservation.expires_at as string) > isoUtcMillis(quote.valid_until as string)
      ) {
        return 'quote.reservations[].expires_at: must not exceed valid_until';
      }
    }
  }
  if (quote.payment_terms !== undefined) {
    if (!isRecord(quote.payment_terms)) return 'quote.payment_terms: must be an object';
    const pt = quote.payment_terms;
    if (
      pt.credit_days !== undefined &&
      (typeof pt.credit_days !== 'number' ||
        !Number.isInteger(pt.credit_days) ||
        pt.credit_days < 0 ||
        pt.credit_days > 3650)
    ) {
      return 'quote.payment_terms.credit_days: must be an integer in [0, 3650]';
    }
    if (pt.text !== undefined && (typeof pt.text !== 'string' || pt.text.length > 500)) {
      return 'quote.payment_terms.text: must be a string of at most 500 characters';
    }
    if (pt.due_basis !== undefined) {
      if (!(DUE_BASES as readonly string[]).includes(pt.due_basis as string)) {
        return 'quote.payment_terms.due_basis: must be from_delivery or from_acceptance';
      }
      // §4.5 — the field exists from protocol minor 1.1. A conversation
      // pinned to 1.0 must not grow a due-date basis mid-flight: the
      // terms digest would cover a field the counterparty's validator
      // never pinned.
      const minor = Number(String(quote.protocol_version).split('.')[1] ?? '0');
      if (!Number.isFinite(minor) || minor < 1) {
        return 'quote.payment_terms.due_basis: requires protocol minor >= 1.1';
      }
    }
  }
  for (const field of ['estimated_dispatch_at', 'estimated_delivery_at'] as const) {
    if (quote[field] !== undefined) {
      const err = validateIsoUtc(quote[field], `quote.${field}`);
      if (err) return err;
    }
  }
  if (quote.catalog_snapshot_ref !== undefined) {
    const err = validateId(quote.catalog_snapshot_ref, 'quote.catalog_snapshot_ref');
    if (err) return err;
  }

  // Digests last: terms, then the quote digest over everything else.
  const termsError = validateHex64(quote.terms_digest, 'quote.terms_digest');
  if (termsError) return termsError;
  const expectedTerms = commerceRecordDigest(
    'terms',
    termsDigestInput(quote as unknown as SignedQuote),
    sha256,
  );
  if (quote.terms_digest !== expectedTerms) {
    return 'quote.terms_digest: does not match the canonical terms recomputation';
  }
  return verifyCommerceRecordDigest('quote', quote, sha256);
}

// ---------------------------------------------------------------------------
// Buyer-side verification (§9.8, §12.3 step 12, §16.2 watermark)
// ---------------------------------------------------------------------------

export interface BuyerQuoteContext {
  /** The buyer's own DID (audience binding). */
  buyer_did: string;
  /** Transport-authenticated sender DID of the D2D envelope. */
  authenticated_supplier_did: string;
  /** Digest of the exact retained QuoteRequest for this request_id. */
  retained_request_digest: string;
  /** Projection digest the buyer sent at quote stage. */
  sent_projection_digest: string;
  /** Highest supplier_epoch seen from this supplier ("0" when none). */
  epoch_watermark: string;
  /**
   * The exact retained QuoteRequest this quote claims to answer.
   *
   * The digest alone proves the supplier SAW the request; it proves nothing
   * about whether the quote's LINES correspond to it. Without the request
   * body a quote can reuse a genuine digest while inventing line ids,
   * misnaming `requested_product`, or substituting a different exact variant
   * where the buyer said `none` — and the buyer would authorise the wrong
   * goods against a quote that verifies.
   */
  retained_request: QuoteRequest;
  /**
   * Acceptance time (canonical ISO UTC). A cryptographically valid but
   * EXPIRED quote must not be ranked, approved, or shown as live.
   */
  at_iso: string;
}

/**
 * Full buyer-side acceptance check for an arriving quote. Returns
 * null when the quote is valid AND answers the buyer's exact
 * question; an error string otherwise.
 */
export function verifySignedQuoteForBuyer(
  quote: unknown,
  context: BuyerQuoteContext,
  sha256: Sha256Fn,
): string | null {
  const structural = validateSignedQuote(quote, sha256);
  if (structural) return structural;
  const q = quote as unknown as SignedQuote;
  if (q.buyer_did !== context.buyer_did) {
    return 'quote: audience mismatch — this quote was issued to a different buyer';
  }
  if (q.supplier_did !== context.authenticated_supplier_did) {
    return 'quote: supplier_did does not match the transport-authenticated sender';
  }
  if (q.request_digest !== context.retained_request_digest) {
    return 'quote: request_digest does not match the retained request — it answers a different question';
  }
  // §9.13 — the conversation's version is the REQUEST's. A structurally valid
  // quote at another version answers a question nobody asked in that dialect.
  const versioned = verifyConversationVersion(
    context.retained_request.protocol_version,
    q.protocol_version,
    'quote',
  );
  if (versioned !== null) return versioned;
  if (q.priced_delivery_projection_digest !== context.sent_projection_digest) {
    return 'quote: priced_delivery_projection_digest does not match the projection sent at quote stage';
  }
  if (BigInt(q.supplier_epoch) < BigInt(context.epoch_watermark)) {
    return 'quote: supplier_epoch is below the watermark — stale pre-restore signer (§16.2)';
  }
  if (context.retained_request.request_id !== q.request_id) {
    return 'quote: request_id does not match the retained request';
  }
  // Expiry compared here rather than imported from order.ts: quote.ts is
  // the earlier module in the dependency order, and the comparison is two
  // canonical ISO strings.
  if (isoUtcMillis(context.at_iso) > isoUtcMillis(q.valid_until)) {
    return 'quote: valid_until has passed — expired quotes are not acceptable terms';
  }
  const lines = verifyQuoteLinesAnswerRequest(q, context.retained_request);
  if (lines !== null) return lines;
  return null;
}

/**
 * §9.7/§9.8 — does every quoted line actually answer a requested line?
 *
 * A quote may price a SUBSET of the request (a supplier that cannot supply
 * everything still gives a usable answer), but it may not invent lines, and
 * each line it does price must name the product the buyer asked for unless
 * the buyer permitted a substitution.
 */
export function verifyQuoteLinesAnswerRequest(
  quote: SignedQuote,
  request: QuoteRequest,
): string | null {
  const asked = new Map(request.lines.map((l) => [l.line_id, l]));
  const seen = new Set<string>();
  for (const line of quote.lines) {
    const source = asked.get(line.line_id);
    if (source === undefined) {
      return `quote.lines[${line.line_id}]: no such line in the retained request — invented line`;
    }
    if (seen.has(line.line_id)) {
      return `quote.lines[${line.line_id}]: quoted twice`;
    }
    seen.add(line.line_id);

    if (!sameProduct(line.requested_product, source.product)) {
      return `quote.lines[${line.line_id}]: requested_product does not match the product the buyer asked for`;
    }

    // Substitution authority is the buyer's to grant, and defaults to NONE.
    // A supplier offering something other than what was asked, without that
    // permission, is a bait-and-switch the buyer must not be asked to
    // notice by eye (§20.4).
    const policy = source.acceptable_substitutions ?? 'none';
    const substituted = !sameProduct(line.offered_product, line.requested_product);
    if (substituted && policy === 'none') {
      return `quote.lines[${line.line_id}]: offers a substitute where the buyer allowed none`;
    }
    if (substituted && !Array.isArray(line.substitution_evidence)) {
      return `quote.lines[${line.line_id}]: a substitution must carry substitution_evidence`;
    }
  }
  return null;
}

/**
 * Exact product identity — `productRefsEqual`, not a local copy.
 *
 * The local copy compared `scheme` and `value` only, and the two fields it
 * omitted are the two that decide §9.4 EXACT-VARIANT authority: `issuer_did`
 * (the same SKU under a different manufacturer is a different product) and
 * `variant_digest` (a 12-pack is not a 6-pack). So a quote could offer another
 * issuer's part, or another variant of the right part, and satisfy a request
 * that said `acceptable_substitutions: "none"` — the exact bait-and-switch the
 * clause below exists to refuse, arriving through the check meant to catch it.
 *
 * The frozen vectors pin `productRefsEqual`. A second, weaker notion of "the
 * same product" living beside them is how a gate passes its own tests while
 * disagreeing with the contract it enforces.
 */
const sameProduct = productRefsEqual;

/**
 * Buyer-side fork DETECTION for a revision arriving on a held chain
 * (§9.8): same quote_id and identity fields, revision head+1,
 * previous_quote_digest equal to the held head digest, and the
 * immutable fields (max_uses among them) unchanged.
 */
export function verifyQuoteRevisionExtends(held: SignedQuote, next: SignedQuote): string | null {
  if (next.quote_id !== held.quote_id) return 'revision: quote_id changed';
  // A REVISION cannot change the dialect either — the same rule the
  // counterproposal clause of §9.13 names, applied where revisions are made.
  for (const field of [
    'buyer_did',
    'supplier_did',
    'request_id',
    'request_digest',
    'protocol_version',
  ] as const) {
    if (next[field] !== held[field]) return `revision: immutable field ${field} changed`;
  }
  if (effectiveMaxUses(next) !== effectiveMaxUses(held)) {
    return 'revision: max_uses is immutable within a quote_id — a different count needs a fresh quote_id';
  }
  if (BigInt(next.quote_revision) !== BigInt(held.quote_revision) + 1n) {
    return `revision: expected revision ${(BigInt(held.quote_revision) + 1n).toString(10)}, got ${next.quote_revision}`;
  }
  if (next.previous_quote_digest !== held.quote_digest) {
    return 'revision: previous_quote_digest does not extend the held head — supplier fork';
  }
  if (BigInt(next.supplier_epoch) < BigInt(held.supplier_epoch)) {
    return 'revision: supplier_epoch regressed within a quote chain';
  }
  return null;
}
