/**
 * COMMITMENT_KERNEL §6, §8 step 3, §9 and §15 step 3 — promises, alternatives
 * and legibility on binding cards, end to end on a shelf deal.
 *
 *   A-01  the lorry case: the store's owner enters an alternative ("₹200 less
 *         rent if your run brings my Hosur stock on Tuesday"); the offer
 *         carries it; the brand gets one card per version; it takes the
 *         alternative, and both sides hold the same promise in the agreement;
 *   A-02  the cards: Core's list names every bound part (no omission), the
 *         store's card is for the version the brand chose, and a changed
 *         promise field shows on the brand's card as what changed;
 *   A-03  a valued promise in a model with no walk-away point goes to the
 *         owner's card (§7), never signed alone;
 *   A-04  capacity: a promise the brand's runs cannot carry beside one it
 *         already made is refused for that version; the plain version still binds;
 *   A-05  an alternative past the store's hard floor is never offered, nor one
 *         past its automatic floor (Core signs offers alone only within it);
 *   A-06  capacity counts deals that overlap in time and day: a renewal with
 *         the same run binds; another run on the same day over the same months
 *         does not, one on another day does;
 *   A-07  each version is checked on its own: the offer's own rent above the
 *         brand's ceiling, its alternative within it → a card for the alternative;
 *   A-08  a promise the pack does not declare in full never reaches a card;
 *   A-09  a set of cards retires together: a sibling cannot bind after the
 *         negotiation stepped back to wait for a persona;
 *   A-10  the brand's card shows its model's worth when the model has values;
 *   A-11  a set holding only an alternative card is put again after a refused
 *         yes (the Slot Pack paused, then resumed), and binds;
 *   A-12  capacity is the peak at any one time: two runs that follow each
 *         other do not add up beside a third;
 *   A-13  a part the brand's model cannot value makes the card's worth unknown.
 */

import {
  sealTermRecord,
  termValues,
  type TermAgreementProposal,
  type TermOffer,
  type TermPromise,
} from '@dina/commerce-protocol';

import { termAgreementStatus } from '../../../src/commerce/term/term_agreements';
import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { hash as termHash } from '../../../src/commerce/term/term_context';
import {
  SHELF_VENDOR_KIND,
  shelfEnvelope,
  shelfParts,
} from '../../../src/commerce/term/term_model';
import { TERM_DECISION_CARD } from '../../../src/commerce/term/term_seller';
import { bindsEveryPart, type BindingCard } from '../../../src/commitment';
import { assemble, type ValueEntry } from '../../../src/commitment/model_store';

import { publishListing } from './term_harness';
import { BRAND_DID, Fleet, HOUR, juicePolicy, must, STORE_DID, type Node } from './term_harness';

import type { TermPolicy } from '../../../src/commerce/term/term_policy';

const TUESDAY_RUN: TermPromise = {
  name: 'stock_run',
  by: 'buyer',
  dimensions: { crates: '2', day: 'tue', every_days: '7' },
};

function policyWith(day = 'tue', delta = '-20000'): TermPolicy {
  const policy = juicePolicy({ holding_rules: [] });
  for (const resource of policy.resources)
    resource.alternatives = [
      {
        alternative_id: 'tue_run',
        fee_delta: delta,
        promises: [{ ...TUESDAY_RUN, dimensions: { ...TUESDAY_RUN.dimensions, day } }],
      },
    ];
  return policy;
}

function setUp(fleet: Fleet, policy = policyWith()): { store: Node; brand: Node } {
  const store = fleet.add(STORE_DID);
  const set = store.engine.setPolicy(policy);
  if (!set.ok) throw new Error(set.refusal);
  return { store, brand: fleet.add(BRAND_DID) };
}

function ask(
  store: Node,
  brand: Node,
  slot = 'slot-3',
  maxRounds = 1,
  dates = { start: '2027-02-01T00:00:00Z', end: '2027-08-01T00:00:00Z' },
): string {
  const listing = publishListing(store, {
    listingId: slot,
    resourceRef: slot,
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice'],
  });
  if (!listing.ok) throw new Error(listing.refusal);
  const started = brand.engine.startNegotiation({
    listing: listing.listing,
    listingUri: listing.uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: dates.start,
    end: dates.end,
    policy: {
      currency: 'INR',
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: maxRounds,
      deadline_seconds: 3 * 24 * 60 * 60,
    },
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request.request_id;
}

/** Bargain until the brand has its cards for this request. */
function toCards(fleet: Fleet, store: Node, brand: Node, requestId: string) {
  fleet.pump();
  for (let i = 0; i < 6 && !cardsFor(brand, requestId).some((c) => c.state === 'pending'); i += 1) {
    fleet.advance(13 * HOUR);
    brand.engine.sweep();
    store.engine.sweep();
    fleet.pump();
  }
  return cardsFor(brand, requestId);
}

function cardsFor(brand: Node, requestId: string) {
  return brand.cards
    .filter((c) => c.type === TERM_PROPOSAL_CARD && c.payload.request_id === requestId)
    .map((c) => ({ ...c, state: brand.store.getCard(c.cardId)?.state }));
}

function head(store: Node, requestId: string): TermOffer {
  const offers = store.store
    .listByRequest(requestId, 'term_offer')
    .map((row) => JSON.parse(row.recordJson) as TermOffer)
    .sort((a, b) => a.revision - b.revision);
  return must(offers.at(-1), 'head');
}

describe('promises and alternatives on a shelf deal', () => {
  const fleets: Fleet[] = [];
  const fleet = (): Fleet => {
    const f = new Fleet();
    fleets.push(f);
    return f;
  };
  afterEach(() => {
    for (const f of fleets.splice(0)) f.closeAll();
  });

  it('A-01: the lorry case binds the alternative with its promise on both sides', () => {
    const f = fleet();
    const { store, brand } = setUp(f);
    const requestId = ask(store, brand);
    const cards = toCards(f, store, brand, requestId);
    const offer = head(store, requestId);
    const alt = must(offer.alternatives?.[0], 'alternative');
    expect(termValues(alt.terms).fee).toBe(termValues(offer.terms).fee - 20_000n);
    expect(alt.promises).toEqual([TUESDAY_RUN]);
    // One card per version: the offer's own terms, and the Tuesday run.
    expect(cards.map((c) => c.payload.alternative_id ?? null)).toEqual([null, 'tue_run']);
    const chosen = must(cards.find((c) => c.payload.alternative_id === 'tue_run'));
    expect(brand.engine.decideCard(chosen.cardId, true)).toEqual({ ok: true });
    // The other version's card closes with it.
    expect(brand.store.getCard(must(cards[0]).cardId)?.state).toBe('lapsed');
    f.pump();
    const decision = must(store.cards.find((c) => c.type === TERM_DECISION_CARD));
    expect(store.engine.decideCard(decision.cardId, true)).toEqual({ ok: true });
    f.pump();
    const row = must(brand.store.listByRequest(requestId, 'term_agreement_proposal')[0]);
    for (const node of [store, brand]) {
      const status = termAgreementStatus(node.store, row.recordDigest);
      expect(status.state).toBe('accepted');
      const proposal = (status as { proposal: TermAgreementProposal }).proposal;
      expect(proposal.alternative_id).toBe('tue_run');
      expect(proposal.promises).toEqual([TUESDAY_RUN]);
      expect(proposal.terms).toEqual(alt.terms);
    }
  });

  it('A-02: cards name every bound part, the version chosen, and a changed promise field', () => {
    const f = fleet();
    const { store, brand } = setUp(f);
    const requestId = ask(store, brand, 'slot-3', 1);
    f.pump(1); // the request: the first offer goes out with the Tuesday run
    // Before the brand's card: the owner moves the run to Wednesday; the next
    // revision carries it, and the brand's card says what changed.
    expect(store.engine.setPolicy(policyWith('wed')).ok).toBe(true);
    const cards = toCards(f, store, brand, requestId);
    const offer = head(store, requestId);
    expect(offer.revision).toBe(2);
    const alt = must(cards.find((c) => c.payload.alternative_id === 'tue_run'));
    const legibility = alt.payload.legibility as BindingCard;
    const version = {
      parts: shelfParts(
        must(offer.alternatives?.[0]).terms,
        offer.general,
        must(offer.alternatives?.[0]).promises,
      ),
      months: 6,
    };
    expect(bindsEveryPart(legibility, version)).toBe(true);
    expect(
      legibility.changed.some((line) => line.includes('day: tue') && line.includes('day: wed')),
    ).toBe(true);
    expect(legibility.risks[0]).toBe(
      'You promise: stock_run (crates: 2, day: wed, every_days: 7).',
    );
    // The store's card is for the version the brand chose.
    expect(brand.engine.decideCard(alt.cardId, true)).toEqual({ ok: true });
    f.pump();
    const decision = must(store.cards.find((c) => c.type === TERM_DECISION_CARD));
    expect(decision.payload.alternative_id).toBe('tue_run');
    const storeCard = decision.payload.legibility as BindingCard;
    expect(storeCard.risks[0]).toMatch(/^the brand promises: stock_run \(crates: 2, day: wed/);
    expect(storeCard.binds.map((b) => b.part)).toEqual(['fee', 'share_bps', 'stock_run']);
  });

  it('A-03: a valued promise in a model with no walk-away point goes to the owner', () => {
    const f = fleet();
    const { brand } = setUp(f);
    const valued: ValueEntry = {
      id: 'p1',
      kind: SHELF_VENDOR_KIND,
      covers: ['stock_run'],
      body: {
        type: 'promise',
        part: 'stock_run',
        value: { dimensions: { crates: 2n, day: 'tue', every_days: 7n }, rupees: -150n },
      },
    };
    brand.engine.ctx.deps.valueModels = (kind) =>
      kind === SHELF_VENDOR_KIND
        ? {
            model: assemble(kind, 1, { limits: {}, totals: {}, asking: {}, binding: 'card' }, [
              valued,
            ]),
            closedPersonas: [],
          }
        : null;
    const verdict = shelfEnvelope(brand.engine.ctx, {
      kind: SHELF_VENDOR_KIND,
      holder: 'buyer',
      limits: { fee: { hard: 300_000n, auto: 300_000n }, share_bps: { hard: 1000n, auto: 1000n } },
      terms: [
        { name: 'fee', value: '230000' },
        { name: 'share_bps', value: '1000' },
      ],
      promises: [TUESDAY_RUN],
      general: {
        tag: 'beverages.juice',
        currency: 'INR',
        start: '2027-02-01T00:00:00Z',
        end: '2027-08-01T00:00:00Z',
        period: 'monthly',
        cash_handler: 'vendor',
        exit_notice_days: 30,
      },
      approvedInPerson: false,
    });
    expect(verdict).toMatchObject({
      outcome: 'card',
      reasons: expect.arrayContaining(['needs_walk_away']),
    });
  });

  it('A-04: a promise past the brand’s capacity is refused; the plain version still binds', () => {
    const f = fleet();
    const { store, brand } = setUp(f);
    // The brand's runs carry two crates in all.
    const capacity: ValueEntry = {
      id: 'c1',
      kind: SHELF_VENDOR_KIND,
      covers: ['stock_run'],
      body: { type: 'capacity', part: 'stock_run', dimension: 'crates', amount: 2n },
    };
    brand.engine.ctx.deps.valueModels = (kind) =>
      kind === SHELF_VENDOR_KIND
        ? {
            model: assemble(kind, 1, { limits: {}, totals: {}, asking: {}, binding: 'card' }, [
              capacity,
            ]),
            closedPersonas: [],
          }
        : null;
    const first = ask(store, brand, 'slot-3');
    const firstCards = toCards(f, store, brand, first);
    expect(
      brand.engine.decideCard(
        must(firstCards.find((c) => c.payload.alternative_id === 'tue_run')).cardId,
        true,
      ),
    ).toEqual({
      ok: true,
    });
    f.pump();
    const second = ask(store, brand, 'slot-4');
    const secondCards = toCards(f, store, brand, second);
    const alt = must(secondCards.find((c) => c.payload.alternative_id === 'tue_run'));
    expect(brand.engine.decideCard(alt.cardId, true)).toEqual({ ok: false, refusal: 'no_room' });
    const plain = must(secondCards.find((c) => c.payload.alternative_id === undefined));
    expect(brand.store.getCard(plain.cardId)?.state).toBe('pending');
    expect(brand.engine.decideCard(plain.cardId, true)).toEqual({ ok: true });
  });

  it('A-05: an alternative past the store’s hard floor is never offered', () => {
    const f = fleet();
    // ₹2,000 less than the ₹2,500 asking falls under the ₹1,500 hard floor.
    const { store, brand } = setUp(f, policyWith('tue', '-200000'));
    const requestId = ask(store, brand);
    f.pump();
    expect(head(store, requestId).alternatives).toBeUndefined();
  });

  const vendorModel = (node: Node, entries: ValueEntry[], closed: string[] = []) => {
    node.engine.ctx.deps.valueModels = (kind, touches) => {
      if (kind !== SHELF_VENDOR_KIND) return null;
      const open = entries.filter((e) => e.persona === undefined || !closed.includes(e.persona));
      const closedPersonas = [
        ...new Set(
          entries
            .filter(
              (e) =>
                e.persona !== undefined &&
                closed.includes(e.persona) &&
                e.covers.some((c) => touches.includes(c)),
            )
            .map((e) => e.persona as string),
        ),
      ];
      return {
        model: assemble(kind, 1, { limits: {}, totals: {}, asking: {}, binding: 'card' }, open),
        closedPersonas,
      };
    };
  };
  const capacityOf = (crates: bigint): ValueEntry => ({
    id: 'c1',
    kind: SHELF_VENDOR_KIND,
    covers: ['stock_run'],
    body: { type: 'capacity', part: 'stock_run', dimension: 'crates', amount: crates },
  });

  it('A-05b: an alternative past the automatic floor is not offered alone', () => {
    const f = fleet();
    // ₹800 less than ₹2,500 is ₹1,700: above the ₹1,500 hard floor, under the ₹1,800 automatic one.
    const { store, brand } = setUp(f, policyWith('tue', '-80000'));
    const requestId = ask(store, brand);
    f.pump(1);
    expect(head(store, requestId).alternatives).toBeUndefined();
  });

  it('A-06: capacity counts only deals that overlap in time and day', () => {
    const f = fleet();
    const { store, brand } = setUp(f);
    vendorModel(brand, [capacityOf(2n)]);
    const first = ask(store, brand, 'slot-3');
    const firstCards = toCards(f, store, brand, first);
    expect(
      brand.engine.decideCard(
        must(firstCards.find((c) => c.payload.alternative_id === 'tue_run')).cardId,
        true,
      ),
    ).toEqual({ ok: true });
    f.pump();
    store.engine.decideCard(
      must(store.cards.find((c) => c.type === TERM_DECISION_CARD)).cardId,
      true,
    );
    f.pump();
    const digest = must(
      brand.store.listByRequest(first, 'term_agreement_proposal')[0],
    ).recordDigest;
    // A renewal with the same run follows the agreement: it never overlaps it.
    const listing = must(
      store.directory.values().next().value as unknown as
        | import('@dina/commerce-protocol').TermListing
        | undefined,
    );
    const renewal = brand.engine.startNegotiation({
      listing,
      listingUri: `at://${listing.seller_did}/com.dinakernel.commerce.termListing/${listing.listing_id}`,
      tag: 'beverages.juice',
      attributes: { skus: 4 },
      start: '2027-08-01T00:00:00Z',
      end: '2028-02-01T00:00:00Z',
      policy: {
        currency: 'INR',
        targets: { fee: '170000', share_bps: '600' },
        ceilings: { fee: '300000', share_bps: '1000' },
        max_rounds: 1,
        deadline_seconds: 3 * 24 * 60 * 60,
        renews: digest,
      },
    });
    if (!renewal.ok) throw new Error(renewal.refusal);
    const renewCards = toCards(f, store, brand, renewal.request.request_id);
    expect(
      brand.engine.decideCard(
        must(renewCards.find((c) => c.payload.alternative_id === 'tue_run')).cardId,
        true,
      ),
    ).toEqual({ ok: true });
  });

  it('A-06b: another run on the same day over the same months does not fit; another day does', () => {
    const f = fleet();
    const store = f.add(STORE_DID);
    const policy = policyWith('tue');
    const slot4 = must(policy.resources[1]);
    slot4.alternatives = [
      {
        alternative_id: 'thu_run',
        fee_delta: '-20000',
        promises: [{ ...TUESDAY_RUN, dimensions: { ...TUESDAY_RUN.dimensions, day: 'thu' } }],
      },
    ];
    expect(store.engine.setPolicy(policy).ok).toBe(true);
    const brand = f.add(BRAND_DID);
    vendorModel(brand, [capacityOf(2n)]);
    const first = ask(store, brand, 'slot-3');
    expect(
      brand.engine.decideCard(
        must(toCards(f, store, brand, first).find((c) => c.payload.alternative_id === 'tue_run'))
          .cardId,
        true,
      ),
    ).toEqual({ ok: true });
    f.pump();
    const thursday = ask(store, brand, 'slot-4');
    expect(
      brand.engine.decideCard(
        must(toCards(f, store, brand, thursday).find((c) => c.payload.alternative_id === 'thu_run'))
          .cardId,
        true,
      ),
    ).toEqual({ ok: true });
  });

  it('A-07: the offer’s own rent above the ceiling, its alternative within it → a card for the alternative', () => {
    const f = fleet();
    const store = f.add(STORE_DID);
    const policy = policyWith('tue', '-20000');
    const res = must(policy.resources[0]);
    res.asking = { fee: '250000', share_bps: '1000' };
    res.floors = { fee: { hard: '200000', auto: '200000' }, share_bps: { hard: '500' } };
    expect(store.engine.setPolicy(policy).ok).toBe(true);
    const brand = f.add(BRAND_DID);
    const listing = publishListing(store, {
      listingId: 'slot-3',
      resourceRef: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      tags: ['beverages.juice'],
    });
    if (!listing.ok) throw new Error(listing.refusal);
    const started = brand.engine.startNegotiation({
      listing: listing.listing,
      listingUri: listing.uri,
      tag: 'beverages.juice',
      attributes: { skus: 4 },
      start: '2027-02-01T00:00:00Z',
      end: '2027-08-01T00:00:00Z',
      policy: {
        currency: 'INR',
        targets: { fee: '230000', share_bps: '1000' },
        ceilings: { fee: '240000', share_bps: '1000' },
        max_rounds: 1,
        deadline_seconds: 3 * 24 * 60 * 60,
      },
    });
    if (!started.ok) throw new Error(started.refusal);
    const cards = toCards(f, store, brand, started.request.request_id);
    expect(cards.map((c) => c.payload.alternative_id ?? null)).toEqual(['tue_run']);
  });

  it('A-08: a promise the pack does not declare in full never reaches a card', () => {
    const f = fleet();
    const { store, brand } = setUp(f);
    const requestId = ask(store, brand);
    f.pump(1); // the request; the store's first offer is in flight
    // A peer sends a promise missing a dimension, sealed so its digest holds.
    const msg = must(f.inFlight.find((m) => m.kind === 'term_offer'));
    const offer = msg.document as TermOffer;
    const { offer_digest: _d, ...draft } = offer;
    const forged = sealTermRecord(
      'term_offer',
      {
        ...draft,
        alternatives: [
          {
            ...must(offer.alternatives?.[0]),
            promises: [{ name: 'stock_run', by: 'buyer', dimensions: { crates: '2', day: 'tue' } }],
          },
        ],
      },
      termHash,
    );
    msg.document = forged;
    const forgedDigest = (forged as unknown as { offer_digest: string }).offer_digest;
    toCards(f, store, brand, requestId);
    // No card for the forged version, whatever the later revisions carry.
    const onForged = cardsFor(brand, requestId).filter(
      (c) => brand.store.getCard(c.cardId)?.refDigest === forgedDigest,
    );
    expect(onForged.some((c) => c.payload.alternative_id === 'tue_run')).toBe(false);
    // And the brand would bind no version naming it: the forged promise
    // never appears in a card's payload.
    expect(
      cardsFor(brand, requestId).some((c) =>
        JSON.stringify(c.payload.promises ?? []).includes('"day":"tue"}'),
      ),
    ).toBe(false);
  });

  it('A-09: a sibling card cannot bind after the set stepped back for a persona', () => {
    const f = fleet();
    const { store, brand } = setUp(f);
    const sealed: ValueEntry = {
      id: 'n1',
      kind: SHELF_VENDOR_KIND,
      persona: 'finance',
      covers: ['fee'],
      body: {
        type: 'never',
        label: 'no rent over ₹5,000',
        all: [{ part: 'fee', above: 500_000n }],
      },
    };
    vendorModel(brand, [sealed]);
    const requestId = ask(store, brand);
    const cards = toCards(f, store, brand, requestId);
    vendorModel(brand, [sealed], ['finance']);
    const alt = must(cards.find((c) => c.payload.alternative_id === 'tue_run'));
    expect(brand.engine.decideCard(alt.cardId, true)).toEqual({
      ok: false,
      refusal: 'persona_closed',
    });
    const plain = must(cards.find((c) => c.payload.alternative_id === undefined));
    expect(brand.store.getCard(plain.cardId)?.state).toBe('lapsed');
    expect(brand.engine.decideCard(plain.cardId, true)).toEqual({
      ok: false,
      refusal: 'already_decided',
    });
    expect(brand.store.listByRequest(requestId, 'term_agreement_proposal')).toEqual([]);
  });

  it('A-10: the brand’s card shows its model’s worth when the model has values', () => {
    const f = fleet();
    const { store, brand } = setUp(f);
    vendorModel(brand, [
      {
        id: 'p1',
        kind: SHELF_VENDOR_KIND,
        covers: ['stock_run'],
        body: {
          type: 'promise',
          part: 'stock_run',
          value: { dimensions: { crates: 2n, day: 'tue', every_days: 7n }, rupees: -150n },
        },
      },
    ]);
    const requestId = ask(store, brand);
    const alt = must(
      toCards(f, store, brand, requestId).find((c) => c.payload.alternative_id === 'tue_run'),
    );
    expect((alt.payload.legibility as BindingCard).worth).toMatch(/^worth -₹\d+ a month to you$/);
  });

  it('A-11: a set of only an alternative card is put again after a paused yes, and binds', () => {
    const f = fleet();
    const store = f.add(STORE_DID);
    const policy = policyWith('tue', '-20000');
    must(policy.resources[0]).floors = {
      fee: { hard: '200000', auto: '200000' },
      share_bps: { hard: '500' },
    };
    expect(store.engine.setPolicy(policy).ok).toBe(true);
    const brand = f.add(BRAND_DID);
    const listing = publishListing(store, {
      listingId: 'slot-3',
      resourceRef: 'slot-3',
      kind: 'shelf',
      region: { scheme: 'postal_area', value: 'IN-560034' },
      tags: ['beverages.juice'],
    });
    if (!listing.ok) throw new Error(listing.refusal);
    const started = brand.engine.startNegotiation({
      listing: listing.listing,
      listingUri: listing.uri,
      tag: 'beverages.juice',
      attributes: { skus: 4 },
      start: '2027-02-01T00:00:00Z',
      end: '2027-08-01T00:00:00Z',
      policy: {
        currency: 'INR',
        targets: { fee: '230000', share_bps: '1000' },
        ceilings: { fee: '240000', share_bps: '1000' },
        max_rounds: 1,
        deadline_seconds: 3 * 24 * 60 * 60,
      },
    });
    if (!started.ok) throw new Error(started.refusal);
    const requestId = started.request.request_id;
    const first = toCards(f, store, brand, requestId);
    expect(first.map((c) => c.payload.alternative_id ?? null)).toEqual(['tue_run']);
    brand.packActive.buyer = false;
    expect(brand.engine.decideCard(must(first[0]).cardId, true)).toEqual({
      ok: false,
      refusal: 'pack_inactive',
    });
    brand.packActive.buyer = true;
    brand.engine.sweep();
    f.pump();
    const again = cardsFor(brand, requestId).filter((c) => c.state === 'pending');
    expect(again.map((c) => c.payload.alternative_id ?? null)).toEqual(['tue_run']);
    expect(brand.engine.decideCard(must(again[0]).cardId, true)).toEqual({ ok: true });
  });

  it('A-12: capacity is the peak at any one time, not a sum over the year', () => {
    const f = fleet();
    const store = f.add(STORE_DID);
    const policy = policyWith();
    policy.resources.push({ ...must(policy.resources[1]), resource_ref: 'slot-5' });
    expect(store.engine.setPolicy(policy).ok).toBe(true);
    const brand = f.add(BRAND_DID);
    vendorModel(brand, [capacityOf(4n)]);
    const bind = (slot: string, start: string, end: string) => {
      const id = ask(store, brand, slot, 1, { start, end });
      const alt = must(
        toCards(f, store, brand, id).find((c) => c.payload.alternative_id === 'tue_run'),
      );
      return brand.engine.decideCard(alt.cardId, true);
    };
    // Two Tuesday runs of two crates, one after the other.
    expect(bind('slot-3', '2027-02-01T00:00:00Z', '2027-04-01T00:00:00Z')).toEqual({ ok: true });
    f.pump();
    expect(bind('slot-4', '2027-04-01T00:00:00Z', '2027-06-01T00:00:00Z')).toEqual({ ok: true });
    f.pump();
    // A third over both: at most two plus two crates at any one time.
    expect(bind('slot-5', '2027-02-01T00:00:00Z', '2027-06-01T00:00:00Z')).toEqual({ ok: true });
  });

  it('A-13: a promise the brand’s model cannot value makes the worth unknown', () => {
    const f = fleet();
    const { store, brand } = setUp(f, policyWith('wed'));
    // The brand valued a Tuesday run; the store offers a Wednesday one.
    vendorModel(brand, [
      {
        id: 'p1',
        kind: SHELF_VENDOR_KIND,
        covers: ['stock_run'],
        body: {
          type: 'promise',
          part: 'stock_run',
          value: { dimensions: { crates: 2n, day: 'tue', every_days: 7n }, rupees: -150n },
        },
      },
    ]);
    const requestId = ask(store, brand);
    const alt = must(
      toCards(f, store, brand, requestId).find((c) => c.payload.alternative_id === 'tue_run'),
    );
    expect((alt.payload.legibility as BindingCard).worth).toBe(
      'worth not known: part of this deal has no value in your model',
    );
  });
});
