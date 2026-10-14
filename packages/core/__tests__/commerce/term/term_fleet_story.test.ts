/**
 * SHELF_SPACE_NEGOTIATION §10 step 10 — the fleet scenario, start to end.
 *
 * A store rents out four slots. Two juice brands take a slot each, through
 * Dina, with both owners approving. Then a third juice brand and a snack brand
 * bargain AT THE SAME TIME: the juice brand meets floors raised by the two
 * juice deals already in force (15% per brand, so 30%); the snack brand meets
 * the plain floors. Both owners approve both deals. Six Home Nodes, each a
 * real term engine; they talk only through both sides' gates.
 *
 * What it pins, beyond each rule's own scenario:
 *   - the holding count comes from AGREEMENTS this store made, not from
 *     manual holdings: each accepted juice deal raises the next brand's floors;
 *   - two negotiations on one store run at once without crossing;
 *   - every party ends with the same agreement and the same statement as its
 *     counterparty, and the store's public listings never carry a number of
 *     its own terms.
 */

import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { TERM_DECISION_CARD, TERM_FLOOR_CARD } from '../../../src/commerce/term/term_seller';

import { publishListing } from './term_harness';
import { DAY, Fleet, HOUR, juicePolicy, STORE_DID, type Node } from './term_harness';

import type { TermResourcePolicy } from '../../../src/commerce/term/term_policy';
import type { TermListing, TermOffer } from '@dina/commerce-protocol';

const JUICE_A = 'did:plc:juicebrandaaaaaaaaaaaaaaaaa';
const JUICE_B = 'did:plc:juicebrandbbbbbbbbbbbbbbbbb';
const JUICE_C = 'did:plc:juicebrandccccccccccccccccc';
const SNACKS = 'did:plc:snackbrand00000000000000000';

/** slot-1 and slot-2 are copies of the juice shelf (slot-3) under their own names. */
function storePolicy() {
  const base = juicePolicy();
  const juiceShelf = base.resources[0] as TermResourcePolicy;
  return juicePolicy({
    resources: [
      { ...juiceShelf, resource_ref: 'slot-1' },
      { ...juiceShelf, resource_ref: 'slot-2' },
      ...base.resources,
    ],
  });
}

interface Published {
  listing: TermListing;
  uri: string;
}

function publish(store: Node, slot: string): Published {
  const published = publishListing(store, {
    listingId: slot,
    resourceRef: slot,
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice', 'snacks'],
  });
  if (!published.ok) throw new Error(published.refusal);
  return { listing: published.listing, uri: published.uri };
}

function ask(brand: Node, at: Published, tag: string): string {
  const started = brand.engine.startNegotiation({
    listing: at.listing,
    listingUri: at.uri,
    tag,
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

function chain(brand: Node, requestId: string): TermOffer[] {
  return brand.store
    .listByRequest(requestId, 'term_offer')
    .map((r) => JSON.parse(r.recordJson) as TermOffer)
    .sort((a, b) => a.revision - b.revision);
}

function feeOf(offer: TermOffer | undefined): string | undefined {
  return offer?.terms.find((t) => t.name === 'fee')?.value;
}

/** The brand's owner says yes to the offer Dina found; returns the proposal digest. */
function brandApproves(fleet: Fleet, brand: Node, requestId: string): string {
  const proposalCard = brand.cards.find(
    (c) => c.type === TERM_PROPOSAL_CARD && c.payload.request_id === requestId,
  );
  if (proposalCard === undefined) throw new Error(`no proposal card for ${requestId}`);
  brand.engine.decideCard(proposalCard.cardId, true);
  fleet.pump();
  const proposal = brand.store.listByRequest(requestId, 'term_agreement_proposal')[0];
  if (proposal === undefined) throw new Error('no proposal sent');
  return proposal.recordDigest;
}

function storeApproves(fleet: Fleet, store: Node, proposalDigest: string): void {
  const decision = store.cards.find(
    (c) => c.type === TERM_DECISION_CARD && c.payload.proposal_digest === proposalDigest,
  );
  if (decision === undefined) throw new Error('no decision card');
  store.engine.decideCard(decision.cardId, true);
  fleet.pump();
}

/** One full deal: bargain, the brand approves, the store approves. */
function placeDeal(
  fleet: Fleet,
  store: Node,
  brand: Node,
  at: Published,
  tag: string,
): { requestId: string; digest: string } {
  const requestId = ask(brand, at, tag);
  fleet.pump();
  const digest = brandApproves(fleet, brand, requestId);
  storeApproves(fleet, store, digest);
  return { requestId, digest };
}

describe('the fleet story (§10 step 10)', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  it('two juice deals raise the third juice brand’s floors by 30%; a snack brand bargaining at the same time meets plain floors; both owners approve both', () => {
    const store = fleet.add(STORE_DID);
    const set = store.engine.setPolicy(storePolicy());
    if (!set.ok) throw new Error(set.refusal);
    const [slot1, slot2, slot3, slot4] = ['slot-1', 'slot-2', 'slot-3', 'slot-4'].map((slot) =>
      publish(store, slot),
    ) as [Published, Published, Published, Published];
    const [juiceA, juiceB, juiceC, snacks] = [JUICE_A, JUICE_B, JUICE_C, SNACKS].map((did) =>
      fleet.add(did),
    ) as [Node, Node, Node, Node];

    // --- two juice brands are placed, each through Dina ------------------------
    const placedA = placeDeal(fleet, store, juiceA, slot1, 'beverages.juice');
    expect(store.engine.agreement(placedA.digest).status).toBe('accepted');
    const placedB = placeDeal(fleet, store, juiceB, slot2, 'beverages.juice');
    expect(store.engine.agreement(placedB.digest).status).toBe('accepted');
    const [dealA, dealB] = [placedA.digest, placedB.digest];

    // --- a third juice brand and a snack brand bargain at once -----------------
    const juiceRequest = ask(juiceC, slot3, 'beverages.juice');
    const snackRequest = ask(snacks, slot4, 'snacks');
    fleet.pump();

    const juiceChain = chain(juiceC, juiceRequest);
    const snackChain = chain(snacks, snackRequest);
    // The juice brand's last offer sits on the raised automatic limit:
    // 180000 × (1 + 2 × 15%) = 234000, never the plain 180000.
    expect(feeOf(juiceChain[juiceChain.length - 1])).toBe('234000');
    // The owner is asked ONCE about going lower (one open floor card per
    // negotiation, however many counters want more) — Core never goes below
    // the raised limit on its own. The first counter asked 210000.
    const juiceFloorCards = store.cards.filter(
      (c) => c.type === TERM_FLOOR_CARD && c.payload.request_id === juiceRequest,
    );
    expect(juiceFloorCards.map((c) => c.payload.asked)).toEqual([{ fee: '210000' }]);
    // The share floor rose by the same 30%: 500 → 650, where the chain stops.
    expect(
      juiceChain[juiceChain.length - 1]?.terms.find((t) => t.name === 'share_bps')?.value,
    ).toBe('650');
    // The snack brand meets slot-4's plain terms: its asking 200000 moves
    // halfway toward 170000 each round, nowhere near its 150000 floor.
    expect(snackChain.map(feeOf)).toEqual(['200000', '185000', '177500', '173750']);
    // Neither negotiation saw the other's documents.
    expect(juiceChain.every((o) => o.request_id === juiceRequest)).toBe(true);
    expect(snackChain.every((o) => o.request_id === snackRequest)).toBe(true);
    expect(juiceC.store.listByRequest(snackRequest, 'term_offer')).toEqual([]);
    expect(snacks.store.listByRequest(juiceRequest, 'term_offer')).toEqual([]);

    // --- both owners approve both deals ---------------------------------------
    const dealC = brandApproves(fleet, juiceC, juiceRequest);
    // The juice brand's proposal reached the store: "delivered" on its row.
    expect(
      juiceC.engine.negotiations().find((n) => n.requestId === juiceRequest)?.proposalDelivery,
    ).toBe('delivered');
    // The store's phone is asleep when the snack brand says yes: "sent", and
    // it stays sent until a resend lands after the phone wakes.
    fleet.unreachable.add(STORE_DID);
    const dealS = brandApproves(fleet, snacks, snackRequest);
    const snackRow = () => snacks.engine.negotiations().find((n) => n.requestId === snackRequest);
    expect(snackRow()?.proposalDelivery).toBe('sent');
    expect(store.cards.some((c) => c.payload.proposal_digest === dealS)).toBe(false);
    fleet.unreachable.delete(STORE_DID);
    fleet.advance(6 * HOUR);
    snacks.engine.sweep();
    fleet.pump();
    expect(snackRow()?.proposalDelivery).toBe('delivered');
    // Before the store decides, the store has sent nothing for the deal.
    expect(store.engine.agreements().find((a) => a.proposalDigest === dealS)).toMatchObject({
      state: 'proposed',
      delivery: null,
    });
    storeApproves(fleet, store, dealS);
    storeApproves(fleet, store, dealC);
    // The store's yes reached both brands.
    for (const digest of [dealS, dealC]) {
      expect(store.engine.agreements().find((a) => a.proposalDigest === digest)?.delivery).toBe(
        'delivered',
      );
    }

    for (const [brand, requestId, digest, slot] of [
      [juiceA, placedA.requestId, dealA, 'slot-1'],
      [juiceB, placedB.requestId, dealB, 'slot-2'],
      [juiceC, juiceRequest, dealC, 'slot-3'],
      [snacks, snackRequest, dealS, 'slot-4'],
    ] as const) {
      // Each brand and the store hold the same accepted agreement.
      expect(brand.engine.agreement(digest).status).toBe('accepted');
      expect(brand.store.getNegotiation(requestId)?.state).toBe('agreed');
      const mine = brand.engine.agreements().find((a) => a.proposalDigest === digest);
      const theirs = store.engine.agreements().find((a) => a.proposalDigest === digest);
      expect(mine).toMatchObject({ role: 'vendor', counterpartyDid: STORE_DID, resourceRef: slot });
      expect(theirs).toMatchObject({ role: 'host', counterpartyDid: brand.did, resourceRef: slot });
      expect(mine?.terms).toEqual(theirs?.terms);
      expect(mine?.general).toEqual(theirs?.general);
    }
    // Each juice deal raised the next juice brand's automatic limit by 15%:
    // A met 180000, B 207000 (one deal in force), C 234000 (two). The snack
    // brand's rent is untouched by the juice rule.
    const agreed = (digest: string) =>
      store.engine
        .agreements()
        .find((a) => a.proposalDigest === digest)
        ?.terms.find((t) => t.name === 'fee')?.value;
    expect([dealA, dealB, dealC, dealS].map(agreed)).toEqual([
      '180000',
      '207000',
      '234000',
      '173750',
    ]);

    // --- the public record carries no term of the store's ---------------------
    for (const { listing } of store.engine.listings()) {
      const keys = JSON.stringify(listing);
      for (const secret of ['250000', '234000', '180000', '150000', 'fee', 'share_bps', 'floor']) {
        expect(keys).not.toContain(secret);
      }
    }

    // --- a month on, the juice brand settles and both fold one statement -------
    fleet.nowMs = Date.parse('2027-03-01T00:00:00Z') + DAY;
    const firstPeriod = juiceC.engine.schedule(dealC)[0];
    if (firstPeriod === undefined) throw new Error('no schedule');
    const note = juiceC.engine.issueSettlement({
      proposalDigest: dealC,
      periodStart: firstPeriod.start,
      periodEnd: firstPeriod.end,
      grossMinor: '2000000',
    });
    if (!note.ok) throw new Error(note.refusal);
    fleet.pump();
    store.engine.acknowledgeSettlement({
      settlementDigest: note.document.settlement_digest,
      kind: 'accepted',
    });
    fleet.pump();
    expect(juiceC.engine.agreement(dealC).statement).toEqual(
      store.engine.agreement(dealC).statement,
    );
    expect(store.engine.agreement(dealC).statement).toMatchObject({
      ok: true,
      direction: 'vendor_owes_host',
      settlement_count: 1,
    });
  });
});
