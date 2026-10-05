/**
 * Search against the mock UCP merchant (UCP plan §3.19 step 2, U1.6): Core's
 * real merchant client, over the real Node policy socket and real TLS, to
 * merchants that hold it to what live merchants do: an MCP session begun
 * with `initialize`, the agent's profile on every call, REST paths with
 * `UCP-Agent`. The published schemas come from the recorded release, through
 * the same socket call, so the resolver's authority and path checks run.
 */

import { mockProduct, type MockProduct } from '../../../../test-harness/src/ucp_merchant/catalog';
import {
  startMockMerchant,
  type MockMerchant,
} from '../../../../test-harness/src/ucp_merchant/server';
import { A2AReleaseLog, installA2AReleaseLog } from '../../../src/a2a';
import { readConversationTaint } from '../../../src/chat/taint';
import { setUcpPolicySocket } from '../../../src/commerce/ucp/fetch';
import { installUcpIdentity } from '../../../src/commerce/ucp/identity';
import { UcpMerchantClient } from '../../../src/commerce/ucp/merchant_client';
import {
  fetchUcpProducts,
  ownerSearchView,
  searchView,
  startSearch,
  type SearchDeps,
} from '../../../src/commerce/ucp/search';
import { UcpSearchStore } from '../../../src/commerce/ucp/search_store';
import { InMemoryWorkflowRepository } from '../../../src/workflow/repository';
import { WorkflowService } from '../../../src/workflow/service';

import {
  CERT,
  IDENTITY,
  KEY,
  PROFILE_HOST,
  PROFILE_URL,
  fetchProfile,
  freshDatabase,
  testSocket,
} from './mock_harness';

const SESSION = 'chat:main';

const TEAS: MockProduct[] = [
  mockProduct({
    id: 'gid://shop/Product/1',
    title: 'Sencha green tea',
    description: 'Steamed Japanese green tea, loose leaf.',
    url: 'https://agent.test/products/sencha',
    variants: [
      { id: 'gid://shop/Variant/11', title: '100 g', price: 1250, available: true },
      {
        id: 'gid://shop/Variant/12',
        title: '250 g',
        price: 2800,
        listPrice: 3200,
        available: false,
      },
    ],
  }),
  mockProduct({
    id: 'gid://shop/Product/2',
    title: 'Earl Grey black tea',
    description: 'Black tea with bergamot.',
    price: 900,
  }),
];
const MATCHA: MockProduct[] = [
  mockProduct({
    id: 'm-1',
    title: 'Ceremonial matcha green tea',
    description: 'Stone-ground green tea.',
    price: 3400,
  }),
];

let database: ReturnType<typeof freshDatabase>;
let db: ReturnType<typeof freshDatabase>['db'];
let mcpShop: MockMerchant;
let restShop: MockMerchant;
/** Answers in server-sent events, Dina's profile read as the others read it. */
let sseShop: MockMerchant;
/** Cannot reach Dina's profile; then one that reads a malformed one. */
let blindShop: MockMerchant;
let pickyShop: MockMerchant;
let seen: string[];
let deps: SearchDeps;
let n = 0;

beforeAll(async () => {
  const shop = { cert: CERT, key: KEY };
  mcpShop = await startMockMerchant({
    ...shop,
    host: 'agent.test',
    products: () => TEAS,
    fetchProfile,
  });
  restShop = await startMockMerchant({
    ...shop,
    host: 'other.test',
    products: () => MATCHA,
    transports: ['rest'],
    fetchProfile,
  });
  sseShop = await startMockMerchant({
    ...shop,
    host: 'agent.test',
    products: () => MATCHA,
    fetchProfile,
    sse: true,
  });
  blindShop = await startMockMerchant({
    ...shop,
    host: 'other.test',
    products: () => TEAS,
    fetchProfile: async () => null,
  });
  pickyShop = await startMockMerchant({
    ...shop,
    host: 'agent.test',
    products: () => TEAS,
    transports: ['rest'],
    fetchProfile: async () => ({ status: 200, body: '{"not":"a profile"}' }),
  });
});

afterAll(async () => {
  for (const s of [mcpShop, restShop, sseShop, blindShop, pickyShop]) await s.close();
});

beforeEach(() => {
  database = freshDatabase('mock-merchant');
  db = database.db;
  const log = new A2AReleaseLog(db, Date.now, { chatLivesIn: 'brain' });
  installA2AReleaseLog(log);
  log.recordUtterance(SESSION, 't0', 'green tea please');
  seen = [];
  setUcpPolicySocket(testSocket(seen));
  const identity = IDENTITY;
  installUcpIdentity(identity);
  mcpShop.requests.length = 0;
  restShop.requests.length = 0;
  const workflow = new WorkflowService({ repository: new InMemoryWorkflowRepository() });
  deps = {
    store: new UcpSearchStore(db),
    client: new UcpMerchantClient({ identity: () => identity, profileHost: PROFILE_HOST }),
    check: { log, taint: (s) => readConversationTaint(db, log, s), nowMs: Date.now },
    settings: () => ({
      merchants: [mcpShop, restShop, sseShop, blindShop, pickyShop].map((m) => m.origin),
      context: { address_country: 'DE', language: 'de' },
    }),
    workflow,
    nowMs: Date.now,
    newId: () => `id${++n}`,
  };
});

afterEach(() => {
  setUcpPolicySocket(null);
  installUcpIdentity(null);
  installA2AReleaseLog(null);
  database.close();
});

describe('a search against the mock merchants, end to end', () => {
  it('searches both shops (MCP and REST) with the owner’s context and Dina’s profile; reads the answers', async () => {
    const started = await startSearch(
      { sessionId: SESSION, query: 'green tea', merchants: [mcpShop.origin, restShop.origin] },
      deps,
    );
    if (!started.ok) throw new Error(`search refused: ${started.reason}`);
    expect(started.merchants.map((m) => [m.origin, m.state, m.products])).toEqual([
      [mcpShop.origin, 'ok', 1],
      [restShop.origin, 'ok', 1],
    ]);
    // What each shop was sent: the query and the owner's context, Dina's profile URL as the agent.
    for (const [shop, transport] of [
      [mcpShop, 'mcp'],
      [restShop, 'rest'],
    ] as const) {
      expect(shop.requests).toEqual([
        expect.objectContaining({
          transport,
          operation: 'search_catalog',
          payload: expect.objectContaining({
            query: 'green tea',
            context: { address_country: 'DE', language: 'de' },
          }),
        }),
      ]);
      // The shop fetched exactly this URL and read Dina's real profile from it.
      expect(shop.requests[0]?.agent).toBe(PROFILE_URL);
    }
    // The published schemas were read through the same socket.
    expect(
      seen.some((u) =>
        u.startsWith('https://ucp.dev/2026-08-25/schemas/shopping/catalog_search.json'),
      ),
    ).toBe(true);

    const view = searchView(deps.store, started.searchId, SESSION, Date.now());
    const sencha = view?.products.find((p) => p.product.merchant === started.merchants[0]?.handle);
    expect(sencha?.product.price_range).toEqual({
      min: { amount: '1250', currency: 'EUR' },
      max: { amount: '2800', currency: 'EUR' },
    });
    expect(sencha?.product.variants.map((v) => [v.price.amount, v.available])).toEqual([
      ['1250', true],
      ['2800', false],
    ]);
    // Brain sees no merchant id or page; the owner sees the shop's own title and page.
    expect(JSON.stringify(view)).not.toMatch(/gid:\/\/|agent\.test\/products/);
    const owner = ownerSearchView(deps.store, started.searchId);
    expect(owner?.products.map((p) => [p.title, p.url ?? null])).toEqual([
      ['Sencha green tea', 'https://agent.test/products/sencha'],
      ['Ceremonial matcha green tea', null],
    ]);
  });

  it('fetches products afresh by handle: one with get_product, and a vanished one is reported missing', async () => {
    const started = await startSearch(
      { sessionId: SESSION, query: 'tea', merchants: [mcpShop.origin] },
      deps,
    );
    if (!started.ok) throw new Error(`search refused: ${started.reason}`);
    const handles = searchView(deps.store, started.searchId, SESSION, Date.now())?.products.map(
      (p) => p.product.handle,
    );
    expect(handles).toEqual(['p1', 'p2']);
    const fetched = await fetchUcpProducts({ sessionId: SESSION, products: ['p2'] }, deps);
    if (!fetched.ok) throw new Error(`fetch refused: ${fetched.reason}`);
    expect(fetched.missing).toEqual([]);
    expect(mcpShop.requests.at(-1)).toMatchObject({
      operation: 'get_product',
      payload: expect.objectContaining({ id: 'gid://shop/Product/2' }),
    });
    // Two products from one shop; one of them gone from the shop.
    const gone = TEAS.splice(1, 1);
    try {
      const both = await fetchUcpProducts({ sessionId: SESSION, products: ['p1', 'p2'] }, deps);
      if (!both.ok) throw new Error(`fetch refused: ${both.reason}`);
      // One get_product each, so each product comes back whole.
      expect(mcpShop.requests.slice(-2).map((r) => r.operation)).toEqual([
        'get_product',
        'get_product',
      ]);
      expect(both.missing).toEqual(['p2']);
      expect(both.merchants).toEqual([
        expect.objectContaining({ origin: mcpShop.origin, products: 1 }),
      ]);
    } finally {
      TEAS.splice(1, 0, ...gone);
    }
  });

  it('a session the shop ended is begun again, and the refused request resent byte for byte', async () => {
    const first = await startSearch(
      { sessionId: SESSION, query: 'tea', merchants: [mcpShop.origin] },
      deps,
    );
    expect(first.ok).toBe(true);
    mcpShop.endSessions();
    const before = mcpShop.mcpLog.length;
    const second = await startSearch(
      { sessionId: SESSION, query: 'black tea', merchants: [mcpShop.origin] },
      deps,
    );
    if (!second.ok) throw new Error(`search refused: ${second.reason}`);
    expect(second.merchants[0]).toMatchObject({ state: 'ok', products: 1 });
    // The old session's call refused (404), a new session begun, then the same bytes again.
    const after = mcpShop.mcpLog.slice(before);
    expect(after.map((e) => [e.method, e.status])).toEqual([
      ['tools/call', 404],
      ['initialize', 200],
      ['notifications/initialized', 202],
      ['tools/call', 200],
    ]);
    expect(after[3]?.rawBody).toBe(after[0]?.rawBody);
    expect(after[3]?.session).not.toBe(after[0]?.session);
  });

  it('a shop that answers in server-sent events, split across writes, is read', async () => {
    const r = await startSearch(
      { sessionId: SESSION, query: 'matcha', merchants: [sseShop.origin] },
      deps,
    );
    if (!r.ok) throw new Error(`search refused: ${r.reason}`);
    expect(r.merchants[0]).toMatchObject({ state: 'ok', products: 1 });
  });

  it('a shop that signs its answers: verified against the key its profile lists; one signed with a key it does not list is not used', async () => {
    const shop = { cert: CERT, key: KEY, host: 'agent.test', products: () => TEAS, fetchProfile };
    const signing = await startMockMerchant({ ...shop, signAnswers: 'listed' });
    const lagging = await startMockMerchant({ ...shop, signAnswers: 'unlisted' });
    try {
      const both = {
        ...deps,
        settings: () => ({ merchants: [signing.origin, lagging.origin], context: {} }),
      };
      const r = await startSearch(
        { sessionId: SESSION, query: 'tea', merchants: [signing.origin, lagging.origin] },
        both,
      );
      if (!r.ok) throw new Error(`search refused: ${r.reason}`);
      expect(new Map(r.merchants.map((m) => [m.origin, [m.state, m.products]]))).toEqual(
        new Map([
          [signing.origin, ['ok', 2]],
          [lagging.origin, ['answer_invalid', 0]],
        ]),
      );
    } finally {
      await signing.close();
      await lagging.close();
    }
  });

  it('a key the shop’s profile does not list: its profile is read again at most once a minute, never on every answer', async () => {
    const lagging = await startMockMerchant({
      cert: CERT,
      key: KEY,
      host: 'agent.test',
      products: () => TEAS,
      fetchProfile,
      signAnswers: 'unlisted',
    });
    let now = Date.now();
    const one = {
      ...deps,
      client: new UcpMerchantClient({
        identity: () => IDENTITY,
        profileHost: PROFILE_HOST,
        now: () => now,
      }),
      settings: () => ({ merchants: [lagging.origin], context: {} }),
    };
    const profileReads = () => seen.filter((u) => u === `${lagging.origin}/.well-known/ucp`).length;
    const search = async () => {
      const r = await startSearch(
        { sessionId: SESSION, query: 'tea', merchants: [lagging.origin] },
        one,
      );
      if (!r.ok) throw new Error(`search refused: ${r.reason}`);
      return r.merchants[0]?.state;
    };
    try {
      expect(await search()).toBe('answer_invalid');
      // Discovery, then one forced read for the key it did not list.
      expect(profileReads()).toBe(2);
      expect(await search()).toBe('answer_invalid');
      expect(profileReads()).toBe(2);
      now += 61_000;
      expect(await search()).toBe('answer_invalid');
      expect(profileReads()).toBe(3);
    } finally {
      await lagging.close();
    }
  });

  it('a shop that cannot read Dina’s profile, or reads a malformed one, says so: profile_rejected, not a shop failure', async () => {
    const r = await startSearch(
      { sessionId: SESSION, query: 'tea', merchants: [blindShop.origin, pickyShop.origin] },
      deps,
    );
    if (!r.ok) throw new Error(`search refused: ${r.reason}`);
    expect(new Map(r.merchants.map((m) => [m.origin, m.state]))).toEqual(
      new Map([
        [blindShop.origin, 'profile_rejected'],
        [pickyShop.origin, 'profile_rejected'],
      ]),
    );
  });

  it('a fetch of two products brings each back whole (get_product), not one featured variant each', async () => {
    const started = await startSearch(
      { sessionId: SESSION, query: 'tea', merchants: [mcpShop.origin] },
      deps,
    );
    if (!started.ok) throw new Error(`search refused: ${started.reason}`);
    const fetched = await fetchUcpProducts({ sessionId: SESSION, products: ['p1', 'p2'] }, deps);
    if (!fetched.ok) throw new Error(`fetch refused: ${fetched.reason}`);
    const sencha = searchView(deps.store, fetched.searchId, SESSION, Date.now())?.products[0];
    expect(sencha?.product.variants).toHaveLength(2);
  });
});

describe('the mock holds a client to what live merchants do', () => {
  const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await testSocket([])({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', ...headers },
      body: new TextEncoder().encode(JSON.stringify(body)),
      accept: 'json',
      minTls: 'TLSv1.2',
      readAuthErrorBodies: true,
      maxResponseBytes: 1 << 20,
      timeoutMs: 5_000,
    });
    if (!r.ok) throw new Error(r.error);
    return {
      status: r.status,
      body: JSON.parse(new TextDecoder().decode(r.bodyBytes) || 'null') as Record<string, unknown>,
      session: r.rawHeaders.find(([k]) => k === 'mcp-session-id')?.[1],
    };
  };
  const call = (name: string, args: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  it('MCP: a call before initialize is refused; a call without the agent profile is an error', async () => {
    const mcp = `${mcpShop.origin}/ucp/mcp`;
    expect((await post(mcp, call('search_catalog', { catalog: { query: 'tea' } }))).status).toBe(
      400,
    );
    const init = await post(mcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(init.session).toBeDefined();
    // Without the agent profile: the spec's invalid_profile_url, HTTP 400 beside JSON-RPC -32001.
    const noAgent = await post(mcp, call('search_catalog', { catalog: { query: 'tea' } }), {
      'mcp-session-id': init.session as string,
    });
    expect(noAgent.status).toBe(400);
    expect(noAgent.body.error).toMatchObject({
      code: -32001,
      data: { code: 'invalid_profile_url' },
    });
  });

  it('REST: a call without UCP-Agent is 400 invalid_profile_url', async () => {
    const r = await post(`${restShop.origin}/ucp/rest/catalog/search`, { query: 'tea' });
    expect([r.status, r.body.code]).toEqual([400, 'invalid_profile_url']);
  });
});
