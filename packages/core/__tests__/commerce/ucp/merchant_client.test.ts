/**
 * The merchant client end to end over a fake merchant: its profile, the
 * published release schemas, and an MCP server answering with the spec's own
 * examples. Validation before sending and after answering; operations the
 * merchant cannot serve never sent; business errors read before resources.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { CAP, UCP_VERSION } from '@dina/ucp';

import { SPEC_EXAMPLES } from '../../../../ucp/__tests__/spec_fixture';
import { UcpDiscovery } from '../../../src/commerce/ucp/discovery';
import { deriveUcpIdentity, type UcpIdentity } from '../../../src/commerce/ucp/identity';
import { UcpMerchantClient } from '../../../src/commerce/ucp/merchant_client';
import { RELEASE_SCHEMAS, SchemaResolver } from '../../../src/commerce/ucp/schemas';
import { UcpTransport } from '../../../src/commerce/ucp/transport';

import type { UcpFetchResult } from '../../../src/commerce/ucp/fetch';
import type { PolicySocketRequest } from '@dina/net-policy';

const DIR = join(__dirname, '../../../../ucp/__tests__/fixtures/schemas/2026-08-25');
const RELEASE: Record<string, string> = {};
(function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else RELEASE[RELEASE_SCHEMAS + relative(DIR, path)] = readFileSync(path, 'utf8');
  }
})(DIR);

const ORIGIN = 'https://shop.example';
const MCP = 'https://shop.example/ucp/mcp';
const capability = (name: string, path: string) => ({
  [name]: [{ version: UCP_VERSION, schema: RELEASE_SCHEMAS + path }],
});
const PROFILE = {
  ucp: {
    version: UCP_VERSION,
    services: { 'dev.ucp.shopping': [{ version: UCP_VERSION, transport: 'mcp', endpoint: MCP }] },
    capabilities: {
      ...capability(CAP.catalogSearch, 'shopping/catalog_search.json'),
      ...capability(CAP.catalogLookup, 'shopping/catalog_lookup.json'),
      ...capability(CAP.order, 'shopping/order.json'),
    },
    payment_handlers: {},
  },
};
const SEARCH_ANSWER = SPEC_EXAMPLES.find(
  (e) => e.source === 'scaffolds/shopping_catalog_search_response.json',
)?.value;

function merchant(toolAnswer: () => unknown = () => SEARCH_ANSWER) {
  const calls: { method: string; name?: string; profile?: string }[] = [];
  const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
    const reply = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ): UcpFetchResult => ({
      ok: true,
      status,
      bodyBytes: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
      headers: { 'content-type': 'application/json', ...headers },
      connectedAddress: '203.0.114.7',
    });
    if (r.url === `${ORIGIN}/.well-known/ucp`) return reply(200, PROFILE);
    if (RELEASE[r.url] !== undefined) return reply(200, RELEASE[r.url]);
    if (r.url !== MCP) return reply(404, {});
    const msg = JSON.parse(new TextDecoder().decode(r.body ?? new Uint8Array()));
    calls.push({
      method: msg.method,
      ...(msg.params?.name !== undefined ? { name: msg.params.name } : {}),
      ...(msg.params?.arguments?.meta !== undefined
        ? { profile: msg.params.arguments.meta['ucp-agent'].profile }
        : {}),
    });
    if (msg.method === 'initialize')
      return reply(
        200,
        { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25' } },
        { 'mcp-session-id': 's1' },
      );
    if (msg.method === 'notifications/initialized') return reply(202, '');
    return reply(200, { jsonrpc: '2.0', id: msg.id, result: { structuredContent: toolAnswer() } });
  };
  return { fetch, calls };
}

const SEED = new Uint8Array(32).fill(5);
let installed: UcpIdentity | null;
beforeEach(() => {
  installed = deriveUcpIdentity(SEED, 0);
});

function client(m: ReturnType<typeof merchant>, now = () => 0) {
  return new UcpMerchantClient({
    discovery: new UcpDiscovery({ fetch: m.fetch, now }),
    resolver: new SchemaResolver({ fetch: m.fetch, now }),
    transport: new UcpTransport({ fetch: m.fetch }),
    identity: () => installed,
    profileHost: 'ucp.test.example',
    now,
  });
}

async function connect(m: ReturnType<typeof merchant>) {
  const opened = await client(m).open(ORIGIN);
  if (!opened.ok) throw new Error(`open: ${opened.reason}`);
  return opened.connection;
}

describe('the merchant client', () => {
  it('is not ready while its identity knows no signing key (a restored node before it read the host; U7)', () => {
    const m = merchant();
    installed = deriveUcpIdentity(SEED);
    const c = client(m);
    expect(c.ready()).toBe(false);
    installed.useGeneration(0);
    expect(c.ready()).toBe(true);
    installed.forgetGeneration();
    expect(c.ready()).toBe(false);
    installed = null;
    expect(c.ready()).toBe(false);
    expect(m.calls).toEqual([]);
  });

  it('opens a merchant: its status names what Dina can use', async () => {
    const c = await connect(merchant());
    expect(c.status()).toEqual({
      origin: ORIGIN,
      transport: 'mcp',
      active: [CAP.catalogLookup, CAP.catalogSearch, CAP.order].sort(),
      droppedEntries: [],
      droppedSchemas: [],
    });
  });

  it('a search is validated, sent with Dina’s profile URL, and its answer validated', async () => {
    const m = merchant();
    const c = await connect(m);
    const r = await c.call('search_catalog', { payload: { query: 'green tea' } });
    expect(r).toMatchObject({ ok: true, value: { products: expect.any(Array) } });
    const sent = m.calls.filter((x) => x.method === 'tools/call');
    expect(sent.map((x) => x.name)).toEqual(['search_catalog']);
    expect(sent[0]?.profile).toBe(
      `https://${(installed as UcpIdentity).label}.ucp.test.example/.well-known/ucp`,
    );
  });

  it('an invalid payload is never sent', async () => {
    const m = merchant();
    const c = await connect(m);
    const r = await c.call('search_catalog', { payload: { query: 7 } as never });
    expect(r).toMatchObject({ ok: false, kind: 'not_sent', reason: 'request_invalid' });
    expect(m.calls.filter((x) => x.method === 'tools/call')).toEqual([]);
  });

  it('an operation the merchant does not offer is never sent', async () => {
    const m = merchant();
    const c = await connect(m);
    expect(
      await c.call('create_cart', { payload: { line_items: [] }, idempotencyKey: 'k' }),
    ).toEqual({
      ok: false,
      kind: 'not_sent',
      reason: 'unavailable',
    });
    expect(m.calls).toEqual([]);
  });

  it('with no UCP identity (a sealed phone) nothing is sent', async () => {
    const m = merchant();
    const c = await connect(m);
    installed = null;
    expect(await c.call('search_catalog', { payload: { query: 'x' } })).toEqual({
      ok: false,
      kind: 'not_sent',
      reason: 'no_identity',
    });
    expect(m.calls).toEqual([]);
  });

  it('an answer that fails its schema is not used', async () => {
    const m = merchant(() => ({ ...(SEARCH_ANSWER as object), products: 'none today' }));
    const c = await connect(m);
    expect(await c.call('search_catalog', { payload: { query: 'x' } })).toMatchObject({
      ok: false,
      kind: 'answer_invalid',
    });
  });

  it('a business error is read before any resource field', async () => {
    const m = merchant(() => ({
      ucp: { version: UCP_VERSION, status: 'error' },
      messages: [
        { type: 'error', code: 'out_of_stock', content: 'Gone', severity: 'unrecoverable' },
      ],
    }));
    const c = await connect(m);
    const r = await c.call('search_catalog', { payload: { query: 'x' } });
    expect(r).toMatchObject({ ok: false, kind: 'error_response' });
  });

  it('reuses an opened merchant for a minute; a failed opening is not reused', async () => {
    const m = merchant();
    let now = 0;
    const cl = client(m, () => now);
    const [a, b] = await Promise.all([cl.open(ORIGIN), cl.open(ORIGIN)]);
    expect(a).toBe(b);
    now = 61_000;
    expect(await cl.open(ORIGIN)).not.toBe(a);
    const failing = client(merchant(), () => 0);
    const bad = await failing.open('https://nowhere.example');
    expect(bad).toEqual({ ok: false, reason: 'not_found' });
    expect(await failing.open('https://nowhere.example')).not.toBe(bad);
  });

  it('one entry per merchant however its origin is spelled; an older failed opening never evicts a newer one', async () => {
    const m = merchant();
    let now = 0;
    const cl = client(m, () => now);
    const a = cl.open('https://shop.example/');
    expect(cl.open('https://SHOP.example')).toBe(a);
    // A first opening that fails late, after a second, successful one has replaced it.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const slow = new UcpMerchantClient({
      discovery: {
        discover: async (o: string) => {
          if (first) {
            first = false;
            await gate;
            return { ok: false, reason: 'unreachable' } as const;
          }
          return new UcpDiscovery({ fetch: m.fetch, now: () => now }).discover(o);
        },
      } as unknown as UcpDiscovery,
      resolver: new SchemaResolver({ fetch: m.fetch, now: () => now }),
      transport: new UcpTransport({ fetch: m.fetch }),
      identity: () => installed,
      profileHost: 'ucp.test.example',
      now: () => now,
    });
    const failing = slow.open(ORIGIN);
    now = 61_000;
    const second = slow.open(ORIGIN);
    expect((await second).ok).toBe(true);
    release();
    expect((await failing).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(slow.open(ORIGIN)).toBe(second);
  });
});
