/**
 * The re-poll half of §12.7 — asking again, for as long as it takes.
 *
 * `submitApprovedOrder` settles the first answer; everything after that is
 * this. Without it the spec's "loop with bounded re-poll" is a field nobody
 * reads, and an ambiguous order sits forever — which looks exactly like an
 * order nobody cared about.
 *
 * THE LOOP IS TWO HALVES, and the split is the design rather than a
 * convenience. The first version took an `ask` that RESOLVED to the answer,
 * and nothing could be wired to it: every outbound `service.query` in this
 * system is fire-and-forget, with the answer arriving later as a correlated
 * `service.response`. So `askReconcilePolls` sends and advances the clock,
 * and `applyReconcileAnswer` applies whatever comes back, whenever it comes
 * back — including after a restart.
 */

import { InMemoryBuyerOrderRepository } from '../../src/commerce/buyer_orders';
import { newBuyerOrder, type BuyerOrderRecord } from '../../src/commerce/buyer_reconciliation';
import { applyReconcileAnswer, askReconcilePolls } from '../../src/commerce/reconcile_poller';
import { InMemoryCommerceReceiptRepository } from '../../src/commerce/receipts';
import { installCommerceRuntime, type CommerceRuntime } from '../../src/commerce/runtime';
import { makeHeldEvidence } from './helpers';

import type { OrderAcknowledgement, OrderReconcileRequest } from '@dina/commerce-protocol';

const NOW = 1_700_000_000_000;
const SUPPLIER = 'did:plc:chairmaker99';

/**
 * An acknowledgement that is ABOUT the described order.
 *
 * `ack()` below is deliberately a bare stand-in — it is used as HELD EVIDENCE,
 * where the question is only whether the buyer presented something, and its
 * shape is irrelevant. A SETTLING answer is a different thing entirely: it has
 * to name the order, or the binding check refuses it.
 */
function boundAck(): Record<string, unknown> {
  return {
    kind: 'accepted',
    protocol_version: DESCRIBED.protocolVersion,
    purchase_order_id: 'po-1',
    order_digest: DESCRIBED.orderDigest,
    buyer_did: DESCRIBED.buyerDid,
    supplier_did: DESCRIBED.supplierDid,
    accepted_quote_digest: DESCRIBED.quoteDigest,
  };
}

let buyerOrders: InMemoryBuyerOrderRepository;

beforeEach(() => {
  buyerOrders = new InMemoryBuyerOrderRepository();
  installCommerceRuntime({
    buyerOrders,
    // §16.2 buyer retention writes the accepted ack here now.
    receipts: new InMemoryCommerceReceiptRepository(),
  } as unknown as CommerceRuntime);
});
afterEach(() => installCommerceRuntime(null));

const DESCRIBED = {
  protocolVersion: '1.0',
  orderDigest: 'a'.repeat(64),
  idempotencyKey: 'idem-1',
  serviceRkey: 'wholesale',
  quoteDigest: 'b'.repeat(64),
  quoteId: 'q-1',
  buyerDid: 'did:plc:sancho42',
  supplierDid: SUPPLIER,
};

function parked(id: string, nextPollAtMs: number | null): BuyerOrderRecord {
  return {
    ...newBuyerOrder(id, DESCRIBED),
    state: 'outcome_unknown',
    nextPollAtMs,
    pollCount: 1,
  };
}

/**
 * An order stored before the record carried its own description. Not a
 * hypothetical: it is what every row written by an earlier build looks like,
 * and it is the only way an order can become undescribable now that the
 * description travels with it.
 */
function undescribable(id: string, nextPollAtMs: number | null): BuyerOrderRecord {
  return { ...newBuyerOrder(id), state: 'outcome_unknown', nextPollAtMs, pollCount: 1 };
}

function ack(kind: string): OrderAcknowledgement {
  return { kind } as unknown as OrderAcknowledgement;
}

/** Collect what left the node, and say it left. */
function sender() {
  const sent: OrderReconcileRequest[] = [];
  return {
    sent,
    send: async ({
      request,
    }: {
      supplierDid: string;
      serviceRkey: string;
      request: OrderReconcileRequest;
    }) => {
      sent.push(request);
      return { sent: true };
    },
  };
}

describe('asking (§12.7)', () => {
  it('asks only for orders whose poll is due', async () => {
    buyerOrders.create(SUPPLIER, parked('po-due', NOW - 1));
    buyerOrders.create(SUPPLIER, parked('po-later', NOW + 60_000));
    const transport = sender();

    const result = await askReconcilePolls({
      nowMs: NOW,
      send: transport.send,
    });
    expect(transport.sent.map((r) => r.purchase_order_id)).toEqual(['po-due']);
    // Asked WITH the digest the order was sent under: a reconcile whose digest
    // does not match the order is a different question, and the supplier is
    // entitled to answer it `never_received`.
    expect(transport.sent[0]).toMatchObject({
      order_digest: DESCRIBED.orderDigest,
      idempotency_key: DESCRIBED.idempotencyKey,
      protocol_version: DESCRIBED.protocolVersion,
    });
    expect(result).toMatchObject({ asked: 1, unsent: 0, undescribable: 0 });
  });

  it('bounds the work per pass', async () => {
    for (let i = 0; i < 40; i += 1) buyerOrders.create(SUPPLIER, parked(`po-${i}`, NOW - 1));
    const transport = sender();
    const result = await askReconcilePolls({
      nowMs: NOW,
      send: transport.send,
      maxPerSweep: 10,
    });
    // A large backlog must not stall a tick; the rest are asked next pass.
    expect(result.asked).toBe(10);
  });

  it('presents held evidence when the buyer has it (§16.2)', async () => {
    // Not an optimisation: presenting evidence is what makes a
    // `never_received` answer illegal.
    buyerOrders.create(SUPPLIER, parked('po-1', NOW - 1));
    const transport = sender();
    await askReconcilePolls({
      nowMs: NOW,
      send: transport.send,
      heldEvidence: () => ({
        held_acknowledgement: makeHeldEvidence(ack('accepted')),
      }),
    });
    expect(transport.sent[0]?.held_acknowledgement).toBeDefined();
  });

  it('skips an order it can no longer describe, rather than asking about nothing', async () => {
    // A supplier's honest answer to a question with no digest would be
    // `never_received` — the one answer that must never arrive by accident.
    buyerOrders.create(SUPPLIER, undescribable('po-1', NOW - 1));
    const transport = sender();
    const result = await askReconcilePolls({
      nowMs: NOW,
      send: transport.send,
    });
    expect(transport.sent).toEqual([]);
    expect(result).toMatchObject({ asked: 0, undescribable: 1 });
    // And the record is untouched, so it is asked again once it can be
    // described.
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.nextPollAtMs).toBe(NOW - 1);
  });

  it.each([
    ['orderDigest', 'the supplier could not tell which order is meant'],
    ['idempotencyKey', 'the supplier could not recognise a retry of it'],
    ['protocolVersion', 'the request would not match the version it was sent at'],
    ['serviceRkey', 'the query would be checked against the wrong listing'],
  ] as const)('needs %s, on its own, before it will ask (%s)', async (field, _why) => {
    // A PARTIAL description is the dangerous case, not the useful one, and a
    // record with nothing filled in cannot tell the difference: any single
    // check catches it, so the whole-record test passed while three of the
    // four conditions did nothing. One record per field, each missing exactly
    // one.
    buyerOrders.create(SUPPLIER, { ...parked('po-1', NOW - 1), [field]: '' });
    const transport = sender();
    const result = await askReconcilePolls({ nowMs: NOW, send: transport.send });
    expect(transport.sent).toEqual([]);
    expect(result).toMatchObject({ asked: 0, undescribable: 1 });
  });

  it('ADVANCES the clock once the question has left', async () => {
    // Without this the sweep re-asks on every tick until the answer arrives,
    // turning a bounded re-poll into a spin against a supplier who is merely
    // slow. The interval comes from the state machine, not from here.
    buyerOrders.create(SUPPLIER, parked('po-1', NOW - 1));
    const transport = sender();
    await askReconcilePolls({ nowMs: NOW, send: transport.send });

    const after = buyerOrders.get(SUPPLIER, 'po-1');
    expect(after?.nextPollAtMs).toBeGreaterThan(NOW);
    expect(after?.pollCount).toBeGreaterThan(1);
    // Asking does not decide: the state is exactly where it was.
    expect(after?.state).toBe('outcome_unknown');
    expect(after?.resubmissionAuthorized).toBe(false);
  });

  it('does not reclassify a WAITING order as a possibly-committed one', () => {
    // The two parked states are not interchangeable: `submitted_unconfirmed`
    // means the decision has not reached the external boundary,
    // `outcome_unknown` means the effect MAY have fired. Advancing every
    // record as `received_unresolved` would move the first into the second
    // because the BUYER asked — which is the supplier's fact to state.
    buyerOrders.create(SUPPLIER, {
      ...newBuyerOrder('po-waiting', DESCRIBED),
      state: 'submitted_unconfirmed',
      nextPollAtMs: NOW - 1,
      pollCount: 1,
    });
    const transport = sender();
    return askReconcilePolls({ nowMs: NOW, send: transport.send }).then(() => {
      const after = buyerOrders.get(SUPPLIER, 'po-waiting');
      expect(after?.state).toBe('submitted_unconfirmed');
      // Still advanced, so the sweep does not re-ask on every tick.
      expect(after?.nextPollAtMs).toBeGreaterThan(NOW);
      expect(after?.pollCount).toBe(2);
    });
  });

  it('leaves the record untouched when the transport could not carry it', async () => {
    buyerOrders.create(SUPPLIER, parked('po-1', NOW - 1));
    const result = await askReconcilePolls({
      nowMs: NOW,
      send: async () => ({ sent: false }),
    });
    expect(result).toMatchObject({ asked: 0, unsent: 1 });
    // NOT advanced: a question that never left is not a question asked.
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.nextPollAtMs).toBe(NOW - 1);
  });

  it('treats a THROWING transport the same as one that could not send', async () => {
    buyerOrders.create(SUPPLIER, parked('po-1', NOW - 1));
    const result = await askReconcilePolls({
      nowMs: NOW,
      send: async () => {
        throw new Error('socket died');
      },
    });
    expect(result).toMatchObject({ asked: 0, unsent: 1 });
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.nextPollAtMs).toBe(NOW - 1);
  });

  it('does nothing at all with no commerce runtime', async () => {
    installCommerceRuntime(null);
    const transport = sender();
    expect(await askReconcilePolls({ nowMs: NOW, send: transport.send })).toEqual({
      asked: 0,
      unsent: 0,
      undescribable: 0,
    });
    expect(transport.sent).toEqual([]);
  });
});

describe('applying the answer, whenever it arrives', () => {
  it('settles a terminal answer', async () => {
    buyerOrders.create(SUPPLIER, parked('po-1', NOW - 1));
    expect(
      applyReconcileAnswer({
        supplierDid: SUPPLIER,
        purchaseOrderId: 'po-1',
        result: { outcome: 'received_accepted', acknowledgement: boundAck() as never },
        nowMs: NOW,
      }),
    ).toBe('applied');
    const after = buyerOrders.get(SUPPLIER, 'po-1');
    expect(after?.state).toBe('accepted');
    // A settled order stops appearing to the sweep, which is how the loop
    // ends: no cancellation, no timer to forget.
    expect(after?.nextPollAtMs).toBeNull();
  });

  it('re-parks an unresolved answer with a fresh deadline', () => {
    buyerOrders.create(SUPPLIER, parked('po-1', NOW - 1));
    applyReconcileAnswer({
      supplierDid: SUPPLIER,
      purchaseOrderId: 'po-1',
      result: { outcome: 'received_unresolved', retry_after_seconds: 45 },
      nowMs: NOW,
    });
    const after = buyerOrders.get(SUPPLIER, 'po-1');
    expect(after?.state).toBe('outcome_unknown');
    expect(after?.nextPollAtMs).toBeGreaterThan(NOW);
    expect(after?.resubmissionAuthorized).toBe(false);
  });

  it('never authorizes a resubmission of its own accord, however long it loops', () => {
    buyerOrders.create(SUPPLIER, parked('po-1', NOW - 1));
    for (let i = 0; i < 50; i += 1) {
      applyReconcileAnswer({
        supplierDid: SUPPLIER,
        purchaseOrderId: 'po-1',
        result: { outcome: 'received_unresolved', retry_after_seconds: 30 },
        nowMs: NOW + i * 60_000,
      });
    }
    // Fifty rounds of "I don't know" is still not permission to send again.
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.resubmissionAuthorized).toBe(false);
  });

  it('refuses a never_received answer given against held evidence', () => {
    // A supplier holding its own signature must RE-ADOPT, not deny. The buyer
    // checks the LEGALITY of the answer rather than trusting it — which is
    // why the request has to be reconstructed WITH its evidence.
    buyerOrders.create(SUPPLIER, parked('po-1', NOW - 1));
    applyReconcileAnswer({
      supplierDid: SUPPLIER,
      purchaseOrderId: 'po-1',
      result: { outcome: 'never_received' },
      nowMs: NOW,
      heldEvidence: () => ({
        held_acknowledgement: makeHeldEvidence(ack('accepted')),
      }),
    });
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.resubmissionAuthorized).toBe(false);
  });

  it('accepts a never_received answer when nothing was presented', () => {
    buyerOrders.create(SUPPLIER, parked('po-1', NOW - 1));
    applyReconcileAnswer({
      supplierDid: SUPPLIER,
      purchaseOrderId: 'po-1',
      result: { outcome: 'never_received' },
      nowMs: NOW,
    });
    const after = buyerOrders.get(SUPPLIER, 'po-1');
    expect(after?.state).toBe('never_received');
    expect(after?.resubmissionAuthorized).toBe(true);
  });

  it('drops an answer for an order it cannot describe rather than judging it', () => {
    // `never_received` is legal only when no evidence was presented, so a
    // request reconstructed without its evidence would make an illegal answer
    // look legal. Refusing to reconstruct is the only safe move.
    buyerOrders.create(SUPPLIER, undescribable('po-1', NOW - 1));
    expect(
      applyReconcileAnswer({
        supplierDid: SUPPLIER,
        purchaseOrderId: 'po-1',
        result: { outcome: 'never_received' },
        nowMs: NOW,
      }),
    ).toBe('undescribable');
    expect(buyerOrders.get(SUPPLIER, 'po-1')?.resubmissionAuthorized).toBe(false);
  });

  it('reports an answer for an order this node does not hold', () => {
    expect(
      applyReconcileAnswer({
        supplierDid: SUPPLIER,
        purchaseOrderId: 'po-nobody',
        result: { outcome: 'never_received' },
        nowMs: NOW,
      }),
    ).toBe('unknown_order');
  });

  it('is quiet with no commerce runtime', () => {
    installCommerceRuntime(null);
    expect(
      applyReconcileAnswer({
        supplierDid: SUPPLIER,
        purchaseOrderId: 'po-1',
        result: { outcome: 'never_received' },
        nowMs: NOW,
      }),
    ).toBe('unknown_order');
  });
});
