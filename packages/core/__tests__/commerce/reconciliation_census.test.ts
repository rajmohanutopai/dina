/**
 * WS-4.3 — the post-restore reconciliation census (§16.2).
 *
 * The point that shapes every test here: this REPORTS, it does not repair.
 * The ceremony that unfreezes an order checks the buyer's held proposal
 * against the digest this supplier signed, and a re-adopted order has nothing
 * local to check against — so a "reconcile all" would have to invent the
 * terms. What the census closes is a different gap: without it the owner
 * learns about a frozen order when a buyer complains.
 */

import { CommerceOrderStore } from '../../src/commerce/commerce_order';
import { InMemoryCommerceOrderRefRepository } from '../../src/commerce/order_refs';
import { buildReconciliationCensus } from '../../src/commerce/reconciliation_census';

import type { CommerceOrderRef } from '../../src/commerce/order_refs';

const BUYER = 'did:plc:retailer';
const OTHER = 'did:plc:otherretailer';

function ref(overrides: Partial<CommerceOrderRef> = {}): CommerceOrderRef {
  return {
    buyerDid: BUYER,
    purchaseOrderId: 'po-1',
    idempotencyKey: 'idem-1',
    orderDigest: 'a'.repeat(64),
    quoteId: 'q-1',
    quoteDigest: 'b'.repeat(64),
    pinnedVersion: '1.0',
    servingManifestCid: '',
    servingInstallId: '',
    admittedEpoch: '1',
    reconciliationRequired: true,
    state: 'reserved',
    effectPhase: 'pre_effect',
    acknowledgementJson: null,
    externalRef: null,
    decisionDeadlineAt: null,
    createdAt: 1_000,
    decidedAt: null,
    ...overrides,
  };
}

describe('what the census reports', () => {
  it('says nothing is frozen when nothing is', () => {
    const census = buildReconciliationCensus([]);
    expect(census.frozen).toEqual([]);
    expect(census.buyerCount).toBe(0);
  });

  it('names the order and the buyer who must act', () => {
    const census = buildReconciliationCensus([ref()]);
    expect(census.frozen).toEqual([
      {
        buyerDid: BUYER,
        purchaseOrderId: 'po-1',
        admittedEpoch: '1',
        createdAt: 1_000,
        decided: false,
      },
    ]);
  });

  /**
   * The census must not read as a button. Nothing here can clear the flag —
   * the buyer holds the only evidence that can — and a caller that assumed
   * otherwise would build a "reconcile all" that invents order terms.
   */
  it('states who clears a frozen order, and it is not this node', () => {
    expect(buildReconciliationCensus([ref()]).clearedBy).toBe('buyer_presents_held_order_proposal');
  });

  it('counts DISTINCT buyers, because one buyer is one conversation', () => {
    const census = buildReconciliationCensus([
      ref({ purchaseOrderId: 'po-1' }),
      ref({ purchaseOrderId: 'po-2' }),
      ref({ purchaseOrderId: 'po-3', buyerDid: OTHER }),
    ]);
    expect(census.frozen).toHaveLength(3);
    expect(census.buyerCount).toBe(2);
  });

  it('marks a DECIDED frozen order, which is the worse case', () => {
    // The buyer holds an acknowledgement this node can no longer describe.
    const census = buildReconciliationCensus([ref({ state: 'decided', decidedAt: 2_000 })]);
    expect(census.frozen[0]?.decided).toBe(true);
  });

  it('orders oldest first, and breaks ties deterministically', () => {
    // A frozen order does not get better with time, so the longest-frozen one
    // is the one to chase. A stable tiebreak keeps the list from reshuffling
    // between reads of the same data.
    const census = buildReconciliationCensus([
      ref({ purchaseOrderId: 'po-late', createdAt: 3_000 }),
      ref({ purchaseOrderId: 'po-b', createdAt: 1_000 }),
      ref({ purchaseOrderId: 'po-a', createdAt: 1_000 }),
    ]);
    expect(census.frozen.map((o) => o.purchaseOrderId)).toEqual(['po-a', 'po-b', 'po-late']);
  });

  it('carries no line items, money, or quote terms', () => {
    // Partly because a re-adopted order does not have them, and partly
    // because this is a management view: "what is stuck" is a list of orders,
    // not a re-export of the ledger.
    const census = buildReconciliationCensus([ref()]);
    const keys = Object.keys(census.frozen[0] ?? {});
    expect(keys.sort()).toEqual([
      'admittedEpoch',
      'buyerDid',
      'createdAt',
      'decided',
      'purchaseOrderId',
    ]);
  });
});

describe('the repository query behind it', () => {
  function store(): { store: CommerceOrderStore; refs: InMemoryCommerceOrderRefRepository } {
    const refs = new InMemoryCommerceOrderRefRepository();
    return { store: new CommerceOrderStore({ refs, now: () => 5_000 }), refs };
  }

  it('returns only orders awaiting reconciliation', () => {
    const { store: orders, refs } = store();
    refs.createReserved(ref({ purchaseOrderId: 'po-frozen' }));
    refs.createReserved(
      ref({
        purchaseOrderId: 'po-normal',
        idempotencyKey: 'idem-2',
        reconciliationRequired: false,
      }),
    );
    expect(orders.listAwaitingReconciliation().map((r) => r.purchaseOrderId)).toEqual([
      'po-frozen',
    ]);
  });

  /**
   * The filter that would have hidden the rows that matter most. A decided
   * order can be frozen too, and it is the case where the buyer already holds
   * an acknowledgement this node can no longer stand behind.
   */
  it('does NOT filter to reserved orders', () => {
    const { store: orders, refs } = store();
    refs.createReserved(ref({ purchaseOrderId: 'po-decided' }));
    refs.decide(BUYER, 'po-decided', {
      acknowledgementJson: '{}',
      decidedAt: 2_000,
      requirePreEffect: false,
    });
    expect(orders.listAwaitingReconciliation()).toHaveLength(1);
  });

  it('drops an order once the ceremony clears it', () => {
    const { store: orders, refs } = store();
    refs.createReserved(ref({ purchaseOrderId: 'po-frozen' }));
    expect(orders.listAwaitingReconciliation()).toHaveLength(1);
    refs.reconcile(BUYER, 'po-frozen', { atEpoch: '2' });
    expect(orders.listAwaitingReconciliation()).toEqual([]);
  });

  it('exposes no bulk reconcile beside the read', () => {
    // The guarantee the census depends on. A `reconcileAll` on the store would
    // have to invent the terms it checks against — the exact thing the
    // post-restore quote seam forbids one layer up.
    const { store: orders } = store();
    expect((orders as unknown as Record<string, unknown>).reconcileAll).toBeUndefined();
  });
});
