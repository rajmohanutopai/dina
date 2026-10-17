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
  MAX_TRADE_REASON_CODE_LENGTH,
  termsDigestInput,
  validateQuoteRequest,
  validateSignedQuote,
  productRefsEqual,
  projectionPincode,
  type Money,
  type ProductRef,
  type Quantity,
  type Sha256Fn,
  type SignedQuote,
  type SignedQuoteLine,
  type QuoteRequest,
  computeTotal,
  type Charge,
  type QuoteAlternative,
} from '@dina/commerce-protocol';

import { appendAudit } from '../audit/service';
import { openSmallerDeals } from '../commitment/option_handler';
import { ownerTimeZoneIfRead } from '../settings/owner_settings';

import { authorQuoteDecline, rehydrateDeclineDocument } from './decline_documents';
import { costLedAlternatives } from './goods_seller_alternatives';
import { publishedCatalogItems } from './published_catalog';
import {
  approvedPricesOf,
  atOrAboveFloor,
  checkRunnerTerms,
  type RunnerBoundsRefusal,
} from './runner_bounds';
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
  | 'registration_refused'
  /** COMMITMENT_KERNEL §15 step 10: the runner's terms broke the owner's floors or rules. */
  | RunnerBoundsRefusal;

export type QuoteIssuanceOutcome =
  /** Core signed it; this JSON replaces the runner's answer on the wire. */
  | { kind: 'signed'; quoteJson: string }
  /**
   * The runner declined the business. A decline is an ANSWER, not a fault, and
   * refusing here would turn "we are not quoting this" into silence, which
   * reads to a buyer exactly like a supplier that never replied. It is ALSO a
   * document: Core seals the runner's refusal into a `QuoteDecline` (§3.4),
   * retains it in the kernel decline store, and this JSON — `{ decline }`, the
   * shape the buyer's quote-lane ingress reads — replaces the runner's answer
   * on the wire. The runner's own words would arrive unverifiable and be
   * dropped as unreadable; a repeated request replays the retained decline.
   */
  | { kind: 'declined'; declineJson: string }
  | { kind: 'withhold'; refusal: QuoteIssuanceRefusal };

interface RunnerLine {
  line_id: string;
  unit_price: Money;
  quantity: Quantity;
  /** NEGOTIATION_PLAN §4.6 — the runner's own item, for a line that allows it. */
  offered_product?: ProductRef;
  substitution_evidence?: string[];
}

const MAX_EVIDENCE_ENTRIES = 5;
const MAX_EVIDENCE_LENGTH = 200;

/** The runner's terms, as far as this module is willing to believe them. */
function readRunnerTerms(
  json: string,
): {
  canSupply: boolean;
  lines: RunnerLine[];
  /** The runner's stated reason when it declines (free text, bounded on seal). */
  declineReason?: string;
  validUntil?: string;
  maxUses?: string;
  paymentTerms?: Record<string, unknown>;
  /** The runner's own charges (delivery and the like) and delivery estimate. */
  charges?: Charge[];
  estimatedDeliveryAt?: string;
  /** Other versions: the same lines, delivered on another date for other charges. */
  alternatives?: { alternative_id: string; charges: Charge[]; estimated_delivery_at: string }[];
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.can_supply !== 'boolean') return null;
  if (!record.can_supply) {
    return {
      canSupply: false,
      lines: [],
      ...(typeof record.decline_reason === 'string' && record.decline_reason.trim() !== ''
        ? { declineReason: record.decline_reason.trim() }
        : {}),
    };
  }
  if (!Array.isArray(record.lines)) return null;
  // Fields the runner states must be well formed: one that is present and
  // malformed refuses the terms, never silently drops (COMMITMENT_KERNEL §6).
  if (record.charges !== undefined && !Array.isArray(record.charges)) return null;
  if (record.estimated_delivery_at !== undefined && typeof record.estimated_delivery_at !== 'string')
    return null;
  if (record.alternatives !== undefined) {
    if (!Array.isArray(record.alternatives)) return null;
    for (const alt of record.alternatives as unknown[]) {
      if (alt === null || typeof alt !== 'object' || Array.isArray(alt)) return null;
      const a = alt as Record<string, unknown>;
      if (
        Object.keys(a).sort().join(',') !== 'alternative_id,charges,estimated_delivery_at' ||
        typeof a.alternative_id !== 'string' ||
        !Array.isArray(a.charges) ||
        typeof a.estimated_delivery_at !== 'string'
      )
        return null;
    }
  }
  const lines: RunnerLine[] = [];
  for (const entry of record.lines) {
    if (entry === null || typeof entry !== 'object') return null;
    const line = entry as Record<string, unknown>;
    if (typeof line.line_id !== 'string' || line.line_id === '') return null;
    if (line.unit_price === null || typeof line.unit_price !== 'object') return null;
    if (line.quantity === null || typeof line.quantity !== 'object') return null;
    const evidence = line.substitution_evidence;
    lines.push({
      line_id: line.line_id,
      unit_price: line.unit_price as Money,
      quantity: line.quantity as Quantity,
      ...(line.offered_product !== undefined && line.offered_product !== null
        ? { offered_product: line.offered_product as ProductRef }
        : {}),
      ...(Array.isArray(evidence) ? { substitution_evidence: evidence as string[] } : {}),
    });
  }
  return {
    canSupply: true,
    lines,
    ...(typeof record.valid_until === 'string' ? { validUntil: record.valid_until } : {}),
    ...(typeof record.max_uses === 'string' ? { maxUses: record.max_uses } : {}),
    // §4.5 — credit terms are the supplier's commercial policy, so the
    // runner states them; `validateSignedQuote` below re-checks the
    // shape AND the minor-version gate, so a malformed or 1.0-dialect
    // terms object withholds the quote rather than shipping it.
    ...(record.payment_terms !== null &&
    typeof record.payment_terms === 'object' &&
    !Array.isArray(record.payment_terms)
      ? { paymentTerms: record.payment_terms as Record<string, unknown> }
      : {}),
    // COMMITMENT_KERNEL §6, §15 step 6 — charges, a delivery estimate and
    // alternatives are the runner's to state. Read as given, never trimmed:
    // a malformed field refuses the terms (above), and `validateSignedQuote`
    // re-checks every value that remains.
    ...(record.charges !== undefined ? { charges: record.charges as Charge[] } : {}),
    ...(record.estimated_delivery_at !== undefined
      ? { estimatedDeliveryAt: record.estimated_delivery_at as string }
      : {}),
    ...(record.alternatives !== undefined
      ? {
          alternatives: record.alternatives as {
            alternative_id: string;
            charges: Charge[];
            estimated_delivery_at: string;
          }[],
        }
      : {}),
  };
}

/**
 * The quote's alternatives, priced by Core from the quote's own line
 * subtotals: each one's total and terms digest are computed here, never taken
 * from the runner. Offered only to a buyer who asked at minor 1.3 or later
 * (§9.13: answered in the buyer's language); otherwise none.
 */
export function priceQuoteAlternatives(
  draft: Omit<SignedQuote, 'terms_digest' | 'quote_digest' | 'alternatives'>,
  alternatives: readonly {
    alternative_id: string;
    charges: Charge[];
    estimated_delivery_at: string;
    /** A version resting on a shipper's option (minor 1.4): kept as given. */
    partner_run?: true;
    offer_ends_at?: string;
    /** Its exit right (minor 1.5, only with `partner_run`): part of its terms digest. */
    exit_if_run_fails?: true;
  }[],
): QuoteAlternative[] | null {
  const minor = Number(String(draft.protocol_version).split('.')[1] ?? '0');
  if (alternatives.length === 0 || !Number.isFinite(minor) || minor < 3) return [];
  const subtotals = draft.lines.map((l) => l.line_subtotal);
  const out: QuoteAlternative[] = [];
  for (const alt of [...alternatives].sort((a, b) => (a.alternative_id < b.alternative_id ? -1 : 1))) {
    const total = computeTotal(draft.total.currency, subtotals, alt.charges);
    if (total.error || !total.value) return null;
    out.push({
      alternative_id: alt.alternative_id,
      charges: alt.charges,
      estimated_delivery_at: alt.estimated_delivery_at,
      total: total.value,
      terms_digest: commerceRecordDigest(
        'terms',
        termsDigestInput({
          ...draft,
          charges: alt.charges,
          estimated_delivery_at: alt.estimated_delivery_at,
          ...(exitRight(alt) ? { exit_if_run_fails: true as const } : {}),
        }),
        hash,
      ),
      ...(alt.partner_run === true && alt.offer_ends_at !== undefined
        ? { partner_run: true as const, offer_ends_at: alt.offer_ends_at }
        : {}),
      ...(exitRight(alt) ? { exit_if_run_fails: true as const } : {}),
    });
  }
  return out;
}

/** A version's exit right stands only on a partner-run version (§15 step 12). */
function exitRight(alt: { partner_run?: true; offer_ends_at?: string; exit_if_run_fails?: true }): boolean {
  return alt.exit_if_run_fails === true && alt.partner_run === true && alt.offer_ends_at !== undefined;
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
  if (!terms.canSupply) {
    return sealDecline(request, terms.declineReason, supplierDid, args.nowMs, runtime);
  }
  // ONE answer per request, whichever came first. A request this node already
  // DECLINED is not quoted on a retry, even if the runner has changed its mind:
  // the buyer's tender holds the decline, and a quote it never sees would be
  // capacity nobody can spend. Replay the retained decline instead.
  if (runtime.declineDocuments.answersTo(request.request_digest).length > 0) {
    return sealDecline(request, undefined, supplierDid, args.nowMs, runtime);
  }

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
    // §9.8 / NEGOTIATION_PLAN §4.6 — what was asked for is what is offered,
    // unless the buyer allowed a substitute AND the runner names an item of
    // THIS supplier's live published catalogue with evidence. A runner cannot
    // invent a product, and cannot substitute where the buyer said `none`.
    const offered = substitutedProduct(requested, offer, runtime);
    if (offered === 'refused') return { kind: 'withhold', refusal: 'terms_unusable' };
    lines.push({
      line_id: requested.line_id,
      requested_product: requested.product,
      ...(offered === null
        ? { offered_product: requested.product }
        : { offered_product: offered.product, substitution_evidence: offered.evidence }),
      quantity: offer.quantity,
      price_basis: priceBasis,
      unit_price: offer.unit_price,
      line_subtotal: subtotal.value,
      stock_status: 'available',
    });
  }

  const charges = terms.charges ?? [];
  const subtotalsTotal = sumLineSubtotals(lines);
  if (subtotalsTotal === null) return { kind: 'withhold', refusal: 'terms_unusable' };
  const withCharges = computeTotal(
    subtotalsTotal.currency,
    lines.map((l) => l.line_subtotal),
    charges,
  );
  if (withCharges.error || !withCharges.value) return { kind: 'withhold', refusal: 'terms_unusable' };
  const total = withCharges.value;

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
    charges,
    total,
    ...(terms.estimatedDeliveryAt === undefined
      ? {}
      : { estimated_delivery_at: terms.estimatedDeliveryAt }),
    issued_at: issuedAt,
    valid_until: validUntil,
    supplier_epoch: supplierEpoch,
    ...(terms.maxUses === undefined ? {} : { max_uses: terms.maxUses }),
    ...(terms.paymentTerms === undefined ? {} : { payment_terms: terms.paymentTerms }),
  };
  // The runner's own alternatives, or, when it states none, the days the
  // seller's own costs make cheaper (COMMITMENT_KERNEL §15 step 6). Those are
  // offered only from the whole model: none while a persona holding the
  // seller's entries is closed (a sealed never-rule may forbid a day), and
  // none before the owner's time zone is known (the day is the owner's day).
  const pricedDraft = draft as unknown as Omit<
    SignedQuote,
    'terms_digest' | 'quote_digest' | 'alternatives'
  >;
  let alternatives: QuoteAlternative[] | null;
  let madeUp = false;
  if (terms.alternatives !== undefined) {
    alternatives = priceQuoteAlternatives(pricedDraft, terms.alternatives);
    if (alternatives === null) return { kind: 'withhold', refusal: 'terms_unusable' };
  } else {
    const seller = runtime.goodsSellerModel?.() ?? null;
    const zone = ownerTimeZoneIfRead();
    const offered =
      seller === null || seller.closedPersonas.length > 0 || zone === null
        ? []
        : costLedAlternatives({
            model: seller.model,
            deliveryAt: terms.estimatedDeliveryAt,
            charges,
            currency: total.currency,
            totalMinor: BigInt(total.minor_units),
            nowMs: args.nowMs,
            timeZone: zone,
            ...shareArg(runtime.goodsSellerShareBps?.()),
          });
    // A cheaper day Core made up never costs the buyer the quote itself.
    alternatives = priceQuoteAlternatives(pricedDraft, offered) ?? [];
    madeUp = alternatives.length > 0;
  }
  // COMMITMENT_KERNEL §10, §15 step 10 — the runner's prices bind once a
  // buyer orders, so they pass the floors a counter passes, measured from
  // what the owner approved, and every version the runner stated passes the
  // seller's never-rules. Core's own cheaper days were judged against the
  // never-rules where made; here they are kept only while they leave the
  // goods at or above their floors.
  const bounds = checkRunnerTerms({
    approved: approvedPricesOf(runtime),
    lines: lines.map((line) => ({
      line_id: line.line_id,
      product: line.offered_product,
      unit_price: line.unit_price,
      quantity: line.quantity,
      price_basis: line.price_basis,
    })),
    versions: [
      {
        ...(terms.estimatedDeliveryAt === undefined
          ? {}
          : { estimatedDeliveryAt: terms.estimatedDeliveryAt }),
        total,
      },
      ...(madeUp
        ? []
        : alternatives.map((alt) => ({
            estimatedDeliveryAt: alt.estimated_delivery_at,
            total: alt.total,
          }))),
    ],
    seller: runtime.goodsSellerModel?.() ?? null,
    timeZone: ownerTimeZoneIfRead(),
  });
  if (!bounds.ok) {
    appendAudit('negotiation', 'runner_quote_withheld', quoteId, `reason=${bounds.refusal}`);
    return { kind: 'withhold', refusal: bounds.refusal };
  }
  if (madeUp) {
    alternatives = atOrAboveFloor(alternatives, bounds.floorGoodsMinor);
    madeUp = alternatives.length > 0;
  }
  const terms_digest = commerceRecordDigest('terms', termsDigestInput(draft), hash);
  const assemble = (alts: readonly QuoteAlternative[]): SignedQuote => {
    const withTerms = {
      ...draft,
      ...(alts.length > 0 ? { alternatives: [...alts] } : {}),
      terms_digest,
    };
    const assembled: SignedQuote = {
      ...withTerms,
      quote_digest: commerceRecordDigest('quote', withTerms as unknown as Record<string, unknown>, hash),
    };
    return assembled;
  };
  let quote = assemble(alternatives);

  // Core validates its OWN output before it can be registered or sent. An
  // invalid quote registered here would be a live family the buyer cannot
  // accept — decided on this side, unusable on theirs, and unreconcilable.
  // Cheaper days Core made up that break the quote (one charge too many) are
  // dropped and the quote checked again: they never cost the buyer the quote.
  if (validateSignedQuote(quote, hash) !== null && madeUp) quote = assemble([]);
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

  // COMMITMENT_KERNEL §6 step 0, §15 step 7: with the buyer's grant, ask this
  // seller's known shippers for a firm run on the delivery day. Only the
  // pincode leaves, and only under the grant; a held option becomes a
  // version in the next revision. Off this path: the quote is already out.
  const postalCode = projectionPincode(request.delivery.projection);
  if (
    request.onward_sharing !== undefined &&
    postalCode !== undefined &&
    quote.estimated_delivery_at !== undefined
  ) {
    void openSmallerDeals({
      dealRef: quote.quote_id,
      grant: {
        fields: request.onward_sharing.fields,
        recipientRole: request.onward_sharing.recipient_role,
      },
      postalCode,
      serviceAt: quote.estimated_delivery_at,
      crates: 1,
      nowMs: args.nowMs,
    }).catch(() => undefined);
  }

  return { kind: 'signed', quoteJson: JSON.stringify(quote) };
}

/**
 * The runner's substitute for a line, when it names one: allowed only where
 * the buyer allowed it, only for an item this supplier publishes, and only
 * with bounded evidence. `null` means no substitution was proposed.
 */
function substitutedProduct(
  requested: QuoteRequest['lines'][number],
  offer: RunnerLine,
  runtime: NonNullable<ReturnType<typeof getCommerceRuntime>>,
): { product: ProductRef; evidence: string[] } | null | 'refused' {
  if (offer.offered_product === undefined) {
    // A requirement line has only a placeholder; offering it would sell nothing.
    return requested.requirement === undefined ? null : 'refused';
  }
  if (productRefsEqual(offer.offered_product, requested.product)) {
    // The same rule when the runner NAMES the placeholder: a need is answered
    // with a real item of this catalogue, never with the buyer's stand-in.
    return requested.requirement === undefined ? null : 'refused';
  }
  if ((requested.acceptable_substitutions ?? 'none') === 'none') return 'refused';
  const evidence = offer.substitution_evidence;
  if (
    evidence === undefined ||
    evidence.length === 0 ||
    evidence.length > MAX_EVIDENCE_ENTRIES ||
    evidence.some((e) => typeof e !== 'string' || e === '' || e.length > MAX_EVIDENCE_LENGTH)
  ) {
    return 'refused';
  }
  const published = publishedCatalogItems(runtime).some((item) =>
    productRefsEqual(item.product, offer.offered_product as ProductRef),
  );
  if (!published) return 'refused';
  return { product: offer.offered_product, evidence };
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

/** `reason_code` is bounded on the wire; a runner's free text is trimmed to fit. */
const DECLINE_REASON_FALLBACK = 'declined';

/**
 * Trim to the wire bound (counted in UTF-16 units, as the validator counts)
 * without leaving a lone high surrogate at the cut; an empty result falls
 * back so the document always carries a reason.
 */
function trimReasonCode(reason: string): string {
  let trimmed = reason.slice(0, MAX_TRADE_REASON_CODE_LENGTH);
  if (/[\uD800-\uDBFF]$/.test(trimmed)) trimmed = trimmed.slice(0, -1);
  return trimmed === '' ? DECLINE_REASON_FALLBACK : trimmed;
}

/**
 * Seal the runner's refusal as a `QuoteDecline` on the money-free decline slice
 * (§5.B1) and hand back the wire JSON the buyer's quote-lane ingress reads. A
 * repeated request (the buyer retrying, the transport redelivering) replays the
 * retained decline — the same discipline the signed quote follows above — so a
 * decline is never re-minted with a second digest.
 */
function sealDecline(
  request: QuoteRequest,
  reason: string | undefined,
  supplierDid: string,
  nowMs: number,
  runtime: NonNullable<ReturnType<typeof getCommerceRuntime>>,
): QuoteIssuanceOutcome {
  const held = runtime.declineDocuments.answersTo(request.request_digest)[0];
  if (held !== undefined) {
    const read = rehydrateDeclineDocument(held);
    return { kind: 'declined', declineJson: JSON.stringify({ decline: read }) };
  }
  const reasonCode = trimReasonCode(reason ?? DECLINE_REASON_FALLBACK);
  const authored = authorQuoteDecline({
    request,
    reasonCode,
    nodeDid: supplierDid,
    nowMs,
    repository: runtime.declineDocuments,
  });
  if (!authored.ok) return { kind: 'withhold', refusal: 'registration_refused' };
  return { kind: 'declined', declineJson: JSON.stringify({ decline: authored.document }) };
}

/** Brain's standing share for an alternative's arguments, when there is one. */
function shareArg(bps: number | undefined): { brainShareBps?: number } {
  return bps === undefined ? {} : { brainShareBps: bps };
}
