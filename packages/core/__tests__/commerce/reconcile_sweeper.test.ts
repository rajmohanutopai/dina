/**
 * The tick that drives §12.7's buyer-side re-poll (WS-7.7).
 *
 * `askReconcilePolls` could be perfect and change nothing if nothing called
 * it — which is the defect this workstream produces more than any other. It
 * sat unreachable for a subtler reason than usual: its ledger entry said "no
 * scheduler tick calls the sweep yet", and the real problem was that its
 * `ask` RESOLVED to the answer, which the fire-and-forget requester lane
 * cannot do. These cover the loop's own obligations now that the shape fits.
 */

import { InMemoryBuyerOrderRepository } from '../../src/commerce/buyer_orders';
import { newBuyerOrder } from '../../src/commerce/buyer_reconciliation';
import {
  makeServiceQueryReconcileSend,
  ORDER_RECONCILE_CAPABILITY,
  ReconcilePollSweeper,
} from '../../src/commerce/reconcile_sweeper';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';

import type { ReconcileSend, ReconcileSweepResult } from '../../src/commerce/reconcile_poller';

const NOW = 1_700_000_000_000;
const SUPPLIER = 'did:plc:chairmaker99';

let buyerOrders: InMemoryBuyerOrderRepository;

beforeEach(() => {
  buyerOrders = new InMemoryBuyerOrderRepository();
  installCommerceRuntime({ buyerOrders } as unknown as CommerceRuntime);
  buyerOrders.create(SUPPLIER, {
    ...newBuyerOrder('po-1', {
      protocolVersion: '1.0',
      orderDigest: 'a'.repeat(64),
      idempotencyKey: 'idem-1',
      serviceRkey: 'wholesale',
      quoteDigest: 'b'.repeat(64),
      quoteId: 'q-1',
      buyerDid: 'did:plc:sancho42',
      supplierDid: 'did:plc:chairmaker99',
    }),
    state: 'outcome_unknown',
    nextPollAtMs: NOW - 1,
    pollCount: 1,
  });
});
afterEach(() => installCommerceRuntime(null));

function fakeTimers() {
  const ticks: (() => void)[] = [];
  let cleared = 0;
  return {
    ticks,
    get cleared() {
      return cleared;
    },
    setInterval: (fn: () => void) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {
      cleared += 1;
    },
  };
}

describe('ReconcilePollSweeper', () => {
  it('asks on the first tick, not one interval later', async () => {
    const asked: string[] = [];
    const send: ReconcileSend = async ({ request }) => {
      asked.push(request.purchase_order_id);
      return { sent: true };
    };
    const sweeper = new ReconcilePollSweeper({
      send: () => send,
      now: () => NOW,
    });
    expect(await sweeper.runTick()).toMatchObject({ asked: 1 });
    expect(asked).toEqual(['po-1']);
  });

  it('is quiet on a node with no outbound transport', async () => {
    // A tick that could only fail would fill an operator's log with a
    // problem they do not have.
    const sweeper = new ReconcilePollSweeper({ send: () => null });
    expect(await sweeper.runTick()).toBeNull();
  });

  it('does not stack a pass on top of a slow one', async () => {
    // The interval is not network-aware. Stacking passes against a peer that
    // is already struggling would ask the same order twice before the first
    // question resolved.
    let inFlight = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const sweeper = new ReconcilePollSweeper({
      send: () => async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        inFlight -= 1;
        return { sent: true };
      },
      now: () => NOW,
    });
    const first = sweeper.runTick();
    await Promise.resolve();
    expect(await sweeper.runTick()).toBeNull();
    release?.();
    await first;
    expect(peak).toBe(1);
  });

  it('reports a throwing resolver rather than dying', async () => {
    const errors: unknown[] = [];
    const sweeper = new ReconcilePollSweeper({
      send: () => {
        throw new Error('no transport');
      },
      onError: (e) => errors.push(e),
    });
    expect(await sweeper.runTick()).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it('stays quiet on a pass that had nothing to do', async () => {
    // An idle node logging once a minute buries the passes that mattered.
    const seen: ReconcileSweepResult[] = [];
    buyerOrders = new InMemoryBuyerOrderRepository();
    installCommerceRuntime({ buyerOrders } as unknown as CommerceRuntime);
    const sweeper = new ReconcilePollSweeper({
      send: () => async () => ({ sent: true }),
      now: () => NOW,
      onSweep: (r) => seen.push(r),
    });
    await sweeper.runTick();
    expect(seen).toEqual([]);
  });

  it('does not let a throwing observer break the loop', async () => {
    const errors: unknown[] = [];
    const sweeper = new ReconcilePollSweeper({
      send: () => async () => ({ sent: true }),
      now: () => NOW,
      onSweep: () => {
        throw new Error('logger exploded');
      },
      onError: (e) => errors.push(e),
    });
    expect(await sweeper.runTick()).toMatchObject({ asked: 1 });
    expect(errors).toHaveLength(1);
  });

  it('starts once and stops once', () => {
    const timers = fakeTimers();
    const sweeper = new ReconcilePollSweeper({
      send: () => null,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    sweeper.start();
    sweeper.start();
    expect(timers.ticks).toHaveLength(1);
    sweeper.stop();
    sweeper.stop();
    expect(timers.cleared).toBe(1);
  });

  it('refuses a non-positive interval rather than spinning', () => {
    expect(() => new ReconcilePollSweeper({ send: () => null, intervalMs: 0 })).toThrow(
      /intervalMs/,
    );
  });
});

describe('the reconcile question on the service-query lane', () => {
  it('sends under the order_reconcile capability, correlated by the order id', async () => {
    const dispatched: { toDid: string; body: Record<string, unknown> }[] = [];
    const send = makeServiceQueryReconcileSend({
      dispatch: async (args) => {
        dispatched.push({ toDid: args.toDid, body: args.body as Record<string, unknown> });
        return { sent: true };
      },
    });
    const result = await send({
      supplierDid: SUPPLIER,
      serviceRkey: 'wholesale',
      request: {
        protocol_version: '1.0',
        purchase_order_id: 'po-1',
        order_digest: 'a'.repeat(64),
        idempotency_key: 'idem-1',
      },
    });
    expect(result).toEqual({ sent: true });
    expect(dispatched[0]?.toDid).toBe(SUPPLIER);
    expect(dispatched[0]?.body.capability).toBe(ORDER_RECONCILE_CAPABILITY);
    // The purchase order id IS the correlation id: two dispatches about one
    // order must not look like two different questions.
    expect(dispatched[0]?.body.query_id).toBe('po-1');
    // And AT the listing the order went to: a supplier may offer commerce on a
    // non-default listing, and a bare query is checked against the default one.
    expect(dispatched[0]?.body.service_uri).toBe(
      `at://${SUPPLIER}/com.dinakernel.service.profile/wholesale`,
    );
  });

  it('reports NOT SENT only when a gate refused before egress', async () => {
    // The one case where nothing crossed the boundary and we can prove it.
    // Everything else leaves the record parked rather than claiming the
    // question was asked.
    const send = makeServiceQueryReconcileSend({
      dispatch: async () => ({ deniedAt: 'egress_gate', sent: false }),
    });
    expect(
      await send({
        supplierDid: SUPPLIER,
        serviceRkey: 'wholesale',
        request: {
          protocol_version: '1.0',
          purchase_order_id: 'po-1',
          order_digest: 'a'.repeat(64),
          idempotency_key: 'idem-1',
        },
      }),
    ).toEqual({ sent: false });
  });
});
