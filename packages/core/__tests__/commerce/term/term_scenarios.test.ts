/**
 * SHELF_SPACE_NEGOTIATION — the scenarios §10 step 10 names, each on two (or
 * three) real engines that talk only through both sides' gates.
 */

import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { TERM_DELIVERY_FAILED_CARD } from '../../../src/commerce/term/term_engine';
import {
  TERM_DECISION_CARD,
  TERM_FLOOR_CARD,
  TERM_STRANGER_CARD,
} from '../../../src/commerce/term/term_seller';

import { publishListing } from './term_harness';
import {
  BRAND2_DID,
  BRAND_DID,
  DAY,
  Fleet,
  HOUR,
  juicePolicy,
  must,
  STORE_DID,
  type Node,
} from './term_harness';

import type { TermPolicy } from '../../../src/commerce/term/term_policy';
import type { TermListing, TermOffer } from '@dina/commerce-protocol';

function setUpStore(
  fleet: Fleet,
  policy: TermPolicy = juicePolicy(),
  access: 'contacts_or_card' | 'anyone' = 'anyone',
): { store: Node; listing: TermListing; uri: string } {
  const store = fleet.add(STORE_DID);
  const set = store.engine.setPolicy(policy);
  if (!set.ok) throw new Error(set.refusal);
  const published = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice', 'snacks'],
  }, access);
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

function ask(
  brand: Node,
  listing: TermListing,
  uri: string,
  over: {
    start?: string;
    end?: string;
    targets?: { fee: string; share_bps: string };
    maxRounds?: number;
    renews?: string;
    tag?: string;
  } = {},
): string {
  const started = brand.engine.startNegotiation({
    listing,
    listingUri: uri,
    tag: over.tag ?? 'beverages.juice',
    attributes: { skus: 4 },
    start: over.start ?? '2027-02-01T00:00:00Z',
    end: over.end ?? '2027-08-01T00:00:00Z',
    policy: {
      currency: 'INR',
      targets: over.targets ?? { fee: '170000', share_bps: '600' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: over.maxRounds ?? 3,
      deadline_seconds: 3 * 24 * 60 * 60,
      ...(over.renews !== undefined ? { renews: over.renews } : {}),
    },
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request.request_id;
}

function offers(node: Node, requestId: string): TermOffer[] {
  return node.store
    .listByRequest(requestId, 'term_offer')
    .map((r) => JSON.parse(r.recordJson) as TermOffer)
    .sort((a, b) => a.revision - b.revision);
}

function card(node: Node, type: string, requestId?: string) {
  const found = node.cards.filter(
    (c) => c.type === type && (requestId === undefined || c.payload.request_id === requestId),
  );
  return found[found.length - 1];
}

/** Run a brand to an approved proposal and the store's card; returns the proposal digest. */
function toStoreCard(fleet: Fleet, brand: Node, requestId: string): string {
  fleet.pump();
  const proposalCard = card(brand, TERM_PROPOSAL_CARD, requestId);
  if (proposalCard === undefined) throw new Error('no proposal card');
  brand.engine.decideCard(proposalCard.cardId, true);
  fleet.pump();
  return must(brand.store.listByRequest(requestId, 'term_agreement_proposal')[0]).recordDigest;
}

function storeDecides(store: Node, proposalDigest: string, approve: boolean): void {
  const decision = store.cards.find(
    (c) => c.type === TERM_DECISION_CARD && c.payload.proposal_digest === proposalDigest,
  );
  if (decision === undefined) throw new Error('no decision card');
  store.engine.decideCard(decision.cardId, approve);
}

describe('term negotiation scenarios', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  describe('holding rules (§5.4)', () => {
    it('two juice brands already placed raise every floor by 30% — the juice example', () => {
      const { store, listing, uri } = setUpStore(
        fleet,
        juicePolicy({
          manual_holdings: [
            {
              holding_id: 'h1',
              tag: 'beverages.juice',
              start: '2027-01-01T00:00:00Z',
              end: '2027-12-01T00:00:00Z',
            },
            {
              holding_id: 'h2',
              tag: 'beverages.juice',
              start: '2027-01-01T00:00:00Z',
              end: '2027-12-01T00:00:00Z',
            },
          ],
        }),
      );
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri, { maxRounds: 1 });
      fleet.pump();
      const chain = offers(brand, requestId);
      // Asking 250000 stands (above the raised automatic limit 180000 × 1.3 = 234000).
      expect(must(must(chain[0]).terms[0]).value).toBe('250000');
      // The one counter asked 170000; halfway is 210000, below 234000: Core signs
      // 234000 and asks the owner about 210000 (above the raised hard floor 195000).
      expect(must(must(chain[1]).terms[0]).value).toBe('234000');
      const floorCard = card(store, TERM_FLOOR_CARD, requestId);
      expect(floorCard?.payload.asked).toEqual({ fee: '210000' });
      // Rounding goes the seller's way, and the share floor (500 → 650) moved too:
      // halfway from 1000 toward 600 is 800, above 650, so it is offered as is.
      expect(must(must(chain[1]).terms[1]).value).toBe('800');
    });

    it('the cap: with four juice brands placed, a fifth is refused — and told nothing about why', () => {
      const four = [1, 2, 3, 4].map((i) => ({
        holding_id: `h${String(i)}`,
        tag: 'beverages.juice',
        start: '2027-01-01T00:00:00Z',
        end: '2027-12-01T00:00:00Z',
      }));
      const { listing, uri } = setUpStore(fleet, juicePolicy({ manual_holdings: four }));
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      fleet.pump();
      expect(offers(brand, requestId)).toHaveLength(0);
      expect(
        brand.store.getOutbox(
          must(brand.store.listByRequest(requestId, 'term_request')[0]).recordDigest,
        )?.receiptOutcome,
      ).toBe('refused');
      expect(brand.store.getNegotiation(requestId)?.state).toBe('closed');
      expect(brand.store.getNegotiation(requestId)?.closeReason).toBe('refused');
    });

    it('a snack brand is not touched by the juice rule', () => {
      const four = [1, 2, 3, 4].map((i) => ({
        holding_id: `h${String(i)}`,
        tag: 'beverages.juice',
        start: '2027-01-01T00:00:00Z',
        end: '2027-12-01T00:00:00Z',
      }));
      const { listing, uri } = setUpStore(fleet, juicePolicy({ manual_holdings: four }));
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri, { tag: 'snacks' });
      fleet.pump();
      expect(must(must(offers(brand, requestId)[0]).terms[0]).value).toBe('250000');
    });

    it('a manual holding that names the slot blocks it; one that names another slot does not', () => {
      const blocking = juicePolicy({
        manual_holdings: [
          {
            holding_id: 'x',
            tag: 'snacks',
            resource_ref: 'slot-3',
            start: '2027-01-01T00:00:00Z',
            end: '2027-12-01T00:00:00Z',
          },
        ],
      });
      const { listing, uri } = setUpStore(fleet, blocking);
      const brand = fleet.add(BRAND_DID);
      const blocked = ask(brand, listing, uri);
      fleet.pump();
      expect(offers(brand, blocked)).toHaveLength(0);

      const fleet2 = new Fleet();
      try {
        const other = juicePolicy({
          manual_holdings: [
            {
              holding_id: 'x',
              tag: 'snacks',
              resource_ref: 'slot-4',
              start: '2027-01-01T00:00:00Z',
              end: '2027-12-01T00:00:00Z',
            },
          ],
        });
        const s2 = setUpStore(fleet2, other);
        const b2 = fleet2.add(BRAND_DID);
        const free = ask(b2, s2.listing, s2.uri);
        fleet2.pump();
        expect(offers(b2, free).length).toBeGreaterThan(0);
      } finally {
        fleet2.closeAll();
      }
    });
  });

  describe('strangers (§5.3, §6.2)', () => {
    it('who may ask is per listing: one slot vets strangers, another lets anyone ask', () => {
      const { store, listing, uri } = setUpStore(fleet, juicePolicy(), 'contacts_or_card');
      const open = publishListing(
        store,
        {
          listingId: 'slot-4',
          resourceRef: 'slot-4',
          kind: 'shelf',
          region: { scheme: 'postal_area', value: 'IN-560034' },
          tags: ['snacks'],
        },
        'anyone',
      );
      if (!open.ok) throw new Error(open.refusal);
      expect(store.engine.listings().map((l) => [l.listing.listing_id, l.access])).toEqual([
        ['slot-3', 'contacts_or_card'],
        ['slot-4', 'anyone'],
      ]);
      // Two strangers: one asks about the open slot and gets an offer at once.
      const first = fleet.add(BRAND_DID);
      const openRequest = first.engine.startNegotiation({
          listing: open.listing,
          listingUri: open.uri,
          tag: 'snacks',
          attributes: { skus: 2 },
          start: '2027-02-01T00:00:00Z',
          end: '2027-08-01T00:00:00Z',
          policy: {
            currency: 'INR',
            targets: { fee: '170000', share_bps: '0' },
            ceilings: { fee: '300000', share_bps: '0' },
            max_rounds: 3,
            deadline_seconds: (3 * DAY) / 1000,
          },
        });
      if (!openRequest.ok) throw new Error(openRequest.refusal);
      fleet.pump();
      expect(offers(first, openRequest.request.request_id).length).toBeGreaterThan(0);
      expect(card(store, TERM_STRANGER_CARD)).toBeUndefined();
      // The other asks about the vetted slot and waits for the owner's card.
      const second = fleet.add(BRAND2_DID);
      const vetted = ask(second, listing, uri);
      fleet.pump();
      expect(offers(second, vetted)).toHaveLength(0);
      expect(card(store, TERM_STRANGER_CARD)?.payload.request_id).toBe(vetted);
    });

    it('under contacts_or_card a stranger is held, the owner is asked once, and a yes lets the request run', () => {
      const { store, listing, uri } = setUpStore(
        fleet,
        juicePolicy(),
        'contacts_or_card',
      );
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      fleet.pump();
      // The receipt still reached the stranger: `held`, not silence.
      const requestDigest = must(
        brand.store.listByRequest(requestId, 'term_request')[0],
      ).recordDigest;
      expect(brand.store.getOutbox(requestDigest)?.receiptOutcome).toBe('held');
      const stranger = card(store, TERM_STRANGER_CARD);
      expect(stranger).toBeDefined();
      expect(offers(brand, requestId)).toHaveLength(0);
      // A second request from the same stranger while the card is open does not get in.
      ask(brand, listing, uri);
      fleet.pump();
      expect(fleet.outcomes('term_request')).toContain('ingress_denied');

      store.engine.decideCard(must(stranger).cardId, true);
      fleet.pump();
      expect(brand.store.getOutbox(requestDigest)?.receiptOutcome).toBe('stored');
      expect(offers(brand, requestId).length).toBeGreaterThan(0);
      // The yes did not make the brand a contact.
      expect(store.contacts.has(BRAND_DID)).toBe(false);
    });

    it('a no refuses the request and the brand learns it', () => {
      const { store, listing, uri } = setUpStore(
        fleet,
        juicePolicy(),
        'contacts_or_card',
      );
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      fleet.pump();
      store.engine.decideCard(must(card(store, TERM_STRANGER_CARD)).cardId, false);
      fleet.pump();
      const requestDigest = must(
        brand.store.listByRequest(requestId, 'term_request')[0],
      ).recordDigest;
      expect(brand.store.getOutbox(requestDigest)?.receiptOutcome).toBe('refused');
      expect(brand.store.getNegotiation(requestId)?.state).toBe('closed');
    });

    it('a contact skips the card even under contacts_or_card', () => {
      const { store, listing, uri } = setUpStore(
        fleet,
        juicePolicy(),
        'contacts_or_card',
      );
      store.contacts.add(BRAND_DID);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      fleet.pump();
      expect(card(store, TERM_STRANGER_CARD)).toBeUndefined();
      expect(offers(brand, requestId).length).toBeGreaterThan(0);
    });

    it('a stranger the owner never answers is refused when its request expires', () => {
      const { store, listing, uri } = setUpStore(
        fleet,
        juicePolicy(),
        'contacts_or_card',
      );
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      fleet.pump();
      fleet.advance(3 * DAY + HOUR);
      store.engine.sweep();
      fleet.pump();
      const requestDigest = must(
        brand.store.listByRequest(requestId, 'term_request')[0],
      ).recordDigest;
      expect(brand.store.getOutbox(requestDigest)?.receiptOutcome).toBe('refused');
      expect(store.closed).toContain(must(card(store, TERM_STRANGER_CARD)).cardId);
    });
  });

  describe('probing and the inbox (§5.3)', () => {
    it('a request spends probing budget: with none left it is refused, and spends nothing more', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      store.probing.allow = false;
      const requestId = ask(brand, listing, uri);
      fleet.pump();
      const digest = must(brand.store.listByRequest(requestId, 'term_request')[0]).recordDigest;
      expect(brand.store.getOutbox(digest)?.receiptOutcome).toBe('refused');
      expect(offers(brand, requestId)).toHaveLength(0);
    });

    it('a card raised before the inbox existed is raised by the next sweep', () => {
      const { store, listing, uri } = setUpStore(
        fleet,
        juicePolicy(),
        'contacts_or_card',
      );
      const brand = fleet.add(BRAND_DID);
      // The inbox is not there yet: the raise is lost, the card is kept.
      const raise = store.engine.ctx.deps.cards.raise;
      store.engine.ctx.deps.cards.raise = () => false;
      ask(brand, listing, uri);
      fleet.pump();
      expect(store.cards).toHaveLength(0);
      store.engine.ctx.deps.cards.raise = raise;
      store.engine.sweep();
      expect(store.cards.map((c) => c.type)).toEqual([TERM_STRANGER_CARD]);
      // A second sweep does not raise it twice.
      store.engine.sweep();
      expect(store.cards).toHaveLength(1);
    });
  });

  describe('the gate binds every document to something held with that peer (§5.3)', () => {
    it('refuses a request naming a listing this store does not publish, and an offer for nothing asked', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      store.engine.withdrawListing('slot-3');
      ask(brand, listing, uri);
      fleet.pump();
      expect(fleet.outcomes('term_request')).toEqual(['ingress_denied']);
      expect(
        brand.engine.gateAllows({
          peerDid: STORE_DID,
          kind: 'term_offer',
          document: { request_id: 'treq-never-sent' },
          direction: 'inbound',
        }),
      ).toBe(false);
      expect(
        store.engine.gateAllows({
          peerDid: BRAND_DID,
          kind: 'term_counter',
          document: { offer_digest: 'a'.repeat(64) },
          direction: 'inbound',
        }),
      ).toBe(false);
    });

    it('outbound, a node sends only what it stored for that peer', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      const request = JSON.parse(
        must(brand.store.listByRequest(requestId, 'term_request')[0]).recordJson,
      ) as unknown;
      expect(
        brand.engine.gateAllows({
          peerDid: STORE_DID,
          kind: 'term_request',
          document: request,
          direction: 'outbound',
        }),
      ).toBe(true);
      expect(
        brand.engine.gateAllows({
          peerDid: BRAND2_DID,
          kind: 'term_request',
          document: request,
          direction: 'outbound',
        }),
      ).toBe(false);
      expect(
        store.engine.gateAllows({
          peerDid: BRAND_DID,
          kind: 'term_receipt',
          document: { of_digest: 'b'.repeat(64) },
          direction: 'outbound',
        }),
      ).toBe(false);
    });
  });

  describe('acceptance (§7.1 step 6)', () => {
    it('two brands race for the last juice place: the first acceptance counts, the second is no longer available', () => {
      const two = [1, 2].map((i) => ({
        holding_id: `h${String(i)}`,
        tag: 'beverages.juice',
        start: '2027-01-01T00:00:00Z',
        end: '2027-12-01T00:00:00Z',
      }));
      const policy = juicePolicy({
        manual_holdings: two,
        holding_rules: [{ tag: 'beverages.juice', premium_bps_per_count: 0, max_count: 3 }],
      });
      const { store, listing, uri } = setUpStore(fleet, policy);
      // A second listing for slot-4, so the two brands want different slots.
      const second = publishListing(store, {
        listingId: 'slot-4',
        resourceRef: 'slot-4',
        kind: 'shelf',
        region: { scheme: 'postal_area', value: 'IN-560034' },
        tags: ['beverages.juice'],
      });
      if (!second.ok) throw new Error(second.refusal);
      const a = fleet.add(BRAND_DID);
      const b = fleet.add(BRAND2_DID);
      const ra = ask(a, listing, uri);
      const rb = ask(b, second.listing, second.uri, { targets: { fee: '150000', share_bps: '0' } });
      const pa = toStoreCard(fleet, a, ra);
      const pb = toStoreCard(fleet, b, rb);
      storeDecides(store, pa, true);
      storeDecides(store, pb, true);
      fleet.pump();
      expect(a.store.getNegotiation(ra)?.state).toBe('agreed');
      expect(b.store.getNegotiation(rb)?.state).toBe('closed');
      expect(b.store.getNegotiation(rb)?.closeReason).toBe('rejected');
    });

    it('an accepted deal that starts in the future still counts and still occupies its slot', () => {
      const policy = juicePolicy({
        holding_rules: [{ tag: 'beverages.juice', premium_bps_per_count: 0, max_count: 1 }],
      });
      const { store, listing, uri } = setUpStore(fleet, policy);
      const a = fleet.add(BRAND_DID);
      const ra = ask(a, listing, uri, {
        start: '2027-06-01T00:00:00Z',
        end: '2027-12-01T00:00:00Z',
      });
      const pa = toStoreCard(fleet, a, ra);
      storeDecides(store, pa, true);
      fleet.pump();
      expect(a.store.getNegotiation(ra)?.state).toBe('agreed');
      // A second juice brand asking for an overlapping later window hits the cap.
      const b = fleet.add(BRAND2_DID);
      const rb = ask(b, listing, uri, {
        start: '2027-09-01T00:00:00Z',
        end: '2027-11-01T00:00:00Z',
      });
      fleet.pump();
      expect(offers(b, rb)).toHaveLength(0);
      expect(b.store.getNegotiation(rb)?.closeReason).toBe('refused');
    });

    it('renewal at the cap: the renewal and the agreement it renews are one holding', () => {
      const policy = juicePolicy({
        holding_rules: [{ tag: 'beverages.juice', premium_bps_per_count: 0, max_count: 1 }],
      });
      const { store, listing, uri } = setUpStore(fleet, policy);
      const a = fleet.add(BRAND_DID);
      const ra = ask(a, listing, uri);
      const pa = toStoreCard(fleet, a, ra);
      storeDecides(store, pa, true);
      fleet.pump();
      // Renew: start where the first ends.
      const renewal = ask(a, listing, uri, {
        start: '2027-08-01T00:00:00Z',
        end: '2028-02-01T00:00:00Z',
        renews: pa,
      });
      const pr = toStoreCard(fleet, a, renewal);
      storeDecides(store, pr, true);
      fleet.pump();
      expect(a.store.getNegotiation(renewal)?.state).toBe('agreed');
      // The old agreement stays in force until its own end.
      expect(store.engine.agreement(pa).status).toBe('accepted');
      expect(store.engine.agreements().find((x) => x.proposalDigest === pa)?.endsAt).toBe(
        '2027-08-01T00:00:00.000Z',
      );
    });

    it('a rule tightened after the offer: acceptance re-checks and says no longer available', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const a = fleet.add(BRAND_DID);
      const ra = ask(a, listing, uri);
      const pa = toStoreCard(fleet, a, ra);
      const tighter = juicePolicy();
      must(tighter.resources[0]).floors.fee = { hard: '400000' };
      must(tighter.resources[0]).asking.fee = '400000';
      expect(store.engine.setPolicy(tighter).ok).toBe(true);
      storeDecides(store, pa, true);
      fleet.pump();
      expect(a.store.getNegotiation(ra)?.closeReason).toBe('rejected');
    });

    it('the store’s card lapses after three days and the brand gets a rejection', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const a = fleet.add(BRAND_DID);
      const ra = ask(a, listing, uri);
      toStoreCard(fleet, a, ra);
      fleet.advance(3 * DAY + HOUR);
      store.engine.sweep();
      fleet.pump();
      expect(a.store.getNegotiation(ra)?.closeReason).toBe('rejected');
    });
  });

  describe('the owner between the floors (§5.4)', () => {
    /** The brand's newest offer for the request, and its pending proposal card. */
    const brandSide = (brand: Node, requestId: string) => {
      const offers = brand.store
        .listByRequest(requestId, 'term_offer')
        .map(
          (row) =>
            JSON.parse(row.recordJson) as {
              revision: number;
              terms: { name: string; value: string }[];
            },
        )
        .sort((x, y) => x.revision - y.revision);
      const head = must(offers.at(-1), 'an offer');
      const pending = brand.cards.find(
        (c) =>
          c.type === TERM_PROPOSAL_CARD &&
          c.payload.request_id === requestId &&
          brand.store.getCard(c.cardId)?.state === 'pending',
      );
      const fee = (terms: { name: string; value: string }[]) =>
        terms.find((t) => t.name === 'fee')?.value;
      return {
        headFee: fee(head.terms),
        cardFee: fee((pending?.payload.terms ?? []) as { name: string; value: string }[]),
      };
    };

    it('a yes on the floor card reaches the brand as a revision at the asked value, and its card binds it', () => {
      const policy = juicePolicy();
      must(policy.resources[0]).floors.fee = { hard: '150000', auto: '240000' };
      const { store, listing, uri } = setUpStore(fleet, policy);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri, { maxRounds: 2 });
      fleet.pump();
      // Round 1: halfway to 210000 is below the automatic 240000 → 240000 offered, owner asked.
      // Round 2 meets the open card and gets the head back; the brand's rounds are spent.
      const floorCard = card(store, TERM_FLOOR_CARD, requestId);
      expect(floorCard?.payload.asked).toEqual({ fee: '210000' });
      expect(brandSide(brand, requestId)).toEqual({ headFee: '240000', cardFee: '240000' });
      store.engine.decideCard(must(floorCard).cardId, true);
      fleet.pump();
      expect(store.store.floorAuthorizations(requestId).get('fee')).toBe(210000n);
      // The yes reached the brand: a revision at 210000, and the card it sends binds that offer.
      expect(brandSide(brand, requestId)).toEqual({ headFee: '210000', cardFee: '210000' });
    });

    /** The S-06 negotiation, run to the point where the brand holds a card and the store a floor card. */
    const toFloorCard = () => {
      const policy = juicePolicy();
      must(policy.resources[0]).floors.fee = { hard: '150000', auto: '240000' };
      const { store, listing, uri } = setUpStore(fleet, policy);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri, { maxRounds: 2 });
      fleet.pump();
      return { store, brand, requestId, policy, floorCard: must(card(store, TERM_FLOOR_CARD, requestId)) };
    };
    const brandApproves = (brand: Node, requestId: string) => {
      const proposalCard = must(card(brand, TERM_PROPOSAL_CARD, requestId));
      expect(brand.engine.decideCard(proposalCard.cardId, true)).toEqual({ ok: true });
      return must(brand.store.listByRequest(requestId, 'term_agreement_proposal')[0]).recordDigest;
    };

    it('a yes after the brand proposed on the head sends no revision: the deal both owners approved goes ahead', () => {
      const { store, brand, requestId, floorCard } = toFloorCard();
      const proposal = brandApproves(brand, requestId);
      fleet.pump();
      store.engine.decideCard(floorCard.cardId, true);
      fleet.pump();
      expect(brandSide(brand, requestId).headFee).toBe('240000');
      storeDecides(store, proposal, true);
      fleet.pump();
      for (const node of [store, brand])
        expect(node.engine.agreement(proposal).status).toBe('accepted');
    });

    it('a proposal still in flight when the yes goes out binds the offer it named', () => {
      const { store, brand, requestId, floorCard } = toFloorCard();
      const proposal = brandApproves(brand, requestId);
      // The yes is given before the brand's proposal arrives; its revision follows it out.
      store.engine.decideCard(floorCard.cardId, true);
      fleet.pump();
      expect(brandSide(brand, requestId).headFee).toBe('210000');
      // The store took the proposal on the offer just before its yes-revision.
      storeDecides(store, proposal, true);
      fleet.pump();
      for (const node of [store, brand])
        expect(node.engine.agreement(proposal).status).toBe('accepted');
    });

    it('a yes signs nothing while another term sits below a hard floor raised since', () => {
      const { store, brand, requestId, policy, floorCard } = toFloorCard();
      // The head's share is 700; the owner raises its hard floor to 800 while the fee card is open.
      must(policy.resources[0]).floors.share_bps = { hard: '800' };
      expect(store.engine.setPolicy(policy).ok).toBe(true);
      store.engine.decideCard(floorCard.cardId, true);
      fleet.pump();
      expect(brandSide(brand, requestId).headFee).toBe('240000');
      expect(store.store.listByRequest(requestId, 'term_offer')).toHaveLength(3);
    });

    it('a yes reaches the brand when the store was already at its automatic limit', () => {
      const policy = juicePolicy();
      // The asking fee IS the automatic limit: every counter is answered with the same head.
      must(policy.resources[0]).floors.fee = { hard: '150000', auto: '250000' };
      const { store, listing, uri } = setUpStore(fleet, policy);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri, { maxRounds: 2 });
      fleet.pump();
      const floorCard = must(card(store, TERM_FLOOR_CARD, requestId));
      const asked = (floorCard.payload.asked as { fee: string }).fee;
      expect(brandSide(brand, requestId).headFee).toBe('250000');
      // The brand waits out its counter's window and takes the old head to its owner.
      fleet.advance(13 * HOUR);
      brand.engine.sweep();
      fleet.pump();
      expect(brandSide(brand, requestId).cardFee).toBe('250000');
      store.engine.decideCard(floorCard.cardId, true);
      fleet.pump();
      // The revision supersedes the stale card; the new one binds the asked fee.
      expect(brandSide(brand, requestId)).toEqual({ headFee: asked, cardFee: asked });
    });
  });

  describe('delivery (§5.3, §9)', () => {
    it('a store offline for more than a day: the request is resent until it lands', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      fleet.unreachable.add(STORE_DID);
      const requestId = ask(brand, listing, uri);
      fleet.pump();
      expect(fleet.outcomes('term_request')).toEqual(['lost']);
      fleet.advance(30 * HOUR);
      fleet.unreachable.delete(STORE_DID);
      brand.engine.sweep();
      fleet.pump();
      expect(offers(brand, requestId).length).toBeGreaterThan(0);
      expect(store.store.listByKind('term_request', 'inbound')).toHaveLength(1);
    });

    it('resends stop at the document’s deadline and the owner is told once', () => {
      const { listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      fleet.unreachable.add(STORE_DID);
      const requestId = ask(brand, listing, uri);
      for (let i = 0; i < 16; i += 1) {
        fleet.advance(6 * HOUR);
        brand.engine.sweep();
        fleet.pump();
      }
      expect(brand.cards.filter((c) => c.type === TERM_DELIVERY_FAILED_CARD)).toHaveLength(1);
      expect(brand.store.getNegotiation(requestId)?.closeReason).toBe('no_offer');
    });

    it('a resend of a stored document gets the same answer, never a second store', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      fleet.pump();
      const request = JSON.parse(
        must(brand.store.listByRequest(requestId, 'term_request')[0]).recordJson,
      ) as unknown;
      const again = store.engine.ingest({
        senderDid: BRAND_DID,
        kind: 'term_request',
        document: request,
        evidenceJson: '{}',
      });
      expect(again.outcome).toBe('duplicate');
      expect(
        store.store.listByKind('term_offer', 'outbound').filter((r) => r.requestId === requestId),
      ).toHaveLength(offers(store, requestId).length);
    });
  });

  describe('the proposal’s arrival (§7.1 step 5)', () => {
    it('a proposal sent before the offer expired, processed after the store’s phone wakes, still lands', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      fleet.pump();
      fleet.unreachable.add(STORE_DID);
      brand.engine.decideCard(must(card(brand, TERM_PROPOSAL_CARD, requestId)).cardId, true);
      fleet.pump();
      // Asleep past the offer's 3-day life; the brand keeps resending.
      fleet.advance(4 * DAY);
      fleet.unreachable.delete(STORE_DID);
      brand.engine.sweep();
      fleet.pump();
      expect(card(store, TERM_DECISION_CARD)).toBeDefined();
    });

    it('a proposal that changes a term is rejected automatically, with no detail', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      fleet.pump();
      const head = must(offers(brand, requestId).at(-1));
      // Hand-made proposal with a lower fee than the offer.
      const { sealTermRecord } =
        jest.requireActual<typeof import('@dina/commerce-protocol')>('@dina/commerce-protocol');
      const { createHash } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
      const forged = sealTermRecord(
        'term_agreement_proposal',
        {
          protocol_version: head.protocol_version,
          proposal_id: 'tagr-forged',
          host_did: head.seller_did,
          vendor_did: head.buyer_did,
          offer_digest: head.offer_digest,
          pack: head.pack,
          resource_ref: head.resource_ref,
          general: head.general,
          terms: [
            { name: 'fee', value: '1' },
            { name: 'share_bps', value: must(head.terms[1]).value },
          ],
          proposed_at: new Date(fleet.nowMs).toISOString(),
        },
        (d) => new Uint8Array(createHash('sha256').update(d).digest()),
      );
      const result = store.engine.ingest({
        senderDid: BRAND_DID,
        kind: 'term_proposal',
        document: forged,
        evidenceJson: '{}',
      });
      expect(result.outcome).toBe('applied');
      expect(card(store, TERM_DECISION_CARD)).toBeUndefined();
      const decisions = store.store.listByKind('agreement_decision', 'outbound');
      expect(decisions).toHaveLength(1);
      expect((JSON.parse(must(decisions[0]).recordJson) as { kind: string }).kind).toBe('rejected');
    });
  });

  describe('after the deal (§5.5–5.6)', () => {
    function agreedDeal(policy: TermPolicy = juicePolicy()): {
      store: Node;
      brand: Node;
      digest: string;
    } {
      const { store, listing, uri } = setUpStore(fleet, policy);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      const digest = toStoreCard(fleet, brand, requestId);
      storeDecides(store, digest, true);
      fleet.pump();
      return { store, brand, digest };
    }

    it('during the trial either side ends the deal at once; the trial is charged pro rata', () => {
      const { store, brand, digest } = agreedDeal();
      fleet.nowMs = Date.parse('2027-02-06T00:00:00Z');
      const ended = store.engine.terminate({ proposalDigest: digest });
      expect(ended.ok).toBe(true);
      fleet.pump();
      const schedule = brand.engine.schedule(digest);
      // 5 of 14 trial days of 50000 = 17857.14 → 17857
      expect(schedule).toEqual([
        expect.objectContaining({
          kind: 'trial',
          end: '2027-02-06T00:00:00.000Z',
          feeDueMinor: '17857',
        }),
      ]);
    });

    it('after the trial a termination needs the exit notice', () => {
      const { store, digest } = agreedDeal();
      fleet.nowMs = Date.parse('2027-03-01T00:00:00Z');
      expect(
        store.engine.terminate({ proposalDigest: digest, effectiveAt: '2027-03-10T00:00:00Z' }),
      ).toEqual({
        ok: false,
        refusal: expect.stringContaining('at least 30 days'),
      });
      expect(
        store.engine.terminate({ proposalDigest: digest, effectiveAt: '2027-03-31T00:00:00Z' }).ok,
      ).toBe(true);
    });

    it('a settlement that arrives before the decision is held, then lands when the decision does', () => {
      const policy = juicePolicy();
      must(policy.resources[0]).conditions.cash_handler = 'host';
      const { store, listing, uri } = setUpStore(fleet, policy);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri);
      const digest = toStoreCard(fleet, brand, requestId);
      // The store accepts; its decision is lost on the way.
      fleet.unreachable.add(BRAND_DID);
      storeDecides(store, digest, true);
      fleet.pump();
      fleet.unreachable.delete(BRAND_DID);
      // The store (cash handler) settles the trial within the hour; the
      // settlement reaches the brand BEFORE the decision's resend does.
      fleet.advance(HOUR);
      const note = store.engine.issueSettlement({
        proposalDigest: digest,
        periodStart: '2027-02-01T00:00:00.000Z',
        periodEnd: '2027-02-15T00:00:00.000Z',
        grossMinor: '500000',
      });
      if (!note.ok) throw new Error(note.refusal);
      fleet.pump();
      expect(store.store.getOutbox(note.document.settlement_digest)?.receiptOutcome).toBe('held');
      // The decision's resend lands; the held settlement is released and a fresh receipt sent.
      fleet.advance(7 * HOUR);
      store.engine.sweep();
      fleet.pump();
      expect(brand.store.getNegotiation(requestId)?.state).toBe('agreed');
      expect(store.store.getOutbox(note.document.settlement_digest)?.receiptOutcome).toBe('stored');
      expect(brand.store.getDocument(note.document.settlement_digest)).not.toBeNull();
    });

    it('both sides fold the same statement, and accepting figures never marks them paid', () => {
      const { store, brand, digest } = agreedDeal();
      fleet.nowMs = Date.parse('2027-03-20T00:00:00Z');
      for (const [start, end, gross] of [
        ['2027-02-01T00:00:00.000Z', '2027-02-15T00:00:00.000Z', '1000000'],
        ['2027-02-15T00:00:00.000Z', '2027-03-15T00:00:00.000Z', '0'],
      ] as const) {
        const note = brand.engine.issueSettlement({
          proposalDigest: digest,
          periodStart: start,
          periodEnd: end,
          grossMinor: gross,
        });
        if (!note.ok) throw new Error(note.refusal);
        fleet.pump();
        store.engine.acknowledgeSettlement({
          settlementDigest: note.document.settlement_digest,
          kind: 'accepted',
        });
        fleet.pump();
      }
      const a = brand.engine.agreement(digest);
      const b = store.engine.agreement(digest);
      expect(a.statement).toEqual(b.statement);
      expect(a.statement).toEqual(
        expect.objectContaining({ ok: true, direction: 'vendor_owes_host', settlement_count: 2 }),
      );
      expect(a.unanswered).toEqual([]);
    });
  });
});
