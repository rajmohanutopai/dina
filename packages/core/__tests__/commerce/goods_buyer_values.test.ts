/**
 * COMMITMENT_KERNEL §7, §15 step 6 — the buyer's own values choose among the
 * versions it is offered ("does day Z suit you, and is ₹40 worth it?").
 *
 *   V-20  a day's value moves a version's cost; a never-rule on a day, or on
 *         the total, rules a version out; no model, no delivery date, or a
 *         quote not in rupees: price alone;
 *   V-21  the day is the owner's day: a delivery just after midnight in India
 *         is Tuesday there, though Monday in UTC; "present" on the total holds.
 */

import { judgeVersion } from '../../src/commerce/buyer_negotiation';
import { assemble } from '../../src/commitment/model_store';

const TUESDAY = '2026-08-11T10:00:00Z';
const FRIDAY = '2026-08-14T10:00:00Z';

const model = (entries: Parameters<typeof assemble>[3]) =>
  assemble('goods.buyer', 1, { limits: {}, totals: {}, asking: {}, binding: 'card' }, entries);

describe("the buyer's values among versions", () => {
  it('V-20: values move the cost; never-rules rule out', () => {
    const tuesdayCostsATrip = model([
      {
        id: 'd1',
        kind: 'goods.buyer',
        covers: ['delivery_day'],
        body: { type: 'choice', part: 'delivery_day', option: 'tue', rupees: -100n },
      },
    ]);
    expect(judgeVersion(tuesdayCostsATrip, TUESDAY, 50_000n, 'INR', 'UTC')).toEqual({
      worthMinor: -10_000n,
    });
    expect(judgeVersion(tuesdayCostsATrip, FRIDAY, 54_000n, 'INR', 'UTC')).toEqual({
      worthMinor: 0n,
    });
    expect(judgeVersion(tuesdayCostsATrip, TUESDAY, 50_000n, 'USD', 'UTC')).toEqual({
      worthMinor: 0n,
    });
    expect(judgeVersion(tuesdayCostsATrip, undefined, 50_000n, 'INR', 'UTC')).toEqual({
      worthMinor: 0n,
    });
    expect(judgeVersion(null, TUESDAY, 50_000n, 'INR', 'UTC')).toEqual({ worthMinor: 0n });
    const neverTuesday = model([
      {
        id: 'n1',
        kind: 'goods.buyer',
        covers: ['delivery_day'],
        body: {
          type: 'never',
          label: 'not on Tuesdays',
          all: [{ part: 'delivery_day', choice: 'tue' }],
        },
      },
    ]);
    expect(judgeVersion(neverTuesday, TUESDAY, 50_000n, 'INR', 'UTC')).toBe('ruled_out');
    expect(judgeVersion(neverTuesday, FRIDAY, 54_000n, 'INR', 'UTC')).toEqual({ worthMinor: 0n });
    const neverAbove = model([
      {
        id: 'n2',
        kind: 'goods.buyer',
        covers: ['total'],
        body: { type: 'never', label: 'not over ₹530', all: [{ part: 'total', above: 53_000n }] },
      },
    ]);
    expect(judgeVersion(neverAbove, FRIDAY, 54_000n, 'INR', 'UTC')).toBe('ruled_out');
    expect(judgeVersion(neverAbove, TUESDAY, 50_000n, 'INR', 'UTC')).toEqual({ worthMinor: 0n });
  });

  it("V-21: the owner's day, and presence on the total", () => {
    const neverTuesday = model([
      {
        id: 'n1',
        kind: 'goods.buyer',
        covers: ['delivery_day'],
        body: {
          type: 'never',
          label: 'not on Tuesdays',
          all: [{ part: 'delivery_day', choice: 'tue' }],
        },
      },
    ]);
    const justAfterMidnightInIndia = '2026-08-10T20:00:00Z'; // Tue 01:30 IST, Mon 20:00 UTC
    expect(
      judgeVersion(neverTuesday, justAfterMidnightInIndia, 50_000n, 'INR', 'Asia/Kolkata'),
    ).toBe('ruled_out');
    expect(judgeVersion(neverTuesday, justAfterMidnightInIndia, 50_000n, 'INR', 'UTC')).toEqual({
      worthMinor: 0n,
    });
    const neverATuesdayOrder = model([
      {
        id: 'n2',
        kind: 'goods.buyer',
        covers: ['delivery_day', 'total'],
        body: {
          type: 'never',
          label: 'no Tuesday orders at all',
          all: [
            { part: 'total', present: true },
            { part: 'delivery_day', choice: 'tue' },
          ],
        },
      },
    ]);
    expect(judgeVersion(neverATuesdayOrder, TUESDAY, 50_000n, 'INR', 'UTC')).toBe('ruled_out');
  });
});
