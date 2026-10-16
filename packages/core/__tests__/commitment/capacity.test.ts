/**
 * COMMITMENT_KERNEL §8 step 9 — promised capacity across bundles and live deals.
 *
 *   K-60  one version within capacity fits; past it, the promise kind is named;
 *   K-61  a bundle counts every member together: two members that each fit
 *         alone do not fit side by side;
 *   K-62  what live deals already promise counts; promises the other side
 *         keeps never do.
 */

import { overCapacity, type DealPart, type DealVersion } from '../../src/commitment';

const run = (crates: bigint): DealPart => ({
  kind: 'promise',
  name: 'stock_run',
  dimensions: { crates, day: 'tue', every_days: 7n },
});
const member = (...parts: DealPart[]): DealVersion => ({ parts, months: 6 });
const capacities = { stock_run: { dimension: 'crates', amount: 3n } };
const mine = () => true;

describe('promised capacity', () => {
  it('K-60: within fits; past names the kind', () => {
    expect(overCapacity({ capacities, already: {}, members: [member(run(3n))], mine })).toBeNull();
    expect(overCapacity({ capacities, already: {}, members: [member(run(4n))], mine })).toBe(
      'stock_run',
    );
  });
  it('K-61: a bundle counts its members together', () => {
    expect(overCapacity({ capacities, already: {}, members: [member(run(2n))], mine })).toBeNull();
    expect(
      overCapacity({ capacities, already: {}, members: [member(run(2n)), member(run(2n))], mine }),
    ).toBe('stock_run');
  });
  it('K-62: live deals count; the other side’s promises do not', () => {
    expect(
      overCapacity({ capacities, already: { stock_run: 2n }, members: [member(run(2n))], mine }),
    ).toBe('stock_run');
    expect(
      overCapacity({
        capacities,
        already: { stock_run: 2n },
        members: [member(run(2n))],
        mine: () => false,
      }),
    ).toBeNull();
  });
});
