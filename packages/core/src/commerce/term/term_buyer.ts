/**
 * The buyer's side of term negotiation (SHELF_SPACE_NEGOTIATION §7.1, §8): a
 * brand asking a store for a resource.
 *
 * FIXED RULES, NO MODEL (NEGOTIATION_PLAN §4.5). The loop counters with the
 * owner's targets, stops when an offer meets every target, when rounds run
 * out, at the deadline, or when the seller stops moving — and then asks the
 * owner ONCE. Directions come from Core's term table, never from the offer,
 * so a seller cannot flip which way is a concession. Nothing binds until the
 * owner approves the proposal, with presence.
 */

import {
  sealTermRecord,
  termListingUri,
  termMeetsBuyerTarget,
  termsFromValues,
  termValues,
  TERM_NAMES,
  validateId,
  validateIsoUtc,
  validateTermListing,
  validateTermRequest,
  validateTermAgreementProposal,
  verifyTermOfferAgainstRequest,
  verifyTermOfferRevision,
  verifyTermProposalAgainstOffer,
  type AgreementDecision,
  type TermAgreementProposal,
  type TermAttributes,
  type TermCounter,
  type TermListing,
  type TermName,
  type TermOffer,
  type TermRequest,
  checkProtocolVersion,
} from '@dina/commerce-protocol';

import { validateAgainstSchema } from '../../plugins/schema_validate';
import {
  buildTermProposalApprovalPayload,
  TERM_PROPOSAL_AUTHORITY_DOMAIN,
  verifyApprovalBinding,
  type ApprovingPrincipal,
} from '../approval_payload';
import { termPackEntry } from '../first_party_packs';

import { termAgreementStatus } from './term_agreements';
import { hash, iso, mintId, TERM_TIMINGS, type TermContext } from './term_context';
import {
  buyerLimitsIn,
  buyerMoneyIn,
  validateTermBuyerPolicy,
  type TermBuyerPolicy,
} from './term_policy';
import {
  readTermApprovalMaterial,
  readTermBuyerPolicyJson,
  readTermCounterRow,
  readTermProposalRow,
  readTermRequestRow,
} from './term_rehydrate';
import { offerChain, type TermVerdict } from './term_seller';

import type { TermDocumentRow } from './term_store';

export const TERM_PROPOSAL_CARD = 'term_agreement_proposal';

// ---------------------------------------------------------------------------
// Starting (§7.1 step 1)
// ---------------------------------------------------------------------------

export type StartTermOutcome = { ok: true; request: TermRequest } | { ok: false; refusal: string };

/**
 * Ask a store for a resource. `listing` is the record fetched from AppView at
 * `listingUri`; it is re-validated here (its digest covers it), and the
 * request binds to it by URI and digest — the binding the store's first-
 * contact rule checks (§5.3).
 */
export function startTermNegotiation(
  ctx: TermContext,
  args: {
    listing: unknown;
    listingUri: string;
    tag: string;
    attributes: TermAttributes;
    start: string;
    end: string;
    policy: TermBuyerPolicy;
  },
): StartTermOutcome {
  const nowMs = ctx.now();
  const pack = ctx.deps.activePack('term_buyer');
  if (pack === null) return { ok: false, refusal: 'the Slot Pack (brand) is not active' };
  const listingError = validateTermListing(args.listing, hash);
  if (listingError !== null) return { ok: false, refusal: `listing: ${listingError}` };
  const listing = args.listing as TermListing;
  // The request takes the listing's version; one this build does not speak
  // would start a chain no reply of this node could carry (§9.13).
  if (checkProtocolVersion(listing.protocol_version) !== null)
    return {
      ok: false,
      refusal: `the listing is at protocol ${listing.protocol_version}, which this Dina does not speak`,
    };
  if (args.listingUri !== termListingUri(listing))
    return { ok: false, refusal: 'the listing is not the one at that address' };
  if (listing.seller_did === ctx.self())
    return { ok: false, refusal: 'a node does not rent from itself' };
  const entry = termPackEntry(listing.pack, 'term_buyer');
  if (entry === null || entry.pluginId !== pack.entry.pluginId)
    return { ok: false, refusal: 'the listing names a pack this node does not run' };
  const policyError = validateTermBuyerPolicy(args.policy);
  if (policyError !== null) return { ok: false, refusal: policyError };
  if (validateId(args.tag, 'tag') !== null || !listing.tags.includes(args.tag))
    return { ok: false, refusal: 'the listing does not want that category' };
  const vocabulary = entry.term?.vocabulary;
  if (
    vocabulary === undefined ||
    !validateAgainstSchema(
      { tag: args.tag, attributes: args.attributes },
      vocabulary.requestParamsSchema,
    ).ok
  ) {
    return { ok: false, refusal: 'the request does not fit the pack’s schema' };
  }
  if (validateIsoUtc(args.start, 'start') !== null || validateIsoUtc(args.end, 'end') !== null)
    return { ok: false, refusal: 'dates: canonical UTC instants' };
  if (
    Date.parse(args.start) < Date.parse(listing.available.from) ||
    Date.parse(args.end) > Date.parse(listing.available.to)
  ) {
    return { ok: false, refusal: 'the listing is not available for those dates' };
  }
  if (args.policy.renews !== undefined) {
    const renewed = termAgreementStatus(ctx.store, args.policy.renews);
    if (
      renewed.state !== 'accepted' ||
      renewed.proposal.vendor_did !== ctx.self() ||
      renewed.proposal.host_did !== listing.seller_did
    ) {
      return { ok: false, refusal: 'renews: not an agreement this node holds with that store' };
    }
    if (renewed.proposal.general.end !== args.start)
      return { ok: false, refusal: 'a renewal starts where the agreement it renews ends' };
  }
  const deadline = nowMs + args.policy.deadline_seconds * 1000;
  const respondBy = Math.min(nowMs + TERM_TIMINGS.requestRespondByMs, deadline);
  const values = {} as Record<TermName, bigint>;
  for (const name of TERM_NAMES) values[name] = BigInt(args.policy.targets[name]);
  const draft = {
    protocol_version: listing.protocol_version,
    request_id: mintId('treq'),
    buyer_did: ctx.self(),
    seller_did: listing.seller_did,
    listing_uri: args.listingUri,
    listing_digest: listing.listing_digest,
    pack: listing.pack,
    resource_ref: listing.resource_ref,
    attributes: args.attributes,
    general: { tag: args.tag, currency: args.policy.currency, start: args.start, end: args.end },
    wanted_terms: termsFromValues(values),
    issued_at: iso(nowMs),
    respond_by: iso(respondBy),
  };
  const request = sealTermRecord('term_request', draft, hash) as unknown as TermRequest;
  const bad = validateTermRequest(request, hash);
  if (bad !== null) return { ok: false, refusal: bad };
  ctx.atomically('start_negotiation', () => {
    ctx.store.putDocument({
      recordDigest: request.request_digest,
      kind: 'term_request',
      counterpartyDid: listing.seller_did,
      requestId: request.request_id,
      proposalDigest: '',
      answersDigest: '',
      direction: 'outbound',
      recordJson: JSON.stringify(request),
      evidenceJson: '{}',
      createdAt: nowMs,
    });
    ctx.store.putNegotiation({
      requestId: request.request_id,
      sellerDid: listing.seller_did,
      listingJson: JSON.stringify(listing),
      policyJson: JSON.stringify(args.policy),
      state: 'negotiating',
      closeReason: '',
      deadlineAt: deadline,
      nextActionAt: respondBy,
      createdAt: nowMs,
      updatedAt: nowMs,
    });
    ctx.enqueue({
      toDid: listing.seller_did,
      kind: 'term_request',
      digest: request.request_digest,
      document: request,
      stopAtMs: respondBy,
    });
  });
  return { ok: true, request };
}

function outboundRequest(ctx: TermContext, requestId: string): TermRequest | null {
  const row = ctx.store
    .listByRequest(requestId, 'term_request')
    .find((r) => r.direction === 'outbound');
  return row === undefined ? null : readTermRequestRow(row);
}

// ---------------------------------------------------------------------------
// Offers arriving (§7.1 steps 2–3)
// ---------------------------------------------------------------------------

export function admitTermOffer(
  ctx: TermContext,
  args: { senderDid: string; offer: TermOffer; evidenceJson: string },
): TermVerdict {
  const { offer } = args;
  const request = outboundRequest(ctx, offer.request_id);
  if (request === null)
    return { outcome: 'refused', detail: 'the offer answers no request this node sent' };
  if (args.senderDid !== request.seller_did || offer.seller_did !== request.seller_did) {
    return { outcome: 'refused', detail: 'the offer comes from another seller' };
  }
  const chain = offerChain(ctx, offer.request_id, 'inbound');
  const head = chain[chain.length - 1];
  if (offer.revision === 1) {
    const bind = verifyTermOfferAgainstRequest(offer, request);
    if (bind !== null) return { outcome: 'refused', detail: bind };
    if (head !== undefined) return { outcome: 'refused', detail: 'the chain already started' };
  } else {
    const previousDigest = offer.previous_offer_digest ?? '';
    const previous = chain.find((e) => e.offer.offer_digest === previousDigest);
    if (previous === undefined) {
      // The revision it builds on has not arrived yet: hold it (§5.3).
      return {
        outcome: 'held',
        reason: 'prerequisite',
        requestId: offer.request_id,
        proposalDigest: '',
        expiresAt: ctx.now() + TERM_TIMINGS.heldForMs,
      };
    }
    const bind = verifyTermOfferRevision(previous.offer, offer);
    if (bind !== null) return { outcome: 'refused', detail: bind };
    if (head !== undefined && head.offer.offer_digest !== previousDigest) {
      return { outcome: 'refused', detail: 'a second revision of the same head' };
    }
  }
  ctx.store.putDocument({
    recordDigest: offer.offer_digest,
    kind: 'term_offer',
    counterpartyDid: args.senderDid,
    requestId: offer.request_id,
    proposalDigest: '',
    answersDigest: offer.previous_offer_digest ?? offer.request_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(offer),
    evidenceJson: args.evidenceJson,
    createdAt: ctx.now(),
  });
  // A revision the relay delivered after the owner's card was raised is the
  // newer head: the card for the older one could only fail its binding, so it
  // lapses, and the loop runs again on the new head (a fresh card if this is
  // the offer to take).
  if (ctx.store.getNegotiation(offer.request_id)?.state === 'ready') {
    for (const card of ctx.store.cardsForRequest(offer.request_id, TERM_PROPOSAL_CARD)) {
      if (card.state !== 'pending' || !ctx.store.decideCard(card.cardId, 'lapsed', ctx.now()))
        continue;
      ctx.closeCard(card.cardId, 'superseded');
    }
    ctx.store.moveNegotiation({
      requestId: offer.request_id,
      from: ['ready'],
      to: 'negotiating',
      nowMs: ctx.now(),
    });
  }
  stepTermNegotiation(ctx, offer.request_id);
  return { outcome: 'stored', requestId: offer.request_id, proposalDigest: '' };
}

// ---------------------------------------------------------------------------
// The loop (§7.1 step 4)
// ---------------------------------------------------------------------------

function meetsAllTargets(offer: TermOffer, policy: TermBuyerPolicy): boolean {
  const values = termValues(offer.terms);
  const targets = buyerLimitsIn(policy, 'targets', offer.general.period);
  return TERM_NAMES.every((name) => termMeetsBuyerTarget(name, values[name], targets[name]));
}

function withinCeilings(offer: TermOffer, policy: TermBuyerPolicy): boolean {
  const values = termValues(offer.terms);
  const ceilings = buyerLimitsIn(policy, 'ceilings', offer.general.period);
  return TERM_NAMES.every((name) => termMeetsBuyerTarget(name, values[name], ceilings[name]));
}

/**
 * This node's counters on a request, in ROUND order. Not creation order: two
 * counters stored in one millisecond would fall back to digest order, which
 * is arbitrary, and "the last counter" decides whether the seller has moved.
 */
function outboundCounters(
  ctx: TermContext,
  requestId: string,
): { row: TermDocumentRow; counter: TermCounter }[] {
  return ctx.store
    .listByRequest(requestId, 'term_counter')
    .filter((row) => row.direction === 'outbound')
    .map((row) => ({ row, counter: readTermCounterRow(row) }))
    .filter((e): e is { row: TermDocumentRow; counter: TermCounter } => e.counter !== null)
    .sort((a, b) => a.counter.round - b.counter.round);
}

/**
 * One step of the brand's loop. Idempotent: called on every arriving offer
 * and by the sweep, it reads the state and does the next thing or nothing.
 */
export function stepTermNegotiation(ctx: TermContext, requestId: string): void {
  const negotiation = ctx.store.getNegotiation(requestId);
  if (negotiation === null || negotiation.state !== 'negotiating') return;
  const policy = readTermBuyerPolicyJson(negotiation.policyJson);
  const nowMs = ctx.now();
  if (policy === null) {
    ctx.store.moveNegotiation({
      requestId,
      from: ['negotiating'],
      to: 'closed',
      nowMs,
      closeReason: 'unreadable_policy',
    });
    return;
  }
  const chain = offerChain(ctx, requestId, 'inbound');
  const head = chain[chain.length - 1]?.offer;
  const request = outboundRequest(ctx, requestId);
  if (head === undefined) {
    // No offer yet: wait for the request's deadline (resends run meanwhile).
    const respondBy = request === null ? nowMs : Date.parse(request.respond_by);
    if (nowMs >= respondBy) {
      ctx.store.moveNegotiation({
        requestId,
        from: ['negotiating'],
        to: 'closed',
        nowMs,
        closeReason: 'no_offer',
      });
    } else {
      ctx.store.setNextAction(requestId, respondBy, nowMs);
    }
    return;
  }
  const counters = outboundCounters(ctx, requestId);
  const last = counters[counters.length - 1];
  const outstanding = last !== undefined && last.counter.offer_digest === head.offer_digest;
  if (meetsAllTargets(head, policy) || nowMs >= negotiation.deadlineAt) {
    toReady(ctx, requestId, head, policy);
    return;
  }
  if (outstanding) {
    // The seller has not moved since the last counter: wait out its window,
    // then read the silence as a hold and stop countering.
    const respondBy = Date.parse(last.counter.respond_by);
    if (nowMs < respondBy) {
      ctx.store.setNextAction(requestId, Math.min(respondBy, negotiation.deadlineAt), nowMs);
      return;
    }
    toReady(ctx, requestId, head, policy);
    return;
  }
  if (counters.length >= policy.max_rounds) {
    toReady(ctx, requestId, head, policy);
    return;
  }
  sendCounter(ctx, {
    head,
    policy,
    round: counters.length + 1,
    deadlineAt: negotiation.deadlineAt,
  });
}

function sendCounter(
  ctx: TermContext,
  args: { head: TermOffer; policy: TermBuyerPolicy; round: number; deadlineAt: number },
): void {
  const nowMs = ctx.now();
  const values = termValues(args.head.terms);
  // The counter speaks the offer's period: a weekly offer is countered in weeks.
  const wanted = buyerLimitsIn(args.policy, 'targets', args.head.general.period);
  const targets: Partial<Record<TermName, string>> = {};
  for (const name of TERM_NAMES) {
    // Name only the terms the head does not already meet.
    if (!termMeetsBuyerTarget(name, values[name], wanted[name]))
      targets[name] = wanted[name].toString(10);
  }
  const respondBy = Math.min(nowMs + TERM_TIMINGS.counterRespondByMs, args.deadlineAt);
  const draft = {
    protocol_version: args.head.protocol_version,
    counter_id: mintId('tctr'),
    offer_id: args.head.offer_id,
    offer_digest: args.head.offer_digest,
    buyer_did: ctx.self(),
    seller_did: args.head.seller_did,
    round: args.round,
    targets,
    issued_at: iso(nowMs),
    respond_by: iso(respondBy),
  };
  const counter = sealTermRecord('term_counter', draft, hash) as unknown as {
    counter_digest: string;
  };
  // The counter, the loop's next step and the send intent land together.
  ctx.atomically('counter', () => {
    ctx.store.putDocument({
      recordDigest: counter.counter_digest,
      kind: 'term_counter',
      counterpartyDid: args.head.seller_did,
      requestId: args.head.request_id,
      proposalDigest: '',
      answersDigest: args.head.offer_digest,
      direction: 'outbound',
      recordJson: JSON.stringify(counter),
      evidenceJson: '{}',
      createdAt: nowMs,
    });
    ctx.store.setNextAction(args.head.request_id, respondBy, nowMs);
    ctx.enqueue({
      toDid: args.head.seller_did,
      kind: 'term_counter',
      digest: counter.counter_digest,
      document: counter,
      stopAtMs: respondBy,
    });
  });
}

const PENDING_PRINCIPAL: ApprovingPrincipal = {
  principalDid: null,
  authorityDomain: TERM_PROPOSAL_AUTHORITY_DOMAIN,
  policyRevision: null,
};

/** Stop bargaining and ask the owner once (§7.3) — or close when nothing can be proposed. */
function toReady(
  ctx: TermContext,
  requestId: string,
  head: TermOffer,
  policy: TermBuyerPolicy,
): void {
  const nowMs = ctx.now();
  if (!withinCeilings(head, policy)) {
    ctx.store.moveNegotiation({
      requestId,
      from: ['negotiating'],
      to: 'closed',
      nowMs,
      closeReason: 'above_ceiling',
    });
    return;
  }
  if (Date.parse(head.valid_until) <= nowMs) {
    ctx.store.moveNegotiation({
      requestId,
      from: ['negotiating'],
      to: 'closed',
      nowMs,
      closeReason: 'offer_expired',
    });
    return;
  }
  if (!ctx.store.moveNegotiation({ requestId, from: ['negotiating'], to: 'ready', nowMs })) return;
  const cardId = `term-proposal-${head.offer_digest.slice(0, 32)}`;
  const binding = buildTermProposalApprovalPayload({
    principal: PENDING_PRINCIPAL,
    offer: head,
    ...(policy.renews !== undefined ? { replacesProposalDigest: policy.renews } : {}),
  });
  const ranking = rankTermOffers(ctx).find((r) => r.requestId === requestId);
  const payload = {
    type: TERM_PROPOSAL_CARD,
    card_id: cardId,
    request_id: requestId,
    seller_did: head.seller_did,
    resource_ref: head.resource_ref,
    general: head.general,
    terms: head.terms,
    valid_until: head.valid_until,
    ...(ranking?.costPerPeriodMinor !== undefined && ranking.costPeriod !== undefined
      ? { cost_per_period_minor: ranking.costPerPeriodMinor, cost_period: ranking.costPeriod }
      : {}),
  };
  ctx.raiseCard({
    cardId,
    type: TERM_PROPOSAL_CARD,
    requestId,
    refDigest: head.offer_digest,
    material: binding,
    description: 'A store’s offer for a slot is ready. Send the proposal?',
    payload,
    decideBy: Date.parse(head.valid_until),
  });
}

// ---------------------------------------------------------------------------
// The owner's yes: the proposal (§7.1 step 5, §7.2)
// ---------------------------------------------------------------------------

export type ProposeOutcome =
  | { ok: true; proposal: TermAgreementProposal | null }
  | {
      ok: false;
      refusal:
        | 'unknown_card'
        | 'already_decided'
        | 'binding_failed'
        | 'offer_expired'
        | 'unbuildable';
    };

/**
 * The owner decided the brand's card (through the owner-only, presence-gated
 * approval route). A yes mints the proposal from the offer the card showed —
 * refused if the head moved since (a new card is needed) or the offer has
 * expired — stores it with its send intent, and moves the negotiation on.
 */
export function decideTermProposalCard(
  ctx: TermContext,
  args: { cardId: string; approve: boolean },
): ProposeOutcome {
  const card = ctx.store.getCard(args.cardId);
  if (card === null || card.cardType !== TERM_PROPOSAL_CARD)
    return { ok: false, refusal: 'unknown_card' };
  if (card.state !== 'pending') return { ok: false, refusal: 'already_decided' };
  const nowMs = ctx.now();
  if (!args.approve) {
    // The card and the negotiation close together, or a crash between them
    // leaves a `ready` negotiation no card or sweep can move again.
    return ctx.atomically('decline_proposal', (): ProposeOutcome => {
      if (!ctx.store.decideCard(args.cardId, 'declined', nowMs))
        return { ok: false, refusal: 'already_decided' };
      ctx.store.moveNegotiation({
        requestId: card.requestId,
        from: ['ready'],
        to: 'closed',
        nowMs,
        closeReason: 'declined',
      });
      return { ok: true, proposal: null };
    });
  }
  const chain = offerChain(ctx, card.requestId, 'inbound');
  const head = chain[chain.length - 1]?.offer;
  const negotiation = ctx.store.getNegotiation(card.requestId);
  const policy = negotiation === null ? null : readTermBuyerPolicyJson(negotiation.policyJson);
  const approved = readTermApprovalMaterial(card.materialJson);
  if (head === undefined || approved === null || policy === null)
    return { ok: false, refusal: 'binding_failed' };
  const executing = buildTermProposalApprovalPayload({
    principal: PENDING_PRINCIPAL,
    offer: head,
    ...(policy.renews !== undefined ? { replacesProposalDigest: policy.renews } : {}),
  });
  if (!verifyApprovalBinding(approved, executing).ok)
    return { ok: false, refusal: 'binding_failed' };
  if (Date.parse(head.valid_until) <= nowMs) {
    lapseProposalCard(ctx, args.cardId);
    return { ok: false, refusal: 'offer_expired' };
  }
  const draft = {
    protocol_version: head.protocol_version,
    proposal_id: mintId('tagr'),
    host_did: head.seller_did,
    vendor_did: ctx.self(),
    offer_digest: head.offer_digest,
    pack: head.pack,
    resource_ref: head.resource_ref,
    general: head.general,
    terms: head.terms,
    ...(policy.renews !== undefined ? { replaces_proposal_digest: policy.renews } : {}),
    proposed_at: iso(nowMs),
  };
  const proposal = sealTermRecord(
    'term_agreement_proposal',
    draft,
    hash,
  ) as unknown as TermAgreementProposal;
  if (
    validateTermAgreementProposal(proposal, hash) !== null ||
    verifyTermProposalAgainstOffer(proposal, head) !== null
  ) {
    return { ok: false, refusal: 'unbuildable' };
  }
  let stored = false;
  ctx.atomically('propose', () => {
    if (!ctx.store.decideCard(args.cardId, 'approved', nowMs)) return;
    ctx.store.putDocument({
      recordDigest: proposal.proposal_digest,
      kind: 'term_agreement_proposal',
      counterpartyDid: head.seller_did,
      requestId: card.requestId,
      proposalDigest: proposal.proposal_digest,
      answersDigest: proposal.replaces_proposal_digest ?? proposal.offer_digest,
      direction: 'outbound',
      recordJson: JSON.stringify(proposal),
      evidenceJson: '{}',
      createdAt: nowMs,
    });
    ctx.store.moveNegotiation({
      requestId: card.requestId,
      from: ['ready'],
      to: 'proposed',
      nowMs,
    });
    // The send intent lands with the proposal, so a crash after the commit
    // still leaves the sweep something to resend.
    ctx.enqueue({
      toDid: head.seller_did,
      kind: 'term_proposal',
      digest: proposal.proposal_digest,
      document: proposal,
      stopAtMs: nowMs + TERM_TIMINGS.agreementResendForMs,
    });
    stored = true;
  });
  if (!stored) return { ok: false, refusal: 'already_decided' };
  return { ok: true, proposal };
}

/** The brand's card lapsed with its offer: the negotiation closes. */
export function lapseProposalCard(ctx: TermContext, cardId: string): void {
  const card = ctx.store.getCard(cardId);
  if (card === null || card.cardType !== TERM_PROPOSAL_CARD) return;
  ctx.atomically('lapse_proposal', () => {
    if (!ctx.store.decideCard(cardId, 'lapsed', ctx.now())) return;
    ctx.store.moveNegotiation({
      requestId: card.requestId,
      from: ['ready'],
      to: 'closed',
      nowMs: ctx.now(),
      closeReason: 'offer_expired',
    });
  });
}

/** The store's decision arrived: the negotiation is agreed or closed. */
export function noteTermDecision(ctx: TermContext, decision: AgreementDecision): void {
  const proposalRow = ctx.store.getDocument(decision.proposal_digest);
  const proposal = readTermProposalRow(proposalRow);
  if (proposalRow === null || proposal === null) return;
  ctx.store.moveNegotiation({
    requestId: proposalRow.requestId,
    from: ['proposed'],
    to: decision.kind === 'accepted' ? 'agreed' : 'closed',
    nowMs: ctx.now(),
    ...(decision.kind === 'rejected' ? { closeReason: 'rejected' } : {}),
  });
}

// ---------------------------------------------------------------------------
// Ranking (§8)
// ---------------------------------------------------------------------------

export interface RankedTermOffer {
  requestId: string;
  sellerDid: string;
  offerDigest: string;
  currency: string;
  period: string;
  fee: string;
  shareBps: string;
  /**
   * fee + expected_sales × share_bps / 10,000, in the brand's own period
   * (`costPeriod`) whatever the offer's; absent without an estimate.
   */
  costPerPeriodMinor?: string;
  costPeriod?: 'monthly' | 'weekly';
}

/**
 * The brand's current offers, ranked (§8). With an expected-sales estimate
 * the cost per period orders them — lower first, ties to the lower fee, then
 * the seller DID. Offers without an estimate, or with a different currency
 * or cost period from the first ranked one, are listed after, unranked, for the
 * owner to compare side by side.
 */
export function rankTermOffers(ctx: TermContext): RankedTermOffer[] {
  // `cost` and `feeIn` are in the entry's own costPeriod (its brand policy's period).
  const ranked: (RankedTermOffer & { cost?: bigint; feeIn?: bigint })[] = [];
  for (const negotiation of ctx.store.listNegotiations()) {
    if (negotiation.state !== 'negotiating' && negotiation.state !== 'ready') continue;
    const policy = readTermBuyerPolicyJson(negotiation.policyJson);
    const chain = offerChain(ctx, negotiation.requestId, 'inbound');
    const head = chain[chain.length - 1]?.offer;
    if (policy === null || head === undefined || !withinCeilings(head, policy)) continue;
    const values = termValues(head.terms);
    const entry: RankedTermOffer & { cost?: bigint; feeIn?: bigint } = {
      requestId: negotiation.requestId,
      sellerDid: head.seller_did,
      offerDigest: head.offer_digest,
      currency: head.general.currency,
      period: head.general.period,
      fee: values.fee.toString(10),
      shareBps: values.share_bps.toString(10),
    };
    if (policy.expected_sales_minor !== undefined) {
      // In the brand's own period, the one its expected sales are given in,
      // so a weekly and a monthly offer are ranked on one scale.
      const own = policy.period ?? 'monthly';
      const feeIn = buyerMoneyIn(values.fee, head.general.period, own);
      const cost = feeIn + (BigInt(policy.expected_sales_minor) * values.share_bps) / 10_000n;
      entry.cost = cost;
      entry.feeIn = feeIn;
      entry.costPerPeriodMinor = cost.toString(10);
      entry.costPeriod = own;
    }
    ranked.push(entry);
  }
  const anchor = ranked.find((r) => r.cost !== undefined);
  const costed: (RankedTermOffer & { cost: bigint; feeIn: bigint })[] = [];
  const rest: RankedTermOffer[] = [];
  for (const { cost, feeIn, ...entry } of ranked) {
    // One scale: the same currency and the same period (two negotiations may
    // carry brand policies in different periods).
    if (
      anchor !== undefined &&
      cost !== undefined &&
      feeIn !== undefined &&
      entry.currency === anchor.currency &&
      entry.costPeriod === anchor.costPeriod
    ) {
      costed.push({ ...entry, cost, feeIn });
    } else {
      rest.push(entry);
    }
  }
  const order = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
  costed.sort(
    (a, b) =>
      order(a.cost, b.cost) ||
      order(a.feeIn, b.feeIn) ||
      a.sellerDid.localeCompare(b.sellerDid),
  );
  return [...costed.map(({ cost: _c, feeIn: _f, ...entry }) => entry), ...rest];
}

/** The head offer a negotiation currently holds, for the owner's screens. */
export function negotiationOffer(ctx: TermContext, requestId: string): TermOffer | null {
  const chain = offerChain(ctx, requestId, 'inbound');
  return chain[chain.length - 1]?.offer ?? null;
}
