/**
 * COMMITMENT_KERNEL §7 and §8 — the value model and the envelope (step 2 of
 * §15), on their own.
 *
 *   K-40  worth is counted in rupees a month: weekly at 52/12, one-off
 *         spread over the deal's months, each part floored against the owner;
 *         another currency and ratios have no rupee value;
 *   K-41  a promise matches a value only if every dimension is the same or
 *         better; the best match applies; a changed or unknown dimension
 *         leaves it unvalued;
 *   K-42  never-rules, a price to a non-party, an option outside the
 *         vocabulary and a number past its hard limit refuse;
 *   K-43  a limit-only model keeps today's rules: within the automatic limits
 *         Core signs; past one, or an unlimited part, the owner's card; an
 *         owner-authorised value covers its part;
 *   K-44  a model with values: below the walk-away point refused; at or above
 *         auto-sign signed; between, the card; a valued part with no limits
 *         and no walk-away point goes to the card;
 *   K-45  totals send a deal past what Dina may commit alone to the card;
 *   K-46  capacity refuses; a closed persona asks, and at binding after the
 *         owner's approval refuses;
 *   K-47  approved in person, only the hard checks run (§8 migration
 *         fixture: offer ₹1,100, hard ₹800, automatic raised to ₹1,200: binds);
 *   K-48  size caps refuse whole; each alternative is checked on its own;
 *   K-49  a deal with an unvalued part goes to the owner, never refused on a
 *         partial worth; money in another currency is unvalued in a model
 *         with values, even with limits; a promise missing a declared
 *         dimension, on either side, is unvalued.
 */

import {
  checkOffer,
  checkVersion,
  moneyWorth,
  partWorth,
  promiseMatches,
  type DealPart,
  type ModelVocabulary,
  type NumberPartSpec,
  type ValueModel,
} from '../../src/commitment';

const RENT: NumberPartSpec = { name: 'fee', kind: 'money', payer: 'buyer', payee: 'seller' };
const SHARE: NumberPartSpec = {
  name: 'share_bps',
  kind: 'ratio_bps',
  payer: 'buyer',
  payee: 'seller',
};

const VOCAB: ModelVocabulary = {
  numbers: [RENT, SHARE],
  choices: { delivery_day: ['mon', 'tue', 'wed'] },
  flags: ['exclusive'],
  promises: {
    run: { who: 'exact', what: 'exact', crates: 'higher_better', every_days: 'lower_better' },
  },
};

const rent = (
  rupees: number,
  per: 'month' | 'week' | 'once' = 'month',
  currency = 'INR',
): DealPart => ({
  kind: 'number',
  name: 'fee',
  value: BigInt(rupees * 100),
  currency,
  per,
});
const share = (bps: number): DealPart => ({
  kind: 'number',
  name: 'share_bps',
  value: BigInt(bps),
});

function model(over: Partial<ValueModel> = {}): ValueModel {
  return {
    kind: 'slot.shelf',
    version: 1,
    limits: {},
    choiceValues: {},
    flagValues: {},
    promiseValues: {},
    never: [],
    totals: {},
    ...over,
  };
}

const LIMITS = {
  fee: { hard: 80_000n, auto: 100_000n },
  share_bps: { hard: 500n, auto: 600n },
};

describe('K-40 worth in rupees a month', () => {
  const holder = 'seller' as const;
  const n = (p: DealPart) => p as Extract<DealPart, { kind: 'number' }>;
  it('counts monthly at face value for the payee and against the payer', () => {
    expect(moneyWorth(RENT, holder, n(rent(1000)), 6)).toBe(1000n);
    expect(moneyWorth(RENT, 'buyer', n(rent(1000)), 6)).toBe(-1000n);
  });
  it('turns weekly into monthly at 52/12 and spreads a one-off, flooring against the owner', () => {
    // ₹300 a week = ₹1,300 a month exactly; ₹301 a week = ₹1,304.33 → ₹1,304 gained, ₹1,305 paid.
    expect(moneyWorth(RENT, holder, n(rent(300, 'week')), 6)).toBe(1300n);
    expect(moneyWorth(RENT, holder, n(rent(301, 'week')), 6)).toBe(1304n);
    expect(moneyWorth(RENT, 'buyer', n(rent(301, 'week')), 6)).toBe(-1305n);
    expect(moneyWorth(RENT, holder, n(rent(1000, 'once')), 3)).toBe(333n);
    expect(moneyWorth(RENT, holder, n(rent(1000, 'once')), 0)).toBe(1000n);
  });
  it('gives another currency and a ratio no rupee value', () => {
    expect(moneyWorth(RENT, holder, n(rent(10, 'month', 'USD')), 6)).toBeNull();
    expect(partWorth(model(), VOCAB, holder, share(800), 6).worth).toBeNull();
  });
});

describe('K-41 promise matching', () => {
  const orders = VOCAB.promises.run;
  const valued = { who: 'brand', what: 'hosur_stock', crates: 2n, every_days: 7n };
  it('matches the same or better on every dimension', () => {
    expect(promiseMatches(orders, valued, valued)).toBe(true);
    expect(promiseMatches(orders, { ...valued, crates: 3n, every_days: 3n }, valued)).toBe(true);
  });
  it('does not match a worse, changed or unknown dimension', () => {
    expect(promiseMatches(orders, { ...valued, every_days: 30n }, valued)).toBe(false);
    expect(promiseMatches(orders, { ...valued, what: 'other' }, valued)).toBe(false);
    expect(promiseMatches(orders, { ...valued, colour: 'red' }, valued)).toBe(false);
  });
  it('takes the best matching value', () => {
    const m = model({
      promiseValues: {
        run: [
          {
            dimensions: { who: 'brand', what: 'hosur_stock', crates: 1n, every_days: 30n },
            rupees: 100n,
          },
          { dimensions: valued, rupees: 300n },
        ],
      },
    });
    const part: DealPart = { kind: 'promise', name: 'run', dimensions: valued };
    expect(partWorth(m, VOCAB, 'seller', part, 6).worth).toBe(300n);
    const monthly: DealPart = {
      kind: 'promise',
      name: 'run',
      dimensions: { ...valued, every_days: 30n },
    };
    expect(partWorth(m, VOCAB, 'seller', monthly, 6).worth).toBe(100n);
  });
});

describe('K-42 what always refuses', () => {
  const base = { vocabulary: VOCAB, holder: 'seller' as const };
  it('a never-rule, a price to a non-party, an unknown option, a part past its hard limit', () => {
    const never = model({
      limits: LIMITS,
      never: [{ label: 'no exclusivity', all: [{ part: 'exclusive', flag: true }] }],
    });
    const v = (parts: DealPart[]) => ({ parts, months: 6 });
    expect(
      checkVersion({
        ...base,
        model: never,
        version: v([rent(1000), share(600), { kind: 'flag', name: 'exclusive', set: true }]),
      }),
    ).toMatchObject({ outcome: 'refused', reason: 'never_rule', detail: 'no exclusivity' });
    expect(
      checkVersion({
        ...base,
        model: never,
        version: v([rent(1000), { kind: 'price_to_non_party', name: 'shelf_price' }]),
      }),
    ).toMatchObject({ outcome: 'refused', reason: 'price_to_non_party' });
    expect(
      checkVersion({
        ...base,
        model: never,
        version: v([{ kind: 'choice', name: 'delivery_day', option: 'sun' }]),
      }),
    ).toMatchObject({ outcome: 'refused', reason: 'unknown_part' });
    expect(
      checkVersion({ ...base, model: never, version: v([rent(700), share(600)]) }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'past_hard_limit',
    });
  });
  it('a combination rule refuses only when every condition holds', () => {
    const m = model({
      limits: LIMITS,
      flagValues: { exclusive: { set: 0n, unset: 0n } },
      never: [
        {
          label: 'no exclusivity on a short notice',
          all: [
            { part: 'exclusive', flag: true },
            { part: 'fee', below: 90_000n },
          ],
        },
      ],
      walkAway: 0n,
      autoSign: 0n,
    });
    const excl: DealPart = { kind: 'flag', name: 'exclusive', set: true };
    expect(
      checkVersion({
        ...base,
        model: m,
        version: { parts: [rent(850), share(600), excl], months: 6 },
      }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'never_rule',
    });
    expect(
      checkVersion({
        ...base,
        model: m,
        version: { parts: [rent(1000), share(600), excl], months: 6 },
      }).outcome,
    ).toBe('sign');
  });
});

describe('K-43 a limit-only model keeps today’s rules', () => {
  const m = model({ limits: LIMITS });
  const check = (parts: DealPart[], authorised?: Map<string, bigint>) =>
    checkVersion({
      model: m,
      vocabulary: VOCAB,
      holder: 'seller',
      version: { parts, months: 6 },
      authorised,
    });
  it('signs within the automatic limits', () => {
    expect(check([rent(1000), share(600)])).toEqual({ outcome: 'sign', worth: null });
  });
  it('asks past an automatic limit, unless the owner authorised that value', () => {
    expect(check([rent(900), share(600)])).toEqual({
      outcome: 'card',
      reasons: ['past_auto_limit'],
      worth: null,
    });
    expect(check([rent(900), share(600)], new Map([['fee', 90_000n]])).outcome).toBe('sign');
    expect(check([rent(850), share(600)], new Map([['fee', 90_000n]])).outcome).toBe('card');
  });
  it('asks about a part with no limits', () => {
    expect(
      check([rent(1000), share(600), { kind: 'flag', name: 'exclusive', set: false }]),
    ).toMatchObject({
      outcome: 'card',
      reasons: ['unvalued_part'],
    });
  });
});

describe('K-44 a model with values', () => {
  const valued = model({
    limits: LIMITS,
    walkAway: 900n,
    autoSign: 1200n,
    choiceValues: { delivery_day: { mon: 0n, tue: 0n, wed: -50n } },
    promiseValues: {
      run: [
        {
          dimensions: { who: 'brand', what: 'hosur_stock', crates: 2n, every_days: 7n },
          rupees: 300n,
        },
      ],
    },
  });
  const check = (parts: DealPart[], m = valued) =>
    checkVersion({ model: m, vocabulary: VOCAB, holder: 'seller', version: { parts, months: 6 } });
  const run: DealPart = {
    kind: 'promise',
    name: 'run',
    dimensions: { who: 'brand', what: 'hosur_stock', crates: 2n, every_days: 7n },
  };
  it('trades parts: rent ₹1,000 and a weekly run worth ₹300 signs at ₹1,300', () => {
    expect(check([rent(1000), share(600), run])).toEqual({ outcome: 'sign', worth: 1300n });
  });
  it('between the walk-away point and auto-sign asks; below the walk-away point refuses', () => {
    expect(
      check([rent(1000), share(600), { kind: 'choice', name: 'delivery_day', option: 'wed' }]),
    ).toEqual({
      outcome: 'card',
      reasons: ['below_auto_sign'],
      worth: 950n,
    });
    expect(
      checkVersion({
        model: { ...valued, limits: { ...LIMITS, fee: { hard: 50_000n, auto: 50_000n } } },
        vocabulary: VOCAB,
        holder: 'seller',
        version: { parts: [rent(800), share(600)], months: 6 },
      }),
    ).toMatchObject({ outcome: 'refused', reason: 'below_walk_away' });
  });
  it('with no walk-away point, a valued part with no limits goes to the owner', () => {
    const noWalk = { ...valued, walkAway: undefined, autoSign: 0n };
    expect(check([rent(1000), share(600), run], noWalk)).toMatchObject({
      outcome: 'card',
      reasons: ['needs_walk_away'],
    });
  });
});

describe('K-45 totals', () => {
  it('a deal past what Dina may commit alone goes to the card', () => {
    const buyer = model({
      limits: { fee: { hard: 150_000n, auto: 120_000n }, share_bps: { hard: 1000n, auto: 800n } },
      totals: { overall: 5000n, perCounterparty: 2000n },
    });
    const check = (overall: bigint, withCounterparty: bigint) =>
      checkVersion({
        model: buyer,
        vocabulary: VOCAB,
        holder: 'buyer',
        version: { parts: [rent(1000), share(600)], months: 6 },
        committed: { overall, withCounterparty },
      });
    expect(check(3000n, 500n).outcome).toBe('sign');
    expect(check(4500n, 500n)).toMatchObject({ outcome: 'card', reasons: ['past_total'] });
    expect(check(0n, 1500n)).toMatchObject({ outcome: 'card', reasons: ['past_total'] });
  });
});

describe('K-46 capacity and closed personas', () => {
  const m = model({ limits: LIMITS });
  const version = { parts: [rent(1000), share(600)], months: 6 };
  it('refuses a deal that does not fit', () => {
    expect(
      checkVersion({ model: m, vocabulary: VOCAB, holder: 'seller', version, fits: () => false }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'no_room',
    });
  });
  it('asks to open a closed persona, and refuses at binding if it stays closed', () => {
    expect(
      checkVersion({
        model: m,
        vocabulary: VOCAB,
        holder: 'seller',
        version,
        closedPersonas: ['health'],
      }),
    ).toMatchObject({
      outcome: 'card',
      reasons: ['persona_closed'],
    });
    expect(
      checkVersion({
        model: m,
        vocabulary: VOCAB,
        holder: 'seller',
        version,
        closedPersonas: ['health'],
        approvedInPerson: true,
      }),
    ).toMatchObject({ outcome: 'refused', reason: 'persona_closed' });
  });
});

describe('K-47 approved in person: only the hard checks', () => {
  it('binds an offer of ₹1,100 when the automatic floor rose to ₹1,200 (hard ₹800)', () => {
    const raised = model({ limits: { ...LIMITS, fee: { hard: 80_000n, auto: 120_000n } } });
    const version = { parts: [rent(1100), share(600)], months: 6 };
    expect(
      checkVersion({ model: raised, vocabulary: VOCAB, holder: 'seller', version }).outcome,
    ).toBe('card');
    expect(
      checkVersion({
        model: raised,
        vocabulary: VOCAB,
        holder: 'seller',
        version,
        approvedInPerson: true,
      }).outcome,
    ).toBe('sign');
  });
  it('does not bind once the hard limit or a never-rule moved past it', () => {
    const version = { parts: [rent(1100), share(600)], months: 6 };
    const hard = model({ limits: { ...LIMITS, fee: { hard: 115_000n, auto: 120_000n } } });
    expect(
      checkVersion({
        model: hard,
        vocabulary: VOCAB,
        holder: 'seller',
        version,
        approvedInPerson: true,
      }).outcome,
    ).toBe('refused');
    const never = model({
      limits: LIMITS,
      never: [{ label: 'no deals under ₹1,200', all: [{ part: 'fee', below: 120_000n }] }],
    });
    expect(
      checkVersion({
        model: never,
        vocabulary: VOCAB,
        holder: 'seller',
        version,
        approvedInPerson: true,
      }).outcome,
    ).toBe('refused');
  });
});

describe('K-48 size and alternatives', () => {
  const m = model({ limits: LIMITS });
  it('refuses an offer past the caps whole', () => {
    const many = Array.from({ length: 9 }, () => ({ parts: [rent(1000), share(600)], months: 6 }));
    expect(
      checkOffer({ model: m, vocabulary: VOCAB, holder: 'seller', versions: many }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'too_large',
    });
    const parts = Array.from(
      { length: 33 },
      (_, i): DealPart => ({ kind: 'flag', name: `f${String(i)}`, set: false }),
    );
    expect(
      checkVersion({
        model: m,
        vocabulary: VOCAB,
        holder: 'seller',
        version: { parts, months: 1 },
      }),
    ).toMatchObject({
      outcome: 'refused',
      reason: 'too_large',
    });
  });
  it('checks each version on its own', () => {
    const verdicts = checkOffer({
      model: m,
      vocabulary: VOCAB,
      holder: 'seller',
      versions: [
        { parts: [rent(1000), share(600)], months: 6 },
        { parts: [rent(900), share(600)], months: 6 },
        { parts: [rent(700), share(600)], months: 6 },
      ],
    });
    expect(Array.isArray(verdicts) && verdicts.map((v) => v.outcome)).toEqual([
      'sign',
      'card',
      'refused',
    ]);
  });
});

describe('K-49 what the model cannot count goes to the owner', () => {
  const valued = model({
    limits: LIMITS,
    walkAway: 900n,
    autoSign: 1200n,
    promiseValues: {
      run: [
        {
          dimensions: { who: 'brand', what: 'hosur_stock', crates: 2n, every_days: 7n },
          rupees: 300n,
        },
      ],
    },
  });
  it('an unvalued part with a low partial worth is carded, not refused', () => {
    const odd: DealPart = {
      kind: 'promise',
      name: 'run',
      dimensions: { who: 'brand', what: 'other', crates: 2n, every_days: 7n },
    };
    expect(
      checkVersion({
        model: { ...valued, limits: { ...LIMITS, fee: { hard: 50_000n, auto: 50_000n } } },
        vocabulary: VOCAB,
        holder: 'seller',
        version: { parts: [rent(500), share(600), odd], months: 6 },
      }),
    ).toMatchObject({ outcome: 'card', reasons: expect.arrayContaining(['unvalued_part']) });
  });
  it('a USD fee with limits is unvalued in a model with values, so never signed alone', () => {
    const buyer = model({
      limits: { fee: { hard: 150_000n, auto: 150_000n }, share_bps: { hard: 1000n, auto: 1000n } },
      walkAway: -2000n,
      autoSign: -2000n,
    });
    expect(
      checkVersion({
        model: buyer,
        vocabulary: VOCAB,
        holder: 'buyer',
        version: { parts: [rent(1000, 'month', 'USD'), share(600)], months: 6 },
      }),
    ).toMatchObject({ outcome: 'card', reasons: expect.arrayContaining(['unvalued_part']) });
  });
  it('a promise missing a declared dimension matches nothing', () => {
    const orders = VOCAB.promises.run;
    const full = { who: 'brand', what: 'hosur_stock', crates: 2n, every_days: 7n };
    const short = { who: 'brand', what: 'hosur_stock', crates: 2n };
    expect(promiseMatches(orders, short, full)).toBe(false);
    expect(promiseMatches(orders, full, short)).toBe(false);
    expect(promiseMatches(orders, short, short)).toBe(false);
  });
});

describe('K-49b who keeps a promise', () => {
  it('a heavier promise the owner keeps does not match a lighter one it valued', () => {
    const m = model({
      promiseValues: {
        run: [
          {
            dimensions: { who: 'brand', what: 'hosur_stock', crates: 2n, every_days: 7n },
            rupees: -150n,
          },
        ],
      },
    });
    const heavier: DealPart = {
      kind: 'promise',
      name: 'run',
      by: 'buyer',
      dimensions: { who: 'brand', what: 'hosur_stock', crates: 5n, every_days: 7n },
    };
    expect(partWorth(m, VOCAB, 'buyer', heavier, 6).worth).toBeNull();
    const lighter: DealPart = {
      ...heavier,
      dimensions: { who: 'brand', what: 'hosur_stock', crates: 1n, every_days: 7n },
    };
    expect(partWorth(m, VOCAB, 'buyer', lighter, 6).worth).toBe(-150n);
    // Made to the owner by the other side, more crates is better.
    expect(partWorth(m, VOCAB, 'seller', heavier, 6).worth).toBe(-150n);
  });
});
