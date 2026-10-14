/**
 * SHELF_SPACE_TEST_PLAN T-04, A-05, K-04, G-07: who may ask, what a paused
 * seller half still accepts, and what a lapsed brand card leaves behind.
 *
 * T-04 runs through Core's REAL receive pipeline (sealed, signed), since a
 * blocked sender is a contact-directory trust level the pipeline checks
 * before the term gate; the engine's own gate knows nothing of blocking.
 */

import { resetAuditState } from '../../../src/audit/service';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { iso } from '../../../src/commerce/term/term_context';
import {
  TERM_DECISION_CARD,
  TERM_FLOOR_CARD,
  TERM_STRANGER_CARD,
} from '../../../src/commerce/term/term_seller';
import { getPublicKey } from '../../../src/crypto/ed25519';
import { sealMessage } from '../../../src/d2d/envelope';
import { clearGatesState } from '../../../src/d2d/gates';
import { receiveD2D } from '../../../src/d2d/receive_pipeline';
import { clearReplayCache } from '../../../src/transport/adversarial';

import { publishListing } from './term_harness';
import {
  BRAND2_DID,
  BRAND_DID,
  DAY,
  Fleet,
  HOUR,
  juicePolicy,
  STORE_DID,
  T0,
  type Node,
} from './term_harness';

import type { TermPolicy } from '../../../src/commerce/term/term_policy';
import type { TermListing, TermOffer, TermRequest } from '@dina/commerce-protocol';

const MINUTE = 60 * 1000;

function setUpStore(
  fleet: Fleet,
  policy: TermPolicy = juicePolicy(),
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
  });
  if (!published.ok) throw new Error(published.refusal);
  return { store, listing: published.listing, uri: published.uri };
}

function ask(
  brand: Node,
  listing: TermListing,
  uri: string,
  over: { start?: string; end?: string } = {},
): TermRequest {
  const started = brand.engine.startNegotiation({
    listing,
    listingUri: uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: over.start ?? '2027-02-01T00:00:00Z',
    end: over.end ?? '2027-08-01T00:00:00Z',
    policy: {
      currency: 'INR',
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: 3,
      deadline_seconds: 3 * 24 * 60 * 60,
    },
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request;
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

function mustCard(node: Node, type: string, requestId?: string) {
  const found = card(node, type, requestId);
  if (found === undefined) throw new Error(`no ${type} card`);
  return found;
}

function proposalDigestOf(node: Node, requestId: string): string {
  const row = node.store.listByRequest(requestId, 'term_agreement_proposal')[0];
  if (row === undefined) throw new Error('no proposal');
  return row.recordDigest;
}

/** Bargain to the brand's card, both owners say yes: an accepted deal. */
function agreedDeal(
  fleet: Fleet,
  store: Node,
  brand: Node,
  listing: TermListing,
  uri: string,
): { requestId: string; digest: string } {
  const requestId = ask(brand, listing, uri).request_id;
  fleet.pump();
  brand.engine.decideCard(mustCard(brand, TERM_PROPOSAL_CARD, requestId).cardId, true);
  fleet.pump();
  const digest = proposalDigestOf(brand, requestId);
  const decision = store.cards.find(
    (c) => c.type === TERM_DECISION_CARD && c.payload.proposal_digest === digest,
  );
  if (decision === undefined) throw new Error('no decision card');
  store.engine.decideCard(decision.cardId, true);
  fleet.pump();
  return { requestId, digest };
}

describe('access, paused packs and lapsed cards', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => {
    installCommerceRuntime(null);
    clearGatesState();
    clearReplayCache();
    resetAuditState();
    fleet.closeAll();
  });

  describe('T-04 a blocked brand at the store’s receive pipeline (§5.3)', () => {
    const brandPriv = new Uint8Array(32).fill(0x11);
    const brandPub = getPublicKey(brandPriv);
    const storePriv = new Uint8Array(32).fill(0x42);
    const storePub = getPublicKey(storePriv);

    function sealed(id: string, request: TermRequest) {
      return sealMessage(
        {
          id,
          type: 'commerce.trade',
          from: BRAND_DID,
          to: STORE_DID,
          created_time: T0,
          body: JSON.stringify({ kind: 'term_request', document: request }),
        },
        brandPriv,
        storePub,
      );
    }

    it('drops the request before the waiver: nothing stored, answered, spent or raised', () => {
      // `anyone`, the widest access: only the block can stop this request.
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const request = ask(brand, listing, uri);
      // Take the request off the wire; the test delivers it by hand.
      const queued = fleet.inFlight.splice(0);
      expect(queued.map((m) => m.kind)).toEqual(['term_request']);
      installCommerceRuntime({ terms: store.engine } as unknown as CommerceRuntime);
      let spent = 0;
      const spend = store.engine.ctx.deps.spendProbing;
      store.engine.ctx.deps.spendProbing = (did, nowMs) => {
        spent += 1;
        return spend(did, nowMs);
      };

      const blocked = receiveD2D(
        sealed('msg-blocked', request),
        storePub,
        storePriv,
        [brandPub],
        'blocked',
      );
      expect(blocked).toEqual(
        expect.objectContaining({ action: 'dropped', reason: 'Sender is blocked' }),
      );
      // The store kept nothing and said nothing: no receipt, no offer.
      expect(store.store.getDocument(request.request_digest)).toBeNull();
      expect(store.store.getAnswer(request.request_digest)).toBeNull();
      expect(store.store.listHeld()).toEqual([]);
      expect(store.cards).toEqual([]);
      expect(fleet.inFlight).toEqual([]);
      expect(spent).toBe(0);
      // So the brand learns nothing: no receipt, no offer, still waiting.
      expect(brand.store.getOutbox(request.request_digest)?.receiptOutcome).toBeNull();
      expect(offers(brand, request.request_id)).toEqual([]);
      expect(brand.store.getNegotiation(request.request_id)?.state).toBe('negotiating');

      // The same request from the same DID, not blocked, is a plain stranger
      // under `anyone`: it is admitted, so the block alone refused it above.
      const stranger = receiveD2D(
        sealed('msg-open', request),
        storePub,
        storePriv,
        [brandPub],
        'unknown',
      );
      expect(stranger.action).toBe('bypassed');
      expect(store.store.getAnswer(request.request_digest)?.outcome).toBe('stored');
      expect(spent).toBe(1);
      // A receipt and the first offer, in whichever order the engine sends them.
      expect(fleet.inFlight.map((m) => `${m.to} ${m.kind}`).sort()).toEqual([
        `${BRAND_DID} term_offer`,
        `${BRAND_DID} term_receipt`,
      ]);
    });
  });

  describe('A-05 a stranger under `anyone` (§6.2)', () => {
    it('gets a first offer with no stranger card; the brand’s no closes it and sends nothing', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri).request_id;
      fleet.pump();

      expect(store.contacts.has(BRAND_DID)).toBe(false);
      expect(card(store, TERM_STRANGER_CARD)).toBeUndefined();
      expect(fleet.outcomes('term_request')).toEqual(['applied']);
      // The first offer is the private asking terms: 250000 and 1000 sit above
      // every floor (no juice brand is placed, so no premium).
      const chain = offers(brand, requestId);
      expect(chain[0]).toEqual(
        expect.objectContaining({
          revision: 1,
          terms: [
            { name: 'fee', value: '250000' },
            { name: 'share_bps', value: '1000' },
          ],
          valid_until: iso(T0 + 3 * DAY),
        }),
      );
      // End to end: the loop ran to the brand's one card, and the store's
      // owner was never asked anything on the way.
      expect(brand.store.getNegotiation(requestId)?.state).toBe('ready');
      expect(store.cards).toEqual([]);
      const proposalCard = mustCard(brand, TERM_PROPOSAL_CARD, requestId);
      const head = chain[chain.length - 1];
      expect(proposalCard.payload.terms).toEqual(head?.terms);

      brand.engine.decideCard(proposalCard.cardId, false);
      fleet.pump();
      expect(brand.store.getNegotiation(requestId)).toEqual(
        expect.objectContaining({ state: 'closed', closeReason: 'declined' }),
      );
      expect(brand.store.getCard(proposalCard.cardId)?.state).toBe('declined');
      // Nothing went to the store, and it holds no proposal or card.
      expect(fleet.outcomes('term_proposal')).toEqual([]);
      expect(store.store.listByRequest(requestId, 'term_agreement_proposal')).toEqual([]);
      expect(card(store, TERM_DECISION_CARD)).toBeUndefined();
      expect(card(store, TERM_FLOOR_CARD)).toBeUndefined();
      // Cleanly: past the offer's life, neither side's sweep sends anything more.
      const sent = fleet.deliveries.length;
      fleet.advance(3 * DAY + HOUR);
      brand.engine.sweep();
      store.engine.sweep();
      fleet.pump();
      expect(fleet.deliveries.length).toBe(sent);
      expect(brand.engine.negotiations()).toEqual([
        expect.objectContaining({ requestId, state: 'closed', pendingCardId: null }),
      ]);
    });

    it('a no from the store’s owner rejects the stranger’s proposal and closes the brand’s side', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri).request_id;
      fleet.pump();
      brand.engine.decideCard(mustCard(brand, TERM_PROPOSAL_CARD, requestId).cardId, true);
      fleet.pump();
      const digest = proposalDigestOf(brand, requestId);
      store.engine.decideCard(mustCard(store, TERM_DECISION_CARD).cardId, false);
      fleet.pump();
      expect(fleet.outcomes('term_decision')).toEqual(['applied']);
      expect(brand.store.getNegotiation(requestId)).toEqual(
        expect.objectContaining({ state: 'closed', closeReason: 'rejected' }),
      );
      expect(store.engine.agreement(digest).status).toBe('rejected');
      expect(brand.engine.agreement(digest).status).toBe('rejected');
      // The decision was delivered; nothing more is pending on either side.
      expect(store.engine.agreements()).toEqual([
        expect.objectContaining({
          proposalDigest: digest,
          state: 'rejected',
          delivery: 'delivered',
        }),
      ]);
      expect(store.cards.filter((c) => c.type === TERM_STRANGER_CARD)).toEqual([]);
    });
  });

  describe('K-04 a paused or absent seller half (§4)', () => {
    it('refuses new requests, while a live deal’s settlement and termination still land', () => {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const { digest } = agreedDeal(fleet, store, brand, listing, uri);
      expect(store.engine.agreement(digest).status).toBe('accepted');

      store.packActive.seller = false;
      // A second brand asks for dates the deal does not touch, so only the
      // pause can refuse it.
      const other = fleet.add(BRAND2_DID);
      const late = { start: '2028-01-01T00:00:00Z', end: '2028-06-01T00:00:00Z' };
      const refusedReq = ask(other, listing, uri, late);
      fleet.pump();
      expect(other.store.getOutbox(refusedReq.request_digest)?.receiptOutcome).toBe('refused');
      expect(other.store.getNegotiation(refusedReq.request_id)).toEqual(
        expect.objectContaining({ state: 'closed', closeReason: 'refused' }),
      );
      expect(offers(other, refusedReq.request_id)).toEqual([]);
      expect(store.store.getDocument(refusedReq.request_digest)).toBeNull();
      expect(store.cards.filter((c) => c.type === TERM_STRANGER_CARD)).toEqual([]);

      // The brand holds the takings (cash_handler vendor) and settles the
      // trial: 14 days at the trial fee of 50000.
      fleet.nowMs = Date.parse('2027-02-16T00:00:00Z');
      const note = brand.engine.issueSettlement({
        proposalDigest: digest,
        periodStart: '2027-02-01T00:00:00.000Z',
        periodEnd: '2027-02-15T00:00:00.000Z',
        grossMinor: '1000000',
      });
      if (!note.ok) throw new Error(note.refusal);
      expect(note.document.fee_due?.minor_units).toBe('50000');
      fleet.pump();
      expect(fleet.outcomes('term_settlement')).toEqual(['applied']);
      expect(brand.store.getOutbox(note.document.settlement_digest)?.receiptOutcome).toBe('stored');
      expect(store.engine.agreement(digest).unanswered).toEqual([note.document.settlement_digest]);

      // After the trial the brand gives the 30 days' notice: 1 March → 31 March.
      fleet.nowMs = Date.parse('2027-03-01T00:00:00Z');
      const ended = brand.engine.terminate({
        proposalDigest: digest,
        effectiveAt: '2027-03-31T00:00:00Z',
      });
      if (!ended.ok) throw new Error(ended.refusal);
      fleet.pump();
      expect(fleet.outcomes('term_termination')).toEqual(['applied']);
      const storeSchedule = store.engine.schedule(digest);
      expect(storeSchedule[storeSchedule.length - 1]?.end).toBe('2027-03-31T00:00:00.000Z');

      // Turned back on, the same request is answered: the pause was the refusal.
      store.packActive.seller = true;
      const retried = ask(other, listing, uri, late);
      fleet.pump();
      expect(other.store.getOutbox(retried.request_digest)?.receiptOutcome).toBe('stored');
      expect(offers(other, retried.request_id).length).toBeGreaterThan(0);
    });
  });

  describe('G-07 the brand’s proposal card lapses (§7.1 steps 4–5)', () => {
    function toBrandCard(): { store: Node; brand: Node; requestId: string; cardId: string } {
      const { store, listing, uri } = setUpStore(fleet);
      const brand = fleet.add(BRAND_DID);
      const requestId = ask(brand, listing, uri).request_id;
      fleet.pump();
      const proposalCard = mustCard(brand, TERM_PROPOSAL_CARD, requestId);
      // Every offer was made at T0, so the head is valid for the default 3
      // days and the card is due by then.
      expect(proposalCard.expiresAtMs).toBe(T0 + 3 * DAY);
      return { store, brand, requestId, cardId: proposalCard.cardId };
    }

    function nothingReachedTheStore(store: Node, brand: Node, requestId: string): void {
      expect(fleet.outcomes('term_proposal')).toEqual([]);
      expect(fleet.inFlight).toEqual([]);
      expect(brand.store.listByRequest(requestId, 'term_agreement_proposal')).toEqual([]);
      expect(store.store.listByRequest(requestId, 'term_agreement_proposal')).toEqual([]);
      expect(card(store, TERM_DECISION_CARD)).toBeUndefined();
    }

    it('the sweep lapses it at its deadline: nothing is sent and the negotiation closes', () => {
      const { store, brand, requestId, cardId } = toBrandCard();
      fleet.nowMs = T0 + 3 * DAY - MINUTE;
      brand.engine.sweep();
      expect(brand.store.getCard(cardId)?.state).toBe('pending');
      expect(brand.closed).toEqual([]);

      fleet.nowMs = T0 + 3 * DAY + MINUTE;
      expect(brand.engine.sweep().lapsed).toBe(1);
      store.engine.sweep();
      fleet.pump();
      expect(brand.store.getCard(cardId)?.state).toBe('lapsed');
      expect(brand.closed).toEqual([cardId]);
      expect(brand.store.getNegotiation(requestId)).toEqual(
        expect.objectContaining({ state: 'closed', closeReason: 'offer_expired' }),
      );
      nothingReachedTheStore(store, brand, requestId);

      // A late yes on the lapsed card mints nothing.
      brand.engine.decideCard(cardId, true);
      brand.engine.sweep();
      fleet.pump();
      nothingReachedTheStore(store, brand, requestId);
      expect(brand.store.getNegotiation(requestId)?.state).toBe('closed');
    });

    it('the workflow’s own expiry lapses it the same way, and the sweep after is a no-op', () => {
      const { store, brand, requestId, cardId } = toBrandCard();
      fleet.nowMs = T0 + 3 * DAY + MINUTE;
      brand.engine.lapseCard(cardId);
      expect(brand.store.getNegotiation(requestId)).toEqual(
        expect.objectContaining({ state: 'closed', closeReason: 'offer_expired' }),
      );
      expect(brand.engine.sweep().lapsed).toBe(0);
      fleet.pump();
      expect(brand.store.getCard(cardId)?.state).toBe('lapsed');
      nothingReachedTheStore(store, brand, requestId);
    });
  });
});
