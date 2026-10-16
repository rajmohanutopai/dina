/**
 * COMMITMENT_KERNEL §12 and §15 step 1 — shelf money goes through the
 * Commerce Pack, and the owner may remove the pack whenever they choose.
 *
 *   M-01  a Slot-only node cannot bind a renewal: the brand cannot start
 *         it, and a store's yes is refused while the brand gets a rejection;
 *   M-02  renewals are new agreements that settle only through the pack: a
 *         node without it refuses to author, and holds what arrives until the
 *         pack is active;
 *   M-03  a brand whose pack goes away before its yes: the card lapses, the
 *         negotiation steps back and waits, raising no card and sending
 *         nothing while the pack stays away; once it is active a new card
 *         asks again and binds;
 *   M-04  a negotiation still waiting for the pack at its deadline closes;
 *   M-05  a Slot-only store's decision card says the pack is needed, and
 *         installing it before the yes binds;
 *   M-06  what the removal warning counts: a deal until it has ended, the
 *         hold window has passed and the notes it received are answered; a
 *         note this node sent and the other side never answers does not count;
 *   M-07  an undecided proposal stops counting once it can no longer be
 *         decided;
 *   M-08  a settlement held while the pack is paused counts until it lands.
 *
 * The deal (juicePolicy, slot-3): 2027-02-01 to 2027-08-01, a 14-day trial,
 * then monthly periods from 2027-02-15; the brand handles the cash.
 */

import { termAgreementStatus } from '../../../src/commerce/term/term_agreements';
import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { COMMERCE_PACK_NEEDED } from '../../../src/commerce/term/term_money';
import { TERM_DECISION_CARD } from '../../../src/commerce/term/term_seller';

import { publishListing } from './term_harness';
import {
  BRAND_DID,
  DAY,
  Fleet,
  HOUR,
  juicePolicy,
  must,
  STORE_DID,
  type Node,
} from './term_harness';

import type { TermListing } from '@dina/commerce-protocol';

interface Shop {
  store: Node;
  listing: TermListing;
  uri: string;
}

function setUpStore(fleet: Fleet): Shop {
  const store = fleet.add(STORE_DID);
  const set = store.engine.setPolicy(juicePolicy());
  if (!set.ok) throw new Error(set.refusal);
  const published = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice'],
  });
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

function start(
  brand: Node,
  shop: Shop,
  dates: { start: string; end: string },
  renews?: string,
): ReturnType<Node['engine']['startNegotiation']> {
  return brand.engine.startNegotiation({
    listing: shop.listing,
    listingUri: shop.uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: dates.start,
    end: dates.end,
    policy: {
      currency: 'INR',
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: 3,
      deadline_seconds: 3 * 24 * 60 * 60,
      ...(renews !== undefined ? { renews } : {}),
    },
  });
}

function card(node: Node, type: string, key: string, value: string) {
  return node.cards.find((c) => c.type === type && c.payload[key] === value);
}

/** The brand's yes; returns its proposal's digest. */
function propose(fleet: Fleet, brand: Node, requestId: string): string {
  fleet.pump();
  const proposalCard = must(card(brand, TERM_PROPOSAL_CARD, 'request_id', requestId), 'card');
  expect(brand.engine.decideCard(proposalCard.cardId, true)).toEqual({ ok: true });
  fleet.pump();
  return must(brand.store.listByRequest(requestId, 'term_agreement_proposal')[0], 'proposal')
    .recordDigest;
}

/** A deal both owners approve; returns the proposal digest. */
function agree(
  fleet: Fleet,
  brand: Node,
  shop: Shop,
  dates: { start: string; end: string },
  renews?: string,
): string {
  const started = start(brand, shop, dates, renews);
  if (!started.ok) throw new Error(started.refusal);
  const digest = propose(fleet, brand, started.request.request_id);
  const decision = must(card(shop.store, TERM_DECISION_CARD, 'proposal_digest', digest), 'card');
  expect(shop.store.engine.decideCard(decision.cardId, true)).toEqual({ ok: true });
  fleet.pump();
  expect(termAgreementStatus(brand.store, digest).state).toBe('accepted');
  return digest;
}

const FIRST = { start: '2027-02-01T00:00:00Z', end: '2027-08-01T00:00:00Z' };
const SECOND = { start: '2027-08-01T00:00:00Z', end: '2028-02-01T00:00:00Z' };
const THIRD = { start: '2028-02-01T00:00:00Z', end: '2028-08-01T00:00:00Z' };

describe('shelf money and the Commerce Pack (COMMITMENT_KERNEL §12)', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  it('M-01: a Slot-only node cannot bind a renewal', () => {
    const shop = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const digest = agree(fleet, brand, shop, FIRST);
    fleet.advance(DAY);

    // A Slot-only brand cannot start the renewal.
    brand.money.active = false;
    const refused = start(brand, shop, SECOND, digest);
    expect(refused).toEqual({
      ok: false,
      refusal: 'install the Commerce Pack first: shelf deals settle through it',
    });

    // A Slot-only store: its owner's yes is refused, and the brand is told no.
    brand.money.active = true;
    shop.store.money.active = false;
    const started = start(brand, shop, SECOND, digest);
    if (!started.ok) throw new Error(started.refusal);
    const renewal = propose(fleet, brand, started.request.request_id);
    const decision = must(card(shop.store, TERM_DECISION_CARD, 'proposal_digest', renewal), 'card');
    expect(shop.store.engine.decideCard(decision.cardId, true)).toEqual({
      ok: false,
      refusal: 'commerce_pack_needed',
    });
    fleet.pump();
    expect(fleet.outcomes('term_decision').at(-1)).toBe('applied');
    for (const node of [shop.store, brand])
      expect(termAgreementStatus(node.store, renewal).state).toBe('rejected');
    // The agreement it would renew is untouched.
    expect(termAgreementStatus(shop.store.store, digest).state).toBe('accepted');
  });

  it('M-02: renewals are new agreements that settle only through the pack', () => {
    const shop = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const first = agree(fleet, brand, shop, FIRST);
    fleet.advance(DAY);
    const second = agree(fleet, brand, shop, SECOND, first);
    fleet.advance(DAY);
    const third = agree(fleet, brand, shop, THIRD, second);
    expect(new Set([first, second, third]).size).toBe(3);

    // With the pack on both sides, each renewal settles.
    for (const digest of [second, third]) {
      const period = must(brand.engine.schedule(digest)[0], 'period');
      const note = brand.engine.issueSettlement({
        proposalDigest: digest,
        periodStart: period.start,
        periodEnd: period.end,
        grossMinor: '500000',
      });
      expect(note.ok).toBe(true);
    }
    fleet.pump();
    expect(fleet.outcomes('term_settlement')).toEqual(['applied', 'applied']);

    // A brand without the pack refuses to author one.
    brand.money.active = false;
    const period = must(brand.engine.schedule(third)[1], 'period');
    expect(
      brand.engine.issueSettlement({
        proposalDigest: third,
        periodStart: period.start,
        periodEnd: period.end,
        grossMinor: '500000',
      }),
    ).toEqual({ ok: false, refusal: COMMERCE_PACK_NEEDED });

    // A store without the pack holds what arrives, and stores it once the pack is active.
    brand.money.active = true;
    shop.store.money.active = false;
    const held = brand.engine.issueSettlement({
      proposalDigest: third,
      periodStart: period.start,
      periodEnd: period.end,
      grossMinor: '500000',
    });
    if (!held.ok) throw new Error(held.refusal);
    fleet.pump();
    expect(fleet.outcomes('term_settlement').at(-1)).toBe('held');
    expect(
      shop.store.engine.acknowledgeSettlement({
        settlementDigest: held.document.settlement_digest,
        kind: 'accepted',
      }),
    ).toEqual({ ok: false, refusal: 'no received settlement with that digest' });
    shop.store.money.active = true;
    shop.store.engine.sweep();
    fleet.pump();
    expect(
      shop.store.engine.schedule(third).find((p) => p.start === period.start)?.settlementDigest,
    ).toBe(held.document.settlement_digest);
    // An acknowledgement waits the same way on a brand that lost the pack.
    brand.money.active = false;
    expect(
      shop.store.engine.acknowledgeSettlement({
        settlementDigest: held.document.settlement_digest,
        kind: 'accepted',
      }).ok,
    ).toBe(true);
    fleet.pump();
    expect(fleet.outcomes('term_settlement_ack').at(-1)).toBe('held');
    brand.money.active = true;
    brand.engine.sweep();
    fleet.pump();
    // The held acknowledgement is retried on the brand's own node and stored.
    expect(brand.store.answersTo(held.document.settlement_digest, 'settlement_ack')).toHaveLength(
      1,
    );
    expect(brand.engine.agreement(third).unanswered).not.toContain(held.document.settlement_digest);
  });

  it('M-03: a brand that lost the pack before its yes is asked again once it is back', () => {
    const shop = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const started = start(brand, shop, FIRST);
    if (!started.ok) throw new Error(started.refusal);
    const requestId = started.request.request_id;
    fleet.pump();
    const first = must(card(brand, TERM_PROPOSAL_CARD, 'request_id', requestId), 'card');
    brand.money.active = false;
    expect(brand.engine.decideCard(first.cardId, true)).toEqual({
      ok: false,
      refusal: 'commerce_pack_needed',
    });
    expect(brand.store.getCard(first.cardId)?.state).toBe('lapsed');
    expect(brand.store.getNegotiation(requestId)?.state).toBe('negotiating');
    expect(brand.store.listByRequest(requestId, 'term_agreement_proposal')).toEqual([]);

    // While the pack stays away, sweeps raise no new card and send nothing.
    const sent = fleet.inFlight.length + fleet.deliveries.length;
    for (let i = 0; i < 3; i += 1) {
      brand.engine.sweep();
      fleet.pump();
      fleet.advance(HOUR);
    }
    expect(brand.cards.filter((c) => c.type === TERM_PROPOSAL_CARD)).toHaveLength(1);
    expect(fleet.inFlight.length + fleet.deliveries.length).toBe(sent);
    expect(brand.store.getNegotiation(requestId)?.state).toBe('negotiating');

    brand.money.active = true;
    fleet.advance(HOUR);
    brand.engine.sweep();
    fleet.pump();
    const again = brand.cards.filter(
      (c) => c.type === TERM_PROPOSAL_CARD && c.payload.request_id === requestId,
    );
    expect(again).toHaveLength(2);
    expect(brand.engine.decideCard(must(again[1]).cardId, true)).toEqual({ ok: true });
    fleet.pump();
    const proposal = must(brand.store.listByRequest(requestId, 'term_agreement_proposal')[0]);
    const decision = must(
      card(shop.store, TERM_DECISION_CARD, 'proposal_digest', proposal.recordDigest),
    );
    expect(shop.store.engine.decideCard(decision.cardId, true)).toEqual({ ok: true });
    fleet.pump();
    expect(termAgreementStatus(brand.store, proposal.recordDigest).state).toBe('accepted');
  });

  it('M-04: a negotiation still waiting for the pack at its deadline closes', () => {
    const shop = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const started = start(brand, shop, FIRST);
    if (!started.ok) throw new Error(started.refusal);
    brand.money.active = false;
    fleet.pump();
    expect(brand.cards.filter((c) => c.type === TERM_PROPOSAL_CARD)).toEqual([]);
    fleet.advance(3 * DAY + HOUR);
    brand.engine.sweep();
    expect(brand.store.getNegotiation(started.request.request_id)).toMatchObject({
      state: 'closed',
      closeReason: 'commerce_pack_needed',
    });
  });

  it("M-05: a Slot-only store's card says the pack is needed, and installing it before the yes binds", () => {
    const shop = setUpStore(fleet);
    shop.store.money.active = false;
    const brand = fleet.add(BRAND_DID);
    const started = start(brand, shop, FIRST);
    if (!started.ok) throw new Error(started.refusal);
    const digest = propose(fleet, brand, started.request.request_id);
    const decision = must(card(shop.store, TERM_DECISION_CARD, 'proposal_digest', digest), 'card');
    expect(decision.payload.needs_commerce_pack).toBe(true);
    expect(decision.description).toContain('Install the Commerce Pack');
    shop.store.money.active = true;
    expect(shop.store.engine.decideCard(decision.cardId, true)).toEqual({ ok: true });
    fleet.pump();
    expect(termAgreementStatus(brand.store, digest).state).toBe('accepted');
  });

  it('M-06: the removal warning counts a deal until it has ended and its received notes are answered', () => {
    const shop = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const digest = agree(fleet, brand, shop, FIRST);
    expect(brand.engine.openShelfDeals()).toBe(1);
    expect(shop.store.engine.openShelfDeals()).toBe(1);
    // Ended more than the hold window ago, with a note the store has not answered.
    fleet.nowMs = Date.parse('2027-09-15T00:00:00Z');
    const last = must(brand.engine.schedule(digest).at(-1), 'period');
    const note = brand.engine.issueSettlement({
      proposalDigest: digest,
      periodStart: last.start,
      periodEnd: last.end,
      grossMinor: '100000',
    });
    if (!note.ok) throw new Error(note.refusal);
    fleet.pump();
    // The store can still answer it; the brand waits on the store and counts nothing.
    expect(shop.store.engine.openShelfDeals()).toBe(1);
    expect(brand.engine.openShelfDeals()).toBe(0);
    expect(
      shop.store.engine.acknowledgeSettlement({
        settlementDigest: note.document.settlement_digest,
        kind: 'accepted',
      }).ok,
    ).toBe(true);
    fleet.pump();
    expect(shop.store.engine.openShelfDeals()).toBe(0);
  });

  it('M-07: an undecided proposal stops counting once it can no longer be decided', () => {
    const shop = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const started = start(brand, shop, FIRST);
    if (!started.ok) throw new Error(started.refusal);
    const digest = propose(fleet, brand, started.request.request_id);
    expect(shop.store.engine.openShelfDeals()).toBe(1);
    expect(brand.engine.openShelfDeals()).toBe(1);
    // The store's card passes its decide-by: the store stops counting at once;
    // the brand, once its proposal is no longer resent.
    fleet.advance(3 * DAY + HOUR);
    expect(shop.store.engine.openShelfDeals()).toBe(0);
    expect(brand.engine.openShelfDeals()).toBe(1);
    fleet.advance(30 * DAY);
    expect(brand.engine.openShelfDeals()).toBe(0);
    expect(termAgreementStatus(brand.store, digest).state).toBe('proposed');
  });

  it('M-08: a settlement held while the pack is paused counts until it lands', () => {
    const shop = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const digest = agree(fleet, brand, shop, FIRST);
    // Long after the end, with nothing left open, the store's pack is paused.
    fleet.nowMs = Date.parse('2027-10-01T00:00:00Z');
    expect(shop.store.engine.openShelfDeals()).toBe(0);
    shop.store.money.active = false;
    const last = must(brand.engine.schedule(digest).at(-1), 'period');
    const late = brand.engine.issueSettlement({
      proposalDigest: digest,
      periodStart: last.start,
      periodEnd: last.end,
      grossMinor: '100000',
    });
    if (!late.ok) throw new Error(late.refusal);
    fleet.pump();
    expect(fleet.outcomes('term_settlement')).toEqual(['held']);
    expect(shop.store.engine.openShelfDeals()).toBe(1);
    // Resuming the pack releases it: now a note the owner can answer.
    shop.store.money.active = true;
    shop.store.engine.sweep();
    fleet.pump();
    expect(shop.store.engine.openShelfDeals()).toBe(1);
    expect(
      shop.store.engine.acknowledgeSettlement({
        settlementDigest: late.document.settlement_digest,
        kind: 'accepted',
      }).ok,
    ).toBe(true);
    expect(shop.store.engine.openShelfDeals()).toBe(0);
  });
});
