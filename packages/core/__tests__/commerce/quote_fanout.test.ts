/**
 * WS-5.9 — bounded quote fan-out (§12.3, §20.17).
 *
 * The test §20.17 actually asks for is the amplification one: whatever the
 * index returns, ONE buyer request must produce a bounded number of outbound
 * queries. Everything else here supports that or keeps the cap from quietly
 * becoming something other than a cap.
 */

import {
  MAX_QUOTE_FANOUT,
  planQuoteFanout,
  type FanoutCandidate,
} from '../../src/commerce/quote_fanout';

const BUYER = 'did:plc:sancho000000';

function candidates(count: number, prefix = 's'): FanoutCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    supplierDid: `did:plc:${prefix}${String(i).padStart(6, '0')}`,
    serviceRkey: 'self',
    trustBp: 5000,
  }));
}

describe('amplification is bounded (§20.17)', () => {
  /**
   * The claim that matters. A buyer's fan-out must not grow with the size of
   * the index — otherwise one tap becomes load proportional to how many
   * suppliers exist, and a peer repeating it has a flood with someone else's
   * name on the envelopes.
   */
  it.each([10, 100, 1000, 10000])(
    'never queries more than the ceiling, given %i candidates',
    (count) => {
      const plan = planQuoteFanout(candidates(count), { buyerDid: BUYER });
      expect(plan.selected).toHaveLength(MAX_QUOTE_FANOUT);
      // And nothing is lost: every candidate is either selected or explained.
      expect(plan.selected.length + plan.excluded.length).toBe(count);
    },
  );

  it('CLAMPS a caller asking for more rather than obeying it', () => {
    // A ceiling that a caller can raise is a default. Refusing outright would
    // be worse than clamping — it tempts a caller into a workaround, and the
    // workaround will not have a cap at all.
    const plan = planQuoteFanout(candidates(50), { buyerDid: BUYER, maxSuppliers: 500 });
    expect(plan.capApplied).toBe(MAX_QUOTE_FANOUT);
    expect(plan.selected).toHaveLength(MAX_QUOTE_FANOUT);
  });

  it('honours a TIGHTER cap the owner asked for', () => {
    const plan = planQuoteFanout(candidates(50), { buyerDid: BUYER, maxSuppliers: 3 });
    expect(plan.selected).toHaveLength(3);
    expect(plan.capApplied).toBe(3);
  });

  it('sends nothing at a cap of zero', () => {
    const plan = planQuoteFanout(candidates(5), { buyerDid: BUYER, maxSuppliers: 0 });
    expect(plan.selected).toHaveLength(0);
    expect(plan.excluded.every((e) => e.reason === 'over_cap')).toBe(true);
  });

  it('treats a negative cap as zero, not as unbounded', () => {
    // The failure mode worth guarding: a signed value flowing into a limit and
    // turning the ceiling off.
    const plan = planQuoteFanout(candidates(5), { buyerDid: BUYER, maxSuppliers: -1 });
    expect(plan.selected).toHaveLength(0);
    // And the REPORTED cap is 0, not -1. Selecting nothing already falls out
    // of the `>=` comparison, so the lower clamp changes no behaviour — what
    // it protects is the number a caller puts in front of the owner when
    // explaining a short shortlist. A mutation proved the behavioural half was
    // redundant, which is how this assertion came to exist.
    expect(plan.capApplied).toBe(0);
  });
});

describe('one query per supplier, not per listing', () => {
  it('collapses a supplier’s many listings into a single query', () => {
    // Six listings from one supplier would otherwise take six of the eight
    // slots — turning a cap meant to protect the network into one that
    // narrows the buyer's comparison instead.
    const busy: FanoutCandidate[] = Array.from({ length: 6 }, (_, i) => ({
      supplierDid: 'did:plc:chairmaker01',
      serviceRkey: `listing-${String(i)}`,
      trustBp: 9000,
    }));
    const plan = planQuoteFanout([...busy, ...candidates(4)], { buyerDid: BUYER });
    const dids = plan.selected.map((c) => c.supplierDid);
    expect(new Set(dids).size).toBe(dids.length);
    expect(dids.filter((d) => d === 'did:plc:chairmaker01')).toHaveLength(1);
    // The four other suppliers still get asked.
    expect(plan.selected).toHaveLength(5);
    expect(plan.excluded.filter((e) => e.reason === 'duplicate_supplier')).toHaveLength(5);
  });

  it('never queries the buyer’s own node', () => {
    const plan = planQuoteFanout([{ supplierDid: BUYER, serviceRkey: 'self' }, ...candidates(2)], {
      buyerDid: BUYER,
    });
    expect(plan.selected.map((c) => c.supplierDid)).not.toContain(BUYER);
    expect(plan.excluded[0]?.reason).toBe('self');
  });
});

describe('selection is deterministic', () => {
  it('asks the same suppliers whatever order the index returned them in', () => {
    // Otherwise the buyer's fan-out is a function of someone else's
    // pagination, and two runs of the same search reach different suppliers.
    const pool: FanoutCandidate[] = [
      { supplierDid: 'did:plc:aaa000000000', serviceRkey: 'self', trustBp: 5000 },
      { supplierDid: 'did:plc:bbb000000000', serviceRkey: 'self', trustBp: 5000 },
      { supplierDid: 'did:plc:ccc000000000', serviceRkey: 'self', trustBp: 5000 },
    ];
    const forward = planQuoteFanout(pool, { buyerDid: BUYER, maxSuppliers: 2 });
    const reversed = planQuoteFanout([...pool].reverse(), { buyerDid: BUYER, maxSuppliers: 2 });
    expect(reversed.selected.map((c) => c.supplierDid)).toEqual(
      forward.selected.map((c) => c.supplierDid),
    );
  });

  it('prefers higher trust, then fresher catalog evidence', () => {
    const plan = planQuoteFanout(
      [
        { supplierDid: 'did:plc:low000000000', serviceRkey: 'self', trustBp: 1000 },
        { supplierDid: 'did:plc:high00000000', serviceRkey: 'self', trustBp: 9000 },
        { supplierDid: 'did:plc:mid000000000', serviceRkey: 'self', trustBp: 5000 },
      ],
      { buyerDid: BUYER, maxSuppliers: 2 },
    );
    expect(plan.selected.map((c) => c.supplierDid)).toEqual([
      'did:plc:high00000000',
      'did:plc:mid000000000',
    ]);
  });

  it('breaks a trust tie on catalog freshness', () => {
    const plan = planQuoteFanout(
      [
        {
          supplierDid: 'did:plc:stale00000000',
          serviceRkey: 'self',
          trustBp: 5000,
          catalogSeenAtMs: 1,
        },
        {
          supplierDid: 'did:plc:fresh00000000',
          serviceRkey: 'self',
          trustBp: 5000,
          catalogSeenAtMs: 999,
        },
      ],
      { buyerDid: BUYER, maxSuppliers: 1 },
    );
    expect(plan.selected[0]?.supplierDid).toBe('did:plc:fresh00000000');
  });
});

describe('trust orders but never excludes (cold start)', () => {
  /**
   * A supplier nobody has rated yet is how every supplier begins. Excluding
   * them at fan-out would make the trust system self-fulfilling: no queries,
   * so no orders, so no reviews, so no trust, so no queries.
   */
  it('still asks an unrated supplier when there is room', () => {
    const plan = planQuoteFanout(
      [
        { supplierDid: 'did:plc:rated000000', serviceRkey: 'self', trustBp: 9000 },
        { supplierDid: 'did:plc:newcomer000', serviceRkey: 'self' },
      ],
      { buyerDid: BUYER },
    );
    expect(plan.selected.map((c) => c.supplierDid)).toEqual([
      'did:plc:rated000000',
      'did:plc:newcomer000',
    ]);
  });

  it('sorts an unrated supplier after a badly-rated one, but keeps both', () => {
    // Ordering is a judgement about likely usefulness. Exclusion would be a
    // judgement about worth, and this layer has no evidence for one.
    const plan = planQuoteFanout(
      [
        { supplierDid: 'did:plc:newcomer000', serviceRkey: 'self' },
        { supplierDid: 'did:plc:poor0000000', serviceRkey: 'self', trustBp: 100 },
      ],
      { buyerDid: BUYER },
    );
    expect(plan.selected.map((c) => c.supplierDid)).toEqual([
      'did:plc:poor0000000',
      'did:plc:newcomer000',
    ]);
  });
});

describe('nothing is silently dropped', () => {
  it('explains every candidate it did not select', () => {
    const plan = planQuoteFanout(
      [
        { supplierDid: BUYER, serviceRkey: 'self' },
        // Top trust, so this supplier is selected and its SECOND listing is
        // reached while there is still room — otherwise the duplicate case
        // never fires and `over_cap` shadows it. Written the wrong way round
        // first, which is how I learned the two reasons can mask each other.
        { supplierDid: 'did:plc:dup000000000', serviceRkey: 'a', trustBp: 9999 },
        { supplierDid: 'did:plc:dup000000000', serviceRkey: 'b', trustBp: 9999 },
        ...candidates(20),
      ],
      { buyerDid: BUYER },
    );
    const reasons = new Set(plan.excluded.map((e) => e.reason));
    expect(reasons).toEqual(new Set(['self', 'duplicate_supplier', 'over_cap']));
    expect(plan.selected.length + plan.excluded.length).toBe(23);
  });

  it('handles an empty candidate list without inventing one', () => {
    expect(planQuoteFanout([], { buyerDid: BUYER })).toEqual({
      selected: [],
      excluded: [],
      capApplied: MAX_QUOTE_FANOUT,
    });
  });
});
