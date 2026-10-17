/**
 * COMMITMENT_KERNEL §11 and §15 step 4 — the strategy slot on the brand's
 * side of a shelf negotiation.
 *
 *   G-01  with Brain chosen, the round goes to Brain: its brief carries the
 *         deal so far and never the brand's ceilings or the model's limits;
 *         nothing is sent until the move comes back, and Brain's proposal
 *         becomes the counter;
 *   G-02  a spent budget: the fixed style plays without asking Brain, and the owner is told;
 *   G-03  no answer in time: the fixed style plays the round;
 *   G-04  a proposal the owner's rules refuse is not sent (the fixed style
 *         plays); a replayed commit changes nothing;
 *   G-05  values off: the brief carries none; the fixed style when Brain is not chosen;
 *   G-06  the store's side: a counter waits for Brain, whose proposal becomes
 *         the revision;
 *   G-07  Brain's proposal below the automatic floor goes through the same
 *         clamp and floor card as the runner's;
 *   G-08  no answer in time: the store's fixed style answers the counter;
 *   G-09  a value kept in a persona Brain may not read never reaches the brief;
 *   G-10  a failed hand-over lets the fixed style play, on both sides;
 *   G-11  an empty proposal, or one after the gates changed, lets the fixed style play;
 *   G-12  the owner's notice names the budget that ran out;
 *   G-13  the conversation channel: Brain's question rides on the fixed style's
 *         counter as a kind and a part; the store's brief shows Core's own
 *         sentence; a part off the table sends no message;
 *   G-14  the store's question rides on its revision; the strategy's own words
 *         never go out;
 *   G-15  a store whose budget is spent answers in its fixed style without
 *         asking Brain, tells its owner, and incoming counters charge nothing;
 *   G-16  a forged revision whose promise is not the pack's, with a message
 *         naming it, is refused: the store's words reach neither the owner nor
 *         Brain;
 *   G-17  the owner back on the fixed style: Brain's late question to the brand
 *         does not go out.
 *
 * §15 step 11 — Brain makes the store's opening offer:
 *   G-18  the request waits for Brain; the brief holds no asking terms or
 *         limits; Brain's proposal is the first offer;
 *   G-19  an opening below the automatic limit is raised to it, with no card;
 *   G-20  no answer in time, a stop, or a spent budget: the fixed style opens;
 *   G-21  a request that must be answered before Brain's wait is over gets
 *         the fixed opening at once; a replayed move changes nothing.
 *
 * §15 step 11 — Brain asks the owner a yes-or-no question:
 *   G-22  the brand's turn waits on the card (nothing sent, no budget, not
 *         taken by the stale sweep); a yes sends the turn back to Brain with
 *         the answer in its brief, and its proposal is the counter;
 *   G-23  the store's turn: a no goes back to Brain the same way;
 *   G-24  a card left to lapse lets the fixed style play the turn;
 *   G-25  a deal asks at most two questions; an empty one is no question;
 *         the card shows one bounded line.
 *   G-26  a replayed move while the card waits changes nothing; once the
 *         owner answered, a move from the brief before the answer is stale;
 *   G-27  a deal due within a day: the card lapses early enough for the
 *         fixed style to play before the deadline; too near, no question.
 */

import {
  sealTermRecord,
  termValues,
  type TermCounter,
  type TermOffer,
} from '@dina/commerce-protocol';

import { STRATEGY_WAIT_MS, TERM_STRATEGY_CARD } from '../../../src/commerce/term/term_buyer';
import { hash } from '../../../src/commerce/term/term_context';
import { FIRST_OFFER_TURN } from '../../../src/commerce/term/term_seller';
import { TERM_STRATEGY_QUESTION_CARD } from '../../../src/commerce/term/term_questions';
import { SHELF_VENDOR_KIND } from '../../../src/commerce/term/term_model';
import { carriesWithheld, type StrategyMove } from '../../../src/commitment';
import { assemble, type ValueEntry } from '../../../src/commitment/model_store';

import { publishListing } from './term_harness';
import { BRAND_DID, Fleet, juicePolicy, must, STORE_DID, type Node } from './term_harness';

import type { NegotiationBrief } from '../../../src/commitment/strategy_submit';

interface Rig {
  briefs: NegotiationBrief[];
  budget: { left: number; spent?: 'negotiation' | 'owner' };
  settings: { strategy: 'fixed' | 'brain'; valuesOn: boolean };
  submitThrows?: boolean;
}

function withStrategy(node: Node, rig: Rig, entries: ValueEntry[] = []): void {
  node.engine.ctx.deps.valueModels = (kind) =>
    kind === SHELF_VENDOR_KIND
      ? {
          model: assemble(
            kind,
            4,
            { limits: {}, totals: {}, asking: {}, binding: 'card' },
            entries,
          ),
          closedPersonas: [],
        }
      : null;
  node.engine.ctx.deps.strategy = {
    settings: () => rig.settings,
    charge: ({ count }) => {
      if (rig.budget.left < count) return { ok: false, spent: 'owner' };
      rig.budget.left -= count;
      return { ok: true };
    },
    submit: (brief) => {
      if (rig.submitThrows === true) return null; // the real submitter turns every failure into null
      rig.briefs.push(brief);
      return { taskId: `task-${String(rig.briefs.length)}` };
    },
    canSpend: () =>
      rig.budget.left > 0 ? { ok: true } : { ok: false, spent: rig.budget.spent ?? 'owner' },
    // Brain sees untagged entries only here (no persona is Brain-readable in the rig).
    brainModel: (kind) =>
      assemble(
        kind,
        4,
        { limits: {}, totals: {}, asking: {}, binding: 'card' },
        entries.filter((e) => e.persona === undefined),
      ),
  };
}

function setUp(
  fleet: Fleet,
  deadlineSeconds = 3 * 24 * 60 * 60,
): { store: Node; brand: Node; requestId: string } {
  const store = fleet.add(STORE_DID);
  expect(store.engine.setPolicy(juicePolicy()).ok).toBe(true);
  const listing = publishListing(store, {
    listingId: 'slot-3',
    resourceRef: 'slot-3',
    kind: 'shelf',
    region: { scheme: 'postal_area', value: 'IN-560034' },
    tags: ['beverages.juice'],
  });
  if (!listing.ok) throw new Error(listing.refusal);
  const brand = fleet.add(BRAND_DID);
  return {
    store,
    brand,
    requestId: (() => {
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
          max_rounds: 3,
          deadline_seconds: deadlineSeconds,
        },
      });
      if (!started.ok) throw new Error(started.refusal);
      return started.request.request_id;
    })(),
  };
}

function counters(brand: Node, requestId: string): TermCounter[] {
  return brand.store
    .listByRequest(requestId, 'term_counter')
    .map((r) => JSON.parse(r.recordJson) as TermCounter)
    .sort((a, b) => a.round - b.round);
}

/**
 * COMMITMENT_KERNEL §15 step 11: with Brain chosen, the store's opening offer
 * is Brain's turn. Tests about the rounds after it let the fixed style open,
 * and drop that turn's brief.
 */
function openFixed(fleet: Fleet, store: Node, requestId: string, r: Rig): void {
  fleet.pump();
  if (store.store.getTurn(requestId, FIRST_OFFER_TURN)?.state !== 'pending') return;
  store.engine.applyStrategyMove({ requestId, turn: FIRST_OFFER_TURN, move: { kind: 'stop' } });
  r.briefs.splice(0, 1);
  fleet.pump();
}

const propose = (fee: bigint): StrategyMove => ({
  kind: 'propose',
  versions: [{ parts: [{ kind: 'number', name: 'fee', value: fee }], months: 1 }],
});

describe('the strategy slot on the brand’s side', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  const rig = (over: Partial<Rig> = {}): Rig => ({
    briefs: [],
    budget: { left: 10 },
    settings: { strategy: 'brain', valuesOn: true },
    ...over,
  });

  it('G-01: Brain takes the round; its brief withholds the ceilings; its proposal is the counter', () => {
    const r = rig();
    const { brand, requestId } = setUp(fleet);
    withStrategy(brand, r, [
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
    fleet.pump();
    expect(counters(brand, requestId)).toEqual([]);
    const brief = must(r.briefs[0], 'brief');
    expect(brief.ref).toEqual({ negotiationId: requestId, turn: 1 });
    expect(carriesWithheld(brief)).toBe(false);
    expect(JSON.stringify(brief)).not.toContain('300000');
    expect(JSON.stringify(brief.model)).toContain('-150');
    expect(brand.engine.applyStrategyMove({ requestId, turn: 1, move: propose(200_000n) })).toEqual(
      { outcome: 'sent' },
    );
    expect(counters(brand, requestId).map((c) => c.targets.fee)).toEqual(['200000']);
  });

  it('G-02: a spent budget: the fixed style plays without asking Brain, and the owner is told', () => {
    const r = rig({ budget: { left: 0 } });
    const { brand, requestId } = setUp(fleet);
    withStrategy(brand, r);
    fleet.pump();
    expect(r.briefs).toEqual([]);
    expect(counters(brand, requestId)[0]?.targets.fee).toBe('170000');
    expect(brand.cards.some((c) => c.type === TERM_STRATEGY_CARD)).toBe(true);
    // Spent between the ask and the answer: refused on arrival, the fixed style plays.
    const g = new Fleet();
    try {
      const late = rig({ budget: { left: 1 } });
      const second = setUp(g);
      withStrategy(second.brand, late);
      g.pump();
      late.budget.left = 0;
      expect(
        second.brand.engine.applyStrategyMove({
          requestId: second.requestId,
          turn: 1,
          move: propose(200_000n),
        }),
      ).toEqual({ outcome: 'budget_spent' });
    } finally {
      g.closeAll();
    }
  });

  it('G-03: no answer in time: the fixed style plays the round', () => {
    const r = rig();
    const { brand, requestId } = setUp(fleet);
    withStrategy(brand, r);
    fleet.pump();
    expect(counters(brand, requestId)).toEqual([]);
    fleet.advance(STRATEGY_WAIT_MS + 1);
    brand.engine.sweep();
    expect(counters(brand, requestId).map((c) => c.targets.fee)).toEqual(['170000']);
  });

  it('G-04: a proposal the owner rules out is not sent; a replayed commit changes nothing', () => {
    const r = rig();
    const { brand, requestId } = setUp(fleet);
    withStrategy(brand, r, [
      {
        id: 'n1',
        kind: SHELF_VENDOR_KIND,
        covers: ['fee'],
        body: {
          type: 'never',
          label: 'no rent over ₹2,200',
          all: [{ part: 'fee', above: 220_000n }],
        },
      },
    ]);
    fleet.pump();
    expect(brand.engine.applyStrategyMove({ requestId, turn: 1, move: propose(230_000n) })).toEqual(
      {
        outcome: 'refused_never_rule',
      },
    );
    brand.engine.sweep();
    expect(
      counters(brand, requestId).map(
        (c) => termValues([{ name: 'fee', value: c.targets.fee ?? '0' }]).fee,
      ),
    ).toEqual([170_000n]);
    expect(brand.engine.applyStrategyMove({ requestId, turn: 1, move: propose(200_000n) })).toEqual(
      { outcome: 'already_applied' },
    );
  });

  it('G-05: values off leave the brief without values; the fixed style when Brain is not chosen', () => {
    const r = rig({ settings: { strategy: 'brain', valuesOn: false } });
    const { brand } = setUp(fleet);
    withStrategy(brand, r, [
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
    fleet.pump();
    expect(must(r.briefs[0]).model).toEqual({ constrained: [] });

    const g = new Fleet();
    try {
      const fixed = rig({ settings: { strategy: 'fixed', valuesOn: true } });
      const second = setUp(g);
      withStrategy(second.brand, fixed);
      g.pump();
      expect(fixed.briefs).toEqual([]);
      expect(counters(second.brand, second.requestId)[0]?.targets.fee).toBe('170000');
    } finally {
      g.closeAll();
    }
  });

  const offersOf = (store: Node, requestId: string) =>
    store.store
      .listByRequest(requestId, 'term_offer')
      .map(
        (r) =>
          JSON.parse(r.recordJson) as {
            revision: number;
            terms: { name: string; value: string }[];
          },
      )
      .sort((a, b) => a.revision - b.revision)
      .map((o) => termValues(o.terms as never).fee);

  it('G-06: the store’s counter waits for Brain; its proposal is the revision', () => {
    const r = rig();
    const { store, requestId } = setUp(fleet);
    withStrategy(store, r);
    openFixed(fleet, store, requestId, r);
    expect(offersOf(store, requestId)).toEqual([250_000n]);
    const brief = must(r.briefs[0]);
    expect(brief.side).toBe('seller');
    expect(JSON.stringify(brief)).not.toMatch(/150000|180000/); // the floors stay in Core
    expect(store.engine.applyStrategyMove({ requestId, turn: 1, move: propose(220_000n) })).toEqual(
      { outcome: 'answered' },
    );
    expect(offersOf(store, requestId)).toEqual([250_000n, 220_000n]);
  });

  it('G-07: below the automatic floor, the same clamp and floor card as the runner', () => {
    const r = rig();
    const { store, requestId } = setUp(fleet);
    withStrategy(store, r);
    openFixed(fleet, store, requestId, r);
    store.engine.applyStrategyMove({ requestId, turn: 1, move: propose(160_000n) });
    expect(offersOf(store, requestId)).toEqual([250_000n, 180_000n]);
    expect(store.cards.some((c) => c.type === 'term_floor_approval')).toBe(true);
  });

  it('G-08: no answer in time: the store’s fixed style answers', () => {
    const r = rig();
    const { store, requestId } = setUp(fleet);
    withStrategy(store, r);
    openFixed(fleet, store, requestId, r);
    fleet.advance(STRATEGY_WAIT_MS + 1);
    store.engine.sweep();
    const offers = offersOf(store, requestId);
    expect(offers.length).toBe(2);
    expect(offers[1]).toBeLessThan(250_000n);
  });

  it('G-09: a value kept in a persona never reaches the brief', () => {
    const r = rig();
    const { brand } = setUp(fleet);
    withStrategy(brand, r, [
      {
        id: 'p1',
        kind: SHELF_VENDOR_KIND,
        persona: 'health',
        covers: ['stock_run'],
        body: {
          type: 'promise',
          part: 'stock_run',
          value: { dimensions: { crates: 2n, day: 'tue', every_days: 7n }, rupees: -999n },
        },
      },
    ]);
    fleet.pump();
    expect(JSON.stringify(must(r.briefs[0]).model)).not.toContain('-999');
  });

  it('G-10: a failed hand-over lets the fixed style play, on both sides', () => {
    const r = rig({ submitThrows: true });
    const { store, brand, requestId } = setUp(fleet);
    withStrategy(brand, r);
    withStrategy(store, r);
    fleet.pump();
    expect(counters(brand, requestId)[0]?.targets.fee).toBe('170000');
    expect(offersOf(store, requestId).length).toBeGreaterThan(1);
  });

  it('G-11: an empty proposal, or one after the gates changed, lets the fixed style play', () => {
    const r = rig();
    const { brand, requestId } = setUp(fleet);
    withStrategy(brand, r);
    fleet.pump();
    expect(
      brand.engine.applyStrategyMove({
        requestId,
        turn: 1,
        move: { kind: 'propose', versions: [{ parts: [], months: 1 }] },
      }),
    ).toEqual({ outcome: 'nothing_asked' });
    brand.engine.sweep();
    expect(counters(brand, requestId)[0]?.targets.fee).toBe('170000');
    const g = new Fleet();
    try {
      const second = setUp(g);
      withStrategy(second.brand, rig());
      g.pump();
      second.brand.engine.ctx.deps.strategy = {
        ...must(second.brand.engine.ctx.deps.strategy),
        settings: () => ({ strategy: 'fixed', valuesOn: true }),
      };
      expect(
        second.brand.engine.applyStrategyMove({
          requestId: second.requestId,
          turn: 1,
          move: propose(200_000n),
        }),
      ).toEqual({ outcome: 'gates_changed' });
      second.brand.engine.sweep();
      expect(counters(second.brand, second.requestId)[0]?.targets.fee).toBe('170000');
    } finally {
      g.closeAll();
    }
  });

  it('G-12: the notice names the budget that ran out', () => {
    const r = rig({ budget: { left: 0, spent: 'negotiation' } });
    const { brand } = setUp(fleet);
    withStrategy(brand, r);
    fleet.pump();
    const card = brand.cards.find((c) => c.type === TERM_STRATEGY_CARD);
    expect(card?.description).toMatch(/for this shelf deal/);
  });

  it('G-13: Brain’s question rides on the counter; the store sees Core’s own sentence', () => {
    const brandRig = rig();
    const storeRig = rig();
    const { store, brand, requestId } = setUp(fleet);
    withStrategy(brand, brandRig);
    withStrategy(store, storeRig);
    openFixed(fleet, store, requestId, storeRig);
    expect(
      brand.engine.applyStrategyMove({
        requestId,
        turn: 1,
        move: { kind: 'ask_other', message: 'ask_about_part', part: 'share_bps' },
      }),
    ).toEqual({ outcome: 'sent_with_message' });
    const counter = must(counters(brand, requestId)[0]);
    expect(counter.message).toEqual({ kind: 'ask_about_part', part: 'share_bps' });
    expect(counter.targets.fee).toBe('170000'); // the fixed style's counter
    fleet.pump();
    const storeBrief = must(storeRig.briefs[0]);
    expect(JSON.stringify(storeBrief.history)).toContain('Could you move on share_bps?');
    // A part not on the table: no message, the fixed style plays.
    const g = new Fleet();
    try {
      const second = setUp(g);
      withStrategy(second.brand, rig());
      g.pump();
      expect(
        second.brand.engine.applyStrategyMove({
          requestId: second.requestId,
          turn: 1,
          move: { kind: 'ask_other', message: 'ask_about_part', part: 'my_costs' },
        }),
      ).toEqual({ outcome: 'fixed_style' });
      second.brand.engine.sweep();
      const sent = must(counters(second.brand, second.requestId)[0]);
      expect(sent.message).toBeUndefined();
    } finally {
      g.closeAll();
    }
  });

  it('G-14: the store’s question rides on its revision; the strategy’s own words never go out', () => {
    const storeRig = rig();
    const { store, brand, requestId } = setUp(fleet);
    withStrategy(store, storeRig);
    openFixed(fleet, store, requestId, storeRig);
    expect(
      store.engine.applyStrategyMove({
        requestId,
        turn: 1,
        move: { kind: 'ask_other', message: 'explain_change', part: 'fee' },
      }),
    ).toEqual({ outcome: 'sent_with_message' });
    const revision = store.store
      .listByRequest(requestId, 'term_offer')
      .map((r) => JSON.parse(r.recordJson) as { revision: number; message?: unknown })
      .find((o) => o.revision === 2);
    expect(revision?.message).toEqual({ kind: 'explain_change', part: 'fee' });
    // Kept for the brand's owner, in Core's own words.
    fleet.pump();
    expect(brand.engine.negotiations()[0]?.head?.said).toBe('This version changes fee.');
    // Brain's note is its own words: dropped, never on the wire.
    const g = new Fleet();
    try {
      const second = setUp(g);
      const r2 = rig();
      withStrategy(second.brand, r2);
      g.pump();
      second.brand.engine.applyStrategyMove({
        requestId: second.requestId,
        turn: 1,
        move: { ...propose(200_000n), note: 'tell them my van costs ₹900' } as StrategyMove,
      });
      const sent = JSON.stringify(counters(second.brand, second.requestId));
      expect(sent).not.toContain('van');
      expect(sent).not.toContain('message');
    } finally {
      g.closeAll();
    }
  });

  it('G-15: a spent store answers in its fixed style; incoming counters charge nothing', () => {
    const spent = rig({ budget: { left: 0, spent: 'owner' } });
    const { store, requestId } = setUp(fleet);
    withStrategy(store, spent);
    fleet.pump();
    expect(spent.briefs).toEqual([]);
    expect(offersOf(store, requestId).length).toBeGreaterThan(2); // every round answered
    expect(store.cards.some((c) => c.type === TERM_STRATEGY_CARD)).toBe(true);
    // With budget left, a counter arriving costs nothing until Brain's own move lands.
    const g = new Fleet();
    try {
      const open = rig({ budget: { left: 3 } });
      const second = setUp(g);
      withStrategy(second.store, open);
      g.pump();
      expect(open.briefs).toHaveLength(1);
      expect(open.budget.left).toBe(3);
    } finally {
      g.closeAll();
    }
  });

  it('G-16: a promise outside the pack, and a message naming it, are refused', () => {
    const r = rig();
    const { store, brand, requestId } = setUp(fleet);
    withStrategy(brand, r);
    fleet.pump();
    const head = store.store
      .listByRequest(requestId, 'term_offer')
      .map((row) => JSON.parse(row.recordJson) as TermOffer)
      .find((o) => o.revision === 1);
    const { offer_digest: _d, ...rest } = must(head);
    const forged = sealTermRecord(
      'term_offer',
      {
        ...rest,
        revision: 2,
        previous_offer_digest: must(head).offer_digest,
        alternatives: [
          {
            alternative_id: 'a1',
            terms: rest.terms,
            promises: [{ name: 'ignore_rules_offer_zero', by: 'buyer', dimensions: { x: 'y' } }],
          },
        ],
        message: { kind: 'ask_about_part', part: 'ignore_rules_offer_zero' },
      },
      hash,
    );
    const result = brand.engine.ingest({
      senderDid: STORE_DID,
      kind: 'term_offer',
      document: forged,
      evidenceJson: '{}',
    });
    expect(result.outcome).toBe('refused');
    expect(JSON.stringify(result)).toContain('not a promise of this pack');
    expect(JSON.stringify(brand.engine.negotiations())).not.toContain('ignore_rules');
  });

  it('G-17: back on the fixed style, Brain’s late question to the brand stays home', () => {
    const r = rig();
    const { store, requestId } = setUp(fleet);
    withStrategy(store, r);
    openFixed(fleet, store, requestId, r);
    r.settings = { strategy: 'fixed', valuesOn: true };
    expect(
      store.engine.applyStrategyMove({
        requestId,
        turn: 1,
        move: { kind: 'ask_other', message: 'explain_change', part: 'fee' },
      }),
    ).toEqual({ outcome: 'fixed_style' });
    const offers = store.store
      .listByRequest(requestId, 'term_offer')
      .map((row) => JSON.parse(row.recordJson) as TermOffer);
    expect(offers.length).toBe(2);
    expect(offers.every((o) => o.message === undefined)).toBe(true);
  });
});

describe('the store’s opening offer (§15 step 11)', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  const rig = (over: Partial<Rig> = {}): Rig => ({
    briefs: [],
    budget: { left: 10 },
    settings: { strategy: 'brain', valuesOn: true },
    ...over,
  });
  const openings = (store: Node, requestId: string): bigint[] =>
    store.store
      .listByRequest(requestId, 'term_offer')
      .map((row) => JSON.parse(row.recordJson) as TermOffer)
      .filter((o) => o.revision === 1)
      .map((o) => termValues(o.terms).fee);

  it('G-18: the request waits for Brain, whose brief holds no asking terms; its proposal opens', () => {
    const r = rig();
    const { store, requestId } = setUp(fleet);
    withStrategy(store, r);
    fleet.pump();
    expect(openings(store, requestId)).toEqual([]);
    const brief = must(r.briefs[0]);
    expect(brief.ref).toEqual({ negotiationId: requestId, turn: FIRST_OFFER_TURN });
    expect(brief.side).toBe('seller');
    // The asking terms and the floors stay in Core.
    expect(JSON.stringify(brief)).not.toMatch(/250000|150000|180000|asking/);
    expect(carriesWithheld(brief)).toBe(false);
    expect(
      store.engine.applyStrategyMove({ requestId, turn: FIRST_OFFER_TURN, move: propose(260_000n) }),
    ).toEqual({ outcome: 'answered' });
    expect(openings(store, requestId)).toEqual([260_000n]);
    expect(r.budget.left).toBe(9);
    // A replayed move changes nothing.
    expect(
      store.engine.applyStrategyMove({ requestId, turn: FIRST_OFFER_TURN, move: propose(200_000n) }),
    ).toEqual({ outcome: 'already_applied' });
    expect(openings(store, requestId)).toEqual([260_000n]);
  });

  it('G-19: an opening below the automatic limit is raised to it, with no card', () => {
    const r = rig();
    const { store, requestId } = setUp(fleet);
    withStrategy(store, r);
    fleet.pump();
    store.engine.applyStrategyMove({ requestId, turn: FIRST_OFFER_TURN, move: propose(100_000n) });
    expect(openings(store, requestId)).toEqual([180_000n]);
    expect(store.cards.some((c) => c.type === 'term_floor_approval')).toBe(false);
  });

  it('G-20: no answer in time, a stop, or a spent budget: the fixed style opens', () => {
    const late = rig();
    const first = setUp(fleet);
    withStrategy(first.store, late);
    fleet.pump();
    fleet.advance(STRATEGY_WAIT_MS + 1);
    first.store.engine.sweep();
    expect(openings(first.store, first.requestId)).toEqual([250_000n]);

    const g = new Fleet();
    try {
      const stopped = rig();
      const second = setUp(g);
      withStrategy(second.store, stopped);
      g.pump();
      expect(
        second.store.engine.applyStrategyMove({
          requestId: second.requestId,
          turn: FIRST_OFFER_TURN,
          move: { kind: 'stop' },
        }),
      ).toEqual({ outcome: 'fixed_style' });
      expect(openings(second.store, second.requestId)).toEqual([250_000n]);
      expect(stopped.budget.left).toBe(10);
    } finally {
      g.closeAll();
    }

    const h = new Fleet();
    try {
      const spent = rig({ budget: { left: 0, spent: 'owner' } });
      const third = setUp(h);
      withStrategy(third.store, spent);
      h.pump();
      expect(spent.briefs.filter((b) => b.ref.turn === FIRST_OFFER_TURN)).toEqual([]);
      expect(openings(third.store, third.requestId)).toEqual([250_000n]);
      expect(third.store.cards.some((c) => c.type === TERM_STRATEGY_CARD)).toBe(true);
    } finally {
      h.closeAll();
    }
  });

  it('G-21: a request due before Brain’s wait is over opens in the fixed style at once', () => {
    const r = rig();
    const { store, requestId } = setUp(fleet, 10 * 60);
    withStrategy(store, r);
    fleet.pump();
    expect(r.briefs.filter((b) => b.ref.turn === FIRST_OFFER_TURN)).toEqual([]);
    expect(openings(store, requestId)).toEqual([250_000n]);
  });
});

describe('Brain asks the owner (§15 step 11)', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  const rig = (over: Partial<Rig> = {}): Rig => ({
    briefs: [],
    budget: { left: 10 },
    settings: { strategy: 'brain', valuesOn: true },
    ...over,
  });
  const ask = (question: string): StrategyMove => ({ kind: 'ask_owner', question });
  const questionCards = (node: Node) => node.cards.filter((c) => c.type === TERM_STRATEGY_QUESTION_CARD);

  it('G-22: the brand’s turn waits on the card; a yes goes back to Brain, whose proposal is the counter', () => {
    const r = rig();
    const { brand, requestId } = setUp(fleet);
    withStrategy(brand, r);
    fleet.pump();
    expect(
      brand.engine.applyStrategyMove({ requestId, turn: 1, move: ask('May I offer ₹2,000 rent?') }),
    ).toEqual({ outcome: 'asked_owner' });
    const card = must(questionCards(brand)[0]);
    expect(card.description).toBe('Brain asks: May I offer ₹2,000 rent?');
    expect(card.payload).toMatchObject({ question: 'May I offer ₹2,000 rent?', request_id: requestId });
    expect(r.budget.left).toBe(10);
    // Waiting on the owner is not "no answer in time".
    fleet.advance(STRATEGY_WAIT_MS + 1);
    brand.engine.sweep();
    expect(counters(brand, requestId)).toEqual([]);
    expect(brand.engine.decideCard(card.cardId, true)).toEqual({ ok: true });
    const again = must(r.briefs.at(-1));
    expect(again.ref).toEqual({ negotiationId: requestId, turn: 1 });
    expect(again.ownerAnswers).toEqual([{ question: 'May I offer ₹2,000 rent?', answer: 'yes' }]);
    expect(brand.engine.applyStrategyMove({ requestId, turn: 1, move: propose(200_000n) })).toEqual({
      outcome: 'sent',
    });
    expect(counters(brand, requestId).map((c) => c.targets.fee)).toEqual(['200000']);
    // A second answer to the same card changes nothing.
    expect(brand.engine.decideCard(card.cardId, false)).toEqual({ ok: false, refusal: 'already_decided' });
  });

  it('G-23: the store’s turn: a no goes back to Brain the same way', () => {
    const r = rig();
    const { store, requestId } = setUp(fleet);
    withStrategy(store, r);
    openFixed(fleet, store, requestId, r);
    expect(
      store.engine.applyStrategyMove({ requestId, turn: 1, move: ask('Hold the rent this round?') }),
    ).toEqual({ outcome: 'asked_owner' });
    const card = must(questionCards(store)[0]);
    expect(store.engine.decideCard(card.cardId, false)).toEqual({ ok: true });
    expect(must(r.briefs.at(-1)).ownerAnswers).toEqual([
      { question: 'Hold the rent this round?', answer: 'no' },
    ]);
    expect(store.engine.applyStrategyMove({ requestId, turn: 1, move: propose(220_000n) })).toEqual({
      outcome: 'answered',
    });
  });

  it('G-24: a card left to lapse lets the fixed style play the turn', () => {
    const r = rig();
    const { brand, requestId } = setUp(fleet);
    withStrategy(brand, r);
    fleet.pump();
    brand.engine.applyStrategyMove({ requestId, turn: 1, move: ask('Go higher?') });
    const card = must(questionCards(brand)[0]);
    brand.engine.lapseCard(card.cardId);
    brand.engine.sweep();
    expect(counters(brand, requestId).map((c) => c.targets.fee)).toEqual(['170000']);
    expect(brand.store.getTurn(requestId, 1)?.state).toBe('fallen_back');
  });

  it('G-25: at most two questions a deal; an empty one is none; the card shows one bounded line', () => {
    const r = rig();
    const { brand, requestId } = setUp(fleet);
    withStrategy(brand, r);
    fleet.pump();
    expect(brand.engine.applyStrategyMove({ requestId, turn: 1, move: ask('  \n ') })).toEqual({
      outcome: 'fixed_style',
    });
    brand.engine.sweep();
    fleet.pump();
    const turn = counters(brand, requestId).length + 1;
    const long = `First line\nsecond ${'x'.repeat(400)}`;
    expect(brand.engine.applyStrategyMove({ requestId, turn, move: ask(long) })).toEqual({
      outcome: 'asked_owner',
    });
    const first = must(questionCards(brand)[0]);
    expect(first.description).not.toContain('\n');
    expect(first.description.length).toBeLessThanOrEqual('Brain asks: '.length + 280);
    brand.engine.decideCard(first.cardId, true);
    expect(brand.engine.applyStrategyMove({ requestId, turn, move: ask('Second?') })).toEqual({
      outcome: 'asked_owner',
    });
    brand.engine.decideCard(must(questionCards(brand)[1]).cardId, true);
    // The third is not put to the owner: the fixed style plays.
    expect(brand.engine.applyStrategyMove({ requestId, turn, move: ask('Third?') })).toEqual({
      outcome: 'fixed_style',
    });
    expect(questionCards(brand)).toHaveLength(2);
  });

  it('G-26: a replay while the card waits changes nothing; a move from before the answer is stale', () => {
    const r = rig();
    const { brand, requestId } = setUp(fleet);
    withStrategy(brand, r);
    fleet.pump();
    expect(brand.engine.applyStrategyMove({ requestId, turn: 1, move: ask('Go to ₹2,000?') })).toEqual({
      outcome: 'asked_owner',
    });
    // The same commit again, or any other move, while the card waits.
    expect(brand.engine.applyStrategyMove({ requestId, turn: 1, move: ask('Go to ₹2,000?') })).toEqual({
      outcome: 'waiting_owner',
    });
    expect(brand.engine.applyStrategyMove({ requestId, turn: 1, move: propose(200_000n) })).toEqual({
      outcome: 'waiting_owner',
    });
    expect(counters(brand, requestId)).toEqual([]);
    brand.engine.decideCard(must(questionCards(brand)[0]).cardId, true);
    // The first task's move, from a brief with no answers, is stale now.
    expect(
      brand.engine.applyStrategyMove({ requestId, turn: 1, move: propose(200_000n), answersSeen: 0 }),
    ).toEqual({ outcome: 'stale_move' });
    expect(counters(brand, requestId)).toEqual([]);
    expect(
      brand.engine.applyStrategyMove({ requestId, turn: 1, move: propose(200_000n), answersSeen: 1 }),
    ).toEqual({ outcome: 'sent' });
  });

  it('G-27: a deal due within a day: the card lapses in time for the fixed style; too near, no question', () => {
    const r = rig();
    // Two hours to go.
    const { brand, requestId } = setUp(fleet, 2 * 60 * 60);
    withStrategy(brand, r);
    fleet.pump();
    brand.engine.applyStrategyMove({ requestId, turn: 1, move: ask('Go higher?') });
    const card = must(questionCards(brand)[0]);
    const deadline = must(brand.store.getNegotiation(requestId)).deadlineAt;
    expect(card.expiresAtMs).toBeLessThanOrEqual(deadline - 30 * 60 * 1000);
    // Nobody answers: at the card's own lapse the sweep plays the fixed counter.
    fleet.advance(card.expiresAtMs - fleet.nowMs + 1);
    brand.engine.sweep();
    brand.engine.sweep();
    expect(counters(brand, requestId).map((c) => c.targets.fee)).toEqual(['170000']);
    // A long negotiation whose store offer expires first: the card lapses before the offer does.
    const h2 = new Fleet();
    try {
      const longRig = rig();
      const third = setUp(h2, 7 * 24 * 60 * 60);
      withStrategy(third.brand, longRig);
      h2.pump();
      const head = must(
        third.brand.store
          .listByRequest(third.requestId, 'term_offer')
          .map((row) => JSON.parse(row.recordJson) as TermOffer)
          .at(-1),
      );
      // Five hours before the offer expires (days before the negotiation ends).
      h2.advance(Date.parse(head.valid_until) - 5 * 60 * 60 * 1000 - h2.nowMs);
      expect(
        third.brand.engine.applyStrategyMove({ requestId: third.requestId, turn: 1, move: ask('Go higher?') }),
      ).toEqual({ outcome: 'asked_owner' });
      const lapse = must(questionCards(third.brand)[0]).expiresAtMs;
      expect(lapse).toBe(Date.parse(head.valid_until) - 30 * 60 * 1000);
    } finally {
      h2.closeAll();
    }
    // Thirty-four minutes to go: too near to ask.
    const g = new Fleet();
    try {
      const near = rig();
      const second = setUp(g, 34 * 60);
      withStrategy(second.brand, near);
      g.pump();
      expect(
        second.brand.engine.applyStrategyMove({ requestId: second.requestId, turn: 1, move: ask('Go higher?') }),
      ).toEqual({ outcome: 'fixed_style' });
    } finally {
      g.closeAll();
    }
  });
});
