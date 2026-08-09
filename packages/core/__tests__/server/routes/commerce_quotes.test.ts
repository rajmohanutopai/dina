/**
 * The supplier's quote surface, reached (FR-P10, WS-7.8).
 *
 * `describeQuoteForOwner` decides what a quote MEANS; this is the half that
 * gets it in front of an owner, and the half that would otherwise be another
 * correct-and-unreachable projection. It also covers the listing itself,
 * because a mutation that dropped the stable tiebreak survived every test of
 * the projection — the projection cannot see the order it is given.
 *
 * OWNER-ONLY, and here the reason is the strongest on this file's surface: the
 * list names every buyer this business has priced for and what it offered
 * them. That is the whole commercial position, and nothing on the wire
 * enumerates it.
 */

import { QuoteFamilyStore } from '../../../src/commerce/quote_family';
import {
  InMemoryCommerceQuoteLedgerRepository,
  type CommerceQuoteHead,
} from '../../../src/commerce/quote_ledger';
import { installCommerceRuntime, type CommerceRuntime } from '../../../src/commerce/runtime';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';

const OWNER_CAP = 'test-owner-capability-secret';
const BUYER = 'did:plc:sancho42';
const SUPPLIER = 'did:plc:chairmaker99';
const NOW_ISH = Date.now();

let ledger: InMemoryCommerceQuoteLedgerRepository;
let router: CoreRouter;

function req(callerType: string | undefined): CoreRequest {
  return {
    method: 'GET',
    path: '/v1/commerce/quotes',
    query: {},
    headers: {},
    body: {},
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: OWNER_CAP } : {}),
  };
}

function seed(over: Partial<CommerceQuoteHead> & { quoteId: string }): void {
  ledger.registerHead({
    buyerDid: BUYER,
    headDigest: 'a'.repeat(64),
    headRevision: '1',
    maxUses: '1',
    validUntil: NOW_ISH + 3_600_000,
    supplierEpoch: '1',
    createdAt: NOW_ISH - 1_000,
    ...over,
  });
}

/**
 * The REAL aggregate store over the in-memory ledger.
 *
 * A stub with its own `listForOwner` was the first version, and a mutation
 * dropping the capacity join survived it — because the stub did the join
 * itself. The store is the thing under test here as much as the route is.
 */
function families(): CommerceRuntime['families'] {
  return new QuoteFamilyStore({
    ledger,
    currentEpoch: () => '1',
    supplierDid: () => SUPPLIER,
    now: () => NOW_ISH,
  }) as unknown as CommerceRuntime['families'];
}

beforeEach(() => {
  ledger = new InMemoryCommerceQuoteLedgerRepository();
  installCommerceRuntime({ families: families() } as unknown as CommerceRuntime);
  router = new CoreRouter();
  registerCommerceRoutes(router, OWNER_CAP);
});
afterEach(() => installCommerceRuntime(null));

describe('the boundary', () => {
  it.each([undefined, 'brain', 'agent', 'plugin', 'device', 'admin', 'service'])(
    'refuses caller type %s',
    async (callerType) => {
      seed({ quoteId: 'q-1' });
      expect((await router.handle(req(callerType))).status).toBe(403);
    },
  );

  it('says the node has no commerce rather than showing an empty list', async () => {
    // An empty list from a node with no commerce has not earned the
    // reassurance an empty list from a working one carries.
    installCommerceRuntime(null);
    const resp = await router.handle(req('owner'));
    expect(resp.status).toBe(503);
    expect((resp.body as { error: string }).error).toBe('commerce_unavailable');
  });
});

describe('what the owner sees', () => {
  it('renders each quote through the ONE projection', async () => {
    // Voided FIRST, then the live one seeded: `voidUnexpired` marks every
    // unexpired head, so seeding both before it would void both. My first
    // version did exactly that and the assertion contradicted the comment
    // beside it.
    seed({ quoteId: 'q-void', createdAt: NOW_ISH - 2_000 });
    ledger.voidUnexpired(NOW_ISH, NOW_ISH);
    seed({ quoteId: 'q-live' });

    const resp = await router.handle(req('owner'));
    expect(resp.status).toBe(200);
    const body = resp.body as { quotes: { quoteId: string; state: string; actions: string[] }[] };
    const byId = new Map(body.quotes.map((q) => [q.quoteId, q]));
    expect(byId.get('q-live')?.state).toBe('live');
    expect(byId.get('q-live')?.actions).toEqual(['view']);
    // The route reports what the projection says rather than deriving its own
    // answer — two states in one response, from one function.
    expect(byId.get('q-void')?.state).toBe('voided');
    expect(byId.get('q-void')?.actions).toEqual(['view']);
  });

  it('is empty, not absent, when this supplier has issued nothing', async () => {
    const resp = await router.handle(req('owner'));
    expect(resp.status).toBe(200);
    expect((resp.body as { quotes: unknown[] }).quotes).toEqual([]);
  });
});

describe('the listing itself', () => {
  it('is newest first, with a STABLE tiebreak', async () => {
    // Two families created in the same millisecond must not shuffle between
    // reads: an owner list that reorders itself on refresh reads as if
    // something changed. A mutation dropping the tiebreak survived every test
    // of the projection, because a projection cannot see the order it is given.
    seed({ quoteId: 'q-b', createdAt: 5_000 });
    seed({ quoteId: 'q-a', createdAt: 5_000 });
    seed({ quoteId: 'q-newest', createdAt: 9_000 });

    const first = ledger.listHeads().map((h) => h.quoteId);
    expect(first).toEqual(['q-newest', 'q-a', 'q-b']);
    // Read twice: identical, which is the actual promise.
    expect(ledger.listHeads().map((h) => h.quoteId)).toEqual(first);
  });

  it('carries the spent capacity alongside each head', async () => {
    // The join the projection depends on. A route that listed heads and left
    // `usesSpent` at zero would render a consumed quote as live.
    seed({ quoteId: 'q-1', maxUses: '2' });
    ledger.holdUse('q-1', 'po-1', NOW_ISH);
    ledger.holdUse('q-1', 'po-2', NOW_ISH);

    const resp = await router.handle(req('owner'));
    const body = resp.body as { quotes: { quoteId: string; state: string; usesSpent: number }[] };
    expect(body.quotes[0]?.usesSpent).toBe(2);
    expect(body.quotes[0]?.state).toBe('consumed');
  });
});
