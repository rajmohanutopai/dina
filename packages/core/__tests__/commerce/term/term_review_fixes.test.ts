/**
 * SHELF_SPACE_NEGOTIATION — the faults the deep review found, each pinned so
 * it cannot come back:
 *
 *   - a termination is dated by its sender: one that reached the receiver
 *     more than 3 days after its date is refused, on both sides alike;
 *   - a settlement for a period an early end removed counts for nothing, and
 *     one that arrives after the end is refused and leaves the sender's books;
 *   - a paused store half makes no new deal, at arrival or at the owner's yes;
 *   - a yes that reaches Core after the card's time lapses it, binds nothing;
 *   - a blocked peer passes no term gate, whatever it can name;
 *   - a document at a protocol major this build does not speak is refused,
 *     and no negotiation starts from such a listing;
 *   - outside effects (sends, receipts, cards) run only after a commit;
 *   - a sender of an agreement document outlasts the receiver's 30-day hold.
 */

import {
  revshareRecordDigest,
  sealTermRecord,
  type AgreementTermination,
 TermListing, TermRequest } from '@dina/commerce-protocol';

import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import {
  hash,
  TermContext,
  TERM_TIMINGS,
  type TermEngineDeps,
} from '../../../src/commerce/term/term_context';
import { TERM_DECISION_CARD } from '../../../src/commerce/term/term_seller';

import { publishListing } from './term_harness';
import { BRAND_DID, DAY, Fleet, HOUR, juicePolicy, STORE_DID, type Node } from './term_harness';

import type { TermPolicy } from '../../../src/commerce/term/term_policy';

interface Published {
  listing: TermListing;
  uri: string;
}

function setUpStore(fleet: Fleet, policy: TermPolicy = juicePolicy()): { store: Node } & Published {
  const store = fleet.add(STORE_DID);
  const set = store.engine.setPolicy(policy);
  if (!set.ok) throw new Error(set.refusal);
  const published = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice', 'snacks'],
  });
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

function ask(brand: Node, at: Published): string {
  const started = brand.engine.startNegotiation({
    listing: at.listing,
    listingUri: at.uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: '2027-02-01T00:00:00Z',
    end: '2027-08-01T00:00:00Z',
    policy: {
      currency: 'INR',
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: 3,
      deadline_seconds: 3 * 24 * 60 * 60,
    },
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request.request_id;
}

function card(node: Node, type: string) {
  const found = node.cards.filter((c) => c.type === type);
  const last = found[found.length - 1];
  if (last === undefined) throw new Error(`no ${type} card`);
  return last;
}

/** Bargain, and the brand says yes; the store's decision card is open. */
function toStoreCard(fleet: Fleet): {
  store: Node;
  brand: Node;
  digest: string;
  requestId: string;
} {
  const { store, ...at } = setUpStore(fleet);
  const brand = fleet.add(BRAND_DID);
  const requestId = ask(brand, at);
  fleet.pump();
  expect(brand.engine.decideCard(card(brand, TERM_PROPOSAL_CARD).cardId, true)).toEqual({
    ok: true,
  });
  fleet.pump();
  const proposal = brand.store.listByRequest(requestId, 'term_agreement_proposal')[0];
  if (proposal === undefined) throw new Error('no proposal');
  return { store, brand, digest: proposal.recordDigest, requestId };
}

function agreedDeal(fleet: Fleet): { store: Node; brand: Node; digest: string } {
  const deal = toStoreCard(fleet);
  expect(deal.store.engine.decideCard(card(deal.store, TERM_DECISION_CARD).cardId, true)).toEqual({
    ok: true,
  });
  fleet.pump();
  expect(deal.brand.engine.agreement(deal.digest).status).toBe('accepted');
  return deal;
}

/** The sweep at every hour from now for `hours` hours, delivering what it sends. */
function run(fleet: Fleet, nodes: Node[], hours: number): void {
  for (let h = 0; h < hours; h += 1) {
    fleet.advance(HOUR);
    for (const node of nodes) node.engine.sweep();
    fleet.pump();
  }
}

function endsAt(node: Node, digest: string): string | null | undefined {
  return node.engine.agreements().find((a) => a.proposalDigest === digest)?.endsAt;
}

describe('review fixes', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  describe('a termination is judged against its arrival', () => {
    it('one that reaches the store 4 days after its date is refused, and both sides keep the deal to its end', () => {
      const { store, brand, digest } = agreedDeal(fleet);
      // Inside the trial, so its own dates satisfy the notice rule: only the
      // arrival bound can refuse it.
      fleet.nowMs = Date.parse('2027-02-06T00:00:00Z');
      fleet.unreachable.add(STORE_DID);
      const ended = brand.engine.terminate({ proposalDigest: digest });
      if (!ended.ok) throw new Error(ended.refusal);
      expect(endsAt(brand, digest)).toBe('2027-02-06T00:00:00.000Z');
      run(fleet, [brand], 4 * 24);
      fleet.unreachable.delete(STORE_DID);
      run(fleet, [brand], 6);
      expect(fleet.outcomes('term_termination')).toContain('refused');
      expect(brand.store.getOutbox(ended.document.termination_digest)?.receiptOutcome).toBe(
        'refused',
      );
      // Refused there, so it never took effect here either: the two folds agree.
      expect(endsAt(brand, digest)).toBe('2027-08-01T00:00:00.000Z');
      expect(endsAt(store, digest)).toBe('2027-08-01T00:00:00.000Z');
      expect(brand.engine.schedule(digest)).toEqual(store.engine.schedule(digest));
    });

    it('one that reaches the store 2 days late lands', () => {
      const { store, brand, digest } = agreedDeal(fleet);
      fleet.nowMs = Date.parse('2027-02-06T00:00:00Z');
      fleet.unreachable.add(STORE_DID);
      const ended = brand.engine.terminate({ proposalDigest: digest });
      if (!ended.ok) throw new Error(ended.refusal);
      run(fleet, [brand], 2 * 24);
      fleet.unreachable.delete(STORE_DID);
      run(fleet, [brand], 6);
      expect(brand.store.getOutbox(ended.document.termination_digest)?.receiptOutcome).toBe(
        'stored',
      );
      expect(endsAt(store, digest)).toBe('2027-02-06T00:00:00.000Z');
    });

    it('one dated in the future is refused', () => {
      const { store, brand, digest } = agreedDeal(fleet);
      fleet.nowMs = Date.parse('2027-02-06T00:00:00Z');
      const draft = {
        protocol_version: '1.0',
        termination_id: 'tterm-future',
        proposal_digest: digest,
        terminated_at: '2027-02-06T01:00:00Z',
        effective_at: '2027-02-06T01:00:00Z',
      };
      const termination = {
        ...draft,
        termination_digest: revshareRecordDigest('agreement_termination', draft, hash),
      } as AgreementTermination;
      const result = store.engine.ingest({
        senderDid: brand.did,
        kind: 'term_termination',
        document: termination,
        evidenceJson: '{}',
      });
      expect(result).toMatchObject({
        outcome: 'refused',
        detail: 'termination dated after it arrived',
      });
      expect(endsAt(store, digest)).toBe('2027-08-01T00:00:00.000Z');
    });
  });

  describe('a settlement for a period an early end removed', () => {
    // After the 14-day trial the periods run from 15 Feb. Notice on 1 Mar,
    // effective 15 Apr: every period from 15 Apr on is gone.
    const APRIL = {
      periodStart: '2027-04-15T00:00:00.000Z',
      periodEnd: '2027-05-15T00:00:00.000Z',
    };

    it('counts for nothing once the termination lands, though the store accepted it before', () => {
      const { store, brand, digest } = agreedDeal(fleet);
      fleet.nowMs = Date.parse('2027-02-28T00:00:00Z');
      const note = brand.engine.issueSettlement({
        proposalDigest: digest,
        ...APRIL,
        grossMinor: '1000000',
      });
      if (!note.ok) throw new Error(note.refusal);
      fleet.pump();
      store.engine.acknowledgeSettlement({
        settlementDigest: note.document.settlement_digest,
        kind: 'accepted',
      });
      fleet.pump();
      const before = store.engine.agreement(digest).statement;
      expect(before).toMatchObject({ ok: true, fee_minor: note.document.fee_due?.minor_units });

      fleet.nowMs = Date.parse('2027-03-01T00:00:00Z');
      const ended = store.engine.terminate({
        proposalDigest: digest,
        effectiveAt: '2027-04-15T00:00:00Z',
      });
      if (!ended.ok) throw new Error(ended.refusal);
      fleet.pump();
      // The April period no longer exists, so the note counts for nothing —
      // its rent and its sales alike, as a note for it arriving now would be
      // refused outright (the schedule no longer contains it).
      const after = store.engine.agreement(digest).statement;
      expect(after).toMatchObject({
        ok: true,
        fee_minor: '0',
        share_minor: '0',
        settlement_count: 0,
      });
      expect(brand.engine.agreement(digest).statement).toEqual(after);
    });

    it('arriving after the termination, it is refused and leaves the sender’s own books', () => {
      const { store, brand, digest } = agreedDeal(fleet);
      fleet.nowMs = Date.parse('2027-02-28T00:00:00Z');
      fleet.unreachable.add(STORE_DID);
      const note = brand.engine.issueSettlement({
        proposalDigest: digest,
        ...APRIL,
        grossMinor: '1000000',
      });
      if (!note.ok) throw new Error(note.refusal);
      fleet.pump();
      fleet.unreachable.delete(STORE_DID);
      fleet.nowMs = Date.parse('2027-03-01T00:00:00Z');
      const ended = store.engine.terminate({
        proposalDigest: digest,
        effectiveAt: '2027-04-15T00:00:00Z',
      });
      if (!ended.ok) throw new Error(ended.refusal);
      fleet.pump();
      run(fleet, [brand], 6);
      expect(brand.store.getOutbox(note.document.settlement_digest)?.receiptOutcome).toBe(
        'refused',
      );
      expect(brand.engine.agreement(digest).unanswered).toEqual([]);
      expect(
        brand.engine
          .schedule(digest)
          .some((p) => p.settlementDigest === note.document.settlement_digest),
      ).toBe(false);
    });
  });

  describe('a paused store half makes no new deal', () => {
    it('a proposal arriving while paused is rejected on arrival', () => {
      const { store, ...at } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, at);
      fleet.pump();
      store.packActive.seller = false;
      brand.engine.decideCard(card(brand, TERM_PROPOSAL_CARD).cardId, true);
      fleet.pump();
      expect(store.cards.some((c) => c.type === TERM_DECISION_CARD)).toBe(false);
      expect(brand.store.getNegotiation(requestId)?.state).not.toBe('agreed');
      const proposal = brand.store.listByRequest(requestId, 'term_agreement_proposal')[0];
      expect(
        proposal === undefined ? 'none' : brand.engine.agreement(proposal.recordDigest).status,
      ).toBe('rejected');
    });

    it('a yes given after the half was paused rejects instead of binding', () => {
      const { store, brand, digest } = toStoreCard(fleet);
      store.packActive.seller = false;
      expect(store.engine.decideCard(card(store, TERM_DECISION_CARD).cardId, true)).toEqual({
        ok: false,
        refusal: 'no_longer_available',
      });
      fleet.pump();
      expect(brand.engine.agreement(digest).status).toBe('rejected');
    });
  });

  it('a yes reaching Core after the card’s time lapses it and binds nothing', () => {
    const { store, brand, digest } = toStoreCard(fleet);
    const decision = card(store, TERM_DECISION_CARD);
    fleet.nowMs = decision.expiresAtMs;
    // No sweep has run: the decision itself must see the time.
    expect(store.engine.decideCard(decision.cardId, true)).toEqual({
      ok: false,
      refusal: 'lapsed',
    });
    fleet.pump();
    expect(store.engine.agreement(digest).status).toBe('rejected');
    expect(brand.engine.agreement(digest).status).toBe('rejected');
  });

  describe('a blocked peer passes no term gate', () => {
    it('a blocked brand’s request is refused at the store’s gate, though it names a published listing', () => {
      const { store, ...at } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      store.blocked.add(BRAND_DID);
      ask(brand, at);
      fleet.pump();
      expect(fleet.outcomes('term_request')).toEqual(['ingress_denied']);
    });

    it('a store that blocks a brand it has a deal with sends it nothing more', () => {
      const { store, digest } = agreedDeal(fleet);
      store.blocked.add(BRAND_DID);
      fleet.nowMs = Date.parse('2027-02-06T00:00:00Z');
      const ended = store.engine.terminate({ proposalDigest: digest });
      if (!ended.ok) throw new Error(ended.refusal);
      fleet.pump();
      expect(fleet.outcomes('term_termination')).toEqual(['egress_denied']);
    });
  });

  describe('protocol majors this build does not speak (§9.13)', () => {
    it('an inbound request at 2.0 is refused, whatever its shape', () => {
      const { store, listing } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const request = brand.store.listByKind('term_request')[0];
      expect(request).toBeUndefined();
      // A well-formed request, sealed at 2.0.
      const draft = {
        protocol_version: '2.0',
        request_id: 'treq-two',
        buyer_did: BRAND_DID,
        seller_did: STORE_DID,
        listing_uri: `at://${STORE_DID}/com.dinakernel.commerce.termListing/slot-3`,
        listing_digest: listing.listing_digest,
        pack: listing.pack,
        resource_ref: 'slot-3',
        general: {
          tag: 'beverages.juice',
          currency: 'INR',
          start: '2027-02-01T00:00:00Z',
          end: '2027-08-01T00:00:00Z',
        },
        attributes: { skus: 4 },
        issued_at: new Date(fleet.nowMs).toISOString(),
        respond_by: new Date(fleet.nowMs + DAY).toISOString(),
      };
      const sealed = sealTermRecord('term_request', draft, hash) as unknown as TermRequest;
      const result = store.engine.ingest({
        senderDid: BRAND_DID,
        kind: 'term_request',
        document: sealed,
        evidenceJson: '{}',
      });
      expect(result).toMatchObject({ outcome: 'unreadable' });
      expect(store.store.getAnswer(sealed.request_digest)?.outcome).toBe('refused');
    });

    it('no negotiation starts from a listing at 2.0', () => {
      const { listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const { listing_digest: _old, ...rest } = listing;
      const newer = sealTermRecord(
        'term_listing',
        { ...rest, protocol_version: '2.0' },
        hash,
      ) as unknown as TermListing;
      expect(() => ask(brand, { listing: newer, uri })).toThrow(/protocol 2\.0/);
    });
  });

  describe('outside effects wait for the commit', () => {
    function context(events: string[], fail: boolean): TermContext {
      return new TermContext({
        transaction: {
          atomically: <T>(_label: string, body: () => T): T => {
            const result = body();
            if (fail) throw new Error('rolled back');
            events.push('commit');
            return result;
          },
        },
        send: async () => {
          events.push('send');
          return true;
        },
      } as unknown as TermEngineDeps);
    }

    it('a send queued inside a transaction runs after the commit', () => {
      const events: string[] = [];
      const ctx = context(events, false);
      ctx.atomically('x', () => {
        ctx.resend(BRAND_DID, 'term_offer', {});
        // Joining the open transaction, not opening a second one.
        ctx.atomically('inner', () => ctx.resend(BRAND_DID, 'term_offer', {}));
        events.push('body done');
      });
      expect(events).toEqual(['body done', 'commit', 'send', 'send']);
    });

    it('a rolled-back transaction sends nothing', () => {
      const events: string[] = [];
      const ctx = context(events, true);
      expect(() => ctx.atomically('x', () => ctx.resend(BRAND_DID, 'term_offer', {}))).toThrow(
        'rolled back',
      );
      expect(events).toEqual([]);
      // And the next act is not haunted by the dropped one.
      ctx.resend(BRAND_DID, 'term_offer', {});
      expect(events).toEqual(['send']);
    });
  });

  it('an agreement document’s sender outlasts the receiver’s 30-day hold', () => {
    // The receiver may hold a document for 30 days from its arrival, and
    // arrival trails sending by up to two days; the sender resends daily on a
    // held answer, so it must still be resending a day after that.
    expect(TERM_TIMINGS.agreementResendForMs).toBeGreaterThanOrEqual(
      TERM_TIMINGS.heldForMs + 2 * DAY + TERM_TIMINGS.heldResendEveryMs,
    );
  });

  it('after a held answer the sender resends once a day, even when later receipts are lost', () => {
    // The store keeps the takings, so it settles; the brand never learns the
    // deal was accepted (every decision is lost), so it holds the settlement.
    const base = juicePolicy();
    const { store, ...at } = setUpStore(
      fleet,
      juicePolicy({
        resources: base.resources.map((r) =>
          r.resource_ref === 'slot-3'
            ? { ...r, conditions: { ...r.conditions, cash_handler: 'host' } }
            : r,
        ),
      }),
    );
    const brand = fleet.add(BRAND_DID);
    const requestId = ask(brand, at);
    fleet.pump();
    brand.engine.decideCard(card(brand, TERM_PROPOSAL_CARD).cardId, true);
    fleet.pump();
    const dropDecisions = (): void => {
      for (let i = fleet.inFlight.length - 1; i >= 0; i -= 1)
        if (fleet.inFlight[i]?.kind === 'term_decision') fleet.inFlight.splice(i, 1);
    };
    store.engine.decideCard(card(store, TERM_DECISION_CARD).cardId, true);
    dropDecisions();
    fleet.pump();
    expect(brand.store.getNegotiation(requestId)?.state).toBe('proposed');
    const proposal = brand.store.listByRequest(requestId, 'term_agreement_proposal')[0];
    if (proposal === undefined) throw new Error('no proposal');
    const note = store.engine.issueSettlement({
      proposalDigest: proposal.recordDigest,
      periodStart: '2027-02-01T00:00:00.000Z',
      periodEnd: '2027-02-15T00:00:00.000Z',
      grossMinor: '1000000',
    });
    if (!note.ok) throw new Error(note.refusal);
    dropDecisions();
    fleet.pump();
    expect(store.store.getOutbox(note.document.settlement_digest)?.receiptOutcome).toBe('held');
    // From now on every receipt the brand sends the store is lost.
    fleet.unreachable.add(STORE_DID);
    const sent = (): number =>
      fleet.deliveries.filter((d) => d.kind === 'term_settlement' && d.from === STORE_DID).length;
    const before = sent();
    for (let h = 0; h < 3 * 24; h += 1) {
      fleet.advance(HOUR);
      store.engine.sweep();
      brand.engine.sweep();
      dropDecisions();
      fleet.pump();
    }
    // Once a day — the held cadence — not every 6 hours (which would be 12).
    expect(sent() - before).toBe(3);
  });

  it('an uncut note for a period the end cut short is refused, and leaves the sender’s books', () => {
    const { store, brand, digest } = agreedDeal(fleet);
    fleet.nowMs = Date.parse('2027-02-28T00:00:00Z');
    fleet.unreachable.add(STORE_DID);
    const note = brand.engine.issueSettlement({
      proposalDigest: digest,
      periodStart: '2027-04-15T00:00:00.000Z',
      periodEnd: '2027-05-15T00:00:00.000Z',
      grossMinor: '1000000',
    });
    if (!note.ok) throw new Error(note.refusal);
    fleet.pump();
    fleet.unreachable.delete(STORE_DID);
    fleet.nowMs = Date.parse('2027-03-01T00:00:00Z');
    // Effective 25 April: the period that began 15 April is cut, not removed.
    const ended = store.engine.terminate({
      proposalDigest: digest,
      effectiveAt: '2027-04-25T00:00:00Z',
    });
    if (!ended.ok) throw new Error(ended.refusal);
    fleet.pump();
    run(fleet, [brand], 6);
    expect(brand.store.getOutbox(note.document.settlement_digest)?.receiptOutcome).toBe('refused');
    const cut = brand.engine.schedule(digest).find((p) => p.start === '2027-04-15T00:00:00.000Z');
    expect(cut).toMatchObject({ end: '2027-04-25T00:00:00.000Z', settlementDigest: null });
    expect(brand.engine.schedule(digest)).toEqual(store.engine.schedule(digest));
  });

  it('a brand’s yes after its offer expired, with no sweep in between, sends nothing', () => {
    const { store, ...at } = setUpStore(fleet);
    const brand = fleet.add(BRAND_DID);
    const requestId = ask(brand, at);
    fleet.pump();
    const proposalCard = card(brand, TERM_PROPOSAL_CARD);
    fleet.nowMs = proposalCard.expiresAtMs;
    const sentBefore = fleet.deliveries.length;
    expect(brand.engine.decideCard(proposalCard.cardId, true)).toEqual({
      ok: false,
      refusal: 'offer_expired',
    });
    fleet.pump();
    expect(fleet.deliveries.slice(sentBefore).filter((d) => d.kind === 'term_proposal')).toEqual(
      [],
    );
    expect(brand.store.listByRequest(requestId, 'term_agreement_proposal')).toEqual([]);
    expect(brand.store.getNegotiation(requestId)).toMatchObject({
      state: 'closed',
      closeReason: 'offer_expired',
    });
    expect(store.cards.some((c) => c.type === TERM_DECISION_CARD)).toBe(false);
  });
});
