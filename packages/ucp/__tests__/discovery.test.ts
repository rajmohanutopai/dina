/**
 * Discovering a merchant (UCP plan §3.6), the rules Core and AppView's
 * merchant index share: the origin, the profile document read strictly, the
 * version through a leaf, and the transport, with every refusal named.
 */

import {
  discoverMerchant,
  merchantOrigin,
  merchantProfileUrl,
  readProfileDocument,
  type ProfileRead,
} from '../src/discovery';
import { parseMerchantProfile } from '../src/profile';

const V = '2026-08-25';
const s = (p: string) => `https://ucp.dev/${V}/schemas/shopping/${p}.json`;

function profile(over: Record<string, unknown> = {}, services?: unknown): unknown {
  return {
    ucp: {
      version: V,
      services: services ?? {
        'dev.ucp.shopping': [
          {
            version: V,
            transport: 'rest',
            endpoint: 'https://shop.example/ucp/rest',
            schema: `https://ucp.dev/${V}/services/shopping/rest.openapi.json`,
          },
          {
            version: V,
            transport: 'mcp',
            endpoint: 'https://shop.example/ucp/mcp',
            schema: `https://ucp.dev/${V}/services/shopping/mcp.openrpc.json`,
          },
        ],
      },
      capabilities: {
        'dev.ucp.shopping.checkout': [{ version: V, schema: s('checkout') }],
        'dev.ucp.shopping.catalog.search': [{ version: V, schema: s('catalog_search') }],
      },
      payment_handlers: { 'com.google.pay': [{ id: 'g', version: '2026-01-11' }] },
      ...over,
    },
  };
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** A `read` over fixed documents; anything else is a 404. */
function reader(docs: Record<string, unknown>): {
  read: (url: string) => Promise<ProfileRead>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    read: async (url) => {
      asked.push(url);
      if (!(url in docs)) return { ok: false, reason: 'not_found' };
      const r = readProfileDocument(bytes(docs[url]));
      return r.ok ? { ok: true, profile: r.profile, stale: false } : r;
    },
  };
}

describe('the merchant’s identity is its origin', () => {
  it.each([
    ['https://Shop.Example', 'https://shop.example'],
    ['https://shop.example/', 'https://shop.example'],
    ['https://shop.example:8443', 'https://shop.example:8443'],
  ])('%s → %s', (input, origin) => expect(merchantOrigin(input)).toBe(origin));

  it.each([
    'http://shop.example',
    'https://user:pw@shop.example',
    'https://shop.example/path',
    'https://shop.example/?q=1',
    'https://shop.example/#x',
    'not a url',
    // Not a public DNS name (simulator finding: "https://tea-shop" was accepted).
    'https://tea-shop',
    'https://localhost',
    'https://shop.example.',
    'https://127.0.0.1',
    'https://203.0.113.9',
    'https://[2001:db8::1]',
  ])('refuses %s', (input) => expect(merchantOrigin(input)).toBeNull());

  it('its profile is at /.well-known/ucp', () => {
    expect(merchantProfileUrl('https://shop.example')).toBe('https://shop.example/.well-known/ucp');
  });
});

describe('a profile document is read strictly', () => {
  it('refuses bytes that are not UTF-8, JSON that is not strict, and a document that is not a profile', () => {
    expect(readProfileDocument(new Uint8Array([0xff, 0xfe]))).toEqual({
      ok: false,
      reason: 'profile_malformed',
      detail: 'utf8',
    });
    expect(readProfileDocument(new TextEncoder().encode('{"ucp":1,"ucp":2}'))).toEqual({
      ok: false,
      reason: 'profile_malformed',
      detail: 'json',
    });
    expect(readProfileDocument(bytes({}))).toEqual({
      ok: false,
      reason: 'profile_malformed',
      detail: 'no_ucp_object',
    });
  });
});

describe('discoverMerchant', () => {
  it('a profile in Dina’s version: MCP over REST, its endpoint, the capabilities both use', async () => {
    const { read, asked } = reader({ 'https://shop.example/.well-known/ucp': profile() });
    const out = await discoverMerchant('https://shop.example', read);
    if (!out.ok) throw new Error(out.reason);
    expect(out.merchant).toMatchObject({
      origin: 'https://shop.example',
      profileUrl: 'https://shop.example/.well-known/ucp',
      transport: 'mcp',
      endpoint: 'https://shop.example/ucp/mcp',
      stale: false,
    });
    expect([...out.merchant.negotiated.keys()].sort()).toEqual([
      'dev.ucp.shopping.catalog.search',
      'dev.ucp.shopping.checkout',
    ]);
    expect(asked).toEqual(['https://shop.example/.well-known/ucp']);
  });

  it('REST only: REST', async () => {
    const rest = {
      'dev.ucp.shopping': [
        {
          version: V,
          transport: 'rest',
          endpoint: 'https://shop.example/ucp/rest',
          schema: `https://ucp.dev/${V}/services/shopping/rest.openapi.json`,
        },
      ],
    };
    const { read } = reader({ 'https://shop.example/.well-known/ucp': profile({}, rest) });
    const out = await discoverMerchant('https://shop.example', read);
    expect(out).toMatchObject({ ok: true, merchant: { transport: 'rest' } });
  });

  it('another current version: Dina’s through the merchant’s leaf, the root kept for its identity', async () => {
    const leafUrl = 'https://shop.example/.well-known/ucp/2026-08-25';
    const root = profile({ version: '2027-01-01', supported_versions: { [V]: leafUrl } });
    const { read, asked } = reader({
      'https://shop.example/.well-known/ucp': root,
      [leafUrl]: profile(),
    });
    const out = await discoverMerchant('https://shop.example', read);
    if (!out.ok) throw new Error(out.reason);
    expect(out.merchant.profileUrl).toBe(leafUrl);
    expect(out.merchant.rootProfile.version).toBe('2027-01-01');
    expect(asked).toEqual(['https://shop.example/.well-known/ucp', leafUrl]);
  });

  it.each([
    ['not an origin', 'https://shop.example/x', {}, { ok: false, reason: 'bad_origin' }],
    ['no profile', 'https://shop.example', {}, { ok: false, reason: 'not_found' }],
    [
      'no version both speak',
      'https://shop.example',
      { 'https://shop.example/.well-known/ucp': profile({ version: '2027-01-01' }) },
      { ok: false, reason: 'no_shared_version', detail: '2027-01-01' },
    ],
    [
      'a leaf that is not there',
      'https://shop.example',
      {
        'https://shop.example/.well-known/ucp': profile({
          version: '2027-01-01',
          supported_versions: { [V]: 'https://shop.example/leaf' },
        }),
      },
      { ok: false, reason: 'leaf_unusable', detail: 'not_found' },
    ],
    [
      'no endpoint Dina can use',
      'https://shop.example',
      {
        'https://shop.example/.well-known/ucp': profile(
          {},
          {
            'dev.ucp.shopping': [
              {
                version: V,
                transport: 'embedded',
                schema: `https://ucp.dev/${V}/services/shopping/embedded.openrpc.json`,
              },
            ],
          },
        ),
      },
      { ok: false, reason: 'no_endpoint' },
    ],
  ])('%s: refused, the reason named', async (_name, input, docs, expected) => {
    const { read } = reader(docs as Record<string, unknown>);
    expect(await discoverMerchant(input, read)).toEqual(expected);
  });

  it('a stale document is said to be stale', async () => {
    const parsed = parseMerchantProfile(profile());
    if (!parsed.ok) throw new Error(parsed.reason);
    const out = await discoverMerchant('https://shop.example', async () => ({
      ok: true,
      profile: parsed.profile,
      stale: true,
    }));
    expect(out).toMatchObject({ ok: true, merchant: { stale: true } });
  });
});
