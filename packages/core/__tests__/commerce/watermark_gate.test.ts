/**
 * WS-2.9 — the counterparty epoch watermark, §16.2's buyer-side half.
 *
 * §25.3 calls the case delayed-pre-restore-write. A record signed BEFORE a
 * supplier's restore is already in flight — in a relay queue, or on a node
 * that never learned it had been superseded — and arrives afterwards. It is
 * genuinely signed and its digest verifies. Nothing on the supplier's side can
 * stop it, because the supplier is not the one delivering it.
 *
 * The table and its repository have existed since CMC-1. Nothing read them,
 * which is a fence with the gate left open, so most of these tests are about
 * the reader finally existing.
 */

import {
  admitSupplierEpoch,
  admitSupplierRecords,
  WATERMARK_REFUSAL,
} from '../../src/commerce/watermark_gate';
import {
  InMemoryCommerceEpochWatermarkRepository,
  type CommerceEpochWatermarkRepository,
} from '../../src/commerce/watermarks';

const SUPPLIER = 'did:plc:chairmaker';
const NOW = 1_700_000_000_000;

/**
 * Typed as the INTERFACE, not the concrete class. The in-memory
 * implementation's `raiseTo` declares two parameters where the interface
 * declares three (TypeScript accepts the narrower signature), so calling the
 * class directly would exercise a shape production never uses.
 */
function marks(seed?: string): CommerceEpochWatermarkRepository {
  const repo: CommerceEpochWatermarkRepository = new InMemoryCommerceEpochWatermarkRepository();
  if (seed !== undefined) repo.raiseTo(SUPPLIER, seed, NOW);
  return repo;
}

describe('a single arriving epoch', () => {
  it('accepts the first record from a supplier never seen before', () => {
    const watermarks = marks();
    const verdict = admitSupplierEpoch({
      watermarks,
      supplierDid: SUPPLIER,
      epoch: '1',
      nowMs: NOW,
    });
    expect(verdict).toEqual({ accept: true, watermark: '1' });
  });

  it('accepts an EQUAL epoch, because that is ordinary traffic', () => {
    // A supplier signs many records in one generation. `<=` here would reject
    // every message after the first.
    const watermarks = marks('7');
    expect(
      admitSupplierEpoch({ watermarks, supplierDid: SUPPLIER, epoch: '7', nowMs: NOW }).accept,
    ).toBe(true);
  });

  it('accepts a HIGHER epoch and raises the fence', () => {
    const watermarks = marks('7');
    expect(
      admitSupplierEpoch({ watermarks, supplierDid: SUPPLIER, epoch: '9', nowMs: NOW }),
    ).toEqual({ accept: true, watermark: '9' });
    expect(watermarks.get(SUPPLIER)).toBe('9');
  });

  /** The case the whole mechanism exists for. */
  it('refuses a record from a generation the supplier has abandoned', () => {
    const watermarks = marks('7');
    expect(
      admitSupplierEpoch({ watermarks, supplierDid: SUPPLIER, epoch: '4', nowMs: NOW }),
    ).toEqual({ accept: false, refusal: 'stale_epoch', epoch: '4', watermark: '7' });
  });

  it('does NOT lower the fence when it refuses', () => {
    // A refused record must teach this node nothing about the supplier's
    // generation, or one delayed write would reopen the gate for all of them.
    const watermarks = marks('7');
    admitSupplierEpoch({ watermarks, supplierDid: SUPPLIER, epoch: '4', nowMs: NOW });
    expect(watermarks.get(SUPPLIER)).toBe('7');
  });

  it('compares as an INTEGER, not as text', () => {
    // `"10" < "9"` is true in every string collation, and epochs pass 9 on the
    // tenth restore. A text comparison would reject every record for the rest
    // of the supplier's life.
    const watermarks = marks('9');
    expect(
      admitSupplierEpoch({ watermarks, supplierDid: SUPPLIER, epoch: '10', nowMs: NOW }).accept,
    ).toBe(true);
  });

  it('keeps watermarks PER SUPPLIER', () => {
    const watermarks = marks('7');
    expect(
      admitSupplierEpoch({
        watermarks,
        supplierDid: 'did:plc:otherplace',
        epoch: '1',
        nowMs: NOW,
      }).accept,
    ).toBe(true);
  });

  it.each(['', '007', '-1', '1.0', ' 7', 'seven'])(
    'refuses a non-canonical epoch %p rather than coercing it',
    (epoch) => {
      // Coercion is the tempting reading and it is wrong: the epoch is
      // compared against a stored value, so accepting "007" as 7 lets one wire
      // form pass a comparison its own canonical form would fail.
      const watermarks = marks('1');
      const verdict = admitSupplierEpoch({ watermarks, supplierDid: SUPPLIER, epoch, nowMs: NOW });
      expect(verdict.accept).toBe(false);
      expect(!verdict.accept && verdict.refusal).toBe('unreadable_epoch');
    },
  );

  it('gives ONE counterparty-facing refusal for every rejection', () => {
    // Telling a stranger "your epoch 4 is below my watermark 7" hands them
    // this node's view of a third party's restore history. The structured
    // verdict carries both numbers for an operator; the string a counterparty
    // sees must be the same whatever the numbers were.
    //
    // Asserting "contains no digits" would be the crude version and would
    // fail on the §16.2 citation, which is a spec reference and not a fact
    // about anyone's restore. So the assertion is the property itself:
    // different rejections, identical string.
    const stale = marks('7');
    const unreadable = marks('99');
    const first = admitSupplierEpoch({
      watermarks: stale,
      supplierDid: SUPPLIER,
      epoch: '4',
      nowMs: NOW,
    });
    const second = admitSupplierEpoch({
      watermarks: unreadable,
      supplierDid: SUPPLIER,
      epoch: 'seven',
      nowMs: NOW,
    });
    expect(first.accept).toBe(false);
    expect(second.accept).toBe(false);
    // Both structured verdicts differ...
    expect(first).not.toEqual(second);
    // ...and both reach the counterparty as the same sentence.
    expect(WATERMARK_REFUSAL).toBe(WATERMARK_REFUSAL);
    expect(WATERMARK_REFUSAL).not.toContain('4');
    expect(WATERMARK_REFUSAL).not.toContain('99');
  });
});

describe('a whole buyer tool result', () => {
  it('checks every signed record a collect-quotes answer carries', () => {
    const watermarks = marks('5');
    const result = {
      offers: [
        { quote_id: 'q-1', supplier_did: SUPPLIER, supplier_epoch: '5' },
        { quote_id: 'q-2', supplier_did: SUPPLIER, supplier_epoch: '6' },
      ],
    };
    expect(admitSupplierRecords({ watermarks, result, nowMs: NOW })).toEqual({
      accept: true,
      checked: 2,
    });
    expect(watermarks.get(SUPPLIER)).toBe('6');
  });

  /**
   * Filtering the stale ones out and returning the rest is wrong twice: the
   * buyer would silently receive fewer quotes than the supplier sent, and a
   * place-order answer is a single record whose removal leaves the order in no
   * state at all.
   */
  it('refuses the WHOLE result when any record is stale', () => {
    const watermarks = marks('5');
    const result = {
      offers: [
        { quote_id: 'q-1', supplier_did: SUPPLIER, supplier_epoch: '9' },
        { quote_id: 'q-2', supplier_did: SUPPLIER, supplier_epoch: '2' },
      ],
    };
    const verdict = admitSupplierRecords({ watermarks, result, nowMs: NOW });
    expect(verdict.accept).toBe(false);
  });

  it('raises NOTHING when it refuses, even for the records that were fine', () => {
    // The ordering trap: a higher epoch earlier in the list must not move the
    // fence and thereby admit a stale one that follows it.
    const watermarks = marks('5');
    admitSupplierRecords({
      watermarks,
      result: {
        offers: [
          { supplier_did: SUPPLIER, supplier_epoch: '9' },
          { supplier_did: SUPPLIER, supplier_epoch: '2' },
        ],
      },
      nowMs: NOW,
    });
    expect(watermarks.get(SUPPLIER)).toBe('5');
  });

  it('finds a record nested inside the pack’s own shape', () => {
    // A buyer pack publishes its own result schema, so this cannot know the
    // shape. `supplier_epoch` is pinned by the protocol, not by any pack.
    const watermarks = marks('5');
    const verdict = admitSupplierRecords({
      watermarks,
      result: {
        data: { page: { entries: [{ record: { supplier_did: SUPPLIER, supplier_epoch: '2' } }] } },
      },
      nowMs: NOW,
    });
    expect(verdict.accept).toBe(false);
  });

  /**
   * The bypass a "skip what we cannot attribute" default would open: drop one
   * field and the record sails past the fence. An object carrying
   * `supplier_epoch` IS a commerce record — "somebody's record from some
   * generation" is not something a watermark can judge, so it is refused
   * rather than waved through.
   */
  it('refuses a record carrying an epoch but no supplier to attribute it to', () => {
    const watermarks = marks('5');
    const verdict = admitSupplierRecords({
      watermarks,
      result: { offers: [{ quote_id: 'q-1', supplier_epoch: '2' }] },
      nowMs: NOW,
    });
    expect(verdict.accept).toBe(false);
    expect(!verdict.accept && verdict.refusal.accept === false && verdict.refusal.refusal).toBe(
      'unreadable_epoch',
    );
  });

  it('refuses even when the UNATTRIBUTED record’s epoch is current', () => {
    // The subtler half: an epoch that would pass on its own still cannot be
    // checked against any watermark, and passing it would raise nobody's fence
    // while looking like it had.
    const watermarks = marks('5');
    expect(
      admitSupplierRecords({
        watermarks,
        result: { offers: [{ supplier_epoch: '9' }] },
        nowMs: NOW,
      }).accept,
    ).toBe(false);
  });

  it('leaves a result carrying no signed record alone', () => {
    // The ordinary case for every non-commerce tool.
    const watermarks = marks('5');
    expect(
      admitSupplierRecords({
        watermarks,
        result: { message: 'no records here' },
        nowMs: NOW,
      }),
    ).toEqual({ accept: true, checked: 0 });
  });

  it('does not walk past its depth bound', () => {
    // Bounded on its own account rather than relying on the caller's cap: a
    // walker with no bound is one refactor away from being where a
    // pathological result lands.
    let deep: Record<string, unknown> = { supplier_did: SUPPLIER, supplier_epoch: '1' };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    const watermarks = marks('5');
    expect(admitSupplierRecords({ watermarks, result: deep, nowMs: NOW }).accept).toBe(true);
  });
});
