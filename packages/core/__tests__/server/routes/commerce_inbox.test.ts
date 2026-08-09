/**
 * The supplier inbox, reached (§18.6, §18.1 — WS-7.3).
 *
 * `buildSupplierInbox` decides what needs the operator; this is the half that
 * gets it in front of them, and the half nothing tested. Its own suite drove
 * the projection directly and one journey walked through the route, which left
 * three route-level answers unchecked — and all three are DISTINCTIONS BETWEEN
 * EMPTY LISTS, which is the one thing this surface must never blur:
 *
 *   200 with `clear: true`   nothing needs you
 *   503 commerce_unavailable this node has no commerce at all
 *   409 supplier_not_installed you are not selling
 *
 * Rendered as an empty list, all three read as "nothing needs you", and two of
 * them are wrong in the direction that costs money: an operator reassured by a
 * node that is not even asking.
 */

import { CredentialBroker } from '../../../src/commerce/credential_broker';
import { InMemoryCredentialStore } from '../../../src/commerce/credential_store';
import {
  BUYER_REFERENCE_MANIFEST,
  SUPPLIER_REFERENCE_MANIFEST,
} from '../../../src/commerce/reference_manifests';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { setPluginInstallRepository } from '../../../src/plugins/registry';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';

import type { CommerceOrderRef } from '../../../src/commerce/order_refs';

const OWNER_CAP = 'test-owner-capability-secret';

let router: CoreRouter;
let reserved: CommerceOrderRef[];
/** Purchase order id -> cancellations parked for a human (§12.5). */
let pendingReview: Map<string, { cancellation_id: string; result: string }[]>;

function get(callerType = 'owner'): CoreRequest {
  return {
    method: 'GET',
    path: '/v1/commerce/inbox',
    query: {},
    headers: {},
    body: {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== '' ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

function orderRef(over: Partial<CommerceOrderRef> = {}): CommerceOrderRef {
  return {
    purchaseOrderId: 'po-1',
    buyerDid: 'did:plc:sancho42',
    orderDigest: 'a'.repeat(64),
    quoteId: 'q-1',
    state: 'reserved',
    decisionDeadlineAt: null,
    effectPhase: 'none',
    ...over,
  } as CommerceOrderRef;
}

/**
 * A runtime with the REAL broker over an empty store, and the real settings
 * read reporting "not configured".
 *
 * The inbox joins four sources; stubbing all four would test the stub. What is
 * substituted here is only the two SOURCES of rows — reserved orders and the
 * settings record — because those are the inputs a route test varies.
 */
function installRuntime(settings?: { ok: false; absent: true }): void {
  installCommerceRuntime({
    orders: { listReserved: () => reserved },
    settings: { readSupplier: () => settings ?? { ok: false, absent: true } },
    broker: new CredentialBroker({ store: new InMemoryCredentialStore(), executors: () => ({}) }),
    // §12.5 — SUPPLIED, not omitted. The route wraps this scan in a catch so
    // one corrupt receipt cannot cost an operator the whole inbox, and a
    // runtime without it would have that catch hide the wiring entirely: the
    // inbox would go on rendering with no `finalize_cancellation` and every
    // test would pass. The double answers from a per-order map the tests set.
    lifecycle: {
      listPendingReviewCancellations: (_buyer: string, purchaseOrderId: string) =>
        pendingReview.get(purchaseOrderId) ?? [],
    },
  } as unknown as CommerceRuntime);
}

beforeEach(() => {
  reserved = [];
  pendingReview = new Map();
  installRuntime();
  setPluginInstallRepository(null);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});

afterEach(() => {
  installCommerceRuntime(null);
  setPluginInstallRepository(null);
});

describe('the boundary', () => {
  it.each(['brain', 'agent', 'plugin', 'device', 'service', 'admin', 'connector', ''])(
    'refuses caller type %p',
    async (callerType) => {
      const resp = await router.handle(get(callerType));
      expect(resp.status).toBe(403);
      expect((resp.body as { error: string }).error).toBe('access_denied');
    },
  );
});

describe('three empty lists that mean different things', () => {
  it('200 and CLEAR when nothing needs the operator', async () => {
    const resp = await router.handle(get());
    expect(resp.status).toBe(200);
    expect(resp.body).toMatchObject({ items: [], clear: true });
  });

  it('503 when this node has no commerce', async () => {
    // Not an empty inbox. A node with no commerce has not asked the question,
    // so it has not earned the reassurance an empty answer carries.
    installCommerceRuntime(null);
    const resp = await router.handle(get());
    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('commerce_unavailable');
  });

  it('409 when this node installed plugins but not the SUPPLIER role', async () => {
    // §18.1/FR-P1 asked per ROLE. "Nothing needs you" is the wrong answer to a
    // node that is not selling; the truth is that it never installed the half
    // that could receive an order.
    // The install's REAL plugin id, from the reference manifest. My first
    // version invented `{ role: 'buyer' }`, which `roleIsInstalled` does not
    // read at all — so the test passed for the wrong reason and the sibling
    // case below failed. A fixture that guesses the shape tests the guess.
    setPluginInstallRepository({
      list: () => [{ installId: 'i-1', pluginId: BUYER_REFERENCE_MANIFEST.plugin_id }],
    } as never);
    const resp = await router.handle(get());
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toBe('supplier_not_installed');
  });

  it('answers normally when the supplier role IS installed', async () => {
    setPluginInstallRepository({
      list: () => [{ installId: 'i-1', pluginId: SUPPLIER_REFERENCE_MANIFEST.plugin_id }],
    } as never);
    const resp = await router.handle(get());
    expect(resp.status).toBe(200);
    expect((resp.body as { clear: boolean }).clear).toBe(true);
  });
});

describe('what reaches the operator', () => {
  it('reports a reserved order as needing a decision, and is NOT clear', async () => {
    reserved = [orderRef()];
    const resp = await router.handle(get());
    const body = resp.body as { items: { kind: string; subject: string }[]; clear: boolean };
    expect(body.clear).toBe(false);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.kind).toBe('order_awaiting_decision');
    expect(body.items[0]?.subject).toBe('po-1');
  });

  it('reads the orders from the AGGREGATE, so a route that skipped it shows nothing', async () => {
    // The join the surface depends on. A route that returned a built inbox
    // without asking the aggregate would report `clear: true` to an operator
    // with orders waiting — the single worst answer this endpoint can give.
    reserved = [orderRef({ purchaseOrderId: 'po-a' }), orderRef({ purchaseOrderId: 'po-b' })];
    const resp = await router.handle(get());
    const body = resp.body as { items: { subject: string }[] };
    expect(body.items.map((i) => i.subject).sort()).toEqual(['po-a', 'po-b']);
  });

  it('treats settings that do not validate as ABSENT rather than failing the inbox', async () => {
    // An operator with a broken settings row still needs to see the orders
    // waiting on them; the settings route is where that fault is reported.
    installCommerceRuntime({
      orders: { listReserved: () => [orderRef()] },
      settings: {
        readSupplier: () => ({ ok: false, absent: false, findings: ['listingState is required'] }),
      },
      broker: new CredentialBroker({ store: new InMemoryCredentialStore(), executors: () => ({}) }),
    } as unknown as CommerceRuntime);
    const resp = await router.handle(get());
    expect(resp.status).toBe(200);
    expect((resp.body as { items: unknown[] }).items).toHaveLength(1);
  });
});

/**
 * §12.5 — the way out of `pending_review`, reached.
 *
 * `finalizePendingCancellation` was written, tested at the engine, exposed on
 * the service, and called by NOTHING. `resolveCancellation` refuses to leave
 * `pending_review` on purpose — the review closes because the OWNER decided,
 * never because the buyer resent the request — so with no route the state was
 * a trap: an order whose external effect had fired stayed non-terminal for
 * ever, holding quote capacity and blocking both continuity release and
 * plugin uninstall.
 */
describe('a cancellation parked for a human (§12.5)', () => {
  function post(body: Record<string, unknown>, callerType = 'owner'): CoreRequest {
    return {
      method: 'POST',
      path: '/v1/commerce/cancellations/finalize',
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

  const TERMINAL = {
    protocol_version: '1.0',
    cancellation_id: 'c-1',
    purchase_order_id: 'po-1',
    result: 'refused_already_dispatched',
    resolved_at: '2026-08-01T10:00:00.000Z',
  };

  /** A runtime whose finalization records what it was asked. */
  function withFinalize(
    answer: unknown = TERMINAL,
  ): { asked: { cancellationId: string; result: string }[] } {
    const asked: { cancellationId: string; result: string }[] = [];
    installCommerceRuntime({
      orders: { listReserved: () => reserved },
      settings: { readSupplier: () => ({ ok: false, absent: true }) },
      broker: new CredentialBroker({ store: new InMemoryCredentialStore(), executors: () => ({}) }),
      lifecycle: {
        listPendingReviewCancellations: () => [],
        finalizePendingCancellation: (
          _buyer: string,
          _po: string,
          cancellationId: string,
          result: string,
        ) => {
          asked.push({ cancellationId, result });
          return answer;
        },
      },
    } as unknown as CommerceRuntime);
    return { asked };
  }

  it('shows the action ONLY on an order that actually has one parked', async () => {
    reserved = [orderRef({ purchaseOrderId: 'po-parked', effectPhase: 'effect_started' })];
    pendingReview.set('po-parked', [{ cancellation_id: 'c-1', result: 'pending_review' }]);
    const parked = await router.handle(get());
    const parkedItem = (parked.body as { items: { subject: string; actions: string[] }[] }).items[0];
    expect(parkedItem?.subject).toBe('po-parked');
    expect(parkedItem?.actions).toEqual(['finalize_cancellation']);

    // The other half of the same case: an effect that fired with NO
    // cancellation attached still has no command, and must not pretend to.
    pendingReview.clear();
    const bare = await router.handle(get());
    const bareItem = (bare.body as { items: { actions: string[] }[] }).items[0];
    expect(bareItem?.actions).toEqual([]);
  });

  it('settles the review and returns the terminal result', async () => {
    const { asked } = withFinalize();
    const resp = await router.handle(
      post({
        buyer_did: 'did:plc:sancho42',
        purchase_order_id: 'po-1',
        cancellation_id: 'c-1',
        result: 'refused_already_dispatched',
      }),
    );
    expect(resp.status).toBe(200);
    expect((resp.body as { result: { result: string } }).result.result).toBe(
      'refused_already_dispatched',
    );
    expect(asked).toEqual([{ cancellationId: 'c-1', result: 'refused_already_dispatched' }]);
  });

  it('refuses a result kind §12.5 does not allow a review to close with', async () => {
    const { asked } = withFinalize();
    // `pending_review` is the state, not a decision. Accepting it would let an
    // owner "settle" a review by restating it, and the engine's CAS would then
    // be the only thing standing between that and a no-op nobody noticed.
    const resp = await router.handle(
      post({
        buyer_did: 'did:plc:sancho42',
        purchase_order_id: 'po-1',
        cancellation_id: 'c-1',
        result: 'pending_review',
      }),
    );
    expect(resp.status).toBe(400);
    expect((resp.body as { error: string }).error).toBe('unknown_result');
    // And nothing reached the engine.
    expect(asked).toEqual([]);
  });

  it('requires all three ids rather than guessing one', async () => {
    const { asked } = withFinalize();
    const resp = await router.handle(
      post({ buyer_did: 'did:plc:sancho42', result: 'refused_policy' }),
    );
    expect(resp.status).toBe(400);
    expect(asked).toEqual([]);
  });

  it('reports the engine refusal rather than claiming success', async () => {
    withFinalize({ error: 'commerce: nothing to finalize' });
    const resp = await router.handle(
      post({
        buyer_did: 'did:plc:sancho42',
        purchase_order_id: 'po-1',
        cancellation_id: 'c-nope',
        result: 'refused_policy',
      }),
    );
    expect(resp.status).toBe(409);
    expect((resp.body as { error: string }).error).toMatch(/nothing to finalize/);
  });

  it('is owner-only', async () => {
    withFinalize();
    const resp = await router.handle(
      post(
        {
          buyer_did: 'did:plc:sancho42',
          purchase_order_id: 'po-1',
          cancellation_id: 'c-1',
          result: 'refused_policy',
        },
        'agent',
      ),
    );
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.status).not.toBe(200);
  });
});
