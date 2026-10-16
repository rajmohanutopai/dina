/**
 * COMMITMENT_KERNEL §7, §8 and §15 step 2 — shelf deals through the envelope.
 * Shelf floors and the brand's ceilings are the limits of a limit-only model;
 * the kind's own model adds never-rules and entries kept in personas.
 *
 *   V-01  an empty model for the kind changes nothing: the same offers, the
 *         same cards, the same agreement as with no model at all;
 *   V-02  a store's never-rule ("no rent under ₹2,000") stops Core signing a
 *         revision below it, and the deal binds above it;
 *   V-03  a never-rule kept in the store's closed persona: Core signs no
 *         offer alone, a card asks to open the persona, and the offer goes out
 *         once it is open;
 *   V-04  a brand's never-rule refuses its own yes with the reason, and the
 *         negotiation closes; one kept in a closed persona raises no proposal
 *         card but a card to open it, and the loop goes on once it is open;
 *   V-05  the store's yes while a persona is closed sends no rejection; the
 *         decision card is put again once it is open, and binds;
 *   V-06  a floor card approved after a never-rule was added signs nothing
 *         below it;
 *   V-07  a counter answered while a persona is closed keeps the head, asks
 *         to open it, and is answered once it is open;
 *   V-08  a floor-card yes while a persona is closed asks to open it, and the
 *         concession is signed once it is open;
 *   V-09  the wait ends without the persona: a declined card for the store's
 *         decision sends the uniform rejection; a lapsed card for the brand's
 *         loop closes it; nothing resumes after the card's time;
 *   V-10  a second closing on the same proposal raises a fresh card, which
 *         resumes in turn;
 *   V-11  a decline the inbox recorded before a crash ends the wait before the
 *         sweep could resume it;
 *   V-12  a yes that waited for a persona is not replayed after a crash: when
 *         the persona card's time has passed, the brand gets the rejection.
 */

import { termValues, type TermOffer } from '@dina/commerce-protocol';

import { termAgreementStatus } from '../../../src/commerce/term/term_agreements';
import { TERM_PROPOSAL_CARD } from '../../../src/commerce/term/term_buyer';
import { SHELF_HOST_KIND, SHELF_VENDOR_KIND } from '../../../src/commerce/term/term_model';
import { TERM_PERSONA_CARD } from '../../../src/commerce/term/term_persona';
import { TERM_DECISION_CARD, TERM_FLOOR_CARD } from '../../../src/commerce/term/term_seller';
import { assemble, type ValueEntry, EMPTY_FORM } from '../../../src/commitment/model_store';

import { publishListing } from './term_harness';
import { BRAND_DID, Fleet, HOUR, juicePolicy, must, STORE_DID, type Node } from './term_harness';

const FORM: typeof EMPTY_FORM = { limits: {}, totals: {}, asking: {}, binding: 'card' };

/** Give a node a model for a kind: entries, and which personas are closed. */
function withModel(node: Node, kind: string, entries: ValueEntry[], closed: string[] = []): void {
  node.engine.ctx.deps.valueModels = (asked, touches) => {
    if (asked !== kind) return null;
    const open = entries.filter((e) => e.persona === undefined || !closed.includes(e.persona));
    const closedPersonas = [
      ...new Set(
        entries
          .filter((e) => e.persona !== undefined && closed.includes(e.persona))
          .filter((e) => e.covers.some((c) => touches.includes(c)))
          .map((e) => e.persona as string),
      ),
    ];
    return { model: assemble(kind, 1, FORM, open), closedPersonas };
  };
}

const NO_RENT_UNDER_2000: ValueEntry = {
  id: 'n1',
  kind: SHELF_HOST_KIND,
  covers: ['fee'],
  body: {
    type: 'never',
    label: 'no rent under ₹2,000 a month',
    all: [{ part: 'fee', below: 200_000n }],
  },
};

function setUp(fleet: Fleet): {
  store: Node;
  brand: Node;
  listing: ReturnType<typeof publishListing>;
} {
  const store = fleet.add(STORE_DID);
  const set = store.engine.setPolicy(juicePolicy());
  if (!set.ok) throw new Error(set.refusal);
  const listing = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice'],
  });
  const brand = fleet.add(BRAND_DID);
  return { store, brand, listing };
}

function ask(brand: Node, listing: ReturnType<typeof publishListing>, maxRounds = 3): string {
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
      targets: { fee: '170000', share_bps: '600' },
      ceilings: { fee: '300000', share_bps: '1000' },
      max_rounds: maxRounds,
      deadline_seconds: 3 * 24 * 60 * 60,
    },
  });
  if (!started.ok) throw new Error(started.refusal);
  return started.request.request_id;
}

function offers(node: Node, requestId: string): TermOffer[] {
  return node.store
    .listByRequest(requestId, 'term_offer')
    .map((row) => JSON.parse(row.recordJson) as TermOffer)
    .sort((a, b) => a.revision - b.revision);
}

/** Run a negotiation to the brand's yes and the store's; returns what bound and the cards. */
function run(fleet: Fleet, store: Node, brand: Node, listing: ReturnType<typeof publishListing>) {
  const requestId = ask(brand, listing);
  fleet.pump();
  // Bargain until Dina has a card for the brand (counters answer within hours).
  for (let i = 0; i < 6 && !brand.cards.some((c) => c.type === TERM_PROPOSAL_CARD); i += 1) {
    fleet.advance(13 * HOUR);
    brand.engine.sweep();
    store.engine.sweep();
    fleet.pump();
  }
  const proposalCard = brand.cards.find((c) => c.type === TERM_PROPOSAL_CARD);
  if (proposalCard !== undefined) brand.engine.decideCard(proposalCard.cardId, true);
  fleet.pump();
  const decision = store.cards.find((c) => c.type === TERM_DECISION_CARD);
  if (decision !== undefined) store.engine.decideCard(decision.cardId, true);
  fleet.pump();
  const proposal = brand.store.listByRequest(requestId, 'term_agreement_proposal')[0];
  return {
    requestId,
    offers: offers(store, requestId).map((o) => termValues(o.terms)),
    cards: [...store.cards, ...brand.cards].map((c) => c.type),
    state:
      proposal === undefined
        ? 'none'
        : termAgreementStatus(brand.store, proposal.recordDigest).state,
  };
}

describe('shelf deals through the envelope', () => {
  const fleets: Fleet[] = [];
  const fleet = (): Fleet => {
    const f = new Fleet();
    fleets.push(f);
    return f;
  };
  afterEach(() => {
    for (const f of fleets.splice(0)) f.closeAll();
  });

  it('V-01: an empty model for the kind changes nothing', () => {
    const plain = fleet();
    const a = setUp(plain);
    const before = run(plain, a.store, a.brand, a.listing);

    const modelled = fleet();
    const b = setUp(modelled);
    withModel(b.store, SHELF_HOST_KIND, []);
    withModel(b.brand, SHELF_VENDOR_KIND, []);
    const after = run(modelled, b.store, b.brand, b.listing);

    expect(after.offers).toEqual(before.offers);
    expect(after.cards).toEqual(before.cards);
    expect(after.state).toBe(before.state);
    expect(before.state).toBe('accepted');
    expect(before.offers.length).toBeGreaterThan(1);
  });

  it('V-02: a store’s never-rule stops a revision below it; the deal binds above it', () => {
    const f = fleet();
    const { store, brand, listing } = setUp(f);
    withModel(store, SHELF_HOST_KIND, [NO_RENT_UNDER_2000]);
    const result = run(f, store, brand, listing);
    expect(result.offers.every((o) => o.fee >= 200_000n)).toBe(true);
    expect(result.state).toBe('accepted');
  });

  it('V-03: a never-rule kept in the store’s closed persona: the owner is asked, then the offer goes out', () => {
    const f = fleet();
    const { store, brand, listing } = setUp(f);
    const sealed = [{ ...NO_RENT_UNDER_2000, persona: 'finance' }];
    withModel(store, SHELF_HOST_KIND, sealed, ['finance']);
    const requestId = ask(brand, listing);
    f.pump();
    expect(offers(store, requestId)).toEqual([]);
    const asked = must(
      store.cards.find((c) => c.type === TERM_PERSONA_CARD),
      'persona card',
    );
    expect(asked.payload).toMatchObject({ step: 'first_offer', personas: ['finance'] });
    // Still closed: the sweep leaves it waiting.
    store.engine.sweep();
    expect(offers(store, requestId)).toEqual([]);
    // Opened: the next sweep signs the first offer, and the card closes.
    withModel(store, SHELF_HOST_KIND, sealed, []);
    store.engine.sweep();
    f.pump();
    const sent = offers(store, requestId);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.every((o) => termValues(o.terms).fee >= 200_000n)).toBe(true);
    expect(store.closed).toContain(asked.cardId);
  });

  it('V-04: a brand’s never-rule refuses its own yes or raises no card; a closed persona asks first', () => {
    const f = fleet();
    const { brand, listing } = setUp(f);
    const ruledOut: ValueEntry = {
      id: 'b1',
      kind: SHELF_VENDOR_KIND,
      covers: ['share_bps'],
      body: {
        type: 'never',
        label: 'no share of sales at all',
        all: [{ part: 'share_bps', above: 0n }],
      },
    };
    // A rule added after the card was raised: the yes is refused, and the negotiation closes.
    const requestId = ask(brand, listing, 1);
    f.pump();
    f.advance(13 * HOUR);
    brand.engine.sweep();
    f.pump();
    const card = must(
      brand.cards.find((c) => c.type === TERM_PROPOSAL_CARD),
      'card',
    );
    withModel(brand, SHELF_VENDOR_KIND, [ruledOut]);
    expect(brand.engine.decideCard(card.cardId, true)).toEqual({ ok: false, refusal: 'ruled_out' });
    expect(brand.store.getNegotiation(requestId)).toMatchObject({
      state: 'closed',
      closeReason: 'ruled_out',
    });

    // The rule in force from the start: no card for a version it rules out.
    const h = fleet();
    const early = setUp(h);
    withModel(early.brand, SHELF_VENDOR_KIND, [ruledOut]);
    const earlyId = ask(early.brand, early.listing, 1);
    h.pump();
    h.advance(13 * HOUR);
    early.brand.engine.sweep();
    h.pump();
    expect(early.brand.cards.filter((c) => c.type === TERM_PROPOSAL_CARD)).toEqual([]);
    expect(early.brand.store.getNegotiation(earlyId)).toMatchObject({
      state: 'closed',
      closeReason: 'ruled_out',
    });

    // The same rule kept in a closed persona: no proposal card the owner
    // could not act on; a card asks to open the persona, and the loop waits.
    const g = fleet();
    const second = setUp(g);
    const sealed = [{ ...ruledOut, persona: 'finance' }];
    withModel(second.brand, SHELF_VENDOR_KIND, sealed, ['finance']);
    const again = ask(second.brand, second.listing, 1);
    g.pump();
    g.advance(13 * HOUR);
    second.brand.engine.sweep();
    g.pump();
    expect(second.brand.cards.filter((c) => c.type === TERM_PROPOSAL_CARD)).toEqual([]);
    expect(second.brand.cards.find((c) => c.type === TERM_PERSONA_CARD)?.payload).toMatchObject({
      step: 'proposal',
      personas: ['finance'],
    });
    expect(second.brand.store.getNegotiation(again)?.state).toBe('negotiating');
    // Opened: the loop goes on, the rule is read, and it rules the deal out.
    withModel(second.brand, SHELF_VENDOR_KIND, sealed, []);
    second.brand.engine.sweep();
    g.pump();
    expect(second.brand.cards.filter((c) => c.type === TERM_PROPOSAL_CARD)).toEqual([]);
    expect(second.brand.store.getNegotiation(again)).toMatchObject({
      state: 'closed',
      closeReason: 'ruled_out',
    });
  });

  it('V-05: the store’s yes waits for a closed persona: no rejection, and the deal binds once it is open', () => {
    const f = fleet();
    const { store, brand, listing } = setUp(f);
    const sealed = [{ ...NO_RENT_UNDER_2000, id: 'n9', persona: 'finance' }];
    withModel(store, SHELF_HOST_KIND, sealed, []);
    const requestId = ask(brand, listing, 1);
    f.pump();
    f.advance(13 * HOUR);
    brand.engine.sweep();
    store.engine.sweep();
    f.pump();
    const proposalCard = must(
      brand.cards.find((c) => c.type === TERM_PROPOSAL_CARD),
      'card',
    );
    expect(brand.engine.decideCard(proposalCard.cardId, true)).toEqual({ ok: true });
    f.pump();
    const decision = must(
      store.cards.find((c) => c.type === TERM_DECISION_CARD),
      'decision card',
    );
    // The owner said yes while the persona was closed.
    withModel(store, SHELF_HOST_KIND, sealed, ['finance']);
    expect(store.engine.decideCard(decision.cardId, true)).toEqual({
      ok: false,
      refusal: 'persona_closed',
    });
    f.pump();
    expect(f.outcomes('term_decision')).toEqual([]);
    expect(store.cards.find((c) => c.type === TERM_PERSONA_CARD)?.payload).toMatchObject({
      step: 'decision',
    });
    // Opened: the decision card is put again, and a yes binds.
    withModel(store, SHELF_HOST_KIND, sealed, []);
    store.engine.sweep();
    const decisions = store.cards.filter((c) => c.type === TERM_DECISION_CARD);
    expect(decisions).toHaveLength(2);
    expect(store.engine.decideCard(must(decisions[1]).cardId, true)).toEqual({ ok: true });
    f.pump();
    const proposal = must(brand.store.listByRequest(requestId, 'term_agreement_proposal')[0]);
    expect(termAgreementStatus(brand.store, proposal.recordDigest).state).toBe('accepted');
  });

  it('V-06: a floor card approved after a never-rule was added signs nothing below it', () => {
    const f = fleet();
    const { store, brand, listing } = setUp(f);
    // An automatic floor of ₹2,400: the first counter already asks the owner.
    const policy = juicePolicy();
    must(policy.resources[0]).floors.fee = { hard: '150000', auto: '240000' };
    const set = store.engine.setPolicy(policy);
    if (!set.ok) throw new Error(set.refusal);
    const requestId = ask(brand, listing, 2);
    f.pump();
    const floor = must(
      store.cards.find((c) => c.type === TERM_FLOOR_CARD),
      'floor card',
    );
    const head = must(offers(store, requestId).at(-1));
    const headFee = termValues(head.terms).fee;
    // The owner rules out any rent below the head before answering the card.
    withModel(store, SHELF_HOST_KIND, [
      {
        ...NO_RENT_UNDER_2000,
        id: 'n7',
        body: {
          type: 'never',
          label: 'nothing below the head',
          all: [{ part: 'fee', below: headFee }],
        },
      },
    ]);
    const before = offers(store, requestId).length;
    store.engine.decideCard(floor.cardId, true);
    f.pump();
    const after = offers(store, requestId);
    expect(after.length).toBe(before);
    expect(after.every((o) => termValues(o.terms).fee >= headFee)).toBe(true);
  });

  /** A rule kept in the finance persona that no deal here breaks: only reading it matters. */
  const HARMLESS: ValueEntry[] = [
    {
      ...NO_RENT_UNDER_2000,
      id: 'n5',
      persona: 'finance',
      body: { type: 'never', label: 'no rent under ₹100', all: [{ part: 'fee', below: 10_000n }] },
    },
  ];

  it('V-07: a counter waits for a closed persona, then is answered', () => {
    const f = fleet();
    const { store, brand, listing } = setUp(f);
    withModel(store, SHELF_HOST_KIND, HARMLESS, []);
    const requestId = ask(brand, listing, 3);
    f.pump(1); // the request: the first offer is signed while the persona is open
    expect(offers(store, requestId)).toHaveLength(1);
    withModel(store, SHELF_HOST_KIND, HARMLESS, ['finance']);
    f.pump(); // the brand counters; the store signs nothing alone
    expect(offers(store, requestId)).toHaveLength(1);
    const asked = must(
      store.cards.find((c) => c.type === TERM_PERSONA_CARD),
      'persona card',
    );
    expect(asked.payload).toMatchObject({ step: 'counter' });
    withModel(store, SHELF_HOST_KIND, HARMLESS, []);
    store.engine.sweep();
    f.pump();
    expect(offers(store, requestId).length).toBeGreaterThan(1);
  });

  it('V-08: a floor-card yes waits for a closed persona, then the concession is signed', () => {
    const f = fleet();
    const { store, brand, listing } = setUp(f);
    const policy = juicePolicy();
    must(policy.resources[0]).floors.fee = { hard: '150000', auto: '240000' };
    const set = store.engine.setPolicy(policy);
    if (!set.ok) throw new Error(set.refusal);
    withModel(store, SHELF_HOST_KIND, HARMLESS, []);
    const requestId = ask(brand, listing, 2);
    f.pump();
    const floor = must(
      store.cards.find((c) => c.type === TERM_FLOOR_CARD),
      'floor card',
    );
    const before = offers(store, requestId).length;
    withModel(store, SHELF_HOST_KIND, HARMLESS, ['finance']);
    store.engine.decideCard(floor.cardId, true);
    f.pump();
    expect(offers(store, requestId)).toHaveLength(before);
    expect(store.cards.find((c) => c.type === TERM_PERSONA_CARD)?.payload).toMatchObject({
      step: 'concession',
    });
    withModel(store, SHELF_HOST_KIND, HARMLESS, []);
    store.engine.sweep();
    f.pump();
    expect(offers(store, requestId)).toHaveLength(before + 1);
  });

  /** Drive a store to a pending decision card while its persona is open. */
  function toDecision(f: Fleet) {
    const { store, brand, listing } = setUp(f);
    withModel(store, SHELF_HOST_KIND, HARMLESS, []);
    const requestId = ask(brand, listing, 1);
    f.pump();
    f.advance(13 * HOUR);
    brand.engine.sweep();
    store.engine.sweep();
    f.pump();
    const proposalCard = must(
      brand.cards.find((c) => c.type === TERM_PROPOSAL_CARD),
      'card',
    );
    expect(brand.engine.decideCard(proposalCard.cardId, true)).toEqual({ ok: true });
    f.pump();
    const proposal = must(brand.store.listByRequest(requestId, 'term_agreement_proposal')[0]);
    return { store, brand, requestId, digest: proposal.recordDigest };
  }

  it('V-09: a declined or lapsed wait ends the step; nothing resumes after its time', () => {
    const f = fleet();
    const { store, brand, digest } = toDecision(f);
    const decision = must(store.cards.find((c) => c.type === TERM_DECISION_CARD));
    withModel(store, SHELF_HOST_KIND, HARMLESS, ['finance']);
    store.engine.decideCard(decision.cardId, true);
    const wait = must(store.cards.find((c) => c.type === TERM_PERSONA_CARD));
    expect(store.engine.decideCard(wait.cardId, false)).toEqual({ ok: true });
    f.pump();
    expect(termAgreementStatus(brand.store, digest).state).toBe('rejected');

    // The brand's loop: the card lapses unanswered, and the negotiation closes.
    const g = fleet();
    const second = setUp(g);
    withModel(
      second.brand,
      SHELF_VENDOR_KIND,
      [
        {
          ...NO_RENT_UNDER_2000,
          id: 'v1',
          kind: SHELF_VENDOR_KIND,
          persona: 'finance',
          body: {
            type: 'never',
            label: 'no rent over ₹5,000',
            all: [{ part: 'fee', above: 500_000n }],
          },
        },
      ],
      ['finance'],
    );
    const requestId = ask(second.brand, second.listing, 1);
    g.pump();
    g.advance(13 * HOUR);
    second.brand.engine.sweep();
    expect(second.brand.cards.some((c) => c.type === TERM_PERSONA_CARD)).toBe(true);
    g.advance(25 * HOUR);
    // Opened only after the card's time: nothing resumes, the loop is closed.
    withModel(second.brand, SHELF_VENDOR_KIND, [], []);
    second.brand.engine.sweep();
    expect(second.brand.store.getNegotiation(requestId)).toMatchObject({
      state: 'closed',
      closeReason: 'persona_closed',
    });
    expect(second.brand.cards.some((c) => c.type === TERM_PROPOSAL_CARD)).toBe(false);
  });

  it('V-10: a second closing on the same proposal raises a fresh card', () => {
    const f = fleet();
    const { store, brand, digest } = toDecision(f);
    const first = must(store.cards.find((c) => c.type === TERM_DECISION_CARD));
    withModel(store, SHELF_HOST_KIND, HARMLESS, ['finance']);
    store.engine.decideCard(first.cardId, true);
    withModel(store, SHELF_HOST_KIND, HARMLESS, []);
    store.engine.sweep();
    const second = must(store.cards.filter((c) => c.type === TERM_DECISION_CARD)[1]);
    withModel(store, SHELF_HOST_KIND, HARMLESS, ['finance']);
    expect(store.engine.decideCard(second.cardId, true)).toEqual({
      ok: false,
      refusal: 'persona_closed',
    });
    const waits = store.cards.filter((c) => c.type === TERM_PERSONA_CARD);
    expect(waits).toHaveLength(2);
    withModel(store, SHELF_HOST_KIND, HARMLESS, []);
    store.engine.sweep();
    const third = must(store.cards.filter((c) => c.type === TERM_DECISION_CARD)[2]);
    expect(store.engine.decideCard(third.cardId, true)).toEqual({ ok: true });
    f.pump();
    expect(termAgreementStatus(brand.store, digest).state).toBe('accepted');
  });

  it('V-11: a decline recorded before a crash ends the wait instead of resuming it', () => {
    const f = fleet();
    const { store, brand, listing } = setUp(f);
    withModel(store, SHELF_HOST_KIND, HARMLESS, ['finance']);
    const requestId = ask(brand, listing);
    f.pump();
    const wait = must(store.cards.find((c) => c.type === TERM_PERSONA_CARD));
    // The inbox recorded "no"; the engine never heard it. Then the persona opens.
    store.inboxAnswers.set(wait.cardId, 'declined');
    withModel(store, SHELF_HOST_KIND, HARMLESS, []);
    store.engine.sweep();
    f.pump();
    expect(store.store.getCard(wait.cardId)?.state).toBe('declined');
    expect(offers(store, requestId)).toEqual([]);
  });

  it('V-12: a waited-on yes is not replayed after a crash past the persona card’s time', () => {
    const f = fleet();
    const { store, brand, digest } = toDecision(f);
    const decision = must(store.cards.find((c) => c.type === TERM_DECISION_CARD));
    withModel(store, SHELF_HOST_KIND, HARMLESS, ['finance']);
    expect(store.engine.decideCard(decision.cardId, true)).toEqual({
      ok: false,
      refusal: 'persona_closed',
    });
    // The inbox task was never closed (a crash); a day and more passes; the persona opens.
    store.inboxAnswers.set(decision.cardId, 'approved');
    f.advance(25 * HOUR);
    withModel(store, SHELF_HOST_KIND, HARMLESS, []);
    store.engine.sweep();
    f.pump();
    expect(store.finished).toContainEqual({
      cardId: decision.cardId,
      ok: false,
      refusal: 'persona_closed',
    });
    expect(termAgreementStatus(brand.store, digest).state).toBe('rejected');
  });
});
