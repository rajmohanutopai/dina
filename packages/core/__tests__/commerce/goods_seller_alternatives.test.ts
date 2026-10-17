/**
 * COMMITMENT_KERNEL §3, §15 step 6 — the seller's own cheaper days become
 * alternatives: "my van passes your way on Tuesday, so delivery is ₹40 less."
 *
 *   S-30  a day that costs the seller less than the quote's own is offered,
 *         with half the saving passed on (the even split); the seller's costs
 *         never appear, only the change;
 *   S-31  no day is offered that costs as much or more, is ruled out, is past,
 *         or when there is no model, no delivery date, or a quote not in rupees;
 *   S-32  the days are the owner's days (the time zone counts);
 *   S-33  the share passed on is the one the owner confirmed (Brain may draw
 *         it out on a card): a third of ₹80 is ₹26; with none chosen, half;
 *   S-34  a never-rule is judged against the whole version: its day, the
 *         share passed on and its total, each test the doors accept;
 *   S-35  a discount larger than the order is never offered;
 *   S-36  after a restart, before the owner's time zone is read, no day is
 *         known: issuance offers no cheaper day rather than guess one.
 */

import {
  chosenShare,
  costLedAlternatives,
  passOf,
  shareChoice,
} from '../../src/commerce/goods_seller_alternatives';
import { describeEntry } from '../../src/commitment/model_changes';
import { assemble } from '../../src/commitment/model_store';

import type { Charge } from '@dina/commerce-protocol';

const FRIDAY = '2026-08-14T10:00:00Z';
const NOW = Date.parse('2026-08-07T09:00:00Z');
const delivery: Charge = {
  kind: 'delivery',
  label: 'Delivery',
  amount: { currency: 'INR', minor_units: '15000' },
  operation: 'add',
};

const sellerCosts = (extra: Parameters<typeof assemble>[3] = []) =>
  assemble('goods.seller', 1, { limits: {}, totals: {}, asking: {}, binding: 'card' }, [
    {
      id: 'fri',
      kind: 'goods.seller',
      covers: ['delivery_day'],
      body: { type: 'choice', part: 'delivery_day', option: 'fri', rupees: -120n },
    },
    {
      id: 'tue',
      kind: 'goods.seller',
      covers: ['delivery_day'],
      body: { type: 'choice', part: 'delivery_day', option: 'tue', rupees: -40n },
    },
    {
      id: 'wed',
      kind: 'goods.seller',
      covers: ['delivery_day'],
      body: { type: 'choice', part: 'delivery_day', option: 'wed', rupees: -150n },
    },
    ...extra,
  ]);

describe("the seller's cheaper days", () => {
  it('S-37: Brain’s standing share passes on its part; a never-rule reads the nearest of the owner’s words (§15 step 11)', () => {
    const offered = (bps: number, extra: Parameters<typeof assemble>[3] = []) =>
      costLedAlternatives({
        model: sellerCosts(extra),
        deliveryAt: FRIDAY,
        charges: [delivery],
        currency: 'INR',
        totalMinor: 65_000n,
        nowMs: NOW,
        timeZone: 'UTC',
        brainShareBps: bps,
      }).map((a) => a.charges.at(-1)?.amount.minor_units);
    // ₹80 saved: a quarter is ₹20; all of it is ₹80; none is no cheaper day.
    expect(offered(2_500)).toEqual(['2000']);
    expect(offered(10_000)).toEqual(['8000']);
    expect(offered(0)).toEqual([]);
    expect(shareChoice(sellerCosts(), 2_500)).toEqual({ label: 'third', bps: 2_500 });
    expect(shareChoice(sellerCosts(), 5_000).label).toBe('half');
    expect(shareChoice(sellerCosts(), 8_000).label).toBe('most');
    expect(passOf(80n, { label: 'most', bps: 8_000 })).toBe(64n);
    // "Never pass on most" holds against Brain's 80%, as against the owner's "most".
    const neverMost = [
      {
        id: 'n1',
        kind: 'goods.seller',
        covers: ['saving_share'],
        body: { type: 'never' as const, label: 'never most', all: [{ part: 'saving_share', choice: 'most' }] },
      },
    ];
    expect(offered(8_000, neverMost)).toEqual([]);
    expect(offered(5_000, neverMost)).toEqual(['4000']);
  });


  it('S-30: Tuesday saves the seller ₹80; ₹40 is offered', () => {
    const offered = costLedAlternatives({
      model: sellerCosts(),
      deliveryAt: FRIDAY,
      charges: [delivery],
      currency: 'INR',
      totalMinor: 65_000n,
      nowMs: NOW,
      timeZone: 'UTC',
    });
    expect(offered).toEqual([
      {
        alternative_id: 'tue',
        charges: [
          delivery,
          {
            kind: 'discount',
            label: 'Delivery on tue',
            amount: { currency: 'INR', minor_units: '4000' },
            operation: 'subtract',
          },
        ],
        estimated_delivery_at: '2026-08-11T10:00:00Z',
      },
    ]);
    // Only the change leaves: never the ₹120 or the ₹40 the days cost.
    const wire = JSON.stringify(offered);
    expect(wire).not.toContain('8000'); // the whole saving
    expect(wire).not.toContain('"-'); // any cost figure
  });

  it('S-31: no dearer day, no ruled-out day, no past day, no model, no date, no rupees', () => {
    const base = {
      deliveryAt: FRIDAY,
      charges: [delivery],
      currency: 'INR',
      totalMinor: 65_000n,
      nowMs: NOW,
      timeZone: 'UTC',
    };
    const neverTuesday = sellerCosts([
      {
        id: 'n',
        kind: 'goods.seller',
        covers: ['delivery_day'],
        body: {
          type: 'never',
          label: 'not Tuesdays',
          all: [{ part: 'delivery_day', choice: 'tue' }],
        },
      },
    ]);
    expect(costLedAlternatives({ ...base, model: neverTuesday })).toEqual([]);
    expect(
      costLedAlternatives({
        ...base,
        model: sellerCosts(),
        nowMs: Date.parse('2026-08-12T00:00:00Z'),
      }),
    ).toEqual([]);
    expect(costLedAlternatives({ ...base, model: null })).toEqual([]);
    expect(costLedAlternatives({ ...base, model: sellerCosts(), deliveryAt: undefined })).toEqual(
      [],
    );
    expect(costLedAlternatives({ ...base, model: sellerCosts(), currency: 'USD' })).toEqual([]);
  });

  it("S-32: the owner's day — Friday 23:30 in India is not a UTC Friday", () => {
    // 2026-08-14T18:00Z is Friday 23:30 IST: a Friday quote there; Tuesday is 4 days back.
    const offered = costLedAlternatives({
      model: sellerCosts(),
      deliveryAt: '2026-08-14T18:00:00Z',
      charges: [delivery],
      currency: 'INR',
      totalMinor: 65_000n,
      nowMs: NOW,
      timeZone: 'Asia/Kolkata',
    });
    expect(offered.map((o) => o.alternative_id)).toEqual(['tue']);
  });

  it("S-33: the owner's chosen share of the saving", () => {
    const third = sellerCosts([
      {
        id: 's',
        kind: 'goods.seller',
        covers: ['saving_share'],
        body: { type: 'choice', part: 'saving_share', option: 'third', rupees: 1n },
      },
    ]);
    expect(chosenShare(third)).toBe('third');
    expect(chosenShare(sellerCosts())).toBe('half');
    const offered = costLedAlternatives({
      model: third,
      deliveryAt: FRIDAY,
      charges: [delivery],
      currency: 'INR',
      totalMinor: 65_000n,
      nowMs: NOW,
      timeZone: 'UTC',
    });
    expect(offered[0]?.charges[1]?.amount.minor_units).toBe('2600');
    expect(
      describeEntry({
        id: 's',
        kind: 'goods.seller',
        covers: ['saving_share'],
        body: { type: 'choice', part: 'saving_share', option: 'third', rupees: 1n },
      }),
    ).toBe('pass on a third of what a cheaper delivery day saves you');
  });

  it('S-34: never-rules on the share, the total, and any day', () => {
    const base = {
      deliveryAt: FRIDAY,
      charges: [delivery],
      currency: 'INR',
      totalMinor: 65_000n,
      nowMs: NOW,
      timeZone: 'UTC',
    };
    const never = (all: unknown[]) =>
      sellerCosts([
        {
          id: 'n',
          kind: 'goods.seller',
          covers: ['delivery_day'],
          body: { type: 'never', label: 'a rule', all },
        } as never,
      ]);
    // Tuesday, when half is passed on: ruled out.
    expect(
      costLedAlternatives({
        ...base,
        model: never([
          { part: 'delivery_day', choice: 'tue' },
          { part: 'saving_share', choice: 'half' },
        ]),
      }),
    ).toEqual([]);
    // Tuesday, only when most is passed on: half is, so Tuesday stands.
    expect(
      costLedAlternatives({
        ...base,
        model: never([
          { part: 'delivery_day', choice: 'tue' },
          { part: 'saving_share', choice: 'most' },
        ]),
      }),
    ).toHaveLength(1);
    // Never a total below ₹620: Tuesday's ₹610 is ruled out.
    expect(
      costLedAlternatives({ ...base, model: never([{ part: 'total', below: 62_000n }]) }),
    ).toEqual([]);
    // A day is present on every version: no other day is offered.
    expect(
      costLedAlternatives({ ...base, model: never([{ part: 'delivery_day', present: true }]) }),
    ).toEqual([]);
  });

  it('S-35: a discount larger than the order is not offered', () => {
    expect(
      costLedAlternatives({
        model: sellerCosts(),
        deliveryAt: FRIDAY,
        charges: [delivery],
        currency: 'INR',
        totalMinor: 3_000n,
        nowMs: NOW,
        timeZone: 'UTC',
      }),
    ).toEqual([]);
  });

  it("S-36: the owner's zone is unknown until read", async () => {
    let settings: typeof import('../../src/settings/owner_settings') | undefined;
    jest.isolateModules(() => {
      settings = jest.requireActual<typeof import('../../src/settings/owner_settings')>(
        '../../src/settings/owner_settings',
      );
    });
    expect(settings?.ownerTimeZoneIfRead()).toBeNull();
    await settings?.setOwnerTimeZone('Asia/Kolkata');
    expect(settings?.ownerTimeZoneIfRead()).toBe('Asia/Kolkata');
  });
});
