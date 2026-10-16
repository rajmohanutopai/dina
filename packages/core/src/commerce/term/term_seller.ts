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
  type TermAlternative,
  type TermCounter,
  type TermGeneral,
  type TermListing,
  type TermName,
  type TermOffer,
  type TermRequest,
  partsOnOffer,
  renderTermMessage,
  type TermMessage,
} from '@dina/commerce-protocol';

import {
  bindableDigests,
  firstWithinLimits,
  judgeLateness,
  ownerConcession,
  projectModel,
  reviseWithinLimits,
  type DealVersion,
  type PartBounds,
  type StrategyMove,
} from '../../commitment';
import { validateAgainstSchema } from '../../plugins/schema_validate';
import {
  buildTermDecisionApprovalPayload,
  TERM_DECISION_AUTHORITY_DOMAIN,
  verifyApprovalBinding,
  type ApprovingPrincipal,
} from '../approval_payload';
import { termPackEntry } from '../first_party_packs';
import { SLOT_PACK_PARTS } from '../slot_pack_manifests';

import { termAgreementStatus, termHoldingCount, termResourceFree } from './term_agreements';
import { DAY_MS, hash, iso, mintId, TERM_TIMINGS, type TermContext } from './term_context';
import {
  SHELF_HOST_KIND,
  shelfBindingCard,
  shelfEnvelope,
  shelfSigningBlocked,
  shelfWorth,
  raiseStrategyNotice,
  strategyBudgetLeft,
  tableMessage,
} from './term_model';
import { closedPersonasFor, raisePersonaCard } from './term_persona';
import {
  TERM_PARTS,
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
  readTermRequestRow,
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
  const signed = firstWithinLimits(TERM_PARTS, 'seller', proposed, bounds);
  // A never-rule stops Core signing alone: no offer goes out, and the brand's
  // request lapses like any other unanswered one. A rule kept in a closed
  // persona asks the owner to open it, and the request waits (term_persona.ts).
  const verdict = shelfEnvelope(ctx, {
    kind: SHELF_HOST_KIND,
    holder: 'seller',
    limits: bounds,
    terms: termsFromValues(signed),
    general,
    approvedInPerson: false,
  });
  if (shelfSigningBlocked(verdict)) {
    const closed = closedPersonasFor(ctx, SHELF_HOST_KIND);
    if (verdict.outcome === 'card' && closed.length > 0)
      raisePersonaCard(ctx, {
        step: 'first_offer',
        requestId: request.request_id,
        refDigest: request.request_digest,
        personas: closed,
      });
    ctx.log('term.offer_withheld', { request: request.request_id });
    return null;
  }
  const alternatives = alternativesFor(ctx, resource, bounds, general, signed);
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
    ...(alternatives.length > 0 ? { alternatives } : {}),
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
  args: {
    counter: TermCounter;
    head: TermOffer;
    policy: TermPolicy;
    resource: TermResourcePolicy;
    /** The strategy's proposal (COMMITMENT_KERNEL §11); absent: the pack's fixed style. */
    proposed?: Record<TermName, bigint>;
    /** The fixed style plays this round whatever the owner chose (a fallback). */
    fixedStyle?: boolean;
    /** A message beside the revision (the conversation channel, §11). */
    message?: TermMessage;
  },
): void {
  const { counter, head, policy, resource } = args;
  // When the owner chose Brain, it takes the round (§11).
  if (args.proposed === undefined && args.fixedStyle !== true && handSellerTurn(ctx, counter, head))
    return;
  const params =
    ctx.deps.activePack('term_seller')?.entry.term?.runner ?? DEFAULT_TERM_RUNNER_PARAMS;
  const current = termValues(head.terms);
  const targets: Partial<Record<TermName, bigint>> = {};
  for (const name of TERM_NAMES) {
    const t = counter.targets[name];
    if (t !== undefined) targets[name] = BigInt(t);
  }
  const proposed = args.proposed ?? proposeRevision({ current, targets, params });
  const bounds = boundsFor(ctx, policy, resource, head.general);
  const revision = reviseWithinLimits({
    parts: TERM_PARTS,
    holder: 'seller',
    current,
    proposed,
    bounds,
    authorised: ctx.store.floorAuthorizations(head.request_id),
  });
  // The owner raised a floor since the head was signed: the head no longer
  // stands for that term, so hold rather than revise around it.
  if (revision.kind === 'hold') {
    resendHead(ctx, head);
    return;
  }
  const { signed, asked } = revision;
  if (Object.keys(asked).length > 0) raiseFloorCard(ctx, { head, asked, signed });
  // A revision never retreats from what the buyer already holds.
  if (revision.unchanged) {
    resendHead(ctx, head);
    return;
  }
  // A never-rule or a closed persona stops Core signing alone: the head
  // stands. A closed persona asks the owner to open it, and the counter is
  // answered again once it is open (term_persona.ts).
  const verdict = shelfEnvelope(ctx, {
    kind: SHELF_HOST_KIND,
    holder: 'seller',
    limits: bounds,
    terms: termsFromValues(signed),
    general: head.general,
    approvedInPerson: false,
    authorised: ctx.store.floorAuthorizations(head.request_id),
  });
  if (shelfSigningBlocked(verdict)) {
    const closed = closedPersonasFor(ctx, SHELF_HOST_KIND);
    if (verdict.outcome === 'card' && closed.length > 0)
      raisePersonaCard(ctx, {
        step: 'counter',
        requestId: head.request_id,
        refDigest: counter.counter_digest,
        personas: closed,
      });
    resendHead(ctx, head);
    return;
  }
  signRevision(ctx, head, signed, counter.counter_digest, args.message);
}

/** Sign, store and send revision N+1 of `head` with these values. */
/**
 * The owner's alternatives for a resource, moved with this version's rent
 * (COMMITMENT_KERNEL §6). Core signs an offer alone, so an alternative goes
 * out only when its terms sit within the automatic limits, as for any offer
 * (§7, §8 step 6), and it passes the owner's rules with its promise (the
 * owner entered that promise, which is its value). One past an automatic or
 * hard limit, against a never-rule, or needing a closed persona is left out.
 */
function alternativesFor(
  ctx: TermContext,
  resource: TermResourcePolicy,
  bounds: Record<TermName, PartBounds>,
  general: TermGeneral,
  base: Record<TermName, bigint>,
): TermAlternative[] {
  const out: TermAlternative[] = [];
  for (const alt of resource.alternatives ?? []) {
    const values = { ...base, fee: base.fee + BigInt(alt.fee_delta) };
    if (values.fee < 0n) continue;
    const terms = termsFromValues(values);
    const promises = [...alt.promises].sort((a, b) => (a.name < b.name ? -1 : 1));
    const alone = shelfEnvelope(ctx, {
      kind: SHELF_HOST_KIND,
      holder: 'seller',
      limits: bounds,
      terms,
      general,
      approvedInPerson: false,
    });
    if (alone.outcome !== 'sign') continue;
    const rules = shelfEnvelope(ctx, {
      kind: SHELF_HOST_KIND,
      holder: 'seller',
      limits: bounds,
      terms,
      promises,
      general,
      approvedInPerson: true,
    });
    if (rules.outcome === 'refused') continue;
    out.push({ alternative_id: alt.alternative_id, terms, promises });
  }
  return out;
}

/** The alternatives a version of an offer carries, from the policy in force now. */
function alternativesForHead(
  ctx: TermContext,
  head: TermOffer,
  base: Record<TermName, bigint>,
): TermAlternative[] {
  const policy = currentTermPolicy(ctx);
  const resource = policy.resources.find((r) => r.resource_ref === head.resource_ref);
  if (resource === undefined) return [];
  return alternativesFor(ctx, resource, boundsFor(ctx, policy, resource, head.general), head.general, base);
}

function signRevision(
  ctx: TermContext,
  head: TermOffer,
  signed: Record<TermName, bigint>,
  answers: string,
  message?: TermMessage,
): void {
  const nowMs = ctx.now();
  // The head's own message stays with the head: a revision says only its own.
  const {
    offer_digest: _d,
    previous_offer_digest: _p,
    alternatives: _a,
    message: _m,
    ...rest
  } = head;
  const alternatives = alternativesForHead(ctx, head, signed);
  const draft = {
    ...rest,
    ...(alternatives.length > 0 ? { alternatives } : {}),
    terms: termsFromValues(signed),
    issued_at: iso(nowMs),
    valid_until: iso(nowMs + TERM_TIMINGS.offerValidForMs),
    revision: head.revision + 1,
    previous_offer_digest: head.offer_digest,
  };
  if (message !== undefined && partsOnOffer(draft).includes(message.part)) Object.assign(draft, { message });
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
  // Only a concession the owner allowed, and every term of what is signed —
  // moved or carried over — clears the hard floor in force now (a floor
  // raised since the head was signed holds it).
  const bounds = boundsFor(ctx, policy, resource, head.general);
  const signed = ownerConcession({
    parts: TERM_PARTS,
    holder: 'seller',
    current: termValues(head.terms),
    authorised: ctx.store.floorAuthorizations(requestId),
    bounds,
  });
  if (signed === null) return;
  // The owner approved in person, but the model may have changed since the
  // card was raised: a never-rule added, a persona closed. Its hard checks
  // run now, as at any binding (§8).
  const verdict = shelfEnvelope(ctx, {
    kind: SHELF_HOST_KIND,
    holder: 'seller',
    limits: bounds,
    terms: termsFromValues(signed),
    general: head.general,
    approvedInPerson: true,
  });
  if (verdict.outcome === 'refused') {
    // A rule sealed in a closed persona: the owner is asked to open it, and
    // the concession they approved is signed once it is (term_persona.ts).
    if (verdict.reason === 'persona_closed')
      raisePersonaCard(ctx, {
        step: 'concession',
        requestId,
        refDigest: head.offer_digest,
        personas: closedPersonasFor(ctx, SHELF_HOST_KIND),
      });
    ctx.log('term.concession_withheld', { request: requestId });
    return;
  }
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
  // `signRevision` records a yes-revision as answering the offer it revises;
  // a counter's revision answers the counter.
  const chain = offerChain(ctx, offer.request_id, 'outbound').map(({ row, offer: o }) => ({
    digest: o.offer_digest,
    ...(o.previous_offer_digest !== undefined ? { previousDigest: o.previous_offer_digest } : {}),
    answersDigest: row.answersDigest,
  }));
  return bindableDigests(chain).includes(offer.offer_digest);
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
  const lateness = judgeLateness({
    signedAtMs: Date.parse(proposal.proposed_at),
    validUntilMs: Date.parse(offer.valid_until),
    nowMs,
    graceMs: TERM_TIMINGS.proposalArrivalGraceMs,
  });
  if (lateness === 'signed_after_expiry') return 'proposed after the offer expired';
  if (lateness === 'arrived_too_late') return 'arrived too late';
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

function raiseDecisionCard(
  ctx: TermContext,
  proposal: TermAgreementProposal,
  nowMs: number,
  again?: { cardId: string; decideBy: number },
): void {
  const cardId = again?.cardId ?? `term-decision-${proposal.proposal_digest.slice(0, 32)}`;
  const decideBy = again?.decideBy ?? nowMs + TERM_TIMINGS.decideByMs;
  const binding = buildTermDecisionApprovalPayload({ principal: PENDING_PRINCIPAL, proposal });
  const policy = currentTermPolicy(ctx);
  const resourceFor = policy.resources.find((r) => r.resource_ref === proposal.resource_ref);
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
    ...(proposal.alternative_id !== undefined
      ? { alternative_id: proposal.alternative_id, promises: proposal.promises ?? [] }
      : {}),
    // §9 — Core's own list of what binds and where the risk is.
    legibility: shelfBindingCard({
      holder: 'seller',
      terms: proposal.terms,
      promises: proposal.promises ?? [],
      general: proposal.general,
      ...(resourceFor !== undefined
        ? shelfWorth(ctx, {
            kind: SHELF_HOST_KIND,
            holder: 'seller',
            limits: boundsFor(ctx, policy, resourceFor, proposal.general, proposal.replaces_proposal_digest),
            terms: proposal.terms,
            promises: proposal.promises ?? [],
            general: proposal.general,
          })
        : {}),
    }),
    // How the holding rule moved the price (§7.1): the count and the rate, never a floor.
    holding: { tag: proposal.general.tag, already_held: held, premium_bps_per_count: rule.premium },
    decide_by: iso(decideBy),
    // A yes binds only with the Commerce Pack (`term_money.ts`): the card says
    // so while it is missing, so the owner can install it before deciding.
    ...(ctx.deps.moneyAvailable() ? {} : { needs_commerce_pack: true }),
  };
  ctx.raiseCard({
    cardId,
    type: TERM_DECISION_CARD,
    requestId: payload.request_id,
    refDigest: proposal.proposal_digest,
    material: binding,
    description: ctx.deps.moneyAvailable()
      ? 'A brand proposes a slot agreement. Accept it?'
      : 'A brand proposes a slot agreement. Install the Commerce Pack before you accept: shelf deals settle through it.',
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
        | 'lapsed'
        | 'commerce_pack_needed'
        | 'persona_closed';
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
    // A rule this yes must check is sealed in a closed persona: nothing binds
    // and nothing is refused yet. The owner is asked to open it, and the
    // decision card is raised again once it is open (term_persona.ts).
    const closed = closedPersonasFor(ctx, SHELF_HOST_KIND);
    if (closed.length > 0) {
      raisePersonaCard(ctx, {
        step: 'decision',
        requestId: card.requestId,
        refDigest: proposal.proposal_digest,
        personas: closed,
      });
      result.outcome = { ok: false, refusal: 'persona_closed' };
      return;
    }
    if (!ctx.store.decideCard(args.cardId, 'approved', nowMs)) return;
    // A shelf deal settles through the Commerce Pack, so none binds without
    // it (COMMITMENT_KERNEL §12): the brand gets the usual rejection, and the
    // owner is told to install the pack.
    if (!ctx.deps.moneyAvailable()) {
      const decision = authorDecision(ctx, proposal, 'rejected');
      result.outcome =
        decision === null
          ? { ok: false, refusal: 'already_decided' }
          : { ok: false, refusal: 'commerce_pack_needed' };
      return;
    }
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
  // The envelope's hard checks: the hard floors (with the premium), and the
  // owner's never-rules and closed personas for shelf deals (§8).
  const verdict = shelfEnvelope(ctx, {
    kind: SHELF_HOST_KIND,
    holder: 'seller',
    limits: bounds,
    terms: proposal.terms,
    promises: proposal.promises ?? [],
    general: proposal.general,
    approvedInPerson: true,
  });
  if (verdict.outcome === 'refused') return verdict.reason === 'past_hard_limit' ? 'below the floor in force' : verdict.reason;
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

// ---------------------------------------------------------------------------
// Going on once a closed persona is open (term_persona.ts)
// ---------------------------------------------------------------------------

/** The request waited for a persona: sign its first offer now, if none went out. */
export function resumeFirstOffer(ctx: TermContext, requestDigest: string): void {
  const row = ctx.store.getDocument(requestDigest);
  if (row === null || row.kind !== 'term_request' || row.direction !== 'inbound') return;
  const request = readTermRequestRow(row);
  if (request === null) return;
  if (ctx.store.listByRequest(request.request_id, 'term_offer').length > 0) return;
  if (Date.parse(request.respond_by) <= ctx.now()) return;
  const pack = ctx.deps.activePack('term_seller');
  const policy = currentTermPolicy(ctx);
  const resource = policy.resources.find((r) => r.resource_ref === request.resource_ref);
  if (pack === null || !policy.enabled || resource === undefined) return;
  issueFirstOffer(ctx, { request, policy, resource, pack });
}

/**
 * The owner's yes waited for a persona: the decision card, whose inbox task
 * that yes already closed, is put to the owner again with the same decide-by.
 */
export function resumeDecision(ctx: TermContext, proposalDigest: string): void {
  const proposal = readTermProposalRow(ctx.store.getDocument(proposalDigest));
  if (proposal === null || termAgreementStatus(ctx.store, proposalDigest).state !== 'proposed') return;
  const requestId = ctx.store.requestOf(proposalDigest) ?? '';
  const base = `term-decision-${proposalDigest.slice(0, 32)}`;
  const cards = ctx.store
    .cardsForRequest(requestId, TERM_DECISION_CARD)
    .filter((c) => c.cardId === base || c.cardId.startsWith(`${base}-`));
  const live = cards.find((c) => c.state === 'pending');
  if (live === undefined || live.decideBy <= ctx.now()) return;
  // Retired without a rejection: the proposal is still undecided.
  ctx.store.decideCard(live.cardId, 'lapsed', ctx.now());
  raiseDecisionCard(ctx, proposal, ctx.now(), {
    cardId: `${base}-${String(cards.length + 1)}`,
    decideBy: live.decideBy,
  });
}

/** A counter waited for a persona: answer it now, if it still answers the head. */
export function resumeCounter(ctx: TermContext, counterDigest: string): void {
  const counter = readTermCounterRow(ctx.store.getDocument(counterDigest));
  if (counter === null) return;
  const offer = readTermOfferRow(ctx.store.getDocument(counter.offer_digest));
  if (offer === null) return;
  const head = offerChain(ctx, offer.request_id, 'outbound').at(-1)?.offer;
  if (head === undefined || head.offer_digest !== counter.offer_digest) return;
  if (Date.parse(head.valid_until) <= ctx.now()) return;
  const policy = currentTermPolicy(ctx);
  const resource = policy.resources.find((r) => r.resource_ref === head.resource_ref);
  if (!policy.enabled || resource === undefined || ctx.deps.activePack('term_seller') === null) return;
  answerCounter(ctx, { counter, head, policy, resource });
}

/** A floor-card yes waited for a persona: sign the concession now. */
export function resumeConcession(ctx: TermContext, requestId: string): void {
  offerAuthorised(ctx, requestId);
}

/** The wait for a persona ended unopened: the brand gets the uniform rejection. */
export function endDecisionWait(ctx: TermContext, proposalDigest: string): void {
  const proposal = readTermProposalRow(ctx.store.getDocument(proposalDigest));
  if (proposal === null || termAgreementStatus(ctx.store, proposalDigest).state !== 'proposed') return;
  const requestId = ctx.store.requestOf(proposalDigest) ?? '';
  for (const card of ctx.store.cardsForRequest(requestId, TERM_DECISION_CARD)) {
    if (card.refDigest === proposalDigest && card.state === 'pending')
      ctx.store.decideCard(card.cardId, 'lapsed', ctx.now());
  }
  authorDecision(ctx, proposal, 'rejected');
}

// ---------------------------------------------------------------------------
// The strategy slot on the store's side (COMMITMENT_KERNEL §11)
// ---------------------------------------------------------------------------

/** How long the store's round waits for the strategy before the fixed style plays it. */
const SELLER_STRATEGY_WAIT_MS = 20 * 60 * 1000;

/**
 * Hand the store's answer to a counter to Brain, when the owner chose it for
 * shelf deals. True when Brain has the round. Brain proposes what the runner
 * would: a revision, which then goes through the same clamp, floor card, hold
 * and envelope as the runner's.
 */
function handSellerTurn(ctx: TermContext, counter: TermCounter, head: TermOffer): boolean {
  const strategy = ctx.deps.strategy;
  if (strategy === undefined) return false;
  const settings = strategy.settings(SHELF_HOST_KIND);
  if (settings.strategy !== 'brain') return false;
  const requestId = head.request_id;
  const turn = ctx.store.getTurn(requestId, counter.round);
  if (turn !== null) return turn.state === 'pending';
  if (!strategyBudgetLeft(ctx, SHELF_HOST_KIND, requestId)) return false;
  const chain = offerChain(ctx, requestId, 'outbound').map(({ offer }) => ({
    by: 'us',
    revision: offer.revision,
    terms: offer.terms,
  }));
  const counters = ctx.store
    .listByRequest(requestId, 'term_counter')
    .flatMap((row) => {
      const c = readTermCounterRow(row);
      return c === null
        ? []
        : [
            {
              by: 'them',
              round: c.round,
              targets: c.targets,
              // Core's own sentence for the brand's message: never the brand's words.
              ...(c.message !== undefined ? { said: renderTermMessage(c.message) } : {}),
            },
          ];
    });
  // Only what Brain may read now: untagged entries and Brain-readable personas.
  const model = strategy.brainModel(SHELF_HOST_KIND) ?? undefined;
  const policy = currentTermPolicy(ctx);
  const submitted = strategy.submit({
    kind: SHELF_HOST_KIND,
    ref: { negotiationId: requestId, turn: counter.round },
    side: 'seller',
    parts: SLOT_PACK_PARTS.map((p) => ({ ...p })),
    table: {
      terms: head.terms,
      general: {
        currency: head.general.currency,
        period: head.general.period,
        start: head.general.start,
        end: head.general.end,
      },
    },
    history: [...chain, ...counters],
    model: model === undefined ? { constrained: [] } : { ...projectModel(model, { valuesOn: settings.valuesOn, firstOfferOut: true }) },
    roundsLeft: Math.max(0, policy.maxRounds - head.revision),
    deadlineAt: head.valid_until,
    rules: [
      'You speak for the store, which is paid rent (fee, minor units) and a share of sales (share_bps).',
      'Propose the next revision of your offer, one version; Core never lets it fall below the owner’s floors.',
      'Never set a price for anyone outside the deal.',
    ],
  });
  if (submitted === null) return false;
  ctx.store.putTurn({ requestId, turn: counter.round, taskId: submitted.taskId, createdAt: ctx.now() });
  return true;
}

/** The counter a store's turn answers, and the offer it countered, if it still stands. */
function sellerTurnTarget(
  ctx: TermContext,
  requestId: string,
  turn: number,
): { counter: TermCounter; head: TermOffer; policy: TermPolicy; resource: TermResourcePolicy } | null {
  const counter = ctx.store
    .listByRequest(requestId, 'term_counter')
    .map((row) => readTermCounterRow(row))
    .find((c): c is TermCounter => c !== null && c.round === turn);
  const head = offerChain(ctx, requestId, 'outbound').at(-1)?.offer;
  if (counter === undefined || head === undefined || head.offer_digest !== counter.offer_digest) return null;
  if (Date.parse(head.valid_until) <= ctx.now()) return null;
  const policy = currentTermPolicy(ctx);
  const resource = policy.resources.find((r) => r.resource_ref === head.resource_ref);
  if (!policy.enabled || resource === undefined || ctx.deps.activePack('term_seller') === null) return null;
  return { counter, head, policy, resource };
}

/**
 * Apply the store's strategy move. Charged first, one verdict per version; the
 * first version stands in for the runner's proposal. A spent budget, a stop,
 * or a move the shelf wire cannot carry lets the fixed style answer.
 */
export function applySellerStrategyMove(
  ctx: TermContext,
  args: { requestId: string; turn: number; move: StrategyMove },
): { outcome: string } {
  const turn = ctx.store.getTurn(args.requestId, args.turn);
  if (turn === null || turn.state !== 'pending') return { outcome: 'already_applied' };
  const target = sellerTurnTarget(ctx, args.requestId, args.turn);
  if (target === null) {
    ctx.store.closeTurn(args.requestId, args.turn, 'applied');
    return { outcome: 'negotiation_moved_on' };
  }
  const fixed = (outcome: string): { outcome: string } => {
    ctx.store.closeTurn(args.requestId, args.turn, 'fallen_back');
    answerCounter(ctx, { ...target, fixedStyle: true });
    return { outcome };
  };
  const strategy = ctx.deps.strategy;
  // The owner went back to the fixed style meanwhile: it answers, with no message.
  if (strategy === undefined || strategy.settings(SHELF_HOST_KIND).strategy !== 'brain')
    return fixed('fixed_style');
  // A question for the brand rides on the fixed style's revision; no verdict, no budget.
  if (args.move.kind === 'ask_other') {
    const message = tableMessage(args.move, target.head);
    ctx.store.closeTurn(args.requestId, args.turn, message === null ? 'fallen_back' : 'applied');
    answerCounter(ctx, { ...target, fixedStyle: true, ...(message !== null ? { message } : {}) });
    return { outcome: message === null ? 'fixed_style' : 'sent_with_message' };
  }
  if (args.move.kind !== 'propose' || args.move.versions.length === 0) return fixed('fixed_style');
  const charged = strategy.charge({
    kind: SHELF_HOST_KIND,
    negotiationId: args.requestId,
    count: args.move.versions.length,
    nowMs: ctx.now(),
    thresholdVersion: ctx.deps.valueModels?.(SHELF_HOST_KIND, [])?.model.version ?? 0,
  });
  if (!charged.ok) {
    raiseStrategyNotice(ctx, args.requestId, charged.spent);
    return fixed('budget_spent');
  }
  const proposed = termValues(target.head.terms);
  for (const part of (args.move.versions[0] as DealVersion).parts)
    if (part.kind === 'number' && (TERM_NAMES as readonly string[]).includes(part.name))
      proposed[part.name as TermName] = part.value;
  ctx.store.closeTurn(args.requestId, args.turn, 'applied');
  answerCounter(ctx, { ...target, proposed });
  return { outcome: 'answered' };
}

/** A store's round the strategy did not answer in time: the fixed style answers. */
export function fallBackStaleSellerTurns(ctx: TermContext): number {
  let n = 0;
  for (const turn of ctx.store.staleTurns(ctx.now() - SELLER_STRATEGY_WAIT_MS)) {
    if (ctx.store.getNegotiation(turn.requestId) !== null) continue; // the brand's own turn
    ctx.atomically('seller_strategy_stale', () => {
      if (!ctx.store.closeTurn(turn.requestId, turn.turn, 'fallen_back')) return;
      const target = sellerTurnTarget(ctx, turn.requestId, turn.turn);
      if (target !== null) answerCounter(ctx, { ...target, fixedStyle: true });
      n += 1;
    });
  }
  return n;
}
