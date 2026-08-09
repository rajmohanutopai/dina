/**
 * The external order boundary as an owner route (§15.5, §12.7 — WS-9.4 / 9.5).
 *
 * The route-level property worth its own test: the effect route takes the
 * idempotency key and the install id from RECORDS, never from the body. A
 * caller who could supply either would be choosing which external order to
 * touch and which grant to spend it through.
 */

import { CredentialBroker, type BrokeredExecutor } from '../../../src/commerce/credential_broker';
import { InMemoryCredentialStore } from '../../../src/commerce/credential_store';
import {
  DEFAULT_RETENTION_REQUIREMENT,
  MIN_PROBE_GAP_MS,
  requiredRetentionMs,
} from '../../../src/commerce/idempotency_evidence';
import { InMemoryIdempotencyEvidenceRepository } from '../../../src/commerce/idempotency_store';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { clearPairingState, setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';

/** What the sweep actually signed, and which orders the engine refused. */
let signed: { buyerDid: string; purchaseOrderId: string; state: string }[] = [];
let signRefusals = new Map<string, string>();

const OWNER_CAP = 'test-owner-capability-secret';
const SUPPLIER = 'did:plc:chairmaker99';
const BUYER = 'did:plc:sancho';

type Verb = 'GET' | 'PUT' | 'POST' | 'DELETE';

function request(
  method: Verb,
  path: string,
  body: Record<string, unknown> = {},
  callerType = 'owner',
): CoreRequest {
  return {
    method,
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

let router: CoreRouter;
let evidence: InMemoryIdempotencyEvidenceRepository;
let effectStartedFor: Set<string>;
let brokerCalls: unknown[];
let executor: BrokeredExecutor;
let openOrders: { buyerDid: string; purchaseOrderId: string; externalRef: string | null }[];
let chainStates: Map<string, string>;

function install(options: { orderExists?: boolean; installId?: string } = {}): void {
  evidence = new InMemoryIdempotencyEvidenceRepository();
  effectStartedFor = new Set<string>();
  brokerCalls = [];
  openOrders = [];
  chainStates = new Map<string, string>();
  const store = new InMemoryCredentialStore();
  store.rotate({
    resource: 'erp.primary',
    installId: options.installId ?? 'install-1',
    operations: ['submit_purchase_order', 'read_fulfilment'],
    material: 'sk-live-erp-token-0123456789abcd',
    nowMs: Date.now(),
  });
  const wrapped: BrokeredExecutor = async (args) => {
    brokerCalls.push(args.params);
    return executor(args);
  };

  const order = {
    ref: { idempotencyKey: 'idem-from-the-record', orderDigest: 'd'.repeat(64) },
    effectStarted: false,
  };

  installCommerceRuntime({
    availability: () => ({ available: true }),
    credentials: store,
    idempotencyEvidence: evidence,
    broker: new CredentialBroker({
      store,
      executors: () => ({
        'erp.primary:submit_purchase_order': wrapped,
        'erp.primary:read_fulfilment': wrapped,
      }),
    }),
    orders: {
      load: (buyerDid: string, poId: string) => {
        if (options.orderExists === false) return null;
        return {
          ...order,
          effectStarted: effectStartedFor.has(`${buyerDid}:${poId}`),
        };
      },
      listWithExternalRef: () => openOrders,
    },
    chains: {
      load: (_buyerDid: string, poId: string) => ({
        exists: chainStates.has(poId),
        get head() {
          const state = chainStates.get(poId);
          if (state === undefined) throw new Error('no head');
          return { state };
        },
      }),
    },
    // THE SWEEP NOW SIGNS, so the double has to carry the signer. Leaving it
    // out would have been the omission the runtime double's own comment warns
    // about elsewhere: "a double that omits a field the type promises is a lie
    // the cast hides". It records what it was asked to sign so the tests can
    // assert the chain actually MOVED, rather than that a decision was
    // computed and dropped — which is precisely the defect this wiring fixes.
    lifecycle: {
      signStatusUpdate: (buyerDid: string, poId: string, fields: { state: string }) => {
        if (signRefusals.has(poId)) return { error: signRefusals.get(poId) as string };
        signed.push({ buyerDid, purchaseOrderId: poId, state: fields.state });
        chainStates.set(poId, fields.state);
        return { state: fields.state, sequence: String(signed.length) };
      },
    },
    admission: {
      markEffectStarted: (buyerDid: string, poId: string) => {
        effectStartedFor.add(`${buyerDid}:${poId}`);
        return true;
      },
    },
  } as unknown as CommerceRuntime);
}

beforeEach(() => {
  setNodeDID(SUPPLIER);
  signed = [];
  signRefusals = new Map();
  executor = async () => ({ ok: true, result: { external_ref: 'SO-1' } });
  install();
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
  clearPairingState();
});

const PATHS: [Verb, string][] = [
  ['GET', '/v1/commerce/idempotency'],
  ['PUT', '/v1/commerce/idempotency/erp.primary/submit_purchase_order'],
  ['POST', '/v1/commerce/orders/effect'],
  ['POST', '/v1/commerce/orders/fulfilment'],
];

describe('every boundary route is owner-only', () => {
  it.each(PATHS)('%s %s refuses a non-owner caller', async (method, path) => {
    for (const callerType of ['agent', 'plugin', 'service', 'device']) {
      expect((await router.handle(request(method, path, {}, callerType))).status).toBe(403);
    }
  });

  it('a router registered with no capability refuses the owner too', async () => {
    const unguarded = new CoreRouter();
    registerCommerceRoutes(unguarded);
    for (const [method, path] of PATHS) {
      expect((await unguarded.handle(request(method, path))).status).toBe(403);
    }
  });
});

describe('evidence is recorded, and the verdict follows from it (§15.5)', () => {
  const goodProbe = (): Record<string, unknown> => ({
    idempotency_key: 'probe-1',
    first_external_ref: 'EXT-1',
    second_external_ref: 'EXT-1',
    second_created_new_order: false,
    first_at_ms: Date.now() - 2 * MIN_PROBE_GAP_MS,
    second_at_ms: Date.now() - MIN_PROBE_GAP_MS,
  });

  it('answers manual_only for a declaration with no probe', async () => {
    const response = await router.handle(
      request('PUT', '/v1/commerce/idempotency/erp.primary/submit_purchase_order', {
        declared_retention_ms: requiredRetentionMs(DEFAULT_RETENTION_REQUIREMENT),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ resubmission: 'manual_only', refusal: 'no_probe' });
  });

  it('answers automatic once a probe proves it', async () => {
    const response = await router.handle(
      request('PUT', '/v1/commerce/idempotency/erp.primary/submit_purchase_order', {
        declared_retention_ms: requiredRetentionMs(DEFAULT_RETENTION_REQUIREMENT),
        probe: goodProbe(),
      }),
    );
    expect(response.body).toEqual({ ok: true, resubmission: 'automatic' });
  });

  it('is not a switch: a probe that shows a second order stays manual', async () => {
    const response = await router.handle(
      request('PUT', '/v1/commerce/idempotency/erp.primary/submit_purchase_order', {
        declared_retention_ms: requiredRetentionMs(DEFAULT_RETENTION_REQUIREMENT),
        probe: { ...goodProbe(), second_created_new_order: true },
      }),
    );
    expect(response.body).toMatchObject({
      resubmission: 'manual_only',
      refusal: 'probe_created_second_order',
    });
  });

  it('separates a malformed probe from an absent one', async () => {
    // "No probe" is a legal state the owner may be in; "a probe this build
    // cannot read" is a request error, and collapsing them would let a typo
    // silently turn off a proven retry policy.
    const response = await router.handle(
      request('PUT', '/v1/commerce/idempotency/erp.primary/submit_purchase_order', {
        declared_retention_ms: 1,
        probe: { idempotency_key: 'probe-1' },
      }),
    );
    expect(response.status).toBe(400);
  });

  it('refuses a missing or negative retention', async () => {
    for (const declared of [undefined, -1, 'a lot']) {
      const response = await router.handle(
        request('PUT', '/v1/commerce/idempotency/erp.primary/submit_purchase_order', {
          ...(declared === undefined ? {} : { declared_retention_ms: declared }),
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  it('derives the verdict on every read rather than storing it', async () => {
    await router.handle(
      request('PUT', '/v1/commerce/idempotency/erp.primary/submit_purchase_order', {
        declared_retention_ms: requiredRetentionMs(DEFAULT_RETENTION_REQUIREMENT),
        probe: goodProbe(),
      }),
    );
    const listed = await router.handle(request('GET', '/v1/commerce/idempotency'));
    expect(listed.body).toEqual({
      connectors: [
        {
          resource: 'erp.primary',
          operation: 'submit_purchase_order',
          declared_retention_ms: requiredRetentionMs(DEFAULT_RETENTION_REQUIREMENT),
          observed: true,
          recorded_at_ms: expect.any(Number),
          resubmission: 'automatic',
        },
      ],
    });

    // Shorten the stored window behind the route's back. A stored verdict
    // would keep saying "automatic"; a derived one changes its mind.
    const stored = evidence.read('erp.primary', 'submit_purchase_order');
    expect(stored).not.toBeNull();
    if (stored !== null) evidence.record({ ...stored, declaredRetentionMs: 1 });

    const again = await router.handle(request('GET', '/v1/commerce/idempotency'));
    expect(again.body).toMatchObject({
      connectors: [{ resubmission: 'manual_only', refusal: 'retention_too_short' }],
    });
  });
});

describe('crossing the boundary', () => {
  it('uses the key from the RECORD, not from the body', async () => {
    const response = await router.handle(
      request('POST', '/v1/commerce/orders/effect', {
        buyer_did: BUYER,
        purchase_order_id: 'po-1',
        resource: 'erp.primary',
        operation: 'submit_purchase_order',
        // A caller trying to choose the key. Ignored entirely.
        idempotency_key: 'attacker-chosen',
      }),
    );
    expect(response.status).toBe(200);
    expect(brokerCalls).toEqual([
      {
        idempotency_key: 'idem-from-the-record',
        order: { purchase_order_id: 'po-1', order_digest: 'd'.repeat(64) },
      },
    ]);
  });

  it('uses the install the CREDENTIAL names, not one the body asks for', async () => {
    install({ installId: 'the-real-install' });
    router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
    const response = await router.handle(
      request('POST', '/v1/commerce/orders/effect', {
        buyer_did: BUYER,
        purchase_order_id: 'po-1',
        resource: 'erp.primary',
        operation: 'submit_purchase_order',
        install_id: 'install-1',
      }),
    );
    // Succeeds, because the route read `the-real-install` off the credential.
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, kind: 'succeeded', externalRef: 'SO-1' });
  });

  it('answers 200 for an ambiguous outcome, because the owner must act on it', async () => {
    executor = async () => {
      throw new Error('socket hang up');
    };
    const response = await router.handle(
      request('POST', '/v1/commerce/orders/effect', {
        buyer_did: BUYER,
        purchase_order_id: 'po-1',
        resource: 'erp.primary',
        operation: 'submit_purchase_order',
      }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: false, kind: 'ambiguous' });
  });

  it('answers 409 for a refusal that never left the node', async () => {
    const response = await router.handle(
      request('POST', '/v1/commerce/orders/effect', {
        buyer_did: BUYER,
        purchase_order_id: 'po-1',
        resource: 'erp.primary',
        operation: 'cancel_everything',
      }),
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ kind: 'refused_before_sending' });
  });

  it('refuses a second effect on an order that already crossed', async () => {
    const send = (): Promise<{ status: number; body?: unknown }> =>
      router.handle(
        request('POST', '/v1/commerce/orders/effect', {
          buyer_did: BUYER,
          purchase_order_id: 'po-1',
          resource: 'erp.primary',
          operation: 'submit_purchase_order',
        }),
      );
    expect((await send()).body).toMatchObject({ kind: 'succeeded' });
    const second = await send();
    expect(second.body).toMatchObject({ kind: 'ambiguous', attempts: 0 });
    // ONE external call, not two.
    expect(brokerCalls).toHaveLength(1);
  });

  it('refuses an unknown order and an unknown credential distinctly', async () => {
    install({ orderExists: false });
    router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
    const unknownOrder = await router.handle(
      request('POST', '/v1/commerce/orders/effect', {
        buyer_did: BUYER,
        purchase_order_id: 'po-nope',
        resource: 'erp.primary',
        operation: 'submit_purchase_order',
      }),
    );
    expect(unknownOrder.status).toBe(404);

    install();
    router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
    const unknownCredential = await router.handle(
      request('POST', '/v1/commerce/orders/effect', {
        buyer_did: BUYER,
        purchase_order_id: 'po-1',
        resource: 'erp.nope',
        operation: 'submit_purchase_order',
      }),
    );
    expect(unknownCredential.status).toBe(409);
    expect(unknownCredential.body).toMatchObject({ error: 'no_such_credential' });
  });

  it('requires all four identifying fields', async () => {
    const complete = {
      buyer_did: BUYER,
      purchase_order_id: 'po-1',
      resource: 'erp.primary',
      operation: 'submit_purchase_order',
    };
    for (const field of Object.keys(complete)) {
      const body: Record<string, unknown> = { ...complete };
      delete body[field];
      expect(
        (await router.handle(request('POST', '/v1/commerce/orders/effect', body))).status,
      ).toBe(400);
    }
  });
});

describe('reconciling external fulfilment', () => {
  it('advances on legal progress', async () => {
    const response = await router.handle(
      request('POST', '/v1/commerce/orders/fulfilment', {
        current: 'accepted',
        expected_external_ref: 'SO-1',
        external: {
          externalRef: 'SO-1',
          state: 'preparing',
          observedAtIso: '2026-08-08T09:00:00Z',
        },
      }),
    );
    expect(response.body).toEqual({ kind: 'advance', to: 'preparing' });
  });

  it('reports a disagreement rather than applying it', async () => {
    const response = await router.handle(
      request('POST', '/v1/commerce/orders/fulfilment', {
        current: 'dispatched',
        expected_external_ref: 'SO-1',
        external: {
          externalRef: 'SO-1',
          state: 'preparing',
          observedAtIso: '2026-08-08T09:00:00Z',
        },
      }),
    );
    expect(response.body).toMatchObject({ kind: 'needs_attention', refusal: 'moves_backwards' });
  });

  it('accepts a null current state but refuses a wrong-typed one', async () => {
    const withNull = await router.handle(
      request('POST', '/v1/commerce/orders/fulfilment', {
        current: null,
        expected_external_ref: 'SO-1',
        external: {
          externalRef: 'SO-1',
          state: 'preparing',
          observedAtIso: '2026-08-08T09:00:00Z',
        },
      }),
    );
    expect(withNull.status).toBe(200);
    expect(withNull.body).toMatchObject({ refusal: 'unknown_external_ref' });

    const wrongType = await router.handle(
      request('POST', '/v1/commerce/orders/fulfilment', {
        current: 7,
        expected_external_ref: 'SO-1',
        external: {
          externalRef: 'SO-1',
          state: 'preparing',
          observedAtIso: '2026-08-08T09:00:00Z',
        },
      }),
    );
    expect(wrongType.status).toBe(400);
  });

  it('requires the external report and the expected reference', async () => {
    for (const body of [
      { expected_external_ref: 'SO-1' },
      {
        external: {
          externalRef: 'SO-1',
          state: 'preparing',
          observedAtIso: '2026-08-08T09:00:00Z',
        },
      },
    ]) {
      expect(
        (await router.handle(request('POST', '/v1/commerce/orders/fulfilment', body))).status,
      ).toBe(400);
    }
  });
});

describe('the fulfilment sweep (WS-9.5)', () => {
  beforeEach(() => {
    openOrders = [
      { buyerDid: BUYER, purchaseOrderId: 'po-1', externalRef: 'SO-1' },
      { buyerDid: BUYER, purchaseOrderId: 'po-2', externalRef: 'SO-2' },
    ];
    chainStates.set('po-1', 'accepted');
    chainStates.set('po-2', 'dispatched');
  });

  const sweep = (body: Record<string, unknown> = {}) =>
    router.handle(
      request('POST', '/v1/commerce/orders/fulfilment/sweep', {
        resource: 'erp.primary',
        operation: 'read_fulfilment',
        ...body,
      }),
    );

  it('reports one refused successor without hiding the others that moved', async () => {
    // A chain refuses a successor it will not take — a fork, a backwards
    // move, a terminal head. That is a fact about ONE order. Signing per
    // order in its own transaction is what makes this possible: one
    // transaction for the whole sweep would roll back every good advance
    // alongside the bad one, and the first disagreement would hide all later
    // progress.
    executor = async ({ params }) => ({
      ok: true,
      result: {
        state:
          (params as { external_ref: string }).external_ref === 'SO-1' ? 'preparing' : 'delivered',
      },
    });
    signRefusals.set('po-1', 'status: successor would fork the chain at sequence 3');

    const response = await sweep();
    expect(response.status).toBe(200);
    // po-2 still advanced.
    expect(signed).toEqual([{ buyerDid: BUYER, purchaseOrderId: 'po-2', state: 'delivered' }]);
    expect(response.body).toMatchObject({
      advanced: [{ purchaseOrderId: 'po-2', to: 'delivered' }],
      refused: [{ purchaseOrderId: 'po-1', error: expect.stringContaining('fork') }],
    });
  });

  it('checks every open order from the RECORDS, not from the request', async () => {
    executor = async ({ params }) => ({
      ok: true,
      result: {
        state:
          (params as { external_ref: string }).external_ref === 'SO-1' ? 'preparing' : 'delivered',
      },
    });
    const response = await sweep({
      // A caller trying to narrow the list. Ignored: the one order left out
      // is the one nobody looks at again.
      purchase_order_ids: ['po-1'],
    });
    expect(response.status).toBe(200);
    // THE CHAIN ACTUALLY MOVED. Before the sweep signed, this body was the
    // whole story and `results` was the only evidence — a list of decisions
    // nobody applied. `advanced` is what makes the difference visible: the
    // two numbers were identical for as long as nothing signed, which is how
    // "the sweep works" survived being untrue.
    expect(signed).toEqual([
      { buyerDid: BUYER, purchaseOrderId: 'po-1', state: 'preparing' },
      { buyerDid: BUYER, purchaseOrderId: 'po-2', state: 'delivered' },
    ]);
    expect(response.body).toMatchObject({
      advanced: [
        { buyerDid: BUYER, purchaseOrderId: 'po-1', to: 'preparing', sequence: '1' },
        { buyerDid: BUYER, purchaseOrderId: 'po-2', to: 'delivered', sequence: '2' },
      ],
      refused: [],
    });
    expect(response.body).toMatchObject({
      checked: 2,
      unreachable: 0,
      results: [
        {
          buyerDid: BUYER,
          purchaseOrderId: 'po-1',
          decision: { kind: 'advance', to: 'preparing' },
        },
        {
          buyerDid: BUYER,
          purchaseOrderId: 'po-2',
          decision: { kind: 'advance', to: 'delivered' },
        },
      ],
    });
  });

  it('counts what it could not reach rather than implying it by a short list', async () => {
    executor = async ({ params }) =>
      (params as { external_ref: string }).external_ref === 'SO-1'
        ? { ok: false, error: 'connector down' }
        : { ok: true, result: { state: 'delivered' } };
    const response = await sweep();
    expect(response.body).toMatchObject({ checked: 2, unreachable: 1 });
    expect((response.body as { results: unknown[] }).results).toHaveLength(1);
  });

  it('carries a disagreement through instead of applying it', async () => {
    executor = async () => ({ ok: true, result: { state: 'preparing' } });
    const response = await sweep();
    const results = (
      response.body as { results: { purchaseOrderId: string; decision: { refusal?: string } }[] }
    ).results;
    // po-2 is dispatched; `preparing` would move it backwards.
    expect(results.find((r) => r.purchaseOrderId === 'po-2')?.decision).toMatchObject({
      refusal: 'moves_backwards',
    });
  });

  it('refuses a state outside the §9.11 vocabulary rather than throwing', async () => {
    executor = async () => ({ ok: true, result: { state: 'lost_in_the_post' } });
    const response = await sweep();
    // Unreadable answers are unreachable reads, not decisions.
    expect(response.body).toMatchObject({ checked: 2, unreachable: 2, results: [] });
  });

  it('treats an order with no chain as a disagreement, not a starting point', async () => {
    chainStates.delete('po-1');
    executor = async () => ({ ok: true, result: { state: 'preparing' } });
    const response = await sweep();
    const results = (
      response.body as { results: { purchaseOrderId: string; decision: { refusal?: string } }[] }
    ).results;
    expect(results.find((r) => r.purchaseOrderId === 'po-1')?.decision).toMatchObject({
      refusal: 'unknown_external_ref',
    });
  });

  it('uses the reference from the ORDER even when the connector echoes another', async () => {
    // A connector echoing the wrong reference would otherwise defeat the
    // reconciler's own crossed-report check.
    executor = async () => ({
      ok: true,
      result: { state: 'preparing', external_ref: 'SOMEBODY-ELSE' },
    });
    const response = await sweep();
    const results = (response.body as { results: { purchaseOrderId: string; decision: unknown }[] })
      .results;
    expect(results.find((r) => r.purchaseOrderId === 'po-1')?.decision).toEqual({
      kind: 'advance',
      to: 'preparing',
    });
  });

  it('needs a resource and an operation, and a credential that exists', async () => {
    expect(
      (await router.handle(request('POST', '/v1/commerce/orders/fulfilment/sweep', {}))).status,
    ).toBe(400);
    const unknown = await sweep({ resource: 'erp.nope' });
    expect(unknown.status).toBe(409);
  });

  it('is owner-only', async () => {
    for (const callerType of ['agent', 'plugin', 'service', 'device']) {
      const response = await router.handle(
        request('POST', '/v1/commerce/orders/fulfilment/sweep', {}, callerType),
      );
      expect(response.status).toBe(403);
    }
  });
});
