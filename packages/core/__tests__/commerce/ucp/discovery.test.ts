/**
 * Discovering a merchant (UCP plan §3.6 steps 1–5), from the spec's own
 * business profiles: origins, the version (through a leaf), filtering,
 * intersection, transport choice, failures, the cache.
 */
import { UCP_VERSION } from '@dina/ucp';

import { SPEC_EXAMPLES } from '../../../../ucp/__tests__/spec_fixture';
import { merchantOrigin, UcpDiscovery } from '../../../src/commerce/ucp/discovery';

import type { UcpFetchResult } from '../../../src/commerce/ucp/fetch';
import type { PolicySocketRequest } from '@dina/net-policy';

const example = (source: string) => {
  const e = SPEC_EXAMPLES.find((x) => x.source === source);
  if (e === undefined) throw new Error(source);
  return structuredClone(e.value) as { ucp: Record<string, unknown> };
};
const MCP_PROFILE = example('shopping/checkout/mcp.md:30');
const REST_PROFILE = example('shopping/checkout/rest.md:30');

/** A web of documents by URL; anything else is a 404. */
function web(docs: Record<string, unknown>, headers: Record<string, string> = {}) {
  const seen: string[] = [];
  const fetch = async (r: PolicySocketRequest): Promise<UcpFetchResult> => {
    seen.push(r.url);
    const doc = docs[r.url];
    if (doc === 'down') return { ok: false, error: 'connect_failed', sent: false };
    const bytes =
      doc instanceof Uint8Array
        ? doc
        : new TextEncoder().encode(
            doc === undefined ? '{}' : typeof doc === 'string' ? doc : JSON.stringify(doc),
          );
    return {
      ok: true,
      status: doc === undefined ? 404 : 200,
      bodyBytes: bytes,
      headers: { 'content-type': 'application/json', ...headers },
      connectedAddress: '203.0.114.7',
    };
  };
  return { seen, fetch };
}

const AT = 'https://shop.example/.well-known/ucp';

describe('origins', () => {
  it('takes an https origin and nothing more', () => {
    expect(merchantOrigin('https://Shop.Example')).toBe('https://shop.example');
    expect(merchantOrigin('https://shop.example:8443/')).toBe('https://shop.example:8443');
    for (const bad of [
      'http://shop.example',
      'https://shop.example/store',
      'https://shop.example/?q=1',
      'https://shop.example/#x',
      'https://user@shop.example',
      'shop.example',
      'not a url',
    ])
      expect(merchantOrigin(bad)).toBeNull();
  });
});

describe('discovery', () => {
  it('reads the spec MCP profile: MCP endpoint, checkout and fulfillment negotiated', async () => {
    const w = web({ [AT]: MCP_PROFILE });
    const d = await new UcpDiscovery({ fetch: w.fetch }).discover('https://shop.example');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.merchant).toMatchObject({
      origin: 'https://shop.example',
      profileUrl: AT,
      transport: 'mcp',
      endpoint: 'https://business.example.com/ucp/mcp',
      stale: false,
    });
    expect([...d.merchant.negotiated.keys()].sort()).toEqual([
      'dev.ucp.shopping.checkout',
      'dev.ucp.shopping.fulfillment',
    ]);
  });

  it('chooses MCP when both transports are offered, REST when only REST is', async () => {
    const both = structuredClone(MCP_PROFILE);
    const services = both.ucp.services as Record<string, unknown[]>;
    const rest = (REST_PROFILE.ucp.services as Record<string, unknown[]>)['dev.ucp.shopping'] ?? [];
    services['dev.ucp.shopping'] = [...rest, ...(services['dev.ucp.shopping'] ?? [])];
    const a = await new UcpDiscovery({ fetch: web({ [AT]: both }).fetch }).discover(
      'https://shop.example',
    );
    expect(a.ok && a.merchant.transport).toBe('mcp');
    const b = await new UcpDiscovery({ fetch: web({ [AT]: REST_PROFILE }).fetch }).discover(
      'https://shop.example',
    );
    expect(b.ok && [b.merchant.transport, b.merchant.endpoint]).toEqual([
      'rest',
      'https://business.example.com/ucp/v1',
    ]);
  });

  it('negotiates through the leaf when the merchant is on a newer version, and refuses a leaf that is not ours', async () => {
    const leafUrl = 'https://shop.example/.well-known/ucp/2026-08-25';
    const top = structuredClone(MCP_PROFILE);
    top.ucp.version = '2027-01-01';
    top.ucp.supported_versions = { [UCP_VERSION]: leafUrl };
    const good = await new UcpDiscovery({
      fetch: web({ [AT]: top, [leafUrl]: MCP_PROFILE }).fetch,
    }).discover('https://shop.example');
    expect(good.ok && good.merchant.profileUrl).toBe(leafUrl);
    const wrongLeaf = structuredClone(MCP_PROFILE);
    wrongLeaf.ucp.version = '2027-01-01';
    const bad = await new UcpDiscovery({
      fetch: web({ [AT]: top, [leafUrl]: wrongLeaf }).fetch,
    }).discover('https://shop.example');
    expect(bad).toMatchObject({
      ok: false,
      reason: 'leaf_unusable',
      detail: 'leaf_version_mismatch',
    });
    const missing = await new UcpDiscovery({ fetch: web({ [AT]: top }).fetch }).discover(
      'https://shop.example',
    );
    expect(missing).toMatchObject({ ok: false, reason: 'leaf_unusable', detail: 'not_found' });
  });

  it('no shared version: no UCP calls, and the versions offered are named', async () => {
    const top = structuredClone(MCP_PROFILE);
    top.ucp.version = '2027-01-01';
    const d = await new UcpDiscovery({ fetch: web({ [AT]: top }).fetch }).discover(
      'https://shop.example',
    );
    expect(d).toEqual({ ok: false, reason: 'no_shared_version', detail: '2027-01-01' });
  });

  it('an entry failing authority binding is dropped and reported; a profile with no usable endpoint is refused', async () => {
    const p = structuredClone(MCP_PROFILE);
    const entry = (p.ucp.capabilities as Record<string, { schema: string }[]>)[
      'dev.ucp.shopping.fulfillment'
    ]?.[0];
    if (entry === undefined) throw new Error('fixture');
    entry.schema = 'https://evil.example/fulfillment.json';
    const d = await new UcpDiscovery({ fetch: web({ [AT]: p }).fetch }).discover(
      'https://shop.example',
    );
    expect(d.ok && d.merchant.dropped).toEqual([
      { name: 'dev.ucp.shopping.fulfillment', reason: 'authority' },
    ]);
    expect(d.ok && [...d.merchant.negotiated.keys()]).toEqual(['dev.ucp.shopping.checkout']);
    const noEndpoint = structuredClone(MCP_PROFILE);
    noEndpoint.ucp.services = {};
    expect(
      await new UcpDiscovery({ fetch: web({ [AT]: noEndpoint }).fetch }).discover(
        'https://shop.example',
      ),
    ).toEqual({
      ok: false,
      reason: 'no_endpoint',
    });
  });

  it('failures: no profile, unreachable, malformed, duplicate keys, not UTF-8, a bad origin', async () => {
    const run = (docs: Record<string, unknown>, origin = 'https://shop.example') =>
      new UcpDiscovery({ fetch: web(docs).fetch }).discover(origin);
    expect(await run({})).toEqual({ ok: false, reason: 'not_found' });
    expect(await run({ [AT]: 'down' })).toEqual({ ok: false, reason: 'unreachable' });
    expect(await run({ [AT]: '{"ucp":' })).toMatchObject({
      ok: false,
      reason: 'profile_malformed',
      detail: 'json',
    });
    expect(await run({ [AT]: '{"ucp":{},"ucp":{}}' })).toMatchObject({
      ok: false,
      reason: 'profile_malformed',
      detail: 'json',
    });
    expect(await run({ [AT]: { not_ucp: 1 } })).toMatchObject({
      ok: false,
      reason: 'profile_malformed',
    });
    expect(await run({ [AT]: new Uint8Array([0x7b, 0xff, 0x7d]) })).toMatchObject({
      ok: false,
      reason: 'profile_malformed',
      detail: 'utf8',
    });
    expect(await run({}, 'http://shop.example')).toEqual({ ok: false, reason: 'bad_origin' });
  });

  it('caches the profile: a second discovery within its freshness fetches nothing', async () => {
    const w = web({ [AT]: MCP_PROFILE }, { 'cache-control': 'max-age=300' });
    const discovery = new UcpDiscovery({ fetch: w.fetch, now: () => 0 });
    await discovery.discover('https://shop.example');
    await discovery.discover('https://shop.example/');
    expect(w.seen).toEqual([AT]);
  });
});
