/**
 * WS-4.3 — the owner surface for the post-restore reconciliation census
 * (§16.2), and its boundary.
 *
 * The census lists counterparties and the orders this node cannot answer for.
 * That is a map of exactly where the supplier is vulnerable — the last thing
 * to hand a plugin or a paired agent — so the boundary is the same as
 * /v1/run and /v1/watch: owner-only, and fail-closed when the owner control
 * plane was never configured.
 */

import { CommerceOrderStore } from '../../../src/commerce/commerce_order';
import {
  InMemoryCommerceOrderRefRepository,
  type CommerceOrderRef,
} from '../../../src/commerce/order_refs';
import { InMemoryBuyerOrderRepository } from '../../../src/commerce/buyer_orders';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';

const OWNER_CAP = 'test-owner-capability-secret';
const BUYER = 'did:plc:retailer';

function req(callerType: string | undefined, capability = OWNER_CAP): CoreRequest {
  return {
    method: 'GET',
    path: '/v1/commerce/reconciliation',
    query: {},
    headers: {},
    body: {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
    // Only the genuine owner holds the boot-minted capability.
    ...(callerType === 'owner' ? { ownerCapability: capability } : {}),
  };
}

const NON_OWNER: (string | undefined)[] = [
  undefined, // Brain's in-process transport carries no callerType
  'brain',
  'admin',
  'connector',
  'device',
  'agent',
  'plugin',
  'service',
];

function frozenRef(purchaseOrderId: string, createdAt: number): CommerceOrderRef {
  return {
    buyerDid: BUYER,
    purchaseOrderId,
    idempotencyKey: `idem-${purchaseOrderId}`,
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
    createdAt,
    decidedAt: null,
  };
}

describe('GET /v1/commerce/reconciliation', () => {
  let router: CoreRouter;
  let refs: InMemoryCommerceOrderRefRepository;

  beforeEach(() => {
    refs = new InMemoryCommerceOrderRefRepository();
    installCommerceRuntime({
      orders: new CommerceOrderStore({ refs, now: () => 5_000 }),
    } as unknown as CommerceRuntime);
    router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
  });

  afterEach(() => installCommerceRuntime(null));

  it('rejects every non-owner caller (403)', async () => {
    for (const callerType of NON_OWNER) {
      const resp = await router.handle(req(callerType));
      expect(resp.status).toBe(403);
      expect((resp.body as { error: string }).error).toBe('access_denied');
    }
  });

  it('rejects an owner presenting the wrong capability', async () => {
    // `trustedInProcess` is not the boundary. A caller must BOTH be
    // owner-marked AND hold the exact boot-minted secret.
    expect((await router.handle(req('owner', 'not-the-secret'))).status).toBe(403);
  });

  it('fails CLOSED when the owner control plane was never configured', async () => {
    // Brain's own router registers no capability. Falling back to "allow"
    // there would put the census on a surface with no owner at all.
    const unconfigured = new CoreRouter();
    registerCommerceRoutes(unconfigured);
    expect((await unconfigured.handle(req('owner'))).status).toBe(403);
  });

  it('answers the owner with an empty census when nothing is frozen', async () => {
    const resp = await router.handle(req('owner'));
    expect(resp.status).toBe(200);
    expect(resp.body).toMatchObject({ frozen: [], buyerCount: 0 });
  });

  it('lists frozen orders oldest first', async () => {
    refs.createReserved(frozenRef('po-late', 3_000));
    refs.createReserved(frozenRef('po-early', 1_000));
    const resp = await router.handle(req('owner'));
    expect(
      (resp.body as { frozen: { purchaseOrderId: string }[] }).frozen.map((o) => o.purchaseOrderId),
    ).toEqual(['po-early', 'po-late']);
  });

  it('distinguishes "no commerce here" from "nothing is frozen"', async () => {
    // An owner reading an empty list must be able to tell the two apart. The
    // second is a reassurance the first has not earned.
    installCommerceRuntime(null);
    const resp = await router.handle(req('owner'));
    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('commerce_unavailable');
  });

  it('offers no way to clear a frozen order from here', async () => {
    // The census reports; the buyer's held proposal is what unfreezes an
    // order. A POST on this path must not exist — a "reconcile all" would
    // have to invent the terms it checks against.
    const post = await router.handle({ ...req('owner'), method: 'POST' });
    expect(post.status).toBe(404);
  });
});

/**
 * §13.2–§13.6 (WS-5/WS-7 Core half) — the buyer's decision surface.
 *
 * Fan-out planning, hard filters, ranking and evidence were each built, each
 * tested, and each called only by a test. The orphan ledger named them; these
 * are the tests that prove the sequence is reachable from a real request.
 */
describe('POST /v1/commerce/procurement', () => {
  let router: CoreRouter;

  function post(path: string, body: Record<string, unknown>, callerType = 'owner'): CoreRequest {
    return {
      method: 'POST',
      path,
      query: {},
      headers: {},
      body,
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      ...(callerType !== '' ? { callerType, callerDID: 'did:key:caller' } : {}),
      ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
    };
  }

  beforeEach(() => {
    router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
  });

  it('plans a fan-out and says who was left out', () => {
    return router
      .handle(
        post('/v1/commerce/procurement/plan', {
          candidates: [
            { supplierDid: 'did:plc:chairmaker', serviceRkey: 'self', trustBp: 7000 },
            { supplierDid: 'did:plc:rivalchairs', serviceRkey: 'self', trustBp: 5000 },
            // The buyer itself, which must never be asked.
            { supplierDid: BUYER, serviceRkey: 'self' },
          ],
          policy: { buyer_did: BUYER },
        }),
      )
      .then((resp) => {
        expect(resp.status).toBe(200);
        const body = resp.body as {
          plan: { selected: { supplierDid: string }[]; excluded: unknown[] };
          askedNobody: boolean;
        };
        expect(body.plan.selected.map((s) => s.supplierDid)).not.toContain(BUYER);
        expect(body.plan.excluded.length).toBeGreaterThan(0);
        expect(body.askedNobody).toBe(false);
      });
  });

  it('says askedNobody rather than leaving an empty list to be interpreted', async () => {
    // "We asked nobody" and "we asked and nobody answered" reach an owner as
    // the same empty array otherwise.
    const resp = await router.handle(
      post('/v1/commerce/procurement/plan', {
        candidates: [{ supplierDid: BUYER, serviceRkey: 'self' }],
        policy: { buyer_did: BUYER },
      }),
    );
    expect((resp.body as { askedNobody: boolean }).askedNobody).toBe(true);
  });

  it.each([{}, { buyer_did: '' }, { buyer_did: 42 }])(
    'requires a real buyer DID rather than defaulting it (%p)',
    async (policy) => {
      // It is what stops a fan-out quoting itself, and an EMPTY string is the
      // dangerous shape: it is present, it is a string, and it matches no
      // supplier — so self-exclusion silently stops working while every other
      // check passes. A first pass tested only the absent case and a mutation
      // that accepted `''` sailed through.
      const resp = await router.handle(
        post('/v1/commerce/procurement/plan', { candidates: [], policy }),
      );
      expect(resp.status).toBe(400);
    },
  );

  it('ranks offers and names a winner', async () => {
    const resp = await router.handle(
      post('/v1/commerce/procurement/choose', {
        offers: [
          {
            supplierDid: 'did:plc:chairmaker',
            quoteId: 'q-1',
            totalMinorUnits: '50000',
            currency: 'INR',
            availableQuantity: { value: '100', unit_code: 'each' },
            expiresAt: '2026-08-09T09:00:00.000Z',
            leadTimeDays: 14,
            trustBp: 7000,
          },
          {
            supplierDid: 'did:plc:rivalchairs',
            quoteId: 'q-2',
            totalMinorUnits: '48000',
            currency: 'INR',
            availableQuantity: { value: '100', unit_code: 'each' },
            expiresAt: '2026-08-09T09:00:00.000Z',
            leadTimeDays: 40,
            trustBp: 3000,
          },
        ],
        requirements: {
          currency: 'INR',
          quantity: { value: '100', unit_code: 'each' },
        },
        at: '2026-08-08T09:00:00.000Z',
      }),
    );
    expect(resp.status).toBe(200);
    const body = resp.body as {
      best: { offer: { supplierDid: string }; scoreBp: number } | null;
      ranking: { ranked: { offer: { supplierDid: string } }[] };
    };
    expect(body.best).not.toBeNull();
    expect(body.ranking.ranked).toHaveLength(2);

    // PINNING A FINDING, not asserting a preference. The cheaper rival wins
    // here despite 40-day lead time (vs 14) and trust 3000 (vs 7000), and it
    // is not close: price is scored min-max, so the cheapest offer takes the
    // FULL 6000bp, while lead time (2500) plus trust (1500) cap every rival
    // at 4000. The cheapest surviving offer therefore always wins, whatever
    // the other factors say, and trust is a tie-breaker among equal prices
    // rather than a rival to price.
    //
    // Whether that is the intended weighting is the owner's call — it is
    // recorded as an open question in implementation-notes.html. This test
    // exists so the behaviour is visible in the code rather than only in
    // prose, and so a change to it is deliberate.
    expect(body.best?.offer.supplierDid).toBe('did:plc:rivalchairs');
  });

  it('returns a NULL winner rather than inventing one when every offer is filtered', async () => {
    // Removing every offer is a result, not a failure: the filters exist to
    // drop what the buyer cannot accept.
    const resp = await router.handle(
      post('/v1/commerce/procurement/choose', {
        offers: [
          {
            supplierDid: 'did:plc:chairmaker',
            quoteId: 'q-1',
            totalMinorUnits: '50000',
            currency: 'INR',
            availableQuantity: { value: '100', unit_code: 'each' },
            // Already expired at the evaluation instant.
            expiresAt: '2026-08-01T00:00:00.000Z',
            leadTimeDays: 14,
          },
        ],
        requirements: { currency: 'INR', quantity: { value: '100', unit_code: 'each' } },
        at: '2026-08-08T09:00:00.000Z',
      }),
    );
    const body = resp.body as { best: unknown; ranking: { filtered: unknown[] } };
    expect(body.best).toBeNull();
    expect(body.ranking.filtered.length).toBe(1);
  });

  it('gives NO headline rather than a neutral score when there is no evidence', async () => {
    // An unrated supplier and a mediocre one are different, and a zero would
    // make them look the same.
    const resp = await router.handle(
      post('/v1/commerce/procurement/choose', {
        offers: [
          {
            supplierDid: 'did:plc:chairmaker',
            quoteId: 'q-1',
            totalMinorUnits: '50000',
            currency: 'INR',
            availableQuantity: { value: '100', unit_code: 'each' },
            expiresAt: '2026-08-09T09:00:00.000Z',
            leadTimeDays: 14,
          },
        ],
        requirements: { currency: 'INR', quantity: { value: '100', unit_code: 'each' } },
        at: '2026-08-08T09:00:00.000Z',
      }),
    );
    expect((resp.body as { headline: unknown }).headline).toBeNull();
  });

  it.each(['brain', 'agent', 'plugin', 'device', 'service'])(
    'refuses %s on both procurement routes',
    async (callerType) => {
      // A shortlist names who this buyer is about to approach; a ranking names
      // what they charge. Both are the owner's commercial position.
      for (const path of ['/v1/commerce/procurement/plan', '/v1/commerce/procurement/choose']) {
        const resp = await router.handle(post(path, {}, callerType));
        expect(resp.status).toBe(403);
      }
    },
  );
});

describe('the procurement routes refuse rather than crash', () => {
  it('answers 400, not 500, when the offers are malformed', async () => {
    // The ranking parses quantities and compares currencies, so a bad body
    // makes it throw. A 500 says "this node is broken" about a request that
    // was merely wrong.
    const router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
    const resp = await router.handle({
      method: 'POST',
      path: '/v1/commerce/procurement/choose',
      query: {},
      headers: {},
      body: {
        // Well-formed enough to PASS the hard filters — otherwise it is
        // dropped before any arithmetic and nothing throws, which is what a
        // first draft of this test proved instead.
        offers: [
          {
            supplierDid: 'did:plc:x',
            quoteId: 'q',
            totalMinorUnits: '12.5',
            currency: 'INR',
            availableQuantity: { value: '100', unit_code: 'each' },
            expiresAt: '2026-08-09T09:00:00.000Z',
          },
        ],
        requirements: { currency: 'INR', quantity: { value: '100', unit_code: 'each' } },
        at: '2026-08-08T09:00:00.000Z',
      },
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      callerType: 'owner',
      callerDID: 'did:key:owner',
      ownerCapability: OWNER_CAP,
    });
    expect(resp.status).toBe(400);
  });
});

/**
 * §12.7 / WS-7.7 — what the buyer is still waiting on.
 *
 * One projection, shared by every client (FR-P10). The route returns
 * `describeOrderForOwner`'s output rather than raw state, so mobile and web
 * cannot disagree about whether `outcome_unknown` means "failed" — and one of
 * those readings invites the owner to press send again while an effect may
 * already have fired.
 */
describe('GET /v1/commerce/orders/unsettled', () => {
  function get(callerType: string | undefined, capability = OWNER_CAP): CoreRequest {
    return {
      method: 'GET',
      path: '/v1/commerce/orders/unsettled',
      query: {},
      headers: {},
      body: {},
      rawBody: new Uint8Array(),
      params: {},
      trustedInProcess: true,
      ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
      ...(callerType === 'owner' ? { ownerCapability: capability } : {}),
    };
  }

  let router: CoreRouter;
  let buyerOrders: InMemoryBuyerOrderRepository;

  beforeEach(() => {
    buyerOrders = new InMemoryBuyerOrderRepository();
    installCommerceRuntime({ buyerOrders } as unknown as CommerceRuntime);
    router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
  });

  afterEach(() => installCommerceRuntime(null));

  it('refuses every non-owner caller', async () => {
    for (const callerType of NON_OWNER) {
      expect((await router.handle(get(callerType))).status).toBe(403);
    }
  });

  it('renders the shared projection, not the raw state', async () => {
    buyerOrders.create('did:plc:chairmaker99', {
      purchaseOrderId: 'po-1',
      orderDigest: 'a'.repeat(64),
      idempotencyKey: 'idem-po-1',
      protocolVersion: '1.0',
      serviceRkey: 'wholesale',
      quoteDigest: 'b'.repeat(64),
      quoteId: 'q-1',
      buyerDid: 'did:plc:sancho42',
      supplierDid: 'did:plc:chairmaker99',
      revision: 0,
      state: 'outcome_unknown',
      acknowledgement: null,
      nextPollAtMs: 5_000,
      pollCount: 3,
      resubmissionAuthorized: false,
      orderLines: null,
      ackEvidence: null,
      protocolFault: null,
    });
    const resp = await router.handle(get('owner'));
    expect(resp.status).toBe(200);
    const body = resp.body as {
      orders: { headline: string; actions: string[]; supplierDid: string; pollCount: number }[];
    };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]?.supplierDid).toBe('did:plc:chairmaker99');
    expect(body.orders[0]?.pollCount).toBe(3);
    // The dangerous action is absent, and the headline does not claim failure.
    expect(body.orders[0]?.actions).not.toContain('resend');
    expect(body.orders[0]?.headline.toLowerCase()).not.toContain('failed');
  });

  it('omits orders that already have an answer', async () => {
    // "Unsettled" means the node still owes the owner an explanation. A
    // settled order belongs on a different surface.
    buyerOrders.create('did:plc:chairmaker99', {
      purchaseOrderId: 'po-done',
      orderDigest: 'a'.repeat(64),
      idempotencyKey: 'idem-po-done',
      protocolVersion: '1.0',
      serviceRkey: 'wholesale',
      quoteDigest: 'b'.repeat(64),
      quoteId: 'q-1',
      buyerDid: 'did:plc:sancho42',
      supplierDid: 'did:plc:chairmaker99',
      revision: 0,
      state: 'accepted',
      acknowledgement: null,
      nextPollAtMs: null,
      pollCount: 1,
      resubmissionAuthorized: false,
      orderLines: null,
      ackEvidence: null,
      protocolFault: null,
    });
    const resp = await router.handle(get('owner'));
    expect((resp.body as { orders: unknown[] }).orders).toEqual([]);
  });

  it('distinguishes "no commerce here" from "nothing outstanding"', async () => {
    installCommerceRuntime(null);
    expect((await router.handle(get('owner'))).status).toBe(503);
  });
});
