/**
 * External fulfilment reconciled to the chain (§12.7, §9.11 — WS-9.5).
 *
 * The naive seam signs whatever the warehouse says. These tests are the case
 * against it: a late webhook, a mis-scan and a crossed reference each become a
 * SIGNED claim under that design, and §9.11 has no way back from a signed
 * state. Nothing here signs — it proposes, and refuses whatever the transition
 * graph refuses.
 */

import {
  reconcileFulfilment,
  sweepFulfilment,
  type ExternalFulfilment,
  type FulfilmentSweepItem,
} from '../../src/commerce/fulfilment_reconciler';

const REF = 'EXT-100';
const AT = '2026-08-08T09:00:00.000Z';

function external(overrides: Partial<ExternalFulfilment> = {}): ExternalFulfilment {
  return { externalRef: REF, state: 'preparing', observedAtIso: AT, ...overrides };
}

const LINES = [{ line_id: 'l1', fulfilled_quantity: { unit_code: 'each', value: '2' } }];

describe('legal progress advances the chain', () => {
  it('accepted becomes preparing', () => {
    expect(
      reconcileFulfilment({
        current: 'accepted',
        external: external(),
        expectedExternalRef: REF,
      }),
    ).toEqual({ kind: 'advance', to: 'preparing' });
  });

  it('preparing becomes dispatched, carrying the lines', () => {
    expect(
      reconcileFulfilment({
        current: 'preparing',
        external: external({ state: 'dispatched', lines: LINES }),
        expectedExternalRef: REF,
      }),
    ).toEqual({ kind: 'advance', to: 'dispatched', lines: LINES });
  });

  it('dispatched becomes delivered', () => {
    expect(
      reconcileFulfilment({
        current: 'dispatched',
        external: external({ state: 'delivered' }),
        expectedExternalRef: REF,
      }),
    ).toEqual({ kind: 'advance', to: 'delivered' });
  });

  it('reports partially_fulfilled repeatedly, which the graph allows', () => {
    expect(
      reconcileFulfilment({
        current: 'preparing',
        external: external({ state: 'partially_fulfilled', lines: LINES }),
        expectedExternalRef: REF,
      }),
    ).toMatchObject({ kind: 'advance', to: 'partially_fulfilled' });
  });
});

describe('the same state is not an update', () => {
  it('answers unchanged rather than proposing a record', () => {
    // Polling returns the same state constantly. Signing each one would fill
    // the chain with records that say nothing and cost a signature apiece.
    expect(
      reconcileFulfilment({
        current: 'preparing',
        external: external({ state: 'preparing' }),
        expectedExternalRef: REF,
      }),
    ).toEqual({ kind: 'unchanged' });
  });

  it('says unchanged even for a terminal state, rather than complaining', () => {
    expect(
      reconcileFulfilment({
        current: 'cancelled',
        external: external({ state: 'cancelled' }),
        expectedExternalRef: REF,
      }),
    ).toEqual({ kind: 'unchanged' });
  });
});

describe('nothing moves backwards', () => {
  it('refuses a late report that would un-dispatch an order', () => {
    // The real failure: a `preparing` webhook landing after a `dispatched`
    // one. The buyer would watch their delivery un-happen.
    const decision = reconcileFulfilment({
      current: 'dispatched',
      external: external({ state: 'preparing' }),
      expectedExternalRef: REF,
    });
    expect(decision).toMatchObject({ kind: 'needs_attention', refusal: 'moves_backwards' });
  });

  it('separates backwards from merely illegal', () => {
    // Different things to an operator: one is a late webhook, the other is a
    // genuine disagreement about what happened.
    const illegal = reconcileFulfilment({
      current: 'accepted',
      external: external({ state: 'delivered' }),
      expectedExternalRef: REF,
    });
    expect(illegal).toMatchObject({ kind: 'needs_attention', refusal: 'illegal_transition' });
  });

  it('refuses to move a terminal chain at all', () => {
    for (const current of ['rejected', 'cancelled', 'disputed'] as const) {
      const decision = reconcileFulfilment({
        current,
        external: external({ state: 'dispatched', lines: LINES }),
        expectedExternalRef: REF,
      });
      expect(decision).toMatchObject({
        kind: 'needs_attention',
        refusal: 'chain_already_terminal',
      });
    }
  });

  it('still allows delivered to become disputed', () => {
    // `delivered` is terminal only once its dispute window elapses, so the
    // graph keeps this edge and so does the reconciler.
    expect(
      reconcileFulfilment({
        current: 'delivered',
        external: external({ state: 'disputed' }),
        expectedExternalRef: REF,
      }),
    ).toEqual({ kind: 'advance', to: 'disputed' });
  });
});

describe('a report has to be about this order', () => {
  it('refuses a report naming a different external order', () => {
    const decision = reconcileFulfilment({
      current: 'accepted',
      external: external({ externalRef: 'EXT-999' }),
      expectedExternalRef: REF,
    });
    // Advancing THIS buyer's chain on another buyer's shipment is the failure.
    expect(decision).toMatchObject({
      kind: 'needs_attention',
      refusal: 'unknown_external_ref',
    });
  });

  it('refuses progress on an order this node never accepted', () => {
    const decision = reconcileFulfilment({
      current: null,
      external: external(),
      expectedExternalRef: REF,
    });
    expect(decision).toMatchObject({
      kind: 'needs_attention',
      refusal: 'unknown_external_ref',
    });
  });
});

describe('a shipment has to say what shipped', () => {
  it.each(['dispatched', 'partially_fulfilled'] as const)('refuses %s with no lines', (state) => {
    const decision = reconcileFulfilment({
      current: 'preparing',
      external: external({ state }),
      expectedExternalRef: REF,
    });
    expect(decision).toMatchObject({ kind: 'needs_attention', refusal: 'lines_missing' });
  });

  it('refuses an empty line list as well as a missing one', () => {
    const decision = reconcileFulfilment({
      current: 'preparing',
      external: external({ state: 'dispatched', lines: [] }),
      expectedExternalRef: REF,
    });
    expect(decision).toMatchObject({ refusal: 'lines_missing' });
  });

  it('does not demand lines for a state that carries none', () => {
    expect(
      reconcileFulfilment({
        current: 'accepted',
        external: external({ state: 'cancelled' }),
        expectedExternalRef: REF,
      }),
    ).toEqual({ kind: 'advance', to: 'cancelled' });
  });
});

describe('the sweep', () => {
  const item = (overrides: Partial<FulfilmentSweepItem> = {}): FulfilmentSweepItem => ({
    buyerDid: 'did:plc:sancho',
    purchaseOrderId: 'po-1',
    externalRef: REF,
    current: 'accepted',
    ...overrides,
  });

  it('decides each open order', async () => {
    const results = await sweepFulfilment({
      open: [item(), item({ purchaseOrderId: 'po-2', current: 'dispatched' })],
      readExternal: async (o) =>
        external({ state: o.purchaseOrderId === 'po-1' ? 'preparing' : 'delivered' }),
    });
    expect(results).toEqual([
      {
        buyerDid: 'did:plc:sancho',
        purchaseOrderId: 'po-1',
        decision: { kind: 'advance', to: 'preparing' },
      },
      {
        buyerDid: 'did:plc:sancho',
        purchaseOrderId: 'po-2',
        decision: { kind: 'advance', to: 'delivered' },
      },
    ]);
  });

  it('says NOTHING about an order it could not read', async () => {
    // A failed read reported as "unchanged" would be indistinguishable from a
    // working connector reporting no change, and only one of those is
    // reassuring.
    const results = await sweepFulfilment({
      open: [item(), item({ purchaseOrderId: 'po-2' })],
      readExternal: async (o) => (o.purchaseOrderId === 'po-1' ? null : external()),
    });
    expect(results.map((r) => r.purchaseOrderId)).toEqual(['po-2']);
  });

  it('carries a disagreement through rather than dropping it', async () => {
    const results = await sweepFulfilment({
      open: [item({ current: 'dispatched' })],
      readExternal: async () => external({ state: 'preparing' }),
    });
    expect(results[0]?.decision).toMatchObject({ refusal: 'moves_backwards' });
  });
});
