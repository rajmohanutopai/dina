/**
 * §16.2 — THE OWNER SURFACE FOR THE RECOVERY CEREMONY.
 *
 * `signRestoreFence`, `reconcileRestoredOrder` and `registerReplacementQuote`
 * were reachable only from tests. Every engine, every transaction boundary and
 * every refusal existed and was exercised; no production caller did. A
 * restored supplier could LIST the orders it could not answer for
 * (`GET /v1/commerce/reconciliation`) and had no way to recover a single one —
 * the read that names the problem shipped, the writes that solve it did not.
 *
 * The boundary test that should have caught it ALLOWLISTED all three, with the
 * reason "no operator surface yet". A row in that list is a promise to wire
 * something, and nothing re-read the promise.
 *
 * These drive the routes through the router, against a REAL commerce runtime
 * on a real SQLite adapter, because the defect was the absence of a caller —
 * and a test that called the service directly is exactly what already existed.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NodeSQLiteAdapter } from '@dina/storage-node';

import { createCommerceRuntime, installCommerceRuntime } from '../../../src/commerce/runtime';
import { CoreRouter, type CoreRequest } from '../../../src/server/router';
import { registerCommerceRoutes } from '../../../src/server/routes/commerce';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';

const OWNER_CAP = 'test-owner-capability-secret';
const BUYER_DID = 'did:plc:buyer1234';
const SUPPLIER_DID = 'did:plc:supplier5678';

const CEREMONY_ROUTES = [
  '/v1/commerce/reconciliation/order',
  '/v1/commerce/reconciliation/fence',
  '/v1/commerce/quotes/replacement',
] as const;

/** Every caller type that is NOT the owner, including "no type at all". */
const NON_OWNER: (string | undefined)[] = [
  undefined,
  'brain',
  'admin',
  'connector',
  'device',
  'agent',
  'plugin',
  'service',
];

function post(
  routePath: string,
  callerType: string | undefined,
  body: Record<string, unknown> = {},
  capability = OWNER_CAP,
): CoreRequest {
  return {
    method: 'POST',
    path: routePath,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    ...(callerType !== undefined ? { callerType, callerDID: 'did:key:caller' } : {}),
    ...(callerType === 'owner' ? { ownerCapability: capability } : {}),
  };
}

describe('the §16.2 ceremony routes', () => {
  let dir: string;
  let adapter: NodeSQLiteAdapter;
  let router: CoreRouter;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'commerce-ceremony-'));
    adapter = new NodeSQLiteAdapter({
      path: path.join(dir, 'identity.sqlite'),
      passphraseHex: randomBytes(32).toString('hex'),
    });
    applyMigrations(adapter, IDENTITY_MIGRATIONS);
    installCommerceRuntime(
      createCommerceRuntime({
        adapter,
        supplierDid: () => SUPPLIER_DID,
        currentEpoch: () => '2',
        now: () => 1_800_000_000_000,
        verifyHeldEvidence: () => true,
      }),
    );
    router = new CoreRouter();
    registerCommerceRoutes(router, OWNER_CAP);
  });

  afterEach(() => {
    installCommerceRuntime(null);
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the boundary', () => {
    it('rejects every non-owner caller on every ceremony route (403)', async () => {
      for (const routePath of CEREMONY_ROUTES) {
        for (const callerType of NON_OWNER) {
          const resp = await router.handle(post(routePath, callerType));
          expect(resp.status).toBe(403);
          expect((resp.body as { error: string }).error).toBe('access_denied');
        }
      }
    });

    it('rejects an owner presenting the wrong capability', async () => {
      for (const routePath of CEREMONY_ROUTES) {
        const resp = await router.handle(post(routePath, 'owner', {}, 'not-the-secret'));
        expect(resp.status).toBe(403);
      }
    });

    it('fails CLOSED when the owner control plane was never configured', async () => {
      // Brain's own router registers no capability. Falling back to "allow"
      // would put the recovery ceremony on a surface with no owner at all.
      const unconfigured = new CoreRouter();
      registerCommerceRoutes(unconfigured);
      for (const routePath of CEREMONY_ROUTES) {
        expect((await unconfigured.handle(post(routePath, 'owner'))).status).toBe(403);
      }
    });

    it('says "no commerce here" rather than failing oddly', async () => {
      installCommerceRuntime(null);
      for (const routePath of CEREMONY_ROUTES) {
        const resp = await router.handle(post(routePath, 'owner'));
        expect(resp.status).toBe(503);
        expect((resp.body as { error: string }).error).toBe('commerce_unavailable');
      }
    });
  });

  describe('what each route requires before it touches an engine', () => {
    it('refuses a reconcile with no proposal', async () => {
      const resp = await router.handle(
        post('/v1/commerce/reconciliation/order', 'owner', { buyer_did: BUYER_DID }),
      );
      expect(resp.status).toBe(400);
    });

    it('refuses a fence over NO evidence', async () => {
      // The one call that must not be possible. A fence exists to fast-forward
      // onto evidence; an empty list would ask the engine to move a signed
      // chain on the owner's say-so.
      for (const receipts of [undefined, [], 'not-an-array']) {
        const resp = await router.handle(
          post('/v1/commerce/reconciliation/fence', 'owner', {
            buyer_did: BUYER_DID,
            purchase_order_id: 'po-1',
            ...(receipts === undefined ? {} : { held_status_receipts: receipts }),
          }),
        );
        expect(resp.status).toBe(400);
      }
    });

    it('refuses a replacement quote with no quote', async () => {
      const resp = await router.handle(
        post('/v1/commerce/quotes/replacement', 'owner', { buyer_did: BUYER_DID }),
      );
      expect(resp.status).toBe(400);
    });
  });

  describe('the engines are really reached', () => {
    it('a reconcile for an order this node does not hold is REFUSED, not silently accepted', async () => {
      // 409 rather than 200: the route did not invent a success for an order
      // no engine could find. A stub that answered `{ok:true}` regardless
      // would pass every boundary case above.
      const resp = await router.handle(
        post('/v1/commerce/reconciliation/order', 'owner', {
          buyer_did: BUYER_DID,
          proposal: { purchase_order_id: 'po-does-not-exist' },
        }),
      );
      expect(resp.status).toBe(409);
      expect(typeof (resp.body as { error: string }).error).toBe('string');
    });

    it('a fence against a chain this node does not have is REFUSED', async () => {
      const resp = await router.handle(
        post('/v1/commerce/reconciliation/fence', 'owner', {
          buyer_did: BUYER_DID,
          purchase_order_id: 'po-does-not-exist',
          held_status_receipts: [{ record: {}, envelope: {}, signature: '' }],
        }),
      );
      expect(resp.status).toBe(409);
    });

    it('a replacement quote that does not validate is REFUSED', async () => {
      const resp = await router.handle(
        post('/v1/commerce/quotes/replacement', 'owner', {
          buyer_did: BUYER_DID,
          quote: { quote_id: 'q-1' },
        }),
      );
      expect(resp.status).toBe(409);
    });
  });
});
