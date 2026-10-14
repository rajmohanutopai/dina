/**
 * The seller's side of term negotiation (SHELF_SPACE_NEGOTIATION §5.4, §7.1):
 * a store answering brands.
 *
 * WHAT CORE DECIDES HERE, AND THE RUNNER DOES NOT. The runner proposes terms
 * (term_runner.ts). Core admits the request (listing, pack vocabulary,
 * policy, dates, holding cap, free resource, stranger rule), moves every
 * proposed term to the owner's floors with the holding premium applied,
 * signs offers, decides whether a counter may be answered at all, checks a
 * proposal against the offer it names, and — on the owner's yes — runs the
 * acceptance check in ONE transaction. No refusal ever names a floor or a
 * rule.
 */

import {
  sealTermRecord,
  termListingUri,
  termsFromValues,
  termValues,
  TERM_LISTING_COLLECTION,
  TERM_NAMES,
  validateTermListing,
  validateTermOffer,
  verifyTermCounterAgainstOffer,
  verifyTermOfferAgainstRequest,
  verifyTermOfferRevision,
  verifyTermProposalAgainstOffer,
  verifyTermRenewal,
  verifyTermRequestAgainstListing,
  revshareRecordDigest,
  validateAgreementDecision,
  type AgreementDecision,
  type TermAgreementProposal,
  type TermCounter,
  type TermGeneral,
  type TermListing,
  type TermName,
  type TermOffer,
  type TermRequest,
} from '@dina/commerce-protocol';

import { validateAgainstSchema } from '../../plugins/schema_validate';
import {
  buildTermDecisionApprovalPayload,
  TERM_DECISION_AUTHORITY_DOMAIN,
  verifyApprovalBinding,
  type ApprovingPrincipal,
} from '../approval_payload';
import { termPackEntry } from '../first_party_packs';

import { termAgreementStatus, termHoldingCount, termResourceFree } from './term_agreements';
import { DAY_MS, hash, iso, mintId, TERM_TIMINGS, type TermContext } from './term_context';
import {
  clampTerm,
  sellerAtLeast,
  termBounds,
  type TermListingAccess,
  type TermPolicy,
  type TermResourcePolicy,
} from './term_policy';
import {
  readTermApprovalMaterial,
  readTermCounterRow,
  readTermFloorMaterial,
  readTermListingJson,
  readTermOfferRow,
  readTermPolicyJson,
  readTermProposalRow,
} from './term_rehydrate';
import { DEFAULT_TERM_RUNNER_PARAMS, proposeFirstOffer, proposeRevision } from './term_runner';

import type { TermDocumentRow } from './term_store';

export const TERM_STRANGER_CARD = 'term_stranger_request';
export const TERM_FLOOR_CARD = 'term_floor_approval';
export const TERM_DECISION_CARD = 'term_agreement_decision';

/** What a verifier concluded about one inbound document (§5.3 receipts). */
export type TermVerdict =
  | { outcome: 'stored'; requestId: string; proposalDigest: string }
  | {
      outcome: 'held';
      reason: 'prerequisite' | 'owner_card';
      requestId: string;
      proposalDigest: string;
      expiresAt: number;
    }
  | { outcome: 'refused'; detail: string };

function refused(detail: string): TermVerdict {
  return { outcome: 'refused', detail };
}

export function currentTermPolicy(ctx: TermContext): TermPolicy {
  return readTermPolicyJson(ctx.store.getPolicy()?.policyJson ?? null);
}

/** The offers of one request's chain this node holds in a direction, by revision. */
export function offerChain(
  ctx: TermContext,
  requestId: string,
  direction: 'inbound' | 'outbound',
): { row: TermDocumentRow; offer: TermOffer }[] {
  return ctx.store
    .listByRequest(requestId, 'term_offer')
    .filter((row) => row.direction === direction)
    .map((row) => ({ row, offer: readTermOfferRow(row) }))
    .filter((e): e is { row: TermDocumentRow; offer: TermOffer } => e.offer !== null)
    .sort((a, b) => a.offer.revision - b.offer.revision);
}

// ---------------------------------------------------------------------------
// Listings (§6.1)
// ---------------------------------------------------------------------------

export interface TermListingInput {
  listingId: string;
  resourceRef: string;
  kind: string;
  size?: TermListing['size'];
  region: TermListing['region'];
  tags: string[];
}

/** Record a listing as published here — after its repo write landed, when there is a repo. */
export function storeTermListing(
  ctx: TermContext,
  listing: TermListing,
  access: TermListingAccess,
): void {
  ctx.store.putListing({
    listingId: listing.listing_id,
    resourceRef: listing.resource_ref,
    recordJson: JSON.stringify(listing),
    listingDigest: listing.listing_digest,
    state: 'published',
    recordPublic: true,
    access,
    updatedAt: ctx.now(),
  });
}

/** Build and check a listing without storing it (§6.1). */
export function composeTermListing(
  ctx: TermContext,
  args: TermListingInput,
): { ok: true; listing: TermListing; uri: string } | { ok: false; refusal: string } {
  const pack = ctx.deps.activePack('term_seller');
  if (pack === null) return { ok: false, refusal: 'the Slot Pack (store) is not active' };
  const vocabulary = pack.entry.term?.vocabulary;
  if (vocabulary === undefined) return { ok: false, refusal: 'not a term pack' };
  const policy = currentTermPolicy(ctx);
  // A listing invites requests; with renting off every one would be refused.
  if (!policy.enabled) return { ok: false, refusal: 'turn renting on before listing a slot' };
  const resource = policy.resources.find((r) => r.resource_ref === args.resourceRef);
  if (resource === undefined)
    return { ok: false, refusal: 'set this resource’s terms before listing it' };
  if (!vocabulary.kinds.includes(args.kind))
    return { ok: false, refusal: 'kind: not one this pack lists' };
  const tags = [...new Set(args.tags)].sort();
  for (const tag of tags) {
    if (!vocabulary.tags.includes(tag))
      return { ok: false, refusal: `tags: ${tag} is not one of this pack's categories` };
  }
  const draft = {
    protocol_version: '1.0',
    listing_id: args.listingId,
    seller_did: ctx.self(),
    pack: ctx.packRef(pack),
    resource_ref: args.resourceRef,
    kind: args.kind,
    ...(args.size !== undefined ? { size: args.size } : {}),
    region: args.region,
    available: resource.available,
    tags,
    published_at: iso(ctx.now()),
  };
  const listing = sealTermRecord('term_listing', draft, hash) as unknown as TermListing;
  const bad = validateTermListing(listing, hash);
  if (bad !== null) return { ok: false, refusal: bad };
  return { ok: true, listing, uri: termListingUri(listing) };
}

export function withdrawTermListing(ctx: TermContext, listingId: string): boolean {
  const row = ctx.store.getListing(listingId);
  if (row === null) return false;
  ctx.store.putListing({ ...row, state: 'withdrawn', updatedAt: ctx.now() });
  return true;
}

/**
 * Published listings the current policy no longer backs — renting is off, or
 * the resource has no terms any more. Every request for one is refused, so
 * the public record would only mislead: the policy route withdraws them.
 */
export function listingsOutsidePolicy(ctx: TermContext): string[] {
  const policy = currentTermPolicy(ctx);
  // With the store's half revoked or uninstalled, nothing it published is
  // backed. A PAUSED half is not gone: its listings stay (requests are refused
  // on arrival while paused), so a pause — or a restore — deletes nothing.
  const packHeld = ctx.deps.packHeld('term_seller');
  return ctx.store
    .listListings()
    .filter((row) => row.state === 'published')
    .filter(
      (row) =>
        !packHeld ||
        !policy.enabled ||
        !policy.resources.some((r) => r.resource_ref === row.resourceRef),
    )
    .map((row) => row.listingId);
}

/**
 * The listing a request names, if this node publishes it now (§5.3 first
 * contact), with who may ask about it (§6.2).
 */
export function publishedListingFor(
  ctx: TermContext,
  request: { listing_uri: string; listing_digest: string },
): { listing: TermListing; access: TermListingAccess } | null {
  const prefix = `at://${ctx.self()}/${TERM_LISTING_COLLECTION}/`;
  if (!request.listing_uri.startsWith(prefix)) return null;
  const row = ctx.store.getListing(request.listing_uri.slice(prefix.length));
  if (row === null || row.state !== 'published' || row.listingDigest !== request.listing_digest)
    return null;
  const listing = readTermListingJson(row.recordJson);
  return listing === null ? null : { listing, access: row.access };
}

// ---------------------------------------------------------------------------
// Requests and the first offer
// ---------------------------------------------------------------------------

function holdingRuleFor(policy: TermPolicy, tag: string): { premium: number; max?: number } {
  const rule = policy.holding_rules.find((r) => r.tag === tag);
  return rule === undefined
    ? { premium: 0 }
    : {
        premium: rule.premium_bps_per_count,
        ...(rule.max_count !== undefined ? { max: rule.max_count } : {}),
      };
}

function heldCountFor(
  ctx: TermContext,
  policy: TermPolicy,
  args: { tag: string; start: string; end: string; renews?: string },
): number {
  return termHoldingCount({
    store: ctx.store,
    selfDid: ctx.self(),
    manualHoldings: policy.manual_holdings,
    tag: args.tag,
    start: args.start,
    end: args.end,
    nowMs: ctx.now(),
    ...(args.renews !== undefined ? { renews: args.renews } : {}),
  });
}

/**
 * Admit a stranger's or contact's request (§7.1 step 1). `ownerApproved` is
 * set when the owner said yes to the stranger card, so the access rule is
 * already satisfied.
 */
export function admitTermRequest(
  ctx: TermContext,
  args: { senderDid: string; request: TermRequest; evidenceJson: string; ownerApproved?: boolean },
): TermVerdict {
  const { request } = args;
  const nowMs = ctx.now();
  if (request.seller_did !== ctx.self()) return refused('the request names another seller');
  if (request.buyer_did !== args.senderDid) return refused('the request names another buyer');
  const pack = ctx.deps.activePack('term_seller');
  const entry = termPackEntry(request.pack, 'term_seller');
  if (pack === null || entry === null || entry.pluginId !== pack.entry.pluginId) {
    return refused('this node does not answer that pack');
  }
  const published = publishedListingFor(ctx, request);
  if (published === null) return refused('the request names no listing this node publishes');
  const { listing, access } = published;
  const listingError = verifyTermRequestAgainstListing(request, listing);
  if (listingError !== null) return refused(listingError);
  const vocabulary = entry.term?.vocabulary;
  if (
    vocabulary === undefined ||
    !validateAgainstSchema(
      { tag: request.general.tag, attributes: request.attributes },
      vocabulary.requestParamsSchema,
    ).ok
  ) {
    return refused('the request does not fit the pack’s schema');
  }
  if (Date.parse(request.respond_by) <= nowMs) return refused('the request’s deadline has passed');
  const policy = currentTermPolicy(ctx);
  const resource = policy.resources.find((r) => r.resource_ref === request.resource_ref);
  if (!policy.enabled || resource === undefined) return refused('not offered');
  if (resource.currency !== request.general.currency)
    return refused('not offered in that currency');
  const start = Date.parse(request.general.start);
  const end = Date.parse(request.general.end);
  if (start < Date.parse(resource.available.from) || end > Date.parse(resource.available.to)) {
    return refused('not available for those dates');
  }
  // No rule is named: a stranger learns "no", never which cap or which slot.
  const rule = holdingRuleFor(policy, request.general.tag);
  const held = heldCountFor(ctx, policy, request.general);
  if (rule.max !== undefined && held >= rule.max) return refused('not offered');
  if (
    !termResourceFree({
      store: ctx.store,
      selfDid: ctx.self(),
      manualHoldings: policy.manual_holdings,
      resourceRef: request.resource_ref,
      start: request.general.start,
      end: request.general.end,
      nowMs,
    })
  ) {
    return refused('not offered');
  }
  // §5.3 — a request spends probing budget like a quote request, once: at its
  // first admission, after every refusal (a refused request must not spend).
  // The owner's yes on a stranger card re-runs these checks without spending
  // again.
  if (args.ownerApproved !== true && !ctx.deps.spendProbing(args.senderDid, nowMs))
    return refused('not now');
  // §6.2 — a stranger asking about a `contacts_or_card` listing waits for the owner's card.
  if (
    args.ownerApproved !== true &&
    !ctx.deps.isContact(args.senderDid) &&
    access === 'contacts_or_card'
  ) {
    return {
      outcome: 'held',
      reason: 'owner_card',
      requestId: request.request_id,
      proposalDigest: '',
      expiresAt: Date.parse(request.respond_by),
    };
  }
  ctx.store.putDocument({
    recordDigest: request.request_digest,
    kind: 'term_request',
    counterpartyDid: args.senderDid,
    requestId: request.request_id,
    proposalDigest: '',
    answersDigest: '',
    direction: 'inbound',
    recordJson: JSON.stringify(request),
    evidenceJson: args.evidenceJson,
    createdAt: nowMs,
  });
  issueFirstOffer(ctx, { request, policy, resource, pack: pack });
  return { outcome: 'stored', requestId: request.request_id, proposalDigest: '' };
}

/** The general block a store's conditions give a request (§5.2). */
function generalFor(request: TermRequest, resource: TermResourcePolicy): TermGeneral {
  const c = resource.conditions;
  const general: TermGeneral = {
    tag: request.general.tag,
    currency: request.general.currency,
    period: c.period,
    cash_handler: c.cash_handler,
    start: request.general.start,
    end: request.general.end,
    exit_notice_days: c.exit_notice_days,
  };
  if (c.trial !== undefined) {
    const trialEnd = Math.min(
      Date.parse(request.general.start) + c.trial.days * DAY_MS,
      Date.parse(request.general.end),
    );
    general.trial = {
      end: iso(trialEnd),
      fee: { currency: request.general.currency, minor_units: c.trial.fee_minor },
    };
  }
  if (c.stock_duties !== undefined) general.stock_duties = c.stock_duties;
  return general;
}

function boundsFor(
  ctx: TermContext,
  policy: TermPolicy,
  resource: TermResourcePolicy,
  general: TermGeneral,
  renews?: string,
): Record<TermName, ReturnType<typeof termBounds>> {
  const rule = holdingRuleFor(policy, general.tag);
  const held = heldCountFor(ctx, policy, {
    tag: general.tag,
    start: general.start,
    end: general.end,
    ...(renews !== undefined ? { renews } : {}),
  });
  const out = {} as Record<TermName, ReturnType<typeof termBounds>>;
  for (const name of TERM_NAMES) out[name] = termBounds(resource, name, held, rule.premium);
  return out;
}

function issueFirstOffer(
  ctx: TermContext,
  args: {
    request: TermRequest;
    policy: TermPolicy;
    resource: TermResourcePolicy;
    pack: NonNullable<ReturnType<TermContext['deps']['activePack']>>;
  },
): TermOffer | null {
  const { request, resource, policy } = args;
  const nowMs = ctx.now();
  const general = generalFor(request, resource);
  const asking = {} as Record<TermName, bigint>;
  for (const name of TERM_NAMES) asking[name] = BigInt(resource.asking[name]);
  const proposed = proposeFirstOffer(asking);
  const bounds = boundsFor(ctx, policy, resource, general);
  // The first offer never asks the owner: anything short of the automatic
  // limit (asking terms below a premium-raised floor) is simply raised to it.
  const signed = {} as Record<TermName, bigint>;
  for (const name of TERM_NAMES) {
    signed[name] = sellerAtLeast(name, proposed[name], bounds[name].auto)
      ? proposed[name]
      : bounds[name].auto;
  }
  const draft = {
    protocol_version: request.protocol_version,
    offer_id: mintId('toff'),
    request_id: request.request_id,
    request_digest: request.request_digest,
    seller_did: ctx.self(),
    buyer_did: request.buyer_did,
    pack: request.pack,
    resource_ref: request.resource_ref,
    attributes: request.attributes,
    general,
    terms: termsFromValues(signed),
    issued_at: iso(nowMs),
    valid_until: iso(nowMs + TERM_TIMINGS.offerValidForMs),
    revision: 1,
  };
  const offer = sealTermRecord('term_offer', draft, hash) as unknown as TermOffer;
  // Authoring runs the inbound rules on itself: never send what the other side refuses.
  if (
    validateTermOffer(offer, hash) !== null ||
    verifyTermOfferAgainstRequest(offer, request) !== null
  ) {
    ctx.log('term.offer_unbuildable', { request: request.request_id });
    return null;
  }
  storeAndSendOffer(ctx, offer, request.request_digest);
  return offer;
}

function storeAndSendOffer(ctx: TermContext, offer: TermOffer, answers: string): void {
  // The offer and its send intent land together (inside an ingest, its
  // transaction; on its own, this one).
  ctx.atomically('offer', () => storeAndEnqueueOffer(ctx, offer, answers));
}

function storeAndEnqueueOffer(ctx: TermContext, offer: TermOffer, answers: string): void {
  ctx.store.putDocument({
    recordDigest: offer.offer_digest,
    kind: 'term_offer',
    counterpartyDid: offer.buyer_did,
    requestId: offer.request_id,
    proposalDigest: '',
    answersDigest: answers,
    direction: 'outbound',
    recordJson: JSON.stringify(offer),
    evidenceJson: '{}',
    createdAt: ctx.now(),
  });
  ctx.enqueue({
    toDid: offer.buyer_did,
    kind: 'term_offer',
    digest: offer.offer_digest,
    document: offer,
    stopAtMs: Date.parse(offer.valid_until),
  });
}

// ---------------------------------------------------------------------------
// Counters (§7.1 step 3)
// ---------------------------------------------------------------------------

export function admitTermCounter(
  ctx: TermContext,
  args: { senderDid: string; counter: TermCounter; evidenceJson: string },
): TermVerdict {
  const { counter } = args;
  const nowMs = ctx.now();
  const named = ctx.store.getDocument(counter.offer_digest);
  if (named === null || named.kind !== 'term_offer' || named.direction !== 'outbound') {
    return refused('the counter names no offer this node made');
  }
  const namedOffer = readTermOfferRow(named);
  if (namedOffer === null) return refused('the named offer cannot be read');
  const bindError = verifyTermCounterAgainstOffer(counter, namedOffer);
  if (bindError !== null) return refused(bindError);
  if (counter.buyer_did !== args.senderDid) return refused('the counter names another buyer');
  // One id names one counter: a different body under a recorded id is refused.
  const earlier = ctx.store.listByRequest(namedOffer.request_id, 'term_counter');
  for (const row of earlier) {
    const c = readTermCounterRow(row);
    if (c !== null && c.counter_id === counter.counter_id)
      return refused('that counter id names another counter');
  }
  const chain = offerChain(ctx, namedOffer.request_id, 'outbound');
  const head = chain[chain.length - 1];
  const first = chain[0];
  if (head === undefined || first === undefined) return refused('no chain');
  const policy = currentTermPolicy(ctx);
  const resource = policy.resources.find((r) => r.resource_ref === namedOffer.resource_ref);
  if (!policy.enabled || resource === undefined || ctx.deps.activePack('term_seller') === null)
    return refused('not offered');
  if (Date.parse(counter.respond_by) <= nowMs) return refused('the counter’s deadline has passed');
  if (nowMs > Date.parse(first.offer.issued_at) + policy.windowSeconds * 1000)
    return refused('the negotiation window has closed');
  // Core counts its own records; the round the buyer writes is not trusted.
  if (earlier.length >= policy.maxRounds) return refused('no more rounds');
  const dayAgo = nowMs - DAY_MS;
  const recentFromBuyer = ctx.store
    .listByKind('term_counter', 'inbound')
    .filter((row) => row.counterpartyDid === args.senderDid && row.createdAt > dayAgo).length;
  if (recentFromBuyer >= policy.maxCountersPerBuyerPerDay)
    return refused('too many counters today');
  if (!ctx.deps.spendProbing(args.senderDid, nowMs)) return refused('not now');
  ctx.store.putDocument({
    recordDigest: counter.counter_digest,
    kind: 'term_counter',
    counterpartyDid: args.senderDid,
    requestId: namedOffer.request_id,
    proposalDigest: '',
    answersDigest: counter.offer_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(counter),
    evidenceJson: args.evidenceJson,
    createdAt: nowMs,
  });
  if (head.offer.offer_digest !== counter.offer_digest) {
    // A counter on a stale head is answered with the current head.
    ctx.resend(head.offer.buyer_did, 'term_offer', head.offer);
    return { outcome: 'stored', requestId: namedOffer.request_id, proposalDigest: '' };
  }
  answerCounter(ctx, { counter, head: head.offer, policy, resource });
  return { outcome: 'stored', requestId: namedOffer.request_id, proposalDigest: '' };
}

function answerCounter(
  ctx: TermContext,
  args: { counter: TermCounter; head: TermOffer; policy: TermPolicy; resource: TermResourcePolicy },
): void {
  const { counter, head, policy, resource } = args;
  const params =
    ctx.deps.activePack('term_seller')?.entry.term?.runner ?? DEFAULT_TERM_RUNNER_PARAMS;
  const current = termValues(head.terms);
  const targets: Partial<Record<TermName, bigint>> = {};
  for (const name of TERM_NAMES) {
    const t = counter.targets[name];
    if (t !== undefined) targets[name] = BigInt(t);
  }
  const proposed = proposeRevision({ current, targets, params });
  const bounds = boundsFor(ctx, policy, resource, head.general);
  const authorised = ctx.store.floorAuthorizations(head.request_id);
  const signed = {} as Record<TermName, bigint>;
  const asked: Partial<Record<TermName, bigint>> = {};
  for (const name of TERM_NAMES) {
    // The owner raised a floor since the head was signed: the head no longer
    // stands for that term, so hold rather than revise around it.
    if (!sellerAtLeast(name, current[name], bounds[name].hard)) {
      resendHead(ctx, head);
      return;
    }
    const clamp = clampTerm(name, proposed[name], bounds[name], authorised.get(name) ?? null);
    // A revision never retreats from what the buyer already holds.
    signed[name] = sellerAtLeast(name, clamp.value, current[name]) ? current[name] : clamp.value;
    if (clamp.needsOwner) asked[name] = clamp.asked;
  }
  if (Object.keys(asked).length > 0) raiseFloorCard(ctx, { head, asked, signed });
  if (TERM_NAMES.every((name) => signed[name] === current[name])) {
    resendHead(ctx, head);
    return;
  }
  signRevision(ctx, head, signed, counter.counter_digest);
}

/** Sign, store and send revision N+1 of `head` with these values. */
function signRevision(
  ctx: TermContext,
  head: TermOffer,
  signed: Record<TermName, bigint>,
  answers: string,
): void {
  const nowMs = ctx.now();
  const { offer_digest: _d, previous_offer_digest: _p, ...rest } = head;
  const draft = {
    ...rest,
    terms: termsFromValues(signed),
    issued_at: iso(nowMs),
    valid_until: iso(nowMs + TERM_TIMINGS.offerValidForMs),
    revision: head.revision + 1,
    previous_offer_digest: head.offer_digest,
  };
  const next = sealTermRecord('term_offer', draft, hash) as unknown as TermOffer;
  if (validateTermOffer(next, hash) !== null || verifyTermOfferRevision(head, next) !== null) {
    ctx.log('term.revision_unbuildable', { request: head.request_id });
    return;
  }
  storeAndSendOffer(ctx, next, answers);
}

function resendHead(ctx: TermContext, head: TermOffer): void {
  ctx.resend(head.buyer_did, 'term_offer', head);
}

/** One card per request while a floor question is open (§5.4). */
function raiseFloorCard(
  ctx: TermContext,
  args: {
    head: TermOffer;
    asked: Partial<Record<TermName, bigint>>;
    signed: Record<TermName, bigint>;
  },
): void {
  const open = ctx.store
    .cardsForRequest(args.head.request_id, TERM_FLOOR_CARD)
    .some((c) => c.state === 'pending');
  if (open) return;
  const cardId = `term-floor-${args.head.offer_digest.slice(0, 32)}`;
  const asked: Record<string, string> = {};
  for (const [name, value] of Object.entries(args.asked))
    asked[name] = (value as bigint).toString(10);
  const payload = {
    type: TERM_FLOOR_CARD,
    card_id: cardId,
    request_id: args.head.request_id,
    buyer_did: args.head.buyer_did,
    resource_ref: args.head.resource_ref,
    currency: args.head.general.currency,
    asked,
    offered: Object.fromEntries(TERM_NAMES.map((n) => [n, args.signed[n].toString(10)])),
  };
  const decideBy = Date.parse(args.head.valid_until) + DAY_MS;
  ctx.raiseCard({
    cardId,
    type: TERM_FLOOR_CARD,
    requestId: args.head.request_id,
    refDigest: args.head.offer_digest,
    description: 'A brand asks for terms past your automatic limit. Offer them?',
    payload,
    decideBy,
  });
}

/**
 * The owner's yes authorises the asked values, and the store offers them at
 * once: a revision of the current head with each asked term moved to its
 * authorised value and every other term as it stands. The yes must reach the
 * brand, who may have stopped countering by now (it reads a resent head as a
 * hold, and its rounds may be spent); a brand that already took the older
 * offer to its owner lets that card lapse for the newer one.
 */
export function decideFloorCard(ctx: TermContext, cardId: string, approve: boolean): boolean {
  const card = ctx.store.getCard(cardId);
  if (card === null || card.cardType !== TERM_FLOOR_CARD) return false;
  // The yes, every value it authorises and the revision it allows land together.
  return ctx.atomically('floor_decision', () => {
    if (!ctx.store.decideCard(cardId, approve ? 'approved' : 'declined', ctx.now())) return false;
    if (!approve) return true;
    const asked = readTermFloorMaterial(card.materialJson);
    for (const [name, value] of Object.entries(asked ?? {})) {
      ctx.store.putFloorAuthorization({
        requestId: card.requestId,
        termName: name,
        value,
        cardId,
        createdAt: ctx.now(),
      });
    }
    offerAuthorised(ctx, card.requestId);
    return true;
  });
}

/**
 * Revise the head to the values the owner authorised, under the floors in
 * force now. Nothing is sent when the negotiation can no longer move (renting
 * off, the slot gone, the store's half not held, the window closed) or when
 * the head already gives the brand as much.
 */
function offerAuthorised(ctx: TermContext, requestId: string): void {
  const chain = offerChain(ctx, requestId, 'outbound');
  const head = chain[chain.length - 1]?.offer;
  const first = chain[0]?.offer;
  if (head === undefined || first === undefined) return;
  const policy = currentTermPolicy(ctx);
  const resource = policy.resources.find((r) => r.resource_ref === head.resource_ref);
  if (!policy.enabled || resource === undefined || ctx.deps.activePack('term_seller') === null)
    return;
  if (ctx.now() > Date.parse(first.issued_at) + policy.windowSeconds * 1000) return;
  // The brand already proposed on this head: the deal goes ahead on it, and a
  // revision now would only make that proposal stale.
  if (
    ctx.store
      .listByRequest(requestId, 'term_agreement_proposal')
      .some((row) => readTermProposalRow(row)?.offer_digest === head.offer_digest)
  )
    return;
  const bounds = boundsFor(ctx, policy, resource, head.general);
  const authorised = ctx.store.floorAuthorizations(requestId);
  const current = termValues(head.terms);
  const signed = { ...current };
  for (const name of TERM_NAMES) {
    const value = authorised.get(name);
    // Only a concession the owner allowed.
    if (value !== undefined && !sellerAtLeast(name, value, current[name])) signed[name] = value;
  }
  if (TERM_NAMES.every((name) => signed[name] === current[name])) return;
  // Every term of what is signed — moved or carried over — clears the hard
  // floor in force now (a floor raised since the head was signed holds it).
  if (!TERM_NAMES.every((name) => sellerAtLeast(name, signed[name], bounds[name].hard))) return;
  signRevision(ctx, head, signed, head.offer_digest);
}

/**
 * The offer a brand's proposal may bind: the chain's head — or the one just
 * before it when the head was signed on the owner's floor-card yes. A brand
 * that proposed on the older offer while the yes was being sent (its
 * proposal in flight, or its phone offline) still has a deal: the older offer
 * is at least as good for the store on every term, since a yes only concedes.
 */
function bindsAsHead(ctx: TermContext, offer: TermOffer): boolean {
  const chain = offerChain(ctx, offer.request_id, 'outbound');
  const head = chain[chain.length - 1];
  if (head === undefined) return false;
  if (head.offer.offer_digest === offer.offer_digest) return true;
  // `signRevision` records a yes-revision as answering the offer it revises;
  // a counter's revision answers the counter.
  return (
    head.offer.previous_offer_digest === offer.offer_digest &&
    head.row.answersDigest === offer.offer_digest
  );
}

// ---------------------------------------------------------------------------
// The stranger card (§6.2)
// ---------------------------------------------------------------------------

export function raiseStrangerCard(ctx: TermContext, request: TermRequest): void {
  const cardId = `term-stranger-${request.request_digest.slice(0, 32)}`;
  const payload = {
    type: TERM_STRANGER_CARD,
    card_id: cardId,
    request_id: request.request_id,
    buyer_did: request.buyer_did,
    resource_ref: request.resource_ref,
    tag: request.general.tag,
    start: request.general.start,
    end: request.general.end,
  };
  const decideBy = Date.parse(request.respond_by);
  ctx.raiseCard({
    cardId,
    type: TERM_STRANGER_CARD,
    requestId: request.request_id,
    refDigest: request.request_digest,
    description: 'A brand you do not know asks about one of your slots. Let them negotiate?',
    payload,
    decideBy,
  });
}

// ---------------------------------------------------------------------------
// Proposals: the arrival check (§7.1 step 5)
// ---------------------------------------------------------------------------

/** Author and send a decision on an inbound proposal. */
function authorDecision(
  ctx: TermContext,
  proposal: TermAgreementProposal,
  kind: 'accepted' | 'rejected',
): AgreementDecision | null {
  const draft = {
    protocol_version: proposal.protocol_version,
    decision_id: mintId('tdec'),
    proposal_digest: proposal.proposal_digest,
    kind,
    decided_at: iso(ctx.now()),
  };
  const decision = {
    ...draft,
    decision_digest: revshareRecordDigest('agreement_decision', draft, hash),
  } as AgreementDecision;
  if (validateAgreementDecision(decision, hash) !== null) return null;
  return ctx.atomically('decision', () => storeAndEnqueueDecision(ctx, proposal, decision));
}

function storeAndEnqueueDecision(
  ctx: TermContext,
  proposal: TermAgreementProposal,
  decision: AgreementDecision,
): AgreementDecision | null {
  const stored = ctx.store.putDocument({
    recordDigest: decision.decision_digest,
    kind: 'agreement_decision',
    counterpartyDid: proposal.vendor_did,
    requestId: ctx.store.requestOf(proposal.proposal_digest) ?? '',
    proposalDigest: proposal.proposal_digest,
    answersDigest: proposal.proposal_digest,
    direction: 'outbound',
    recordJson: JSON.stringify(decision),
    evidenceJson: '{}',
    createdAt: ctx.now(),
  });
  if (!stored) return null;
  ctx.enqueue({
    toDid: proposal.vendor_did,
    kind: 'term_decision',
    digest: decision.decision_digest,
    document: decision,
    stopAtMs: ctx.now() + TERM_TIMINGS.agreementResendForMs,
  });
  return decision;
}

export function admitTermProposal(
  ctx: TermContext,
  args: { senderDid: string; proposal: TermAgreementProposal; evidenceJson: string },
): TermVerdict {
  const { proposal } = args;
  const nowMs = ctx.now();
  if (proposal.host_did !== ctx.self()) return refused('the proposal names another host');
  if (proposal.vendor_did !== args.senderDid) return refused('the proposal names another vendor');
  const offerRow = ctx.store.getDocument(proposal.offer_digest);
  if (offerRow === null || offerRow.kind !== 'term_offer' || offerRow.direction !== 'outbound') {
    return refused('the proposal names no offer this node made');
  }
  const offer = readTermOfferRow(offerRow);
  if (offer === null) return refused('the named offer cannot be read');
  // One proposal per offer: a second, different one is refused.
  const others = ctx.store
    .listByRequest(offer.request_id, 'term_agreement_proposal')
    .filter((r) => r.recordDigest !== proposal.proposal_digest);
  if (others.some((r) => readTermProposalRow(r)?.offer_digest === proposal.offer_digest)) {
    return refused('the offer already has a proposal');
  }
  ctx.store.putDocument({
    recordDigest: proposal.proposal_digest,
    kind: 'term_agreement_proposal',
    counterpartyDid: args.senderDid,
    requestId: offer.request_id,
    proposalDigest: proposal.proposal_digest,
    answersDigest: proposal.replaces_proposal_digest ?? proposal.offer_digest,
    direction: 'inbound',
    recordJson: JSON.stringify(proposal),
    evidenceJson: args.evidenceJson,
    createdAt: nowMs,
  });
  const verdict: TermVerdict = {
    outcome: 'stored',
    requestId: offer.request_id,
    proposalDigest: proposal.proposal_digest,
  };
  const failure = arrivalFailure(ctx, proposal, offer, nowMs);
  if (failure !== null) {
    // §7.1 step 5 — an automatic rejection with no detail, so the brand's card closes.
    ctx.log('term.proposal_rejected_on_arrival', { request: offer.request_id });
    authorDecision(ctx, proposal, 'rejected');
    return verdict;
  }
  raiseDecisionCard(ctx, proposal, nowMs);
  return verdict;
}

function arrivalFailure(
  ctx: TermContext,
  proposal: TermAgreementProposal,
  offer: TermOffer,
  nowMs: number,
): string | null {
  // A paused or removed store half makes no new deals; follow-ups to deals it
  // already made still land (their admitters do not ask).
  if (ctx.deps.activePack('term_seller') === null) return 'not offered';
  if (!bindsAsHead(ctx, offer)) return 'not the head';
  if (offer.buyer_did !== proposal.vendor_did) return 'addressed to another buyer';
  const pair = verifyTermProposalAgainstOffer(proposal, offer);
  if (pair !== null) return pair;
  // Judged on the signed `proposed_at` (§7.1 step 5), bounded by a 7-day arrival window.
  if (Date.parse(proposal.proposed_at) > Date.parse(offer.valid_until))
    return 'proposed after the offer expired';
  if (nowMs > Date.parse(offer.valid_until) + TERM_TIMINGS.proposalArrivalGraceMs)
    return 'arrived too late';
  if (proposal.replaces_proposal_digest !== undefined) {
    const renewed = termAgreementStatus(ctx.store, proposal.replaces_proposal_digest);
    if (renewed.state !== 'accepted' || renewed.proposal.host_did !== ctx.self())
      return 'renews nothing';
    const renewal = verifyTermRenewal(renewed.proposal, proposal);
    if (renewal !== null) return renewal;
  }
  return null;
}

const PENDING_PRINCIPAL: ApprovingPrincipal = {
  principalDid: null,
  authorityDomain: TERM_DECISION_AUTHORITY_DOMAIN,
  policyRevision: null,
};

function raiseDecisionCard(ctx: TermContext, proposal: TermAgreementProposal, nowMs: number): void {
  const cardId = `term-decision-${proposal.proposal_digest.slice(0, 32)}`;
  const decideBy = nowMs + TERM_TIMINGS.decideByMs;
  const binding = buildTermDecisionApprovalPayload({ principal: PENDING_PRINCIPAL, proposal });
  const policy = currentTermPolicy(ctx);
  const rule = holdingRuleFor(policy, proposal.general.tag);
  const held = heldCountFor(ctx, policy, {
    tag: proposal.general.tag,
    start: proposal.general.start,
    end: proposal.general.end,
    ...(proposal.replaces_proposal_digest !== undefined
      ? { renews: proposal.replaces_proposal_digest }
      : {}),
  });
  const payload = {
    type: TERM_DECISION_CARD,
    card_id: cardId,
    request_id: ctx.store.requestOf(proposal.proposal_digest) ?? '',
    proposal_digest: proposal.proposal_digest,
    vendor_did: proposal.vendor_did,
    resource_ref: proposal.resource_ref,
    general: proposal.general,
    terms: proposal.terms,
    // How the holding rule moved the price (§7.1): the count and the rate, never a floor.
    holding: { tag: proposal.general.tag, already_held: held, premium_bps_per_count: rule.premium },
    decide_by: iso(decideBy),
  };
  ctx.raiseCard({
    cardId,
    type: TERM_DECISION_CARD,
    requestId: payload.request_id,
    refDigest: proposal.proposal_digest,
    material: binding,
    description: 'A brand proposes a slot agreement. Accept it?',
    payload,
    decideBy,
  });
}

// ---------------------------------------------------------------------------
// The store's decision: the acceptance check (§7.1 step 6)
// ---------------------------------------------------------------------------

export type TermDecisionOutcome =
  | { ok: true; decision: 'accepted' | 'rejected'; decisionDigest: string }
  | {
      ok: false;
      refusal:
        | 'unknown_card'
        | 'already_decided'
        | 'binding_failed'
        | 'no_longer_available'
        | 'lapsed';
    };

/**
 * The owner decided the store's card — through the owner-only,
 * presence-gated approval route, which is what establishes WHO decided. A no
 * sends a rejection. A yes runs the
 * acceptance check and records the agreement as accepted IN ONE TRANSACTION,
 * so a second acceptance counts this one; a failed check sends a rejection
 * and says the deal is no longer available.
 */
export function decideTermProposal(
  ctx: TermContext,
  args: { cardId: string; approve: boolean },
): TermDecisionOutcome {
  const card = ctx.store.getCard(args.cardId);
  if (card === null || card.cardType !== TERM_DECISION_CARD)
    return { ok: false, refusal: 'unknown_card' };
  if (card.state !== 'pending') return { ok: false, refusal: 'already_decided' };
  // An answer that reaches Core after the card's time is the lapse the sweep
  // would have made a moment later: the brand was told the card stands until
  // then, so nothing binds after it.
  if (ctx.now() >= card.decideBy) {
    lapseDecisionCard(ctx, args.cardId);
    return { ok: false, refusal: 'lapsed' };
  }
  const proposal = readTermProposalRow(ctx.store.getDocument(card.refDigest));
  if (proposal === null) return { ok: false, refusal: 'unknown_card' };
  // Written inside the transaction; a box, because a closure's assignment is
  // invisible to the compiler's narrowing.
  const result: { outcome: TermDecisionOutcome } = {
    outcome: { ok: false, refusal: 'already_decided' },
  };
  ctx.atomically('decide_proposal', () => {
    const nowMs = ctx.now();
    if (!args.approve) {
      if (!ctx.store.decideCard(args.cardId, 'declined', nowMs)) return;
      const decision = authorDecision(ctx, proposal, 'rejected');
      result.outcome =
        decision === null
          ? { ok: false, refusal: 'already_decided' }
          : { ok: true, decision: 'rejected', decisionDigest: decision.decision_digest };
      return;
    }
    // FR-P5 — what the owner saw is what executes.
    const approved = readTermApprovalMaterial(card.materialJson);
    const executing = buildTermDecisionApprovalPayload({ principal: PENDING_PRINCIPAL, proposal });
    if (approved === null || !verifyApprovalBinding(approved, executing).ok) {
      result.outcome = { ok: false, refusal: 'binding_failed' };
      return;
    }
    if (!ctx.store.decideCard(args.cardId, 'approved', nowMs)) return;
    if (acceptanceFailure(ctx, proposal, nowMs) !== null) {
      const decision = authorDecision(ctx, proposal, 'rejected');
      result.outcome =
        decision === null
          ? { ok: false, refusal: 'already_decided' }
          : { ok: false, refusal: 'no_longer_available' };
      return;
    }
    const decision = authorDecision(ctx, proposal, 'accepted');
    result.outcome =
      decision === null
        ? { ok: false, refusal: 'already_decided' }
        : { ok: true, decision: 'accepted', decisionDigest: decision.decision_digest };
  });
  const outcome = result.outcome;
  if (outcome.ok) ctx.log('term.decided', { decision: outcome.decision });
  return outcome;
}

function acceptanceFailure(
  ctx: TermContext,
  proposal: TermAgreementProposal,
  nowMs: number,
): string | null {
  if (termAgreementStatus(ctx.store, proposal.proposal_digest).state !== 'proposed')
    return 'already decided';
  if (ctx.deps.activePack('term_seller') === null) return 'not offered';
  const offerRow = ctx.store.getDocument(proposal.offer_digest);
  const offer = readTermOfferRow(offerRow);
  if (offer === null) return 'offer gone';
  if (!bindsAsHead(ctx, offer)) return 'not the head';
  const policy = currentTermPolicy(ctx);
  const resource = policy.resources.find((r) => r.resource_ref === proposal.resource_ref);
  if (!policy.enabled || resource === undefined) return 'not offered';
  const renews = proposal.replaces_proposal_digest;
  // The owner is present and approving these terms, so the HARD floor (with
  // the premium for what is held now) is the line, not the automatic one.
  const bounds = boundsFor(ctx, policy, resource, proposal.general, renews);
  const values = termValues(proposal.terms);
  for (const name of TERM_NAMES) {
    if (!sellerAtLeast(name, values[name], bounds[name].hard)) return 'below the floor in force';
  }
  const rule = holdingRuleFor(policy, proposal.general.tag);
  const held = heldCountFor(ctx, policy, {
    tag: proposal.general.tag,
    start: proposal.general.start,
    end: proposal.general.end,
    ...(renews !== undefined ? { renews } : {}),
  });
  if (rule.max !== undefined && held >= rule.max) return 'the tag is full';
  const free = termResourceFree({
    store: ctx.store,
    selfDid: ctx.self(),
    manualHoldings: policy.manual_holdings,
    resourceRef: proposal.resource_ref,
    start: proposal.general.start,
    end: proposal.general.end,
    nowMs,
    ...(renews !== undefined ? { renews } : {}),
  });
  return free ? null : 'the resource is taken';
}

/** A store card that lapsed: the brand gets a rejection (§7.1 step 5). */
export function lapseDecisionCard(ctx: TermContext, cardId: string): void {
  const card = ctx.store.getCard(cardId);
  if (card === null || card.cardType !== TERM_DECISION_CARD) return;
  ctx.atomically('lapse_decision', () => {
    if (!ctx.store.decideCard(cardId, 'lapsed', ctx.now())) return;
    const proposal = readTermProposalRow(ctx.store.getDocument(card.refDigest));
    if (proposal !== null) authorDecision(ctx, proposal, 'rejected');
  });
}
