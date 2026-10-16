/**
 * COMMITMENT_KERNEL §11 — the verdict budget, through the engine, with the
 * durable store. Every answer Brain can read about a threshold comes from a
 * charged move; the store survives a relaunch; answers past the budget say
 * nothing about the owner.
 *
 *   E-01  a probe for the brand's hidden ceiling across new negotiations, values
 *         off, every answer charged; the number of answers is at most the
 *         owner's budget, so what Brain learns stays within 1.6 bits each;
 *   E-02  the budget survives a relaunch;
 *   E-03  two moves landing at once draw two verdicts; a replay draws none;
 *   E-04  many counterparties countering the store charge its budget nothing;
 *   E-05  a count of what Brain could observe — the cards raised and the
 *         agreements formed — stays within the stated bound: the inbound
 *         outcomes the counterparties' own probing budgets allowed (I) plus the
 *         owner's own verdicts (N), so at most 1.6 × (N + I) bits.
 */

import { SHELF_HOST_KIND, SHELF_VENDOR_KIND } from '../../../src/commerce/term/term_model';
import { assemble } from '../../../src/commitment/model_store';
import { StrategyStore } from '../../../src/commitment/strategy_store';

import { publishListing } from './term_harness';
import { BRAND2_DID, BRAND_DID, Fleet, juicePolicy, STORE_DID, type Node } from './term_harness';

import type { StrategyMove } from '../../../src/commitment';

const RULES = { perNegotiation: 12, perOwnerMonthly: 4 };
const budget = (node: Node) => new StrategyStore(node.db(), RULES);

/** Brain chosen, values off, the budget in the node's own identity database. */
function durable(node: Node, briefs: unknown[] = []): void {
  // The brand's never-rule: no rent above ₹2,200 a month. Brain knows only
  // that fee is constrained; the figure is what a probe would hunt for.
  node.engine.ctx.deps.valueModels = (kind) => ({
    model: assemble(
      kind,
      1,
      { limits: {}, totals: {}, asking: {}, binding: 'card' },
      kind !== SHELF_VENDOR_KIND
        ? []
        : [
            {
              id: 'n1',
              kind,
              covers: ['fee'],
              body: {
                type: 'never',
                label: 'no rent above ₹2,200',
                all: [{ part: 'fee', above: 220_000n }],
              },
            },
          ],
    ),
    closedPersonas: [],
  });
  node.engine.ctx.deps.strategy = {
    settings: () => ({ strategy: 'brain', valuesOn: false }),
    charge: (a) => budget(node).charge(a),
    canSpend: (a) => budget(node).canSpend(a),
    submit: (brief) => {
      briefs.push(brief);
      return { taskId: `task-${String(briefs.length)}` };
    },
    brainModel: (kind) =>
      assemble(kind, 1, { limits: {}, totals: {}, asking: {}, binding: 'card' }, []),
  };
}

function storeWithListing(fleet: Fleet) {
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
  return { store, listing };
}

function negotiate(
  brand: Node,
  listing: { listing: never; uri: string } | never,
  n: number,
): string {
  const l = listing as unknown as { listing: never; uri: string };
  const started = brand.engine.startNegotiation({
    listing: l.listing,
    listingUri: l.uri,
    tag: 'beverages.juice',
    attributes: { skus: 4 },
    start: `2027-${String(2 + n).padStart(2, '0')}-01T00:00:00Z`,
    end: `2027-${String(3 + n).padStart(2, '0')}-01T00:00:00Z`,
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

/** A counter asking for this fee: past the brand's never-rule, or within it. */
const ask = (fee: bigint): StrategyMove => ({
  kind: 'propose',
  versions: [{ parts: [{ kind: 'number', name: 'fee', value: fee }], months: 1 }],
});

/** Outcomes that tell Brain which side of the threshold it fell. */
const ANSWERS = new Set(['sent', 'refused_never_rule', 'refused_not_enough']);

describe('the verdict budget through the engine', () => {
  let fleet: Fleet;
  beforeEach(() => {
    fleet = new Fleet();
  });
  afterEach(() => fleet.closeAll());

  it('E-01 and E-02: a probe across negotiations gets at most the budget’s answers, through a relaunch', () => {
    const { listing } = storeWithListing(fleet);
    const brand = fleet.add(BRAND_DID);
    durable(brand);
    // Brain searches for the rule's figure between its targets and the offer.
    let low = 170_000n;
    let high = 250_000n;
    let answers = 0;
    let silent = 0;
    for (let n = 0; n < 8; n += 1) {
      if (n === 2) {
        brand.restart(); // the budget lives in the identity database
        durable(brand);
      }
      const requestId = negotiate(brand, listing as never, n);
      fleet.pump();
      const mid = (low + high) / 2n;
      const out = brand.engine.applyStrategyMove({ requestId, turn: 1, move: ask(mid) }).outcome;
      if (!ANSWERS.has(out)) {
        silent += 1; // nothing about the threshold
        continue;
      }
      answers += 1;
      if (out === 'sent') low = mid;
      else high = mid;
    }
    expect(answers).toBeGreaterThan(0); // the probe did reach the threshold
    expect(answers).toBeLessThanOrEqual(RULES.perOwnerMonthly);
    expect(silent).toBeGreaterThanOrEqual(8 - RULES.perOwnerMonthly);
    // Three outcomes per answer: at most log2(3) ≈ 1.6 bits each (§11).
    expect(answers * Math.log2(3)).toBeLessThanOrEqual(1.6 * RULES.perOwnerMonthly);
    expect(high - low).toBeGreaterThan(0n);
  });

  it('E-03: two moves at once draw two verdicts; a replay draws none', () => {
    const { listing } = storeWithListing(fleet);
    const brand = fleet.add(BRAND_DID);
    durable(brand);
    const a = negotiate(brand, listing as never, 0);
    const b = negotiate(brand, listing as never, 1);
    fleet.pump();
    brand.engine.applyStrategyMove({ requestId: a, turn: 1, move: ask(200_000n) });
    brand.engine.applyStrategyMove({ requestId: b, turn: 1, move: ask(200_000n) });
    expect(brand.engine.applyStrategyMove({ requestId: a, turn: 1, move: ask(200_000n) })).toEqual({
      outcome: 'already_applied',
    });
    const left = budget(brand).canSpend({
      kind: SHELF_VENDOR_KIND,
      negotiationId: 'other',
      nowMs: fleet.nowMs,
      thresholdVersion: 1,
    });
    expect(left).toEqual({ ok: true });
    // Two drawn of four: two more allowed, then none.
    for (const id of ['x', 'y'])
      expect(
        budget(brand).charge({
          kind: SHELF_VENDOR_KIND,
          negotiationId: id,
          count: 1,
          nowMs: fleet.nowMs,
          thresholdVersion: 1,
        }),
      ).toEqual({ ok: true });
    expect(
      budget(brand).charge({
        kind: SHELF_VENDOR_KIND,
        negotiationId: 'z',
        count: 1,
        nowMs: fleet.nowMs,
        thresholdVersion: 1,
      }),
    ).toEqual({ ok: false, spent: 'owner' });
  });

  it('E-04: many counterparties countering the store charge its budget nothing', () => {
    const { store, listing } = storeWithListing(fleet);
    const briefs: unknown[] = [];
    durable(store, briefs);
    for (const [i, did] of [BRAND_DID, BRAND2_DID].entries()) {
      const brand = fleet.add(did);
      negotiate(brand, listing as never, i);
    }
    fleet.pump();
    expect(briefs.length).toBe(2);
    expect(
      budget(store).charge({
        kind: SHELF_HOST_KIND,
        negotiationId: 'n',
        count: RULES.perOwnerMonthly,
        nowMs: fleet.nowMs,
        thresholdVersion: 1,
      }),
    ).toEqual({ ok: true });
  });

  it('E-05: what Brain could observe stays within 1.6 × (N + I)', () => {
    const { store, listing } = storeWithListing(fleet);
    const briefs: unknown[] = [];
    durable(store, briefs);
    // Each counterparty's own probing budget: two answered requests or counters.
    const PER_COUNTERPARTY = 2;
    const spent = new Map<string, number>();
    let granted = 0;
    store.engine.ctx.deps.spendProbing = (from: string) => {
      const used = spent.get(from) ?? 0;
      if (used >= PER_COUNTERPARTY) return false;
      spent.set(from, used + 1);
      granted += 1;
      return true;
    };
    const brands = [BRAND_DID, BRAND2_DID, 'did:plc:brand3333'];
    for (const did of brands) {
      const brand = fleet.add(did);
      for (let n = 0; n < 3; n += 1) negotiate(brand, listing as never, n);
    }
    fleet.pump();
    const observed = store.cards.length + store.engine.agreements().length;
    const I = granted;
    const N = RULES.perOwnerMonthly;
    expect(I).toBeLessThanOrEqual(PER_COUNTERPARTY * brands.length);
    expect(observed).toBeLessThanOrEqual(N + I);
    expect(observed * Math.log2(3)).toBeLessThanOrEqual(1.6 * (N + I));
  });
});

