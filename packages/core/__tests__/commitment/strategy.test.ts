/**
 * COMMITMENT_KERNEL §11 — the strategy slot's kernel rules (step 4 of §15).
 *
 *   S-01  a verdict tells the strategy which side of a threshold it fell and
 *         nothing more: a never-rule is named, worth and limits say "not enough";
 *   S-02  messages Core renders come from fixed kinds and only name parts on
 *         the table; a strategy's own note needs the owner's yes;
 *   S-03  budgets: a cap per negotiation, a monthly refill per owner, a fresh
 *         budget when the owner changes the threshold;
 *   S-04  the projection never carries the walk-away point, the comfort zone,
 *         limits, totals or asking terms; values only when the owner turned
 *         them on.
 */

import {
  carriesWithheld,
  charge,
  DEFAULT_BUDGET_RULES,
  needsOwnerYes,
  projectModel,
  refill,
  renderMessage,
  strategyVerdict,
  type DealPart,
  type ValueModel,
} from '../../src/commitment';

const MONTH = 30 * 24 * 60 * 60 * 1000;

describe('the strategy slot', () => {
  it('S-01: verdicts carry no threshold', () => {
    expect(strategyVerdict({ outcome: 'sign', worth: 1200n })).toEqual({ outcome: 'sign' });
    expect(strategyVerdict({ outcome: 'card', reasons: ['below_auto_sign'], worth: 950n })).toEqual(
      { outcome: 'needs_owner' },
    );
    // The owner's wording ("no rent under ₹2,000") never reaches the strategy: the part only.
    expect(
      strategyVerdict({
        outcome: 'refused',
        reason: 'never_rule',
        detail: 'no rent under ₹2,000',
        parts: ['fee'],
      }),
    ).toEqual({ outcome: 'refused', reason: 'never_rule', parts: ['fee'] });
    for (const reason of ['below_walk_away', 'past_hard_limit'] as const)
      expect(
        strategyVerdict({ outcome: 'refused', reason, detail: 'fee: past its hard limit' }),
      ).toEqual({
        outcome: 'refused',
        reason: 'not_enough',
      });
  });

  it('S-02: Core renders only fixed kinds about parts on the table', () => {
    const table: DealPart[] = [
      { kind: 'number', name: 'fee', value: 150_000n, currency: 'INR', per: 'month' },
    ];
    expect(renderMessage('ask_about_part', table, 'fee')).toBe('Could you move on fee?');
    expect(renderMessage('ask_about_part', table, 'my_costs')).toBeNull();
    expect(renderMessage('decline', table)).toBe('This does not work for us.');
    expect(needsOwnerYes({ kind: 'propose', versions: [], note: 'my rent covers my van' })).toBe(
      true,
    );
    expect(needsOwnerYes({ kind: 'propose', versions: [] })).toBe(false);
  });

  it('S-03: budgets cap a negotiation and refill monthly, or at once for a new threshold', () => {
    const rules = { perNegotiation: 3, perOwnerMonthly: 5 };
    let state = { negotiation: 0, ownerLeft: 5, ownerRefilledAtMs: 0, thresholdVersion: 1 };
    const first = charge(state, rules, 3);
    if (!first.ok) throw new Error('first charge');
    state = first.state;
    expect(charge(state, rules, 1)).toEqual({ ok: false, spent: 'negotiation' });
    // A new negotiation: its own count, the owner's budget carried over.
    state = { ...state, negotiation: 0 };
    expect(charge(state, rules, 3)).toEqual({ ok: false, spent: 'owner' });
    expect(refill(state, rules, MONTH - 1, 1).ownerLeft).toBe(2);
    expect(refill(state, rules, MONTH + 1, 1).ownerLeft).toBe(5);
    expect(refill(state, rules, 10, 2)).toMatchObject({ ownerLeft: 5, thresholdVersion: 2 });
    expect(DEFAULT_BUDGET_RULES.perNegotiation).toBeGreaterThan(0);
  });

  it('S-04: the projection never carries what stays in Core', () => {
    const model: ValueModel = {
      kind: 'shelf_space.vendor',
      version: 3,
      walkAway: 900n,
      autoSign: 1200n,
      limits: { fee: { hard: 300_000n, auto: 250_000n } },
      choiceValues: { delivery_day: { tue: 0n, wed: -50n } },
      flagValues: {},
      promiseValues: { stock_run: [{ dimensions: { crates: 2n, day: 'tue' }, rupees: -150n }] },
      never: [{ label: 'no rent under ₹2,000', all: [{ part: 'fee', below: 200_000n }] }],
      totals: { overall: 5000n },
    };
    const on = projectModel(model, { valuesOn: true, firstOfferOut: true });
    expect(carriesWithheld(on)).toBe(false);
    expect(JSON.stringify(on)).not.toMatch(/900|1200|300000|250000|5000|2,000|200000/);
    expect(on.values?.choices.delivery_day).toEqual({ tue: '0', wed: '-50' });
    expect(on.constrained).toEqual(['fee']);
    const off = projectModel(model, { valuesOn: false, firstOfferOut: true });
    expect(off).toEqual({ constrained: ['fee'] });
    expect(carriesWithheld({ deal: { limits: {} } })).toBe(true);
  });
});
