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
import { projectionPincode, validateDeliveryProjection, type DeliveryProjection } from './region';

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
  /**
   * NEGOTIATION_PLAN §4.6 — a NEED instead of a product, for goods no two
   * suppliers share a code for ("floral celebration cake, 20 servings").
   * The line's `product` is then the buyer's own placeholder (`custom`,
   * issued by the buyer) and the supplier answers with its own item as a
   * substitution. From protocol minor 1.2; requires `supplier_may_propose`.
   */
  requirement?: QuoteRequirement;
}

export interface QuoteRequirement {
  text: string;
  category_id?: string;
}

export const MAX_REQUIREMENT_TEXT_LENGTH = 200;

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
  /** The buyer's onward-sharing grant (§6 step 0). From protocol minor 1.4. */
  onward_sharing?: OnwardSharingGrant;
  /**
   * From minor 1.5 (COMMITMENT_KERNEL §15 step 12): the buyer asks that a
   * version resting on a partner's run let it cancel without charge if the
   * run falls through after binding, rather than take the quote's own terms.
   * Only with `onward_sharing`, without which no partner run is asked.
   */
  exit_if_run_fails?: true;
  request_digest: string;
}

/**
 * The buyer's per-deal onward-sharing grant (COMMITMENT_KERNEL §6 step 0,
 * §11): which of the buyer's fields the supplier may pass on, and to which
 * kind of recipient, to open a smaller deal beneath this one. Only the
 * delivery pincode, and only to the supplier's own known shippers, in this
 * minor. The buyer cannot enforce what the supplier's node does; the grant
 * is the supplier's promise, and a breach is evidence. From minor 1.4.
 */
export interface OnwardSharingGrant {
  fields: ['postal_code'];
  recipient_role: 'shipper';
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

function validateOnwardSharing(grant: unknown, protocolVersion: unknown): string | null {
  const minor = Number(String(protocolVersion).split('.')[1] ?? '0');
  if (!Number.isFinite(minor) || minor < 4) {
    return 'quoteRequest.onward_sharing: requires protocol minor >= 1.4';
  }
  if (!isRecord(grant)) return 'quoteRequest.onward_sharing: must be an object';
  if (Object.keys(grant).sort().join(',') !== 'fields,recipient_role') {
    return 'quoteRequest.onward_sharing: exactly fields, recipient_role';
  }
  if (
    !Array.isArray(grant.fields) ||
    grant.fields.length !== 1 ||
    grant.fields[0] !== 'postal_code'
  ) {
    return 'quoteRequest.onward_sharing.fields: ["postal_code"]';
  }
  if (grant.recipient_role !== 'shipper') {
    return 'quoteRequest.onward_sharing.recipient_role: "shipper"';
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
    if (line.requirement !== undefined) {
      const requirementError = validateRequirementLine(
        line,
        request.protocol_version,
        request.buyer_did,
      );
      if (requirementError) return requirementError;
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

  if (request.onward_sharing !== undefined) {
    const err = validateOnwardSharing(request.onward_sharing, request.protocol_version);
    if (err) return err;
    const projection = (request.delivery as Record<string, unknown>).projection as DeliveryProjection;
    if (projectionPincode(projection) === undefined) {
      return 'quoteRequest.onward_sharing: grants a pincode the projection does not carry';
    }
  }

  if (request.exit_if_run_fails !== undefined) {
    const minor = Number(String(request.protocol_version).split('.')[1] ?? '0');
    if (!Number.isFinite(minor) || minor < 5)
      return 'quoteRequest.exit_if_run_fails: requires protocol minor >= 1.5';
    if (request.exit_if_run_fails !== true) return 'quoteRequest.exit_if_run_fails: true';
    if (request.onward_sharing === undefined)
      return 'quoteRequest.exit_if_run_fails: only with onward_sharing';
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

/**
 * A requirement line (NEGOTIATION_PLAN §4.6): a bounded description, a
 * placeholder product the BUYER issued (so no supplier's code is claimed),
 * and substitution authority — a need with `none` could never be answered.
 * Gated on minor 1.2 so a 1.1 conversation never grows a field its
 * counterparty's validator did not pin (the `due_basis` precedent).
 */
function validateRequirementLine(
  line: Record<string, unknown>,
  protocolVersion: unknown,
  buyerDid: unknown,
): string | null {
  const minor = Number(String(protocolVersion).split('.')[1] ?? '0');
  if (!Number.isFinite(minor) || minor < 2) {
    return 'quoteRequest.lines[].requirement: requires protocol minor >= 1.2';
  }
  if (!isRecord(line.requirement)) return 'quoteRequest.lines[].requirement: must be an object';
  const requirement = line.requirement;
  if (
    typeof requirement.text !== 'string' ||
    requirement.text.trim() === '' ||
    requirement.text.length > MAX_REQUIREMENT_TEXT_LENGTH
  ) {
    return `quoteRequest.lines[].requirement.text: must be 1 to ${MAX_REQUIREMENT_TEXT_LENGTH} characters`;
  }
  // Bidi and control characters would let a need read differently than it is.
  // eslint-disable-next-line no-control-regex -- control and bidi characters are the refusal
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(requirement.text)) {
    return 'quoteRequest.lines[].requirement.text: must not contain control or bidi characters';
  }
  if (requirement.category_id !== undefined) {
    const err = validateId(requirement.category_id, 'quoteRequest.lines[].requirement.category_id');
    if (err) return err;
  }
  for (const key of Object.keys(requirement)) {
    if (key !== 'text' && key !== 'category_id') {
      return `quoteRequest.lines[].requirement: unexpected field "${key}"`;
    }
  }
  if (line.acceptable_substitutions !== 'supplier_may_propose') {
    return 'quoteRequest.lines[].requirement: needs acceptable_substitutions "supplier_may_propose"';
  }
  const product = line.product as ProductRef;
  if (product.scheme !== 'custom' || product.issuer_did !== buyerDid) {
    return 'quoteRequest.lines[].requirement: the line product must be a custom placeholder issued by the buyer';
  }
  return null;
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

/**
 * Another version of the same quote (COMMITMENT_KERNEL §6, §15 step 6): the
 * same lines at the same prices, delivered on another date for other
 * charges — "₹X any day; ₹40 less shipping if delivery is on day Z". The
 * buyer's order takes at most one version, named by `alternative_id`; the
 * quote's own fields are the version taken when none is named. Its own total
 * and terms digest are what an order taking it approves. From protocol minor
 * 1.3.
 */
export interface QuoteAlternative {
  alternative_id: string;
  charges: Charge[];
  estimated_delivery_at: string;
  total: Money;
  terms_digest: string;
  /**
   * From minor 1.4: this version rests on a firm option from one of the
   * supplier's shippers (COMMITMENT_KERNEL §6). An order must name it before
   * `offer_ends_at`; if the shipper's run is lost after binding, the quote's
   * own terms (standard shipping) apply — the fallback. Both or neither.
   */
  partner_run?: true;
  offer_ends_at?: string;
  /**
   * From minor 1.5, only on a partner-run version, and only when the request
   * asked for it (COMMITMENT_KERNEL §15 step 12): if the run falls through
   * after binding, the buyer may cancel without charge instead of taking the
   * quote's own terms. Part of this version's `terms_digest`, so an order
   * that names the version holds the right.
   */
  exit_if_run_fails?: true;
}

/** At most this many alternatives beside the quote's own terms. */
export const MAX_QUOTE_ALTERNATIVES = 3;

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
  /** Other versions the buyer may take instead (sorted by id, unique). From minor 1.3. */
  alternatives?: QuoteAlternative[];
  terms_digest: string;
  quote_digest: string;
}

/**
 * The version an order takes: the quote's own total and terms, or those of
 * the alternative it names. Null when the quote has no such alternative.
 */
export function quoteVersion(
  quote: SignedQuote,
  alternativeId?: string,
): { total: Money; terms_digest: string; charges: Charge[]; estimated_delivery_at?: string } | null {
  if (alternativeId === undefined)
    return {
      total: quote.total,
      terms_digest: quote.terms_digest,
      charges: quote.charges,
      ...(quote.estimated_delivery_at !== undefined
        ? { estimated_delivery_at: quote.estimated_delivery_at }
        : {}),
    };
  const alt = (quote.alternatives ?? []).find((a) => a.alternative_id === alternativeId);
  return alt === undefined
    ? null
    : {
        total: alt.total,
        terms_digest: alt.terms_digest,
        charges: alt.charges,
        estimated_delivery_at: alt.estimated_delivery_at,
      };
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
  /** A version's exit right (1.5); absent from every digest made without one. */
  exit_if_run_fails?: true;
}): Record<string, unknown> {
  return {
    charges: quote.charges,
    estimated_dispatch_at: quote.estimated_dispatch_at,
    estimated_delivery_at: quote.estimated_delivery_at,
    payment_terms: quote.payment_terms,
    valid_until: quote.valid_until,
    ...(quote.exit_if_run_fails === true ? { exit_if_run_fails: true } : {}),
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

  if (quote.alternatives !== undefined) {
    const err = validateQuoteAlternatives(quote, currency, subtotals, sha256);
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

const ALTERNATIVE_ID = /^[a-z][a-z0-9_]{0,15}$/;

/**
 * Each alternative: an id (sorted, unique), a delivery date, charges, and a
 * total that is the quote's line subtotals with ITS charges (§9.1), and a
 * terms digest over the quote's terms with its charges and delivery date.
 */
function validateQuoteAlternatives(
  quote: Record<string, unknown>,
  currency: string,
  subtotals: Money[],
  sha256: Sha256Fn,
): string | null {
  const minor = Number(String(quote.protocol_version).split('.')[1] ?? '0');
  if (!Number.isFinite(minor) || minor < 3) {
    return 'quote.alternatives: requires protocol minor >= 1.3';
  }
  const alternatives = quote.alternatives;
  if (!Array.isArray(alternatives) || alternatives.length === 0) {
    return 'quote.alternatives: must be a non-empty array when present';
  }
  if (alternatives.length > MAX_QUOTE_ALTERNATIVES) {
    return `quote.alternatives: exceeds ${MAX_QUOTE_ALTERNATIVES}`;
  }
  let previous = '';
  for (const [i, raw] of alternatives.entries()) {
    const path = `quote.alternatives[${String(i)}]`;
    if (!isRecord(raw)) return `${path}: must be an object`;
    const keys = Object.keys(raw).sort().join(',');
    const exitRight =
      keys ===
      'alternative_id,charges,estimated_delivery_at,exit_if_run_fails,offer_ends_at,partner_run,terms_digest,total';
    const partnerRun =
      exitRight ||
      keys === 'alternative_id,charges,estimated_delivery_at,offer_ends_at,partner_run,terms_digest,total';
    if (keys !== 'alternative_id,charges,estimated_delivery_at,terms_digest,total' && !partnerRun) {
      return `${path}: exactly alternative_id, charges, estimated_delivery_at, total, terms_digest (and from 1.4, partner_run with offer_ends_at; from 1.5, exit_if_run_fails with them)`;
    }
    if (exitRight) {
      if (minor < 5) return `${path}.exit_if_run_fails: requires protocol minor >= 1.5`;
      if (raw.exit_if_run_fails !== true) return `${path}.exit_if_run_fails: true`;
    }
    if (partnerRun) {
      if (minor < 4) return `${path}.partner_run: requires protocol minor >= 1.4`;
      if (raw.partner_run !== true) return `${path}.partner_run: true`;
      const endsErr = validateIsoUtc(raw.offer_ends_at, `${path}.offer_ends_at`);
      if (endsErr) return endsErr;
      const ends = Date.parse(raw.offer_ends_at as string);
      if (
        ends <= Date.parse(String(quote.issued_at)) ||
        ends > Date.parse(String(quote.valid_until))
      ) {
        return `${path}.offer_ends_at: after the quote is issued, and no later than valid_until`;
      }
    }
    if (typeof raw.alternative_id !== 'string' || !ALTERNATIVE_ID.test(raw.alternative_id)) {
      return `${path}.alternative_id: lowercase id`;
    }
    if (raw.alternative_id <= previous) return `${path}.alternative_id: sorted and unique`;
    previous = raw.alternative_id;
    const dateErr = validateIsoUtc(raw.estimated_delivery_at, `${path}.estimated_delivery_at`);
    if (dateErr) return dateErr;
    if (!Array.isArray(raw.charges) || raw.charges.length > MAX_CHARGES) {
      return `${path}.charges: an array of at most ${MAX_CHARGES}`;
    }
    for (const charge of raw.charges) {
      const err = validateCharge(charge);
      if (err) return `${path}.${err}`;
    }
    const moneyErr = validateMoney(raw.total);
    if (moneyErr) return `${path}.${moneyErr}`;
    const total = raw.total as Money;
    if (total.currency !== currency) return `${path}.total: currency differs from the quote`;
    const recomputed = computeTotal(currency, subtotals, raw.charges as Charge[]);
    if (recomputed.error) return `${path}.total: ${recomputed.error}`;
    if (recomputed.value?.minor_units !== total.minor_units) {
      return `${path}.total: does not equal the §9.1 recomputation`;
    }
    const expected = commerceRecordDigest(
      'terms',
      termsDigestInput({
        ...(quote as unknown as SignedQuote),
        charges: raw.charges as Charge[],
        estimated_delivery_at: raw.estimated_delivery_at as string,
        ...(raw.exit_if_run_fails === true ? { exit_if_run_fails: true as const } : {}),
      }),
      sha256,
    );
    if (raw.terms_digest !== expected) {
      return `${path}.terms_digest: does not match its terms`;
    }
  }
  return null;
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

    // NEGOTIATION_PLAN §4.6 — a requirement line names the buyer's own
    // placeholder, which is not goods. An answer must offer a real product.
    if (source.requirement !== undefined && sameProduct(line.offered_product, source.product)) {
      return `quote.lines[${line.line_id}]: answers a requirement with the buyer's placeholder, not a product`;
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
