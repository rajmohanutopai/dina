/**
 * The UCP routes (UCP plan §3.11, §3.16) through the in-process transport,
 * as the phone's Brain calls them: search, read, the owner's card, the guard.
 * Also who may call them on a server.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { A2A_CORE_ANSWER_HEADER } from '@dina/a2a';
import { NodeSQLiteAdapter } from '@dina/storage-node';

import { A2AReleaseLog, installA2AReleaseLog } from '../../../src/a2a';
import { isAuthorized } from '../../../src/auth/authz';
import { SQLiteChatMessageRepository } from '../../../src/chat/repository';
import { readConversationTaint } from '../../../src/chat/taint';
import { HttpCoreTransport } from '../../../src/client/http-transport';
import { InProcessTransport } from '../../../src/client/in-process-transport';
import { inProcessOwnerDispatcher } from '../../../src/client/owner-dispatch';
import { OwnerUcpClient } from '../../../src/client/owner-ucp-client';
import { UcpDiscovery } from '../../../src/commerce/ucp/discovery';
import { deriveUcpIdentity } from '../../../src/commerce/ucp/identity';
import { installUcpLinkStore, UcpLinkStore } from '../../../src/commerce/ucp/link_store';
import { UcpMerchantClient } from '../../../src/commerce/ucp/merchant_client';
import { installUcpMerchantTrust } from '../../../src/commerce/ucp/merchant_trust';
import { getUcpSearchRuntime, installUcpSearchRuntime } from '../../../src/commerce/ucp/runtime';
import {
  installUcpCheckoutRuntime,
  type UcpCheckoutRuntime,
} from '../../../src/commerce/ucp/runtime';
import { SchemaResolver } from '../../../src/commerce/ucp/schemas';
import { UcpSearchStore } from '../../../src/commerce/ucp/search_store';
import {
  installUcpSettingsListener,
  installUcpSettingsStore,
  UcpSettingsStore,
} from '../../../src/commerce/ucp/settings';
import { UcpTransport } from '../../../src/commerce/ucp/transport';
import {
  installUcpWebhookOrigin,
  UCP_OAUTH_INGRESS_ROUTE,
  UCP_WEBHOOK_INGRESS_ROUTE,
} from '../../../src/commerce/ucp/webhooks';
import { registerDevice, resetDeviceRegistry } from '../../../src/devices/registry';
import { setNodeDID } from '../../../src/pairing/ceremony';
import { CoreRouter, type CoreRequest, type CoreResponse } from '../../../src/server/router';
import { registerUcpRoutes } from '../../../src/server/routes/ucp';
import { applyMigrations } from '../../../src/storage/migration';
import { IDENTITY_MIGRATIONS } from '../../../src/storage/schemas';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService } from '../../../src/workflow/service';
import { fakeMerchants, productNamed } from '../../commerce/ucp/merchant_fixture';

import type { UcpSearchMerchant } from '../../../src/client/core-client';
import type { MerchantOutcome } from '../../../src/commerce/ucp/search';

// The wire's merchant type is Core's outcome, member for member: a state added on
// one side and not the other fails to compile.
type Same<X, Y> = [X] extends [Y] ? ([Y] extends [X] ? true : false) : false;
const merchantWireMatches: Same<MerchantOutcome, UcpSearchMerchant> = true;
void merchantWireMatches;

const SHOP = 'https://tea-shop.example';
const OWNER_CAP = 'test-owner-capability';

/** An owner call, as the phone's or web app's owner surface makes it. */
const ownerCall = (
  method: 'GET' | 'PUT' | 'POST',
  p: string,
  body: unknown = {},
  overrides: Partial<CoreRequest> = {},
): Promise<CoreResponse> =>
  router.handle({
    method,
    path: p,
    query: {},
    headers: {},
    body,
    rawBody: new Uint8Array(),
    params: {},
    trustedInProcess: true,
    callerType: 'owner',
    ownerCapability: OWNER_CAP,
    ...overrides,
  } as CoreRequest);
const SESSION = 'chat:main';

let dir: string;
let db: NodeSQLiteAdapter;
let router: CoreRouter;
let core: InProcessTransport;
let workflow: WorkflowService;
let web: ReturnType<typeof fakeMerchants>;
let n = 0;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'ucp-routes-'));
  db = new NodeSQLiteAdapter({
    path: path.join(dir, 'identity.sqlite'),
    passphraseHex: 'ef'.repeat(32),
    journalMode: 'WAL',
    synchronous: 'NORMAL',
  });
  applyMigrations(db, IDENTITY_MIGRATIONS);
  const log = new A2AReleaseLog(db);
  installA2AReleaseLog(log);
  log.recordUtterance(SESSION, 't0', 'hi');
  await new SQLiteChatMessageRepository(db).append({
    id: 'm1',
    threadId: 'main',
    type: 'user',
    content: 'hi',
    metadata: {},
    sources: [],
    timestamp: Date.now(),
  });
  workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
  web = fakeMerchants({
    [SHOP]: () => [productNamed('t1', 'Sencha'), productNamed('t2', 'Matcha')],
  });
  const identity = deriveUcpIdentity(new Uint8Array(32).fill(4), 0);
  installUcpSearchRuntime({
    store: new UcpSearchStore(db),
    client: new UcpMerchantClient({
      discovery: new UcpDiscovery({ fetch: web.fetch }),
      resolver: new SchemaResolver({ fetch: web.fetch }),
      transport: new UcpTransport({ fetch: web.fetch }),
      identity: () => identity,
      profileHost: 'ucp.test.example',
    }),
    check: { log, taint: (s) => readConversationTaint(db, log, s), nowMs: Date.now },
    settings: () => ({ merchants: web.origins, context: {} }),
    workflow: () => workflow,
    nowMs: Date.now,
    newId: () => `id${++n}`,
  });
  router = new CoreRouter();
  registerUcpRoutes(router, OWNER_CAP);
  setNodeDID('did:plc:owner');
  installUcpSettingsStore(new UcpSettingsStore(db));
  core = new InProcessTransport(router);
});

afterEach(() => {
  installUcpSettingsStore(null);
  installUcpSearchRuntime(null);
  installA2AReleaseLog(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The server's Brain: HttpCoreTransport, its requests handed to the same
 * router as a signed Brain call arrives (the signature itself is the auth
 * pipeline's, tested there).
 */
function httpBrain(): HttpCoreTransport {
  return new HttpCoreTransport({
    baseUrl: 'http://core:8100',
    signer: async () => ({ did: 'did:plc:brain', timestamp: 't', nonce: 'n', signature: 's' }),
    httpClient: {
      async request(url, init) {
        const u = new URL(url);
        const raw = init.body ?? new Uint8Array();
        const res = await router.handle({
          method: init.method as CoreRequest['method'],
          path: u.pathname,
          query: Object.fromEntries(u.searchParams),
          headers: init.headers,
          body: raw.length > 0 ? JSON.parse(new TextDecoder().decode(raw)) : undefined,
          rawBody: raw,
          params: {},
          trustedInProcess: true,
          callerType: 'brain',
        } as CoreRequest);
        return {
          status: res.status,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(res.status === 204 ? '' : JSON.stringify(res.body)),
        };
      },
    },
  });
}

describe('Brain’s UCP routes', () => {
  it('search, guard every product’s text, then read the search', async () => {
    const started = await core.searchUcp({
      releaseSession: SESSION,
      query: 'green tea',
      merchants: [SHOP],
    });
    expect(started).toMatchObject({
      ok: true,
      provenance: 'derived',
      merchants: [{ handle: 'm1', origin: SHOP, state: 'ok', products: 2 }],
    });
    if (!started.ok) return;
    for (
      let work = await core.claimUcpGuardJob();
      work !== null;
      work = await core.claimUcpGuardJob()
    ) {
      expect(work.merchant).toBe(SHOP);
      const out = await core.submitUcpGuardVerdict({
        jobId: work.job_id,
        claimId: work.claim_id,
        digest: work.digest,
        verdict: 'passed',
        code: 'model_pass',
      });
      expect(out).toEqual({ ok: true, state: 'passed' });
    }
    const view = await core.getUcpSearch(started.searchId, SESSION);
    expect(view?.complete).toBe(true);
    expect(view?.products.map((p) => [p.product.handle, p.text?.title])).toEqual([
      ['p1', 'Sencha'],
      ['p2', 'Matcha'],
    ]);
    expect(await core.getUcpSearch(started.searchId, 'chat:other')).toBeNull();
  });

  it('a held search comes back needs_review with its reasons; the card is raised by Core and used once', async () => {
    const held = { releaseSession: SESSION, query: 'tea for +1 415 555 0134', merchants: [SHOP] };
    expect(await core.searchUcp(held)).toEqual({
      ok: false,
      status: 409,
      reason: 'needs_review',
      why: ['personal_data'],
    });
    const raised = await core.raiseUcpSearchReview(held);
    if (!raised.ok) throw new Error('raise');
    expect(await core.searchUcp({ ...held, reviewId: raised.reviewId })).toEqual({
      ok: false,
      status: 409,
      reason: 'review_pending',
    });
    workflow.approve(raised.reviewId);
    expect(await core.searchUcp({ ...held, reviewId: raised.reviewId })).toMatchObject({
      ok: true,
    });
    expect(await core.searchUcp({ ...held, reviewId: raised.reviewId })).toEqual({
      ok: false,
      status: 409,
      reason: 'review_used',
    });
    expect(
      await core.raiseUcpSearchReview({ releaseSession: SESSION, query: 'tea', merchants: [SHOP] }),
    ).toEqual({
      ok: false,
      status: 409,
      reason: 'not_needed',
    });
  });

  it('bad input is a 400; no runtime is a 503; a verdict that is not one is refused', async () => {
    expect(
      await core.searchUcp({ releaseSession: 'bad session!', query: 'x', merchants: [SHOP] }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await core.searchUcp({
        releaseSession: SESSION,
        query: 'x',
        merchants: ['http://plain.example'],
      }),
    ).toEqual({
      ok: false,
      status: 400,
      reason: 'bad_merchants',
    });
    expect(
      await core.submitUcpGuardVerdict({
        jobId: 'nope',
        claimId: 'c',
        digest: 'd',
        verdict: 'passed',
        code: 'model_pass',
      }),
    ).toEqual({
      ok: false,
      status: 404,
      reason: 'not_found',
    });
    const installed = getUcpSearchRuntime();
    if (installed === null) throw new Error('runtime');
    installUcpSearchRuntime({ ...installed, workflow: () => null });
    expect(await core.claimUcpGuardJob().catch((e: Error) => e.message)).toMatch(/503/);
    installUcpSearchRuntime(null);
    expect(
      await core.searchUcp({ releaseSession: SESSION, query: 'x', merchants: [SHOP] }),
    ).toEqual({ ok: false, status: 503, reason: 'ucp_unavailable' });
  });

  it('the server’s Brain reads every route the same way over HTTP', async () => {
    const http = httpBrain();
    expect(await http.claimUcpGuardJob()).toBeNull();
    const started = await http.searchUcp({
      releaseSession: SESSION,
      query: 'green tea',
      merchants: [SHOP],
    });
    if (!started.ok) throw new Error(`search: ${started.reason}`);
    expect(started.merchants).toEqual([
      { handle: 'm1', origin: SHOP, state: 'ok', products: 2, skipped: 0 },
    ]);
    const work = await http.claimUcpGuardJob();
    if (work === null) throw new Error('claim');
    expect(
      await http.submitUcpGuardVerdict({
        jobId: work.job_id,
        claimId: work.claim_id,
        digest: 'x',
        verdict: 'passed',
        code: 'model_pass',
      }),
    ).toEqual({ ok: false, status: 409, reason: 'digest_mismatch' });
    expect(
      await http.submitUcpGuardVerdict({
        jobId: work.job_id,
        claimId: work.claim_id,
        digest: work.digest,
        verdict: 'passed',
        code: 'model_pass',
      }),
    ).toEqual({ ok: true, state: 'passed' });
    const view = await http.getUcpSearch(started.searchId, SESSION);
    expect(view?.products[0]).toMatchObject({ text_state: 'passed', product: { handle: 'p1' } });
    expect(await http.getUcpSearch(started.searchId, 'chat:other')).toBeNull();
    const held = { releaseSession: SESSION, query: 'tea for +1 415 555 0134', merchants: [SHOP] };
    expect(await http.searchUcp(held)).toEqual({
      ok: false,
      status: 409,
      reason: 'needs_review',
      why: ['personal_data'],
    });
    const raised = await http.raiseUcpSearchReview(held);
    expect(raised).toMatchObject({ ok: true });
    expect(await http.searchUcp({ ...held, releaseSession: 'chat:nobody' })).toEqual({
      ok: false,
      status: 409,
      reason: 'no_owner_turn',
    });
    installUcpSearchRuntime(null);
    await expect(http.claimUcpGuardJob()).rejects.toMatchObject({ status: 503 });
  });

  it('the owner reads each of a search’s shops’ trust from Core, through the owner client; Brain cannot', async () => {
    const started = await core.searchUcp({ releaseSession: SESSION, query: 'green tea' });
    if (!started.ok) throw new Error(started.reason);
    const asked: string[] = [];
    installUcpMerchantTrust(async (subject) => {
      asked.push(JSON.parse(subject).uri);
      return { trustLevel: 'high', recommendation: 'proceed', attestationSummary: { total: 7 } };
    });
    try {
      const client = new OwnerUcpClient(inProcessOwnerDispatcher(router, OWNER_CAP));
      expect(await client.trust(started.searchId)).toEqual(
        new Map([[SHOP, { state: 'rated', recommendation: 'proceed', level: 'high', reviews: 7 }]]),
      );
      // Only the shops the search asked: nothing a caller names.
      expect(asked).toEqual([SHOP]);
      expect(await client.trust('ucp-search-none')).toEqual(new Map());
      expect(
        (
          await ownerCall(
            'GET',
            `/v1/owner/ucp/searches/${started.searchId}/trust`,
            {},
            { callerType: 'brain', ownerCapability: undefined },
          )
        ).status,
      ).toBe(403);
      expect(isAuthorized('brain', 'GET', `/v1/owner/ucp/searches/${started.searchId}/trust`)).toBe(
        false,
      );
      expect(
        isAuthorized('device', 'GET', `/v1/owner/ucp/searches/${started.searchId}/trust`),
      ).toBe(true);
    } finally {
      installUcpMerchantTrust(null);
    }
  });

  it('fetches products by handle, and the owner reads the search with the merchant’s own titles', async () => {
    const started = await core.searchUcp({ releaseSession: SESSION, query: 'green tea' });
    if (!started.ok) throw new Error(started.reason);
    const fetched = await core.fetchUcpProducts({ releaseSession: SESSION, products: ['p2'] });
    expect(fetched).toMatchObject({
      ok: true,
      merchants: [{ origin: SHOP, state: 'ok', products: 1 }],
    });
    expect(await core.fetchUcpProducts({ releaseSession: SESSION, products: ['p9'] })).toEqual({
      ok: false,
      status: 404,
      reason: 'unknown_product',
    });
    const owner = await ownerCall('GET', `/v1/owner/ucp/searches/${started.searchId}`);
    expect(owner.status).toBe(200);
    expect((owner.body as { products: { title: string }[] }).products.map((p) => p.title)).toEqual([
      'Sencha',
      'Matcha',
    ]);
    expect((await ownerCall('GET', '/v1/owner/ucp/searches/ucp-search-none')).status).toBe(404);
    // Not the owner: a wrong capability, or Brain.
    expect(
      (
        await ownerCall(
          'GET',
          `/v1/owner/ucp/searches/${started.searchId}`,
          {},
          { ownerCapability: 'nope' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await ownerCall(
          'GET',
          `/v1/owner/ucp/searches/${started.searchId}`,
          {},
          { callerType: 'brain', ownerCapability: undefined },
        )
      ).status,
    ).toBe(403);
  });

  it('the owner reads and saves the settings; a field that does not read is named; Brain cannot', async () => {
    // `searching`: this node runs UCP (the runtime is installed here).
    expect(await ownerCall('GET', '/v1/owner/ucp/settings')).toEqual({
      status: 200,
      body: {
        merchants: [],
        context: {},
        order_webhooks: true,
        order_webhook_url: null,
        searching: true,
      },
    });
    const saved = await ownerCall('PUT', '/v1/owner/ucp/settings', {
      merchants: ['https://Tea-Shop.example'],
      context: { address_country: 'DE' },
    });
    expect(saved).toEqual({
      status: 200,
      body: {
        merchants: [SHOP],
        context: { address_country: 'DE' },
        order_webhooks: true,
        order_webhook_url: null,
        searching: true,
      },
    });
    expect(
      await ownerCall('PUT', '/v1/owner/ucp/settings', {
        merchants: [],
        context: { address_country: 'Germany' },
      }),
    ).toEqual({
      status: 400,
      body: { error: 'invalid_settings', field: 'address_country' },
    });
    expect(
      (
        await ownerCall(
          'PUT',
          '/v1/owner/ucp/settings',
          { merchants: [], context: {} },
          { callerType: 'brain', ownerCapability: undefined },
        )
      ).status,
    ).toBe(403);
    expect((await ownerCall('GET', '/v1/owner/ucp/settings')).body).toEqual({
      merchants: [SHOP],
      context: { address_country: 'DE' },
      order_webhooks: true,
      order_webhook_url: null,
      searching: true,
    });
    // With UCP off the settings still read and save, and say search is off.
    installUcpSearchRuntime(null);
    expect((await ownerCall('GET', '/v1/owner/ucp/settings')).body).toMatchObject({
      merchants: [SHOP],
      searching: false,
    });
  });

  it('order webhooks: listed on a public node unless turned off; a save without the choice keeps it; each save is announced', async () => {
    let announced = 0;
    installUcpSettingsListener(() => announced++);
    installUcpWebhookOrigin('https://node.example/');
    try {
      expect((await ownerCall('GET', '/v1/owner/ucp/settings')).body).toMatchObject({
        order_webhooks: true,
        order_webhook_url: 'https://node.example/ucp/webhooks/orders',
      });
      const off = await ownerCall('PUT', '/v1/owner/ucp/settings', {
        merchants: [],
        context: {},
        order_webhooks: false,
      });
      expect(off.body).toMatchObject({ order_webhooks: false, order_webhook_url: null });
      // A screen that does not show the choice (the phone's) leaves it off.
      const kept = await ownerCall('PUT', '/v1/owner/ucp/settings', {
        merchants: [SHOP],
        context: {},
      });
      expect(kept.body).toMatchObject({
        merchants: [SHOP],
        order_webhooks: false,
        order_webhook_url: null,
      });
      expect(announced).toBe(2);
    } finally {
      installUcpWebhookOrigin(null);
      installUcpSettingsListener(null);
    }
  });

  it('the webhook door: the gateway’s alone; Core’s answer marked for relay; a failed store is a 503 the gateway does not relay', async () => {
    const call = (callerType: CoreRequest['callerType']) =>
      router.handle({
        method: 'POST',
        path: UCP_WEBHOOK_INGRESS_ROUTE,
        query: {},
        headers: {},
        body: { path: '/ucp/webhooks/orders', query: '', headers: {}, body_b64: '' },
        rawBody: new Uint8Array(),
        params: {},
        trustedInProcess: true,
        callerType,
      } as CoreRequest);
    expect((await call('brain')).status).toBe(403);
    expect(await call('device')).toMatchObject({ status: 403 });
    // No UCP runtime: still a 200 the gateway relays, and nothing kept.
    installUcpCheckoutRuntime(null);
    expect(await call('gateway')).toEqual({
      status: 200,
      body: { ucp: { version: '2026-08-25' } },
      headers: { [A2A_CORE_ANSWER_HEADER]: '1' },
    });
    let processed = 0;
    const runtime = (accept: () => unknown) =>
      ({
        webhooks: { accept },
        processWebhooks: () => processed++,
        stop: () => undefined,
      }) as unknown as UcpCheckoutRuntime;
    installUcpCheckoutRuntime(runtime(() => ({ status: 200, body: { ucp: { version: 'v-x' } } })));
    expect(await call('gateway')).toMatchObject({ status: 200, body: { ucp: { version: 'v-x' } } });
    expect(processed).toBe(1);
    installUcpCheckoutRuntime(
      runtime(() => {
        throw new Error('disk full');
      }),
    );
    const failed = await call('gateway');
    expect(failed.status).toBe(503);
    expect(failed.headers?.[A2A_CORE_ANSWER_HEADER]).toBeUndefined();
    installUcpCheckoutRuntime(null);
  });

  it('the OAuth callback door: the gateway’s alone; four short parameters reach the link service; its answer names only the merchant host', async () => {
    const call = (callerType: CoreRequest['callerType'], body: unknown) =>
      router.handle({
        method: 'POST',
        path: UCP_OAUTH_INGRESS_ROUTE,
        query: {},
        headers: {},
        body,
        rawBody: new Uint8Array(),
        params: {},
        trustedInProcess: true,
        callerType,
      } as CoreRequest);
    expect((await call('brain', {})).status).toBe(403);
    expect((await call('device', {})).status).toBe(403);
    installUcpCheckoutRuntime(null);
    expect(await call('gateway', { state: 's' })).toEqual({
      status: 200,
      body: { linked: false, reason: 'unavailable' },
      headers: { [A2A_CORE_ANSWER_HEADER]: '1' },
    });
    const given: unknown[] = [];
    let outcome: unknown = { ok: true, merchantOrigin: 'https://shop.example', scopes: ['x'] };
    installUcpCheckoutRuntime({
      links: {
        complete: async (p: unknown) => {
          given.push(p);
          return outcome;
        },
      },
      stop: () => undefined,
    } as unknown as UcpCheckoutRuntime);
    const linked = await call('gateway', {
      code: 'c',
      state: 's',
      iss: 'https://shop.example',
      error: 'e',
      extra: 'dropped',
      long: 'x'.repeat(5000),
    });
    expect(linked).toEqual({
      status: 200,
      body: { linked: true, merchant_host: 'shop.example' },
      headers: { [A2A_CORE_ANSWER_HEADER]: '1' },
    });
    expect(given).toEqual([{ code: 'c', state: 's', iss: 'https://shop.example', error: 'e' }]);
    await call('gateway', { code: 'x'.repeat(2049), state: 7, iss: null });
    expect(given[1]).toEqual({});
    outcome = { ok: false, reason: 'denied' };
    expect((await call('gateway', { state: 's' })).body).toEqual({
      linked: false,
      reason: 'denied',
    });
    installUcpCheckoutRuntime(null);
  });

  it('linked accounts (§3.17): the owner lists, starts, unlinks and hands in a callback; nothing about tokens leaves', async () => {
    const calls: unknown[][] = [];
    const link = {
      merchant_origin: SHOP,
      issuer: `${SHOP}/auth`,
      token_endpoint: `${SHOP}/auth/token`,
      revocation_endpoint: `${SHOP}/auth/revoke`,
      client_id: 'https://x.ucp.example/.well-known/ucp',
      scopes: ['dev.ucp.shopping.order:read'],
      state: 'active',
      generation: 3,
      access_expires_at: 1,
      refresh_holder: 'h#1',
      refresh_until: 2,
      created_at: 10,
      updated_at: 20,
    };
    let received: unknown = { ok: false, reason: 'held' };
    let started: unknown = {
      ok: true,
      opens: 'here',
      url: `${SHOP}/auth/authorize?x=1`,
      scopes: ['s'],
      expiresAt: 99,
    };
    installUcpCheckoutRuntime({
      links: {
        list: () => [link],
        wanted: () => [{ merchant_origin: 'https://rice.example', scopes: ['x:y'], at: 3 }],
        unrevoked: () => [{ merchant_origin: 'https://old.example', since: 4 }],
        failedAttempts: () => [
          { merchant_origin: 'https://bread.example', outcome: 'token_unreachable', at: 5 },
        ],
        dismissUnrevoked: (o: string) => {
          calls.push(['dismiss', o]);
          return true;
        },
        startForOwner: async (...a: unknown[]) => {
          calls.push(['start', ...a]);
          return started;
        },
        unlink: (o: string) => {
          calls.push(['unlink', o]);
          return true;
        },
        receive: async (p: unknown) => {
          calls.push(['receive', p]);
          return received;
        },
      },
      stop: () => undefined,
    } as unknown as UcpCheckoutRuntime);
    try {
      const listed = await ownerCall('GET', '/v1/owner/ucp/links');
      expect(listed.body).toEqual({
        links: [
          {
            merchant_origin: SHOP,
            merchant_host: 'tea-shop.example',
            scopes: ['dev.ucp.shopping.order:read'],
            state: 'active',
            linked_at: 10,
            updated_at: 20,
          },
        ],
        wanted: [
          {
            merchant_origin: 'https://rice.example',
            merchant_host: 'rice.example',
            scopes: ['x:y'],
            at: 3,
          },
        ],
        unrevoked: [
          { merchant_origin: 'https://old.example', merchant_host: 'old.example', since: 4 },
        ],
        failed: [
          {
            merchant_origin: 'https://bread.example',
            merchant_host: 'bread.example',
            outcome: 'token_unreachable',
            at: 5,
          },
        ],
      });
      expect(
        (
          await ownerCall('POST', '/v1/owner/ucp/links/dismiss', {
            merchant_origin: 'https://old.example',
          })
        ).body,
      ).toEqual({ dismissed: true });
      expect(
        (await ownerCall('POST', '/v1/owner/ucp/links/dismiss', { merchant_origin: 'old.example' }))
          .status,
      ).toBe(400);
      expect(
        (
          await ownerCall('POST', '/v1/owner/ucp/links/start', {
            merchant_origin: `${SHOP}/`,
            scopes: ['a', 'b'],
          })
        ).body,
      ).toEqual({
        started: true,
        opens: 'here',
        url: `${SHOP}/auth/authorize?x=1`,
        scopes: ['s'],
        expires_at: 99,
      });
      // A server behind NAT: the card that carried the page to the phone, never the page.
      started = { ok: true, opens: 'phone', cardId: 'ucp-link-1', scopes: ['s'], expiresAt: 99 };
      expect(
        (await ownerCall('POST', '/v1/owner/ucp/links/start', { merchant_origin: SHOP })).body,
      ).toEqual({
        started: true,
        opens: 'phone',
        card_id: 'ucp-link-1',
        scopes: ['s'],
        expires_at: 99,
      });
      started = { ok: false, reason: 'no_public_client' };
      expect(
        (await ownerCall('POST', '/v1/owner/ucp/links/start', { merchant_origin: SHOP })).body,
      ).toEqual({ started: false, reason: 'no_public_client' });
      for (const bad of [
        { merchant_origin: 'http://tea-shop.example' },
        { merchant_origin: `${SHOP}/path` },
        { merchant_origin: SHOP, scopes: 'a' },
        { merchant_origin: SHOP, scopes: Array.from({ length: 21 }, (_, i) => `s${i}`) },
        {},
      ])
        expect((await ownerCall('POST', '/v1/owner/ucp/links/start', bad)).status).toBe(400);
      expect(
        (await ownerCall('POST', '/v1/owner/ucp/links/unlink', { merchant_origin: SHOP })).body,
      ).toEqual({
        unlinked: true,
      });
      expect(
        (
          await ownerCall('POST', '/v1/owner/ucp/links/callback', {
            code: 'c',
            state: 's',
            other: 'x',
          })
        ).body,
      ).toEqual({ linked: false, held: true });
      received = { ok: true, merchantOrigin: SHOP, scopes: [] };
      expect(
        (await ownerCall('POST', '/v1/owner/ucp/links/callback', { state: 's' })).body,
      ).toEqual({
        linked: true,
        merchant_host: 'tea-shop.example',
      });
      received = { ok: false, reason: 'denied' };
      expect(
        (await ownerCall('POST', '/v1/owner/ucp/links/callback', { state: 's' })).body,
      ).toEqual({
        linked: false,
        reason: 'denied',
      });
      expect(calls).toEqual([
        ['dismiss', 'https://old.example'],
        ['start', SHOP, ['a', 'b']],
        ['start', SHOP, []],
        ['start', SHOP, []],
        ['unlink', SHOP],
        ['receive', { code: 'c', state: 's' }],
        ['receive', { state: 's' }],
        ['receive', { state: 's' }],
      ]);
      // Not the owner: refused, nothing called.
      const stranger = {
        callerType: 'device' as const,
        callerDID: 'did:key:z6MkStranger',
        ownerCapability: undefined,
      };
      for (const [m, p] of [
        ['GET', '/v1/owner/ucp/links'],
        ['POST', '/v1/owner/ucp/links/start'],
        ['POST', '/v1/owner/ucp/links/unlink'],
        ['POST', '/v1/owner/ucp/links/callback'],
        ['POST', '/v1/owner/ucp/links/dismiss'],
      ] as const)
        expect(
          (await ownerCall(m, p, { merchant_origin: SHOP, state: 's' }, stranger)).status,
        ).toBe(403);
      expect(calls).toHaveLength(8);
    } finally {
      installUcpCheckoutRuntime(null);
    }
  });

  it('held callbacks (§3.17): kept on a phone that runs no UCP itself; the owner’s paired node alone pulls and drops them, by the states it names', async () => {
    const S1 = 'a'.repeat(43);
    installUcpCheckoutRuntime(null);
    installUcpLinkStore(new UcpLinkStore(db));
    try {
      // No server paired with this phone: a callback for nothing is not kept.
      expect(
        (await ownerCall('POST', '/v1/owner/ucp/links/callback', { code: 'c', state: S1 })).body,
      ).toEqual({ linked: false, reason: 'unknown_state' });
      registerDevice(
        'server node',
        'z6MkServerNodeKey000000000000000000000000000',
        'agent',
        'node',
      );
      // The app caught a merchant's answer for the paired server; this phone has no UCP runtime.
      expect(
        (
          await ownerCall('POST', '/v1/owner/ucp/links/callback', {
            code: 'c',
            state: S1,
            iss: 'https://shop.example',
          })
        ).body,
      ).toEqual({ linked: false, held: true });
      const call = (p: string, b: unknown, who: Partial<CoreRequest>) =>
        router.handle({
          method: 'POST',
          path: p,
          query: {},
          headers: {},
          body: b,
          rawBody: new Uint8Array(),
          params: {},
          callerDID: 'did:key:z6MkServer',
          trustedInProcess: true,
          ...who,
        } as CoreRequest);
      const PULL = '/v1/agent/approval-sync/v1/oauth-callbacks/pull';
      const ACK = '/v1/agent/approval-sync/v1/oauth-callbacks/ack';
      const node = { callerType: 'agent' as const, agentScope: 'node' as const };
      for (const who of [
        { callerType: 'agent' as const },
        { callerType: 'agent' as const, agentScope: 'coding' as const },
        { callerType: 'device' as const },
        { callerType: 'brain' as const },
      ]) {
        expect((await call(PULL, { states: [S1] }, who)).status).toBe(403);
        expect((await call(ACK, { states: [S1] }, who)).status).toBe(403);
      }
      for (const bad of [
        {},
        { states: 's1' },
        { states: [1] },
        { states: Array.from({ length: 21 }, () => 's') },
      ])
        expect((await call(PULL, bad, node)).status).toBe(400);
      // Another state reads nothing; its own reads the callback whole.
      expect((await call(PULL, { states: ['b'.repeat(43)] }, node)).body).toEqual({
        callbacks: [],
      });
      expect((await call(PULL, { states: [S1] }, node)).body).toEqual({
        callbacks: [{ state: S1, params: { code: 'c', state: S1, iss: 'https://shop.example' } }],
      });
      expect((await call(ACK, { states: [S1] }, node)).body).toEqual({ dropped: 1 });
      expect((await call(PULL, { states: [S1] }, node)).body).toEqual({ callbacks: [] });
      // A node with no store at all: nothing kept, nothing to pull.
      installUcpLinkStore(null);
      expect((await ownerCall('POST', '/v1/owner/ucp/links/callback', { state: S1 })).status).toBe(
        503,
      );
      expect((await call(PULL, { states: [S1] }, node)).body).toEqual({ callbacks: [] });
    } finally {
      installUcpLinkStore(null);
      resetDeviceRegistry();
    }
  });

  it('a paired device that is not the owner is refused by the owner routes, and nothing changes', async () => {
    await ownerCall('PUT', '/v1/owner/ucp/settings', { merchants: [SHOP], context: {} });
    const asStranger = {
      callerType: 'device' as const,
      callerDID: 'did:key:z6MkStranger',
      ownerCapability: undefined,
    };
    expect((await ownerCall('GET', '/v1/owner/ucp/settings', {}, asStranger)).status).toBe(403);
    expect(
      (await ownerCall('PUT', '/v1/owner/ucp/settings', { merchants: [], context: {} }, asStranger))
        .status,
    ).toBe(403);
    expect(
      (await ownerCall('GET', '/v1/owner/ucp/searches/ucp-search-x', {}, asStranger)).status,
    ).toBe(403);
    // The owner's own paired device (its DID is the node's) may.
    expect(
      (
        await ownerCall(
          'GET',
          '/v1/owner/ucp/settings',
          {},
          { callerType: 'device', callerDID: 'did:plc:owner', ownerCapability: undefined },
        )
      ).body,
    ).toEqual({
      merchants: [SHOP],
      context: {},
      order_webhooks: true,
      order_webhook_url: null,
      searching: true,
    });
  });

  it('a choose_merchants refusal carries the owner’s allowed shops, for Brain to choose from', async () => {
    const eleven = Array.from(
      { length: 11 },
      (_, i) => `https://s${String(i).padStart(2, '0')}.example`,
    );
    const installed = getUcpSearchRuntime();
    if (installed === null) throw new Error('runtime');
    installUcpSearchRuntime({
      ...installed,
      workflow: () => workflow,
      settings: () => ({ merchants: eleven, context: {} }),
    });
    expect(await core.searchUcp({ releaseSession: SESSION, query: 'tea' })).toEqual({
      ok: false,
      status: 409,
      reason: 'choose_merchants',
      allowed: eleven,
    });
    // The review route answers the same, with the list, for a held search.
    expect(
      await core.raiseUcpSearchReview({
        releaseSession: SESSION,
        query: 'tea for +1 415 555 0134',
      }),
    ).toEqual({ ok: false, status: 409, reason: 'choose_merchants', allowed: eleven });
  });

  it('only Brain may call them: a paired device or agent is refused, here and by the server’s authorisation', async () => {
    const asDevice = await router.handle({
      method: 'POST',
      path: '/v1/ucp/search',
      query: {},
      headers: {},
      body: { release_session: SESSION, query: 'x', merchants: [SHOP] },
      rawBody: new Uint8Array(),
      params: {},
      // Past the signature check, as a paired device's call reaches the handler.
      trustedInProcess: true,
      callerType: 'device',
    } as CoreRequest);
    expect(asDevice.status).toBe(403);
    for (const [method, p] of [
      ['POST', '/v1/ucp/search'],
      ['POST', '/v1/ucp/search/review'],
      ['GET', '/v1/ucp/search/ucp-search-x'],
      ['POST', '/v1/ucp/guard/next'],
      ['POST', '/v1/ucp/guard/verdict'],
      ['POST', '/v1/ucp/products'],
    ] as const) {
      expect(isAuthorized('brain', method, p)).toBe(true);
      for (const other of ['device', 'agent', 'plugin', 'connector'] as const)
        expect(isAuthorized(other, method, p)).toBe(false);
    }
    expect(isAuthorized('brain', 'GET', '/v1/ucp/search/a/b')).toBe(false);
    // The owner's routes: the owner surface, an admin, a paired device (each checked in-handler as the owner); never Brain.
    for (const [method, p] of [
      ['GET', '/v1/owner/ucp/settings'],
      ['PUT', '/v1/owner/ucp/settings'],
      ['GET', '/v1/owner/ucp/searches/ucp-search-x'],
    ] as const) {
      for (const who of ['owner', 'admin', 'device'] as const)
        expect(isAuthorized(who, method, p)).toBe(true);
      for (const who of ['brain', 'agent', 'plugin'] as const)
        expect(isAuthorized(who, method, p)).toBe(false);
    }
  });
});
