/**
 * The COMMAND half of the owner order contract (FR-P10 — WS-7.8).
 *
 * The read half shipped first: one projection, so mobile and web cannot
 * disagree about whether `outcome_unknown` means "failed". The command half is
 * the other side of that promise, and its whole design is one rule — the
 * command is authorized by the SAME projection that offered it.
 *
 * A second reading of "may the owner resend this" is one reading too many. The
 * divergence that matters runs in one direction: a command that allows what the
 * card never offered, on the one state where the wrong answer puts a duplicate
 * order for real goods on the wire.
 */

import {
  buildBuyerApprovalPayload,
  type ActingInstall,
  type BuyerApprovalContext,
  type BuyerApprovalPayload,
} from '../../../src/commerce/approval_payload';
import {
  installBuyerOrderSender,
  type BuyerOrderSender,
} from '../../../src/commerce/buyer_executor';
import { InMemoryBuyerOrderRepository } from '../../../src/commerce/buyer_orders';
import { newBuyerOrder, type BuyerOrderRecord } from '../../../src/commerce/buyer_reconciliation';
import { installCommerceServiceQueryDispatch } from '../../../src/commerce/buyer_sender';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { BUYER_DID, makeOrder, makeQuoteRequest, makeSignedQuote } from '../../commerce/helpers';

const OWNER_CAP = 'test-owner-capability-secret';

/**
 * The REAL order, quote and approval, from the shared commerce fixtures rather
 * than hand-built here. A hand-built order was the first version of this file
 * and it never reached the §15.2 binding at all — `buildBuyerApprovalPayload`
 * threw on a missing line list, so every resend test passed the route and
 * failed before it proved anything.
 */
const REQUEST = makeQuoteRequest();
const QUOTE = makeSignedQuote(REQUEST, { quote_id: 'q-cmd' });
const ORDER = makeOrder(QUOTE, REQUEST.delivery.projection);
const SUPPLIER = ORDER.supplier_did;
const PO = ORDER.purchase_order_id;

const INSTALL: ActingInstall = {
  installId: 'install-buyer',
  capabilityId: 'com.dinakernel.commerce.submit-order',
  manifestCid: 'bafyreibuyer',
  installScopeHash: 's'.repeat(64),
  configRevision: '1',
};

const CONTEXT: BuyerApprovalContext = {
  actingBusinessDid: BUYER_DID,
  principal: {
    principalDid: 'did:plc:sanchoowner',
    authorityDomain: 'procurement',
    policyRevision: null,
  },
  serviceUri: `at://${SUPPLIER}/com.dinakernel.service.profile/self`,
  displayedLabels: { l1: 'Oak dining chair' },
  productKeys: { l1: 'gtin:05012345678900' },
  linePrices: { l1: { currency: 'INR', minor_units: '500' } },
  charges: [],
  quoteRevision: 1,
  quoteExpiresAt: '2026-08-09T09:00:00.000Z',
  install: INSTALL,
};

function approval(): BuyerApprovalPayload {
  const built = buildBuyerApprovalPayload(ORDER, CONTEXT);
  if (!built.ok) throw new Error(`fixture is missing ${built.missing.join(', ')}`);
  return built.payload;
}

const DESCRIBED = {
  orderDigest: ORDER.order_digest,
  idempotencyKey: ORDER.idempotency_key,
  protocolVersion: ORDER.protocol_version,
  serviceRkey: 'self',
  // From the REAL order. An acknowledgement is now checked against these, so a
  // fixture inventing them would test a binding no order ever carried.
  quoteDigest: ORDER.quote_digest,
  quoteId: ORDER.quote_id,
  buyerDid: ORDER.buyer_did,
  supplierDid: ORDER.supplier_did,
};

let buyerOrders: InMemoryBuyerOrderRepository;
let router: CoreRouter;
/** Every outbound service query this node made. */
let dispatched: { toDid: string; body: Record<string, unknown> }[];
/** Every order the buyer sender was asked to send. */
let sent: string[];

/**
 * NO DEFAULT on `callerType`. A default parameter swallows an EXPLICIT
 * `undefined`, so `it.each([undefined, …])` silently tested the owner and the
 * one caller shape that matters most — Brain's in-process transport, which
 * carries no callerType at all — was never exercised.
 */
function req(body: Record<string, unknown>, callerType: string | undefined): CoreRequest {
  return {
    method: 'POST',
    path: '/v1/commerce/orders/command',
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

/** The owner's own request. Named, so no call site relies on a default. */
function owner(body: Record<string, unknown>): CoreRequest {
  return req(body, 'owner');
}

function record(over: Partial<BuyerOrderRecord> = {}): BuyerOrderRecord {
  return { ...newBuyerOrder(PO, DESCRIBED), ...over };
}

beforeEach(() => {
  buyerOrders = new InMemoryBuyerOrderRepository();
  installCommerceRuntime({ buyerOrders } as unknown as CommerceRuntime);
  dispatched = [];
  sent = [];
  installCommerceServiceQueryDispatch(async ({ toDid, body }) => {
    dispatched.push({ toDid, body: body as unknown as Record<string, unknown> });
    return { sent: true };
  });
  const sender: BuyerOrderSender = async ({ order }) => {
    sent.push(order.purchase_order_id);
    return { kind: 'ambiguous', reason: 'sent; awaiting the supplier acknowledgement' };
  };
  installBuyerOrderSender(sender);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
  installCommerceServiceQueryDispatch(null);
  installBuyerOrderSender(null);
});

describe('the boundary', () => {
  it.each([undefined, 'brain', 'agent', 'plugin', 'device', 'admin', 'service'])(
    'refuses caller type %s',
    async (callerType) => {
      // An order this node cannot account for is a list of exactly where its
      // money might already be, and the COMMAND can move money's paperwork.
      buyerOrders.create(SUPPLIER, record({ state: 'outcome_unknown', nextPollAtMs: 1 }));
      const resp = await router.handle(
        req({ supplier_did: SUPPLIER, purchase_order_id: PO, action: 'reconcile_now' }, callerType),
      );
      expect(resp.status).toBe(403);
      expect(dispatched).toEqual([]);
    },
  );

  it('reports an unknown order as 404 rather than inventing one', async () => {
    const resp = await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: 'po-nobody', action: 'reconcile_now' }),
    );
    expect(resp.status).toBe(404);
  });

  it('requires both halves of the key', async () => {
    const resp = await router.handle(owner({ purchase_order_id: PO, action: 'reconcile_now' }));
    expect(resp.status).toBe(400);
  });
});

describe('the projection authorizes the command', () => {
  it('refuses resend on an order the card does not offer it for', async () => {
    // `outcome_unknown` offers wait + reconcile_now and NEVER resend: the
    // effect may have fired, and sending again is exactly the duplicate §12.7
    // exists to prevent.
    buyerOrders.create(SUPPLIER, record({ state: 'outcome_unknown', nextPollAtMs: 1 }));
    const resp = await router.handle(
      owner({
        supplier_did: SUPPLIER,
        purchase_order_id: PO,
        action: 'resend',
        order: ORDER,
        approved: {},
        context: CONTEXT,
      }),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('action_not_offered');
    expect(sent).toEqual([]);
  });

  it('refuses resend on a never_received the supplier was not entitled to give', async () => {
    // The answer arrived, the state moved, and the authorization was withheld
    // because the buyer held the supplier's own signature. The card offers
    // wait + reconcile_now, so the command must too.
    buyerOrders.create(
      SUPPLIER,
      record({
        state: 'never_received',
        resubmissionAuthorized: false,
        protocolFault: 'denied while holding evidence',
      }),
    );
    const resp = await router.handle(
      owner({
        supplier_did: SUPPLIER,
        purchase_order_id: PO,
        action: 'resend',
        order: ORDER,
        approved: {},
        context: CONTEXT,
      }),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('action_not_offered');
    expect(sent).toEqual([]);
  });

  it('carries the projection back with the refusal, reason intact', async () => {
    // A stale card re-renders from the same answer rather than fetching again
    // to find out why — and the view's own owner-facing `detail` survives.
    buyerOrders.create(SUPPLIER, record({ state: 'accepted' }));
    const resp = await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: PO, action: 'reconcile_now' }),
    );
    const body = resp.body as { error: string; offered: string[]; headline: string; state: string };
    expect(body.error).toBe('action_not_offered');
    // `check_status` joined this projection with §9.11's buyer chain: an
    // accepted order is the one state where the supplier has progress to
    // report and no other action asks for it.
    expect(body.offered).toEqual(['view_acknowledgement', 'check_status']);
    expect(body.state).toBe('accepted');
    expect(body.headline).toContain('Accepted');
  });

  it('refuses the two actions that are not commands', async () => {
    // `wait` is the ABSENCE of a command and `view_acknowledgement` is a read
    // the projection already answers. Performing either would be inventing a
    // side effect for a button that has none.
    buyerOrders.create(SUPPLIER, record({ state: 'outcome_unknown', nextPollAtMs: 1 }));
    const wait = await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: PO, action: 'wait' }),
    );
    expect(wait.status).toBe(400);
    expect((wait.body as { error: string }).error).toBe('action_is_not_a_command');

    buyerOrders.create(SUPPLIER, { ...record({ state: 'accepted' }), purchaseOrderId: 'po-2' });
    const view = await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: 'po-2', action: 'view_acknowledgement' }),
    );
    expect(view.status).toBe(400);
  });

  it('refuses an action name this build has never heard of', async () => {
    buyerOrders.create(SUPPLIER, record({ state: 'outcome_unknown', nextPollAtMs: 1 }));
    const resp = await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: PO, action: 'force_settle' }),
    );
    expect(resp.status).toBe(409);
    expect(sent).toEqual([]);
    expect(dispatched).toEqual([]);
  });
});

describe('reconcile_now', () => {
  it('asks even when the automatic poll is not due yet', async () => {
    // The backoff exists to stop the AUTOMATIC loop spinning against a slow
    // supplier. It is not a limit on what the owner may do on their own node.
    buyerOrders.create(
      SUPPLIER,
      record({ state: 'outcome_unknown', nextPollAtMs: Date.now() + 3_600_000, pollCount: 2 }),
    );
    const resp = await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: PO, action: 'reconcile_now' }),
    );
    expect(resp.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.toDid).toBe(SUPPLIER);
    expect(dispatched[0]?.body.capability).toBe('order_reconcile');
  });

  it('advances the clock, so one tap does not become two questions', async () => {
    buyerOrders.create(
      SUPPLIER,
      record({ state: 'outcome_unknown', nextPollAtMs: Date.now() - 1, pollCount: 1 }),
    );
    await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: PO, action: 'reconcile_now' }),
    );
    const after = buyerOrders.get(SUPPLIER, PO);
    expect(after?.nextPollAtMs).toBeGreaterThan(Date.now());
    expect(after?.pollCount).toBe(2);
  });

  it('asks about exactly the one order, never the whole backlog', async () => {
    buyerOrders.create(SUPPLIER, record({ state: 'outcome_unknown', nextPollAtMs: 1 }));
    buyerOrders.create(SUPPLIER, {
      ...record({ state: 'outcome_unknown', nextPollAtMs: 1 }),
      purchaseOrderId: 'po-other',
    });
    await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: PO, action: 'reconcile_now' }),
    );
    expect(dispatched.map((d) => d.body.query_id)).toEqual([PO]);
  });

  it('says nothing was asked when the order cannot be described', async () => {
    // A row from before the description columns existed. Asking without a
    // digest invites `never_received`, the one answer that must never arrive by
    // accident — so nothing leaves and the owner is told.
    buyerOrders.create(SUPPLIER, {
      ...newBuyerOrder(PO),
      state: 'outcome_unknown',
      nextPollAtMs: 1,
      pollCount: 1,
    });
    const resp = await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: PO, action: 'reconcile_now' }),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('undescribable');
    expect(dispatched).toEqual([]);
  });

  it('fails closed with no outbound transport', async () => {
    installCommerceServiceQueryDispatch(null);
    buyerOrders.create(SUPPLIER, record({ state: 'outcome_unknown', nextPollAtMs: 1 }));
    const resp = await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: PO, action: 'reconcile_now' }),
    );
    expect(resp.status).toBe(503);
  });
});

describe('resend', () => {
  it('needs the order, the approval and the context — it does not reuse the first attempt', async () => {
    // §15.2: the order is unchanged, but WHICH install, capability, manifest
    // CID and config revision are about to send it may not be, and a swap of
    // any of those is a different act by a different actor.
    buyerOrders.create(SUPPLIER, record({ state: 'never_received', resubmissionAuthorized: true }));
    const resp = await router.handle(
      owner({ supplier_did: SUPPLIER, purchase_order_id: PO, action: 'resend' }),
    );
    expect(resp.status).toBe(400);
    expect(sent).toEqual([]);
  });

  it('refuses when the binding does not hold, and sends nothing', async () => {
    buyerOrders.create(SUPPLIER, record({ state: 'never_received', resubmissionAuthorized: true }));
    const resp = await router.handle(
      owner({
        supplier_did: SUPPLIER,
        purchase_order_id: PO,
        action: 'resend',
        order: ORDER,
        // An approval payload that binds to nothing this order is about.
        approved: { kind: 'buyer_order_approval', digest: 'f'.repeat(64) },
        context: CONTEXT,
      }),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { refusal: string }).refusal).toBe('approval_binding_failed');
    expect(sent).toEqual([]);
    // And the record is untouched, so the authorization is still there to use.
    expect(buyerOrders.get(SUPPLIER, PO)?.resubmissionAuthorized).toBe(true);
  });

  it('spends the authorization, so a second tap cannot become a second order', async () => {
    // One legal `never_received`, one resend. The fresh record clears the flag
    // before the send, so an owner tapping twice on a slow network gets a
    // refusal rather than a duplicate.
    buyerOrders.create(SUPPLIER, record({ state: 'never_received', resubmissionAuthorized: true }));
    // Drive the real binding by asking the executor directly through the route
    // with a payload the builder itself produced.
    const first = await router.handle(
      owner({
        supplier_did: SUPPLIER,
        purchase_order_id: PO,
        action: 'resend',
        order: ORDER,
        approved: approval(),
        context: CONTEXT,
      }),
    );
    expect(first.status).toBe(200);
    expect(sent).toEqual([PO]);
    expect(buyerOrders.get(SUPPLIER, PO)?.resubmissionAuthorized).toBe(false);

    const second = await router.handle(
      owner({
        supplier_did: SUPPLIER,
        purchase_order_id: PO,
        action: 'resend',
        order: ORDER,
        approved: approval(),
        context: CONTEXT,
      }),
    );
    // The card no longer offers it, so the command no longer performs it.
    expect(second.status).toBe(409);
    expect(sent).toEqual([PO]);
  });

  it('writes the fresh record BEFORE the send, not after', async () => {
    // The crash boundary, and the reason a mutation that swapped `create` for
    // `put` here survived at first: the settle at the END of the submit writes
    // the record anyway, so the difference is invisible unless you look at the
    // store from INSIDE the send. A crash between the write and the send must
    // leave a record of an order that may exist — and it must be the FRESH
    // record, with the authorization already spent, so the same crash cannot be
    // turned into a second resend by an owner tapping again.
    buyerOrders.create(SUPPLIER, record({ state: 'never_received', resubmissionAuthorized: true }));
    // Collected into an array rather than a `let`: TypeScript's control-flow
    // analysis cannot see an assignment made inside a callback, so a nullable
    // local narrows to `never` after the null check and every read is an error.
    const atSendTime: BuyerOrderRecord[] = [];
    installBuyerOrderSender(async () => {
      const seen = buyerOrders.get(SUPPLIER, PO);
      if (seen !== null) atSendTime.push(seen);
      return { kind: 'ambiguous', reason: 'sent' };
    });

    await router.handle(
      owner({
        supplier_did: SUPPLIER,
        purchase_order_id: PO,
        action: 'resend',
        order: ORDER,
        approved: approval(),
        context: CONTEXT,
      }),
    );
    expect(atSendTime).toHaveLength(1);
    expect(atSendTime[0]?.resubmissionAuthorized).toBe(false);
    expect(atSendTime[0]?.state).toBe('submitted_unconfirmed');
    expect(atSendTime[0]?.pollCount).toBe(0);
  });

  it('sends the SAME order, key and digest', async () => {
    // Not a new order: the same purchase. If the supplier turns out to be wrong
    // about never having seen it, the idempotency key is what stops the second
    // copy from becoming a second order (§15.5).
    buyerOrders.create(SUPPLIER, record({ state: 'never_received', resubmissionAuthorized: true }));
    const seen: { idempotency_key: string; order_digest: string }[] = [];
    installBuyerOrderSender(async ({ order }) => {
      seen.push(order);
      return { kind: 'ambiguous', reason: 'sent' };
    });

    await router.handle(
      owner({
        supplier_did: SUPPLIER,
        purchase_order_id: PO,
        action: 'resend',
        order: ORDER,
        approved: approval(),
        context: CONTEXT,
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.idempotency_key).toBe(ORDER.idempotency_key);
    expect(seen[0]?.order_digest).toBe(ORDER.order_digest);
  });

  it('parks the resent order rather than claiming it landed', async () => {
    buyerOrders.create(SUPPLIER, record({ state: 'never_received', resubmissionAuthorized: true }));
    const resp = await router.handle(
      owner({
        supplier_did: SUPPLIER,
        purchase_order_id: PO,
        action: 'resend',
        order: ORDER,
        approved: approval(),
        context: CONTEXT,
      }),
    );
    // A successful dispatch is AMBIGUOUS — the acknowledgement comes back later
    // on the response lane. Anything else here would be a claim the node cannot
    // support.
    expect((resp.body as { state: string }).state).toBe('outcome_unknown');
  });
});
