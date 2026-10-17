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
  type Term,
  type TermPromise,
  type TermRequest,
  checkProtocolVersion,
  renderTermMessage,
  type TermMessage,
} from '@dina/commerce-protocol';


import {
  overCapacity,
  projectModel,
  strategyVerdict,
  type DealVersion,
  type PartBounds,
  type StrategyMove,
} from '../../commitment';
import { validateAgainstSchema } from '../../plugins/schema_validate';
import {
  buildTermProposalApprovalPayload,
  TERM_PROPOSAL_AUTHORITY_DOMAIN,
  verifyApprovalBinding,
  type ApprovingPrincipal,
} from '../approval_payload';
import { termPackEntry } from '../first_party_packs';
import { SLOT_PACK_PARTS } from '../slot_pack_manifests';

import { termAgreementStatus } from './term_agreements';
import { HOUR_MS, hash, iso, mintId, TERM_TIMINGS, type TermContext } from './term_context';
import {
  SHELF_VENDOR_KIND,
  shelfBindingCard,
  shelfEnvelope,
  shelfParts,
  shelfWorth,
  ownerAnswersFor,
  raiseStrategyNotice,
  strategyBudgetLeft,
  tableMessage,
} from './term_model';
import { closedPersonasFor, raisePersonaCard } from './term_persona';
import {
  buyerAtLeast,
  buyerLimitsIn,
  buyerMoneyIn,
  promiseProblem,
  validateTermBuyerPolicy,
  type TermBuyerPolicy,
} from './term_policy';
import { askOwnerOnTurn } from './term_questions';
import {
  readTermApprovalMaterial,
  readTermBuyerPolicyJson,
  readTermCardPayloadJson,
  readTermCounterRow,
  readTermOfferRow,
  readTermProposalRow,
  readTermRequestRow,
} from './term_rehydrate';
import { offerChain, type TermVerdict } from './term_seller';

import type { TermCardRow, TermDocumentRow } from './term_store';
import type { NegotiationBrief } from '../../commitment/strategy_submit';

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
  // No deal it starts could bind without the Commerce Pack (`term_money.ts`).
  if (!ctx.deps.moneyAvailable())
    return { ok: false, refusal: 'install the Commerce Pack first: shelf deals settle through it' };
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
  // Every name on the table comes from the pack's vocabulary (§11): a promise
  // the pack does not declare would put the store's own words in front of the
  // owner and Brain, through the table and through a message naming it.
  for (const alt of offer.alternatives ?? [])
    for (const [i, promise] of alt.promises.entries()) {
      const problem = promiseProblem(promise, `alternatives.${alt.alternative_id}.promises[${String(i)}]`);
      if (problem !== null) return { outcome: 'refused', detail: problem };
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
  return TERM_NAMES.every((name) => buyerAtLeast(name, values[name], targets[name]));
}

function withinCeilings(offer: TermOffer, policy: TermBuyerPolicy): boolean {
  const values = termValues(offer.terms);
  const ceilings = buyerLimitsIn(policy, 'ceilings', offer.general.period);
  return TERM_NAMES.every((name) => buyerAtLeast(name, values[name], ceilings[name]));
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
  // A paused or removed brand half authors nothing: no counter, no card (§4).
  // A paused one keeps its place and goes on from here once resumed.
  if (ctx.deps.activePack('term_buyer') === null) {
    const nowMs = ctx.now();
    if (!ctx.deps.packHeld('term_buyer')) {
      // Removed or revoked, not paused: nothing can carry this one on.
      ctx.store.moveNegotiation({
        requestId,
        from: ['negotiating'],
        to: 'closed',
        nowMs,
        closeReason: 'pack_removed',
      });
      return;
    }
    // Paused: looked at again within the hour, or at its deadline if sooner.
    ctx.store.setNextAction(requestId, Math.min(nowMs + HOUR_MS, negotiation.deadlineAt), nowMs);
    return;
  }
  // No deal it reaches could bind without the Commerce Pack (`term_money.ts`):
  // no counter and no card while it is missing. Looked at again within the
  // hour, and closed at the deadline.
  if (!ctx.deps.moneyAvailable()) {
    const nowMs = ctx.now();
    if (nowMs >= negotiation.deadlineAt) {
      ctx.store.moveNegotiation({
        requestId,
        from: ['negotiating'],
        to: 'closed',
        nowMs,
        closeReason: 'commerce_pack_needed',
      });
      return;
    }
    ctx.store.setNextAction(requestId, Math.min(nowMs + HOUR_MS, negotiation.deadlineAt), nowMs);
    return;
  }
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
  // Any version that meets every target is enough to put to the owner (§8 step 3).
  if (
    offerVersions(head).some((v) => meetsAllTargets({ ...head, terms: v.terms }, policy)) ||
    nowMs >= negotiation.deadlineAt
  ) {
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
  // COMMITMENT_KERNEL §11 — when the owner chose Brain, it takes the round.
  if (handToStrategy(ctx, { requestId, head, policy, round: counters.length + 1, deadlineAt: negotiation.deadlineAt }))
    return;
  sendCounter(ctx, {
    head,
    policy,
    round: counters.length + 1,
    deadlineAt: negotiation.deadlineAt,
  });
}

// ---------------------------------------------------------------------------
// The strategy slot (COMMITMENT_KERNEL §11)
// ---------------------------------------------------------------------------

/** How long a round waits for the strategy before the fixed style plays it. */
export const STRATEGY_WAIT_MS = 20 * 60 * 1000;

export { TERM_STRATEGY_CARD } from './term_model';

/**
 * Hand this round to Brain, when the owner chose it for shelf deals. True
 * when Brain has the round (asked now, or asked before and not yet back);
 * false when the fixed style plays it.
 */
function handToStrategy(
  ctx: TermContext,
  args: { requestId: string; head: TermOffer; policy: TermBuyerPolicy; round: number; deadlineAt: number },
): boolean {
  const strategy = ctx.deps.strategy;
  if (strategy === undefined) return false;
  const settings = strategy.settings(SHELF_VENDOR_KIND);
  if (settings.strategy !== 'brain') return false;
  const nowMs = ctx.now();
  const turn = ctx.store.getTurn(args.requestId, args.round);
  if (turn !== null) {
    if (turn.state !== 'pending') return false;
    ctx.store.setNextAction(args.requestId, Math.min(turn.createdAt + STRATEGY_WAIT_MS, args.deadlineAt), nowMs);
    return true;
  }
  if (!strategyBudgetLeft(ctx, SHELF_VENDOR_KIND, args.requestId)) return false;
  const submitted = strategy.submit(vendorBrief(ctx, args, settings.valuesOn));
  if (submitted === null) return false;
  ctx.atomically('strategy_turn', () => {
    ctx.store.putTurn({ requestId: args.requestId, turn: args.round, taskId: submitted.taskId, createdAt: nowMs });
    ctx.store.setNextAction(args.requestId, Math.min(nowMs + STRATEGY_WAIT_MS, args.deadlineAt), nowMs);
  });
  return true;
}

/**
 * Brain's brief, through Core's one projection (§11): the parts, the offers
 * and counters so far (the store's moves are data), the owner's values when
 * they switched them on, the never-rules' labels, rounds and time left.
 * Never the ceilings (the brand's hard limits) or its expected sales.
 */
function vendorBrief(
  ctx: TermContext,
  args: { requestId: string; head: TermOffer; policy: TermBuyerPolicy; round: number; deadlineAt: number },
  valuesOn: boolean,
): NegotiationBrief {
  const chain = offerChain(ctx, args.requestId, 'inbound').map(({ offer }) => ({
    by: 'them',
    revision: offer.revision,
    terms: offer.terms,
    ...(offer.alternatives !== undefined ? { alternatives: offer.alternatives } : {}),
    // Core's own sentence for the store's message: never words the store wrote.
    ...(offer.message !== undefined ? { said: renderTermMessage(offer.message) } : {}),
  }));
  const counters = outboundCounters(ctx, args.requestId).map(({ counter }) => ({
    by: 'us',
    round: counter.round,
    targets: counter.targets,
    ...(counter.message !== undefined ? { said: renderTermMessage(counter.message) } : {}),
  }));
  // Only what Brain may read now: untagged entries and Brain-readable personas.
  const model = ctx.deps.strategy?.brainModel(SHELF_VENDOR_KIND) ?? undefined;
  return {
    kind: SHELF_VENDOR_KIND,
    ref: { negotiationId: args.requestId, turn: args.round },
    side: 'buyer',
    parts: SHELF_PARTS_BRIEF,
    table: {
      terms: args.head.terms,
      ...(args.head.alternatives !== undefined ? { alternatives: args.head.alternatives } : {}),
      general: {
        currency: args.head.general.currency,
        period: args.head.general.period,
        start: args.head.general.start,
        end: args.head.general.end,
      },
    },
    history: [...chain, ...counters],
    model: model === undefined ? { constrained: [] } : { ...projectModel(model, { valuesOn, firstOfferOut: true }) },
    roundsLeft: Math.max(0, args.policy.max_rounds - counters.length),
    deadlineAt: iso(args.deadlineAt),
    rules: [
      'You speak for the brand, which pays the store rent (fee, minor units) and a share of sales (share_bps).',
      'A counter asks the store to move; propose the terms you want, one version.',
      'Never set a price for anyone outside the deal.',
    ],
    ...ownerAnswersFor(ctx, SHELF_VENDOR_KIND, args.requestId),
  };
}

/**
 * The brand's brief for a turn already handed to Brain, built again from the
 * negotiation as it stands (after the owner answered Brain's question). Null
 * when the negotiation has moved on.
 */
export function buyerTurnBrief(ctx: TermContext, requestId: string, turn: number): NegotiationBrief | null {
  const negotiation = ctx.store.getNegotiation(requestId);
  const policy = negotiation === null ? null : readTermBuyerPolicyJson(negotiation.policyJson);
  const head = offerChain(ctx, requestId, 'inbound').at(-1)?.offer;
  const settings = ctx.deps.strategy?.settings(SHELF_VENDOR_KIND);
  if (
    negotiation === null ||
    negotiation.state !== 'negotiating' ||
    policy === null ||
    head === undefined ||
    settings === undefined ||
    outboundCounters(ctx, requestId).length + 1 !== turn
  )
    return null;
  return vendorBrief(ctx, { requestId, head, policy, round: turn, deadlineAt: negotiation.deadlineAt }, settings.valuesOn);
}

const SHELF_PARTS_BRIEF = SLOT_PACK_PARTS.map((p) => ({ ...p }));

/**
 * Apply a move the strategy returned (through the commit bridge). Idempotent
 * on the turn: a replayed commit finds it closed. Every proposal is charged to
 * the verdict budgets first, one per version; a spent budget, a refusal or a
 * move the shelf wire cannot carry yet lets the fixed style play the round.
 */
export function applyStrategyMove(
  ctx: TermContext,
  args: { requestId: string; turn: number; move: StrategyMove },
): { outcome: string } {
  const turn = ctx.store.getTurn(args.requestId, args.turn);
  if (turn === null || turn.state !== 'pending') return { outcome: 'already_applied' };
  const nowMs = ctx.now();
  const negotiation = ctx.store.getNegotiation(args.requestId);
  const policy = negotiation === null ? null : readTermBuyerPolicyJson(negotiation.policyJson);
  const head = offerChain(ctx, args.requestId, 'inbound').at(-1)?.offer;
  const fixed = (outcome: string): { outcome: string } => {
    ctx.atomically('strategy_fallback', () => {
      ctx.store.closeTurn(args.requestId, args.turn, 'fallen_back');
      ctx.store.setNextAction(args.requestId, nowMs, nowMs);
    });
    return { outcome };
  };
  if (negotiation === null || negotiation.state !== 'negotiating' || policy === null || head === undefined) {
    ctx.store.closeTurn(args.requestId, args.turn, 'applied');
    return { outcome: 'negotiation_moved_on' };
  }
  // The gates are checked again now, not as they were when the turn was asked:
  // the half paused, the Commerce Pack gone, the owner back on the fixed style,
  // or a round that is no longer this one — the fixed style plays instead.
  const strategyNow = ctx.deps.strategy?.settings(SHELF_VENDOR_KIND).strategy;
  if (
    ctx.deps.activePack('term_buyer') === null ||
    !ctx.deps.moneyAvailable() ||
    strategyNow !== 'brain' ||
    outboundCounters(ctx, args.requestId).length + 1 !== args.turn ||
    nowMs >= negotiation.deadlineAt
  )
    return fixed('gates_changed');
  if (args.move.kind === 'stop') {
    ctx.atomically('strategy_stop', () => {
      ctx.store.closeTurn(args.requestId, args.turn, 'applied');
      toReady(ctx, args.requestId, head, policy);
    });
    return { outcome: 'stopped' };
  }
  // §15 step 11 — a yes-or-no question for the owner: the turn waits on its
  // card. It draws no verdict (the owner answers, not a threshold), so no
  // budget; a deal asks at most a few.
  if (args.move.kind === 'ask_owner') {
    return askOwnerOnTurn(ctx, {
      requestId: args.requestId,
      turn: args.turn,
      question: args.move.question,
      // The counter must go out while the negotiation runs and the store's offer stands.
      dealDeadlineMs: Math.min(negotiation.deadlineAt, Date.parse(head.valid_until)),
    })
      ? { outcome: 'asked_owner' }
      : fixed('fixed_style');
  }
  // A question for the store: the fixed style's counter carries it, if the
  // part is on the table. It draws no verdict, so no budget.
  if (args.move.kind === 'ask_other') {
    const message = tableMessage(args.move, head);
    if (message === null) return fixed('fixed_style');
    ctx.atomically('strategy_message', () => {
      ctx.store.closeTurn(args.requestId, args.turn, 'applied');
      sendCounter(ctx, { head, policy, round: args.turn, deadlineAt: negotiation.deadlineAt, message });
    });
    return { outcome: 'sent_with_message' };
  }
  if (args.move.kind !== 'propose' || args.move.versions.length === 0) return fixed('fixed_style');
  const strategy = ctx.deps.strategy;
  if (strategy === undefined) return fixed('fixed_style');
  const modelVersion = ctx.deps.valueModels?.(SHELF_VENDOR_KIND, [])?.model.version ?? 0;
  const charged = strategy.charge({
    kind: SHELF_VENDOR_KIND,
    negotiationId: args.requestId,
    count: args.move.versions.length,
    nowMs,
    thresholdVersion: modelVersion,
  });
  if (!charged.ok) {
    raiseStrategyNotice(ctx, args.requestId, charged.spent);
    return fixed('budget_spent');
  }
  // A counter carries one set of targets: the first version.
  const version = args.move.versions[0] as DealVersion;
  const wanted = termValues(head.terms);
  for (const part of version.parts)
    if (part.kind === 'number' && (TERM_NAMES as readonly string[]).includes(part.name))
      wanted[part.name as TermName] = part.value;
  // A counter that asks for nothing the head does not already give is no move.
  const values = termValues(head.terms);
  if (TERM_NAMES.every((name) => buyerAtLeast(name, values[name], wanted[name]))) return fixed('nothing_asked');
  // The hard checks, as for the fixed style's counter: a counter asks and
  // binds nothing. Whatever the store answers reaches the full envelope, and
  // the owner's card where it needs one, at the proposal step.
  const verdict = strategyVerdict(vendorVerdict(ctx, head, policy, termsFromValues(wanted), []));
  if (verdict.outcome === 'refused')
    return fixed(verdict.reason === 'never_rule' ? 'refused_never_rule' : 'refused_not_enough');
  ctx.atomically('strategy_counter', () => {
    ctx.store.closeTurn(args.requestId, args.turn, 'applied');
    sendCounter(ctx, { head, policy, round: args.turn, deadlineAt: negotiation.deadlineAt, wanted });
  });
  return { outcome: 'sent' };
}

/** A round asked of the strategy that did not come back in time: the fixed style plays it. */
export function fallBackStaleTurns(ctx: TermContext): number {
  const nowMs = ctx.now();
  let n = 0;
  for (const turn of ctx.store.staleTurns(nowMs - STRATEGY_WAIT_MS)) {
    if (ctx.store.getNegotiation(turn.requestId) === null) continue; // the store's own turn
    ctx.atomically('strategy_stale', () => {
      if (ctx.store.closeTurn(turn.requestId, turn.turn, 'fallen_back')) {
        ctx.store.setNextAction(turn.requestId, nowMs, nowMs);
        n += 1;
      }
    });
  }
  return n;
}


function sendCounter(
  ctx: TermContext,
  args: {
    head: TermOffer;
    policy: TermBuyerPolicy;
    round: number;
    deadlineAt: number;
    /** A strategy's targets (COMMITMENT_KERNEL §11); absent: the owner's own. */
    wanted?: Record<TermName, bigint>;
    /** A message beside the counter (the conversation channel, §11). */
    message?: TermMessage;
  },
): void {
  const nowMs = ctx.now();
  const values = termValues(args.head.terms);
  // The counter speaks the offer's period: a weekly offer is countered in weeks.
  const wanted = args.wanted ?? buyerLimitsIn(args.policy, 'targets', args.head.general.period);
  const targets: Partial<Record<TermName, string>> = {};
  for (const name of TERM_NAMES) {
    // Name only the terms the head does not already meet.
    if (!buyerAtLeast(name, values[name], wanted[name]))
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
    ...(args.message !== undefined ? { message: args.message } : {}),
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
  // A rule kept in a closed persona: no card the owner could not act on. The
  // owner is asked to open the persona; the loop looks again within the hour
  // and closes at its deadline (term_persona.ts).
  const closed = closedPersonasFor(ctx, SHELF_VENDOR_KIND);
  if (closed.length > 0) {
    const negotiation = ctx.store.getNegotiation(requestId);
    if (negotiation !== null && nowMs >= negotiation.deadlineAt) {
      ctx.store.moveNegotiation({
        requestId,
        from: ['negotiating'],
        to: 'closed',
        nowMs,
        closeReason: 'persona_closed',
      });
      return;
    }
    raisePersonaCard(ctx, { step: 'proposal', requestId, refDigest: head.offer_digest, personas: closed });
    ctx.store.setNextAction(
      requestId,
      Math.min(nowMs + HOUR_MS, negotiation?.deadlineAt ?? nowMs + HOUR_MS),
      nowMs,
    );
    return;
  }
  // Each version on its own (§8 step 3): close only when none is within the
  // ceilings and the owner's rules — above the ceiling when even the offer's
  // own terms are, else ruled out by the owner's rules.
  const passing = offerVersions(head).filter((v) => versionAllowed(ctx, head, policy, v));
  if (passing.length === 0) {
    ctx.store.moveNegotiation({
      requestId,
      from: ['negotiating'],
      to: 'closed',
      nowMs,
      closeReason: withinCeilings(head, policy) ? 'ruled_out' : 'above_ceiling',
    });
    return;
  }
  if (!ctx.store.moveNegotiation({ requestId, from: ['negotiating'], to: 'ready', nowMs })) return;
  // One card per version of the head — the offer's own terms, and each
  // alternative within the ceilings and the owner's rules (§8 step 3: the
  // owner picks among the versions that pass). A fresh set when an earlier
  // set for the same head lapsed (a yes refused while the half was paused).
  const base = `term-proposal-${head.offer_digest.slice(0, 32)}`;
  // Sets are numbered from every card for this head, alternatives included:
  // a set may hold only alternative cards.
  const earlier = new Set(
    ctx.store
      .cardsForRequest(requestId, TERM_PROPOSAL_CARD)
      .map((c) => c.cardId.split('~')[0] as string)
      .filter((set) => set === base || set.startsWith(`${base}-`)),
  ).size;
  const setId = earlier === 0 ? base : `${base}-${String(earlier + 1)}`;
  let raised = 0;
  const ranking = rankTermOffers(ctx).find((r) => r.requestId === requestId);
  const previous = previousOffer(ctx, head);
  for (const version of passing) {
    const cardId = version.alternative_id === undefined ? setId : `${setId}~${version.alternative_id}`;
    const binding = buildTermProposalApprovalPayload({
      principal: PENDING_PRINCIPAL,
      offer: head,
      ...(policy.renews !== undefined ? { replacesProposalDigest: policy.renews } : {}),
      ...(version.alternative_id !== undefined ? { alternativeId: version.alternative_id } : {}),
    });
    const before =
      previous === null
        ? undefined
        : offerVersions(previous).find((v) => v.alternative_id === version.alternative_id);
    const payload = {
      type: TERM_PROPOSAL_CARD,
      card_id: cardId,
      request_id: requestId,
      seller_did: head.seller_did,
      resource_ref: head.resource_ref,
      general: head.general,
      terms: version.terms,
      ...(version.alternative_id !== undefined
        ? { alternative_id: version.alternative_id, promises: version.promises }
        : {}),
      valid_until: head.valid_until,
      // §9 — Core's own list of what binds, where the risk is, what changed.
      legibility: shelfBindingCard({
        holder: 'buyer',
        terms: version.terms,
        promises: version.promises,
        general: head.general,
        ...shelfWorth(ctx, {
          kind: SHELF_VENDOR_KIND,
          holder: 'buyer',
          limits: ceilingLimits(head, policy),
          terms: version.terms,
          promises: version.promises,
          general: head.general,
        }),
        ...(before !== undefined ? { previous: { terms: before.terms, promises: before.promises } } : {}),
      }),
      ...(ranking?.costPerPeriodMinor !== undefined && ranking.costPeriod !== undefined
        ? { cost_per_period_minor: ranking.costPerPeriodMinor, cost_period: ranking.costPeriod }
        : {}),
    };
    const fresh = ctx.raiseCard({
      cardId,
      type: TERM_PROPOSAL_CARD,
      requestId,
      refDigest: head.offer_digest,
      material: binding,
      description:
        version.alternative_id === undefined
          ? 'A store’s offer for a slot is ready. Send the proposal?'
          : 'A store offers another version of the deal, with a promise from you. Send the proposal for this version?',
      payload,
      decideBy: Date.parse(head.valid_until),
    });
    if (fresh) raised += 1;
  }
  // A `ready` negotiation with no card would wait for good: nothing steps a
  // ready one. Step back and look again within the hour.
  if (raised === 0) {
    ctx.store.moveNegotiation({ requestId, from: ['ready'], to: 'negotiating', nowMs });
    ctx.store.setNextAction(requestId, nowMs + HOUR_MS, nowMs);
  }
}

/** The versions of an offer: its own terms, then each alternative. */
function offerVersions(
  offer: TermOffer,
): { alternative_id?: string; terms: Term[]; promises: TermPromise[] }[] {
  return [
    { terms: offer.terms, promises: [] },
    ...(offer.alternatives ?? []).map((a) => ({
      alternative_id: a.alternative_id,
      terms: a.terms,
      promises: a.promises,
    })),
  ];
}

/** The offer this one revised, for "what changed" on the card. */
function previousOffer(ctx: TermContext, offer: TermOffer): TermOffer | null {
  if (offer.previous_offer_digest === undefined) return null;
  return readTermOfferRow(ctx.store.getDocument(offer.previous_offer_digest));
}

/** Is this alternative within the ceilings and the owner's rules? */
function versionAllowed(
  ctx: TermContext,
  head: TermOffer,
  policy: TermBuyerPolicy,
  version: { terms: Term[]; promises: TermPromise[] },
): boolean {
  if (!withinCeilings({ ...head, terms: version.terms }, policy)) return false;
  // A promise the pack's vocabulary does not declare, in full, never reaches a
  // binding card (§6): wrong name, wrong keeper, a missing or unknown dimension.
  if (version.promises.some((p, i) => promiseProblem(p, `promises[${String(i)}]`) !== null)) return false;
  return (
    vendorVerdict(ctx, head, policy, version.terms, version.promises).outcome !== 'refused'
  );
}

/** The envelope on one version for the brand, approved in person (hard checks only). */
function vendorVerdict(
  ctx: TermContext,
  head: TermOffer,
  policy: TermBuyerPolicy,
  terms: Term[],
  promises: TermPromise[],
): ReturnType<typeof shelfEnvelope> {
  return shelfEnvelope(ctx, {
    kind: SHELF_VENDOR_KIND,
    holder: 'buyer',
    limits: ceilingLimits(head, policy),
    terms,
    promises,
    general: head.general,
    approvedInPerson: true,
  });
}

/**
 * §8 step 9 — the most the brand has promised at any one time beside a new
 * deal, for one promise kind's counted dimension: the peak over the new
 * deal's dates of the deals running then (two runs in February–March and in
 * April–May never add up), on the same day when the promise names one. An
 * agreement counts while it holds its slot (`heldUntil`: a termination the
 * store has not stored frees nothing); a proposal while undecided and not
 * refused, over its own dates.
 */
function promisedPeak(
  ctx: TermContext,
  args: { name: string; dimension: string; start: string; end: string; day?: string },
): bigint {
  const from = Date.parse(args.start);
  const to = Date.parse(args.end);
  const events: [number, bigint][] = [];
  for (const row of ctx.store.listByKind('term_agreement_proposal', 'outbound')) {
    const status = termAgreementStatus(ctx.store, row.recordDigest);
    if (status.state === 'rejected' || status.state === 'none') continue;
    if (ctx.store.getOutbox(row.recordDigest)?.receiptOutcome === 'refused') continue;
    const dealStart = Math.max(from, Date.parse(status.proposal.general.start));
    const dealEnd = Math.min(
      to,
      status.state === 'accepted' ? Date.parse(status.heldUntil) : Date.parse(status.proposal.general.end),
    );
    if (dealStart >= dealEnd) continue;
    for (const promise of status.proposal.promises ?? []) {
      if (promise.name !== args.name || promise.by !== 'buyer') continue;
      if (args.day !== undefined && promise.dimensions.day !== args.day) continue;
      const v = promise.dimensions[args.dimension];
      if (v === undefined || !/^\d+$/.test(v)) continue;
      events.push([dealStart, BigInt(v)], [dealEnd, -BigInt(v)]);
    }
  }
  // Ends before starts at the same instant: one deal following another never overlaps it.
  events.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  let now = 0n;
  let peak = 0n;
  for (const [, delta] of events) {
    now += delta;
    if (now > peak) peak = now;
  }
  return peak;
}

/**
 * Does this version's promise fit beside what the owner already promised?
 * Only the promise kinds the version itself carries are checked: a version
 * that promises nothing new takes no room.
 */
function withinCapacity(ctx: TermContext, head: TermOffer, promises: readonly TermPromise[]): boolean {
  const all = ctx.deps.valueModels?.(SHELF_VENDOR_KIND, [])?.model.capacities ?? {};
  const mine = new Set(promises.filter((p) => p.by === 'buyer').map((p) => p.name));
  const capacities = Object.fromEntries(Object.entries(all).filter(([name]) => mine.has(name)));
  const already: Record<string, bigint> = {};
  for (const [name, cap] of Object.entries(capacities)) {
    const day = promises.find((p) => p.name === name)?.dimensions.day;
    already[name] = promisedPeak(ctx, {
      name,
      dimension: cap.dimension,
      start: head.general.start,
      end: head.general.end,
      ...(day !== undefined ? { day } : {}),
    });
  }
  return (
    overCapacity({
      capacities,
      already,
      members: [{ parts: shelfParts(head.terms, head.general, promises), months: 1 }],
      mine: (part) => mine.has(part.name),
    }) === null
  );
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
        | 'unbuildable'
        | 'pack_inactive'
        | 'pack_removed'
        | 'commerce_pack_needed'
        | 'ruled_out'
        | 'persona_closed'
        | 'no_room';
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
  // No proposal leaves while the brand half is paused or removed (§4). The
  // inbox task this yes came through cannot reopen, so the card lapses and
  // the negotiation steps back: once the half is resumed, the next sweep
  // raises a fresh card on the same head for the owner to answer. A no
  // still closes the negotiation, paused or not.
  if (args.approve && ctx.deps.activePack('term_buyer') === null) {
    if (!ctx.deps.packHeld('term_buyer')) {
      // Removed or revoked: no resume can bring a card back, so the card and
      // the negotiation close together and the owner is told plainly.
      ctx.atomically('removed_proposal', () => {
        if (!ctx.store.decideCard(args.cardId, 'lapsed', nowMs)) return;
        ctx.store.moveNegotiation({
          requestId: card.requestId,
          from: ['ready'],
          to: 'closed',
          nowMs,
          closeReason: 'pack_removed',
        });
      });
      return { ok: false, refusal: 'pack_removed' };
    }
    ctx.atomically('paused_proposal', () => {
      if (!ctx.store.decideCard(args.cardId, 'lapsed', nowMs)) return;
      ctx.store.moveNegotiation({
        requestId: card.requestId,
        from: ['ready'],
        to: 'negotiating',
        nowMs,
      });
      ctx.store.setNextAction(card.requestId, nowMs, nowMs);
    });
    return { ok: false, refusal: 'pack_inactive' };
  }
  // A shelf deal settles through the Commerce Pack, so none binds without it
  // (COMMITMENT_KERNEL §12). As for a paused half: the card lapses and the
  // negotiation steps back, so once the pack is installed the next sweep
  // asks again on the same head.
  if (args.approve && !ctx.deps.moneyAvailable()) {
    ctx.atomically('no_money_proposal', () => {
      if (!ctx.store.decideCard(args.cardId, 'lapsed', nowMs)) return;
      ctx.store.moveNegotiation({
        requestId: card.requestId,
        from: ['ready'],
        to: 'negotiating',
        nowMs,
      });
      ctx.store.setNextAction(card.requestId, nowMs, nowMs);
    });
    return { ok: false, refusal: 'commerce_pack_needed' };
  }
  if (!args.approve) {
    // The card and the negotiation close together, or a crash between them
    // leaves a `ready` negotiation no card or sweep can move again. A no to
    // one version leaves the others standing; the last no closes it.
    return ctx.atomically('decline_proposal', (): ProposeOutcome => {
      if (!ctx.store.decideCard(args.cardId, 'declined', nowMs))
        return { ok: false, refusal: 'already_decided' };
      if (siblingCards(ctx, card).length > 0) return { ok: true, proposal: null };
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
  // The version this card asked about: the offer's own terms, or one alternative.
  const altId = readTermCardPayloadJson(card.payloadJson)?.alternative_id;
  const version = offerVersions(head).find((v) =>
    typeof altId === 'string' ? v.alternative_id === altId : v.alternative_id === undefined,
  );
  if (version === undefined) return { ok: false, refusal: 'binding_failed' };
  const executing = buildTermProposalApprovalPayload({
    principal: PENDING_PRINCIPAL,
    offer: head,
    ...(policy.renews !== undefined ? { replacesProposalDigest: policy.renews } : {}),
    ...(version.alternative_id !== undefined ? { alternativeId: version.alternative_id } : {}),
  });
  if (!verifyApprovalBinding(approved, executing).ok)
    return { ok: false, refusal: 'binding_failed' };
  if (Date.parse(head.valid_until) <= nowMs) {
    lapseProposalCard(ctx, args.cardId);
    return { ok: false, refusal: 'offer_expired' };
  }
  // The envelope's hard checks on the brand's side: its ceilings, and the
  // owner's never-rules and closed personas for shelf deals (§8).
  const verdict = vendorVerdict(ctx, head, policy, version.terms, version.promises);
  if (verdict.outcome === 'refused' && verdict.reason === 'persona_closed') {
    // The persona closed after the card was raised: the card lapses, the loop
    // steps back and waits, and the owner is asked to open it.
    ctx.atomically('closed_persona_proposal', () => {
      if (!ctx.store.decideCard(args.cardId, 'lapsed', nowMs)) return;
      // The whole set goes: once the persona is open, a fresh set asks again.
      for (const sibling of siblingCards(ctx, card)) {
        ctx.store.decideCard(sibling.cardId, 'lapsed', nowMs);
        ctx.closeCard(sibling.cardId, 'waiting for a persona');
      }
      ctx.store.moveNegotiation({ requestId: card.requestId, from: ['ready'], to: 'negotiating', nowMs });
      ctx.store.setNextAction(card.requestId, nowMs, nowMs);
      raisePersonaCard(ctx, {
        step: 'proposal',
        requestId: card.requestId,
        refDigest: head.offer_digest,
        personas: closedPersonasFor(ctx, SHELF_VENDOR_KIND),
      });
    });
    return { ok: false, refusal: 'persona_closed' };
  }
  // §8 step 9 — a promise the owner's runs cannot carry beside the deals
  // already promised: this version cannot bind; another may.
  if (verdict.outcome !== 'refused' && !withinCapacity(ctx, head, version.promises)) {
    ctx.atomically('no_room_proposal', () => {
      if (!ctx.store.decideCard(args.cardId, 'lapsed', nowMs)) return;
      if (siblingCards(ctx, card).length > 0) return;
      ctx.store.moveNegotiation({
        requestId: card.requestId,
        from: ['ready'],
        to: 'closed',
        nowMs,
        closeReason: 'no_room',
      });
    });
    return { ok: false, refusal: 'no_room' };
  }
  if (verdict.outcome === 'refused') {
    ctx.atomically('ruled_out_proposal', () => {
      if (!ctx.store.decideCard(args.cardId, 'lapsed', nowMs)) return;
      if (siblingCards(ctx, card).length > 0) return;
      ctx.store.moveNegotiation({
        requestId: card.requestId,
        from: ['ready'],
        to: 'closed',
        nowMs,
        closeReason: 'ruled_out',
      });
    });
    return { ok: false, refusal: 'ruled_out' };
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
    terms: version.terms,
    ...(version.alternative_id !== undefined
      ? { alternative_id: version.alternative_id, promises: version.promises }
      : {}),
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
    // A card of a set the negotiation has left (closed, or waiting again)
    // binds nothing: the state is checked in the same transaction.
    if (ctx.store.getNegotiation(card.requestId)?.state !== 'ready') {
      ctx.store.decideCard(args.cardId, 'lapsed', nowMs);
      return;
    }
    if (!ctx.store.decideCard(args.cardId, 'approved', nowMs)) return;
    // One version binds: the other cards for this head close with it.
    for (const sibling of siblingCards(ctx, card)) {
      ctx.store.decideCard(sibling.cardId, 'lapsed', nowMs);
      ctx.closeCard(sibling.cardId, 'another version was sent');
    }
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

/** The loop waited for a persona: look again now (term_persona.ts). */
export function resumeProposal(ctx: TermContext, requestId: string): void {
  const negotiation = ctx.store.getNegotiation(requestId);
  if (negotiation === null || negotiation.state !== 'negotiating') return;
  ctx.store.setNextAction(requestId, ctx.now(), ctx.now());
}

/** The wait for a persona ended unopened: the negotiation closes. */
export function endProposalWait(ctx: TermContext, requestId: string): void {
  ctx.store.moveNegotiation({
    requestId,
    from: ['negotiating', 'ready'],
    to: 'closed',
    nowMs: ctx.now(),
    closeReason: 'persona_closed',
  });
}

/** The other pending cards for the same head (other versions of one offer). */
function siblingCards(ctx: TermContext, card: TermCardRow): TermCardRow[] {
  return ctx.store
    .cardsForRequest(card.requestId, TERM_PROPOSAL_CARD)
    .filter((c) => c.cardId !== card.cardId && c.refDigest === card.refDigest && c.state === 'pending');
}

/** The brand's ceilings as hard limits, in the offer's period. */
function ceilingLimits(head: TermOffer, policy: TermBuyerPolicy): Record<TermName, PartBounds> {
  const ceilings = buyerLimitsIn(policy, 'ceilings', head.general.period);
  const limits = {} as Record<TermName, PartBounds>;
  for (const name of TERM_NAMES) limits[name] = { hard: ceilings[name], auto: ceilings[name] };
  return limits;
}

