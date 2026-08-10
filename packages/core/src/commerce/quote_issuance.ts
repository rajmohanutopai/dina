/**
 * §9.8 / §9.12 — where a quote is BORN.
 *
 * THIS SEAM DID NOT EXIST, and its absence took the whole supplier trade lane
 * with it. A cold audit found that nothing in production ever built a
 * `SignedQuote`: `commerceRecordDigest('quote', …)` appeared only in test
 * helpers, `registerSignedQuote` had no non-test caller, and `request_quote`
 * fell through `transformInboundOrderResult` to `passthrough` — so a runner's
 * unsigned terms went to the buyer raw, wearing no signature and holding no
 * capacity.
 *
 * The consequence compounded past the quote. `admitInTx` loads the quote
 * family for an inbound order and rejects `quote_unknown` when there is none,
 * and it also demands a retained `request`-domain receipt as the yardstick for
 * the §9.9 projection-extends check — and nothing wrote that receipt either.
 * So on a real node every inbound order was refused, and the supplier could
 * not trade at all.
 *
 * The journey suites did not catch it because they call
 * `admission.registerSignedQuote(quote)` themselves before ordering. They
 * proved the engines agree with one another; they could not prove a quote can
 * be issued, because they supplied the step that was missing.
 *
 * WHAT CORE OWNS HERE, and why the split is where it is (§9.12). The runner
 * makes the COMMERCIAL decision — will we supply, at what unit price, in what
 * quantity — because that is its business and Core has no view on it. Core
 * makes the RECORD: it validates the buyer's request, binds the quote to that
 * request and to the delivery projection the buyer priced against, composes
 * the canonical line arithmetic, stamps its own epoch, and registers the
 * family so the use counter exists before anyone can spend it. A runner that
 * returned a `SignedQuote` would be claiming an authority it does not hold —
 * no key, no ledger, no view of capacity.
 *
 * THE AUDIENCE IS THE AUTHENTICATED SENDER, never a field in the request. The
 * buyer named in the body is a claim; the DID the transport authenticated is a
 * fact. They are compared, and a disagreement is refused rather than
 * reconciled — a supplier that priced for whoever asked would let any peer
 * obtain a quote addressed to someone else.
 */

import { sha256 } from '@noble/hashes/sha2.js';

import {
  commerceRecordDigest,
  computeLineSubtotal,
  termsDigestInput,
  validateQuoteRequest,
  validateSignedQuote,
  type Money,
  type Quantity,
  type Sha256Fn,
  type SignedQuote,
  type SignedQuoteLine,
  type QuoteRequest,
} from '@dina/commerce-protocol';

import { getCommerceRuntime } from './runtime';

const hash: Sha256Fn = (data) => sha256(data);

/** How long a quote stands when the runner names no expiry. */
const DEFAULT_QUOTE_VALIDITY_MS = 24 * 60 * 60 * 1000;

export type QuoteIssuanceRefusal =
  /** No commerce runtime, or it cannot sign right now. */
  | 'commerce_unavailable'
  /** The buyer's request is not a valid `QuoteRequest`. */
  | 'request_invalid'
  /** The request names a buyer other than the authenticated sender. */
  | 'request_not_yours'
  /** The request is addressed to a different supplier. */
  | 'not_our_request'
  /** The runner's answer is unreadable, or names lines the request did not. */
  | 'terms_unusable'
  /** Core composed a quote its own validator refused. */
  | 'quote_invalid'
  /** The ledger refused to register the family (§9.8). */
  | 'registration_refused';

export type QuoteIssuanceOutcome =
  /** Core signed it; this JSON replaces the runner's answer on the wire. */
  | { kind: 'signed'; quoteJson: string }
  /**
   * The runner declined the business. A decline is an ANSWER, not a fault:
   * there is no record to sign and nothing for Core to improve on, so the
   * runner's own words travel unchanged. Refusing here instead would turn "we
   * are not quoting this" into silence, which reads to a buyer exactly like a
   * supplier that never replied.
   */
  | { kind: 'declined' }
  | { kind: 'withhold'; refusal: QuoteIssuanceRefusal };

interface RunnerLine {
  line_id: string;
  unit_price: Money;
  quantity: Quantity;
}

/** The runner's terms, as far as this module is willing to believe them. */
function readRunnerTerms(
  json: string,
): { canSupply: boolean; lines: RunnerLine[]; validUntil?: string; maxUses?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.can_supply !== 'boolean') return null;
  if (!record.can_supply) return { canSupply: false, lines: [] };
  if (!Array.isArray(record.lines)) return null;
  const lines: RunnerLine[] = [];
  for (const entry of record.lines) {
    if (entry === null || typeof entry !== 'object') return null;
    const line = entry as Record<string, unknown>;
    if (typeof line.line_id !== 'string' || line.line_id === '') return null;
    if (line.unit_price === null || typeof line.unit_price !== 'object') return null;
    if (line.quantity === null || typeof line.quantity !== 'object') return null;
    lines.push({
      line_id: line.line_id,
      unit_price: line.unit_price as Money,
      quantity: line.quantity as Quantity,
    });
  }
  return {
    canSupply: true,
    lines,
    ...(typeof record.valid_until === 'string' ? { validUntil: record.valid_until } : {}),
    ...(typeof record.max_uses === 'string' ? { maxUses: record.max_uses } : {}),
  };
}

/**
 * Deterministic quote id, derived from the request it answers.
 *
 * A replayed `request_quote` therefore composes the SAME identity rather than
 * a second family for one question, which is what lets registration collapse
 * a duplicate instead of minting a rival quote the buyer could also spend.
 * Bounded well inside `MAX_ID_LENGTH`.
 */
function quoteIdFor(requestDigest: string): string {
  return `q:${requestDigest.slice(0, 32)}`;
}

/**
 * Compose and register the quote answering one `request_quote` query.
 *
 * Returns what should go on the wire. Every refusal writes nothing: a quote
 * that could not register must never reach a buyer, because a buyer that holds
 * a quote this node cannot honour is worse off than one that got no answer.
 */
export function settleInboundQuote(args: {
  /** TRANSPORT-authenticated sender. Never a field from the body. */
  buyerDid: string;
  /** The `request_quote` params — a `QuoteRequest` the buyer sent. */
  request: unknown;
  /** The runner's unsigned terms. */
  runnerResultJson: string;
  nowMs: number;
}): QuoteIssuanceOutcome {
  const runtime = getCommerceRuntime();
  if (runtime === null) return { kind: 'withhold', refusal: 'commerce_unavailable' };

  // §16.2 — `currentEpoch()` THROWS until an epoch record has been published,
  // and that is the contract, not a defect: a node that signed at a guessed
  // epoch would produce records no restore fence can place. Read it first, so
  // the refusal happens before any work and before anything is written.
  let supplierEpoch: string;
  let supplierDid: string;
  try {
    supplierEpoch = runtime.currentEpoch();
    supplierDid = runtime.nodeDid();
  } catch {
    return { kind: 'withhold', refusal: 'commerce_unavailable' };
  }

  const invalid = validateQuoteRequest(args.request, hash);
  if (invalid !== null) return { kind: 'withhold', refusal: 'request_invalid' };
  const request = args.request as QuoteRequest;

  // The body's `buyer_did` is a claim; the authenticated DID is the fact.
  if (request.buyer_did !== args.buyerDid) {
    return { kind: 'withhold', refusal: 'request_not_yours' };
  }
  if (request.supplier_did !== supplierDid) {
    return { kind: 'withhold', refusal: 'not_our_request' };
  }

  // §9.9's REPLAY DISCIPLINE, applied to quoting. A repeated `request_quote`
  // — a buyer retrying after a dropped response, or the transport redelivering
  // — must receive the quote already issued, not a refusal and not a rival.
  //
  // Refusing was the first behaviour and it was wrong in a quiet way: the
  // family already existed, so registration answered "duplicate" and the buyer
  // got `registration_refused` for a question this node had in fact already
  // answered. The buyer then has a request it cannot get a price for and no
  // way to learn one exists.
  //
  // Safe to serve without re-checking the audience, because the audience is
  // already inside the key: `request_digest` covers `buyer_did`, and the
  // authenticated sender was compared against it above. A different buyer
  // cannot produce this digest.
  const quoteId = quoteIdFor(request.request_digest);
  const existing = runtime.families.load(quoteId);
  if (existing !== null) {
    const retained = runtime.receipts.get(existing.headDigest);
    if (retained !== null) return { kind: 'signed', quoteJson: retained.recordJson };
    // The family exists but its head record is gone. Refusing is the only
    // honest answer: re-composing would sign a second document for a head this
    // node can no longer show, and the two could differ.
    return { kind: 'withhold', refusal: 'registration_refused' };
  }

  const terms = readRunnerTerms(args.runnerResultJson);
  if (terms === null) return { kind: 'withhold', refusal: 'terms_unusable' };
  if (!terms.canSupply) return { kind: 'declined' };

  // EVERY REQUESTED LINE, PRICED. A runner that answers a subset has not
  // quoted the request the buyer asked; returning a partial quote would let
  // the buyer accept terms for goods nobody committed to. The reverse — a
  // runner naming a line the request never had — is refused for the same
  // reason in the other direction.
  const priced = new Map(terms.lines.map((line) => [line.line_id, line]));
  if (priced.size !== request.lines.length) return { kind: 'withhold', refusal: 'terms_unusable' };
  const lines: SignedQuoteLine[] = [];
  for (const requested of request.lines) {
    const offer = priced.get(requested.line_id);
    if (offer === undefined) return { kind: 'withhold', refusal: 'terms_unusable' };
    // Price basis is ONE of the quantity's own unit. The reference result
    // schema carries no basis field, so inventing a different one here would
    // be Core deciding a commercial term; per-unit is the reading that cannot
    // silently change what the runner meant.
    const priceBasis: Quantity = { value: '1', unit_code: offer.quantity.unit_code };
    const subtotal = computeLineSubtotal(offer.unit_price, offer.quantity, priceBasis);
    if (subtotal.error || !subtotal.value) return { kind: 'withhold', refusal: 'terms_unusable' };
    lines.push({
      line_id: requested.line_id,
      requested_product: requested.product,
      // §9.8 — the runner's result schema declares no substitution, so what
      // was asked for is what is offered. When a substitution lane is added it
      // must carry `substitution_evidence` and honour the request's
      // `acceptable_substitutions`, which is why this is not a silent default
      // but a stated one.
      offered_product: requested.product,
      quantity: offer.quantity,
      price_basis: priceBasis,
      unit_price: offer.unit_price,
      line_subtotal: subtotal.value,
      stock_status: 'available',
    });
  }

  const total = sumLineSubtotals(lines);
  if (total === null) return { kind: 'withhold', refusal: 'terms_unusable' };

  const issuedAt = new Date(args.nowMs).toISOString();
  const validUntil = terms.validUntil ?? new Date(args.nowMs + DEFAULT_QUOTE_VALIDITY_MS).toISOString();
  const draft = {
    // §9.13 — answered in the language the buyer asked in.
    protocol_version: request.protocol_version,
    quote_id: quoteId,
    request_id: request.request_id,
    // §9.8 — the binding a buyer checks to know this answers ITS question.
    request_digest: request.request_digest,
    buyer_did: request.buyer_did,
    supplier_did: supplierDid,
    quote_revision: '1',
    // §9.8 — priced against the projection the buyer sent, not one this node
    // preferred. The buyer re-derives this and refuses a mismatch.
    priced_delivery_projection_digest: request.delivery.projection.projection_digest,
    lines,
    charges: [],
    total,
    issued_at: issuedAt,
    valid_until: validUntil,
    supplier_epoch: supplierEpoch,
    ...(terms.maxUses === undefined ? {} : { max_uses: terms.maxUses }),
  };
  const terms_digest = commerceRecordDigest('terms', termsDigestInput(draft), hash);
  const withTerms = { ...draft, terms_digest };
  const quote: SignedQuote = {
    ...withTerms,
    quote_digest: commerceRecordDigest('quote', withTerms as unknown as Record<string, unknown>, hash),
  };

  // Core validates its OWN output before it can be registered or sent. An
  // invalid quote registered here would be a live family the buyer cannot
  // accept — decided on this side, unusable on theirs, and unreconcilable.
  if (validateSignedQuote(quote, hash) !== null) {
    return { kind: 'withhold', refusal: 'quote_invalid' };
  }

  // ONE TRANSACTION for the retained request and the family. The request
  // receipt is the yardstick §9.9 measures a later order's projection
  // against; a family that existed without it would admit orders this node
  // cannot check, and a receipt without a family would be a promise to
  // nobody.
  const refused = runtime.admission.issueQuote({
    request,
    quote,
    expectedBuyerDid: args.buyerDid,
  });
  if (refused !== null) return { kind: 'withhold', refusal: 'registration_refused' };

  return { kind: 'signed', quoteJson: JSON.stringify(quote) };
}

/**
 * Add the line subtotals, refusing a currency mix rather than coercing one.
 *
 * `computeLineSubtotal` has already produced each line in its own currency;
 * a quote whose lines disagree has no single total, and picking one would be
 * inventing a commercial term.
 */
function sumLineSubtotals(lines: readonly SignedQuoteLine[]): Money | null {
  if (lines.length === 0) return null;
  const currency = lines[0].line_subtotal.currency;
  let minor = 0n;
  for (const line of lines) {
    if (line.line_subtotal.currency !== currency) return null;
    minor += BigInt(line.line_subtotal.minor_units);
  }
  return { currency, minor_units: minor.toString(10) };
}
